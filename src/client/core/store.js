// UI-agnostic client core: the shared application state, the action handlers
// the network layer fills in, and the small set of mutators the network calls
// to push server updates in. Both the terminal UI (`../ui/app.js`) and the
// Electron GUI (`../../../electron/main.js`) consume this module — neither the
// state nor the mutators touch any rendering layer.
//
// Every mutation emits `events.emit('change', patch)` so a UI can react (the TUI
// flips its dirty flag; the GUI forwards a state snapshot over IPC). Side effects
// kept here are UI-independent (join/leave sound cues, unread bookkeeping); any
// terminal-only reaction (chat scroll/focus reset) lives in the TUI's change
// listener, not here.

import { EventEmitter } from 'events'
import Conf from 'conf'
import { notifyRoomsChanged } from '../audio/notifications.js'

const config = new Conf({ projectName: 'yapper' })

// Fires 'change' (with the applied patch) on every state mutation.
export const events = new EventEmitter()
events.setMaxListeners(0)

// ─── State ─────────────────────────────────────────────────────────────────
export const state = {
  rooms: [],                 // [{ name, users: [{id, name, muted}] }]
  currentRoom: null,
  username: String(config.get('username') || ('user' + (Math.floor(Math.random() * 9000) + 1000))),
  userId: null,
  muted: false,
  connected: false,
  serverAddr: null,
  talking: new Set(),
  selfLevel: 0,              // live mic level of the local user (0..1)
  chat: {},                  // roomName → message[] ({userId,name,text,ts}). Local mirror, survives reconnect.
  unread: {},                // roomName → count of unseen messages (badge in the left panel)
}

// Filled in by the network layer (ws-client wireHandlers) and the audio wrapper.
export const handlers = {
  onJoin: null, onLeave: null, onCreate: null, onDelete: null, onMute: null, onForcedLeave: null, onDisconnect: null, onChat: null, onIdentify: null,
}

const CHAT_CAP = 200         // messages kept per room client-side (matches the host)
export const MAX_CHATMSG = 300         // max characters per outgoing message
const chatKey = (m) => `${m.ts}-${m.userId}-${m.text}`

// ─── Mutators (network → state) ──────────────────────────────────────────────
export function updateState(patch) {
  if (patch.rooms !== undefined) {
    notifyRoomsChanged(patch.rooms, patch.currentRoom ?? state.currentRoom, patch.userId ?? state.userId)
  }
  // Entering a (different) room clears its unread badge. (Terminal-only view
  // resets — chat scroll/focus — are handled by the TUI's change listener.)
  if (patch.currentRoom && patch.currentRoom !== state.currentRoom) {
    delete state.unread[patch.currentRoom]
  }
  Object.assign(state, patch)
  events.emit('change', patch)
}

export function markTalking(userId, active) {
  if (active) state.talking.add(userId)
  else state.talking.delete(userId)
  events.emit('change', { talking: true })
}

// ─── Chat (network → state) ───────────────────────────────────────────────────
function pushChat(room, msg) {
  const list = state.chat[room] || (state.chat[room] = [])
  if (list.some(m => chatKey(m) === chatKey(msg))) return false   // dedupe (echo / mirror overlap)
  list.push(msg)
  if (list.length > CHAT_CAP) list.splice(0, list.length - CHAT_CAP)
  return true
}

// One new message relayed from the host.
export function addChatMessage(room, msg) {
  if (!room || !msg) return
  const added = pushChat(room, msg)
  if (added && room !== state.currentRoom) state.unread[room] = (state.unread[room] || 0) + 1
  events.emit('change', { chat: true })
}

// Backlog (on join) or a host handing us history — merge, dedupe, keep order.
export function mergeChatHistory(room, messages) {
  if (!room || !Array.isArray(messages)) return
  for (const m of messages) pushChat(room, m)
  const list = state.chat[room]
  if (list) list.sort((a, b) => a.ts - b.ts)
  events.emit('change', { chat: true })
}

// Our local mirror, handed to a freshly-promoted host to seed its history.
export function getChatMirror() { return state.chat }

export function setSelfLevel(l) {
  state.selfLevel = Math.max(state.selfLevel, l)
  events.emit('change', { selfLevel: true })
}
