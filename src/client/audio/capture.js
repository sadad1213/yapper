import { EventEmitter } from 'events'
import { isSilent, level } from './vad.js'

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
  }

  start() {
    if (this.active) return                    // already capturing — no duplicate listeners or processes
    this.active = true
    this._hangover = 0
    this._preRoll.length = 0
    this.stream.on('data', this._bound)
    if (this.stream.start) this.stream.start()
  }

  stop() {
    this.active = false
    this.stream.removeListener('data', this._bound)
    this._buf = Buffer.alloc(0)
    this._hangover = 0
    this._preRoll.length = 0
    if (this.stream.quit) this.stream.quit()
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
      const frame = this._buf.slice(0, FRAME_BYTES)
      this._buf = this._buf.slice(FRAME_BYTES)
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
