// background/service-worker.js
// Orchestrates task lifecycle, snapshot cache, port management, and crash recovery.
//
// Multi-tab architecture: each browser tab can have its own independent task.
// tasksByTab / agentsByTab are Maps keyed by tabId.  A single loop alarm
// iterates all active tabs and runs one step per tab per alarm fire.

import { Agent } from '../lib/agent.js';
import { session, local, KEYS, getSettings, updateSettings } from '../lib/storage.js';
import { newCounters, recordApproval } from '../lib/usage.js';
import { check, loadBuiltinCategories } from '../lib/allowlist.js';
import { toolResultWrap } from '../lib/prompt-defense.js';

const snapshotCache = new Map();
// Per-tab task/agent storage
const tasksByTab   = new Map();  // tabId -> task
const agentsByTab  = new Map();  // tabId -> { taskId, agent }
const loopRunningTabs = new Set(); // tabIds currently executing a step

const uiPorts = new Set();
const linkedTabs = new Set(); // tabIds that are linked together for shared context
const SNAPSHOT_CACHE_SIZE = 20;
const LOOP_ALARM      = 'webnav-loop';
const HEARTBEAT_ALARM = 'agent-heartbeat';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaultProfile();
  const settings = await getSettings();
  if (!settings.firstRunShown) {
    await local.set('firstRunShown', true);
    chrome.runtime.openOptionsPage();
  }
});
chrome.runtime.onStartup.addListener(() => { resumeIfAny().catch(() => {}); });
resumeIfAny().catch(() => {});

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------
chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.33 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || !alarm.name) return;
  if (alarm.name === HEARTBEAT_ALARM) {
    for (const [, task] of tasksByTab) {
      try { await session.set(KEYS.AGENT(task.id) + ':hb', Date.now()); } catch {}
    }
  } else if (alarm.name === LOOP_ALARM) {
    loopAll();
  }
});

// ---------------------------------------------------------------------------
// Default profile
// ---------------------------------------------------------------------------
async function ensureDefaultProfile() {
  const obj = await local.get(KEYS.PROFILES, []);
  const list = obj || [];
  if (list.length === 0) {
    const seed = {
      id: 'pf_default_ollama',
      name: 'Local Ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5',
      temperature: 0.2,
      maxTokens: 0,
      maxSteps: 25,
      isDefault: true,
      costPer1kPromptTokens: 0,
      costPer1kCompletionTokens: 0
    };
    await local.set(KEYS.PROFILES, [seed]);
  }
}

// ---------------------------------------------------------------------------
// Resume persisted tasks
// ---------------------------------------------------------------------------
async function resumeIfAny() {
  await ensureDefaultProfile();
  const all = await session.list('agent:');
  for (const [key, payload] of Object.entries(all)) {
    if (!payload || !payload.state) continue;
    if (['done', 'aborted', 'error'].includes(payload.state.status)) continue;
    if (key.endsWith(':hb')) continue;
    const lastBeat = payload._heartbeat || payload.startedAt || 0;
    if (Date.now() - lastBeat > 5 * 60 * 1000 &&
        !['awaiting_approval', 'awaiting_user'].includes(payload.state.status)) {
      payload.state.status = 'error';
      payload.state.error = { kind: 'error', message: 'orphaned' };
      await session.set(key, payload);
      continue;
    }
    await startAgent(payload, true);
  }
}

// ---------------------------------------------------------------------------
// UI port connections
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup' || port.name === 'sidebar') {
    uiPorts.add(port);
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'GET_STATUS') {
        sendStatusToPort(port);
      } else if (msg.type === 'APPROVAL_RESPONSE') {
        handleApprovalResponse(msg.taskId, msg.decision).catch((e) => console.error(e));
      } else if (msg.type === 'ASK_USER_ANSWER') {
        handleAskUserAnswer(msg.taskId, msg.answer).catch((e) => console.error(e));
      } else if (msg.type === 'STOP_TASK') {
        const tabId = msg.tabId || null;
        if (tabId) {
          stopTabTask(tabId).catch((e) => console.error(e));
        } else {
          // Stop all (fallback)
          for (const tid of [...tasksByTab.keys()]) stopTabTask(tid).catch(() => {});
        }
      }
    });
    port.onDisconnect.addListener(() => { uiPorts.delete(port); });
    sendStatusToPort(port);
  }
});

function sendStatusToPort(port) {
  try {
    const activeTasks = [...tasksByTab.values()].filter(t => t &&
      !['done', 'aborted', 'error'].includes(t.state.status));
    if (activeTasks.length === 0) {
      port.postMessage({ kind: 'idle' });
      return;
    }
    // Send status for each active task
    for (const task of activeTasks) {
      port.postMessage({
        kind: 'status',
        tabId: task.tabId,
        task: {
          id: task.id,
          goal: task.goal,
          status: task.state.status,
          counters: task.counters,
          thinking: task.state.thinking || null
        }
      });
    }
  } catch (e) { /* port closed */ }
}

function broadcastAll(event) {
  for (const port of uiPorts) {
    try { port.postMessage(event); } catch (e) { /* port closed */ }
  }
  try { chrome.runtime.sendMessage(event).catch(() => {}); } catch {}
}
self.__webnavBroadcast = broadcastAll;

// ---------------------------------------------------------------------------
// Overlay helpers
// ---------------------------------------------------------------------------
async function showOverlay(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'AI_OVERLAY_SHOW' }); } catch {}
}
async function hideOverlay(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'AI_OVERLAY_HIDE' }); } catch {}
}

// ---------------------------------------------------------------------------
// Message API
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg) { sendResponse({ ok: false, error: 'empty' }); return; }
      switch (msg.type) {
        case 'START_TASK': {
          // tabId can come from the message (sidebar sends selectedTabId)
          // or fall back to the sender's tab (content script) or active tab.
          const senderTabId = (sender && sender.tab && sender.tab.id) || msg.tabId || null;
          const r = await startTask(msg.goal, msg.profileId, senderTabId);
          sendResponse(r);
          break;
        }
        case 'STOP_TASK': {
          const tabId = msg.tabId || (sender && sender.tab && sender.tab.id) || null;
          if (tabId) {
            await stopTabTask(tabId);
          } else {
            for (const tid of [...tasksByTab.keys()]) await stopTabTask(tid);
          }
          sendResponse({ ok: true });
          break;
        }
        case 'APPROVAL_RESPONSE': {
          try {
            await handleApprovalResponse(msg.taskId, msg.decision);
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }
        case 'ASK_USER_ANSWER': {
          try {
            await handleAskUserAnswer(msg.taskId, msg.answer);
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }
        case 'OPEN_SIDEBAR': {
          try { await chrome.sidePanel.open({ tabId: msg.tabId }); sendResponse({ ok: true }); }
          catch (e) { sendResponse({ ok: false, error: e.message }); }
          break;
        }
        case 'FETCH_MODELS': {
          const { baseUrl, key } = msg;
          const cleanBase = (baseUrl || '').replace(/\/+$/, '');
          const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(cleanBase);
          const authHeaders = { 'Content-Type': 'application/json' };
          if (key && !isLocal) authHeaders['Authorization'] = `Bearer ${key}`;
          let lastErr = null;
          let lastErrKind = 'network';
          try {
            const res = await fetch(cleanBase + '/models', { method: 'GET', headers: authHeaders });
            if (res.ok) {
              const body = await res.json();
              if (Array.isArray(body.data) && body.data.length > 0) {
                sendResponse({ ok: true, models: body.data.map(m => m.id || m.name).filter(Boolean) });
                return;
              }
              if (Array.isArray(body.models) && body.models.length > 0) {
                sendResponse({ ok: true, models: body.models.map(m => m.name || m.id).filter(Boolean) });
                return;
              }
              lastErr = 'connected but no models returned'; lastErrKind = 'empty';
            } else {
              const snippet = (await res.text().catch(() => '') || '').slice(0, 200);
              if (res.status === 401 || res.status === 403) { lastErrKind = 'auth'; lastErr = `HTTP ${res.status} — authentication failed.${snippet ? ' (' + snippet + ')' : ''}`; }
              else { lastErrKind = 'http'; lastErr = `HTTP ${res.status}${snippet ? ': ' + snippet : ''}`; }
            }
          } catch (e) { lastErrKind = 'network'; lastErr = e && e.message ? e.message : String(e); }

          const nativeBase = cleanBase.replace(/\/v1$/, '');
          try {
            const res2 = await fetch(nativeBase + '/api/tags', { method: 'GET', headers: authHeaders });
            if (res2.ok) {
              const body2 = await res2.json();
              if (Array.isArray(body2.models) && body2.models.length > 0) {
                sendResponse({ ok: true, models: body2.models.map(m => m.name).filter(Boolean) }); return;
              }
            } else if (lastErrKind === 'network' || !lastErr) {
              if (res2.status === 401 || res2.status === 403) { lastErrKind = 'auth'; lastErr = `HTTP ${res2.status} — authentication failed.`; }
              else { lastErrKind = 'http'; lastErr = `HTTP ${res2.status}`; }
            }
          } catch (e) { if (lastErrKind === 'network' || !lastErr) lastErr = e && e.message ? e.message : String(e); }

          let message;
          if (lastErrKind === 'network') {
            message = isLocal
              ? `Could not reach ${cleanBase}. Is the local server running?`
              : `Could not reach ${cleanBase}. Check the Base URL and your connection.`;
          } else if (lastErrKind === 'auth') {
            message = lastErr;
          } else if (lastErrKind === 'http') {
            message = `Server at ${cleanBase} rejected the request (${lastErr}).`;
          } else {
            message = `Connected to ${cleanBase} but it returned no models. ${lastErr || ''}`.trim();
          }
          sendResponse({ ok: false, kind: lastErrKind, error: message });
          break;
        }
        case 'TEST_CONNECTION': {
          const { baseUrl, key, model } = msg;
          const cleanBase = (baseUrl || '').replace(/\/+$/, '');
          const headers = { 'Content-Type': 'application/json' };
          if (key) headers['Authorization'] = `Bearer ${key}`;
          const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(cleanBase);
          const body = JSON.stringify({ model: model || 'gpt-oss:20b', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0 });
          try {
            const res = await fetch(cleanBase + '/chat/completions', { method: 'POST', headers, body });
            if (res.ok) {
              sendResponse({ ok: true, status: res.status });
            } else {
              const snippet = (await res.text().catch(() => '') || '').slice(0, 200);
              let message;
              if (res.status === 401 || res.status === 403) message = `Authentication failed (HTTP ${res.status}).${snippet ? ' — ' + snippet : ''}`;
              else if (res.status === 404) message = `HTTP 404 at ${cleanBase}/chat/completions. Check the Base URL.`;
              else message = `Server returned HTTP ${res.status}.${snippet ? ' — ' + snippet : ''}`;
              sendResponse({ ok: false, kind: 'http', status: res.status, error: message });
            }
          } catch (e) {
            const msg2 = e && e.message ? e.message : String(e);
            const message = isLocal ? `Could not reach ${cleanBase}. Is the local server running? (${msg2})` : `Could not reach ${cleanBase}. (${msg2})`;
            sendResponse({ ok: false, kind: 'network', error: message });
          }
          break;
        }
        case 'GET_PROFILES': {
          await ensureDefaultProfile();
          const profiles = (await local.get(KEYS.PROFILES, [])) || [];
          sendResponse({ ok: true, profiles });
          break;
        }
        case 'GET_SETTINGS': {
          const s = await getSettings();
          sendResponse({ ok: true, settings: s });
          break;
        }
        case 'SET_ALLOWLIST_MODE': {
          const mode = msg.mode;
          const valid = ['allow-all-non-blocked', 'explicit-allow', 'confirm-per-domain', 'allow-all'];
          if (!valid.includes(mode)) { sendResponse({ ok: false, error: 'invalid_mode' }); break; }
          await updateSettings({ allowlistMode: mode });
          sendResponse({ ok: true, allowlistMode: mode });
          break;
        }
        case 'GET_CURRENT_TASK': {
          // Support tabId param; fallback to first running task for backward compat.
          let task = null;
          if (msg.tabId != null) {
            task = tasksByTab.get(msg.tabId) || null;
          } else {
            task = [...tasksByTab.values()].find(t => t &&
              !['done', 'aborted', 'error'].includes(t.state.status)) || null;
          }
          if (!task) { sendResponse({ ok: true, task: null }); return; }
          sendResponse({ ok: true, task: { id: task.id, goal: task.goal, status: task.state.status, counters: task.counters, state: task.state, tabId: task.tabId } });
          break;
        }
        case 'GET_ALL_TABS_STATUS': {
          try {
            const tabs = await chrome.tabs.query({});
            const result = tabs.map(tab => {
              const task = tasksByTab.get(tab.id);
              return {
                tabId:      tab.id,
                title:      tab.title || 'New Tab',
                url:        tab.url   || '',
                favIconUrl: tab.favIconUrl || '',
                active:     tab.active,
                windowId:   tab.windowId,
                taskStatus: task ? task.state.status : null,
                taskGoal:   task ? task.goal : null,
                taskId:     task ? task.id : null,
                isLinked:   linkedTabs.has(tab.id)
              };
            });
            sendResponse({ ok: true, tabs: result });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }
        case 'LINK_TAB': {
          const lid = msg.tabId;
          if (lid != null) {
            linkedTabs.add(lid);
            broadcastAll({ kind: 'linked_tabs_changed', linkedTabs: [...linkedTabs] });
          }
          sendResponse({ ok: true, linkedTabs: [...linkedTabs] });
          break;
        }
        case 'UNLINK_TAB': {
          const uid = msg.tabId;
          if (uid != null) linkedTabs.delete(uid);
          broadcastAll({ kind: 'linked_tabs_changed', linkedTabs: [...linkedTabs] });
          sendResponse({ ok: true, linkedTabs: [...linkedTabs] });
          break;
        }
        case 'GET_LINKED_TABS': {
          sendResponse({ ok: true, linkedTabs: [...linkedTabs] });
          break;
        }
        case 'GET_SNAPSHOT': {
          const s = snapshotCache.get(msg.tabId) || null;
          sendResponse({ ok: true, snapshot: s });
          break;
        }
        case 'CHECK_URL': {
          const s = await getSettings();
          const bd = await loadBuiltinCategories();
          const r = await check(msg.url, { mode: s.allowlistMode || 'allow-all-non-blocked', allow: s.allow || [], deny: s.deny || [], userOverrides: s.userOverrides || {} }, bd);
          sendResponse({ ok: true, allow: r.allow, reason: r.reason, matchedCategory: r.matchedCategory || null });
          break;
        }
        case 'ADD_TO_ALLOWLIST': {
          const s = await getSettings();
          const list = s.allow || [];
          if (!list.includes(msg.pattern)) list.push(msg.pattern);
          s.allow = list;
          await local.set(KEYS.SETTINGS, s);
          sendResponse({ ok: true });
          break;
        }
        case 'HIGHLIGHT_IDS': {
          try { await chrome.tabs.sendMessage(msg.tabId, { type: 'HIGHLIGHT', ids: msg.ids }); } catch {}
          sendResponse({ ok: true });
          break;
        }
        case 'PING': {
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown_message: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------
async function startTask(goal, profileId, senderTabId) {
  if (!goal || !goal.trim()) return { ok: false, error: 'empty_goal' };

  await ensureDefaultProfile();
  const settings = await getSettings();
  if (!settings.allowlistMode) {
    return { ok: false, error: 'first_run_required', message: 'Open Options to pick an allowlist mode before starting a task.' };
  }
  const profiles = (await local.get(KEYS.PROFILES, [])) || [];
  const profile = (profileId && profiles.find(p => p.id === profileId)) || profiles.find(p => p.isDefault) || profiles[0];
  if (!profile) return { ok: false, error: 'no_profile' };

  const storedKey = await local.get(KEYS.PROFILE_KEY(profile.id), null);
  if (storedKey) profile.apiKey = storedKey;

  // Resolve the target tab
  let tab = null;
  if (senderTabId) {
    try { tab = await chrome.tabs.get(senderTabId); } catch {}
  }
  if (!tab) {
    tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  }
  if (!tab) return { ok: false, error: 'no_active_tab' };

  // Only one task per tab at a time
  const existing = tasksByTab.get(tab.id);
  if (existing && !['done', 'aborted', 'error'].includes(existing.state.status)) {
    return { ok: false, error: 'another_task_running' };
  }

  const id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const origin = (() => { try { return new URL(tab.url).origin; } catch { return null; } })();
  const task = {
    id,
    goal: goal.trim(),
    profileId: profile.id,
    profile,
    settings,
    tabId: tab.id,
    state: {
      status: 'running',
      messages: [{ kind: 'goal', role: 'user', content: goal.trim() }],
      stepsTaken: 0,
      lastSnapshot: null,
      pageContext: { url: tab.url, title: tab.title, origin },
      pendingToolCall: null,
      pendingAskUser: null,
      finalAnswer: null,
      error: null
    },
    counters: newCounters(),
    approvedPairs: [],
    recentActions: [],
    injectionHitsTotal: 0,
    maxSteps: 25,
    maxWallTime: 10 * 60 * 1000,
    startedAt: Date.now()
  };
  await session.set(KEYS.AGENT(id), task);
  await session.set(KEYS.CURRENT_TASK, id);
  await startAgent(task, false);
  return { ok: true, taskId: id };
}

async function startAgent(task, isResume) {
  tasksByTab.set(task.tabId, task);
  agentsByTab.set(task.tabId, { taskId: task.id, agent: new Agent(task) });

  if (!isResume) {
    broadcastAll({ kind: 'task_started', taskId: task.id, tabId: task.tabId, goal: task.goal });
    // Show the AI active overlay on the tab
    showOverlay(task.tabId);
    // Broadcast tab list change so the sidebar strip updates
    broadcastAll({ kind: 'tab_list_changed' });
    // Take an initial snapshot
    try {
      const r = await chrome.tabs.sendMessage(task.tabId, { type: 'SNAPSHOT' });
      if (r && r.snapshot) {
        task.state.lastSnapshot = r.snapshot;
        task.state.pageContext = { url: r.snapshot.url, title: r.snapshot.title, origin: r.snapshot.origin };
        cacheSnapshot(task.tabId, r.snapshot);
      }
    } catch {}
  } else {
    // Re-broadcast pending states so the sidebar can re-show modals
    if (task.state && task.state.status === 'awaiting_user' && task.state.pendingAskUser) {
      broadcastAll({ kind: 'ask_user', taskId: task.id, tabId: task.tabId, args: task.state.pendingAskUser });
    }
    if (task.state && task.state.status === 'awaiting_approval' && task.state.pendingToolCall) {
      broadcastAll({ kind: 'approval_requested', taskId: task.id, tabId: task.tabId, call: task.state.pendingToolCall.call, risk: task.state.pendingToolCall.risk });
    }
    // Restore overlay if task was running
    if (task.state && ['running', 'awaiting_approval', 'awaiting_user'].includes(task.state.status)) {
      showOverlay(task.tabId);
    }
  }
  scheduleLoop();
}

// ---------------------------------------------------------------------------
// Multi-tab loop
// ---------------------------------------------------------------------------
function scheduleLoop() {
  try { chrome.alarms.create(LOOP_ALARM, { delayInMinutes: 1 / 60 }); } catch {
    // Fallback: run directly if alarms unavailable
    loopAll();
  }
}

async function loopAll() {
  const tabIds = [...tasksByTab.keys()];
  const promises = [];
  for (const tabId of tabIds) {
    if (loopRunningTabs.has(tabId)) continue;
    const task = tasksByTab.get(tabId);
    if (!task) continue;
    if (['done', 'aborted', 'error'].includes(task.state.status)) {
      releaseTabTask(tabId);
      continue;
    }
    loopRunningTabs.add(tabId);
    promises.push(loopTab(tabId).finally(() => loopRunningTabs.delete(tabId)));
  }
  if (promises.length > 0) await Promise.all(promises);
}

async function loopTab(tabId) {
  const task      = tasksByTab.get(tabId);
  const agentEntry = agentsByTab.get(tabId);
  if (!task || !agentEntry) return;
  const agent = agentEntry.agent;
  const state = task.state;

  if (['done', 'aborted', 'error'].includes(state.status)) {
    releaseTabTask(tabId); return;
  }

  if (state.status === 'awaiting_approval') {
    try {
      const liveSettings = await getSettings();
      if (liveSettings.confirmationMode === 'always-allow' ||
          (task.settings && task.settings.confirmationMode === 'always-allow')) {
        if (!state.pendingToolCall) {
          state.status = 'running';
        } else {
          const r = await agent.handleApprovalResponse('allow-once');
          if (r && r.status === 'executing_tool') await agent.executeTool();
        }
      } else {
        return; // wait for user approval
      }
    } catch (e) {
      console.error('[webnav] auto-approval failed', e);
      try { await agent.abort({ kind: 'error', message: e.message }); } catch {}
      releaseTabTask(tabId); return;
    }
  }

  if (state.status === 'awaiting_user') return;

  // Collect context from linked tabs (if any) so the AI sees all linked pages.
  if (linkedTabs.size > 0) {
    const linkedCtx = [];
    for (const lid of linkedTabs) {
      if (lid === tabId) continue; // skip self — already has its own snapshot
      const cached = snapshotCache.get(lid);
      if (cached && cached.snapshot && (Date.now() - cached.lastAccess) < 5000) {
        linkedCtx.push({ tabId: lid, snapshot: cached.snapshot, fresh: false });
      } else {
        try {
          const r = await chrome.tabs.sendMessage(lid, { type: 'SNAPSHOT' });
          if (r && r.snapshot) {
            cacheSnapshot(lid, r.snapshot);
            linkedCtx.push({ tabId: lid, snapshot: r.snapshot, fresh: true });
          }
        } catch { /* tab may not support content scripts */ }
      }
    }
    state.linkedContexts = linkedCtx;
  } else {
    state.linkedContexts = null;
  }

  try {
    const r = await agent.runStep();
    if (agent.isAborted()) { releaseTabTask(tabId); return; }
    if (r && r.status === 'executing_tool') {
      const er = await agent.executeTool();
      if (agent.isAborted()) { releaseTabTask(tabId); return; }
      if (er && er.status === 'awaiting_user') return;
    }
  } catch (e) {
    console.error('[webnav] step error on tab', tabId, e);
    broadcastAll({ kind: 'error', taskId: task.id, tabId, error: e.message });
    try { await agent.abort({ kind: 'error', message: e.message }); } catch {}
    releaseTabTask(tabId); return;
  }

  // Re-arm alarm if still running
  const current = tasksByTab.get(tabId);
  if (current && !['done', 'aborted', 'error'].includes(current.state.status) &&
      !['awaiting_approval', 'awaiting_user'].includes(current.state.status)) {
    try { chrome.alarms.create(LOOP_ALARM, { delayInMinutes: 1 / 60 }); } catch {}
  } else if (current && ['done', 'aborted', 'error'].includes(current.state.status)) {
    releaseTabTask(tabId);
  }
}

function releaseTabTask(tabId) {
  const task = tasksByTab.get(tabId);
  if (task && ['done', 'aborted', 'error'].includes(task.state.status)) {
    hideOverlay(tabId);
    tasksByTab.delete(tabId);
    agentsByTab.delete(tabId);
    broadcastAll({ kind: 'tab_list_changed' });
  }
}

async function stopTabTask(tabId) {
  const agentEntry = agentsByTab.get(tabId);
  if (agentEntry && agentEntry.agent) {
    try { await agentEntry.agent.abort({ kind: 'aborted', message: 'user_stopped' }); } catch {}
  }
  hideOverlay(tabId);
  tasksByTab.delete(tabId);
  agentsByTab.delete(tabId);
  broadcastAll({ kind: 'tab_list_changed' });
}

// ---------------------------------------------------------------------------
// Approval / Ask-user responses
// ---------------------------------------------------------------------------
async function handleApprovalResponse(taskId, decision) {
  // Find which tab this task belongs to
  let tabId = null;
  for (const [tid, task] of tasksByTab) {
    if (task.id === taskId) { tabId = tid; break; }
  }
  if (tabId === null) {
    const restored = await restoreTaskById(taskId);
    if (!restored) { sendMessageError('task_not_found'); return; }
    for (const [tid, task] of tasksByTab) {
      if (task.id === taskId) { tabId = tid; break; }
    }
  }
  if (tabId === null) { sendMessageError('task_not_found'); return; }

  const task = tasksByTab.get(tabId);
  if (!task || task.state.status !== 'awaiting_approval') { sendMessageError('not_awaiting_approval'); return; }

  const agentEntry = agentsByTab.get(tabId);
  if (!agentEntry) { sendMessageError('agent_missing'); return; }
  const r = await agentEntry.agent.handleApprovalResponse(decision);
  if (r && r.status === 'executing_tool') {
    try { await agentEntry.agent.executeTool(); } catch (e) { console.error('[webnav] executeTool after approval failed', e); }
  }
  scheduleLoop();
}

async function handleAskUserAnswer(taskId, answer) {
  let tabId = null;
  for (const [tid, task] of tasksByTab) {
    if (task.id === taskId) { tabId = tid; break; }
  }
  if (tabId === null) {
    const restored = await restoreTaskById(taskId);
    if (!restored) { sendMessageError('task_not_found'); return; }
    for (const [tid, task] of tasksByTab) {
      if (task.id === taskId) { tabId = tid; break; }
    }
  }
  if (tabId === null) { sendMessageError('task_not_found'); return; }

  const task = tasksByTab.get(tabId);
  if (!task || task.state.status !== 'awaiting_user') { sendMessageError('not_awaiting_user'); return; }

  const agentEntry = agentsByTab.get(tabId);
  if (!agentEntry) { sendMessageError('agent_missing'); return; }
  try { await agentEntry.agent.handleAskUserAnswer(answer); } catch (e) { console.error('[webnav] handleAskUserAnswer failed', e); }
  scheduleLoop();
}

function sendMessageError(error) {
  broadcastAll({ kind: 'error', error });
}

async function restoreTaskById(taskId) {
  try {
    const obj = await session.get(KEYS.AGENT(taskId));
    if (!obj) return false;
    await startAgent(obj, true);
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Tab events
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'SNAPSHOT' });
      if (r && r.snapshot) cacheSnapshot(tabId, r.snapshot);
    } catch {}
    // Restore overlay if an active task is on this tab (page reload)
    const task = tasksByTab.get(tabId);
    if (task && ['running', 'awaiting_approval', 'awaiting_user'].includes(task.state.status)) {
      setTimeout(() => showOverlay(tabId), 300);
    }
  }
  if (changeInfo.url) {
    invalidateSnapshot(tabId);
  }
  // Broadcast tab list change so sidebar refreshes title/favicon
  if (changeInfo.title || changeInfo.favIconUrl || changeInfo.status === 'complete') {
    broadcastAll({ kind: 'tab_list_changed' });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  snapshotCache.delete(tabId);
  try { await session.remove(KEYS.SNAPSHOT(tabId)); } catch {}
  if (tasksByTab.has(tabId)) {
    const task = tasksByTab.get(tabId);
    broadcastAll({ kind: 'error', taskId: task && task.id, tabId, error: 'active_tab_closed' });
    const agentEntry = agentsByTab.get(tabId);
    if (agentEntry) {
      try { await agentEntry.agent.abort({ kind: 'aborted', message: 'active_tab_closed' }); } catch {}
    }
    tasksByTab.delete(tabId);
    agentsByTab.delete(tabId);
  }
  broadcastAll({ kind: 'tab_list_changed' });
});

chrome.tabs.onCreated.addListener(() => {
  broadcastAll({ kind: 'tab_list_changed' });
});

chrome.tabs.onActivated.addListener(() => {
  broadcastAll({ kind: 'tab_list_changed' });
});

// ---------------------------------------------------------------------------
// Snapshot cache
// ---------------------------------------------------------------------------
function cacheSnapshot(tabId, snapshot) {
  snapshotCache.set(tabId, { snapshot, lastAccess: Date.now() });
  if (snapshotCache.size > SNAPSHOT_CACHE_SIZE) {
    let oldestKey = null, oldestTime = Infinity;
    for (const [k, v] of snapshotCache.entries()) {
      if (v.lastAccess < oldestTime) { oldestTime = v.lastAccess; oldestKey = k; }
    }
    if (oldestKey != null) {
      snapshotCache.delete(oldestKey);
      session.remove(KEYS.SNAPSHOT(oldestKey)).catch(() => {});
    }
  }
  session.set(KEYS.SNAPSHOT(tabId), { snapshot, capturedAt: Date.now() }).catch(() => {});
}

function invalidateSnapshot(tabId) {
  if (snapshotCache.has(tabId)) {
    const e = snapshotCache.get(tabId);
    e.snapshot = null;
    e.lastAccess = Date.now();
  }
}
