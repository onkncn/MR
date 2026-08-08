#!/bin/bash
# pre-deploy-check.sh — MR 项目部署前验证
# 在 rsync + restart 之前运行，确保代码能正常跑通
set -e

PUBLIC_DIR="/home/onkn/meeting-room2/public"
SERVER_FILE="/home/onkn/meeting-room2/server.js"
APP_FILE="$PUBLIC_DIR/app.js"
HTML_FILE="$PUBLIC_DIR/index.html"
ERRORS=0

red() { echo -e "\033[31m$1\033[0m"; }
green() { echo -e "\033[32m$1\033[0m"; }

echo "========================================"
echo " MR 部署前验证"
echo "========================================"

# ── 1. 语法检查 ──
echo ""
echo "[1/4] 语法检查..."
if node -c "$SERVER_FILE" 2>/dev/null; then
    green "  ✓ server.js 语法通过"
else
    red "  ✗ server.js 语法错误"
    ERRORS=$((ERRORS+1))
fi

if node -c "$APP_FILE" 2>/dev/null; then
    green "  ✓ app.js 语法通过"
else
    red "  ✗ app.js 语法错误"
    ERRORS=$((ERRORS+1))
fi

# ── 2. 新增/修改的函数调用是否已定义 ──
echo ""
echo "[2/4] 函数引用检查（检查 app.js 中调用的函数是否已定义）..."

# 提取所有已定义的函数名
DEFINED_FUNCS=$(grep -oP '(?<=function )\w+|(?<=const )\w+(?= = \(\) =>)|(?<=const )\w+(?= = function)|(?<=let )\w+(?= = \(\) =>)|(?<=let )\w+(?= = function)|(?<=var )\w+(?= = \(\) =>)|(?<=var )\w+(?= = function)' "$APP_FILE" | sort -u)

# 提取所有函数调用 (identifier followed by opening paren)
CALLED_FUNCS=$(grep -oP '\b([a-zA-Z_]\w*)\s*\(' "$APP_FILE" | sed 's/[ (]//g' | sort -u)

# 内置/浏览器/全局函数白名单
BUILTINS="if|for|while|switch|catch|return|throw|new|typeof|instanceof|console|document|window|navigator|alert|setTimeout|setInterval|clearTimeout|clearInterval|fetch|JSON|Math|Date|Array|Object|String|Number|Boolean|Map|Set|Promise|Error|parseInt|parseFloat|isNaN|isFinite|encodeURIComponent|decodeURIComponent|RegExp|Audio|MediaStream|MediaRecorder|RTCPeerConnection|RTCSessionDescription|RTCIceCandidate|RTCRtpTransceiver|RTCRtpSender|addEventListener|removeEventListener|getElementById|querySelector|querySelectorAll|createElement|createDocumentFragment|createTextNode|appendChild|removeChild|classList|getComputedStyle|matchMedia|localStorage|sessionStorage|location|history|Image|FileReader|FormData|Blob|URL|atob|btoa|Intl|performance|requestAnimationFrame|cancelAnimationFrame|navigator|screen|innerWidth|innerHeight|getUserMedia|getDisplayMedia|Event|CustomEvent|MouseEvent|TouchEvent|KeyboardEvent|FocusEvent|InputEvent|DOMParser|XMLSerializer|Range|Selection|Node|Element|HTMLElement|HTMLInputElement|HTMLVideoElement|HTMLAudioElement|HTMLButtonElement|HTMLDivElement|HTMLSpanElement|Text|Comment|setAttribute|getAttribute|removeAttribute|hasAttribute|MutationObserver|IntersectionObserver|ResizeObserver|Notification|SpeechSynthesisUtterance|webkitSpeechRecognition|crypto|Uint8Array|ArrayBuffer|DataView"

MISSING=0
while IFS= read -r func; do
    # 跳过空行和内置函数
    [[ -z "$func" ]] && continue
    [[ "$func" =~ ^[0-9] ]] && continue
    echo "$BUILTINS" | grep -qx "$func" && continue
    # 跳过 JS 关键字
    case "$func" in
        if|else|for|while|do|switch|case|break|continue|return|throw|try|catch|finally|new|typeof|instanceof|void|delete|in|of|async|await|yield|class|extends|super|import|export|default|function|var|let|const|this|true|false|null|undefined) continue ;;
    esac
    # 检查是否已定义
    if ! echo "$DEFINED_FUNCS" | grep -qx "$func"; then
        # 二次确认：用单词边界精确匹配
        if ! grep -q "\b$func\s*=\s*function\|\bfunction\s\+$func\b\|\b$func\s*=\s*(.*)\s*=>\|\b$func\s*=\s*async\s*(" "$APP_FILE"; then
            red "  ✗ 未定义函数: $func()"
            MISSING=$((MISSING+1))
        fi
    fi
done <<< "$CALLED_FUNCS"

if [ $MISSING -eq 0 ]; then
    green "  ✓ 所有函数引用均已定义"
else
    red "  ✗ 发现 $MISSING 个未定义函数引用"
    ERRORS=$((ERRORS+1))
fi

# ── 3. DOM 元素 ID 检查 ──
echo ""
echo "[3/4] DOM 元素 ID 检查（JS 引用的 ID 是否在 HTML 中存在）..."

JS_IDS=$(grep -oP "getElementById\(['\"]\K[^'\"]+" "$APP_FILE" | sort -u)
HTML_IDS=$(grep -oP 'id="([^"]*)"' "$HTML_FILE" | sed 's/id="//;s/"//' | sort -u)

ID_MISSING=0
while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    if ! echo "$HTML_IDS" | grep -qx "$id"; then
        red "  ✗ JS 引用了不存在的 DOM ID: #$id"
        ID_MISSING=$((ID_MISSING+1))
    fi
done <<< "$JS_IDS"

if [ $ID_MISSING -eq 0 ]; then
    green "  ✓ 所有 DOM ID 引用均有效"
else
    red "  ✗ 发现 $ID_MISSING 个无效 DOM ID 引用"
    ERRORS=$((ERRORS+1))
fi

# ── 4. CSS 类名检查（JS 中用到的类名是否在 CSS 中定义） ──
echo ""
echo "[4/4] CSS 类名检查（JS 中使用的类名是否在 CSS 中定义）..."

CSS_CLASSES=$(grep -oP '\.([a-zA-Z_-][\w-]*)' "$PUBLIC_DIR/style.css" | sed 's/^\.//' | sort -u)
JS_CLASSES=$(grep -oP "className\s*=\s*['\"]([^'\"]+)['\"]|classList\.(add|remove|toggle|contains)\(['\"]([^'\"]+)['\"]" "$APP_FILE" | grep -oP "(?<=['\"])[^'\"]+(?=['\"])" | sort -u)

CLASS_MISSING=0
while IFS= read -r cls; do
    [[ -z "$cls" ]] && continue
    # 跳过动态拼接的类名（含空格或 +）
    [[ "$cls" =~ \ |\+ ]] && continue
    # 跳过常见 HTML 属性
    [[ "$cls" == "hidden" || "$cls" == "active" || "$cls" == "open" || "$cls" == "closed" ]] && continue
    if ! echo "$CSS_CLASSES" | grep -qx "$cls"; then
        red "  ✗ JS 引用未定义的 CSS 类: .$cls"
        CLASS_MISSING=$((CLASS_MISSING+1))
    fi
done <<< "$JS_CLASSES"

if [ $CLASS_MISSING -eq 0 ]; then
    green "  ✓ 所有 CSS 类名引用均有效"
else
    red "  ✗ 发现 $CLASS_MISSING 个未定义 CSS 类引用"
    # CSS 类名缺失不阻塞部署（可能是动态类）
fi

# ── 结果 ──
echo ""
echo "========================================"
if [ $ERRORS -eq 0 ]; then
    green " ✅ 全部检查通过，可以部署"
    exit 0
else
    red " ❌ 发现 $ERRORS 项错误，请修复后再部署"
    exit 1
fi
