import { BUILD_HASH } from './version.js'
import Conf from 'conf'

const config = new Conf({ projectName: 'yapper' })
const REPO = 'sadad1213/yapper'
const API = `https://api.github.com/repos/${REPO}/commits/main`

// Check once per session — cached in config to avoid hitting rate limits
let _checked = false

export async function checkForUpdate() {
  if (_checked) return getPendingUpdate()
  _checked = true

  try {
    const res = await fetch(API, {
      headers: { 'User-Agent': 'yapper', 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const { sha } = await res.json()
    const lastSeen = config.get('lastSeenHash', BUILD_HASH)
    if (sha && sha !== lastSeen) {
      config.set('updateAvailable', sha)
      return sha
    }
    config.delete('updateAvailable')
    return null
  } catch {
    return config.get('updateAvailable', null)   // keep stale notification rather than losing it
  }
}

export function getPendingUpdate() {
  return config.get('updateAvailable', null)
}

export function clearPendingUpdate() {
  const sha = config.get('updateAvailable')
  if (sha) config.set('lastSeenHash', sha)
  config.delete('updateAvailable')
}
