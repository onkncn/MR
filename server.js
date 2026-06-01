const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

const options = {
  key: fs.readFileSync(path.join(__dirname, '../.ssl/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, '../.ssl/cert.pem'))
};

const server = https.createServer(options, app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const channels = new Map();
// 跟踪每个用户的屏幕共享状态 { channelId -> Map<userId, boolean> }
const screenShareStatus = new Map();

io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  socket.on('login', (username) => {
    socket.username = username;
    socket.emit('channel-list', Array.from(channels.entries()).map(([id, ch]) => ({
      id,
      name: ch.name,
      users: Array.from(ch.users)
    })));
    // 登录时不需要屏幕共享状态（用户还没加入任何频道）
  });

  socket.on('create-channel', (channelName) => {
    const channelId = generateRoomId();
    channels.set(channelId, {
      id: channelId,
      name: channelName,
      users: new Set()
    });
    io.emit('channel-created', {
      id: channelId,
      name: channelName,
      users: []
    });
  });

  socket.on('join-channel', (channelId, userId) => {
    const channel = channels.get(channelId);
    if (!channel) {
      return;
    }

    socket.join(channelId);
    socket.currentChannel = channelId;
    socket.userId = userId;
    channel.users.add(userId);

    console.log(`用户 ${userId} 加入频道 ${channel.name} (${channelId})`);

    // 发送用户列表（包含屏幕共享状态）
    const channelScreenStatus = screenShareStatus.get(channelId) || new Map();
    const roomUsers = Array.from(channel.users)
      .filter(u => u !== userId)
      .map(u => ({
        name: u,
        screenSharing: channelScreenStatus.get(u) || false
      }));
    socket.emit('room-users', roomUsers);
    socket.to(channelId).emit('user-connected', userId);

    io.emit('channel-updated', {
      id: channelId,
      name: channel.name,
      users: Array.from(channel.users)
    });
  });

  socket.on('offer', (data) => {
    if (socket.currentChannel) {
      socket.to(socket.currentChannel).emit('offer', data);
    }
  });

  socket.on('answer', (data) => {
    if (socket.currentChannel) {
      socket.to(socket.currentChannel).emit('answer', data);
    }
  });

  socket.on('ice-candidate', (data) => {
    if (socket.currentChannel) {
      socket.to(socket.currentChannel).emit('ice-candidate', data);
    }
  });

  socket.on('audio-status', (data) => {
    if (socket.currentChannel) {
      socket.to(socket.currentChannel).emit('audio-status', data);
    }
  });

  socket.on('screen-share-status', (data) => {
    if (socket.currentChannel) {
      // 更新服务端状态
      const channelId = socket.currentChannel;
      if (!screenShareStatus.has(channelId)) {
        screenShareStatus.set(channelId, new Map());
      }
      screenShareStatus.get(channelId).set(data.user, data.sharing);
      
      socket.to(channelId).emit('screen-share-status', data);
    }
  });

  socket.on('chat-message', (data) => {
    if (socket.currentChannel) {
      socket.to(socket.currentChannel).emit('chat-message', data);
    }
  });

  socket.on('leave-channel', () => {
    if (socket.currentChannel && socket.userId) {
      const channelId = socket.currentChannel;
      const userId = socket.userId;
      const channel = channels.get(channelId);
      
      if (channel) {
        console.log(`用户 ${userId} 离开频道 ${channel.name} (${channelId})`);
        socket.leave(channelId);
        socket.to(channelId).emit('user-disconnected', userId);
        
        channel.users.delete(userId);
        
        // 清理屏幕共享状态
        if (screenShareStatus.has(channelId)) {
          screenShareStatus.get(channelId).delete(userId);
        }
        
        if (channel.users.size === 0) {
          channels.delete(channelId);
          screenShareStatus.delete(channelId);
          io.emit('channel-deleted', channelId);
        } else {
          io.emit('channel-updated', {
            id: channelId,
            name: channel.name,
            users: Array.from(channel.users)
          });
        }
      }
      
      socket.currentChannel = null;
    }
  });

  socket.on('rename-channel', (channelId, newName) => {
    if (channels.has(channelId)) {
      const channel = channels.get(channelId);
      channel.name = newName;
      io.emit('channel-updated', {
        id: channelId,
        name: newName,
        users: Array.from(channel.users)
      });
    }
  });

  socket.on('delete-channel', (channelId) => {
    if (channels.has(channelId)) {
      const channel = channels.get(channelId);
      console.log(`频道 ${channel.name} (${channelId}) 被删除`);
      
      // 通知频道内所有用户断开
      channel.users.forEach(userId => {
        io.to(channelId).emit('user-disconnected', userId);
      });
      
      channels.delete(channelId);
      io.emit('channel-deleted', channelId);
    }
  });

  socket.on('disconnect', () => {
    if (socket.currentChannel && socket.userId) {
      const channelId = socket.currentChannel;
      const userId = socket.userId;
      const channel = channels.get(channelId);
      
      if (channel) {
        console.log(`用户 ${userId} 断开连接，离开频道 ${channel.name} (${channelId})`);
        socket.to(channelId).emit('user-disconnected', userId);
        
        channel.users.delete(userId);
        
        // 清理屏幕共享状态
        if (screenShareStatus.has(channelId)) {
          screenShareStatus.get(channelId).delete(userId);
        }
        
        if (channel.users.size === 0) {
          channels.delete(channelId);
          screenShareStatus.delete(channelId);
          io.emit('channel-deleted', channelId);
        } else {
          io.emit('channel-updated', {
            id: channelId,
            name: channel.name,
            users: Array.from(channel.users)
          });
        }
      }
    }
  });
});

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const os = require('os');
const PORT = process.env.PORT || 6789;

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('========================================');
  console.log('语音频道服务器已启动！');
  console.log('【注意】首次访问时浏览器会提示证书不安全，请点击"高级"->"继续访问"');
  console.log('');
  console.log(`本地访问: https://localhost:${PORT}`);
  console.log(`局域网访问: https://${localIP}:${PORT}`);
  console.log(`外网访问: https://onkn.cn:${PORT}`);
  console.log('');
  console.log('【外网访问配置检查】');
  console.log(`1. 确保路由器已将端口 ${PORT} 映射到 192.168.8.20:${PORT}`);
  console.log(`2. 确保服务器防火墙已开放 ${PORT} 端口`);
  console.log('');
  console.log('【功能】');
  console.log('✓ 语音通话');
  console.log('✓ 屏幕共享（支持全屏）');
  console.log('✓ 频道创建和重命名');
  console.log('✓ 移动端支持');
  console.log('========================================');
});
