// xray.js -- X-ray: live agent terminal view inside NotoLink.
//
// Each agent's CLI runs in a tmux session on the server machine. X-ray
// streams `tmux capture-pane` frames over the existing WebSocket into a
// right-side drawer, and forwards occasional keystrokes back — so the user
// never needs a macOS Terminal window per agent, but can still reach the
// real terminal when something needs a manual nudge.

let _xrayAgent = null;         // agent currently being viewed (or null)
let _xrayPinnedToBottom = true;

// --- ANSI (SGR) → HTML -------------------------------------------------------

const _ANSI_BASIC = [
    '#3b4048', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#dcdfe4',
    '#5c6370', '#ff7a85', '#a9d47f', '#f0ca8a', '#74bdff', '#d98ae6', '#6bc6d1', '#ffffff',
];

function _ansi256(n) {
    n = Number(n);
    if (Number.isNaN(n) || n < 0) return null;
    if (n < 16) return _ANSI_BASIC[n];
    if (n < 232) {
        n -= 16;
        const l = [0, 95, 135, 175, 215, 255];
        return `rgb(${l[Math.floor(n / 36)]},${l[Math.floor(n / 6) % 6]},${l[n % 6]})`;
    }
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
}

function ansiToHtml(text) {
    // Strip OSC sequences (titles, hyperlinks) and keep only SGR CSI codes.
    text = text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
    const st = { fg: null, bg: null, bold: false, dim: false, underline: false };
    let out = '';
    let open = false;
    const closeSpan = () => { if (open) { out += '</span>'; open = false; } };
    const openSpan = () => {
        closeSpan();
        const css = [];
        if (st.fg) css.push(`color:${st.fg}`);
        if (st.bg) css.push(`background-color:${st.bg}`);
        if (st.bold) css.push('font-weight:600');
        if (st.dim) css.push('opacity:.62');
        if (st.underline) css.push('text-decoration:underline');
        if (css.length) { out += `<span style="${css.join(';')}">`; open = true; }
    };
    for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
        const m = part.match(/^\x1b\[([0-9;]*)m$/);
        if (m) {
            const codes = (m[1] === '' ? '0' : m[1]).split(';').map(Number);
            for (let i = 0; i < codes.length; i++) {
                const c = codes[i];
                if (c === 0) { st.fg = st.bg = null; st.bold = st.dim = st.underline = false; }
                else if (c === 1) st.bold = true;
                else if (c === 2) st.dim = true;
                else if (c === 4) st.underline = true;
                else if (c === 22) { st.bold = false; st.dim = false; }
                else if (c === 24) st.underline = false;
                else if (c >= 30 && c <= 37) st.fg = _ANSI_BASIC[c - 30];
                else if (c === 38 && codes[i + 1] === 5) { st.fg = _ansi256(codes[i + 2]); i += 2; }
                else if (c === 38 && codes[i + 1] === 2) { st.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
                else if (c === 39) st.fg = null;
                else if (c >= 40 && c <= 47) st.bg = _ANSI_BASIC[c - 40];
                else if (c === 48 && codes[i + 1] === 5) { st.bg = _ansi256(codes[i + 2]); i += 2; }
                else if (c === 48 && codes[i + 1] === 2) { st.bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
                else if (c === 49) st.bg = null;
                else if (c >= 90 && c <= 97) st.fg = _ANSI_BASIC[c - 90 + 8];
                else if (c >= 100 && c <= 107) st.bg = _ANSI_BASIC[c - 100 + 8];
            }
            openSpan();
        } else if (part) {
            // Drop any residual CSI control sequences (cursor moves etc.)
            out += escapeHtml(part.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
        }
    }
    closeSpan();
    return out;
}

// --- Panel -------------------------------------------------------------------

function _xrayPanel() {
    return document.getElementById('xray-panel');
}

function openXray(agent) {
    if (!agent) return;
    if (_xrayAgent === agent && _xrayPanel()) return;   // already open on this agent
    if (_xrayAgent && _xrayAgent !== agent) {
        _xraySend({ type: 'xray_close', agent: _xrayAgent });
    }
    _xrayAgent = agent;
    _xrayPinnedToBottom = true;

    let panel = _xrayPanel();
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'xray-panel';
        document.body.appendChild(panel);
    }
    const color = (typeof getColor === 'function') ? getColor(agent) : '#00BCFF';
    panel.innerHTML = `
        <div class="xray-header">
            <span class="xray-dot" style="background: ${color}"></span>
            <span class="xray-title">${escapeHtml(agent)}</span>
            <span class="xray-session" id="xray-session-label">connecting…</span>
            <button class="xray-close" onclick="closeXray()" title="Close">&times;</button>
        </div>
        <pre id="xray-screen" class="xray-screen">waiting for first frame…</pre>
        <div class="xray-controls">
            <div class="xray-keys">
                <button onclick="_xrayKey('Enter')" title="Enter">⏎</button>
                <button onclick="_xrayKey('C-c')" title="Ctrl-C">^C</button>
                <button onclick="_xrayKey('Escape')" title="Escape">esc</button>
                <button onclick="_xrayKey('Up')" title="Arrow up">↑</button>
                <button onclick="_xrayKey('Down')" title="Arrow down">↓</button>
                <button onclick="_xrayKey('Tab')" title="Tab">⇥</button>
            </div>
            <div class="xray-input-row">
                <input id="xray-input" type="text" placeholder="Type into ${escapeHtml(agent)}'s terminal…" spellcheck="false" autocomplete="off" />
                <button class="xray-send" onclick="_xraySendText()">Send</button>
            </div>
        </div>`;

    const screen = document.getElementById('xray-screen');
    screen.addEventListener('scroll', () => {
        _xrayPinnedToBottom =
            screen.scrollHeight - screen.scrollTop - screen.clientHeight < 30;
    });
    const input = document.getElementById('xray-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _xraySendText(); }
    });

    _xraySend({ type: 'xray_open', agent });
}

function closeXray() {
    if (_xrayAgent) _xraySend({ type: 'xray_close', agent: _xrayAgent });
    _xrayAgent = null;
    const panel = _xrayPanel();
    if (panel) panel.remove();
}

function handleXrayFrame(ev) {
    if (!_xrayAgent || ev.agent !== _xrayAgent) return;
    const screen = document.getElementById('xray-screen');
    const sessionLabel = document.getElementById('xray-session-label');
    if (!screen) return;
    if (ev.error) {
        screen.innerHTML = `<span class="xray-error">${escapeHtml(ev.error)}</span>`;
        if (sessionLabel) sessionLabel.textContent = 'offline';
        return;
    }
    if (sessionLabel && ev.session) sessionLabel.textContent = ev.session;
    screen.innerHTML = ansiToHtml(ev.data || '');
    if (_xrayPinnedToBottom) screen.scrollTop = screen.scrollHeight;
}

// --- Input forwarding ---------------------------------------------------------

function _xraySend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function _xraySendText() {
    if (!_xrayAgent) return;
    const input = document.getElementById('xray-input');
    if (!input || !input.value) return;
    // Text + Enter: the overwhelmingly common case (answering a prompt).
    // Use the key buttons for bare control keys.
    _xraySend({ type: 'xray_input', agent: _xrayAgent, text: input.value, key: 'Enter' });
    input.value = '';
    input.focus();
}

function _xrayKey(key) {
    if (!_xrayAgent) return;
    _xraySend({ type: 'xray_input', agent: _xrayAgent, key });
}

// Re-open the stream after a WS reconnect (the server-side poller died with
// the old socket). Called from chat.js's ws.onopen.
function _xrayOnReconnect() {
    if (_xrayAgent) _xraySend({ type: 'xray_open', agent: _xrayAgent });
}
