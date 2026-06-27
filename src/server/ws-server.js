import { WebSocketServer } from 'ws'
import { rooms, addRoom } from './rooms.js'

export const DEFAULT_PORT = 4747
let nextId = 1

// Map<ws, { id, username, room: string|null, muted: bool }>
const clients = new Map()

function roomList() {
  const map = new Map()
  for (const name of rooms) map.set(name, { name, users: [] })
  for (const client of clients.values()) {
    if (!client.room) continue
    if (!map.has(client.room)) map.set(client.room, { name: client.room, users: [] })
    map.get(client.room).users.push({ id: client.id, name: client.username, muted: !!client.muted })
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
    send(ws, { type: 'rooms', list: roomList() })
  } else if (msg.type === 'join') {
    const name = String(msg.room).slice(0, 64)
    if (!rooms.has(name)) addRoom(name)
    client.room = name
    send(ws, { type: 'joined', room: name })
    broadcast({ type: 'rooms', list: roomList() })
  } else if (msg.type === 'leave') {
    client.room = null
    send(ws, { type: 'left' })
    broadcast({ type: 'rooms', list: roomList() })
  } else if (msg.type === 'create') {
    const name = String(msg.room).slice(0, 64)
    addRoom(name)
    broadcast({ type: 'rooms', list: roomList() })
  } else if (msg.type === 'mute') {
    client.muted = !!msg.muted
    broadcast({ type: 'user_mute', userId: client.id, muted: client.muted })
  }
}

function handleAudio(ws, data) {
  const sender = clients.get(ws)
  if (!sender || !sender.room) return

  // Prepend 1-byte userId so the receiver knows who is talking
  const frame = Buffer.allocUnsafe(1 + data.length)
  frame.writeUInt8(sender.id & 0xff, 0)
  data.copy(frame, 1)

  for (const [otherWs, other] of clients) {
    if (other.room === sender.room && otherWs !== ws && otherWs.readyState === 1) {
      otherWs.send(frame)
    }
  }
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
      const client = { id, username: `user${id}`, room: null, muted: false }
      clients.set(ws, client)

      ws.on('message', (data, isBinary) => {
        if (isBinary) handleAudio(ws, data)
        else {
          try { handleSignal(ws, JSON.parse(data.toString())) } catch {}
        }
      })

      ws.on('close', () => {
        clients.delete(ws)
        broadcast({ type: 'rooms', list: roomList() })
      })

      send(ws, { type: 'identified', userId: id })
      send(ws, { type: 'rooms', list: roomList() })
    })
  })
}
