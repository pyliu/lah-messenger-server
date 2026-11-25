const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SERVER_DIR = path.resolve(__dirname, '..')

// 若測試執行環境為現代 Node.js (ABI 147) 而無法載入 ABI 93 的 better-sqlite3 原生模組，
// 僅於測試層透過 Node.js 內建 node:sqlite 提供相容轉接器，不修改正式程式碼或安裝新套件。
function ensureBetterSqlite3Compatible () {
  const pkgPath = require.resolve('better-sqlite3', { paths: [SERVER_DIR] })
  try {
    const BetterSqlite3 = require(pkgPath)
    const probe = new BetterSqlite3(':memory:')
    probe.close()
  } catch (err) {
    if (err.code !== 'ERR_DLOPEN_FAILED') {
      throw err
    }
    const { DatabaseSync } = require('node:sqlite')
    class BetterSqlite3TestShim {
      constructor (filepath) {
        this._db = new DatabaseSync(filepath)
      }

      prepare (sql) {
        // better-sqlite3 使用 $name 具名參數並會把傳入物件多餘 key 忽略或對應，node:sqlite 支援 $name，
        // 但 node:sqlite 在無 $ 前綴時不會自動忽略未出現在 SQL 的屬性，因此需篩選 SQL 中實際使用的具名參數。
        const paramMatches = [...sql.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1])
        const namedKeys = [...new Set(paramMatches)]
        const stmt = this._db.prepare(sql)
        const bindArg = (args) => {
          if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && namedKeys.length > 0) {
            const raw = args[0]
            const filtered = {}
            for (const k of namedKeys) {
              filtered[`$${k}`] = raw[k] === undefined ? null : raw[k]
            }
            return [filtered]
          }
          return args
        }
        return {
          run: (...args) => stmt.run(...bindArg(args)),
          get: (...args) => stmt.get(...bindArg(args)),
          all: (...args) => stmt.all(...bindArg(args)),
          pluck: () => ({
            get: (...args) => {
              const row = stmt.get(...bindArg(args))
              if (!row) return undefined
              return Object.values(row)[0]
            }
          })
        }
      }

      transaction (fn) {
        const execTx = (...args) => {
          this._db.exec('BEGIN IMMEDIATE')
          try {
            const res = fn(...args)
            this._db.exec('COMMIT')
            return res
          } catch (e) {
            this._db.exec('ROLLBACK')
            throw e
          }
        }
        execTx.deferred = (...args) => execTx(...args)
        return execTx
      }

      close () {
        this._db.close()
      }
    }
    require.cache[pkgPath] = {
      id: pkgPath,
      filename: pkgPath,
      loaded: true,
      exports: BetterSqlite3TestShim
    }
  }
}

ensureBetterSqlite3Compatible()

const MessageDB = require(path.join(SERVER_DIR, 'message-db.js'))
const RequestHandler = require(path.join(SERVER_DIR, 'request-handler.js'))
const utils = require(path.join(SERVER_DIR, 'utils.js'))

const TEST_CHANNEL = `announcement_test_bump_${Date.now()}`
const TEST_DB_PATH = path.join(SERVER_DIR, 'db', `${TEST_CHANNEL}.db`)
const TEST_UPLOAD_ROOT = path.join(SERVER_DIR, 'uploads', TEST_CHANNEL)

function createMockClient (userid) {
  const sent = []
  return {
    user: userid ? { userid, username: userid } : undefined,
    readyState: 1,
    sent,
    send (raw) {
      sent.push(JSON.parse(raw))
    }
  }
}

function setupChannelMessages (channel) {
  const db = new MessageDB(channel)
  const first = db.insertMessage({
    title: '第一則舊公告',
    content: '這是需要被推前的公告內容',
    priority: 1,
    create_datetime: '2026-10-01 09:00:00',
    expire_datetime: '2026-12-31 23:59:59',
    sender: 'HA0001',
    from_ip: '192.168.10.11',
    flag: 0
  })
  const second = db.insertMessage({
    title: '第二則較新公告',
    content: '原本排在最後面的公告',
    priority: 2,
    create_datetime: '2026-10-02 10:30:00',
    expire_datetime: '',
    sender: 'HA0002',
    from_ip: '192.168.10.12',
    flag: 0
  })
  db.close()
  return {
    firstId: Number(first.lastInsertRowid),
    secondId: Number(second.lastInsertRowid)
  }
}

test.describe('bump_message WebSocket 命令整合測試 (Seam 1)', () => {
  test.beforeEach(() => {
    RequestHandler._instance = null
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.rmSync(TEST_DB_PATH, { force: true })
    }
    if (fs.existsSync(TEST_UPLOAD_ROOT)) {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true })
    }
  })

  test.after(() => {
    RequestHandler._instance = null
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.rmSync(TEST_DB_PATH, { force: true })
    }
    if (fs.existsSync(TEST_UPLOAD_ROOT)) {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true })
    }
  })

  test('正常頂起：重鑄新 ID、保留原始 create_datetime 與欄位、全體廣播 remove_message 並對多端回傳 ACK -14', () => {
    const { firstId, secondId } = setupChannelMessages(TEST_CHANNEL)
    const opClientA = createMockClient('HA0001')
    const opClientB = createMockClient('HA0001')
    const viewerClient = createMockClient('HA0003')
    const clients = new Set([opClientA, opClientB, viewerClient])
    const wss = { clients }
    opClientA.wss = wss
    opClientB.wss = wss
    viewerClient.wss = wss

    const broadcasted = []
    const mockWatcher = {
      broadcastChannelMessage (channel, row) {
        broadcasted.push({ channel, row })
      }
    }
    const handler = new RequestHandler(wss, mockWatcher)

    const ok = handler.handle(opClientA, JSON.stringify({
      type: 'command',
      channel: 'system',
      sender: 'HA0001',
      message: JSON.stringify({
        command: 'bump_message',
        channel: TEST_CHANNEL,
        id: firstId,
        sender: 'HA0001'
      })
    }))

    assert.equal(ok, true)

    const db = new MessageDB(TEST_CHANNEL)
    assert.equal(db.getMessageById(firstId), undefined, '舊公告 ID 應已刪除')
    const latest = db.getLatestMessage()
    assert.ok(latest.id > secondId, '頂起後的新 ID 應大於原最新公告 ID')
    assert.equal(latest.title, '第一則舊公告')
    assert.equal(latest.content, '這是需要被推前的公告內容')
    assert.equal(latest.priority, 1)
    assert.equal(latest.create_datetime, '2026-10-01 09:00:00', '應保留原始發布時間')
    assert.equal(latest.sender, 'HA0001')
    db.close()

    assert.equal(broadcasted.length, 1)
    assert.equal(broadcasted[0].channel, TEST_CHANNEL)
    assert.equal(broadcasted[0].row.id, latest.id)

    for (const c of [opClientA, opClientB, viewerClient]) {
      const rmAck = c.sent.find(m => m.type === 'ack' && m.message?.command === 'remove_message')
      assert.ok(rmAck, '所有連線皆應收到舊 ID 的 remove_message ACK')
      assert.equal(rmAck.message.payload.id, firstId)
      assert.equal(rmAck.message.payload.channel, TEST_CHANNEL)
    }

    for (const op of [opClientA, opClientB]) {
      const bumpAck = op.sent.find(m => m.type === 'ack' && m.id === '-14' && m.message?.command === 'bump_message')
      assert.ok(bumpAck, '操作者的每個在線連線皆應收到 bump_message ACK (-14)')
      assert.equal(bumpAck.message.success, true)
      assert.equal(bumpAck.message.payload.oldId, firstId)
      assert.equal(bumpAck.message.payload.newId, latest.id)
    }

    const viewerBumpAck = viewerClient.sent.find(m => m.message?.command === 'bump_message')
    assert.equal(viewerBumpAck, undefined, '非操作者不應收到專屬 bump_message ACK')
  })

  test('含附件頂起：附件目錄自 oldId 搬移至 newId 且列表完整', () => {
    const { firstId } = setupChannelMessages(TEST_CHANNEL)
    const oldAttDir = utils.getAttachmentDir(TEST_CHANNEL, firstId)
    fs.mkdirSync(oldAttDir, { recursive: true })
    fs.writeFileSync(path.join(oldAttDir, '測試簡報.pdf'), 'PDF-CONTENT', 'utf8')

    const client = createMockClient('HA0001')
    const wss = { clients: new Set([client]) }
    client.wss = wss
    const handler = new RequestHandler(wss, { broadcastChannelMessage () {} })

    const ok = handler.handle(client, JSON.stringify({
      type: 'command',
      channel: 'system',
      sender: 'HA0001',
      message: JSON.stringify({
        command: 'bump_message',
        channel: TEST_CHANNEL,
        id: firstId,
        sender: 'HA0001'
      })
    }))

    assert.equal(ok, true)
    const bumpAck = client.sent.find(m => m.message?.command === 'bump_message')
    const newId = bumpAck.message.payload.newId

    assert.equal(fs.existsSync(oldAttDir), false, '舊附件目錄應已移除')
    const newAttDir = utils.getAttachmentDir(TEST_CHANNEL, newId)
    assert.equal(fs.existsSync(path.join(newAttDir, '測試簡報.pdf')), true, '新附件目錄應包含原附件')
    assert.equal(fs.readFileSync(path.join(newAttDir, '測試簡報.pdf'), 'utf8'), 'PDF-CONTENT')

    const listed = utils.listAttachments(TEST_CHANNEL, newId)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].name, '測試簡報.pdf')
  })

  test('邊界防護：已是最新一筆、非公告頻道、不存在 ID 皆應拒絕執行', () => {
    const { secondId } = setupChannelMessages(TEST_CHANNEL)
    const client = createMockClient('HA0001')
    const wss = { clients: new Set([client]) }
    client.wss = wss
    const handler = new RequestHandler(wss, { broadcastChannelMessage () {} })

    // 1. 已是最新一筆
    const resLatest = handler.handle(client, JSON.stringify({
      type: 'command',
      channel: 'system',
      sender: 'HA0001',
      message: JSON.stringify({ command: 'bump_message', channel: TEST_CHANNEL, id: secondId, sender: 'HA0001' })
    }))
    assert.equal(resLatest, false)
    assert.equal(client.sent.at(-1).message.success, false)

    // 2. 非公告頻道
    const resNonAnn = handler.handle(client, JSON.stringify({
      type: 'command',
      channel: 'system',
      sender: 'HA0001',
      message: JSON.stringify({ command: 'bump_message', channel: 'lds', id: 1, sender: 'HA0001' })
    }))
    assert.equal(resNonAnn, false)
    assert.equal(client.sent.at(-1).message.success, false)

    // 3. 不存在 ID
    const resMissing = handler.handle(client, JSON.stringify({
      type: 'command',
      channel: 'system',
      sender: 'HA0001',
      message: JSON.stringify({ command: 'bump_message', channel: TEST_CHANNEL, id: 999999, sender: 'HA0001' })
    }))
    assert.equal(resMissing, false)
    assert.equal(client.sent.at(-1).message.success, false)
  })
})
