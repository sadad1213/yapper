// Detects room-level join / leave events by diffing the old and new room list
// after each `rooms` broadcast from the server.  Notifications fire *only* for
// the room the local user is currently sitting in — you won't hear sounds from
// other rooms.
//
// For update-found notifications, call `notifyUpdateFound()` directly (the UI
// already knows when an update check returns a newer version).

import { playSystemSound } from './playback.js'
import { joinPCM, leavePCM, updatePCM } from './sounds.js'

let _lastIds = new Set()       // userIds that were in the user's current room
let _lastRoom = null

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
      playSystemSound(joinPCM())
      break   // one beep per batch, even if multiple people joined
    }
  }

  // Left since last snapshot (exclude self)
  for (const id of _lastIds) {
    if (!nowIds.has(id) && id !== selfId) {
      playSystemSound(leavePCM())
      break
    }
  }

  _lastIds = nowIds
}

/** Play the "update available" chime. Safe to call at any time. */
export function notifyUpdateFound() {
  playSystemSound(updatePCM())
}
