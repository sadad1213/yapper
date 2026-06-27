import Bonjour from 'bonjour-service'

const TIMEOUT_MS = 4000

export function discoverServer() {
  return new Promise((resolve, reject) => {
    const bonjour = new Bonjour()
    const timer = setTimeout(() => {
      browser.stop()
      bonjour.destroy()
      reject(new Error('No yapper server found on local network'))
    }, TIMEOUT_MS)

    const browser = bonjour.find({ type: 'yapper' }, (service) => {
      clearTimeout(timer)
      browser.stop()
      bonjour.destroy()
      const host = service.addresses?.[0] ?? service.host ?? '127.0.0.1'
      resolve(`ws://${host}:${service.port}`)
    })
  })
}
