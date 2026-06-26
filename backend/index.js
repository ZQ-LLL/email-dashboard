const express = require('express')
const cors = require('cors')
const session = require('express-session')
const { google } = require('googleapis')
const OpenAI = require('openai')
const Database = require('better-sqlite3')
require('dotenv').config()

// ── SQLite setup ──
const db = new Database('events.db')
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT NOT NULL,
    name TEXT,
    datetime TEXT,
    location TEXT,
    link TEXT,
    category TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`)
const insertEvent = db.prepare(`
  INSERT INTO events (email_id, name, datetime, location, link, category)
  VALUES (@email_id, @name, @datetime, @location, @link, @category)
`)
const getEventsByEmailId = db.prepare('SELECT * FROM events WHERE email_id = ?')
const getAllEvents = db.prepare('SELECT * FROM events ORDER BY created_at DESC')

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY
})

const app = express()
app.use(cors({ origin: 'http://localhost:5173', credentials: true }))
app.use(express.json())
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}))

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  )
}

// Redirect user to Google OAuth consent screen
app.get('/auth/login', (req, res) => {
  const oauth2Client = getOAuthClient()
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly']
  })
  res.redirect(url)
})

// Exchange authorization code for tokens and store in session
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query
  try {
    const oauth2Client = getOAuthClient()
    const { tokens } = await oauth2Client.getToken(code)
    req.session.tokens = tokens
    res.redirect('http://localhost:5173')
  } catch (err) {
    res.status(500).json({ error: 'Authorization failed', detail: err.message })
  }
})

app.get('/auth/status', (req, res) => {
  res.json({ loggedIn: !!req.session.tokens })
})

app.get('/auth/logout', (req, res) => {
  req.session.destroy()
  res.json({ success: true })
})

// Fetch the 20 most recent emails
app.get('/api/emails', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  try {
    const oauth2Client = getOAuthClient()
    oauth2Client.setCredentials(req.session.tokens)
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

    const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: 20 })
    const messages = listRes.data.messages || []

    const emails = await Promise.all(
      messages.map(async (msg) => {
        const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' })
        const headers = detail.data.payload.headers
        const subject = headers.find(h => h.name === 'Subject')?.value || '(No subject)'
        const from = headers.find(h => h.name === 'From')?.value || '(Unknown)'
        const date = headers.find(h => h.name === 'Date')?.value || ''
        const body = extractBody(detail.data.payload)
        return { id: msg.id, subject, from, date, body }
      })
    )

    res.json(emails)
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch emails', detail: err.message })
  }
})

// Analyze emails with AI and extract campus events; results are cached in SQLite
app.get('/api/analyze', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  try {
    const oauth2Client = getOAuthClient()
    oauth2Client.setCredentials(req.session.tokens)
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

    const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: 20 })
    const messages = listRes.data.messages || []

    const results = []

    for (const msg of messages) {
      // Return cached result if this email has already been analyzed
      const cached = getEventsByEmailId.all(msg.id)
      if (cached.length > 0) {
        results.push(...cached)
        continue
      }

      const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' })
      const headers = detail.data.payload.headers
      const subject = headers.find(h => h.name === 'Subject')?.value || '(No subject)'
      const from = headers.find(h => h.name === 'From')?.value || ''
      const body = extractBody(detail.data.payload)

      const prompt = `You are a campus email assistant. Analyze the email below and determine whether it contains information about campus events (lectures, job fairs, club activities, application deadlines, etc.).

Subject: ${subject}
From: ${from}
Body (first 1500 chars):
${body.slice(0, 1500)}

If the email contains event information, return a JSON array where each object has these fields:
- name: event name (string)
- datetime: event time (string, use the original wording)
- location: venue (string, or null if not mentioned)
- link: related URL (string, or null if not mentioned)
- category: one of "Academic" | "Social" | "Career" | "Deadline" | "Other"

If the email contains no events, return an empty array [].
Return only valid JSON — no explanation or markdown.`

      const completion = await openai.chat.completions.create({
        model: 'anthropic/claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })

      let events = []
      try {
        const text = completion.choices[0].message.content.trim()
        const json = text.replace(/^```json\n?/, '').replace(/\n?```$/, '')
        events = JSON.parse(json)
      } catch {
        events = []
      }

      // Cache results; insert a null-name placeholder so this email is not re-analyzed
      const insertMany = db.transaction((evs) => {
        for (const ev of evs) {
          insertEvent.run({ email_id: msg.id, ...ev })
        }
        if (evs.length === 0) {
          insertEvent.run({ email_id: msg.id, name: null, datetime: null, location: null, link: null, category: null })
        }
      })
      insertMany(events)

      const saved = getEventsByEmailId.all(msg.id).filter(e => e.name !== null)
      results.push(...saved)
    }

    res.json(results)
  } catch (err) {
    res.status(500).json({ error: 'AI analysis failed', detail: err.message })
  }
})

// Extract plain text from a Gmail message payload (handles base64 and multipart)
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
