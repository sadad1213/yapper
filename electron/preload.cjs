// Preload bridge — the only surface the renderer can touch. Exposes a minimal,
// typed-ish `window.yapper` API over IPC; no Node primitives leak into the page
// (contextIsolation on, nodeIntegration off).

const { contextBridge, ipcRenderer } = require('electron')

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)   // unsubscribe
}

contextBridge.exposeInMainWorld('yapper', {
  // Subscriptions (return an unsubscribe fn).
  onState: (cb) => on('state', cb),
  onMicLevel: (cb) => on('mic-level', cb),
  onMicTestLevel: (cb) => on('mic-test-level', cb),
  onUpdateProgress: (cb) => on('update-progress', cb),

  // Fire-and-forget room/chat/identity actions.
  action: (type, payload) => ipcRenderer.send('action', { type, payload }),
  join: (room) => ipcRenderer.send('action', { type: 'join', payload: room }),
  leave: () => ipcRenderer.send('action', { type: 'leave' }),
  create: (room) => ipcRenderer.send('action', { type: 'create', payload: room }),
  remove: (room) => ipcRenderer.send('action', { type: 'delete', payload: room }),
  chat: (text) => ipcRenderer.send('action', { type: 'chat', payload: text }),
  setMuted: (muted) => ipcRenderer.send('action', { type: 'mute', payload: muted }),
  quit: () => ipcRenderer.send('action', { type: 'quit' }),

  // Request/response settings + devices.
  getSettings: () => ipcRenderer.invoke('getSettings'),
  setUsername: (name) => ipcRenderer.invoke('setUsername', name),
  setVadThreshold: (v) => ipcRenderer.invoke('setVadThreshold', v),
  setDenoise: (on) => ipcRenderer.invoke('setDenoise', on),
  getUserVolume: (id) => ipcRenderer.invoke('getUserVolume', id),
  setUserVolume: (userId, vol) => ipcRenderer.invoke('setUserVolume', { userId, vol }),
  listInputDevices: () => ipcRenderer.invoke('listInputDevices'),
  setInputDevice: (id) => ipcRenderer.invoke('setInputDevice', id),
  micTestStart: () => ipcRenderer.invoke('micTest:start'),
  micTestStop: () => ipcRenderer.invoke('micTest:stop'),

  // Updates + external links.
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  fetchChangelog: (ver) => ipcRenderer.invoke('fetchChangelog', ver),
  runUpdate: () => ipcRenderer.send('runUpdate'),
  openExternal: (url) => ipcRenderer.send('openExternal', url),
})
