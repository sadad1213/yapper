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

Options:
  -v, --version         Show version
  -h, --help            Show this help
`)
  process.exit(0)
}

const command = positionals[0]

if (command === 'server') {
  const { startServer } = await import('./server/index.js')
  startServer()
} else {
  const { startUI, state, handlers } = await import('./client/ui/app.js')
  const { connect, wireHandlers, setAudioQueue, sendAudio } = await import('./client/network/ws-client.js')
  const { discoverServer } = await import('./client/network/discovery.js')

  startUI()
  wireHandlers()

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

  // Audio — non-blocking, shows warning in stderr if unavailable
  try {
    const { initAudio, startCapture, stopCapture } = await import('./client/audio/index.js')
    const audio = await initAudio()

    if (!audio.available) {
      process.stderr.write(`[yapper] Audio unavailable: ${audio.reason}\n`)
    } else {
      setAudioQueue(audio.queueFrame)

      // Wrap join/leave to start/stop audio capture
      const origJoin = handlers.onJoin
      const origLeave = handlers.onLeave
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
  } catch (err) {
    process.stderr.write(`[yapper] Audio init error: ${err.message}\n`)
  }
}
