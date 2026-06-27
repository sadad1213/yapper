import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Conf from 'conf'

const config = new Conf({ projectName: 'yapper' })
const API_URL = 'https://api.github.com/repos/sadad1213/yapper/contents/package.json?ref=main'
const CHANGELOG_URL = 'https://api.github.com/repos/sadad1213/yapper/contents/CHANGELOG.md?ref=main'

// GitHub auth — 5000 req/h with token vs 60 without.
// Priority: env GITHUB_TOKEN → conf githubToken → anonymous.
function authHeaders() {
  const token = process.env.GITHUB_TOKEN || config.get('githubToken')
  const h = { 'User-Agent': 'yapper', 'Accept': 'application/vnd.github.v3+json' }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

export function setGithubToken(token) {
  config.set('githubToken', token)
}

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
  return _doCheck()
}

export function getPendingUpdate() {
  return config.get('updateAvailable', null)
}

// Forget that we already checked, so the next checkForUpdate() actually hits the
// network again. Used by the manual "check for updates" button in settings.
export function resetUpdateCache() {
  _checked = false
}

// Runs a live network check and caches the result in conf.  When
// `throwOnError` is true, network / GitHub errors are thrown instead of
// swallowed — used by the manual check so the UI can show "failed".
async function _doCheck(throwOnError = false) {
  const current = getCurrentVersion()
  if (!current) return null
  try {
    const res = await fetch(API_URL, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      if (throwOnError) throw new Error(`GitHub returned ${res.status}`)
      return getPendingUpdate()
    }
    const data = await res.json()
    const remotePkg = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'))
    const remote = parseVersion(remotePkg.version)
    if (compare(remote, current) > 0) {
      config.set('updateAvailable', remote.raw)
      return remote.raw
    }
    config.delete('updateAvailable')
    return null
  } catch (e) {
    if (throwOnError) throw e
    return getPendingUpdate()
  }
}

/** Same as checkForUpdate() but throws on network/GitHub errors so the UI can
 *  show a distinct "failed" state.  Used by the manual check button. */
export async function checkForUpdateManual() {
  resetUpdateCache()
  _checked = true
  return _doCheck(true)
}

export function clearPendingUpdate() {
  config.delete('updateAvailable')
}

// Fetch the CHANGELOG.md section for the given version (e.g. '0.1.16' or 'v0.1.16').
// Each version lives under a `## <version>` heading; the content is everything
// until the next `## ` heading. RU block first, EN block second — in file order.
// Returns an array of raw lines, or null if unavailable / version not found.
export async function fetchChangelog(version) {
  const want = String(version || '').replace(/^v/, '').trim()
  if (!want) return null
  try {
    const res = await fetch(CHANGELOG_URL, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const md = Buffer.from(data.content, 'base64').toString('utf8')
    const lines = md.split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
      const m = /^##\s+([0-9][\w.\-]*)/.exec(lines[i])
      if (m && m[1].replace(/^v/, '') === want) { start = i + 1; break }
    }
    if (start < 0) return null
    const section = []
    for (let i = start; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) break
      section.push(lines[i])
    }
    while (section.length && !section[0].trim()) section.shift()
    while (section.length && !section[section.length - 1].trim()) section.pop()
    return section.length ? section : null
  } catch {
    return null
  }
}
