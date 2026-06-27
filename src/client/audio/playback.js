import { FRAME_SIZE, FRAME_BYTES, CHANNELS } from './capture.js'

// Per-user jitter buffer: userId → Buffer[]
const queues = new Map()
let outputStream = null
let decoder = null
let mixTimer = null

export function initPlayback(dec, stream) {
  decoder = dec
  outputStream = stream
  if (stream.start) stream.start()
}

export function startMixer() {
  if (mixTimer) return
  mixTimer = setInterval(() => {
    const frames = []
    for (const [id, queue] of queues) {
      if (queue.length > 0) frames.push(queue.shift())
      if (queue.length === 0) queues.delete(id)
    }
    if (frames.length === 0 || !outputStream) return
    const mixed = mixFrames(frames)
    outputStream.write(mixed)
  }, 20)
}

export function stopMixer() {
  clearInterval(mixTimer)
  mixTimer = null
  queues.clear()
}

export function queueFrame(userId, opusData) {
  if (!decoder) return
  try {
    const pcm = decoder.decode(Buffer.from(opusData), FRAME_SIZE)
    const buf = Buffer.from(pcm)   // copy exact PCM bytes, not the whole internal buffer
    if (!queues.has(userId)) queues.set(userId, [])
    const q = queues.get(userId)
    // Drop if too far behind to avoid audio delay buildup
    if (q.length < 10) q.push(buf)
  } catch {}
}

function mixFrames(buffers) {
  if (buffers.length === 1) return buffers[0]
  const result = Buffer.alloc(FRAME_BYTES)
  for (let i = 0; i < FRAME_BYTES; i += 2) {
    let s = 0
    for (const b of buffers) s += b.readInt16LE(i)
    result.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i)
  }
  return result
}
