import { spawn, execSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { mkdirSync, createWriteStream, existsSync, readdirSync, unlinkSync } from 'fs'
import termkit from 'terminal-kit'

const term = termkit.terminal
const __dirname  = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT   = join(__dirname, '..')
const TOOLS_DIR  = join(homedir(), '.yapper', 'tools')

const SOX_VER    = '14.4.2'
const SOX_URL    = `https://downloads.sourceforge.net/project/sox/sox/${SOX_VER}/sox-${SOX_VER}-win32.zip`

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hasCmd(cmd) {
  try { execSync(`where "${cmd}"`, { stdio: 'ignore' }); return true } catch { return false }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function header() {
  term.clear()
  term.bold.cyan(' yapper — Audio Setup\n')
  term.dim(' ' + '─'.repeat(Math.max(40, (process.stdout.columns || 70) - 2)) + '\n\n')
}

function status(icon, label, detail = '') {
  const sym = { ok: '✓', err: '✗', warn: '!', info: '→' }[icon] ?? '·'
  const col = { ok: term.bold.green, err: term.bold.red, warn: term.bold.yellow, info: term.bold.cyan }[icon] ?? term
  col(` ${sym}  `)
  term(label)
  if (detail) term.dim(`  ${detail}`)
  term('\n')
}

async function waitKey(msg = ' Press any key to continue...') {
  term.dim(msg)
  term.grabInput()
  await new Promise(resolve => term.once('key', resolve))
  term.grabInput(false)
  term('\n')
}

// ─── Progress bar for child-process installs ──────────────────────────────────

function runWithProgress(cmd, args, { title, milestones = [], shell = false, cwd } = {}) {
  return new Promise((resolve) => {
    term('\n')
    const barW = Math.min((process.stdout.columns || 72) - 8, 56)
    const bar  = term.progressBar({ width: barW, title, percent: true, eta: false,
                                    titleStyle: term.bold, barStyle: term.cyan, barBracketStyle: term.dim })

    let cur = 0, target = milestones[0]?.pct ?? 5, done = false
    const tick = setInterval(() => {
      if (!done && cur < target) { cur = Math.min(cur + 1, target); bar.update({ progress: cur / 100 }) }
    }, 80)

    const proc = spawn(cmd, args, { cwd: cwd ?? PKG_ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell })
    const lines = []

    const onData = (d) => {
      for (const line of d.toString().split('\n')) {
        const l = line.trim()
        if (!l) continue
        lines.push(l)
        for (const { pct, kw } of milestones) {
          if (kw && l.toLowerCase().includes(kw) && pct > target) { target = pct }
        }
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)

    proc.on('close', async (code) => {
      done = true; clearInterval(tick)
      bar.update({ progress: code === 0 ? 1 : cur / 100 })
      await sleep(150); bar.stop()
      resolve({ ok: code === 0, log: lines.join('\n') })
    })
    proc.on('error', async () => {
      done = true; clearInterval(tick); bar.stop()
      resolve({ ok: false, log: '' })
    })
  })
}

// ─── Progress bar for HTTP download ──────────────────────────────────────────

async function downloadWithProgress(url, destPath, title) {
  term('\n')
  const barW = Math.min((process.stdout.columns || 72) - 8, 56)
  const bar  = term.progressBar({ width: barW, title, percent: true, eta: true,
                                  titleStyle: term.bold, barStyle: term.green, barBracketStyle: term.dim })
  try {
    const res = await fetch(url, { headers: { 'User-Agent': `yapper/${SOX_VER}` } })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)

    const total   = parseInt(res.headers.get('content-length') || '0', 10)
    let received  = 0
    const stream  = createWriteStream(destPath)

    for await (const chunk of res.body) {
      received += chunk.length
      stream.write(chunk)
      bar.update({ progress: total ? received / total : undefined })
    }

    await new Promise((ok, fail) => { stream.end(); stream.on('finish', ok); stream.on('error', fail) })
    bar.update({ progress: 1 })
    await sleep(150); bar.stop()
    return true
  } catch (err) {
    bar.stop()
    status('err', `Download failed: ${err.message}`)
    return false
  }
}

// ─── SoX install methods ──────────────────────────────────────────────────────

async function installSoxWinget() {
  // Correct winget package ID (was incorrectly 'SoX.SoX')
  return runWithProgress('winget', [
    'install', '--id', 'ChrisBagwell.SoX', '--scope', 'user',
    '--accept-source-agreements', '--accept-package-agreements',
  ], {
    title: 'Installing SoX via winget',
    milestones: [
      { pct: 10, kw: 'found'        },
      { pct: 30, kw: 'download'     },
      { pct: 60, kw: 'verif'        },
      { pct: 80, kw: 'install'      },
      { pct: 92, kw: 'successfully' },
    ],
  })
}

async function installSoxScoop() {
  return runWithProgress('scoop', ['install', 'sox'], {
    title: 'Installing SoX via Scoop',
    milestones: [
      { pct: 10, kw: 'installing' },
      { pct: 40, kw: 'download'   },
      { pct: 80, kw: 'linking'    },
      { pct: 92, kw: 'installed'  },
    ],
  })
}

async function installSoxChoco() {
  return runWithProgress('choco', ['install', 'sox', '-y', '--no-progress'], {
    title: 'Installing SoX via Chocolatey',
    milestones: [
      { pct: 10, kw: 'chocolatey' },
      { pct: 35, kw: 'download'   },
      { pct: 70, kw: 'installing' },
      { pct: 92, kw: 'installed'  },
    ],
  })
}

async function downloadSoxPortable() {
  mkdirSync(TOOLS_DIR, { recursive: true })

  const zipPath  = join(TOOLS_DIR, 'sox.zip')
  const soxDir   = join(TOOLS_DIR, `sox-${SOX_VER}`)

  status('info', `Downloading SoX ${SOX_VER} portable...`)
  const ok = await downloadWithProgress(SOX_URL, zipPath, `Downloading sox-${SOX_VER}-win32.zip`)
  if (!ok) return { ok: false, reason: 'Download failed' }

  // Extract
  status('info', 'Extracting...')
  try {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${TOOLS_DIR}' -Force"`,
      { stdio: 'ignore' }
    )
    try { unlinkSync(zipPath) } catch {}
  } catch {
    return { ok: false, reason: 'Extraction failed (PowerShell Expand-Archive)' }
  }

  // Find sox.exe — it may be in sox-14.4.2/ or sox-14.4.2-win32/
  let foundDir = null
  if (existsSync(soxDir) && existsSync(join(soxDir, 'sox.exe'))) {
    foundDir = soxDir
  } else {
    for (const entry of readdirSync(TOOLS_DIR)) {
      const candidate = join(TOOLS_DIR, entry)
      if (existsSync(join(candidate, 'sox.exe'))) { foundDir = candidate; break }
    }
  }

  if (!foundDir) return { ok: false, reason: 'sox.exe not found after extraction' }

  // Add to current process PATH immediately
  process.env.PATH = `${foundDir};${process.env.PATH}`

  // Persist to user PATH for future sessions
  try {
    execSync(`setx PATH "${foundDir};%PATH%"`, { stdio: 'ignore' })
  } catch {}

  return { ok: true }
}

// ─── Check audio backends ─────────────────────────────────────────────────────

function hasSoxCmd() { return hasCmd('sox') }
async function hasNaudiodon() {
  try { await import('naudiodon'); return true } catch { return false }
}

// ─── Main setup flow ──────────────────────────────────────────────────────────

export async function runSetup({ force = false } = {}) {
  const soxOk = hasSoxCmd()
  const ndOk  = await hasNaudiodon()

  if ((soxOk || ndOk) && !force) {
    status('ok', 'Audio backend already available', ndOk ? 'naudiodon' : 'SoX')
    return true
  }

  header()
  term.bold(' Checking audio backends...\n\n')
  status(ndOk  ? 'ok' : 'warn', 'naudiodon (native)',  ndOk  ? 'available' : 'not found')
  status(soxOk ? 'ok' : 'warn', 'SoX',                 soxOk ? 'available' : 'not found')
  term('\n')

  if (!force && (soxOk || ndOk)) {
    status('ok', 'Audio is ready'); return true
  }

  // Menu
  term.bold(' Choose installation method:\n\n')
  term.cyan('  [1]  SoX ')
  term.dim('(recommended — auto-download, no compilation)\n')
  term.cyan('  [2]  naudiodon ')
  term.dim('(better quality — needs Visual Studio Build Tools)\n')
  term.dim('  [3]  Skip — run without audio\n\n')
  term('  Choice: ')

  term.grabInput()
  const choice = await new Promise(resolve => {
    const onKey = (name) => {
      if (['1','2','3','CTRL_C','q'].includes(name)) { term.removeListener('key', onKey); resolve(name) }
    }
    term.on('key', onKey)
  })
  term.grabInput(false)

  if (['3', 'CTRL_C', 'q'].includes(choice)) {
    term.dim('\n Skipping audio setup.\n\n')
    return false
  }

  term('\n')
  header()

  // ── SoX ───────────────────────────────────────────────────────────────────
  if (choice === '1') {
    let result = { ok: false, reason: '' }

    if (hasCmd('winget')) {
      status('info', 'Trying winget...')
      result = await installSoxWinget()
      if (!result.ok) status('warn', result.reason ?? 'winget failed, trying next method...')
    }

    if (!result.ok && hasCmd('scoop')) {
      status('info', 'Trying Scoop...')
      result = await installSoxScoop()
      if (!result.ok) status('warn', 'Scoop failed, trying next method...')
    }

    if (!result.ok && hasCmd('choco')) {
      status('info', 'Trying Chocolatey...')
      result = await installSoxChoco()
      if (!result.ok) status('warn', 'Chocolatey failed, trying direct download...')
    }

    if (!result.ok) {
      status('info', 'Downloading portable SoX directly...')
      result = await downloadSoxPortable()
    }

    term('\n')
    if (result.ok) {
      // Refresh PATH from environment (winget/scoop may have added to system PATH)
      if (process.platform === 'win32' && !hasSoxCmd()) {
        try {
          const p = execSync('cmd /c echo %PATH%', { encoding: 'utf8' }).trim()
          process.env.PATH = p
        } catch {}
      }
      if (hasSoxCmd()) {
        status('ok', 'SoX is ready — audio enabled!')
      } else {
        status('warn', 'SoX installed but not yet in PATH')
        term.dim('  Restart your terminal and run yapper again.\n')
      }
    } else {
      status('err', `Failed: ${result.reason ?? 'all methods exhausted'}`)
      term('\n  Manual options:\n')
      term('    winget: ')
      term.bold('winget install ChrisBagwell.SoX\n')
      term('    direct: ')
      term.bold(`https://sourceforge.net/projects/sox/files/sox/${SOX_VER}/\n`)
    }
  }

  // ── naudiodon ─────────────────────────────────────────────────────────────
  if (choice === '2') {
    const hasMsBuild = hasCmd('msbuild')
    if (process.platform === 'win32' && !hasMsBuild) {
      status('warn', 'Visual Studio Build Tools not detected')
      term('\n  Install from: https://visualstudio.microsoft.com/downloads/\n')
      term('  Choose "Build Tools for Visual Studio" → C++ build tools workload.\n')
      term('  Then restart terminal and run ')
      term.bold('yapper setup\n')
    } else {
      status('info', `Building in ${PKG_ROOT}`)
      const { ok, log } = await runWithProgress('npm', ['install', 'naudiodon', '--build-from-source'], {
        title: 'Building naudiodon',
        shell: process.platform === 'win32',
        milestones: [
          { pct: 5,  kw: 'gyp info'  },
          { pct: 25, kw: 'msbuild'   },
          { pct: 50, kw: 'cl.exe'    },
          { pct: 72, kw: 'link.exe'  },
          { pct: 88, kw: 'added'     },
        ],
      })
      term('\n')
      if (ok) status('ok', 'naudiodon built — audio enabled!')
      else    status('err', 'Build failed — try SoX (option 1) as an easier alternative')
    }
  }

  term('\n')
  await waitKey()
  return true
}

export async function runSetupCLI() {
  await runSetup({ force: true })
  process.exit(0)
}
