import { EventEmitter } from 'events'
import { isSilent } from './vad.js'

export const SAMPLE_RATE = 48000
export const CHANNELS = 1
export const FRAME_SIZE = 960             // 20ms at 48kHz
export const FRAME_BYTES = FRAME_SIZE * 2 // 16-bit samples

export class Capture extends EventEmitter {
  constructor(encoder, audioStream) {
    super()
    this.encoder = encoder
    this.stream = audioStream
    this._buf = Buffer.alloc(0)
    this._bound = this._onData.bind(this)
    this.active = false
  }

  start() {
    this.active = true
    this.stream.on('data', this._bound)
    if (this.stream.start) this.stream.start()
  }

  stop() {
    this.active = false
    this.stream.removeListener('data', this._bound)
    this._buf = Buffer.alloc(0)
    if (this.stream.quit) this.stream.quit()
  }

  _onData(chunk) {
    if (!this.active) return
    this._buf = Buffer.concat([this._buf, chunk])
    while (this._buf.length >= FRAME_BYTES) {
      const frame = this._buf.slice(0, FRAME_BYTES)
      this._buf = this._buf.slice(FRAME_BYTES)
      if (!isSilent(frame)) {
        try {
          const encoded = this.encoder.encode(frame, FRAME_SIZE)
          this.emit('frame', Buffer.from(encoded.buffer))
        } catch {}
      }
    }
  }
}
