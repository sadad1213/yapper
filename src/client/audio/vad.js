const SILENCE_THRESHOLD = 400  // RMS below this is considered silence

export function isSilent(pcmBuffer) {
  let sumSq = 0
  const samples = pcmBuffer.length / 2
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const s = pcmBuffer.readInt16LE(i)
    sumSq += s * s
  }
  return Math.sqrt(sumSq / samples) < SILENCE_THRESHOLD
}
