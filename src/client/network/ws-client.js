import WebSocket from 'ws'
import { state, handlers, updateState, markTalking } from '../ui/app.js'

let ws = null
let reconnectTimer = null
let audioQueueFn = null   // set to playback.queueFrame once audio is ready

export function setAudioQueue(fn) {
  audioQueueFn = fn
}

export function connect(url) {
  if (ws) ws.terminate()

  ws = new WebSocket(url)

  ws.on('open', () => {
    clearTimeout(reconnectTimer)
    updateState({ connected: true, serverAddr: url.replace('ws://', '') })
    send({ type: 'identify', username: state.username })
  })

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary: [userId byte][opus data...]
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (buf.length < 2) return
      const userId = buf.readUInt8(0)
      const opus = buf.slice(1)
      markTalking(userId, true)
      setTimeout(() => markTalking(userId, false), 300)
      if (audioQueueFn) audioQueueFn(userId, opus)
    } else {
      try { handleSignal(JSON.parse(data.toString())) } catch {}
    }
  })

  ws.on('close', () => {
    updateState({ connected: false, serverAddr: null, rooms: [], currentRoom: null })
    reconnectTimer = setTimeout(() => connect(url), 3000)
  })

  ws.on('error', () => {})
}

function handleSignal(msg) {
  switch (msg.type) {
    case 'identified':
      updateState({ userId: msg.userId })
      break
    case 'rooms':
      updateState({ rooms: msg.list })
      break
    case 'joined':
      updateState({ currentRoom: msg.room })
      break
    case 'left':
      updateState({ currentRoom: null })
      break
    case 'user_mute': {
      // Update muted status in the room's user list
      const rooms = state.rooms.map(r => ({
        ...r,
        users: r.users.map(u => u.id === msg.userId ? { ...u, muted: msg.muted } : u),
      }))
      updateState({ rooms })
      break
    }
  }
}

export function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

export function sendAudio(frame) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(frame)
}

export function disconnect() {
  clearTimeout(reconnectTimer)
  if (ws) { ws.terminate(); ws = null }
}

// Wire up UI action handlers
export function wireHandlers() {
  handlers.onJoin = (room) => send({ type: 'join', room })
  handlers.onLeave = () => send({ type: 'leave' })
  handlers.onCreate = (room) => {
    send({ type: 'create', room })
    send({ type: 'join', room })
  }
  handlers.onMute = (muted) => send({ type: 'mute', muted })
  handlers.onDisconnect = disconnect
}
