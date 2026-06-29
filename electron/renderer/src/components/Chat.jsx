import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

const URL_RE = /(https?:\/\/[^\s]+)/gi
const IS_URL = /^https?:\/\//i
const MAX_CHATMSG = 300

// Right column — the current room's chat: scrollable history that sticks to the
// bottom, clickable links (opened in the OS browser), own messages tinted, and a
// composer.
export default function Chat({ state, room }) {
  const [draft, setDraft] = useState('')
  const histRef = useRef(null)
  const stick = useRef(true)

  const msgs = (state.currentRoom && state.chat[state.currentRoom]) || []

  // Keep pinned to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = histRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [msgs.length, state.currentRoom])

  const onScroll = () => {
    const el = histRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const send = () => {
    const text = draft.trim()
    if (!text) return
    api.chat(text)
    setDraft(''); stick.current = true
  }

  if (!state.currentRoom || !room) {
    return (
      <section className="chat">
        <div className="col-head">chat</div>
        <div className="empty">join a room to chat</div>
      </section>
    )
  }

  return (
    <section className="chat">
      <div className="col-head">chat</div>
      <div className="history" ref={histRef} onScroll={onScroll}>
        {msgs.map((m, i) => (
          <div key={`${m.ts}-${m.userId}-${i}`} className={`msg ${m.userId === state.userId ? 'own' : ''}`}>
            <span className="who">{m.name || '?'}</span>
            <span className="text">{renderText(m.text)}</span>
          </div>
        ))}
      </div>
      <div className="composer">
        <input value={draft} maxLength={MAX_CHATMSG} placeholder="type a message…"
               onChange={(e) => setDraft(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') send() }} />
        <button onClick={send} disabled={!draft.trim()}>Send</button>
      </div>
    </section>
  )
}

// Split a message into text + clickable link spans.
function renderText(text) {
  const parts = String(text).split(URL_RE)
  return parts.map((p, i) =>
    IS_URL.test(p)
      ? <a key={i} className="link" href="#" onClick={(e) => { e.preventDefault(); api.openExternal(p) }}>{p}</a>
      : <React.Fragment key={i}>{p}</React.Fragment>
  )
}
