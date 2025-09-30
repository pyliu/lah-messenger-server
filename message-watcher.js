const path = require('path')
const utils = require('./utils.js')
const MessageDB = require(path.join(__dirname, 'message-db.js'))
const ChannelDB = require(path.join(__dirname, 'channel-db.js'))

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
    // evt => 'update' / 'remove', name => 'D:\CODE\lah-messenger-server\db\HAXXXXXXXX.db'
    // e.g. HA20023698.db
    // const basename = path.basename(name)
    // e.g. HA20023698
    const channel = path.basename(name, '.db')
    if (evt === 'update') {
      // on create or modify
      const mc = new MessageDB(channel)
      const row = mc.getLatestMessage()
      utils.log(`偵測到 ${channel} 訊息更新`)
      if (row) {
        const allClients = [...MessageWatcher.wss.clients]
        if (MessageWatcher.stickyChannels.includes(channel) || channel.startsWith('announcement')) {
          // const wsClients = MessageWatcher.getOnlineWsClients(channel)
          utils.broadcast(allClients, row, channel)
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

          // find client ws to send message
          utils.log(`找目前在 ${channel} 頻道的使用者，並發送訊息過去 ... (目前線上使用者 ${allClients.length} 位)`)
          allClients.filter(
            ws =>
              ws.user?.userid === channel ||  // personal message
              ws.user?.channel === channel  // group message
          ).forEach(ws => {
            utils.log(`${ws.user.username} 目前在 ${channel} 頻道，發送訊息給他 ... `)
            ws.send(packedMessage)
          })

          // search channel participants and delivery message to them
          // const channelDb = new ChannelDB()
          // const participants = channelDb.getAllParticipantsByChannel(channel)
          // participants.forEach((participant, idx, arr) => {
          //   const found = wsClients.find((ws, idx, arr) => {
          //     if (ws.user) {
          //       return ws.user.userid === participant.user_id
          //     }
          //     return false
          //   })
          //   found && found.send(packedMessage)
          // })
        }
      } else {
        utils.log(`無法取得 ${channel} 最新訊息`)
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
