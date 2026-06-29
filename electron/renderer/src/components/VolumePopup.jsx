import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

// Per-user playback volume (0–200%), applied live and persisted on close — same
// behaviour as the TUI's volume popup.
export default function VolumePopup({ user, onClose }) {
  const [vol, setVol] = useState(100)

  useEffect(() => { api.getUserVolume(user.userId).then((v) => setVol(v ?? 100)) }, [user.userId])

  const change = (v) => {
    setVol(v)
    api.setUserVolume(user.userId, v)   // live + persisted
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <h3>volume · {user.username}</h3>
        <input type="range" min="0" max="200" step="10" value={vol}
               onChange={(e) => change(Number(e.target.value))} />
        <div className="vol-val">{vol}%</div>
        <div className="row gap">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
