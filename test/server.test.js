'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');

process.env.NODE_ENV = 'test';
const { start, server, rooms, normalizeCode, newRoomCode, CODE_LEN } = require('../server.js');

const BASE = {};

function url(path) {
  return `http://127.0.0.1:${BASE.port}${path}`;
}

function wsUrl(room) {
  return `ws://127.0.0.1:${BASE.port}/sinal?sala=${room}`;
}

// `connection: close` evita que o pool keep-alive do undici segure o processo aberto.
function get(path) {
  return fetch(url(path), { headers: { connection: 'close' } });
}

/** Cliente WS de teste: resolve mensagens por tipo. */
function client(room, name) {
  const ws = new WebSocket(wsUrl(room));
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return {
    ws,
    opened,
    inbox,
    waitFor(type, timeout = 3000) {
      const hit = inbox.findIndex((m) => m.type === type);
      if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout esperando "${type}"`)), timeout);
        waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    send(obj) { ws.send(JSON.stringify(obj)); },
    close() { try { ws.close(); } catch { /* noop */ } },
    async join() {
      await opened;
      this.send({ type: 'join', name });
      const w = await this.waitFor('welcome');
      this.selfId = w.selfId;
      this.room = w.room;
      return w;
    },
  };
}

test.before(async () => {
  BASE.port = await start(0);
});

test.after(() => {
  server.closeAllConnections?.();
  server.close();
});

test('normalizeCode aceita só códigos do tamanho certo e rejeita lixo', () => {
  assert.equal(normalizeCode('abc2d'), 'ABC2D');
  assert.equal(normalizeCode(' ab-c2d '), 'ABC2D', 'limpa ruído e normaliza maiúsculas');
  assert.equal(normalizeCode('AB2D'), '');           // curto demais (4)
  assert.equal(normalizeCode('abc'), '');            // curto demais
  assert.equal(normalizeCode('ABCDEFGHI'), '');      // longo demais
  assert.equal(normalizeCode(null), '');
  assert.match(newRoomCode(), new RegExp(`^[A-Z0-9]{${CODE_LEN}}$`));
});

test('GET /healthz responde ok', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.rooms, 'number');
});

test('GET /api/salas/nova devolve um código válido', async () => {
  const res = await get('/api/salas/nova');
  assert.equal(res.status, 200);
  const { room } = await res.json();
  assert.match(room, new RegExp(`^[A-Z0-9]{${CODE_LEN}}$`));
});

test('GET /sala/:code entrega o app, código inválido dá 400', async () => {
  const ok = await get('/sala/ABC2D');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Compartilhar Tela/);

  assert.equal((await get('/sala/x')).status, 400);
  assert.equal((await get('/sala/ABCDEFGH')).status, 400);
});

test('dois participantes entram na sala e se enxergam', async () => {
  const room = newRoomCode();
  const a = client(room, 'Gabriel');
  const b = client(room, 'Amigo');

  const wa = await a.join();
  assert.equal(wa.room, room);
  assert.equal(wa.peers.length, 0, 'A entra sozinho (welcome não lista a si mesmo)');

  const wb = await b.join();
  assert.equal(wb.peers.length, 1, 'B já vê o A no welcome');
  assert.equal(wb.peers[0].name, 'Gabriel');

  const joined = await a.waitFor('peer-joined');
  assert.equal(joined.name, 'Amigo');

  a.close(); b.close();
});

test('SDP e ICE são retransmitidos só para o outro participante', async () => {
  const room = newRoomCode();
  const a = client(room, 'A');
  const b = client(room, 'B');
  await a.join();
  await b.join();
  await a.waitFor('peer-joined');

  const sdp = { type: 'offer', sdp: 'v=0 fake-sdp' };
  a.send({ type: 'desc', payload: sdp });
  const got = await b.waitFor('desc');
  assert.deepEqual(got.payload, sdp);
  assert.equal(got.from, a.selfId);

  a.send({ type: 'ice', payload: { candidate: 'candidate:1 1 udp 2122 1.2.3.4 5000 typ host' } });
  const ice = await b.waitFor('ice');
  assert.equal(ice.from, a.selfId);
  assert.match(ice.payload.candidate, /^candidate:1/);

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(a.inbox.filter((m) => m.type === 'desc').length, 0, 'não ecoa pro remetente');

  a.close(); b.close();
});

test('chat chega no outro lado com o nome do autor', async () => {
  const room = newRoomCode();
  const a = client(room, 'Gabriel');
  const b = client(room, 'Amigo');
  await a.join();
  await b.join();
  await a.waitFor('peer-joined');

  a.send({ type: 'chat', payload: { text: 'oi, tá vendo minha tela?' } });
  const msg = await b.waitFor('chat');
  assert.equal(msg.text, 'oi, tá vendo minha tela?');
  assert.equal(msg.name, 'Gabriel');
  assert.equal(a.inbox.filter((m) => m.type === 'chat').length, 0, 'não ecoa pro autor');

  a.close(); b.close();
});

test('quem sai dispara peer-left com wasPresenter', async () => {
  const room = newRoomCode();
  const a = client(room, 'A');
  const b = client(room, 'B');
  await a.join();
  await b.join();
  await a.waitFor('peer-joined');

  a.send({ type: 'role', payload: 'presenter' });
  const presence = await b.waitFor('presence');
  assert.ok(presence.peers.some((p) => p.id === a.selfId && p.role === 'presenter'));

  a.close();
  const left = await b.waitFor('peer-left');
  assert.equal(left.id, a.selfId);
  assert.equal(left.wasPresenter, true);
  b.close();
});

test('a sala é descartada quando fica vazia', async () => {
  const room = newRoomCode();
  const a = client(room, 'A');
  await a.join();
  assert.equal(rooms.has(room), true);
  a.close();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(rooms.has(room), false, 'sala removida do mapa');
});

test('terceira pessoa é recusada (sala é 1:1)', async () => {
  const room = newRoomCode();
  const a = client(room, 'A');
  const b = client(room, 'B');
  const c = client(room, 'C');
  await a.join();
  await b.join();
  await a.waitFor('peer-joined');

  await c.opened;
  c.send({ type: 'join', name: 'C' });
  const err = await c.waitFor('error');
  assert.equal(err.code, 'room-full');
  const closed = await new Promise((res) => c.ws.on('close', (code) => res(code)));
  assert.equal(closed, 4001);

  a.close(); b.close(); c.close();
});

test('mensagem antes do join fecha a conexão', async () => {
  const room = newRoomCode();
  const ws = new WebSocket(wsUrl(room));
  await new Promise((res) => ws.on('open', res));
  ws.send(JSON.stringify({ type: 'chat', payload: { text: 'oi' } }));
  const code = await new Promise((res) => ws.on('close', (c) => res(c)));
  assert.equal(code, 4002);
});

test('sala inválida na URL é recusada', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${BASE.port}/sinal?sala=!!`);
  const code = await new Promise((res) => { ws.on('close', (c) => res(c)); ws.on('error', () => res('err')); });
  assert.equal(code, 4000);
});
