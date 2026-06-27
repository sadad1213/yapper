import dgram from 'dgram'
import os from 'os'

export const DISCOVERY_PORT = 4748
const MAGIC  = 'YAPPER1'
const PROBE  = MAGIC + ':PROBE'
const REPLY  = MAGIC + ':HERE:'   // followed by the WebSocket port

// All broadcast targets we can reach: the global broadcast plus each
// interface's directed broadcast (covers real LAN + Hamachi/Radmin adapters).
function broadcastAddresses() {
  const addrs = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue
      const ip   = i.address.split('.').map(Number)
      const mask = i.netmask.split('.').map(Number)
      const bc   = ip.map((o, k) => (o & mask[k]) | (~mask[k] & 0xff))
      addrs.add(bc.join('.'))
    }
  }
  return [...addrs]
}

// Broadcast a probe and resolve with the first host that answers, or null.
export function discover(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let done = false
    let retryTimer = null, deadline = null
    const finish = (val) => {
      if (done) return
      done = true
      clearTimeout(retryTimer)
      clearTimeout(deadline)
      try { sock.close() } catch {}
      resolve(val)
    }

    sock.on('message', (msg, rinfo) => {
      const s = msg.toString()
      if (s.startsWith(REPLY)) {
        const port = parseInt(s.slice(REPLY.length), 10)
        if (port) finish({ host: rinfo.address, port })
      }
    })
    sock.on('error', () => finish(null))

    sock.bind(() => {
      try { sock.setBroadcast(true) } catch {}
      const data = Buffer.from(PROBE)
      const send = () => {
        if (done) return                 // socket may already be closed (host found fast)
        for (const addr of broadcastAddresses()) {
          try { sock.send(data, DISCOVERY_PORT, addr, () => {}) } catch {}
        }
      }
      send()
      retryTimer = setTimeout(send, 300)             // retry once in case the first probe is lost
      deadline   = setTimeout(() => finish(null), timeoutMs)
    })
  })
}

// Listen for probes and answer with our WebSocket port. Reply is unicast,
// so it works over VPNs even when only the broadcast leg is flaky.
export function startResponder(wsPort) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  sock.on('message', (msg, rinfo) => {
    if (msg.toString() === PROBE) {
      sock.send(Buffer.from(REPLY + wsPort), rinfo.port, rinfo.address, () => {})
    }
  })
  sock.on('error', () => {})
  sock.bind(DISCOVERY_PORT, () => { try { sock.setBroadcast(true) } catch {} })
  return { stop: () => { try { sock.close() } catch {} } }
}
