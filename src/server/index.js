import { startWsServer } from './ws-server.js'

export function startServer() {
  console.log('Starting yapper server...')
  const wss = startWsServer()

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    wss.close(() => process.exit(0))
  })
}
