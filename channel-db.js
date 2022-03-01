const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')
const utils = require(path.join(__dirname, 'utils.js'))

const isDev = process.env.NODE_ENV !== 'production'

class ChannelDB {
  constructor () {
    this.dbDir = path.join(__dirname, 'dimension')
    if (!fs.existsSync(this.dbDir)) {
      fs.mkdirSync(this.dbDir)
    }
    this.filepath = path.join(this.dbDir, 'channel') + '.db'
    this.createTable()
    this.db = new Database(this.filepath, { verbose: isDev ? console.log : null })
  }

  close () {
    this.db.close()
  }

  async createTable () {
    if (!fs.existsSync(this.filepath)) {
      const db = new Database(this.filepath, { verbose: isDev ? console.log : null })
      let stmt = db.prepare(`
        CREATE TABLE IF NOT EXISTS "channel" (
          "id" INTEGER,
          "name" TEXT NOT NULL,
          "host" TEXT,
          "password" TEXT,
          "type" INTEGER NOT NULL DEFAULT 0,
          "last" INTEGER NOT NULL DEFAULT -1,
          PRIMARY KEY("id" AUTOINCREMENT)
        )
      `)
      stmt.run()
      stmt = db.prepare(`
        CREATE TABLE IF NOT EXISTS "participant" (
          "id" INTEGER,
          "channel_id" INTEGER NOT NULL,
          "user_id" TEXT NOT NULL,
          PRIMARY KEY("id" AUTOINCREMENT)
        )
      `)
      stmt.run()
      await utils.sleep(400)
      db.close()
    }
  }

  timestamp (date = 'full') {
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

  updateChannelLastUpdated (channel) {
    let channelId = channel
    switch (channelId) {
      case 'inf':
        channelId = '1'
        break
      case 'adm':
        channelId = '2'
        break
      case 'reg':
        channelId = '3'
        break
      case 'sur':
        channelId = '4'
        break
      case 'val':
        channelId = '5'
        break
      case 'supervisor':
        channelId = '6'
        break
      case 'hr':
        channelId = '7'
        break
      case 'acc':
        channelId = '8'
        break
      case 'lds':
        channelId = '9'
        break
      case 'announcement':
        channelId = '10'
        break
      default:
        break
    }
    const info = this.db.prepare('UPDATE channel SET last = $last WHERE id = $id').run({ id: channelId, last: +new Date() })
    // info: { changes: 1, lastInsertRowid: 0 }
    isDev && console.log('更新成功', info)
  }

  insertChannel (params) {
    const info = this.db.prepare(`
      INSERT INTO channel(name, host, password, type)
      VALUES ($name, $host, $password, $type)
    `).run({
      ...{
        name: '',
        host: '',
        password: '',
        type: 0 // 0 -> 1 on 1, 1 -> group, 2 -> broadcast channel
      },
      ...params
    })
    // info: { changes: 1, lastInsertRowid: 0 }
    isDev && console.log('新增頻道成功', info, params)
    return info
  }

  getGroupChannels () {
    return this.db.prepare('SELECT * FROM channel WHERE type = \'1\' ORDER BY name, id').all()
  }

  getOneOnOneChannels () {
    return this.db.prepare('SELECT * FROM channel WHERE type = \'0\' ORDER BY name, id').all()
  }

  getBroadcastChannels () {
    return this.db.prepare('SELECT * FROM channel WHERE type = \'2\' ORDER BY name, id').all()
  }

  getChannelsByHost (userId) {
    return this.db.prepare('SELECT * FROM channel WHERE host = $user_id ORDER BY name, id').all({ user_id: userId })
  }

  getChannelByParticipant (userId, callback) {
    const stmt = this.db.prepare(`
      SELECT * FROM channel WHERE id IN (SELECT DISTINCT channel_id FROM participant WHERE user_id = $user_id)
      ORDER BY name, id
    `)
    for (const channel of stmt.iterate({user_id: userId})) {
      // channel: { id: 10, name: 'DONTCARE', host: null, password: null, type: 0 }
      // add participants into the channel row
      const allParticipants = this.getAllParticipantsByChannel(channel.id)
      channel.participants = []
      allParticipants.forEach((val, idx, arr) => {
        channel.participants.push(val.user_id)
      })
      // callback for the channel
      callback(channel)
    }
  }

  getAllParticipantsByChannel (channelId) {
    return this.db.prepare(`
      SELECT * FROM participant WHERE channel_id = $channel_id
      ORDER BY user_id
    `).all({ channel_id: channelId })
  }
}
module.exports = ChannelDB
