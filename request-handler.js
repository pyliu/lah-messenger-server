const path = require('path')
const utils = require(path.join(__dirname, 'utils.js'))
const MessageDB = require(path.join(__dirname, 'message-db.js'))
const ChannelDB = require(path.join(__dirname, 'channel-db.js'))

const isDev = process.env.NODE_ENV !== 'production'

class RequestHandler {
  constructor (wss, messageWatcher) {
    // singleton
    if (!RequestHandler._instance) {
      RequestHandler._instance = this
      // WebSocket Server
      this.wss = wss
      // MessageWatcher
      this.watcher = messageWatcher
    }
    return RequestHandler._instance
  }

  handle (ws, incomingRaw) {
    const incoming = JSON.parse(incomingRaw)

    isDev && console.log('收到客戶端訊息', incoming)

    if (incoming.channel === undefined && incoming.message.channel === undefined) {
      console.warn('沒有頻道資訊，無法處理此訊息', incoming)
      return
    }

    if (typeof incoming === 'object' && incoming.type) {
      switch (incoming.type) {
        case 'command':
          // handle system command
          return this.handleCommandRequest(ws, incoming.message)
        case 'mine':
          // client side sends message
          return this.handleClientRequest(ws, incoming)
        default:
          return false
      }
    } else {
      console.warn(`${incoming} is not a valid json object, skip the request ... `, `RAW: ${incomingRaw}`)
    }
    return false
  }

  handleCommandRequest (ws, message) {
    const json = typeof message === 'string' ? JSON.parse(message) : message
    const cmd = json.command
    switch (cmd) {
      case 'register':
        return this.executeRegisterCommand(ws, json)
      case 'mychannel':
        return this.executeQueryJoinChannelCommand(ws)
      case 'online':
        return this.executeQueryOnlineCommand(ws, json)
      case 'latest':
        return this.executeQueryLatestMessageCommand(ws, json)
      case 'previous':
        return this.executeQueryPreviousMessageCommand(ws, json)
      case 'set_read':
        return this.executeChannelSetReadCommand(ws, json)
      case 'check_read':
        return this.executeChannelCheckReadCommand(ws, json)
      case 'unread':
        return this.executeChannelUnreadCommand(ws, json)
      case 'remove_message':
        return this.executeRemoveMessageCommand(ws, json)
      case 'remove_channel':
        return this.executeRemoveChannelCommand(ws, json)
      case 'update_user':
        return this.executeUpdateUserCommand(ws, json)
      default:
        console.warn(`不支援的命令 ${cmd}`)
    }
    return false
  }

  executeRegisterCommand (ws, args) {
    /** expected args json format
      {
        command: 'register',
        ip: '192.168.24.2',
        domain: 'HBWEB',
        userid: 'HB0541',
        username: 'WHOAMI',
        dept: 'inf',
      }
     */
    const valid = typeof args === 'object'
    // inject client information into ws instance, currently it should contain ip, domain and username from remote client
    valid && (ws.user = { ...args, timestamp: +new Date() })

    const message = valid ? `遠端客戶端資料 (${ws.user.ip}, ${ws.user.domain}, ${ws.user.userid}, ${ws.user.username}, ${ws.user.dept}) 已儲存於 ws 物件中` : '無法完成 register 命令，因為格式不符'
    console.log(message)
    !valid && console.warn('收到參數', args)
    isDev && console.log('WS中的使用者資訊', ws.user)

    ws.send(utils.packMessage(
      // message payload
      {
        command: 'register',
        payload: ws.user,
        success: valid,
        message
      },
      // outter message attrs
      {
        type: 'ack',
        id: '-1', // temporary id for register
        channel: 'system'
      }
    ))

    return valid
  }

  executeQueryJoinChannelCommand (ws) {
    !ws.user && console.warn('無法完成 mychannel 命令，因為無使用者資訊')
    const db = new ChannelDB()
    ws.user && db.getChannelByParticipant(ws.user.userid, (row) => {
      isDev && console.log(`找到 ${ws.user.userid} 參與頻道資訊`, row)
      ws.send(utils.packMessage(
        // message payload
        {
          command: 'mychannel',
          payload: { action: 'add', ...row },
          success: true,
          message: `找到 ${row.id} 頻道`
        },
        // outter message attrs
        {
          type: 'ack',
          id: '-2', // temporary id for mychannel
          channel: 'system'
        }
      ))
    })
    return Boolean(ws.user)
  }

  executeRemoveChannelCommand (ws, json) {
    // const channel = json.channel
    /*
      item example: {
        id: 10,
        name: 'DONTCARE',
        participants: [ '0541', 'HB0542' ],
        type: 0
      }
    */
    const id = json.id
    const toBeRemoved = new MessageDB(id)
    // find online participants' ws to send ACK
    const participants = [...ws.wss.clients].filter((client, idx, arr) => {
      return json.participants.includes(client.user.userid)
    })
    toBeRemoved.remove((success) => {
      participants.forEach((participant) => {
        participant.send(utils.packMessage(
          // message payload
          {
            command: 'remove_channel',
            payload: json,
            success,
            message: success ? `已移除 ${id} / ${json.name} 頻道` : `移除 ${id} / ${json.name} 頻道失敗，請稍後再試`
          },
          // outter message attrs
          {
            type: 'ack',
            id: '-3', // temporary id for remove channel
            channel: 'system'
          }
        ))
      })
    })
  }

  executeQueryPreviousMessageCommand (ws, json) {
    const channel = String(json.channel)
    const count = parseInt(json.count) || 1
    const headId = json.headId
    const channelDB = new MessageDB(channel)
    const messages = channelDB.getPreviousMessagesByCount(headId, count)
    const hasMessage = messages && messages.length > 0
    if (hasMessage) {
      messages.forEach((message, idx, arr) => {
        if (channel.startsWith('announcement')) {
          ws.send(utils.packMessage(message, {
            channel,
            id: message.id,
            prepend: true
          }))
        } else {
          ws.send(utils.packMessage(message.content, {
            id: message.id,
            sender: message.sender,
            date: message.create_datetime.split(' ')[0],
            time: message.create_datetime.split(' ')[1],
            from: message.ip,
            channel,
            prepend: true,
            flag: message.flag,
            remove: message.title
          }))
        }
      })
    }

    ws.send(utils.packMessage(
      // message payload
      {
        command: 'previous',
        payload: json,
        success: hasMessage,
        message: hasMessage ? `已完成 ${channel} 歷史訊息讀取` : '已無歷史訊息'
      },
      // outter message attrs
      {
        type: 'ack',
        id: '-4', // temporary id for previous
        channel: 'system'
      }
    ))

    return true
  }

  executeChannelUnreadCommand (ws, json) {
    const channel = String(json.channel)
    const last = parseInt(json.last) || 0
    const channelDB = new MessageDB(channel)
    json.unread = channelDB.getUnreadMessageCount(last)
    ws.send(utils.packMessage(
      // message payload
      {
        command: 'unread',
        payload: json,
        success: true,
        message: `${channel} 共 ${json.unread} 筆未讀訊息`
      },
      // outter message attrs
      {
        type: 'ack',
        id: '-5', // temporary id for unread
        channel: 'system'
      }
    ))

    return true
  }

  executeRemoveMessageCommand (ws, json) {
    /** expected json
     {
        command: 'remove_message',
        channel: 'inf',
        id: '23'
      }
     */
    const targetChannel = String(json.channel)
    const targetId = parseInt(json.id) || 0
    const messageDB = new MessageDB(targetChannel)
    const result = messageDB.removeMesaage(targetId)
    const allConnectedWs = [...ws.wss.clients]
    allConnectedWs.forEach((thisWs) => {
      thisWs.send(utils.packMessage(
        // message payload
        {
          command: 'remove_message',
          payload: json,
          success: result !== false,
          message: `${targetChannel} 移除 #${targetId} 訊息${result !== false ? '成功' : '失敗'}`
        },
        // outter message attrs
        {
          type: 'ack',
          id: '-6', // temporary id for remove_message
          channel: 'system'
        }
      ))
    })
    return true
  }

  executeQueryOnlineCommand (ws, json) {
    const channel = String(json.channel)
    // assume the channel belongs to chatting room
    const depts = ['adm', 'inf', 'reg', 'sur', 'val', 'acc', 'hr', 'supervisor']
    // default get all connected clients
    let filteredClients = [...ws.wss.clients]
    if (depts.includes(channel)) {
      filteredClients = filteredClients.filter((client) => {
        return client.user && client.user.dept === channel
      })
    }
    // sort filtered client with its register timestamp
    filteredClients.sort((a, b) => {
      const aTs = parseInt(a.user?.timestamp)
      const bTs = parseInt(b.user?.timestamp)
      if (aTs && bTs) {
        // bigger ts at array front
        if (bTs > aTs) { return 1 }
        if (bTs < aTs) { return -1 }
      }
      return 0
    })
    // prepare ack payload info
    const ackUsers = filteredClients.map(client => client.user)

    ws.send(utils.packMessage(
      // message payload
      {
        command: 'online',
        payload: { ...json, users: ackUsers },
        success: ackUsers.length > 0,
        message: `找到 ${ackUsers.length} 已連線使用者`
      },
      // outter message attrs
      {
        type: 'ack',
        id: '-7', // temporary id for online
        channel: 'system'
      }
    ))

    return true
  }

  executeChannelSetReadCommand (ws, json) {
    // json.command === 'set_read'
    /** expected json
     {
        command: 'set_read',
        channel: 'HA8001XXXX',
        id: '123',
        flag: 0,
        sender: 'HA1001XXXX',
        cascade: true // if send message back to the sender to set the message in his channel
      }
     */
    const targetChannel = String(json.channel)
    const targetId = parseInt(json.id) || 0
    const flag = parseInt(json.flag) || 0
    const sender = json.sender
    const messageDB = new MessageDB(targetChannel)
    const result = messageDB.setMessageRead(targetId, flag)
    // send ack to the message sender ...
    const found = [...ws.wss.clients].find((ws) => {
      return ws.user?.userid === sender
    })

    // console.log('準備送出已讀ACK(-8)，接收者', found?.user)

    found && found.send(utils.packMessage(
      // message payload
      {
        command: 'set_read',
        payload: json,
        success: result !== false,
        cascade: json.cascade,
        message: `於 ${targetChannel} 頻道設定 #${targetId} 訊息已讀${result !== false ? '成功' : '失敗'}`
      },
      // outter message attrs
      {
        type: 'ack',
        id: '-8', // temporary id for set_read
        channel: 'system'
      }
    ))
    return true
  }

  executeChannelCheckReadCommand (ws, json) {
    // json.command === 'set_read'
    /** expected json
     {
        command: 'check_read',
        channel: 'HA8001XXXX',
        id: '123',
        sender: 'HA1001XXXX',
        senderChannelMessageId: '158',
        senderChannelMessageFlag: 0
      }
     */
    const senderChannel = String(json.sender)
    const senderMessageId = parseInt(json.senderChannelMessageId) || 0
    const senderMessageFlag = parseInt(json.senderChannelMessageFlag) || 0
    const targetChannel = String(json.channel)
    const targetId = parseInt(json.id) || 0
    const sender = json.sender
    const messageDB = new MessageDB(targetChannel)
    const result = messageDB.isMessageRead(targetId)
    // send ack to the message sender ...
    const found = [...ws.wss.clients].find((ws) => {
      return ws.user?.userid === sender
    })

    // console.log('準備送出已讀ACK(-9)，接收者', found?.user)

    found && found.send(utils.packMessage(
      // message payload
      {
        command: 'check_read',
        payload: json,
        success: result !== false,
        message: `於 ${senderChannel} 頻道設定 #${senderMessageId} 訊息已讀${result !== false ? '成功' : '失敗'}`
      },
      // outter message attrs
      {
        type: 'ack',
        id: '-9', // temporary id for check_read
        channel: 'system'
      }
    ))

    if (result !== false) {
      // set sender channel message read
      const messageDB = new MessageDB(senderChannel)
      !messageDB.setMessageRead(senderMessageId, senderMessageFlag) && console.warn(`設定 ${senderChannel} 頻道訊息 #${senderMessageId} 已讀失敗`)
    }

    return true
  }

  executeUpdateUserCommand (ws, json) {
    /** expected json
      {
        command: 'update_user',
        id: 'HA1001XXXX',
        info: {
          id: 'ID to be updated',
          name: 'Name to be updated',
          dept: 'Dept to be updated',
          ext: 'Ext to be updated',
          ip: 'IP to be updated',
          work: 'Work to be updated'
        }
      }
     */
    // prepare system command message
    const packedMessage = utils.packMessage({
      command: 'update_user',
      payload: json.info
    }, {
      channel: 'system'
    })
    // target user id
    const targetUserId = json.id
    // find online user's ws
    const found = [...ws.wss.clients].find((ws) => {
      return ws.user?.userid === targetUserId
    })
    if (found) {
      found.send(packedMessage)
      console.log(`傳送系統訊息至 ${targetUserId}`, packedMessage)
    } else {
      console.warn(`${targetUserId} 沒在線上，無法更新快取登入資訊!`, json)
    }
    return true
  }

  executeQueryLatestMessageCommand (ws, json) {
    const channel = String(json.channel)
    const count = parseInt(json.count) || 30
    const channelDB = new MessageDB(channel)
    const messages = channelDB.getLatestMessagesByCount(count)
    if (messages && messages.length > 0) {
      messages.forEach((message, idx, arr) => {
        if (channel.startsWith('announcement')) {
          ws.send(utils.packMessage(message, { channel, id: message.id }))
        } else {
          ws.send(utils.packMessage(message.content, {
            id: message.id,
            sender: message.sender,
            date: message.create_datetime.split(' ')[0],
            time: message.create_datetime.split(' ')[1],
            from: message.ip,
            channel,
            flag: message.flag,
            remove: message.title
          }))
        }
      })
    }
    return true
  }

  handleClientRequest (ws, json) {
    if (json.channel === 'chat') {
      // skip message from announcement channel
      console.log(`收到客戶端送給 ${json.channel} 頻道訊息，略過不處理。`, json)
      return false
    }
    // insert client sent message to the channel db; expected info: { changes: 1, lastInsertRowid: xx }
    const info = utils.insertMessageChannel(json.channel, json)
    // send ACK back to user to add talk record in own channel when sent private message
    if (info.changes === 1 && !json.channel?.startsWith('announcement') && !['chat', 'lds', 'inf', 'reg', 'val', 'adm', 'acc', 'hr', 'sur', 'supervisor'].includes(json.channel)) {
      // successful inserted message to channel
      // const message = utils.getLatestMessageByChannel(json.channel)
      ws.send(utils.packMessage(
        // message payload
        {
          command: 'private_message',
          payload: {
            ...json,
            insertedId: info.lastInsertRowid,
            flag: 1,
            remove: { to: json.channel, id: info.lastInsertRowid }
          },
          success: true,
          message: `已新增訊息到 ${json.channel} 頻道，該訊息 ID 為 ${info.lastInsertRowid}`
        },
        // outter message attrs
        {
          type: 'ack',
          id: '-99', // temporary id for online
          channel: 'system'
        }
      ))
    }
    return true
  }
}
module.exports = RequestHandler
