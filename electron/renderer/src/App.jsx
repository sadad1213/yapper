import React, { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import RoomsSidebar from './components/RoomsSidebar.jsx'
import WhosHere from './components/WhosHere.jsx'
import Chat from './components/Chat.jsx'
import Settings from './components/Settings.jsx'
import VolumePopup from './components/VolumePopup.jsx'
import StatusBar from './components/StatusBar.jsx'

const EMPTY = {
  rooms: [], currentRoom: null, username: '…', userId: null, muted: false,
  connected: false, serverAddr: null, talking: [], chat: {}, unread: {},
  audioAvailable: false, appVersion: '',
}

export default function App() {
  const [state, setState] = useState(EMPTY)
  const [settings, setSettings] = useState(null)
  const [micLevel, setMicLevel] = useState(0)        // own VU meter (decays locally)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [volumeUser, setVolumeUser] = useState(null) // { userId, username }
  const [confirmDelete, setConfirmDelete] = useState(null) // room name
  const [newRoomOpen, setNewRoomOpen] = useState(false)
  const [newRoomDraft, setNewRoomDraft] = useState('')
  const decay = useRef(null)

  // Subscriptions + initial settings load.
  useEffect(() => {
    const offState = api.onState(setState)
    const offLevel = api.onMicLevel((l) => setMicLevel((p) => Math.max(p, l)))
    api.getSettings().then(setSettings)
    return () => { offState?.(); offLevel?.() }
  }, [])

  // Smooth release of the mic meter, like the TUI's loop.
  useEffect(() => {
    decay.current = setInterval(() => setMicLevel((p) => (p > 0.01 ? p * 0.82 : 0)), 60)
    return () => clearInterval(decay.current)
  }, [])

  const talking = new Set(state.talking)
  const room = state.rooms.find((r) => r.name === state.currentRoom) || null

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">yapper</span>
        <span className={`conn ${state.connected ? 'on' : 'off'}`}>
          <span className="dot" />
          {state.connected ? (state.serverAddr || 'connected') : 'connecting…'}
        </span>
      </header>

      <main className="cols">
        <RoomsSidebar
          state={state}
          onJoin={(name) => name !== state.currentRoom && api.join(name)}
          onNewRoom={(name) => api.create(name)}
          onDelete={(name) => setConfirmDelete(name)}
          onUserClick={(u) => setVolumeUser({ userId: u.id, username: u.name })}
        />
        <WhosHere state={state} room={room} talking={talking} micLevel={micLevel}
                  onUserClick={(u) => setVolumeUser({ userId: u.id, username: u.name })} />
        <Chat state={state} room={room} />
      </main>

      <StatusBar
        state={state}
        onToggleMute={() => api.setMuted(!state.muted)}
        onNewRoom={() => { setNewRoomDraft(''); setNewRoomOpen(true) }}
        onSettings={() => setSettingsOpen(true)}
        onQuit={() => api.quit()}
      />

      {settingsOpen && settings && (
        <Settings settings={settings} state={state}
                  onChange={setSettings} onClose={() => setSettingsOpen(false)} />
      )}
      {volumeUser && (
        <VolumePopup user={volumeUser} onClose={() => setVolumeUser(null)} />
      )}
      {newRoomOpen && (
        <div className="overlay" onClick={() => setNewRoomOpen(false)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <h3>New room</h3>
            <input autoFocus maxLength={20} value={newRoomDraft} placeholder="room name"
                   onChange={(e) => setNewRoomDraft(e.target.value)}
                   onKeyDown={(e) => {
                     if (e.key === 'Enter') { const n = slugRoom(newRoomDraft); if (n) api.create(n); setNewRoomOpen(false) }
                     if (e.key === 'Escape') setNewRoomOpen(false)
                   }} />
            <div className="row gap mt">
              <button className="accent" onClick={() => { const n = slugRoom(newRoomDraft); if (n) api.create(n); setNewRoomOpen(false) }}>Create</button>
              <button onClick={() => setNewRoomOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {confirmDelete && (
        <div className="overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <h3>Delete room “{confirmDelete}”?</h3>
            <div className="row gap">
              <button className="danger" onClick={() => { api.remove(confirmDelete); setConfirmDelete(null) }}>Delete</button>
              <button onClick={() => setConfirmDelete(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function slugRoom(val) {
  return String(val).trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 20)
}
