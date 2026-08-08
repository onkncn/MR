# Meeting Room — 项目上下文 (AI Agent 指南)

> 基于 WebRTC 的多人实时语音频道应用。支持语音通话、屏幕共享、文字聊天。
> **部署地址**: https://onkn.cn:6789
> **GitHub**: github.com/onkncn/MR.git

---

## 1. 项目结构

```
meeting-room2/                  # Git 仓库（开发目录）
├── server.js                   # 后端 Express + Socket.io + HTTPS (914行)
├── config.json                 # 本地配置（gitignored，含端口6789、SSL、ICE）
├── config_example.json         # 配置模板
├── package.json                # npm 依赖
├── turnserver.conf             # coturn TURN 服务器配置
├── public/
│   ├── index.html              # 页面结构 (434行)
│   ├── style.css               # 深色主题样式 (3201行)
│   ├── app.js                  # 前端 WebRTC + Socket.io + UI (4289行)
├── data/                       # 运行时持久化（gitignored）
│   ├── channels.json
│   └── messages.json
├── test/
│   └── test.js                 # 36项自动化测试
├── CLAUDE.md                   # Claude Code 项目上下文
└── AGENTS.md                   # 本文件

meeting-room/                   # 生产部署目录（无 .git）
└── （rsync 自 meeting-room2，排除 .git/.claude/node_modules/config.json/data/uploads）
```

**双目录架构**:
- `meeting-room2` = Git 仓库 + 开发，端口 6800
- `meeting-room` = systemd 部署，端口 6789
- 部署时 rsync meeting-room2 → meeting-room，然后 `systemctl restart`

---

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js + Express + Socket.io |
| 前端 | 原生 HTML/CSS/JS，无框架 |
| 实时通信 | WebRTC P2P (mesh topology) + Socket.io 信令 |
| 音频处理 | Web Audio API (GainNode 增益、AnalyserNode 语音检测) |
| 持久化 | JSON 文件 (channels.json, messages.json) |
| 安全 | HTTPS 自签证书，CSP 头，bcrypt 密码哈希 |
| TURN | coturn (TCP relay，端口 3478) |
| 进程管理 | systemd (meeting-room.service) |

---

## 3. 功能清单

### 语音通话
- 多人实时语音（WebRTC mesh）
- 麦克风开关 + 音量增益控制（GainNode）
- AI 降噪 toggle（noiseSuppression）
- 语音检测指示灯（AnalyserNode 音量阈值）
- PTT/VOX 模式（键盘按键 / 语音激活）
- 服务端静音踢人

### 屏幕共享
- getDisplayMedia 共享 + 观看
- 多人同时共享，点击切换观看
- 停止观看（释放视频资源）+ 恢复条
- 本地预览自动暂停（降低资源占用）

### 文字聊天
- 实时消息 + 历史记录（加入时加载）
- Markdown 解析（粗体、斜体、代码块、链接、@提及）
- 图片/视频发送（FileReader base64，20MB 限制）
- 消息撤回（作者/房主）
- 表情反应（emoji picker）
- 输入状态提示
- 聊天 TTS 朗读

### 频道管理
- 创建/加入/离开频道
- 密码保护（bcrypt 哈希）
- 邀请链接（token，支持次数限制和过期）
- 重命名/删除频道（仅房主）
- 自动删除（人时计算延迟）
- Nuke 端点（一键清空所有数据）

### 自定义音频
- 上传本地音频文件播放到频道
- iOS Safari 文件输入兼容

### 在线用户列表（v2.1+）
- 右侧聊天面板拆分为上下结构
- 上 1/4：在线用户列表（昵称 + IP 地址）
- 下 3/4：聊天消息区

### 移动端适配
- 竖屏底部固定面板 + 横屏三栏布局
- 触控面板拖拽调整大小
- iPhone 安全区适配（safe-area-inset）
- iOS Safari 兼容（Web Audio 绕过、文件输入、autoplay）
- 后台恢复（visibilitychange 5步恢复）

### 桌面端
- 侧边栏频道列表 + 在线参与者
- 控制栏自动隐藏（全屏模式）
- 面板拖拽调整

---

## 4. 关键命令

```bash
# === 开发（meeting-room2） ===
npm start                          # 启动开发服务器（端口 6800）
npm test                           # 运行 36 项测试（需服务器先启动）
node -c public/app.js              # JS 语法检查

# === 部署到生产 ===
curl -sk -X POST https://localhost:6789/api/nuke \
  -H "Content-Type: application/json" \
  -d '{"secret":"mr-nuke-onkn"}'   # ① 清空数据
sleep 1
rsync -av --exclude='.git' --exclude='.claude' --exclude='node_modules' \
  --exclude='config.json' --exclude='data' --exclude='uploads' \
  /home/onkn/meeting-room2/ /home/onkn/meeting-room/  # ② 同步文件
sudo systemctl restart meeting-room.service            # ③ 重启服务

# === 验证 ===
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://localhost:6789/
sudo journalctl -u meeting-room --since "1 min ago" --no-pager | tail -10
```

---

## 5. Known Pitfalls (CRITICAL)

### ⚠️ 部署前验证：`node -c` 不够！必须验证函数存在
`node -c` 只检查语法，不检查运行时。调用未定义函数（如 `escapeHtml()`）不会报语法错误，但会在浏览器中静默崩溃。

**每次部署前必须确认新增代码中引用的所有自定义函数都已定义：**
```bash
# 列出新增/修改代码中调用的自定义函数，逐个确认存在
grep -n 'function 函数名' public/app.js
```

### ⚠️ 浏览器缓存：`?v=N` 是强制要求，不是可选项
`Cache-Control: no-store` 不可靠。**每次修改 app.js 或 style.css 必须递增版本号：**
```html
<link rel="stylesheet" href="style.css?v=3">
<script src="app.js?v=3"></script>
```
不递增 → 用户看到旧代码 → 报 bug → 浪费排查时间。

### ⚠️ 优先用 DOM API，避免 innerHTML 模板
`innerHTML` 模板中调用函数容易写出未定义引用。优先用 `createElement` + `textContent`，天然防 XSS + 不会因函数缺失而崩溃。

### 声明顺序
`app.js` 中 DOM 元素声明在文件前部（~行78-200）。**任何在声明前调用 DOM 变量的代码都会 ReferenceError，整个应用崩溃。** 新增代码时必须确认变量已声明。

### 浏览器缓存
设置了 `Cache-Control: no-store`，但浏览器仍可能缓存旧版 JS。修改后需告诉用户 **Ctrl+Shift+R 强制刷新**。

### iOS Safari 兼容
- 跳过 Web Audio API，直接使用原生音轨
- `getDisplayMedia` 不支持（Apple 限制）
- `<input type="file">` 需动态创建 + DOM 挂载 + 每次新建
- AudioContext 从 `suspended` 状态开始，需 `resume()`
- 不支持 `sampleRate`/`sampleSize`/`channelCount` 约束

### WebRTC 信令冲突 (Glare)
两方同时发起 offer 会冲突。polite 端（userName 较小）执行 `setLocalDescription({ type: 'rollback' })`。

### Server 重启后必须刷新
server 重启后 WebRTC 连接全部丢失，用户必须刷新浏览器（Ctrl+Shift+R）。

### `maxHttpBufferSize`
图片 base64 超 1MB 会导致 Socket.io 断开 → WebRTC 全部丢失。已设 50MB。

### Web Audio 节点清理
`leaveChannel()` 时需 `disconnect()` GainNode/MixDest 防止泄漏，但**不能 close AudioContext**。

### offsetWidth 边界检查
`offsetWidth === 0` 在有 1px border 的元素上返回 1。用 `<= 1` 替代。

### chat-only 模式
`.room.chat-only` 隐藏侧边栏和主内容区，聊天面板占满。新增 UI 元素需确认在该模式下表现正确。

### 多标签页
同一用户多标签页时，离开/踢出逻辑需检查 `userSockets` 中是否还有其他 socket。

---

## 6. Socket.io 事件速查

| 事件 | 方向 | 用途 |
|---|---|---|
| `login` | C→S | 用户登录 |
| `create-channel` | C→S | 创建频道 |
| `join-channel` | C→S | 加入频道（支持密码） |
| `leave-channel` | C→S | 离开频道 |
| `room-users` | S→C | 当前频道用户列表（含 name, ip, screenSharing, muted） |
| `user-connected` | S→C | 新用户**加入频道** `{ name, ip }`（向后兼容 string） |
| `user-disconnected` | S→C | 用户离开频道 |
| `online-users` | S→C | 登录时返回**全局**在线用户全量列表 `[{name, ip}]` |
| `user-online` | S→C | 广播：新用户**登录** `{ name, ip }` |
| `user-offline` | S→C | 广播：用户**完全断开** `{ name }` |
| `offer` / `answer` / `ice-candidate` | 双向 | WebRTC 信令 |
| `audio-status` | 双向 | 麦克风状态变更 |
| `screen-share-status` | 双向 | 屏幕共享状态变更 |
| `chat-message` | 双向 | 聊天消息 |
| `chat-history` | S→C | 加入时发送历史消息 |
| `typing-status` | 双向 | 输入状态 |
| `add-reaction` | C→S | 表情反应 |
| `delete-message` | C→S | 撤回消息 |
| `kick-user` / `kicked` | C→S / S→C | 踢人 |
| `mute-user` / `unmute-user` / `user-muted` | 双向 | 服务端静音 |
| `nuked` | S→C | 服务器 nuke 通知 |
| `channel-updated` / `channel-deleted` | S→C | 频道状态广播 |

---

## 7. 最近更新

| 日期 | 内容 |
|---|---|
| 2026-07-26 | 右侧在线用户列表：全局在线（login即显示，含自己），1/4+3/4布局，纯DOM API渲染 |
| 2026-07-26 | `index.html` 加 `?v=3` 缓存破坏；部署前验证流程建立 |
| 2026-07-14 | 自定义音频播放功能 |
| v2.0 | POST /api/nuke 端点 |
| v1.9 | 停止观看屏幕共享 + 恢复条 |
| v1.8 | 音频无声三连 bug 修复 |
| v1.7 | iOS 锁屏解锁布局修复 |

---

## 8. Git 工作流

- `main` = 生产稳定分支
- `develop` = 新功能开发
- **禁止合并 develop 到 main 除非用户明确说"合并"**
- 部署: `git checkout main` → restart
- 开发: `git checkout develop`
- Cherry-pick: `git checkout main && git cherry-pick <commit>` 用于单次修复
- 版本标签: `git tag -a vX.Y -m "..." && git push origin main --tags`
