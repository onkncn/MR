const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');

// 加载配置
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('❌ config.json 不存在，请复制 config_example.json 并填写配置：');
  console.error('   cp config_example.json config.json');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const app = express();

const options = {
  key: fs.readFileSync(path.resolve(__dirname, config.ssl.key)),
  cert: fs.readFileSync(path.resolve(__dirname, config.ssl.cert))
};

const server = https.createServer(options, app);
const io = new Server(server, {
  cors: config.cors,
  maxHttpBufferSize: 50 * 1024 * 1024
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => { res.set('Cache-Control', 'no-store'); } }));

// 提供 ICE 服务器配置给客户端
app.get('/api/config', (req, res) => {
  res.json({ iceServers: config.iceServers });
});

// ====== 频道持久化 ======
const DATA_DIR = path.join(__dirname, 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadChannels() {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
      const m = new Map();
      for (const [id, ch] of Object.entries(data)) {
        m.set(id, {
          id,
          name: ch.name,
          users: new Set(),
          password: ch.password || null,
          owner: ch.owner || null,
          createdAt: ch.createdAt || Date.now(),
          personTime: ch.personTime || 0
        });
      }
      return m;
    }
  } catch (e) { console.error('加载频道数据失败:', e); }
  return new Map();
}

function saveChannels() {
  const obj = {};
  channels.forEach((ch, id) => {
    obj[id] = { name: ch.name, password: ch.password, owner: ch.owner, createdAt: ch.createdAt, personTime: ch.personTime || 0 };
  });
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(obj, null, 2));
}

const channels = loadChannels();
const screenShareStatus = new Map();
const inviteTokens = new Map(); // token -> { channelId, createdAt, maxUses, uses }
const mutedUsers = new Map();  // channelId -> Set<userId>
const joinTimers = new Map();  // channelId -> Map<userId, joinTimestamp>
const deleteTimers = new Map(); // channelId -> timeout handle
const typingUsers = new Map(); // channelId -> Map<userId, timeout>
const MAX_MESSAGES = 200; // 每频道最多存储消息数

// ====== 消息持久化 ======
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const data = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
      const m = new Map();
      for (const [id, msgs] of Object.entries(data)) {
        m.set(id, msgs || []);
      }
      return m;
    }
  } catch (e) { console.error('加载消息数据失败:', e); }
  return new Map();
}

function saveMessages() {
  const obj = {};
  channelMessages.forEach((msgs, id) => { obj[id] = msgs; });
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(obj, null, 2));
}

const channelMessages = loadMessages();

// ====== Socket.IO ======
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  socket.on('login', (username) => {
    socket.username = username;
    socket.emit('channel-list', Array.from(channels.entries()).map(([id, ch]) => ({
      id,
      name: ch.name,
      users: Array.from(ch.users),
      hasPassword: !!ch.password,
      owner: ch.owner,
      personTime: ch.personTime || 0,
      pendingDelete: deleteTimers.has(id)
    })));
  });

  // 创建频道（支持密码）
  socket.on('create-channel', (data) => {
    if (!socket.username) return;
    const name = typeof data === 'string' ? data : data.name;
    const password = typeof data === 'object' ? data.password : null;
    const channelId = generateRoomId();
    channels.set(channelId, {
      id: channelId,
      name,
      users: new Set(),
      password: password || null,
      owner: socket.username,
      createdAt: Date.now(),
      personTime: 0
    });
    saveChannels();
    io.emit('channel-created', {
      id: channelId,
      name,
      users: [],
      hasPassword: !!password,
      owner: socket.username,
      personTime: 0,
      pendingDelete: false
    });
  });

  // 加入频道（密码验证）
  socket.on('join-channel', (data) => {
    const channelId = typeof data === 'string' ? data : data.channelId;
    const password = typeof data === 'object' ? data.password : undefined;
    const userId = socket.username;
    const channel = channels.get(channelId);
    if (!channel) return socket.emit('join-error', '频道不存在');

    if (channel.password && channel.password !== password) {
      return socket.emit('join-error', '密码错误');
    }

    socket.join(channelId);
    socket.currentChannel = channelId;
    socket.userId = userId;
    channel.users.add(userId);

    // 记录加入时间
    if (!joinTimers.has(channelId)) joinTimers.set(channelId, new Map());
    joinTimers.get(channelId).set(userId, Date.now());

    // 取消该频道的自动删除计时器
    if (deleteTimers.has(channelId)) {
      clearTimeout(deleteTimers.get(channelId));
      deleteTimers.delete(channelId);
      io.emit('channel-delete-cancelled', channelId);
    }

    console.log(`用户 ${userId} 加入频道 ${channel.name} (${channelId})`);

    const channelScreenStatus = screenShareStatus.get(channelId) || new Map();
    const channelMuted = mutedUsers.get(channelId) || new Set();
    const roomUsers = Array.from(channel.users)
      .filter(u => u !== userId)
      .map(u => ({
        name: u,
        screenSharing: channelScreenStatus.get(u) || false,
        muted: channelMuted.has(u)
      }));
    socket.emit('room-users', roomUsers);
    socket.to(channelId).emit('user-connected', userId);

    io.emit('channel-updated', {
      id: channelId,
      name: channel.name,
      users: Array.from(channel.users),
      hasPassword: !!channel.password,
      owner: channel.owner,
      personTime: channel.personTime || 0,
      pendingDelete: deleteTimers.has(channelId)
    });

    // 通知有人加入
    socket.to(channelId).emit('user-joined-notification', { user: userId, channel: channel.name });

    // 发送历史消息
    const history = channelMessages.get(channelId) || [];
    socket.emit('chat-history', history);
  });

  // 生成邀请链接
  socket.on('create-invite', (data) => {
    const { channelId, maxUses, expiresIn } = data;
    const channel = channels.get(channelId);
    if (!channel) return;
    if (socket.currentChannel !== channelId && channel.owner !== socket.username) return;

    const token = crypto.randomBytes(8).toString('hex');
    inviteTokens.set(token, {
      channelId,
      createdAt: Date.now(),
      maxUses: maxUses || 0, // 0 = unlimited
      uses: 0,
      expiresIn: expiresIn || 86400000 // default 24h
    });
    socket.emit('invite-created', { token, channelId });
  });

  // 通过邀请链接加入
  socket.on('join-by-invite', (token) => {
    const invite = inviteTokens.get(token);
    if (!invite) return socket.emit('join-error', '邀请链接无效或已过期');

    if (invite.maxUses > 0 && invite.uses >= invite.maxUses) {
      return socket.emit('join-error', '邀请链接已达使用次数上限');
    }
    if (Date.now() - invite.createdAt > invite.expiresIn) {
      inviteTokens.delete(token);
      return socket.emit('join-error', '邀请链接已过期');
    }

    invite.uses++;
    const channel = channels.get(invite.channelId);
    if (!channel) return socket.emit('join-error', '频道不存在');

    socket.emit('invite-valid', { channelId: invite.channelId, channelName: channel.name, hasPassword: !!channel.password });
  });

  // 房主踢人
  socket.on('kick-user', (data) => {
    const { channelId, targetUser } = data;
    const channel = channels.get(channelId);
    if (!channel || channel.owner !== socket.username) return;
    if (targetUser === socket.username) return;

    // 找到目标用户的 socket
    const sockets = io.sockets.sockets;
    for (const [id, s] of sockets) {
      if (s.userId === targetUser && s.currentChannel === channelId) {
        s.emit('kicked', { channel: channel.name });
        s.leave(channelId);
        s.currentChannel = null;
        channel.users.delete(targetUser);
        if (joinTimers.has(channelId)) joinTimers.get(channelId).delete(targetUser);
        socket.to(channelId).emit('user-disconnected', targetUser);
        break;
      }
    }
    io.emit('channel-updated', {
      id: channelId,
      name: channel.name,
      users: Array.from(channel.users),
      hasPassword: !!channel.password,
      owner: channel.owner,
      personTime: channel.personTime || 0,
      pendingDelete: deleteTimers.has(channelId)
    });
  });

  // 房主静音他人
  socket.on('mute-user', (data) => {
    const { channelId, targetUser } = data;
    const channel = channels.get(channelId);
    if (!channel || channel.owner !== socket.username) return;

    if (!mutedUsers.has(channelId)) mutedUsers.set(channelId, new Set());
    mutedUsers.get(channelId).add(targetUser);

    io.to(channelId).emit('user-muted', { user: targetUser, muted: true });
  });

  socket.on('unmute-user', (data) => {
    const { channelId, targetUser } = data;
    const channel = channels.get(channelId);
    if (!channel || channel.owner !== socket.username) return;

    if (mutedUsers.has(channelId)) mutedUsers.get(channelId).delete(targetUser);
    io.to(channelId).emit('user-muted', { user: targetUser, muted: false });
  });

  // 音量/说话状态广播
  socket.on('speaking-status', (data) => {
    if (socket.currentChannel) {
      socket.to(socket.currentChannel).emit('speaking-status', { user: socket.userId, speaking: data.speaking });
    }
  });

  socket.on('offer', (data) => {
    if (socket.currentChannel) socket.to(socket.currentChannel).emit('offer', data);
  });

  socket.on('answer', (data) => {
    if (socket.currentChannel) socket.to(socket.currentChannel).emit('answer', data);
  });

  socket.on('ice-candidate', (data) => {
    if (socket.currentChannel) socket.to(socket.currentChannel).emit('ice-candidate', data);
  });

  socket.on('audio-status', (data) => {
    if (socket.currentChannel) socket.to(socket.currentChannel).emit('audio-status', { user: socket.userId, ...data });
  });

  socket.on('screen-share-status', (data) => {
    if (socket.currentChannel) {
      const channelId = socket.currentChannel;
      if (!screenShareStatus.has(channelId)) screenShareStatus.set(channelId, new Map());
      screenShareStatus.get(channelId).set(data.user, data.sharing);
      socket.to(channelId).emit('screen-share-status', { user: socket.userId, sharing: data.sharing });
    }
  });

  socket.on('chat-message', (data) => {
    if (data.message && data.message.length > 100000) return;
    if (socket.currentChannel) {
      const msgId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
      const msg = { ...data, id: msgId, reactions: {} };
      // 持久化
      if (!channelMessages.has(socket.currentChannel)) channelMessages.set(socket.currentChannel, []);
      const msgs = channelMessages.get(socket.currentChannel);
      msgs.push(msg);
      if (msgs.length > MAX_MESSAGES) msgs.splice(0, msgs.length - MAX_MESSAGES);
      saveMessages();
      // 广播
      socket.to(socket.currentChannel).emit('chat-message', msg);
      socket.emit('chat-message', msg);
    }
  });

  // 消息撤回
  socket.on('delete-message', (msgId) => {
    if (!socket.currentChannel) return;
    const msgs = channelMessages.get(socket.currentChannel);
    if (!msgs) return;
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx >= 0 && msgs[idx].user === socket.username) {
      msgs.splice(idx, 1);
      saveMessages();
      io.to(socket.currentChannel).emit('message-deleted', msgId);
    }
  });

  // 输入中指示器
  socket.on('typing-status', (data) => {
    if (!socket.currentChannel) return;
    const channelId = socket.currentChannel;
    if (!typingUsers.has(channelId)) typingUsers.set(channelId, new Map());
    const map = typingUsers.get(channelId);
    if (data.typing) {
      // 清除旧计时器
      if (map.has(socket.username)) clearTimeout(map.get(socket.username));
      // 3秒后自动清除
      const timer = setTimeout(() => {
        map.delete(socket.username);
        socket.to(channelId).emit('typing-users', Array.from(map.keys()));
      }, 3000);
      map.set(socket.username, timer);
    } else {
      if (map.has(socket.username)) clearTimeout(map.get(socket.username));
      map.delete(socket.username);
    }
    socket.to(channelId).emit('typing-users', Array.from(map.keys()));
  });

  // 表情回复
  socket.on('add-reaction', (data) => {
    if (!socket.currentChannel) return;
    const { msgId, emoji } = data;
    const msgs = channelMessages.get(socket.currentChannel);
    if (!msgs) return;
    const msg = msgs.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const users = msg.reactions[emoji];
    const userIdx = users.indexOf(socket.username);
    if (userIdx >= 0) {
      users.splice(userIdx, 1); // 取消
      if (users.length === 0) delete msg.reactions[emoji];
    } else {
      users.push(socket.username); // 添加
    }
    saveMessages();
    io.to(socket.currentChannel).emit('reaction-updated', { msgId, reactions: msg.reactions });
  });

  socket.on('leave-channel', () => {
    handleLeave(socket);
  });

  socket.on('rename-channel', (channelId, newName) => {
    const channel = channels.get(channelId);
    if (!channel || channel.owner !== socket.username) return;
    if (channels.has(channelId)) {
      channel.name = newName;
      saveChannels();
      io.emit('channel-updated', {
        id: channelId,
        name: newName,
        users: Array.from(channel.users),
        hasPassword: !!channel.password,
        owner: channel.owner,
        personTime: channel.personTime || 0,
        pendingDelete: deleteTimers.has(channelId)
      });
    }
  });

  socket.on('delete-channel', (channelId) => {
    if (channels.has(channelId)) {
      const channel = channels.get(channelId);
      // 只有房主可以手动删除
      if (channel.owner !== socket.username) return;
      deleteChannel(channelId, channel);
    }
  });

  socket.on('disconnect', () => {
    handleLeave(socket);
  });
});

// 计算自动删除延迟（基于累计人时）
function calcDeleteDelay(personTimeSeconds) {
  const BASE_DELAY = 10 * 60 * 1000;  // 10 分钟基础
  const MAX_DELAY = 24 * 60 * 60 * 1000; // 24 小时上限
  const delay = BASE_DELAY + personTimeSeconds * 0.2 * 1000;
  return Math.min(Math.round(delay), MAX_DELAY);
}

// 通用频道删除
function deleteChannel(channelId, channel) {
  console.log(`频道 ${channel.name} (${channelId}) 被删除`);
  io.to(channelId).emit('channel-removed', { reason: 'deleted' });
  channels.delete(channelId);
  joinTimers.delete(channelId);
  screenShareStatus.delete(channelId);
  mutedUsers.delete(channelId);
  channelMessages.delete(channelId);
  typingUsers.delete(channelId);
  if (deleteTimers.has(channelId)) {
    clearTimeout(deleteTimers.get(channelId));
    deleteTimers.delete(channelId);
  }
  saveChannels();
  saveMessages();
  io.emit('channel-deleted', channelId);
}

function handleLeave(socket) {
  if (socket.currentChannel && socket.userId) {
    const channelId = socket.currentChannel;
    const userId = socket.userId;
    const channel = channels.get(channelId);

    if (channel) {
      // 累计人时
      const timers = joinTimers.get(channelId);
      if (timers && timers.has(userId)) {
        const joinTime = timers.get(userId);
        const duration = (Date.now() - joinTime) / 1000; // 秒
        channel.personTime = (channel.personTime || 0) + duration;
        timers.delete(userId);
        saveChannels();
      }

      console.log(`用户 ${userId} 离开频道 ${channel.name} (${channelId})`);
      socket.leave(channelId);
      socket.to(channelId).emit('user-disconnected', userId);
      socket.to(channelId).emit('user-left-notification', { user: userId, channel: channel.name });

      channel.users.delete(userId);
      if (screenShareStatus.has(channelId)) screenShareStatus.get(channelId).delete(userId);

      if (channel.users.size === 0) {
        // 频道为空，启动自动删除计时器
        const delay = calcDeleteDelay(channel.personTime || 0);
        console.log(`频道 ${channel.name} 空闲，${Math.round(delay/1000/60)} 分钟后自动删除 (累计人时: ${Math.round(channel.personTime || 0)}s)`);
        const timer = setTimeout(() => {
          if (channels.has(channelId) && channels.get(channelId).users.size === 0) {
            deleteChannel(channelId, channels.get(channelId));
          }
        }, delay);
        deleteTimers.set(channelId, timer);

        io.emit('channel-updated', {
          id: channelId,
          name: channel.name,
          users: [],
          hasPassword: !!channel.password,
          owner: channel.owner,
          personTime: channel.personTime || 0,
          pendingDelete: true,
          deleteAt: Date.now() + delay
        });
      } else {
        io.emit('channel-updated', {
          id: channelId,
          name: channel.name,
          users: Array.from(channel.users),
          hasPassword: !!channel.password,
          owner: channel.owner,
          personTime: channel.personTime || 0,
          pendingDelete: false
        });
      }
    }
    socket.currentChannel = null;
  }
}

function generateRoomId() {
  let id;
  do {
    id = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (channels.has(id));
  return id;
}

const os = require('os');
const PORT = config.port || 6789;
const HOST = config.host || '0.0.0.0';
const DOMAIN = config.domain || 'localhost';

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, HOST, () => {
  const localIP = getLocalIP();
  console.log('========================================');
  console.log('语音频道服务器已启动！');
  console.log(`本地访问: https://localhost:${PORT}`);
  console.log(`局域网访问: https://${localIP}:${PORT}`);
  console.log(`外网访问: https://${DOMAIN}:${PORT}`);
  console.log(`持久化频道: ${channels.size} 个`);
  console.log('========================================');
});
