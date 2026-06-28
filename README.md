# 🎧 Meeting Room

一个基于 WebRTC 的多人实时语音频道应用，提供语音通话、屏幕共享和文字聊天功能。

**核心目标**：构建一个类似 Discord 语音频道的轻量级实时协作工具，支持局域网和外网部署。

## ✨ 功能特性

### 用户认证
- 用户名登录（1-20字符）
- 用户名去重，防止冒充
- 自动登录（有缓存用户名时跳过登录页）
- 状态持久化（用户名、麦克风/扬声器状态保存到 localStorage）

### 频道管理
- 创建/删除频道（支持名称和密码设置）
- 邀请链接（支持最大使用次数和过期时间）
- 频道自动删除（空频道根据累计人时自动清理）
- 右键/长按菜单（桌面端右键、移动端长按）

### 语音通话
- 🎤 多人语音通话（基于 WebRTC P2P，低延迟）
- 🎚️ 麦克风音量控制（Web Audio API GainNode，0%~300%）
- 🔈 扬声器开关和音量控制（0%~100%）
- 🔇 AI 降噪（Chrome 内置 RNNoise）
- 🎙️ 音频混合（麦克风与屏幕音频自动混合）
- 说话状态指示（检测音频能量，高亮说话者）

### 屏幕共享
- 📺 多人屏幕共享（侧边栏点击头像切换观看）
- 🔊 屏幕共享音频（共享标签页时同步传输声音）
- 全屏查看和最小化浮窗
- 移动端滑动切换
- 视频码率控制（上限 4Mbps，帧率 60fps）

### 文字聊天
- 💬 发送文字、图片、视频（最大 50MB）
- 消息撤回、表情回复
- 聊天历史（最多200条/频道）
- 输入中指示器
- 图片预览和弹窗查看
- 聊天全屏模式

### 用户管理（房主权限）
- 踢人、静音他人
- 👥 参与者列表（侧边栏显示头像、名字、共享/观看状态）

### 系统通知
- 加入/离开/被踢/频道删除通知

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
  "port": 6800,
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

访问 `https://localhost:6800`。

### 测试

```bash
npm test          # 运行 36 项自动化测试
npm run test:full # 运行完整测试
```

> 运行测试前需先启动服务器：`npm start &`

## ⚙️ 配置说明

| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `port` | number | 服务端口 | `6800` |
| `host` | string | 监听地址 | `0.0.0.0` |
| `domain` | string | 外网域名 | `localhost` |
| `ssl.key` | string | SSL 私钥路径 | — |
| `ssl.cert` | string | SSL 证书路径 | — |
| `iceServers` | array | WebRTC ICE 服务器列表 | Google STUN |
| `cors.origin` | string | CORS 允许的来源 | `*` |

### ICE / TURN 服务器

**STUN**（免费，获取公网 IP）：
```
stun:stun.l.google.com:19302
stun:global.stun.twilio.com:3478
stun:stun.relay.metered.ca:80
```

**TURN**（自建，NAT 穿透）：
- 推荐自建 [coturn](https://github.com/coturn/coturn)
- 或使用免费商业服务如 [Metered Open Relay](https://www.metered.ca/tools/openrelay/)

> 💡 局域网内使用只需 STUN；跨网络（4G/WiFi 不同网段）需要 TURN。

## 📁 项目结构

```
meeting-room/
├── server.js              # 后端服务（Express + Socket.io + HTTPS）
├── config.json            # 本地配置（已 gitignore）
├── config_example.json    # 配置模板
├── turnserver.conf        # TURN 服务器配置示例
├── data/                  # 持久化数据目录
│   ├── channels.json      # 频道数据（防抖写入）
│   └── messages.json      # 聊天消息（防抖写入）
├── public/
│   ├── index.html         # 页面结构
│   ├── style.css          # 样式（深色主题 + 响应式）
│   └── app.js             # 前端逻辑（WebRTC + Socket.io + Web Audio API）
├── test/                  # 测试目录
├── uploads/               # 上传文件目录
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

## 🔧 技术栈

- **后端**：Node.js + Express + Socket.io
- **前端**：原生 HTML / CSS / JS（无框架）
- **实时通信**：WebRTC（P2P 语音 + 屏幕共享）
- **音频处理**：Web Audio API（GainNode 增益控制 + 多源混合）
- **信令**：Socket.io（offer/answer/ICE candidate 交换）
- **数据持久化**：JSON 文件（防抖写入）

## 🔒 安全特性

| 特性 | 说明 |
|------|------|
| 密码哈希 | 频道密码使用 scrypt 算法哈希存储 |
| 时序安全比较 | 密码验证使用 crypto.timingSafeEqual 防止时序攻击 |
| HTTPS 强制 | 内置 SSL，满足 WebRTC 安全上下文要求 |
| 输入限制 | 用户名 20字符，频道名 30字符，文本消息 5000字符 |
| 控制字符过滤 | 聊天消息过滤控制字符（保留换行） |

## ⚡ 性能指标

- 语音延迟：基于 WebRTC P2P，端到端 < 500ms
- 速率限制：创建频道 5次/分钟，加入 10次/分钟，聊天 30次/分钟
- 消息存储：每频道最多 200 条
- Socket 缓冲区：最大 50MB

## 🔄 可靠性保障

- Socket.io 自动断线重连，重连后自动重新登录和加入频道
- WebRTC 连接断开 5 秒后自动尝试 ICE 重启
- WebRTC offer 冲突使用 polite/impolite 策略处理
- 同一用户多标签页支持，关闭一个不影响其他
- 频道和消息数据防抖写入文件，写入失败不清除 dirty 标志

## 📱 移动端适配

- 响应式布局：桌面端三栏，移动端垂直布局
- 横屏适配：横屏时切换为三栏布局，控制栏自动隐藏
- 触屏手势：侧边栏滑动拉出、频道名上滑隐藏
- 后台恢复：页面恢复可见时自动恢复 AudioContext、检查音轨状态

## 🌐 外网访问

1. 路由器端口转发：外部端口 → 服务器内网 IP:6800
2. 服务器防火墙放行端口
3. 必须使用 HTTPS（WebRTC 安全上下文要求）
4. 移动端必须 HTTPS 才能访问麦克风

## 📦 依赖项

| 包名 | 版本 | 用途 |
|------|------|------|
| express | ^4.18.2 | HTTP 服务器和静态文件服务 |
| socket.io | ^4.7.2 | 实时通信（信令 + 聊天） |
| cors | ^2.8.5 | 跨域资源共享 |
| multer | ^2.1.1 | 文件上传处理 |

### 开发依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| nodemon | ^3.0.1 | 开发时自动重启 |
| puppeteer-core | ^25.1.0 | 端到端测试 |
| socket.io-client | ^4.7.2 | 测试用 Socket 客户端 |

## ⚠️ 已知限制

1. **Mesh 拓扑**：所有参与者两两建立 P2P 连接，超过 5-6 人时性能下降
2. **无 SFU/MCU**：不支持大规模会议（>10人）
3. **iOS 屏幕共享**：iOS 系统限制，不支持 `getDisplayMedia` API
4. **文件存储**：图片/视频以 data URL 形式传输，大量媒体数据会占用内存
5. **无数据库**：使用 JSON 文件持久化，不适合高并发场景
6. **单服务器**：无集群支持，所有状态保存在内存中

## 🗺️ 未来规划

| 编号 | 功能 | 优先级 |
|------|------|--------|
| P-01 | 引入 SFU 支持大规模会议 | 高 |
| P-02 | 支持视频通话（摄像头） | 高 |
| P-03 | 用户头像上传 | 中 |
| P-04 | 频道分类/标签 | 中 |
| P-05 | 录音/录像功能 | 中 |
| P-06 | Docker 容器化部署 | 低 |
| P-07 | 管理后台 | 低 |

## License

MIT
