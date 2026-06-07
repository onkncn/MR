/**
 * 前端自动隐藏 UI 测试用例
 * 
 * 测试场景：当侧边栏和聊天面板都收起时，1秒无触碰后自动隐藏顶部手柄和底部控制栏
 * 覆盖：桌面端、移动端竖屏、移动端横屏
 */

const puppeteer = require('puppeteer-core');

const URL = 'https://localhost:6789';
let browser;
let passed = 0, failed = 0;
const failures = [];

function ok(name) { passed++; console.log(`  ✅ ${name}`); }
function fail(name, reason) { failed++; failures.push({ name, reason }); console.log(`  ❌ ${name}: ${reason}`); }
function section(title) { console.log(`\n${title}`); }
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// 安全点击：先尝试 puppeteer.click，失败则用 evaluate
async function safeClick(page, selector) {
    try {
        await page.click(selector);
    } catch (e) {
        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.click();
        }, selector);
    }
}

async function loginAndJoin(page) {
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 10000 });
    await page.type('#userName', 'AutoHideTest');
    await safeClick(page, '#loginBtn');
    await page.waitForSelector('.room:not(.hidden)', { timeout: 5000 });
    await sleep(500);
    
    // 移动端侧边栏默认关闭，需要先打开
    const isMobile = await page.evaluate(() => window.innerWidth <= 768);
    if (isMobile) {
        await page.evaluate(() => document.getElementById('sidebarToggle').click());
        await sleep(500);
    }
    
    // 创建频道
    await safeClick(page, '#addChannelBtn');
    await sleep(500);
    await page.waitForSelector('#createModal:not(.hidden)', { timeout: 3000 });
    await page.type('#newChannelName', '自动隐藏测试');
    await safeClick(page, '#confirmCreateBtn');
    await sleep(1000);
    
    // 加入频道
    const channel = await page.$('.channel-item');
    if (channel) {
        try { await channel.click(); } catch (e) {
            await page.evaluate(() => { const c = document.querySelector('.channel-item'); if (c) c.click(); });
        }
        await sleep(500);
    }
    
    // 移动端：关闭侧边栏
    if (isMobile) {
        const sidebarOpen = await page.evaluate(() => 
            document.querySelector('.sidebar-left').classList.contains('open')
        );
        if (sidebarOpen) {
            await page.evaluate(() => document.getElementById('sidebarToggle').click());
            await sleep(300);
        }
    }
}

async function testAutoHide(page, label) {
    section(`🫥 ${label} - 自动隐藏测试`);

    // 5.1 检查初始状态
    try {
        const controlsOpacity = await page.$eval('.main-controls', el => getComputedStyle(el).opacity);
        if (controlsOpacity === '1') {
            ok(`${label} 初始状态：控制栏可见`);
        } else {
            fail(`${label} 初始状态`, `controls opacity: ${controlsOpacity}`);
        }
    } catch (e) { fail(`${label} 初始状态检查`, e.message); }

    // 5.2 收起侧边栏
    try {
        const isPortraitMobile = await page.evaluate(() => 
            window.innerWidth <= 768 && !matchMedia('(orientation: landscape)').matches
        );
        
        if (isPortraitMobile) {
            // 竖屏：确保侧边栏关闭
            const sidebarOpen = await page.evaluate(() => 
                document.querySelector('.sidebar-left').classList.contains('open')
            );
            if (sidebarOpen) {
                await page.evaluate(() => document.getElementById('sidebarToggle').click());
                await sleep(500);
            }
        } else {
            // 桌面/横屏：拖拽收起
            const sidebarHandle = await page.$('#sidebarResizeHandle');
            if (sidebarHandle) {
                const box = await sidebarHandle.boundingBox();
                if (box) {
                    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                    await page.mouse.down();
                    await page.mouse.move(0, box.y + box.height / 2, { steps: 10 });
                    await page.mouse.up();
                    await sleep(300);
                }
            }
        }
        
        const debugInfo = await page.evaluate(() => {
            const s = document.querySelector('.sidebar-left');
            const st = getComputedStyle(s);
            return { classes: s.className, width: s.offsetWidth, opacity: st.opacity, pe: st.pointerEvents };
        });
        console.log(`    [DEBUG] sidebar:`, JSON.stringify(debugInfo));
        
        const sidebarClosed = debugInfo.classes.includes('closed') 
            || debugInfo.width <= 1 
            || (debugInfo.opacity === '0' && debugInfo.pe === 'none');
        
        if (sidebarClosed) ok(`${label} 侧边栏收起成功`);
        else fail(`${label} 侧边栏收起`, JSON.stringify(debugInfo));
    } catch (e) { fail(`${label} 收起侧边栏`, e.message); }

    // 5.3 桌面/横屏：收起聊天面板
    try {
        const isPortraitMobile = await page.evaluate(() => 
            window.innerWidth <= 768 && !matchMedia('(orientation: landscape)').matches
        );
        
        if (!isPortraitMobile) {
            const viewportWidth = await page.evaluate(() => window.innerWidth);
            const chatHandle = await page.$('#chatResizeHandle');
            if (chatHandle) {
                const box = await chatHandle.boundingBox();
                if (box) {
                    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                    await page.mouse.down();
                    await page.mouse.move(viewportWidth, box.y + box.height / 2, { steps: 10 });
                    await page.mouse.up();
                    await sleep(300);
                }
            }
            const chatWidth = await page.$eval('#chatPanel', el => el.offsetWidth);
            console.log(`    [DEBUG] chatPanel width: ${chatWidth}`);
            if (chatWidth <= 1) ok(`${label} 聊天面板收起成功`);
            else fail(`${label} 聊天面板收起`, `width: ${chatWidth}`);
        } else {
            ok(`${label} 竖屏模式跳过聊天面板（固定底部）`);
        }
    } catch (e) { fail(`${label} 收起聊天面板`, e.message); }

    // 5.4 检查全屏模式
    try {
        const isFullScreen = await page.evaluate(() => {
            const sidebar = document.querySelector('.sidebar-left');
            const chatPanel = document.getElementById('chatPanel');
            if (!sidebar || !chatPanel) return false;
            const ss = getComputedStyle(sidebar);
            const sidebarClosed = sidebar.classList.contains('closed') 
                || sidebar.offsetWidth <= 1 
                || (ss.opacity === '0' && ss.pointerEvents === 'none');
            const isPM = window.innerWidth <= 768 && !matchMedia('(orientation: landscape)').matches;
            if (isPM) return false; // 竖屏不启用
            const cs = getComputedStyle(chatPanel);
            const chatHidden = chatPanel.classList.contains('hidden') 
                || chatPanel.offsetWidth <= 1 
                || (cs.opacity === '0' && cs.pointerEvents === 'none');
            return sidebarClosed && chatHidden;
        });
        
        const isPortraitMobile = await page.evaluate(() => 
            window.innerWidth <= 768 && !matchMedia('(orientation: landscape)').matches
        );
        
        if (isPortraitMobile) {
            if (!isFullScreen) ok(`${label} 竖屏不进入全屏模式（符合预期）`);
            else fail(`${label} 竖屏不应进入全屏模式`, '');
        } else {
            if (isFullScreen) ok(`${label} 全屏模式检测成功`);
            else fail(`${label} 全屏模式检测`, '未进入全屏模式');
        }
    } catch (e) { fail(`${label} 全屏模式检测`, e.message); }

    // 5.5 检查自动隐藏行为
    try {
        const isPortraitMobile = await page.evaluate(() => 
            window.innerWidth <= 768 && !matchMedia('(orientation: landscape)').matches
        );
        
        await page.mouse.move(200, 200);
        await sleep(100);
        await page.mouse.move(210, 210);
        await sleep(1500);
        const controlsOpacity = await page.$eval('.main-controls', el => parseFloat(getComputedStyle(el).opacity));
        console.log(`    [DEBUG] after 1.5s: controls=${controlsOpacity}`);
        
        if (isPortraitMobile) {
            // 竖屏不应隐藏
            if (controlsOpacity > 0.9) ok(`${label} 竖屏不自动隐藏（符合预期）`);
            else fail(`${label} 竖屏不应隐藏`, `controls opacity: ${controlsOpacity}`);
        } else {
            if (controlsOpacity < 0.1) ok(`${label} ✅ 自动隐藏成功（1秒后隐藏）`);
            else fail(`${label} 自动隐藏`, `controls opacity: ${controlsOpacity}`);
        }
    } catch (e) { fail(`${label} 自动隐藏检查`, e.message); }

    // 5.6 触碰后重新显示
    try {
        await page.evaluate(() => {
            document.querySelector('.main-content').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await sleep(300);
        const controlsOpacity = await page.$eval('.main-controls', el => parseFloat(getComputedStyle(el).opacity));
        if (controlsOpacity > 0.9) ok(`${label} 触碰后重新显示成功`);
        else fail(`${label} 触碰后重新显示`, `controls opacity: ${controlsOpacity}`);
    } catch (e) { fail(`${label} 触碰后重新显示`, e.message); }

    // 5.7 展开侧边栏后立即显示
    try {
        const isPortraitMobile = await page.evaluate(() => 
            window.innerWidth <= 768 && !matchMedia('(orientation: landscape)').matches
        );
        if (isPortraitMobile) {
            await page.evaluate(() => document.getElementById('sidebarToggle').click());
        } else {
            const sidebarHandle = await page.$('#sidebarResizeHandle');
            if (sidebarHandle) {
                const box = await sidebarHandle.boundingBox();
                if (box) {
                    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                    await page.mouse.down();
                    await page.mouse.move(220, box.y + box.height / 2, { steps: 10 });
                    await page.mouse.up();
                }
            }
        }
        await sleep(300);
        const controlsOpacity = await page.$eval('.main-controls', el => parseFloat(getComputedStyle(el).opacity));
        if (controlsOpacity > 0.9) ok(`${label} 展开侧边栏后立即显示成功`);
        else fail(`${label} 展开侧边栏后显示`, `controls opacity: ${controlsOpacity}`);
    } catch (e) { fail(`${label} 展开侧边栏后显示`, e.message); }
}

async function runTests() {
    console.log('\n🧪 前端自动隐藏 UI 测试\n' + '='.repeat(50));

    // ─── 1. 桌面端测试 ───
    section('🖥️  1. 桌面端测试 (1280x720)');
    try {
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--disable-gpu']
        });
        const p = await browser.newPage();
        await p.setViewport({ width: 1280, height: 720 });
        await loginAndJoin(p);
        await testAutoHide(p, '桌面端');
        await p.close();
    } catch (e) { fail('桌面端测试', e.message); }

    // ─── 2. 移动端竖屏测试 ───
    section('📱 2. 移动端竖屏测试 (375x667)');
    try {
        const p = await browser.newPage();
        await p.setViewport({ width: 375, height: 667, isMobile: true, hasTouch: true });
        await loginAndJoin(p);
        await testAutoHide(p, '竖屏');
        await p.close();
    } catch (e) { fail('竖屏测试', e.message); }

    // ─── 3. 移动端横屏测试 ───
    section('📱 3. 移动端横屏测试 (667x375)');
    try {
        const p = await browser.newPage();
        await p.setViewport({ width: 667, height: 375, isMobile: true, hasTouch: true });
        await loginAndJoin(p);
        await testAutoHide(p, '横屏');
        await p.close();
    } catch (e) { fail('横屏测试', e.message); }

    // ─── 清理测试频道 ───
    section('🧹 4. 清理测试频道');
    try {
        const cleaned = await new Promise((resolve) => {
            const sio = require('socket.io-client');
            const s = sio(URL, { rejectUnauthorized: false });
            s.on('connect', () => {
                // 用创建者用户名登录才能删除
                s.emit('login', 'AutoHideTest');
                s.on('channel-list', (list) => {
                    const testChannels = list.filter(c => c.name === '自动隐藏测试');
                    if (testChannels.length === 0) {
                        s.disconnect();
                        resolve(0);
                        return;
                    }
                    let removed = 0;
                    s.on('channel-removed', () => {
                        removed++;
                        if (removed >= testChannels.length) {
                            s.disconnect();
                            resolve(removed);
                        }
                    });
                    testChannels.forEach(c => s.emit('delete-channel', c.id));
                    setTimeout(() => { s.disconnect(); resolve(removed); }, 5000);
                });
            });
            setTimeout(() => { s.disconnect(); resolve(0); }, 10000);
        });
        
        if (cleaned > 0) ok(`清理了 ${cleaned} 个测试频道`);
        else ok('无需清理');
    } catch (e) {
        console.log('  ⚠️ 清理频道失败:', e.message);
    }

    await browser.close();

    console.log('\n' + '='.repeat(50));
    console.log(`📊 测试结果: ${passed} 通过, ${failed} 失败`);
    if (failures.length > 0) {
        console.log('\n❌ 失败用例:');
        failures.forEach(f => console.log(`   - ${f.name}: ${f.reason}`));
    }
    console.log('');
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
    console.error('测试运行错误:', e);
    if (browser) browser.close();
    process.exit(1);
});
