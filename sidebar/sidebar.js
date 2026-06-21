// sidebar/sidebar.js
// Self-contained.

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
    pill: $('status-pill'),
    tabs: document.querySelectorAll('.tab'),
    panes: { chat: $('pane-chat'), activity: $('pane-activity'), approvals: $('pane-approvals') },
    chat: $('chat-log'),
    chatEmpty: $('chat-empty'),
    chatInput: $('chat-input'),
    chatSend: $('chat-send'),
    chatHint: $('chat-hint'),
    profileSelect: $('sidebar-profile-select'),
    settingsLink: $('sidebar-open-options'),
    activity: $('activity-log'),
    approvalsList: $('approval-list'),
    approvalsCount: $('approvals-count'),
    approvalsEmpty: $('approvals-empty'),
    counter: $('counter-line'),
    modal: $('approval-modal'),
    approvalTitle: $('approval-title'),
    approvalTool: $('approval-tool'),
    approvalRisk: $('approval-risk'),
    approvalReason: $('approval-reason'),
    approvalPayload: $('approval-payload'),
    approvalDeny: $('approval-deny'),
    approvalAllowOnce: $('approval-allow-once'),
    approvalAllowAlways: $('approval-allow-always'),
    askModal: $('ask-user-modal'),
    askQuestion: $('ask-user-question'),
    askOptions: $('ask-user-options'),
    askText: $('ask-user-text'),
    askCancel: $('ask-user-cancel'),
    askSend: $('ask-user-send')
  };

  // Request/response helper (mirrors popup.js).
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

  let isRunning = false;

  function setComposerEnabled(running) {
    isRunning = running;
    if (!els.chatInput) return;
    els.chatInput.disabled = running;
    els.chatSend.textContent = running ? '⏹' : '➤';
    els.chatSend.className = running ? 'send-btn stop-btn' : 'primary send-btn';
    els.chatSend.title = running ? 'Stop the current task' : 'Send';
    els.chatInput.placeholder = running
      ? 'A task is running… click Stop to end it, or answer questions when asked.'
      : 'Describe a task and hit Send…';
    els.chatHint.textContent = running
      ? 'Task running'
      : 'Enter to send · Shift+Enter for newline';
  }

  let port = null;
  let currentTaskId = null;
  let currentCall = null;

  function setPane(name) {
    for (const t of els.tabs) t.classList.toggle('active', t.dataset.pane === name);
    for (const k in els.panes) els.panes[k].classList.toggle('active', k === name);
  }
  for (const t of els.tabs) t.addEventListener('click', () => setPane(t.dataset.pane));

  function renderMarkdown(t) {
    let html = String(t == null ? '' : t);
    // Escape HTML entities first
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Code blocks (```...```)
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Headings (must be after code blocks to avoid matching inside them)
    html = html.replace(/^### (.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^## (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^# (.+)$/gm, '<h4>$1</h4>');
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Line breaks
    html = html.replace(/\n/g, '<br />');
    return html;
  }

  function appendChat(role, text) {
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
    els.chat.appendChild(d);
    els.chat.scrollTop = els.chat.scrollHeight;
    if (els.chatEmpty) els.chatEmpty.classList.add('hidden');
  }
  function appendActivity(text, cls) {
    const d = document.createElement('div');
    d.className = 'line' + (cls ? ' ' + cls : '');
    d.textContent = text;
    els.activity.appendChild(d);
    els.activity.scrollTop = els.activity.scrollHeight;
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

  // Poll status to recover from SW restarts.
  setInterval(async () => {
    try {
      const r = await new Promise((res) => {
        chrome.runtime.sendMessage({ type: 'GET_CURRENT_TASK' }, (resp) => res(resp));
      });
      const t = r && r.task;
      if (t) {
        if (currentTaskId !== t.id) currentTaskId = t.id;
        setPill(t.status, (t.state && t.state.thinking) || null);
        updateCounters(t.counters || {});
        if (t.status !== 'awaiting_approval' && els.approvalsList.children.length > 0) {
          els.approvalsList.innerHTML = '';
          els.approvalsEmpty.classList.remove('hidden');
          updateApprovalsCount();
        }
      } else if (currentTaskId) {
        // Task was cleared
        setPill('idle');
        currentTaskId = null;
        if (els.approvalsList.children.length > 0) {
          els.approvalsList.innerHTML = '';
          els.approvalsEmpty.classList.remove('hidden');
          updateApprovalsCount();
        }
      }
    } catch {}
  }, 1500);

  function handleEvent(msg) {
    if (msg.kind === 'task_started') {
      currentTaskId = msg.taskId;
      setPill('running', 'Cooking...');
      els.chat.innerHTML = '';
      els.activity.innerHTML = '';
      els.approvalsList.innerHTML = '';
      els.approvalsEmpty.classList.remove('hidden');
      updateApprovalsCount();
      appendChat('user', msg.goal);
      appendActivity('. Task started: ' + truncate(msg.goal, 80));
    } else if (msg.kind === 'thinking') {
      setPill('running', msg.phrase || 'Thinking...');
    } else if (msg.kind === 'model_message') {
      // Free text the model emitted (commentary / thinking) before or without a tool call.
      if (msg.text && msg.text.trim()) appendChat('assistant', msg.text);
    } else if (msg.kind === 'tool_executing') {
      const tool = (msg.call && msg.call.tool) || 'unknown';
      const args = describeCallArgs(msg.call);
      appendChat('status', '🔧 The AI is using **' + tool + '**' + (args ? ' ' + args : ''));
      appendActivity('> Running: ' + tool + args, 'muted');
    } else if (msg.kind === 'tool_result') {
      const summary = msg.summary || ((msg.call && msg.call.tool) || 'action');
      if (msg.ok) {
        appendActivity('. ' + summary, 'ok');
      } else {
        appendActivity('X ' + summary + (msg.error ? ' — ' + msg.error : ''), 'error');
      }
    } else if (msg.kind === 'approval_requested') {
      appendChat('status', '⏳ The AI needs approval to **' + (msg.call && msg.call.tool) + '** — check the Approvals tab.');
      showApproval(msg);
    } else if (msg.kind === 'ask_user') {
      showAskUser(msg);
    } else if (msg.kind === 'status') {
      if (msg.task) {
        currentTaskId = msg.task.id;
        setPill(msg.task.status, msg.task.thinking || null);
        updateCounters(msg.task.counters || {});
      }
    } else if (msg.kind === 'done') {
      setPill('done');
      appendChat('assistant', msg.answer || '');
      appendActivity('.v Task complete', 'ok');
      closeApproval();
      els.approvalsList.innerHTML = '';
      els.approvalsEmpty.classList.remove('hidden');
      updateApprovalsCount();
    } else if (msg.kind === 'aborted' || msg.kind === 'error') {
      const errMsg = (msg.error && msg.error.message) || '';
      setPill(msg.kind);
      if (errMsg.includes('image') && (errMsg.includes('not support') || errMsg.includes('Cannot read') || errMsg.includes('image_url'))) {
        appendChat('error', '⚠️ This model does not support image input. Please switch to a vision-capable model in your profile settings, or remove any image references from your request.');
      } else {
        appendChat('error', errMsg || (msg.kind === 'aborted' ? 'Task aborted' : 'An error occurred'));
      }
      appendActivity((msg.kind === 'aborted' ? '.x Aborted: ' : 'X Error: ') + errMsg, 'error');
      closeApproval();
      els.approvalsList.innerHTML = '';
      els.approvalsEmpty.classList.remove('hidden');
      updateApprovalsCount();
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
    els.counter.textContent = steps + ' steps . ' + calls + ' calls . ' + formatTok(tok) + ' tok . ' + formatMs(ms);
  }

  function showApproval(msg) {
    currentCall = msg.call;
    els.approvalTitle.textContent = 'Approve ' + (msg.call.tool || 'action');
    els.approvalTool.textContent = msg.call.tool || '';
    els.approvalRisk.textContent = (msg.risk && (msg.risk.level + ' . ' + msg.risk.reason)) || '';
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

  function closeApproval() {
    els.modal.classList.add('hidden');
  }

  async function respondApproval(decision) {
    if (!currentTaskId) { closeApproval(); return; }
    const r = await send('APPROVAL_RESPONSE', { taskId: currentTaskId, decision });
    if (!r || !r.ok) {
      appendActivity('X Approval failed: ' + (r ? r.error : 'unknown error'), 'error');
      return; // Do not close modal if it failed
    }
    appendActivity((decision === 'deny' ? 'X Denied' : '.v Allowed') + ': ' + (currentCall && currentCall.tool), decision === 'deny' ? 'warn' : 'ok');
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

  function showAskUser(msg) {
    // Ensure currentTaskId is set even if the task_started event was missed.
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
    setPane('chat');
    // Focus the textarea so the user can type immediately.
    setTimeout(() => { try { els.askText.focus(); } catch {} }, 50);
    // Re-assert visibility — the chat-composer's disabled state can cause a
    // brief layout shift; ensure the modal stays on top.
    els.askModal.style.zIndex = '200';
  }

  function closeAskUser() {
    els.askModal.classList.add('hidden');
  }

  els.askCancel.addEventListener('click', () => { closeAskUser(); });
  els.askSend.addEventListener('click', async () => {
    const text = (els.askText.value || '').trim();
    if (!text) {
      // Visible feedback instead of a silent return.
      els.askText.style.borderColor = 'var(--danger)';
      els.askText.placeholder = 'Please type an answer first.';
      setTimeout(() => { els.askText.style.borderColor = ''; els.askText.placeholder = 'Type your answer'; }, 1500);
      return;
    }
    if (!currentTaskId) {
      appendActivity('X Cannot send: no active task. The agent may have stopped.', 'error');
      closeAskUser();
      return;
    }
    const r = await send('ASK_USER_ANSWER', { taskId: currentTaskId, answer: text });
    if (!r || !r.ok) {
      appendActivity('X Send failed: ' + (r ? r.error : 'unknown error'), 'error');
      return;
    }
    appendChat('user', '(reply) ' + text);
    closeAskUser();
  });

  // Allow Enter to send from the modal textarea.
  els.askText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      els.askSend.click();
    }
  });

  // --- Chat composer: start a task from the sidebar ---
  let pendingGoalAfterSetup = null;

  async function sendTask(goal) {
    if (!goal || isRunning) return;
    setComposerEnabled(true); // visually mark as running immediately
    const profileId = els.profileSelect ? els.profileSelect.value : undefined;
    const r = await send('START_TASK', { goal, profileId });
    if (!r.ok) {
      setComposerEnabled(false); // restore idle
      if (r.error === 'first_run_required') {
        // Offer a one-click setup so the user isn't blocked by a dead-end.
        pendingGoalAfterSetup = goal;
        showFirstRunCard();
        return;
      }
      appendChat('error', 'Could not start task: ' + (r.error || 'unknown'));
      appendActivity('X Start failed: ' + (r.error || 'unknown'), 'error');
      return;
    }
    // The SW will push task_started/step events over the port; ensure the chat
    // pane is visible so the user sees the transcript build up.
    setPane('chat');
    els.chatInput.value = '';
  }

  function showFirstRunCard() {
    appendChat('system', 'Before you can run tasks, pick how WebNav treats websites. The easiest option is "Allow all non-blocked" (it blocks banking/payment/crypto/government sites by default). You can change this later in Options.');
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
    if (!r.ok) {
      appendChat('error', 'Could not save that choice: ' + (r.error || 'unknown'));
      return;
    }
    if (card) card.remove();
    appendChat('assistant', 'Great — allowlist mode set to "' + mode + '".');
    const goal = pendingGoalAfterSetup;
    pendingGoalAfterSetup = null;
    if (goal) {
      appendChat('user', goal);
      sendTask(goal);
    }
  }

  if (els.chatSend) {
    els.chatSend.addEventListener('click', () => {
      if (isRunning) {
        if (port) port.postMessage({ type: 'STOP_TASK' });
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

  // Load profiles into the selector
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

  connect();
})();
