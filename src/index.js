import { parseArgs } from 'util'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const { values, positionals } = parseArgs({
  options: {
    version: { type: 'boolean', short: 'v' },
    help:    { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
  strict: false,
})

if (values.version) {
  console.log(`yapper v${version}`)
  process.exit(0)
}

if (values.help) {
  console.log(`
yapper — CLI voice chat

Usage:
  yapper                Join the LAN: find a host automatically, or become one
  yapper connect <ip>   Connect to a specific host (ip or ws://host:port)
  yapper server         Run a dedicated headless host (no UI)
  yapper setup          Configure audio backend (SoX or naudiodon)

No server to start manually — just run "yapper" on each machine. The first
one becomes the host; everyone else discovers it and shares its rooms. Over
Hamachi/Radmin, if discovery is blocked use "yapper connect <peer-ip>".

Options:
  -v, --version         Show version
  -h, --help            Show this help
`)
  process.exit(0)
}

const command = positionals[0]

// ── Server mode ───────────────────────────────────────────────────────────────
if (command === 'server') {
  const { startServer } = await import('./server/index.js')
  startServer()
  // No process.exit() — WebSocket server keeps the event loop alive
}

// ── Explicit setup command ────────────────────────────────────────────────────
else if (command === 'setup') {
  const { runSetupCLI } = await import('./setup.js')
  await runSetupCLI()
}

// ── Client mode ───────────────────────────────────────────────────────────────
else {
  const { startUI, handlers, registerAudio, registerShutdown, setSelfLevel } = await import('./client/ui/app.js')
  const { connectManaged, wireHandlers, setAudioQueue, sendAudio } = await import('./client/network/ws-client.js')
  const { discover, startResponder } = await import('./net/discovery.js')
  const { startWsServer, DEFAULT_PORT } = await import('./server/ws-server.js')
  const audio = await import('./client/audio/index.js')
  const { startCapture, stopCapture, getInputDevices, setInputDevice, startMicTest, audioEvents } = audio

  // 1. Check audio — show setup wizard if missing (only when interactive)
  let audioResult = await audio.initAudio()
  if (!audioResult.available && process.stdin.isTTY) {
    const { runSetup } = await import('./setup.js')
    await runSetup()
    audioResult = await audio.initAudio()  // re-check after setup
  }

  // 2. Inject audio controls into the UI (settings modal, mic test, VU meter)
  registerAudio({
    available: audioResult.available,
    getInputDevices, setInputDevice, startMicTest,
  })
  audioEvents.on('level', l => setSelfLevel(l))

  // 3. Start TUI
  startUI()

  // 4. Wire network handlers first so the audio hooks can wrap them
  wireHandlers()

  // 5. Wrap audio capture around join/leave
  if (audioResult.available) {
    setAudioQueue(audioResult.queueFrame)

    const origJoin       = handlers.onJoin
    const origLeave      = handlers.onLeave
    const origDisconnect = handlers.onDisconnect

    handlers.onJoin = (room) => {
      origJoin?.(room)
      startCapture(sendAudio)
    }
    handlers.onLeave = () => {
      origLeave?.()
      stopCapture()
    }
    handlers.onDisconnect = () => {
      stopCapture()
      origDisconnect?.()
    }
    // Server forced us out of a room (it got deleted) — stop capture without
    // re-sending `leave`, same as a disconnect teardown of the audio path.
    handlers.onForcedLeave = () => {
      stopCapture()
      import('./client/audio/notifications.js').then(({ notifyLeaving }) => notifyLeaving())
    }
  }

  // 6. Connect — serverless: discover a host on the LAN, or become the host.
  let explicitUrl = null
  if (command === 'connect' && positionals[1]) {
    const arg = positionals[1]
    explicitUrl = arg.startsWith('ws://') ? arg : `ws://${arg}:${DEFAULT_PORT}`
  }

  let hosting = false
  let wss = null            // WebSocketServer when we're the host (else null)
  let responder = null      // discovery responder handle when hosting

  // Release the host's ports (WS 4747 + discovery 4748) so a relaunched instance
  // can re-bind them. Without this, a [R] restart leaves the old process holding
  // the ports while its event loop is frozen by spawnSync, so the new process
  // can neither connect nor host → endless "connect…". Clients are RST-terminated
  // (no TIME_WAIT) and we await the listen socket's close before returning.
  registerShutdown(async () => {
    try { await responder?.stop() } catch {}
    responder = null
    const server = wss
    wss = null
    if (!server) return
    try { for (const c of server.clients) { try { c.terminate() } catch {} } } catch {}
    await new Promise((resolve) => {
      let done = false
      const fin = () => { if (!done) { done = true; resolve() } }
      try { server.close(fin) } catch { fin() }
      setTimeout(fin, 800)   // safety: never hang the restart if close stalls
    })
  })

  async function resolveUrl() {
    if (explicitUrl) return explicitUrl
    if (hosting) return `ws://127.0.0.1:${DEFAULT_PORT}`

    const found = await discover(1500)
    if (found) return `ws://${found.host}:${found.port}`

    // Nobody is hosting — try to become the host.
    try {
      wss = await startWsServer(DEFAULT_PORT)
      responder = startResponder(DEFAULT_PORT)
      hosting = true
      return `ws://127.0.0.1:${DEFAULT_PORT}`
    } catch {
      // Lost the race (port taken) — someone else just became host; find them.
      const again = await discover(1500)
      return again ? `ws://${again.host}:${again.port}` : null
    }
  }

  connectManaged(resolveUrl)
}
