/* Teste E2E em navegador real: dois Chromium headless com dispositivos de mídia
 * falsos compartilham tela de verdade (WebRTC ponta a ponta).
 *
 * O puppeteer NÃO está nas dependências pra não pesar o build do Render.
 * Pra rodar:
 *   npm start                          # num terminal
 *   npm i -D puppeteer                 # uma vez (~300 MB com o Chromium)
 *   node e2e/browser.js                # ou: node e2e/browser.js https://url-no-ar
 *
 * Em Linux sem X pode faltar biblioteca do Chromium:
 *   sudo apt-get install -y libnss3 libatk-bridge2.0-0 libgbm1 libasound2 libxkbcommon0
 */
const puppeteer = require('puppeteer');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-features=AutoplayIgnoreWebAudio',
];

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const openedPages = [];

async function open(browser, label) {
  const page = await browser.newPage();
  page.__label = label;
  page.__errors = [];
  openedPages.push(page);
  // Qualquer exceção não tratada no cliente é falha do teste.
  page.on('pageerror', (e) => {
    page.__errors.push(e.message);
    console.log(`    [pageerror ${label}] ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`    [console ${label}] ${m.text().slice(0, 200)}`);
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  return page;
}

// page.click() trava quando o botão some logo após o clique (o Puppeteer fica
// esperando o elemento voltar a ficar visível). Clique via evaluate é determinístico.
async function click(page, sel) {
  await page.evaluate((s) => document.querySelector(s).click(), sel);
}

async function setVal(page, sel, value) {
  await page.evaluate((s, v) => { document.querySelector(s).value = v; }, sel, value);
}

async function enterRoom(page, name, code = null) {
  // page.type() concatena com o nome lembrado no localStorage (as duas abas
  // compartilham a origem), então setamos o valor direto.
  await setVal(page, '#nameInput', name);
  if (code) await setVal(page, '#codeInput', code);
  await click(page, code ? '#joinBtn' : '#lobbyForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('room').classList.contains('hidden'), { timeout: 8000 });
  return page.$eval('#roomCode', (n) => n.textContent.trim());
}

async function waitFor(page, fn, timeout = 20000, arg = null) {
  try {
    await page.waitForFunction(fn, { timeout, polling: 300 }, arg);
    return true;
  } catch { return false; }
}

const hasRemoteVideo = () => {
  const v = document.getElementById('remoteVideo');
  return !!v.srcObject && v.videoWidth > 0 && v.readyState >= 2;
};

async function framesAdvancing(page) {
  const read = () => page.$eval('#remoteVideo', (v) => v.webkitDecodedFrameCount ?? 0);
  const a = await read();
  await new Promise((r) => setTimeout(r, 1500));
  const b = await read();
  return { a, b, advancing: b > a };
}

const view = () => ({
  overlayHidden: document.getElementById('videoOverlay').classList.contains('hidden'),
  overlayTitle: document.getElementById('overlayTitle').textContent,
  remoteW: document.getElementById('remoteVideo').videoWidth,
  remoteHasStream: !!document.getElementById('remoteVideo').srcObject,
  pipOn: document.getElementById('localPip').classList.contains('on'),
  presenting: !document.getElementById('stopBtn').hidden,
  people: document.getElementById('peopleCount').textContent,
});

async function scenario(title, fn) {
  console.log(`\n▶ ${title}`);
  openedPages.length = 0;
  const browser = await puppeteer.launch({ headless: true, args: ARGS, protocolTimeout: 60000 });
  try {
    await fn(browser);
  } catch (e) {
    console.log(`  ✖ exceção: ${e.message}`);
    failures++;
  } finally {
    const errs = openedPages.flatMap((p) => (p.__errors || []).map((m) => `${p.__label}: ${m}`));
    check('nenhuma exceção de JS na página', errs.length === 0, errs.join(' | '));
    await browser.close();
  }
}

(async () => {
  console.log(`alvo: ${BASE}`);

  // ---------- 1. fluxo normal ----------
  await scenario('1. A entra, B entra, A compartilha → B vê a tela', async (browser) => {
    const a = await open(browser, 'A');
    const code = await enterRoom(a, 'Gabriel');
    const b = await open(browser, 'B');
    await enterRoom(b, 'Amigo', code);

    check('B vê 2 pessoas na sala', await waitFor(b, () => document.getElementById('peopleCount').textContent === '2', 8000));

    await click(a, '#shareBtn');
    const got = await waitFor(b, hasRemoteVideo, 25000);
    check('B recebe vídeo de A', got, got ? '' : `estado B: ${JSON.stringify(await b.evaluate(view))}`);

    if (got) {
      const f = await framesAdvancing(b);
      check('frames de B estão avançando', f.advancing, `decodificados ${f.a} → ${f.b}`);
    }

    const va = await a.evaluate(view);
    check('A está no modo apresentador', va.presenting);
    check('A vê a própria tela em destaque (overlay some)', va.overlayHidden,
      va.overlayHidden ? '' : `overlay visível dizendo: "${va.overlayTitle}"`);
    check('A vê a própria imagem grande (não só o PiP)', va.remoteW > 0, `videoWidth=${va.remoteW}`);
  });

  // ---------- 2. compartilhar ANTES do amigo entrar ----------
  await scenario('2. A compartilha ANTES de B entrar → B deve ver assim que entrar', async (browser) => {
    const a = await open(browser, 'A');
    const code = await enterRoom(a, 'Gabriel');

    await click(a, '#shareBtn');
    await waitFor(a, () => !document.getElementById('stopBtn').hidden, 8000);
    check('A está compartilhando sozinho na sala', true);

    const b = await open(browser, 'B');
    await enterRoom(b, 'Amigo', code);

    const got = await waitFor(b, hasRemoteVideo, 25000);
    check('B recebe a tela mesmo tendo entrado depois', got,
      got ? '' : `estado B: ${JSON.stringify(await b.evaluate(view))}`);
  });

  // ---------- 3. parar e voltar a compartilhar ----------
  await scenario('3. A para e volta a compartilhar → B volta a ver', async (browser) => {
    const a = await open(browser, 'A');
    const code = await enterRoom(a, 'Gabriel');
    const b = await open(browser, 'B');
    await enterRoom(b, 'Amigo', code);

    await click(a, '#shareBtn');
    const first = await waitFor(b, hasRemoteVideo, 25000);
    check('primeira apresentação chega em B', first);

    await click(a, '#stopBtn');
    const cleared = await waitFor(b, () => !document.getElementById('remoteVideo').srcObject, 8000);
    check('B limpa o vídeo quando A para', cleared);

    await click(a, '#shareBtn');
    const second = await waitFor(b, hasRemoteVideo, 25000);
    check('segunda apresentação chega em B', second,
      second ? '' : `estado B: ${JSON.stringify(await b.evaluate(view))}`);
  });

  // ---------- 4. chat ----------
  await scenario('4. chat vai e volta', async (browser) => {
    const a = await open(browser, 'A');
    const code = await enterRoom(a, 'Gabriel');
    const b = await open(browser, 'B');
    await enterRoom(b, 'Amigo', code);
    await waitFor(b, () => document.getElementById('peopleCount').textContent === '2', 8000);

    await a.type('#chatInput', 'oi, tá vendo?');
    await click(a, '#chatForm button[type=submit]');
    const got = await waitFor(b, () =>
      [...document.querySelectorAll('#chatLog .msg-text')].some((n) => n.textContent === 'oi, tá vendo?'), 8000);
    check('mensagem de A aparece em B', got);
  });

  // ---------- 5. microfone durante a apresentação ----------
  await scenario('5. ligar o microfone no meio da apresentação não derruba o vídeo', async (browser) => {
    const a = await open(browser, 'A');
    const code = await enterRoom(a, 'Gabriel');
    const b = await open(browser, 'B');
    await enterRoom(b, 'Amigo', code);
    await waitFor(b, () => document.getElementById('peopleCount').textContent === '2', 8000);

    await click(a, '#shareBtn');
    const before = await waitFor(b, hasRemoteVideo, 25000);
    check('vídeo chega antes do mic', before);
    const f1 = await framesAdvancing(b);

    await click(a, '#micBtn');
    await waitFor(a, () => window.__ct.micStream !== null, 8000);
    await new Promise((r) => setTimeout(r, 1500));

    const audioOn = await a.evaluate(() => {
      const s = window.__ct;
      const sender = s.audioSender;
      return { hasMic: !!s.micStream, senderKind: sender?.track?.kind || null, senderLive: sender?.track?.readyState === 'live' };
    });
    check('microfone virou trilha de áudio enviada', audioOn.hasMic && audioOn.senderLive, JSON.stringify(audioOn));

    const f2 = await framesAdvancing(b);
    check('vídeo continua chegando depois de ligar o mic', f2.advancing, `decodificados ${f2.a} → ${f2.b}`);

    await click(a, '#micBtn');
    await waitFor(a, () => window.__ct.micStream === null, 8000);
    const f3 = await framesAdvancing(b);
    check('vídeo continua depois de desligar o mic', f3.advancing, `decodificados ${f3.a} → ${f3.b}`);
    check('B nunca perdeu o stream', await b.evaluate(() => !!document.getElementById('remoteVideo').srcObject));
  });

  // ---------- 6. queda do WebSocket no meio da apresentação ----------
  await scenario('6. queda do WebSocket no meio da apresentação se recupera sozinha', async (browser) => {
    const a = await open(browser, 'A');
    const code = await enterRoom(a, 'Gabriel');
    const b = await open(browser, 'B');
    await enterRoom(b, 'Amigo', code);

    await click(a, '#shareBtn');
    const before = await waitFor(b, hasRemoteVideo, 25000);
    check('vídeo chega antes da queda', before);

    // derruba o socket de A de propósito (o que o plano free do Render faz sozinho)
    const selfBefore = await a.evaluate(() => window.__ct.selfId);
    await a.evaluate(() => { window.__wsBefore = window.__ct.ws; window.__ct.ws.close(); });
    // waitForFunction com polling default usa requestAnimationFrame, que não roda
    // em aba não visível — por isso o helper usa polling numérico.
    const reconnected = await waitFor(a, () =>
      window.__ct.ws !== window.__wsBefore && window.__ct.ws?.readyState === 1 && window.__ct.selfId !== null, 30000);
    check('A reconectou com um socket novo', reconnected);
    const newSelf = await a.evaluate(() => window.__ct.selfId);
    check('A ganhou identidade nova no servidor', newSelf !== selfBefore, `${selfBefore?.slice(0, 6)} → ${newSelf?.slice(0, 6)}`);

    const role = await waitFor(b, () => [...window.__ct.peers.values()].some((p) => p.role === 'presenter'), 20000);
    check('B volta a ver A como apresentador', role,
      role ? '' : `papéis: ${JSON.stringify(await b.evaluate(() => [...window.__ct.peers.values()]))}`);

    const back = await waitFor(b, hasRemoteVideo, 30000);
    check('B volta a ver a tela depois da queda', back,
      back ? '' : `estado B: ${JSON.stringify(await b.evaluate(view))}`);
    if (back) {
      const f = await framesAdvancing(b);
      check('e os quadros voltam a avançar', f.advancing, `decodificados ${f.a} → ${f.b}`);
    }
  });

  console.log(`\n${failures === 0 ? 'TUDO PASSOU' : `${failures} FALHA(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
