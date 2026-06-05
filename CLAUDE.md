# Meeting Room — 项目上下文

## 项目概述
基于 WebRTC 的多人实时语音频道应用，支持语音通话、屏幕共享和文字聊天。

## 技术栈
- **后端**：Node.js + Express + Socket.io（server.js, 675行）
- **前端**：原生 HTML/CSS/JS，无框架（app.js, 2500+行）
- **实时通信**：WebRTC P2P 语音 + 屏幕共享
- **音频处理**：Web Audio API（GainNode 增益 + 多源混合）
- **信令**：Socket.io（offer/answer/ICE candidate 交换）
- **数据持久化**：JSON 文件（data/channels.json, data/messages.json）

## 关键命令
- `npm start` — 启动 HTTPS 服务器（端口 6789）
- `npm test` — 运行 36 项自动化测试（需要服务器先运行）
- `node -c public/app.js` — 语法检查（仅检查语法，不检查运行时错误）

## 项目结构
```
meeting-room/
├── server.js              # 后端（Express + Socket.io + HTTPS）
├── config.json            # 本地配置（gitignore）
├── config_example.json    # 配置模板
├── public/
│   ├── index.html         # 页面结构
│   ├── style.css          # 样式（深色主题）
│   └── app.js             # 前端逻辑（WebRTC + Socket.io + Web Audio API）
├── data/
│   ├── channels.json      # 频道持久化
│   └── messages.json      # 聊天消息持久化
├── test/
│   └── test.js            # 自动化测试套件
└── package.json
```

## 代码规范
- 中文注释，BUGFIX 标记格式：`// BUGFIX: [编号] 描述`
- 前端无构建步骤，直接修改 public/ 下的文件
- 服务端修改后需重启：`systemctl restart meeting-room`
- 前端修改后需强制刷新浏览器（Cache-Control: no-store 可能不够）

## 已知陷阱（CRITICAL）

### 1. 声明顺序问题
app.js 中 DOM 元素声明（getElementById）在文件前部（~行78-140）。
**任何在声明之前调用这些变量的代码都会导致 ReferenceError，整个应用崩溃。**
Claude Code 添加代码时必须检查：所有引用的变量是否在调用点之前声明。

### 2. 浏览器缓存
静态资源设置了 `Cache-Control: no-store`，但浏览器仍可能缓存旧版 JS。
修改 app.js 后用户可能需要强制刷新（Ctrl+Shift+R）。

### 3. iOS Safari 兼容性
- iOS 跳过 Web Audio API 管线，直接使用原生音轨
- iOS 不支持 getDisplayMedia API（屏幕共享）
- iOS Safari 拦截自动播放，远程音频需显式 play()

### 4. WebRTC 信令冲突（Glare）
两方同时发起 offer 时会冲突。解决方案：polite 端（userName 较小）执行 rollback。

### 5. 多标签页场景
同一用户多标签页时，离开/踢出逻辑需检查是否有其他 socket 仍在频道中。

## 测试
运行测试前必须确保服务器已启动：
```bash
npm start &  # 后台启动
sleep 2
npm test     # 运行 36 项测试
```

测试覆盖：连接(3) + 登录(3) + 创建(2) + 验证(3) + 加入(1) + 密码(2) + 聊天(2) + 伪造(1) + 信令(2) + 同步(1) + 离开(1) + 加入通知(1) + 多人(1) + 麦克风(5) + 屏幕(3) + 静音(3) + 清理(2) = 36项

## Git 分支策略
- `main` — 稳定运行版本
- `develop` — 新功能开发
- **严格分开，不合并 develop 到 main**
- GitHub: github.com/onkncn/MR.git

## 部署
- systemd 服务：`systemctl restart meeting-room`
- HTTPS 内置（config.json 配置 SSL 证书）
- 外网访问：https://onkn.cn:6789
