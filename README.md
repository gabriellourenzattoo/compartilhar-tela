# Compartilhar Tela 🖥️

Mostre sua tela pra um amigo direto do navegador — sem instalar nada, sem cadastro.

**Como funciona:** você cria uma sala, recebe um link de 5 letras, manda pro seu amigo. Ele abre,
você clica em *Compartilhar minha tela* e pronto. A tela vai **direto de você pra ele** (WebRTC
P2P, criptografada DTLS-SRTP). O servidor só apresenta os dois — ele **nunca vê nem grava o vídeo**.

## Recursos

- 🎬 Compartilhamento de tela inteira, janela ou aba
- 🔊 Áudio do sistema junto com a tela (Chrome/Edge)
- 🎤 Microfone opcional, mixado com o áudio do sistema
- ↔️ Qualquer um dos dois pode apresentar (negociação perfeita, sem conflito)
- 💬 Chat de texto na lateral
- 📊 Indicador de resolução / fps / bitrate em tempo real
- 📱 Quem assiste pode usar o celular; quem apresenta precisa de computador
- 🔁 Reconexão automática se a rede cair
- ⛔ Sala limitada a 2 pessoas, código aleatório, descartada quando fica vazia

## Rodando local

```bash
npm install
npm start          # http://localhost:3000
npm test           # 14 testes de integração do servidor de sinalização
```

> `getDisplayMedia` exige contexto seguro: use `https://` ou `http://localhost`.

## Testes

**Servidor** (`npm test`) — sobe o servidor numa porta efêmera e valida o protocolo de
sinalização: entrada na sala, retransmissão de SDP/ICE só para o outro participante, chat,
`peer-left` com o papel de quem saiu, sala 1:1, descarte de sala vazia, códigos inválidos,
reconexão de quem já estava apresentando e `/config`.

**Navegador** (`e2e/browser.js`) — dois Chromium headless com dispositivos de mídia falsos
compartilham tela **de verdade**, ponta a ponta. Cobre:

1. A entra, B entra, A compartilha → B recebe vídeo e os quadros avançam; A vê a própria tela
2. A compartilha **antes** de B entrar → B recebe assim que entra
3. A para e volta a compartilhar → B volta a ver
4. Chat vai e volta
5. Ligar/desligar o microfone no meio da apresentação não derruba o vídeo
6. Queda do WebSocket no meio da apresentação se recupera sozinha (o papel de
   apresentador sobrevive à reconexão e a tela volta)

```bash
npm i -D puppeteer        # uma vez; não está nas deps pra não pesar o build
node e2e/browser.js       # com o servidor rodando
```

## Estrutura

```
server.js          servidor Express + WebSocket (só sinalização SDP/ICE + chat)
public/index.html  interface
public/app.js      cliente WebRTC
public/styles.css  tema
test/              testes (node:test)
```

## Deploy no Render

Web service Node no plano free:

| Campo | Valor |
|---|---|
| Build | `npm ci --omit=dev` |
| Start | `node server.js` |
| Health check | `/healthz` |
| Porta | `$PORT` (Render injeta) |

O serviço é stateless e roda em uma única instância, então as salas em memória funcionam sem
Redis. Se você escalar para mais de uma instância, a sinalização precisa de um pub/sub.

### Variáveis de ambiente (opcionais)

| Nome | Uso |
|---|---|
| `TURN_URL` | `turn:host:3478` — melhora a conexão atrás de NATs restritivos |
| `TURN_USERNAME` | usuário do TURN |
| `TURN_CREDENTIAL` | senha do TURN |

Sem TURN o app usa STUN público e funciona na maioria das redes; em NATs simétricos (algumas
redes de empresa/celular) a conexão direta pode falhar.

## Limitações do plano free do Render

- Dorme após 15 min sem tráfego; o primeiro acesso depois leva ~1 min pra acordar.
- Mensagens de WebSocket contam como tráfego, então uma tela sendo compartilhada mantém vivo.

## Privacidade

Nada é gravado. O servidor guarda apenas: código da sala, nome e papel (apresentador/espectador)
dos dois participantes, em memória, até a sala esvaziar.
