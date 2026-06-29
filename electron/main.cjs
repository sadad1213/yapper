// Electron main process — the GUI's orchestration layer. It mirrors the wiring
// in src/index.js (audio init, host election, connect/reconnect, capture around
// join/leave) but, instead of starting the terminal UI, it forwards the shared
// store's state to the renderer over IPC and turns renderer actions back into
// store/handler calls. All the real logic (discovery, WS signaling, UDP voice,
// OPUS audio) is the same ESM code the CLI uses — reused untouched.
//
// CommonJS on purpose: it lets Electron load the entry directly while we pull the
// ESM `src/` modules in via dynamic import(). Node remains confined to this
// process; the renderer is a sandboxed web page (see preload.cjs).

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')

process.on('uncaughtException', (err) => { console.error('[main] uncaughtException:', err) })
process.on('unhandledRejection', (err) => { console.error('[main] unhandledRejection:', err) })

const IS_DEV = !!process.env.YAPPER_DEV
const DEV_URL = 'http://127.0.0.1:5173'
const APP_VERSION = require('../package.json').version

let win = null
let mods = null            // loaded ESM module namespaces
let audioApi = null        // { available, getInputDevices, setInputDevice, startMicTest }
let networkShutdown = null // releases host ports (WS/discovery/UDP) on quit
let micTestStop = null     // active mic-test teardown fn, if any

// ─── Renderer bridge ─────────────────────────────────────────────────────────
function snapshot() {
  const { state } = mods.store
  return {
    rooms: state.rooms,
    currentRoom: state.currentRoom,
    username: state.username,
    userId: state.userId,
    muted: state.muted,
    connected: state.connected,
    serverAddr: state.serverAddr,
    talking: [...state.talking],          // Set → array for IPC
    chat: state.chat,
    unread: state.unread,
    audioAvailable: !!audioApi?.available,
    appVersion: APP_VERSION,
  }
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', snapshot())
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// ─── Orchestration (mirrors src/index.js) ──────────────────────────────────────
async function loadModules() {
  const [store, settings, wsClient, discovery, wsServer, audio, autoUpdate, notifications] = await Promise.all([
    import('../src/client/core/store.js'),
    import('../src/client/core/settings.js'),
    import('../src/client/network/ws-client.js'),
    import('../src/net/discovery.js'),
    import('../src/server/ws-server.js'),
    import('../src/client/audio/index.js'),
    import('../src/auto-update.js'),
    import('../src/client/audio/notifications.js'),
  ])
  mods = { store, settings, wsClient, discovery, wsServer, audio, autoUpdate, notifications }
}

async function startNetworkAndAudio() {
  const { store, settings, wsClient, discovery, wsServer, audio } = mods
  const { handlers } = store
  const { connectManaged, wireHandlers, setAudioQueue, sendAudio } = wsClient
  const { discover, startResponder } = discovery
  const { startWsServer, startAudioRelay, seedChat, DEFAULT_PORT, AUDIO_PORT } = wsServer
  const { startCapture, stopCapture, getInputDevices, setInputDevice, startMicTest, audioEvents } = audio

  // 1. Audio — proceed even if unavailable (GUI shows it instead of a TUI wizard).
  const audioResult = await audio.initAudio()
  audioApi = { available: audioResult.available, getInputDevices, setInputDevice, startMicTest }
  settings.applyAudioSettings()                 // VAD gate, denoise, per-user volumes from conf
  audioEvents.on('level', (l) => send('mic-level', l))

  // 2. Forward every store mutation to the renderer.
  store.events.on('change', pushState)

  // 3. Wire network handlers, then wrap capture around join/leave (as in index.js).
  wireHandlers()
  if (audioResult.available) {
    setAudioQueue(audioResult.queueFrame)
    const origJoin = handlers.onJoin, origLeave = handlers.onLeave, origDisconnect = handlers.onDisconnect
    handlers.onJoin = (room) => { origJoin?.(room); startCapture(sendAudio) }
    handlers.onLeave = () => { origLeave?.(); stopCapture() }
    handlers.onDisconnect = () => { stopCapture(); origDisconnect?.() }
    handlers.onForcedLeave = () => {
      stopCapture()
      mods.notifications.notifyLeaving()
    }
  }

  // 4. Host election + reconnect resolver (identical strategy to index.js).
  let explicitUrl = null
  const connectArg = process.env.YAPPER_CONNECT
  if (connectArg) explicitUrl = connectArg.startsWith('ws://') ? connectArg : `ws://${connectArg}:${DEFAULT_PORT}`

  let hosting = false, wss = null, responder = null, audioRelay = null

  networkShutdown = async () => {
    try { await responder?.stop() } catch {}
    responder = null
    try { audioRelay?.close() } catch {}
    audioRelay = null
    const server = wss; wss = null
    if (!server) return
    try { for (const c of server.clients) { try { c.terminate() } catch {} } } catch {}
    await new Promise((resolve) => {
      let done = false
      const fin = () => { if (!done) { done = true; resolve() } }
      try { server.close(fin) } catch { fin() }
      setTimeout(fin, 800)
    })
  }

  async function resolveUrl() {
    if (explicitUrl) return explicitUrl
    if (hosting) return `ws://127.0.0.1:${DEFAULT_PORT}`
    const found = await discover(1500)
    if (found) return `ws://${found.host}:${found.port}`
    try {
      wss = await startWsServer(DEFAULT_PORT)
      responder = startResponder(DEFAULT_PORT)
      audioRelay = startAudioRelay(AUDIO_PORT)
      try { seedChat(store.getChatMirror()) } catch {}
      hosting = true
      return `ws://127.0.0.1:${DEFAULT_PORT}`
    } catch {
      const again = await discover(1500)
      return again ? `ws://${again.host}:${again.port}` : null
    }
  }

  connectManaged(resolveUrl)
  pushState()                                   // initial paint (likely "connecting…")
}

// ─── IPC: renderer → main ──────────────────────────────────────────────────────
function registerIpc() {
  const { store, settings, autoUpdate } = mods
  const { handlers } = store

  // Room / chat / identity actions — fire-and-forget.
  ipcMain.on('action', (_e, { type, payload }) => {
    switch (type) {
      case 'join':     handlers.onJoin?.(payload); break
      case 'leave':    if (store.state.currentRoom) { mods.notifications.notifyLeaving(); handlers.onLeave?.() } break
      case 'create':   handlers.onCreate?.(payload); break
      case 'delete':   handlers.onDelete?.(payload); break
      case 'chat':     handlers.onChat?.(payload); break
      case 'mute':     store.state.muted = !!payload; handlers.onMute?.(!!payload); (payload ? mods.notifications.notifyMuted() : mods.notifications.notifyUnmuted()); pushState(); break
      case 'identify': { const u = settings.setUsername(payload); store.state.username = u; handlers.onIdentify?.(u); pushState(); break }
      case 'quit':     app.quit(); break
    }
  })

  // Settings + device queries — request/response.
  ipcMain.handle('getSettings', () => settings.snapshotSettings())
  ipcMain.handle('setUsername', (_e, name) => { const u = settings.setUsername(name); store.state.username = u; handlers.onIdentify?.(u); pushState(); return u })
  ipcMain.handle('setVadThreshold', (_e, v) => settings.setVadThreshold(v))
  ipcMain.handle('setDenoise', (_e, on) => settings.setDenoise(on))
  ipcMain.handle('getUserVolume', (_e, id) => { const v = settings.getUserVolumes()[String(id)]; return typeof v === 'number' ? v : 100 })
  ipcMain.handle('setUserVolume', (_e, { userId, vol }) => settings.setUserVolumePersisted(userId, vol))
  ipcMain.handle('listInputDevices', () => (audioApi?.getInputDevices ? audioApi.getInputDevices() : [{ id: -1, name: 'No audio backend' }]))
  ipcMain.handle('setInputDevice', (_e, id) => { audioApi?.setInputDevice?.(id); return true })

  // Mic test — streams levels on 'mic-test-level' until stopped.
  ipcMain.handle('micTest:start', () => {
    if (!audioApi?.available || !audioApi.startMicTest) return false
    if (micTestStop) { micTestStop(); micTestStop = null }
    micTestStop = audioApi.startMicTest((lvl) => send('mic-test-level', lvl))
    return true
  })
  ipcMain.handle('micTest:stop', () => { if (micTestStop) { micTestStop(); micTestStop = null } return true })

  // Updates.
  ipcMain.handle('checkUpdate', async () => {
    try { return await autoUpdate.checkForUpdateManual() } catch { return null }
  })
  ipcMain.handle('fetchChangelog', async (_e, ver) => {
    try { return await autoUpdate.fetchChangelog(ver) } catch { return null }
  })
  ipcMain.on('runUpdate', () => runUpdate())

  // Open external links in the OS browser (chat URLs).
  ipcMain.on('openExternal', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url) })
}

const UPDATE_URL = 'https://github.com/sadad1213/yapper/archive/refs/heads/main.tar.gz'

function runUpdate() {
  const { spawn } = require('child_process')
  send('update-progress', { status: 'running', last: 'starting…' })
  const child = spawn(`npm install -g ${UPDATE_URL}`, {
    stdio: ['ignore', 'pipe', 'pipe'], shell: true,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  const onData = (d) => {
    for (const line of d.toString().split('\n')) {
      const l = line.trim()
      if (l) send('update-progress', { status: 'running', last: l })
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  const finish = (code) => {
    if (code === 0) { try { mods.autoUpdate.clearPendingUpdate() } catch {}; send('update-progress', { status: 'done' }) }
    else send('update-progress', { status: 'failed', code: code ?? 1 })
  }
  child.on('close', finish)
  child.on('error', () => finish(1))
}

// ─── Window + lifecycle ────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1024, height: 680, minWidth: 760, minHeight: 480,
    backgroundColor: '#0e1116',
    title: 'Yapper',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.removeMenu()
  if (IS_DEV) {
    win.loadURL(DEV_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'))
  }
  // Push a fresh snapshot once the page is ready to receive it.
  win.webContents.on('did-finish-load', () => { if (mods) pushState() })
}

app.whenReady().then(async () => {
  await loadModules()
  createWindow()
  registerIpc()
  await startNetworkAndAudio()

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch((err) => { console.error('[main] startup failed:', err) })

let quitting = false
app.on('before-quit', async (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  try { if (micTestStop) micTestStop() } catch {}
  try { mods?.wsClient.disconnect() } catch {}
  try { if (networkShutdown) await networkShutdown() } catch {}
  app.exit(0)
})

app.on('window-all-closed', () => { app.quit() })
