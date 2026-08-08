/**
 * Meeting Room Nuke 端点测试（独立运行，会清空服务器所有数据）
 *
 * 运行方式: npm run test:nuke
 * 要求: 服务器必须在 localhost:6800 运行
 * ⚠️ 会通知所有连接客户端返回首页，请勿在真实使用时段运行
 */

const { io } = require('socket.io-client');
const https = require('https');
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

function ok(name) { total++; passed++; console.log(`  ✅ ${name}`); }
function fail(name, reason) { total++; failed++; failures.push({ name, reason }); console.log(`  ❌ ${name}: ${reason}`); }
function section(title) { console.log(`\n${title}`); }

function postNuke(secret) {
  return new Promise((resolve) => {
    const req = https.request(URL + '/api/nuke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      rejectUnauthorized: false
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ status: 0, body: String(e) }));
    req.write(JSON.stringify({ secret }));
    req.end();
  });
}

function printResults() {
  console.log('\n' + '='.repeat(50));
  console.log(`📊 测试结果: ${passed} 通过, ${failed} 失败, 共 ${total} 项`);
  if (failures.length > 0) {
    console.log('\n失败详情:');
    failures.forEach(f => console.log(`  ${f.name}: ${f.reason}`));
    process.exit(1);
  } else {
    console.log('🎉 全部通过!');
    process.exit(0);
  }
}

// ─── 测试用例 ───

async function runTests() {
  console.log('\n🧨 Meeting Room Nuke 端点测试\n' + '='.repeat(50));

  section('🧨 1. 准备');

  let alice;
  try {
    alice = await connect('NukeAlice');
    alice.emit('login', 'NukeAlice');
    await waitFor(alice, 'channel-list');
    // 创建一个频道保证有数据
    const created = waitFor(alice, 'channel-created');
    alice.emit('create-channel', { name: 'Nuke测试频道', password: null });
    await created;
    ok('已创建测试频道，准备 nuke');
  } catch (e) {
    fail('准备', e.message);
    if (alice) alice.disconnect();
    printResults();
    return;
  }

  section('🧨 2. 错误密钥被拒绝');

  try {
    const r = await postNuke('wrong-secret');
    if (r.status === 403) ok('错误密钥被拒绝: HTTP 403');
    else fail('错误密钥', `status=${r.status}, body=${r.body}`);
  } catch (e) { fail('错误密钥', e.message); }

  section('🧨 3. 正确密钥清空 + nuked 广播');

  try {
    const nuked = waitFor(alice, 'nuked');
    const secret = require('../config.json').nukeSecret || 'mr-nuke-default';
    const r = await postNuke(secret);
    if (r.status === 200) ok('正确密钥: HTTP 200');
    else fail('正确密钥', `status=${r.status}, body=${r.body}`);
    const data = await nuked;
    if (data && data.reason) ok('客户端收到 nuked 广播');
    else fail('nuked 广播', JSON.stringify(data));
  } catch (e) { fail('nuke 主流程', e.message); }

  alice.disconnect();
  printResults();
}

runTests();
