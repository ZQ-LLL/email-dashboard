import { useState, useEffect, useRef } from 'react'

const API = 'http://localhost:3001'
const TABS       = ['All', 'Academic', 'Social', 'Career', 'Deadline', 'Other', 'Starred']
const CATEGORIES = ['Academic', 'Social', 'Career', 'Deadline', 'Other']

const BADGE = {
  Academic: 'bg-blue-100 text-blue-700',
  Social:   'bg-green-100 text-green-700',
  Career:   'bg-purple-100 text-purple-700',
  Deadline: 'bg-red-100 text-red-700',
  Other:    'bg-gray-100 text-gray-600',
}

// ISO date-only strings (e.g. "2025-04-15") are parsed as UTC midnight by browsers,
// which causes off-by-one day issues in negative-offset timezones. Append T00:00 to force local.
function localDate(dt) {
  if (!dt) return null
  const s = /^\d{4}-\d{2}-\d{2}$/.test(dt) ? dt + 'T00:00' : dt
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function isExpired(dt) {
  const d = localDate(dt)
  return !!d && d < new Date()
}

// Returns a human-readable date string, or the raw string if unparseable.
function formatDate(dt) {
  if (!dt) return null
  const d = localDate(dt)
  if (!d) return dt
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    ...(hasTime && { hour: 'numeric', minute: '2-digit' }),
  })
}

// Converts a stored datetime string to the "YYYY-MM-DDTHH:mm" format required by <input type="datetime-local">.
function toDatetimeLocal(dt) {
  if (!dt) return ''
  const d = localDate(dt)
  if (!d) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const DOT_COLOR = {
  Academic: 'bg-blue-400',
  Social:   'bg-green-400',
  Career:   'bg-purple-400',
  Deadline: 'bg-red-400',
  Other:    'bg-gray-400',
}

function parseEventDate(dt) {
  return localDate(dt)
}

function toDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Paste into Gmail's search bar to find the exact email
function gmailSearchQuery(source) {
  if (!source || typeof source === 'string') return null
  return source.msgIdHeader ? `rfc822msgid:${source.msgIdHeader}` : null
}

// Paste into Outlook (or any client) search bar
function emailSubject(source) {
  if (!source || typeof source === 'string') return null
  return source.subject || null
}

function CopyBtn({ label, text, active, onCopy }) {
  return (
    <button
      onClick={() => onCopy(text)}
      className="text-xs text-gray-400 hover:text-gray-600 border border-gray-200 rounded px-1.5 py-0.5 cursor-pointer transition-colors whitespace-nowrap"
    >
      {active ? '✓ Copied' : label}
    </button>
  )
}

// Best-effort Gmail link — may open the wrong account for Workspace SSO users.
// Use gmailSearchQuery() as a reliable fallback.
function gmailUrl(source) {
  if (!source) return 'https://mail.google.com/mail/'
  if (typeof source === 'object' && source.msgIdHeader) {
    return `https://mail.google.com/mail/#search/rfc822msgid:${encodeURIComponent(source.msgIdHeader)}`
  }
  const id = typeof source === 'string' ? source : (source.threadId || source.id)
  return `https://mail.google.com/mail/u/0/#all/${id}`
}

// ── Detail / Edit Modal ──
function EventModal({ event, onClose, onStar, onSave, onDelete, userEmail }) {
  const [isEditing, setIsEditing]   = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [form, setForm] = useState({
    name:        event.name        || '',
    description: event.description || '',
    datetime:    toDatetimeLocal(event.datetime),
    location:    event.location    || '',
    link:        event.link        || '',
    category:    event.category    || 'Other',
  })

  useEffect(() => {
    if (!isEditing) {
      setForm({
        name:        event.name        || '',
        description: event.description || '',
        datetime:    toDatetimeLocal(event.datetime),
        location:    event.location    || '',
        link:        event.link        || '',
        category:    event.category    || 'Other',
      })
    }
  }, [event, isEditing])

  const sources  = JSON.parse(event.source_emails || '[]')
  const expired  = isExpired(event.datetime)
  const [copied, setCopied] = useState(null) // key: e.g. 'gmail-0', 'subject-1'

  function copy(key, text) {
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 2000)
    })
  }

  function textField(label, key, placeholder = '', multiline = false) {
    const cls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-200'
    return (
      <div>
        <label className="text-xs font-medium text-gray-500 block mb-1">{label}</label>
        {multiline
          ? <textarea rows={3} value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} placeholder={placeholder} className={cls} />
          : <input   value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} placeholder={placeholder} className={cls} />
        }
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-6">
          {/* Modal header */}
          <div className="flex items-center justify-between mb-4">
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${BADGE[event.category] || BADGE.Other}`}>
              {event.category || 'Other'}
            </span>
            <div className="flex items-center gap-3">
              {expired && <span className="text-xs text-gray-400 italic">Expired</span>}
              <button onClick={() => onStar(event.id)} className="text-lg leading-none cursor-pointer hover:scale-110 transition-transform">
                {event.starred ? '⭐' : '☆'}
              </button>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600 cursor-pointer text-xl leading-none">✕</button>
            </div>
          </div>

          {isEditing ? (
            // ── Edit mode ──
            <div className="flex flex-col gap-3">
              {textField('Event Name', 'name')}
              <div>
                <label className="text-xs font-medium text-gray-500 block mb-1">Category</label>
                <select
                  value={form.category}
                  onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none cursor-pointer"
                >
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              {textField('Description', 'description', 'Brief description of the event...', true)}
              <div>
                <label className="text-xs font-medium text-gray-500 block mb-1">Date / Time</label>
                <input
                  type="datetime-local"
                  value={form.datetime}
                  onChange={e => setForm(p => ({ ...p, datetime: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>
              {textField('Location',    'location',    'e.g. Room 101, Building A')}
              {textField('External Link', 'link',      'https://...')}
              <div className="flex gap-2 mt-1">
                <button
                  onClick={() => { onSave(event.id, form); setIsEditing(false) }}
                  className="flex-1 bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold py-2 rounded-lg cursor-pointer transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => setIsEditing(false)}
                  className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold py-2 rounded-lg cursor-pointer transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            // ── View mode ──
            <div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">{event.name}</h2>

              {event.description && (
                <p className="text-sm text-gray-600 mb-4 leading-relaxed">{event.description}</p>
              )}

              <div className="flex flex-col gap-2 mb-4">
                {event.datetime && (
                  <p className="text-sm text-gray-600 flex items-center gap-2">🕐 {formatDate(event.datetime)}</p>
                )}
                {event.location && (
                  <p className="text-sm text-gray-600 flex items-center gap-2">📍 {event.location}</p>
                )}
                {event.link && (
                  <p className="text-sm flex items-start gap-2">
                    🔗 <a href={event.link} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline break-all">{event.link}</a>
                  </p>
                )}
              </div>

              {/* Source emails */}
              <div className="pt-4 border-t border-gray-100">
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
                  Source email{sources.length > 1 ? `s (${sources.length})` : ''}
                </p>
                <div className="flex flex-col gap-2">
                  {sources.map((src, i) => {
                    const gmailQ   = gmailSearchQuery(src)
                    const subjectQ = emailSubject(src)
                    return (
                      <div key={i}>
                        <a
                          href={gmailUrl(src)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-blue-500 hover:text-blue-700 hover:underline"
                        >
                          View {sources.length > 1 ? `email ${i + 1}` : 'in Gmail'} →
                        </a>
                        {(gmailQ || subjectQ) && (
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <span className="text-xs text-gray-400">Copy search:</span>
                            {gmailQ && (
                              <CopyBtn
                                label="Gmail"
                                text={gmailQ}
                                active={copied === `gmail-${i}`}
                                onCopy={t => copy(`gmail-${i}`, t)}
                              />
                            )}
                            {subjectQ && (
                              <CopyBtn
                                label="Outlook / other"
                                text={subjectQ}
                                active={copied === `subject-${i}`}
                                onCopy={t => copy(`subject-${i}`, t)}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <p className="text-xs text-gray-400 mt-3 leading-relaxed">
                  If the link opens the wrong account: use <strong>Gmail</strong> to paste into Gmail's search bar,
                  or <strong>Outlook / other</strong> to search by subject in any mail client.
                </p>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => setIsEditing(true)}
                  className="flex-1 border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium py-2 rounded-lg cursor-pointer transition-colors"
                >
                  ✏️ Edit
                </button>
                {confirmDel ? (
                  <>
                    <button
                      onClick={() => onDelete(event.id)}
                      className="flex-1 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold py-2 rounded-lg cursor-pointer transition-colors"
                    >
                      Confirm delete
                    </button>
                    <button
                      onClick={() => setConfirmDel(false)}
                      className="px-4 border border-gray-200 hover:bg-gray-50 text-gray-500 text-sm py-2 rounded-lg cursor-pointer transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDel(true)}
                    className="px-4 border border-red-200 hover:bg-red-50 text-red-500 text-sm py-2 rounded-lg cursor-pointer transition-colors"
                  >
                    🗑️
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Event Card ──
function EventCard({ event, onSelect, onStar, userEmail }) {
  const expired = isExpired(event.datetime)
  const sources = JSON.parse(event.source_emails || '[]')

  return (
    <div
      onClick={() => onSelect(event.id)}
      className={`bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-2 shadow-sm cursor-pointer hover:border-gray-300 hover:shadow-md transition-all ${expired ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${BADGE[event.category] || BADGE.Other}`}>
          {event.category || 'Other'}
        </span>
        <button
          onClick={e => { e.stopPropagation(); onStar(event.id) }}
          className="text-lg leading-none cursor-pointer hover:scale-110 transition-transform"
        >
          {event.starred ? '⭐' : '☆'}
        </button>
      </div>

      <h3 className="font-semibold text-gray-900 text-[15px] leading-snug">{event.name}</h3>

      {event.description && (
        <p className="text-sm text-gray-500 line-clamp-2 leading-relaxed">{event.description}</p>
      )}

      {event.datetime && (
        <p className="text-sm text-gray-400 flex items-center gap-1.5">🕐 {formatDate(event.datetime)}</p>
      )}
      {event.location && (
        <p className="text-sm text-gray-400 flex items-center gap-1.5">📍 {event.location}</p>
      )}

      <div className="flex items-center justify-between mt-auto pt-2">
        <a
          href={gmailUrl(sources[0])}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="text-sm text-blue-500 hover:underline"
        >
          View in Gmail →
        </a>
        {sources.length > 1 && (
          <span className="text-xs text-gray-400">{sources.length} emails</span>
        )}
      </div>

      {expired && <span className="text-xs text-gray-400 italic">Expired</span>}
    </div>
  )
}

// ── Event List Row ──
function EventRow({ event, onSelect, onStar, userEmail }) {
  const expired = isExpired(event.datetime)
  const sources = JSON.parse(event.source_emails || '[]')

  return (
    <div
      onClick={() => onSelect(event.id)}
      className={`flex items-center gap-3 px-4 py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer ${expired ? 'opacity-50' : ''}`}
    >
      <button
        onClick={e => { e.stopPropagation(); onStar(event.id) }}
        className="text-base cursor-pointer flex-shrink-0 leading-none"
      >
        {event.starred ? '⭐' : '☆'}
      </button>
      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${BADGE[event.category] || BADGE.Other}`}>
        {event.category || 'Other'}
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 text-sm truncate">{event.name}</p>
        {event.description && (
          <p className="text-xs text-gray-400 truncate mt-0.5">{event.description}</p>
        )}
      </div>
      {event.datetime && (
        <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:block">🕐 {formatDate(event.datetime)}</span>
      )}
      {event.location && (
        <span className="text-xs text-gray-400 flex-shrink-0 hidden md:block">📍 {event.location}</span>
      )}
      {sources.length > 1 && (
        <span className="text-xs text-gray-300 flex-shrink-0">{sources.length}×</span>
      )}
      <a
        href={gmailUrl(sources[0])}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        className="text-xs text-blue-500 hover:underline flex-shrink-0"
      >
        Gmail →
      </a>
    </div>
  )
}

// ── Calendar View ──
function CalendarView({ events, onSelect, onStar, userEmail }) {
  const today = new Date()
  const [year, setYear]       = useState(today.getFullYear())
  const [month, setMonth]     = useState(today.getMonth())
  const [pickedDay, setPickedDay] = useState(null)

  const byDate  = {}
  const undated = []
  for (const ev of events) {
    const d = parseEventDate(ev.datetime)
    if (d) {
      const key = toDateKey(d)
      ;(byDate[key] ??= []).push(ev)
    } else {
      undated.push(ev)
    }
  }

  const todayKey = toDateKey(today)

  function prevMonth() {
    setPickedDay(null)
    setMonth(m => { if (m === 0) { setYear(y => y - 1); return 11 } return m - 1 })
  }
  function nextMonth() {
    setPickedDay(null)
    setMonth(m => { if (m === 11) { setYear(y => y + 1); return 0 } return m + 1 })
  }

  const firstDow    = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const monthLabel  = new Date(year, month).toLocaleString('en-US', { month: 'long', year: 'numeric' })

  const cells = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  while (cells.length % 7) cells.push(null)

  const pickedKey    = pickedDay
    ? `${year}-${String(month + 1).padStart(2, '0')}-${String(pickedDay).padStart(2, '0')}`
    : null
  const pickedEvents = pickedKey ? (byDate[pickedKey] || []) : []

  return (
    <div>
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-3">
        <button onClick={prevMonth}
          className="px-3 py-1.5 rounded-lg hover:bg-gray-100 cursor-pointer text-gray-500 text-lg leading-none">
          ‹
        </button>
        <span className="text-sm font-semibold text-gray-800">{monthLabel}</span>
        <button onClick={nextMonth}
          className="px-3 py-1.5 rounded-lg hover:bg-gray-100 cursor-pointer text-gray-500 text-lg leading-none">
          ›
        </button>
      </div>

      {/* Calendar grid */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="grid grid-cols-7 border-b border-gray-100">
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
            <div key={d} className="py-2 text-center text-xs font-medium text-gray-400">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((day, i) => {
            if (!day) return (
              <div key={`e${i}`} className="h-[70px] border-b border-r border-gray-50 bg-gray-50/50 last:border-r-0" />
            )
            const key      = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            const dayEvs   = byDate[key] || []
            const isToday  = key === todayKey
            const isPicked = day === pickedDay

            return (
              <div
                key={day}
                onClick={() => setPickedDay(isPicked ? null : day)}
                className={`h-[70px] border-b border-r border-gray-100 p-1.5 cursor-pointer transition-colors
                  ${isPicked ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
              >
                <span className={`text-xs font-medium inline-flex items-center justify-center w-5 h-5 rounded-full
                  ${isToday ? 'bg-blue-500 text-white' : 'text-gray-700'}`}>
                  {day}
                </span>
                <div className="flex flex-wrap gap-[3px] mt-1 px-0.5">
                  {dayEvs.slice(0, 5).map((ev, j) => (
                    <span key={j} className={`w-[6px] h-[6px] rounded-full ${DOT_COLOR[ev.category] || 'bg-gray-400'}`} />
                  ))}
                  {dayEvs.length > 5 && (
                    <span className="text-[10px] text-gray-400 leading-[6px]">+{dayEvs.length - 5}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Dot legend */}
      <div className="flex items-center gap-4 mt-2 px-1 flex-wrap">
        {Object.entries(DOT_COLOR).map(([cat, cls]) => (
          <span key={cat} className="flex items-center gap-1 text-xs text-gray-400">
            <span className={`w-2 h-2 rounded-full ${cls}`} />
            {cat}
          </span>
        ))}
      </div>

      {/* Picked-day event list */}
      {pickedDay && (
        <div className="mt-5">
          <p className="text-sm font-medium text-gray-700 mb-2">
            {new Date(year, month, pickedDay).toLocaleDateString('en-US', {
              weekday: 'long', month: 'long', day: 'numeric',
            })}
            <span className="ml-2 text-xs text-gray-400 font-normal">
              {pickedEvents.length === 0 ? 'no events' : `${pickedEvents.length} event${pickedEvents.length !== 1 ? 's' : ''}`}
            </span>
          </p>
          {pickedEvents.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {pickedEvents.map(ev => (
                <EventRow key={ev.id} event={ev} onSelect={onSelect} onStar={onStar} userEmail={userEmail} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Undated events */}
      {undated.length > 0 && (
        <div className="mt-6">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
            No date · {undated.length}
          </p>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {undated.map(ev => (
              <EventRow key={ev.id} event={ev} onSelect={onSelect} onStar={onStar} userEmail={userEmail} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Chat Panel ──
function ChatPanel({ onClose }) {
  const [messages, setMessages]   = useState([])
  const [input, setInput]         = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    if (!input.trim() || streaming) return
    const text    = input.trim()
    const history = [...messages]
    setMessages(prev => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '', done: false }])
    setInput('')
    setStreaming(true)

    try {
      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: text, history }),
      })

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6)
          if (payload === '[DONE]') continue
          try {
            const { delta, error } = JSON.parse(payload)
            if (error) throw new Error(error)
            if (delta) {
              setMessages(prev => {
                const next = [...prev]
                const last = next[next.length - 1]
                next[next.length - 1] = { ...last, content: last.content + delta }
                return next
              })
            }
          } catch { /* skip malformed chunks */ }
        }
      }
    } catch (err) {
      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { role: 'assistant', content: `Sorry, something went wrong: ${err.message}`, done: true }
        return next
      })
    } finally {
      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { ...next[next.length - 1], done: true }
        return next
      })
      setStreaming(false)
    }
  }

  return (
    <div className="fixed bottom-20 right-6 w-80 bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col z-40 overflow-hidden"
      style={{ height: '420px' }}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
        <div>
          <p className="font-semibold text-gray-900 text-sm">Ask about your events</p>
          <p className="text-xs text-gray-400">Powered by Claude</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 cursor-pointer text-lg leading-none">✕</button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 text-sm mt-6">
            <p className="text-3xl mb-3">💬</p>
            <p className="font-medium text-gray-500">Ask me about your events</p>
            <p className="text-xs mt-2 text-gray-400">"Any career events this week?"</p>
            <p className="text-xs mt-1 text-gray-400">"When is the next deadline?"</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap
              ${msg.role === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-800'}`}>
              {msg.content}
              {msg.role === 'assistant' && !msg.done && (
                <span className="inline-block w-[2px] h-[14px] bg-gray-500 ml-0.5 align-middle animate-pulse" />
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-3 py-3 border-t border-gray-100 flex gap-2 flex-shrink-0">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder="Ask about events..."
          disabled={streaming}
          className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
        />
        <button
          onClick={send}
          disabled={streaming || !input.trim()}
          className="bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 text-white rounded-lg px-3 py-2 text-sm cursor-pointer disabled:cursor-not-allowed transition-colors font-medium"
        >
          ↑
        </button>
      </div>
    </div>
  )
}

// ── App ──
export default function App() {
  const [authStatus, setAuthStatus]     = useState('loading')
  const [userEmail, setUserEmail]       = useState(null)
  const [events, setEvents]             = useState([])
  const [analyzing, setAnalyzing]       = useState(false)
  const [loadingMore, setLoadingMore]   = useState(false)
  const [activeTab, setActiveTab]       = useState('All')
  const [search, setSearch]             = useState('')
  const [viewMode, setViewMode]         = useState('card')
  const [sortBy, setSortBy]             = useState('newest')
  const [error, setError]               = useState(null)
  const [analyzeInfo, setAnalyzeInfo]   = useState(null)
  const [selectedId, setSelectedId]     = useState(null)
  const [customDays, setCustomDays]     = useState('30')
  const [chatOpen, setChatOpen]         = useState(false)

  const selectedEvent = events.find(e => e.id === selectedId) || null

  useEffect(() => {
    fetch(`${API}/auth/status`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (data.loggedIn) {
          setAuthStatus('loggedIn')
          setUserEmail(data.userEmail)
          fetch(`${API}/api/events`, { credentials: 'include' })
            .then(r => r.json())
            .then(setEvents)
            .catch(() => {})
        } else {
          setAuthStatus('loggedOut')
        }
      })
      .catch(() => {
        setError('Cannot reach backend — make sure the server is running on port 3001')
        setAuthStatus('loggedOut')
      })
  }, [])

  async function runAnalysis({ days = 7, pageToken = null } = {}) {
    pageToken ? setLoadingMore(true) : setAnalyzing(true)
    setError(null)
    const url = `${API}/api/analyze?days=${days}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    try {
      const res  = await fetch(url, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setEvents(data.events)
      setAnalyzeInfo({ days: data.days, processed: data.processed, nextPageToken: data.nextPageToken })
    } catch (err) {
      setError(`Analysis failed: ${err.message}`)
    } finally {
      setAnalyzing(false)
      setLoadingMore(false)
    }
  }

  async function handleStar(id) {
    const res  = await fetch(`${API}/api/events/${id}/star`, { method: 'PATCH', credentials: 'include' })
    const data = await res.json()
    setEvents(prev => prev.map(e => e.id === id ? { ...e, starred: data.starred ? 1 : 0 } : e))
  }

  async function handleSave(id, form) {
    const res     = await fetch(`${API}/api/events/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(form),
    })
    const updated = await res.json()
    setEvents(prev => prev.map(e => e.id === id ? updated : e))
  }

  async function handleDelete(id) {
    await fetch(`${API}/api/events/${id}`, { method: 'DELETE', credentials: 'include' })
    setEvents(prev => prev.filter(e => e.id !== id))
    setSelectedId(null)
  }

  function handleLogout() {
    fetch(`${API}/auth/logout`, { credentials: 'include' })
      .then(() => { setEvents([]); setAnalyzeInfo(null); setAuthStatus('loggedOut') })
  }

  const displayed = (() => {
    let result = events
    if (activeTab === 'Starred') {
      result = result.filter(e => !!e.starred)
    } else if (activeTab !== 'All') {
      result = result.filter(e => e.category === activeTab)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(e =>
        e.name?.toLowerCase().includes(q) ||
        e.description?.toLowerCase().includes(q) ||
        e.location?.toLowerCase().includes(q) ||
        e.datetime?.toLowerCase().includes(q)
      )
    }
    return [...result].sort((a, b) => {
      if (sortBy === 'name')     return (a.name || '').localeCompare(b.name || '')
      if (sortBy === 'category') return (a.category || '').localeCompare(b.category || '')
      return b.id - a.id
    })
  })()

  const tabCount = tab => {
    if (tab === 'All')     return events.length
    if (tab === 'Starred') return events.filter(e => e.starred).length
    return events.filter(e => e.category === tab).length
  }

  if (authStatus === 'loading') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-400 text-sm">Loading...</p>
      </div>
    )
  }

  if (authStatus === 'loggedOut') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl shadow-lg p-12 text-center w-full max-w-sm">
          <div className="text-5xl mb-4">📬</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Email Dashboard</h1>
          <p className="text-gray-500 text-sm mb-8">Connect your Gmail to discover campus events</p>
          {error && <p className="text-red-600 bg-red-50 rounded-lg px-4 py-2 text-sm mb-6">{error}</p>}
          <a href={`${API}/auth/login`} className="block">
            <button className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold px-6 py-3 rounded-xl transition-colors cursor-pointer">
              Connect Gmail
            </button>
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {selectedEvent && (
        <EventModal
          event={selectedEvent}
          onClose={() => setSelectedId(null)}
          onStar={handleStar}
          onSave={handleSave}
          onDelete={handleDelete}
          userEmail={userEmail}
        />
      )}

      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
          <span className="text-xl">📬</span>
          <h1 className="text-lg font-bold text-gray-900 mr-auto">Email Dashboard</h1>

          <div className="flex bg-gray-100 rounded-lg p-1 gap-0.5">
            <button onClick={() => setViewMode('card')} title="Card view"
              className={`px-2.5 py-1.5 rounded-md text-sm transition-colors cursor-pointer ${viewMode === 'card' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400 hover:text-gray-600'}`}>⊞</button>
            <button onClick={() => setViewMode('list')} title="List view"
              className={`px-2.5 py-1.5 rounded-md text-sm transition-colors cursor-pointer ${viewMode === 'list' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400 hover:text-gray-600'}`}>☰</button>
            <button onClick={() => setViewMode('calendar')} title="Calendar view"
              className={`px-2.5 py-1.5 rounded-md transition-colors cursor-pointer ${viewMode === 'calendar' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400 hover:text-gray-600'}`}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" xmlns="http://www.w3.org/2000/svg">
                <rect x="0.65" y="1.65" width="11.7" height="10.7" rx="1.3" />
                <line x1="0.65" y1="5" x2="12.35" y2="5" />
                <line x1="3.5" y1="0.65" x2="3.5" y2="2.65" strokeLinecap="round" />
                <line x1="9.5" y1="0.65" x2="9.5" y2="2.65" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <select value={sortBy} onChange={e => setSortBy(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 outline-none cursor-pointer">
            <option value="newest">Newest</option>
            <option value="name">Name A–Z</option>
            <option value="category">Category</option>
          </select>

          <button onClick={() => runAnalysis()} disabled={analyzing}
            className="bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed">
            {analyzing ? 'Analyzing...' : 'Analyze Emails'}
          </button>
          <button onClick={handleLogout}
            className="text-sm text-gray-500 hover:text-gray-800 px-3 py-2 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer">
            Sign out
          </button>
        </div>
      </header>

      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
      <button
        onClick={() => setChatOpen(o => !o)}
        title="Ask about events"
        className={`fixed bottom-6 right-6 w-13 h-13 rounded-full shadow-lg flex items-center justify-center text-xl cursor-pointer transition-colors z-30
          ${chatOpen ? 'bg-gray-700 hover:bg-gray-800' : 'bg-blue-500 hover:bg-blue-600'} text-white`}
        style={{ width: '52px', height: '52px' }}
      >
        {chatOpen ? '✕' : '💬'}
      </button>

      <main className="max-w-5xl mx-auto px-6 py-6">
        {error && (
          <div className="bg-red-50 text-red-600 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>
        )}

        {analyzeInfo && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-gray-500 mb-4">
            <span>
              {analyzeInfo.processed === 0
                ? <>All emails from the last <strong className="text-gray-700">{analyzeInfo.days} days</strong> are up to date</>
                : <>Analyzed <strong className="text-gray-700">{analyzeInfo.processed}</strong> new email{analyzeInfo.processed !== 1 ? 's' : ''} from the last <strong className="text-gray-700">{analyzeInfo.days} days</strong></>
              }
            </span>
            <span className="text-gray-300">·</span>
            <span className="flex items-center gap-1.5">
              Expand to
              <input
                type="number" min="1" max="365" value={customDays}
                onChange={e => setCustomDays(e.target.value)}
                className="w-14 border border-gray-200 rounded px-2 py-0.5 text-sm text-center outline-none focus:ring-1 focus:ring-blue-300"
              />
              days
              <button
                onClick={() => runAnalysis({ days: parseInt(customDays, 10) })}
                disabled={analyzing || !parseInt(customDays, 10) || parseInt(customDays, 10) <= analyzeInfo.days}
                className="text-blue-500 hover:text-blue-700 disabled:text-gray-300 cursor-pointer disabled:cursor-not-allowed font-medium"
              >
                Go
              </button>
            </span>
            {analyzeInfo.nextPageToken && (
              <>
                <span className="text-gray-300">·</span>
                <button
                  onClick={() => runAnalysis({ days: analyzeInfo.days, pageToken: analyzeInfo.nextPageToken })}
                  disabled={loadingMore}
                  className="text-blue-500 hover:text-blue-700 disabled:opacity-50 cursor-pointer"
                >
                  {loadingMore ? 'Loading...' : 'Load more emails'}
                </button>
              </>
            )}
          </div>
        )}

        <div className="flex gap-1.5 mb-3 flex-wrap">
          {TABS.map(tab => {
            const count  = tabCount(tab)
            const active = activeTab === tab
            return (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                  active ? 'bg-blue-500 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300 hover:text-gray-900'
                }`}>
                {tab === 'Starred' ? '⭐ Starred' : tab}
                <span className={`text-xs rounded-full px-1.5 py-0.5 ${active ? 'bg-blue-400 text-white' : 'bg-gray-100 text-gray-500'}`}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        <div className="relative mb-6">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
          <input
            type="text" placeholder="Search by name, description, location..." value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-white border border-gray-200 rounded-xl pl-9 pr-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
          />
        </div>

        {events.length === 0 && !analyzing && (
          <div className="text-center py-32">
            <div className="text-5xl mb-4">🔍</div>
            <p className="text-base font-medium text-gray-500">No events yet</p>
            <p className="text-sm text-gray-400 mt-1">Click "Analyze Emails" to scan your inbox</p>
          </div>
        )}

        {events.length === 0 && analyzing && (
          <div className="text-center py-32">
            <div className="text-5xl mb-4">⚙️</div>
            <p className="text-base font-medium text-gray-500">Analyzing your emails...</p>
            <p className="text-sm text-gray-400 mt-1">This may take up to a minute</p>
          </div>
        )}

        {events.length > 0 && (
          <>
            {displayed.length === 0 ? (
              <div className="text-center py-16 text-gray-400 text-sm">No events match your filter</div>
            ) : viewMode === 'card' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {displayed.map(e => <EventCard key={e.id} event={e} onSelect={setSelectedId} onStar={handleStar} userEmail={userEmail} />)}
              </div>
            ) : viewMode === 'list' ? (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {displayed.map(e => <EventRow key={e.id} event={e} onSelect={setSelectedId} onStar={handleStar} userEmail={userEmail} />)}
              </div>
            ) : (
              <CalendarView events={displayed} onSelect={setSelectedId} onStar={handleStar} userEmail={userEmail} />
            )}
            {viewMode !== 'calendar' && (
              <p className="text-xs text-gray-400 text-center mt-6">
                Showing {displayed.length} of {events.length} events
              </p>
            )}
          </>
        )}
      </main>
    </div>
  )
}
