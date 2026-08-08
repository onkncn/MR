/**
 * Meeting Room WebRTC 端到端测试（双浏览器真实建连）
 *
 * 运行方式: npm run test:webrtc
 * 要求: 服务器必须在 localhost:6800 运行；系统装有 Chrome
 * 原理: 打开两个 headless 页面分别登录并加入同一频道，
 *       监听 app.js 的 onconnectionstatechange 日志，
 *       断言双方 RTCPeerConnection 状态都变为 connected。
 */

const puppeteer = require('puppeteer-core');

const URL = 'https://localhost:6800';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

let passed = 0, failed = 0, total = 0;
const failures = [];

function ok(name) { total++; passed++; console.log(`  ✅ ${name}`); }
function fail(name, reason) { total++; failed++; failures.push({ name, reason }); console.log(`  ❌ ${name}: ${reason}`); }
function section(title) { console.log(`\n${title}`); }

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

async function runTests() {
  console.log('\n🌐 Meeting Room WebRTC 双浏览器建连测试\n' + '='.repeat(50));

  section('🌐 启动浏览器');

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required'
      ],
      ignoreHTTPSErrors: true,
      timeout: 30000
    });
    ok('Chrome 启动成功');
  } catch (e) {
    fail('Chrome 启动', e.message);
    printResults();
    return;
  }

  const connected = { A: false, B: false };

  function attachConsole(label, page) {
    page.on('console', (msg) => {
      const text = msg.text();
      const m = text.match(/与 (.+?) 的连接状态: (\w+)/);
      if (m) {
        console.log(`  [${label}] ${text}`);
        if (m[2] === 'connected') connected[label] = true;
      }
    });
    page.on('pageerror', (err) => {
      console.log(`  [${label}] ⚠️ 页面错误: ${err.message}`);
    });
  }

  section('🔗 A 登录并创建频道');

  let pageA;
  try {
    pageA = await browser.newPage();
    attachConsole('A', pageA);
    await pageA.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 同一 browser 的页面共享 localStorage，清掉可能存在的自动登录缓存
    await pageA.evaluate(() => {
      localStorage.clear();
      const room = document.getElementById('room');
      if (room && !room.classList.contains('hidden')) logout();
    });
    await pageA.waitForSelector('#lobby:not(.hidden)', { timeout: 10000 });
    await pageA.evaluate(() => {
      document.getElementById('userName').value = 'WebRTCA';
      login();
    });
    await pageA.waitForSelector('#room:not(.hidden)', { timeout: 10000 });
    ok('A 登录成功');

    // 创建频道（createChannel 后服务端 channel-created 会触发自动加入）
    await pageA.evaluate(() => {
      document.getElementById('newChannelName').value = 'WebRTC建连测试';
      createChannel();
    });
    await pageA.waitForFunction(() => {
      const el = document.getElementById('currentChannelName');
      return el && el.textContent.includes('WebRTC建连测试');
    }, { timeout: 10000 });
    ok('A 创建频道并自动加入');
  } catch (e) {
    fail('A 流程', e.message);
  }

  section('🔗 B 登录并加入频道');

  let pageB;
  try {
    pageB = await browser.newPage();
    attachConsole('B', pageB);
    await pageB.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 同一 browser 的页面共享 localStorage，A 已登录会触发自动登录 → 先清缓存并退回 lobby
    await pageB.evaluate(() => {
      localStorage.clear();
      const room = document.getElementById('room');
      if (room && !room.classList.contains('hidden')) logout();
    });
    await pageB.waitForSelector('#lobby:not(.hidden)', { timeout: 10000 });
    await pageB.evaluate(() => {
      document.getElementById('userName').value = 'WebRTCB';
      login();
    });
    await pageB.waitForSelector('#room:not(.hidden)', { timeout: 10000 });
    ok('B 登录成功');

    // 等待频道出现在 B 的列表（channel-created 全局广播）
    await pageB.waitForFunction(() => {
      const items = document.querySelectorAll('.channel-item');
      return Array.from(items).some(el => el.textContent.includes('WebRTC建连测试'));
    }, { timeout: 15000 });
    // 点击频道项加入
    await pageB.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.channel-item'));
      const target = items.find(el => el.textContent.includes('WebRTC建连测试'));
      if (target) target.click();
    });
    await pageB.waitForFunction(() => {
      const el = document.getElementById('currentChannelName');
      return el && el.textContent.includes('WebRTC建连测试');
    }, { timeout: 10000 });
    ok('B 加入频道');
  } catch (e) {
    fail('B 流程', e.message);
  }

  section('🌐 等待双方 WebRTC connected');

  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (connected.A && connected.B) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (connected.A && connected.B) {
      ok('双方 WebRTC 连接建立: A connected + B connected');
    } else {
      fail('WebRTC 建连', `A=${connected.A ? 'connected' : '未连接'}, B=${connected.B ? 'connected' : '未连接'}`);
    }
  } catch (e) { fail('WebRTC 建连', e.message); }

  // 清理：A 删除测试频道（房主），避免遗留
  try {
    if (pageA) {
      await pageA.evaluate(() => {
        if (currentChannel) {
          socket.emit('delete-channel', currentChannel.id);
        }
      });
      await new Promise(r => setTimeout(r, 500));
      ok('测试频道已清理');
    }
  } catch (e) { fail('清理频道', e.message); }

  try { if (pageA) await pageA.close(); } catch (e) {}
  try { if (pageB) await pageB.close(); } catch (e) {}
  try { await browser.close(); } catch (e) {}
  printResults();
}

runTests();
