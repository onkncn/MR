# Meeting Room - WebRTC 语音频道

基于 WebRTC 的多人语音通话与屏幕共享应用。

## 功能特性

- 🎤 多人实时语音通话
- 📺 多人屏幕共享（点击侧边栏头像切换观看）
- 🔇 AI 降噪（Chrome 内置 RNNoise 神经网络）
- 💬 文字聊天（支持图片/视频）
- 📱 响应式设计，移动端适配
- 🔊 自定义音量滑块（麦克风/扬声器独立控制）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

```bash
cp config_example.json config.json
```

编辑 `config.json`，填写你的配置：

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
    { "urls": "stun:stun.l.google.com:19302" },
    {
      "urls": "turn:your-turn-server:3478",
      "username": "your-username",
      "credential": "your-credential"
    }
  ],
  "cors": {
    "origin": "*"
  }
}
```

### 3. 启动

```bash
npm start
```

访问 `https://localhost:6789`。

## 配置说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `port` | 服务端口 | `6789` |
| `host` | 监听地址 | `0.0.0.0` |
| `domain` | 外网域名（用于日志显示） | `localhost` |
| `ssl.key` | SSL 私钥路径 | - |
| `ssl.cert` | SSL 证书路径 | - |
| `iceServers` | WebRTC ICE 服务器列表 | Google STUN |
| `cors.origin` | CORS 允许的来源 | `*` |

### ICE 服务器

**STUN 服务器**（免费，用于获取公网 IP）：
- `stun:stun.l.google.com:19302`
- `stun:global.stun.twilio.com:3478`

**TURN 服务器**（需自建，用于 NAT 穿透）：
- 推荐 [coturn](https://github.com/coturn/coturn)
- 或使用商业服务如 [Metered](https://www.metered.ca/tools/openrelay/)

## 项目结构

```
meeting-room/
├── server.js              # 后端（HTTPS + Socket.io）
├── config.json            # 本地配置（gitignore）
├── config_example.json    # 配置模板
├── public/
│   ├── index.html         # 页面结构
│   ├── style.css          # 样式
│   └── app.js             # 前端逻辑（WebRTC）
├── turnserver.conf        # TURN 服务器配置示例
└── package.json
```

## 外网访问

1. 确保路由器已将端口映射到服务器内网 IP
2. 确保服务器防火墙已开放端口
3. 需要 HTTPS（WebRTC 要求安全上下文）
4. 移动端需要 HTTPS 才能使用麦克风

## License

MIT
