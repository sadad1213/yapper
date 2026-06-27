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

/** Play the local mute / unmute feedback.  Call when the local mic toggle
 *  flips so the user hears confirmation through their speakers. */
export async function notifyMuted()   { playSystemSound(await loadSound('mute')) }
export async function notifyUnmuted() { playSystemSound(await loadSound('unmute')) }
