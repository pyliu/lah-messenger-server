const isDev = process.env.NODE_ENV !== 'production'
try {
  require('dotenv').config()

  const fs = require('fs')
  const path = require('path')
  const utils = require(path.join(__dirname, 'utils.js'))
  const RequestHandler = require(path.join(__dirname, 'request-handler.js'))
  const MessageWatcher = require(path.join(__dirname, 'message-watcher.js'))

  const dbDir = path.join(__dirname, 'db')
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir)
  }

  const servicePort = process.env.WEBSOCKET_PORT || 8081
  // initialize WS server
  const WebSocket = require('ws')
  // log 用：連線數與不重複使用者數 (依 userid 去重) 不同，補充說明避免誤解
  const onlineUniqueUsersText = (server) => { const ids = new Set(); server.clients.forEach((c) => { if (c.user && c.user.userid) { ids.add(c.user.userid) } }); return `（不重複使用者 ${ids.size}）` }
  const wss = new WebSocket.Server({
    port: servicePort,
    perMessageDeflate: {
      zlibDeflateOptions: {
        // See zlib defaults.
        chunkSize: 1024,
        memLevel: 7,
        level: 3
      },
      zlibInflateOptions: {
        chunkSize: 10 * 1024
      },
      // Other options settable:
      clientNoContextTakeover: true, // Defaults to negotiated value.
      serverNoContextTakeover: true, // Defaults to negotiated value.
      serverMaxWindowBits: 10, // Defaults to negotiated value.
      // Below options specified as default values.
      concurrencyLimit: 10, // Limits zlib concurrency for perf.
      threshold: 1024 // Size (in bytes) below which messages
      // should not be compressed.
    }
  })

  const watcher = new MessageWatcher(wss)
  const handler = new RequestHandler(wss, watcher)

  // new connection handler for remote client
  wss.on('connection', function connection (ws, req) {
    ws.wss = this // reference to the server
    ws.isAlive = true
    const clientIp = req?.socket?.remoteAddress || req?.headers['x-forwarded-for'] || '未知IP'
    ws.clientIp = clientIp
    ws.connectTime = Date.now()
    // 開發測試模式 (WS_ALLOW_ANONYMOUS=true)：未註冊前先以固定的 DEV 身份連線，註冊後會被真實身份覆蓋
    if (utils.allowAnonymous()) {
      ws.user = {
        ip: req?.socket?.remoteAddress || '127.0.0.1',
        domain: 'dev',
        userid: 'DEV',
        username: 'DEV',
        dept: 'inf',
        channel: 'lds',
        timestamp: +new Date()
      }
    }
    ws.on('pong', function heartbeat () {
      // only ws has user info is treated as alive
      this.isAlive = typeof this.user === 'object' || utils.allowAnonymous()
    })

    ws.on('message', function incoming (message) {
      const processedMessage = handler.handle(this, message)
      if (processedMessage === false) {
        isDev && console.log('處理訊息失敗', message)
        this.send(utils.packMessage(`WS伺服器無法處理您的請求 ${message}`))
      } else if (processedMessage === true) {
        isDev && console.log('處理訊息成功')
      } else if (!utils.isEmpty(processedMessage)) {
        this.send(utils.packMessage(processedMessage, { channel: this.user.userid }))
      } else {
        isDev && console.log('處理訊息後無回傳值，無法處理給客戶端回應', message)
      }
    })

    ws.on('close', function close () {
      const disconnected_user = this.user
      if (disconnected_user) {
        const message = `${disconnected_user.userid} / ${disconnected_user.username} / ${disconnected_user.ip} 連線已中斷`
        console.log(message)
        // send user_disconnected command to all ws clients
        wss?.clients?.forEach((ws) => {
          utils.sendCommand(ws, {
            command: 'user_disconnected',
            payload: disconnected_user,
            message: `${disconnected_user.username} 已離線`
          })
        })
      } else {
        const duration = ws.connectTime ? (' (在線時長: ' + Math.round((Date.now() - ws.connectTime) / 1000) + 's)') : ''
        console.log('未註冊客戶端 (' + (ws.clientIp || '未知IP') + ') 已斷線' + duration)
      }
      console.log('目前已連線客戶數 ' + [...wss.clients].length + onlineUniqueUsersText(wss))
    })

    console.log('新連線建立 (' + clientIp + ')，目前已連線客戶數 ' + [...wss.clients].length + onlineUniqueUsersText(wss))
  })

  // remove dead connection every 20s
  const interval = setInterval(function ping () {
    wss.clients.forEach(function each (ws) {
      if (ws.isAlive === false) {
        ws.user && console.log(`偵測到 ${ws.user.dept} / ${ws.user.userid} 的連線已中斷。`)
        !ws.user && console.log('偵測到無使用者資訊的連線 (' + (ws.clientIp || '未知IP') + ')，斷線 ... ')
        return ws.terminate()
      }
      ws.isAlive = false
      ws.ping(function noop () {})
    })
  }, 20000)

  wss.on('close', function close () {
    clearInterval(interval)
    watcher.close()
  })

  console.log(`ws伺服器已啟動 (${servicePort})`)

  // 附件上傳/下載 HTTP API (獨立 try/catch，啟動失敗不影響 WebSocket 服務)
  try {
    const express = require('express')
    const uploadRouter = require(path.join(__dirname, 'upload-router.js'))
    const app = express()

    // 資安加固：關閉 X-Powered-By 標頭，防止洩漏底層伺服器框架指紋
    app.disable('x-powered-by')

    // 允許跨來源請求 (CORS) 與 Preflight OPTIONS
    app.use((req, res, next) => {
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
    })

    app.use('/api', uploadRouter)

    // 資安加固：統一錯誤處理，避免例外堆疊 (Stack Trace) 外洩
    app.use((err, req, res, next) => {
      console.error('HTTP 服務未處理例外:', err)
      if (res.headersSent) {
        return next(err)
      }
      res.status(500).json({ status: false, message: '伺服器內部錯誤' })
    })
    const httpPort = process.env.HTTP_PORT || 8082
    const httpServer = app.listen(httpPort, () => {
      console.log(`HTTP API 已啟動 (${httpPort})`)
    })
    httpServer.on('error', (err) => {
      console.error(`HTTP API 啟動失敗 (${httpPort})`, err)
    })
  } catch (httpErr) {
    console.error('HTTP API 初始化失敗', httpErr)
  }
} catch (e) {
  console.error('ws伺服器啟動失敗', e)
} finally {
  // finally。
}
