// channels.js -- Channel tabs, switching, filtering, CRUD
// Extracted from chat.js PR 4.  Reads shared state via window.* bridges.

'use strict';

// ---------------------------------------------------------------------------
// State (local to channels)
// ---------------------------------------------------------------------------

const _channelScrollMsg = {};  // channel name -> message ID at top of viewport

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _getTopVisibleMsgId() {
    const scroll = document.getElementById('timeline');
    const container = document.getElementById('messages');
    if (!scroll || !container) return null;
    const rect = scroll.getBoundingClientRect();
    for (const el of container.children) {
        if (el.style.display === 'none' || !el.dataset.id) continue;
        const elRect = el.getBoundingClientRect();
        if (elRect.bottom > rect.top) return el.dataset.id;
    }
    return null;
}

// Configured members of `channel` that are currently registered (present).
// agentConfig is keyed by lowercase name; channel_members are stored
// lowercase too, but normalize defensively. Used by the channel-tab badges
// so the count reflects who's actually in the channel, not who's allowed.
function _presentChannelMembers(channel) {
    const cfg = (window.channelMembers && window.channelMembers[channel]) || [];
    const reg = window.agentConfig || {};
    return cfg.filter(m => reg[String(m).toLowerCase()]);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderChannelTabs() {
    const container = document.getElementById('channel-tabs');
    if (!container) return;

    // Preserve inline create input if it exists
    const existingCreate = container.querySelector('.channel-inline-create');
    container.innerHTML = '';

    for (const name of window.channelList) {
        const tab = document.createElement('button');
        tab.className = 'channel-tab' + (name === window.activeChannel ? ' active' : '');
        tab.dataset.channel = name;

        const label = document.createElement('span');
        label.className = 'channel-tab-label';
        label.textContent = '# ' + name;
        tab.appendChild(label);

        const unread = window.channelUnread[name] || 0;
        if (unread > 0 && name !== window.activeChannel) {
            const dot = document.createElement('span');
            dot.className = 'channel-unread-dot';
            dot.textContent = unread > 99 ? '99+' : unread;
            tab.appendChild(dot);
        }

        // Members count indicator — reflects who's actually present
        // (configured ∩ registered), not the configured ceiling. Hidden
        // when 0 are present so empty channels don't claim members.
        // Restricted-channel editing lives on the "+" pill above the composer.
        const configuredCount = (window.channelMembers && window.channelMembers[name])
            ? window.channelMembers[name].length : 0;
        const presentCount = _presentChannelMembers(name).length;
        if (configuredCount > 0 && presentCount > 0) {
            const badge = document.createElement('span');
            badge.className = 'ch-members-badge restricted';
            badge.title = presentCount === configuredCount
                ? `${presentCount} agent${presentCount === 1 ? '' : 's'} in this channel`
                : `${presentCount} of ${configuredCount} agents online`;
            badge.innerHTML = `
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="8" cy="6" r="2.6" stroke="currentColor" stroke-width="1.4"/>
                    <path d="M3 13c0-2.4 2.2-4 5-4s5 1.6 5 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                </svg>
                <span class="ch-members-count">${presentCount}</span>
            `;
            tab.appendChild(badge);
        }

        // Edit + delete icons for non-general tabs (visible on hover via CSS)
        if (name !== 'general') {
            const actions = document.createElement('span');
            actions.className = 'channel-tab-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'ch-edit-btn';
            editBtn.title = 'Rename';
            editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
            editBtn.onclick = (e) => { e.stopPropagation(); showChannelRenameDialog(name); };
            actions.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'ch-delete-btn';
            delBtn.title = 'Delete';
            delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V3h4v1M5 4v8.5h6V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            delBtn.onclick = (e) => { e.stopPropagation(); deleteChannel(name); };
            actions.appendChild(delBtn);

            tab.appendChild(actions);
        }

        tab.onclick = (e) => {
            if (e.target.closest('.channel-tab-actions')) return;
            if (name === window.activeChannel) {
                // Second click on active tab -- toggle edit controls
                tab.classList.toggle('editing');
            } else {
                // Clear any editing state, switch channel
                document.querySelectorAll('.channel-tab.editing').forEach(t => t.classList.remove('editing'));
                switchChannel(name);
            }
        };

        container.appendChild(tab);
    }

    // Re-append inline create if it was open
    if (existingCreate) {
        container.appendChild(existingCreate);
    }

    // Update add button disabled state
    const addBtn = document.getElementById('channel-add-btn');
    if (addBtn) {
        addBtn.classList.toggle('disabled', window.channelList.length >= 8);
    }

    renderChannelSidebar();
}

// ---------------------------------------------------------------------------
// Sidebar (Discord/Slack-style vertical list)
// ---------------------------------------------------------------------------

function renderChannelSidebar() {
    const list = document.getElementById('channel-sidebar-list');
    if (!list) return;

    // Preserve inline create/rename if present
    const existingCreate = list.querySelector('.channel-inline-create');
    list.innerHTML = '';

    for (const name of window.channelList) {
        const row = document.createElement('button');
        row.className = 'channel-sidebar-row' + (name === window.activeChannel ? ' active' : '');
        row.dataset.channel = name;

        const label = document.createElement('span');
        label.className = 'channel-sidebar-row-label';
        label.textContent = '# ' + name;
        row.appendChild(label);

        const unread = window.channelUnread[name] || 0;
        if (unread > 0 && name !== window.activeChannel) {
            const dot = document.createElement('span');
            dot.className = 'channel-sidebar-row-unread';
            dot.textContent = unread > 99 ? '99+' : unread;
            row.appendChild(dot);
        }

        // Build actions slot first so the members badge can render after it
        // (keeps the badge column-aligned across all rows: rows without
        // edit/delete buttons would otherwise pull the badge left).
        const actions = document.createElement('span');
        actions.className = 'channel-sidebar-row-actions';

        if (name !== 'general') {
            const editBtn = document.createElement('button');
            editBtn.title = 'Rename';
            editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
            editBtn.onclick = (e) => { e.stopPropagation(); _showSidebarRenameDialog(name); };
            actions.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.title = 'Delete';
            delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V3h4v1M5 4v8.5h6V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            delBtn.onclick = (e) => { e.stopPropagation(); _sidebarConfirmDelete(name, row, label); };
            actions.appendChild(delBtn);
        }

        row.appendChild(actions);

        // Members count indicator — reflects who's actually present
        // (configured ∩ registered). Hidden when 0 present.
        const configuredCountSidebar = (window.channelMembers && window.channelMembers[name])
            ? window.channelMembers[name].length : 0;
        const presentCountSidebar = _presentChannelMembers(name).length;
        if (configuredCountSidebar > 0 && presentCountSidebar > 0) {
            const badge = document.createElement('span');
            badge.className = 'ch-members-badge restricted';
            badge.title = presentCountSidebar === configuredCountSidebar
                ? `${presentCountSidebar} agent${presentCountSidebar === 1 ? '' : 's'} in this channel`
                : `${presentCountSidebar} of ${configuredCountSidebar} agents online`;
            badge.innerHTML = `
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="8" cy="6" r="2.6" stroke="currentColor" stroke-width="1.4"/>
                    <path d="M3 13c0-2.4 2.2-4 5-4s5 1.6 5 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                </svg>
                <span class="ch-members-count">${presentCountSidebar}</span>
            `;
            row.appendChild(badge);
        }

        row.onclick = (e) => {
            if (e.target.closest('.channel-sidebar-row-actions')) return;
            if (name !== window.activeChannel) switchChannel(name);
        };

        list.appendChild(row);
    }

    if (existingCreate) list.appendChild(existingCreate);

    const addBtn = document.getElementById('channel-sidebar-add');
    if (addBtn) {
        addBtn.classList.toggle('disabled', window.channelList.length >= 8);
    }
}

function _showSidebarRenameDialog(oldName) {
    const list = document.getElementById('channel-sidebar-list');
    if (!list) return;
    list.querySelector('.channel-inline-create')?.remove();

    const targetRow = list.querySelector(`.channel-sidebar-row[data-channel="${oldName}"]`);

    const wrapper = document.createElement('div');
    wrapper.className = 'channel-inline-create';

    const prefix = document.createElement('span');
    prefix.className = 'channel-input-prefix';
    prefix.textContent = '#';
    wrapper.appendChild(prefix);

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.value = oldName;
    wrapper.appendChild(input);

    const cleanup = () => { wrapper.remove(); if (targetRow) targetRow.style.display = ''; };

    const confirm = document.createElement('button');
    confirm.className = 'confirm-btn';
    confirm.innerHTML = '&#10003;';
    confirm.title = 'Rename';
    confirm.onclick = () => {
        const newName = input.value.trim().toLowerCase();
        if (!newName || !/^[a-z0-9][a-z0-9\-]{0,19}$/.test(newName)) return;
        if (newName !== oldName) {
            window.ws.send(JSON.stringify({ type: 'channel_rename', old_name: oldName, new_name: newName }));
            if (window.activeChannel === oldName) {
                window._setActiveChannel(newName);
                localStorage.setItem('agentchattr-channel', newName);
                Store.set('activeChannel', newName);
            }
        }
        cleanup();
    };
    wrapper.appendChild(confirm);

    const cancel = document.createElement('button');
    cancel.className = 'cancel-btn';
    cancel.innerHTML = '&#10005;';
    cancel.title = 'Cancel';
    cancel.onclick = cleanup;
    wrapper.appendChild(cancel);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirm.click(); }
        if (e.key === 'Escape') cleanup();
    });
    input.addEventListener('input', () => {
        input.value = input.value.toLowerCase().replace(/[^a-z0-9\-]/g, '');
    });

    if (targetRow) {
        targetRow.style.display = 'none';
        targetRow.insertAdjacentElement('afterend', wrapper);
    } else {
        list.appendChild(wrapper);
    }
    input.select();
}

function _sidebarConfirmDelete(name, row, label) {
    if (name === 'general' || row.classList.contains('confirm-delete')) return;
    const actions = row.querySelector('.channel-sidebar-row-actions');
    const originalText = label.textContent;
    const originalOnclick = row.onclick;

    row.classList.add('confirm-delete');
    label.textContent = `delete #${name}?`;
    if (actions) actions.style.display = 'none';

    const confirmBar = document.createElement('span');
    confirmBar.className = 'channel-sidebar-row-actions';
    confirmBar.style.display = 'flex';

    const tickBtn = document.createElement('button');
    tickBtn.title = 'Confirm delete';
    tickBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const crossBtn = document.createElement('button');
    crossBtn.title = 'Cancel';
    crossBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

    confirmBar.appendChild(tickBtn);
    confirmBar.appendChild(crossBtn);
    row.appendChild(confirmBar);

    const revert = () => {
        row.classList.remove('confirm-delete');
        label.textContent = originalText;
        if (actions) actions.style.display = '';
        confirmBar.remove();
        row.onclick = originalOnclick;
        document.removeEventListener('click', outsideClick);
    };

    tickBtn.onclick = (e) => {
        e.stopPropagation();
        revert();
        window.ws.send(JSON.stringify({ type: 'channel_delete', name }));
        if (window.activeChannel === name) switchChannel('general');
    };
    crossBtn.onclick = (e) => { e.stopPropagation(); revert(); };
    row.onclick = (e) => { e.stopPropagation(); };

    const outsideClick = (e) => { if (!row.contains(e.target)) revert(); };
    setTimeout(() => document.addEventListener('click', outsideClick), 0);
}

// ---------------------------------------------------------------------------
// Switch / filter
// ---------------------------------------------------------------------------

function switchChannel(name) {
    if (name === window.activeChannel) return;
    // Save top-visible message ID for current channel
    const topId = _getTopVisibleMsgId();
    if (topId) _channelScrollMsg[window.activeChannel] = topId;
    window._setActiveChannel(name);
    window.channelUnread[name] = 0;
    localStorage.setItem('agentchattr-channel', name);
    filterMessagesByChannel();
    renderChannelTabs();
    renderChannelSidebar();
    // Re-render the agent strips so they reflect the new channel's roster.
    if (typeof buildStatusPills === 'function') {
        try { buildStatusPills(); } catch (_) {}
    }
    if (typeof buildMentionToggles === 'function') {
        try { buildMentionToggles(); } catch (_) {}
    }
    if (typeof renderChannelChips === 'function') {
        try { renderChannelChips(); } catch (_) {}
    }
    Store.set('activeChannel', name);
    // Restore: scroll to saved message, or bottom if none saved
    const savedId = _channelScrollMsg[name];
    if (savedId) {
        const el = document.querySelector(`.message[data-id="${savedId}"]`);
        if (el) { el.scrollIntoView({ block: 'start' }); return; }
    }
    window.scrollToBottom();
}

function filterMessagesByChannel() {
    const container = document.getElementById('messages');
    if (!container) return;

    for (const el of container.children) {
        const ch = el.dataset.channel || 'general';
        el.style.display = ch === window.activeChannel ? '' : 'none';
    }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function showChannelCreateDialog() {
    if (window.channelList.length >= 8) return;
    // Route the inline create into the sidebar list when sidebar mode is on,
    // otherwise into the top-bar tabs — keeps the input visible either way.
    const inSidebar = document.body.classList.contains('channels-in-sidebar');
    const tabs = inSidebar
        ? document.getElementById('channel-sidebar-list')
        : document.getElementById('channel-tabs');
    // Remove existing inline create if any
    tabs.querySelector('.channel-inline-create')?.remove();

    // Hide the + button while creating
    const addBtn = inSidebar
        ? document.getElementById('channel-sidebar-add')
        : document.getElementById('channel-add-btn');
    if (addBtn) addBtn.style.display = 'none';

    const wrapper = document.createElement('div');
    wrapper.className = 'channel-inline-create';

    const prefix = document.createElement('span');
    prefix.className = 'channel-input-prefix';
    prefix.textContent = '#';
    wrapper.appendChild(prefix);

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.placeholder = 'channel-name';
    wrapper.appendChild(input);

    const cleanup = () => { wrapper.remove(); if (addBtn) addBtn.style.display = ''; };

    const confirm = document.createElement('button');
    confirm.className = 'confirm-btn';
    confirm.innerHTML = '&#10003;';
    confirm.title = 'Create';
    confirm.onclick = () => { _submitInlineCreate(input, wrapper); if (addBtn) addBtn.style.display = ''; };
    wrapper.appendChild(confirm);

    const cancel = document.createElement('button');
    cancel.className = 'cancel-btn';
    cancel.innerHTML = '&#10005;';
    cancel.title = 'Cancel';
    cancel.onclick = cleanup;
    wrapper.appendChild(cancel);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _submitInlineCreate(input, wrapper); if (addBtn) addBtn.style.display = ''; }
        if (e.key === 'Escape') cleanup();
    });
    input.addEventListener('input', () => {
        input.value = input.value.toLowerCase().replace(/[^a-z0-9\-]/g, '');
    });

    tabs.appendChild(wrapper);
    input.focus();
}

function _submitInlineCreate(input, wrapper) {
    const name = input.value.trim().toLowerCase();
    if (!name || !/^[a-z0-9][a-z0-9\-]{0,19}$/.test(name)) return;
    if (window.channelList.includes(name)) { input.focus(); return; }
    window._setPendingChannelSwitch(name);
    window.ws.send(JSON.stringify({ type: 'channel_create', name }));
    wrapper.remove();
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

function showChannelRenameDialog(oldName) {
    const tabs = document.getElementById('channel-tabs');
    tabs.querySelector('.channel-inline-create')?.remove();

    // Find the tab being renamed so we can insert the input in its place
    const targetTab = tabs.querySelector(`.channel-tab[data-channel="${oldName}"]`);

    const wrapper = document.createElement('div');
    wrapper.className = 'channel-inline-create';

    const prefix = document.createElement('span');
    prefix.className = 'channel-input-prefix';
    prefix.textContent = '#';
    wrapper.appendChild(prefix);

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.value = oldName;
    wrapper.appendChild(input);

    const cleanup = () => {
        wrapper.remove();
        if (targetTab) targetTab.style.display = '';
    };

    const confirm = document.createElement('button');
    confirm.className = 'confirm-btn';
    confirm.innerHTML = '&#10003;';
    confirm.title = 'Rename';
    confirm.onclick = () => {
        const newName = input.value.trim().toLowerCase();
        if (!newName || !/^[a-z0-9][a-z0-9\-]{0,19}$/.test(newName)) return;
        if (newName !== oldName) {
            window.ws.send(JSON.stringify({ type: 'channel_rename', old_name: oldName, new_name: newName }));
            if (window.activeChannel === oldName) {
                window._setActiveChannel(newName);
                localStorage.setItem('agentchattr-channel', newName);
                Store.set('activeChannel', newName);
            }
        }
        cleanup();
    };
    wrapper.appendChild(confirm);

    const cancel = document.createElement('button');
    cancel.className = 'cancel-btn';
    cancel.innerHTML = '&#10005;';
    cancel.title = 'Cancel';
    cancel.onclick = cleanup;
    wrapper.appendChild(cancel);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirm.click(); }
        if (e.key === 'Escape') cleanup();
    });
    input.addEventListener('input', () => {
        input.value = input.value.toLowerCase().replace(/[^a-z0-9\-]/g, '');
    });

    // Insert inline next to the tab, hide the original tab
    if (targetTab) {
        targetTab.style.display = 'none';
        targetTab.insertAdjacentElement('afterend', wrapper);
    } else {
        tabs.appendChild(wrapper);
    }
    input.select();
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

function deleteChannel(name) {
    if (name === 'general') return;
    const tab = document.querySelector(`.channel-tab[data-channel="${name}"]`);
    if (!tab || tab.classList.contains('confirm-delete')) return;

    const label = tab.querySelector('.channel-tab-label');
    const actions = tab.querySelector('.channel-tab-actions');
    const originalText = label.textContent;
    const originalOnclick = tab.onclick;

    tab.classList.add('confirm-delete');
    tab.classList.remove('editing');
    label.textContent = `delete #${name}?`;
    if (actions) actions.style.display = 'none';

    const confirmBar = document.createElement('span');
    confirmBar.className = 'channel-delete-confirm';

    const tickBtn = document.createElement('button');
    tickBtn.className = 'ch-confirm-yes';
    tickBtn.title = 'Confirm delete';
    tickBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const crossBtn = document.createElement('button');
    crossBtn.className = 'ch-confirm-no';
    crossBtn.title = 'Cancel';
    crossBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

    confirmBar.appendChild(tickBtn);
    confirmBar.appendChild(crossBtn);
    tab.appendChild(confirmBar);

    const revert = () => {
        tab.classList.remove('confirm-delete');
        label.textContent = originalText;
        if (actions) actions.style.display = '';
        confirmBar.remove();
        tab.onclick = originalOnclick;
        document.removeEventListener('click', outsideClick);
    };

    tickBtn.onclick = (e) => {
        e.stopPropagation();
        revert();
        window.ws.send(JSON.stringify({ type: 'channel_delete', name }));
        if (window.activeChannel === name) switchChannel('general');
    };

    crossBtn.onclick = (e) => {
        e.stopPropagation();
        revert();
    };

    tab.onclick = (e) => { e.stopPropagation(); };

    const outsideClick = (e) => {
        if (!tab.contains(e.target)) revert();
    };
    setTimeout(() => document.addEventListener('click', outsideClick), 0);
}

// ---------------------------------------------------------------------------
// Sidebar mode toggle + resize grip
// ---------------------------------------------------------------------------

const SIDEBAR_MODE_KEY = 'agentchattr-channel-sidebar-mode';
const SIDEBAR_WIDTH_KEY = 'agentchattr-channel-sidebar-w';

function setChannelSidebarMode(mode, persist = true) {
    const sidebar = document.getElementById('channel-sidebar');
    const top = document.getElementById('channel-sidebar-top');
    const support = document.querySelector('.channel-support');
    const updatePill = document.getElementById('update-pill');
    if (!sidebar) return;

    const on = mode === 'sidebar';
    document.body.classList.toggle('channels-in-sidebar', on);
    sidebar.classList.toggle('hidden', !on);

    // Move support link + update pill into the sidebar top when sidebar is
    // active, and back to the top bar when it's off. Update pill goes first
    // so it sits above support when visible.
    const rightBar = document.querySelector('#channel-bar .channel-bar-right');
    if (on && top) {
        if (updatePill && updatePill.parentElement !== top) top.appendChild(updatePill);
        if (support && support.parentElement !== top) top.appendChild(support);
    } else if (!on && rightBar) {
        if (updatePill && updatePill.parentElement !== rightBar) rightBar.appendChild(updatePill);
        if (support && support.parentElement !== rightBar) rightBar.appendChild(support);
    }

    if (persist) localStorage.setItem(SIDEBAR_MODE_KEY, mode);
    const setting = document.getElementById('setting-channel-sidebar');
    if (setting && setting.value !== mode) setting.value = mode;

    if (on) renderChannelSidebar();
    _updateSupportLabel();
}

// Swap "Support development" → "Support" when the sidebar is narrow, so the
// text doesn't truncate. Width threshold tuned to match the pill's padding
// plus the heart glyph.
function _updateSupportLabel() {
    const label = document.querySelector('.channel-support .support-label');
    if (!label) return;
    const inSidebar = document.body.classList.contains('channels-in-sidebar');
    if (!inSidebar) {
        label.textContent = ' Support development';
        return;
    }
    const panel = document.getElementById('channel-sidebar');
    const w = panel ? panel.offsetWidth : 200;
    label.textContent = w < 200 ? ' Support' : ' Support development';
}

function setupChannelSidebarGrip() {
    const grip = document.getElementById('channel-sidebar-grip');
    const panel = document.getElementById('channel-sidebar');
    if (!grip || !panel) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        grip.classList.add('dragging');
        panel.style.transition = 'none';
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        // Sidebar is on the left, so dragging right grows it (positive delta).
        const delta = e.clientX - startX;
        const newWidth = Math.min(Math.max(startWidth + delta, 140), 400);
        panel.style.setProperty('--channel-sidebar-w', newWidth + 'px');
        panel.style.width = newWidth + 'px';
        _updateSupportLabel();
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        grip.classList.remove('dragging');
        panel.style.transition = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem(SIDEBAR_WIDTH_KEY, panel.offsetWidth);
    });
}

function _restoreSidebarState() {
    const savedWidth = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '', 10);
    if (savedWidth && savedWidth >= 140 && savedWidth <= 400) {
        const panel = document.getElementById('channel-sidebar');
        if (panel) {
            panel.style.setProperty('--channel-sidebar-w', savedWidth + 'px');
            panel.style.width = savedWidth + 'px';
        }
    }
    const savedMode = localStorage.getItem(SIDEBAR_MODE_KEY) || 'sidebar';
    setChannelSidebarMode(savedMode, false);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// Keep Clear Chat the same pixel width as the send-group so its left edge
// aligns with the Send button's left edge. Pure CSS can't match another
// element's measured width, so we sync via JS on load + resize.
function _syncClearChatWidth() {
    const clearBtn = document.getElementById('clear-chat-btn');
    const sendGroup = document.querySelector('#input-row .send-group');
    if (!clearBtn || !sendGroup) return;
    const w = sendGroup.offsetWidth;
    if (w > 0) clearBtn.style.width = w + 'px';
}

function _channelsInit() {
    setupChannelSidebarGrip();
    _restoreSidebarState();

    const setting = document.getElementById('setting-channel-sidebar');
    if (setting) {
        setting.addEventListener('change', () => setChannelSidebarMode(setting.value));
    }

    requestAnimationFrame(_syncClearChatWidth);
    window.addEventListener('resize', _syncClearChatWidth);
}

// ---------------------------------------------------------------------------
// Window exports (for inline onclick in index.html and chat.js callers)
// ---------------------------------------------------------------------------

window.showChannelCreateDialog = showChannelCreateDialog;
window.switchChannel = switchChannel;
window.filterMessagesByChannel = filterMessagesByChannel;
window.renderChannelTabs = renderChannelTabs;
window.deleteChannel = deleteChannel;
window.showChannelRenameDialog = showChannelRenameDialog;
window.renderChannelSidebar = renderChannelSidebar;
window.setChannelSidebarMode = setChannelSidebarMode;
window.Channels = { init: _channelsInit };


// ---------------------------------------------------------------------------
// Channel-bar chips (loop guard, rules refresh, channel ⋮ menu)
// ---------------------------------------------------------------------------
//
// Each chip mirrors a piece of channel-scoped state. The value shown is the
// resolved override-or-default, with a visible "overridden" treatment when
// the active channel has its own value set. Click → small popover anchored
// to the chip with an inline editor + "Reset to default" link. PUT to
// /api/channels/{name}/settings; the server broadcasts updated settings
// over WebSocket and we re-render via applySettings.
//
// Source-of-truth state on window: `roomDefaults` (room-level defaults) and
// `channelSettings` (per-channel overrides). Both are populated by
// applySettings() in chat.js whenever a `settings` event arrives.

const _CHIP_DEFS = {
    loop_guard: {
        key: 'max_agent_hops',
        label: 'Loop',
        defaultValue: 4,
        format: v => String(v),
        title: 'Loop guard: max agent-to-agent hops in this channel',
    },
    rules_refresh: {
        key: 'rules_refresh_interval',
        label: 'Rules',
        defaultValue: 10,
        format: v => v === 0 ? 'off' : `${v}s`,
        title: 'Rules refresh interval (seconds) for this channel',
    },
};

function _resolveChannelChipValue(channelName, defKey) {
    const def = _CHIP_DEFS[defKey];
    const override = (window.channelSettings && window.channelSettings[channelName] || {})[def.key];
    if (override !== undefined && override !== null) {
        return { value: override, overridden: true };
    }
    const roomDefault = (window.roomDefaults || {})[def.key];
    if (roomDefault !== undefined && roomDefault !== null) {
        return { value: roomDefault, overridden: false };
    }
    return { value: def.defaultValue, overridden: false };
}

function renderChannelChips() {
    const host = document.getElementById('channel-bar-chips');
    if (!host) return;
    const channel = window.activeChannel || 'general';
    host.innerHTML = '';

    for (const defKey of ['loop_guard', 'rules_refresh']) {
        const def = _CHIP_DEFS[defKey];
        const { value, overridden } = _resolveChannelChipValue(channel, defKey);
        const chip = document.createElement('button');
        chip.className = 'ch-chip' + (overridden ? ' overridden' : '');
        chip.id = `ch-chip-${defKey}`;
        chip.title = def.title;
        chip.innerHTML = `
            <span class="ch-chip-label">${def.label}</span>
            <span class="ch-chip-value">${def.format(value)}</span>
        `;
        chip.onclick = (e) => { e.stopPropagation(); _toggleChipPopover(chip, defKey, channel); };
        host.appendChild(chip);
    }

    // Channel ⋮ menu: export this channel, clear chat
    const menuChip = document.createElement('button');
    menuChip.className = 'ch-chip ch-chip-menu';
    menuChip.id = 'ch-chip-menu';
    menuChip.title = 'Channel actions';
    menuChip.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>`;
    menuChip.onclick = (e) => { e.stopPropagation(); _toggleChipPopover(menuChip, 'menu', channel); };
    host.appendChild(menuChip);
}

let _openChipPopover = null;

function _closeChipPopover() {
    if (_openChipPopover) {
        _openChipPopover.remove();
        _openChipPopover = null;
        document.removeEventListener('click', _onChipPopoverOutside, true);
        document.removeEventListener('keydown', _onChipPopoverEsc);
    }
}

function _onChipPopoverOutside(e) {
    if (_openChipPopover && !_openChipPopover.contains(e.target)) {
        _closeChipPopover();
    }
}

function _onChipPopoverEsc(e) {
    if (e.key === 'Escape') _closeChipPopover();
}

function _toggleChipPopover(anchor, kind, channel) {
    if (_openChipPopover && _openChipPopover.dataset.kind === kind) {
        _closeChipPopover();
        return;
    }
    _closeChipPopover();
    const pop = document.createElement('div');
    pop.className = 'ch-chip-popover';
    pop.dataset.kind = kind;

    if (kind === 'loop_guard') {
        const { value, overridden } = _resolveChannelChipValue(channel, 'loop_guard');
        pop.innerHTML = `
            <div class="ccp-title">Loop guard for #${channel}</div>
            <div class="ccp-row">
                <input type="number" min="1" max="50" value="${value}" class="ccp-input">
                <button class="ccp-save">Set</button>
            </div>
            <div class="ccp-foot">
                ${overridden
                    ? `<a class="ccp-reset" href="#">Reset to default</a>`
                    : `<span class="ccp-hint">Default from Settings → Defaults</span>`}
            </div>
        `;
        const input = pop.querySelector('.ccp-input');
        const save = pop.querySelector('.ccp-save');
        const reset = pop.querySelector('.ccp-reset');
        save.onclick = () => _putChannelSetting(channel, { max_agent_hops: parseInt(input.value, 10) || 4 });
        if (reset) reset.onclick = (e) => { e.preventDefault(); _putChannelSetting(channel, { max_agent_hops: null }); };
    } else if (kind === 'rules_refresh') {
        const { value, overridden } = _resolveChannelChipValue(channel, 'rules_refresh');
        const options = [0, 5, 10, 20, 50];
        pop.innerHTML = `
            <div class="ccp-title">Rules refresh for #${channel}</div>
            <div class="ccp-row">
                <select class="ccp-input">
                    ${options.map(o => `<option value="${o}" ${o === value ? 'selected' : ''}>${o === 0 ? 'off' : o + 's'}</option>`).join('')}
                </select>
                <button class="ccp-save">Set</button>
            </div>
            <div class="ccp-foot">
                ${overridden
                    ? `<a class="ccp-reset" href="#">Reset to default</a>`
                    : `<span class="ccp-hint">Default from Settings → Defaults</span>`}
            </div>
        `;
        const select = pop.querySelector('.ccp-input');
        const save = pop.querySelector('.ccp-save');
        const reset = pop.querySelector('.ccp-reset');
        save.onclick = () => _putChannelSetting(channel, { rules_refresh_interval: parseInt(select.value, 10) || 0 });
        if (reset) reset.onclick = (e) => { e.preventDefault(); _putChannelSetting(channel, { rules_refresh_interval: null }); };
    } else if (kind === 'menu') {
        pop.classList.add('ch-chip-popover--menu');
        pop.innerHTML = `
            <button class="ccp-menu-item" data-action="export">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1v9M4 6l4-5 4 5M2 12v3h12v-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Export this channel
            </button>
            <button class="ccp-menu-item" data-action="clear">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V3h4v1M5 4v8.5h6V4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Clear chat
            </button>
        `;
        pop.querySelector('[data-action="export"]').onclick = () => { _closeChipPopover(); _exportChannel(channel); };
        pop.querySelector('[data-action="clear"]').onclick = () => { _closeChipPopover(); if (typeof window.clearChat === 'function') window.clearChat(); };
    }

    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = (rect.bottom + 6) + 'px';
    // Right-align under the anchor; clamp to viewport.
    const popRect = pop.getBoundingClientRect();
    let left = rect.right - popRect.width;
    if (left < 8) left = 8;
    if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
    pop.style.left = left + 'px';
    _openChipPopover = pop;
    setTimeout(() => {
        document.addEventListener('click', _onChipPopoverOutside, true);
        document.addEventListener('keydown', _onChipPopoverEsc);
    }, 0);
}

function _putChannelSetting(channel, body) {
    const tok = window.SESSION_TOKEN || window.__SESSION_TOKEN__ || '';
    fetch(`/api/channels/${encodeURIComponent(channel)}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': tok },
        body: JSON.stringify(body),
    }).then(r => {
        if (!r.ok) console.warn('channel settings PUT failed:', r.status);
    }).finally(_closeChipPopover);
    // Server broadcasts updated settings → applySettings → renderChannelChips,
    // so we don't need to re-render here.
}

function _exportChannel(channel) {
    const tok = window.SESSION_TOKEN || window.__SESSION_TOKEN__ || '';
    const url = `/api/channels/${encodeURIComponent(channel)}/export?token=${encodeURIComponent(tok)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

window.renderChannelChips = renderChannelChips;


// ---------------------------------------------------------------------------
// Channel members modal
// ---------------------------------------------------------------------------
//
// Opens when the user clicks the "+ members" icon on a channel row.
// Shows a search-filterable checkbox list of all registered agents; checked
// items become the channel's explicit member list. Empty list = the channel
// is "open" (all agents allowed — backwards-compatible default).

function showChannelMembersModal(channelName) {
    // Tear down any prior instance.
    document.querySelectorAll('.channel-members-modal-backdrop').forEach(el => el.remove());

    const backdrop = document.createElement('div');
    backdrop.className = 'channel-members-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'channel-members-modal';

    const header = document.createElement('div');
    header.className = 'channel-members-modal-header';
    const title = document.createElement('div');
    title.className = 'channel-members-modal-title';
    title.textContent = `Manage agents in #${channelName}`;
    const subtitle = document.createElement('div');
    subtitle.className = 'channel-members-modal-subtitle';
    subtitle.textContent = 'Empty = open (all agents). Check agents to restrict to that set.';
    header.appendChild(title);
    header.appendChild(subtitle);
    modal.appendChild(header);

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search agents…';
    search.className = 'channel-members-modal-search';
    modal.appendChild(search);

    const list = document.createElement('div');
    list.className = 'channel-members-modal-list';
    modal.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'channel-members-modal-footer';
    const cancel = document.createElement('button');
    cancel.className = 'channel-members-modal-cancel';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.className = 'channel-members-modal-save';
    save.textContent = 'Save';
    footer.appendChild(cancel);
    footer.appendChild(save);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const currentMembers = new Set((window.channelMembers && window.channelMembers[channelName]) || []);
    const allAgents = Object.entries(window.agentConfig || {})
        .filter(([_, cfg]) => cfg && cfg.state !== 'pending')
        .map(([name, cfg]) => ({ name, label: cfg.label || name }));
    allAgents.sort((a, b) => a.label.localeCompare(b.label));

    function renderList(filterText) {
        list.innerHTML = '';
        const q = (filterText || '').toLowerCase();
        const matches = allAgents.filter(a =>
            !q || a.label.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
        );
        if (matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'channel-members-modal-empty';
            empty.textContent = 'No matching agents.';
            list.appendChild(empty);
            return;
        }
        for (const agent of matches) {
            const row = document.createElement('label');
            row.className = 'channel-members-modal-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = currentMembers.has(agent.name);
            cb.dataset.agent = agent.name;
            cb.onchange = () => {
                if (cb.checked) currentMembers.add(agent.name);
                else currentMembers.delete(agent.name);
            };
            const txt = document.createElement('span');
            txt.textContent = agent.label;
            const handle = document.createElement('span');
            handle.className = 'channel-members-modal-handle';
            handle.textContent = '@' + agent.name;
            row.appendChild(cb);
            row.appendChild(txt);
            row.appendChild(handle);
            list.appendChild(row);
        }
    }
    renderList('');
    search.oninput = () => renderList(search.value);
    setTimeout(() => search.focus(), 50);

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    cancel.onclick = close;
    document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape') {
            close();
            document.removeEventListener('keydown', onEsc);
        }
    });

    save.onclick = async () => {
        const sessionToken = window.__SESSION_TOKEN__ || '';
        const agents = Array.from(currentMembers);
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
            const resp = await fetch(`/api/channels/${encodeURIComponent(channelName)}/members`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Token': sessionToken,
                },
                body: JSON.stringify({ agents }),
            });
            if (!resp.ok) {
                const err = await resp.text();
                save.disabled = false;
                save.textContent = 'Save';
                alert('Failed to save: ' + err);
                return;
            }
            // The server will broadcast a settings update which re-renders the
            // sidebar + pills. Just close the modal.
            close();
        } catch (err) {
            save.disabled = false;
            save.textContent = 'Save';
            alert('Failed to save: ' + err);
        }
    };
}

window.showChannelMembersModal = showChannelMembersModal;
