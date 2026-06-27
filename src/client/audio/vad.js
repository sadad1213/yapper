const SILENCE_THRESHOLD = 400  // linear RMS below this is treated as silence

export function rawRms(pcmBuffer) {
  let sumSq = 0
  const samples = pcmBuffer.length / 2
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const s = pcmBuffer.readInt16LE(i)
    sumSq += s * s
  }
  return Math.sqrt(sumSq / samples)
}

export function isSilent(pcmBuffer) {
  return rawRms(pcmBuffer) < SILENCE_THRESHOLD
}

// Normalised 0..1 level on a dB scale, nice for a VU meter.
export function level(pcmBuffer) {
  const r = rawRms(pcmBuffer)
  if (r < 1) return 0
  const db = 20 * Math.log10(r / 32768)   // -inf .. 0
  return Math.max(0, Math.min(1, (db + 55) / 55))
}
