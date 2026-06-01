# 🎧 Meeting Room

基于 WebRTC 的多人实时语音频道应用，支持语音通话、屏幕共享和文字聊天。

## ✨ 功能特性

- 🎤 **多人语音通话** — 基于 WebRTC P2P，低延迟
- 📺 **多人屏幕共享** — 侧边栏点击头像切换观看，支持全屏和最小化浮窗
- 🔇 **AI 降噪** — 利用 Chrome 内置 RNNoise 神经网络，无需额外依赖
- 💬 **文字聊天** — 支持发送文字、图片、视频
- 👥 **参与者列表** — 桌面端侧边栏显示头像、名字、共享/观看状态
- 🔊 **独立音量控制** — 麦克风和扬声器分别可调（0%~300%）
- 📱 **移动端适配** — 响应式布局，触屏友好
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
│   └── app.js             # 前端逻辑（WebRTC + Socket.io）
└── package.json
```

## 🌐 外网访问

1. 路由器端口转发：外部端口 → 服务器内网 IP:6789
2. 服务器防火墙放行端口
3. 必须使用 HTTPS（WebRTC 安全上下文要求）
4. 移动端必须 HTTPS 才能访问麦克风

## 🔧 技术栈

- **后端**：Node.js + Express + Socket.io
- **前端**：原生 HTML / CSS / JS（无框架）
- **实时通信**：WebRTC（P2P 语音 + 屏幕共享）
- **信令**：Socket.io（offer/answer/ICE candidate 交换）

## License

MIT
