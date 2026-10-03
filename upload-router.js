const express = require('express')
const multer = require('multer')
const path = require('path')
const crypto = require('crypto')
const utils = require('./utils.js')

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

router.use(authMiddleware)

// Configure storage – keep files under ./uploads/, sub‑folder per channel
// NOTE: multipart 的 channel 欄位必須放在 file 欄位之前，否則會使用 general
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const channel = req.body.channel || 'general'
    if (!channelPattern.test(channel)) {
      return cb(new Error('Invalid channel'))
    }
    req.uploadChannel = channel
    const dir = path.join(uploadRoot, channel)
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
  'application/x-7z-compressed' // .7z
]
const allowedMimes = process.env.FILE_UPLOAD_ALLOWED_MIMES
  ? process.env.FILE_UPLOAD_ALLOWED_MIMES.split(',').map(v => v.trim())
  : defaultMimes

// File size limit (bytes) from environment, default 10 MB
const maxSize = parseInt(process.env.FILE_UPLOAD_MAX_SIZE) || 10 * 1024 * 1024

const fileFilter = (req, file, cb) => {
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(new Error('Unsupported file type'), false)
  }
}

const upload = multer({ storage, fileFilter, limits: { fileSize: maxSize } }) // size limit from env

// POST /upload – expects multipart/form-data with fields: channel, file
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ status: 0, message: 'File upload failed' })
  }
  res.json({
    status: 1,
    data: {
      originalName: req.file.originalname,
      storedName: req.file.filename,
      mime: req.file.mimetype,
      size: req.file.size,
      channel: req.uploadChannel || 'general'
    }
  })
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

// 上傳錯誤 (檔案類型/大小/channel 不合法等) 統一以 JSON 回應，不外洩錯誤堆疊
router.use((err, req, res, next) => {
  utils.warn('Upload router error', err && err.message)
  const tooLarge = err && err.code === 'LIMIT_FILE_SIZE'
  res.status(tooLarge ? 413 : 400).json({
    status: 0,
    message: tooLarge ? 'File too large' : (err && err.message) || 'Bad request'
  })
})

module.exports = router
