// RNNoise-based noise suppression for the capture path.
//
// Operates on 48 kHz mono 16-bit PCM. RNNoise processes fixed 480-sample
// (10 ms) chunks, which now matches our capture frame exactly (one chunk per
// frame); the loop below still handles any whole multiple of 480 just in case.
//
// Uses @jitsi/rnnoise-wasm's *sync* build: it inlines the WASM as base64, so
// there's no separate .wasm file to locate at runtime — important for a global
// CLI install. We import the dist file directly because the package's index.js
// entry uses an extensionless import that Node's ESM loader rejects.
//
// Degrades gracefully: if the WASM fails to load, denoiseFrame() returns the
// input untouched and the feature reports itself unavailable.

const RN_FRAME = 480      // RNNoise's fixed frame size in samples (10 ms @ 48 kHz)

let Module = null         // emscripten runtime
let state = 0             // DenoiseState pointer
let ptrIn = 0, ptrOut = 0 // persistent WASM heap buffers (float32 × RN_FRAME)
let scratch = null        // reusable Float32Array(RN_FRAME) — avoids per-frame alloc
let available = false
let enabled = true        // user toggle; default on, overridden from config at startup
let loading = null        // shared promise so concurrent initDenoise() calls dedupe

export function isDenoiseAvailable() { return available }
export function isDenoiseEnabled()   { return enabled }
export function setDenoiseEnabled(v) { enabled = !!v }

// Load the WASM model and allocate the denoise state. Safe to call repeatedly —
// the work happens once. Returns whether denoise is available afterwards.
export function initDenoise() {
  if (available) return Promise.resolve(true)
  if (loading) return loading
  loading = (async () => {
    try {
      const { default: createModule } = await import('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js')
      const M = createModule()
      await M.ready                       // wasm instantiation finishes here
      state = M._rnnoise_create(0)        // 0 = built-in default model
      ptrIn  = M._malloc(RN_FRAME * 4)
      ptrOut = M._malloc(RN_FRAME * 4)
      scratch = new Float32Array(RN_FRAME)
      Module = M
      available = true
    } catch {
      available = false                   // missing/broken WASM → pass-through, no crash
    }
    return available
  })()
  return loading
}

// Denoise one capture frame (Int16 mono PCM Buffer). Returns a fresh cleaned
// Buffer when active, or the input Buffer unchanged when disabled/unavailable.
// RNNoise consumes and produces 16-bit-range floats.
export function denoiseFrame(pcmBuf) {
  if (!enabled || !available || !state) return pcmBuf
  const samples = pcmBuf.length >> 1
  if (samples === 0 || samples % RN_FRAME !== 0) return pcmBuf   // unexpected size — pass through

  const out = Buffer.allocUnsafe(pcmBuf.length)
  // Re-read HEAPF32 each call: emscripten can swap the backing buffer if memory
  // grows (it won't here, but this stays correct and costs nothing).
  const heap = Module.HEAPF32
  const inIdx = ptrIn >> 2, outIdx = ptrOut >> 2

  for (let off = 0; off < samples; off += RN_FRAME) {
    for (let i = 0; i < RN_FRAME; i++) scratch[i] = pcmBuf.readInt16LE((off + i) << 1)
    heap.set(scratch, inIdx)
    try { Module._rnnoise_process_frame(state, ptrOut, ptrIn) }
    catch { return pcmBuf }
    for (let i = 0; i < RN_FRAME; i++) {
      let s = Math.round(heap[outIdx + i])
      if (s > 32767) s = 32767
      else if (s < -32768) s = -32768
      out.writeInt16LE(s, (off + i) << 1)
    }
  }
  return out
}
