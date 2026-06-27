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
  try { execSync('where sox', { stdio: 'ignore' }); return true } catch { return false }
}

export async function initAudio() {
  const { encoder, decoder } = await loadOpus()

  try {
    const { inStream, outStream } = await tryNaudiodon()
    initPlayback(decoder, outStream)
    captureInstance = new Capture(encoder, inStream)
    return { available: true, queueFrame }
  } catch {
    if (!hasSox()) {
      return {
        available: false,
        reason:
          'Audio requires naudiodon (Visual Studio Build Tools) or SoX.\n' +
          'Install SoX: https://sourceforge.net/projects/sox/\n' +
          'Or: npm install naudiodon --build-from-source',
      }
    }
    return { available: false, reason: 'SoX audio backend not yet implemented' }
  }
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
