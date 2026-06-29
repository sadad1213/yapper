// Shared persisted settings — one place for the `conf` keys the TUI sets inline
// and the GUI main process needs to read/write too, so the two never drift.
// Setters that affect the audio pipeline (VAD gate, denoise, per-user volume)
// apply the change immediately as well as persisting it.

import Conf from 'conf'
import { setThreshold } from '../audio/vad.js'
import { setDenoiseEnabled } from '../audio/denoise.js'
import { setUserVolume } from '../audio/playback.js'

const config = new Conf({ projectName: 'yapper' })

export const VAD_MIN = 50, VAD_MAX = 3000   // mic-sensitivity slider bounds (match the TUI)

const clampVad = (v) => Math.max(VAD_MIN, Math.min(VAD_MAX, Number(v) || 200))

export function getUsername() {
  return String(config.get('username') || ('user' + (Math.floor(Math.random() * 9000) + 1000)))
}
export function setUsername(name) {
  const u = String(name || '').trim().slice(0, 16) || getUsername()
  config.set('username', u)
  return u
}

export function getVadThreshold() { return clampVad(config.get('vadThreshold', 200)) }
export function setVadThreshold(v) {
  const t = clampVad(v)
  config.set('vadThreshold', t)
  setThreshold(t)
  return t
}

export function getDenoise() { return config.get('noiseSuppression', true) }
export function setDenoise(on) {
  config.set('noiseSuppression', !!on)
  setDenoiseEnabled(!!on)
  return !!on
}

export function getMuteHotkey() { return config.get('muteHotkey', 'off') }
export function setMuteHotkeyId(id) { config.set('muteHotkey', id) }

export function getUserVolumes() {
  const v = config.get('userVolumes', {})
  return v && typeof v === 'object' ? v : {}
}
export function setUserVolumePersisted(userId, vol) {
  const v = Math.max(0, Math.min(200, Number(vol) || 0))
  setUserVolume(userId, v)
  const map = getUserVolumes()
  map[String(userId)] = v
  config.set('userVolumes', map)
  return v
}

// Apply every audio-affecting setting on startup (called once by an orchestrator).
export function applyAudioSettings() {
  setThreshold(getVadThreshold())
  setDenoiseEnabled(getDenoise())
  for (const [id, vol] of Object.entries(getUserVolumes())) {
    if (typeof vol === 'number') setUserVolume(Number(id), vol)
  }
}

// A serialisable bundle for the renderer's settings panel.
export function snapshotSettings() {
  return {
    username: getUsername(),
    vadThreshold: getVadThreshold(),
    vadMin: VAD_MIN,
    vadMax: VAD_MAX,
    denoise: getDenoise(),
    muteHotkey: getMuteHotkey(),
    userVolumes: getUserVolumes(),
  }
}
