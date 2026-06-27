// Tracks which room names exist (membership is tracked in ws-server via clients map)
import Conf from 'conf'

const config = new Conf({ projectName: 'yapper' })

export const DEFAULTS = ['general', 'gaming', 'music']

export const rooms = new Set(DEFAULTS)

// Restore custom rooms saved from a previous host session
const saved = config.get('rooms', [])
if (Array.isArray(saved)) saved.forEach(name => rooms.add(name))

function persist() {
  const custom = [...rooms].filter(r => !DEFAULTS.includes(r))
  config.set('rooms', custom)
}

export function addRoom(name) {
  rooms.add(name)
  persist()
}

export function hasRoom(name) {
  return rooms.has(name)
}

// Remove a custom room.  Default rooms are permanent and cannot be deleted.
export function deleteRoom(name) {
  if (DEFAULTS.includes(name)) return false
  if (!rooms.has(name)) return false
  rooms.delete(name)
  persist()
  return true
}
