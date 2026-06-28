import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Global mute hotkey (Windows only).
//
// We register a single system-wide hotkey via the Win32 RegisterHotKey API,
// driven by a tiny PowerShell helper that runs a message loop and prints a line
// each time the combo is pressed. This is deliberately NOT a low-level keyboard
// hook: only the chosen combo is captured (nothing else is observed), so it
// doesn't behave like a keylogger and doesn't trip antivirus. For the same
// reason the helper is a plain .ps1 invoked by path with numeric args — not an
// -EncodedCommand, which AV/EDR tends to flag.
//
// RegisterHotKey only signals key-down (no key-up), so this supports a mute
// TOGGLE, not push-to-talk. Bare single letters are intentionally not offered:
// a global hotkey swallows the key in every app, so we stick to modifier combos
// and function/lock keys.

// fsModifiers (winuser.h)
const MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4
const MOD_NOREPEAT = 0x4000   // ignore auto-repeat while held — one event per press

// Virtual-key codes (winuser.h)
const VK = {
  PAUSE: 0x13, SCROLL: 0x91,
  F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
  M: 0x4D, U: 0x55, B: 0x42,
}

// Curated, RegisterHotKey-compatible combos the settings modal cycles through.
// `id` is the stable value persisted in config; `off` disables the feature.
export const HOTKEY_PRESETS = [
  { id: 'off',          label: 'off',          mods: 0,                      vk: 0 },
  { id: 'f8',           label: 'F8',           mods: 0,                      vk: VK.F8 },
  { id: 'f9',           label: 'F9',           mods: 0,                      vk: VK.F9 },
  { id: 'f10',          label: 'F10',          mods: 0,                      vk: VK.F10 },
  { id: 'f12',          label: 'F12',          mods: 0,                      vk: VK.F12 },
  { id: 'pause',        label: 'Pause',        mods: 0,                      vk: VK.PAUSE },
  { id: 'scrolllock',   label: 'ScrollLock',   mods: 0,                      vk: VK.SCROLL },
  { id: 'ctrl+shift+m', label: 'Ctrl+Shift+M', mods: MOD_CONTROL | MOD_SHIFT, vk: VK.M },
  { id: 'ctrl+alt+m',   label: 'Ctrl+Alt+M',   mods: MOD_CONTROL | MOD_ALT,   vk: VK.M },
  { id: 'alt+shift+m',  label: 'Alt+Shift+M',  mods: MOD_ALT | MOD_SHIFT,     vk: VK.M },
  { id: 'ctrl+shift+u', label: 'Ctrl+Shift+U', mods: MOD_CONTROL | MOD_SHIFT, vk: VK.U },
]

export function presetIndex(id) {
  const i = HOTKEY_PRESETS.findIndex(p => p.id === id)
  return i >= 0 ? i : 0
}

// The helper is static; it reads the modifiers and vk as numeric arguments and
// reports 'OK' once armed and 'HK' on every press. RegisterHotKey with
// hWnd=NULL posts WM_HOTKEY (0x0312) to the thread queue, which GetMessage picks
// up. The combo is auto-unregistered when the process exits (i.e. when killed).
const PS_HELPER = [
  "$ErrorActionPreference='Stop'",
  '$mods=[uint32]$args[0]',
  '$vk=[uint32]$args[1]',
  '$ppid=[int]$args[2]',
  "$sig='[DllImport(\"user32.dll\")] public static extern bool RegisterHotKey(IntPtr hWnd,int id,uint fsModifiers,uint vk); [DllImport(\"user32.dll\")] public static extern IntPtr SetTimer(IntPtr hWnd,IntPtr nIDEvent,uint uElapse,IntPtr lpTimerFunc); [DllImport(\"user32.dll\")] public static extern int GetMessage(out MSG lpMsg,IntPtr hWnd,uint min,uint max); [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }'",
  // -MemberDefinition already imports System.Runtime.InteropServices; passing it
  // again is a duplicate-using compile error. -PassThru returns both the class
  // and the nested MSG struct, so select the class that owns RegisterHotKey.
  '$t=Add-Type -MemberDefinition $sig -Name HK -Namespace Y -PassThru | Where-Object { $_.Name -eq \'HK\' }',
  'if(-not $t::RegisterHotKey([IntPtr]::Zero,1,$mods,$vk)){ exit 1 }',
  // A thread timer wakes the message loop every 2s so we can notice the parent
  // app dying (e.g. terminal force-closed without teardown) and exit too —
  // otherwise this process would linger and keep swallowing the hotkey globally.
  '[void]$t::SetTimer([IntPtr]::Zero,[IntPtr]::Zero,2000,[IntPtr]::Zero)',
  "[Console]::Out.WriteLine('OK'); [Console]::Out.Flush()",
  "$m=New-Object 'Y.HK+MSG'",
  'while($t::GetMessage([ref]$m,[IntPtr]::Zero,0,0) -ne 0){',
  "  if($m.message -eq 0x0312){ [Console]::Out.WriteLine('HK'); [Console]::Out.Flush() }",
  '  elseif($m.message -eq 0x0113){ if(-not (Get-Process -Id $ppid -ErrorAction SilentlyContinue)){ break } }',
  '}',
].join('\n')

let child = null
let onTrigger = null
let helperPath = null

function writeHelper() {
  if (helperPath) return helperPath
  const p = join(tmpdir(), 'yapper-mute-hotkey.ps1')
  try { writeFileSync(p, PS_HELPER, 'utf8'); helperPath = p } catch { helperPath = null }
  return helperPath
}

function stop() {
  if (child) { try { child.kill() } catch {} ; child = null }
}

function start(preset) {
  stop()
  const path = writeHelper()
  if (!path) return
  const mods = preset.mods | MOD_NOREPEAT
  child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, String(mods), String(preset.vk), String(process.pid)],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  )
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line === 'HK') { try { onTrigger?.() } catch {} }
    }
  })
  child.on('error', () => {})
  child.on('close', () => { child = null })
}

// (Re)bind the global mute hotkey. `id` is a HOTKEY_PRESETS id; `off` (or any
// unknown id) disables it. `cb` is invoked on every press. No-op off Windows.
export function setMuteHotkey(id, cb) {
  onTrigger = cb
  if (process.platform !== 'win32') return
  const preset = HOTKEY_PRESETS.find(p => p.id === id)
  if (!preset || preset.id === 'off') { stop(); return }
  start(preset)
}

export function stopHotkey() { stop() }
