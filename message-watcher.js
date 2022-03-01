const path = require('path')
const utils = require('./utils.js')
const MessageDB = require(path.join(__dirname, 'message-db.js'))
const ChannelDB = require(path.join(__dirname, 'channel-db.js'))

const isDev = process.env.NODE_ENV !== 'production'

class MessageWatcher {
  constructor (wss) {
    // singleton
    if (!MessageWatcher._instance) {
      MessageWatcher._instance = this
      // WebSocket Server
      MessageWatcher.wss = wss
      // static channels
      MessageWatcher.stickyChannels = [
        'announcement', // 公告
        'adm', // 行政
        'reg', // 登記
        'sur', // 測量
        'inf', // 資訊
        'val', // 地價
        'supervisor', // 主任/秘書
        'lds' // 喇迪賽
      ]
      // watch db folder for changes
      const nodeWatch = require('node-watch')
      nodeWatch(
        path.join(__dirname, 'db'),
        { recursive: true, filter: /\.db$/ },
        this.watchHandler
      )
    }
    return MessageWatcher._instance
  }

  watchHandler (evt, name) {
    // evt => 'update' / 'remove', name => 'D:\tmp\code\lah-nuxtjs\ws\db\0541.db'
    // e.g. 0541.db
    // const basename = path.basename(name)
    // e.g. 0541
    const channel = path.basename(name, '.db')
    if (evt === 'update') {
      // on create or modify
      const mc = new MessageDB(channel)
      const row = mc.getLatestMessage()
      if (row) {
        const wsClients = MessageWatcher.getOnlineWsClients(channel)
        if (MessageWatcher.stickyChannels.includes(channel) || channel.startsWith('announcement')) {
          utils.broadcast(wsClients, row, channel)
        } else {
          // prepare message
          const packedMessage = utils.packMessage(row.content, {
            id: row.id,
            sender: row.sender,
            date: row.create_datetime.split(' ')[0],
            time: row.create_datetime.split(' ')[1],
            from: row.ip,
            channel,
            flag: row.flag, // remove PM required
            remove: row.title // remove PM required
          })

          // find user own channel ws
          const ownWs = wsClients.find((ws, idx, arr) => {
            if (ws.user) {
              return ws.user.userid === channel
            }
            return false
          })
          ownWs && ownWs.send(packedMessage)

          // search channel participants and delivery message to them
          const channelDb = new ChannelDB()
          const participants = channelDb.getAllParticipantsByChannel(channel)
          participants.forEach((participant, idx, arr) => {
            const found = wsClients.find((ws, idx, arr) => {
              if (ws.user) {
                return ws.user.userid === participant.user_id
              }
              return false
            })
            found && found.send(packedMessage)
          })
        }
      } else {
        isDev && console.log(`無法取得 ${channel} 最新訊息`)
      }
    }

    if (evt === 'remove') {
      // on delete
    }
  }

  static filterOnlineClientsByDept (dept) {
    return [...MessageWatcher.wss.clients].filter(function (ws, idx, array) {
      if (ws.user) {
        return ws.user.dept === dept
      }
      return false
    })
  }

  static getOnlineWsClients (channel) {
    switch (channel) {
      case 'adm': // 行政
        return MessageWatcher.filterOnlineClientsByDept('adm')
      case 'reg': // 登記
        return MessageWatcher.filterOnlineClientsByDept('reg')
      case 'sur': // 測量
        return MessageWatcher.filterOnlineClientsByDept('sur')
      case 'inf': // 資訊
        return MessageWatcher.filterOnlineClientsByDept('inf')
      case 'val': // 地價
        return MessageWatcher.filterOnlineClientsByDept('val')
      case 'supervisor': // 主任/秘書
        return MessageWatcher.filterOnlineClientsByDept('supervisor')
      case 'lds': // 喇迪賽
      case 'announcement':
      default:
        return [...MessageWatcher.wss.clients]
    }
  }
}
module.exports = MessageWatcher
