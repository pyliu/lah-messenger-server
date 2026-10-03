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
        'acc', // 會計
        'hr', // 人事
        'supervisor', // 主任/秘書
        'lds' // 喇迪賽
      ]
      MessageWatcher.lastBroadcastIdMap = {}
      // watch db folder for changes
      const nodeWatch = require('node-watch')
      nodeWatch(
        path.join(__dirname, 'db'),
        { recursive: true, filter: /\.db$/ },
        this.watchHandler.bind(this)
      )
    }
    return MessageWatcher._instance
  }

  broadcastChannelMessage (channel, row) {
    if (!row) {
      const mc = new MessageDB(channel)
      row = mc.getLatestMessage()
    }
    if (!row) {
      utils.log(`無法取得 ${channel} 最新訊息`)
      return false
    }

    const lastId = MessageWatcher.lastBroadcastIdMap[channel] || 0
    if (row.id && row.id <= lastId) {
      // 已經廣播過此訊息，略過重複推播
      return false
    }
    if (row.id) {
      MessageWatcher.lastBroadcastIdMap[channel] = row.id
    }

    const allClients = [...MessageWatcher.wss.clients]
    if (MessageWatcher.stickyChannels.includes(channel) || channel.startsWith('announcement')) {
      utils.broadcast(allClients, row, channel)
    } else {
      const packedMessage = utils.packMessage(row.content, {
        id: row.id,
        sender: row.sender,
        date: row.create_datetime.split(' ')[0],
        time: row.create_datetime.split(' ')[1],
        from: row.ip,
        channel,
        flag: row.flag,
        remove: row.title
      })

      utils.log(`找目前在 ${channel} 頻道的使用者，並發送訊息過去 ... (目前線上使用者 ${allClients.length} 位)`)
      allClients.filter(
        ws =>
          ws.user?.userid === channel || // personal message
          ws.user?.channel === channel || // group message
          (!ws.user && utils.allowAnonymous()) // 未註冊連線 (本機測試/監看用，需開啟 WS_ALLOW_ANONYMOUS)
      ).forEach(ws => {
        utils.log(`${ws.user?.username} 目前在 ${channel} 頻道，發送訊息給他 ... `)
        ws.send(packedMessage)
      })
    }
    return true
  }

  watchHandler (evt, name) {
    // evt => 'update' / 'remove', name => 'D:\CODE\lah-messenger-server\db\HAXXXXXXXX.db'
    const channel = path.basename(name, '.db')
    if (evt === 'update') {
      const mc = new MessageDB(channel)
      const row = mc.getLatestMessage()
      utils.log(`偵測到 ${channel} 訊息更新 (node-watch)`)
      if (row) {
        this.broadcastChannelMessage(channel, row)
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
      case 'acc': // 會計
        return MessageWatcher.filterOnlineClientsByDept('acc')
      case 'hr': // 人事
        return MessageWatcher.filterOnlineClientsByDept('hr')
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
