import { WebSocketServer } from 'ws'
import Bonjour from 'bonjour-service'
import { rooms, addRoom } from './rooms.js'

const PORT = 4747
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

  // Prepend 1-byte userId so receiver knows who's talking
  const frame = Buffer.allocUnsafe(1 + data.length)
  frame.writeUInt8(sender.id & 0xff, 0)
  data.copy(frame, 1)

  for (const [otherWs, other] of clients) {
    if (other.room === sender.room && otherWs !== ws && otherWs.readyState === 1) {
      otherWs.send(frame)
    }
  }
}

export function startWsServer() {
  const wss = new WebSocketServer({ port: PORT })
  const bonjour = new Bonjour()

  bonjour.publish({ name: 'yapper', type: 'yapper', port: PORT })
  console.log(`yapper server listening on ws://0.0.0.0:${PORT}`)
  console.log('Broadcasting on local network via mDNS...')

  wss.on('connection', (ws) => {
    const id = nextId > 255 ? (nextId = 1) && nextId++ : nextId++
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

  return wss
}
