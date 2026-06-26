const express = require('express')
const cors = require('cors')
const session = require('express-session')
const { google } = require('googleapis')
const OpenAI = require('openai')
const Database = require('better-sqlite3')
require('dotenv').config()

// ── Database setup ──
const db = new Database('events.db')
db.exec(`
  CREATE TABLE IF NOT EXISTS analyzed_emails (
    email_id TEXT PRIMARY KEY,
    analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS events (
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
  );
`)

// Safe migration: add columns that may not exist in older DBs
for (const col of ['description TEXT', 'link TEXT']) {
  try { db.exec(`ALTER TABLE events ADD COLUMN ${col}`) } catch (_) {}
}

const stmt = {
  isAnalyzed:    db.prepare('SELECT 1 FROM analyzed_emails WHERE email_id = ?'),
  markAnalyzed:  db.prepare('INSERT OR IGNORE INTO analyzed_emails (email_id) VALUES (?)'),
  findByName:    db.prepare('SELECT * FROM events WHERE lower(trim(name)) = lower(trim(?))'),
  insert:        db.prepare(`
    INSERT INTO events (name, description, datetime, location, link, category, source_emails)
    VALUES (@name, @description, @datetime, @location, @link, @category, @source_emails)
  `),
  updateSources: db.prepare('UPDATE events SET source_emails = ? WHERE id = ?'),
  updateEvent:   db.prepare(`
    UPDATE events
    SET name = @name, description = @description, datetime = @datetime,
        location = @location, link = @link, category = @category
    WHERE id = @id
  `),
  deleteEvent:   db.prepare('DELETE FROM events WHERE id = ?'),
  allEvents:     db.prepare('SELECT * FROM events ORDER BY created_at DESC'),
  getEvent:      db.prepare('SELECT * FROM events WHERE id = ?'),
  toggleStar:    db.prepare('UPDATE events SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END WHERE id = ?'),
}

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})

const app = express()
app.use(cors({ origin: 'http://localhost:5173', credentials: true }))
app.use(express.json())
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false },
}))

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  )
}

app.get('/auth/login', (req, res) => {
  const oauth2Client = getOAuthClient()
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
  })
  res.redirect(url)
})

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query
  try {
    const oauth2Client = getOAuthClient()
    const { tokens } = await oauth2Client.getToken(code)
    req.session.tokens = tokens
    // Fetch and store the user's email so the frontend can build correct Gmail URLs
    oauth2Client.setCredentials(tokens)
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
    const profile = await gmail.users.getProfile({ userId: 'me' })
    req.session.userEmail = profile.data.emailAddress
    res.redirect('http://localhost:5173')
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

app.get('/api/events', (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  res.json(stmt.allEvents.all())
})

app.patch('/api/events/:id', (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  const { name, description, datetime, location, link, category } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  stmt.updateEvent.run({
    name: name.trim(),
    description: description || null,
    datetime:    datetime    || null,
    location:    location    || null,
    link:        link        || null,
    category:    category    || 'Other',
    id: parseInt(req.params.id),
  })
  res.json(stmt.getEvent.get(req.params.id))
})

app.delete('/api/events/:id', (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  stmt.deleteEvent.run(req.params.id)
  res.json({ success: true })
})

app.patch('/api/events/:id/star', (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })
  stmt.toggleStar.run(req.params.id)
  const updated = stmt.getEvent.get(req.params.id)
  if (!updated) return res.status(404).json({ error: 'Event not found' })
  res.json({ id: updated.id, starred: !!updated.starred })
})

app.get('/api/analyze', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })

  const days      = parseInt(req.query.days) || 7
  const pageToken = req.query.pageToken || undefined

  try {
    const oauth2Client = getOAuthClient()
    oauth2Client.setCredentials(req.session.tokens)
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 30,
      q: `newer_than:${days}d`,
      ...(pageToken && { pageToken }),
    })

    const messages      = listRes.data.messages || []
    const nextPageToken = listRes.data.nextPageToken || null
    let processed = 0

    for (const msg of messages) {
      if (stmt.isAnalyzed.get(msg.id)) continue

      const detail  = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' })
      const headers = detail.data.payload.headers
      const subject = headers.find(h => h.name === 'Subject')?.value || '(No subject)'
      const from    = headers.find(h => h.name === 'From')?.value    || ''
      const body    = extractBody(detail.data.payload)
      const threadId    = detail.data.threadId || msg.id
      // RFC822 Message-ID header is unique per email and works with Gmail's rfc822msgid search
      // Case-insensitive match because mail servers use Message-ID, Message-Id, message-id, etc.
      const msgIdHeader = headers.find(h => h.name.toLowerCase() === 'message-id')?.value || null

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
        model: 'anthropic/claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      })

      let events = []
      try {
        const text   = completion.choices[0].message.content.trim()
        const json   = text.replace(/^```json\n?/, '').replace(/\n?```$/, '')
        const parsed = JSON.parse(json)
        events = Array.isArray(parsed) ? parsed : []
      } catch { /* keep events = [] */ }

      const sourceEntry = { id: msg.id, threadId, msgIdHeader, subject }

      db.transaction((evs, emailId) => {
        stmt.markAnalyzed.run(emailId)
        for (const ev of evs) {
          if (!ev.name?.trim()) continue
          const existing = stmt.findByName.get(ev.name)
          if (existing) {
            const sources = JSON.parse(existing.source_emails || '[]')
            const seen    = sources.some(s => (typeof s === 'string' ? s : s.id) === emailId)
            if (!seen) {
              stmt.updateSources.run(JSON.stringify([...sources, sourceEntry]), existing.id)
            }
          } else {
            stmt.insert.run({
              name:          ev.name.trim(),
              description:   ev.description  || null,
              datetime:      ev.datetime     || null,
              location:      ev.location     || null,
              link:          ev.link         || null,
              category:      ev.category     || 'Other',
              source_emails: JSON.stringify([sourceEntry]),
            })
          }
        }
      })(events, msg.id)

      processed++
    }

    res.json({ events: stmt.allEvents.all(), nextPageToken, processed, days })
  } catch (err) {
    res.status(500).json({ error: 'AI analysis failed', detail: err.message })
  }
})

app.post('/api/chat', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' })

  const { message, history = [] } = req.body
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' })

  const allEvents = stmt.allEvents.all()
  const context = allEvents.length === 0
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
      model: 'anthropic/claude-haiku-4-5',
      max_tokens: 1024,
      stream: true,
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

function extractBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8')
      }
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

app.listen(process.env.PORT || 3001, () => {
  console.log(`Server running at http://localhost:${process.env.PORT || 3001}`)
})
