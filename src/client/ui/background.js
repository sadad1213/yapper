// Animated backgrounds for the main TUI screen.
//
// These paint *only* into cells the UI left blank (empty chat rows, the space
// below the member list, idle "no room" areas) — never over text or borders — so
// they add subtle motion without hurting readability. Everything is dim and blue
// to sit behind the interface, not fight it. The caller (ui/app.js) walks the
// blank interior cells each frame and asks bgCell() what, if anything, to draw.

const MODES = ['off', 'stars', 'rain', 'aurora']
export const BG_MODES = MODES
export const BG_LABELS = { off: 'off', stars: 'starfield', rain: 'rain', aurora: 'aurora' }

// Step the setting forward/back through the list (used by the ‹ › control).
export function nextBgMode(mode, dir) {
  const i = Math.max(0, MODES.indexOf(mode))
  return MODES[(i + dir + MODES.length) % MODES.length]
}

// Stable per-cell noise in [0,1) — keeps each cell's role (is-a-star, stream
// offset) fixed across frames so the motion is coherent, not random sparkle.
function rnd(a, b) {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// 1) Starfield — a sparse scatter of twinkling dim-blue stars.
function bgStars(x, y, t) {
  const r = rnd(x, y)
  if (r > 0.05) return null                       // ~5% of blank cells are stars
  const tw = (Math.sin(t / 700 + r * 120) + 1) / 2
  if (tw < 0.4) return null                        // twinkle: dark half stays blank
  const ch = tw > 0.85 ? '✦' : tw > 0.62 ? '•' : '·'
  return { ch, attr: { color: tw > 0.8 ? 39 : 25, dim: tw < 0.7 } }
}

// 2) Rain — faint vertical streams trickling down a fraction of the columns.
const RAIN_P = 16
function bgRain(x, y, t) {
  if (rnd(x, 90) > 0.45) return null               // only ~45% of columns rain
  const speed = 1.2 + rnd(x, 7) * 2.0              // rows per second
  const head = (t / 1000) * speed + rnd(x, 8) * RAIN_P
  let d = (y - head) % RAIN_P
  d = ((d % RAIN_P) + RAIN_P) % RAIN_P             // distance below the drop head
  const trail = 6
  if (d > trail) return null
  const v = 1 - d / trail
  if (v < 0.12) return null
  const ch = d < 1 ? '│' : v > 0.5 ? '┊' : '·'
  return { ch, attr: { color: d < 1 ? 45 : v > 0.5 ? 31 : 24, dim: v < 0.55 } }
}

// 3) Aurora — slow overlapping sine waves form soft drifting blue bands.
function bgAurora(x, y, t) {
  const v = (Math.sin(x * 0.10 + t / 1100) + Math.sin(y * 0.34 - t / 1500) + Math.sin((x + y) * 0.06 + t / 1900)) / 3
  const n = (v + 1) / 2
  if (n < 0.62) return null                        // only wave crests are drawn
  const ch = n > 0.82 ? '▒' : '░'
  return { ch, attr: { color: n > 0.82 ? 25 : 18, dim: n < 0.8 } }
}

// Returns { ch, attr } to paint at (x,y), or null to leave the cell blank.
export function bgCell(mode, x, y, t) {
  switch (mode) {
    case 'stars':  return bgStars(x, y, t)
    case 'rain':   return bgRain(x, y, t)
    case 'aurora': return bgAurora(x, y, t)
    default:       return null
  }
}
