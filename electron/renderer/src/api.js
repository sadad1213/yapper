// Thin wrapper over the preload bridge. When the page is opened outside Electron
// (e.g. plain `vite` in a browser) window.yapper is absent — fall back to no-ops
// so the UI still renders for layout work.
const noop = () => {}
const stub = {
  onState: noop, onMicLevel: noop, onMicTestLevel: noop, onUpdateProgress: noop,
  join: noop, leave: noop, create: noop, remove: noop, chat: noop, setMuted: noop, setDeafened: noop, quit: noop,
  getSettings: async () => ({ username: 'you', vadThreshold: 200, vadMin: 50, vadMax: 3000, denoise: true, muteHotkey: 'off', userVolumes: {} }),
  setUsername: async (n) => n, setVadThreshold: async (v) => v, setDenoise: async (o) => o,
  getUserVolume: async () => 100, setUserVolume: async () => 100,
  listInputDevices: async () => [{ id: -1, name: 'default' }], setInputDevice: async () => true,
  micTestStart: async () => false, micTestStop: async () => true,
  checkUpdate: async () => null, fetchChangelog: async () => null, runUpdate: noop, openExternal: noop,
}

export const api = (typeof window !== 'undefined' && window.yapper) ? window.yapper : stub
