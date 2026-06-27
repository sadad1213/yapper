import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { SAMPLE_RATE, CHANNELS } from './capture.js'

// On Windows, SoX uses "-t waveaudio <device>"; on Linux/Mac, "-d" (default) works
const isWin = process.platform === 'win32'
const outputDevice = isWin ? ['-t', 'waveaudio', '0'] : ['-d']

const rawArgs = ['-t', 'raw', '-r', String(SAMPLE_RATE), '-e', 'signed-integer', '-b', '16', '-c', String(CHANNELS)]

// On Windows, waveaudio input devices are addressed by index (0, 1, 2, …).
function inputArgs(deviceId) {
  if (!isWin) return ['-d']
  const idx = (deviceId == null || deviceId < 0) ? 0 : deviceId
  return ['-t', 'waveaudio', String(idx)]
}

export class SoxCapture extends EventEmitter {
  constructor(deviceId = 0) {
    super()
    this.deviceId = deviceId
    this._proc = null
  }

  start() {
    // sox [input device args] [format args] - (stdout)
    this._proc = spawn('sox', [...inputArgs(this.deviceId), ...rawArgs, '-'], { stdio: ['ignore', 'pipe', 'ignore'] })
    this._proc.stdout.on('data', chunk => this.emit('data', chunk))
    this._proc.on('error', err => this.emit('error', err))
  }

  quit() {
    if (this._proc) { this._proc.kill('SIGTERM'); this._proc = null }
  }
}

export class SoxPlayback {
  constructor() {
    this._proc = null
    this._stdin = null
  }

  start() {
    // sox [format args] - (stdin) [output device args]
    this._proc = spawn('sox', [...rawArgs, '-', ...outputDevice], { stdio: ['pipe', 'ignore', 'ignore'] })
    this._stdin = this._proc.stdin
    this._proc.on('error', () => {})
  }

  write(buf) {
    if (this._stdin && !this._stdin.destroyed) this._stdin.write(buf)
  }

  quit() {
    if (this._proc) { this._proc.kill('SIGTERM'); this._proc = null; this._stdin = null }
  }
}
