import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

// Settings overlay — username, input device, mic test, VAD sensitivity, noise
// suppression, and update check. Mirrors the TUI settings modal.
export default function Settings({ settings, state, onChange, onClose }) {
  const [name, setName] = useState(settings.username)
  const [devices, setDevices] = useState([])
  const [deviceId, setDeviceId] = useState(-1)
  const [testing, setTesting] = useState(false)
  const [testLevel, setTestLevel] = useState(0)
  const [vad, setVad] = useState(settings.vadThreshold)
  const [denoise, setDenoise] = useState(settings.denoise)
  const [check, setCheck] = useState(null)        // null | 'checking' | {ver} | 'latest' | 'failed'
  const offLevel = useRef(null)

  useEffect(() => {
    api.listInputDevices().then((d) => { setDevices(d); if (d[0]) setDeviceId(d[0].id) })
    return () => { api.micTestStop(); offLevel.current?.() }
  }, [])

  const patch = (p) => onChange({ ...settings, ...p })

  const saveName = () => { api.setUsername(name).then((u) => { setName(u); patch({ username: u }) }) }

  const toggleTest = async () => {
    if (testing) { await api.micTestStop(); offLevel.current?.(); offLevel.current = null; setTesting(false); setTestLevel(0); return }
    const ok = await api.micTestStart()
    if (!ok) return
    offLevel.current = window.yapper?.onMicTestLevel((l) => setTestLevel((p) => Math.max(p * 0.6, l)))
    setTesting(true)
  }

  const changeVad = (v) => { setVad(v); api.setVadThreshold(v); patch({ vadThreshold: v }) }
  const changeDenoise = (on) => { setDenoise(on); api.setDenoise(on); patch({ denoise: on }) }
  const changeDevice = (id) => { setDeviceId(id); api.setInputDevice(id) }

  const doCheck = async () => {
    setCheck('checking')
    const ver = await api.checkUpdate()
    setCheck(ver ? { ver } : 'latest')
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>settings</h3>

        <label>username</label>
        <div className="row gap">
          <input value={name} maxLength={16} onChange={(e) => setName(e.target.value)}
                 onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && saveName()} />
        </div>

        <label>microphone</label>
        <select value={deviceId} onChange={(e) => changeDevice(Number(e.target.value))}
                disabled={!state.audioAvailable}>
          {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>

        <label>mic test</label>
        <div className="row gap">
          <button onClick={toggleTest} disabled={!state.audioAvailable}>
            {testing ? '■ stop' : '▶ test microphone'}
          </button>
          <div className="meter grow"><div className="meter-fill" style={{ width: `${Math.round(testLevel * 100)}%` }} /></div>
        </div>
        {!state.audioAvailable && <div className="hint warn">no audio backend available</div>}

        <label>mic sensitivity <span className="dim">({vad})</span></label>
        <input type="range" min={settings.vadMin} max={settings.vadMax} step="50" value={vad}
               onChange={(e) => changeVad(Number(e.target.value))} />

        <label className="row between">
          <span>noise suppression</span>
          <input type="checkbox" checked={denoise} onChange={(e) => changeDenoise(e.target.checked)} />
        </label>

        <label>updates</label>
        <div className="row gap">
          <button onClick={doCheck}>{check === 'checking' ? '⟳ checking…' : '▶ check for updates'}</button>
          {check && check !== 'checking' && (
            check === 'latest' ? <span className="ok">✓ up to date</span>
            : check === 'failed' ? <span className="warn">× check failed</span>
            : <button className="accent" onClick={() => api.runUpdate()}>install v{check.ver}</button>
          )}
        </div>

        <div className="row end mt">
          <button onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  )
}
