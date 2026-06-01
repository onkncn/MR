# 🎧 Meeting Room

基于 WebRTC 的多人实时语音频道应用，支持语音通话、屏幕共享和文字聊天。

## ✨ 功能特性

- 🎤 **多人语音通话** — 基于 WebRTC P2P，低延迟
- 📺 **多人屏幕共享** — 侧边栏点击头像切换观看，支持全屏和最小化浮窗
- 🔊 **屏幕共享音频** — 共享标签页时可同步传输画面声音（需选择"标签页"共享）
- 🎙️ **音频混合** — 麦克风与屏幕音频自动混合为单条音轨，接收端同时听到说话声和画面声音
- 🔇 **AI 降噪** — 利用 Chrome 内置 RNNoise 神经网络，无需额外依赖
- 🎚️ **麦克风音量控制** — Web Audio API GainNode 真正控制增益（非简单静音）
- 🔈 **扬声器开关** — 一键静音/取消静音远程音频
- 💬 **文字聊天** — 支持发送文字、图片、视频（最大 50MB）
- 👥 **参与者列表** — 桌面端侧边栏显示头像、名字、共享/观看状态
- 🔊 **独立音量控制** — 麦克风和扬声器分别可调（0%~300%）
- 💾 **状态持久化** — 自动保存用户名、麦克风/扬声器状态到 localStorage，下次打开自动恢复
- 🚀 **自动登录** — 有缓存用户名时跳过登录页，直接进入主界面
- 📱 **移动端适配** — 响应式布局，触屏友好，屏幕共享支持滑动切换和最小化浮窗
- 🔒 **HTTPS 内置** — 自带 SSL，开箱即用

## 🚀 快速开始

### 安装依赖

```bash
npm install
```

### 配置

```bash
cp config_example.json config.json
```

编辑 `config.json`：

```json
{
  "port": 6789,
  "host": "0.0.0.0",
  "domain": "your-domain.com",
  "ssl": {
    "key": "path/to/key.pem",
    "cert": "path/to/cert.pem"
  },
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" }
  ],
  "cors": { "origin": "*" }
}
```

### 启动

```bash
npm start
```

访问 `https://localhost:6789`。

## ⚙️ 配置说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `port` | 服务端口 | `6789` |
| `host` | 监听地址 | `0.0.0.0` |
| `domain` | 外网域名（日志显示） | `localhost` |
| `ssl.key` | SSL 私钥路径 | — |
| `ssl.cert` | SSL 证书路径 | — |
| `iceServers` | WebRTC ICE 服务器列表 | Google STUN |
| `cors.origin` | CORS 允许的来源 | `*` |

### ICE / TURN 服务器

**STUN**（免费，获取公网 IP）：
```
stun:stun.l.google.com:19302
stun:global.stun.twilio.com:3478
```

**TURN**（自建，NAT 穿透）：
- 推荐自建 [coturn](https://github.com/coturn/coturn)
- 或使用免费商业服务如 [Metered Open Relay](https://www.metered.ca/tools/openrelay/)

> 💡 局域网内使用只需 STUN；跨网络（4G/WiFi 不同网段）需要 TURN。

## 📁 项目结构

```
meeting-room/
├── server.js              # 后端（Express + Socket.io + HTTPS）
├── config.json            # 本地配置（已 gitignore）
├── config_example.json    # 配置模板
├── turnserver.conf        # TURN 服务器配置示例
├── public/
│   ├── index.html         # 页面结构
│   ├── style.css          # 样式（深色主题）
│   └── app.js             # 前端逻辑（WebRTC + Socket.io + Web Audio API）
└── package.json
```

## 📋 使用说明

### 屏幕共享音频

共享屏幕时，选择 **"标签页"**（Chrome）或 **"窗口"**（Firefox）并勾选 **"共享标签页音频"**，对方即可听到画面中的声音。

> ⚠️ 选择"整个屏幕"时浏览器不捕获音频，这是浏览器限制。

### 音频混合

麦克风语音和屏幕共享音频通过 Web Audio API 自动混合为单条音轨传输：
- 接收端同时听到说话声和画面声音
- 停止屏幕共享后自动恢复纯麦克风音轨
- AI 降噪切换时混合管线自动重连

### 状态持久化

以下状态自动保存到浏览器 localStorage：
- 用户名 — 下次打开自动填入并登录
- 麦克风开关 — 加入频道时自动恢复上次状态
- 扬声器开关 — 恢复上次状态

清除浏览器数据可重置。

## 📱 iOS 兼容性

- **Safari** 为唯一支持的 iOS 浏览器（其他 iOS 浏览器不支持 WebRTC）
- **麦克风**：iOS 跳过 Web Audio API 管线，直接使用原生音轨（iOS 上 GainNode 行为不稳定）
- **屏幕共享**：iOS 不支持 `getDisplayMedia` API，此为 Apple 系统限制
- **音频播放**：iOS Safari 拦截自动播放，远程音频通过显式 `play()` 触发

## 🌐 外网访问

1. 路由器端口转发：外部端口 → 服务器内网 IP:6789
2. 服务器防火墙放行端口
3. 必须使用 HTTPS（WebRTC 安全上下文要求）
4. 移动端必须 HTTPS 才能访问麦克风

## 🔧 技术栈

- **后端**：Node.js + Express + Socket.io
- **前端**：原生 HTML / CSS / JS（无框架）
- **实时通信**：WebRTC（P2P 语音 + 屏幕共享）
- **音频处理**：Web Audio API（GainNode 增益控制 + 多源混合）
- **信令**：Socket.io（offer/answer/ICE candidate 交换）

## License

MIT
