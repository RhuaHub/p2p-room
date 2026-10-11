/**
 * 自建 PeerJS 信令服务器示例
 *
 * 用途：摆脱对 PeerJS 公共云（0.peerjs.com，无 SLA）的依赖。
 * 它只负责握手（交换 SDP / ICE 候选），不转发聊天内容与音视频流。
 *
 * 运行：
 *   npm i express peer
 *   node tools/peer-server.js
 *   # 自定义端口：PORT=9000 node tools/peer-server.js
 *
 * 然后把前端 assets/js/app.js 顶部 SIGNALING 的第一项改成：
 *   { host: '你的域名', port: 443, secure: true, path: '/', key: 'peerjs' }
 * 注意 URL 拼法是 /{path}{key}，所以 path:'/' + key:'peerjs' 对应 wss://域名/peerjs。
 */

const express = require('express')
const { ExpressPeerServer } = require('peer')

const PORT = Number(process.env.PORT) || 9000
const app = express()

app.get('/', (req, res) => res.send('peerjs signaling server is running'))

const server = app.listen(PORT, () => {
  console.log(`[peer-server] 信令服务已启动: http://localhost:${PORT}`)
})

const peerServer = ExpressPeerServer(server, {
  path: '/',          // 前端 path 需与此一致，前端拼出的 URL 为 /{path}{key}
  allow_discovery: false,
  // 生产环境建议打开 key 校验，只允许本站使用：
  // key: 'peerjs'
})

app.use('/peerjs', peerServer)

// 房间号（Peer ID）回收，便于排查
peerServer.on('connection', (client) => {
  console.log(`[peer-server] + 连接 ${client.getId()}`)
})
peerServer.on('disconnect', (client) => {
  console.log(`[peer-server] - 断开 ${client.getId()}`)
})
peerServer.on('error', (err) => {
  console.error('[peer-server] 错误:', err && err.message)
})
