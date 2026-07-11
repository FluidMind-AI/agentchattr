// hub.js -- Noto hub: routing cards, origin badges, route receipts.
//
// The hub channel (settings.hub_channel, default "general") is the user's
// front door. The hub agent (noto) routes work out to other channels; those
// sends wait in a server-side outbox for a grace window, surfaced here as
// cancellable routing cards. Messages relayed INTO the hub carry
// origin_channel metadata and get a "from #channel" badge; replying to them
// auto-routes back to the origin channel (server-side), previewed by a chip
// on the composer's reply banner.

window.hubChannel = window.hubChannel || 'general';
window.hubAgent = window.hubAgent || 'noto';

// ---------------------------------------------------------------------------
// Routing cards (ephemeral, driven by WS 'route' events)
// ---------------------------------------------------------------------------

const _routeCards = {};   // route_id -> { el, interval }

function _routeCardEl(routeId) {
    return document.querySelector(`.route-card-msg[data-route-id="${routeId}"]`);
}

function handleRouteEvent(event, route) {
    if (!route || route.route_id === undefined) return;
    if (event === 'pending') {
        _renderRouteCard(route);
    } else if (event === 'delivered') {
        // The permanent route_receipt message follows via the normal message
        // flow — retire the live card.
        _resolveRouteCard(route.route_id, 'delivered');
    } else if (event === 'cancelled') {
        _resolveRouteCard(route.route_id, 'cancelled');
    } else if (event === 'failed') {
        _resolveRouteCard(route.route_id, 'failed');
    }
}

function _renderRouteCard(route) {
    const container = document.getElementById('messages');
    if (!container) return;
    let holder = _routeCardEl(route.route_id);
    if (!holder) {
        holder = document.createElement('div');
        holder.className = 'message route-card-msg';
        holder.dataset.routeId = route.route_id;
        holder.dataset.channel = window.hubChannel;
        if (window.activeChannel !== window.hubChannel) holder.style.display = 'none';
        container.appendChild(holder);
    }
    const preview = (route.text || '').length > 220
        ? route.text.slice(0, 220) + '…' : (route.text || '');
    const senderColor = (typeof getColor === 'function') ? getColor(route.sender) : '#00BCFF';
    holder.innerHTML = `
        <div class="route-card pending">
            <div class="route-card-head">
                <span class="route-pill">routing</span>
                <span class="route-sender" style="color: ${senderColor}">${escapeHtml(route.sender || '')}</span>
                <span class="route-arrow">→</span>
                <button class="route-target-chip" onclick="hubJumpTo('${escapeHtml(route.channel || '')}', null)">#${escapeHtml(route.channel || '')}</button>
                <span class="route-countdown" data-deliver-at="${route.deliver_at || 0}"></span>
            </div>
            <div class="route-card-text">${escapeHtml(preview)}</div>
            <div class="route-card-actions">
                <button class="route-cancel-btn" onclick="cancelRoute(${route.route_id})">Cancel</button>
            </div>
        </div>`;
    _startRouteCountdown(route.route_id);
    _hubScrollIfNearBottom(container);
}

function _startRouteCountdown(routeId) {
    const prev = _routeCards[routeId];
    if (prev && prev.interval) clearInterval(prev.interval);
    const tick = () => {
        const el = _routeCardEl(routeId);
        if (!el) { clearInterval(interval); delete _routeCards[routeId]; return; }
        const cd = el.querySelector('.route-countdown');
        if (!cd) return;
        const deliverAt = parseFloat(cd.dataset.deliverAt || '0');
        const remaining = Math.max(0, deliverAt - Date.now() / 1000);
        cd.textContent = remaining > 0 ? `${Math.ceil(remaining)}s` : 'delivering…';
    };
    const interval = setInterval(tick, 400);
    _routeCards[routeId] = { interval };
    tick();
}

function _resolveRouteCard(routeId, outcome) {
    const entry = _routeCards[routeId];
    if (entry && entry.interval) clearInterval(entry.interval);
    delete _routeCards[routeId];
    const holder = _routeCardEl(routeId);
    if (!holder) return;
    if (outcome === 'delivered') {
        // Receipt message takes this card's place — remove without fanfare.
        holder.remove();
        return;
    }
    const card = holder.querySelector('.route-card');
    if (!card) { holder.remove(); return; }
    card.classList.remove('pending');
    card.classList.add(outcome);
    const actions = card.querySelector('.route-card-actions');
    if (actions) actions.remove();
    const cd = card.querySelector('.route-countdown');
    if (cd) cd.textContent = outcome === 'cancelled' ? 'cancelled — never delivered' : 'failed to deliver';
    if (outcome === 'cancelled') {
        setTimeout(() => holder.remove(), 6000);
    }
}

function cancelRoute(routeId) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'route_cancel', route_id: routeId }));
        // Optimistic UI: freeze the countdown immediately; the server's
        // 'cancelled' (or, if we lost the race, 'delivered') event settles it.
        const holder = _routeCardEl(routeId);
        const btn = holder && holder.querySelector('.route-cancel-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
    }
}

function _hubScrollIfNearBottom(container) {
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 160;
    if (nearBottom) container.scrollTop = container.scrollHeight;
}

// ---------------------------------------------------------------------------
// Route receipts (permanent hub-timeline record; msg_type "route_receipt")
// ---------------------------------------------------------------------------

window._messageRenderers = window._messageRenderers || {};
window._messageRenderers['route_receipt'] = function (el, msg) {
    const meta = msg.metadata || {};
    const actor = meta.actor || window.hubAgent;
    const target = meta.target_channel || '';
    const msgId = (meta.msg_id === undefined || meta.msg_id === null) ? 'null' : meta.msg_id;
    const actorColor = (typeof getColor === 'function') ? getColor(actor) : '#00BCFF';
    const preview = (msg.text || '').length > 140 ? msg.text.slice(0, 140) + '…' : (msg.text || '');
    el.classList.add('route-receipt-msg');
    el.innerHTML = `
        <div class="route-receipt">
            <span class="route-receipt-check">✓</span>
            <span class="route-receipt-actor" style="color: ${actorColor}">${escapeHtml(actor)}</span>
            <span class="route-receipt-label">${meta.auto_reply ? 'replied in' : 'routed to'}</span>
            <button class="route-receipt-chip" onclick="hubJumpTo('${escapeHtml(target)}', ${msgId})">#${escapeHtml(target)}</button>
            <span class="route-receipt-preview">${escapeHtml(preview)}</span>
            <span class="msg-time">${msg.time || ''}</span>
        </div>`;
};

// ---------------------------------------------------------------------------
// Origin badge ("from #channel") for relayed messages
// ---------------------------------------------------------------------------

// Called from chat.js's default bubble renderer. Returns '' for messages
// without origin metadata, so it is a no-op outside hub reporting.
window.buildOriginChipHtml = function (msg) {
    const meta = msg.metadata || {};
    if (!meta.origin_channel) return '';
    const mid = (meta.origin_msg_id === undefined || meta.origin_msg_id === null)
        ? 'null' : meta.origin_msg_id;
    return `<button class="origin-chip" title="Go to #${escapeHtml(meta.origin_channel)}"
        onclick="hubJumpTo('${escapeHtml(meta.origin_channel)}', ${mid}); event.stopPropagation();">
        from #${escapeHtml(meta.origin_channel)}</button>`;
};

// Jump to a channel (and message) referenced by a chip.
function hubJumpTo(channel, msgId) {
    if (!channel || !window.channelList.includes(channel)) return;
    if (window.activeChannel !== channel && typeof switchChannel === 'function') {
        switchChannel(channel);
    }
    if (msgId !== null && msgId !== undefined && typeof scrollToMessage === 'function') {
        setTimeout(() => scrollToMessage(msgId), 120);
    }
}
