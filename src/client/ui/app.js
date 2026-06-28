import termkit from 'terminal-kit'
import Conf from 'conf'
import { createRequire } from 'module'
import { getThreshold, setThreshold } from '../audio/vad.js'
import { setDenoiseEnabled, isDenoiseEnabled, isDenoiseAvailable } from '../audio/denoise.js'
import { getUserVolume, setUserVolume } from '../audio/playback.js'
import { notifyRoomsChanged, notifyUpdateFound, notifyMuted, notifyUnmuted, notifyLeaving } from '../audio/notifications.js'
import { preloadAll } from '../audio/loader.js'
import { checkForUpdate, clearPendingUpdate, checkForUpdateManual, fetchChangelog } from '../../auto-update.js'
import { HOTKEY_PRESETS, presetIndex, setMuteHotkey, stopHotkey } from '../hotkey.js'

const term = termkit.terminal
const config = new Conf({ projectName: 'yapper' })
// Captured at module load (before startUI writes anything): tells an update from
// an old version (conf already had data → existing user) apart from a genuinely
// fresh install (conf empty). Only existing users get the "what's new" hint.
const _hadConfig = Object.keys(config.store).length > 0

const require = createRequire(import.meta.url)
const VERSION = require('../../../package.json').version

const LEFT_W = 22            // min inner width of the left (rooms) panel
const THREE_COL_MIN = 70    // terminal width at/above which the middle column is shown
const MAX_USERNAME = 16       // short chars; server-side slice(0, 32) lets it through
const MAX_ROOMNAME = 20       // short enough to fit a sidebar row: `▸ <name> <count>` in LEFT_W

// Default rooms are permanent — keep in sync with src/server/rooms.js DEFAULTS.
const DEFAULT_ROOMS = new Set(['general', 'gaming', 'music'])

// Mic sensitivity (VAD gate) — a continuous slider. Higher = you must speak
// louder before transmitting, which keeps keyboard clatter and background noise
// off-air. Stepped in VAD_STEP so the arrows feel like a slider.
const VAD_MIN = 50, VAD_MAX = 3000, VAD_STEP = 50

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

export const handlers = {
  onJoin: null, onLeave: null, onCreate: null, onDelete: null, onMute: null, onForcedLeave: null, onDisconnect: null, onChat: null,
}

const CHAT_CAP = 200         // messages kept per room client-side (matches the host)
const MAX_CHATMSG = 300      // max characters per outgoing message
const chatKey = (m) => `${m.ts}-${m.userId}-${m.text}`

let audioApi = null          // injected via registerAudio()
let updateAvailable = false  // set by checkForUpdate() after startup — remote version is newer
const SEEN_KEY = 'lastSeenVersion'
let whatsNew = false          // local VERSION differs from last seen — show "what's new" changelog
let whatsNewTimer = null      // auto-hide the hint 30s after launch

// ─── UI runtime ──────────────────────────────────────────────────────────────
const ui = {
  sb: null,
  dirty: true,
  loopTimer: null,
  modal: null,               // settings overlay
  prompt: null,              // text-input overlay (new room)
  volumePopup: null,         // per-user volume overlay { userId, username, vol }
  changelog: null,           // changelog overlay { title, rawLines, lines, scroll, rect }
  confirm: null,             // yes/no overlay { title, onConfirm }
  update: null,              // self-update overlay { status, startedAt, pct, last, code, rect }
  userZones: [],             // clickable user rows [{ x0, x1, y, userId, username }]
  roomItems: [],             // left-panel navigation [{ type:'room'|'user'|'newRoom', ... }]
  selectedLine: 0,           // index into roomItems
  statusZones: [],           // clickable status-bar segments
  chat: { input: '', scroll: 0, stick: true, focused: false },  // chat composer + history scroll
  chatZone: null,            // clickable chat region [{x0,x1,y0,y1}] for focusing the composer
}

// ─── Drawing primitives ───────────────────────────────────────────────────────
function putStr(x, y, str, attr) {
  if (!ui.sb || y < 0 || y >= ui.sb.height) return
  ui.sb.put({ x, y, attr: attr || {}, wrap: false, dx: 1, dy: 0 }, '%s', str)
}

function padEnd(s, w) {
  s = String(s)
  return s.length > w ? s.slice(0, w) : s + ' '.repeat(w - s.length)
}

function bar(level, w) {
  const n = Math.max(0, Math.min(w, Math.round(level * w)))
  return '█'.repeat(n) + '·'.repeat(w - n)
}

const BLK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
function animBars(seed, w) {
  const t = Date.now() / 100
  let s = ''
  for (let i = 0; i < w; i++) {
    const v = (Math.sin(t + i * 0.7 + seed * 1.3) + 1) / 2
    s += BLK[Math.floor(v * (BLK.length - 1))]
  }
  return s
}

function levelAttr(l) {
  if (l > 0.85) return { color: 'red' }
  if (l > 0.6)  return { color: 'yellow' }
  return { color: 'green' }
}

// Terminal size can be Infinity/undefined when stdout is not a TTY — clamp it.
function clampDim(v, fallback) {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}
function makeScreen() {
  return new termkit.ScreenBuffer({ dst: term, width: clampDim(term.width, 80), height: clampDim(term.height, 24) })
}

// ─── Layout ────────────────────────────────────────────────────────────────
// Three responsive columns: rooms │ who's-here │ chat. When the terminal is too
// narrow for all three, the middle column collapses (members are still visible
// in the left tree) and chat takes the whole right side.
function L() {
  const W = ui.sb.width, H = ui.sb.height
  const headerRow = 1, ulineRow = 2, firstRow = 3
  const sepRow = H - 3, statusRow = H - 2
  const lastRow = sepRow - 1
  const threeCol = W >= THREE_COL_MIN
  let roomsW, divX, usersX = 0, usersW = 0, midDiv = null, chatX, chatW
  if (threeCol) {
    // Three roughly-equal columns. Budget = W minus 2 borders, 2 (divider+space)
    // gaps and a 1-col right margin; rooms & who's-here take a third each, chat
    // gets the rest (≈ the same), so no column dwarfs the others.
    const base = Math.max(LEFT_W, Math.floor((W - 7) / 3))
    roomsW = base; usersW = base
    divX = 1 + roomsW                      // first divider: rooms │ who's-here
    usersX = divX + 2
    midDiv = usersX + usersW               // second divider: who's-here │ chat
    chatX = midDiv + 2
  } else {
    roomsW = LEFT_W
    divX = 1 + roomsW
    chatX = divX + 2
  }
  chatW = Math.max(8, W - chatX - 2)
  return { W, H, roomsW, divX, threeCol, usersX, usersW, midDiv, chatX, chatW, headerRow, ulineRow, firstRow, sepRow, statusRow, lastRow }
}

// ─── Render ────────────────────────────────────────────────────────────────
function drawAll() {
  const sb = ui.sb
  if (!sb) return
  sb.fill({ char: ' ', attr: {} })
  drawFrame()
  drawRooms()
  drawUsers()                // middle column (no-op when too narrow)
  drawChat()                 // right column
  drawStatus()
  if (ui.modal) drawModal()
  if (ui.prompt) drawPrompt()
  if (ui.volumePopup) drawVolumePopup()
  if (ui.changelog) drawChangelog()
  if (ui.confirm) drawConfirm()
  if (ui.update) drawUpdate()
  sb.draw({ delta: true })
  // A delta draw leaves the real terminal cursor on the last cell it touched —
  // e.g. mid-screen after the settings modal closes — and it shows as a stray
  // blue bar. We never use the hardware cursor (edit fields draw their own ▆), so
  // re-hide it every frame; hideCursor() just re-emits ?25l, it isn't state-gated.
  term.hideCursor()
}

function drawFrame() {
  const { W, H, roomsW, divX, threeCol, usersX, usersW, midDiv, chatX, chatW, headerRow, ulineRow, sepRow, statusRow, lastRow } = L()
  const dim = { dim: true }

  // top + bottom borders
  putStr(0, 0, '╭' + '─'.repeat(W - 2) + '╮', dim)
  putStr(0, H - 1, '╰' + '─'.repeat(W - 2) + '╯', dim)
  putStr(2, 0, ' yapper ', { color: 'cyan', bold: true })

  // connection status (top-right)
  const txt = state.connected ? (state.serverAddr || 'connected') : 'connecting…'
  const seg = ` ${txt} `
  const sx = Math.max(12, W - 2 - seg.length - 2)
  putStr(sx, 0, '●', state.connected ? { color: 'green' } : { color: 'red' })
  putStr(sx + 2, 0, txt, dim)

  // side borders + column dividers
  for (let y = 1; y <= statusRow; y++) { putStr(0, y, '│', dim); putStr(W - 1, y, '│', dim) }
  for (let y = 1; y <= lastRow; y++) putStr(divX, y, '│', dim)
  if (threeCol) for (let y = 1; y <= lastRow; y++) putStr(midDiv, y, '│', dim)

  // separator above status bar, with ┴ joins under each divider
  putStr(0, sepRow, '├' + '─'.repeat(W - 2) + '┤', dim)
  putStr(divX, sepRow, '┴', dim)
  if (threeCol) putStr(midDiv, sepRow, '┴', dim)

  // headers
  putStr(2, headerRow, 'ROOMS', { bold: true })
  putStr(2, ulineRow, '─'.repeat(roomsW - 1), dim)
  const room = state.rooms.find(r => r.name === state.currentRoom)
  const titleAttr = state.currentRoom ? { color: 'cyan', bold: true } : dim
  const title = state.currentRoom || 'no room'
  if (threeCol) {
    // middle = room / who's-here, right = chat
    putStr(usersX, headerRow, padEnd(title, usersW), titleAttr)
    if (room) { const cnt = String(room.users.length); putStr(midDiv - 1 - cnt.length, headerRow, cnt, dim) }
    putStr(usersX, ulineRow, '─'.repeat(usersW), dim)
    putStr(chatX, headerRow, 'chat', { bold: true })
    putStr(chatX, ulineRow, '─'.repeat(chatW), dim)
  } else {
    // narrow: chat column is headed by the room title (+ online count)
    putStr(chatX, headerRow, title, titleAttr)
    if (room) { const cnt = `${room.users.length} online`; putStr(W - 2 - cnt.length, headerRow, cnt, dim) }
    putStr(chatX, ulineRow, '─'.repeat(chatW), dim)
  }
}

function drawRooms() {
  const { firstRow, lastRow, roomsW } = L()

  // Build flat navigation list from rooms + expanded members
  ui.roomItems = []
  state.rooms.forEach((r, idx) => {
    ui.roomItems.push({ type: 'room', name: r.name, idx })
    // Members shown under every room — not just the current one, so you can see
    // who's in any room while sitting elsewhere. Self is prepended only to the
    // room we're actually in (selfIdx >= 0); other rooms just list their users.
    const members = (r.users || []).slice()
    const selfIdx = members.findIndex(u => u.id === state.userId)
    if (selfIdx >= 0) {
      const selfName = members[selfIdx].name || state.username
      members.splice(selfIdx, 1)
      members.unshift({ id: state.userId, name: selfName, self: true, muted: state.muted })
    }
    members.forEach((u, i) => {
      ui.roomItems.push({ type: 'user', username: u.name, userId: u.id, self: !!u.self, roomIdx: idx, last: i === members.length - 1 })
    })
  })
  ui.roomItems.push({ type: 'newRoom' })

  // Clamp selection
  if (ui.selectedLine >= ui.roomItems.length) ui.selectedLine = Math.max(0, ui.roomItems.length - 1)

  // Auto-select current room header when room changes
  if (state.currentRoom && state.currentRoom !== ui._lastRoom) {
    ui._lastRoom = state.currentRoom
    const ri = ui.roomItems.findIndex(it => it.type === 'room' && it.name === state.currentRoom)
    if (ri >= 0) ui.selectedLine = ri
  } else if (!state.currentRoom) {
    ui._lastRoom = null
  }

  let y = firstRow
  const newRoomIdx = ui.roomItems.length - 1   // last item is always the newRoom footer
  for (let i = 0; i < ui.roomItems.length; i++) {
    if (y > lastRow - 2) break                 // reserve lastRow-1 (divider) and lastRow (footer)
    const item = ui.roomItems[i]
    if (item.type === 'newRoom') continue      // footer is drawn separately at the bottom
    const sel = i === ui.selectedLine && !ui.modal && !ui.prompt && !ui.volumePopup && !ui.changelog

    if (item.type === 'room') {
      const cur = item.name === state.currentRoom
      const room = state.rooms[item.idx]
      const count = String(room?.users?.length || 0)
      const icon = cur ? '▸' : ' '
      const label = `${icon} ${item.name}`
      const line = padEnd(label, roomsW - 1 - count.length) + count
      const attr = sel ? { bgColor: 'cyan', color: 'black' }
                 : cur ? { color: 'green', bold: true } : {}
      putStr(1, y, padEnd(line, roomsW), attr)
      // Unread chat badge (only for rooms you're not currently in).
      const unread = state.unread[item.name] || 0
      if (unread > 0 && !cur) {
        const badge = '●' + (unread > 9 ? '9+' : unread)
        const bx = 1 + Math.max(0, roomsW - count.length - badge.length - 1)
        putStr(bx, y, badge, sel ? { color: 'yellow', bold: true, bgColor: 'cyan' } : { color: 'yellow', bold: true })
      }
    } else if (item.type === 'user') {
      const branch = item.last ? '  └─ ' : '  ├─ '
      const name = item.self ? `${item.username} (you)` : item.username
      const line = branch + name
      const attr = sel ? { bgColor: 'cyan', color: 'black' }
                 : item.self ? { color: 'green', bold: true }
                 : { dim: true }
      putStr(1, y, padEnd(line, roomsW), attr)
    }
    y++
  }

  // Footer: [+ new room] pinned to the very bottom of the sidebar, with a
  // thin divider above it so it reads as an action, not just another room.
  putStr(1, lastRow - 1, '─'.repeat(roomsW), { dim: true })
  const sel = newRoomIdx === ui.selectedLine && !ui.modal && !ui.prompt && !ui.volumePopup && !ui.changelog
  putStr(1, lastRow, padEnd('+ new room', roomsW), sel ? { bgColor: 'cyan', color: 'black' } : { dim: true })
  ui.newRoomY = lastRow
}

// Middle column — "who's here" + your mic meter. Only drawn in the 3-column
// layout; when narrower the roster is covered by the left tree.
function drawUsers() {
  const { usersX, usersW, threeCol, firstRow, lastRow } = L()
  ui.userZones = []
  if (!threeCol) return

  if (!state.currentRoom) {
    putStr(usersX, Math.floor((firstRow + lastRow) / 2), 'no room', { dim: true })
    return
  }

  const room = state.rooms.find(r => r.name === state.currentRoom)
  const others = (room?.users ?? []).filter(u => u.id !== state.userId)

  // Participant list — self sits at the top, right among everyone else.
  let y = firstRow
  drawUserRow(y++, state.username + ' (you)', {
    self: true, muted: state.muted,
    talking: !state.muted && state.selfLevel > 0.05,
  }, usersX, usersW)
  for (const u of others) {
    if (y > lastRow - 1) break
    drawUserRow(y, u.name, { talking: state.talking.has(u.id), muted: u.muted, seed: u.id }, usersX, usersW)
    ui.userZones.push({ x0: usersX, x1: usersX + usersW, y, userId: u.id, username: u.name })
    y++
  }

  // Mic-level bar pinned at the bottom of the column.
  if (state.muted) {
    putStr(usersX, lastRow, 'your mic · muted', { color: 'red', dim: true })
  } else {
    putStr(usersX, lastRow, 'your mic', { dim: true })
    const meterX = usersX + 9
    const meterW = Math.max(4, usersX + usersW - meterX)
    putStr(meterX, lastRow, bar(state.selfLevel, meterW), levelAttr(state.selfLevel))
  }
}

function drawUserRow(y, name, o, colX, colW) {
  const icon = o.muted ? '⊘' : (o.talking ? '◉' : '○')
  const iconAttr = o.muted ? { color: 'red' } : (o.talking ? { color: 'green', bold: true } : { dim: true })
  putStr(colX, y, icon, iconAttr)
  // Narrow column: icon + name only. Talking/mute is conveyed by the icon colour.
  const nameW = Math.max(4, colW - 3)
  const nameAttr = o.self ? { color: 'cyan', bold: true } : (o.talking ? { color: 'green', bold: true } : o.muted ? { dim: true } : {})
  putStr(colX + 2, y, padEnd(name, nameW), nameAttr)
}

// Word-wrap one chat message ("name: text") to `width`, hard-breaking overlong
// tokens. Own messages are tinted green so authorship reads at a glance.
function wrapChatLine(name, text, width, own) {
  const attr = own ? { color: 'green' } : {}
  const out = []
  let line = ''
  for (let w of (name + ': ' + text).split(' ')) {
    while (w.length > width) {                      // a single token longer than the column
      if (line) { out.push({ text: line, attr }); line = '' }
      out.push({ text: w.slice(0, width), attr })
      w = w.slice(width)
    }
    if (!line) line = w
    else if ((line + ' ' + w).length <= width) line += ' ' + w
    else { out.push({ text: line, attr }); line = w }
  }
  out.push({ text: line, attr })
  return out
}

// Right column — the current room's chat: scrollable history + a composer line.
function drawChat() {
  const { chatX, chatW, firstRow, lastRow } = L()
  ui.chatZone = { x0: chatX, x1: chatX + chatW, y0: firstRow, y1: lastRow }

  const composerY = lastRow
  const divY = lastRow - 1
  const histTop = firstRow
  const innerH = Math.max(1, divY - histTop)        // history rows: firstRow .. divY-1

  if (!state.currentRoom) {
    putStr(chatX, Math.floor((firstRow + lastRow) / 2), 'join a room to chat', { dim: true })
    return
  }

  // Wrap every message into display lines.
  const msgs = state.chat[state.currentRoom] || []
  const lines = []
  for (const m of msgs) {
    for (const l of wrapChatLine(m.name || '?', m.text, chatW, m.userId === state.userId)) lines.push(l)
  }

  const maxScroll = Math.max(0, lines.length - innerH)
  if (ui.chat.stick) {
    ui.chat.scroll = maxScroll
  } else {
    ui.chat.scroll = Math.min(Math.max(0, ui.chat.scroll), maxScroll)
    if (ui.chat.scroll >= maxScroll) ui.chat.stick = true   // scrolled back to bottom → re-stick
  }
  const top = ui.chat.scroll

  for (let i = 0; i < innerH; i++) {
    const ln = lines[top + i]
    putStr(chatX, histTop + i, padEnd(ln ? ln.text : '', chatW), ln ? ln.attr : {})
  }
  if (top > 0) putStr(chatX + chatW - 1, histTop, '▲', { dim: true })
  if (top + innerH < lines.length) putStr(chatX + chatW - 1, divY - 1, '▼', { dim: true })

  // Divider + composer.
  putStr(chatX, divY, '─'.repeat(chatW), { dim: true })
  const focused = ui.chat.focused
  const empty = !ui.chat.input && !focused
  if (empty) {
    putStr(chatX, composerY, padEnd('> type a message… (Tab)', chatW), { dim: true })
  } else {
    const avail = Math.max(1, chatW - 2 - (focused ? 1 : 0))
    const shown = ui.chat.input.length > avail ? ui.chat.input.slice(ui.chat.input.length - avail) : ui.chat.input
    putStr(chatX, composerY, padEnd('> ' + shown + (focused ? '█' : ''), chatW), {})
  }
}

function drawStatus() {
  const { statusRow } = L()
  ui.statusZones = []
  let x = 2
  const seg = (label, action, attr) => {
    putStr(x, statusRow, label, attr || {})
    ui.statusZones.push({ x0: x, x1: x + label.length - 1, action })
    x += label.length + 3
  }
  seg(state.muted ? '[M] unmute' : '[M] mute', toggleMute, state.muted ? { color: 'red', bold: true } : {})
  seg('[N] new room', promptNewRoom)
  seg('[S] settings', openSettings)
  if (updateAvailable) seg('[U] update!', runUpdate, { color: 'yellow', bold: true })
  // [D] delete — only when a deletable custom room is the selected row.
  {
    const it = ui.roomItems[ui.selectedLine]
    if (it?.type === 'room' && !DEFAULT_ROOMS.has(it.name)) seg('[D] delete', promptDeleteRoom, { color: 'red' })
  }
  seg('[Q] quit', quit)

  // Version in the bottom-right corner, with a transient "what's new" changelog
  // hint to its left — same dim style as the version, auto-hides after 30s.
  const { W } = L()
  const ver = `v${VERSION}`
  const vX = W - ver.length - 2
  putStr(vX, statusRow, ver, { dim: true })
  if (whatsNew) {
    const label = '[C] changelog'
    const lx = vX - label.length - 1
    putStr(lx, statusRow, label, { dim: true })
    ui.statusZones.push({ x0: lx, x1: lx + label.length - 1, action: openChangelog })
  }
}

// ─── Overlays ────────────────────────────────────────────────────────────────
function drawModal() {
  const { W, H } = L()
  const m = ui.modal
  const bw = Math.min(54, W - 4), bh = 20
  const bx = Math.floor((W - bw) / 2), by = Math.floor((H - bh) / 2)
  m.rect = { bx, by, bw, bh }
  const C = { color: 'cyan' }

  putStr(bx, by, '╭' + '─'.repeat(bw - 2) + '╮', C)
  for (let i = 1; i < bh - 1; i++) {
    putStr(bx, by + i, '│', C)
    putStr(bx + 1, by + i, ' '.repeat(bw - 2), {})
    putStr(bx + bw - 1, by + i, '│', C)
  }
  putStr(bx, by + bh - 1, '╰' + '─'.repeat(bw - 2) + '╯', C)
  putStr(bx + 2, by, ' settings ', { color: 'cyan', bold: true })

  const ix = bx + 2, rw = bw - 4
  m.rowsY = [by + 2, by + 4, by + 6, by + 8, by + 10, by + 12, by + 14, by + 18]

  const uval = (m.editing && m.row === 0) ? m.edit + '█' : state.username
  modalField(ix, by + 2, rw, 'username', uval, m.row === 0)
  if (m.editing && m.row === 0) {
    const cnt = `${m.edit.length}/${MAX_USERNAME}`
    putStr(ix + rw - cnt.length, by + 2, cnt, m.edit.length >= MAX_USERNAME ? { color: 'yellow', bold: true } : { dim: true })
  }

  const dev = m.devices?.[m.devIdx]?.name || 'default'
  modalField(ix, by + 4, rw, 'microphone', '‹ ' + dev + ' ›', m.row === 1)

  const tlabel = m.testing ? '■ stop test  (speak — you should hear yourself)' : '▶ test microphone'
  modalField(ix, by + 6, rw, '', tlabel, m.row === 2)
  if (m.testing)        putStr(ix + 1, by + 7, bar(m.testLevel || 0, rw - 2), levelAttr(m.testLevel || 0))
  else if (m.testError) putStr(ix + 1, by + 7, 'audio backend not available', { color: 'red', dim: true })

  // Row 3: mic sensitivity (VAD gate) as a slider — drag right to keep keyboard
  // clatter and background noise off-air.
  const slW = 16
  const frac = (m.threshold - VAD_MIN) / (VAD_MAX - VAD_MIN)
  const sline = padEnd('sensitivity', 11) + ' ‹ ' + bar(frac, slW) + ' › ' + m.threshold
  putStr(ix, by + 8, padEnd(' ' + sline, rw), m.row === 3 ? { bgColor: 'cyan', color: 'black' } : {})

  // Row 4: noise suppression toggle. While enabled but the WASM hasn't loaded
  // yet, say so — audio passes through untouched until it's ready.
  const non = isDenoiseEnabled()
  const nlabel = !non ? 'off' : isDenoiseAvailable() ? 'on' : 'on (loading…)'
  modalField(ix, by + 10, rw, 'noise', '‹ ' + nlabel + ' ›', m.row === 4)

  // Row 5: global mute hotkey — toggles mute from any app (Windows only). On
  // other platforms the binding is inert, so we say so instead of pretending.
  const hk = HOTKEY_PRESETS[m.hotkeyIdx]?.label || 'off'
  const hkVal = process.platform === 'win32' ? '‹ ' + hk + ' ›' : '‹ ' + hk + ' › (Windows only)'
  modalField(ix, by + 12, rw, 'mute key', hkVal, m.row === 5)

  // Row 6: check for updates — status shown inline so the button doubles as
  // a result line ("up to date" / "update vX available" / "check failed").
  // Sticky while there is a pending update; transient otherwise (auto-clears
  // after 4s).
  const csel = m.row === 6
  let cval, cattr
  if (m.checkStatus === 'checking')    { cval = '⟳ checking…';                                      cattr = { color: 'yellow' } }
  else if (m.checkStatus === 'update') { cval = '! update v' + m.updateVer + ' available — press [U]'; cattr = { color: 'yellow', bold: true } }
  else if (m.checkStatus === 'latest') { cval = '✓ you are up to date';                                cattr = { color: 'green' } }
  else if (m.checkStatus === 'failed') { cval = '× check failed (rate limit / offline)';              cattr = { color: 'red', dim: true } }
  else                                 { cval = '▶ check for updates';                               cattr = {} }
  putStr(ix, by + 14, padEnd(' ' + cval, rw), csel ? { bgColor: 'cyan', color: 'black' } : cattr)

  putStr(ix + 1, by + 16, '↑↓ move · enter select · ‹ › adjust · esc close', { dim: true })
  modalField(ix, by + 18, rw, '', '[ close ]', m.row === 7)
}

function modalField(ix, y, rw, label, value, sel) {
  const text = label ? padEnd(label, 11) + ' ' + value : value
  putStr(ix, y, padEnd(' ' + text, rw), sel ? { bgColor: 'cyan', color: 'black' } : {})
}

function drawPrompt() {
  const { W, H } = L()
  const p = ui.prompt
  const bw = Math.min(44, W - 4), bh = 5
  const bx = Math.floor((W - bw) / 2), by = Math.floor((H - bh) / 2)
  const C = { color: 'cyan' }
  putStr(bx, by, '╭' + '─'.repeat(bw - 2) + '╮', C)
  for (let i = 1; i < bh - 1; i++) {
    putStr(bx, by + i, '│', C)
    putStr(bx + 1, by + i, ' '.repeat(bw - 2), {})
    putStr(bx + bw - 1, by + i, '│', C)
  }
  putStr(bx, by + bh - 1, '╰' + '─'.repeat(bw - 2) + '╯', C)
  putStr(bx + 2, by, ' ' + p.title + ' ', { color: 'cyan', bold: true })
  putStr(bx + 2, by + 2, '> ' + p.value + '█', {})
  if (p.max) {
    const cnt = `${p.value.length}/${p.max}`
    putStr(bx + bw - cnt.length - 2, by + 2, cnt, p.value.length >= p.max ? { color: 'yellow', bold: true } : { dim: true })
  }
  putStr(bx + 2, by + bh - 1, ' enter ok · esc cancel ', { dim: true })
}

function drawConfirm() {
  const { W, H } = L()
  const c = ui.confirm
  const bw = Math.min(42, W - 4), bh = 5
  const bx = Math.floor((W - bw) / 2), by = Math.floor((H - bh) / 2)
  const C = { color: 'cyan' }
  putStr(bx, by, '╭' + '─'.repeat(bw - 2) + '╮', C)
  for (let i = 1; i < bh - 1; i++) {
    putStr(bx, by + i, '│', C)
    putStr(bx + 1, by + i, ' '.repeat(bw - 2), {})
    putStr(bx + bw - 1, by + i, '│', C)
  }
  putStr(bx, by + bh - 1, '╰' + '─'.repeat(bw - 2) + '╯', C)
  putStr(bx + 2, by, ' confirm ', { color: 'red', bold: true })
  putStr(bx + 2, by + 2, padEnd(c.title, bw - 4), { color: 'red' })
  putStr(bx + 2, by + bh - 1, ' enter delete · esc cancel ', { dim: true })
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function drawUpdate() {
  const { W, H } = L()
  const u = ui.update
  const bw = Math.min(52, W - 4), bh = 9
  const bx = Math.floor((W - bw) / 2), by = Math.floor((H - bh) / 2)
  u.rect = { bx, by, bw, bh }
  const C = { color: 'cyan' }
  putStr(bx, by, '╭' + '─'.repeat(bw - 2) + '╮', C)
  for (let i = 1; i < bh - 1; i++) {
    putStr(bx, by + i, '│', C)
    putStr(bx + 1, by + i, ' '.repeat(bw - 2), {})
    putStr(bx + bw - 1, by + i, '│', C)
  }
  putStr(bx, by + bh - 1, '╰' + '─'.repeat(bw - 2) + '╯', C)
  putStr(bx + 2, by, ' update ', { color: 'cyan', bold: true })

  const ix = bx + 3, iw = bw - 6

  // Headline + progress bar. While running the bar creeps toward ~95% on a time
  // estimate (npm gives little granular feedback); it snaps to 100% on success.
  if (u.status === 'running') {
    const spin = SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]
    u.pct = Math.min(95, Math.round((Date.now() - u.startedAt) / UPDATE_EST_MS * 95))
    putStr(ix, by + 2, spin + '  Updating yapper…', { color: 'cyan', bold: true })
  } else if (u.status === 'done') {
    putStr(ix, by + 2, '✓  Updated to the latest version!', { color: 'green', bold: true })
  } else {
    putStr(ix, by + 2, '✗  Update failed (exit ' + u.code + ')', { color: 'red', bold: true })
  }

  const barW = iw - 6
  const frac = u.pct / 100
  const barAttr = u.status === 'failed' ? { color: 'red' }
                : u.status === 'done'   ? { color: 'green' }
                : { color: 'cyan' }
  putStr(ix, by + 4, bar(frac, barW), barAttr)
  putStr(ix + barW + 1, by + 4, String(u.pct).padStart(3) + '%', { dim: true })

  // Footer: last npm line while running, action hints once finished.
  if (u.status === 'running') {
    const line = u.last ? 'npm: ' + u.last : 'starting…'
    putStr(ix, by + 6, padEnd(line.slice(0, iw), iw), { dim: true })
  } else if (u.status === 'done') {
    putStr(ix, by + 6, '[R] restart now   ·   [Esc] restart later', { color: 'yellow' })
  } else {
    putStr(ix, by + 6, padEnd('install -g ' + UPDATE_URL, iw).slice(0, iw), { dim: true })
    putStr(ix, by + 7, '[Esc] close', { dim: true })
  }
}

function handleUpdateKey(name) {
  const u = ui.update
  if (!u) return
  if (u.status === 'running') return             // block input until npm finishes
  if (u.status === 'done' && (name === 'r' || name === 'R' || name === 'ENTER')) {
    restartApp(); return
  }
  if (name === 'ESCAPE' || name === 'q' || name === 'Q' ||
      (u.status === 'failed' && name === 'ENTER')) {
    ui.update = null; ui.dirty = true
  }
}

function handleUpdateMouse(name, x, y) {
  const u = ui.update
  if (!u || u.status === 'running') return        // no clicks mid-install
  if (name !== 'MOUSE_LEFT_BUTTON_PRESSED') return
  if (u.status === 'done') { restartApp(); return }
  ui.update = null; ui.dirty = true               // failed → any click closes
}

function drawVolumePopup() {
  const { W, H } = L()
  const v = ui.volumePopup
  const bw = Math.min(42, W - 4), bh = 6
  const bx = Math.floor((W - bw) / 2), by = Math.floor((H - bh) / 2)
  const C = { color: 'cyan' }
  putStr(bx, by, '╭' + '─'.repeat(bw - 2) + '╮', C)
  for (let i = 1; i < bh - 1; i++) {
    putStr(bx, by + i, '│', C)
    putStr(bx + 1, by + i, ' '.repeat(bw - 2), {})
    putStr(bx + bw - 1, by + i, '│', C)
  }
  putStr(bx, by + bh - 1, '╰' + '─'.repeat(bw - 2) + '╯', C)
  putStr(bx + 2, by, ' volume: ' + v.username + ' ', { color: 'cyan', bold: true })

  const barW = Math.min(30, bw - 12)
  const barX = bx + Math.floor((bw - barW) / 2) - 1
  const pct = Math.round(v.vol / 200 * 100)
  putStr(barX, by + 2, '‹ ' + bar(v.vol / 200, barW) + ' ›', {})
  const label = String(v.vol) + '%'
  putStr(bx + Math.floor((bw - label.length) / 2), by + 3, label, { bold: true })
  putStr(bx + 2, by + bh - 2, ' ← → adjust · esc close ', { dim: true })
}

// ─── Changelog overlay ───────────────────────────────────────────────────────
function changelogBox() {
  const { W, H } = L()
  const bw = Math.min(64, W - 4)
  const bh = Math.max(8, Math.min(22, H - 4))
  const bx = Math.floor((W - bw) / 2)
  const by = Math.floor((H - bh) / 2)
  return { W, H, bw, bh, bx, by }
}

// Re-wrap raw lines to fit the changelog box inner width. Called on open and on resize.
function wrapChangelog() {
  const cl = ui.changelog
  if (!cl) return
  const { bw } = changelogBox()
  const cap = Math.max(8, bw - 4)
  cl.lines = []
  for (const raw of cl.rawLines || []) {
    if (!raw) { cl.lines.push(''); continue }
    for (let i = 0; i < raw.length; i += cap) cl.lines.push(raw.slice(i, i + cap))
  }
  const innerH = (cl.rect?.bh || 18) - 4
  if (cl.scroll > Math.max(0, cl.lines.length - innerH)) cl.scroll = 0
  ui.dirty = true
}

function drawChangelog() {
  const { bw, bh, bx, by } = changelogBox()
  const cl = ui.changelog
  cl.rect = { bx, by, bw, bh }
  const C = { color: 'cyan' }
  putStr(bx, by, '╭' + '─'.repeat(bw - 2) + '╮', C)
  for (let i = 1; i < bh - 1; i++) {
    putStr(bx, by + i, '│', C)
    putStr(bx + 1, by + i, ' '.repeat(bw - 2), {})
    putStr(bx + bw - 1, by + i, '│', C)
  }
  putStr(bx, by + bh - 1, '╰' + '─'.repeat(bw - 2) + '╯', C)
  putStr(bx + 2, by, ` changelog ${cl.title} `, { color: 'cyan', bold: true })

  const innerH = bh - 4
  const lines = cl.lines.length ? cl.lines : ['...']
  const maxScroll = Math.max(0, lines.length - innerH)
  if (cl.scroll > maxScroll) cl.scroll = maxScroll
  if (cl.scroll < 0) cl.scroll = 0
  const attrFor = (line) => /^#/.test(line) ? { color: 'cyan', bold: true } : {}
  for (let i = 0; i < innerH; i++) {
    const idx = cl.scroll + i
    if (idx >= lines.length) break
    putStr(bx + 2, by + 1 + i, padEnd(lines[idx], bw - 4), attrFor(lines[idx]))
  }
  if (lines.length > innerH) {
    const info = ` ${cl.scroll + 1}-${Math.min(lines.length, cl.scroll + innerH)}/${lines.length} `
    putStr(bx + 2, by + bh - 1, info, { dim: true })
  }
  const hint = ' ↑↓ scroll · esc close '
  putStr(bx + bw - hint.length - 1, by + bh - 1, hint, { dim: true })
}

function handleChangelogKey(name) {
  const cl = ui.changelog
  if (!cl) return
  const innerH = (cl.rect?.bh || 18) - 4
  const maxScroll = Math.max(0, (cl.lines?.length || 0) - innerH)
  if (name === 'ESCAPE' || name === 'q' || name === 'Q' || name === 'c' || name === 'C' || name === 'ENTER') {
    ui.changelog = null; ui.dirty = true
  } else if (name === 'UP')        { cl.scroll = Math.max(0, cl.scroll - 1); ui.dirty = true }
    else if (name === 'DOWN')      { cl.scroll = Math.min(maxScroll, cl.scroll + 1); ui.dirty = true }
    else if (name === 'PAGE_UP')   { cl.scroll = Math.max(0, cl.scroll - innerH); ui.dirty = true }
    else if (name === 'PAGE_DOWN') { cl.scroll = Math.min(maxScroll, cl.scroll + innerH); ui.dirty = true }
    else if (name === 'HOME')      { cl.scroll = 0; ui.dirty = true }
    else if (name === 'END')       { cl.scroll = maxScroll; ui.dirty = true }
}

function handleChangelogMouse(name, x, y) {
  const cl = ui.changelog
  if (!cl) return
  const innerH = (cl.rect?.bh || 18) - 4
  const maxScroll = Math.max(0, (cl.lines?.length || 0) - innerH)
  if (name === 'MOUSE_WHEEL_UP')   { cl.scroll = Math.max(0, cl.scroll - 2); ui.dirty = true; return }
  if (name === 'MOUSE_WHEEL_DOWN') { cl.scroll = Math.min(maxScroll, cl.scroll + 2); ui.dirty = true; return }
  if (name === 'MOUSE_LEFT_BUTTON_PRESSED') {
    const r = cl.rect
    if (!r || x < r.bx || x > r.bx + r.bw - 1 || y < r.by || y > r.by + r.bh - 1) { ui.changelog = null; ui.dirty = true }
  }
}

// ─── Input: keyboard ──────────────────────────────────────────────────────────
function handleKey(name, matches, data) {
  if (name === 'CTRL_C') return quit()
  if (ui.update) return handleUpdateKey(name)
  if (ui.volumePopup) return handleVolumeKey(name)
  if (ui.changelog) return handleChangelogKey(name)
  if (ui.confirm) return handleConfirmKey(name)
  if (ui.prompt) return handlePromptKey(name, data)
  if (ui.modal)  return handleModalKey(name, data)
  if (ui.chat.focused) return handleChatKey(name, data)   // typing — shield single-key shortcuts

  switch (name) {
    case 'UP':    move(-1); break
    case 'DOWN':  move(1); break
    case 'ENTER': activateSelection(); break
    case 'TAB':   if (state.currentRoom) { ui.chat.focused = true; ui.dirty = true } break
    case 'ESCAPE': if (state.currentRoom && handlers.onLeave) { notifyLeaving(); handlers.onLeave(); } break
    case 'm': case 'M': toggleMute(); break
    case 's': case 'S': openSettings(); break
    case 'n': case 'N': promptNewRoom(); break
    case 'd': case 'D': if (!ui.modal && !ui.prompt && !ui.volumePopup && !ui.changelog && !ui.confirm) promptDeleteRoom(); break
    case 'c': case 'C': if (whatsNew) openChangelog(); break
    case 'u': case 'U': if (updateAvailable) runUpdate(); break
    case 'q': case 'Q': quit(); break
  }
}

function chatScroll(d) {
  ui.chat.stick = false
  ui.chat.scroll = Math.max(0, ui.chat.scroll + d)   // upper bound + re-stick handled in drawChat
  ui.dirty = true
}

function handleChatKey(name, data) {
  const c = ui.chat
  if (name === 'ESCAPE' || name === 'TAB')  { c.focused = false; ui.dirty = true; return }
  if (name === 'ENTER') {
    const text = c.input.trim()
    if (text && handlers.onChat) handlers.onChat(text)
    c.input = ''; c.stick = true; ui.dirty = true
    return
  }
  if (name === 'BACKSPACE')   { c.input = c.input.slice(0, -1); ui.dirty = true; return }
  if (name === 'UP')          return chatScroll(-1)
  if (name === 'DOWN')        return chatScroll(1)
  if (name === 'PAGE_UP')     return chatScroll(-5)
  if (name === 'PAGE_DOWN')   return chatScroll(5)
  if (data?.isCharacter && c.input.length < MAX_CHATMSG) { c.input += String.fromCodePoint(data.codepoint); ui.dirty = true }
}

function handlePromptKey(name, data) {
  const p = ui.prompt
  if (name === 'ENTER')          { ui.prompt = null; p.onSubmit(p.value); ui.dirty = true }
  else if (name === 'ESCAPE')    { ui.prompt = null; ui.dirty = true }
  else if (name === 'BACKSPACE') { p.value = p.value.slice(0, -1); ui.dirty = true }
  else if (data?.isCharacter && p.value.length < (p.max ?? Infinity)) { p.value += String.fromCodePoint(data.codepoint); ui.dirty = true }
}

function handleVolumeKey(name) {
  const v = ui.volumePopup
  // Apply live so you hear the change while adjusting; persistence to config
  // happens once on close to avoid a disk write per keypress.
  if (name === 'LEFT')        { v.vol = Math.max(0, v.vol - 10);   setUserVolume(v.userId, v.vol); ui.dirty = true }
  else if (name === 'RIGHT')  { v.vol = Math.min(200, v.vol + 10); setUserVolume(v.userId, v.vol); ui.dirty = true }
  else if (name === 'ESCAPE' || name === 'ENTER') closeVolumePopup()
}

function handleConfirmKey(name) {
  const c = ui.confirm
  if (!c) return
  if (name === 'ENTER')          { ui.confirm = null; c.onConfirm?.(); ui.dirty = true }
  else if (name === 'ESCAPE')    { ui.confirm = null; ui.dirty = true }
  // any other key: ignore — confirm is yes/no only
}

function handleModalKey(name, data) {
  const m = ui.modal
  if (m.editing) {
    if (name === 'ENTER')          { state.username = (m.edit.trim() || state.username).slice(0, MAX_USERNAME); config.set('username', state.username); m.editing = false; handlers.onIdentify?.(state.username) }
    else if (name === 'ESCAPE')    { m.editing = false }
    else if (name === 'BACKSPACE') { m.edit = m.edit.slice(0, -1) }
    else if (data?.isCharacter && m.edit.length < MAX_USERNAME) { m.edit += String.fromCodePoint(data.codepoint) }
    ui.dirty = true
    return
  }
  switch (name) {
    case 'UP':    m.row = (m.row + 7) % 8; ui.dirty = true; break
    case 'DOWN':  m.row = (m.row + 1) % 8; ui.dirty = true; break
    case 'LEFT':  if (m.row === 1) cycleDevice(-1); else if (m.row === 3) adjustThreshold(-1); else if (m.row === 4) toggleDenoise(); else if (m.row === 5) cycleHotkey(-1); break
    case 'RIGHT': if (m.row === 1) cycleDevice(1); else if (m.row === 3) adjustThreshold(1); else if (m.row === 4) toggleDenoise(); else if (m.row === 5) cycleHotkey(1); break
    case 'ENTER': modalActivate(); break
    case 's': case 'S': case 'q': case 'Q': case 'ESCAPE': closeSettings(); break
  }
}

// ─── Input: mouse ─────────────────────────────────────────────────────────────
function handleMouse(name, data) {
  const x = data.x - 1, y = data.y - 1   // terminal is 1-based, buffer 0-based

  if (ui.update) return handleUpdateMouse(name, x, y)
  if (ui.volumePopup) {         // click anywhere outside closes
    if (name === 'MOUSE_LEFT_BUTTON_PRESSED') closeVolumePopup()
    return
  }
  if (ui.changelog) return handleChangelogMouse(name, x, y)
  if (ui.confirm) {             // click anywhere cancels the confirm
    if (name === 'MOUSE_LEFT_BUTTON_PRESSED') { ui.confirm = null; ui.dirty = true }
    return
  }
  if (ui.prompt) {              // click anywhere outside closes the prompt
    return
  }
  if (ui.modal) return handleModalMouse(name, x, y)

  // Wheel over the chat pane scrolls chat; elsewhere it navigates rooms.
  if (name === 'MOUSE_WHEEL_UP' || name === 'MOUSE_WHEEL_DOWN') {
    const z = ui.chatZone
    if (z && x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) chatScroll(name === 'MOUSE_WHEEL_UP' ? -2 : 2)
    else move(name === 'MOUSE_WHEEL_UP' ? -1 : 1)
    return
  }
  if (name !== 'MOUSE_LEFT_BUTTON_PRESSED') return

  const { firstRow, lastRow, divX, statusRow } = L()

  // Click in the chat pane focuses the composer; any other click defocuses it.
  const cz = ui.chatZone
  const inChat = cz && x >= cz.x0 && x <= cz.x1 && y >= cz.y0 && y <= cz.y1
  ui.chat.focused = !!(inChat && state.currentRoom)
  if (inChat) { ui.dirty = true; return }

  // Check clicks on user rows (volume popup)
  for (const z of ui.userZones) {
    if (x >= z.x0 && x <= z.x1 && y === z.y) {
      openVolumePopup(z.userId, z.username)
      return
    }
  }

  if (x >= 1 && x < divX && y >= firstRow && y <= lastRow) {
    if (y === lastRow) {                       // [+ new room] footer
      ui.selectedLine = ui.roomItems.length - 1
      activateSelection()
      return
    }
    if (y === lastRow - 1) return               // divider — nothing to click
    const idx = y - firstRow
    if (idx >= 0 && idx < ui.roomItems.length - 1) {
      ui.selectedLine = idx
      activateSelection()
    }
    return
  }

  if (y === statusRow) {
    for (const z of ui.statusZones) {
      if (x >= z.x0 && x <= z.x1) { z.action(); break }
    }
  }
}

function handleModalMouse(name, x, y) {
  if (name !== 'MOUSE_LEFT_BUTTON_PRESSED') return
  const m = ui.modal
  if (!m.rect) return
  const { bx, by, bw, bh } = m.rect
  if (x < bx || x > bx + bw - 1 || y < by || y > by + bh - 1) { closeSettings(); return }
  if (m.rowsY) {
    for (let i = 0; i < m.rowsY.length; i++) {
      if (y === m.rowsY[i]) { m.row = i; modalActivate(); return }
    }
  }
}

// ─── Actions ───────────────────────────────────────────────────────────────
function move(d) {
  const n = ui.roomItems.length
  if (n === 0) return
  ui.selectedLine = (ui.selectedLine + d + n) % n
  ui.dirty = true
}

function activateSelection() {
  const item = ui.roomItems[ui.selectedLine]
  if (!item) return
  if (item.type === 'room')      joinRoom(item.name)
  else if (item.type === 'user') { if (!item.self) openVolumePopup(item.userId, item.username) }
  else if (item.type === 'newRoom') promptNewRoom()
}

function joinRoom(name) {
  if (name === state.currentRoom) return
  if (state.currentRoom && handlers.onLeave) { notifyLeaving(); handlers.onLeave() }   // leave old room before joining new one
  if (handlers.onJoin) handlers.onJoin(name)
  else state.currentRoom = name
  ui.dirty = true
}

function toggleMute() {
  state.muted = !state.muted
  handlers.onMute?.(state.muted)
  // Local confirmation chime through the speakers.  Fire-and-forget — the
  // sounds are pre-loaded at startup, so this is effectively instant.
  if (state.muted) notifyMuted(); else notifyUnmuted()
  ui.dirty = true
}

function openVolumePopup(userId, username) {
  const vol = getUserVolume(userId)
  ui.volumePopup = { userId, username, vol }
  ui.dirty = true
}

function closeVolumePopup() {
  const v = ui.volumePopup
  if (v) {
    setUserVolume(v.userId, v.vol)
    const map = config.get('userVolumes', {})
    map[String(v.userId)] = v.vol
    config.set('userVolumes', map)
  }
  ui.volumePopup = null
  ui.dirty = true
}

function loadVolumes() {
  const saved = config.get('userVolumes', {})
  if (saved && typeof saved === 'object') {
    for (const [id, vol] of Object.entries(saved)) {
      if (typeof vol === 'number') setUserVolume(Number(id), vol)
    }
  }
}

function promptNewRoom() {
  ui.prompt = {
    title: 'new room',
    value: '',
    max: MAX_ROOMNAME,
    onSubmit: (val) => {
      const name = val.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
      if (!name) return
      if (handlers.onCreate) handlers.onCreate(name)
      else {
        if (!state.rooms.find(r => r.name === name)) state.rooms.push({ name, users: [] })
        state.currentRoom = name
      }
      // Selection will clamp on next drawRooms rebuild
    },
  }
  ui.dirty = true
}

function promptDeleteRoom() {
  const it = ui.roomItems[ui.selectedLine]
  if (!it || it.type !== 'room' || DEFAULT_ROOMS.has(it.name)) return
  ui.confirm = {
    title: `delete room "${it.name}"?`,
    onConfirm: () => { handlers.onDelete?.(it.name) },
  }
  ui.dirty = true
}

// ─── Settings modal ───────────────────────────────────────────────────────────
function openSettings() {
  const devices = audioApi?.getInputDevices ? audioApi.getInputDevices() : [{ id: -1, name: 'default' }]
  const savedThreshold = config.get('vadThreshold', 200)
  ui.modal = { row: 0, editing: false, edit: '', devices, devIdx: 0, testing: false, testLevel: 0, testError: false, threshold: Math.max(VAD_MIN, Math.min(VAD_MAX, savedThreshold)), hotkeyIdx: presetIndex(config.get('muteHotkey', 'off')), checkStatus: null, updateVer: null, _checkTimer: null }
  ui.dirty = true
}

function closeSettings() {
  const m = ui.modal
  if (m?._checkTimer) clearTimeout(m._checkTimer)
  stopMicTest()
  ui.modal = null
  ui.dirty = true
}

function modalActivate() {
  const m = ui.modal
  if (m.row === 0)      { m.editing = true; m.edit = state.username; ui.dirty = true }
  else if (m.row === 1) cycleDevice(1)
  else if (m.row === 2) toggleMicTest()
  else if (m.row === 3) adjustThreshold(1)
  else if (m.row === 4) toggleDenoise()
  else if (m.row === 5) cycleHotkey(1)
  else if (m.row === 6) checkUpdateNow()
  else if (m.row === 7) closeSettings()
}

function toggleDenoise() {
  const next = !isDenoiseEnabled()
  setDenoiseEnabled(next)
  config.set('noiseSuppression', next)
  ui.dirty = true
}

function cycleDevice(dir) {
  const m = ui.modal
  if (!m.devices?.length) return
  m.devIdx = (m.devIdx + dir + m.devices.length) % m.devices.length
  audioApi?.setInputDevice?.(m.devices[m.devIdx].id)
  if (m.testing) { stopMicTest(); startMicTestInternal() }
  ui.dirty = true
}

function toggleMicTest() {
  if (ui.modal.testing) stopMicTest()
  else startMicTestInternal()
}

function adjustThreshold(dir) {
  const m = ui.modal
  m.threshold = Math.max(VAD_MIN, Math.min(VAD_MAX, m.threshold + dir * VAD_STEP))
  config.set('vadThreshold', m.threshold)
  setThreshold(m.threshold)
  ui.dirty = true
}

function cycleHotkey(dir) {
  const m = ui.modal
  m.hotkeyIdx = (m.hotkeyIdx + dir + HOTKEY_PRESETS.length) % HOTKEY_PRESETS.length
  const preset = HOTKEY_PRESETS[m.hotkeyIdx]
  config.set('muteHotkey', preset.id)
  setMuteHotkey(preset.id, toggleMute)   // re-arms the global helper (no-op off Windows)
  ui.dirty = true
}

function startMicTestInternal() {
  const m = ui.modal
  if (!audioApi?.available || !audioApi.startMicTest) { m.testError = true; ui.dirty = true; return }
  m.testing = true; m.testLevel = 0; m.testError = false
  m._stop = audioApi.startMicTest((lvl) => { m.testLevel = Math.max((m.testLevel || 0) * 0.6, lvl); ui.dirty = true })
  ui.dirty = true
}

function stopMicTest() {
  const m = ui.modal
  if (m?._stop) { m._stop(); m._stop = null }
  if (m) { m.testing = false; m.testLevel = 0 }
  ui.dirty = true
}

// Manual update check from the settings modal. Bypasses the once-per-session
// cache so each press re-fetches from GitHub. Surfaces the result inline on the
// button row; if an update is found, also lights up the [U] shortcut in the
// status bar so it can be installed without leaving settings first.
async function checkUpdateNow() {
  const m = ui.modal
  if (!m) return
  if (m.checkStatus === 'checking') return
  if (m._checkTimer) { clearTimeout(m._checkTimer); m._checkTimer = null }
  m.checkStatus = 'checking'; m.updateVer = null; ui.dirty = true
  let ver
  try {
    ver = await checkForUpdateManual()        // throws on network error
  } catch {
    ver = null
    if (!ui.modal) return
    m.checkStatus = 'failed'; ui.dirty = true
    m._checkTimer = setTimeout(() => {
      if (ui.modal) { ui.modal.checkStatus = null; ui.dirty = true }
    }, 4000)
    return
  }
  if (!ui.modal) return
  if (ver) {
    m.checkStatus = 'update'; m.updateVer = ver
    updateAvailable = true; notifyUpdateFound(); ui.dirty = true
  } else {
    m.checkStatus = 'latest'; ui.dirty = true
    m._checkTimer = setTimeout(() => {
      if (ui.modal) { ui.modal.checkStatus = null; ui.dirty = true }
    }, 4000)
  }
}

async function openChangelog() {
  // Show "what's new" for the local version (the one you just updated to).
  clearTimeout(whatsNewTimer)
  config.set(SEEN_KEY, VERSION)
  whatsNew = false
  ui.changelog = { title: `v${VERSION}`, rawLines: null, lines: [], scroll: 0, rect: null }
  ui.dirty = true
  const raw = await fetchChangelog(VERSION)
  if (!ui.changelog) return                       // closed while fetching
  ui.changelog.rawLines = raw || ['(changelog unavailable)']
  ui.changelog.scroll = 0
  wrapChangelog()
}

// Tear down the alt-screen TUI and restore a normal terminal. Used right before
// we exit or hand the terminal to a relaunched process.
function teardownTerminal() {
  handlers.onDisconnect?.()
  stopHotkey()                        // kill the global-hotkey helper process
  clearInterval(ui.loopTimer)
  term.grabInput(false)
  term.styleReset()
  term.clear()
  term.fullscreen(false)
  process.stdout.write('\x1b[?25h')   // show cursor (terminal-kit compat)
}

function quit() {
  teardownTerminal()
  process.exit(0)
}

const UPDATE_URL = 'https://github.com/sadad1213/yapper/archive/refs/heads/main.tar.gz'
const UPDATE_EST_MS = 15000   // rough install time — drives the indeterminate bar

// Self-update without leaving the TUI. npm runs as a piped child (its output is
// captured, never printed onto the alt-screen, so nothing garbles the UI), and
// progress is shown in a modal. On success the user can restart in place.
async function runUpdate() {
  if (ui.update) return               // already updating — ignore re-trigger
  ui.modal = null                     // close settings if it was open
  ui.update = { status: 'running', startedAt: Date.now(), pct: 0, last: '', code: 0, rect: null }
  ui.dirty = true

  const { spawn } = await import('child_process')
  // shell:true is required on Windows (npm is npm.cmd, and spawning .cmd needs a
  // shell since the CVE-2024-27980 fix). Pass the command as one string (no args
  // array) to avoid DEP0190 — the URL is a hardcoded constant, nothing to inject.
  // NODE_NO_WARNINGS also silences any deprecation notices npm's own node emits.
  const child = spawn(`npm install -g ${UPDATE_URL}`, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })

  const onData = (d) => {
    if (!ui.update) return
    for (const line of d.toString().split('\n')) {
      const l = line.trim()
      if (l) ui.update.last = l       // keep the most recent meaningful line
    }
    ui.dirty = true
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  const finish = (code) => {
    if (!ui.update) return
    if (code === 0) {
      ui.update.status = 'done'
      ui.update.pct = 100
      clearPendingUpdate()
      updateAvailable = false          // installed — hide the [U] hint
    } else {
      ui.update.status = 'failed'
      ui.update.code = code ?? 1
    }
    ui.dirty = true
  }
  child.on('close', finish)
  child.on('error', () => finish(1))
}

// Relaunch the freshly installed yapper in place, then exit this (old) process.
// spawnSync runs sequentially so there's no overlap between the two on screen.
async function restartApp() {
  teardownTerminal()                       // also RST-terminates our client ws
  // Free the host ports before we freeze this process in spawnSync, or the new
  // instance can't bind them and spins forever on "connect…".
  try { if (networkShutdown) await networkShutdown() } catch {}
  try {
    const { spawnSync } = await import('child_process')
    // Re-run exactly how we were launched: node + the same script and args. This
    // works both for a global install (npm overwrote the script at this path, so
    // it now holds the new code) and for a dev run (node bin/yapper.js), and it
    // preserves args like `connect <ip>`. shell:false + args array → no DEP0190.
    const args = process.argv.slice(1)               // [scriptPath, ...userArgs]
    if (args.length) spawnSync(process.execPath, args, { stdio: 'inherit' })
    else spawnSync('yapper', { stdio: 'inherit', shell: true })   // fallback: PATH lookup
  } catch {}
  process.exit(0)
}

// ─── Public API ────────────────────────────────────────────────────────────
export function updateState(patch) {
  if (patch.rooms !== undefined) {
    notifyRoomsChanged(patch.rooms, patch.currentRoom ?? state.currentRoom, patch.userId ?? state.userId)
  }
  // Entering a (different) room: clear its unread badge, reset the chat view and draft.
  if (patch.currentRoom && patch.currentRoom !== state.currentRoom) {
    delete state.unread[patch.currentRoom]
    ui.chat.scroll = 0; ui.chat.stick = true; ui.chat.input = ''
  }
  if ('currentRoom' in patch && !patch.currentRoom) ui.chat.focused = false   // left the room
  Object.assign(state, patch)
  ui.dirty = true
}

export function markTalking(userId, active) {
  if (active) state.talking.add(userId)
  else state.talking.delete(userId)
  ui.dirty = true
}

// ─── Chat (net → UI) ───────────────────────────────────────────────────────────
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
  ui.dirty = true
}

// Backlog (on join) or a host handing us history — merge, dedupe, keep order.
export function mergeChatHistory(room, messages) {
  if (!room || !Array.isArray(messages)) return
  for (const m of messages) pushChat(room, m)
  const list = state.chat[room]
  if (list) list.sort((a, b) => a.ts - b.ts)
  ui.dirty = true
}

// Our local mirror, handed to a freshly-promoted host to seed its history.
export function getChatMirror() { return state.chat }

export function setSelfLevel(l) { state.selfLevel = Math.max(state.selfLevel, l); ui.dirty = true }

export function registerAudio(api) { audioApi = api }

let networkShutdown = null
// index.js registers a hook that closes the host's WS server + discovery
// responder so a relaunched instance can re-bind those ports.
export function registerShutdown(fn) { networkShutdown = fn }

function loop() {
  state.selfLevel = Math.max(0, state.selfLevel - 0.06)   // smooth release
  const animating = state.talking.size > 0 || ui.modal?.testing || state.selfLevel > 0.01 || ui.update?.status === 'running'
  if (ui.dirty || animating) { drawAll(); ui.dirty = false }
}

export function startUI() {
  preloadAll()            // warm the SoX decode cache early
  config.set('username', state.username)
  setThreshold(config.get('vadThreshold', 200))
  setDenoiseEnabled(config.get('noiseSuppression', true))
  loadVolumes()
  setMuteHotkey(config.get('muteHotkey', 'off'), toggleMute)   // arm the saved global mute key (Windows)
  term.fullscreen(true)
  term.hideCursor()
  term.grabInput({ mouse: 'button' })
  term.on('key', handleKey)
  term.on('mouse', handleMouse)
  term.on('resize', () => {
    ui.sb = makeScreen()
    term.clear()
    if (ui.changelog) wrapChangelog()
    ui.dirty = true
  })
  ui.sb = makeScreen()
  ui.dirty = true
  ui.loopTimer = setInterval(loop, 50)

  // "What's new" hint: show the changelog button next to the version only for
  // existing users whose last seen version differs from the running one. A
  // fresh install (no prior conf data) stays quiet. The hint auto-hides after 30s.
  whatsNew = _hadConfig && config.get(SEEN_KEY) !== VERSION
  if (whatsNew) {
    clearTimeout(whatsNewTimer)
    whatsNewTimer = setTimeout(() => {
      config.set(SEEN_KEY, VERSION)
      whatsNew = false
      ui.dirty = true
    }, 30000)
  }

  // Check for updates in the background
  checkForUpdate().then(ver => { if (ver) { updateAvailable = true; notifyUpdateFound(); ui.dirty = true } })
}
