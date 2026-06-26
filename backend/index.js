const express = require('express')
const cors = require('cors')
const session = require('express-session')
const { google } = require('googleapis')
require('dotenv').config()

const app = express()
app.use(cors({ origin: 'http://localhost:5173', credentials: true }))
app.use(express.json())
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}))

// 创建 OAuth 客户端
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  )
}

// 路由 1：生成 Google 登录链接，前端跳转到这里
app.get('/auth/login', (req, res) => {
  const oauth2Client = getOAuthClient()
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly']
  })
  res.redirect(url)
})

// 路由 2：Google 登录成功后回调到这里
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query  // Google 带回来的授权码
  try {
    const oauth2Client = getOAuthClient()
    const { tokens } = await oauth2Client.getToken(code)  // 用授权码换 token
    req.session.tokens = tokens  // 把 token 存进 session
    res.redirect('http://localhost:5173')  // 跳回前端
  } catch (err) {
    res.status(500).json({ error: '授权失败', detail: err.message })
  }
})

// 路由 3：检查登录状态（前端用来判断是否已登录）
app.get('/auth/status', (req, res) => {
  res.json({ loggedIn: !!req.session.tokens })
})

// 路由 4：退出登录
app.get('/auth/logout', (req, res) => {
  req.session.destroy()
  res.json({ success: true })
})

// 路由 5：拉取邮件（核心功能）
app.get('/api/emails', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: '未登录' })
  }
  try {
    const oauth2Client = getOAuthClient()
    oauth2Client.setCredentials(req.session.tokens)
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

    // 拉取最近 20 封邮件的 ID
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 20
    })

    const messages = listRes.data.messages || []

    // 用 Promise.all 并发获取每封邮件的详细内容
    const emails = await Promise.all(
      messages.map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full'
        })

        const headers = detail.data.payload.headers
        const subject = headers.find(h => h.name === 'Subject')?.value || '(无主题)'
        const from = headers.find(h => h.name === 'From')?.value || '(未知)'
        const date = headers.find(h => h.name === 'Date')?.value || ''

        // 提取邮件正文（处理 base64 编码）
        const body = extractBody(detail.data.payload)

        return { id: msg.id, subject, from, date, body }
      })
    )

    res.json(emails)
  } catch (err) {
    res.status(500).json({ error: '获取邮件失败', detail: err.message })
  }
})

// 工具函数：从邮件 payload 里提取纯文本正文
function extractBody(payload) {
  // 直接有 body 的情况
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }
  // multipart 邮件，找 text/plain 部分
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8')
      }
    }
    // 没有 text/plain，用 text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8')
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      }
    }
  }
  return '(无法解析正文)'
}

app.listen(process.env.PORT || 3001, () => {
  console.log(`后端运行在 http://localhost:${process.env.PORT || 3001}`)
})