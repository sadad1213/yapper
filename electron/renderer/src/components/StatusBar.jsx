import React from 'react'

// Bottom action bar — mirrors the TUI's status line shortcuts.
export default function StatusBar({ state, onToggleMute, onNewRoom, onSettings, onQuit }) {
  return (
    <footer className="statusbar">
      <button className={state.muted ? 'mute on' : 'mute'} onClick={onToggleMute}>
        {state.muted ? '🔇 unmute' : '🎙 mute'}
      </button>
      <button onClick={onNewRoom}>+ new room</button>
      <button onClick={onSettings}>⚙ settings</button>
      <div className="spacer" />
      <button className="ghost" onClick={onQuit}>quit</button>
      <span className="version">v{state.appVersion}</span>
    </footer>
  )
}
