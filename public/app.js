/* compartilhar-tela — cliente
 * Sinalização por WebSocket + mídia P2P via WebRTC.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    lobby: $('lobby'), room: $('room'), lobbyForm: $('lobbyForm'),
    nameInput: $('nameInput'), codeInput: $('codeInput'), joinBtn: $('joinBtn'),
    createBtnLabel: $('createBtnLabel'),
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
  // TURN opcional vem do servidor (TURN_URL/TURN_USERNAME/TURN_CREDENTIAL no Render).
  fetch('/config')
    .then((r) => r.json())
    .then((c) => {
      if (c?.turn?.url) ICE_SERVERS.push({ urls: c.turn.url, username: c.turn.username, credential: c.turn.credential });
    })
    .catch(() => { /* sem TURN, só STUN */ });

  const MAX_RESTARTS = 3;

  const state = {
    name: '', code: '', selfId: null,
    peers: new Map(),           // id -> {name, role}
    ws: null, attempt: 0, reconnectTimer: null, manualExit: false,
    pc: null, videoSender: null, audioSender: null,
    displayStream: null, micStream: null, mixer: null,
    presenting: false, otherId: null, peerSig: '',
    makingOffer: false, soundOn: true, soundBlocked: false, restarts: 0,
    joinedOnce: false, roomFullSince: 0,
  };

  // Acumula as trilhas recebidas. Precisa ser UM stream só: o ontrack dispara uma
  // vez por trilha e, se a gente atribuir srcObject a cada vez, a última (áudio)
  // sobrescreve o vídeo e a tela fica preta.
  const remoteStream = new MediaStream();
  // Candidatos ICE que chegam antes do remoteDescription precisam esperar.
  const pendingIce = [];

  /* ---------------- helpers ---------------- */
  function toast(msg, kind = '', ms = 3600) {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    el.toastWrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
  }

  function chatNode(text, who, kind) {
    const node = el.msgTpl.content.firstElementChild.cloneNode(true);
    if (kind) node.classList.add(kind);
    node.querySelector('.msg-who').textContent = who;
    node.querySelector('.msg-text').textContent = text;
    node.querySelector('.msg-time').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    el.chatLog.appendChild(node);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }
  const log = (text, who = 'sistema') => chatNode(text, who, 'system');
  const addChat = (text, who, mine) => chatNode(text, who, mine ? 'me' : '');

  function setConn(kind, text) {
    el.connPill.classList.toggle('is-live', kind === 'live');
    el.connPill.classList.toggle('is-off', kind === 'off');
    el.connText.textContent = text;
  }

  const roomUrl = (code) => `${location.origin}/sala/${code}`;

  /* ---------------- lobby ---------------- */
  el.nameInput.value = localStorage.getItem('ct:name') || '';

  function refreshLobbyLabel() {
    const has = el.codeInput.value.trim().length > 0;
    el.createBtnLabel.textContent = has ? 'Entrar na sala' : 'Criar uma sala';
  }

  el.lobbyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!el.nameInput.value.trim()) return el.nameInput.focus();
    const code = el.codeInput.value.trim();
    if (code) return joinRoom(code.toUpperCase());

    el.joinBtn.disabled = true;
    try {
      const r = await fetch('/api/salas/nova');
      const d = await r.json();
      if (!d.room) throw new Error('sem código');
      joinRoom(d.room);
    } catch {
      joinRoom(randomCode()); // fallback: gera no cliente
    } finally {
      el.joinBtn.disabled = false;
    }
  });

  el.joinBtn.addEventListener('click', () => el.lobbyForm.requestSubmit());
  el.codeInput.addEventListener('input', () => {
    el.codeInput.value = el.codeInput.value.toUpperCase();
    refreshLobbyLabel();
  });

  function randomCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(5)), (n) => A[n % A.length]).join('');
  }

  // Entra direto se vier com /sala/CODIGO na URL
  const pathMatch = location.pathname.match(/^\/sala\/([A-Za-z0-9]{5})$/);
  if (pathMatch) {
    el.codeInput.value = pathMatch[1].toUpperCase();
    refreshLobbyLabel();
    if (el.nameInput.value) el.lobbyForm.requestSubmit();
  }

  /* ---------------- sala ---------------- */
  function joinRoom(code) {
    state.name = el.nameInput.value.trim().slice(0, 32) || 'Anônimo';
    localStorage.setItem('ct:name', state.name);
    state.code = code;
    state.manualExit = false;
    state.restarts = 0;

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
    state.peerSig = '';
    state.otherId = null;
    state.joinedOnce = false;
    state.roomFullSince = 0;
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
    } catch {
      return scheduleReconnect();
    }
    state.ws = ws;
    setConn('off', 'conectando…');

    ws.onopen = () => {
      state.attempt = 0;
      setConn('live', 'online');
      // presenting vai junto: depois de uma reconexão o servidor volta a saber
      // que somos nós quem está apresentando.
      ws.send(JSON.stringify({ type: 'join', name: state.name, presenting: state.presenting }));
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      onSignal(m);
    };

    ws.onclose = () => {
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
    state.reconnectTimer = setTimeout(connect, Math.min(800 * 2 ** (state.attempt - 1), 12000));
  }

  function onSignal(m) {
    switch (m.type) {
      case 'welcome':
        state.selfId = m.selfId;
        state.joinedOnce = true;
        state.roomFullSince = 0;
        state.peers.clear();
        for (const p of m.peers) state.peers.set(p.id, { name: p.name, role: p.role });
        syncOther();
        // (Re)conectamos: força a reconstrução da peer connection e uma oferta
        // nova, mesmo que seja a mesma pessoa do outro lado.
        state.peerSig = '';
        if (state.presenting) send({ type: 'role', payload: 'presenter' });
        maybePeerChange();
        refreshUI();
        break;

      case 'peer-joined':
        state.peers.set(m.id, { name: m.name, role: 'viewer' });
        syncOther();
        maybePeerChange();
        refreshUI();
        log(`${m.name} entrou na sala.`);
        break;

      case 'peer-left': {
        const gone = state.peers.get(m.id);
        const name = gone ? gone.name : 'Seu amigo';
        state.peers.delete(m.id);
        syncOther();
        maybePeerChange();
        refreshUI();
        log(m.wasPresenter ? `${name} parou de compartilhar.` : `${name} saiu da sala.`);
        break;
      }

      case 'presence':
        state.peers.clear();
        for (const p of m.peers) if (p.id !== state.selfId) state.peers.set(p.id, { name: p.name, role: p.role });
        syncOther();
        maybePeerChange();
        refreshUI();
        break;

      case 'desc':
        handleDescription(m.payload);
        break;

      case 'ice':
        handleIce(m.payload);
        break;

      case 'stopped':
        log(`${m.name} parou de compartilhar.`);
        if (!state.presenting) {
          teardownPC();
          clearRemote(`${m.name} parou de compartilhar.`, 'Clique em “Compartilhar minha tela” para apresentar.');
          refreshUI();
        }
        break;

      case 'chat':
        addChat(m.text, m.name, false);
        break;

      case 'error':
        if (m.code === 'room-full') {
          // Se a gente já estava nessa sala, é o nosso próprio socket antigo que
          // ainda não foi liberado (o proxy segura o close por alguns segundos).
          // Insistir resolve sozinho; desistir expulsaria você da própria sala.
          if (state.roomFullSince === 0) state.roomFullSince = Date.now();
          const insistir = state.joinedOnce && Date.now() - state.roomFullSince < 30000;
          if (insistir) {
            setConn('off', 'reconectando…');
            scheduleReconnect();
          } else {
            toast('A sala já está cheia (2 pessoas).', 'err', 8000);
            leaveRoom();
          }
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

  /**
   * Reconstrói a conexão quando o conjunto de pessoas muda de verdade.
   * Cobre: amigo entrou depois de eu já estar compartilhando, amigo caiu e voltou,
   * e eu reconectei. Sem isso a oferta antiga morre no vazio e ninguém vê nada.
   */
  function maybePeerChange() {
    const sig = [...state.peers.keys()].sort().join(',');
    if (sig === state.peerSig) return;
    state.peerSig = sig;
    state.restarts = 0;
    teardownPC();
    if (state.presenting) {
      ensurePC();
      syncTracks().catch((e) => console.error('syncTracks', e));
    }
    refreshUI();
  }

  /* ---------------- WebRTC ---------------- */
  // "polite" determinístico: exatamente um dos lados cede numa colisão de ofertas.
  const polite = () => (!state.otherId ? true : String(state.selfId) > String(state.otherId));

  function ensurePC() {
    if (state.pc) return state.pc;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    state.pc = pc;
    state.restarts = 0;

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'ice', payload: e.candidate.toJSON() });
    };

    pc.onnegotiationneeded = () => { renegotiate(); };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') state.restarts = 0;
      if (s === 'failed') {
        if (state.restarts >= MAX_RESTARTS) {
          toast('Não consegui reconectar. Peça pro seu amigo compartilhar de novo.', 'err', 7000);
          return;
        }
        state.restarts++;
        toast(`Conexão caiu, tentando de novo (${state.restarts}/${MAX_RESTARTS})…`, '', 3000);
        // Sem backoff isso vira um loop infinito de ofertas.
        setTimeout(() => {
          if (state.pc !== pc) return;
          teardownPC();
          if (state.presenting) { ensurePC(); syncTracks().catch(() => {}); }
        }, 500 * state.restarts);
      }
    };

    // Uma trilha por evento. Todas vão para o MESMO stream, senão o áudio
    // sobrescreve o vídeo no <video>.
    pc.ontrack = (e) => {
      if (!remoteStream.getTracks().includes(e.track)) remoteStream.addTrack(e.track);
      e.track.addEventListener('ended', () => remoteStream.removeTrack(e.track));
      if (state.presenting) return; // quem apresenta vê a própria tela
      el.remoteVideo.srcObject = remoteStream;
      el.overlay.classList.add('hidden');
      el.videoMeta.style.display = 'block';
      playRemote();
    };

    return pc;
  }

  async function renegotiate() {
    const pc = state.pc;
    if (!pc || state.makingOffer) return;
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      send({ type: 'desc', payload: pc.localDescription });
    } catch (err) {
      console.error('renegotiate', err);
    } finally {
      state.makingOffer = false;
    }
  }

  async function playRemote() {
    const v = el.remoteVideo;
    v.muted = !state.soundOn;
    try {
      await v.play();
      state.soundBlocked = false;
    } catch {
      state.soundBlocked = true;
      v.muted = true;
      await v.play().catch(() => {});
      toast('Toque em “Som” para ouvir o áudio.', '', 6000);
    }
    refreshUI();
  }

  async function handleDescription(desc) {
    if (!desc) return;
    const pc = ensurePC();
    const collision = desc.type === 'offer' && (state.makingOffer || pc.signalingState !== 'stable');
    if (collision && !polite()) return; // impolite ignora a oferta concorrente
    try {
      await pc.setRemoteDescription(desc);
      await flushIce(pc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        send({ type: 'desc', payload: pc.localDescription });
      }
    } catch (err) {
      console.error('setRemoteDescription', err);
    }
  }

  async function handleIce(candidate) {
    if (!candidate) return;
    const pc = state.pc;
    // Candidato antes da descrição: guarda, senão ele é descartado e a conexão
    // pode nunca fechar.
    if (!pc || !pc.remoteDescription) {
      if (pendingIce.length < 100) pendingIce.push(candidate);
      return;
    }
    try { await pc.addIceCandidate(candidate); } catch (err) { console.warn('addIceCandidate', err.message); }
  }

  async function flushIce(pc) {
    while (pendingIce.length) {
      const c = pendingIce.shift();
      try { await pc.addIceCandidate(c); } catch { /* candidato obsoleto */ }
    }
  }

  function closeMixer() {
    if (state.mixer?.ctx) { try { state.mixer.ctx.close(); } catch { /* noop */ } }
    state.mixer = null;
  }

  function teardownPC() {
    if (!state.pc) return;
    const pc = state.pc;
    pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = pc.onconnectionstatechange = null;
    try { pc.close(); } catch { /* noop */ }
    state.pc = null;
    state.videoSender = null;
    state.audioSender = null;
    state.makingOffer = false;
    pendingIce.length = 0;
    for (const t of remoteStream.getTracks()) remoteStream.removeTrack(t);
    closeMixer();
    if (!state.presenting) el.remoteVideo.srcObject = null;
  }

  /* ---------------- captura ---------------- */
  async function mixAudioTracks(tracks) {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    for (const t of tracks) ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
    return { track: dest.stream.getAudioTracks()[0], ctx };
  }

  /**
   * Ajusta o que está sendo enviado. Usa replaceTrack quando os transceivers já
   * existem — assim ligar/desligar o microfone não renegocia nada.
   */
  async function syncTracks() {
    const pc = ensurePC();
    const display = state.displayStream;
    const videoTrack = display?.getVideoTracks?.()[0] || null;

    const sources = [];
    const sys = display?.getAudioTracks?.()[0];
    if (sys) sources.push(sys);
    const mic = state.micStream?.getAudioTracks?.()[0];
    if (mic) sources.push(mic);

    let audioTrack = null;
    if (sources.length === 1) {
      closeMixer();
      audioTrack = sources[0];
    } else if (sources.length > 1) {
      closeMixer();
      state.mixer = await mixAudioTracks(sources);
      audioTrack = state.mixer?.track || null;
    } else {
      closeMixer();
    }

    // Cria os transceivers uma única vez (isso dispara UMA negociação).
    let created = false;
    if (!state.videoSender || !state.videoSender.transport || state.videoSender.transport.state === 'closed') {
      state.videoSender = pc.addTransceiver('video', { direction: 'sendonly' }).sender;
      created = true;
    }
    if (!state.audioSender || !state.audioSender.transport || state.audioSender.transport.state === 'closed') {
      state.audioSender = pc.addTransceiver('audio', { direction: 'sendonly' }).sender;
      created = true;
    }

    if (videoTrack) { try { videoTrack.contentHint = 'detail'; } catch { /* noop */ } }
    await state.videoSender.replaceTrack(videoTrack);
    await state.audioSender.replaceTrack(audioTrack);

    // addTransceiver já agenda a negociação; só força quando nada foi criado
    // (ex.: reconectar com as trilhas já prontas).
    if (!created && pc.signalingState === 'stable') await renegotiate();
  }

  async function startPresenting() {
    if (state.presenting) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast('Este navegador não permite compartilhar a tela. Use o Chrome ou o Edge no computador.', 'err', 7000);
      return;
    }
    if (!state.otherId) {
      toast('Seu amigo ainda não entrou. Pode compartilhar — ele vê assim que entrar.', '', 5000);
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
        selfBrowserSurface: 'include',
        systemAudio: 'include',
      });
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') toast('Não foi possível capturar a tela: ' + err.message, 'err');
      return;
    }

    state.displayStream = stream;
    state.presenting = true;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => stopPresenting());

    send({ type: 'role', payload: 'presenter' });
    el.micBtn.disabled = false;
    log('Você começou a compartilhar a tela.');
    refreshUI();

    try {
      await syncTracks();
    } catch (err) {
      console.error('syncTracks', err);
      toast('Falha ao iniciar o compartilhamento.', 'err');
      stopPresenting();
    }
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

    if (state.presenting) {
      state.presenting = false;
      if (!silent) send({ type: 'stopped' });
      send({ type: 'role', payload: 'viewer' });
      teardownPC();
      el.micBtn.disabled = true;
      el.micBtn.classList.remove('is-on');
      el.micLabel.textContent = 'Microfone';
      if (!silent) log('Você parou de compartilhar.');
    } else {
      closeMixer();
    }

    el.localPip.classList.remove('on');
    el.localVideo.srcObject = null;
    el.remoteVideo.srcObject = null;
    refreshUI();
  }

  async function toggleMic() {
    if (!state.presenting) return;
    if (state.micStream) {
      for (const t of state.micStream.getTracks()) t.stop();
      state.micStream = null;
      el.micBtn.classList.remove('is-on');
      el.micLabel.textContent = 'Microfone';
      log('Microfone desligado.');
    } else {
      try {
        state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        el.micBtn.classList.add('is-on');
        el.micLabel.textContent = 'Mic ligado';
        log('Microfone ligado.');
      } catch {
        toast('Não consegui acessar o microfone.', 'err');
        return;
      }
    }
    try { await syncTracks(); } catch (e) { console.error(e); }
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
    // otherId pode apontar para alguém que já saiu: nunca confie nele sozinho.
    const other = (state.otherId && state.peers.get(state.otherId)) || null;
    const someone = !!other;
    const remotePresenting = other?.role === 'presenter';

    el.peopleCount.textContent = String(state.peers.size + 1);
    el.shareBtn.hidden = state.presenting;
    el.stopBtn.hidden = !state.presenting;
    el.soundBtn.disabled = state.presenting;

    if (state.presenting) {
      // Quem apresenta vê a própria tela em destaque (mudo, pra não dar eco).
      el.shareBtnOverlay.hidden = true;
      if (el.remoteVideo.srcObject !== state.displayStream) {
        el.remoteVideo.srcObject = state.displayStream;
        el.remoteVideo.muted = true;
        el.remoteVideo.play().catch(() => {});
      }
      el.overlay.classList.add('hidden');
      el.videoMeta.style.display = 'block';
      el.localPip.classList.toggle('on', !!state.displayStream);
      el.localVideo.srcObject = state.displayStream;
    } else {
      el.shareBtnOverlay.hidden = false;
      el.shareBtnLabel.textContent = someone ? 'Compartilhar minha tela' : 'Testar compartilhamento';
      el.localPip.classList.remove('on');
      if (!remotePresenting) {
        clearRemote(
          someone ? `${other.name} está na sala.` : 'Esperando seu amigo entrar…',
          someone ? 'Você ou ele podem clicar em “Compartilhar minha tela”.' : 'Envie o link da sala pra ele.',
        );
      }
    }
    el.soundBtn.classList.toggle('is-on', state.soundOn && !state.soundBlocked && !state.presenting);
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
    el.soundLabel.textContent = state.soundOn ? 'Som' : 'Sem som';
    refreshUI();
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

  /* Hooks de teste. __ctFeed injeta uma mensagem de sinalização falsa, o que
   * permite testar caminhos que só acontecem atrás de um proxy (room-full numa
   * reconexão) sem precisar simular a rede. */
  window.__ct = state;
  window.__ctRemote = remoteStream;
  window.__ctFeed = onSignal;

  /* ---------------- estatísticas ---------------- */
  let lastBytes = 0;
  let lastTs = 0;
  setInterval(async () => {
    if (!state.pc) return;
    try {
      const stats = await state.pc.getStats();
      const kind = state.presenting ? 'outbound-rtp' : 'inbound-rtp';
      for (const r of stats.values()) {
        if (r.type !== kind || r.kind !== 'video') continue;
        const bytes = r.bytesSent ?? r.bytesReceived ?? 0;
        const kbps = lastTs ? Math.max(0, Math.round(((bytes - lastBytes) * 8) / (r.timestamp - lastTs))) : 0;
        lastBytes = bytes; lastTs = r.timestamp;
        const w = r.frameWidth || 0;
        const h = r.frameHeight || 0;
        const fps = Math.round(r.framesPerSecond || 0);
        el.videoMeta.textContent = w ? `${w}×${h} · ${fps} fps · ${kbps} kbps` : `${kbps} kbps`;
      }
    } catch { /* noop */ }
  }, 2000);

  refreshLobbyLabel();
  refreshUI();
})();
