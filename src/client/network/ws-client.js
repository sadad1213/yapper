import WebSocket from 'ws'
import { state, handlers, updateState, markTalking } from '../ui/app.js'

let ws = null
let reconnectTimer = null
let audioQueueFn = null     // set to playback.queueFrame once audio is ready
let resolveUrl = null       // async () => 'ws://host:port' | null  (re-runs discovery/host election)
let stopped = false

export function setAudioQueue(fn) {
  audioQueueFn = fn
}

// Connect using a resolver so that, after a drop, we re-discover (or become)
// a host rather than hammering a dead address.
export function connectManaged(resolver) {
  resolveUrl = resolver
  stopped = false
  attempt()
}

async function attempt() {
  if (stopped) return
  let url
  try { url = await resolveUrl() } catch { url = null }
  if (stopped) return
  if (!url) { scheduleRetry(); return }
  openSocket(url)
}

function scheduleRetry() {
  clearTimeout(reconnectTimer)
  // jitter avoids every orphaned client trying to become host at the same instant
  reconnectTimer = setTimeout(attempt, 600 + Math.random() * 1200)
}

function openSocket(url) {
  if (ws) { try { ws.terminate() } catch {} }
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
    scheduleRetry()           // re-resolve: find the new host or become one
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
      // A forced leave (room was deleted out from under us) arrives the same
      // way as a voluntary one.  Stop capture locally without re-sending
      // `leave` — server-side the room is already gone / nulled.
      updateState({ currentRoom: null })
      handlers.onForcedLeave?.()
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
  if (state.muted) return                     // client-side mute — don't even send
  if (ws?.readyState === WebSocket.OPEN) ws.send(frame)
}

export function disconnect() {
  stopped = true
  clearTimeout(reconnectTimer)
  if (ws) { try { ws.terminate() } catch {}; ws = null }
}

// Wire up UI action handlers
export function wireHandlers() {
  handlers.onJoin = (room) => send({ type: 'join', room })
  handlers.onLeave = () => send({ type: 'leave' })
  handlers.onCreate = (room) => {
    send({ type: 'create', room })
    send({ type: 'join', room })
  }
  handlers.onDelete = (room) => send({ type: 'delete', room })
  handlers.onMute = (muted) => send({ type: 'mute', muted })
  handlers.onIdentify = (username) => send({ type: 'identify', username })
  handlers.onDisconnect = disconnect
}
