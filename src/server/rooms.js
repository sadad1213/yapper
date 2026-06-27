// Tracks which room names exist (membership is tracked in ws-server via clients map)
export const rooms = new Set(['general', 'gaming', 'music'])

export function addRoom(name) {
  rooms.add(name)
}

export function hasRoom(name) {
  return rooms.has(name)
}
