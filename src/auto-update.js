import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Conf from 'conf'

const config = new Conf({ projectName: 'yapper' })
const RAW_URL = 'https://raw.githubusercontent.com/sadad1213/yapper/main/package.json'

let _checked = false
let _currentVersion = null

function getCurrentVersion() {
  if (_currentVersion) return _currentVersion
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    _currentVersion = parseVersion(pkg.version)
    return _currentVersion
  } catch {
    return null
  }
}

function parseVersion(v) {
  const parts = String(v).split('.').map(Number)
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0, raw: String(v).trim() }
}

// Returns 1 if a > b, -1 if a < b, 0 if equal
function compare(a, b) {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  return 0
}

export async function checkForUpdate() {
  if (_checked) return getPendingUpdate()
  _checked = true

  const current = getCurrentVersion()
  if (!current) return null

  try {
    const res = await fetch(RAW_URL, {
      headers: { 'User-Agent': 'yapper' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const remotePkg = await res.json()
    const remote = parseVersion(remotePkg.version)
    if (compare(remote, current) > 0) {
      config.set('updateAvailable', remote.raw)
      return remote.raw
    }
    config.delete('updateAvailable')
    return null
  } catch {
    return config.get('updateAvailable', null)
  }
}

export function getPendingUpdate() {
  return config.get('updateAvailable', null)
}

export function clearPendingUpdate() {
  config.delete('updateAvailable')
}
