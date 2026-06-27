import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { SAMPLE_RATE, CHANNELS } from './capture.js'

// On Windows, SoX uses "-t waveaudio"; on Linux/Mac, "-d" works
const isWin = process.platform === 'win32'
const inputDevice  = isWin ? ['-t', 'waveaudio', '0'] : ['-d']
const outputDevice = isWin ? ['-t', 'waveaudio', '0'] : ['-d']

const rawArgs = ['-t', 'raw', '-r', String(SAMPLE_RATE), '-e', 'signed-integer', '-b', '16', '-c', String(CHANNELS)]

export class SoxCapture extends EventEmitter {
  constructor() {
    super()
    this._proc = null
  }

  start() {
    // sox [input device args] [format args] - (stdout)
    this._proc = spawn('sox', [...inputDevice, ...rawArgs, '-'], { stdio: ['ignore', 'pipe', 'ignore'] })
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
