import { spawn, execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import termkit from 'terminal-kit'

const term = termkit.terminal
const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const PKG_ROOT   = join(__dirname, '..')   // src/setup.js → yapper/

// ─── Utilities ────────────────────────────────────────────────────────────────

function hasCmd(cmd) {
  const check = process.platform === 'win32' ? `where "${cmd}"` : `which "${cmd}"`
  try { execSync(check, { stdio: 'ignore' }); return true } catch { return false }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function header() {
  term.clear()
  term.moveTo(1, 1)
  term.bold.cyan(' yapper — Audio Setup\n')
  term.dim(' ' + '─'.repeat((process.stdout.columns || 70) - 2) + '\n\n')
}

function status(icon, label, detail = '') {
  const icons = { ok: term.bold.green, warn: term.bold.yellow, err: term.bold.red, info: term.bold.cyan }
  const fn = icons[icon] ?? term.dim
  fn(` ${icon === 'ok' ? '✓' : icon === 'err' ? '✗' : icon === 'warn' ? '!' : '→'}  `)
  term(label)
  if (detail) term.dim(`  ${detail}`)
  term('\n')
}

// ─── Progress runner ──────────────────────────────────────────────────────────

// milestones: [{pct: 0-100, keyword: 'text in output to trigger jump'}]
async function runWithProgress(cmd, args, { cwd, title, milestones, shell = false } = {}) {
  term('\n')
  const bar = term.progressBar({
    width: Math.min(process.stdout.columns - 6 || 60, 60),
    title,
    percent: true,
    eta: false,
    titleStyle: term.bold,
    barStyle: term.cyan,
    barBracketStyle: term.dim,
    percentStyle: term.bold,
  })

  let currentPct = 0
  let targetPct  = 0
  let statusLine = ''
  let done = false

  // Smooth animation: creep currentPct toward targetPct
  const tick = setInterval(() => {
    if (done) return
    if (currentPct < targetPct) {
      currentPct = Math.min(currentPct + 1, targetPct)
      bar.update({ progress: currentPct / 100 })
    }
  }, 80)

  // Bump target when a milestone keyword appears in output
  function checkLine(line) {
    for (const { pct, keyword } of milestones) {
      if (keyword && line.toLowerCase().includes(keyword.toLowerCase())) {
        if (pct > targetPct) { targetPct = pct; bar.update({ progress: currentPct / 100 }) }
      }
    }
  }

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: cwd ?? PKG_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
    })

    const onData = (d) => d.toString().split('\n').forEach(l => l.trim() && checkLine(l))
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)

    proc.on('close', async (code) => {
      done = true
      clearInterval(tick)
      currentPct = code === 0 ? 100 : currentPct
      bar.update({ progress: currentPct / 100 })
      await sleep(200)
      bar.stop()
      resolve(code === 0)
    })

    proc.on('error', async () => {
      done = true; clearInterval(tick)
      bar.update({ progress: 0 }); await sleep(100); bar.stop()
      resolve(false)
    })

    // Kickstart first milestone
    targetPct = milestones[0]?.pct ?? 5
  })
}

// ─── Install methods ──────────────────────────────────────────────────────────

async function installSoxWinget() {
  return runWithProgress('winget', [
    'install', '--id', 'SoX.SoX',
    '--accept-source-agreements', '--accept-package-agreements', '-h',
  ], {
    title: 'Installing SoX via winget',
    milestones: [
      { pct: 5,  keyword: 'found'       },
      { pct: 20, keyword: 'download'    },
      { pct: 55, keyword: 'verif'       },
      { pct: 75, keyword: 'starting'    },
      { pct: 90, keyword: 'successfully'},
    ],
  })
}

async function installSoxChoco() {
  return runWithProgress('choco', ['install', 'sox', '-y', '--no-progress'], {
    title: 'Installing SoX via Chocolatey',
    milestones: [
      { pct: 5,  keyword: 'chocolatey'  },
      { pct: 25, keyword: 'download'    },
      { pct: 60, keyword: 'installing'  },
      { pct: 90, keyword: 'installed'   },
    ],
  })
}

async function installNaudiodon() {
  return runWithProgress('npm', ['install', 'naudiodon', '--build-from-source'], {
    title: 'Building naudiodon (native audio)',
    milestones: [
      { pct: 5,  keyword: 'npm warn'     },
      { pct: 15, keyword: 'gyp info'     },
      { pct: 30, keyword: 'msbuild'      },
      { pct: 50, keyword: 'cl.exe'       },
      { pct: 70, keyword: 'link.exe'     },
      { pct: 85, keyword: 'node_modules' },
      { pct: 92, keyword: 'added'        },
    ],
    shell: process.platform === 'win32',
  })
}

// ─── Check helpers ────────────────────────────────────────────────────────────

async function hasSox() { return hasCmd('sox') }
async function hasNaudiodon() {
  try { await import('naudiodon'); return true } catch { return false }
}

// ─── Main setup flow ──────────────────────────────────────────────────────────

export async function runSetup({ force = false } = {}) {
  const soxOk    = await hasSox()
  const ndOk     = await hasNaudiodon()
  const audioOk  = soxOk || ndOk

  if (audioOk && !force) {
    status('ok', 'Audio backend already available', ndOk ? 'naudiodon' : 'SoX')
    return true
  }

  header()
  term.bold(' Checking audio backends...\n\n')
  status(ndOk  ? 'ok'  : 'warn', 'naudiodon (native)',   ndOk  ? 'available' : 'not found')
  status(soxOk ? 'ok'  : 'warn', 'SoX',                  soxOk ? 'available' : 'not found')
  term('\n')

  if (!force && audioOk) { status('ok', 'Audio is ready — no setup needed'); return true }

  // ── Option menu ──────────────────────────────────────────────────────────
  term.bold(' Choose installation method:\n\n')
  term.cyan('  [1]  SoX ')
  term.dim('(recommended — simple download, no compilation)\n')

  term.cyan('  [2]  naudiodon ')
  term.dim('(better quality — requires Visual Studio Build Tools)\n')

  term.dim('  [3]  Skip — run without audio\n\n')
  term('  Choice: ')

  term.grabInput()
  const choice = await new Promise(resolve => {
    function onKey(name) {
      if (['1','2','3','CTRL_C','q'].includes(name)) {
        term.removeListener('key', onKey)
        resolve(name)
      }
    }
    term.on('key', onKey)
  })
  term.grabInput(false)

  if (choice === 'CTRL_C' || choice === 'q' || choice === '3') {
    term.dim('\n Skipping audio setup.\n\n')
    return false
  }

  term('\n')
  header()

  // ── SoX install ──────────────────────────────────────────────────────────
  if (choice === '1') {
    let ok = false

    if (hasCmd('winget')) {
      status('info', 'Found winget — using Windows Package Manager')
      ok = await installSoxWinget()
    } else if (hasCmd('choco')) {
      status('info', 'Found Chocolatey — using choco install')
      ok = await installSoxChoco()
    } else {
      status('err', 'Neither winget nor chocolatey found')
      term('\n  Install SoX manually:\n')
      term('  https://sourceforge.net/projects/sox/files/sox/\n\n')
      term('  Then re-run: ')
      term.bold('yapper setup\n\n')
      await waitKey()
      return false
    }

    term('\n')
    if (ok) {
      status('ok', 'SoX installed! Verifying...')
      // Refresh PATH so sox is available in this process
      if (process.platform === 'win32') {
        try {
          const newPath = execSync('cmd /c echo %PATH%', { encoding: 'utf8' }).trim()
          process.env.PATH = newPath
        } catch {}
      }
      const verified = hasCmd('sox')
      if (verified) {
        status('ok', 'SoX found in PATH — audio is ready')
      } else {
        status('warn', 'SoX installed but not yet in PATH')
        term.dim('   Restart your terminal and run yapper again.\n')
      }
    } else {
      status('err', 'SoX installation failed')
      term('\n  Try installing manually: ')
      term.bold('winget install SoX.SoX\n')
    }
  }

  // ── naudiodon install ────────────────────────────────────────────────────
  if (choice === '2') {
    status('info', `Installing in: ${PKG_ROOT}`)

    const hasMsBuild = process.platform === 'win32'
      ? (() => { try { execSync('where msbuild', { stdio: 'ignore' }); return true } catch { return false } })()
      : true  // On Linux/Mac, g++ usually available

    if (process.platform === 'win32' && !hasMsBuild) {
      status('warn', 'Visual Studio Build Tools not found')
      term('\n  naudiodon needs C++ compiler. Install:\n')
      term('  https://visualstudio.microsoft.com/downloads/ → "Build Tools for Visual Studio"\n')
      term('  Select: C++ build tools workload, then re-run: ')
      term.bold('yapper setup\n\n')
      await waitKey()
      return false
    }

    const ok = await installNaudiodon()
    term('\n')
    if (ok) {
      status('ok', 'naudiodon built successfully — audio is ready')
    } else {
      status('err', 'naudiodon build failed — try SoX instead (option 1)')
    }
  }

  term('\n')
  await waitKey()
  return true
}

async function waitKey() {
  term.dim(' Press any key to continue...')
  term.grabInput()
  await new Promise(resolve => term.once('key', resolve))
  term.grabInput(false)
  term('\n')
}

// ─── Called directly: yapper setup ───────────────────────────────────────────
export async function runSetupCLI() {
  await runSetup({ force: true })
  process.exit(0)
}
