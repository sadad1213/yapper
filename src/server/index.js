import { startWsServer, DEFAULT_PORT } from './ws-server.js'
import { startResponder } from '../net/discovery.js'

// Explicit dedicated host (no UI) — handy for an always-on machine.
export async function startServer() {
  try {
    const wss = await startWsServer(DEFAULT_PORT)
    const responder = startResponder(DEFAULT_PORT)
    console.log(`yapper host running on port ${DEFAULT_PORT} — discoverable on the LAN`)

    process.on('SIGINT', () => {
      console.log('\nShutting down...')
      responder.stop()
      wss.close(() => process.exit(0))
    })
  } catch (err) {
    console.error(`Could not start host on port ${DEFAULT_PORT}: ${err.message}`)
    console.error('Another yapper host may already be running on this machine.')
    process.exit(1)
  }
}
