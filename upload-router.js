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
// channel / filename 安全檢驗，避免路徑穿越 (../) 與隱藏檔
const channelPattern = /^[A-Za-z0-9_-]{1,64}$/
// 允許合法中文、英數字、空白、括號、底線與連字號，嚴格禁止路徑穿越與保留字元
const isSafeFilename = (filename) => {
  if (!filename || typeof filename !== 'string') { return false }
  const trimmed = filename.trim()
  if (trimmed.length === 0 || trimmed.length > 255) { return false }
  if (trimmed.startsWith('.') || trimmed.includes('..')) { return false }
  // 禁止 / \ : * ? " < > | 以及 ASCII 控制字元
  // eslint-disable-next-line no-control-regex
  return !/[\/\\:\*\?"<>\|\x00-\x1f\x7f]/.test(trimmed)
}

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
const makeError = (message, status, details = {}) => {
  const err = new Error(message)
  err.status = status
  err.details = details
  return err
}

const formatSize = (bytes) => {
  if (!bytes || isNaN(bytes)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = Number(bytes)
  let idx = 0
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024
    idx++
  }
  return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`
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
      return cb(makeError(`無效的頻道名稱格式: ${channel}`, 400, { code: 'INVALID_CHANNEL', channel }))
    }
    const messageId = String(req.body.message_id || '')
    if (!messageIdPattern.test(messageId)) {
      return cb(makeError(`無效或缺失的訊息 ID: ${messageId || '(未提供)'}。請確認 multipart 欄位依序包含 channel, message_id, file`, 400, { code: 'INVALID_MESSAGE_ID', messageId }))
    }
    if (!messageExists(channel, messageId)) {
      return cb(makeError(`在頻道 [${channel}] 中找不到指定的訊息 #${messageId}`, 404, { code: 'MESSAGE_NOT_FOUND', channel, messageId }))
    }
    req.uploadChannel = channel
    req.uploadMessageId = messageId
    const dir = path.join(uploadRoot, channel, messageId)
    utils.ensureDir(dir)
    req.uploadDir = dir
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    const dir = req.uploadDir || path.join(uploadRoot, req.uploadChannel, req.uploadMessageId)
    const uniqueName = utils.getUniqueFilename(dir, file.originalname)
    cb(null, uniqueName)
  }
})

// 允許的預設 MIME 類型白名單 (含完整 ODF 系列、Office、PDF、RTF、純文字/公文/資料交換、CAD圖資、影像掃描、郵件備份與壓縮檔)
const defaultMimes = [
  // PDF & RTF 文件
  'application/pdf',
  'application/rtf',
  'text/rtf',
  // MS Office - Word (.docx, .doc, .dotx, .dot)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/msword-template',
  // MS Office - Excel (.xlsx, .xls, .xltx, .xlt)
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  'application/vnd.ms-excel.template',
  // MS Office - PowerPoint (.pptx, .ppt, .potx, .pot)
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/vnd.ms-powerpoint.template',
  // ODF (OpenDocument Format CNS15251 全系列: .odt, .ott, .ods, .ots, .odp, .otp, .odg, .otg)
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.text-template',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.spreadsheet-template',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.presentation-template',
  'application/vnd.oasis.opendocument.graphics',
  'application/vnd.oasis.opendocument.graphics-template',
  // 純文字與資料交換格式 (.txt, .csv, .json, .xml, .di公文檔)
  'text/plain',
  'text/csv',
  'application/csv',
  'text/xml',
  'application/xml',
  'application/json',
  'text/json',
  // 壓縮檔 - 包含 RAR 所有常見 MIME、ZIP、7Z、GZ、TAR
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-rar',
  'application/rar',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'multipart/x-zip',
  'application/x-7z-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/tar',
  // 地政測量 CAD 圖資 (.dwg, .dxf)
  'image/vnd.dwg',
  'image/x-dwg',
  'application/acad',
  'application/x-acad',
  'application/autocad_dwg',
  'application/dwg',
  'image/vnd.dxf',
  'image/x-dxf',
  'application/dxf',
  // 影像與掃描檔案 (含地籍謄本/公文掃描檔 TIFF, JPEG, PNG 等)
  'image/tiff',
  'image/x-tiff',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-ms-bmp',
  // 公務郵件備份 (.eml, .msg)
  'message/rfc822',
  'application/vnd.ms-outlook',
  // 通用二進位串流 (若副檔名在允許清單中則允許)
  'application/octet-stream'
]

// 預設允許的副檔名清單 (公務人員常用文書、圖資、影像與壓縮檔)
const defaultAllowedExtensions = [
  // PDF & RTF
  'pdf', 'rtf',
  // MS Office
  'doc', 'docx', 'dot', 'dotx',
  'xls', 'xlsx', 'xlt', 'xltx',
  'ppt', 'pptx', 'pot', 'potx',
  // ODF 系列
  'odt', 'ott', 'ods', 'ots', 'odp', 'otp', 'odg', 'otg',
  // 純文字、資料與公文交換檔
  'txt', 'csv', 'xml', 'json', 'di',
  // 地政測量 CAD 圖資
  'dwg', 'dxf',
  // 影像與掃描檔 (包含 TIFF 謄本掃描檔)
  'tif', 'tiff', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
  // 壓縮檔 (含 rar)
  'rar', 'zip', '7z', 'gz', 'tar',
  // 電子郵件備份
  'eml', 'msg'
]

const allowedMimes = process.env.FILE_UPLOAD_ALLOWED_MIMES
  ? process.env.FILE_UPLOAD_ALLOWED_MIMES.split(',').map(v => v.trim().toLowerCase())
  : defaultMimes.map(v => v.toLowerCase())

const allowedExtensions = process.env.FILE_UPLOAD_ALLOWED_EXTENSIONS
  ? process.env.FILE_UPLOAD_ALLOWED_EXTENSIONS.split(',').map(v => v.trim().toLowerCase().replace(/^\./, ''))
  : defaultAllowedExtensions

// 副檔名取得輔助函式
const getFileExtension = (filename) => {
  if (!filename || typeof filename !== 'string') { return '' }
  return path.extname(filename).toLowerCase().replace(/^\./, '')
}

// File size limit (bytes) from environment, default 10 MB
const maxSize = parseInt(process.env.FILE_UPLOAD_MAX_SIZE) || 10 * 1024 * 1024

const fileFilter = (req, file, cb) => {
  const ext = getFileExtension(file.originalname)
  const mime = (file.mimetype || '').toLowerCase()

  // 1. 若環境變數設定 '*'，全數放行
  if (allowedMimes.includes('*') || allowedExtensions.includes('*')) {
    return cb(null, true)
  }

  // 2. 雙重檢核：
  // 若 MIME 在白名單中 (且非通用二進位 application/octet-stream)，直接通過
  // 若 MIME 為 application/octet-stream 或空字串，或不在 MIME 白名單但副檔名在允許名單中，亦通過 (避免 Windows/瀏覽器 MIME 判斷偏差)
  const isMimeAllowed = mime && mime !== 'application/octet-stream' && allowedMimes.includes(mime)
  const isExtAllowed = ext && allowedExtensions.includes(ext)

  if (isMimeAllowed || isExtAllowed) {
    return cb(null, true)
  }

  // 3. 雙重驗證皆未通過，回傳詳細錯誤訊息
  const err = makeError(
    `不支援檔案「${file.originalname || '未知檔名'}」的類型 (副檔名: ${ext ? '.' + ext : '無'}, 偵測類型: ${mime || '未知'})。允許格式包含：PDF、Office、ODF、純文字(TXT)、壓縮檔(ZIP/7Z/RAR)、圖資(DWG/DXF)、公文/謄本掃描(TIFF) 等常用公務檔案`,
    400,
    {
      code: 'UNSUPPORTED_FILE_TYPE',
      filename: file.originalname || '',
      ext: ext ? `.${ext}` : '',
      mime: file.mimetype || '',
      allowedExtensions
    }
  )
  cb(err, false)
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

// 附件刪除後即時通知相關連線 (ACK -13 / command: attachment_deleted)
const notifyAttachmentDeleted = (channel, messageId, filename) => {
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
            command: 'attachment_deleted',
            payload: { channel, message_id: parseInt(messageId), filename, attachments },
            success: true,
            message: `${channel} #${messageId} 移除附件 ${filename}`
          }, -13)
        }
      } catch (err) {
        utils.warn('notifyAttachmentDeleted send error', err.message)
      }
    })
  } catch (err) {
    utils.warn('notifyAttachmentDeleted error', err.message)
  }
}

// POST /upload – expects multipart/form-data with fields (依序): channel, message_id, file
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      status: 0,
      message: '未接收到上傳檔案或欄位名稱錯誤 (請確認上傳欄位名稱為 file，並依序傳送 channel, message_id, file)',
      details: { code: 'NO_FILE_UPLOADED' }
    })
  }
  const channel = req.uploadChannel || 'general'
  const messageId = req.uploadMessageId
  notifyAttachmentUploaded(channel, messageId, { name: req.file.filename, size: req.file.size })
  res.json({
    status: 1,
    data: {
      originalName: utils.sanitizeFilename(req.file.originalname),
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
    return res.status(400).json({
      status: 0,
      message: '無效的頻道名稱或訊息 ID 格式',
      details: { code: 'INVALID_PARAM', channel, messageId }
    })
  }
  res.json({ status: 1, data: utils.listAttachments(channel, messageId) })
})

// DELETE /attachments/:channel/:messageId/:filename – 刪除指定訊息的單一附件
router.delete('/attachments/:channel/:messageId/:filename', (req, res) => {
  const { channel, messageId, filename } = req.params
  if (!channelPattern.test(channel) || !messageIdPattern.test(messageId) || !isSafeFilename(filename)) {
    return res.status(400).json({
      status: 0,
      message: '無效的頻道名稱、訊息 ID 或檔名格式',
      details: { code: 'INVALID_PARAM', channel, messageId, filename }
    })
  }
  const deleted = utils.removeAttachmentFile(channel, messageId, filename)
  if (!deleted) {
    return res.status(404).json({
      status: -7,
      message: '找不到欲刪除的附件檔案',
      details: { code: 'ATTACHMENT_NOT_FOUND', channel, messageId, filename }
    })
  }
  notifyAttachmentDeleted(channel, messageId, filename)
  res.json({
    status: 1,
    message: 'Attachment deleted',
    data: {
      channel,
      message_id: parseInt(messageId),
      filename,
      attachments: utils.listAttachments(channel, messageId)
    }
  })
})

// GET /download/:channel/:filename – streams the file back to the client as an attachment (歷史相容路徑)
router.get('/download/:channel/:filename', (req, res) => {
  const { channel, filename } = req.params
  if (!channelPattern.test(channel) || !isSafeFilename(filename)) {
    return res.status(400).json({ status: 0, message: 'Invalid channel or filename' })
  }
  const filePath = path.join(uploadRoot, channel, filename)
  if (!filePath.startsWith(uploadRoot + path.sep)) {
    return res.status(400).json({ status: 0, message: 'Invalid path' })
  }
  const downloadName = utils.stripTimestamp(filename)
  // 一律以附件下載並禁止瀏覽器猜測內容類型，避免上傳的 html 等檔案被當網頁執行
  res.set('X-Content-Type-Options', 'nosniff')
  res.download(filePath, downloadName, { dotfiles: 'deny' }, err => {
    if (err && !res.headersSent) {
      utils.warn('File download error', err.message)
      res.status(404).json({ status: -7, message: 'File not found' })
    }
  })
})

// GET /download/:channel/:messageId/:filename – 下載指定訊息的附件
router.get('/download/:channel/:messageId/:filename', (req, res) => {
  const { channel, messageId, filename } = req.params
  if (!channelPattern.test(channel) || !messageIdPattern.test(messageId) || !isSafeFilename(filename)) {
    return res.status(400).json({ status: 0, message: 'Invalid channel, message_id or filename' })
  }
  const filePath = path.join(uploadRoot, channel, messageId, filename)
  if (!filePath.startsWith(uploadRoot + path.sep)) {
    return res.status(400).json({ status: 0, message: 'Invalid path' })
  }
  const downloadName = utils.stripTimestamp(filename)
  res.set('X-Content-Type-Options', 'nosniff')
  res.download(filePath, downloadName, { dotfiles: 'deny' }, err => {
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
  const notFound = err && (err.status === 404 || err.code === 'MESSAGE_NOT_FOUND')
  const status = notFound ? 404 : tooLarge ? 413 : (err && err.status) || 400

  let message = (err && err.message) || '上傳請求處理失敗'
  let details = (err && err.details) ? { ...err.details } : {}

  if (tooLarge) {
    const limitText = formatSize(maxSize)
    message = `檔案大小超過限制，單檔上限為 ${limitText}`
    details = {
      code: 'LIMIT_FILE_SIZE',
      maxSizeBytes: maxSize,
      maxSizeText: limitText,
      field: (err && err.field) || 'file'
    }
  }

  res.status(status).json({
    status: notFound ? -7 : 0,
    message,
    ...(Object.keys(details).length > 0 ? { details } : {})
  })
})

module.exports = router
