import { useState, useEffect } from 'react'

const API = 'http://localhost:3001'

function App() {
  const [status, setStatus] = useState('loading') // 'loading' | 'loggedOut' | 'loggedIn'
  const [emails, setEmails] = useState([])
  const [emailsLoading, setEmailsLoading] = useState(false)
  const [error, setError] = useState(null)

  // 启动时检查登录状态
  useEffect(() => {
    fetch(`${API}/auth/status`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.loggedIn) {
          setStatus('loggedIn')
          loadEmails()
        } else {
          setStatus('loggedOut')
        }
      })
      .catch(() => {
        setError('无法连接到后端，请确认后端在 3001 端口运行')
        setStatus('loggedOut')
      })
  }, [])

  function loadEmails() {
    setEmailsLoading(true)
    setError(null)
    fetch(`${API}/api/emails`, { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(data => {
        setEmails(data)
        setEmailsLoading(false)
      })
      .catch(err => {
        setError(`加载邮件失败：${err.message}`)
        setEmailsLoading(false)
      })
  }

  function handleLogout() {
    fetch(`${API}/auth/logout`, { credentials: 'include' })
      .then(() => {
        setEmails([])
        setStatus('loggedOut')
      })
  }

  // ── 加载中 ──
  if (status === 'loading') {
    return (
      <div style={styles.center}>
        <p style={styles.muted}>正在检查登录状态...</p>
      </div>
    )
  }

  // ── 未登录 ──
  if (status === 'loggedOut') {
    return (
      <div style={styles.center}>
        <div style={styles.card}>
          <h1 style={styles.title}>📬 Email Dashboard</h1>
          <p style={styles.subtitle}>连接你的 Gmail，自动提取校园活动信息</p>
          {error && <p style={styles.error}>{error}</p>}
          <a href={`${API}/auth/login`}>
            <button style={styles.btn}>Connect Gmail</button>
          </a>
        </div>
      </div>
    )
  }

  // ── 已登录：邮件列表 ──
  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.title}>📬 Email Dashboard</h1>
        <button style={styles.btnSmall} onClick={handleLogout}>退出登录</button>
      </header>

      {error && <p style={styles.error}>{error}</p>}

      {emailsLoading ? (
        <p style={styles.muted}>正在加载邮件...</p>
      ) : (
        <div>
          <p style={styles.muted}>共加载 {emails.length} 封邮件</p>
          {emails.map(email => (
            <div key={email.id} style={styles.emailCard}>
              <p style={styles.emailSubject}>{email.subject}</p>
              <p style={styles.emailMeta}>发件人：{email.from}</p>
              <p style={styles.emailMeta}>时间：{email.date}</p>
              <p style={styles.emailBody}>{email.body.slice(0, 200)}{email.body.length > 200 ? '...' : ''}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const styles = {
  center: {
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    minHeight: '100vh', backgroundColor: '#f5f5f5'
  },
  page: {
    maxWidth: 760, margin: '0 auto', padding: '24px 16px'
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 24
  },
  card: {
    background: '#fff', borderRadius: 12, padding: 40,
    textAlign: 'center', boxShadow: '0 2px 12px rgba(0,0,0,0.1)'
  },
  title: { margin: '0 0 8px', fontSize: 28, fontWeight: 700 },
  subtitle: { color: '#666', marginBottom: 24 },
  muted: { color: '#888', fontSize: 14 },
  error: { color: '#c0392b', background: '#fdecea', padding: '8px 12px', borderRadius: 6, fontSize: 14 },
  btn: {
    background: '#4285f4', color: '#fff', border: 'none',
    padding: '12px 28px', borderRadius: 8, fontSize: 16,
    cursor: 'pointer', fontWeight: 600
  },
  btnSmall: {
    background: '#eee', color: '#333', border: 'none',
    padding: '6px 14px', borderRadius: 6, fontSize: 14, cursor: 'pointer'
  },
  emailCard: {
    background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8,
    padding: 16, marginBottom: 12
  },
  emailSubject: { fontWeight: 600, fontSize: 16, margin: '0 0 6px' },
  emailMeta: { fontSize: 13, color: '#666', margin: '2px 0' },
  emailBody: { fontSize: 13, color: '#444', marginTop: 8, lineHeight: 1.5 }
}

export default App
