// Decodes bundled audio files into raw 48 kHz mono 16-bit PCM.
//
// Primary path: SoX (handles all formats — WAV, OGG, etc.)
// Pure-JS fallback for .wav files: parses the RIFF header, converts stereo→mono
//   and 44.1→48 kHz via linear interpolation.  OGG files have no pure-JS path.
//
// No synthesised sounds — the audio/ files are the single source of truth.

import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { SAMPLE_RATE, FRAME_BYTES } from './capture.js'

// Resolve the repo root:  src/client/audio/loader.js → repo root
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..', '..')

const FILES = {
  join:   { path: join(ROOT, 'audio', 'snd_splash.wav'),   ext: '.wav' },
  leave:  { path: join(ROOT, 'audio', 'mus_doorclose.ogg'), ext: '.ogg' },
  update: { path: join(ROOT, 'audio', 'mus_piano7.wav'),   ext: '.wav' },
}

// Cached PCM buffers — decoded once, reused forever.
const cache = { join: null, leave: null, update: null }

// Map of pending decode promises so concurrent callers share one operation.
const pending = { join: null, leave: null, update: null }

// ─── SoX availability ───────────────────────────────────────────────────────

let _soxAvail = null
function hasSox() {
  if (_soxAvail !== null) return _soxAvail
  const cmd = process.platform === 'win32' ? 'where sox' : 'which sox'
  try {
    require('child_process').execSync(cmd, { stdio: 'ignore' })
    _soxAvail = true
  } catch {
    _soxAvail = false
  }
  return _soxAvail
}

// ─── SoX decode (all formats) ───────────────────────────────────────────────

function decodeWithSox(filePath) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const proc = spawn('sox', [
      filePath,
      '-t', 'raw',
      '-r', String(SAMPLE_RATE),
      '-e', 'signed-integer',
      '-b', '16',
      '-c', '1',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    proc.stdout.on('data', c => chunks.push(c))
    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`sox exit ${code}`))
    })
  })
}

// ─── Pure-JS WAV decoder (stereo 44.1 kHz → mono 48 kHz) ───────────────────

function wavToPCM(buf) {
  if (buf.length < 44) return null

  // Parse RIFF/WAV header
  const riff   = buf.toString('ascii', 0, 4)
  const wave   = buf.toString('ascii', 8, 12)
  const fmt    = buf.toString('ascii', 12, 16)
  if (riff !== 'RIFF' || wave !== 'WAVE' || fmt !== 'fmt ') return null

  const audioFormat = buf.readUInt16LE(20)
  if (audioFormat !== 1) return null  // PCM only

  const channels = buf.readUInt16LE(22)
  const srcRate  = buf.readUInt32LE(24)
  const bits     = buf.readUInt16LE(34)
  if (bits !== 16) return null        // 16-bit only

  // Find "data" chunk (may be after extra chunks like "fact")
  let dataOffset = 36
  while (dataOffset + 8 <= buf.length) {
    const tag = buf.toString('ascii', dataOffset, dataOffset + 4)
    const size = buf.readUInt32LE(dataOffset + 4)
    if (tag === 'data') {
      dataOffset += 8
      break
    }
    dataOffset += 8 + size
  }
  if (dataOffset >= buf.length) return null

  const dataEnd = Math.min(dataOffset + buf.readUInt32LE(dataOffset - 4), buf.length)
  const dataLen = dataEnd - dataOffset
  if (dataLen < 2) return null

  // Read 16-bit samples as Int16LE
  const samples = []
  for (let i = dataOffset; i < dataEnd; i += 2) {
    samples.push(buf.readInt16LE(i))
  }

  const srcFrames = Math.floor(samples.length / channels)
  const dstFrames = Math.floor(srcFrames * SAMPLE_RATE / srcRate)

  const out = Buffer.alloc(dstFrames * 2)

  for (let d = 0; d < dstFrames; d++) {
    // Source position (fractional) + linear interpolation between neighbour frames
    const srcPos = d * srcRate / SAMPLE_RATE
    const f0 = Math.floor(srcPos)
    const f1 = Math.min(f0 + 1, srcFrames - 1)
    const frac = srcPos - f0

    // Mix stereo→mono (average), interpolate between frames
    const mix0 = channels === 1
      ? samples[f0]
      : Math.round((samples[f0 * channels] + samples[f0 * channels + 1]) / 2)
    const mix1 = channels === 1
      ? samples[f1]
      : Math.round((samples[f1 * channels] + samples[f1 * channels + 1]) / 2)

    const val = Math.round(mix0 + (mix1 - mix0) * frac)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, val)), d * 2)
  }

  return out
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function decodeFile(info) {
  // 1. SoX path — handles everything, best quality
  if (hasSox()) {
    const pcm = await decodeWithSox(info.path)
    return pcm
  }

  // 2. Pure-JS path for WAV files
  if (info.ext === '.wav') {
    try {
      const raw = readFileSync(info.path)
      const pcm = wavToPCM(raw)
      if (pcm && pcm.length > 0) return pcm
    } catch { /* file missing or corrupt — fall through */ }
  }

  // 3. No decoder available (OGG without SoX) — return empty buffer
  return Buffer.alloc(0)
}

/** Load (and cache) one of the bundled notification sounds.  Returns an empty
 *  buffer when decoding is impossible (OGG without SoX, missing file, etc.).
 *  @param {'join'|'leave'|'update'} which
 *  @returns {Promise<Buffer>} raw mono 48kHz 16-bit PCM */
export async function loadSound(which) {
  if (cache[which]) return cache[which]
  if (pending[which]) return pending[which]

  pending[which] = (async () => {
    cache[which] = await decodeFile(FILES[which])
    return cache[which]
  })()

  return pending[which]
}

/** Pre-load all three notification sounds in the background so the first
 *  join/leave/update event doesn't stall with a cold SoX spawn. */
export function preloadAll() {
  for (const k of Object.keys(FILES)) loadSound(k)
}
