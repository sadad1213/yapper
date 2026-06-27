import { FRAME_SIZE, FRAME_BYTES } from './capture.js'

const FRAME_MS = 20
const JITTER_TARGET = 3     // pre-roll frames (~60ms) to absorb network jitter
const MAX_BUFFER = 20       // ~400ms hard cap before dropping oldest frames

const SILENCE = Buffer.alloc(FRAME_BYTES)

// userId → { frames: Buffer[], playing: boolean }
const users = new Map()

let outputStream = null
let decoder = null
let timer = null
let startTime = null
let framesWritten = 0

export function initPlayback(dec, stream) {
  decoder = dec
  outputStream = stream
  if (stream.start) stream.start()
}

export function startMixer() {
  if (timer) {
    clearInterval(timer)          // reset — room switch must start fresh
    timer = null
    users.clear()
  }
  startTime = Date.now()
  framesWritten = 0
  // Tick faster than the frame rate; the wall-clock drift correction in tick()
  // decides how many 20ms frames are actually due, so output stays in realtime.
  timer = setInterval(tick, 10)
}

export function stopMixer() {
  clearInterval(timer)
  timer = null
  users.clear()
  startTime = null
  framesWritten = 0
}

export function queueFrame(userId, opusData) {
  if (!decoder) return
  let pcm
  try { pcm = Buffer.from(decoder.decode(Buffer.from(opusData), FRAME_SIZE)) }
  catch { return }

  let u = users.get(userId)
  if (!u) { u = { frames: [], playing: false }; users.set(userId, u) }
  u.frames.push(pcm)
  if (u.frames.length > MAX_BUFFER) u.frames.splice(0, u.frames.length - MAX_BUFFER)
}

function tick() {
  if (!outputStream || startTime == null) return
  const due = Math.floor((Date.now() - startTime) / FRAME_MS)
  let n = due - framesWritten
  if (n <= 0) return
  if (n > 5) { framesWritten = due - 1; n = 1 }   // we stalled — resync instead of fast-forwarding
  for (let i = 0; i < n; i++) { writeFrame(); framesWritten++ }
}

function writeFrame() {
  const active = []
  for (const u of users.values()) {
    if (!u.playing) {
      if (u.frames.length >= JITTER_TARGET) u.playing = true   // pre-roll reached
      else continue                                            // still buffering → silent
    }
    if (u.frames.length > 0) active.push(u.frames.shift())
    else u.playing = false                                     // underran → rebuffer before resuming
  }

  const out = active.length === 0 ? SILENCE
            : active.length === 1 ? active[0]
            : mix(active)
  outputStream.write(out)
}

function mix(buffers) {
  const result = Buffer.alloc(FRAME_BYTES)
  for (let i = 0; i < FRAME_BYTES; i += 2) {
    let s = 0
    for (const b of buffers) s += b.readInt16LE(i)
    result.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i)
  }
  return result
}
