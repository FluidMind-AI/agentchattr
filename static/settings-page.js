// settings-page.js — Full-page Settings shell (NotoNote-style).
//
// Replaces the old #settings-bar horizontal strip. Mirrors NotoNote's
// SettingsPage layout: sticky header with back-arrow + gradient title,
// horizontal tab bar inside a glass-strong card, scrollable section cards
// per tab. Implementation is plain JS + plain CSS (no React/Tailwind).
//
// State source-of-truth: window.appSettings (populated by applySettings
// in chat.js whenever a `settings` event arrives over WebSocket). Each
// tab's render fn reads from there. User changes call save handlers that
// dispatch the same `update_settings` WS event the legacy strip used —
// the server broadcasts back, applySettings re-stores, the page re-renders
// the affected tab.

'use strict';

const TABS = [
    { id: 'profile',     label: 'Profile',     icon: 'user' },
    { id: 'appearance',  label: 'Appearance',  icon: 'sparkles' },
    { id: 'defaults',    label: 'Defaults',    icon: 'sliders' },
    { id: 'permissions', label: 'Permissions', icon: 'shield' },
    { id: 'history',     label: 'History',     icon: 'archive' },
    { id: 'advanced',    label: 'Advanced',    icon: 'tool' },
];

let _activeTab = 'profile';
let _saveDebounce = null;

// Used by chat.js to push the latest settings snapshot when the WS event
// arrives. Render functions read from this.
window.appSettings = window.appSettings || {};

function _icon(name) {
    // Tiny inline SVGs — no icon dependency.
    const ICONS = {
        user: '<path d="M8 8a3 3 0 100-6 3 3 0 000 6zM2 14c0-3 2.7-5 6-5s6 2 6 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>',
        sparkles: '<path d="M8 2v4M8 10v4M2 8h4M10 8h4M3 3l2 2M11 11l2 2M13 3l-2 2M5 11l-2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
        sliders: '<path d="M3 4h10M3 8h6M3 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="11" cy="4" r="1.6" fill="currentColor"/><circle cx="7" cy="8" r="1.6" fill="currentColor"/><circle cx="11" cy="12" r="1.6" fill="currentColor"/>',
        shield: '<path d="M8 1.5L2.5 4v4c0 3.5 2.4 6 5.5 7 3.1-1 5.5-3.5 5.5-7V4L8 1.5z" stroke="currentColor" stroke-width="1.3" fill="none"/>',
        archive: '<path d="M2 4h12v3H2zM3 7v6h10V7M6 10h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        tool: '<path d="M11 2l-2 2 3 3 2-2-3-3zM4 13l5-5M4 13l-2 2 1 1 2-2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    };
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function _sessionToken() {
    return window.SESSION_TOKEN || window.__SESSION_TOKEN__ || '';
}

function _saveSettingsDebounced(payload) {
    if (_saveDebounce) clearTimeout(_saveDebounce);
    _saveDebounce = setTimeout(() => {
        if (window.ws && window.ws.readyState === WebSocket.OPEN) {
            window.ws.send(JSON.stringify({ type: 'update_settings', data: payload }));
        }
    }, 150);
}

// --- Tab renderers --------------------------------------------------------

function _renderProfile() {
    const s = window.appSettings;
    return `
        <div class="np-card">
            <h3 class="np-card-title">Profile</h3>
            <div class="np-row">
                <label class="np-label" for="np-username">Display name</label>
                <input class="np-input" id="np-username" type="text" maxlength="20" value="${_esc(s.username || 'user')}">
            </div>
            <p class="np-hint">How you appear in chat. Visible to all agents in this room.</p>
        </div>
    `;
}

function _wireProfile() {
    const el = document.getElementById('np-username');
    if (!el) return;
    el.addEventListener('blur', () => {
        const v = el.value.trim();
        if (v) _saveSettingsDebounced({ username: v });
    });
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') el.blur();
    });
}

function _renderAppearance() {
    const s = window.appSettings;
    const layout = (typeof window.getChannelSidebarMode === 'function') ? window.getChannelSidebarMode() : 'top';
    return `
        <div class="np-card">
            <h3 class="np-card-title">Typography</h3>
            <div class="np-row">
                <label class="np-label" for="np-font">Font</label>
                <select class="np-input" id="np-font">
                    <option value="sans" ${s.font === 'sans' ? 'selected' : ''}>Sans</option>
                    <option value="mono" ${s.font === 'mono' ? 'selected' : ''}>Monospace</option>
                </select>
            </div>
        </div>

        <div class="np-card">
            <h3 class="np-card-title">Contrast</h3>
            <div class="np-options">
                <button class="np-option ${s.contrast !== 'high' ? 'active' : ''}" data-contrast="normal">Normal</button>
                <button class="np-option ${s.contrast === 'high' ? 'active' : ''}" data-contrast="high">High</button>
            </div>
        </div>

        <div class="np-card">
            <h3 class="np-card-title">Channel layout</h3>
            <div class="np-options">
                <button class="np-option ${layout === 'top' ? 'active' : ''}" data-layout="top">Top bar</button>
                <button class="np-option ${layout === 'sidebar' ? 'active' : ''}" data-layout="sidebar">Sidebar</button>
            </div>
            <p class="np-hint">Show channels in a horizontal top bar or a Slack-style sidebar.</p>
        </div>
    `;
}

function _wireAppearance() {
    const fontSel = document.getElementById('np-font');
    if (fontSel) fontSel.addEventListener('change', () => {
        const v = fontSel.value;
        // Apply font class immediately for the same reason as contrast below.
        document.body.classList.remove('font-sans', 'font-mono', 'font-serif');
        document.body.classList.add('font-' + v);
        _saveSettingsDebounced({ font: v });
    });
    document.querySelectorAll('[data-contrast]').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-contrast');
            // Apply immediately so the user sees the change before the WS
            // round-trip lands. applySettings would do this on broadcast,
            // but the lag is jarring for an instantaneous-feel toggle.
            document.body.classList.toggle('high-contrast', mode === 'high');
            _saveSettingsDebounced({ contrast: mode });
            // Re-render so the active option-button updates.
            _renderActiveTab();
        });
    });
    document.querySelectorAll('[data-layout]').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-layout');
            if (typeof window.setChannelSidebarMode === 'function') {
                window.setChannelSidebarMode(mode);
            }
            // Re-render this tab so the active option button updates.
            _renderActiveTab();
        });
    });
}

function _renderDefaults() {
    const s = window.appSettings;
    const hops = s.max_agent_hops ?? 4;
    const refresh = s.rules_refresh_interval ?? 10;
    const history = s.history_limit ?? 'all';
    return `
        <div class="np-card">
            <h3 class="np-card-title">Loop guard</h3>
            <p class="np-hint">Maximum agent-to-agent hops before the router pauses a chain. Per-channel overrides live on the channel bar.</p>
            <div class="np-row">
                <label class="np-label" for="np-hops">Default ceiling</label>
                <input class="np-input np-input-narrow" id="np-hops" type="number" min="1" max="50" value="${hops}">
            </div>
        </div>

        <div class="np-card">
            <h3 class="np-card-title">Rules refresh</h3>
            <p class="np-hint">How often agents re-pull active rules. Per-channel overrides live on the channel bar.</p>
            <div class="np-row">
                <label class="np-label" for="np-rules-refresh">Default interval (seconds)</label>
                <select class="np-input np-input-narrow" id="np-rules-refresh">
                    <option value="0" ${refresh === 0 ? 'selected' : ''}>off</option>
                    <option value="5" ${refresh === 5 ? 'selected' : ''}>5</option>
                    <option value="10" ${refresh === 10 ? 'selected' : ''}>10</option>
                    <option value="20" ${refresh === 20 ? 'selected' : ''}>20</option>
                    <option value="50" ${refresh === 50 ? 'selected' : ''}>50</option>
                </select>
            </div>
        </div>

        <div class="np-card">
            <h3 class="np-card-title">History on connect</h3>
            <p class="np-hint">How many messages the client loads when (re)connecting. "All" loads the full history.</p>
            <div class="np-row">
                <label class="np-label" for="np-history">Limit</label>
                <select class="np-input np-input-narrow" id="np-history">
                    <option value="all" ${String(history) === 'all' ? 'selected' : ''}>All</option>
                    <option value="25" ${String(history) === '25' ? 'selected' : ''}>25</option>
                    <option value="50" ${String(history) === '50' ? 'selected' : ''}>50</option>
                    <option value="100" ${String(history) === '100' ? 'selected' : ''}>100</option>
                    <option value="200" ${String(history) === '200' ? 'selected' : ''}>200</option>
                    <option value="500" ${String(history) === '500' ? 'selected' : ''}>500</option>
                </select>
            </div>
        </div>
    `;
}

function _wireDefaults() {
    const hops = document.getElementById('np-hops');
    if (hops) hops.addEventListener('change', () => {
        const v = parseInt(hops.value, 10);
        if (Number.isFinite(v) && v >= 1 && v <= 50) {
            _saveSettingsDebounced({ max_agent_hops: v });
        }
    });
    const ref = document.getElementById('np-rules-refresh');
    if (ref) ref.addEventListener('change', () => {
        _saveSettingsDebounced({ rules_refresh_interval: parseInt(ref.value, 10) || 0 });
    });
    const hist = document.getElementById('np-history');
    if (hist) hist.addEventListener('change', () => {
        _saveSettingsDebounced({ history_limit: hist.value });
    });
}

function _renderPermissions() {
    return `
        <div class="np-card">
            <h3 class="np-card-title">Defaults</h3>
            <p class="np-hint">Allow / Ask / Deny per tool, applied to every agent unless they have a specific override. Per-agent overrides live on each agent — click their name pill in the header.</p>
            <p class="np-placeholder">Permissions UI coming in the next release.</p>
        </div>
    `;
}

function _wirePermissions() {
    // P4 will populate.
}

function _renderHistory() {
    return `
        <div class="np-card">
            <h3 class="np-card-title">Project export</h3>
            <p class="np-hint">Download a zip archive of the entire project (all channels, jobs, rules, summaries). Channel-only exports live on the channel bar's ⋮ menu.</p>
            <div class="np-row np-row-actions">
                <button class="np-btn" id="np-export">Export project</button>
                <button class="np-btn" id="np-import">Import project</button>
                <input type="file" id="np-import-file" accept=".zip" style="display:none">
            </div>
        </div>
    `;
}

function _wireHistory() {
    const exportBtn = document.getElementById('np-export');
    if (exportBtn) exportBtn.addEventListener('click', () => {
        if (typeof window.exportHistory === 'function') window.exportHistory();
    });
    const importBtn = document.getElementById('np-import');
    const importFile = document.getElementById('np-import-file');
    if (importBtn && importFile) {
        importBtn.addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', () => {
            if (typeof window.importHistory === 'function') window.importHistory(importFile);
        });
    }
}

function _renderAdvanced() {
    return `
        <div class="np-card">
            <h3 class="np-card-title">Advanced</h3>
            <p class="np-placeholder">Reserved for future power-user options (server URL, transport choice, etc.).</p>
        </div>
    `;
}
function _wireAdvanced() {}

const _RENDERERS = {
    profile:     [_renderProfile,     _wireProfile],
    appearance:  [_renderAppearance,  _wireAppearance],
    defaults:    [_renderDefaults,    _wireDefaults],
    permissions: [_renderPermissions, _wirePermissions],
    history:     [_renderHistory,     _wireHistory],
    advanced:    [_renderAdvanced,    _wireAdvanced],
};

function _renderActiveTab() {
    const content = document.getElementById('np-tab-content');
    if (!content) return;
    const [render, wire] = _RENDERERS[_activeTab] || _RENDERERS.profile;
    content.innerHTML = render();
    wire();
}

function _renderShell() {
    const tabs = TABS.map(t => `
        <button class="np-tab ${t.id === _activeTab ? 'active' : ''}" data-tab="${t.id}">
            ${_icon(t.icon)}
            <span>${t.label}</span>
        </button>
    `).join('');

    return `
        <header class="np-header">
            <button class="np-back" id="np-close" aria-label="Close settings">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </button>
            <h1 class="np-title">Settings</h1>
        </header>
        <div class="np-shell np-glass-strong">
            <nav class="np-tabs" role="tablist">${tabs}</nav>
            <div class="np-tab-content" id="np-tab-content"></div>
        </div>
    `;
}

function _wireShell(host) {
    host.querySelector('#np-close').addEventListener('click', () => closeSettings());
    host.querySelectorAll('.np-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            _activeTab = btn.getAttribute('data-tab');
            // Update active state on tabs without re-rendering the whole shell.
            host.querySelectorAll('.np-tab').forEach(b => {
                b.classList.toggle('active', b === btn);
            });
            _renderActiveTab();
        });
    });
}

// --- Public API -----------------------------------------------------------

function openSettings() {
    const host = document.getElementById('settings-page');
    if (!host) return;
    host.innerHTML = _renderShell();
    _wireShell(host);
    _renderActiveTab();
    host.classList.remove('hidden');
    document.getElementById('app').classList.add('settings-active');
    document.addEventListener('keydown', _onSettingsEsc);
}

function closeSettings() {
    const host = document.getElementById('settings-page');
    if (!host) return;
    host.classList.add('hidden');
    host.innerHTML = '';
    document.getElementById('app').classList.remove('settings-active');
    document.removeEventListener('keydown', _onSettingsEsc);
}

function _onSettingsEsc(e) {
    if (e.key === 'Escape') closeSettings();
}

function isOpen() {
    const host = document.getElementById('settings-page');
    return host && !host.classList.contains('hidden');
}

function refreshIfOpen() {
    // Re-render the active tab in place so values stay fresh when the
    // server broadcasts a settings update while the page is visible.
    if (isOpen()) _renderActiveTab();
}

function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

window.openSettingsPage = openSettings;
window.closeSettingsPage = closeSettings;
window.refreshSettingsPage = refreshIfOpen;
