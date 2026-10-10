# P2P 实时共享聊天室

浏览器点对点的实时聊天室：文本、图片、文件、语音、摄像头视频通话、视频共享全程 P2P 直连，业务数据不经过任何服务器。纯静态页面，无构建步骤，GitHub Pages 直接托管。

**在线地址：** https://chat.rhua.net/（Cloudflare Pages + 自定义域名）

## 功能

| 模块 | 说明 |
| --- | --- |
| 房间 | 一键创建房间生成房间号，或输入房间号加入；支持 `?room=xxxx` / `#xxxx` 链接直达 |
| 聊天 | 文本消息（自动识别链接）、图片（自动压缩至 1440px）、粘贴图片即发、60 秒内撤回 |
| 文件 | 多文件分片直传（64KB/片 + 背压控制），≥50MB 大文件改为接收方点击「接收」后再传 |
| 语音 | 一键开麦 / 静音，`AudioContext` 实时说话检测驱动成员列表波形 |
| 视频通话 | 摄像头 + 麦克风 mesh 多人通话；自己的画面可独立静音 / 关画面，对端状态实时同步（640×480@24fps 采集，控制带宽） |
| 视频共享 | 本地视频 `captureStream` P2P 推流，房间成员实时看同一画面 |
| 视频链接 | 自动识别 B站 / YouTube / Vimeo / 直链 / HLS，可一键「推到共享区」并同步播放进度 |
| 在线预览 | 图片、音视频、docx、xlsx、pptx、xmind 直接在弹窗内查看，依赖按需懒加载 |

## 用法

1. 打开页面，填昵称 → 点「创建房间并进入」
2. 点击顶栏房间号右侧的复制按钮，把房间号发给朋友
3. 对方打开同一地址 → 切到「加入房间」→ 粘贴房间号 → 进入
4. 房间号形如 `rm3kf9a2x1`，也可以用 `.../?room=rm3kf9a2x1` 的链接直接进去
5. 点底部摄像头图标开启视频通话：自己的画面右上角有两个按钮，分别是「静音」和「关画面（只留语音）」；再点一次摄像头图标即可结束

> 摄像头与麦克风只在一个入口：开启视频通话时会自动关掉纯语音，避免同一路声音重复传输产生回声。

## 技术说明

- **信令**：PeerJS 公共服务器（`0.peerjs.com`），仅用于握手，多 CDN 兜底加载
- **传输**：`RTCDataChannel` 传消息与文件分片，`RTCPeerConnection` 传音视频流
- **拓扑**：全网状 mesh —— 房主 Peer ID 即房间号，房主在收到 `hello` 后下发在线成员列表，新成员与所有已在线成员逐一建立直连
- **ICE**：使用 Google / Twilio 公共 STUN

协议消息统一用 `k` 字段区分：`hello` / `peers` / `voice` / `cam` / `stage` / `stageClose` / `sync` / `bye` / `recall` / `msg` / `file` / `chunk` / `fdone` / `faccept`。

音视频流用三类 `MediaConnection`，通过 `metadata.kind` 区分：`voice`（纯语音）、`cam`（摄像头通话，含音频）、`share`（本地视频推流）。摄像机开关 / 静音状态通过 `cam` 消息同步，避免接收端只看到黑屏却不知道对端是主动关的。

## 本地运行

`getUserMedia` 只在安全上下文可用，本地必须走 `localhost` 或 HTTPS（直接双击 `index.html` 用 `file://` 打开会导致麦克风不可用）：

```bash
python -m http.server 8000
# 打开 http://localhost:8000
```

## 自动化测试

`tools/e2e.js` 是一套真实端到端测试：无头 Edge/Chrome（假摄像头 + 假麦克风）+ CDP 协议驱动三个真实页面，通过 PeerJS 公共信令**真实建连**后逐项断言。

```bash
node tools/e2e.js            # 需 Node 18+ 与本机 Edge / Chrome
```

覆盖 26 项：建房 / 加房 / 成员列表同步、文本收发与撤回、摄像头视频通话（含分辨率、关画面、静音、结束）、语音开关与静音状态同步、300KB 文件直传、60MB 大文件待接收流程、图片压缩通道、视频链接卡片、灯箱、本地视频共享推流、共享区双向同步、三人 mesh 广播、成员离开回收。脚本自带静态服务器与浏览器探测，退出码非 0 即有用例失败。

## 已知限制

- **公共信令不稳定**：PeerJS 官方公共云不保证可用性，高峰可能握手失败（实测出现过整轮建房超时，稍后重试即恢复）。生产环境请自建 `peerjs-server`。
- **传输速率**：端到端约 2.5MB/s（60MB 文件约 24s），瓶颈在 SCTP 层，调大分片无明显提升。
- **无 TURN 中继**：对称型 NAT 或严格防火墙下打洞会失败，需自建 coturn 并配置 `iceServers`。
- **房间无持久化**：房主断开后房间即失效，不保存任何历史消息。
- **人数上限**：mesh 拓扑下每人需与其余所有人建立连接。纯聊天建议 ≤ 6 人；开视频通话时建议 ≤ 4 人（每路 640×480 约占 0.5–1 Mbps 上行，4 人房间单人上行约 3 Mbps）。更多人数应改 SFU 架构。

## 部署

### GitHub Pages

推送到 `main` 分支后，在仓库 **Settings → Pages → Build and deployment** 选择 `Deploy from a branch` / `main` / `/ (root)` 即可上线。

### Cloudflare Pages（当前线上方案）

已上线：**https://chat.rhua.net/**

Workers & Pages → **Create** → **Pages** → **Connect to Git**，选中 `RhuaHub/p2p-room` 后填：

| 配置项 | 值 |
| --- | --- |
| Framework preset | `None` |
| Build command | `mkdir -p dist && cp -r *.html assets _headers dist/` |
| Build output directory | `dist` |

构建命令把产物收进 `dist/`，避免 `tools/` 与 `README.md` 被公开访问；该命令与 Pages 构建容器行为一致，可在本机先跑一遍验证。

首次连接需授权 Cloudflare 访问 GitHub 仓库（一次性）。绑定成功后每次 `git push` 自动重建，约 1 分钟生效。

自定义域名：域名已托管在 Cloudflare 时，在 Pages 项目 **Custom domains → Set up a custom domain** 直接添加，会自动写 DNS 并签发证书。

根目录下的 `_headers` 提供安全响应头与 CSS/JS 一天缓存（手写站没有文件指纹，所以用 `must-revalidate` 而不是长缓存 `immutable`，否则改完样式用户会拿到旧文件）。`404.html` 会被自动用作未匹配路径的响应。

## 文件结构

```
index.html              页面结构
404.html                未匹配路径的响应页（Pages/GitHub Pages 自动识别）
_headers                Pages 响应头与缓存规则
assets/css/style.css    样式（设计变量集中在 :root，当前为暖金主题）
assets/js/app.js        全部逻辑（信令、聊天、文件、语音、视频通话、共享、预览）
tools/e2e.js            端到端自动化测试（无头浏览器 + CDP，26 项）
```

## License

MIT
