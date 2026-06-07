const socket = io();

let localStream;
let audioTrack;
let screenStream;
let userName;
let currentChannel = null;
let audioEnabled = false;
let denoiseEnabled = true;
let screenSharing = false;
let videoEnabled = true; // 扬声器状态

// Web Audio API — 麦克风音量增益 + 音频混合
let audioContext = null;
let micGainNode = null;
let micGainDest = null;
let audioMixDest = null;  // 最终混合输出（麦克风 + 屏幕音频）
const remoteAudioElements = new Set(); // 追踪远程音频元素

// ====== C4: 常量定义 ======
const DEBOUNCE_SAVE_MS = 1000;
const MAX_TEXT_MESSAGE_LENGTH = 5000;
const MAX_DATA_MESSAGE_LENGTH = 100000;
const MAX_DOM_MESSAGES = 200;
const CHAT_HISTORY_MAX = 500;

// ====== C1: TODO — 全局变量封装到 AppState ======
// 当前主要状态变量为全局作用域（~行3-50），后续可封装到 window.appState，
// 使用 getter/setter 保持向后兼容。风险较高，暂不实施。
// 涉及变量：localStream, audioTrack, screenStream, userName, currentChannel,
// audioEnabled, denoiseEnabled, screenSharing, videoEnabled, currentScreenSharer,
// participants, peerConnections, pendingCandidates, screenStreams, viewingScreenOf 等

// ====== localStorage 持久化 ======
function loadSavedState() {
    try {
        const saved = JSON.parse(localStorage.getItem('mr_state') || '{}');
        if (saved.username) {
            const input = document.getElementById('userName');
            if (input) input.value = saved.username;
        }
        if (typeof saved.audioEnabled === 'boolean') audioEnabled = saved.audioEnabled;
        if (typeof saved.videoEnabled === 'boolean') videoEnabled = saved.videoEnabled;
    } catch (e) {}
}

function saveState(key, value) {
    try {
        const saved = JSON.parse(localStorage.getItem('mr_state') || '{}');
        saved[key] = value;
        localStorage.setItem('mr_state', JSON.stringify(saved));
    } catch (e) {}
}

loadSavedState();
let currentScreenSharer = null;
let participants = new Map();
const peerConnections = new Map();
const pendingCandidates = new Map(); // BUGFIX: H3 ICE候选队列
const screenStreams = new Map(); // 存储每个用户的屏幕共享流
let viewingScreenOf = null; // 当前正在观看谁的屏幕
const channelList = [];

// 从服务端获取 ICE 配置
// BUGFIX: R1 初始化默认 ICE 服务器，防止 fetch 未完成时 PeerConnection 无 STUN/TURN
// W2: TURN 服务器占位 — 如需 NAT 穿透支持，部署 coturn 后在 config.json 的 iceServers 中添加：
//   { urls: 'turn:你的域名:3478', username: '用户名', credential: '密码' }
let configuration = {
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: 'all',
    sdpSemantics: 'unified-plan',
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

fetch('/api/config')
    .then(res => res.json())
    .then(cfg => {
        configuration.iceServers = cfg.iceServers;
        console.log('ICE 配置已加载:', cfg.iceServers.length, '个服务器');
    })
    .catch(err => {
        console.warn('加载 ICE 配置失败，使用默认 STUN:', err);
        configuration.iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ];
    });

const lobby = document.getElementById('lobby');
const room = document.getElementById('room');
const userNameInput = document.getElementById('userName');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const localAvatar = document.getElementById('localAvatar');
const localUserDisplay = document.getElementById('localUserDisplay');
const toggleAudioBtn = document.getElementById('toggleAudioBtn');
const toggleVideoBtn = document.getElementById('toggleVideoBtn');
const toggleScreenShareBtn = document.getElementById('toggleScreenShareBtn');
const toggleDenoiseBtn = document.getElementById('toggleDenoiseBtn');
const toggleChatExpandBtn = document.getElementById('toggleChatExpandBtn');
const placeholderCreateBtn = document.getElementById('placeholderCreateBtn');
const placeholderSelectBtn = document.getElementById('placeholderSelectBtn');
const addChannelBtn = document.getElementById('addChannelBtn');
const channelListEl = document.getElementById('channelList');
const currentChannelName = document.getElementById('currentChannelName');
const renameBtn = document.getElementById('renameBtn');
const channelPlaceholder = document.getElementById('channelPlaceholder');
const participantsContainer = document.getElementById('participantsContainer');
const screenShareContainer = document.getElementById('screenShareContainer');
const remoteScreenVideo = document.getElementById('remoteScreenVideo');
const screenSharingUser = document.getElementById('screenSharingUser');
const screenFullscreenBtn = document.getElementById('screenFullscreenBtn');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');

let sidebarOpen = false; // 必须在 initSidebar() 之前声明（let TDZ）

// BUGFIX: L4 初始化侧边栏状态
initSidebar();

const createModal = document.getElementById('createModal');
const closeCreateModal = document.getElementById('closeCreateModal');
const cancelCreateBtn = document.getElementById('cancelCreateBtn');
const confirmCreateBtn = document.getElementById('confirmCreateBtn');
const newChannelNameInput = document.getElementById('newChannelName');

const renameModal = document.getElementById('renameModal');
const closeRenameModal = document.getElementById('closeRenameModal');
const cancelRenameBtn = document.getElementById('cancelRenameBtn');
const confirmRenameBtn = document.getElementById('confirmRenameBtn');
const renameChannelInput = document.getElementById('renameChannelInput');

const chatPanel = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const chatFileBtn = document.getElementById('chatFileBtn');
const chatPreviewArea = document.getElementById('chatPreviewArea');
const chatCollapseBtn = document.getElementById('chatCollapseBtn');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const mobileAvatar = document.getElementById('mobileAvatar');
const mobileUserName = document.getElementById('mobileUserName');
const mobileLogoutBtn = document.getElementById('mobileLogoutBtn');
const micVolumeSlider = document.getElementById('micVolume');
const speakerVolumeSlider = document.getElementById('speakerVolume');
const channelContextMenu = document.getElementById('channelContextMenu');
const ctxRename = document.getElementById('ctxRename');
const ctxJoin = document.getElementById('ctxJoin');
const ctxDelete = document.getElementById('ctxDelete');

let micVolume = 1;
let speakerVolume = 1;
let imageIdCounter = 0; // BUGFIX: L7 自增计数器防碰撞
let pendingImages = [];
let chatMessagesList = [];
let contextMenuChannel = null;
let pendingJoinChannel = null; // BUGFIX: C2 存储待加入频道名
let createToken = null; // BUGFIX: B6 创建频道令牌，用于确认是自己创建的频道

// BUGFIX: B5 页面关闭时释放 AudioContext
window.addEventListener('beforeunload', () => {
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
    }
});

// BUGFIX: M9 移动端切换后台后恢复语音
// 移动浏览器（尤其 iOS Safari）在页面进入后台时会暂停 AudioContext 和降低 WebRTC 优先级
// 页面恢复可见时需要主动恢复
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (!currentChannel) return; // 未在频道中，无需处理

    console.log('[M9] 页面恢复可见，检查音频和连接状态');

    // 1. 恢复 AudioContext（iOS Safari 后台会暂停）
    if (audioContext && audioContext.state === 'suspended') {
        try {
            await audioContext.resume();
            console.log('[M9] AudioContext 已恢复');
        } catch (e) {
            console.warn('[M9] AudioContext 恢复失败:', e.message || e);
        }
    }

    // 2. 检查本地音轨状态
    if (audioEnabled && audioTrack) {
        if (audioTrack.readyState === 'ended') {
            console.warn('[M9] 本地麦克风音轨已结束，尝试重新获取');
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const newTrack = stream.getAudioTracks()[0];
                // 替换所有 PeerConnection 中的音轨
                peerConnections.forEach((pc) => {
                    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (sender) {
                        sender.replaceTrack(newTrack).catch(e =>
                            console.warn('[M9] replaceTrack 失败:', e.message || e));
                    }
                });
                audioTrack = newTrack;
                if (localStream) {
                    const oldTracks = localStream.getAudioTracks();
                    oldTracks.forEach(t => localStream.removeTrack(t));
                    localStream.addTrack(newTrack);
                }
                console.log('[M9] 麦克风音轨已重新获取');
            } catch (e) {
                console.error('[M9] 重新获取麦克风失败:', e.message || e);
            }
        }
    }

    // 3. 检查 PeerConnection 状态，尝试 ICE 重启
    peerConnections.forEach((pc, peerId) => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            console.log(`[M9] ${peerId} 连接状态: ${pc.connectionState}，尝试 ICE 重启`);
            if (pc.connectionState === 'failed') {
                // failed 状态需要完全重建连接
                pc.close();
                peerConnections.delete(peerId);
                participants.delete(peerId);
                // 创建新的 PeerConnection 并发送 offer
                console.log(`[M9] 重建与 ${peerId} 的连接`);
                const newPc = createPeerConnection(peerId);
                createOfferAndSend(newPc, peerId).catch(e =>
                    console.warn('[M9] 重建连接 offer 失败:', e.message || e));
            } else {
                // disconnected 状态尝试 ICE 重启
                pc.restartIce();
                createOfferAndSend(pc, peerId).catch(e =>
                    console.warn('[M9] ICE 重启 offer 失败:', e.message || e));
            }
        }
    });

    // 4. 检查 Socket.io 连接
    if (!socket.connected) {
        console.log('[M9] Socket.io 已断开，等待自动重连');
        socket.connect();
    }

    // 5. 恢复远程音频播放（iOS Safari 后台会暂停）
    remoteAudioElements.forEach(audio => {
        if (audio.paused && !audio.muted) {
            audio.play().catch(e =>
                console.warn('[M9] 远程音频播放恢复失败:', e.message || e));
        }
    });
});

// 恢复保存的按钮状态
if (typeof updateVideoButton === 'function') updateVideoButton();

// 有缓存用户名时自动登录
if (userNameInput && userNameInput.value.trim()) {
    login();
}

// 初始化侧边栏状态
// ====== C2: iOS 检测提取函数 ======
function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroid() {
    return /Android/i.test(navigator.userAgent);
}

function isMobileDevice() {
    return isIOS() || isAndroid();
}

function initSidebar() {
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
        sidebarOpen = false;
        sidebar.classList.add('closed');
        sidebar.classList.remove('open');
    } else {
        sidebarOpen = true;
        sidebar.classList.remove('closed');
        sidebar.classList.add('open');
    }
}

// 窗口大小改变时更新侧边栏状态
window.addEventListener('resize', () => {
    if (!room.classList.contains('hidden')) {
        const isMobile = window.innerWidth <= 768;
        const isLandscape = window.matchMedia('(orientation: landscape)').matches && isMobile;
        
        if (!isMobile) {
            // 桌面端：始终显示侧边栏和聊天面板
            sidebarOpen = true;
            sidebar.classList.remove('closed');
            sidebar.classList.add('open');
            sidebarOverlay.classList.remove('active');
            chatPanelOpen = true;
            const chatPanel = document.getElementById('chatPanel');
            if (chatPanel) chatPanel.classList.remove('hidden');
        } else if (!isLandscape && sidebarOpen) {
            // 竖屏移动端：关闭侧边栏（横屏切竖屏时）
            sidebarOpen = false;
            sidebar.classList.add('closed');
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('active');
            // 清除横屏拖拽设置的内联样式，让移动端CSS生效
            sidebar.style.width = '';
            sidebar.style.minWidth = '';
            sidebar.style.opacity = '';
            sidebar.style.overflow = '';
            // 竖屏时聊天面板由移动端样式控制，重置状态
            chatPanelOpen = true;
            const chatPanel = document.getElementById('chatPanel');
            if (chatPanel) {
                chatPanel.classList.remove('hidden');
                // 清除横屏拖拽设置的内联样式，让移动端CSS生效
                chatPanel.style.width = '';
                chatPanel.style.minWidth = '';
                chatPanel.style.opacity = '';
                chatPanel.style.overflow = '';
            }
        }
    }
});

// ====== 横屏上滑隐藏频道名 ======
// 移动端横屏时，在中间屏幕区域上滑隐藏频道 header，下滑恢复
(function initHeaderSwipeToggle() {
    const mainContent = document.querySelector('.main-content');
    const channelHeader = document.querySelector('.channel-header');
    console.log('[HeaderSwipe] 初始化:', { mainContent: !!mainContent, channelHeader: !!channelHeader });
    if (!mainContent || !channelHeader) return;

    let startY = 0;
    let startTarget = null;
    const SWIPE_THRESHOLD = 30; // 最小滑动距离

    mainContent.addEventListener('touchstart', (e) => {
        // 仅在横屏移动端生效
        const isLandscape = window.matchMedia('(orientation: landscape)').matches;
        const isMobile = window.innerWidth <= 932;
        if (!isLandscape || !isMobile) return;

        // 忽略控制栏和侧边栏区域的触摸
        const target = e.target;
        if (target.closest('.main-controls') || target.closest('.sidebar-left')) return;

        startY = e.touches[0].clientY;
        startTarget = target;
        console.log('[HeaderSwipe] touchstart:', { startY, target: target.className });
    }, { passive: true });

    mainContent.addEventListener('touchend', (e) => {
        if (startY === 0) return;

        const isLandscape = window.matchMedia('(orientation: landscape)').matches;
        const isMobile = window.innerWidth <= 932;
        if (!isLandscape || !isMobile) {
            startY = 0;
            return;
        }

        const endY = e.changedTouches[0].clientY;
        const deltaY = endY - startY;
        console.log('[HeaderSwipe] touchend:', { startY, endY, deltaY, threshold: SWIPE_THRESHOLD });

        if (Math.abs(deltaY) >= SWIPE_THRESHOLD) {
            if (deltaY < 0) {
                // 上滑 → 隐藏频道 header
                channelHeader.classList.add('header-hidden');
                console.log('[HeaderSwipe] 上滑隐藏频道 header');
            } else {
                // 下滑 → 显示频道 header
                channelHeader.classList.remove('header-hidden');
                console.log('[HeaderSwipe] 下滑显示频道 header');
            }
        }

        startY = 0;
        startTarget = null;
    }, { passive: true });
})();

loginBtn.addEventListener('click', login);
logoutBtn.addEventListener('click', logout);
mobileLogoutBtn.addEventListener('click', logout);
sidebarOverlay.addEventListener('click', closeSidebar);
toggleAudioBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAudio();
});
toggleVideoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleVideo();
});
toggleScreenShareBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleScreenShare();
});
toggleDenoiseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDenoise();
});
toggleChatExpandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    room.classList.add('chat-only');
    toggleChatExpandBtn.classList.add('active');
});
chatCollapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    room.classList.remove('chat-only');
    toggleChatExpandBtn.classList.remove('active');
});
addChannelBtn.addEventListener('click', () => openModal(createModal));
placeholderCreateBtn.addEventListener('click', () => openModal(createModal));
placeholderSelectBtn.addEventListener('click', () => {
    sidebarOpen = true;
    sidebar.classList.add('open');
    sidebar.classList.remove('closed');
    sidebarOverlay.classList.add('active');
});

// ====== 自定义音量滑块 ======
function setupVolumeSlider(rangeInput, onUpdate) {
    if (!rangeInput) return;
    const wrapper = rangeInput.closest('.volume-slider-wrapper');
    if (!wrapper) return;
    const track = wrapper.querySelector('.volume-slider-track');
    const fill = wrapper.querySelector('.volume-slider-fill');
    const thumb = wrapper.querySelector('.volume-slider-thumb');
    const label = wrapper.closest('.volume-control')?.querySelector('.volume-label');
    if (!track || !fill || !thumb) return;

    const MIN = parseInt(rangeInput.min) || 0;
    const MAX = parseInt(rangeInput.max) || 300;

    function updateVisual(val) {
        const pct = (val - MIN) / (MAX - MIN);
        fill.style.height = (pct * 100) + '%';
        thumb.style.bottom = (pct * 100) + '%';
        if (label) label.textContent = val + '%';
        rangeInput.value = val;
    }

    function calcValue(clientY) {
        const rect = track.getBoundingClientRect();
        // track 有 14px 的上下内缩，需要计算实际可拖动区域
        const trackTop = rect.top;
        const trackHeight = rect.height;
        let ratio = (clientY - trackTop) / trackHeight;
        ratio = 1 - ratio; // 翻转：上方 = 高值
        ratio = Math.max(0, Math.min(1, ratio));
        return Math.round(ratio * (MAX - MIN) + MIN);
    }

    let dragging = false;

    function onStart(e) {
        e.preventDefault();
        dragging = true;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const val = calcValue(clientY);
        updateVisual(val);
        onUpdate(val);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    }

    function onMove(e) {
        if (!dragging) return;
        e.preventDefault();
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const val = calcValue(clientY);
        updateVisual(val);
        onUpdate(val);
    }

    function onEnd() {
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
    }

    // 隐藏的 range input 也需要响应（键盘无障碍）
    rangeInput.addEventListener('input', () => {
        const val = parseInt(rangeInput.value);
        updateVisual(val);
        onUpdate(val);
    });

    // 鼠标/触摸事件绑定到 wrapper（覆盖整个可交互区域）
    wrapper.addEventListener('mousedown', onStart);
    wrapper.addEventListener('touchstart', onStart, { passive: false });

    // 初始化显示
    updateVisual(parseInt(rangeInput.value));
}

// 麦克风音量
setupVolumeSlider(micVolumeSlider, (val) => {
    micVolume = val / 100;
    if (micGainNode) {
        micGainNode.gain.value = micVolume;
    }
    // 0 时静音原始音轨（完全关闭麦克风）
    if (audioTrack) {
        audioTrack.enabled = micVolume > 0;
    }
});

// 扬声器音量
setupVolumeSlider(speakerVolumeSlider, (val) => {
    speakerVolume = val / 100;
    // BUGFIX: H1 远程音频是audio元素，需同时控制video和audio
    document.querySelectorAll('video, audio').forEach(el => {
        el.volume = Math.min(speakerVolume, 1);
    });
});
// ====== 自定义音量滑块 end ======

const micControlWrapper = document.querySelector('#micControlWrapper') || document.querySelector('.control-btn-wrapper');
const speakerControlWrapper = document.querySelector('#speakerControlWrapper');

if (micControlWrapper && !micControlWrapper.id) {
    micControlWrapper.id = 'micControlWrapper';
}
if (speakerControlWrapper && !speakerControlWrapper.id) {
    speakerControlWrapper.id = 'speakerControlWrapper';
}

document.querySelectorAll('.control-btn-wrapper').forEach(wrapper => {
    if (!wrapper.id) return;
    
    let hideTimer = null;
    
    function showSlider() {
        clearTimeout(hideTimer);
        wrapper.classList.add('active');
        document.querySelectorAll('.control-btn-wrapper').forEach(w => {
            if (w !== wrapper) w.classList.remove('active');
        });
    }
    
    function hideSlider() {
        hideTimer = setTimeout(() => {
            wrapper.classList.remove('active');
        }, 300);
    }
    
    // 仅桌面端启用 hover 显示音量条，移动端不需要
    if (!('ontouchstart' in window)) {
        wrapper.addEventListener('mouseenter', showSlider);
        wrapper.addEventListener('mouseleave', hideSlider);
    }
    
    wrapper.addEventListener('click', (e) => {
        if (e.target.closest('.volume-control')) {
            e.stopPropagation();
            return;
        }
        if (e.target.closest('.control-btn')) {
            return;
        }
    });
    
    wrapper.querySelector('.volume-control')?.addEventListener('click', (e) => {
        e.stopPropagation();
    });
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('.control-btn-wrapper')) {
        document.querySelectorAll('.control-btn-wrapper').forEach(w => w.classList.remove('active'));
    }
});
sidebarToggle.addEventListener('click', toggleSidebar);

screenFullscreenBtn.addEventListener('click', toggleScreenFullscreen);

// 缩小/恢复屏幕共享浮窗（独立元素挂在body，兼容iOS）
const screenMinimizeBtn = document.getElementById('screenMinimizeBtn');
let minimizedThumb = null;

function minimizeScreenShare() {
    screenShareContainer.classList.add('hidden');
    
    minimizedThumb = document.createElement('div');
    minimizedThumb.className = 'screen-minimized-thumb';
    minimizedThumb.innerHTML = '<video autoplay playsinline muted></video><div class="minimized-indicator"></div>';
    document.body.appendChild(minimizedThumb);
    
    const thumbVideo = minimizedThumb.querySelector('video');
    thumbVideo.srcObject = remoteScreenVideo.srcObject;
    
    minimizedThumb.addEventListener('click', restoreScreenShare);
}

function restoreScreenShare() {
    if (minimizedThumb) {
        minimizedThumb.querySelector('video').srcObject = null;
        minimizedThumb.remove();
        minimizedThumb = null;
    }
    screenShareContainer.classList.remove('hidden');
    if (remoteScreenVideo.paused && remoteScreenVideo.srcObject) {
        remoteScreenVideo.play().catch(e => console.warn('[Media] play:', e.message || e));
        if (typeof showPlayOverlay === 'function') showPlayOverlay();
    }
}

if (screenMinimizeBtn) {
    screenMinimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        minimizeScreenShare();
    });
}

// 移动端共享屏幕播放控制
const screenPlayOverlay = document.getElementById('screenPlayOverlay');
const screenShareVideoEl = document.getElementById('screenShareVideo');
let screenPlayTimer = null;

function showPlayOverlay() {
    if (!screenPlayOverlay) return;
    screenPlayOverlay.classList.add('visible');
    clearTimeout(screenPlayTimer);
}

function hidePlayOverlay() {
    if (!screenPlayOverlay) return;
    clearTimeout(screenPlayTimer);
    screenPlayOverlay.classList.remove('visible');
}

function showPlayOverlayTemporary() {
    showPlayOverlay();
    screenPlayTimer = setTimeout(hidePlayOverlay, 1000);
}

// 点击播放按钮 → 播放视频并隐藏
if (screenPlayOverlay) {
    screenPlayOverlay.addEventListener('click', () => {
        remoteScreenVideo.play().then(() => {
            hidePlayOverlay();
        }).catch(() => {});
    });
}

// 点击视频区域 → 显示播放按钮（临时）
const channelHeader = document.querySelector('.channel-header');
let headerHidden = false;

if (screenShareVideoEl) {
    screenShareVideoEl.addEventListener('click', (e) => {
        if (e.target.closest('.screen-fullscreen-btn')) return;
        if (e.target.closest('.screen-play-overlay')) return;
        
        // 移动端：点击切换频道名显示/隐藏
        const isMobile = window.innerWidth <= 768;
        if (isMobile && channelHeader) {
            headerHidden = !headerHidden;
            if (headerHidden) {
                channelHeader.classList.add('header-hidden');
            } else {
                channelHeader.classList.remove('header-hidden');
            }
        }
        
        if (remoteScreenVideo.paused) {
            showPlayOverlay();
        } else {
            showPlayOverlayTemporary();
        }
    });
}

// 视频暂停时显示播放按钮，播放时隐藏
if (remoteScreenVideo) {
    remoteScreenVideo.addEventListener('pause', () => {
        if (remoteScreenVideo.srcObject) showPlayOverlay();
    });
    remoteScreenVideo.addEventListener('play', hidePlayOverlay);
}

// 退出全屏后恢复播放（带延迟重试，兼容移动端浏览器）
function onFullscreenExit() {
    if (remoteScreenVideo.srcObject) {
        // 延迟一下等浏览器完成全屏退出
        setTimeout(() => {
            remoteScreenVideo.play().catch(() => {
                // 如果失败再试一次
                setTimeout(() => remoteScreenVideo.play().catch(() => {}), 200);
            });
        }, 100);
    }
}
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) onFullscreenExit();
});
document.addEventListener('webkitfullscreenchange', () => {
    if (!document.webkitFullscreenElement) onFullscreenExit();
});

closeCreateModal.addEventListener('click', () => closeModal(createModal));
cancelCreateBtn.addEventListener('click', () => closeModal(createModal));
confirmCreateBtn.addEventListener('click', createChannel);

closeRenameModal.addEventListener('click', () => closeModal(renameModal));
cancelRenameBtn.addEventListener('click', () => closeModal(renameModal));

renameBtn.addEventListener('click', () => {
    if (currentChannel) {
        renameChannelInput.value = currentChannel.name;
        renameModal._targetChannel = null; // null 表示重命名当前频道
        openModal(renameModal);
    }
});

chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        sendChatMessage();
    }
});
chatInput.addEventListener('paste', handleChatPaste);

// iOS 兼容的文件选择：动态创建 input 元素
function createFileInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.style.display = 'none';
    input.addEventListener('change', handleChatFile);
    return input;
}

let currentFileInput = null;

chatFileBtn.addEventListener('click', () => {
    if (!currentChannel) {
        alert('请先加入频道');
        return;
    }
    
    // 每次点击创建新的 input，确保 iOS 兼容
    if (currentFileInput) {
        currentFileInput.remove();
    }
    currentFileInput = createFileInput();
    document.body.appendChild(currentFileInput);
    currentFileInput.click();
});

function initResizeHandles() {
    const sidebarHandle = document.getElementById('sidebarResizeHandle');
    const chatHandle = document.getElementById('chatResizeHandle');
    let isResizing = false;
    let currentHandle = null;
    let startX = 0;
    let startWidth = 0;
    
    // 隐藏阈值：拖到这个宽度以下就隐藏面板
    const HIDE_THRESHOLD = 80;
    // 边缘滑动检测区域宽度
    const EDGE_SWIPE_ZONE = 20;
    
    const startResize = (handle, e) => {
        isResizing = true;
        currentHandle = handle;
        startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
        
        if (handle === sidebarHandle) {
            startWidth = sidebar.offsetWidth;
        } else if (handle === chatHandle) {
            startWidth = chatPanel.offsetWidth;
        }
        
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    };
    
    const stopResize = () => {
        if (!isResizing) return;
        
        // 检查是否需要隐藏面板
        if (currentHandle === sidebarHandle && sidebar.offsetWidth < HIDE_THRESHOLD) {
            sidebar.style.width = '0px';
            sidebar.style.minWidth = '0px';
            sidebar.style.opacity = '0';
            sidebar.style.overflow = 'hidden';
        } else if (currentHandle === chatHandle && chatPanel.offsetWidth < HIDE_THRESHOLD) {
            chatPanel.style.width = '0px';
            chatPanel.style.minWidth = '0px';
            chatPanel.style.opacity = '0';
            chatPanel.style.overflow = 'hidden';
        }
        
        isResizing = false;
        currentHandle = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    };
    
    const doResize = (e) => {
        if (!isResizing || !currentHandle) return;
        
        const clientX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
        
        if (currentHandle === sidebarHandle) {
            const newWidth = clientX;
            if (newWidth >= 0 && newWidth <= 400) {
                sidebar.style.width = newWidth + 'px';
                sidebar.style.minWidth = newWidth > 0 ? newWidth + 'px' : '0px';
                sidebar.style.opacity = newWidth > 0 ? '1' : '0';
                sidebar.style.overflow = newWidth > 0 ? 'visible' : 'hidden';
            }
        } else if (currentHandle === chatHandle) {
            const newWidth = window.innerWidth - clientX;
            if (newWidth >= 0 && newWidth <= 500) {
                chatPanel.style.width = newWidth + 'px';
                chatPanel.style.minWidth = newWidth > 0 ? newWidth + 'px' : '0px';
                chatPanel.style.opacity = newWidth > 0 ? '1' : '0';
                chatPanel.style.overflow = newWidth > 0 ? 'visible' : 'hidden';
            }
        }
    };
    
    // 鼠标事件
    if (sidebarHandle) {
        sidebarHandle.addEventListener('mousedown', (e) => startResize(sidebarHandle, e));
    }
    if (chatHandle) {
        chatHandle.addEventListener('mousedown', (e) => startResize(chatHandle, e));
    }
    document.addEventListener('mousemove', doResize);
    document.addEventListener('mouseup', stopResize);
    
    // 触摸事件（移动端）
    if (sidebarHandle) {
        sidebarHandle.addEventListener('touchstart', (e) => startResize(sidebarHandle, e), { passive: false });
    }
    if (chatHandle) {
        chatHandle.addEventListener('touchstart', (e) => startResize(chatHandle, e), { passive: false });
    }
    document.addEventListener('touchmove', doResize, { passive: false });
    document.addEventListener('touchend', stopResize);
    
    // 边缘滑动拉出面板
    let edgeSwipeStartX = 0;
    let edgeSwipeActive = false;
    let edgeSwipeSide = null; // 'left' or 'right'
    
    document.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        const isLandscape = window.matchMedia('(orientation: landscape)').matches;
        
        if (!isLandscape) return;
        
        // 左边缘检测：侧边栏隐藏时
        if (touch.clientX < EDGE_SWIPE_ZONE && sidebar.offsetWidth === 0) {
            edgeSwipeStartX = touch.clientX;
            edgeSwipeActive = true;
            edgeSwipeSide = 'left';
        }
        // 右边缘检测：聊天面板隐藏时
        else if (touch.clientX > window.innerWidth - EDGE_SWIPE_ZONE && chatPanel.offsetWidth === 0) {
            edgeSwipeStartX = touch.clientX;
            edgeSwipeActive = true;
            edgeSwipeSide = 'right';
        }
    }, { passive: true });
    
    document.addEventListener('touchmove', (e) => {
        if (!edgeSwipeActive) return;
        
        const touch = e.touches[0];
        const deltaX = touch.clientX - edgeSwipeStartX;
        
        if (edgeSwipeSide === 'left' && deltaX > 0) {
            // 从左边缘向右滑动：拉出侧边栏
            const newWidth = Math.min(deltaX, 400);
            sidebar.style.width = newWidth + 'px';
            sidebar.style.minWidth = newWidth + 'px';
            sidebar.style.opacity = '1';
            sidebar.style.overflow = 'visible';
            e.preventDefault();
        } else if (edgeSwipeSide === 'right' && deltaX < 0) {
            // 从右边缘向左滑动：拉出聊天面板
            const newWidth = Math.min(-deltaX, 500);
            chatPanel.style.width = newWidth + 'px';
            chatPanel.style.minWidth = newWidth + 'px';
            chatPanel.style.opacity = '1';
            chatPanel.style.overflow = 'visible';
            e.preventDefault();
        }
    }, { passive: false });
    
    document.addEventListener('touchend', () => {
        edgeSwipeActive = false;
        edgeSwipeSide = null;
    });
}

initResizeHandles();

// ====== 频道名拖拽隐藏 ======
// 拖拽频道名下方的 handle 向上可隐藏频道名，向下可显示
(function initHeaderDragHandle() {
    const handle = document.getElementById('headerDragHandle');
    const header = document.getElementById('channelHeader');
    if (!handle || !header) return;
    
    let startY = 0;
    let headerHeight = 0;
    let isDragging = false;
    const DRAG_THRESHOLD = 30; // 最小拖拽距离
    
    handle.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
        headerHeight = header.offsetHeight;
        isDragging = true;
        header.style.transition = 'none'; // 拖拽时禁用动画
    }, { passive: true });
    
    handle.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const currentY = e.touches[0].clientY;
        const deltaY = currentY - startY;
        
        // 向上拖拽：缩小 header，向下拖拽：恢复 header
        const newHeight = Math.max(0, Math.min(headerHeight, headerHeight + deltaY));
        header.style.height = newHeight + 'px';
        header.style.overflow = 'hidden';
        header.style.opacity = (newHeight / headerHeight).toString();
        e.preventDefault();
    }, { passive: false });
    
    handle.addEventListener('touchend', (e) => {
        if (!isDragging) return;
        isDragging = false;
        header.style.transition = ''; // 恢复动画
        
        const endY = e.changedTouches[0].clientY;
        const deltaY = endY - startY;
        
        if (deltaY < -DRAG_THRESHOLD) {
            // 上滑超过阈值 → 隐藏
            header.classList.add('header-hidden');
        } else {
            // 下滑或未超过阈值 → 恢复
            header.classList.remove('header-hidden');
            header.style.height = '';
            header.style.opacity = '';
        }
    }, { passive: true });
    
    // 双击 handle 切换显示/隐藏
    handle.addEventListener('dblclick', () => {
        header.classList.toggle('header-hidden');
    });
})();

// 面板直接滑动缩放（在侧边栏/聊天面板上滑动）
function initPanelSwipeResize() {
    const isLandscape = () => window.matchMedia('(orientation: landscape)').matches;
    
    let swipeActive = false;
    let swipeTarget = null; // 'sidebar' or 'chat'
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let directionLocked = false;
    let isHorizontal = false;
    const DIRECTION_THRESHOLD = 10; // 滑动多少像素后判断方向
    
    // 侧边栏左滑缩小
    sidebar.addEventListener('touchstart', (e) => {
        if (!isLandscape()) return;
        if (sidebar.offsetWidth === 0) return;
        
        swipeActive = true;
        swipeTarget = 'sidebar';
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startWidth = sidebar.offsetWidth;
        directionLocked = false;
        isHorizontal = false;
    }, { passive: true });
    
    // 聊天面板右滑缩小
    chatPanel.addEventListener('touchstart', (e) => {
        if (!isLandscape()) return;
        if (chatPanel.offsetWidth === 0) return;
        
        swipeActive = true;
        swipeTarget = 'chat';
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startWidth = chatPanel.offsetWidth;
        directionLocked = false;
        isHorizontal = false;
    }, { passive: true });
    
    document.addEventListener('touchmove', (e) => {
        if (!swipeActive || !swipeTarget) return;
        
        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        const deltaX = currentX - startX;
        const deltaY = currentY - startY;
        
        // 方向锁定：滑动超过阈值后判断方向
        if (!directionLocked) {
            if (Math.abs(deltaX) > DIRECTION_THRESHOLD || Math.abs(deltaY) > DIRECTION_THRESHOLD) {
                directionLocked = true;
                isHorizontal = Math.abs(deltaX) > Math.abs(deltaY);
            }
            return; // 等待方向确定
        }
        
        // 如果是垂直滑动，不处理（让浏览器处理滚动）
        if (!isHorizontal) return;
        
        if (swipeTarget === 'sidebar') {
            // 侧边栏：左滑缩小（deltaX < 0）
            const newWidth = Math.max(0, startWidth + deltaX);
            if (newWidth <= 400) {
                sidebar.style.width = newWidth + 'px';
                sidebar.style.minWidth = newWidth > 0 ? newWidth + 'px' : '0px';
                sidebar.style.opacity = newWidth > 0 ? '1' : '0';
                sidebar.style.overflow = newWidth > 0 ? 'visible' : 'hidden';
                e.preventDefault();
            }
        } else if (swipeTarget === 'chat') {
            // 聊天面板：右滑缩小（deltaX > 0）
            const newWidth = Math.max(0, startWidth - deltaX);
            if (newWidth <= 500) {
                chatPanel.style.width = newWidth + 'px';
                chatPanel.style.minWidth = newWidth > 0 ? newWidth + 'px' : '0px';
                chatPanel.style.opacity = newWidth > 0 ? '1' : '0';
                chatPanel.style.overflow = newWidth > 0 ? 'visible' : 'hidden';
                e.preventDefault();
            }
        }
    }, { passive: false });
    
    document.addEventListener('touchend', () => {
        if (!swipeActive) return;
        
        // 只有水平滑动时才检查是否需要完全隐藏
        if (isHorizontal) {
            if (swipeTarget === 'sidebar' && sidebar.offsetWidth < 80) {
                sidebar.style.width = '0px';
                sidebar.style.minWidth = '0px';
                sidebar.style.opacity = '0';
                sidebar.style.overflow = 'hidden';
            } else if (swipeTarget === 'chat' && chatPanel.offsetWidth < 80) {
                chatPanel.style.width = '0px';
                chatPanel.style.minWidth = '0px';
                chatPanel.style.opacity = '0';
                chatPanel.style.overflow = 'hidden';
            }
        }
        
        swipeActive = false;
        swipeTarget = null;
        directionLocked = false;
        isHorizontal = false;
    });
}

initPanelSwipeResize();

function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    const isMobile = window.innerWidth <= 768;
    
    if (isMobile) {
        if (sidebarOpen) {
            sidebar.classList.add('open');
            sidebar.classList.remove('closed');
            sidebarOverlay.classList.add('active');
        } else {
            sidebar.classList.remove('open');
            sidebar.classList.add('closed');
            sidebarOverlay.classList.remove('active');
        }
    } else {
        if (sidebarOpen) {
            sidebar.classList.remove('closed');
            sidebar.classList.add('open');
        } else {
            sidebar.classList.remove('open');
            sidebar.classList.add('closed');
        }
    }
}

function closeSidebar() {
    const isMobile = window.innerWidth <= 768;
    if (isMobile && sidebarOpen) {
        sidebarOpen = false;
        sidebar.classList.remove('open');
        sidebar.classList.add('closed');
        sidebarOverlay.classList.remove('active');
    }
}

function openModal(modal) {
    modal.classList.remove('hidden');
    const input = modal.querySelector('input');
    if (input) {
        setTimeout(() => input.focus(), 100);
    }
}

function closeModal(modal) {
    modal.classList.add('hidden');
    modal.querySelectorAll('input').forEach(input => { input.value = ''; });
}

function login() {
    const name = userNameInput.value.trim();
    if (!name) {
        alert('请输入用户名');
        return;
    }
    
    userName = name;
    saveState('username', name);
    socket.emit('login', userName);
    lobby.classList.add('hidden');
    room.classList.remove('hidden');
    room.classList.add('no-channel');
    
    localAvatar.textContent = name.charAt(0).toUpperCase();
    localUserDisplay.textContent = name;
    
    if (mobileAvatar) {
        mobileAvatar.textContent = name.charAt(0).toUpperCase();
    }
    if (mobileUserName) {
        mobileUserName.textContent = name;
    }
    
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
        sidebarOpen = false;
        sidebar.classList.add('closed');
        sidebar.classList.remove('open');
    } else {
        sidebarOpen = true;
        sidebar.classList.remove('closed');
        sidebar.classList.add('open');
    }
}

function logout() {
    leaveChannel();
    
    // 清理 Web Audio API 资源
    if (micGainNode) { try { micGainNode.disconnect(); } catch(e) {} micGainNode = null; }
    if (micGainDest) { try { micGainDest.disconnect(); } catch(e) {} micGainDest = null; }
    if (audioMixDest) { try { audioMixDest.disconnect(); } catch(e) {} audioMixDest = null; }
    if (audioContext && audioContext.state !== 'closed') { audioContext.close().catch(e => console.warn('[Audio] close:', e.message || e)); audioContext = null; }
    
    // 清理媒体状态
    audioTrack = null;
    localStream = null;
    screenStream = null;
    screenSharing = false;
    audioEnabled = false;
    denoiseEnabled = true;
    viewingScreenOf = null;
    currentScreenSharer = null;
    userName = null;
    
    // 清理聊天状态
    chatMessagesList = [];
    pendingImages = [];
    if (chatMessages) chatMessages.innerHTML = '';
    clearImagePreview();
    
    // 重置按钮
    toggleAudioBtn.classList.remove('mic-active');
    toggleVideoBtn.classList.remove('speaker-active');
    toggleScreenShareBtn.classList.remove('screen-active');
    if (toggleDenoiseBtn) toggleDenoiseBtn.classList.add('active');
    updateVideoButton();
    
    // 切换到登录页
    room.classList.add('hidden');
    lobby.classList.remove('hidden');
    userNameInput.value = '';
    
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
        sidebarOpen = false;
        sidebar.classList.add('closed');
        sidebar.classList.remove('open');
    } else {
        sidebarOpen = true;
        sidebar.classList.remove('closed');
        sidebar.classList.add('open');
    }
}

function updateChannelList() {
    channelListEl.innerHTML = '';
    
    if (channelList.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding: 16px; text-align: center; color: #8e9297; font-size: 14px;';
        empty.textContent = '暂无频道';
        channelListEl.appendChild(empty);
        return;
    }
    
    channelList.forEach(channel => {
        const isActive = currentChannel && currentChannel.id === channel.id;
        const item = document.createElement('div');
        item.className = 'channel-item' + (isActive ? ' active' : '');
        
        const nameRow = document.createElement('div');
        nameRow.className = 'channel-item-row';
        nameRow.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polygon points="10 8 16 12 10 16 10 8"></polygon>
            </svg>
            <span class="channel-item-name"></span>
            <span class="user-count"></span>
        `;
        nameRow.querySelector('.channel-item-name').textContent = channel.name;
        nameRow.querySelector('.user-count').textContent = channel.users ? channel.users.length : 0;
        item.appendChild(nameRow);
        
        // 活跃频道下显示参与者列表
        if (isActive && channel.users && channel.users.length > 0) {
            const participantsRow = document.createElement('div');
            participantsRow.className = 'channel-participants';
            channel.users.forEach(u => {
                const isSelf = u === userName;
                const pData = participants.get(u);
                const isSharing = isSelf ? screenSharing : (pData && pData.screenSharing);
                const isViewing = viewingScreenOf === u;
                
                const row = document.createElement('div');
                row.className = 'channel-participant-item';
                if (isSharing) row.classList.add('screen-sharing');
                if (isViewing) row.classList.add('viewing-screen');
                
                // 头像
                const avatar = document.createElement('div');
                avatar.className = 'channel-participant-avatar';
                avatar.textContent = u.charAt(0).toUpperCase();
                
                // 在线状态点
                const statusDot = document.createElement('div');
                statusDot.className = 'channel-participant-status';
                avatar.appendChild(statusDot);
                
                // 名字
                const name = document.createElement('div');
                name.className = 'channel-participant-name';
                name.textContent = isSelf ? u + ' (你)' : u;
                
                row.appendChild(avatar);
                row.appendChild(name);
                
                // 共享/观看标记
                if (isViewing) {
                    const badge = document.createElement('span');
                    badge.className = 'channel-participant-badge badge-viewing';
                    badge.textContent = '观看中';
                    row.appendChild(badge);
                } else if (isSharing) {
                    const badge = document.createElement('span');
                    badge.className = 'channel-participant-badge badge-sharing';
                    badge.textContent = '共享';
                    row.appendChild(badge);
                }
                
                // 点击切换观看
                if (isSharing && screenStreams.has(u)) {
                    row.addEventListener('click', (e) => {
                        e.stopPropagation();
                        switchScreenView(u);
                    });
                }
                
                participantsRow.appendChild(row);
            });
            item.appendChild(participantsRow);
        }
        
        item.addEventListener('click', () => {
            if (!currentChannel || currentChannel.id !== channel.id) {
                joinChannel(channel);
            }
            const isMobile = window.innerWidth <= 768;
            if (isMobile) {
                closeSidebar();
            }
        });
        
        // 右键菜单（桌面端）
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(channel, e.clientX, e.clientY);
        });
        
        // 长按菜单（移动端）
        let longPressTimer = null;
        item.addEventListener('touchstart', (e) => {
            longPressTimer = setTimeout(() => {
                e.preventDefault();
                const touch = e.touches[0];
                showContextMenu(channel, touch.clientX, touch.clientY);
            }, 600);
        });
        item.addEventListener('touchend', () => clearTimeout(longPressTimer));
        item.addEventListener('touchmove', () => clearTimeout(longPressTimer));
        
        channelListEl.appendChild(item);
    });
}

// 右键菜单相关函数
function showContextMenu(channel, x, y) {
    contextMenuChannel = channel;
    channelContextMenu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
    channelContextMenu.style.top = Math.min(y, window.innerHeight - 140) + 'px';
    channelContextMenu.classList.add('show');

    // 如果是当前频道，高亮加入按钮
    ctxJoin.style.display = (!currentChannel || currentChannel.id !== channel.id) ? '' : 'none';
    // BUGFIX: L1 非房主隐藏删除按钮
    ctxDelete.style.display = (channel.owner === userName) ? '' : 'none';
}

function hideContextMenu() {
    channelContextMenu.classList.remove('show');
    contextMenuChannel = null;
}

ctxRename.addEventListener('click', () => {
    if (contextMenuChannel) {
        renameChannelInput.value = contextMenuChannel.name;
        openModal(renameModal);
        // 保存待重命名频道（不一定正在该频道中）
        renameModal._targetChannel = contextMenuChannel;
    }
    hideContextMenu();
});

ctxJoin.addEventListener('click', () => {
    if (contextMenuChannel) {
        joinChannel(contextMenuChannel);
    }
    hideContextMenu();
});

ctxDelete.addEventListener('click', () => {
    if (contextMenuChannel) {
        if (confirm(`确定删除频道「${contextMenuChannel.name}」？`)) {
            socket.emit('delete-channel', contextMenuChannel.id);
        }
    }
    hideContextMenu();
});

// 点击空白处关闭菜单
document.addEventListener('click', (e) => {
    if (!e.target.closest('.channel-context-menu')) {
        hideContextMenu();
    }
});

document.addEventListener('scroll', hideContextMenu, true);

// 重命名支持跨频道（从右键菜单触发时）
confirmRenameBtn.addEventListener('click', (e) => {
    const target = renameModal._targetChannel;
    const name = renameChannelInput.value.trim();
    if (!name) {
        alert('请输入新频道名称');
        return;
    }
    if (target) {
        socket.emit('rename-channel', target.id, name);
        if (currentChannel && currentChannel.id === target.id) {
            currentChannel.name = name;
            currentChannelName.textContent = name;
        }
        renameModal._targetChannel = null;
    } else if (currentChannel) {
        socket.emit('rename-channel', currentChannel.id, name);
        currentChannel.name = name;
        currentChannelName.textContent = name;
    }
    updateChannelList();
    closeModal(renameModal);
});

function updateParticipantsDisplay() {
    if (!currentChannel) {
        channelPlaceholder.classList.remove('hidden');
        participantsContainer.classList.add('hidden');
        room.classList.add('no-channel');
        return;
    }
    
    room.classList.remove('no-channel');
    channelPlaceholder.classList.add('hidden');
    participantsContainer.classList.remove('hidden');
    
    // 刷新侧边栏参与者列表
    updateChannelList();
}

function showScreenShare(userId) {
    if (!userId) {
        // 清理浮窗
        if (minimizedThumb) {
            minimizedThumb.querySelector('video').srcObject = null;
            minimizedThumb.remove();
            minimizedThumb = null;
        }
        screenShareContainer.classList.add('hidden');
        return;
    }
    
    screenShareContainer.classList.remove('hidden');
    screenSharingUser.textContent = userId;
}

// 切换观看某人的屏幕共享
function switchScreenView(targetUser) {
    if (!targetUser) return;
    
    const stream = screenStreams.get(targetUser);
    if (!stream) {
        console.warn('没有找到', targetUser, '的屏幕流');
        return;
    }
    
    viewingScreenOf = targetUser;
    remoteScreenVideo.srcObject = stream;
    remoteScreenVideo.autoplay = true;
    remoteScreenVideo.playsInline = true;
    
    // 如果是自己的屏幕，muted 防止回声
    if (targetUser === userName) {
        remoteScreenVideo.muted = true;
    } else {
        remoteScreenVideo.muted = false;
    }
    
    const displayName = targetUser === userName ? targetUser + ' (你)' : targetUser;
    showScreenShare(displayName);
    screenSharingUser.textContent = displayName;
    
    // 尝试播放
    remoteScreenVideo.play().catch(() => {
        setTimeout(() => remoteScreenVideo.play().catch(() => {}), 200);
    });
    
    // 更新参与者头像高亮
    updateParticipantsDisplay();
    updateChannelList(); // 刷新侧边栏参与者头像高亮
    updateScreenShareBar(); // 刷新头像条和指示器
    
    console.log('切换观看:', targetUser, '的屏幕');
}

// ====== 多人共享头像条 + 滑动指示器 ======
function updateScreenShareBar() {
    const bar = document.getElementById('screenShareBar');
    const barList = document.getElementById('screenShareBarList');
    const indicator = document.getElementById('screenSwipeIndicator');
    if (!bar || !barList || !indicator) return;
    
    // 收集所有正在共享的用户（含自己）
    const sharers = [];
    if (screenSharing) sharers.push(userName);
    screenStreams.forEach((_, name) => {
        if (name !== userName && !sharers.includes(name)) sharers.push(name);
    });
    
    // 单人或无人共享时隐藏
    if (sharers.length < 2) {
        bar.classList.add('hidden');
        indicator.classList.add('hidden');
        return;
    }
    
    // 渲染头像条
    bar.classList.remove('hidden');
    barList.innerHTML = '';
    sharers.forEach(name => {
        const isSelf = name === userName;
        const isActive = viewingScreenOf === name;
        
        const item = document.createElement('div');
        item.className = 'screen-share-bar-item' + (isActive ? ' active' : '');
        
        const avatar = document.createElement('div');
        avatar.className = 'screen-share-bar-avatar';
        avatar.textContent = name.charAt(0).toUpperCase();
        
        const nameEl = document.createElement('span');
        nameEl.className = 'screen-share-bar-name';
        nameEl.textContent = isSelf ? name + ' (你)' : name;
        
        item.appendChild(avatar);
        item.appendChild(nameEl);
        
        item.addEventListener('click', () => {
            switchScreenView(name);
        });
        
        barList.appendChild(item);
    });
    
    // 滚动到当前活跃项
    const activeItem = barList.querySelector('.screen-share-bar-item.active');
    if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
    
    // 渲染滑动指示器
    indicator.classList.remove('hidden');
    indicator.innerHTML = '';
    const currentIdx = sharers.indexOf(viewingScreenOf);
    sharers.forEach((_, i) => {
        const dot = document.createElement('div');
        dot.className = 'screen-swipe-dot' + (i === currentIdx ? ' active' : '');
        dot.addEventListener('click', () => switchScreenView(sharers[i]));
        indicator.appendChild(dot);
    });
}

// 屏幕共享区域左右滑动手势
(function initScreenSwipe() {
    let touchStartX = 0;
    let touchStartY = 0;
    let swiping = false;
    
    const screenWrapper = document.getElementById('screenShareVideo');
    if (!screenWrapper) return;
    
    screenWrapper.addEventListener('touchstart', (e) => {
        const sharers = getScreenSharers();
        if (sharers.length < 2) return;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        swiping = true;
    }, { passive: true });
    
    screenWrapper.addEventListener('touchmove', (e) => {
        if (!swiping) return;
        // 判断是否为横向滑动
        const dx = Math.abs(e.touches[0].clientX - touchStartX);
        const dy = Math.abs(e.touches[0].clientY - touchStartY);
        if (dy > dx) {
            swiping = false; // 纵向滑动，放弃
        }
    }, { passive: true });
    
    screenWrapper.addEventListener('touchend', (e) => {
        if (!swiping) return;
        swiping = false;
        
        const dx = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(dx) < 50) return; // 滑动距离不够
        
        const sharers = getScreenSharers();
        if (sharers.length < 2) return;
        
        const currentIdx = sharers.indexOf(viewingScreenOf);
        let nextIdx;
        if (dx < 0) {
            // 左滑 → 下一个
            nextIdx = (currentIdx + 1) % sharers.length;
        } else {
            // 右滑 → 上一个
            nextIdx = (currentIdx - 1 + sharers.length) % sharers.length;
        }
        
        switchScreenView(sharers[nextIdx]);
    }, { passive: true });
    
    function getScreenSharers() {
        const sharers = [];
        if (screenSharing) sharers.push(userName);
        screenStreams.forEach((_, name) => {
            if (name !== userName && !sharers.includes(name)) sharers.push(name);
        });
        return sharers;
    }
})();

async function joinChannel(channel) {
    // BUGFIX: R7 防止重复加入（快速双击）
    if (joiningChannel) return;
    joiningChannel = true;

    // BUGFIX: C2/M6 手动加入频道时清除 pendingJoinChannel
    pendingJoinChannel = null;
    if (currentChannel) {
        await leaveChannel();
    }

    document.body.style.cursor = 'wait';

    try {
        // 加入频道时默认关闭麦克风，如果上次是开的则自动尝试开启
        localStream = new MediaStream();
        audioEnabled = false;
        audioTrack = null;

        // BUGFIX: L5 密码保护频道先询问密码
        let password = '';
        if (channel.hasPassword) {
            password = prompt(`请输入频道「${channel.name}」的密码：`);
            if (password === null) {
                document.body.style.cursor = '';
                joiningChannel = false; // BUGFIX: R7
                return; // 用户取消
            }
        }

        currentChannel = channel;

        socket.emit('join-channel', { channelId: channel.id, password: password });
        updateAudioButtons();
        updateParticipantsDisplay();
        
        // 如果上次麦克风是开启的，自动尝试开麦（会触发权限请求）
        const savedMicState = (() => {
            try { return JSON.parse(localStorage.getItem('mr_state') || '{}').audioEnabled; } catch(e) { return false; }
        })();
        if (savedMicState) {
            await toggleAudio();
        }
    } catch (err) {
        console.error('加入频道失败:', err);
        alert('加入频道失败');
    } finally {
        document.body.style.cursor = '';
        joiningChannel = false; // BUGFIX: R7
    }
}

// BUGFIX: C3 提取公共媒体清理函数，供 leaveChannel、kicked、channel-removed 复用
function cleanupAllMedia() {
    // 停止本地流
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    // 停止屏幕流
    if (screenStream) {
        if (screenStream._audioSource) {
            try { screenStream._audioSource.disconnect(audioMixDest); } catch(e) {}
            screenStream._audioSource = null;
        }
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }
    // 关闭所有 PeerConnection
    peerConnections.forEach(pc => pc.close());
    peerConnections.clear();
    participants.clear();
    // 清理远程音频元素
    remoteAudioElements.forEach(audio => {
        audio.srcObject = null;
        audio.pause();
    });
    remoteAudioElements.clear();
    // 断开 Web Audio 节点（不关闭 audioContext，因为可能重用）
    if (micGainNode) { try { micGainNode.disconnect(); } catch(e) {} micGainNode = null; }
    if (micGainDest) { try { micGainDest.disconnect(); } catch(e) {} micGainDest = null; }
    if (audioMixDest) { try { audioMixDest.disconnect(); } catch(e) {} audioMixDest = null; }
    // 清理其他状态
    pendingCandidates.clear();
    screenStreams.clear();
    audioTrack = null;
    audioEnabled = false;
    screenSharing = false;
    viewingScreenOf = null;
    currentScreenSharer = null;
}

async function leaveChannel() {
    if (!currentChannel) return;

    if (screenSharing) {
        await stopScreenShare();
    }

    cleanupAllMedia();

    socket.emit('leave-channel');

    currentChannel = null;
    updateScreenShareBar();
    remoteScreenVideo.srcObject = null;
    showScreenShare(null);

    // 退出聊天全屏模式
    room.classList.remove('chat-only');
    if (toggleChatExpandBtn) toggleChatExpandBtn.classList.remove('active');

    // 重置按钮状态
    toggleAudioBtn.classList.remove('mic-active');
    toggleVideoBtn.classList.remove('speaker-active');
    toggleScreenShareBtn.classList.remove('screen-active');

    currentChannelName.textContent = '选择一个频道';
    updateParticipantsDisplay();
    updateChannelList();
}

function createChannel() {
    const name = newChannelNameInput.value.trim();
    if (!name) {
        alert('请输入频道名称');
        return;
    }
    // BUGFIX: L5 传递密码
    const password = document.getElementById('newChannelPassword')?.value?.trim() || '';

    socket.emit('create-channel', { name: name, password: password });
    // BUGFIX: C2/B6 存储频道名和创建令牌，5秒超时自动清除
    pendingJoinChannel = name;
    createToken = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const thisToken = createToken;
    setTimeout(() => {
        if (createToken === thisToken) createToken = null;
        if (pendingJoinChannel === name) pendingJoinChannel = null;
    }, 5000);
    closeModal(createModal);
}

async function toggleAudio() {
    if (!currentChannel) {
        alert('请先加入频道');
        return;
    }
    
    const mobile = isMobileDevice();
    
    if (!audioTrack) {
        // 首次开麦，请求麦克风权限
        try {
            const audioConstraints = {
                echoCancellation: true,
                noiseSuppression: denoiseEnabled,
                autoGainControl: true
            };
            if (!mobile) {
                audioConstraints.sampleRate = 48000;
                audioConstraints.sampleSize = 16;
                audioConstraints.channelCount = 1;
            }
            const micStream = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints,
                video: false
            });
            
            audioTrack = micStream.getAudioTracks()[0];
            
            let sendTrack; // 实际发送给 PeerConnection 的音轨
            
            if (mobile) {
                // 移动端: 跳过 Web Audio API 管线，直接使用原生音轨
                sendTrack = audioTrack;
                console.log('[Mobile] 直接使用原生麦克风音轨');
                console.log('[Mobile] audioTrack:', audioTrack.id, 'enabled:', audioTrack.enabled, 'readyState:', audioTrack.readyState);
            } else {
                // 桌面端: 建立 Web Audio API 管线：麦克风 → GainNode → 混合输出
                if (!audioContext) {
                    audioContext = new (window.AudioContext || window.webkitAudioContext)();
                }
                if (audioContext.state === 'suspended') {
                    await audioContext.resume();
                }
                if (!audioMixDest) {
                    audioMixDest = audioContext.createMediaStreamDestination();
                }
                const source = audioContext.createMediaStreamSource(micStream);
                micGainNode = audioContext.createGain();
                micGainNode.gain.value = micVolume;
                micGainDest = audioContext.createMediaStreamDestination();
                source.connect(micGainNode);
                micGainNode.connect(micGainDest);
                micGainNode.connect(audioMixDest);
                
                sendTrack = audioMixDest.stream.getAudioTracks()[0];
                if (!sendTrack) {
                    // Web Audio API 未产出 track，降级到原生音轨
                    console.warn('Web Audio API 未产出音轨，降级使用原生音轨');
                    sendTrack = audioTrack;
                }
            }
            
            localStream.addTrack(sendTrack);
            console.log('[Audio] sendTrack added to localStream, localStream tracks:', localStream.getTracks().map(t => t.kind + ':' + t.id));
            
            // 填充所有已有的 PeerConnection 的音频
            peerConnections.forEach((pc, peerId) => {
                const senders = pc.getSenders();
                const audioSender = senders.find(s => s.track?.kind === 'audio') ||
                                   senders.find(s => s.track === null && s.receiver?.kind === 'audio');
                console.log('[Audio] peer:', peerId, 'audioSender:', !!audioSender, 'track:', audioSender?.track?.kind || 'null');
                
                if (audioSender) {
                    audioSender.replaceTrack(sendTrack).then(() => {
                        console.log('[Audio] replaceTrack 成功');
                        // BUGFIX: B1 renegotiate 错误处理
                        renegotiate(pc, peerId).catch(e => console.warn('[WebRTC] renegotiate:', e.message || e));
                    }).catch(err => {
                        console.error('[Audio] replaceTrack 失败:', err);
                    });
                } else {
                    try {
                        pc.addTrack(sendTrack, localStream);
                        console.log('[Audio] addTrack 成功');
                        // BUGFIX: B1 renegotiate 错误处理
                        renegotiate(pc, peerId).catch(e => console.warn('[WebRTC] renegotiate:', e.message || e));
                    } catch (err) {
                        console.error('[Audio] addTrack 失败:', err);
                    }
                }
            });
            
            audioEnabled = true;
        } catch (err) {
            console.error('获取麦克风失败:', err);
            alert('无法访问麦克风，请允许权限\n\n' + (err.name || err.message || err));
            return;
        }
    } else {
        audioEnabled = !audioEnabled;
        audioTrack.enabled = audioEnabled;
    }
    
    updateAudioButtons();
    updateParticipantsDisplay();
    socket.emit('audio-status', { user: userName, enabled: audioEnabled });
    saveState('audioEnabled', audioEnabled);
}

function updateAudioButtons() {
    const btn = toggleAudioBtn.querySelector('svg');
    
    if (audioEnabled) {
        btn.innerHTML = `
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
        `;
        toggleAudioBtn.classList.add('mic-active');
    } else {
        btn.innerHTML = `
            <line x1="1" y1="1" x2="23" y2="23"></line>
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-1.11 3.5"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
        `;
        toggleAudioBtn.classList.remove('mic-active');
    }
}

async function toggleDenoise() {
    denoiseEnabled = !denoiseEnabled;
    
    if (localStream && audioTrack) {
        const mobile = isMobileDevice();
        try {
            // 重新获取音频流，切换降噪设置
            const audioConstraints = {
                echoCancellation: true,
                noiseSuppression: denoiseEnabled,
                autoGainControl: true
            };
            if (!mobile) {
                audioConstraints.sampleRate = 48000;
                audioConstraints.sampleSize = 16;
                audioConstraints.channelCount = 1;
            }
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints,
                video: false
            });
            
            const newTrack = newStream.getAudioTracks()[0];
            newTrack.enabled = audioEnabled;
            
            // 替换本地流中的音轨
            const oldSendTrack = localStream.getAudioTracks()[0];
            if (oldSendTrack) localStream.removeTrack(oldSendTrack);
            audioTrack.stop();
            audioTrack = newTrack;
            
            let sendTrack;
            
            if (mobile) {
                // 移动端: 直接使用原生音轨
                sendTrack = newTrack;
            } else {
                // 桌面端: 重新连接 GainNode 管线
                if (micGainNode && audioContext) {
                    if (micGainNode._source) try { micGainNode._source.disconnect(); } catch(e) {}
                    const source = audioContext.createMediaStreamSource(newStream);
                    micGainNode._source = source;
                    source.connect(micGainNode);
                    if (micGainDest) micGainNode.connect(micGainDest);
                    if (audioMixDest) micGainNode.connect(audioMixDest);
                }
                sendTrack = audioMixDest ? audioMixDest.stream.getAudioTracks()[0] : 
                            (micGainDest ? micGainDest.stream.getAudioTracks()[0] : newTrack);
            }
            
            // 更新本地流
            localStream.addTrack(sendTrack);
            
            // 替换所有 PeerConnection 中的音轨
            peerConnections.forEach((pc) => {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
                if (sender) {
                    sender.replaceTrack(sendTrack).catch(e => console.warn('降噪切换 replaceTrack 失败:', e));
                }
            });
            
            console.log('AI降噪', denoiseEnabled ? '已开启' : '已关闭');
            console.log('Track settings:', newTrack.getSettings());
        } catch (err) {
            console.error('切换降噪失败:', err);
            denoiseEnabled = !denoiseEnabled;
            return;
        }
    }
    
    updateDenoiseButton();
}

function updateDenoiseButton() {
    if (denoiseEnabled) {
        toggleDenoiseBtn.classList.add('active');
        toggleDenoiseBtn.title = 'AI降噪（已开启）';
    } else {
        toggleDenoiseBtn.classList.remove('active');
        toggleDenoiseBtn.title = 'AI降噪（已关闭）';
    }
}

function toggleVideo() {
    videoEnabled = !videoEnabled;
    updateVideoButton();
    saveState('videoEnabled', videoEnabled);
    
    // 控制所有远程音频
    remoteAudioElements.forEach(audio => {
        audio.muted = !videoEnabled;
        // 开启扬声器时，尝试播放之前被阻止的音频
        if (videoEnabled) {
            audio.play().catch(() => {});
        }
    });
}

function updateVideoButton() {
    const btn = toggleVideoBtn.querySelector('svg');
    
    if (videoEnabled) {
        btn.innerHTML = `
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
        `;
        toggleVideoBtn.classList.add('speaker-active');
    } else {
        btn.innerHTML = `
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <line x1="23" y1="9" x2="17" y2="15"></line>
            <line x1="17" y1="9" x2="23" y2="15"></line>
        `;
        toggleVideoBtn.classList.remove('speaker-active');
    }
}

function updateScreenShareButton() {
    const btn = toggleScreenShareBtn.querySelector('svg');
    
    if (screenSharing) {
        btn.innerHTML = `
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
        `;
        toggleScreenShareBtn.classList.add('screen-active');
    } else {
        btn.innerHTML = `
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
        `;
        toggleScreenShareBtn.classList.remove('screen-active');
    }
}

async function toggleScreenShare() {
    if (!currentChannel) {
        alert('请先加入频道');
        return;
    }
    
    if (screenSharing) {
        await stopScreenShare();
    } else {
        await startScreenShare();
    }
}

async function startScreenShare() {
    try {
        const iOS = isIOS();
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        
        if (iOS && !isSafari) {
            alert('⚠️ iOS需要使用 Safari 浏览器\n\n请在 Safari 中打开此页面\n\n当前浏览器：' + navigator.userAgent.substring(0, 50));
            return;
        }
        
        if (iOS) {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
                alert('❌ iOS不支持屏幕共享\n\n【原因】\niOS Safari和所有iOS浏览器都不支持 getDisplayMedia API，这是Apple的系统限制。\n\n【替代方案】\n1️⃣ 使用桌面电脑（Windows/Mac）进行屏幕共享\n2️⃣ 使用Android设备（支持Chrome）\n3️⃣ 使用腾讯会议、钉钉等原生App\n\n【开发建议】\n如需iOS屏幕共享，需要使用原生开发（React Native/Cordova），通过Native模块调用iOS的屏幕录制功能。');
                return;
            }
            
            const confirmed = confirm('📱 iOS屏幕共享\n\n⚠️ 注意：iOS Safari不支持标准屏幕共享API\n\niOS唯一的屏幕共享方式是：\n1. 从屏幕底部向上滑动\n2. 点击屏幕录制按钮\n3. 选择此网页应用\n4. 开始录制\n\n此方式为屏幕录制，非真正的屏幕共享。\n\n是否继续尝试？');
            if (!confirmed) {
                return;
            }
        }
        
        let constraints = {
            video: true,
            audio: true  // 请求屏幕音频（需要选择"标签页"共享才能捕获声音）
        };
        
        if (!iOS) {
            constraints.video = {
                cursor: 'always',
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 60, max: 60 }
            };
        }
        
        console.log('请求屏幕共享，约束:', constraints);
        
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            alert('您的浏览器不支持屏幕共享');
            return;
        }
        
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
            console.log('获取到屏幕流:', screenStream);
        } catch (firstError) {
            console.log('第一次尝试失败:', firstError);
            console.log('尝试使用基本参数...');
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                console.log('第二次尝试成功:', screenStream);
            } catch (secondError) {
                console.log('第二次尝试也失败:', secondError);
                throw firstError;
            }
        }
        
        if (!screenStream) {
            alert('未获取到屏幕流');
            return;
        }
        
        const videoTracks = screenStream.getVideoTracks();
        const audioTracks = screenStream.getAudioTracks();
        console.log('视频轨道数量:', videoTracks.length, '音频轨道数量:', audioTracks.length);
        
        if (videoTracks.length === 0) {
            alert('未找到视频轨道');
            return;
        }
        
        console.log('视频轨道:', videoTracks[0]);
        
        screenSharing = true;
        updateScreenShareButton();
        updateParticipantsDisplay();
        
        peerConnections.forEach((pc, peerId) => {
            // 发送屏幕视频
            const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (videoSender) {
                console.log('替换已有的视频轨道');
                videoSender.replaceTrack(videoTracks[0]).then(() => {
                    // BUGFIX: B1 renegotiate 错误处理
                    renegotiate(pc, peerId).catch(e => console.warn('[WebRTC] renegotiate:', e.message || e));
                }).catch(e => console.warn('[WebRTC] replaceTrack:', e.message || e));
            } else {
                console.log('添加新的视频轨道');
                pc.addTrack(videoTracks[0], screenStream);
                // BUGFIX: B1 renegotiate 错误处理
                renegotiate(pc, peerId).catch(e => console.warn('[WebRTC] renegotiate:', e.message || e));
            }
            // 设置视频编码码率上限，提高画质
            const vSender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (vSender) {
                const params = vSender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }
                params.encodings[0].maxBitrate = 4_000_000; // 4Mbps
                params.encodings[0].maxFramerate = 60;
                vSender.setParameters(params).catch(e =>
                    console.warn('设置视频码率失败:', e)
                );
            }
        });
        
        // 屏幕音频接入混合器（与麦克风混合成单条音轨）
        if (audioTracks.length > 0 && audioContext && audioMixDest) {
            const screenAudioSource = audioContext.createMediaStreamSource(screenStream);
            screenAudioSource.connect(audioMixDest);
            // 保存引用，停止共享时断开
            screenStream._audioSource = screenAudioSource;
            console.log('屏幕音频已接入混合器');
            
            // 更新所有 PeerConnection 的音频 sender 为新的混合音轨
            const newMixedTrack = audioMixDest.stream.getAudioTracks()[0];
            peerConnections.forEach((pc) => {
                const audioSender = pc.getSenders().find(s => s.track?.kind === 'audio');
                if (audioSender) {
                    audioSender.replaceTrack(newMixedTrack);
                }
            });
        }
        
        socket.emit('screen-share-status', { user: userName, sharing: true });
        
        videoTracks[0].onended = () => {
            console.log('屏幕共享轨道结束');
            stopScreenShare();
        };
        
        // 在屏幕共享容器中显示自己的屏幕
        screenStreams.set(userName, screenStream);
        viewingScreenOf = userName;
        updateScreenShareBar();
        remoteScreenVideo.srcObject = screenStream;
        remoteScreenVideo.autoplay = true;
        remoteScreenVideo.muted = true;
        remoteScreenVideo.playsInline = true;
        screenShareContainer.classList.remove('hidden');
        screenSharingUser.textContent = userName + ' (你)';
        
        console.log('屏幕共享已启动');
        
    } catch (err) {
        console.error('屏幕共享完全失败:', err);
        console.error('错误名称:', err.name);
        console.error('错误信息:', err.message);
        
        const iOS = isIOS();
        
        if (iOS) {
            alert('❌ iOS屏幕录制失败\n\n📋 完整检查清单：\n1. ✅ 使用 Safari 浏览器\n2. ✅ 设置 → 控制中心，添加"屏幕录制"\n3. ✅ 访问 HTTPS 网址\n4. ✅ 点击共享后选择"整个屏幕"\n5. ✅ 点击"开始直播"\n6. ✅ 授予"屏幕录制"权限\n\n💡 错误: ' + (err.name || 'Unknown') + ' - ' + (err.message || ''));
        } else if (err.name === 'NotAllowedError') {
            alert('您拒绝了屏幕共享权限，请重试');
        } else if (err.name === 'NotFoundError') {
            alert('未找到可共享的屏幕');
        } else if (err.name === 'NotReadableError') {
            alert('无法访问屏幕，请检查是否被其他应用占用');
        } else if (err.name === 'OverconstrainedError') {
            alert('无法满足视频约束，尝试其他方式');
        } else {
            alert('无法共享屏幕\n\n' + err.name + ': ' + (err.message || '未知错误'));
        }
    }
}

async function stopScreenShare() {
    const oldScreenStream = screenStream;
    // 断开屏幕音频混合器，恢复纯麦克风混合音轨
    if (oldScreenStream && oldScreenStream._audioSource) {
        try { oldScreenStream._audioSource.disconnect(audioMixDest); } catch(e) {}
        oldScreenStream._audioSource = null;
    }
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }
    
    // 从 screenStreams 中移除自己的屏幕
    screenStreams.delete(userName);
    
    // 清除本地屏幕预览（仅当显示的是自己的屏幕时）
    if (remoteScreenVideo.srcObject === oldScreenStream) {
        remoteScreenVideo.srcObject = null;
        // 尝试切换到其他人的屏幕
        const otherSharers = Array.from(screenStreams.keys());
        if (otherSharers.length > 0) {
            switchScreenView(otherSharers[0]);
        } else {
            viewingScreenOf = null;
            showScreenShare(null);
        }
    }
    
    screenSharing = false;
    updateScreenShareButton();
    updateParticipantsDisplay();
    updateScreenShareBar();
    
    peerConnections.forEach((pc, peerId) => {
        // 移除屏幕视频 sender
        const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (videoSender) {
            pc.removeTrack(videoSender);
        }
        // 更新音频 sender 为纯麦克风混合音轨（屏幕音频已从混合器断开）
        if (audioMixDest) {
            const micOnlyTrack = audioMixDest.stream.getAudioTracks()[0];
            const audioSender = pc.getSenders().find(s => s.track?.kind === 'audio');
            if (audioSender && micOnlyTrack) {
                audioSender.replaceTrack(micOnlyTrack);
            }
        }
    });
    
    socket.emit('screen-share-status', { user: userName, sharing: false });
}

function createPeerConnection(remoteUserName) {
    // BUGFIX: B2 创建新 PC 前先清理同名用户的旧音频元素
    remoteAudioElements.forEach(audio => {
        if (audio.id.startsWith('remote-audio-' + remoteUserName)) {
            audio.srcObject = null;
            audio.pause();
            remoteAudioElements.delete(audio);
        }
    });
    const pc = new RTCPeerConnection(configuration);
    peerConnections.set(remoteUserName, pc);
    
    // BUGFIX: W3 统一音频收发器管理策略
    // - addTrack: 已有麦克风/混合音轨时使用，创建 sender + transceiver，后续 replaceTrack 不产生新 m-line
    // - addTransceiver: 未开麦时预创建 sendrecv transceiver，确保 SDP 中始终有音频 m-line
    //   后续开麦时通过 replaceTrack 填充，避免 addTrack 产生重复 m-line（unified-plan 限制）
    const mixedTrack = audioMixDest ? audioMixDest.stream.getAudioTracks()[0] : null;
    if (mixedTrack && localStream) {
        pc.addTrack(mixedTrack, localStream);
    } else if (audioTrack && localStream) {
        pc.addTrack(audioTrack, localStream);
    } else {
        pc.addTransceiver('audio', { direction: 'sendrecv' });
    }
    
    if (localStream) {
        if (screenSharing && screenStream) {
            pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
            // 设置视频编码码率
            const vSender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (vSender) {
                const p = vSender.getParameters();
                if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
                p.encodings[0].maxBitrate = 4_000_000;
                p.encodings[0].maxFramerate = 60;
                vSender.setParameters(p).catch(e => console.warn('[WebRTC] setParameters:', e.message || e));
            }
            // 屏幕音频已通过 audioMixDest 混合到单条音轨中，无需单独发送
        }
    }
    
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                candidate: event.candidate,
                from: userName,
                to: remoteUserName,
            });
        }
    };
    
    pc.ontrack = (event) => {
        const stream = event.streams[0];
        
        if (event.track.kind === 'video') {
            console.log('收到视频轨道:', remoteUserName);
            // 存储该用户的屏幕流
            screenStreams.set(remoteUserName, stream);
            currentScreenSharer = remoteUserName;
            // 如果当前没有在看其他人的屏幕，自动切换到新共享者
            if (!viewingScreenOf || viewingScreenOf === remoteUserName) {
                switchScreenView(remoteUserName);
            }
            updateParticipantsDisplay();
            updateScreenShareBar();
            
            // 视频轨道结束时清理
            event.track.onended = () => {
                console.log(remoteUserName, '的屏幕共享轨道结束');
                screenStreams.delete(remoteUserName);
                updateScreenShareBar();
                if (viewingScreenOf === remoteUserName) {
                    const otherSharers = Array.from(screenStreams.keys());
                    if (otherSharers.length > 0) {
                        switchScreenView(otherSharers[0]);
                    } else {
                        viewingScreenOf = null;
                        currentScreenSharer = null;
                        showScreenShare(null);
                    }
                }
                updateParticipantsDisplay();
            };
        } else if (event.track.kind === 'audio') {
            const audio = new Audio();
            audio.srcObject = stream;
            audio.muted = !videoEnabled;
            audio.id = 'remote-audio-' + remoteUserName + '-' + Date.now();
            // iOS Safari 拦截 autoplay，需要显式 play()
            audio.play().catch(err => {
                console.warn('远程音频自动播放被阻止，等待用户交互:', err);
            });
            remoteAudioElements.add(audio);
            // 音轨结束时清理
            event.track.onended = () => {
                remoteAudioElements.delete(audio);
            };
        }
    };
    
    pc.onconnectionstatechange = () => {
        console.log(`与 ${remoteUserName} 的连接状态:`, pc.connectionState);
        // BUGFIX: W1 短暂断开时等待5秒后尝试 ICE 重启，而非直接放弃
        if (pc.connectionState === 'disconnected') {
            setTimeout(() => {
                if (pc.connectionState === 'disconnected' && peerConnections.has(remoteUserName)) {
                    console.log(`[W1] ${remoteUserName} 持续断开，尝试 ICE 重启`);
                    pc.restartIce();
                    createOfferAndSend(pc, remoteUserName).catch(e =>
                        console.warn('[W1] ICE 重启后 offer 失败:', e.message || e));
                }
            }, 5000);
        }
        // BUGFIX: M8 failed 状态清理 PC 和相关资源
        if (pc.connectionState === 'failed') {
            console.log(`[M8] ${remoteUserName} 连接失败，清理PC`);
            if (peerConnections.has(remoteUserName)) {
                peerConnections.get(remoteUserName).close();
                peerConnections.delete(remoteUserName);
            }
            participants.delete(remoteUserName);
            pendingCandidates.delete(remoteUserName);
            remoteAudioElements.forEach(audio => {
                if (audio.id.startsWith('remote-audio-' + remoteUserName)) {
                    audio.srcObject = null;
                    audio.pause();
                    remoteAudioElements.delete(audio);
                }
            });
            screenStreams.delete(remoteUserName);
            updateScreenShareBar();
            if (viewingScreenOf === remoteUserName) {
                const otherSharers = Array.from(screenStreams.keys());
                if (otherSharers.length > 0) {
                    switchScreenView(otherSharers[0]);
                } else {
                    viewingScreenOf = null;
                    currentScreenSharer = null;
                    showScreenShare(null);
                }
            }
            updateParticipantsDisplay();
        }
    };
    
    return pc;
}

async function createOfferAndSend(pc, remoteUserName) {
    try {
        // BUGFIX: W4 移除废弃的 offerToReceive 选项，由 addTransceiver 管理
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        socket.emit('offer', {
            sdp: offer,
            from: userName,
            to: remoteUserName
        });
    } catch (err) {
        console.error('创建 offer 失败:', err);
    }
}

// 重新协商：当本端添加了新 track 后，需要创建新 offer 发送给对方
async function renegotiate(pc, remoteUserName) {
    try {
        if (pc.signalingState !== 'stable') {
            // 等待状态变为 stable 后重试（处理 offer collision）
            console.log('[renegotiate] signalingState:', pc.signalingState, '等待 stable 后重试');
            await new Promise(resolve => {
                const check = () => {
                    if (pc.signalingState === 'stable') { resolve(); return; }
                    if (pc.signalingState === 'closed') { resolve(); return; }
                    pc.addEventListener('signalingstatechange', check, { once: true });
                };
                check();
            });
            if (pc.signalingState !== 'stable') {
                console.log('[renegotiate] 放弃，signalingState:', pc.signalingState);
                return;
            }
        }
        const senders = pc.getSenders().map(s => s.track ? s.track.kind + ':' + s.track.id.substring(0,8) : 'null');
        console.log('[renegotiate] peer:', remoteUserName, 'senders:', senders);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', {
            sdp: offer,
            from: userName,
            to: remoteUserName
        });
        console.log('[renegotiate] offer 已发送给:', remoteUserName);
    } catch (err) {
        console.error('[renegotiate] 失败:', err.name, err.message);
    }
}

function toggleScreenFullscreen() {
    const container = document.getElementById('screenShareVideo');
    const video = document.getElementById('remoteScreenVideo');
    const iOS = isIOS();
    
    if (iOS) {
        if (video && document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        }
        if (video && video.webkitPresentationMode !== 'fullscreen') {
            if (video.webkitEnterFullscreen) {
                video.webkitEnterFullscreen();
            } else if (video.requestFullscreen) {
                video.requestFullscreen();
            }
        } else if (video) {
            if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        }
    } else {
        if (!document.fullscreenElement) {
            if (container.requestFullscreen) {
                container.requestFullscreen();
            } else if (container.webkitRequestFullscreen) {
                container.webkitRequestFullscreen();
            } else if (container.msRequestFullscreen) {
                container.msRequestFullscreen();
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        }
    }
}

// BUGFIX: H3 刷新 ICE 候选队列
async function flushPendingCandidates(peerName) {
    if (pendingCandidates.has(peerName)) {
        const pc = peerConnections.get(peerName);
        if (!pc) { pendingCandidates.delete(peerName); return; }
        const candidates = pendingCandidates.get(peerName);
        pendingCandidates.delete(peerName);
        for (const candidate of candidates) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.error('[H3] 添加队列ICE候选失败:', err);
            }
        }
    }
}

socket.on('join-error', (msg) => {
    // BUGFIX: L5 密码错误时允许重试
    if (msg === '密码错误' && currentChannel) {
        const retryPwd = prompt(`密码错误，请重新输入频道「${currentChannel.name}」的密码：`);
        if (retryPwd) {
            socket.emit('join-channel', { channelId: currentChannel.id, password: retryPwd });
            return;
        }
    }
    // 清理未确认的频道状态（密码错误取消、或频道不存在等）
    currentChannel = null;
    joiningChannel = false; // BUGFIX: R7
    document.body.style.cursor = '';
    updateParticipantsDisplay();
    updateChannelList();
    alert('加入频道失败: ' + msg);
});

socket.on('channel-list', (list) => {
    console.log('收到频道列表:', list);
    channelList.length = 0;
    channelList.push(...list);
    updateChannelList();
});

socket.on('channel-created', (channel) => {
    console.log('频道创建:', channel);
    channelList.push(channel);
    updateChannelList();
    // BUGFIX: C2/B6 通过名称和令牌双重确认是自己创建的频道
    if (pendingJoinChannel && createToken && channel.name === pendingJoinChannel) {
        pendingJoinChannel = null;
        createToken = null;
        joinChannel(channel);
    }
});

socket.on('channel-updated', (channel) => {
    const idx = channelList.findIndex(ch => ch.id === channel.id);
    if (idx >= 0) {
        channelList[idx] = channel;
        if (currentChannel && currentChannel.id === channel.id) {
            currentChannel.name = channel.name;
            currentChannelName.textContent = channel.name;
        }
        updateChannelList();
    }
});

socket.on('channel-deleted', (channelId) => {
    const idx = channelList.findIndex(ch => ch.id === channelId);
    if (idx >= 0) {
        channelList.splice(idx, 1);
        if (currentChannel && currentChannel.id === channelId) {
            leaveChannel();
        }
        updateChannelList();
    }
});

socket.on('user-connected', async (remoteUserName) => {
    console.log('用户加入:', remoteUserName);
    participants.set(remoteUserName, { audioEnabled: true, screenSharing: false });
    updateParticipantsDisplay();
    
    const pc = createPeerConnection(remoteUserName);
    await createOfferAndSend(pc, remoteUserName);
});

socket.on('user-disconnected', (remoteUserName) => {
    console.log('用户离开:', remoteUserName);
    if (peerConnections.has(remoteUserName)) {
        peerConnections.get(remoteUserName).close();
        peerConnections.delete(remoteUserName);
    }
    participants.delete(remoteUserName);
    
    // Clean up remote audio elements
    remoteAudioElements.forEach(audio => {
        if (audio.id.startsWith('remote-audio-' + remoteUserName)) {
            audio.srcObject = null;
            audio.pause();
            remoteAudioElements.delete(audio);
        }
    });

    // 清理待处理的 ICE 候选
    pendingCandidates.delete(remoteUserName);
    
    // 清理屏幕共享流
    screenStreams.delete(remoteUserName);
    updateScreenShareBar();
    
    // 如果正在观看离开者的屏幕，切换到其他人或隐藏
    if (viewingScreenOf === remoteUserName) {
        const otherSharers = Array.from(screenStreams.keys());
        if (otherSharers.length > 0) {
            switchScreenView(otherSharers[0]);
        } else {
            viewingScreenOf = null;
            currentScreenSharer = null;
            showScreenShare(null);
        }
    }
    
    updateParticipantsDisplay();
});

socket.on('offer', async (data) => {
    if (data.to !== userName) return;
    const audioLines = data.sdp.sdp ? data.sdp.sdp.split('\r\n').filter(l => l.startsWith('m=audio')) : [];
    console.log('[收到offer] from:', data.from, 'audio:', audioLines);

    let pc = peerConnections.get(data.from);
    if (!pc) {
        pc = createPeerConnection(data.from);
    }
    console.log('[收到offer] signalingState:', pc.signalingState);
    try {
        // BUGFIX: H2 处理 offer 冲突（glare）
        // polite端（userName < data.from）执行 rollback，impolite端忽略本次 offer
        if (pc.signalingState !== 'stable') {
            if (userName < data.from) {
                console.log('[H2] polite端 rollback');
                await pc.setLocalDescription({ type: 'rollback' });
            } else {
                console.log('[H2] impolite端忽略冲突 offer from:', data.from);
                return;
            }
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        // BUGFIX: H3 remoteDescription 就绪后刷新 ICE 候选队列
        await flushPendingCandidates(data.from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit('answer', {
            sdp: answer,
            from: userName,
            to: data.from
        });
        console.log('[收到offer] answer 已发送给:', data.from);
    } catch (err) {
        console.error('[收到offer] 处理失败:', err.name, err.message);
    }
});

socket.on('answer', async (data) => {
    if (data.to !== userName) return;
    console.log('收到 answer 从:', data.from);

    const pc = peerConnections.get(data.from);
    if (pc) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            // BUGFIX: H3 remoteDescription 就绪后刷新 ICE 候选队列
            await flushPendingCandidates(data.from);
        } catch (err) {
            console.error('处理 answer 失败:', err);
        }
    }
});

socket.on('ice-candidate', async (data) => {
    if (data.to !== userName) return;
    try {
        const pc = peerConnections.get(data.from);
        if (!pc || !data.candidate) return;
        // BUGFIX: H3 remoteDescription 未就绪时队列化 ICE 候选
        if (pc.currentRemoteDescription && pc.currentRemoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
            if (!pendingCandidates.has(data.from)) {
                pendingCandidates.set(data.from, []);
            }
            pendingCandidates.get(data.from).push(data.candidate);
        }
    } catch (err) {
        console.error('添加 ICE 候选失败:', err);
    }
});

socket.on('room-users', (users) => {
    console.log('频道用户列表:', users);
    users.forEach(u => {
        // 支持新格式 { name, screenSharing } 和旧格式 (string)
        const name = typeof u === 'string' ? u : u.name;
        const isSharing = typeof u === 'object' ? u.screenSharing : false;
        const isMuted = typeof u === 'object' && u.muted;
        
        if (name !== userName && !participants.has(name)) {
            participants.set(name, { audioEnabled: !isMuted, screenSharing: isSharing || false, muted: isMuted || false });
        } else if (name !== userName && participants.has(name) && isMuted) {
            participants.get(name).muted = isMuted;
        }
    });
    updateParticipantsDisplay();
});

socket.on('audio-status', (data) => {
    if (participants.has(data.user)) {
        participants.get(data.user).audioEnabled = data.enabled;
        updateParticipantsDisplay();
    }
});

socket.on('screen-share-status', (data) => {
    console.log('收到屏幕共享状态:', data);
    
    if (participants.has(data.user)) {
        participants.get(data.user).screenSharing = data.sharing;
        updateParticipantsDisplay();
        updateChannelList();
        updateScreenShareBar(); // 刷新侧边栏屏幕共享标记
    }
    
    if (data.user !== userName) {
        if (data.sharing) {
            console.log(`${data.user} 开始共享屏幕`);
        } else {
            // 对方停止共享，清理其屏幕流
            screenStreams.delete(data.user);
            updateScreenShareBar();
            if (viewingScreenOf === data.user) {
                const otherSharers = Array.from(screenStreams.keys());
                if (otherSharers.length > 0) {
                    switchScreenView(otherSharers[0]);
                } else {
                    viewingScreenOf = null;
                    currentScreenSharer = null;
                    showScreenShare(null);
                }
            }
        }
    }
});

socket.on('chat-message', (data) => {
    addChatMessage(data);
});

function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!currentChannel) {
        alert('请先加入频道');
        return;
    }
    if (!message && pendingImages.length === 0) return;
    
    if (message) {
        const msgData = {
            user: userName,
            message: message,
            time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            type: 'text'
        };
        socket.emit('chat-message', msgData);
        chatInput.value = '';
    }
    
    pendingImages.forEach(img => {
        const msgData = {
            user: userName,
            message: img.dataUrl,
            time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            type: img.type || 'image',
            fileName: img.fileName
        };
        socket.emit('chat-message', msgData);
    });
    
    pendingImages = [];
    clearImagePreview();
}

function handleChatPaste(e) {
    if (!currentChannel) {
        alert('请先加入频道');
        return;
    }
    
    const clipboardData = e.clipboardData;
    if (!clipboardData || !clipboardData.items) return;
    
    for (let i = 0; i < clipboardData.items.length; i++) {
        const item = clipboardData.items[i];
        
        if (item.type.indexOf('image') !== -1) {
            const file = item.getAsFile();
            if (file) {
                const reader = new FileReader();
                reader.onload = (evt) => {
                    const imageData = {
                        id: ++imageIdCounter, // BUGFIX: L7 自增计数器防碰撞
                        dataUrl: evt.target.result,
                        fileName: '粘贴图片.png'
                    };
                    pendingImages.push(imageData);
                    addImagePreview(imageData);
                };
                reader.readAsDataURL(file);
            }
            e.preventDefault();
            return;
        }
    }
}

function handleChatFile(e) {
    const input = e.target; // 获取触发事件的 input 元素
    const file = input.files[0];
    if (!file) return;
    
    if (!currentChannel) {
        alert('请先加入频道');
        input.remove();
        return;
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
        const imageData = {
            id: ++imageIdCounter, // BUGFIX: L7 自增计数器防碰撞
            dataUrl: e.target.result,
            fileName: file.name,
            type: file.type.startsWith('image') ? 'image' : 'video'
        };
        pendingImages.push(imageData);
        addImagePreview(imageData);
    };
    reader.readAsDataURL(file);
    
    // 清理：移除临时 input 元素
    setTimeout(() => input.remove(), 100);
}

function getUserColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = [
        '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
        '#3498db', '#9b59b6', '#e91e63', '#00bcd4', '#8bc34a',
        '#ff9800', '#795548', '#607d8b', '#673ab7', '#4caf50'
    ];
    return colors[Math.abs(hash) % colors.length];
}

function addChatMessage(data) {
    chatMessagesList.push(data);
    if (chatMessagesList.length > 500) chatMessagesList.shift();
    
    const emptyMsg = chatMessages.querySelector('.chat-empty');
    if (emptyMsg) {
        emptyMsg.remove();
    }
    
    const msgEl = document.createElement('div');
    const isSelf = data.user === userName;
    msgEl.className = 'chat-message ' + (isSelf ? 'self' : 'other');
    
    const headerEl = document.createElement('div');
    headerEl.className = 'chat-message-header';
    const userSpan = document.createElement('span');
    userSpan.className = 'chat-message-user';
    userSpan.textContent = data.user;
    if (!isSelf) {
        userSpan.style.color = getUserColor(data.user);
    }
    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-message-time';
    timeSpan.textContent = data.time;
    headerEl.appendChild(userSpan);
    headerEl.appendChild(timeSpan);
    msgEl.appendChild(headerEl);
    
    const contentEl = document.createElement('div');
    contentEl.className = 'chat-message-content';
    
    if (!isSelf) {
        contentEl.style.borderLeftColor = getUserColor(data.user);
        contentEl.style.borderLeftWidth = '3px';
    }
    
    if (data.type === 'image') {
        const img = document.createElement('img');
        img.src = data.message;
        img.className = 'chat-message-image';
        img.onclick = () => openImageModal(data.message);
        contentEl.appendChild(img);
    } else if (data.type === 'video') {
        const video = document.createElement('video');
        video.src = data.message;
        video.className = 'chat-message-video';
        video.controls = true;
        contentEl.appendChild(video);
    } else {
        contentEl.textContent = data.message;
    }
    
    msgEl.appendChild(contentEl);
    chatMessages.appendChild(msgEl);

    // BUGFIX: R6 限制 DOM 中消息数量，防止内存无限增长
    const MAX_DOM_MESSAGES = 200;
    while (chatMessages.children.length > MAX_DOM_MESSAGES + 1) {
        const first = chatMessages.children[0];
        if (first.classList.contains('chat-empty')) break;
        first.remove();
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addImagePreview(imageData) {
    chatPreviewArea.classList.remove('hidden');
    
    const previewItem = document.createElement('div');
    previewItem.className = 'chat-preview-item';
    previewItem.dataset.id = imageData.id;
    
    const img = document.createElement('img');
    img.src = imageData.dataUrl;
    
    const removeBtn = document.createElement('div');
    removeBtn.className = 'chat-preview-remove';
    removeBtn.innerHTML = '&times;';
    removeBtn.onclick = () => removeImagePreview(imageData.id);
    
    previewItem.appendChild(img);
    previewItem.appendChild(removeBtn);
    chatPreviewArea.appendChild(previewItem);
}

function removeImagePreview(imageId) {
    pendingImages = pendingImages.filter(img => img.id !== imageId);
    const item = chatPreviewArea.querySelector(`[data-id="${imageId}"]`);
    if (item) {
        item.remove();
    }
    if (pendingImages.length === 0) {
        chatPreviewArea.classList.add('hidden');
    }
}

function clearImagePreview() {
    chatPreviewArea.innerHTML = '';
    chatPreviewArea.classList.add('hidden');
}

// BUGFIX: H4 模块级图片弹窗状态与处理器
let currentImageModalOverlay = null;

function handleModalKeydown(e) {
    if (e.key === 'Escape') {
        closeImageModal();
    }
}

function closeImageModal() {
    if (currentImageModalOverlay) {
        currentImageModalOverlay.remove();
        currentImageModalOverlay = null;
    }
    document.removeEventListener('keydown', handleModalKeydown);
}

function openImageModal(imageUrl) {
    // 关闭已存在的弹窗
    closeImageModal();

    const overlay = document.createElement('div');
    overlay.className = 'image-modal-overlay';
    overlay.onclick = closeImageModal;
    currentImageModalOverlay = overlay;

    const img = document.createElement('img');
    img.src = imageUrl;
    img.className = 'image-modal-content';
    img.onclick = (e) => e.stopPropagation();

    const closeBtn = document.createElement('button');
    closeBtn.className = 'image-modal-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = closeImageModal;

    overlay.appendChild(img);
    overlay.appendChild(closeBtn);
    document.body.appendChild(overlay);

    document.addEventListener('keydown', handleModalKeydown);
}

// ====== BUGFIX: R2/R3 Socket 重连 & 缺失事件处理 ======

// R2: 断线重连后自动重新登录和加入频道
socket.on('connect', () => {
    if (userName) {
        console.log('[R2] 重新连接，自动登录:', userName);
        socket.emit('login', userName);
        if (currentChannel) {
            console.log('[R2] 尝试重新加入频道:', currentChannel.name);
            socket.emit('join-channel', { channelId: currentChannel.id });
        }
    }
});

// R3: 被踢出频道时更新 UI
socket.on('kicked', async (data) => {
    console.log('[R3] 被踢出频道:', data.channel);
    alert(`你已被房主请出频道「${data.channel}」`);
    if (currentChannel && currentChannel.name === data.channel) {
        // 清理本地状态（不发送 leave-channel，服务器已处理）
        // BUGFIX: B4 先 await stopScreenShare 再继续清理
        if (screenSharing) {
            try { await stopScreenShare(); } catch(e) { console.warn('[WebRTC] stopScreenShare:', e.message || e); }
        }
        cleanupAllMedia();
        currentChannel = null;
        updateScreenShareBar();
        remoteScreenVideo.srcObject = null;
        showScreenShare(null);
        room.classList.remove('chat-only');
        if (toggleChatExpandBtn) toggleChatExpandBtn.classList.remove('active');
        toggleAudioBtn.classList.remove('mic-active');
        toggleVideoBtn.classList.remove('speaker-active');
        toggleScreenShareBtn.classList.remove('screen-active');
        currentChannelName.textContent = '选择一个频道';
        updateParticipantsDisplay();
        updateChannelList();
    }
});

// R3: 聊天历史消息（加入频道时服务端发送）
socket.on('chat-history', (messages) => {
    if (messages && messages.length > 0) {
        console.log('[R3] 收到聊天历史:', messages.length, '条');
        messages.forEach(msg => addChatMessage(msg));
    }
});

// R3: 频道被删除（你正在频道中时收到的实时通知）
socket.on('channel-removed', (data) => {
    console.log('[R3] 频道被删除:', data.reason);
    if (currentChannel) {
        alert('当前频道已被删除');
        currentChannel = null;
        participants.clear();
        peerConnections.forEach(pc => pc.close());
        peerConnections.clear();
        updateParticipantsDisplay();
        updateChannelList();
    }
});

// ====== BUGFIX: R7 加入频道防重入标志 ======
let joiningChannel = false;

