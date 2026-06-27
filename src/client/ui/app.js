import termkit from 'terminal-kit'
import Conf from 'conf'

const term = termkit.terminal
const config = new Conf({ projectName: 'yapper' })

const VERSION = '0.1.0'
const LEFT_INNER = 22   // visible chars in left panel (not counting border/divider)
const PORT = 4747

// ─── State ─────────────────────────────────────────────────────────────────
export const state = {
  rooms: [],                  // [{ name, users: [{id, name, muted}] }]
  currentRoom: null,
  selectedIdx: 0,
  username: String(config.get('username') || ('user' + (Math.floor(Math.random() * 9000) + 1000))),
  userId: null,
  muted: false,
  connected: false,
  serverAddr: null,
  talking: new Set(),         // set of userIds currently sending audio
}

// Set these from ws-client.js to wire up network actions
export const handlers = {
  onJoin: null,
  onLeave: null,
  onCreate: null,
  onMute: null,
  onDisconnect: null,
}

// ─── Layout ────────────────────────────────────────────────────────────────
function lay() {
  const W = term.width || 80
  const H = term.height || 24
  const divX = LEFT_INNER + 2    // col 24 = 1(left border) + 22(inner) + 1(divider)
  const firstRow = 4             // first content row
  const lastRow = H - 3          // last content row
  const statusRow = H - 1
  return { W, H, divX, firstRow, lastRow, statusRow }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function pad(str, width) {
  const s = String(str)
  if (s.length >= width) return s.slice(0, width)
  return s + ' '.repeat(width - s.length)
}

// ─── Full render ────────────────────────────────────────────────────────────
export function render() {
  term.clear()
  const l = lay()
  drawFrame(l)
  drawRoomPanel(l)
  drawUserPanel(l)
  drawStatusBar(l)
  term.hideCursor()
}

function drawFrame(l) {
  const { W, H, divX } = l
  const title = ` yapper v${VERSION} `
  const srv = state.connected ? ` ${state.serverAddr} ` : ' not connected '
  const fillTotal = Math.max(0, W - 2 - title.length - srv.length)
  const fillL = Math.floor(fillTotal / 2)
  const fillR = fillTotal - fillL

  // Row 1: top border
  term.moveTo(1, 1)
  term('┌')
  term.bold.cyan(title)
  term('─'.repeat(fillL))
  term.dim(srv)
  term('─'.repeat(fillR))
  term('┐')

  // Row 2: column headers
  const rightInner = W - divX - 2
  const roomLabel = state.currentRoom ? `IN ROOM: ${state.currentRoom}` : 'IN ROOM: -'
  term.moveTo(1, 2)
  term('│')
  term.bold(' ' + pad('ROOMS', LEFT_INNER) + ' ')
  term('│')
  term.bold(' ' + pad(roomLabel, rightInner) + ' ')
  term('│')

  // Row 3: sub-header separator
  term.moveTo(1, 3)
  term('│')
  term.dim(' ' + '─'.repeat(LEFT_INNER) + ' ')
  term('│')
  term.dim(' ' + '─'.repeat(rightInner) + ' ')
  term('│')

  // Rows 4..H-3: side borders
  for (let y = 4; y <= H - 3; y++) {
    term.moveTo(1, y)('│')
    term.moveTo(divX, y)('│')
    term.moveTo(W, y)('│')
  }

  // Row H-2: separator above status bar (┴ at divider col)
  term.moveTo(1, H - 2)
  term('├' + '─'.repeat(divX - 2) + '┴' + '─'.repeat(W - divX - 1) + '┤')

  // Row H-1: status bar side borders
  term.moveTo(1, H - 1)('│')
  term.moveTo(W, H - 1)('│')

  // Row H: bottom border
  term.moveTo(1, H)
  term('└' + '─'.repeat(W - 2) + '┘')
}

function drawRoomPanel(l) {
  const { firstRow, lastRow } = l
  const btnRow = lastRow - 1      // [+ New Room] fixed near bottom
  let row = firstRow

  state.rooms.forEach((room, idx) => {
    if (row >= btnRow) return     // don't overdraw [+ New Room] position
    const isCurrent = state.currentRoom === room.name
    const isSelected = state.selectedIdx === idx
    const prefix = isCurrent ? '▶ ' : '  '
    const count = `(${room.users.length})`
    const namepart = prefix + room.name
    const spacer = Math.max(1, LEFT_INNER - namepart.length - count.length)
    const line = namepart + ' '.repeat(spacer) + count

    term.moveTo(2, row)
    if (isSelected && !isCurrent) term.bgBlue.white(' ' + pad(line, LEFT_INNER) + ' ')
    else if (isCurrent)            term.green(' ' + pad(line, LEFT_INNER) + ' ')
    else                           term(' ' + pad(line, LEFT_INNER) + ' ')
    row++
  })

  // [+ New Room] button
  if (btnRow >= firstRow) {
    const isSelected = state.selectedIdx === state.rooms.length
    term.moveTo(2, btnRow)
    if (isSelected) term.bgBlue.white(' ' + pad('[+ New Room]', LEFT_INNER) + ' ')
    else            term.dim(' ' + pad('[+ New Room]', LEFT_INNER) + ' ')
  }
}

function drawUserPanel(l) {
  const { W, divX, firstRow, lastRow } = l
  const rightInner = W - divX - 2
  const col = divX + 2

  if (!state.currentRoom) {
    const msg = 'Click or press Enter to join a room'
    const midRow = Math.floor((firstRow + lastRow) / 2)
    term.moveTo(col, midRow)
    term.dim(pad(msg, rightInner))
    return
  }

  const room = state.rooms.find(r => r.name === state.currentRoom)
  const others = (room?.users ?? []).filter(u => u.id !== state.userId)
  let row = firstRow

  for (const user of others) {
    if (row > lastRow) break
    const isTalking = state.talking.has(user.id)
    const prefix = isTalking ? '▶ ' : '· '
    const suffix = user.muted ? ' [muted]' : isTalking ? ' [talking]' : ''
    const line = prefix + user.name + suffix
    term.moveTo(col, row)
    if (isTalking) term.green(pad(line, rightInner))
    else           term(pad(line, rightInner))
    row++
  }

  // Show self at the bottom (always)
  if (row <= lastRow) {
    const prefix = state.muted ? 'x ' : '· '
    const suffix = state.muted ? ' [muted]' : ''
    const line = prefix + state.username + suffix + ' (you)'
    term.moveTo(col, row)
    if (state.muted) term.red(pad(line, rightInner))
    else             term.cyan(pad(line, rightInner))
  }
}

function drawStatusBar(l) {
  const { W, statusRow } = l
  const muteHint = state.muted ? '[M] Unmute' : '[M] Mute  '
  const bar = ` ${muteHint}  [N] New Room  [S] Settings  [Q] Quit  arrows/click to navigate`
  term.moveTo(2, statusRow)
  term.dim(pad(bar, W - 2))
}

// ─── Input ─────────────────────────────────────────────────────────────────
let inputLocked = false

function handleKey(name) {
  if (inputLocked) return
  const total = state.rooms.length + 1  // +1 for [+ New Room]

  switch (name) {
    case 'UP':
      state.selectedIdx = (state.selectedIdx - 1 + total) % total
      render(); break
    case 'DOWN':
      state.selectedIdx = (state.selectedIdx + 1) % total
      render(); break
    case 'ENTER':
      if (state.selectedIdx === state.rooms.length) promptNewRoom()
      else if (state.rooms[state.selectedIdx]) joinRoom(state.rooms[state.selectedIdx].name)
      break
    case 'm': case 'M': toggleMute(); break
    case 's': case 'S': showSettings(); break
    case 'n': case 'N': promptNewRoom(); break
    case 'q': case 'Q': case 'CTRL_C': quit(); break
  }
}

function handleMouse(name, data) {
  if (inputLocked) return
  const { x, y } = data
  const l = lay()
  const { divX, firstRow, lastRow, statusRow } = l

  if (name === 'MOUSE_WHEEL_UP') {
    state.selectedIdx = Math.max(0, state.selectedIdx - 1)
    render(); return
  }
  if (name === 'MOUSE_WHEEL_DOWN') {
    state.selectedIdx = Math.min(state.rooms.length, state.selectedIdx + 1)
    render(); return
  }
  if (name !== 'MOUSE_LEFT_BUTTON_PRESSED') return

  // Left panel click
  if (x >= 1 && x < divX && y >= firstRow && y <= lastRow) {
    const btnRow = lastRow - 1
    if (y === btnRow) {
      state.selectedIdx = state.rooms.length
      promptNewRoom()
    } else {
      const idx = y - firstRow
      if (idx >= 0 && idx < state.rooms.length) {
        state.selectedIdx = idx
        joinRoom(state.rooms[idx].name)
      }
    }
  }

  // Status bar shortcut clicks
  if (y === statusRow) {
    if (x >= 2 && x <= 13)  toggleMute()
    if (x >= 16 && x <= 28) promptNewRoom()
    if (x >= 31 && x <= 42) showSettings()
  }
}

// ─── Actions ───────────────────────────────────────────────────────────────
function joinRoom(name) {
  if (name === state.currentRoom) return
  if (handlers.onJoin) {
    handlers.onJoin(name)
  } else {
    state.currentRoom = name
    render()
  }
}

function toggleMute() {
  state.muted = !state.muted
  if (handlers.onMute) handlers.onMute(state.muted)
  render()
}

async function promptNewRoom() {
  if (inputLocked) return
  inputLocked = true
  const l = lay()

  // Redraw status bar as an input prompt
  term.moveTo(2, l.statusRow)
  term(pad('', l.W - 2))
  term.moveTo(2, l.statusRow)
  term(' New room name: ')

  const input = await new Promise(resolve =>
    term.inputField({ cancelable: true, style: term.white }, (err, val) => resolve(val))
  )
  inputLocked = false

  if (input && input.trim()) {
    const name = input.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
    if (handlers.onCreate) {
      handlers.onCreate(name)
    } else {
      if (!state.rooms.find(r => r.name === name)) state.rooms.push({ name, users: [] })
      state.selectedIdx = state.rooms.findIndex(r => r.name === name)
      state.currentRoom = name
    }
  }
  render()
}

async function showSettings() {
  if (inputLocked) return
  inputLocked = true
  const l = lay()

  term.moveTo(2, l.statusRow)
  term(pad('', l.W - 2))
  term.moveTo(2, l.statusRow)
  term(` Username [${state.username}]: `)

  const input = await new Promise(resolve =>
    term.inputField({ default: state.username, cancelable: true, style: term.white }, (err, val) => resolve(val))
  )
  inputLocked = false

  if (input !== null && input.trim()) {
    state.username = input.trim().slice(0, 32)
    config.set('username', state.username)
  }
  render()
}

function quit() {
  if (handlers.onDisconnect) handlers.onDisconnect()
  term.fullscreen(false)
  term.showCursor()
  term.grabInput(false)
  process.exit(0)
}

// ─── Public API ────────────────────────────────────────────────────────────
export function updateState(patch) {
  Object.assign(state, patch)
  render()
}

export function markTalking(userId, active) {
  if (active) state.talking.add(userId)
  else state.talking.delete(userId)
  render()
}

export function startUI() {
  config.set('username', state.username)   // ensure persisted
  term.fullscreen(true)
  term.hideCursor()
  term.grabInput({ mouse: 'button' })
  term.on('key', handleKey)
  term.on('mouse', handleMouse)
  term.on('resize', render)
  render()
}
