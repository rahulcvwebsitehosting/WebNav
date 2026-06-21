// popup/popup.js
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
    console.error('[WebNav popup]', msg);
  }
  window.addEventListener('error', (e) => showError('JS error: ' + (e.error && e.error.message || e.message || 'unknown')));
  window.addEventListener('unhandledrejection', (e) => showError('Promise error: ' + (e.reason && e.reason.message || e.reason || 'unknown')));

  const KEYS = { SETTINGS: 'settings', PROFILES: 'profiles' };
  const DEFAULT_SETTINGS = {
    allowlistMode: null,
    redact: { passwords: false, paymentFields: false, otp: false, usernames: false, cookies: false, apiTokens: false, apiKeyShapes: false, ccHeuristic: false }
  };
  async function getSettings() {
    const obj = await chrome.storage.local.get(KEYS.SETTINGS);
    const s = obj[KEYS.SETTINGS];
    if (!s) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    return Object.assign({}, DEFAULT_SETTINGS, s, { redact: Object.assign({}, DEFAULT_SETTINGS.redact, s.redact || {}) });
  }
  async function getProfiles() { const obj = await chrome.storage.local.get(KEYS.PROFILES); return obj[KEYS.PROFILES] || []; }

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

  let currentTask = null;
  let port = null;

  // Periodically re-fetch the current task — port can be torn down when SW restarts.
  setInterval(async () => {
    try {
      const r = await send('GET_CURRENT_TASK');
      const t = r && r.task;
      if (t && (!currentTask || currentTask.id !== t.id || currentTask.status !== t.status)) {
        currentTask = t;
        if (t.status === 'done' || t.status === 'aborted' || t.status === 'error') {
          handleEvent({ kind: t.status, error: t.state && t.state.error, answer: t.state && t.state.finalAnswer });
          // Terminal task: drop our cached copy and restore the Run UI so the
          // user can start a new task. (The SW also clears currentTask on
          // terminal, so future polls see no task.)
          currentTask = null;
          enterInputMode();
        } else {
          enterRunningMode(t);
        }
      } else if (!t && currentTask) {
        currentTask = null;
        enterInputMode();
      }
    } catch {}
  }, 1500);

  async function init() {
    try {
      const settings = await getSettings();
      if (!settings.allowlistMode) $('first-run-banner').classList.remove('hidden');
      else $('first-run-banner').classList.add('hidden');

      const dismissedObj = await chrome.storage.local.get('redactionBannerDismissed');
      const dismissed = !!dismissedObj.redactionBannerDismissed;
      const anyRedactOn = settings.redact && Object.values(settings.redact).some(Boolean);
      if (!anyRedactOn && !dismissed) $('redact-banner').classList.remove('hidden');
      else $('redact-banner').classList.add('hidden');

      const profilesResp = await send('GET_PROFILES');
      const profiles = (profilesResp && profilesResp.profiles) || [];
      const sel = $('profile-select');
      sel.innerHTML = profiles.length
        ? profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} - ${escapeHtml(p.model)}</option>`).join('')
        : '<option value="">(no profiles - open Settings)</option>';
      const def = profiles.find(p => p.isDefault) || profiles[0];
      if (def) {
        sel.value = def.id;
        $('profile-indicator').textContent = def.name + ' . ' + def.model;
      } else {
        $('profile-indicator').textContent = 'No profiles configured';
      }

      // Last goal
      const lastObj = await chrome.storage.session.get('popupState');
      const last = lastObj.popupState;
      if (last && last.goal) $('goal').value = last.goal;

      // Connect to SW port for live updates
      try {
        port = chrome.runtime.connect({ name: 'popup' });
        port.onMessage.addListener((msg) => { if (msg) handleEvent(msg); });
        port.onDisconnect.addListener(() => { port = null; });
        port.postMessage({ type: 'GET_STATUS' });
      } catch (e) { console.warn('port failed', e); }

      // Check current task
      const ctResp = await send('GET_CURRENT_TASK');
      const ct = ctResp && ctResp.task;
      if (ct && !['done', 'aborted', 'error'].includes(ct.status)) {
        enterRunningMode(ct);
      } else {
        enterInputMode();
      }
    } catch (e) {
      showError('Init failed: ' + e.message);
    }
  }

  function enterRunningMode(task) {
    $('status-section').classList.remove('hidden');
    $('task-input-section').classList.add('hidden');
    $('log-section').classList.remove('hidden');
    $('status-text').textContent = 'Running: ' + truncate(task.goal, 60);
    updateCounters(task.counters || {});
    if (task.state && task.state.status === 'awaiting_approval') $('pending-row').classList.remove('hidden');
    else $('pending-row').classList.add('hidden');
  }

  // Restore the task-entry UI (Run button visible). Called when a task ends
  // or when there is no current task.
  function enterInputMode() {
    $('status-section').classList.add('hidden');
    $('task-input-section').classList.remove('hidden');
    $('pending-row').classList.add('hidden');
  }

  function updateCounters(c) {
    const steps = c.toolExecutions || 0;
    const calls = c.modelCalls || 0;
    const tok = c.totalTokens || 0;
    const ms = c.elapsedTime || 0;
    $('counter-line').textContent = steps + ' steps . ' + calls + ' calls . ' + formatTok(tok) + ' tok . ' + formatMs(ms);
  }

  function handleEvent(msg) {
    if (msg.kind === 'task_started') {
      $('status-section').classList.remove('hidden');
      $('task-input-section').classList.add('hidden');
      $('log-section').classList.remove('hidden');
      $('log').innerHTML = '';
      $('result-section').classList.add('hidden');
      appendLog('. ' + truncate(msg.goal, 80));
      $('status-text').textContent = 'Cooking...';
      $('status-text').classList.add('animated');
    } else if (msg.kind === 'thinking') {
      const el = $('status-text');
      if (el) {
        el.textContent = msg.phrase || 'Thinking...';
        el.classList.add('animated');
      }
    } else if (msg.kind === 'model_message') {
      if (msg.text && msg.text.trim()) appendLog('  ' + truncate(msg.text, 120));
    } else if (msg.kind === 'tool_executing') {
      appendLog('> ' + msg.call.tool + describeCallArgs(msg.call), 'muted');
    } else if (msg.kind === 'tool_result') {
      const summary = msg.summary || ((msg.call && msg.call.tool) || 'action');
      appendLog((msg.ok ? '. ' : 'X ') + truncate(summary, 120), msg.ok ? 'ok' : 'error');
    } else if (msg.kind === 'approval_requested') {
      appendLog('! Approval requested: ' + msg.call.tool + (msg.risk ? ' [' + msg.risk.level + ']' : ''), 'warn');
      $('pending-row').classList.remove('hidden');
    } else if (msg.kind === 'ask_user') {
      appendLog('? Model asked: ' + (msg.args && msg.args.question || ''));
    } else if (msg.kind === 'status') {
      if (msg.task) {
        enterRunningMode({ goal: msg.task.goal, state: { status: msg.task.status }, counters: msg.task.counters || {} });
        updateCounters(msg.task.counters || {});
        if (msg.task.thinking) {
          $('status-text').textContent = msg.task.thinking;
          $('status-text').classList.add('animated');
        }
      }
    } else if (msg.kind === 'done') {
      $('status-text').classList.remove('animated');
      $('status-text').textContent = 'Done';
      appendLog('.v Done', 'ok');
      $('result-section').classList.remove('hidden');
      $('result').textContent = msg.answer || '';
      enterInputMode();
    } else if (msg.kind === 'aborted' || msg.kind === 'error') {
      $('status-text').classList.remove('animated');
      $('status-text').textContent = msg.kind === 'aborted' ? 'Aborted' : 'Error';
      appendLog((msg.kind === 'aborted' ? '.x ' : 'X ') + (msg.error && msg.error.message || ''), 'error');
      enterInputMode();
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

  function appendLog(text, cls) {
    const d = document.createElement('div');
    d.className = 'line' + (cls ? ' ' + cls : '');
    d.textContent = text;
    $('log').appendChild(d);
    $('log').scrollTop = $('log').scrollHeight;
  }

  $('run-btn').addEventListener('click', async () => {
    try {
      const goal = $('goal').value.trim();
      if (!goal) return;
      await chrome.storage.session.set({ popupState: { goal } });
      const profileId = $('profile-select').value;
      const r = await send('START_TASK', { goal, profileId });
      if (!r.ok) {
        appendLog('X ' + (r.error || 'start failed'), 'error');
        if (r.error === 'first_run_required') $('first-run-banner').classList.remove('hidden');
      }
    } catch (e) {
      showError('Run failed: ' + e.message);
    }
  });

  $('stop-btn').addEventListener('click', async () => {
    await send('STOP_TASK');
    $('status-text').textContent = 'Stopped';
  });

  $('go-sidebar-btn').addEventListener('click', openSidebar);
  $('open-sidebar-btn').addEventListener('click', openSidebar);

  async function openSidebar() {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (tab) await send('OPEN_SIDEBAR', { tabId: tab.id });
  }

  $('open-options-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('open-options-btn2').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('open-safety-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('dismiss-redact').addEventListener('click', async () => {
    $('redact-banner').classList.add('hidden');
    await chrome.storage.local.set({ redactionBannerDismissed: true });
  });

  $('allow-site-btn').addEventListener('click', async () => {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab) return;
    let host = '';
    try { host = new URL(tab.url).hostname; } catch {}
    if (!host) return;
    const r = await send('ADD_TO_ALLOWLIST', { pattern: host });
    if (r.ok) appendLog('.v Added ' + host + ' to allowlist', 'ok');
  });

  $('profile-select').addEventListener('change', () => {
    const opt = $('profile-select').options[$('profile-select').selectedIndex];
    if (opt) $('profile-indicator').textContent = opt.textContent;
  });

  init();
})();
