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
let ttsEnabled = true; // 聊天消息 TTS 播放状态
const pendingTtsMessages = [];
let ttsPromptEl = null;

// 自定义音频播放器状态
let customAudioBuffer = null;       // 解码后的 AudioBuffer
let customAudioSource = null;       // 当前播放的 AudioBufferSourceNode
let customAudioGainNode = null;     // 自定义音频增益节点
let customAudioStartTime = 0;       // 播放开始时间（用于暂停/恢复）
let customAudioPausedAt = 0;        // 暂停时的偏移量（秒）
let customAudioPlaying = false;
let customAudioDuration = 0;        // 音频总时长（秒）
let customAudioTimeInterval = null;  // 时间更新定时器

// Web Audio API — 麦克风音量增益 + 音频混合
let audioContext = null;
let micGainNode = null;
let micGainDest = null;
let audioMixDest = null;  // 最终混合输出（麦克风 + 屏幕音频）
const remoteAudioElements = new Set(); // 追踪远程音频元素
const remoteAudioByUser = new Map(); // BUGFIX: M11 按用户名索引 Audio 元素

// ====== C4: 常量定义 ======
const DEBOUNCE_SAVE_MS = 1000;
const MAX_TEXT_MESSAGE_LENGTH = 5000;
const MAX_DATA_MESSAGE_LENGTH = 100000;
const MAX_DOM_MESSAGES = 200;
const CHAT_HISTORY_MAX = 500;
const CHAT_IMAGE_MAX_SIDE = 1280;
const CHAT_IMAGE_MIN_QUALITY = 0.45;
const TTS_MAX_CHARS = 180;
const TTS_PENDING_MAX = 5;

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
        if (typeof saved.ttsEnabled === 'boolean') ttsEnabled = saved.ttsEnabled;
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
// BUGFIX: C5 iOS 兼容的 alert/toast 封装 — 在非手势上下文使用自定义 toast 替代 alert()
function showAlert(msg, title) {
    if (isIOS()) {
        // iOS: 创建 toast 风格提示
        let toast = document.getElementById('__iosToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = '__iosToast';
            toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;max-width:85vw;text-align:center;z-index:99999;transition:opacity 0.3s;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
            document.body.appendChild(toast);
        }
        toast.textContent = title ? title + ': ' + msg : msg;
        toast.style.opacity = '1';
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
    } else {
        alert(msg);
    }
}

let currentScreenSharer = null;
let participants = new Map();
let globalOnlineUsers = new Map(); // 全局在线用户 (name → { ip })
const peerConnections = new Map();
const pendingCandidates = new Map(); // BUGFIX: H3 ICE候选队列
const screenStreams = new Map(); // 存储每个用户的屏幕共享流
let viewingScreenOf = null; // 当前正在观看谁的屏幕
let selfScreenPreviewEnabled = false; // 默认不渲染自己的屏幕共享，降低本机资源占用
const channelList = [];

// 从服务端获取 ICE 配置
// BUGFIX: R1 初始化默认 ICE 服务器，防止 fetch 未完成时 PeerConnection 无 STUN/TURN
// W2: TURN 服务器占位 — 如需 NAT 穿透支持，部署 coturn 后在 config.json 的 iceServers 中添加：
//   { urls: 'turn:你的域名:3478', username: '用户名', credential: '密码' }
// BUGFIX: A1 移除 iceCandidatePoolSize，避免预收集候选时排除 TURN 中继候选
let configuration = {
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
const toggleTtsBtn = document.getElementById('toggleTtsBtn');
const toggleCustomAudioBtn = document.getElementById('toggleCustomAudioBtn');
const customAudioPlayer = document.getElementById('customAudioPlayer');
const customAudioFileInput = document.getElementById('customAudioFileInput');
const customAudioName = document.getElementById('customAudioName');
const customAudioTime = document.getElementById('customAudioTime');
const customAudioPlayBtn = document.getElementById('customAudioPlayBtn');
const customAudioStopBtn = document.getElementById('customAudioStopBtn');
const customAudioVolume = document.getElementById('customAudioVolume');
const customAudioCloseBtn = document.getElementById('customAudioCloseBtn');
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
const screenOrientationBtn = document.getElementById('screenOrientationBtn');
const screenStopViewBtn = document.getElementById('screenStopViewBtn');
const screenResumeBar = document.getElementById('screenResumeBar');
const screenResumeBarList = document.getElementById('screenResumeBarList');
const toggleOrientationBtn = document.getElementById('toggleOrientationBtn');
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

const onlineUsersSection = document.getElementById('onlineUsersSection');
const onlineUsersList = document.getElementById('onlineUsersList');
const onlineUsersCount = document.getElementById('onlineUsersCount');
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
let renameTargetChannel = null; // BUGFIX: C5 重命名目标频道（null=当前频道，对象=其他频道）
// BUGFIX: C5 密码模态框相关
const joinPasswordModal = document.getElementById('joinPasswordModal');
const joinPasswordInput = document.getElementById('joinPasswordInput');
const joinPasswordTitle = document.getElementById('joinPasswordTitle');
const closeJoinPasswordModal = document.getElementById('closeJoinPasswordModal');
const cancelJoinPasswordBtn = document.getElementById('cancelJoinPasswordBtn');
const confirmJoinPasswordBtn = document.getElementById('confirmJoinPasswordBtn');
let joinPasswordResolver = null; // Promise resolver for password modal

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

if ('speechSynthesis' in window) {
    window.speechSynthesis.addEventListener('voiceschanged', () => {});
}

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
    // BUGFIX: M20 横屏抽屉模式（v2.9）— 抽屉模式默认收起
    const isDrawerMode = window.innerWidth <= 932
        && window.matchMedia('(orientation: landscape)').matches;
    if (isMobile || isDrawerMode) {
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
        // BUGFIX: M20 横屏抽屉模式（v2.9）— 932px 内横屏手机用抽屉布局
        const isDrawerMode = window.innerWidth <= 932
            && window.matchMedia('(orientation: landscape)').matches;
        
        if (!isMobile && !isDrawerMode) {
            // 桌面端：始终显示侧边栏和聊天面板
            sidebarOpen = true;
            sidebar.classList.remove('closed');
            sidebar.classList.add('open');
            sidebarOverlay.classList.remove('active');
            chatPanelOpen = true;
            const chatPanel = document.getElementById('chatPanel');
            if (chatPanel) chatPanel.classList.remove('hidden');
        } else if (isDrawerMode) {
            // 横屏抽屉模式：默认收起抽屉（主内容全屏）
            sidebarOpen = false;
            sidebar.classList.add('closed');
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('active');
            const chatPanel = document.getElementById('chatPanel');
            if (chatPanel) chatPanel.classList.remove('mobile-expanded');
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
        updateLandscapePanels();
    }
});
window.addEventListener('orientationchange', () => {
    // BUGFIX: C5 iOS 锁屏解锁后三重 dispatch + requestAnimationFrame 防抖
    let frameId;
    const fireResize = () => {
        cancelAnimationFrame(frameId);
        frameId = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    };
    fireResize();
    setTimeout(fireResize, 300);
    setTimeout(fireResize, 600);
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
            syncHeaderHiddenState();
        }

        startY = 0;
        startTarget = null;
    }, { passive: true });
})();

// BUGFIX: M20 横屏抽屉模式 — header 隐藏/显示时同步主内容 padding
function syncHeaderHiddenState() {
    const currentChannelEl = document.querySelector('.current-channel');
    if (!currentChannelEl) return;
    if (channelHeader.classList.contains('header-hidden')) {
        currentChannelEl.classList.add('header-hidden-active');
    } else {
        currentChannelEl.classList.remove('header-hidden-active');
    }
}

loginBtn.addEventListener('click', login);
logoutBtn.addEventListener('click', logout);
mobileLogoutBtn.addEventListener('click', logout);
sidebarOverlay.addEventListener('click', closeSidebar);
['pointerdown', 'touchend', 'keydown'].forEach(eventName => {
    document.addEventListener(eventName, () => {
        if (ttsEnabled && !isIOS()) window.speechSynthesis?.resume?.();
    }, { passive: true });
});
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
if (toggleTtsBtn) {
    toggleTtsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTts();
    });
}
toggleChatExpandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentChannel) return; // BUGFIX: C6 不在频道中不可切换到仅聊天模式
    room.classList.add('chat-only');
    toggleChatExpandBtn.classList.add('active');
});
chatCollapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    room.classList.remove('chat-only');
    toggleChatExpandBtn.classList.remove('active');
    // 移动端 bottom sheet：点击返回按钮收起聊天面板
    if (chatPanel.classList.contains('mobile-expanded')) {
        collapseMobileChat();
    }
});

// ====== 移动端聊天 bottom sheet ======
// 竖屏：聊天面板默认收起（底部露出手柄条），点击展开/收起
// 横屏：聊天面板为侧栏，此逻辑不生效
const mobileChatBtn = document.getElementById('mobileChatBtn');
const chatSheetHandle = document.getElementById('chatSheetHandle');
const chatSheetHint = document.getElementById('chatSheetHint');

function isPortraitMobile() {
    return window.innerWidth <= 768 
        && !window.matchMedia('(orientation: landscape)').matches;
}

function isMobileChatSheetActive() {
    // BUGFIX: M20 竖屏用 bottom sheet，横屏（抽屉模式）用右抽屉，均支持 mobile-expanded
    const isLandscapeMobile = window.innerWidth <= 932
        && window.matchMedia('(orientation: landscape)').matches;
    return (isPortraitMobile() || isLandscapeMobile) && !room.classList.contains('chat-only');
}

function expandMobileChat() {
    if (!isMobileChatSheetActive()) return;
    chatPanel.classList.add('mobile-expanded');
    if (chatSheetHint) chatSheetHint.textContent = '下滑或点此收起';
    // 展开后聚焦输入框（延迟等待动画）
    setTimeout(() => {
        const input = document.getElementById('chatInput');
        if (input && !isIOS()) input.focus();
    }, 350);
    // 滚动到最新消息
    setTimeout(() => {
        const messages = document.getElementById('chatMessages');
        if (messages) messages.scrollTop = messages.scrollHeight;
    }, 400);
}

function collapseMobileChat() {
    if (!chatPanel.classList.contains('mobile-expanded')) return;
    chatPanel.classList.remove('mobile-expanded');
    if (chatSheetHint) chatSheetHint.textContent = '上滑查看更多';
}

// 控制栏聊天按钮：展开聊天面板
if (mobileChatBtn) {
    mobileChatBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!currentChannel) {
            alert('请先加入频道');
            return;
        }
        if (chatPanel.classList.contains('mobile-expanded')) {
            collapseMobileChat();
        } else {
            expandMobileChat();
        }
    });
}

// 手柄：点击展开/收起
if (chatSheetHandle) {
    chatSheetHandle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (chatPanel.classList.contains('mobile-expanded')) {
            collapseMobileChat();
        } else {
            expandMobileChat();
        }
    });

    // 手柄拖拽展开/收起
    let sheetStartY = 0;
    let sheetDragging = false;
    chatSheetHandle.addEventListener('touchstart', (e) => {
        sheetStartY = e.touches[0].clientY;
        sheetDragging = true;
        chatPanel.style.transition = 'none';
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!sheetDragging) return;
        const deltaY = e.touches[0].clientY - sheetStartY;
        // 下拉超过 60px 则收起
        if (deltaY > 60 && chatPanel.classList.contains('mobile-expanded')) {
            collapseMobileChat();
            sheetDragging = false;
        }
    }, { passive: true });
    document.addEventListener('touchend', () => {
        if (sheetDragging) {
            sheetDragging = false;
            chatPanel.style.transition = '';
        }
    }, { passive: true });
}

// 点击聊天面板 header 也可展开（收起时）
document.querySelector('.chat-header')?.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (!chatPanel.classList.contains('mobile-expanded') && isMobileChatSheetActive()) {
        expandMobileChat();
    }
});

// BUGFIX: M20 横屏抽屉模式 — 点击主内容区关闭已展开的抽屉
document.querySelector('.main-content')?.addEventListener('click', (e) => {
    const isDrawerMode = window.innerWidth <= 932
        && window.matchMedia('(orientation: landscape)').matches;
    if (!isDrawerMode) return;
    if (e.target.closest('.sidebar-left') || e.target.closest('.chat-panel')) return;
    if (e.target.closest('button')) return;
    // 关闭侧边栏抽屉
    if (sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
        sidebar.classList.add('closed');
        sidebarOpen = false;
        updateLandscapePanels();
    }
    // 关闭聊天抽屉
    if (chatPanel.classList.contains('mobile-expanded')) {
        collapseMobileChat();
    }
});

// 横竖屏切换 / 窗口 resize 时重置聊天面板状态
const originalResizeHandler = window.onresize;
window.addEventListener('resize', () => {
    if (!isPortraitMobile()) {
        // 横屏或桌面：移除移动端展开态
        chatPanel.classList.remove('mobile-expanded');
        if (chatSheetHint) chatSheetHint.textContent = '上滑查看更多';
    }
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

// 控制栏自动隐藏（仅移动端横屏）：3秒无操作后下沉隐藏，触摸视频区域时浮现
(function initControlsAutoHide() {
    const mainControls = document.querySelector('.main-controls');
    if (!mainControls) return;
    
    // 桌面端不启用
    // BUGFIX: M16 断点与 CSS 横屏布局一致（932px）而非 768px —
    // 原 768px 导致 769-932px 宽的大屏手机横屏（iPhone Pro Max 等）自动隐藏失效，
    // 而 CSS 却已按 932px 应用横屏布局，功能与样式不一致。
    if (window.innerWidth > 932) return;
    
    let hideTimer = null;
    const HIDE_DELAY = 3000;
    
    function isLandscape() {
        return window.innerWidth > window.innerHeight;
    }
    
    function showControls() {
        mainControls.classList.remove('auto-hidden');
        mainControls.classList.add('controls-hover-zone');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideControls, HIDE_DELAY);
    }
    
    function hideControls() {
        // 竖屏不隐藏
        if (!isLandscape()) return;
        if (document.querySelector('.control-btn-wrapper.active')) {
            hideTimer = setTimeout(hideControls, HIDE_DELAY);
            return;
        }
        mainControls.classList.add('auto-hidden');
        mainControls.classList.remove('controls-hover-zone');
    }
    
    // 触摸设备：点击主内容区域切换显示/隐藏
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
        mainContent.addEventListener('click', (e) => {
            if (e.target.closest('.main-controls') || e.target.closest('button')) return;
            if (mainControls.classList.contains('auto-hidden')) {
                showControls();
            }
        });
    }
    
    // 控制栏自身触摸/鼠标交互
    mainControls.addEventListener('touchstart', showControls, { passive: true });
    mainControls.addEventListener('mouseenter', showControls);
    mainControls.addEventListener('mouseleave', () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideControls, HIDE_DELAY);
    });
    
    // 横竖屏切换时处理
    window.addEventListener('orientationchange', () => {
        setTimeout(() => {
            if (isLandscape()) {
                hideTimer = setTimeout(hideControls, HIDE_DELAY);
            } else {
                // 切回竖屏时显示控制栏
                showControls();
            }
        }, 100);
    });
    
    // 初始状态：横屏才自动隐藏
    if (isLandscape()) {
        hideTimer = setTimeout(hideControls, HIDE_DELAY);
    }
})();

screenFullscreenBtn.addEventListener('click', toggleScreenFullscreen);
if (screenStopViewBtn) {
    screenStopViewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        stopWatchingScreen();
    });
}

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
            syncHeaderHiddenState();
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
        renameTargetChannel = null; // null 表示重命名当前频道
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

// iOS 兼容的文件选择：使用视觉隐藏而非 display:none，避免移动端拦截 click()
function createFileInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.className = 'chat-file-input-native';
    input.addEventListener('change', handleChatFile);
    return input;
}

let currentFileInput = null;
let lastFilePickerAt = 0;

function openChatFilePicker(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    if (!currentChannel) {
        alert('请先加入频道');
        return;
    }

    // touchend 后部分移动浏览器还会补发 click，短时间内忽略重复触发
    const now = Date.now();
    if (now - lastFilePickerAt < 700) return;
    lastFilePickerAt = now;

    if (!currentFileInput || !document.body.contains(currentFileInput)) {
        currentFileInput = createFileInput();
        document.body.appendChild(currentFileInput);
    }
    currentFileInput.value = '';
    currentFileInput.click();
}

chatFileBtn.addEventListener('click', openChatFilePicker);
chatFileBtn.addEventListener('touchend', openChatFilePicker, { passive: false });

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
            sidebar.classList.add('closed');
            sidebar.classList.remove('open');
        } else if (currentHandle === chatHandle && chatPanel.offsetWidth < HIDE_THRESHOLD) {
            chatPanel.style.width = '0px';
            chatPanel.style.minWidth = '0px';
            chatPanel.style.opacity = '0';
            chatPanel.style.overflow = 'hidden';
            chatPanel.classList.add('hidden');
        }
        updateLandscapePanels();
        
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
                if (newWidth > 0) sidebar.classList.remove('closed');
            }
        } else if (currentHandle === chatHandle) {
            const newWidth = window.innerWidth - clientX;
            if (newWidth >= 0 && newWidth <= 500) {
                chatPanel.style.width = newWidth + 'px';
                chatPanel.style.minWidth = newWidth > 0 ? newWidth + 'px' : '0px';
                chatPanel.style.opacity = newWidth > 0 ? '1' : '0';
                chatPanel.style.overflow = newWidth > 0 ? 'visible' : 'hidden';
                if (newWidth > 0) chatPanel.classList.remove('hidden');
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
    
    // BUGFIX: M20 横屏抽屉模式检测（v2.9）—
    // 抽屉模式下边缘滑动改为直接开关抽屉（transform class），不再调宽度
    const isDrawerMode = () => {
        const isLandscape = window.matchMedia('(orientation: landscape)').matches;
        return window.innerWidth <= 932 && isLandscape;
    };
    
    // 抽屉模式下侧边栏是否展开
    const isSidebarOpen = () => sidebar.classList.contains('open');
    // 抽屉模式下聊天面板是否展开
    const isChatOpen = () => chatPanel.classList.contains('mobile-expanded');
    
    document.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        const isLandscape = window.matchMedia('(orientation: landscape)').matches;
        
        if (!isLandscape) return;
        
        if (isDrawerMode()) {
            // 抽屉模式：从左边缘滑动打开侧边栏（已关闭时）
            if (touch.clientX < EDGE_SWIPE_ZONE && !isSidebarOpen()) {
                edgeSwipeStartX = touch.clientX;
                edgeSwipeActive = true;
                edgeSwipeSide = 'left';
            }
            // 从右边缘滑动打开聊天（已关闭时）
            else if (touch.clientX > window.innerWidth - EDGE_SWIPE_ZONE && !isChatOpen()) {
                edgeSwipeStartX = touch.clientX;
                edgeSwipeActive = true;
                edgeSwipeSide = 'right';
            }
            return;
        }
        
        // 非抽屉模式：原有宽度逻辑
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
        
        if (isDrawerMode()) {
            // 抽屉模式：滑动超过阈值即展开（由 touchend 决定）
            e.preventDefault();
            return;
        }
        
        if (edgeSwipeSide === 'left' && deltaX > 0) {
            // 从左边缘向右滑动：拉出侧边栏
            const newWidth = Math.min(deltaX, 400);
            sidebar.style.width = newWidth + 'px';
            sidebar.style.minWidth = newWidth + 'px';
            sidebar.style.opacity = '1';
            sidebar.style.overflow = 'visible';
            sidebar.classList.remove('closed');
            e.preventDefault();
        } else if (edgeSwipeSide === 'right' && deltaX < 0) {
            // 从右边缘向左滑动：拉出聊天面板
            const newWidth = Math.min(-deltaX, 500);
            chatPanel.style.width = newWidth + 'px';
            chatPanel.style.minWidth = newWidth + 'px';
            chatPanel.style.opacity = '1';
            chatPanel.style.overflow = 'visible';
            chatPanel.classList.remove('hidden');
            e.preventDefault();
        }
    }, { passive: false });
    
    document.addEventListener('touchend', () => {
        if (!edgeSwipeActive) { edgeSwipeSide = null; return; }
        
        if (isDrawerMode()) {
            // 抽屉模式：直接切换开合
            if (edgeSwipeSide === 'left') {
                sidebar.classList.add('open');
                sidebar.classList.remove('closed');
            } else if (edgeSwipeSide === 'right') {
                chatPanel.classList.add('mobile-expanded');
            }
            edgeSwipeActive = false;
            edgeSwipeSide = null;
            return;
        }
        
        // 非抽屉模式：原有阈值逻辑
        // 边缘滑动结束后：超过阈值则展开，否则收回
        if (edgeSwipeSide === 'left') {
            if (sidebar.offsetWidth < 80) {
                sidebar.style.width = '0px';
                sidebar.style.minWidth = '0px';
                sidebar.style.opacity = '0';
                sidebar.style.overflow = 'hidden';
                sidebar.classList.add('closed');
            } else {
                sidebar.classList.remove('closed');
            }
        } else if (edgeSwipeSide === 'right') {
            if (chatPanel.offsetWidth < 80) {
                chatPanel.style.width = '0px';
                chatPanel.style.minWidth = '0px';
                chatPanel.style.opacity = '0';
                chatPanel.style.overflow = 'hidden';
                chatPanel.classList.add('hidden');
            } else {
                chatPanel.classList.remove('hidden');
            }
        }
        
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
        syncHeaderHiddenState();
    }, { passive: true });
    
    // 双击 handle 切换显示/隐藏
    handle.addEventListener('dblclick', () => {
        header.classList.toggle('header-hidden');
        syncHeaderHiddenState();
    });
})();

// ====== 全屏模式自动隐藏 UI ======
// 当侧边栏和聊天面板都收起时，1秒无触碰后自动隐藏顶部手柄和底部控制栏
(function initAutoHideUI() {
    const mainContent = document.querySelector('.main-content');
    const controls = document.querySelector('.main-controls');
    const dragHandle = document.getElementById('headerDragHandle');
    if (!mainContent || !controls || !dragHandle) return;
    
    let hideTimer = null;
    let isHidden = false;
    const HIDE_DELAY = 1000; // 1秒
    
    function isFullScreenMode() {
        const sidebar = document.querySelector('.sidebar-left');
        const chatPanel = document.getElementById('chatPanel');
        if (!sidebar || !chatPanel) return false;
        
        const sidebarStyle = getComputedStyle(sidebar);
        const sidebarClosed = sidebar.classList.contains('closed') 
            || sidebar.offsetWidth <= 1 
            || (sidebarStyle.opacity === '0' && sidebarStyle.pointerEvents === 'none');
        
        const isPortraitMobile = window.innerWidth <= 768 
            && !matchMedia('(orientation: landscape)').matches;
        
        // 竖屏移动端不启用自动隐藏
        if (isPortraitMobile) return false;
        
        // BUGFIX: M16 横屏移动端由 initControlsAutoHide 单独管理（class 方式 3s 下沉），
        // 本逻辑用 inline style 控制同一元素会与之冲突（opacity 互相覆盖、恢复需多次点击）。
        // 横屏移动端直接跳过，桌面/平板全屏模式仍由本逻辑管理。
        if (window.innerWidth <= 932 && matchMedia('(orientation: landscape)').matches) return false;
        
        // 桌面端/横屏移动端：侧边栏和聊天面板都需要收起
        const chatStyle = getComputedStyle(chatPanel);
        const chatHidden = chatPanel.classList.contains('hidden') 
            || chatPanel.offsetWidth <= 1 
            || (chatStyle.opacity === '0' && chatStyle.pointerEvents === 'none');
        return sidebarClosed && chatHidden;
    }
    
    function showUI() {
        if (!isHidden) return;
        controls.style.opacity = '1';
        controls.style.pointerEvents = 'auto';
        dragHandle.style.opacity = '1';
        dragHandle.style.pointerEvents = 'auto';
        isHidden = false;
    }
    
    function hideUI() {
        if (!isFullScreenMode()) return;
        if (isHidden) return;
        controls.style.opacity = '0';
        controls.style.pointerEvents = 'none';
        dragHandle.style.opacity = '0';
        dragHandle.style.pointerEvents = 'none';
        isHidden = true;
    }
    
    function resetHideTimer() {
        showUI();
        clearTimeout(hideTimer);
        if (isFullScreenMode()) {
            hideTimer = setTimeout(hideUI, HIDE_DELAY);
        }
    }
    
    // 监听触碰和鼠标活动（绑定到document，覆盖整个页面）
    document.addEventListener('touchstart', resetHideTimer, { passive: true });
    document.addEventListener('touchmove', resetHideTimer, { passive: true });
    document.addEventListener('mousemove', resetHideTimer, { passive: true });
    document.addEventListener('click', resetHideTimer, { passive: true });
    
    // 监听侧边栏和聊天面板状态变化
    const observer = new MutationObserver(() => {
        if (!isFullScreenMode()) {
            clearTimeout(hideTimer);
            showUI();
        } else {
            resetHideTimer();
        }
    });
    
    const sidebar = document.querySelector('.sidebar-left');
    const chatPanel = document.getElementById('chatPanel');
    if (sidebar) observer.observe(sidebar, { attributes: true, attributeFilter: ['class', 'style'] });
    if (chatPanel) observer.observe(chatPanel, { attributes: true, attributeFilter: ['class', 'style'] });
})();

// 面板直接滑动缩放（在侧边栏/聊天面板上滑动）
function initPanelSwipeResize() {
    const isLandscape = () => window.matchMedia('(orientation: landscape)').matches;
    
    // BUGFIX: M20 横屏抽屉模式（v2.9）下禁用宽度滑动 —
    // 侧边栏/聊天面板改为 fixed 覆盖式抽屉，宽度固定，滑动改宽度会破坏布局
    if (window.innerWidth <= 932 && isLandscape()) return;
    
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
                if (newWidth > 0) sidebar.classList.remove('closed');
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
                if (newWidth > 0) chatPanel.classList.remove('hidden');
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
                sidebar.classList.add('closed');
                sidebar.classList.remove('open');
            } else if (swipeTarget === 'chat' && chatPanel.offsetWidth < 80) {
                chatPanel.style.width = '0px';
                chatPanel.style.minWidth = '0px';
                chatPanel.style.opacity = '0';
                chatPanel.style.overflow = 'hidden';
                chatPanel.classList.add('hidden');
            }
        }
        updateLandscapePanels();
        
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
    updateLandscapePanels();
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

// BUGFIX: 横屏时侧边栏和聊天栏都完全隐藏则隐藏占位按钮区
function updateLandscapePanels() {
    const isMobile = window.innerWidth <= 768;
    const isLandscape = window.matchMedia('(orientation: landscape)').matches;
    if (!isMobile || !isLandscape) {
        room.classList.remove('panels-hidden');
        return;
    }
    // BUGFIX: M20 抽屉模式（v2.9）— 用 class 判断，不再依赖 offsetWidth
    // （fixed 抽屉的 offsetWidth 恒为面板宽度，宽度为 0 的判断不再成立）
    const isDrawerMode = window.innerWidth <= 932 && isLandscape;
    let sidebarHidden, chatHidden;
    if (isDrawerMode) {
        sidebarHidden = !sidebar.classList.contains('open') || sidebar.classList.contains('closed');
        chatHidden = !chatPanel.classList.contains('mobile-expanded');
    } else {
        // 必须同时满足：class 标记 + 实际宽度为 0
        sidebarHidden = sidebar.classList.contains('closed') && sidebar.offsetWidth === 0;
        chatHidden = chatPanel.classList.contains('hidden') && chatPanel.offsetWidth === 0;
    }
    if (sidebarHidden && chatHidden) {
        room.classList.add('panels-hidden');
    } else {
        room.classList.remove('panels-hidden');
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
    syncSavedControlButtons();
    
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
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
    
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
    selfScreenPreviewEnabled = false;
    audioEnabled = false;
    denoiseEnabled = true;
    viewingScreenOf = null;
    currentScreenSharer = null;
    userName = null;
    
    // 清理聊天状态
    clearChatMessages();
    
    // 重置按钮
    toggleScreenShareBtn.classList.remove('screen-active');
    if (toggleDenoiseBtn) toggleDenoiseBtn.classList.add('active');
    updateAudioButtons();
    updateVideoButton();
    
    // 切换到登录页
    room.classList.add('hidden');
    lobby.classList.remove('hidden');
    userNameInput.value = '';
    // BUGFIX: B6 清除 localStorage 缓存的用户名，防止刷新页面后自动登录绕过 lobby
    saveState('username', '');
    
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

    const fragment = document.createDocumentFragment();
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
        
        fragment.appendChild(item);
    });
    channelListEl.appendChild(fragment);
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
        renameTargetChannel = contextMenuChannel; // BUGFIX: C5 闭包变量存储目标频道
        openModal(renameModal);
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
    const target = renameTargetChannel; // BUGFIX: C5 改用闭包变量
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
        renameTargetChannel = null;
    } else if (currentChannel) {
        socket.emit('rename-channel', currentChannel.id, name);
        currentChannel.name = name;
        currentChannelName.textContent = name;
    }
    updateChannelList();
    closeModal(renameModal);
});

// BUGFIX: C5 密码模态框事件
function showPasswordModal(channelName) {
    return new Promise((resolve) => {
        joinPasswordTitle.textContent = `输入频道「${channelName}」的密码`;
        joinPasswordInput.value = '';
        joinPasswordResolver = resolve;
        openModal(joinPasswordModal);
        setTimeout(() => joinPasswordInput.focus(), 100);
    });
}

closeJoinPasswordModal.addEventListener('click', () => {
    joinPasswordInput.value = '';
    closeModal(joinPasswordModal);
    if (joinPasswordResolver) { joinPasswordResolver(null); joinPasswordResolver = null; }
});
cancelJoinPasswordBtn.addEventListener('click', () => {
    closeModal(joinPasswordModal);
    if (joinPasswordResolver) { joinPasswordResolver(null); joinPasswordResolver = null; }
});
confirmJoinPasswordBtn.addEventListener('click', () => {
    const pwd = joinPasswordInput.value;
    closeModal(joinPasswordModal);
    if (joinPasswordResolver) { joinPasswordResolver(pwd || ''); joinPasswordResolver = null; }
});
joinPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmJoinPasswordBtn.click();
});

function updateParticipantsDisplay() {
    if (!currentChannel) {
        channelPlaceholder.classList.remove('hidden');
        participantsContainer.classList.add('hidden');
        room.classList.add('no-channel');
        updateOnlineUserList();
        return;
    }
    
    room.classList.remove('no-channel');
    channelPlaceholder.classList.add('hidden');
    participantsContainer.classList.remove('hidden');
    
    // 刷新侧边栏参与者列表
    updateChannelList();
    // 刷新右侧在线用户列表
    updateOnlineUserList();
}

// 更新右侧面板的在线用户列表（昵称 + IP）
// - 未进频道: 显示全部在线用户（全局）
// - 进频道后: 只显示当前频道成员（participants 不含自己，补上自己）
function updateOnlineUserList() {
    if (!onlineUsersList || !onlineUsersCount) return;
    
    // 标题随模式切换
    const titleEl = document.getElementById('onlineUsersTitle');
    if (titleEl) titleEl.textContent = currentChannel ? '频道成员' : '在线用户';
    
    const entries = [];
    if (currentChannel) {
        // 频道内：只显示当前频道成员
        participants.forEach((data, name) => {
            entries.push({ name, ip: data.ip || '', isSelf: name === userName });
        });
        if (!participants.has(userName)) {
            entries.push({ name: userName, ip: '', isSelf: true });
        }
    } else {
        // 未进频道：显示全部在线用户
        globalOnlineUsers.forEach((data, name) => {
            entries.push({ name, ip: data.ip || '', isSelf: name === userName });
        });
    }
    
    // 按自己排最前
    entries.sort((a, b) => {
        if (a.isSelf) return -1;
        if (b.isSelf) return 1;
        return a.name.localeCompare(b.name);
    });
    
    onlineUsersCount.textContent = entries.length;
    
    if (entries.length === 0) {
        onlineUsersList.innerHTML = '<div class="online-users-empty">暂无在线用户</div>';
        return;
    }
    
    const fragment = document.createDocumentFragment();
    entries.forEach(({ name, ip, isSelf }) => {
        const item = document.createElement('div');
        item.className = 'online-user-item' + (isSelf ? ' is-self' : '');
        
        const avatar = document.createElement('div');
        avatar.className = 'online-user-avatar';
        avatar.textContent = name.charAt(0).toUpperCase();
        
        const info = document.createElement('div');
        info.className = 'online-user-info';
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'online-user-name';
        nameSpan.textContent = name;
        
        if (isSelf) {
            const tag = document.createElement('span');
            tag.className = 'online-user-self-tag';
            tag.textContent = '(你)';
            nameSpan.appendChild(document.createTextNode(' '));
            nameSpan.appendChild(tag);
        }
        info.appendChild(nameSpan);
        
        if (ip) {
            const ipSpan = document.createElement('span');
            ipSpan.className = 'online-user-ip';
            ipSpan.textContent = ip;
            info.appendChild(ipSpan);
        }
        
        item.appendChild(avatar);
        item.appendChild(info);
        fragment.appendChild(item);
    });
    
    onlineUsersList.innerHTML = '';
    onlineUsersList.appendChild(fragment);
}

function showScreenShare(userId) {
    hideSelfScreenPreviewPrompt();
    hideSelfScreenPreviewPauseBtn();
    if (!userId) {
        // 清理浮窗
        if (minimizedThumb) {
            minimizedThumb.querySelector('video').srcObject = null;
            minimizedThumb.remove();
            minimizedThumb = null;
        }
        screenShareContainer.classList.add('hidden');
        screenShareContainer.classList.remove('self-preview-paused');
        return;
    }
    
    screenShareContainer.classList.remove('hidden');
    screenShareContainer.classList.remove('self-preview-paused');
    screenSharingUser.textContent = userId;
}

function ensureSelfScreenPreviewPrompt() {
    let prompt = document.getElementById('selfScreenPreviewPrompt');
    if (prompt) return prompt;

    prompt = document.createElement('button');
    prompt.id = 'selfScreenPreviewPrompt';
    prompt.type = 'button';
    prompt.className = 'self-screen-preview-prompt';
    prompt.innerHTML = `
        <span class="self-screen-preview-title">你正在共享屏幕</span>
        <span class="self-screen-preview-text">本地预览已暂停以降低资源占用</span>
        <span class="self-screen-preview-action">查看共享内容</span>
    `;
    prompt.addEventListener('click', () => {
        selfScreenPreviewEnabled = true;
        switchScreenView(userName);
    });

    const wrapper = document.getElementById('screenShareVideo');
    if (wrapper) wrapper.appendChild(prompt);
    return prompt;
}

function hideSelfScreenPreviewPrompt() {
    const prompt = document.getElementById('selfScreenPreviewPrompt');
    if (prompt) prompt.classList.add('hidden');
}

function ensureSelfScreenPreviewPauseBtn() {
    let btn = document.getElementById('selfScreenPreviewPauseBtn');
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = 'selfScreenPreviewPauseBtn';
    btn.type = 'button';
    btn.className = 'self-screen-preview-pause hidden';
    btn.textContent = '暂停本地预览';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showOwnScreenShareStatus();
    });

    const wrapper = document.getElementById('screenShareVideo');
    if (wrapper) wrapper.appendChild(btn);
    return btn;
}

function hideSelfScreenPreviewPauseBtn() {
    const btn = document.getElementById('selfScreenPreviewPauseBtn');
    if (btn) btn.classList.add('hidden');
}

// BUGFIX: V1 停止观看屏幕共享（释放视频资源，降低占用，共享保持连接）
function stopWatchingScreen() {
    // 清理浮窗
    if (minimizedThumb) {
        minimizedThumb.querySelector('video').srcObject = null;
        minimizedThumb.remove();
        minimizedThumb = null;
    }
    // 释放视频资源
    if (remoteScreenVideo.srcObject) {
        remoteScreenVideo.pause();
        remoteScreenVideo.srcObject = null;
        remoteScreenVideo.removeAttribute('src');
        remoteScreenVideo.load();
    }
    if (viewingScreenOf === userName) {
        selfScreenPreviewEnabled = false;
    }
    viewingScreenOf = null;
    hideSelfScreenPreviewPrompt();
    hideSelfScreenPreviewPauseBtn();
    screenShareContainer.classList.add('hidden');
    screenShareContainer.classList.remove('self-preview-paused');
    // 更新恢复条和参与者显示
    updateScreenShareBar();
    updateParticipantsDisplay();
    console.log('[Screen] 已停止观看，资源已释放，共享仍在进行中');
}

// 恢复观看：点击恢复条中的头像
function resumeWatchingScreen(targetUser) {
    if (!targetUser) return;
    switchScreenView(targetUser);
}

function showOwnScreenShareStatus() {
    if (!screenSharing || !screenStream) return;
    viewingScreenOf = null;
    selfScreenPreviewEnabled = false;
    if (remoteScreenVideo.srcObject === screenStream) {
        remoteScreenVideo.pause();
    }
    remoteScreenVideo.srcObject = null;
    remoteScreenVideo.removeAttribute('src');
    remoteScreenVideo.load();
    screenShareContainer.classList.remove('hidden');
    screenShareContainer.classList.add('self-preview-paused');
    screenSharingUser.textContent = userName + ' (你，正在共享)';
    const prompt = ensureSelfScreenPreviewPrompt();
    prompt.classList.remove('hidden');
    hideSelfScreenPreviewPauseBtn();
    updateParticipantsDisplay();
    updateChannelList();
    updateScreenShareBar();
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
    if (targetUser === userName) {
        selfScreenPreviewEnabled = true;
    }
    hideSelfScreenPreviewPrompt();
    screenShareContainer.classList.remove('self-preview-paused');
    if (targetUser === userName) {
        ensureSelfScreenPreviewPauseBtn().classList.remove('hidden');
    } else {
        hideSelfScreenPreviewPauseBtn();
    }
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
    
    // BUGFIX: V1 当用户停止观看但仍有共享者时，显示恢复观看条
    if (!screenResumeBar || !screenResumeBarList) return;
    // 收集所有共享者
    const allSharers = [];
    if (screenSharing) allSharers.push(userName);
    screenStreams.forEach((_, name) => {
        if (name !== userName && !allSharers.includes(name)) allSharers.push(name);
    });
    // viewingScreenOf === null 且仍有共享者 → 显示恢复条
    if (viewingScreenOf === null && allSharers.length > 0) {
        screenResumeBar.classList.remove('hidden');
        screenResumeBarList.innerHTML = '';
        allSharers.forEach(name => {
            const isSelf = name === userName;
            const item = document.createElement('div');
            item.className = 'screen-resume-bar-item';
            const avatar = document.createElement('div');
            avatar.className = 'screen-resume-bar-avatar';
            avatar.textContent = name.charAt(0).toUpperCase();
            const nameEl = document.createElement('span');
            nameEl.className = 'screen-resume-bar-name';
            nameEl.textContent = isSelf ? name + ' (你)' : name;
            item.appendChild(avatar);
            item.appendChild(nameEl);
            item.addEventListener('click', () => {
                resumeWatchingScreen(name);
            });
            screenResumeBarList.appendChild(item);
        });
    } else {
        screenResumeBar.classList.add('hidden');
    }
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
        const savedMicState = (() => {
            try { return JSON.parse(localStorage.getItem('mr_state') || '{}').audioEnabled === true; } catch(e) { return false; }
        })();
        audioEnabled = savedMicState;
        audioTrack = null;

        // BUGFIX: L5/C5 密码保护频道用模态框替代 prompt()（iOS Safari 兼容）
        let password = '';
        if (channel.hasPassword) {
            password = await showPasswordModal(channel.name);
            if (password === null) {
                document.body.style.cursor = '';
                joiningChannel = false; // BUGFIX: R7
                return; // 用户取消
            }
        }

        currentChannel = channel;
        // BUGFIX: M14 缓存频道密码，供断线重连（R2）重新加入时使用
        // 原逻辑重连 join-channel 不带 password，密码频道会被服务端拒绝，
        // 导致 user-connected 不广播、双方静默无声，必须换用户名重新输密码才能恢复。
        currentChannel._password = password || '';

        socket.emit('join-channel', { channelId: channel.id, password: password });
        updateAudioButtons();
        updateParticipantsDisplay();
        
        // 如果上次麦克风是开启的，自动尝试开麦（会触发权限请求）
        if (savedMicState) {
            await toggleAudio();
        }
    } catch (err) {
        console.error('加入频道失败:', err);
        showAlert('加入频道失败');
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
    remoteAudioByUser.clear(); // BUGFIX: M11 同步清理
    // 断开 Web Audio 节点（不关闭 audioContext，因为可能重用）
    if (micGainNode) { try { micGainNode.disconnect(); } catch(e) {} micGainNode = null; }
    if (micGainDest) { try { micGainDest.disconnect(); } catch(e) {} micGainDest = null; }
    if (audioMixDest) { try { audioMixDest.disconnect(); } catch(e) {} audioMixDest = null; }
    // 清理自定义音频
    stopCustomAudio();
    customAudioBuffer = null;
    customAudioDuration = 0;
    if (customAudioPlayer) customAudioPlayer.classList.add('hidden');
    if (toggleCustomAudioBtn) toggleCustomAudioBtn.classList.remove('active');
    // 清理其他状态
    pendingCandidates.clear();
    screenStreams.clear();
    audioTrack = null;
    audioEnabled = false;
    screenSharing = false;
    selfScreenPreviewEnabled = false;
    viewingScreenOf = null;
    currentScreenSharer = null;
    // v2.4 聊天记录按频道隔离：离开/被踢/清空时清空聊天面板，
    // 防止切换频道后上一个频道的消息混入当前频道
    clearChatMessages();
}

// v2.4 清空聊天记录（切换频道/离开频道时调用，保证聊天记录按频道隔离）
function clearChatMessages() {
    chatMessagesList = [];
    pendingImages = [];
    clearImagePreview();
    if (chatMessages) {
        chatMessages.innerHTML = '';
        // 恢复空态占位符
        const empty = document.createElement('div');
        empty.className = 'chat-empty';
        empty.textContent = '开始聊天吧...';
        chatMessages.appendChild(empty);
    }
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
    updateAudioButtons();
    updateVideoButton();
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
                // BUGFIX: M10 用 getTransceivers() 查找音轨 sender，RTCRtpSender 没有 .receiver 属性
                const transceivers = pc.getTransceivers().map(t => ({
                    mid: t.mid, dir: t.direction,
                    recvKind: t.receiver?.track?.kind || 'none',
                    sendTrackKind: t.sender?.track?.kind || 'none'
                }));
                console.log('[Audio] peer:', peerId, 'transceivers:', JSON.stringify(transceivers));
                const audioTransceiver = pc.getTransceivers().find(t => t.receiver?.track?.kind === 'audio');
                const audioSender = audioTransceiver ? audioTransceiver.sender : null;
                // 备选：从 senders 中按 track.kind 查找（addTrack 创建的 sender）
                const fallbackSender = !audioSender ? pc.getSenders().find(s => s.track?.kind === 'audio') || null : null;
                // BUGFIX: M13 兜底：找 track===null 的 sender（addTransceiver 创建的 sender）
                const nullTrackSender = (!audioSender && !fallbackSender) ? pc.getSenders().find(s => s.track === null) || null : null;
                const finalSender = audioSender || fallbackSender || nullTrackSender;
                console.log('[Audio] peer:', peerId, 'audioSender:', !!finalSender, 'track:', finalSender?.track?.kind || 'null', 'fallback:', !!fallbackSender, 'nullTrack:', !!nullTrackSender);
                
                if (finalSender) {
                    finalSender.replaceTrack(sendTrack).then(() => {
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
            showAlert('无法访问麦克风，请允许权限: ' + (err.name || err.message || err));
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
            
            // BUGFIX: C5 降噪切换：先接新 track 再停旧 track，避免对方短暂无音频
            const oldTrack = audioTrack;
            const oldSendTrack = localStream.getAudioTracks()[0];
            audioTrack = newTrack;
            if (oldSendTrack) localStream.removeTrack(oldSendTrack);

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
            
            // BUGFIX: A3 替换所有 PeerConnection 中的音轨（三重兜底，不遗漏 null-track sender）
            peerConnections.forEach((pc) => {
                const audioTransceiver = pc.getTransceivers()
                    .find(t => t.receiver?.track?.kind === 'audio');
                const audioSender = audioTransceiver ? audioTransceiver.sender : null;
                const fallbackSender = !audioSender
                    ? pc.getSenders().find(s => s.track?.kind === 'audio') || null : null;
                const nullTrackSender = (!audioSender && !fallbackSender)
                    ? pc.getSenders().find(s => s.track === null) || null : null;
                const finalSender = audioSender || fallbackSender || nullTrackSender;
                if (finalSender) {
                    finalSender.replaceTrack(sendTrack).catch(e => console.warn('降噪切换 replaceTrack 失败:', e));
                }
            });
            
            console.log('AI降噪', denoiseEnabled ? '已开启' : '已关闭');
            console.log('Track settings:', newTrack.getSettings());
            // 等新 track 就位后再停旧 track
            if (oldTrack && oldTrack !== audioTrack) oldTrack.stop();
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

// ====== 自定义音频播放器 ======

// 点击按钮打开文件选择器
if (toggleCustomAudioBtn) {
    toggleCustomAudioBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!currentChannel) {
            alert('请先加入频道');
            return;
        }
        // 动态创建文件输入以兼容 iOS Safari
        if (customAudioFileInput) customAudioFileInput.remove();
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'customAudioFileInput';
        input.accept = 'audio/*';
        input.style.display = 'none';
        input.addEventListener('change', handleCustomAudioFile);
        document.body.appendChild(input);
        // 重新获取引用
        window._customAudioInput = input;
        input.click();
    });
}

// 处理音频文件选择
function handleCustomAudioFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    // 检查文件类型
    const supportedTypes = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm',
        'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-wav', 'audio/mp3'];
    const ext = file.name.split('.').pop().toLowerCase();
    const supportedExts = ['mp3', 'wav', 'ogg', 'webm', 'm4a', 'aac', 'flac', 'opus'];
    if (!supportedTypes.includes(file.type) && !supportedExts.includes(ext)) {
        alert('不支持的音频格式。支持的格式：MP3、WAV、OGG、WebM、M4A、AAC、FLAC、Opus');
        return;
    }

    // 检查文件大小（限制 30MB）
    if (file.size > 30 * 1024 * 1024) {
        alert('文件太大，请选择 30MB 以内的音频文件');
        return;
    }

    // 停止当前播放
    stopCustomAudio();

    // 读取并解码音频文件
    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const arrayBuffer = ev.target.result;

            // 确保 AudioContext 存在且运行
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            // 解码音频数据
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            customAudioBuffer = audioBuffer;
            customAudioDuration = audioBuffer.duration;
            customAudioPausedAt = 0;

            // 显示播放器
            customAudioName.textContent = file.name;
            updateCustomAudioTime(0);
            customAudioPlayer.classList.remove('hidden');
            toggleCustomAudioBtn.classList.add('active');

            console.log('[CustomAudio] 已加载:', file.name,
                '时长:', audioBuffer.duration.toFixed(1) + 's',
                '采样率:', audioBuffer.sampleRate + 'Hz',
                '声道:', audioBuffer.numberOfChannels);
        } catch (err) {
            console.error('[CustomAudio] 解码失败:', err);
            alert('音频解码失败: ' + (err.message || err));
            cleanupCustomAudio();
        }
    };
    reader.onerror = () => {
        alert('文件读取失败');
        cleanupCustomAudio();
    };
    reader.readAsArrayBuffer(file);

    // 清理临时 input
    setTimeout(() => { if (e.target) e.target.remove(); }, 100);
}

// 播放/暂停
if (customAudioPlayBtn) {
    customAudioPlayBtn.addEventListener('click', () => {
        if (customAudioPlaying) {
            pauseCustomAudio();
        } else {
            playCustomAudio();
        }
    });
}

// 播放自定义音频
function playCustomAudio() {
    if (!customAudioBuffer || !audioContext) return;

    // 确保 AudioContext 运行
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    // 创建新的 AudioBufferSourceNode（一次性的）
    customAudioSource = audioContext.createBufferSource();
    customAudioSource.buffer = customAudioBuffer;

    // 创建增益节点（音量控制）
    customAudioGainNode = audioContext.createGain();
    customAudioGainNode.gain.value = (customAudioVolume ? customAudioVolume.value / 100 : 0.8);

    // 连接到输出
    customAudioSource.connect(customAudioGainNode);

    // 路由到 audioMixDest（混入频道语音）
    if (audioMixDest) {
        customAudioGainNode.connect(audioMixDest);
        console.log('[CustomAudio] 路由到 audioMixDest → WebRTC');
    } else {
        // 没有 audioMixDest 时，直接输出到扬声器（仅本地听到）
        customAudioGainNode.connect(audioContext.destination);
        console.log('[CustomAudio] audioMixDest 不可用，仅本地播放');
    }

    // 从暂停位置开始播放
    const offset = customAudioPausedAt;
    customAudioSource.start(0, offset);
    customAudioStartTime = audioContext.currentTime - offset;
    customAudioPlaying = true;

    // 播放结束时
    customAudioSource.onended = () => {
        if (customAudioPlaying) {
            // 自然播放完毕
            customAudioPlaying = false;
            customAudioPausedAt = 0;
            updateCustomAudioTime(0);
            updateCustomAudioPlayButton();
            stopCustomAudioTimeUpdate();
            console.log('[CustomAudio] 播放完毕');
        }
    };

    // 更新 UI
    updateCustomAudioPlayButton();
    startCustomAudioTimeUpdate();
    console.log('[CustomAudio] 开始播放，偏移:', offset.toFixed(1) + 's');
}

// 暂停
function pauseCustomAudio() {
    if (!customAudioPlaying || !customAudioSource) return;

    // 记录当前位置
    customAudioPausedAt = audioContext.currentTime - customAudioStartTime;
    if (customAudioPausedAt >= customAudioDuration) {
        customAudioPausedAt = 0;
    }

    // 停止并断开当前 source
    try { customAudioSource.stop(); } catch (e) { /* 可能已停止 */ }
    customAudioSource.disconnect();
    customAudioSource = null;

    if (customAudioGainNode) {
        customAudioGainNode.disconnect();
        customAudioGainNode = null;
    }

    customAudioPlaying = false;
    updateCustomAudioPlayButton();
    stopCustomAudioTimeUpdate();
    updateCustomAudioTime(customAudioPausedAt);
    console.log('[CustomAudio] 暂停于:', customAudioPausedAt.toFixed(1) + 's');
}

// 停止
if (customAudioStopBtn) {
    customAudioStopBtn.addEventListener('click', stopCustomAudio);
}

function stopCustomAudio() {
    if (customAudioSource) {
        try { customAudioSource.stop(); } catch (e) { }
        customAudioSource.disconnect();
        customAudioSource = null;
    }
    if (customAudioGainNode) {
        customAudioGainNode.disconnect();
        customAudioGainNode = null;
    }
    customAudioPlaying = false;
    customAudioPausedAt = 0;
    updateCustomAudioPlayButton();
    stopCustomAudioTimeUpdate();
    updateCustomAudioTime(0);
}

// 关闭播放器
if (customAudioCloseBtn) {
    customAudioCloseBtn.addEventListener('click', () => {
        stopCustomAudio();
        customAudioBuffer = null;
        customAudioDuration = 0;
        customAudioPlayer.classList.add('hidden');
        toggleCustomAudioBtn.classList.remove('active');
    });
}

// 音量控制
if (customAudioVolume) {
    customAudioVolume.addEventListener('input', () => {
        if (customAudioGainNode) {
            customAudioGainNode.gain.value = customAudioVolume.value / 100;
        }
    });
}

// 更新时间显示
function updateCustomAudioTime(seconds) {
    if (!customAudioTime) return;
    const s = Math.max(0, Math.min(seconds, customAudioDuration || 0));
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    customAudioTime.textContent = String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function startCustomAudioTimeUpdate() {
    stopCustomAudioTimeUpdate();
    customAudioTimeInterval = setInterval(() => {
        if (!customAudioPlaying || !audioContext) return;
        const elapsed = audioContext.currentTime - customAudioStartTime;
        updateCustomAudioTime(elapsed);
        if (elapsed >= customAudioDuration) {
            stopCustomAudioTimeUpdate();
        }
    }, 200);
}

function stopCustomAudioTimeUpdate() {
    if (customAudioTimeInterval) {
        clearInterval(customAudioTimeInterval);
        customAudioTimeInterval = null;
    }
}

function updateCustomAudioPlayButton() {
    if (!customAudioPlayBtn) return;
    if (customAudioPlaying) {
        customAudioPlayBtn.classList.add('playing');
        customAudioPlayBtn.title = '暂停';
    } else {
        customAudioPlayBtn.classList.remove('playing');
        customAudioPlayBtn.title = '播放';
    }
}

// 清理自定义音频资源
function cleanupCustomAudio() {
    stopCustomAudio();
    customAudioBuffer = null;
    customAudioDuration = 0;
    customAudioPlayer.classList.add('hidden');
    toggleCustomAudioBtn.classList.remove('active');
}

function toggleTts() {
    ttsEnabled = !ttsEnabled;
    updateTtsButton();
    saveState('ttsEnabled', ttsEnabled);
    if (ttsEnabled) {
        if (isIOS() && pendingTtsMessages.length > 0) {
            showTtsPrompt();
        } else if ('speechSynthesis' in window) {
            window.speechSynthesis.resume();
        }
    } else {
        pendingTtsMessages.length = 0;
        hideTtsPrompt();
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }
}

function updateTtsButton() {
    if (!toggleTtsBtn) return;
    if (ttsEnabled) {
        toggleTtsBtn.classList.add('active');
        toggleTtsBtn.title = '聊天TTS（已开启）';
    } else {
        toggleTtsBtn.classList.remove('active');
        toggleTtsBtn.title = '聊天TTS（已关闭）';
    }
}

function getTtsText(data) {
    if (!data || data.type !== 'text' || !data.message) return '';
    return String(data.message)
        .replace(/https?:\/\/\S+/gi, '链接')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TTS_MAX_CHARS);
}

function getPreferredTtsVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    return voices.find(v => /^zh[-_]?CN/i.test(v.lang)) ||
           voices.find(v => /^zh/i.test(v.lang)) ||
           voices.find(v => /Chinese|Mandarin|中文|普通话/i.test(v.name)) ||
           voices[0] ||
           null;
}

function createTtsUtterance(text) {
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = getPreferredTtsVoice();
    if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang || 'zh-CN';
    } else {
        utterance.lang = 'zh-CN';
    }
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    return utterance;
}

function enqueueTtsMessage(data) {
    pendingTtsMessages.push(data);
    while (pendingTtsMessages.length > TTS_PENDING_MAX) {
        pendingTtsMessages.shift();
    }
}

function showTtsPrompt() {
    if (!isIOS() || !ttsEnabled || !videoEnabled || pendingTtsMessages.length === 0) return;
    if (!ttsPromptEl) {
        ttsPromptEl = document.createElement('button');
        ttsPromptEl.className = 'tts-play-prompt';
        ttsPromptEl.type = 'button';
        ttsPromptEl.addEventListener('click', (e) => {
            e.stopPropagation();
            flushPendingTtsMessages();
        });
        document.body.appendChild(ttsPromptEl);
    }
    ttsPromptEl.textContent = `播放 ${pendingTtsMessages.length} 条TTS`;
    ttsPromptEl.classList.remove('hidden');
}

function hideTtsPrompt() {
    if (ttsPromptEl) ttsPromptEl.classList.add('hidden');
}

function flushPendingTtsMessages() {
    if (!ttsEnabled || !videoEnabled) return;
    const queue = pendingTtsMessages.splice(0, pendingTtsMessages.length);
    hideTtsPrompt();
    queue.forEach(data => speakChatMessage(data, { fromUserGesture: true }));
}

function speakChatMessage(data, options = {}) {
    if (!ttsEnabled || !videoEnabled) return;
    if (data.user === userName) return;
    if (!data.tts) return;
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
        console.warn('[TTS] 当前浏览器不支持 SpeechSynthesis');
        return;
    }

    const text = getTtsText(data);
    if (!text) return;

    if (isIOS() && !options.fromUserGesture) {
        enqueueTtsMessage(data);
        showTtsPrompt();
        return;
    }

    window.speechSynthesis.resume();
    const utterance = createTtsUtterance(`${data.user}说：${text}`);
    window.speechSynthesis.speak(utterance);
}

function toggleVideo() {
    videoEnabled = !videoEnabled;
    updateVideoButton();
    saveState('videoEnabled', videoEnabled);
    if (!videoEnabled && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        pendingTtsMessages.length = 0;
        hideTtsPrompt();
    } else if (videoEnabled && ttsEnabled) {
        if (isIOS()) {
            showTtsPrompt();
        } else {
            flushPendingTtsMessages();
        }
    }
    
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

function syncSavedControlButtons() {
    updateAudioButtons();
    updateVideoButton();
    updateTtsButton();
}

syncSavedControlButtons();

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
        
        // BUGFIX: M18 共享范围提示 — 引导用户选择"标签页"而非"窗口/整个屏幕"
        // 避免浏览器外壳（地址栏/书签栏/其他标签）被共享出去，暴露隐私且观感差
        if (!iOS) {
            const tip = confirm(
                '🖥️ 选择共享范围\n\n' +
                '💡 最佳体验：在系统弹窗中选择「此标签页」\n' +
                '→ 只共享本应用页面，不含地址栏/书签栏\n\n' +
                '⚠️ 若选择「窗口」或「整个屏幕」：\n' +
                '→ 浏览器外壳、其他标签页、任务栏都会暴露\n' +
                '→ 观看者会看到与截图示例相同的"整窗口"画面\n\n' +
                '是否继续共享？'
            );
            if (!tip) {
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
                displaySurface: 'browser',  // 优先"标签页"共享，避免整个浏览器窗口/屏幕
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
        
        // BUGFIX: P2 默认不渲染自己的屏幕预览，避免本机长时间解码/绘制导致掉帧
        screenStreams.set(userName, screenStream);
        showOwnScreenShareStatus();
        
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
    selfScreenPreviewEnabled = false;
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
            // BUGFIX: A2 双防御：复用 Audio 元素 + 共享 MediaStream（不覆盖已有有效音轨）
            // 如果远端有双 m=audio bug，两个 ontrack 都会把 track 加入同一个共享流，
            // 死 track 贡献静音，活 track 贡献真实音频 → 用户始终能听到声音
            let audio = remoteAudioByUser.get(remoteUserName);
            if (!audio) {
                audio = new Audio();
                audio.id = 'remote-audio-' + remoteUserName;
                audio.srcObject = new MediaStream(); // 初始化为空共享流
                remoteAudioByUser.set(remoteUserName, audio);
                remoteAudioElements.add(audio);
            }
            // 向共享流中添加 track（重复 add 是 no-op）
            if (audio.srcObject && !audio.srcObject.getAudioTracks().includes(event.track)) {
                audio.srcObject.addTrack(event.track);
            }
            audio.muted = !videoEnabled;
            // iOS Safari 拦截 autoplay，需要显式 play()
            audio.play().catch(err => {
                // BUGFIX: A2 renegotiate 期间 play() 被 pause()/AbortError 打断是正常行为
                if (err.name !== 'AbortError') {
                    console.warn('远程音频自动播放被阻止:', err.name, err.message);
                }
            });
            // track 结束时从共享流中移除；只有所有 track 都结束才清空 srcObject
            event.track.onended = () => {
                if (audio.srcObject) {
                    try { audio.srcObject.removeTrack(event.track); } catch(e) {}
                    if (audio.srcObject.getAudioTracks().length === 0) {
                        audio.srcObject = null;
                    }
                }
            };
        }
    };
    
    pc.onconnectionstatechange = () => {
        console.log(`与 ${remoteUserName} 的连接状态:`, pc.connectionState);
        // BUGFIX: W1 短暂断开时等待5秒后尝试 ICE 重启，而非直接放弃
        if (pc.connectionState === 'disconnected') {
            pc._disconnectTimer = setTimeout(() => {
                if (pc.connectionState === 'disconnected' && peerConnections.has(remoteUserName)) {
                    console.log(`[W1] ${remoteUserName} 持续断开，尝试 ICE 重启`);
                    // BUGFIX: C6 仅在 signalingState=stable 时调用 restartIce
                    if (pc.signalingState === 'stable') {
                        pc.restartIce();
                    }
                    createOfferAndSend(pc, remoteUserName).catch(e =>
                        console.warn('[W1] ICE 重启后 offer 失败:', e.message || e));
                }
                pc._disconnectTimer = null;
            }, 5000);
        } else {
            // BUGFIX: C6 清除断开定时器，避免 stale timer 在状态变化后仍触发
            if (pc._disconnectTimer) { clearTimeout(pc._disconnectTimer); pc._disconnectTimer = null; }
        }
        // BUGFIX: M8 failed 状态清理 PC 和相关资源
        if (pc.connectionState === 'failed') {
            console.log(`[M8] ${remoteUserName} 连接失败，清理PC`);
            if (peerConnections.has(remoteUserName)) {
                peerConnections.get(remoteUserName).close();
                peerConnections.delete(remoteUserName);
            }
            // BUGFIX: M14 不再删除 participants —— PC failed 不代表对方离线，
            // 对方可能仍在频道正常说话，只是这条连接死了。
            // 删除会导致 UI 上对方消失，且无法触发自动重建。
            pendingCandidates.delete(remoteUserName);
            remoteAudioElements.forEach(audio => {
                if (audio.id.startsWith('remote-audio-' + remoteUserName)) {
                    audio.srcObject = null;
                    audio.pause();
                    remoteAudioElements.delete(audio);
                }
            });
            remoteAudioByUser.delete(remoteUserName); // BUGFIX: C6 同步清理索引
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
            // BUGFIX: M14 failed 后自动重建 —— 原逻辑只清理不重建，
            // 导致连接永久死亡，必须换用户名（重新触发 user-connected）才能恢复声音。
            scheduleRebuild(remoteUserName, 2000 + Math.random() * 1000);
        }
    };

    return pc;
}

// BUGFIX: M14 连接失败后自动重建
// 原逻辑 failed 后只清理不重建，导致 WebRTC 链路永久死亡，
// 必须换用户名重新登录（触发 user-connected 广播）才能恢复声音。
function scheduleRebuild(remoteUserName, delay) {
    setTimeout(() => {
        if (!currentChannel) return;                      // 已离开频道
        if (!participants.has(remoteUserName)) return;    // 对方已离开
        if (peerConnections.has(remoteUserName)) return;  // 已被其他路径重建
        console.log(`[M14] 自动重建与 ${remoteUserName} 的连接`);
        const pc = createPeerConnection(remoteUserName);
        createOfferAndSend(pc, remoteUserName).catch(e =>
            console.warn('[M14] 重建 offer 失败:', e.message || e));
    }, delay);
}

async function createOfferAndSend(pc, remoteUserName) {
    try {
        // BUGFIX: M15 防交叉协商（glare 竞态）— 双方同时主动建连时，
        // createOffer() 异步完成期间可能已收到并处理了对方 offer。
        // 此时若继续 setLocalDescription 本地 offer，会产生两套交叉不匹配的 SDP，
        // 导致 setRemoteDescription(answer) 报 wrong state，连接永远建立不起来。
        // 守卫：已有 remote description（对方 offer 已接管）或非 stable → 放弃主动发 offer。
        if (pc.remoteDescription || pc.signalingState !== 'stable') {
            console.log('[createOfferAndSend] 跳过：remote 已存在或非 stable, state:', pc.signalingState);
            return;
        }
        // BUGFIX: W4 移除废弃的 offerToReceive 选项，由 addTransceiver 管理
        const offer = await pc.createOffer();
        if (pc.remoteDescription || pc.signalingState !== 'stable') {
            console.log('[createOfferAndSend] createOffer 期间状态变化，放弃发送过期 offer');
            return;
        }
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

// ====== 横竖屏切换（Screen Orientation API） ======
function toggleOrientation() {
    if (!screen.orientation || typeof screen.orientation.lock !== 'function') return;

    const isLandscape = window.innerWidth > window.innerHeight;
    const targetOrientation = isLandscape ? 'portrait' : 'landscape';

    screen.orientation.lock(targetOrientation).catch(err => {
        console.warn('[Orientation] 锁定失败:', err.name, err.message);
    });
}

// 更新 orientation 按钮图标
function updateOrientationBtnIcon() {
    const isLandscape = window.innerWidth > window.innerHeight;
    const isMobile = window.innerWidth <= 768;
    const btns = [screenOrientationBtn, toggleOrientationBtn].filter(Boolean);

    btns.forEach(btn => {
        if (!btn) return;
        btn.classList.remove('portrait', 'landscape');
        btn.classList.add(isLandscape ? 'landscape' : 'portrait');

        // 更新 title
        btn.title = isLandscape ? '锁定竖屏' : '锁定横屏';

        // 更新 SVG 图标方向
        const rect = btn.querySelector('svg rect');
        if (rect) {
            rect.setAttribute('transform',
                isLandscape ? 'rotate(90 12 12)' : 'rotate(0 12 12)');
        }
    });
}

if (screenOrientationBtn) {
    screenOrientationBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleOrientation();
    });
}

if (toggleOrientationBtn) {
    toggleOrientationBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleOrientation();
    });
}

// 监听 orientation / resize 事件更新图标
window.addEventListener('orientationchange', () => {
    setTimeout(updateOrientationBtnIcon, 200);
});
window.addEventListener('resize', () => {
    const isMobile = window.innerWidth <= 768;
    if (isMobile) updateOrientationBtnIcon();
});
// 初始更新
setTimeout(updateOrientationBtnIcon, 500);

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

socket.on('join-error', async (msg) => {
    // BUGFIX: L5/C5 密码错误时用模态框重试替代 prompt()
    if (msg === '密码错误' && currentChannel) {
        const retryPwd = await showPasswordModal(currentChannel.name);
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
    showAlert('加入频道失败: ' + msg);
});

socket.on('channel-list', (list) => {
    console.log('收到频道列表:', list);
    channelList.length = 0;
    channelList.push(...list);
    updateChannelList();
});

// 全局在线用户列表事件
socket.on('online-users', (users) => {
    console.log('收到在线用户列表:', users);
    globalOnlineUsers.clear();
    users.forEach(u => {
        globalOnlineUsers.set(u.name, { ip: u.ip || '' });
    });
    updateOnlineUserList();
});

socket.on('user-online', (data) => {
    console.log('用户上线:', data.name, data.ip);
    globalOnlineUsers.set(data.name, { ip: data.ip || '' });
    updateOnlineUserList();
});

socket.on('user-offline', (data) => {
    console.log('用户离线:', data.name);
    globalOnlineUsers.delete(data.name);
    updateOnlineUserList();
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

socket.on('user-connected', async (data) => {
    // 支持旧格式 (string) 和新格式 { name, ip }
    const remoteUserName = typeof data === 'string' ? data : data.name;
    const remoteIp = typeof data === 'object' ? data.ip : '';
    console.log('用户加入:', remoteUserName, remoteIp ? `(${remoteIp})` : '');
    participants.set(remoteUserName, { audioEnabled: true, screenSharing: false, ip: remoteIp });
    updateParticipantsDisplay();
    updateOnlineUserList();
    
    // BUGFIX: M14 若 room-users 兜底已建连，不再重复建 PC（避免覆盖正在协商的 PC）
    let pc = peerConnections.get(remoteUserName);
    if (!pc) {
        pc = createPeerConnection(remoteUserName);
        await createOfferAndSend(pc, remoteUserName);
    }
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
    remoteAudioByUser.delete(remoteUserName); // BUGFIX: C6 同步清理按用户名索引的 Map

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
    updateOnlineUserList();
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
        // polite端（字典序较小的用户名）执行 rollback，避免比较不同类型数据
        if (pc.signalingState !== 'stable') {
            if (userName < data.from) {
                console.log('[H2] polite端 rollback,', userName, '<', data.from);
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
        // 支持新格式 { name, screenSharing, muted, ip } 和旧格式 (string)
        const name = typeof u === 'string' ? u : u.name;
        const isSharing = typeof u === 'object' ? u.screenSharing : false;
        const isMuted = typeof u === 'object' && u.muted;
        const ip = typeof u === 'object' ? (u.ip || '') : '';
        
        if (name !== userName && !participants.has(name)) {
            participants.set(name, { audioEnabled: !isMuted, screenSharing: isSharing || false, muted: isMuted || false, ip });
        } else if (name !== userName && participants.has(name)) {
            // BUGFIX: C5 保持已有的 audioEnabled 不变，muted 是服务端静音标识
            const p = participants.get(name);
            p.muted = isMuted || false;
            p.screenSharing = isSharing || false;
            if (ip) p.ip = ip;
        }
        // BUGFIX: M14 兜底——room-users 也主动建连，不再完全依赖 user-connected 事件。
        // user-connected 可能因 socket 抖动丢失，导致加入者永远收不到 offer 而无声；
        // 只有换用户名重新加入（重新触发广播）才能恢复。
        // BUGFIX: M15 延迟 800ms 再兜底，给 user-connected 触发的 offer 优先到达的机会，
        // 避免双方同时主动建连导致交叉协商（glare 竞态）。
        if (name !== userName && !peerConnections.has(name)) {
            const fallbackName = name;
            setTimeout(() => {
                if (!currentChannel) return;
                if (peerConnections.has(fallbackName)) return; // user-connected 已建连
                console.log('[M14] room-users 兜底建连:', fallbackName);
                const pc = createPeerConnection(fallbackName);
                createOfferAndSend(pc, fallbackName).catch(e =>
                    console.warn('[M14] room-users 建连 offer 失败:', e.message || e));
            }, 800);
        }
    });
    updateParticipantsDisplay();
    updateOnlineUserList();
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
    speakChatMessage(data);
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
            type: 'text',
            tts: ttsEnabled
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

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (evt) => resolve(evt.target.result);
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}

function loadImageElement(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片格式无法预览'));
        img.src = url;
    });
}

function canvasToDataURL(canvas, quality) {
    return canvas.toDataURL('image/jpeg', quality);
}

async function compressImageForChat(file) {
    const objectUrl = URL.createObjectURL(file);
    try {
        const img = await loadImageElement(objectUrl);
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;
        const maxSide = Math.max(width, height);
        if (maxSide > CHAT_IMAGE_MAX_SIDE) {
            const scale = CHAT_IMAGE_MAX_SIDE / maxSide;
            width = Math.max(1, Math.round(width * scale));
            height = Math.max(1, Math.round(height * scale));
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('浏览器不支持图片压缩');

        for (let sideScale = 1; sideScale >= 0.45; sideScale -= 0.15) {
            canvas.width = Math.max(1, Math.round(width * sideScale));
            canvas.height = Math.max(1, Math.round(height * sideScale));
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            for (let quality = 0.82; quality >= CHAT_IMAGE_MIN_QUALITY; quality -= 0.12) {
                const dataUrl = canvasToDataURL(canvas, quality);
                if (dataUrl.length <= MAX_DATA_MESSAGE_LENGTH) return dataUrl;
            }
        }
        throw new Error('图片压缩后仍超过发送限制');
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function prepareChatImage(file) {
    const originalDataUrl = await readFileAsDataURL(file);
    if (originalDataUrl.length <= MAX_DATA_MESSAGE_LENGTH) return originalDataUrl;

    // BUGFIX: M10 移动端相册原图通常超过服务端 data URL 限制，发送前压缩到可传输大小
    try {
        return await compressImageForChat(file);
    } catch (err) {
        console.warn('[ChatFile] 图片压缩失败:', err.message || err);
        throw new Error('图片过大或格式不支持，请选择 JPG/PNG 图片，或先截图后发送');
    }
}

async function handleChatFile(e) {
    const input = e.target; // 获取触发事件的 input 元素
    const file = input.files[0];
    if (!file) return;
    
    if (!currentChannel) {
        alert('请先加入频道');
        return;
    }

    try {
        if (file.type.startsWith('image/')) {
            const dataUrl = await prepareChatImage(file);
            const imageData = {
                id: ++imageIdCounter, // BUGFIX: L7 自增计数器防碰撞
                dataUrl: dataUrl,
                fileName: file.name,
                type: 'image'
            };
            pendingImages.push(imageData);
            addImagePreview(imageData);
            return;
        }

        const dataUrl = await readFileAsDataURL(file);
        if (dataUrl.length > MAX_DATA_MESSAGE_LENGTH) {
            alert('视频文件过大，当前聊天附件限制约 100KB，请压缩后再发送');
            return;
        }
        const imageData = {
            id: ++imageIdCounter, // BUGFIX: L7 自增计数器防碰撞
            dataUrl: dataUrl,
            fileName: file.name,
            type: 'video'
        };
        pendingImages.push(imageData);
        addImagePreview(imageData);
    } catch (err) {
        alert(err.message || '读取文件失败，请重试');
    }
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
            // BUGFIX: M14 重连带密码（密码频道原逻辑会被服务端拒绝）
            socket.emit('join-channel', { channelId: currentChannel.id, password: currentChannel._password || '' });
        }
    }
});

// R3: 被踢出频道时更新 UI
socket.on('kicked', async (data) => {
    console.log('[R3] 被踢出频道:', data.channel);
    showAlert(`你已被房主请出频道「${data.channel}」`);
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
        updateAudioButtons();
        updateVideoButton();
        toggleScreenShareBtn.classList.remove('screen-active');
        currentChannelName.textContent = '选择一个频道';
        updateParticipantsDisplay();
        updateChannelList();
    }
});

// BUGFIX: N1 管理员清空所有频道（nuke），返回首页
socket.on('nuked', (data) => {
    console.log('[Nuke] 管理员已清空所有频道:', data.reason);
    showAlert(data.reason);
    // 静默清理所有本地状态，不发网络请求
    if (screenSharing) {
        stopScreenShare().catch(e => console.warn('[Nuke] stopScreenShare:', e.message || e));
    }
    cleanupAllMedia();
    currentChannel = null;
    updateScreenShareBar();
    remoteScreenVideo.srcObject = null;
    showScreenShare(null);
    room.classList.remove('chat-only');
    if (toggleChatExpandBtn) toggleChatExpandBtn.classList.remove('active');
    room.classList.add('no-channel');
    channelPlaceholder.classList.remove('hidden');
    participantsContainer.classList.add('hidden');
    updateAudioButtons();
    updateVideoButton();
    toggleScreenShareBtn.classList.remove('screen-active');
    currentChannelName.textContent = '选择一个频道';
    updateParticipantsDisplay();
    // 刷新频道列表（服务器已清空）
    updateChannelList();
    // 清空在线列表
    globalOnlineUsers.clear();
    updateOnlineUserList();
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
        showAlert('当前频道已被删除');
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

