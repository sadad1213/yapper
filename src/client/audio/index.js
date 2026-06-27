import { execSync } from 'child_process'
import { EventEmitter } from 'events'
import { SAMPLE_RATE, CHANNELS } from './capture.js'
import { Capture } from './capture.js'
import { initPlayback, startMixer, stopMixer, queueFrame } from './playback.js'

// Emits 'level' (0..1) on every captured frame — used by the UI VU meter.
export const audioEvents = new EventEmitter()

let backend = null          // 'naudiodon' | 'sox' | null
let naudio = null           // naudiodon module namespace (if loaded)
let soxMod = null           // ./sox.js module (if loaded)
let encoder = null, decoder = null
let captureInstance = null
let outStream = null
let selectedInputId = -1

async function loadOpus() {
  const { default: OpusScript } = await import('opusscript')
  encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP)
  decoder = new OpusScript(SAMPLE_RATE, CHANNELS)
  // We're on a LAN/VPN — bandwidth is cheap, so favour quality over compression.
  // Opus' VOIP default lands around ~24-32 kbps; a clean mono voice stream at
  // 64 kbps is effectively transparent and still only ~8 KB/s.
  try {
    encoder.setBitrate(64000)        // OPUS_SET_BITRATE
    encoder.encoderCTL(4010, 10)     // OPUS_SET_COMPLEXITY = 10 (max quality)
    encoder.encoderCTL(4024, 3001)   // OPUS_SET_SIGNAL = OPUS_SIGNAL_VOICE
  } catch {}
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

// Build an input stream for the current backend at the given device id.
function makeInput(deviceId) {
  if (backend === 'naudiodon') return buildNdInput(deviceId)
  if (backend === 'sox')       return new soxMod.SoxCapture(deviceId < 0 ? 0 : deviceId)
  return null
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
    soxMod = await import('./sox.js')
    outStream = new soxMod.SoxPlayback()
    initPlayback(decoder, outStream)
    attachCapture(new soxMod.SoxCapture(selectedInputId < 0 ? 0 : selectedInputId))
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
  if (backend === 'sox') {
    // SoX can't name devices, but waveaudio addresses them by index.
    return [
      { id: 0, name: 'Default mic (device 0)' },
      { id: 1, name: 'Device 1' },
      { id: 2, name: 'Device 2' },
      { id: 3, name: 'Device 3' },
    ]
  }
  return [{ id: -1, name: 'No audio backend' }]
}

export function setInputDevice(id) {
  selectedInputId = id
  if (backend !== 'naudiodon' && backend !== 'sox') return
  const wasActive = captureInstance?.active
  try { captureInstance?.stop() } catch {}
  attachCapture(makeInput(id))
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
