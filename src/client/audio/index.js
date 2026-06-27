import { execSync } from 'child_process'
import { EventEmitter } from 'events'
import { SAMPLE_RATE, CHANNELS } from './capture.js'
import { Capture } from './capture.js'
import { initPlayback, startMixer, stopMixer, queueFrame } from './playback.js'

// Emits 'level' (0..1) on every captured frame — used by the UI VU meter.
export const audioEvents = new EventEmitter()

let backend = null          // 'naudiodon' | 'sox' | null
let naudio = null           // naudiodon module namespace (if loaded)
let encoder = null, decoder = null
let captureInstance = null
let outStream = null
let selectedInputId = -1

async function loadOpus() {
  const { default: OpusScript } = await import('opusscript')
  encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP)
  decoder = new OpusScript(SAMPLE_RATE, CHANNELS)
}

// ─── naudiodon helpers (robust to API shape differences) ───────────────────────
function ndAudioIO() { return naudio.AudioIO || naudio.default || naudio }
function ndFormat()  { const A = ndAudioIO(); return naudio.SampleFormat16Bit ?? A.SampleFormat16Bit ?? 8 }

function buildNdInput(deviceId) {
  const A = ndAudioIO()
  return new A({ inOptions: { channelCount: CHANNELS, sampleFormat: ndFormat(), sampleRate: SAMPLE_RATE, deviceId: deviceId ?? -1, closeOnError: false } })
}
function buildNdOutput() {
  const A = ndAudioIO()
  return new A({ outOptions: { channelCount: CHANNELS, sampleFormat: ndFormat(), sampleRate: SAMPLE_RATE, deviceId: -1, closeOnError: false } })
}

function hasSox() {
  const cmd = process.platform === 'win32' ? 'where sox' : 'which sox'
  try { execSync(cmd, { stdio: 'ignore' }); return true } catch { return false }
}

function attachCapture(inStream) {
  captureInstance = new Capture(encoder, inStream)
  captureInstance.on('level', l => audioEvents.emit('level', l))
}

// ─── Public API ────────────────────────────────────────────────────────────────
export async function initAudio() {
  await loadOpus()

  // Prefer naudiodon (native, supports device selection)
  try {
    naudio = await import('naudiodon')
    backend = 'naudiodon'
    outStream = buildNdOutput()
    initPlayback(decoder, outStream)
    attachCapture(buildNdInput(selectedInputId))
    return { available: true, queueFrame, backend }
  } catch {}

  // Fall back to SoX
  if (hasSox()) {
    backend = 'sox'
    const { SoxCapture, SoxPlayback } = await import('./sox.js')
    outStream = new SoxPlayback()
    initPlayback(decoder, outStream)
    attachCapture(new SoxCapture())
    return { available: true, queueFrame, backend }
  }

  backend = null
  return {
    available: false,
    reason:
      'Audio requires naudiodon or SoX.\n' +
      'Run "yapper setup" to install one automatically.',
  }
}

export function getInputDevices() {
  if (backend === 'naudiodon') {
    try {
      const list = naudio.getDevices ? naudio.getDevices() : ndAudioIO().getDevices()
      const inputs = list.filter(d => d.maxInputChannels > 0).map(d => ({ id: d.id, name: d.name }))
      return inputs.length ? inputs : [{ id: -1, name: 'Default' }]
    } catch { return [{ id: -1, name: 'Default' }] }
  }
  if (backend === 'sox') return [{ id: -1, name: 'System default (SoX)' }]
  return [{ id: -1, name: 'No audio backend' }]
}

export function setInputDevice(id) {
  selectedInputId = id
  if (backend !== 'naudiodon') return   // SoX uses the system default device
  const wasActive = captureInstance?.active
  try { captureInstance?.stop() } catch {}
  attachCapture(buildNdInput(id))
  if (wasActive) captureInstance.start()
}

export function startCapture(sendFn) {
  if (!captureInstance) return
  captureInstance.removeAllListeners('frame')
  captureInstance.on('frame', sendFn)
  captureInstance.start()
  startMixer()
}

export function stopCapture() {
  if (!captureInstance) return
  captureInstance.stop()
  stopMixer()
}

// Loopback mic test: route our own encoded frames back through the decoder/mixer
// so the user hears themselves. Returns a stop() function.
export function startMicTest(onLevel) {
  if (!captureInstance) return () => {}
  const wasActive = captureInstance.active
  const frameH = (frame) => queueFrame(0, frame)
  const levelH = (l) => { try { onLevel(l) } catch {} }

  captureInstance.on('frame', frameH)
  audioEvents.on('level', levelH)
  if (!wasActive) captureInstance.start()
  startMixer()

  return () => {
    captureInstance.off('frame', frameH)
    audioEvents.off('level', levelH)
    if (!wasActive) { captureInstance.stop(); stopMixer() }
  }
}
