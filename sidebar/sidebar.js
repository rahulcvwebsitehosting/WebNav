// sidebar/sidebar.js
// Multi-tab aware sidebar. Each browser tab gets its own chat session.

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '...' : s; }
  function formatTok(n) { if (n > 1000) return (n / 1000).toFixed(1) + 'k'; return String(n); }
  function formatMs(ms) { const s = Math.round((ms || 0) / 1000); if (s < 60) return s + 's'; return Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }

  function showError(msg) {
    const el = $('global-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    console.error('[WebNav sidebar]', msg);
  }
  window.addEventListener('error', (e) => showError('JS error: ' + (e.error && e.error.message || e.message || 'unknown')));
  window.addEventListener('unhandledrejection', (e) => showError('Promise error: ' + (e.reason && e.reason.message || e.reason || 'unknown')));

  const els = {
    pill:              $('status-pill'),
    tabs:              document.querySelectorAll('.tab'),
    panes:             { chat: $('pane-chat'), activity: $('pane-activity'), approvals: $('pane-approvals') },
    chat:              $('chat-log'),
    chatEmpty:         $('chat-empty'),
    chatInput:         $('chat-input'),
    chatSend:          $('chat-send'),
    chatHint:          $('chat-hint'),
    profileSelect:     $('sidebar-profile-select'),
    settingsLink:      $('sidebar-open-options'),
    activity:          $('activity-log'),
    approvalsList:     $('approval-list'),
    approvalsCount:    $('approvals-count'),
    approvalsEmpty:    $('approvals-empty'),
    counter:           $('counter-line'),
    modal:             $('approval-modal'),
    approvalTitle:     $('approval-title'),
    approvalTool:      $('approval-tool'),
    approvalRisk:      $('approval-risk'),
    approvalReason:    $('approval-reason'),
    approvalPayload:   $('approval-payload'),
    approvalDeny:      $('approval-deny'),
    approvalAllowOnce: $('approval-allow-once'),
    approvalAllowAlways: $('approval-allow-always'),
    askModal:          $('ask-user-modal'),
    askQuestion:       $('ask-user-question'),
    askOptions:        $('ask-user-options'),
    askText:           $('ask-user-text'),
    askCancel:         $('ask-user-cancel'),
    askSend:           $('ask-user-send'),
    tabSessionsBar:    $('tab-sessions-bar'),
    tabSessionsList:   $('tab-sessions-list'),
    tabSessionsRefresh: $('tab-sessions-refresh'),
    linkToggleBtn:     $('link-toggle-btn')
  };

  // ── Message send helper ──────────────────────────────────────────────────────
  function send(type, payload) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (r) => {
          if (chrome.runtime.lastError) { res({ ok: false, error: chrome.runtime.lastError.message }); return; }
          res(r || { ok: false, error: 'no response' });
        });
      } catch (e) { res({ ok: false, error: e.message }); }
    });
  }

  // ── Per-tab session state ────────────────────────────────────────────────────
  //
  // tabSessions: Map<tabId, { chatNodes, activityNodes, taskId, currentCall, counters, pill }>
  //   chatNodes / activityNodes are DocumentFragment arrays stored as arrays of
  //   rendered DOM nodes so we can swap them when the user switches tabs.
  //
  const tabSessions = new Map();  // tabId -> session
  let selectedTabId = null;       // which tab's content is shown
  let isRunning = false;
  let currentTaskId = null;       // taskId for the selected tab's active task
  let currentCall = null;         // for the approval modal

  // ── Multi-tab linking state ──────────────────────────────────────────────────
  let linkingMode = false;         // toggle state for the link button
  let linkedTabIds = new Set();    // tabIds that are currently linked

  function getOrCreateSession(tabId) {
    if (!tabSessions.has(tabId)) {
      tabSessions.set(tabId, {
        chatNodes: [],       // cloned DOM nodes to restore the chat pane
        activityNodes: [],   // cloned DOM nodes to restore activity pane
        taskId: null,
        currentCall: null,
        counters: {},
        taskStatus: null,
        taskGoal: null
      });
    }
    return tabSessions.get(tabId);
  }

  // Save the current pane's live DOM into the session object, then clear it.
  function saveCurrentSession() {
    if (selectedTabId == null) return;
    const sess = getOrCreateSession(selectedTabId);
    sess.chatNodes = [...els.chat.childNodes].map(n => n.cloneNode(true));
    sess.activityNodes = [...els.activity.childNodes].map(n => n.cloneNode(true));
    sess.counters = _parseCounters();
    sess.taskId = currentTaskId;
    sess.currentCall = currentCall;
    sess.taskStatus = _pillStatus();
  }

  function _parseCounters() {
    return { _raw: els.counter.textContent };
  }
  function _pillStatus() {
    return (els.pill.className.match(/pill (\w+)/) || [])[1] || 'idle';
  }

  // Restore a saved session into the live DOM.
  function restoreSession(tabId) {
    const sess = tabSessions.get(tabId);
    // Clear live panes
    els.chat.innerHTML = '';
    els.activity.innerHTML = '';

    if (!sess || (sess.chatNodes.length === 0 && sess.activityNodes.length === 0)) {
      // No history: show the empty state
      if (els.chatEmpty) els.chatEmpty.classList.remove('hidden');
      els.counter.textContent = '-';
      setPill('idle', null);
      setComposerEnabled(false);
      currentTaskId = null;
      currentCall = null;
      return;
    }

    if (els.chatEmpty) els.chatEmpty.classList.add('hidden');
    for (const n of sess.chatNodes) els.chat.appendChild(n.cloneNode(true));
    for (const n of sess.activityNodes) els.activity.appendChild(n.cloneNode(true));
    if (sess.counters && sess.counters._raw) els.counter.textContent = sess.counters._raw;
    currentTaskId = sess.taskId;
    currentCall = sess.currentCall;

    // Restore pill / running state
    const status = sess.taskStatus || 'idle';
    const isActive = ['running', 'awaiting_approval', 'awaiting_user'].includes(status);
    setComposerEnabled(isActive);
    setPill(status, isActive ? 'Working...' : null);

    els.chat.scrollTop = els.chat.scrollHeight;
    els.activity.scrollTop = els.activity.scrollHeight;
  }

  // ── Tab strip rendering ──────────────────────────────────────────────────────
  let _tabStripData = [];  // last fetched list of tabs

  async function refreshTabStrip() {
    try {
      const r = await send('GET_ALL_TABS_STATUS');
      if (!r || !r.ok || !Array.isArray(r.tabs)) return;
      _tabStripData = r.tabs;
      renderTabStrip(r.tabs);
    } catch {}
  }

  function renderTabStrip(tabs) {
    const list = els.tabSessionsList;
    if (!list) return;

    // Get the currently focused window's tabs
    const currentWindow = tabs.filter(t => {
      // Show all tabs for now; filter active window
      return true;
    });

    list.innerHTML = '';
    for (const tab of currentWindow) {
      const item = document.createElement('div');
      item.className = 'tab-session-item';
      item.dataset.tabId = String(tab.tabId);

      if (tab.tabId === selectedTabId) item.classList.add('selected');

      const isAiRunning = tab.taskStatus &&
        ['running', 'awaiting_approval', 'awaiting_user'].includes(tab.taskStatus);
      if (isAiRunning) item.classList.add('ai-running');

      // Favicon
      if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
        const img = document.createElement('img');
        img.className = 'tab-favicon';
        img.src = tab.favIconUrl;
        img.alt = '';
        img.onerror = () => { img.replaceWith(makeFallbackIcon()); };
        item.appendChild(img);
      } else {
        item.appendChild(makeFallbackIcon());
      }

      // Title
      const titleEl = document.createElement('span');
      titleEl.className = 'tab-title';
      titleEl.textContent = tab.title || tab.url || 'Tab';
      titleEl.title = tab.title || '';
      item.appendChild(titleEl);

      // Status dot
      const dot = document.createElement('span');
      dot.className = 'tab-status-dot';
      if (tab.taskStatus) {
        const st = tab.taskStatus;
        if (st === 'running') dot.classList.add('running');
        else if (st === 'awaiting_approval' || st === 'awaiting_user') dot.classList.add('awaiting');
        else if (st === 'done') dot.classList.add('done');
        else if (st === 'error' || st === 'aborted') dot.classList.add('error');
      }
      item.appendChild(dot);

      // Link indicator (shown when linking mode is active)
      if (linkingMode && tab.isLinked) {
        item.classList.add('tab-linked');
        const linkIcon = document.createElement('span');
        linkIcon.className = 'tab-link-icon';
        linkIcon.textContent = '🔗';
        item.appendChild(linkIcon);
      }

      item.addEventListener('click', () => {
        if (linkingMode) {
          toggleTabLink(tab.tabId);
        } else {
          selectTab(tab.tabId);
        }
      });
      list.appendChild(item);
    }

    // Auto-select the active tab if nothing is selected yet
    if (selectedTabId == null) {
      const active = tabs.find(t => t.active);
      if (active) selectTab(active.tabId);
    }
  }

  function makeFallbackIcon() {
    const el = document.createElement('div');
    el.className = 'tab-favicon-fallback';
    el.textContent = '⬜';
    return el;
  }

  function selectTab(tabId) {
    if (tabId === selectedTabId) return;
    // Save current session before switching
    saveCurrentSession();
    selectedTabId = tabId;
    // Restore (or create blank) the new session
    restoreSession(tabId);
    // Update strip selection state
    for (const item of (els.tabSessionsList || { querySelectorAll: () => [] }).querySelectorAll('.tab-session-item')) {
      item.classList.toggle('selected', Number(item.dataset.tabId) === tabId);
    }
    // Update status pill for the new tab
    const tabData = _tabStripData.find(t => t.tabId === tabId);
    if (tabData && tabData.taskStatus) {
      const isActive = ['running', 'awaiting_approval', 'awaiting_user'].includes(tabData.taskStatus);
      setPill(tabData.taskStatus, isActive ? 'Working...' : null);
      setComposerEnabled(isActive);
    } else {
      setPill('idle', null);
      setComposerEnabled(false);
    }
  }

  if (els.tabSessionsRefresh) {
    els.tabSessionsRefresh.addEventListener('click', () => refreshTabStrip());
  }

  // ── Status pill ──────────────────────────────────────────────────────────────
  function setComposerEnabled(running) {
    isRunning = running;
    if (!els.chatInput) return;
    els.chatInput.disabled = running;
    els.chatSend.textContent = running ? '⏹' : '➤';
    els.chatSend.className = running ? 'send-btn stop-btn' : 'primary send-btn';
    els.chatSend.title = running ? 'Stop the current task' : 'Send';
    els.chatInput.placeholder = running
      ? 'AI is running… click ⏹ to stop, or answer questions when asked.'
      : 'Describe a task and hit Send…';
    els.chatHint.textContent = running
      ? 'Task running'
      : 'Enter to send · Shift+Enter for newline';
  }

  function setPill(status, phrase) {
    const terminal = ['done', 'aborted', 'error'].includes(status);
    if (terminal || !status || status === 'idle') {
      els.pill.className = 'pill ' + (status || 'idle');
      els.pill.textContent = status || 'idle';
    } else if (status === 'running' && phrase) {
      els.pill.className = 'pill running animated';
      els.pill.textContent = phrase;
    } else {
      els.pill.className = 'pill ' + (status || '');
      els.pill.textContent = status || '';
    }
    setComposerEnabled(!terminal && status !== 'idle' && !!status);
  }

  // ── Pane tabs (Chat / Activity / Approvals) ──────────────────────────────────
  function setPane(name) {
    for (const t of els.tabs) t.classList.toggle('active', t.dataset.pane === name);
    for (const k in els.panes) els.panes[k].classList.toggle('active', k === name);
  }
  for (const t of els.tabs) t.addEventListener('click', () => setPane(t.dataset.pane));

  // ── Markdown renderer ────────────────────────────────────────────────────────
  function renderMarkdown(t) {
    let html = String(t == null ? '' : t);
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^### (.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^## (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^# (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/\n/g, '<br />');
    return html;
  }

  // ── Chat bubble helpers ──────────────────────────────────────────────────────
  function appendChat(role, text, targetTabId) {
    // If targetTabId is specified and doesn't match selected tab, store in session only
    const isVisible = (targetTabId == null || targetTabId === selectedTabId);
    const d = document.createElement('div');
    d.className = 'bubble ' + role;
    const inner = document.createElement('div');
    inner.className = 'bubble-inner';
    const txt = document.createElement('span');
    txt.className = 'bubble-text';
    txt.innerHTML = renderMarkdown(text);
    inner.appendChild(txt);
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).catch(() => {});
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
    inner.appendChild(btn);
    d.appendChild(inner);

    if (isVisible) {
      els.chat.appendChild(d);
      els.chat.scrollTop = els.chat.scrollHeight;
      if (els.chatEmpty) els.chatEmpty.classList.add('hidden');
    }

    // Always store in the appropriate session
    if (targetTabId != null) {
      const sess = getOrCreateSession(targetTabId);
      sess.chatNodes.push(d.cloneNode(true));
    }
  }

  function appendActivity(text, cls, targetTabId) {
    const isVisible = (targetTabId == null || targetTabId === selectedTabId);
    const d = document.createElement('div');
    d.className = 'line' + (cls ? ' ' + cls : '');
    d.textContent = text;

    if (isVisible) {
      els.activity.appendChild(d);
      els.activity.scrollTop = els.activity.scrollHeight;
    }
    if (targetTabId != null) {
      const sess = getOrCreateSession(targetTabId);
      sess.activityNodes.push(d.cloneNode(true));
    }
  }

  // ── Port connection (live events from service worker) ────────────────────────
  let port = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'sidebar' });
      port.onMessage.addListener((msg) => { if (msg) handleEvent(msg); });
      port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 500); });
      port.postMessage({ type: 'GET_STATUS' });
    } catch (e) {
      showError('Connect failed: ' + e.message);
      setTimeout(connect, 2000);
    }
  }

  // ── Status polling ───────────────────────────────────────────────────────────
  setInterval(async () => {
    try {
      // Refresh the tab strip status
      await refreshTabStrip();

      // Update the pill for the currently selected tab
      if (selectedTabId != null) {
        const r = await send('GET_CURRENT_TASK', { tabId: selectedTabId });
        const t = r && r.task;
        if (t) {
          currentTaskId = t.id;
          setPill(t.status, (t.state && t.state.thinking) || null);
          updateCounters(t.counters || {});
          // Update session status
          const sess = getOrCreateSession(selectedTabId);
          sess.taskStatus = t.status;
          sess.taskId = t.id;

          if (t.status !== 'awaiting_approval' && els.approvalsList.children.length > 0) {
            els.approvalsList.innerHTML = '';
            els.approvalsEmpty.classList.remove('hidden');
            updateApprovalsCount();
          }
        } else {
          // No task on this tab
          const sess = tabSessions.get(selectedTabId);
          const wasRunning = sess && ['running', 'awaiting_approval', 'awaiting_user'].includes(sess.taskStatus);
          if (wasRunning) {
            setPill('idle');
            currentTaskId = null;
            if (els.approvalsList.children.length > 0) {
              els.approvalsList.innerHTML = '';
              els.approvalsEmpty.classList.remove('hidden');
              updateApprovalsCount();
            }
          }
        }
      }
    } catch {}
  }, 1500);

  // ── Event handler (routed by tabId) ──────────────────────────────────────────
  function handleEvent(msg) {
    const tabId = msg.tabId != null ? msg.tabId : null;
    const isMine = (tabId == null || tabId === selectedTabId);

    if (msg.kind === 'task_started') {
      const sess = getOrCreateSession(tabId);
      sess.taskId = msg.taskId;
      sess.taskStatus = 'running';
      sess.taskGoal = msg.goal;
      sess.chatNodes = [];
      sess.activityNodes = [];

      if (isMine) {
        currentTaskId = msg.taskId;
        setPill('running', 'Cooking...');
        els.chat.innerHTML = '';
        els.activity.innerHTML = '';
        els.approvalsList.innerHTML = '';
        els.approvalsEmpty.classList.remove('hidden');
        updateApprovalsCount();
      }
      appendChat('user', msg.goal, tabId);
      appendActivity('. Task started: ' + truncate(msg.goal, 80), '', tabId);
      // Refresh strip to show new task status
      refreshTabStrip();

    } else if (msg.kind === 'thinking') {
      if (isMine) setPill('running', msg.phrase || 'Thinking...');
      const sess = getOrCreateSession(tabId);
      if (sess) { sess.taskStatus = 'running'; }

    } else if (msg.kind === 'model_message') {
      if (msg.text && msg.text.trim()) appendChat('assistant', msg.text, tabId);

    } else if (msg.kind === 'tool_executing') {
      const tool = (msg.call && msg.call.tool) || 'unknown';
      const args = describeCallArgs(msg.call);
      appendChat('status', '🔧 The AI is using **' + tool + '**' + (args ? ' ' + args : ''), tabId);
      appendActivity('> Running: ' + tool + args, 'muted', tabId);

    } else if (msg.kind === 'tool_result') {
      const summary = msg.summary || ((msg.call && msg.call.tool) || 'action');
      if (msg.ok) {
        appendActivity('. ' + summary, 'ok', tabId);
      } else {
        appendActivity('X ' + summary + (msg.error ? ' — ' + msg.error : ''), 'error', tabId);
      }

    } else if (msg.kind === 'approval_requested') {
      appendChat('status', '⏳ The AI needs approval to **' + (msg.call && msg.call.tool) + '** — check the Approvals tab.', tabId);
      const sess = getOrCreateSession(tabId);
      if (sess) sess.taskStatus = 'awaiting_approval';
      if (isMine) showApproval(msg);

    } else if (msg.kind === 'ask_user') {
      const sess = getOrCreateSession(tabId);
      if (sess) sess.taskStatus = 'awaiting_user';
      if (isMine) showAskUser(msg);

    } else if (msg.kind === 'status') {
      if (msg.task) {
        const sess = getOrCreateSession(msg.task.tabId || tabId);
        if (sess) { sess.taskStatus = msg.task.status; sess.taskId = msg.task.id; }
        if (isMine) {
          currentTaskId = msg.task.id;
          setPill(msg.task.status, msg.task.thinking || null);
          updateCounters(msg.task.counters || {});
        }
      }

    } else if (msg.kind === 'done') {
      const sess = getOrCreateSession(tabId);
      if (sess) sess.taskStatus = 'done';
      if (isMine) {
        setPill('done');
        closeApproval();
        els.approvalsList.innerHTML = '';
        els.approvalsEmpty.classList.remove('hidden');
        updateApprovalsCount();
      }
      appendChat('assistant', msg.answer || '', tabId);
      appendActivity('.✓ Task complete', 'ok', tabId);
      refreshTabStrip();

    } else if (msg.kind === 'aborted' || msg.kind === 'error') {
      const errMsg = (msg.error && msg.error.message) || msg.error || '';
      const sess = getOrCreateSession(tabId);
      if (sess) sess.taskStatus = msg.kind;
      if (isMine) {
        setPill(msg.kind);
        if (errMsg.includes('image') && (errMsg.includes('not support') || errMsg.includes('Cannot read') || errMsg.includes('image_url'))) {
          appendChat('error', '⚠️ This model does not support image input. Please switch to a vision-capable model.', tabId);
        } else {
          appendChat('error', errMsg || (msg.kind === 'aborted' ? 'Task aborted' : 'An error occurred'), tabId);
        }
        appendActivity((msg.kind === 'aborted' ? '.x Aborted: ' : 'X Error: ') + errMsg, 'error', tabId);
        closeApproval();
        els.approvalsList.innerHTML = '';
        els.approvalsEmpty.classList.remove('hidden');
        updateApprovalsCount();
      } else {
        appendActivity((msg.kind === 'aborted' ? '.x Aborted: ' : 'X Error: ') + errMsg, 'error', tabId);
      }
      refreshTabStrip();

    } else if (msg.kind === 'tab_list_changed') {
      refreshTabStrip();

    } else if (msg.kind === 'linked_tabs_changed') {
      handleLinkedTabsChanged(msg.linkedTabs);

    } else if (msg.kind === 'idle') {
      if (isMine) setPill('idle');
    }
  }

  function describeCallArgs(call) {
    if (!call || !call.args) return '';
    const a = call.args;
    if (a.url) return '(' + truncate(String(a.url), 60) + ')';
    if (a.id) return '(' + a.id + ')';
    if (a.text) return '(...)';
    return '';
  }

  function updateCounters(c) {
    const steps = c.toolExecutions || 0;
    const calls = c.modelCalls || 0;
    const tok = c.totalTokens || 0;
    const ms = c.elapsedTime || 0;
    els.counter.textContent = steps + ' steps · ' + calls + ' calls · ' + formatTok(tok) + ' tok · ' + formatMs(ms);
  }

  // ── Approval modal ───────────────────────────────────────────────────────────
  function showApproval(msg) {
    currentCall = msg.call;
    els.approvalTitle.textContent = 'Approve ' + (msg.call.tool || 'action');
    els.approvalTool.textContent = msg.call.tool || '';
    els.approvalRisk.textContent = (msg.risk && (msg.risk.level + ' · ' + msg.risk.reason)) || '';
    els.approvalReason.textContent = (msg.risk && msg.risk.riskReason) || '(no reason given)';
    els.approvalPayload.textContent = JSON.stringify(msg.call, null, 2);
    const showAlways = msg.risk && msg.risk.level === 'R2' && msg.risk.reason === 'cross_origin_navigation';
    els.approvalAllowAlways.classList.toggle('hidden', !showAlways);

    const card = document.createElement('div');
    card.className = 'approval-card';
    card.innerHTML = '<div><strong>' + escapeHtml(msg.call.tool) + '</strong> <span class="pill">' + escapeHtml(msg.risk ? msg.risk.level : '') + '</span></div>' +
      '<div class="muted">' + escapeHtml(truncate(JSON.stringify(msg.call.args), 200)) + '</div>' +
      '<div class="row">' +
        '<button class="primary small" data-act="allow-once">Allow</button>' +
        (showAlways ? '<button class="primary small" data-act="allow-always">Allow always</button>' : '') +
        '<button class="ghost small" data-act="deny">Deny</button>' +
      '</div>';
    els.approvalsList.prepend(card);
    card.querySelector('[data-act="allow-once"]').addEventListener('click', () => respondApproval('allow-once'));
    if (showAlways) card.querySelector('[data-act="allow-always"]').addEventListener('click', () => respondApproval('allow-always'));
    card.querySelector('[data-act="deny"]').addEventListener('click', () => respondApproval('deny'));
    updateApprovalsCount();

    setPane('approvals');
    els.modal.classList.remove('hidden');
  }

  function updateApprovalsCount() {
    const n = els.approvalsList.children.length;
    if (n > 0) { els.approvalsCount.textContent = String(n); els.approvalsCount.classList.remove('hidden'); els.approvalsEmpty.classList.add('hidden'); }
    else { els.approvalsCount.classList.add('hidden'); els.approvalsEmpty.classList.remove('hidden'); }
  }

  function closeApproval() { els.modal.classList.add('hidden'); }

  async function respondApproval(decision) {
    if (!currentTaskId) { closeApproval(); return; }
    const r = await send('APPROVAL_RESPONSE', { taskId: currentTaskId, decision });
    if (!r || !r.ok) {
      appendActivity('X Approval failed: ' + (r ? r.error : 'unknown error'), 'error', selectedTabId);
      return;
    }
    appendActivity((decision === 'deny' ? 'X Denied' : '.✓ Allowed') + ': ' + (currentCall && currentCall.tool), decision === 'deny' ? 'warn' : 'ok', selectedTabId);
    closeApproval();
    const cards = els.approvalsList.querySelectorAll('.approval-card');
    for (const c of cards) {
      if (c.textContent && c.textContent.includes((currentCall && currentCall.tool) || '___none___')) { c.remove(); break; }
    }
    updateApprovalsCount();
  }

  els.approvalDeny.addEventListener('click', () => respondApproval('deny'));
  els.approvalAllowOnce.addEventListener('click', () => respondApproval('allow-once'));
  els.approvalAllowAlways.addEventListener('click', () => respondApproval('allow-always'));

  // ── Ask-user modal ───────────────────────────────────────────────────────────
  function showAskUser(msg) {
    if (msg.taskId) currentTaskId = msg.taskId;
    els.askQuestion.textContent = (msg.args && msg.args.question) || '';
    els.askOptions.innerHTML = '';
    for (const opt of (msg.args && msg.args.options) || []) {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = opt;
      b.addEventListener('click', () => { els.askText.value = opt; els.askText.focus(); });
      els.askOptions.appendChild(b);
    }
    els.askText.value = '';
    els.askModal.classList.remove('hidden');
    els.askModal.style.zIndex = '200';
    setPane('chat');
    setTimeout(() => { try { els.askText.focus(); } catch {} }, 50);
  }

  function closeAskUser() { els.askModal.classList.add('hidden'); }

  els.askCancel.addEventListener('click', () => { closeAskUser(); });
  els.askSend.addEventListener('click', async () => {
    const text = (els.askText.value || '').trim();
    if (!text) {
      els.askText.style.borderColor = 'var(--danger)';
      els.askText.placeholder = 'Please type an answer first.';
      setTimeout(() => { els.askText.style.borderColor = ''; els.askText.placeholder = 'Type your answer'; }, 1500);
      return;
    }
    if (!currentTaskId) {
      appendActivity('X Cannot send: no active task.', 'error', selectedTabId);
      closeAskUser();
      return;
    }
    const r = await send('ASK_USER_ANSWER', { taskId: currentTaskId, answer: text });
    if (!r || !r.ok) {
      appendActivity('X Send failed: ' + (r ? r.error : 'unknown error'), 'error', selectedTabId);
      return;
    }
    appendChat('user', '(reply) ' + text, selectedTabId);
    closeAskUser();
  });

  els.askText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.askSend.click(); }
  });

  // ── Chat composer ────────────────────────────────────────────────────────────
  let pendingGoalAfterSetup = null;

  async function sendTask(goal) {
    if (!goal || isRunning) return;
    if (selectedTabId == null) {
      appendChat('error', 'No tab selected. Click a tab in the strip above first.', null);
      return;
    }
    setComposerEnabled(true);
    const profileId = els.profileSelect ? els.profileSelect.value : undefined;
    const r = await send('START_TASK', { goal, profileId, tabId: selectedTabId });
    if (!r.ok) {
      setComposerEnabled(false);
      if (r.error === 'first_run_required') {
        pendingGoalAfterSetup = goal;
        showFirstRunCard();
        return;
      }
      appendChat('error', 'Could not start task: ' + (r.error || 'unknown'), selectedTabId);
      appendActivity('X Start failed: ' + (r.error || 'unknown'), 'error', selectedTabId);
      return;
    }
    setPane('chat');
    els.chatInput.value = '';
  }

  function showFirstRunCard() {
    appendChat('system', 'Before you can run tasks, pick how WebNav treats websites. "Allow all non-blocked" is the recommended option.', selectedTabId);
    const card = document.createElement('div');
    card.className = 'firstrun-card';
    card.innerHTML =
      '<div class="row" style="flex-wrap:wrap;gap:6px;">' +
        '<button class="primary small" data-mode="allow-all-non-blocked">Allow all non-blocked (recommended)</button>' +
        '<button class="ghost small" data-mode="explicit-allow">Explicit allow list</button>' +
        '<button class="ghost small" data-mode="confirm-per-domain">Ask each task</button>' +
        '<button class="ghost small" data-mode="allow-all" title="No restrictions at all">⚠ Allow ALL (no restrictions)</button>' +
      '</div>';
    els.chat.appendChild(card);
    els.chat.scrollTop = els.chat.scrollHeight;
    if (els.chatEmpty) els.chatEmpty.classList.add('hidden');
    card.querySelector('[data-mode="allow-all-non-blocked"]').addEventListener('click', () => setModeAndRetry('allow-all-non-blocked', card));
    card.querySelector('[data-mode="explicit-allow"]').addEventListener('click', () => setModeAndRetry('explicit-allow', card));
    card.querySelector('[data-mode="confirm-per-domain"]').addEventListener('click', () => setModeAndRetry('confirm-per-domain', card));
    card.querySelector('[data-mode="allow-all"]').addEventListener('click', () => {
      const ok = confirm('Switch to UNRESTRICTED mode?\n\nThe agent will be able to navigate to ANY website, including banking, payment, identity, and government sites. Built-in safety categories will be disabled.\n\nContinue only if you fully trust the agent and the model.');
      if (ok) setModeAndRetry('allow-all', card);
    });
  }

  async function setModeAndRetry(mode, card) {
    const r = await send('SET_ALLOWLIST_MODE', { mode });
    if (!r.ok) { appendChat('error', 'Could not save that choice: ' + (r.error || 'unknown'), selectedTabId); return; }
    if (card) card.remove();
    appendChat('assistant', 'Great — allowlist mode set to "' + mode + '".', selectedTabId);
    const goal = pendingGoalAfterSetup;
    pendingGoalAfterSetup = null;
    if (goal) {
      appendChat('user', goal, selectedTabId);
      sendTask(goal);
    }
  }

  if (els.chatSend) {
    els.chatSend.addEventListener('click', () => {
      if (isRunning) {
        // Stop the task for the selected tab
        if (port) port.postMessage({ type: 'STOP_TASK', tabId: selectedTabId });
      } else {
        const goal = (els.chatInput.value || '').trim();
        if (goal) sendTask(goal);
      }
    });
  }
  if (els.chatInput) {
    els.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const goal = (els.chatInput.value || '').trim();
        if (goal) sendTask(goal);
      }
    });
  }

  if (els.settingsLink) {
    els.settingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }

  // ── Multi-tab linking ────────────────────────────────────────────────────────
  function updateLinkButton() {
    if (!els.linkToggleBtn) return;
    els.linkToggleBtn.textContent = linkingMode ? '🔗 Linked' : '🔗 Link';
    els.linkToggleBtn.classList.toggle('linked', linkingMode);
    els.linkToggleBtn.title = linkingMode
      ? 'Linking mode ON — click tab pills to link/unlink tabs'
      : 'Toggle multi-tab linking mode';
  }

  async function toggleTabLink(tabId) {
    if (linkedTabIds.has(tabId)) {
      linkedTabIds.delete(tabId);
      await send('UNLINK_TAB', { tabId });
    } else {
      linkedTabIds.add(tabId);
      await send('LINK_TAB', { tabId });
    }
  }

  if (els.linkToggleBtn) {
    els.linkToggleBtn.addEventListener('click', async () => {
      linkingMode = !linkingMode;
      updateLinkButton();
      if (linkingMode) {
        // Fetch current linked tabs from SW
        const r = await send('GET_LINKED_TABS');
        if (r && r.ok) linkedTabIds = new Set(r.linkedTabs);
      }
      refreshTabStrip(); // re-render to show link controls on pills
    });
  }

  // Handle linked_tabs_changed events
  function handleLinkedTabsChanged(linkedArr) {
    linkedTabIds = new Set(linkedArr || []);
    refreshTabStrip();
  }

  // ── Load profiles ────────────────────────────────────────────────────────────
  (async () => {
    try {
      const resp = await send('GET_PROFILES');
      const profiles = (resp && resp.profiles) || [];
      const sel = els.profileSelect;
      if (!sel) return;
      sel.innerHTML = profiles.length
        ? profiles.map(p => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + ' - ' + escapeHtml(p.model) + '</option>').join('')
        : '<option value="">(no profiles)</option>';
      const def = profiles.find(p => p.isDefault) || profiles[0];
      if (def) sel.value = def.id;
    } catch {}
  })();

  // ── Bootstrap ────────────────────────────────────────────────────────────────
  connect();
  refreshTabStrip(); // initial load of the tab strip
  // Fetch initial linked tabs state
  (async () => {
    const r = await send('GET_LINKED_TABS');
    if (r && r.ok) {
      linkedTabIds = new Set(r.linkedTabs);
      if (r.linkedTabs.length > 0) {
        linkingMode = true;
        updateLinkButton();
        refreshTabStrip();
      }
    }
  })();
})();
