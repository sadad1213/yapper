import { WebSocketServer } from 'ws'
import dgram from 'dgram'
import { randomBytes } from 'crypto'
import { rooms, addRoom, deleteRoom, appendChat, getChat, seedChat, DEFAULTS } from './rooms.js'

export { seedChat }   // re-exported so index.js can seed history on host promotion

export const DEFAULT_PORT = 4747
export const AUDIO_PORT = 4749        // UDP voice relay (4748 is discovery)
let nextId = 1

// Map<ws, { id, username, room, muted, ws, token, udp, udpSeen }>
const clients = new Map()
// token(hex) → client, so a UDP voice packet can be traced back to its sender
const byToken = new Map()

let audioSocket = null                // host's UDP voice relay socket (null until hosting)
const UDP_FRESH_MS = 6000             // a peer's UDP path is considered dead after this gap → WS
const ACK = Buffer.from([0x00])       // 1-byte UDP reply: "got it, UDP works"

function roomList() {
  const map = new Map()
  for (const name of rooms) map.set(name, { name, users: [] })
  for (const client of clients.values()) {
    if (!client.room) continue
    if (!map.has(client.room)) map.set(client.room, { name: client.room, users: [] })
    map.get(client.room).users.push({ id: client.id, name: client.username, muted: !!client.muted, deafened: !!client.deafened })
  }
  return [...map.values()]
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj))
}

function broadcast(obj) {
  const msg = JSON.stringify(obj)
  for (const ws of clients.keys()) {
    if (ws.readyState === 1) ws.send(msg)
  }
}

function handleSignal(ws, msg) {
  const client = clients.get(ws)
  if (!client) return

  if (msg.type === 'identify') {
    client.username = String(msg.username || client.username).slice(0, 32)
    broadcast({ type: 'rooms', list: roomList() })
  } else if (msg.type === 'join') {
    const name = String(msg.room).slice(0, 64)
    if (!rooms.has(name)) addRoom(name)
    client.room = name
    send(ws, { type: 'joined', room: name })
    send(ws, { type: 'chat_history', room: name, messages: getChat(name) })   // backlog for the joiner
    broadcast({ type: 'rooms', list: roomList() })
  } else if (msg.type === 'leave') {
    client.room = null
    send(ws, { type: 'left' })
    broadcast({ type: 'rooms', list: roomList() })
  } else if (msg.type === 'create') {
    const name = String(msg.room).slice(0, 64)
    addRoom(name)
    broadcast({ type: 'rooms', list: roomList() })
  } else if (msg.type === 'delete') {
    const name = String(msg.room).slice(0, 64)
    if (!DEFAULTS.includes(name) && rooms.has(name)) {
      // Kick everyone still in the room about to disappear, then delete it.
      // Each kicked client gets a `left` so its capture stops cleanly.
      for (const [otherWs, other] of clients) {
        if (other.room === name) {
          other.room = null
          send(otherWs, { type: 'left' })
        }
      }
      deleteRoom(name)
      broadcast({ type: 'rooms', list: roomList() })
    }
  } else if (msg.type === 'mute') {
    client.muted = !!msg.muted
    broadcast({ type: 'user_mute', userId: client.id, muted: client.muted })
  } else if (msg.type === 'deafen') {
    client.deafened = !!msg.deafened
    broadcast({ type: 'user_deafen', userId: client.id, deafened: client.deafened })
  } else if (msg.type === 'chat') {
    if (!client.room) return
    const text = String(msg.text || '').trim().slice(0, 300)
    if (!text) return
    // Server-authoritative record — never trust client-supplied id/name/ts.
    const record = { userId: client.id, name: client.username, text, ts: Date.now() }
    appendChat(client.room, record)
    // Relay to everyone in the room INCLUDING the sender (so it renders the same
    // for all). Room-scoped, so not broadcast().
    for (const c of clients.values()) {
      if (c.room === client.room && c.ws.readyState === 1) {
        send(c.ws, { type: 'chat', room: client.room, msg: record })
      }
    }
  }
}

// Forward one Opus frame from `sender` to everyone else in the room, choosing
// each recipient's path independently: UDP when we've heard from them recently
// (lower latency, loss-tolerant), else the WS/TCP fallback. The host bridges, so
// a WS sender still reaches UDP listeners and vice versa.
function relayAudio(sender, opus) {
  if (!sender.room || sender.muted) return

  // Prepend 1-byte userId so the receiver knows who is talking
  const frame = Buffer.allocUnsafe(1 + opus.length)
  frame.writeUInt8(sender.id & 0xff, 0)
  opus.copy(frame, 1)

  const now = Date.now()
  for (const peer of clients.values()) {
    if (peer === sender || peer.room !== sender.room) continue
    if (audioSocket && peer.udp && now - peer.udpSeen < UDP_FRESH_MS) {
      try { audioSocket.send(frame, peer.udp.port, peer.udp.address) } catch {}
    } else if (peer.ws.readyState === 1) {
      peer.ws.send(frame)
    }
  }
}

function handleAudio(ws, data) {
  const sender = clients.get(ws)
  if (sender) relayAudio(sender, data)
}

// UDP voice from clients: [token(4)][opus] is audio; [token(4)] alone is a
// keepalive (also learns the client's return address and holds NAT open).
function handleUdp(msg, rinfo) {
  if (msg.length < 4) return
  const client = byToken.get(msg.toString('hex', 0, 4))
  if (!client) return
  client.udp = { address: rinfo.address, port: rinfo.port }
  client.udpSeen = Date.now()
  if (msg.length === 4) {
    try { audioSocket.send(ACK, rinfo.port, rinfo.address) } catch {}   // confirm UDP works
    return
  }
  relayAudio(client, msg.subarray(4))
}

// Start the host's UDP voice relay. Best-effort: if it can't bind, clients just
// keep using the WS audio path.
export function startAudioRelay(port = AUDIO_PORT) {
  const sock = dgram.createSocket('udp4')
  sock.on('message', handleUdp)
  sock.on('error', () => {})
  sock.on('close', () => { if (audioSocket === sock) audioSocket = null })
  try { sock.bind(port) } catch {}
  audioSocket = sock
  return sock
}

// Resolves once the server is listening; rejects on bind error (e.g. EADDRINUSE),
// which the caller uses to detect that someone else already won the host slot.
export function startWsServer(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port })

    wss.on('error', reject)
    wss.on('listening', () => resolve(wss))

    wss.on('connection', (ws) => {
      const id = nextId > 255 ? (nextId = 1) : nextId++
      const token = randomBytes(4).toString('hex')
      const client = { id, username: `user${id}`, room: null, muted: false, deafened: false, ws, token, udp: null, udpSeen: 0 }
      clients.set(ws, client)
      byToken.set(token, client)

      ws.on('message', (data, isBinary) => {
        if (isBinary) handleAudio(ws, data)
        else {
          try { handleSignal(ws, JSON.parse(data.toString())) } catch {}
        }
      })

      ws.on('close', () => {
        clients.delete(ws)
        byToken.delete(token)
        broadcast({ type: 'rooms', list: roomList() })
      })

      // token + audioPort let the client open the UDP voice path (with WS fallback)
      send(ws, { type: 'identified', userId: id, token, audioPort: AUDIO_PORT })
      send(ws, { type: 'rooms', list: roomList() })
    })
  })
}
