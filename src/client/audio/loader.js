// Decodes bundled audio files into raw 48kHz mono 16-bit PCM using SoX.
// Falls back to the inline synthesised sounds when SoX is unavailable or the
// files are missing.

import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { SAMPLE_RATE, FRAME_BYTES } from './capture.js'
import { joinPCM as synthJoin, leavePCM as synthLeave, updatePCM as synthUpdate } from './sounds.js'

// Resolve the repo root:  src/client/audio/loader.js → repo root
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..', '..')

const FILES = {
  join:   join(ROOT, 'audio', 'snd_splash.wav'),
  leave:  join(ROOT, 'audio', 'mus_doorclose.ogg'),
  update: join(ROOT, 'audio', 'mus_piano7.wav'),
}

const FALLBACK = {
  join:   synthJoin,
  leave:  synthLeave,
  update: synthUpdate,
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

// ─── Decode via SoX ──────────────────────────────────────────────────────────

/** Convert any audio file to raw 48kHz mono 16-bit PCM via SoX. */
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

// ─── Public API ──────────────────────────────────────────────────────────────

/** Load (and cache) one of the bundled notification sounds.
 *  @param {'join'|'leave'|'update'} which
 *  @returns {Promise<Buffer>} raw mono 48kHz 16-bit PCM */
export async function loadSound(which) {
  if (cache[which]) return cache[which]
  if (pending[which]) return pending[which]

  pending[which] = (async () => {
    // 1. Try SoX on the bundled file
    if (hasSox()) {
      const path = FILES[which]
      try {
        readFileSync(path)          // throw synchronously if file is missing
        const pcm = await decodeWithSox(path)
        cache[which] = pcm
        return pcm
      } catch {
        // file missing or sox failed → fall through to synthesis
      }
    }
    // 2. Fall back to inline synthesised sound
    cache[which] = FALLBACK[which]()
    return cache[which]
  })()

  return pending[which]
}

/** Pre-load all three notification sounds in the background so the first
 *  join/leave/update event doesn't stall with a cold SoX spawn. */
export function preloadAll() {
  for (const k of Object.keys(FILES)) loadSound(k)
}
