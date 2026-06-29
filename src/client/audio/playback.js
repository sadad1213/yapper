import { FRAME_SIZE, FRAME_BYTES } from './capture.js'

const FRAME_MS = 10         // 10ms Opus frames (see capture.js FRAME_SIZE)
const TICK_MS = FRAME_MS / 2 // tick twice per frame so wall-clock drift correction has headroom
const JITTER_TARGET = 3     // pre-roll frames (~30ms) to absorb network jitter
const MAX_BUFFER = 40       // ~400ms hard cap before dropping oldest frames

const SILENCE = Buffer.alloc(FRAME_BYTES)

// userId → { frames: Buffer[], playing: boolean }
const users = new Map()

// Per-user volume multiplier (0..200, default 100). Persisted in config, survives restarts.
const userVolumes = new Map()

export function setUserVolume(userId, vol) {
  userVolumes.set(userId, Math.max(0, Math.min(200, Math.round(vol))))
}

export function getUserVolume(userId) {
  return userVolumes.has(userId) ? userVolumes.get(userId) : 100
}

// Deafen: stop hearing other people. Incoming voice is dropped before it's even
// decoded (queueFrame), and any already-buffered voice is cleared so it goes quiet
// immediately. System sounds (the deafen chime itself) still play — they live in
// the reserved SYSTEM_USER slot, which this never touches.
let deafened = false
export function setDeafened(on) {
  deafened = !!on
  if (deafened) {
    for (const [id, u] of users) if (id !== SYSTEM_USER) u.frames.length = 0
  }
}
export function isDeafened() { return deafened }

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
  timer = setInterval(tick, TICK_MS)
}

export function stopMixer() {
  clearInterval(timer)
  timer = null
  users.clear()
  startTime = null
  framesWritten = 0
}

// Like stopMixer, but keeps the timer ticking so the output device stays fed
// with silence. Used when leaving a room on a backend whose output stream must
// not starve — naudiodon/WASAPI can wedge an output that goes too long without
// writes, which is why playback "disappears after a while" once it's no longer
// being torn down on leave. Buffered voice is dropped; the device stays alive.
export function pauseMixer() {
  users.clear()
  if (!timer) {
    startTime = Date.now()
    framesWritten = 0
    timer = setInterval(tick, TICK_MS)
  }
}

// ─── System sounds ───────────────────────────────────────────────────────────

const SYSTEM_USER = 0          // virtual user ID; real IDs are ≥ 1
const SOUND_GRACE_MS = 60      // extra ms to wait before stopping mixer after sound

// Ensure the mixer timer is ticking without touching existing user buffers.
function ensureMixerRunning() {
  if (timer) return
  startTime = Date.now()
  framesWritten = 0
  timer = setInterval(tick, TICK_MS)
}

// Play a raw PCM buffer as a notification sound, mixing it on top of any
// ongoing voice chat.  When the mixer is not already running (user hasn't
// joined a room yet) the mixer is started just for the sound and torn down
// shortly after it finishes.
//
// NOTE: this is a fire-and-forget API — the PCM buffer is sliced into 20 ms
// frames and fed into the mixer under a reserved SYSTEM_USER slot.  The mixer
// auto-drains stale system frames on the next tick.
export function playSystemSound(pcmBuf) {
  if (!outputStream || !pcmBuf || pcmBuf.length === 0) return

  const wasRunning = !!timer
  ensureMixerRunning()

  let u = users.get(SYSTEM_USER)
  if (!u) {
    u = { frames: [], playing: true, timer: null }   // no jitter pre-roll for system sounds
    users.set(SYSTEM_USER, u)
  } else {
    u.playing = true                    // re-arm in case previous sound drained
  }

  // Interrupt any sound still playing: drop the buffered-but-unplayed frames of
  // the previous notification so the new one starts immediately instead of
  // queueing behind it.  Also cancel that previous teardown timer; the fresh
  // one we schedule below is the only one allowed to stop the mixer.
  u.frames.length = 0
  if (u.timer) { clearTimeout(u.timer); u.timer = null }

  const frameCount = Math.floor(pcmBuf.length / FRAME_BYTES)
  for (let i = 0; i < frameCount; i++) {
    u.frames.push(pcmBuf.slice(i * FRAME_BYTES, (i + 1) * FRAME_BYTES))
  }
  // No MAX_BUFFER cap here — system sounds are a known finite buffer and the
  // mixer drains them in real-time.  Capping would silently truncate longer
  // sounds (e.g. the 2 s update chime).

  // When we spun up the mixer just for this sound, tear it down afterwards.
  // Real voice frames from other users (nonzero userId) keep it alive.  The
  // timer is tracked on the SYSTEM_USER slot so the next call clears it.
  if (!wasRunning) {
    const durationMs = frameCount * FRAME_MS + SOUND_GRACE_MS
    u.timer = setTimeout(() => {
      if (u.timer) { u.timer = null }
      const sys = users.get(SYSTEM_USER)
      const hasVoice = [...users.keys()].some(
        id => id !== SYSTEM_USER && (users.get(id)?.frames?.length ?? 0) > 0
      )
      // Don't stop if a newer sound replaced this slot (sys !== u) or is still draining.
      if (sys === u && !hasVoice) stopMixer()
    }, durationMs)
  }
}

export function queueFrame(userId, opusData) {
  if (!decoder || deafened) return         // deafened → don't even decode incoming voice
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
  if (n > 10) { framesWritten = due - 1; n = 1 }   // stalled >~100ms — resync instead of fast-forwarding
  for (let i = 0; i < n; i++) { writeFrame(); framesWritten++ }
}

function writeFrame() {
  const active = []
  for (const [userId, u] of users) {
    if (!u.playing) {
      if (u.frames.length >= JITTER_TARGET) u.playing = true   // pre-roll reached
      else continue                                            // still buffering → silent
    }
    if (u.frames.length > 0) {
      let frame = u.frames.shift()
      const vol = userVolumes.get(userId)
      if (vol !== undefined && vol !== 100) frame = applyVolume(frame, vol)
      active.push(frame)
    }
    else u.playing = false                                     // underran → rebuffer before resuming
  }

  const out = active.length === 0 ? SILENCE
            : active.length === 1 ? active[0]
            : mix(active)
  outputStream.write(out)
}

function applyVolume(frame, vol) {
  const factor = vol / 100
  const result = Buffer.alloc(FRAME_BYTES)
  for (let i = 0; i < FRAME_BYTES; i += 2) {
    const s = Math.round(frame.readInt16LE(i) * factor)
    result.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i)
  }
  return result
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
