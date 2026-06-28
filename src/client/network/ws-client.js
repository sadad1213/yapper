import WebSocket from 'ws'
import { state, handlers, updateState, markTalking, addChatMessage, mergeChatHistory } from '../ui/app.js'
import { initUdpAudio, configureUdp, sendUdpAudio, stopUdpAudio } from './udp-audio.js'

let ws = null
let reconnectTimer = null
let audioQueueFn = null     // set to playback.queueFrame once audio is ready
let resolveUrl = null       // async () => 'ws://host:port' | null  (re-runs discovery/host election)
let stopped = false
let currentHost = null      // host of the active ws:// url — where UDP voice is sent
// The server echoes a `left` for every voluntary `leave` we send. We must NOT
// treat that echo as a forced leave (which tears capture down): when switching
// rooms directly the echo lands AFTER we've already re-joined and started the
// mic, killing it. This counts leaves we initiated so we can skip the teardown
// for their echoes; a `left` with none pending is a real server-side kick.
let pendingLeaves = 0

export function setAudioQueue(fn) {
  audioQueueFn = fn
}

// Connect using a resolver so that, after a drop, we re-discover (or become)
// a host rather than hammering a dead address.
export function connectManaged(resolver) {
  resolveUrl = resolver
  stopped = false
  initUdpAudio(handleIncomingAudio)   // UDP voice and WS voice share one receive path
  attempt()
}

// Inbound voice — same handling whether it arrived over UDP or the WS fallback.
function handleIncomingAudio(userId, opus) {
  markTalking(userId, true)
  setTimeout(() => markTalking(userId, false), 300)
  if (audioQueueFn) audioQueueFn(userId, opus)
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
  try { currentHost = new URL(url).hostname } catch { currentHost = null }
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
      handleIncomingAudio(buf.readUInt8(0), buf.slice(1))
    } else {
      try { handleSignal(JSON.parse(data.toString())) } catch {}
    }
  })

  ws.on('close', () => {
    pendingLeaves = 0         // any unacked leaves are moot once the socket drops
    stopUdpAudio()            // tear down the UDP path; the next `identified` re-arms it
    updateState({ connected: false, serverAddr: null, rooms: [], currentRoom: null })
    scheduleRetry()           // re-resolve: find the new host or become one
  })

  ws.on('error', () => {})
}

function handleSignal(msg) {
  switch (msg.type) {
    case 'identified':
      updateState({ userId: msg.userId })
      if (msg.token && msg.audioPort && currentHost) {
        configureUdp({ host: currentHost, audioPort: msg.audioPort, token: msg.token })
      }
      break
    case 'rooms':
      updateState({ rooms: msg.list })
      break
    case 'joined':
      updateState({ currentRoom: msg.room })
      break
    case 'left':
      // A forced leave (room was deleted out from under us) arrives the same
      // way as the echo of a voluntary `leave`.  Only tear capture down for a
      // genuine kick — for our own leave the audio was already handled by
      // onLeave, and tearing it down here would race a directly-following
      // re-join (room switch) and silence the mic.
      updateState({ currentRoom: null })
      if (pendingLeaves > 0) pendingLeaves--
      else handlers.onForcedLeave?.()
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
    case 'chat':
      addChatMessage(msg.room, msg.msg)
      break
    case 'chat_history':
      mergeChatHistory(msg.room, msg.messages)
      break
  }
}

export function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

export function sendAudio(frame) {
  if (state.muted) return                     // client-side mute — don't even send
  if (sendUdpAudio(frame)) return             // UDP voice path (preferred); falls through until confirmed
  if (ws?.readyState === WebSocket.OPEN) ws.send(frame)
}

export function disconnect() {
  stopped = true
  stopUdpAudio()
  clearTimeout(reconnectTimer)
  if (ws) { try { ws.terminate() } catch {}; ws = null }
}

// Wire up UI action handlers
export function wireHandlers() {
  handlers.onJoin = (room) => send({ type: 'join', room })
  handlers.onLeave = () => { pendingLeaves++; send({ type: 'leave' }) }
  handlers.onCreate = (room) => {
    send({ type: 'create', room })
    send({ type: 'join', room })
  }
  handlers.onDelete = (room) => send({ type: 'delete', room })
  handlers.onMute = (muted) => send({ type: 'mute', muted })
  handlers.onIdentify = (username) => send({ type: 'identify', username })
  handlers.onChat = (text) => send({ type: 'chat', text })
  handlers.onDisconnect = disconnect
}
