// Synthesised notification sounds as raw 16-bit 48kHz mono PCM.
// No external files needed — just maths.

import { SAMPLE_RATE } from './capture.js'

// ─── helpers ────────────────────────────────────────────────────────────────

/** Single-frequency tone of the given duration (ms) and amplitude (0..1). */
function tone(freq, durationMs, amplitude = 0.3) {
  const len = Math.floor(SAMPLE_RATE * durationMs / 1000)
  const buf = Buffer.alloc(len * 2)
  for (let i = 0; i < len; i++) {
    const s = Math.round(Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE) * amplitude * 32767)
    buf.writeInt16LE(s, i * 2)
  }
  return buf
}

/** Frequency sweep from startFreq to endFreq over durationMs. */
function sweep(startFreq, endFreq, durationMs, amplitude = 0.3) {
  const len = Math.floor(SAMPLE_RATE * durationMs / 1000)
  const buf = Buffer.alloc(len * 2)
  let phase = 0
  for (let i = 0; i < len; i++) {
    const t = i / len // 0 → 1
    const freq = startFreq + (endFreq - startFreq) * t
    phase += 2 * Math.PI * freq / SAMPLE_RATE
    const s = Math.round(Math.sin(phase) * amplitude * 32767)
    buf.writeInt16LE(s, i * 2)
  }
  return buf
}

function silence(durationMs) {
  return Buffer.alloc(Math.floor(SAMPLE_RATE * durationMs / 1000) * 2)
}

// ─── notification sounds ────────────────────────────────────────────────────

/** Someone joined your room — two rising chimes. */
export function joinPCM() {
  return Buffer.concat([
    sweep(523, 784, 80, 0.25),
    silence(40),
    sweep(659, 1047, 120, 0.28),
  ])
}

/** Someone left your room — two descending tones. */
export function leavePCM() {
  return Buffer.concat([
    sweep(587, 349, 100, 0.25),
    silence(30),
    sweep(440, 220, 120, 0.25),
  ])
}

/** An update is available — three-note ascending chime. */
export function updatePCM() {
  return Buffer.concat([
    tone(523, 90, 0.3),
    silence(20),
    tone(659, 90, 0.3),
    silence(20),
    tone(784, 140, 0.35),
  ])
}
