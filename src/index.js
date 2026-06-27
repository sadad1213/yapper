import { parseArgs } from 'util'

const { values, positionals } = parseArgs({
  options: {
    version: { type: 'boolean', short: 'v' },
    help:    { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
  strict: false,
})

if (values.version) {
  console.log('yapper v0.1.0')
  process.exit(0)
}

if (values.help) {
  console.log(`
yapper — CLI voice chat

Usage:
  yapper                Auto-discover server on LAN and start client
  yapper server         Start a server on the local network
  yapper connect <url>  Connect to a specific server (ws://host:port)
  yapper setup          Configure audio backend (SoX or naudiodon)

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
  const { startUI, handlers } = await import('./client/ui/app.js')
  const { connect, wireHandlers, setAudioQueue, sendAudio } = await import('./client/network/ws-client.js')
  const { discoverServer }  = await import('./client/network/discovery.js')
  const { initAudio, startCapture, stopCapture } = await import('./client/audio/index.js')

  // 1. Check audio — show setup wizard if missing (before TUI)
  let audioResult = await initAudio()
  if (!audioResult.available) {
    const { runSetup } = await import('./setup.js')
    await runSetup()
    audioResult = await initAudio()  // re-check after setup
  }

  // 2. Start TUI
  startUI()

  // 3. Wire network handlers first so setupAudioHooks can wrap them
  wireHandlers()

  // 4. Wrap audio around network handlers
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
  }

  // 5. Connect to server
  const targetUrl = (command === 'connect' && positionals[1]) ? positionals[1] : null

  async function tryConnect() {
    try {
      const url = targetUrl ?? await discoverServer()
      connect(url)
    } catch {
      setTimeout(tryConnect, 5000)
    }
  }
  tryConnect()
}
