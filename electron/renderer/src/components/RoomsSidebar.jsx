import React, { useState } from 'react'
import { slugRoom } from '../App.jsx'

const DEFAULT_ROOMS = new Set(['general', 'gaming', 'music'])

// Left column — every room and who's in each, like the TUI's room tree. Members
// are shown under every room (not just the current one); your own row is marked.
export default function RoomsSidebar({ state, onJoin, onNewRoom, onDelete, onUserClick }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const submit = () => {
    const name = slugRoom(draft)
    if (name) onNewRoom(name)
    setDraft(''); setAdding(false)
  }

  return (
    <aside className="rooms">
      <div className="col-head">ROOMS</div>
      <div className="rooms-list">
        {state.rooms.map((r) => {
          const cur = r.name === state.currentRoom
          const unread = state.unread[r.name] || 0
          const members = orderedMembers(r, state)
          return (
            <div key={r.name} className="room-group">
              <button className={`room ${cur ? 'current' : ''}`} onClick={() => onJoin(r.name)}>
                <span className="room-name">{cur ? '▸ ' : ''}{r.name}</span>
                <span className="room-meta">
                  {unread > 0 && !cur && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
                  <span className="count">{r.users?.length || 0}</span>
                  {cur && !DEFAULT_ROOMS.has(r.name) && (
                    <span className="del" title="Delete room"
                          onClick={(e) => { e.stopPropagation(); onDelete(r.name) }}>✕</span>
                  )}
                </span>
              </button>
              {members.map((u, i) => (
                <div key={u.id ?? i}
                     className={`member ${u.self ? 'self' : ''}`}
                     onClick={() => !u.self && onUserClick(u)}>
                  <span className="branch">{i === members.length - 1 ? '└─' : '├─'}</span>
                  <span className="mname">{u.name}{u.self ? ' (you)' : ''}</span>
                  {u.muted && <span className="mmute">⊘</span>}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      <div className="rooms-foot">
        {adding ? (
          <input autoFocus className="newroom-input" maxLength={20} value={draft}
                 placeholder="room name"
                 onChange={(e) => setDraft(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setAdding(false); setDraft('') } }}
                 onBlur={() => { setAdding(false); setDraft('') }} />
        ) : (
          <button className="newroom" onClick={() => setAdding(true)}>+ new room</button>
        )}
      </div>
    </aside>
  )
}

// Self prepended only for the room we're actually in (matches the TUI).
function orderedMembers(room, state) {
  const members = (room.users || []).map((u) => ({ ...u }))
  const idx = members.findIndex((u) => u.id === state.userId)
  if (idx >= 0) {
    const self = members.splice(idx, 1)[0]
    members.unshift({ ...self, self: true })
  }
  return members
}
