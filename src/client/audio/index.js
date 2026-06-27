import { execSync } from 'child_process'
import { SAMPLE_RATE, CHANNELS } from './capture.js'
import { Capture } from './capture.js'
import { initPlayback, startMixer, stopMixer, queueFrame } from './playback.js'

let captureInstance = null

async function loadOpus() {
  const { default: OpusScript } = await import('opusscript')
  const encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP)
  const decoder = new OpusScript(SAMPLE_RATE, CHANNELS)
  return { encoder, decoder }
}

async function tryNaudiodon() {
  const { default: AudioIO } = await import('naudiodon')
  const opts = {
    channelCount: CHANNELS,
    sampleFormat: AudioIO.SampleFormat16Bit,
    sampleRate: SAMPLE_RATE,
    deviceId: -1,
    closeOnError: false,
  }
  return {
    inStream:  new AudioIO({ inOptions: opts }),
    outStream: new AudioIO({ outOptions: opts }),
  }
}

function hasSox() {
  const cmd = process.platform === 'win32' ? 'where sox' : 'which sox'
  try { execSync(cmd, { stdio: 'ignore' }); return true } catch { return false }
}

async function trySox() {
  const { SoxCapture, SoxPlayback } = await import('./sox.js')
  return { inStream: new SoxCapture(), outStream: new SoxPlayback() }
}

export async function initAudio() {
  const { encoder, decoder } = await loadOpus()

  let inStream, outStream

  // Try naudiodon first (best quality, native PortAudio)
  try {
    const nd = await tryNaudiodon()
    inStream  = nd.inStream
    outStream = nd.outStream
  } catch {
    // Fall back to SoX
    if (!hasSox()) {
      return {
        available: false,
        reason:
          'Audio requires naudiodon or SoX.\n' +
          'Option 1 — Install SoX (easier): https://sourceforge.net/projects/sox/files/sox/\n' +
          'Option 2 — Build naudiodon: needs Visual Studio Build Tools + Python,\n' +
          '           then: npm install naudiodon --build-from-source',
      }
    }
    const sox = await trySox()
    inStream  = sox.inStream
    outStream = sox.outStream
  }

  initPlayback(decoder, outStream)
  captureInstance = new Capture(encoder, inStream)
  return { available: true, queueFrame }
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
