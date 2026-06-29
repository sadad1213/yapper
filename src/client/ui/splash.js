// Startup splash animations for the TUI.
//
// One ASCII-art "YAPPER" banner (ANSI Shadow style) rendered through one of many
// randomly-chosen animation variants — a shimmer sweep, a twinkling starfield, a
// matrix rain, a flowing gradient, a glitch, a sparkle burst, and a neon flicker.
// All purely cosmetic; the host election / audio init runs behind it. The caller
// (ui/app.js) owns the screen buffer and input — it just hands us a tiny drawing
// API and the elapsed time, and skips us on any key.
//
// Drawing API passed in by the caller:
//   api.put(x, y, str, attr)   — write to the screen buffer (clips off-screen y)
//   api.fill()                 — clear the whole buffer
//   api.W, api.H               — current buffer dimensions

// ─── ASCII-art banner (ANSI Shadow) ───────────────────────────────────────────
const BANNER_RAW = [
  '██╗   ██╗ █████╗ ██████╗ ██████╗ ███████╗██████╗ ',
  '╚██╗ ██╔╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗',
  ' ╚████╔╝ ███████║██████╔╝██████╔╝█████╗  ██████╔╝',
  '  ╚██╔╝  ██╔══██║██╔═══╝ ██╔═══╝ ██╔══╝  ██╔══██╗',
  '   ██║   ██║  ██║██║     ██║     ███████╗██║  ██║',
  '   ╚═╝   ╚═╝  ╚═╝╚═╝     ╚═╝     ╚══════╝╚═╝  ╚═╝',
]
// Normalise to equal width so geometry is simple and resize-safe.
const BW = Math.max(...BANNER_RAW.map((r) => [...r].length))
const BANNER = BANNER_RAW.map((r) => { const a = [...r]; while (a.length < BW) a.push(' '); return a })
const BH = BANNER.length

// Letter index per banner column (Y A P P E R), for the neon variant's per-letter
// flicker. Widths: Y=9, then A/P/P/E/R = 8 each.
function letterAt(lx) { return lx < 9 ? 0 : lx < 17 ? 1 : lx < 25 ? 2 : lx < 33 ? 3 : lx < 41 ? 4 : 5 }

// ─── Timing ───────────────────────────────────────────────────────────────────
export const SPLASH_TOTAL_MS = 3000
const FADE_MS = 820

// ─── Helpers ────────────────────────────────────────────────────────────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const fadeOut = (t) => (t < SPLASH_TOTAL_MS - FADE_MS ? 1 : clamp01((SPLASH_TOTAL_MS - t) / FADE_MS))

// Deep navy → bright cyan/white (256-colour indices) for the blue shimmer ramp.
const BLUES = [17, 18, 19, 20, 21, 27, 33, 39, 45, 51, 87, 123, 159, 195, 231]
const blueAt = (v) => BLUES[Math.min(BLUES.length - 1, Math.floor(clamp01(v) * (BLUES.length - 1)))]

// Cheap deterministic noise — stable per (a,b) so flicker/twinkle don't jitter
// randomly between frames unless we advance one of the inputs with time.
function rnd(a, b) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function forEachInk(cb) {
  for (let ly = 0; ly < BH; ly++) {
    const row = BANNER[ly]
    for (let lx = 0; lx < BW; lx++) if (row[lx] !== ' ') cb(lx, ly, row[lx])
  }
}

function place(api) {
  const bx = Math.floor((api.W - BW) / 2)
  const by = Math.floor((api.H - BH) / 2) - 1
  return { bx, by, bw: BW, bh: BH }
}

// ─── Variants ─────────────────────────────────────────────────────────────────
// Each: (api, sp, t) => void.  `sp.state` is scratch space we may lazily init.

// 1) Shimmer — left→right reveal with a moving blue highlight + sweeping underline.
function vShimmer(api, sp, t) {
  const { bx, by, bw } = place(api), fade = fadeOut(t)
  forEachInk((lx, ly, ch) => {
    const reveal = clamp01((t / 600) * (bw + 6) - lx)
    const wave = (Math.sin(lx * 0.22 - t / 120) + 1) / 2
    const v = clamp01((0.5 + 0.5 * wave) * reveal * fade)
    if (v <= 0.05) return
    api.put(bx + lx, by + ly, ch, { color: blueAt(v), bold: v > 0.7 })
  })
  const ulY = by + BH, sweep = ((t / 13) % (bw + 20)) - 10
  for (let i = 0; i < bw; i++) {
    const v = clamp01(1 - Math.abs(i - sweep) / 8) * fade
    if (v > 0.06) api.put(bx + i, ulY, '─', { color: blueAt(v) })
  }
}

// 2) Starfield — twinkling, gently drifting stars; the banner brightens in over them.
function vStars(api, sp, t) {
  if (!sp.state || sp.state.W !== api.W || sp.state.H !== api.H) {
    const n = Math.max(24, Math.floor((api.W * api.H) / 38)), stars = []
    for (let i = 0; i < n; i++) stars.push({ x: Math.floor(rnd(i, 1) * api.W), y: Math.floor(rnd(i, 2) * api.H), ph: rnd(i, 3) * 6.28, spd: 0.6 + rnd(i, 4) * 2.2 })
    sp.state = { stars, W: api.W, H: api.H }
  }
  const fade = fadeOut(t)
  for (const s of sp.state.stars) {
    const tw = (Math.sin((t / 360) * s.spd + s.ph) + 1) / 2
    const v = tw * fade
    if (v <= 0.12) continue
    const ch = v > 0.82 ? '✦' : v > 0.55 ? '•' : v > 0.3 ? '∙' : '·'
    const col = v > 0.85 ? 195 : v > 0.6 ? 51 : v > 0.35 ? 39 : 19
    api.put(s.x, s.y, ch, { color: col })
  }
  const { bx, by, bw } = place(api), appear = clamp01(t / 700), pulse = 0.85 + 0.15 * Math.sin(t / 260)
  forEachInk((lx, ly, ch) => {
    const v = clamp01(appear * fade * pulse * (0.7 + 0.3 * Math.sin(t / 320 - lx * 0.04)))
    if (v <= 0.06) return
    api.put(bx + lx, by + ly, ch, { color: blueAt(v), bold: v > 0.7 })
  })
}

// 3) Matrix rain — falling glyph streams; the letters freeze out of the rain L→R.
const RAIN = '01<>/\\|=+*░▒ｱｲｳｴｵﾊﾋﾐﾑﾝ'.split('')
function vMatrix(api, sp, t) {
  const { W, H } = api, fade = fadeOut(t)
  for (let x = 0; x < W; x++) {
    const speed = 7 + rnd(x, 7) * 12
    const head = ((t / 1000) * speed + rnd(x, 8) * H) % (H + 8)
    const len = 4 + Math.floor(rnd(x, 9) * 6)
    for (let k = 0; k < len; k++) {
      const y = Math.floor(head) - k
      if (y < 0 || y >= H) continue
      const v = (1 - k / len) * fade
      if (v <= 0.12) continue
      const ch = RAIN[Math.floor(rnd(x * 7 + y, Math.floor(t / 110)) * RAIN.length) % RAIN.length]
      const col = k === 0 ? 195 : v > 0.6 ? 48 : v > 0.35 ? 35 : 22
      api.put(x, y, ch, { color: col, bold: k === 0 })
    }
  }
  const { bx, by, bw } = place(api)
  forEachInk((lx, ly, ch) => {
    const v = clamp01((t / 900) * (bw + 6) - lx) * fade
    if (v <= 0.06) return
    api.put(bx + lx, by + ly, ch, { color: v > 0.75 ? 195 : 51, bold: true })
  })
}

// 4) Gradient flow — a diagonal blue gradient streams continuously through the letters.
function vGradient(api, sp, t) {
  const { bx, by } = place(api), fade = fadeOut(t), appear = clamp01(t / 500)
  forEachInk((lx, ly, ch) => {
    const g = (Math.sin((ly * 0.9 + lx * 0.12) - t / 180) + 1) / 2
    const v = clamp01((0.38 + 0.62 * g) * appear * fade)
    if (v <= 0.05) return
    api.put(bx + lx, by + ly, ch, { color: blueAt(v), bold: v > 0.7 })
  })
}

// 5) Glitch — rows jitter and colour-split, then settle into a clean banner.
function vGlitch(api, sp, t) {
  const { bx, by } = place(api), fade = fadeOut(t), settle = clamp01(t / 1100)
  const bucket = Math.floor(t / 90)
  forEachInk((lx, ly, ch) => {
    const jitter = Math.round((rnd(ly + 1, bucket) * 2 - 1) * (1 - settle) * 6)
    const x = bx + lx + jitter
    const noisy = rnd(lx + ly, bucket) < (1 - settle) * 0.25
    const col = noisy ? (rnd(lx, bucket) > 0.5 ? 201 : 51) : blueAt(0.6 + 0.3 * Math.sin(t / 200))
    if (fade <= 0.05) return
    api.put(x, by + ly, ch, { color: col, bold: true })
    if (settle < 0.8 && rnd(ly, bucket) > 0.62) api.put(x + 2, by + ly, ch, { color: 198, dim: true })
  })
}

// 6) Sparkle burst — a wavefront expands from the centre, lighting the letters, with
//    sparkle particles flung outward.
function vSparkle(api, sp, t) {
  const { bx, by, bw, bh } = place(api), fade = fadeOut(t)
  const cx = bw / 2, cy = bh / 2, maxR = Math.hypot(cx, cy * 1.8)
  const radius = (t / 720) * maxR * 1.25
  forEachInk((lx, ly, ch) => {
    const d = Math.hypot(lx - cx, (ly - cy) * 1.8)
    if (radius - d < 0) return
    const edge = clamp01(1 - (radius - d) / 3)
    const v = clamp01((0.6 + 0.4 * edge)) * fade
    if (v <= 0.06) return
    const col = radius - d < 1.2 ? 231 : blueAt(0.5 + 0.4 * Math.sin(t / 250 - d * 0.2))
    api.put(bx + lx, by + ly, ch, { color: col, bold: v > 0.7 })
  })
  for (let i = 0; i < 22; i++) {
    const a = rnd(i, 1) * 6.28, rr = radius * (0.3 + rnd(i, 2))
    const px = Math.round(bx + cx + Math.cos(a) * rr), py = Math.round(by + cy + Math.sin(a) * rr * 0.6)
    const tw = ((Math.sin(t / 120 + i) + 1) / 2) * fade
    if (tw > 0.5) api.put(px, py, tw > 0.82 ? '✦' : '·', { color: tw > 0.82 ? 195 : 51 })
  }
}

// 7) Neon — letters flicker on like a neon sign (staggered, with buzz) then hold cyan.
const NEON_ON = [150, 520, 300, 820, 640, 1000]   // per-letter switch-on (out of order)
function vNeon(api, sp, t) {
  const { bx, by } = place(api), fade = fadeOut(t)
  forEachInk((lx, ly, ch) => {
    const li = letterAt(lx), since = t - NEON_ON[li]
    let lit
    if (since < 0) lit = 0
    else if (since < 320) lit = rnd(li, Math.floor(t / 55)) > 0.45 ? 1 : 0.12
    else lit = rnd(li, Math.floor(t / 220)) > 0.96 ? 0.5 : 1   // occasional buzz
    const v = clamp01(lit * fade)
    if (v <= 0.06) return
    const col = v > 0.7 ? 51 : v > 0.3 ? 39 : 19
    api.put(bx + lx, by + ly, ch, { color: col, bold: v > 0.6 })
  })
}

const VARIANTS = [vShimmer, vStars, vMatrix, vGradient, vGlitch, vSparkle, vNeon]

export function pickSplashVariant() { return Math.floor(Math.random() * VARIANTS.length) }

// Single-line shimmer used when the terminal is too small for the big banner.
function drawFallback(api, t) {
  const word = 'YAPPER', fade = fadeOut(t)
  const wx = Math.floor((api.W - word.length) / 2), wy = Math.floor(api.H / 2)
  for (let i = 0; i < word.length; i++) {
    const wave = (Math.sin(i * 0.6 - t / 110) + 1) / 2
    const v = clamp01((0.5 + 0.5 * wave) * fade)
    if (v > 0.04) api.put(wx + i, wy, word[i], { color: blueAt(v), bold: v > 0.7 })
  }
}

export function drawSplash(api, sp, t) {
  api.fill()
  if (api.W < BW + 4 || api.H < BH + 5) { drawFallback(api, t); return }
  ;(VARIANTS[sp.variant] || VARIANTS[0])(api, sp, t)
}
