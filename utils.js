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

let broadcasting = false
const broadcast = (clients, rowORtext, channel = 'lds') => {
  const connected = clients.length
  if (broadcasting === false && connected > 0) {
    broadcasting = true
    let processed = 0
    clients.forEach(function each (client) {
      if (!client.user) {
        console.log('沒有使用者資訊，略過廣播此WS頻道 ... ')
      } else if (client.readyState === WebSocket.OPEN) {
        // if the input is a array then retrive its id as the message id
        const messageId = typeof rowORtext === 'string' ? 0 : rowORtext.id

        // channel === 'supervisor' && console.log(rowORtext)
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
        client.send(json)
      }

      processed++
      if (processed === connected) {
        broadcasting = false
      }
    })
  }
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

module.exports.timestamp = timestamp
module.exports.packMessage = packMessage
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
