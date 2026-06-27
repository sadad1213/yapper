import termkit from 'terminal-kit'
import Conf from 'conf'
import { createRequire } from 'module'
import { getThreshold, setThreshold } from '../audio/vad.js'
import { getUserVolume, setUserVolume } from '../audio/playback.js'
import { checkForUpdate, clearPendingUpdate, fetchChangelog } from '../../auto-update.js'

const term = termkit.terminal
const config = new Conf({ projectName: 'yapper' })
// Captured at module load (before startUI writes anything): tells an update from
// an old version (conf already had data → existing user) apart from a genuinely
// fresh install (conf empty). Only existing users get the "what's new" hint.
const _hadConfig = Object.keys(config.store).length > 0

const require = createRequire(import.meta.url)
const VERSION = require('../../../package.json').version

const LEFT_W = 22            // inner width of the left (rooms) panel
const MAX_USERNAME = 32       // matches the server-side slice(0, 32)
const MAX_ROOMNAME = 20       // short enough to fit a sidebar row: `▸ <name> <count>` in LEFT_W

const THRESHOLD_PRESETS = [
  { value: 100, label: 'Quiet (100)' },
  { value: 200, label: 'Normal (200)' },
  { value: 400, label: 'Loud (400)' },
]

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
}

export const handlers = {
  onJoin: null, onLeave: null, onCreate: null, onMute: null, onDisconnect: null,
}

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
  userZones: [],             // clickable user rows [{ x0, x1, y, userId, username }]
  roomItems: [],             // left-panel navigation [{ type:'room'|'user'|'newRoom', ... }]
  selectedLine: 0,           // index into roomItems
  statusZones: [],           // clickable status-bar segments
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
function L() {
  const W = ui.sb.width, H = ui.sb.height
  const divX = LEFT_W + 1
  const headerRow = 1, ulineRow = 2, firstRow = 3
  const sepRow = H - 3, statusRow = H - 2
  const lastRow = sepRow - 1
  const rightX = divX + 2
  const rightW = Math.max(4, W - rightX - 2)
  return { W, H, divX, headerRow, ulineRow, firstRow, sepRow, statusRow, lastRow, rightX, rightW }
}

// ─── Render ────────────────────────────────────────────────────────────────
function drawAll() {
  const sb = ui.sb
  if (!sb) return
  sb.fill({ char: ' ', attr: {} })
  drawFrame()
  drawRooms()
  drawUsers()
  drawStatus()
  if (ui.modal) drawModal()
  if (ui.prompt) drawPrompt()
  if (ui.volumePopup) drawVolumePopup()
  if (ui.changelog) drawChangelog()
  sb.draw({ delta: true })
}

function drawFrame() {
  const { W, H, divX, headerRow, ulineRow, sepRow, statusRow, lastRow, rightX, rightW } = L()
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

  // side borders + divider
  for (let y = 1; y <= statusRow; y++) { putStr(0, y, '│', dim); putStr(W - 1, y, '│', dim) }
  for (let y = 1; y <= lastRow; y++) putStr(divX, y, '│', dim)

  // separator above status bar
  putStr(0, sepRow, '├' + '─'.repeat(W - 2) + '┤', dim)
  putStr(divX, sepRow, '┴', dim)

  // headers
  putStr(2, headerRow, 'ROOMS', { bold: true })
  const room = state.rooms.find(r => r.name === state.currentRoom)
  const title = state.currentRoom || 'no room joined'
  putStr(rightX, headerRow, title, state.currentRoom ? { color: 'cyan', bold: true } : dim)
  if (room) {
    const cnt = `${room.users.length} online`
    putStr(W - 2 - cnt.length, headerRow, cnt, dim)
  }
  putStr(2, ulineRow, '─'.repeat(LEFT_W - 1), dim)
  putStr(rightX, ulineRow, '─'.repeat(rightW), dim)
}

function drawRooms() {
  const { firstRow, lastRow } = L()

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
      const line = padEnd(label, LEFT_W - 1 - count.length) + count
      const attr = sel ? { bgColor: 'cyan', color: 'black' }
                 : cur ? { color: 'green', bold: true } : {}
      putStr(1, y, padEnd(line, LEFT_W), attr)
    } else if (item.type === 'user') {
      const branch = item.last ? '  └─ ' : '  ├─ '
      const name = item.self ? `${item.username} (you)` : item.username
      const line = branch + name
      const attr = sel ? { bgColor: 'cyan', color: 'black' }
                 : item.self ? { color: 'green', bold: true }
                 : { dim: true }
      putStr(1, y, padEnd(line, LEFT_W), attr)
    }
    y++
  }

  // Footer: [+ new room] pinned to the very bottom of the sidebar, with a
  // thin divider above it so it reads as an action, not just another room.
  putStr(1, lastRow - 1, '─'.repeat(LEFT_W), { dim: true })
  const sel = newRoomIdx === ui.selectedLine && !ui.modal && !ui.prompt && !ui.volumePopup && !ui.changelog
  putStr(1, lastRow, padEnd('+ new room', LEFT_W), sel ? { bgColor: 'cyan', color: 'black' } : { dim: true })
  ui.newRoomY = lastRow
}

function drawUsers() {
  const { rightX, rightW, firstRow, lastRow } = L()
  ui.userZones = []

  if (!state.currentRoom) {
    putStr(rightX, Math.floor((firstRow + lastRow) / 2), 'Select a room on the left and press Enter to join.', { dim: true })
    return
  }

  const room = state.rooms.find(r => r.name === state.currentRoom)
  const others = (room?.users ?? []).filter(u => u.id !== state.userId)

  // Participant list — self sits at the top, right among everyone else.
  let y = firstRow
  drawUserRow(y++, state.username + ' (you)', {
    self: true, muted: state.muted,
    talking: !state.muted && state.selfLevel > 0.05,
  })
  for (const u of others) {
    if (y > lastRow - 1) break
    drawUserRow(y, u.name, { talking: state.talking.has(u.id), muted: u.muted, seed: u.id })
    ui.userZones.push({ x0: rightX, x1: rightX + rightW, y, userId: u.id, username: u.name })
    y++
  }

  // Dedicated mic-level bar pinned at the bottom of the panel.
  const label = state.muted ? 'your mic · muted' : 'your mic'
  putStr(rightX, lastRow, label, state.muted ? { color: 'red', dim: true } : { dim: true })
  const meterX = rightX + 17
  const meterW = Math.max(8, rightW - 19)
  const lvl = state.muted ? 0 : state.selfLevel
  putStr(meterX, lastRow, bar(lvl, meterW), levelAttr(lvl))
}

function drawUserRow(y, name, o) {
  const { rightX, rightW } = L()
  const icon = o.muted ? '⊘' : (o.talking ? '◉' : '○')
  const iconAttr = o.muted ? { color: 'red' } : (o.talking ? { color: 'green', bold: true } : { dim: true })
  putStr(rightX, y, icon, iconAttr)

  const nameAttr = o.self ? { color: 'cyan', bold: true } : (o.talking ? { bold: true } : {})
  putStr(rightX + 2, y, padEnd(name, 16), nameAttr)

  const statusX = rightX + 19
  const meterW = Math.max(6, Math.min(14, rightW - 21))
  if (o.muted)        putStr(statusX, y, 'muted', { color: 'red', dim: true })
  else if (o.self)    putStr(statusX, y, o.talking ? 'speaking' : 'idle', { color: 'cyan', dim: !o.talking })
  else if (o.talking) putStr(statusX, y, animBars(o.seed || 1, meterW), { color: 'green' })
  else                putStr(statusX, y, 'idle', { dim: true })
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
  const bw = Math.min(54, W - 4), bh = 14
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
  m.rowsY = [by + 2, by + 4, by + 6, by + 8, by + 12]

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

  const thr = THRESHOLD_PRESETS[m.thresholdIdx]?.label || 'Normal (200)'
  modalField(ix, by + 8, rw, 'sensitivity', '‹ ' + thr + ' ›', m.row === 3)

  putStr(ix + 1, by + 10, '↑↓ move · enter select · ‹ › adjust · esc close', { dim: true })
  modalField(ix, by + 12, rw, '', '[ close ]', m.row === 4)
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
  if (ui.volumePopup) return handleVolumeKey(name)
  if (ui.changelog) return handleChangelogKey(name)
  if (ui.prompt) return handlePromptKey(name, data)
  if (ui.modal)  return handleModalKey(name, data)

  switch (name) {
    case 'UP':    move(-1); break
    case 'DOWN':  move(1); break
    case 'ENTER': activateSelection(); break
    case 'ESCAPE': if (state.currentRoom && handlers.onLeave) handlers.onLeave(); break
    case 'm': case 'M': toggleMute(); break
    case 's': case 'S': openSettings(); break
    case 'n': case 'N': promptNewRoom(); break
    case 'c': case 'C': if (whatsNew) openChangelog(); break
    case 'u': case 'U': if (updateAvailable) runUpdate(); break
    case 'q': case 'Q': quit(); break
  }
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
  if (name === 'LEFT')        { v.vol = Math.max(0, v.vol - 10); ui.dirty = true }
  else if (name === 'RIGHT')  { v.vol = Math.min(200, v.vol + 10); ui.dirty = true }
  else if (name === 'ESCAPE' || name === 'ENTER') closeVolumePopup()
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
    case 'UP':    m.row = (m.row + 4) % 5; ui.dirty = true; break
    case 'DOWN':  m.row = (m.row + 1) % 5; ui.dirty = true; break
    case 'LEFT':  if (m.row === 1) cycleDevice(-1); else if (m.row === 3) cycleThreshold(-1); break
    case 'RIGHT': if (m.row === 1) cycleDevice(1); else if (m.row === 3) cycleThreshold(1); break
    case 'ENTER': modalActivate(); break
    case 's': case 'S': case 'q': case 'Q': case 'ESCAPE': closeSettings(); break
  }
}

// ─── Input: mouse ─────────────────────────────────────────────────────────────
function handleMouse(name, data) {
  const x = data.x - 1, y = data.y - 1   // terminal is 1-based, buffer 0-based

  if (ui.volumePopup) {         // click anywhere outside closes
    if (name === 'MOUSE_LEFT_BUTTON_PRESSED') closeVolumePopup()
    return
  }
  if (ui.changelog) return handleChangelogMouse(name, x, y)
  if (ui.prompt) {              // click anywhere outside closes the prompt
    return
  }
  if (ui.modal) return handleModalMouse(name, x, y)

  if (name === 'MOUSE_WHEEL_UP')   { move(-1); return }
  if (name === 'MOUSE_WHEEL_DOWN') { move(1);  return }
  if (name !== 'MOUSE_LEFT_BUTTON_PRESSED') return

  const { firstRow, lastRow, divX, statusRow } = L()

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
  if (state.currentRoom && handlers.onLeave) handlers.onLeave()   // leave old room before joining new one
  if (handlers.onJoin) handlers.onJoin(name)
  else state.currentRoom = name
  ui.dirty = true
}

function toggleMute() {
  state.muted = !state.muted
  handlers.onMute?.(state.muted)
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

// ─── Settings modal ───────────────────────────────────────────────────────────
function openSettings() {
  const devices = audioApi?.getInputDevices ? audioApi.getInputDevices() : [{ id: -1, name: 'default' }]
  const savedThreshold = config.get('vadThreshold', 200)
  const presetIdx = THRESHOLD_PRESETS.findIndex(p => p.value === savedThreshold)
  ui.modal = { row: 0, editing: false, edit: '', devices, devIdx: 0, testing: false, testLevel: 0, testError: false, thresholdIdx: presetIdx >= 0 ? presetIdx : 1 }
  ui.dirty = true
}

function closeSettings() {
  stopMicTest()
  ui.modal = null
  ui.dirty = true
}

function modalActivate() {
  const m = ui.modal
  if (m.row === 0)      { m.editing = true; m.edit = state.username; ui.dirty = true }
  else if (m.row === 1) cycleDevice(1)
  else if (m.row === 2) toggleMicTest()
  else if (m.row === 3) cycleThreshold(1)
  else if (m.row === 4) closeSettings()
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

function cycleThreshold(dir) {
  const m = ui.modal
  m.thresholdIdx = (m.thresholdIdx + dir + THRESHOLD_PRESETS.length) % THRESHOLD_PRESETS.length
  const val = THRESHOLD_PRESETS[m.thresholdIdx].value
  config.set('vadThreshold', val)
  setThreshold(val)
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

function quit() {
  handlers.onDisconnect?.()
  clearInterval(ui.loopTimer)
  term.grabInput(false)
  term.styleReset()
  term.clear()
  term.fullscreen(false)
  process.stdout.write('\x1b[?25h')   // show cursor (terminal-kit compat)
  process.exit(0)
}

async function runUpdate() {
  // Exit TUI cleanly first
  handlers.onDisconnect?.()
  clearInterval(ui.loopTimer)
  term.grabInput(false)
  term.styleReset()
  term.clear()
  term.fullscreen(false)
  process.stdout.write('\x1b[?25h')   // show cursor (terminal-kit compat)

  const { spawn } = await import('child_process')
  console.log('\n' + '─'.repeat(40))
  console.log('  yapper — updating to latest...\n')

  const child = spawn('npm', ['install', '-g', 'https://github.com/sadad1213/yapper/archive/refs/heads/main.tar.gz'], {
    stdio: 'inherit',
    shell: true,
  })

  child.on('close', (code) => {
    console.log('\n' + '─'.repeat(40))
    if (code === 0) {
      console.log('  ✓ Update complete! Run yapper again.')
      clearPendingUpdate()
    } else {
      console.log('  ✗ Update failed (code ' + code + '). Try manually:')
      console.log('    npm install -g https://github.com/sadad1213/yapper/archive/refs/heads/main.tar.gz')
    }
    process.exit(code ?? 1)
  })
}

// ─── Public API ────────────────────────────────────────────────────────────
export function updateState(patch) { Object.assign(state, patch); ui.dirty = true }

export function markTalking(userId, active) {
  if (active) state.talking.add(userId)
  else state.talking.delete(userId)
  ui.dirty = true
}

export function setSelfLevel(l) { state.selfLevel = Math.max(state.selfLevel, l); ui.dirty = true }

export function registerAudio(api) { audioApi = api }

function loop() {
  state.selfLevel = Math.max(0, state.selfLevel - 0.06)   // smooth release
  const animating = state.talking.size > 0 || ui.modal?.testing || state.selfLevel > 0.01
  if (ui.dirty || animating) { drawAll(); ui.dirty = false }
}

export function startUI() {
  config.set('username', state.username)
  setThreshold(config.get('vadThreshold', 200))
  loadVolumes()
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
  checkForUpdate().then(ver => { if (ver) { updateAvailable = true; ui.dirty = true } })
}
