const express          = require('express')
const cors             = require('cors')
const session          = require('express-session')
const { google }       = require('googleapis')
const OpenAI           = require('openai')
const { createClient } = require('@libsql/client')
require('dotenv').config()

// ── Database ──
// Locally: set TURSO_DATABASE_URL=file:events.db in .env (no auth token needed)
// Production: set TURSO_DATABASE_URL=libsql://xxx.turso.io and TURSO_AUTH_TOKEN=xxx
const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || 'file:events.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})

async function q(sql, args = [])   { return (await db.execute({ sql, args })).rows }
async function q1(sql, args = [])  { return (await q(sql, args))[0] ?? null }
async function run(sql, args = []) { await db.execute({ sql, args }) }

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS analyzed_emails (
    email_id TEXT PRIMARY KEY,
    analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
  await run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    datetime TEXT,
    location TEXT,
    link TEXT,
    category TEXT,
    source_emails TEXT DEFAULT '[]',
    starred INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
  await run(`CREATE TABLE IF NOT EXISTS blocked_senders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
}

// ── OpenAI / OpenRouter ──
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey:  process.env.OPENROUTER_API_KEY,
})

// ── Express ──
const app    = express()
const isProd = process.env.NODE_ENV === 'production'

// Required when running behind Render's reverse proxy so secure cookies work
if (isProd) app.set('trust proxy', 1)

app.use(cors({
  origin:      process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}))
app.use(express.json())
app.use(session({
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   isProd,
    sameSite: isProd ? 'none' : 'lax',
  },
}))

// ── OAuth helpers ──
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI,
  )
}

// ── Auth routes ──
app.get('/auth/login', (req, res) => {
  const url = getOAuthClient().generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
  })
  res.redirect(url)
})

app.get('/auth/callback', async (req, res) => {
  try {
    const oauth2Client = getOAuthClient()
    const { tokens }   = await oauth2Client.getToken(req.query.code)
    req.session.tokens = tokens
    oauth2Client.setCredentials(tokens)
    const gmail   = google.gmail({ version: 'v1', auth: oauth2Client })
    const profile = await gmail.users.getProfile({ userId: 'me' })
    req.session.userEmail = profile.data.emailAddress
    res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173')
  } catch (err) {
    res.status(500).json({ error: 'Authorization failed', detail: err.message })
  }
})

app.get('/auth/status', (req, res) => res.json({
  loggedIn:  !!req.session.tokens,
  userEmail: req.session.userEmail || null,
}))

app.get('/auth/logout', (req, res) => {
  req.session.destroy()
  res.json({ success: true })
})

// ── Events ──
app.get('/api/events', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  res.json(await q('SELECT * FROM events ORDER BY created_at DESC'))
})

app.patch('/api/events/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  const { name, description, datetime, location, link, category } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  await run(
    'UPDATE events SET name = ?, description = ?, datetime = ?, location = ?, link = ?, category = ? WHERE id = ?',
    [name.trim(), description || null, datetime || null, location || null, link || null, category || 'Other', parseInt(req.params.id)],
  )
  res.json(await q1('SELECT * FROM events WHERE id = ?', [req.params.id]))
})

app.delete('/api/events/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  await run('DELETE FROM events WHERE id = ?', [req.params.id])
  res.json({ success: true })
})

app.patch('/api/events/:id/star', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  await run(
    'UPDATE events SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END WHERE id = ?',
    [req.params.id],
  )
  const updated = await q1('SELECT * FROM events WHERE id = ?', [req.params.id])
  if (!updated) return res.status(404).json({ error: 'Event not found' })
  res.json({ id: Number(updated.id), starred: !!updated.starred })
})

// ── Blocked Senders ──
app.get('/api/blocked', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  res.json(await q('SELECT * FROM blocked_senders ORDER BY blocked_at DESC'))
})

app.post('/api/blocked', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  const { email } = req.body
  if (!email?.trim()) return res.status(400).json({ error: 'Email required' })
  await run('INSERT OR IGNORE INTO blocked_senders (email) VALUES (?)', [email.trim().toLowerCase()])
  res.json(await q('SELECT * FROM blocked_senders ORDER BY blocked_at DESC'))
})

app.delete('/api/blocked/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  await run('DELETE FROM blocked_senders WHERE id = ?', [req.params.id])
  res.json(await q('SELECT * FROM blocked_senders ORDER BY blocked_at DESC'))
})

// ── Analyze ──
app.get('/api/analyze', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })

  const days      = parseInt(req.query.days) || 7
  const pageToken = req.query.pageToken || undefined

  try {
    const oauth2Client = getOAuthClient()
    oauth2Client.setCredentials(req.session.tokens)
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

    const listRes = await gmail.users.messages.list({
      userId: 'me', maxResults: 30,
      q: `newer_than:${days}d`,
      ...(pageToken && { pageToken }),
    })

    const messages      = listRes.data.messages || []
    const nextPageToken = listRes.data.nextPageToken || null
    let processed = 0

    const blockedRows = await q('SELECT email FROM blocked_senders')
    const blockedSet  = new Set(blockedRows.map(b => b.email.toLowerCase()))

    for (const msg of messages) {
      if (await q1('SELECT 1 FROM analyzed_emails WHERE email_id = ?', [msg.id])) continue

      const detail  = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' })
      const headers = detail.data.payload.headers
      const subject     = headers.find(h => h.name === 'Subject')?.value                  || '(No subject)'
      const from        = headers.find(h => h.name === 'From')?.value                     || ''
      const msgIdHeader = headers.find(h => h.name.toLowerCase() === 'message-id')?.value || null
      const body        = extractBody(detail.data.payload)
      const threadId    = detail.data.threadId || msg.id

      // Skip blocked senders (still mark analyzed so they stay skipped)
      const fromEmail = (from.match(/<(.+)>/) || [, from])[1]?.toLowerCase() || ''
      if (blockedSet.has(fromEmail)) {
        await run('INSERT OR IGNORE INTO analyzed_emails (email_id) VALUES (?)', [msg.id])
        continue
      }

      const prompt = `You are a campus email assistant. Analyze the email below and determine whether it contains campus event information (lectures, job fairs, club activities, application deadlines, etc.).

Subject: ${subject}
From: ${from}
Body (first 1500 chars):
${body.slice(0, 1500)}

If the email contains event information, return a JSON array where each object has:
- name: event name (string)
- description: 1-2 sentence summary of what this event is about (string)
- datetime: event time as described in the email (string, or null)
- location: venue (string, or null)
- link: related URL (string, or null)
- category: one of "Academic" | "Social" | "Career" | "Deadline" | "Other"

If no events are found, return [].
Return only valid JSON — no explanation or markdown.`

      const completion = await openai.chat.completions.create({
        model:      'anthropic/claude-haiku-4-5',
        max_tokens: 1024,
        messages:   [{ role: 'user', content: prompt }],
      })

      let events = []
      try {
        const text = completion.choices[0].message.content.trim()
        const json = text.replace(/^```json\n?/, '').replace(/\n?```$/, '')
        events = Array.isArray(JSON.parse(json)) ? JSON.parse(json) : []
      } catch { /* keep events = [] */ }

      const sourceEntry = { id: msg.id, threadId, msgIdHeader, subject, from }

      await run('INSERT OR IGNORE INTO analyzed_emails (email_id) VALUES (?)', [msg.id])
      for (const ev of events) {
        if (!ev.name?.trim()) continue
        const existing = await q1(
          'SELECT * FROM events WHERE lower(trim(name)) = lower(trim(?))', [ev.name],
        )
        if (existing) {
          const sources = JSON.parse(existing.source_emails || '[]')
          const seen    = sources.some(s => (typeof s === 'string' ? s : s.id) === msg.id)
          if (!seen) {
            await run(
              'UPDATE events SET source_emails = ? WHERE id = ?',
              [JSON.stringify([...sources, sourceEntry]), existing.id],
            )
          }
        } else {
          await run(
            'INSERT INTO events (name, description, datetime, location, link, category, source_emails) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [ev.name.trim(), ev.description || null, ev.datetime || null, ev.location || null, ev.link || null, ev.category || 'Other', JSON.stringify([sourceEntry])],
          )
        }
      }
      processed++
    }

    res.json({ events: await q('SELECT * FROM events ORDER BY created_at DESC'), nextPageToken, processed, days })
  } catch (err) {
    res.status(500).json({ error: 'AI analysis failed', detail: err.message })
  }
})

// ── Chat (streaming SSE) ──
app.post('/api/chat', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })

  const { message, history = [] } = req.body
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' })

  const allEvents = await q('SELECT * FROM events ORDER BY created_at DESC')
  const context   = allEvents.length === 0
    ? 'No events have been analyzed yet.'
    : allEvents.map(ev => {
        const lines = [`- ${ev.name} [${ev.category}]`]
        if (ev.datetime)    lines.push(`  When: ${ev.datetime}`)
        if (ev.location)    lines.push(`  Where: ${ev.location}`)
        if (ev.description) lines.push(`  About: ${ev.description}`)
        return lines.join('\n')
      }).join('\n\n')

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })

  const systemPrompt = `You are a helpful assistant for a campus email dashboard. Today is ${today}.

The user's inbox has been analyzed and the following campus events were found:

${context}

Answer the user's questions about these events concisely. If an event has no date, say so. Do not make up events that aren't listed above.`

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  try {
    console.log('[chat] stream start:', message.slice(0, 60))
    const stream = await openai.chat.completions.create({
      model: 'anthropic/claude-haiku-4-5', max_tokens: 1024, stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
      ],
    })
    let chunks = 0
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) { res.write(`data: ${JSON.stringify({ delta })}\n\n`); chunks++ }
    }
    console.log('[chat] stream done, chunks:', chunks)
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    console.error('[chat] error:', err.message)
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
    res.end()
  }
})

// ── Helpers ──
function extractBody(payload) {
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data)
        return Buffer.from(part.body.data, 'base64').toString('utf-8')
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8')
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      }
    }
  }
  return '(Body unavailable)'
}

// ── Start ──
initDb()
  .then(() => app.listen(process.env.PORT || 3001, () =>
    console.log(`Server on port ${process.env.PORT || 3001}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1) })
