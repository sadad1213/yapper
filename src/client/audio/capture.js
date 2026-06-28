import { EventEmitter } from 'events'
import { isSilent, level } from './vad.js'
import { denoiseFrame } from './denoise.js'

export const SAMPLE_RATE = 48000
export const CHANNELS = 1
export const FRAME_SIZE = 960             // 20ms at 48kHz
export const FRAME_BYTES = FRAME_SIZE * 2 // 16-bit samples

// VAD smoothing. A bare "send only when above threshold" gate clips the soft
// onset of words and tears the stream apart between syllables, which the
// receiver hears as a laggy start followed by stutter (Opus is a stateful codec
// — gaps wreck its inter-frame prediction). We fix that with:
//   • PRE-ROLL  — keep the last few sub-threshold frames so the quiet start of a
//                 word is transmitted, not chopped off.
//   • HANGOVER  — once speech is detected, keep sending for a short tail so brief
//                 inter-word dips don't break the stream mid-utterance.
const HANGOVER_FRAMES = 15   // ~300ms of "keep sending" after level drops
const PREROLL_FRAMES  = 3    // ~60ms captured before the detected onset

export class Capture extends EventEmitter {
  constructor(encoder, audioStream) {
    super()
    this.encoder = encoder
    this.stream = audioStream
    this._buf = Buffer.alloc(0)
    this._bound = this._onData.bind(this)
    this.active = false
    this._hangover = 0      // frames left to keep transmitting after silence
    this._preRoll = []      // recent silent frames, flushed on the next onset
    // When set, stop() keeps the device open (see stop()) instead of releasing
    // it — required for naudiodon, whose quit() can't be undone.
    this.keepAlive = false
    this._streamStarted = false
  }

  start() {
    if (this.active) return                    // already capturing — no duplicate listeners or processes
    this.active = true
    this._hangover = 0
    this._preRoll.length = 0
    // Attach the processor only if it isn't already. A keep-alive stop leaves it
    // attached and the device running, so the live naudiodon stream never
    // changes its flowing state — toggling 'data' listeners on it can wedge
    // delivery so the mic silently stops after the first room leave.
    if (!this.stream.listeners('data').includes(this._bound)) {
      this.stream.on('data', this._bound)
    }
    // Only (re)start the device when it isn't already running. A kept-alive
    // naudiodon stream is single-shot — start() twice would throw. SoX is
    // released on stop, so _streamStarted is false there and it respawns.
    if (!this._streamStarted) {
      if (this.stream.start) this.stream.start()
      this._streamStarted = true
    }
  }

  // A normal stop releases the device (quit()). When `keepAlive` is set the
  // device is kept open and running instead — naudiodon's quit() also tears down
  // the shared PortAudio session (silencing playback) and can't be restarted, so
  // leaving a room must not quit it. The processor stays attached; _onData gates
  // on `active`, so captured audio is simply discarded until the next start().
  // `force: true` overrides keepAlive for a true release (device change / quit).
  stop({ force = false } = {}) {
    this.active = false
    this._buf = Buffer.alloc(0)
    this._hangover = 0
    this._preRoll.length = 0
    if (force || !this.keepAlive) {
      this.stream.removeListener('data', this._bound)
      if (this.stream.quit) this.stream.quit()
      this._streamStarted = false
    }
  }

  _send(frame) {
    try {
      // Buffer.from(encoded) copies exactly the packet bytes; encoded.buffer
      // would be opusscript's whole multi-KB internal buffer (corrupt frame).
      const encoded = this.encoder.encode(frame, FRAME_SIZE)
      this.emit('frame', Buffer.from(encoded))
    } catch {}
  }

  _onData(chunk) {
    if (!this.active) return
    this._buf = Buffer.concat([this._buf, chunk])
    while (this._buf.length >= FRAME_BYTES) {
      const raw = this._buf.slice(0, FRAME_BYTES)
      this._buf = this._buf.slice(FRAME_BYTES)
      // Noise-suppress first, so the VU meter, VAD gate and Opus all see the
      // cleaned signal (no-op pass-through when denoise is off/unavailable).
      const frame = denoiseFrame(raw)
      this.emit('level', level(frame))         // always, for the VU meter

      if (!isSilent(frame)) {
        // Onset: flush the pre-roll so the soft start of the word survives.
        if (this._hangover <= 0 && this._preRoll.length) {
          for (const f of this._preRoll) this._send(f)
          this._preRoll.length = 0
        }
        this._hangover = HANGOVER_FRAMES
        this._send(frame)
      } else if (this._hangover > 0) {
        // Tail / inter-word gap: keep the stream continuous.
        this._hangover--
        this._send(frame)
      } else {
        // True silence: remember recent frames for the next onset's pre-roll.
        this._preRoll.push(frame)
        if (this._preRoll.length > PREROLL_FRAMES) this._preRoll.shift()
      }
    }
  }
}
