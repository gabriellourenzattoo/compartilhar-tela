/**
 * compartilhar-tela — servidor de sinalização para compartilhamento de tela 1:1.
 *
 * O servidor NUNCA vê o vídeo: ele só reencaminha as mensagens de sinalização
 * WebRTC (SDP/ICE) entre os dois participantes da sala. A mídia trafega P2P.
 */
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PEERS_PER_ROOM = 2;
const ROOM_IDLE_MS = 1000 * 60 * 5; // sala vazia é descartada após 5 min
const HEARTBEAT_MS = 25000;
const MAX_MESSAGE_BYTES = 64 * 1024; // SDP/ICE são pequenos; chat é truncado
const MAX_CHAT_CHARS = 2000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem chars ambíguos (0/O, 1/I)
const CODE_LEN = 5;

/** @type {Map<string, {code:string, peers:Set<Peer>, createdAt:number, lastActivity:number}>} */
const rooms = new Map();

class Peer {
  constructor(ws, room, id) {
    this.ws = ws;
    this.room = room;
    this.id = id;
    this.name = 'Anônimo';
    this.role = 'viewer'; // 'presenter' | 'viewer'
    this.alive = true;
  }

  send(obj) {
    if (this.ws.readyState === this.ws.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch (err) {
        console.warn('[send] falha ao enviar:', err.message);
      }
    }
  }
}

function newRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LEN; i++) {
      code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length === CODE_LEN ? cleaned : '';
}

function roomSnapshot(room) {
  return [...room.peers].map((p) => ({ id: p.id, name: p.name, role: p.role }));
}

function broadcast(room, obj, except = null) {
  for (const peer of room.peers) {
    if (peer !== except) peer.send(obj);
  }
}

function touch(room) {
  room.lastActivity = Date.now();
}

function dropPeer(peer) {
  const room = rooms.get(peer.room);
  try {
    peer.ws.close();
  } catch {
    /* já fechado */
  }
  if (!room || !room.peers.delete(peer)) return;

  if (room.peers.size === 0) {
    rooms.delete(room.code);
    return;
  }
  touch(room);
  // Avisa quem ficou na sala que o par saiu (e que a apresentação acabou).
  const wasPresenter = peer.role === 'presenter';
  for (const other of room.peers) {
    other.send({ type: 'peer-left', id: peer.id, wasPresenter });
    other.send({ type: 'presence', peers: roomSnapshot(room) });
  }
}

function handleJoin(ws, room, payload) {
  if (room.peers.size >= MAX_PEERS_PER_ROOM) {
    ws.send(JSON.stringify({ type: 'error', code: 'room-full', message: 'A sala já está com duas pessoas.' }));
    ws.close(4001, 'room-full');
    return null;
  }
  const peer = new Peer(ws, room.code, crypto.randomUUID());
  peer.name = String(payload?.name || 'Anônimo').slice(0, 32) || 'Anônimo';
  // O papel vem junto no join: se o WebSocket cair e reconectar no meio de uma
  // apresentação, o servidor não pode esquecer que essa pessoa é quem apresenta.
  peer.role = payload?.presenting ? 'presenter' : 'viewer';
  room.peers.add(peer);
  touch(room);

  const others = [...room.peers].filter((p) => p !== peer).map((p) => ({ id: p.id, name: p.name, role: p.role }));
  ws.send(JSON.stringify({ type: 'welcome', selfId: peer.id, room: room.code, peers: others }));
  for (const other of room.peers) {
    if (other !== peer) {
      other.send({ type: 'peer-joined', id: peer.id, name: peer.name });
      other.send({ type: 'presence', peers: roomSnapshot(room) });
    }
  }
  return peer;
}

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));

app.get(['/healthz', '/api/health'], (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

app.get('/api/salas/nova', (_req, res) => {
  const code = newRoomCode();
  res.json({ room: code });
});

// Expõe o TURN (se configurado) para o cliente. Nada secreto aqui: as credenciais
// de TURN são, por natureza, entregues ao navegador.
app.get('/config', (_req, res) => {
  const url = process.env.TURN_URL;
  res.json({
    turn: url ? { url, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' } : null,
  });
});

app.get('/sala/:code', (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return res.status(400).send('Código de sala inválido.');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((_req, res) => {
  res.status(404).type('text/plain; charset=utf-8').send('Não encontrado.');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/sinal', maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const code = normalizeCode(url.searchParams.get('sala'));
  if (!code) {
    ws.close(4000, 'invalid-room');
    return;
  }
  if (!rooms.has(code)) {
    rooms.set(code, { code, peers: new Set(), createdAt: Date.now(), lastActivity: Date.now() });
  }
  const room = rooms.get(code);

  let peer = null;
  let joined = false;

  ws.on('pong', () => {
    ws.isAlive = true;
    if (peer) peer.alive = true;
  });
  ws.isAlive = true;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (!joined) {
      if (msg.type !== 'join') {
        ws.close(4002, 'join-required');
        return;
      }
      peer = handleJoin(ws, room, msg);
      if (!peer) return;
      joined = true;
      return;
    }

    touch(room);

    switch (msg.type) {
      case 'desc':
      case 'ice':
        // Sinalização WebRTC: repassa só para o outro participante.
        for (const other of room.peers) if (other !== peer) other.send({ type: msg.type, from: peer.id, payload: msg.payload });
        break;

      case 'role':
        peer.role = msg.payload === 'presenter' ? 'presenter' : 'viewer';
        broadcast(room, { type: 'presence', peers: roomSnapshot(room) }, null);
        break;

      case 'chat': {
        const text = String(msg.payload?.text || '').slice(0, MAX_CHAT_CHARS);
        if (text.trim()) {
          broadcast(room, { type: 'chat', from: peer.id, name: peer.name, text }, peer);
        }
        break;
      }

      case 'stopped':
        if (peer.role === 'presenter') {
          peer.role = 'viewer';
          broadcast(room, { type: 'stopped', from: peer.id, name: peer.name }, peer);
          broadcast(room, { type: 'presence', peers: roomSnapshot(room) }, null);
        }
        break;

      case 'ping':
        peer.send({ type: 'pong', t: Date.now() });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (peer) dropPeer(peer);
    else if (room.peers.size === 0) rooms.delete(code);
  });

  ws.on('error', () => {
    if (peer) dropPeer(peer);
  });
});

// Mantém conexões vivas e descarta clientes mortos (importante atrás de proxy).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
  // Limpeza de salas abandonadas.
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.peers.size === 0 && now - room.lastActivity > ROOM_IDLE_MS) rooms.delete(code);
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

function shutdown(signal) {
  console.log(`[${signal}] encerrando...`);
  clearInterval(heartbeat);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function start(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      const addr = server.address();
      console.log(`compartilhar-tela ouvindo em 0.0.0.0:${addr.port}`);
      resolve(addr.port);
    });
  });
}

if (require.main === module) start();

module.exports = { app, server, start, rooms, normalizeCode, newRoomCode, CODE_LEN };
