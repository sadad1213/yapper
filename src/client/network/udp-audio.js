import dgram from 'dgram'

// Client side of the UDP voice path.
//
// Why UDP: voice over TCP (our WS path) stalls and crackles on a lossy link —
// TCP retransmits and holds later audio behind the lost packet (head-of-line
// blocking). On UDP a lost frame is simply skipped and Opus conceals it, so the
// stream keeps flowing. We keep WS for signaling and as an automatic fallback.
//
// Flow: the server hands us a per-session token + its audio port in `identified`.
// We send the host `[token(4)][opus]` for voice and `[token]` alone as a periodic
// keepalive (which also teaches the host our return address and holds the NAT
// mapping open). The host replies to a keepalive with a 1-byte ACK; receiving
// anything over UDP is our proof the path works, so we flip to sending voice over
// UDP. If UDP goes quiet we revert to WS. Inbound voice arrives as `[userId][opus]`.

const KEEPALIVE_MS = 2000
const UDP_TIMEOUT_MS = 5000      // no UDP from host for this long → assume it died, fall back to WS

let socket = null
let host = null, port = 0
let token = null                 // Buffer(4)
let udpUp = false
let lastRecv = 0
let kaTimer = null
let onAudio = null               // (userId, opusBuf) => void

// Wire the inbound-voice handler once; shared with the WS receive path.
export function initUdpAudio(cb) { onAudio = cb }

// (Re)point the UDP path at the current host. Called on every `identified`, so a
// reconnect or host change re-establishes cleanly.
export function configureUdp({ host: h, audioPort, token: tokenHex }) {
  stopUdpAudio()
  if (!h || !audioPort || !tokenHex) return
  host = h
  port = audioPort
  token = Buffer.from(tokenHex, 'hex')
  udpUp = false
  lastRecv = 0

  socket = dgram.createSocket('udp4')
  socket.on('message', (msg) => {
    lastRecv = Date.now()
    if (msg.length === 1) { udpUp = true; return }            // ACK — UDP confirmed
    if (msg.length >= 2 && onAudio) onAudio(msg.readUInt8(0), msg.subarray(1))
  })
  socket.on('error', () => {})                                // a UDP hiccup must never crash us

  sendKeepalive()                                             // probe immediately so UDP comes up fast
  kaTimer = setInterval(() => {
    if (udpUp && Date.now() - lastRecv > UDP_TIMEOUT_MS) udpUp = false   // path went quiet → WS
    sendKeepalive()
  }, KEEPALIVE_MS)
}

function sendKeepalive() {
  if (!socket || !token) return
  try { socket.send(token, port, host) } catch {}
}

// Send one Opus frame over UDP. Returns true if it went out — the caller skips
// the WS path so audio is never duplicated. Returns false until UDP is confirmed.
export function sendUdpAudio(opus) {
  if (!udpUp || !socket || !token) return false
  const pkt = Buffer.allocUnsafe(token.length + opus.length)
  token.copy(pkt, 0)
  opus.copy(pkt, token.length)
  try { socket.send(pkt, port, host); return true } catch { return false }
}

export function isUdpUp() { return udpUp }

export function stopUdpAudio() {
  if (kaTimer) { clearInterval(kaTimer); kaTimer = null }
  if (socket) { try { socket.close() } catch {} ; socket = null }
  udpUp = false
}
