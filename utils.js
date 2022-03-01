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

require('dotenv').config()

const trim = (x) => { return typeof x === 'string' ? x.replace(/^[\s\r\n]+|[\s\r\n]+$/gm, '') : '' }

const timestamp = function (date = 'time') {
  const now = new Date()
  const full = now.getFullYear() + '-' +
    ('0' + (now.getMonth() + 1)).slice(-2) + '-' +
    ('0' + now.getDate()).slice(-2) + ' ' +
    ('0' + now.getHours()).slice(-2) + ':' +
    ('0' + now.getMinutes()).slice(-2) + ':' +
    ('0' + now.getSeconds()).slice(-2)
  if (date === 'full') {
    // e.g. 2021-03-14 16:03:00
    return full
  } else if (date === 'date') {
    return full.split(' ')[0]
  } else {
    // e.g. 16:03:00
    return full.split(' ')[1]
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
          opts.message = marked.parse(rowORtext.content, { sanitizer: DOMPurify.sanitize })
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

module.exports.timestamp = timestamp
module.exports.packMessage = packMessage
module.exports.broadcast = broadcast
module.exports.insertMessageChannel = insertMessageChannel
module.exports.getLatestMessageByChannel = getLatestMessageByChannel
module.exports.trim = trim
module.exports.sleep = sleep
module.exports.isEmpty = isEmpty
module.exports.ip = ip
