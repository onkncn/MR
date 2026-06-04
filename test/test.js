/**
 * Meeting Room 自动化测试套件
 * 
 * 运行方式: npm test
 * 要求: 服务器必须在 localhost:6789 运行
 */

const { io } = require('socket.io-client');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const URL = 'https://localhost:6789';
let passed = 0, failed = 0, total = 0;
const failures = [];

// ─── 工具函数 ───

function connect(name) {
  return new Promise((resolve, reject) => {
    const s = io(URL, {
      rejectUnauthorized: false,
      transports: ['websocket', 'polling'],
      timeout: 5000
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('连接超时')), 5000);
  });
}

function waitFor(s, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    s.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

function noEvent(s, event, timeout = 1500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), timeout);
    s.once(event, () => { clearTimeout(timer); resolve(false); });
  });
}

function ok(name) { total++; passed++; console.log(`  ✅ ${name}`); }
function fail(name, reason) { total++; failed++; failures.push({ name, reason }); console.log(`  ❌ ${name}: ${reason}`); }
function section(title) { console.log(`\n${title}`); }

// ─── 测试用例 ───

async function runTests() {
  console.log('\n🧪 Meeting Room 自动化测试\n' + '='.repeat(50));

  // ─────────────────────────────────────
  // 1. 服务器连接
  // ─────────────────────────────────────
  section('📡 1. 服务器连接');

  let alice, bob, charlie;
  try {
    alice = await connect('Alice');
    ok('用户 Alice 连接成功');
  } catch (e) {
    fail('用户 Alice 连接', e.message);
    printResults();
    process.exit(1);
  }

  try {
    bob = await connect('Bob');
    ok('用户 Bob 连接成功');
  } catch (e) {
    fail('用户 Bob 连接', e.message);
    alice.disconnect();
    printResults();
    process.exit(1);
  }

  try {
    charlie = await connect('Charlie');
    ok('用户 Charlie 连接成功');
  } catch (e) {
    fail('用户 Charlie 连接', e.message);
    alice.disconnect(); bob.disconnect();
    printResults();
    process.exit(1);
  }

  // ─────────────────────────────────────
  // 2. 用户登录
  // ─────────────────────────────────────
  section('👤 2. 用户登录');

  try {
    const ch = waitFor(alice, 'channel-list');
    alice.emit('login', 'Alice');
    const list = await ch;
    ok(`Alice 登录成功，收到 ${list.length} 个频道`);
  } catch (e) { fail('Alice 登录', e.message); }

  try {
    const ch = waitFor(bob, 'channel-list');
    bob.emit('login', 'Bob');
    await ch;
    ok('Bob 登录成功');
  } catch (e) { fail('Bob 登录', e.message); }

  try {
    const ch = waitFor(charlie, 'channel-list');
    charlie.emit('login', 'Charlie');
    await ch;
    ok('Charlie 登录成功');
  } catch (e) { fail('Charlie 登录', e.message); }

  // ─────────────────────────────────────
  // 3. 创建频道
  // ─────────────────────────────────────
  section('📺 3. 创建频道');

  let publicChannelId, privateChannelId;

  try {
    const created = waitFor(alice, 'channel-created');
    alice.emit('create-channel', { name: '公共测试频道', password: null });
    const ch = await created;
    publicChannelId = ch.id;
    if (ch.name === '公共测试频道' && !ch.hasPassword) {
      ok(`创建公共频道 "${ch.name}" (id: ${ch.id})`);
    } else {
      fail('创建公共频道', `名称或密码标记异常: name=${ch.name}, hasPassword=${ch.hasPassword}`);
    }
  } catch (e) { fail('创建公共频道', e.message); }

  try {
    const created = waitFor(alice, 'channel-created');
    alice.emit('create-channel', { name: '私密测试频道', password: 'pass123' });
    const ch = await created;
    privateChannelId = ch.id;
    if (ch.name === '私密测试频道' && ch.hasPassword) {
      ok(`创建私密频道 "${ch.name}" (hasPassword: ${ch.hasPassword})`);
    } else {
      fail('创建私密频道', `名称或密码标记异常`);
    }
  } catch (e) { fail('创建私密频道', e.message); }

  // ─────────────────────────────────────
  // 4. 频道名验证
  // ─────────────────────────────────────
  section('✏️ 4. 频道名验证');

  // 空名称
  try {
    alice.emit('create-channel', { name: '   ', password: null });
    const rejected = await noEvent(alice, 'channel-created');
    if (rejected) ok('空名称被正确拒绝');
    else fail('空名称验证', '空名称频道被创建了');
  } catch (e) { fail('空名称验证', e.message); }

  // 超长名称
  try {
    alice.emit('create-channel', { name: 'a'.repeat(31), password: null });
    const rejected = await noEvent(alice, 'channel-created');
    if (rejected) ok('超长名称(>30字符)被正确拒绝');
    else fail('超长名称验证', '超长名称频道被创建了');
  } catch (e) { fail('超长名称验证', e.message); }

  // 合法名称
  try {
    const created = waitFor(alice, 'channel-created');
    alice.emit('create-channel', { name: '合法频道', password: null });
    const ch = await created;
    if (ch.name === '合法频道') ok('合法名称(30字符内)创建成功');
    else fail('合法名称创建', '名称不匹配');
  } catch (e) { fail('合法名称创建', e.message); }

  // ─────────────────────────────────────
  // 5. 加入公共频道
  // ─────────────────────────────────────
  section('🚪 5. 加入公共频道');

  try {
    const users = waitFor(bob, 'room-users');
    bob.emit('join-channel', { channelId: publicChannelId });
    const u = await users;
    ok(`Bob 加入公共频道，房间内 ${u.length} 人`);
  } catch (e) { fail('Bob 加入公共频道', e.message); }

  // ─────────────────────────────────────
  // 6. 密码频道验证
  // ─────────────────────────────────────
  section('🔐 6. 密码频道验证');

  // 错误密码
  try {
    const err = waitFor(bob, 'join-error');
    bob.emit('leave-channel');
    await new Promise(r => setTimeout(r, 300));
    bob.emit('join-channel', { channelId: privateChannelId, password: 'wrong' });
    const msg = await err;
    if (msg.includes('密码')) ok(`错误密码被拒绝: "${msg}"`);
    else fail('错误密码拒绝', `返回消息: ${msg}`);
  } catch (e) { fail('错误密码拒绝', e.message); }

  // 正确密码
  try {
    // 重新登录获取最新频道列表
    const chList = waitFor(bob, 'channel-list');
    bob.emit('login', 'Bob');
    await chList;
    await new Promise(r => setTimeout(r, 300));

    const users = waitFor(bob, 'room-users');
    bob.emit('join-channel', { channelId: privateChannelId, password: 'pass123' });
    const u = await users;
    ok(`Bob 用正确密码加入私密频道，房间内 ${u.length} 人`);
  } catch (e) { fail('正确密码加入', e.message); }

  // ─────────────────────────────────────
  // 7. 聊天消息
  // ─────────────────────────────────────
  section('💬 7. 聊天消息');

  // Alice 也加入私密频道
  try {
    alice.emit('leave-channel');
    await new Promise(r => setTimeout(r, 300));
    const users = waitFor(alice, 'room-users');
    alice.emit('join-channel', { channelId: privateChannelId, password: 'pass123' });
    await users;
    await new Promise(r => setTimeout(r, 300));
    ok('Alice 加入私密频道准备聊天测试');
  } catch (e) { fail('Alice 加入私密频道', e.message); }

  // 发送消息
  try {
    const aliceMsg = waitFor(alice, 'chat-message');
    bob.emit('chat-message', { message: '你好 Alice！', user: 'Bob' });
    const msg = await aliceMsg;
    if (msg.message === '你好 Alice！' && msg.user === 'Bob') {
      ok(`消息收发正常: "${msg.message}" (from: ${msg.user})`);
    } else {
      fail('消息收发', `内容不匹配: ${JSON.stringify(msg)}`);
    }
  } catch (e) { fail('消息收发', e.message); }

  // ─────────────────────────────────────
  // 8. 安全: 消息伪造防护
  // ─────────────────────────────────────
  section('🛡️ 8. 安全: 消息伪造防护');

  try {
    const msg = waitFor(alice, 'chat-message');
    bob.emit('chat-message', { message: '伪造消息', user: 'Alice' }); // Bob 冒充 Alice
    const received = await msg;
    if (received.user === 'Bob') {
      ok(`消息伪造被拦截: Bob 冒充 Alice → user 仍为 "${received.user}"`);
    } else {
      fail('消息伪造防护', `user 被覆盖为 ${received.user}`);
    }
  } catch (e) { fail('消息伪造防护', e.message); }

  // ─────────────────────────────────────
  // 9. 安全: WebRTC 信令 from 伪造防护
  // ─────────────────────────────────────
  section('📡 9. 安全: WebRTC 信令 from 伪造防护');

  try {
    const offer = waitFor(bob, 'offer');
    alice.emit('offer', { from: 'Eve', sdp: 'fake-sdp' });
    const data = await offer;
    if (data.from === 'Alice') {
      ok(`offer from 伪造被拦截: 实际 from="${data.from}"`);
    } else {
      fail('offer from 伪造防护', `from 为 "${data.from}"`);
    }
  } catch (e) { fail('offer from 伪造防护', e.message); }

  try {
    const answer = waitFor(alice, 'answer');
    bob.emit('answer', { from: 'Eve', sdp: 'fake-sdp' });
    const data = await answer;
    if (data.from === 'Bob') {
      ok(`answer from 伪造被拦截: 实际 from="${data.from}"`);
    } else {
      fail('answer from 伪造防护', `from 为 "${data.from}"`);
    }
  } catch (e) { fail('answer from 伪造防护', e.message); }

  // ─────────────────────────────────────
  // 10. 频道列表同步
  // ─────────────────────────────────────
  section('📋 10. 频道列表同步');

  try {
    const ch = waitFor(charlie, 'channel-list');
    charlie.emit('login', 'Charlie');
    const list = await ch;
    const hasPublic = list.some(c => c.name === '公共测试频道');
    const hasPrivate = list.some(c => c.name === '私密测试频道');
    const hasPwd = list.find(c => c.name === '私密测试频道');
    if (hasPublic && hasPrivate) {
      ok(`频道列表同步正常: ${list.length} 个频道，密码标记: ${hasPwd?.hasPassword}`);
    } else {
      fail('频道列表同步', `公共=${hasPublic}, 私密=${hasPrivate}`);
    }
  } catch (e) { fail('频道列表同步', e.message); }

  // ─────────────────────────────────────
  // 11. 离开频道通知
  // ─────────────────────────────────────
  section('👋 11. 离开频道通知');

  try {
    const disconnect = waitFor(alice, 'user-disconnected');
    bob.emit('leave-channel');
    const who = await disconnect;
    if (who === 'Bob') ok(`离开通知正常: Alice 收到 "${who}" 离开`);
    else fail('离开通知', `收到 ${who} 而非 Bob`);
  } catch (e) { fail('离开通知', e.message); }

  // ─────────────────────────────────────
  // 12. 用户加入通知
  // ─────────────────────────────────────
  section('🔔 12. 用户加入通知');

  try {
    const connected = waitFor(alice, 'user-connected');
    const bobUsers = waitFor(bob, 'room-users');
    bob.emit('join-channel', { channelId: privateChannelId, password: 'pass123' });
    const who = await connected;
    await bobUsers;
    if (who === 'Bob') ok(`加入通知正常: Alice 收到 "${who}" 加入`);
    else fail('加入通知', `收到 ${who} 而非 Bob`);
  } catch (e) { fail('加入通知', e.message); }

  // ─────────────────────────────────────
  // 13. 多用户同频道
  // ─────────────────────────────────────
  section('👥 13. 多用户同频道');

  try {
    const users = waitFor(charlie, 'room-users');
    charlie.emit('join-channel', { channelId: privateChannelId, password: 'pass123' });
    const u = await users;
    // room-users 返回已在房间的其他用户（不含自己），3人频道中新加入者收到2人
    if (u.length >= 2) ok(`三人同频道: Charlie 收到 ${u.length} 个其他用户`);
    else fail('三人同频道', `只有 ${u.length} 个其他用户`);
  } catch (e) { fail('三人同频道', e.message); }

  // ─────────────────────────────────────
  // 14. 麦克风 & 扬声器状态
  // ─────────────────────────────────────
  section('🎤 14. 麦克风 & 扬声器状态');

  // 麦克风开启通知
  try {
    const status = waitFor(bob, 'audio-status');
    alice.emit('audio-status', { enabled: true });
    const data = await status;
    if (data.user === 'Alice' && data.enabled === true) {
      ok(`麦克风开启通知: Alice → enabled=${data.enabled}`);
    } else {
      fail('麦克风开启通知', `user=${data.user}, enabled=${data.enabled}`);
    }
  } catch (e) { fail('麦克风开启通知', e.message); }

  // 麦克风关闭通知
  try {
    const status = waitFor(bob, 'audio-status');
    alice.emit('audio-status', { enabled: false });
    const data = await status;
    if (data.user === 'Alice' && data.enabled === false) {
      ok(`麦克风关闭通知: Alice → enabled=${data.enabled}`);
    } else {
      fail('麦克风关闭通知', `user=${data.user}, enabled=${data.enabled}`);
    }
  } catch (e) { fail('麦克风关闭通知', e.message); }

  // 麦克风状态伪造防护
  try {
    const status = waitFor(alice, 'audio-status');
    bob.emit('audio-status', { user: 'Alice', enabled: true }); // Bob 冒充 Alice
    const data = await status;
    if (data.user === 'Bob') {
      ok(`麦克风状态伪造被拦截: Bob 冒充 Alice → user 仍为 "${data.user}"`);
    } else {
      fail('麦克风状态伪造防护', `user 被覆盖为 ${data.user}`);
    }
  } catch (e) { fail('麦克风状态伪造防护', e.message); }

  // 说话状态通知
  try {
    const speaking = waitFor(bob, 'speaking-status');
    alice.emit('speaking-status', { speaking: true });
    const data = await speaking;
    if (data.user === 'Alice' && data.speaking === true) {
      ok(`说话状态通知: Alice → speaking=${data.speaking}`);
    } else {
      fail('说话状态通知', `user=${data.user}, speaking=${data.speaking}`);
    }
  } catch (e) { fail('说话状态通知', e.message); }

  // 停止说话通知
  try {
    const speaking = waitFor(bob, 'speaking-status');
    alice.emit('speaking-status', { speaking: false });
    const data = await speaking;
    if (data.user === 'Alice' && data.speaking === false) {
      ok(`停止说话通知: Alice → speaking=${data.speaking}`);
    } else {
      fail('停止说话通知', `user=${data.user}, speaking=${data.speaking}`);
    }
  } catch (e) { fail('停止说话通知', e.message); }

  // ─────────────────────────────────────
  // 15. 屏幕共享状态
  // ─────────────────────────────────────
  section('🖥️ 15. 屏幕共享状态');

  // 开始屏幕共享
  try {
    const status = waitFor(bob, 'screen-share-status');
    alice.emit('screen-share-status', { user: 'Alice', sharing: true });
    const data = await status;
    if (data.user === 'Alice' && data.sharing === true) {
      ok(`屏幕共享开启: Alice → sharing=${data.sharing}`);
    } else {
      fail('屏幕共享开启', `user=${data.user}, sharing=${data.sharing}`);
    }
  } catch (e) { fail('屏幕共享开启', e.message); }

  // 停止屏幕共享
  try {
    const status = waitFor(bob, 'screen-share-status');
    alice.emit('screen-share-status', { user: 'Alice', sharing: false });
    const data = await status;
    if (data.user === 'Alice' && data.sharing === false) {
      ok(`屏幕共享停止: Alice → sharing=${data.sharing}`);
    } else {
      fail('屏幕共享停止', `user=${data.user}, sharing=${data.sharing}`);
    }
  } catch (e) { fail('屏幕共享停止', e.message); }

  // 屏幕共享用户伪造防护
  try {
    const status = waitFor(alice, 'screen-share-status');
    bob.emit('screen-share-status', { user: 'Alice', sharing: true }); // Bob 冒充 Alice
    const data = await status;
    if (data.user === 'Bob') {
      ok(`屏幕共享伪造被拦截: Bob 冒充 Alice → user 仍为 "${data.user}"`);
    } else {
      fail('屏幕共享伪造防护', `user 被覆盖为 ${data.user}`);
    }
  } catch (e) { fail('屏幕共享伪造防护', e.message); }

  // ─────────────────────────────────────
  // 16. 频道管理员静音功能
  // ─────────────────────────────────────
  section('🔇 16. 频道管理员静音');

  // Alice 是频道创建者，尝试静音 Bob
  try {
    const muted = waitFor(bob, 'user-muted');
    alice.emit('mute-user', { channelId: privateChannelId, targetUser: 'Bob' });
    const data = await muted;
    if (data.user === 'Bob' && data.muted === true) {
      ok(`管理员静音: Alice 静音 Bob → muted=${data.muted}`);
    } else {
      fail('管理员静音', `user=${data.user}, muted=${data.muted}`);
    }
  } catch (e) { fail('管理员静音', e.message); }

  // 取消静音
  try {
    const unmuted = waitFor(bob, 'user-muted');
    alice.emit('unmute-user', { channelId: privateChannelId, targetUser: 'Bob' });
    const data = await unmuted;
    if (data.user === 'Bob' && data.muted === false) {
      ok(`取消静音: Alice 取消静音 Bob → muted=${data.muted}`);
    } else {
      fail('取消静音', `user=${data.user}, muted=${data.muted}`);
    }
  } catch (e) { fail('取消静音', e.message); }

  // 非管理员不能静音
  try {
    bob.emit('mute-user', { channelId: privateChannelId, targetUser: 'Alice' }); // Bob 尝试静音 Alice
    const rejected = await noEvent(alice, 'user-muted');
    if (rejected) ok('非管理员静音被拒绝');
    else fail('非管理员静音', '非管理员成功静音了别人');
  } catch (e) { fail('非管理员静音', e.message); }

  // ─────────────────────────────────────
  // 17. 清理测试数据 & 断开
  // ─────────────────────────────────────
  section('🧹 17. 清理 & 断开');

  // 清理测试创建的频道
  try {
    const fs = require('fs');
    const path = require('path');
    const channelsFile = path.join(__dirname, '..', 'data', 'channels.json');
    if (fs.existsSync(channelsFile)) {
      const data = JSON.parse(fs.readFileSync(channelsFile, 'utf-8'));
      const testNames = ['公共测试频道', '私密测试频道', '合法频道'];
      let cleaned = 0;
      const result = {};
      for (const [id, ch] of Object.entries(data)) {
        if (testNames.includes(ch.name)) { cleaned++; continue; }
        result[id] = ch;
      }
      fs.writeFileSync(channelsFile, JSON.stringify(result, null, 2));
      if (cleaned > 0) ok(`清理 ${cleaned} 个测试频道`);
      else ok('无测试频道需要清理');
    }
  } catch (e) { fail('清理测试频道', e.message); }

  alice.disconnect();
  bob.disconnect();
  charlie.disconnect();
  ok('所有连接已断开');

  // ─────────────────────────────────────
  // 结果
  // ─────────────────────────────────────
  printResults();
}

function printResults() {
  console.log('\n' + '='.repeat(50));
  console.log(`📊 测试结果: ${passed} 通过, ${failed} 失败, 共 ${total} 项`);
  if (failures.length > 0) {
    console.log('\n失败详情:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}: ${f.reason}`));
  }
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
