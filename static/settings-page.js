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
        _saveSettingsDebounced({ font: fontSel.value });
    });
    document.querySelectorAll('[data-contrast]').forEach(btn => {
        btn.addEventListener('click', () => {
            _saveSettingsDebounced({ contrast: btn.getAttribute('data-contrast') });
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

// --- Permissions: defaults tab ---
//
// Per-agent overrides do NOT live here — they live on each agent (open the
// pill popover, click Permissions). This tab is the global "what's the
// policy for everyone unless an agent overrides" surface.

const _PERMS_DECISIONS = ['allow', 'ask', 'deny'];
const _TIER_LABELS = {
    0: 'Tier 0 — Read-only',
    1: 'Tier 1 — Self-state',
    2: 'Tier 2 — Other-agent',
    3: 'Tier 3 — Environment',
};

async function _fetchPerms() {
    try {
        const tok = window.SESSION_TOKEN || window.__SESSION_TOKEN__ || '';
        const r = await fetch('/api/permissions', { headers: { 'X-Session-Token': tok } });
        if (!r.ok) return null;
        return await r.json();
    } catch (_) { return null; }
}

function _groupToolsByTier(toolTiers) {
    const groups = { 0: [], 1: [], 2: [], 3: [] };
    for (const [tool, tier] of Object.entries(toolTiers || {})) {
        const t = Math.max(0, Math.min(3, tier | 0));
        groups[t].push(tool);
    }
    for (const k of Object.keys(groups)) groups[k].sort();
    return groups;
}

// Engine-shipped defaults are returned by /api/permissions in
// `default_tier_policy`. Fall back to a hardcoded mirror only if the
// endpoint hasn't been called yet (or the field is absent — older
// servers). Use _setEngineDefaults to keep this in sync after each fetch.
let _engineDefaults = { 0: 'allow', 1: 'allow', 2: 'deny', 3: 'ask' };
function _setEngineDefaults(map) {
    if (!map || typeof map !== 'object') return;
    const out = {};
    for (const k of [0, 1, 2, 3]) {
        const v = map[k] ?? map[String(k)];
        if (_PERMS_DECISIONS.includes(v)) out[k] = v;
    }
    if (Object.keys(out).length) _engineDefaults = { ..._engineDefaults, ...out };
}

function _resolveDefault(tier, perms) {
    const defaults = (perms || {})._defaults || {};
    const v = defaults[`tier_${tier}`];
    if (_PERMS_DECISIONS.includes(v)) return v;
    return _engineDefaults[tier] || 'deny';
}

function _renderDecisionGroup(scope, key, current) {
    return `
        <span class="np-perms-decisions" data-scope="${scope}" data-key="${key}">
            ${_PERMS_DECISIONS.map(d => `
                <button type="button" class="np-perms-pill np-perms-${d} ${current === d ? 'active' : ''}" data-decision="${d}">${d}</button>
            `).join('')}
        </span>
    `;
}

function _renderPermsDefaultsBlock(perms, toolTiers) {
    const groups = _groupToolsByTier(toolTiers);
    let html = '';
    // Always render every tier 0-3 so the "Bucket default" pill is always
    // editable, even for tiers that don't have any tools registered yet
    // (e.g. tier-3 today). The backend accepts tier_3 — there's no reason
    // the UI shouldn't surface it.
    for (const tier of [0, 1, 2, 3]) {
        const tools = groups[tier];
        const tierKey = `tier_${tier}`;
        const tierVal = ((perms._defaults || {})[tierKey]) || _resolveDefault(tier, perms);
        const empty = !tools.length;
        html += `
            <div class="np-perms-tier${empty ? ' empty' : ''}">
                <div class="np-perms-tier-header">
                    <span class="np-perms-tier-label">${_TIER_LABELS[tier]}</span>
                    <span class="np-perms-tier-row">
                        <span class="np-perms-tier-hint">${empty ? 'No tools registered yet' : 'Bucket default'}</span>
                        ${_renderDecisionGroup('tier', tierKey, tierVal)}
                    </span>
                </div>
            </div>
        `;
    }
    return html;
}

function _renderPermissions() {
    return `
        <div class="np-card">
            <h3 class="np-card-title">Defaults</h3>
            <p class="np-hint">These apply to every agent unless that agent has a specific override. Per-agent overrides live on each agent — click their name pill in the header.</p>
            <div id="np-perms-defaults"><p class="np-placeholder">Loading…</p></div>
        </div>
    `;
}

async function _wirePermissions() {
    const host = document.getElementById('np-perms-defaults');
    if (!host) return;
    const data = await _fetchPerms();
    if (data) _setEngineDefaults(data.default_tier_policy);
    if (!data) {
        host.innerHTML = '<p class="np-placeholder">Could not load permissions.</p>';
        return;
    }
    host.innerHTML = _renderPermsDefaultsBlock(data.permissions, data.tool_tiers);
    host.addEventListener('click', _onPermsDefaultsClick);
}

async function _putDefaults(body) {
    try {
        const tok = window.SESSION_TOKEN || window.__SESSION_TOKEN__ || '';
        await fetch('/api/permissions/_defaults', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Session-Token': tok },
            body: JSON.stringify(body),
        });
    } catch (e) { console.warn('PUT defaults failed', e); }
}

function _onPermsDefaultsClick(e) {
    const btn = e.target.closest('.np-perms-pill');
    if (!btn) return;
    const group = btn.closest('.np-perms-decisions');
    if (!group) return;
    const key = group.dataset.key;
    const decision = btn.dataset.decision;
    group.querySelectorAll('.np-perms-pill').forEach(b => b.classList.toggle('active', b === btn));
    _putDefaults({ [key]: decision });
}

// --- Per-agent permissions panel (opened from the pill popover) ---

async function _putAgentOverride(agent, overrides) {
    try {
        const tok = window.SESSION_TOKEN || window.__SESSION_TOKEN__ || '';
        await fetch(`/api/permissions/${encodeURIComponent(agent)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Session-Token': tok },
            body: JSON.stringify({ overrides }),
        });
    } catch (e) { console.warn('PUT agent override failed', e); }
}

async function _deleteAgentPerms(agent) {
    try {
        const tok = window.SESSION_TOKEN || window.__SESSION_TOKEN__ || '';
        await fetch(`/api/permissions/${encodeURIComponent(agent)}`, {
            method: 'DELETE',
            headers: { 'X-Session-Token': tok },
        });
    } catch (e) { console.warn('DELETE agent perms failed', e); }
}

async function _populateAgentPanel(panel, agent) {
    const body = panel.querySelector('.np-agent-perms-body');
    body.innerHTML = '<p class="np-placeholder">Loading…</p>';
    const data = await _fetchPerms();
    if (!data) {
        body.innerHTML = '<p class="np-placeholder">Could not load permissions.</p>';
        return;
    }
    _setEngineDefaults(data.default_tier_policy);
    const groups = _groupToolsByTier(data.tool_tiers);
    const overrides = (data.permissions[agent] || {});
    let html = '';
    for (const tier of [0, 1, 2, 3]) {
        const tools = groups[tier];
        if (!tools.length) continue;
        html += `<div class="np-agent-perms-tier"><div class="np-agent-perms-tier-label">${_TIER_LABELS[tier]}</div>`;
        for (const tool of tools) {
            const def = ((data.permissions._defaults || {})[`tier_${tier}`]) || _resolveDefault(tier, data.permissions);
            const overrideVal = overrides[tool];
            const overridden = _PERMS_DECISIONS.includes(overrideVal);
            const effective = overridden ? overrideVal : def;
            html += `
                <div class="np-agent-perms-row ${overridden ? 'overridden' : ''}" data-tool="${tool}">
                    <div class="np-agent-perms-tool">
                        <span class="np-agent-perms-tool-name">${tool}</span>
                        <span class="np-agent-perms-default-badge">Default: ${def}</span>
                    </div>
                    <div class="np-agent-perms-decisions">
                        ${_PERMS_DECISIONS.map(d => `
                            <button class="np-perms-pill np-perms-${d} ${effective === d && overridden ? 'active' : ''}" data-decision="${d}">${d}</button>
                        `).join('')}
                        ${overridden ? `<button class="np-agent-perms-clear" title="Clear override">↺</button>` : ''}
                    </div>
                </div>
            `;
        }
        html += '</div>';
    }
    body.innerHTML = html;
    body.onclick = (e) => _onAgentPermsClick(e, panel, agent);
}

function _onAgentPermsClick(e, panel, agent) {
    const row = e.target.closest('.np-agent-perms-row');
    if (!row) return;
    const tool = row.dataset.tool;
    if (e.target.classList.contains('np-agent-perms-clear')) {
        _putAgentOverride(agent, { [tool]: null }).then(() => _populateAgentPanel(panel, agent));
        return;
    }
    const btn = e.target.closest('.np-perms-pill');
    if (!btn) return;
    _putAgentOverride(agent, { [tool]: btn.dataset.decision }).then(() => _populateAgentPanel(panel, agent));
}

function openAgentPermissionsPanel(agentName, anchorEl) {
    document.querySelectorAll('.np-agent-perms-panel').forEach(p => p.remove());

    const panel = document.createElement('div');
    panel.className = 'np-agent-perms-panel np-glass-strong';
    panel.dataset.agent = agentName;
    panel.innerHTML = `
        <div class="np-agent-perms-header">
            <strong>Permissions for ${_esc(agentName)}</strong>
            <button class="np-agent-perms-close" aria-label="Close">×</button>
        </div>
        <div class="np-agent-perms-body"><p class="np-placeholder">Loading…</p></div>
        <div class="np-agent-perms-foot">
            <a href="#" class="np-agent-perms-reset">Reset all overrides</a>
        </div>
    `;
    document.body.appendChild(panel);

    if (anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        const w = 360;
        let left = rect.left;
        if (left + w > window.innerWidth - 12) left = window.innerWidth - w - 12;
        if (left < 12) left = 12;
        panel.style.position = 'fixed';
        panel.style.top = `${rect.bottom + 8}px`;
        panel.style.left = `${left}px`;
        panel.style.width = `${w}px`;
    } else {
        panel.style.position = 'fixed';
        panel.style.top = '50%';
        panel.style.left = '50%';
        panel.style.transform = 'translate(-50%, -50%)';
        panel.style.width = '360px';
    }

    panel.querySelector('.np-agent-perms-close').addEventListener('click', () => panel.remove());
    panel.querySelector('.np-agent-perms-reset').addEventListener('click', async (e) => {
        e.preventDefault();
        await _deleteAgentPerms(agentName);
        await _populateAgentPanel(panel, agentName);
    });

    setTimeout(() => {
        const handler = (ev) => {
            if (!panel.contains(ev.target)) {
                panel.remove();
                document.removeEventListener('click', handler, true);
            }
        };
        document.addEventListener('click', handler, true);
    }, 0);

    _populateAgentPanel(panel, agentName);
}

window.openAgentPermissionsPanel = openAgentPermissionsPanel;

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
