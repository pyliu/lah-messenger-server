const express = require('express')
const multer = require('multer')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const utils = require('./utils.js')
const MessageDB = require('./message-db.js')
const MessageWatcher = require('./message-watcher.js')

const router = express.Router()

const uploadRoot = path.join(__dirname, 'uploads')
// channel / filename 只允許安全字元，避免路徑穿越 (../) 與隱藏檔
const channelPattern = /^[A-Za-z0-9_-]{1,64}$/
const filenamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/

// Simple token authentication (optional)
const uploadAuthToken = process.env.UPLOAD_AUTH_TOKEN || ''
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}
const authMiddleware = (req, res, next) => {
  if (!uploadAuthToken) { return next() } // no auth required if not set
  const token = req.headers['x-auth-token']
  if (token && safeEqual(token, uploadAuthToken)) {
    return next()
  }
  return res.status(401).json({ status: -5, message: 'Unauthorized' })
}

// 允許跨來源請求 (CORS) 與 Preflight OPTIONS
const corsMiddleware = (req, res, next) => {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Origin, X-Requested-With, Content-Type, Accept, x-auth-token, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }
  next()
}

router.use(corsMiddleware)
router.use(authMiddleware)

// 附件以 message_id 分目錄: uploads/<channel>/<message_id>/<timestamp>_<filename>
// NOTE: multipart 的 channel、message_id 欄位必須放在 file 欄位之前
const messageIdPattern = /^[1-9][0-9]{0,15}$/
const makeError = (message, status) => {
  const err = new Error(message)
  err.status = status
  return err
}
// 僅在該頻道 DB 已存在時才檢查訊息是否存在 (避免 MessageDB 建構時自動建立空白 DB)
const messageExists = (channel, messageId) => {
  const dbFile = path.join(__dirname, 'db', channel + '.db')
  if (!fs.existsSync(dbFile)) { return false }
  let messageDB = null
  try {
    messageDB = new MessageDB(channel)
    return !!messageDB.db.prepare('SELECT id FROM message WHERE id = ?').get(parseInt(messageId))
  } catch (e) {
    utils.warn('Check message exists error', e.message)
    return false
  } finally {
    try { messageDB && messageDB.db.close() } catch (e) { /* ignore */ }
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const channel = req.body.channel || 'general'
    if (!channelPattern.test(channel)) {
      return cb(makeError('Invalid channel', 400))
    }
    const messageId = String(req.body.message_id || '')
    if (!messageIdPattern.test(messageId)) {
      return cb(makeError('Invalid message_id', 400))
    }
    if (!messageExists(channel, messageId)) {
      return cb(makeError('Message not found', 404))
    }
    req.uploadChannel = channel
    req.uploadMessageId = messageId
    const dir = path.join(uploadRoot, channel, messageId)
    utils.ensureDir(dir)
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now()
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    cb(null, `${timestamp}_${safeName}`)
  }
})

// Accept only whitelisted MIME types from environment
const defaultMimes = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/zip', // .zip
  'application/x-7z-compressed', // .7z
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/octet-stream'
]
const allowedMimes = process.env.FILE_UPLOAD_ALLOWED_MIMES
  ? process.env.FILE_UPLOAD_ALLOWED_MIMES.split(',').map(v => v.trim())
  : defaultMimes

// File size limit (bytes) from environment, default 10 MB
const maxSize = parseInt(process.env.FILE_UPLOAD_MAX_SIZE) || 10 * 1024 * 1024

const fileFilter = (req, file, cb) => {
  if (allowedMimes.includes('*') || allowedMimes.includes(file.mimetype) || !file.mimetype) {
    cb(null, true)
  } else {
    cb(new Error(`Unsupported file type: ${file.mimetype}`), false)
  }
}

const upload = multer({ storage, fileFilter, limits: { fileSize: maxSize } }) // size limit from env

// 上傳成功後即時通知相關連線 (ACK -12 / command: attachment_uploaded)
// 接收對象規則與訊息推播一致: 公共頻道=全體、個人/群組頻道=停留該頻道的連線
const notifyAttachmentUploaded = (channel, messageId, file) => {
  try {
    const wss = MessageWatcher.wss
    if (!wss) { return }
    const all = [...wss.clients]
    const isPublic = MessageWatcher.stickyChannels.includes(channel) || channel.startsWith('announcement')
    const targets = isPublic
      ? all
      : all.filter(ws => ws.user?.userid === channel || ws.user?.channel === channel)
    const attachments = utils.listAttachments(channel, messageId)
    targets.forEach(ws => {
      try {
        if (ws.readyState === 1) {
          utils.sendAck(ws, {
            command: 'attachment_uploaded',
            payload: { channel, message_id: parseInt(messageId), file, attachments },
            success: true,
            message: `${channel} #${messageId} 新增附件 ${file.name}`
          }, -12)
        }
      } catch (err) {
        utils.warn('notifyAttachmentUploaded send error', err.message)
      }
    })
  } catch (err) {
    utils.warn('notifyAttachmentUploaded error', err.message)
  }
}

// POST /upload – expects multipart/form-data with fields (依序): channel, message_id, file
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ status: 0, message: 'File upload failed' })
  }
  const channel = req.uploadChannel || 'general'
  const messageId = req.uploadMessageId
  notifyAttachmentUploaded(channel, messageId, { name: req.file.filename, size: req.file.size })
  res.json({
    status: 1,
    data: {
      originalName: req.file.originalname,
      storedName: req.file.filename,
      mime: req.file.mimetype,
      size: req.file.size,
      channel,
      message_id: parseInt(messageId)
    }
  })
})

// GET /attachments/:channel/:messageId – 列出訊息的附件
router.get('/attachments/:channel/:messageId', (req, res) => {
  const { channel, messageId } = req.params
  if (!channelPattern.test(channel) || !messageIdPattern.test(messageId)) {
    return res.status(400).json({ status: 0, message: 'Invalid channel or message_id' })
  }
  res.json({ status: 1, data: utils.listAttachments(channel, messageId) })
})

// GET /download/:channel/:filename – streams the file back to the client as an attachment
router.get('/download/:channel/:filename', (req, res) => {
  const { channel, filename } = req.params
  if (!channelPattern.test(channel) || !filenamePattern.test(filename)) {
    return res.status(400).json({ status: 0, message: 'Invalid channel or filename' })
  }
  const filePath = path.join(uploadRoot, channel, filename)
  if (!filePath.startsWith(uploadRoot + path.sep)) {
    return res.status(400).json({ status: 0, message: 'Invalid path' })
  }
  // 一律以附件下載並禁止瀏覽器猜測內容類型，避免上傳的 html 等檔案被當網頁執行
  res.set('X-Content-Type-Options', 'nosniff')
  res.download(filePath, filename, { dotfiles: 'deny' }, err => {
    if (err && !res.headersSent) {
      utils.warn('File download error', err.message)
      res.status(404).json({ status: -7, message: 'File not found' })
    }
  })
})

// GET /download/:channel/:messageId/:filename – 下載指定訊息的附件
router.get('/download/:channel/:messageId/:filename', (req, res) => {
  const { channel, messageId, filename } = req.params
  if (!channelPattern.test(channel) || !messageIdPattern.test(messageId) || !filenamePattern.test(filename)) {
    return res.status(400).json({ status: 0, message: 'Invalid channel, message_id or filename' })
  }
  const filePath = path.join(uploadRoot, channel, messageId, filename)
  if (!filePath.startsWith(uploadRoot + path.sep)) {
    return res.status(400).json({ status: 0, message: 'Invalid path' })
  }
  res.set('X-Content-Type-Options', 'nosniff')
  res.download(filePath, filename, { dotfiles: 'deny' }, err => {
    if (err && !res.headersSent) {
      utils.warn('File download error', err.message)
      res.status(404).json({ status: -7, message: 'File not found' })
    }
  })
})

// 上傳錯誤 (檔案類型/大小/channel 不合法等) 統一以 JSON 回應，不外洩錯誤堆疊
router.use((err, req, res, next) => {
  utils.warn('Upload router error', err && err.message)
  const tooLarge = err && err.code === 'LIMIT_FILE_SIZE'
  const notFound = err && err.status === 404
  res.status(tooLarge ? 413 : notFound ? 404 : 400).json({
    status: notFound ? -7 : 0,
    message: tooLarge ? 'File too large' : (err && err.message) || 'Bad request'
  })
})

module.exports = router
