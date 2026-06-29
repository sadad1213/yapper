// Detects room-level join / leave events by diffing the old and new room list
// after each `rooms` broadcast from the server.  Notifications fire *only* for
// the room the local user is currently sitting in — you won't hear sounds from
// other rooms.
//
// For update-found notifications, call `notifyUpdateFound()` directly (the UI
// already knows when an update check returns a newer version).

import { playSystemSound } from './playback.js'
import { loadSound } from './loader.js'

let _lastIds = new Set()       // userIds that were in the user's current room
let _lastRoom = null

// ─── helpers ──────────────────────────────────────────────────────────────

async function playJoinSound()  { playSystemSound(await loadSound('join')) }
async function playLeaveSound() { playSystemSound(await loadSound('leave')) }

// Local feedback for the user's OWN leave action (ESC or switching rooms).
// Fires in addition to the other-user leave detection so you reliably hear
// something even when testing solo.
export async function notifyLeaving() { playSystemSound(await loadSound('leave')) }

// ─── public ───────────────────────────────────────────────────────────────

/** Call this every time the `rooms` snapshot arrives. */
export function notifyRoomsChanged(newRooms, currentRoom, selfId) {
  if (!currentRoom || !selfId) {
    _lastIds.clear()
    _lastRoom = null
    return
  }

  const room = newRooms?.find(r => r.name === currentRoom)
  const nowIds = new Set((room?.users ?? []).map(u => u.id))

  // Just entered or switched rooms — seed the baseline so existing occupants
  // don't trigger spurious join sounds.
  if (_lastRoom !== currentRoom) {
    _lastRoom = currentRoom
    _lastIds = nowIds
    return
  }

  // Joined since last snapshot (exclude self)
  for (const id of nowIds) {
    if (!_lastIds.has(id) && id !== selfId) {
      playJoinSound()    // fire-and-forget — cached after first load
      break
    }
  }

  // Left since last snapshot (exclude self)
  for (const id of _lastIds) {
    if (!nowIds.has(id) && id !== selfId) {
      playLeaveSound()
      break
    }
  }

  _lastIds = nowIds
}

/** Play the "update available" chime. Safe to call at any time. */
export async function notifyUpdateFound() {
  playSystemSound(await loadSound('update'))
}

// Resample 48 kHz mono PCM to shift pitch (and tempo) by `factor`: >1 raises the
// pitch (shorter), <1 lowers it. Linear interpolation — plenty for a short SFX.
function pitchShift(pcm, factor) {
  if (!pcm || pcm.length < 2 || factor === 1) return pcm
  const inN = pcm.length >> 1
  const outN = Math.max(1, Math.floor(inN / factor))
  const out = Buffer.alloc(outN * 2)
  for (let i = 0; i < outN; i++) {
    const sp = i * factor
    const i0 = Math.floor(sp), i1 = Math.min(i0 + 1, inN - 1), fr = sp - i0
    const s = pcm.readInt16LE(i0 * 2) * (1 - fr) + pcm.readInt16LE(i1 * 2) * fr
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2)
  }
  return out
}

async function playPitched(sound, factor) { playSystemSound(pitchShift(await loadSound(sound), factor)) }

// Mic mute/unmute → piano (mus_piano5.wav), deafen/undeafen → swipe (mus_sfx_swipe.wav)
// Each pair pitched apart by 1.0:
//   mute 0.70  ·  unmute 1.70
//   deafen 0.70  ·  undeafen 1.70
/** Local mic mute / unmute feedback. */
export async function notifyMuted()      { playPitched('mute', 1.00) }
export async function notifyUnmuted()    { playPitched('mute', 2.00) }
/** Deafen on/off feedback. */
export async function notifyDeafened()    { playPitched('swipe', 0.70) }
export async function notifyUndeafened()  { playPitched('swipe', 1.70) }
