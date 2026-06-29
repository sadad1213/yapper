import { execSync, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { SAMPLE_RATE, CHANNELS } from './capture.js'
import { Capture } from './capture.js'
import { initPlayback, startMixer, stopMixer, pauseMixer, queueFrame } from './playback.js'
import { initDenoise } from './denoise.js'

// Re-exported so UI layers (TUI app.js, GUI main) can toggle deafen without
// reaching into playback.js directly.
export { setDeafened, isDeafened } from './playback.js'

// Emits 'level' (0..1) on every captured frame — used by the UI VU meter.
export const audioEvents = new EventEmitter()

let backend = null          // 'naudiodon' | 'sox' | null
let naudio = null           // naudiodon module namespace (if loaded)
let soxMod = null           // ./sox.js module (if loaded)
let encoder = null, decoder = null
let captureInstance = null
let outStream = null
let selectedInputId = -1

async function loadOpus() {
  const { default: OpusScript } = await import('opusscript')
  encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP)
  decoder = new OpusScript(SAMPLE_RATE, CHANNELS)
  // We're on a LAN/VPN — bandwidth is cheap, so favour quality over compression.
  // Opus' VOIP default lands around ~24-32 kbps; a clean mono voice stream at
  // 64 kbps is effectively transparent and still only ~8 KB/s.
  try {
    encoder.setBitrate(64000)        // OPUS_SET_BITRATE
    encoder.encoderCTL(4010, 10)     // OPUS_SET_COMPLEXITY = 10 (max quality)
    encoder.encoderCTL(4024, 3001)   // OPUS_SET_SIGNAL = OPUS_SIGNAL_VOICE
  } catch {}
}

// ─── naudiodon helpers (robust to API shape differences) ───────────────────────
function ndAudioIO() { return naudio.AudioIO || naudio.default || naudio }
function ndFormat()  { const A = ndAudioIO(); return naudio.SampleFormat16Bit ?? A.SampleFormat16Bit ?? 8 }

function buildNdInput(deviceId) {
  const A = ndAudioIO()
  return new A({ inOptions: { channelCount: CHANNELS, sampleFormat: ndFormat(), sampleRate: SAMPLE_RATE, deviceId: deviceId ?? -1, closeOnError: false } })
}
function buildNdOutput() {
  const A = ndAudioIO()
  return new A({ outOptions: { channelCount: CHANNELS, sampleFormat: ndFormat(), sampleRate: SAMPLE_RATE, deviceId: -1, closeOnError: false } })
}

function hasSox() {
  const cmd = process.platform === 'win32' ? 'where sox' : 'which sox'
  try { execSync(cmd, { stdio: 'ignore' }); return true } catch { return false }
}

function attachCapture(inStream) {
  captureInstance = new Capture(encoder, inStream)
  // naudiodon's device must survive a room leave: its quit() also tears down the
  // shared PortAudio session (silencing playback) and its AudioIO can't be
  // restarted. SoX has no such constraint, so it's released on every stop.
  captureInstance.keepAlive = (backend === 'naudiodon')
  captureInstance.on('level', l => audioEvents.emit('level', l))
}

// Build an input stream for the current backend at the given device id.
function makeInput(deviceId) {
  if (backend === 'naudiodon') return buildNdInput(deviceId)
  if (backend === 'sox')       return new soxMod.SoxCapture(deviceId < 0 ? 0 : deviceId)
  return null
}

// ─── Public API ────────────────────────────────────────────────────────────────
export async function initAudio() {
  await loadOpus()

  // Warm the RNNoise WASM in the background — the first capture frame uses it
  // once ready, and passes audio through untouched until then.
  initDenoise()

  // Prefer naudiodon (native, supports device selection)
  try {
    naudio = await import('naudiodon')
    backend = 'naudiodon'
    outStream = buildNdOutput()
    initPlayback(decoder, outStream)
    attachCapture(buildNdInput(selectedInputId))
    return { available: true, queueFrame, backend }
  } catch {}

  // Fall back to SoX
  if (hasSox()) {
    backend = 'sox'
    warmWinMics()                    // pre-fetch real Windows mic names in the background
    soxMod = await import('./sox.js')
    outStream = new soxMod.SoxPlayback()
    initPlayback(decoder, outStream)
    attachCapture(new soxMod.SoxCapture(selectedInputId < 0 ? 0 : selectedInputId))
    return { available: true, queueFrame, backend }
  }

  backend = null
  return {
    available: false,
    reason:
      'Audio requires naudiodon or SoX.\n' +
      'Run "yapper setup" to install one automatically.',
  }
}

// ─── Windows microphone names (SoX backend) ─────────────────────────────────────
// SoX's waveaudio driver addresses inputs by index only — it can't name them, so
// the UI used to show "Device 0/1/2". WinMM's waveInGetDevCaps enumerates inputs in
// the *same order* SoX uses, with real names, so we query it (via PowerShell P/Invoke)
// and map index→name. Names are capped at 31 chars by the MME API, but that still
// identifies the mic. Warmed once asynchronously at init so opening settings is instant.
let _winMics = null            // [{ id, name }] once resolved (kept as the SoX index list)
let _winMicsTried = false       // we've attempted enumeration (success or not)

function micEnumScript() {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class YapWaveIn {',
    '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
    '  public struct CAPS {',
    '    public ushort wMid; public ushort wPid; public uint vDriverVersion;',
    '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szPname;',
    '    public uint dwFormats; public ushort wChannels; public ushort wReserved1;',
    '  }',
    '  [DllImport("winmm.dll", CharSet=CharSet.Unicode)] public static extern uint waveInGetNumDevs();',
    '  [DllImport("winmm.dll", CharSet=CharSet.Unicode)] public static extern uint waveInGetDevCapsW(UIntPtr id, ref CAPS c, uint cb);',
    '}',
    '"@',
    '$n=[YapWaveIn]::waveInGetNumDevs()',
    'for($i=0;$i -lt $n;$i++){',
    "  $c=New-Object 'YapWaveIn+CAPS'",
    "  $sz=[System.Runtime.InteropServices.Marshal]::SizeOf([type]'YapWaveIn+CAPS')",
    '  $r=[YapWaveIn]::waveInGetDevCapsW([UIntPtr]([uint32]$i),[ref]$c,[uint32]$sz)',
    '  if($r -eq 0){ Write-Output ("{0}\t{1}" -f $i,$c.szPname) }',
    '}',
  ].join('\n')
}

function parseMicLines(out) {
  const devs = []
  for (const line of String(out).split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const id = Number(line.slice(0, tab))
    if (!Number.isInteger(id)) continue
    const name = line.slice(tab + 1).trim()
    devs.push({ id, name: name || `Microphone ${id}` })
  }
  return devs
}

// Best-effort async enumeration. Never throws; populates _winMics when it succeeds.
function warmWinMics() {
  if (process.platform !== 'win32' || _winMicsTried) return
  _winMicsTried = true
  try {
    const b64 = Buffer.from(micEnumScript(), 'utf16le').toString('base64')
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => { out += d.toString('utf8') })
    p.on('error', () => {})
    p.on('close', () => { const d = parseMicLines(out); if (d.length) _winMics = d })
  } catch { /* leave _winMics null → generic fallback */ }
}

export function getInputDevices() {
  if (backend === 'naudiodon') {
    try {
      const list = naudio.getDevices ? naudio.getDevices() : ndAudioIO().getDevices()
      const inputs = list.filter(d => d.maxInputChannels > 0).map(d => ({ id: d.id, name: d.name }))
      return inputs.length ? inputs : [{ id: -1, name: 'Default' }]
    } catch { return [{ id: -1, name: 'Default' }] }
  }
  if (backend === 'sox') {
    // Real Windows mic names when we have them (warmed at init); otherwise the
    // generic index list (also the case on Linux/macOS, where SoX uses -d/default).
    if (process.platform === 'win32') {
      if (_winMics && _winMics.length) return _winMics
      warmWinMics()                          // kick off (or re-try) enumeration for next time
    }
    return [
      { id: 0, name: 'Default mic (device 0)' },
      { id: 1, name: 'Device 1' },
      { id: 2, name: 'Device 2' },
      { id: 3, name: 'Device 3' },
    ]
  }
  return [{ id: -1, name: 'No audio backend' }]
}

export function setInputDevice(id) {
  selectedInputId = id
  if (backend !== 'naudiodon' && backend !== 'sox') return
  const wasActive = captureInstance?.active
  try { captureInstance?.stop({ force: true }) } catch {}   // device change → fully release the old one
  attachCapture(makeInput(id))
  if (wasActive) captureInstance.start()
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
  // When the device is kept alive across the leave (naudiodon), keep the output
  // fed with silence so it doesn't starve and stall. SoX can be fully stopped.
  if (captureInstance.keepAlive) pauseMixer()
  else stopMixer()
}

// Loopback mic test: route our own encoded frames back through the decoder/mixer
// so the user hears themselves. Returns a stop() function.
export function startMicTest(onLevel) {
  if (!captureInstance) return () => {}
  const wasActive = captureInstance.active
  const frameH = (frame) => queueFrame(0, frame)
  const levelH = (l) => { try { onLevel(l) } catch {} }

  captureInstance.on('frame', frameH)
  audioEvents.on('level', levelH)
  if (!wasActive) captureInstance.start()
  startMixer()

  return () => {
    captureInstance.off('frame', frameH)
    audioEvents.off('level', levelH)
    if (!wasActive) { captureInstance.stop(); captureInstance.keepAlive ? pauseMixer() : stopMixer() }
  }
}
