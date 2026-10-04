const OS = require('os')
let ip = require('ip').address()
// get all ip addresses by node.js os module
const nets = OS.networkInterfaces()
for (const name of Object.keys(nets)) {
  for (const net of nets[name]) {
    // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
    if (net.family === 'IPv4' && !net.internal) {
      ip = net.address
    }
  }
}
const isEmpty = require('lodash/isEmpty')
const { marked } = require('marked')
const DOMPurify = require('dompurify')
const WebSocket = require('ws')
const MessageDB = require('./message-db.js')

marked.setOptions({
  breaks: true,
  sanitizer: DOMPurify.sanitize
})

require('dotenv').config()

const isDev = process.env.NODE_ENV !== 'production'

// 是否允許「未註冊 (沒有 userid/username)」的連線接收推播，僅供本機測試/監看用，預設關閉
const allowAnonymous = () => String(process.env.WS_ALLOW_ANONYMOUS).toLowerCase() === 'true'

const log = function () {
  // 檢查是否有傳入參數
  if (arguments.length === 0) {
    isDev && console.log();
    return;
  }
  // 檢查第一個參數是否為 true
  if (arguments[0] === true) {
    // 如果是 true，則建立一個不包含第一個元素的新陣列
    // Array.prototype.slice.call(arguments, 1) 會從索引 1 開始切割參數列表
    const argsToLog = Array.prototype.slice.call(arguments, 1);
    console.log(...argsToLog);
  } else {
    // 如果第一個參數不是 true，則行為保持不變
    // 只有在 isDev 為 true 時才輸出日誌
    isDev && console.log(...arguments);
  }
}

const warn = function () {
  // 檢查是否有傳入參數
  if (arguments.length === 0) {
    isDev && console.warn();
    return;
  }
  // 檢查第一個參數是否為 true
  if (arguments[0] === true) {
    // 如果是 true，則建立一個不包含第一個元素的新陣列
    // Array.prototype.slice.call(arguments, 1) 會從索引 1 開始切割參數列表
    const argsToLog = Array.prototype.slice.call(arguments, 1);
    console.warn(...argsToLog);
  } else {
    // 如果第一個參數不是 true，則行為保持不變
    // 只有在 isDev 為 true 時才輸出日誌
    isDev && console.warn(...arguments);
  }
}

const error = function () {
  console.error(...arguments)
}

const trim = (x) => { return typeof x === 'string' ? x.replace(/^[\s\r\n]+|[\s\r\n]+$/gm, '') : '' }

const timestamp = function (date = 'time', showMs = false) {
  const now = new Date();

  const year = now.getFullYear()
  const month = (now.getMonth() + 1).toString().padStart(2, '0')
  const day = now.getDate().toString().padStart(2, '0')
  // Extract hours, minutes, seconds, and milliseconds
  const hours = now.getHours().toString().padStart(2, '0')
  const minutes = now.getMinutes().toString().padStart(2, '0')
  const seconds = now.getSeconds().toString().padStart(2, '0');
  const milliseconds = now.getMilliseconds().toString().padStart(3, '0');

  // e.g. 2024-10-29 10:40:00.123
  const formatted = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}${showMs ? `.${milliseconds}` : ''}`
  if (date === "full") {
    return formatted;
  } else if (date === "date") {
    return formatted.split(" ")[0];
  } else {
    // e.g. 16:03:00.123
    return formatted.split(" ")[1];
  }
}

const packMessage = function (payload, opts = {}) {
  const args = {
    ...{
      type: 'remote',
      id: '0',
      sender: process.env.WEBSOCKET_ROBOT_NAME,
      date: timestamp('date'),
      time: timestamp('time'),
      message: payload,
      from: ip,
      channel: 'blackhole',
      prepend: false
    },
    ...opts
  }
  if (typeof args.message === 'string') {
    args.message = trim(marked.parse(args.message, { sanitizer: DOMPurify.sanitize }))
    // markd generated message into <p>....</p>
    const innerText = args.message.replace(/(<p[^>]+?>|<p>|<\/p>)/img, '')
    // test if the inner text contain HTML element
    if (!/<\/?[a-z][\s\S]*>/i.test(innerText)) {
      args.message = args.message.replace(/(?:\r\n|\r|\n)/g, '<br/>')
    }
  }
  return JSON.stringify(args)
}

const broadcast = (clients, rowORtext, channel = 'lds') => {
  if (!Array.isArray(clients) || clients.length === 0) {
    return
  }
  const messageId = typeof rowORtext === 'string' ? 0 : rowORtext.id
  const opts = {}
  if (channel.startsWith('announcement')) {
    opts.id = rowORtext.id
  } else {
    opts.id = rowORtext.id
    opts.sender = rowORtext.sender
    opts.date = rowORtext.create_datetime.split(' ')[0]
    opts.time = rowORtext.create_datetime.split(' ')[1]
    opts.message = marked.parseInline(marked.parse(rowORtext.content))
    opts.from = rowORtext.$from_ip
    opts.channel = channel
  }

  const json = packMessage(rowORtext, { channel, id: messageId, ...opts })
  clients.forEach(function each (client) {
    if (!client.user && !allowAnonymous()) {
      // 略過沒有使用者資訊的連線
    } else if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(json)
      } catch (err) {
        console.error(`[utils.broadcast] 傳送至 ${client.user?.userid} 失敗:`, err)
      }
    }
  })
}

const insertMessageChannel = (channel, json) => {
  const channelDB = new MessageDB(channel)
  const priority = parseInt(json.priority)
  return channelDB.insertMessage({
    title: json.title || 'dontcare',
    content: json.message,
    sender: json.sender,
    priority: priority === 0 ? 0 : priority || 3,
    from_ip: json.from || '',
    flag: parseInt(json.flag) || 0
  })
}

const getLatestMessageByChannel = (channel) => {
  const channelDB = new MessageDB(channel)
  return channelDB.getLatestMessage()
}

const sleep = function (ms = 0) {
  // eslint-disable-next-line promise/param-names
  return new Promise(r => setTimeout(r, ms))
}

const sendCommand = function (ws, cmdPayload) {
    // prepare system command message
    if (ws) {
      ws.send(packMessage(cmdPayload, { channel: 'system' }))
      log('已傳送系統訊息', cmdPayload)
    } else {
      console.warn('無法傳送系統訊息!', cmdPayload)
    }
}

const sendAck = function (ws, commandPayload, ackInt = -99) {
  // ws.send(utils.packMessage(
  //   // message payload
  //   {
  //     command: 'register',
  //     payload: ws.user,
  //     success: valid,
  //     message
  //   },
  //   // outter message attrs
  //   {
  //     type: 'ack',
  //     id: '-1', // temporary id for register
  //     channel: 'system'
  //   }
  // ))
  ws?.send(packMessage(
    // message payload
    commandPayload,
    // outter message attrs
    {
      type: 'ack',
      id: String(ackInt), // temporary id for register
      channel: 'system'
    }
  ))
}

// Ensure a directory exists (recursive)
const ensureDir = function (dir) {
  const fs = require('fs')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// 附件以目錄對應訊息: uploads/<channel>/<message_id>/<filename>
const attachmentChannelPattern = /^[A-Za-z0-9_-]{1,64}$/
const attachmentMessageIdPattern = /^[1-9][0-9]{0,15}$/
const getAttachmentDir = function (channel, messageId) {
  const path = require('path')
  const ch = String(channel)
  const mid = String(messageId)
  if (!attachmentChannelPattern.test(ch) || !attachmentMessageIdPattern.test(mid)) {
    return null
  }
  return path.join(__dirname, 'uploads', ch, mid)
}

// 移除檔名中舊版留存的時間戳前綴 (例: 1791086738695_a.pdf -> a.pdf)
const stripTimestamp = function (filename) {
  if (!filename) { return '' }
  return String(filename).replace(/^\d{10,14}_/, '')
}

// 修復 Multer 1.4.x 對 UTF-8 檔名以 latin1 解析的問題，並過濾路徑危險字元
const sanitizeFilename = function (rawName) {
  if (!rawName) { return 'file' }
  let decoded = String(rawName)
  try {
    const converted = Buffer.from(decoded, 'latin1').toString('utf8')
    if (!converted.includes('\ufffd')) {
      decoded = converted
    }
  } catch (e) {}
  // 移除危險路徑字元 \ / : * ? " < > | 以及控制字元
  // eslint-disable-next-line no-control-regex
  let safe = decoded.replace(/[\/\\:\*\?"<>\|\x00-\x1f\x7f]/g, '_').trim()
  // 去除開頭的點，避免成為隱藏檔
  safe = safe.replace(/^\.+/, '')
  if (!safe) { safe = 'file' }
  return safe
}

// 若目錄下已有同名檔案，自動遞增序號: 檔名 (1).副檔名, 檔名 (2).副檔名
const getUniqueFilename = function (dir, filename) {
  const fs = require('fs')
  const path = require('path')
  const safeName = sanitizeFilename(filename)
  const fullPath = path.join(dir, safeName)
  if (!fs.existsSync(fullPath)) {
    return safeName
  }
  const ext = path.extname(safeName)
  const base = path.basename(safeName, ext)
  let count = 1
  while (fs.existsSync(path.join(dir, `${base} (${count})${ext}`))) {
    count++
  }
  return `${base} (${count})${ext}`
}

// 列出某訊息的附件，目錄不存在或任何錯誤皆回傳空陣列
const listAttachments = function (channel, messageId) {
  try {
    const fs = require('fs')
    const path = require('path')
    const dir = getAttachmentDir(channel, messageId)
    if (!dir || !fs.existsSync(dir)) {
      return []
    }
    return fs.readdirSync(dir)
      .filter(name => !name.startsWith('.'))
      .map(name => {
        const stat = fs.statSync(path.join(dir, name))
        return { name, size: stat.size }
      })
  } catch (err) {
    warn('listAttachments error', err.message)
    return []
  }
}

// 移除某訊息的所有附件 (刪訊息時呼叫)
const removeAttachments = function (channel, messageId) {
  try {
    const fs = require('fs')
    const dir = getAttachmentDir(channel, messageId)
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch (err) {
    warn('removeAttachments error', err.message)
  }
}

// 移除單一附件檔案，若目錄為空則一併清理空目錄
const removeAttachmentFile = function (channel, messageId, filename) {
  try {
    const fs = require('fs')
    const path = require('path')
    const dir = getAttachmentDir(channel, messageId)
    if (!dir || !fs.existsSync(dir)) {
      return false
    }
    const filePath = path.join(dir, filename)
    if (!filePath.startsWith(dir + path.sep)) {
      return false
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      const remaining = fs.readdirSync(dir).filter(name => !name.startsWith('.'))
      if (remaining.length === 0) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
      return true
    }
    return false
  } catch (err) {
    warn('removeAttachmentFile error', err.message)
    return false
  }
}

module.exports.timestamp = timestamp
module.exports.packMessage = packMessage
module.exports.getAttachmentDir = getAttachmentDir
module.exports.stripTimestamp = stripTimestamp
module.exports.sanitizeFilename = sanitizeFilename
module.exports.getUniqueFilename = getUniqueFilename
module.exports.listAttachments = listAttachments
module.exports.removeAttachments = removeAttachments
module.exports.removeAttachmentFile = removeAttachmentFile
module.exports.broadcast = broadcast
module.exports.insertMessageChannel = insertMessageChannel
module.exports.getLatestMessageByChannel = getLatestMessageByChannel
module.exports.trim = trim
module.exports.sleep = sleep
module.exports.isEmpty = isEmpty
module.exports.ip = ip
module.exports.sendAck = sendAck
module.exports.sendCommand = sendCommand
module.exports.log = log
module.exports.warn = warn
module.exports.error = error
module.exports.ensureDir = ensureDir
module.exports.allowAnonymous = allowAnonymous
