const socket = io();

let localStream;
let audioTrack;
let screenStream;
let userName;
let currentChannel = null;
let audioEnabled = true;
let denoiseEnabled = true;
let screenSharing = false;
let videoEnabled = true; // 扬声器状态

// Web Audio API — 麦克风音量增益 + 音频混合
let audioContext = null;
let micGainNode = null;
let micGainDest = null;
let audioMixDest = null;  // 最终混合输出（麦克风 + 屏幕音频）
const remoteAudioElements = new Set(); // 追踪远程音频元素

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
const screenStreams = new Map(); // 存储每个用户的屏幕共享流
let viewingScreenOf = null; // 当前正在观看谁的屏幕
const channelList = [];

// 从服务端获取 ICE 配置
let configuration = {
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: 'all',
    sdpSemantics: 'unified-plan'
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
const chatFileInput = document.getElementById('chatFileInput');
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

let sidebarOpen = false;
let micVolume = 1;
let speakerVolume = 1;
let pendingImages = [];
let chatMessagesList = [];
let contextMenuChannel = null;
let pendingJoinChannel = false;

// 恢复保存的按钮状态
if (typeof updateVideoButton === 'function') updateVideoButton();

// 有缓存用户名时自动登录
if (userNameInput && userNameInput.value.trim()) {
    login();
}

// 初始化侧边栏状态
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
        if (!isMobile) {
            sidebarOpen = true;
            sidebar.classList.remove('closed');
            sidebar.classList.add('open');
        }
    }
});

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
    document.querySelectorAll('video').forEach(video => {
        video.volume = Math.min(speakerVolume, 1);
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
        remoteScreenVideo.play().catch(() => {});
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
if (screenShareVideoEl) {
    screenShareVideoEl.addEventListener('click', (e) => {
        if (e.target.closest('.screen-fullscreen-btn')) return;
        if (e.target.closest('.screen-play-overlay')) return;
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
chatFileBtn.addEventListener('click', () => {
    if (!currentChannel) {
        alert('请先加入频道');
        return;
    }
    chatFileInput.click();
});
chatFileInput.addEventListener('change', handleChatFile);

function initResizeHandles() {
    const sidebarHandle = document.getElementById('sidebarResizeHandle');
    const chatHandle = document.getElementById('chatResizeHandle');
    let isResizing = false;
    let currentHandle = null;
    
    const startResize = (handle, e) => {
        isResizing = true;
        currentHandle = handle;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    };
    
    const stopResize = () => {
        isResizing = false;
        currentHandle = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    };
    
    const doResize = (e) => {
        if (!isResizing || !currentHandle) return;
        
        if (currentHandle === sidebarHandle) {
            const newWidth = e.clientX;
            const minWidth = 160;
            const maxWidth = 400;
            
            if (newWidth >= minWidth && newWidth <= maxWidth) {
                sidebar.style.width = newWidth + 'px';
            }
        } else if (currentHandle === chatHandle) {
            const newWidth = window.innerWidth - e.clientX;
            const minWidth = 200;
            const maxWidth = 500;
            
            if (newWidth >= minWidth && newWidth <= maxWidth) {
                chatPanel.style.width = newWidth + 'px';
            }
        }
    };
    
    if (sidebarHandle) {
        sidebarHandle.addEventListener('mousedown', (e) => startResize(sidebarHandle, e));
    }
    
    if (chatHandle) {
        chatHandle.addEventListener('mousedown', (e) => startResize(chatHandle, e));
    }
    
    document.addEventListener('mousemove', doResize);
    document.addEventListener('mouseup', stopResize);
}

initResizeHandles();

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
    const input = modal.querySelector('input');
    if (input) {
        input.value = '';
    }
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
    if (audioContext && audioContext.state !== 'closed') { audioContext.close().catch(() => {}); audioContext = null; }
    
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
    if (currentChannel) {
        await leaveChannel();
    }
    
    document.body.style.cursor = 'wait';
    
    try {
        // 加入频道时默认关闭麦克风，如果上次是开的则自动尝试开启
        localStream = new MediaStream();
        audioEnabled = false;
        audioTrack = null;
        currentChannel = channel;
        
        socket.emit('join-channel', channel.id, userName);
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
    }
}

async function leaveChannel() {
    if (!currentChannel) return;
    
    if (screenSharing) {
        await stopScreenShare();
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
    }
    
    peerConnections.forEach(pc => pc.close());
    peerConnections.clear();
    participants.clear();
    
    // 清理远程音频元素
    remoteAudioElements.forEach(audio => {
        audio.srcObject = null;
        audio.pause();
    });
    remoteAudioElements.clear();
    
    socket.emit('leave-channel', currentChannel.id, userName);
    
    currentChannel = null;
    audioTrack = null;
    audioEnabled = false; // 离开频道时麦克风关闭，下次加入时根据保存状态决定
    currentScreenSharer = null;
    viewingScreenOf = null;
    screenStreams.clear();
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
    
    socket.emit('create-channel', name);
    pendingJoinChannel = true;
    closeModal(createModal);
}

async function toggleAudio() {
    if (!currentChannel) {
        alert('请先加入频道');
        return;
    }
    
    if (!audioTrack) {
        // 首次开麦，请求麦克风权限
        try {
            const micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: denoiseEnabled,
                    autoGainControl: true,
                    sampleRate: 48000,
                    sampleSize: 16,
                    channelCount: 1
                },
                video: false
            });
            
            audioTrack = micStream.getAudioTracks()[0];
            
            // 建立 Web Audio API 管线：麦克风 → GainNode → 混合输出
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (!audioMixDest) {
                audioMixDest = audioContext.createMediaStreamDestination();
            }
            const source = audioContext.createMediaStreamSource(micStream);
            micGainNode = audioContext.createGain();
            micGainNode.gain.value = micVolume;
            micGainDest = audioContext.createMediaStreamDestination(); // 用于降噪切换时重连
            source.connect(micGainNode);
            micGainNode.connect(micGainDest);
            micGainNode.connect(audioMixDest); // 混合输出
            
            // 用混合音轨添加到 PeerConnection（单条音频，包含麦克风+屏幕音频）
            const mixedTrack = audioMixDest.stream.getAudioTracks()[0];
            localStream.addTrack(mixedTrack);
            
            // 填充所有已有的 PeerConnection 的音频 transceiver
            // 使用 replaceTrack 而非 addTrack，避免产生重复的音频 m-line
            peerConnections.forEach((pc, peerId) => {
                const audioTransceiver = pc.getTransceivers().find(t => 
                    t.receiver?.track?.kind === 'audio' || 
                    (t.sender && t.sender.track === null && t.receiver?.kind === 'audio')
                );
                if (audioTransceiver) {
                    audioTransceiver.sender.replaceTrack(mixedTrack).then(() => {
                        if (audioTransceiver.direction === 'recvonly') {
                            audioTransceiver.direction = 'sendrecv';
                        }
                        renegotiate(pc, peerId);
                    });
                } else {
                    // 没有预创建的 transceiver（极端情况），退回到 addTrack
                    pc.addTrack(mixedTrack, localStream);
                    renegotiate(pc, peerId);
                }
            });
            
            audioEnabled = true;
        } catch (err) {
            console.error('获取麦克风失败:', err);
            alert('无法访问麦克风，请允许权限');
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
        try {
            // 重新获取音频流，切换降噪设置
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: denoiseEnabled,
                    autoGainControl: true,
                    sampleRate: 48000,
                    sampleSize: 16,
                    channelCount: 1
                },
                video: false
            });
            
            const newTrack = newStream.getAudioTracks()[0];
            
            // 保留之前的 enabled 状态
            newTrack.enabled = audioEnabled;
            
            // 替换本地流中的音轨
            localStream.removeTrack(audioTrack);
            audioTrack.stop();
            audioTrack = newTrack;
            
            // 重新连接 GainNode 管线：新麦克风 → GainNode → 混合输出
            if (micGainNode && audioContext) {
                const source = audioContext.createMediaStreamSource(newStream);
                source.connect(micGainNode);
                if (micGainDest) micGainNode.connect(micGainDest);
                if (audioMixDest) micGainNode.connect(audioMixDest);
            }
            const mixedTrack = audioMixDest ? audioMixDest.stream.getAudioTracks()[0] : (micGainDest ? micGainDest.stream.getAudioTracks()[0] : newTrack);
            
            // 更新本地流
            localStream.removeTrack(localStream.getAudioTracks()[0]);
            localStream.addTrack(mixedTrack);
            
            // 替换所有 PeerConnection 中的音轨
            peerConnections.forEach((pc) => {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
                if (sender) {
                    sender.replaceTrack(mixedTrack);
                }
            });
            
            console.log('AI降噪', denoiseEnabled ? '已开启' : '已关闭');
            console.log('Track settings:', newTrack.getSettings());
        } catch (err) {
            console.error('切换降噪失败:', err);
            // 回滚状态
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
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        
        if (isIOS && !isSafari) {
            alert('⚠️ iOS需要使用 Safari 浏览器\n\n请在 Safari 中打开此页面\n\n当前浏览器：' + navigator.userAgent.substring(0, 50));
            return;
        }
        
        if (isIOS) {
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
        
        if (!isIOS) {
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
                videoSender.replaceTrack(videoTracks[0]);
            } else {
                console.log('添加新的视频轨道');
                pc.addTrack(videoTracks[0], screenStream);
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
        
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        
        if (isIOS) {
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
    const pc = new RTCPeerConnection(configuration);
    peerConnections.set(remoteUserName, pc);
    
    // 始终确保音频收发通道存在
    // 预创建 sendrecv transceiver，开麦时 replaceTrack 填充，不会产生重复 m-line
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
                vSender.setParameters(p).catch(() => {});
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
            audio.autoplay = true;
            audio.muted = !videoEnabled;
            audio.id = 'remote-audio-' + remoteUserName;
            remoteAudioElements.add(audio);
            // 音轨结束时清理
            event.track.onended = () => {
                remoteAudioElements.delete(audio);
            };
        }
    };
    
    // 当 PeerConnection 的 track 发生变化（添加/移除）时自动触发 renegotiation
    // 这样对方才能收到我们的新 track（如屏幕共享）
    let negotiationTimer = null;
    pc.onnegotiationneeded = () => {
        // 防抖：短时间内多次触发只执行一次
        clearTimeout(negotiationTimer);
        negotiationTimer = setTimeout(() => {
            if (pc.signalingState === 'stable') {
                console.log('onnegotiationneeded 触发，开始 renegotiate 与:', remoteUserName);
                renegotiate(pc, remoteUserName);
            } else {
                console.log('onnegotiationneeded 跳过，signalingState:', pc.signalingState);
            }
        }, 100);
    };
    
    pc.onconnectionstatechange = () => {
        console.log(`与 ${remoteUserName} 的连接状态:`, pc.connectionState);
    };
    
    return pc;
}

async function createOfferAndSend(pc, remoteUserName) {
    try {
        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
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
        console.log('触发 renegotiation 与:', remoteUserName);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', {
            sdp: offer,
            from: userName,
            to: remoteUserName
        });
    } catch (err) {
        console.error('Renegotiation 失败:', err);
    }
}

function toggleScreenFullscreen() {
    const container = document.getElementById('screenShareVideo');
    const video = document.getElementById('remoteScreenVideo');
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                 (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    
    if (isIOS) {
        if (video && document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        }
        if (video.webkitPresentationMode !== 'fullscreen') {
            if (video.webkitEnterFullscreen) {
                video.webkitEnterFullscreen();
            } else if (video.requestFullscreen) {
                video.requestFullscreen();
            }
        } else {
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
    if (pendingJoinChannel) {
        pendingJoinChannel = false;
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
        if (audio.id === 'remote-audio-' + remoteUserName) {
            audio.srcObject = null;
            audio.pause();
            remoteAudioElements.delete(audio);
        }
    });
    
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
    console.log('收到 offer 从:', data.from);
    
    // 复用已有的 PeerConnection（renegotiation 场景）
    let pc = peerConnections.get(data.from);
    if (!pc) {
        pc = createPeerConnection(data.from);
    }
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        socket.emit('answer', {
            sdp: answer,
            from: userName,
            to: data.from
        });
    } catch (err) {
        console.error('处理 offer 失败:', err);
    }
});

socket.on('answer', async (data) => {
    if (data.to !== userName) return;
    console.log('收到 answer 从:', data.from);
    
    const pc = peerConnections.get(data.from);
    if (pc) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } catch (err) {
            console.error('处理 answer 失败:', err);
        }
    }
});

socket.on('ice-candidate', async (data) => {
    if (data.to !== userName) return;
    try {
        const pc = peerConnections.get(data.from);
        if (pc && data.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
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
        
        if (name !== userName && !participants.has(name)) {
            participants.set(name, { audioEnabled: true, screenSharing: isSharing || false });
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
        addChatMessage(msgData);
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
        addChatMessage(msgData);
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
                        id: Date.now() + Math.random(),
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

function handleChatFile() {
    const file = chatFileInput.files[0];
    if (!file) return;
    
    if (!currentChannel) {
        alert('请先加入频道');
        chatFileInput.value = '';
        return;
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
        const imageData = {
            id: Date.now() + Math.random(),
            dataUrl: e.target.result,
            fileName: file.name,
            type: file.type.startsWith('image') ? 'image' : 'video'
        };
        pendingImages.push(imageData);
        addImagePreview(imageData);
    };
    reader.readAsDataURL(file);
    chatFileInput.value = '';
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

function openImageModal(imageUrl) {
    const overlay = document.createElement('div');
    overlay.className = 'image-modal-overlay';
    overlay.onclick = closeImageModal;
    
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
    
    function closeImageModal() {
        overlay.remove();
        document.removeEventListener('keydown', handleModalKeydown);
    }
    
    function handleModalKeydown(e) {
        if (e.key === 'Escape') {
            closeImageModal();
        }
    }
}

function toggleChatPanel() { // removed: dead code
}

function clearChatMessages() { // removed: dead code
}
