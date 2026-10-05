/* compartilhar-tela — cliente
 * Sinalização por WebSocket + mídia P2P via WebRTC.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    lobby: $('lobby'), room: $('room'), lobbyForm: $('lobbyForm'),
    nameInput: $('nameInput'), codeInput: $('codeInput'), joinBtn: $('joinBtn'),
    roomCode: $('roomCode'), roomIdChip: $('roomIdChip'), backBtn: $('backBtn'),
    connPill: $('connPill'), connText: $('connText'), peopleCount: $('peopleCount'),
    remoteVideo: $('remoteVideo'), localVideo: $('localVideo'), localPip: $('localPip'),
    overlay: $('videoOverlay'), overlayTitle: $('overlayTitle'), overlaySub: $('overlaySub'),
    shareBtnOverlay: $('shareBtnOverlay'), shareBtn: $('shareBtn'), shareBtnLabel: $('shareBtnLabel'),
    micBtn: $('micBtn'), micLabel: $('micLabel'), soundBtn: $('soundBtn'), soundLabel: $('soundLabel'),
    fsBtn: $('fsBtn'), stopBtn: $('stopBtn'), videoMeta: $('videoMeta'),
    chatLog: $('chatLog'), chatForm: $('chatForm'), chatInput: $('chatInput'),
    peerName: $('peerName'), toastWrap: $('toastWrap'), msgTpl: $('msgTpl'),
  };

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];
  // Opcional: configure um TURN no Render (TURN_URL / TURN_USERNAME / TURN_CREDENTIAL)
  if (window.__TURN_URL__) {
    ICE_SERVERS.push({ urls: window.__TURN_URL__, username: window.__TURN_USERNAME__, credential: window.__TURN_CREDENTIAL__ });
  }

  const state = {
    name: '', code: '', selfId: null,
    peers: new Map(),          // id -> {name, role}
    ws: null, wsOk: false, attempt: 0, reconnectTimer: null, manualExit: false,
    pc: null, displayStream: null, micStream: null, mixer: null,
    presenting: false, otherId: null,
    makingOffer: false, soundOn: true, soundBlocked: false,
  };

  /* ---------------- helpers ---------------- */
  function toast(msg, kind = '', ms = 3600) {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    el.toastWrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
  }

  function log(text, who = 'sistema') {
    const node = el.msgTpl.content.firstElementChild.cloneNode(true);
    node.classList.add('system');
    node.querySelector('.msg-who').textContent = who;
    node.querySelector('.msg-text').textContent = text;
    node.querySelector('.msg-time').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    el.chatLog.appendChild(node);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function addChat(text, who, mine) {
    const node = el.msgTpl.content.firstElementChild.cloneNode(true);
    if (mine) node.classList.add('me');
    node.querySelector('.msg-who').textContent = who;
    node.querySelector('.msg-text').textContent = text;
    node.querySelector('.msg-time').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    el.chatLog.appendChild(node);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function setConn(kind, text) {
    el.connPill.classList.toggle('is-live', kind === 'live');
    el.connPill.classList.toggle('is-off', kind === 'off');
    el.connText.textContent = text;
  }

  function roomUrl(code) {
    return `${location.origin}/sala/${code}`;
  }

  /* ---------------- lobby ---------------- */
  el.nameInput.value = localStorage.getItem('ct:name') || '';

  el.lobbyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!el.nameInput.value.trim()) return el.nameInput.focus();
    const code = (el.codeInput.value || '').trim();
    if (code) return joinRoom(code.toUpperCase());
    // cria sala nova
    el.joinBtn.disabled = true;
    try {
      const r = await fetch('/api/salas/nova');
      const d = await r.json();
      joinRoom(d.room);
    } catch {
      joinRoom(randomCode()); // fallback: gera no cliente
    } finally {
      el.joinBtn.disabled = false;
    }
  });

  el.joinBtn.addEventListener('click', () => el.lobbyForm.requestSubmit());
  el.codeInput.addEventListener('input', () => { el.codeInput.value = el.codeInput.value.toUpperCase(); });

  function randomCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(5)), (n) => A[n % A.length]).join('');
  }

  // Entra direto se vier com /sala/CODIGO na URL
  const pathMatch = location.pathname.match(/^\/sala\/([A-Za-z0-9]{5})$/);
  if (pathMatch) {
    el.codeInput.value = pathMatch[1].toUpperCase();
    if (el.nameInput.value) el.lobbyForm.requestSubmit();
  }

  /* ---------------- sala ---------------- */
  function joinRoom(code) {
    state.name = el.nameInput.value.trim().slice(0, 32);
    localStorage.setItem('ct:name', state.name);
    state.code = code;
    state.manualExit = false;

    el.roomCode.textContent = code;
    el.lobby.classList.add('hidden');
    el.room.classList.remove('hidden');
    el.room.setAttribute('aria-hidden', 'false');
    history.replaceState({}, '', roomUrl(code));

    el.chatLog.innerHTML = '';
    log(`Você entrou na sala ${code}. Envie o link pro seu amigo.`);
    connect();
  }

  function leaveRoom() {
    state.manualExit = true;
    clearTimeout(state.reconnectTimer);
    stopPresenting(true);
    try { state.ws?.close(); } catch { /* noop */ }
    state.ws = null;
    state.peers.clear();
    teardownPC();

    el.room.classList.add('hidden');
    el.room.setAttribute('aria-hidden', 'true');
    el.lobby.classList.remove('hidden');
    history.replaceState({}, '', '/');
    refreshUI();
  }

  /* ---------------- sinalização ---------------- */
  function send(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
  }

  function connect() {
    clearTimeout(state.reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/sinal?sala=${encodeURIComponent(state.code)}`);
    } catch (err) {
      return scheduleReconnect();
    }
    state.ws = ws;
    setConn('off', 'conectando…');

    ws.onopen = () => {
      state.wsOk = true;
      state.attempt = 0;
      setConn('live', 'online');
      ws.send(JSON.stringify({ type: 'join', name: state.name }));
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      onSignal(m);
    };

    ws.onclose = () => {
      state.wsOk = false;
      if (!state.manualExit) {
        setConn('off', 'reconectando…');
        scheduleReconnect();
      }
    };

    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  function scheduleReconnect() {
    if (state.manualExit) return;
    state.attempt = Math.min(state.attempt + 1, 6);
    const delay = Math.min(800 * 2 ** (state.attempt - 1), 12000);
    state.reconnectTimer = setTimeout(connect, delay);
  }

  function onSignal(m) {
    switch (m.type) {
      case 'welcome':
        state.selfId = m.selfId;
        state.peers.clear();
        for (const p of m.peers) state.peers.set(p.id, { name: p.name, role: p.role });
        state.peers.delete(m.selfId);
        syncOther();
        refreshUI();
        break;

      case 'peer-joined':
        state.peers.set(m.id, { name: m.name, role: 'viewer' });
        syncOther();
        refreshUI();
        log(`${m.name} entrou na sala.`);
        break;

      case 'peer-left': {
        const gone = [...state.peers.entries()].find(([id]) => id === m.id);
        if (gone) state.peers.delete(m.id);
        syncOther();
        refreshUI();
        if (m.wasPresenter) {
          log(`${gone ? gone[1].name : 'Seu amigo'} parou de compartilhar.`);
          clearRemote('Seu amigo parou de compartilhar.', 'Quando ele voltar a compartilhar, aparece aqui.');
        } else {
          log(`${gone ? gone[1].name : 'Seu amigo'} saiu da sala.`);
          clearRemote('Esperando seu amigo entrar…', 'Envie o link da sala pra ele.');
        }
        break;
      }

      case 'presence':
        state.peers.clear();
        for (const p of m.peers) if (p.id !== state.selfId) state.peers.set(p.id, { name: p.name, role: p.role });
        syncOther();
        refreshUI();
        break;

      case 'desc':
        handleDescription(m.payload);
        break;

      case 'ice':
        handleIce(m.payload);
        break;

      case 'stopped':
        if (!state.presenting) clearRemote(`${m.name} parou de compartilhar.`, 'Clique em “Compartilhar minha tela” para apresentar.');
        log(`${m.name} parou de compartilhar.`);
        break;

      case 'chat':
        addChat(m.text, m.name, false);
        break;

      case 'error':
        if (m.code === 'room-full') {
          toast('A sala já está cheia (2 pessoas).', 'err', 8000);
          leaveRoom();
        }
        break;

      default:
        break;
    }
  }

  function syncOther() {
    state.otherId = [...state.peers.keys()][0] || null;
    const p = state.otherId && state.peers.get(state.otherId);
    el.peerName.textContent = p ? `com ${p.name}` : 'só você';
  }

  /* ---------------- WebRTC ---------------- */
  // "polite" definido de forma determinística: exatamente um dos lados cede em caso de colisão.
  function polite() {
    return !state.otherId ? true : String(state.selfId) > String(state.otherId);
  }

  function ensurePC() {
    if (state.pc) return state.pc;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    state.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'ice', payload: e.candidate.toJSON() });
    };

    pc.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        await pc.setLocalDescription();
        send({ type: 'desc', payload: pc.localDescription });
      } catch (err) {
        console.error('negotiation', err);
      } finally {
        state.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        toast('A conexão direta falhou. Tentando reabrir…', 'err');
        restartPC();
      }
    };

    pc.ontrack = (e) => {
      const [track] = e.streams[0] ? e.streams[0].getTracks() : [e.track];
      const stream = e.streams[0] || new MediaStream([track]);
      el.remoteVideo.srcObject = stream;
      el.overlay.classList.add('hidden');
      el.videoMeta.style.display = 'block';
      playRemote();
    };

    return pc;
  }

  async function playRemote() {
    const v = el.remoteVideo;
    v.muted = !state.soundOn;
    try {
      await v.play();
      state.soundBlocked = false;
      el.soundBtn.classList.toggle('is-on', state.soundOn);
    } catch {
      state.soundBlocked = true;
      v.muted = true;
      await v.play().catch(() => {});
      toast('Toque em “Som” para ouvir o áudio.', '', 6000);
    }
  }

  async function handleDescription(desc) {
    if (!desc) return;
    const pc = ensurePC();
    const collision = desc.type === 'offer' && (state.makingOffer || pc.signalingState !== 'stable');
    if (collision && !polite()) return; // impolite ignora a oferta concorrente
    try {
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        send({ type: 'desc', payload: pc.localDescription });
      }
    } catch (err) {
      console.error('setRemoteDescription', err);
    }
  }

  async function handleIce(candidate) {
    if (!candidate || !state.pc) return;
    try {
      await state.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('addIceCandidate', err.message);
    }
  }

  function teardownPC() {
    if (!state.pc) return;
    try { state.pc.ontrack = state.pc.onicecandidate = state.pc.onnegotiationneeded = state.pc.onconnectionstatechange = null; state.pc.close(); } catch { /* noop */ }
    state.pc = null;
  }

  async function restartPC() {
    teardownPC();
    ensurePC();
    if (state.displayStream) await attachTracks();
  }

  /* ---------------- captura ---------------- */
  async function mixAudioTracks(tracks) {
    if (!tracks.length) return null;
    if (tracks.length === 1) return { track: tracks[0], ctx: null };
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    for (const t of tracks) {
      const src = ctx.createMediaStreamSource(new MediaStream([t]));
      src.connect(dest);
    }
    return { track: dest.stream.getAudioTracks()[0], ctx };
  }

  async function attachTracks() {
    const pc = ensurePC();
    const display = state.displayStream;
    const audioTracks = [];

    const sysAudio = display?.getAudioTracks?.()[0];
    if (sysAudio) audioTracks.push(sysAudio);
    const micAudio = state.micStream?.getAudioTracks?.()[0];
    if (micAudio) audioTracks.push(micAudio);

    // limpa senders antigos
    for (const sender of pc.getSenders()) {
      try { await pc.removeTrack(sender); } catch { /* noop */ }
    }

    const videoTrack = display?.getVideoTracks?.()[0];
    if (videoTrack) {
      try { videoTrack.contentHint = 'detail'; } catch { /* noop */ }
      pc.addTrack(videoTrack, display);
    }

    if (audioTracks.length) {
      if (state.mixer?.ctx) { try { state.mixer.ctx.close(); } catch { /* noop */ } }
      state.mixer = await mixAudioTracks(audioTracks);
      if (state.mixer?.track) pc.addTrack(state.mixer.track, new MediaStream([state.mixer.track]));
    }

    // disparar renegociação caso onnegotiationneeded não dispare sozinho
    if (pc.getSenders().some((s) => s.track) && pc.signalingState === 'stable') {
      await pc.setLocalDescription();
      send({ type: 'desc', payload: pc.localDescription });
    }
  }

  async function startPresenting() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast('Este navegador não permite compartilhar a tela. Use o Chrome/Edge no computador.', 'err', 7000);
      return;
    }
    if (!state.otherId) {
      toast('Seu amigo ainda não entrou. Pode compartilhar mesmo assim — ele vê assim que entrar.', '', 5000);
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 }, displaySurface: 'monitor' },
        audio: true,
        selfBrowserSurface: 'include',
        systemAudio: 'include',
      });
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') toast('Não foi possível capturar a tela: ' + err.message, 'err');
      return;
    }

    state.displayStream = stream;
    el.localVideo.srcObject = stream;
    el.localPip.classList.add('on');

    stream.getVideoTracks()[0]?.addEventListener('ended', () => stopPresenting());

    state.presenting = true;
    send({ type: 'role', payload: 'presenter' });
    el.micBtn.disabled = false;
    refreshUI();
    log('Você começou a compartilhar a tela.');

    ensurePC();
    await attachTracks();
  }

  function stopPresenting(silent = false) {
    if (state.displayStream) {
      for (const t of state.displayStream.getTracks()) { try { t.stop(); } catch { /* noop */ } }
      state.displayStream = null;
    }
    if (state.micStream) {
      for (const t of state.micStream.getTracks()) { try { t.stop(); } catch { /* noop */ } }
      state.micStream = null;
    }
    if (state.mixer?.ctx) { try { state.mixer.ctx.close(); } catch { /* noop */ } state.mixer = null; }
    el.localPip.classList.remove('on');
    el.localVideo.srcObject = null;

    if (state.presenting) {
      state.presenting = false;
      if (!silent) send({ type: 'stopped' });
      send({ type: 'role', payload: 'viewer' });
      teardownPC();
      el.micBtn.disabled = true;
      el.micBtn.classList.remove('is-on');
      if (!silent) log('Você parou de compartilhar.');
    }
    refreshUI();
  }

  async function toggleMic() {
    if (!state.presenting) return;
    if (state.micStream) {
      for (const t of state.micStream.getTracks()) t.stop();
      state.micStream = null;
      el.micBtn.classList.remove('is-on');
      log('Microfone desligado.');
      await attachTracks();
      refreshUI();
      return;
    }
    try {
      state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      el.micBtn.classList.add('is-on');
      log('Microfone ligado.');
      await attachTracks();
    } catch {
      toast('Não consegui acessar o microfone.', 'err');
    }
    refreshUI();
  }

  function clearRemote(title, sub) {
    el.remoteVideo.srcObject = null;
    el.overlay.classList.remove('hidden');
    el.overlayTitle.textContent = title;
    el.overlaySub.textContent = sub;
    el.videoMeta.style.display = 'none';
  }

  /* ---------------- UI ---------------- */
  function refreshUI() {
    const someone = !!state.otherId;
    el.peopleCount.textContent = String(state.peers.size + 1);

    if (state.presenting) {
      el.shareBtn.hidden = true;
      el.shareBtnOverlay.hidden = true;
      el.stopBtn.hidden = false;
    } else {
      el.shareBtn.hidden = false;
      el.stopBtn.hidden = true;
      el.shareBtnLabel.textContent = someone ? 'Compartilhar minha tela' : 'Compartilhar minha tela';
      el.shareBtnOverlay.hidden = false;
    }

    const other = state.otherId && state.peers.get(state.otherId);
    const remotePresenting = other?.role === 'presenter';

    if (!state.presenting && !remotePresenting) {
      if (!someone) clearRemote('Esperando seu amigo entrar…', 'Envie o link da sala pra ele.');
      else clearRemote(`${other.name} está na sala.`, 'Você ou ele podem clicar em “Compartilhar minha tela”.');
    }
    el.soundBtn.classList.toggle('is-on', state.soundOn && !state.soundBlocked);
  }

  async function copyLink() {
    const url = roomUrl(state.code);
    try {
      await navigator.clipboard.writeText(url);
      toast('Link da sala copiado!', 'ok', 2200);
    } catch {
      const tmp = document.createElement('input');
      tmp.value = url;
      document.body.appendChild(tmp);
      tmp.select();
      try { document.execCommand('copy'); toast('Link copiado!', 'ok', 2200); }
      catch { prompt('Copie o link da sala:', url); }
      tmp.remove();
    }
  }

  el.roomIdChip.addEventListener('click', copyLink);
  el.backBtn.addEventListener('click', leaveRoom);
  el.shareBtn.addEventListener('click', startPresenting);
  el.shareBtnOverlay.addEventListener('click', startPresenting);
  el.stopBtn.addEventListener('click', () => stopPresenting());
  el.micBtn.addEventListener('click', toggleMic);

  el.soundBtn.addEventListener('click', async () => {
    state.soundOn = !state.soundOn;
    el.remoteVideo.muted = !state.soundOn;
    if (state.soundOn) {
      try { await el.remoteVideo.play(); state.soundBlocked = false; } catch { /* noop */ }
    }
    el.soundBtn.classList.toggle('is-on', state.soundOn && !state.soundBlocked);
    el.soundLabel.textContent = state.soundOn ? 'Som' : 'Sem som';
  });

  el.fsBtn.addEventListener('click', async () => {
    const target = el.remoteVideo.parentElement;
    try {
      if (!document.fullscreenElement) await target.requestFullscreen();
      else await document.exitFullscreen();
    } catch { toast('Tela cheia não permitida aqui.', 'err', 2500); }
  });

  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    send({ type: 'chat', payload: { text } });
    addChat(text, state.name, true);
    el.chatInput.value = '';
  });

  window.addEventListener('beforeunload', () => { if (state.presenting) send({ type: 'stopped' }); });
  document.addEventListener('visibilitychange', () => { /* conexão segue ativa em segundo plano */ });

  /* ---------------- estatísticas ---------------- */
  let lastBytes = 0;
  let lastTs = 0;
  setInterval(async () => {
    if (!state.pc || el.videoMeta.style.display === 'none') return;
    try {
      const stats = await state.pc.getStats();
      const kind = state.presenting ? 'outbound-rtp' : 'inbound-rtp';
      for (const r of stats.values()) {
        if (r.type !== kind || r.kind !== 'video') continue;
        const bytes = r.bytesSent ?? r.bytesReceived ?? 0;
        const now = r.timestamp;
        const kbps = lastTs ? Math.max(0, Math.round(((bytes - lastBytes) * 8) / (now - lastTs))) : 0;
        lastBytes = bytes; lastTs = now;
        const w = r.frameWidth || 0;
        const h = r.frameHeight || 0;
        const fps = Math.round(r.framesPerSecond || 0);
        el.videoMeta.textContent = w ? `${w}×${h} · ${fps} fps · ${kbps} kbps` : `${kbps} kbps`;
      }
    } catch { /* noop */ }
  }, 2000);

  refreshUI();
})();
