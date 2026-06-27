// Tracks which room names exist (membership is tracked in ws-server via clients map)
import Conf from 'conf'

const config = new Conf({ projectName: 'yapper' })

const DEFAULTS = ['general', 'gaming', 'music']

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
