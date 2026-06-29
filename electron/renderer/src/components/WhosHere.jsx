import React from 'react'

// Middle column — participants of the current room with talking/mute state, plus
// your own live mic meter at the bottom (fed by 'mic-level').
export default function WhosHere({ state, room, talking, micLevel, onUserClick }) {
  if (!state.currentRoom || !room) {
    return (
      <section className="whos">
        <div className="col-head">who’s here</div>
        <div className="empty">no room</div>
      </section>
    )
  }

  const others = (room.users || []).filter((u) => u.id !== state.userId)
  const selfTalking = !state.muted && micLevel > 0.05

  return (
    <section className="whos">
      <div className="col-head">{state.currentRoom} <span className="dim">· {room.users?.length || 0} online</span></div>
      <div className="members">
        <Row name={`${state.username} (you)`} self talking={selfTalking} muted={state.muted} />
        {others.map((u) => (
          <Row key={u.id} name={u.name} talking={talking.has(u.id)} muted={u.muted}
               onClick={() => onUserClick(u)} />
        ))}
      </div>
      <div className="mic">
        {state.muted ? (
          <span className="mic-muted">your mic · muted</span>
        ) : (
          <>
            <span className="mic-label">your mic</span>
            <div className="meter"><div className="meter-fill" style={{ width: `${Math.round(micLevel * 100)}%` }} /></div>
          </>
        )}
      </div>
    </section>
  )
}

function Row({ name, self, talking, muted, onClick }) {
  const icon = muted ? '⊘' : talking ? '◉' : '○'
  const cls = muted ? 'muted' : talking ? 'talking' : 'idle'
  return (
    <div className={`urow ${self ? 'self' : 'clickable'}`} onClick={onClick}>
      <span className={`uicon ${cls}`}>{icon}</span>
      <span className="uname">{name}</span>
    </div>
  )
}
