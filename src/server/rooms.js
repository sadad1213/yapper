// Tracks which room names exist (membership is tracked in ws-server via clients map)
import Conf from 'conf'

const config = new Conf({ projectName: 'yapper' })

export const DEFAULTS = ['general', 'gaming', 'music']

export const rooms = new Set(DEFAULTS)

// Restore custom rooms saved from a previous host session
const saved = config.get('rooms', [])
if (Array.isArray(saved)) saved.forEach(name => rooms.add(name))

function persist() {
  const custom = [...rooms].filter(r => !DEFAULTS.includes(r))
  config.set('rooms', custom)
}

export function addRoom(name) {
  rooms.add(name)
  persist()
}

export function hasRoom(name) {
  return rooms.has(name)
}

// Remove a custom room.  Default rooms are permanent and cannot be deleted.
export function deleteRoom(name) {
  if (DEFAULTS.includes(name)) return false
  if (!rooms.has(name)) return false
  rooms.delete(name)
  chat.delete(name)
  persist()
  persistChat()
  return true
}

// ─── Per-room chat history (host-side) ─────────────────────────────────────────
// Kept in memory and mirrored to the shared conf store so it survives a host
// restart. A message is { userId, name, text, ts }. Identity for dedupe (used
// when merging a promoting client's mirror on host change) is ts+userId+text.

const CHAT_CAP = 200          // messages kept per room

const chat = new Map()        // roomName → message[]  (oldest first)

// Restore history saved by a previous host session.
const savedChat = config.get('chatHistory', {})
if (savedChat && typeof savedChat === 'object') {
  for (const [room, msgs] of Object.entries(savedChat)) {
    if (Array.isArray(msgs)) chat.set(room, msgs.slice(-CHAT_CAP))
  }
}

function persistChat() {
  config.set('chatHistory', Object.fromEntries(chat))
}

const msgKey = (m) => `${m.ts}-${m.userId}-${m.text}`

export function appendChat(room, msg) {
  const list = chat.get(room) || []
  list.push(msg)
  if (list.length > CHAT_CAP) list.splice(0, list.length - CHAT_CAP)
  chat.set(room, list)
  persistChat()
}

export function getChat(room) {
  return chat.get(room) || []
}

// Merge a {room: msg[]} mirror (e.g. from a client being promoted to host) into
// our history, deduping and keeping chronological order. Lets chat survive a
// host change as long as some participant still had it.
export function seedChat(incoming) {
  if (!incoming || typeof incoming !== 'object') return
  for (const [room, msgs] of Object.entries(incoming)) {
    if (!Array.isArray(msgs)) continue
    const merged = chat.get(room) || []
    const seen = new Set(merged.map(msgKey))
    for (const m of msgs) {
      if (!m || typeof m.ts !== 'number') continue
      const k = msgKey(m)
      if (!seen.has(k)) { seen.add(k); merged.push(m) }
    }
    merged.sort((a, b) => a.ts - b.ts)
    chat.set(room, merged.slice(-CHAT_CAP))
  }
  persistChat()
}
