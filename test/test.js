/**
 * Meeting Room 自动化测试套件
 * 
 * 运行方式: npm test
 * 要求: 服务器必须在 localhost:6800 运行
 */

const { io } = require('socket.io-client');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const URL = 'https://localhost:6800';
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

  let publicChannelId, privateChannelId, legalChannelId;
  const createdChannelIds = []; // 记录所有创建的频道ID用于清理

  try {
    const created = waitFor(alice, 'channel-created');
    alice.emit('create-channel', { name: '公共测试频道', password: null });
    const ch = await created;
    publicChannelId = ch.id;
    createdChannelIds.push(ch.id);
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
    createdChannelIds.push(ch.id);
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
    legalChannelId = ch.id;
    createdChannelIds.push(ch.id);
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
    // v2.1+ user-connected 发送 { name, ip } 对象，向前兼容字符串
    const whoName = typeof who === 'string' ? who : (who && who.name);
    if (whoName === 'Bob') ok(`加入通知正常: Alice 收到 "${whoName}" 加入`);
    else fail('加入通知', `收到 ${JSON.stringify(who)} 而非 Bob`);
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
  // 17. 踢人权限
  // ─────────────────────────────────────
  section('🚪 17. 踢人权限');

  // 非房主踢人应被拒绝
  try {
    charlie.emit('kick-user', { channelId: privateChannelId, targetUser: 'Alice' });
    const rejected = await noEvent(alice, 'kicked');
    if (rejected) ok('非房主踢人被拒绝: Charlie 尝试踢 Alice 无 kicked');
    else fail('非房主踢人', '非房主成功踢出了房主');
  } catch (e) { fail('非房主踢人', e.message); }

  // 房主踢人：Bob 被 Alice 踢出，频道内广播 user-disconnected
  try {
    const kicked = waitFor(bob, 'kicked');
    const gone = waitFor(charlie, 'user-disconnected');
    alice.emit('kick-user', { channelId: privateChannelId, targetUser: 'Bob' });
    const k = await kicked;
    const g = await gone;
    if (k.channel === '私密测试频道' && g === 'Bob') {
      ok('房主踢人: Alice 踢出 Bob → Bob 收 kicked, 频道内广播 user-disconnected');
    } else {
      fail('房主踢人', `kicked=${JSON.stringify(k)}, user-disconnected=${g}`);
    }
  } catch (e) { fail('房主踢人', e.message); }

  // Bob 重新加入，恢复状态供后续测试
  try {
    const users = waitFor(bob, 'room-users');
    bob.emit('join-channel', { channelId: privateChannelId, password: 'pass123' });
    await users;
    await new Promise(r => setTimeout(r, 300));
    ok('Bob 重新加入私密频道');
  } catch (e) { fail('Bob 重新加入', e.message); }

  // ─────────────────────────────────────
  // 18. 频道重命名权限
  // ─────────────────────────────────────
  section('✏️ 18. 频道重命名权限');

  // 非房主重命名被拒绝
  try {
    charlie.emit('rename-channel', privateChannelId, '非法改名');
    const rejected = await noEvent(alice, 'channel-updated');
    if (rejected) ok('非房主重命名被拒绝');
    else fail('非房主重命名', '非房主成功重命名了频道');
  } catch (e) { fail('非房主重命名', e.message); }

  // 房主重命名成功，所有用户收到 channel-updated
  try {
    const updated = waitFor(charlie, 'channel-updated');
    alice.emit('rename-channel', privateChannelId, '私密改名频道');
    const ch = await updated;
    if (ch.id === privateChannelId && ch.name === '私密改名频道') {
      ok('房主重命名: 频道改名为 "私密改名频道" 并广播 channel-updated');
    } else {
      fail('房主重命名', `id=${ch.id}, name=${ch.name}`);
    }
  } catch (e) { fail('房主重命名', e.message); }

  // 改回原名（保持后续测试一致性）
  try {
    const updated = waitFor(charlie, 'channel-updated');
    alice.emit('rename-channel', privateChannelId, '私密测试频道');
    await updated;
    ok('频道名恢复为 "私密测试频道"');
  } catch (e) { fail('频道名恢复', e.message); }

  // ─────────────────────────────────────
  // 19. 频道删除权限
  // ─────────────────────────────────────
  section('🗑️ 19. 频道删除权限');

  // 非房主删除被拒绝
  try {
    charlie.emit('delete-channel', privateChannelId);
    const rejected = await noEvent(alice, 'channel-removed');
    if (rejected) ok('非房主删除频道被拒绝');
    else fail('非房主删除频道', '非房主成功删除了频道');
  } catch (e) { fail('非房主删除频道', e.message); }

  // ─────────────────────────────────────
  // 20. 消息撤回权限
  // ─────────────────────────────────────
  section('↩️ 20. 消息撤回权限');

  let recallMsgId;
  // Bob 发一条待撤回消息
  try {
    const echoed = waitFor(bob, 'chat-message');
    bob.emit('chat-message', { message: '待撤回消息' });
    const msg = await echoed;
    recallMsgId = msg.id;
    if (recallMsgId) ok(`Bob 发送消息成功 (id: ${recallMsgId})`);
    else fail('发送消息', '回显消息缺少 id');
  } catch (e) { fail('发送消息', e.message); }

  // 第三者撤回被拒绝
  try {
    charlie.emit('delete-message', recallMsgId);
    const rejected = await noEvent(alice, 'message-deleted');
    if (rejected) ok('第三者撤回被拒绝: Charlie 无法撤回 Bob 的消息');
    else fail('第三者撤回', 'Charlie 成功撤回了 Bob 的消息');
  } catch (e) { fail('第三者撤回', e.message); }

  // 作者自己撤回成功
  try {
    const deleted = waitFor(charlie, 'message-deleted');
    bob.emit('delete-message', recallMsgId);
    const msgId = await deleted;
    if (msgId === recallMsgId) ok('作者撤回成功: Bob 撤回自己的消息 → message-deleted 广播');
    else fail('作者撤回', `收到 id=${msgId}`);
  } catch (e) { fail('作者撤回', e.message); }

  // ─────────────────────────────────────
  // 21. 全局在线列表 (v2.1)
  // ─────────────────────────────────────
  section('🌐 21. 全局在线列表');

  try {
    const dave = await connect('Dave');
    const online = waitFor(dave, 'online-users');
    const announced = waitFor(alice, 'user-online');
    dave.emit('login', 'Dave');
    const users = await online;
    const a = await announced;
    const names = users.map(u => u.name);
    if (a.name === 'Dave' && names.includes('Alice') && names.includes('Dave')) {
      ok(`Dave 登录: online-users 含 ${names.length} 人, Alice 收到 user-online`);
    } else {
      fail('全局在线列表', `online=${JSON.stringify(names)}, user-online=${JSON.stringify(a)}`);
    }
    // Dave 断开 → 其他人收到 user-offline
    const gone = waitFor(alice, 'user-offline');
    dave.disconnect();
    const off = await gone;
    if (off.name === 'Dave') ok('Dave 断开: Alice 收到 user-offline');
    else fail('user-offline', `收到 ${JSON.stringify(off)}`);
  } catch (e) { fail('全局在线列表', e.message); }

  // ─────────────────────────────────────
  // 22. 表情反应
  // ─────────────────────────────────────
  section('😀 22. 表情反应');

  let reactionMsgId;
  try {
    const echoed = waitFor(bob, 'chat-message');
    bob.emit('chat-message', { message: '这条要有表情' });
    const msg = await echoed;
    reactionMsgId = msg.id;
    ok('Bob 发送待反应消息');
  } catch (e) { fail('发送待反应消息', e.message); }

  // 添加反应
  try {
    const reacted = waitFor(alice, 'reaction-updated');
    bob.emit('add-reaction', { msgId: reactionMsgId, emoji: '👍' });
    const data = await reacted;
    const users = (data.reactions['👍'] || []);
    if (data.msgId === reactionMsgId && users.includes('Bob')) {
      ok('添加反应: 👍 → [Bob]');
    } else {
      fail('添加反应', `reactions=${JSON.stringify(data.reactions)}`);
    }
  } catch (e) { fail('添加反应', e.message); }

  // 再次点击取消反应（toggle）
  try {
    const reacted = waitFor(alice, 'reaction-updated');
    bob.emit('add-reaction', { msgId: reactionMsgId, emoji: '👍' });
    const data = await reacted;
    if (!data.reactions['👍']) {
      ok('取消反应: 再次点击 👍 已移除');
    } else {
      fail('取消反应', `reactions=${JSON.stringify(data.reactions)}`);
    }
  } catch (e) { fail('取消反应', e.message); }

  // ─────────────────────────────────────
  // 23. 输入状态
  // ─────────────────────────────────────
  section('⌨️ 23. 输入状态');

  // 输入中广播
  try {
    const typing = waitFor(alice, 'typing-users');
    bob.emit('typing-status', { typing: true });
    const list = await typing;
    if (Array.isArray(list) && list.includes('Bob')) {
      ok('输入状态: Bob 输入中 → typing-users [Bob]');
    } else {
      fail('输入状态', `typing-users=${JSON.stringify(list)}`);
    }
  } catch (e) { fail('输入状态', e.message); }

  // 停止输入
  try {
    const typing = waitFor(alice, 'typing-users');
    bob.emit('typing-status', { typing: false });
    const list = await typing;
    if (Array.isArray(list) && !list.includes('Bob')) {
      ok('停止输入: typing-users 移除 Bob');
    } else {
      fail('停止输入', `typing-users=${JSON.stringify(list)}`);
    }
  } catch (e) { fail('停止输入', e.message); }

  // 3 秒自动清除（不手动停止）
  try {
    bob.emit('typing-status', { typing: true });
    await new Promise(r => setTimeout(r, 100));
    const typing = waitFor(alice, 'typing-users', 5000);
    const list = await typing;
    if (Array.isArray(list) && !list.includes('Bob')) {
      ok('3秒自动清除: 未手动停止, typing-users 自动移除 Bob');
    } else {
      fail('3秒自动清除', `typing-users=${JSON.stringify(list)}`);
    }
  } catch (e) { fail('3秒自动清除', e.message); }

  // ─────────────────────────────────────
  // 24. 邀请链接
  // ─────────────────────────────────────
  section('🔗 24. 邀请链接');

  let inviteToken;
  // 房主生成邀请（限 1 次使用）
  try {
    const created = waitFor(alice, 'invite-created');
    alice.emit('create-invite', { channelId: privateChannelId, maxUses: 1 });
    const inv = await created;
    inviteToken = inv.token;
    if (inviteToken && inv.channelId === privateChannelId) ok(`邀请链接生成成功 (token: ${inviteToken.slice(0, 8)}...)`);
    else fail('邀请链接生成', JSON.stringify(inv));
  } catch (e) { fail('邀请链接生成', e.message); }

  // 用邀请加入成功 + 超限被拒
  try {
    const dave = await connect('Dave');
    const valid = waitFor(dave, 'invite-valid');
    dave.emit('join-by-invite', inviteToken);
    const info = await valid;
    if (info.channelId === privateChannelId && info.channelName === '私密测试频道') {
      ok('邀请加入: Dave 收到 invite-valid');
    } else {
      fail('邀请加入', JSON.stringify(info));
    }
    const over = waitFor(dave, 'join-error');
    dave.emit('join-by-invite', inviteToken);
    const err = await over;
    if (String(err).includes('上限')) ok('邀请超限被拒: 第二次使用 → join-error');
    else fail('邀请超限', String(err));
    dave.disconnect();
  } catch (e) { fail('邀请链接', e.message); }

  // 无效 token
  try {
    const dave = await connect('Dave');
    const err = waitFor(dave, 'join-error');
    dave.emit('join-by-invite', 'invalidtoken123');
    const e = await err;
    if (String(e).includes('无效') || String(e).includes('过期')) ok('无效 token 被拒: join-error');
    else fail('无效 token', String(e));
    dave.disconnect();
  } catch (e) { fail('无效 token', e.message); }

  // ─────────────────────────────────────
  // 25. 加入不存在的频道
  // ─────────────────────────────────────
  section('🚫 25. join-error');

  try {
    const err = waitFor(bob, 'join-error');
    bob.emit('join-channel', { channelId: 'NONEXIST123' });
    const e = await err;
    if (String(e).includes('不存在')) ok('加入不存在频道: join-error "频道不存在"');
    else fail('join-error', String(e));
  } catch (e) { fail('join-error', e.message); }

  // ─────────────────────────────────────
  // 26. 速率限制
  // ─────────────────────────────────────
  section('⏱️ 26. 速率限制');

  try {
    const rateUser = await connect('RateUser');
    rateUser.emit('login', 'RateUser');
    await new Promise(r => setTimeout(r, 300));
    // 连续 11 次 join-channel：前 10 次应收到 join-error（频道不存在），第 11 次被限流无响应
    let gotErrors = 0;
    for (let i = 1; i <= 10; i++) {
      const err = waitFor(rateUser, 'join-error', 2000);
      rateUser.emit('join-channel', { channelId: 'RATELIMIT' + i });
      try { await err; gotErrors++; } catch (e) { break; }
    }
    const silent = noEvent(rateUser, 'join-error', 1200);
    rateUser.emit('join-channel', { channelId: 'RATELIMIT11' });
    const rejected = await silent;
    if (gotErrors === 10 && rejected) {
      ok(`速率限制: 前 10 次响应, 第 11 次被限流 (gotErrors=${gotErrors})`);
    } else {
      fail('速率限制', `gotErrors=${gotErrors}, 第11次静默=${rejected}`);
    }
    rateUser.disconnect();
  } catch (e) { fail('速率限制', e.message); }

  // ─────────────────────────────────────
  // 27. 聊天历史
  // ─────────────────────────────────────
  section('📜 27. 聊天历史');

  let histChannelId;
  try {
    // v2.4 跨频道隔离准备：Alice 在私密频道发一条消息，
    // 后续验证它不会出现在历史频道的聊天记录里
    const aliceMsg = waitFor(alice, 'chat-message');
    alice.emit('chat-message', { message: '私密频道专属消息' });
    await aliceMsg;
    ok('隔离准备: Alice 在私密频道发送 "私密频道专属消息"');

    // Bob 创建并加入历史频道
    const created = waitFor(bob, 'channel-created');
    bob.emit('create-channel', { name: '历史频道', password: null });
    const ch = await created;
    histChannelId = ch.id;
    createdChannelIds.push(ch.id);
    const users = waitFor(bob, 'room-users');
    bob.emit('join-channel', { channelId: histChannelId });
    const bobRoomUsers = await users;
    // v2.4 频道隔离 — Bob 加入历史频道时 room-users 应为空：
    // Alice 在私密频道，不属于历史频道，不应出现在 Bob 的频道成员列表
    if (Array.isArray(bobRoomUsers) && bobRoomUsers.length === 0) {
      ok('频道隔离: Bob 加入历史频道, room-users 为空（Alice 在私密频道不在本频道）');
    } else {
      fail('频道隔离 room-users', `应为空, 实际=${JSON.stringify(bobRoomUsers)}`);
    }
    // Bob 发 2 条消息
    const m1 = waitFor(bob, 'chat-message');
    bob.emit('chat-message', { message: '历史消息1' });
    await m1;
    const m2 = waitFor(bob, 'chat-message');
    bob.emit('chat-message', { message: '历史消息2' });
    await m2;
    ok('历史频道: Bob 创建并发送 2 条消息');
  } catch (e) { fail('历史频道准备', e.message); }

  // 后加入者收到历史消息 + 频道隔离验证
  try {
    const hist = waitFor(charlie, 'chat-history');
    const roomUsersP = waitFor(charlie, 'room-users');
    charlie.emit('join-channel', { channelId: histChannelId });
    const history = await hist;
    const roomUsers = await roomUsersP;
    const texts = history.map(m => m.message);
    if (Array.isArray(history) && texts.includes('历史消息1') && texts.includes('历史消息2')) {
      ok(`后加入者收到聊天历史 (${history.length} 条, 含 Bob 的 2 条)`);
    } else {
      fail('聊天历史', JSON.stringify(texts));
    }
    // v2.4 聊天记录跨频道隔离 — Charlie 的 chat-history 是本频道（历史频道）的消息，
    // 不应包含 Alice 在私密频道发的 "私密频道专属消息"
    if (Array.isArray(history) && !texts.includes('私密频道专属消息')) {
      ok('聊天记录隔离: 历史频道的 chat-history 不含私密频道的消息');
    } else {
      fail('聊天记录隔离', `chat-history 混入了其他频道消息: ${JSON.stringify(texts)}`);
    }
    // v2.4 频道隔离 — Charlie 的 room-users 只含本频道成员 Bob，不含私密频道的 Alice
    const memberNames = roomUsers.map(u => (typeof u === 'string' ? u : u.name));
    if (memberNames.length === 1 && memberNames[0] === 'Bob') {
      ok('频道隔离: Charlie 加入历史频道, room-users 只含 Bob（不含私密频道的 Alice）');
    } else {
      fail('频道隔离 room-users', `实际=${JSON.stringify(memberNames)}`);
    }
    // v2.4 频道隔离 — Bob 离开历史频道：只有历史频道成员收到 user-disconnected，
    // 私密频道的 Alice 不应收到（事件按频道隔离广播）
    const gone = waitFor(charlie, 'user-disconnected');
    const aliceGone = noEvent(alice, 'user-disconnected', 1200);
    bob.emit('leave-channel');
    const g = await gone;
    const isolated = await aliceGone;
    if (g === 'Bob' && isolated) {
      ok('频道隔离: Bob 离开历史频道 → Charlie 收 user-disconnected, 私密频道的 Alice 不收到');
    } else {
      fail('频道隔离 user-disconnected', `charlie=${g}, alice静默=${isolated}`);
    }
    // 清理：Bob（房主）删除历史频道
    const removed = waitFor(charlie, 'channel-removed');
    bob.emit('delete-channel', histChannelId);
    await removed;
    ok('历史频道已清理');
  } catch (e) { fail('聊天历史', e.message); }

  // ─────────────────────────────────────
  // 28. 清理测试数据 & 断开
  // ─────────────────────────────────────
  section('🧹 28. 清理 & 断开');

  // 通过 socket 删除测试创建的频道
  try {
    let cleaned = 0;
    for (const channelId of createdChannelIds) {
      try {
        const deleted = waitFor(alice, 'channel-removed', 2000);
        alice.emit('delete-channel', channelId);
        await deleted;
        cleaned++;
      } catch (e) {
        // 频道可能已经被删除或不存在，忽略错误
      }
    }
    if (cleaned > 0) ok(`通过 socket 清理 ${cleaned} 个测试频道`);
    else ok('无测试频道需要清理');
  } catch (e) { fail('清理测试频道', e.message); }

  alice.disconnect();
  bob.disconnect();
  charlie.disconnect();
  ok('所有连接已断开');

  // ─────────────────────────────────────
  // 29. 前端静态文件检查
  // ─────────────────────────────────────
  section('📄 29. 前端静态文件检查');

  const fs = require('fs');
  const path = require('path');
  const publicDir = path.join(__dirname, '..', 'public');

  // 检查 app.js 是否包含关键函数
  try {
    const appJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf-8');
    
    // M9: visibilitychange 事件处理
    if (appJs.includes("document.addEventListener('visibilitychange'")) {
      ok('M9: visibilitychange 事件处理存在');
    } else {
      fail('M9: visibilitychange 事件处理', '未找到');
    }
    
    // 面板滑动缩放函数
    if (appJs.includes('function initPanelSwipeResize')) {
      ok('面板滑动缩放函数 initPanelSwipeResize 存在');
    } else {
      fail('面板滑动缩放函数', '未找到 initPanelSwipeResize');
    }
    
    // 边缘滑动检测
    if (appJs.includes('EDGE_SWIPE_ZONE')) {
      ok('边缘滑动检测常量 EDGE_SWIPE_ZONE 存在');
    } else {
      fail('边缘滑动检测', '未找到 EDGE_SWIPE_ZONE');
    }
    
    // 隐藏阈值常量
    if (appJs.includes('HIDE_THRESHOLD')) {
      ok('隐藏阈值常量 HIDE_THRESHOLD 存在');
    } else {
      fail('隐藏阈值常量', '未找到 HIDE_THRESHOLD');
    }
    
    // 方向锁定机制
    if (appJs.includes('directionLocked')) {
      ok('方向锁定机制 directionLocked 存在');
    } else {
      fail('方向锁定机制', '未找到 directionLocked');
    }
    
    // 频道名隐藏功能
    if (appJs.includes('header-hidden')) {
      ok('频道名隐藏功能 header-hidden 存在');
    } else {
      fail('频道名隐藏功能', '未找到 header-hidden');
    }
    
    // 横屏上滑手势功能
    if (appJs.includes('initHeaderSwipeToggle')) {
      ok('横屏上滑手势函数 initHeaderSwipeToggle 存在');
    } else {
      fail('横屏上滑手势函数', '未找到 initHeaderSwipeToggle');
    }
    
    // 上滑阈值常量
    if (appJs.includes('SWIPE_THRESHOLD')) {
      ok('上滑阈值常量 SWIPE_THRESHOLD 存在');
    } else {
      fail('上滑阈值常量', '未找到 SWIPE_THRESHOLD');
    }
    
    // 上滑隐藏逻辑
    if (appJs.includes("channelHeader.classList.add('header-hidden')") &&
        appJs.includes("channelHeader.classList.remove('header-hidden')")) {
      ok('上滑隐藏/下滑恢复逻辑存在');
    } else {
      fail('上滑隐藏/下滑恢复逻辑', '未找到 add/remove header-hidden');
    }
    
    // M14: 无声必须换用户名才能恢复的问题修复守护
    if (appJs.includes('function scheduleRebuild')) {
      ok('M14: scheduleRebuild 自动重建函数存在');
    } else {
      fail('M14: scheduleRebuild', '未找到函数');
    }
    
    if (appJs.includes('scheduleRebuild(remoteUserName')) {
      ok('M14: failed 分支调用 scheduleRebuild 自动重建');
    } else {
      fail('M14: failed 自动重建', 'failed 分支未调用 scheduleRebuild');
    }
    
    if (appJs.includes('M14 不再删除 participants')) {
      ok('M14: failed 不再删除 participants（对方可能仍在线）');
    } else {
      fail('M14: participants 保留', '未找到标记');
    }
    
    if (appJs.includes('room-users 兜底建连')) {
      ok('M14: room-users 兜底建连（不依赖 user-connected 事件）');
    } else {
      fail('M14: room-users 兜底', '未找到标记');
    }
    
    if (appJs.includes('currentChannel._password') && appJs.includes('password: currentChannel._password')) {
      ok('M14: R2 断线重连带密码（缓存 _password 并在重连 emit 时使用）');
    } else {
      fail('M14: R2 带密码', '未找到 _password 缓存/使用');
    }
    
    // v2.1 全局在线列表事件
    if (appJs.includes("socket.on('online-users'") &&
        appJs.includes("socket.on('user-online'") &&
        appJs.includes("socket.on('user-offline'")) {
      ok('v2.1: 全局在线列表事件监听存在 (online-users/user-online/user-offline)');
    } else {
      fail('v2.1: 在线列表事件', '未找到监听');
    }
    
    // index.html 缓存破坏版本号
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
    if (html.includes('app.js?v=17') && html.includes('style.css?v=13')) {
      ok('缓存破坏: index.html app.js?v=17 + style.css?v=13');
    } else {
      fail('缓存破坏', 'app.js?v=17 / style.css?v=13 未找到');
    }
    
    // M16/M22 移动端控制栏自动隐藏：断点与 CSS 横屏 1024px 对齐
    // (v2.13: 932→1024 覆盖 iPhone Pro Max 横屏 956px)
    if (appJs.includes('window.innerWidth > 1024')) {
      ok('M16/M22: 控制栏自动隐藏断点与 CSS 横屏 1024px 对齐');
    } else {
      fail('M16/M22: 自动隐藏断点', '未找到 1024px 断点');
    }
    
    // M16 横屏移动端跳过第二套全屏隐藏（避免双重控制冲突）
    if (appJs.includes('window.innerWidth <= 1024 && matchMedia') &&
        appJs.includes('initControlsAutoHide 单独管理')) {
      ok('M16: 横屏移动端由单套逻辑管理（无双重隐藏冲突）');
    } else {
      fail('M16: 双重隐藏冲突', '未找到横屏移动端跳过逻辑');
    }
    
    // v2.4 聊天记录按频道隔离
    if (appJs.includes('function clearChatMessages') &&
        appJs.includes('clearChatMessages()') &&
        appJs.includes("chatMessages.innerHTML = ''")) {
      ok('v2.4: 聊天记录按频道隔离 (clearChatMessages 存在并被调用)');
    } else {
      fail('v2.4: 聊天记录隔离', '未找到 clearChatMessages 清理逻辑');
    }
    
    // 在线用户列表模式切换：未进频道显示全局，进频道显示频道成员
    if (appJs.includes("titleEl.textContent = currentChannel ? '频道成员' : '在线用户'") &&
        appJs.includes('participants.has(userName)')) {
      ok('在线列表: 未进频道显示全局 / 进频道显示频道成员');
    } else {
      fail('在线列表模式切换', '未找到频道成员切换逻辑');
    }
    
    // v2.4 频道成员数据源：频道内用 participants 渲染 + 自动补自己
    if (appJs.includes('participants.forEach((data, name)') &&
        appJs.includes("!participants.has(userName)")) {
      ok('在线列表: 频道内用 participants 数据源 + 自动补自己');
    } else {
      fail('在线列表数据源', '未找到频道内 participants 渲染');
    }
    
    // v2.4 标题元素存在
    if (html.includes('id="onlineUsersTitle"')) {
      ok('在线列表: 标题元素 onlineUsersTitle 存在');
    } else {
      fail('在线列表标题', '未找到 onlineUsersTitle');
    }
    
  } catch (e) { fail('读取 app.js', e.message); }

  // 检查 style.css 是否包含关键样式
  try {
    const styleCss = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf-8');
    
    // 频道名隐藏样式
    if (styleCss.includes('.channel-header.header-hidden')) {
      ok('频道名隐藏样式 .header-hidden 存在');
    } else {
      fail('频道名隐藏样式', '未找到 .header-hidden');
    }
    
    // M17/M23 横屏控制栏布局：v2.15 悬浮胶囊（fixed + 居中 + 半透明常驻可点）
    if (styleCss.includes('BUGFIX: M17/M23 控制栏隐藏时保持胶囊位置可点') &&
        styleCss.includes('.main-controls.auto-hidden') &&
        styleCss.includes('border-radius: 30px')) {
      ok('M17/M23: 横屏控制栏悬浮胶囊 + 半透明常驻可点');
    } else {
      fail('M17/M23: 横屏控制栏布局', '未找到悬浮胶囊 / 半透明可点修复');
    }
    
    // 频道 header 过渡动画
    if (styleCss.includes('.channel-header') && styleCss.includes('transition') && 
        styleCss.includes('transform')) {
      ok('频道 header 过渡动画样式存在');
    } else {
      fail('频道 header 过渡动画', '未找到 transition/transform');
    }
    
    // header-hidden 高度归零
    if (styleCss.includes('.channel-header.header-hidden') && 
        styleCss.includes('height: 0')) {
      ok('header-hidden 高度归零样式存在');
    } else {
      fail('header-hidden 高度归零', '未找到 height: 0');
    }
    
    // 屏幕共享自适应样式
    if (styleCss.includes('.screen-share-wrapper') && styleCss.includes('flex: 1')) {
      ok('屏幕共享自适应样式存在');
    } else {
      fail('屏幕共享自适应样式', '未找到 flex: 1');
    }
    
    // 横屏布局样式
    if (styleCss.includes('orientation: landscape')) {
      ok('横屏布局媒体查询存在');
    } else {
      fail('横屏布局媒体查询', '未找到 orientation: landscape');
    }
    
    // 移动端成员列表样式
    if (styleCss.includes('.channel-participants') && styleCss.includes('flex-wrap: wrap')) {
      ok('移动端成员列表横向布局存在');
    } else {
      fail('移动端成员列表样式', '未找到 flex-wrap: wrap');
    }
    
    // resize handle 宽度
    if (styleCss.includes('.resize-handle-v') && styleCss.includes('width: 12px')) {
      ok('横屏 resize handle 宽度设置存在');
    } else {
      fail('横屏 resize handle 宽度', '未找到 width: 12px');
    }
    
  } catch (e) { fail('读取 style.css', e.message); }

  // 检查 index.html 是否包含关键元素
  try {
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
    
    // viewport-fit=cover
    if (indexHtml.includes('viewport-fit=cover')) {
      ok('viewport-fit=cover 设置存在');
    } else {
      fail('viewport-fit=cover', '未找到');
    }
    
    // channel-header 结构
    if (indexHtml.includes('class="channel-header"')) {
      ok('channel-header 元素存在');
    } else {
      fail('channel-header 元素', '未找到');
    }
    
    // screenShareContainer
    if (indexHtml.includes('id="screenShareContainer"')) {
      ok('screenShareContainer 元素存在');
    } else {
      fail('screenShareContainer 元素', '未找到');
    }
    
    // participantsContainer
    if (indexHtml.includes('id="participantsContainer"')) {
      ok('participantsContainer 元素存在');
    } else {
      fail('participantsContainer 元素', '未找到');
    }
    
  } catch (e) { fail('读取 index.html', e.message); }

  // ─────────────────────────────────────
  // M23 横屏按钮可用性（v2.15 排查"聊天/更多失效"）
  // 根因: auto-hidden 用 opacity:0 + 下沉 + pointer-events:none，
  //      移动端 touch 被拦截无法唤出 → 按钮"失效"。
  // 修复: auto-hidden 改为半透明常驻 + pointer-events:auto（按钮始终可点）。
  // ─────────────────────────────────────
  {
    const m23Css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf-8');
    const m23AppJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf-8');
    const m23Html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
    const m23IndexHtml = m23Html;
    
    // M23-1: 横屏 auto-hidden 不设 pointer-events:none（按钮保持可点）
    if (m23Css.match(/@media[^{]*max-width:\s*1024px[^{]*landscape[^{]*{[\s\S]*?\.main-controls\.auto-hidden\s*{[\s\S]*?pointer-events:\s*auto/)) {
      ok('M23-1: 横屏 auto-hidden 按钮 pointer-events:auto（可点，不失效）');
    } else {
      fail('M23-1: 横屏 auto-hidden 可点', '未找到 pointer-events:auto 规则');
    }
    
    // M23-2: 横屏 auto-hidden 不下沉出屏幕（transform 仅居中）
    if (m23Css.match(/@media[^{]*max-width:\s*1024px[^{]*landscape[^{]*{[\s\S]*?\.main-controls\.auto-hidden\s*{[\s\S]*?transform:\s*translateX\(-50%\)\s*;/)) {
      ok('M23-2: 横屏 auto-hidden 不下沉（transform 仅 translateX 居中）');
    } else {
      fail('M23-2: auto-hidden 不下沉', '未找到不下沉 transform');
    }
    
    // M23-3: 横屏 auto-hidden 半透明而非完全隐藏（opacity 0 < x < 1）
    if (m23Css.match(/@media[^{]*max-width:\s*1024px[^{]*landscape[^{]*{[\s\S]*?\.main-controls\.auto-hidden\s*{[\s\S]*?opacity:\s*0\.\d+/)) {
      ok('M23-3: 横屏 auto-hidden 半透明（0<opacity<1，降低干扰但可见）');
    } else {
      fail('M23-3: auto-hidden 半透明', '未找到半透明 opacity');
    }
    
    // M23-4: 音量滑块打开时不隐藏（active 加在 wrapper 上，选择器必须匹配）
    if (m23AppJs.includes("mainControls.querySelector('.control-btn-wrapper.active')")) {
      ok('M23-4: 音量滑块 active 检查用 .control-btn-wrapper.active（正确）');
    } else {
      fail('M23-4: 音量滑块检查', '选择器未匹配 wrapper.active');
    }
    
    // M23-5: 更多菜单 4 项 data-target 都指向真实存在的按钮 id
    const moreTargets = ['toggleDenoiseBtn', 'toggleCustomAudioBtn', 'toggleTtsBtn', 'toggleOrientationBtn'];
    const allTargetsExist = moreTargets.every(id => m23IndexHtml.includes(`id="${id}"`));
    if (m23IndexHtml.includes('class="more-menu"') && allTargetsExist) {
      ok('M23-5: 更多菜单 4 项 data-target 指向真实按钮');
    } else {
      fail('M23-5: 更多菜单目标', '菜单项目标 id 缺失');
    }
    
    // M23-6: 聊天按钮 mobileChatBtn 与更多按钮 moreMenuBtn 存在（横屏胶囊核心按钮）
    if (m23IndexHtml.includes('id="mobileChatBtn"') && m23IndexHtml.includes('id="moreMenuBtn"')) {
      ok('M23-6: 横屏核心按钮 mobileChatBtn/moreMenuBtn 存在');
    } else {
      fail('M23-6: 核心按钮', 'mobileChatBtn/moreMenuBtn 缺失');
    }
    
    // M23-7: 缓存版本号递增（v2.15: style.css v13 / app.js v17）
    if (m23Html.includes('app.js?v=17') && m23Html.includes('style.css?v=13')) {
      ok('M23-7: 缓存破坏 v2.15 (app.js?v=17 + style.css?v=13)');
    } else {
      fail('M23-7: 缓存版本', 'v17/v13 未找到');
    }
  }

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
