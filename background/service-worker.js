// background/service-worker.js
// Orchestrates task lifecycle, snapshot cache, port management, and crash recovery.
//
// The agent loop is implemented as a self-rescheduling alarm rather than a
// while loop, so the service worker can be suspended by Chrome at any time
// (e.g. when the browser is in the background) without losing progress. After
// each step we set an alarm to wake us up in ~1s; the alarm handler runs one
// more step then reschedules. This is the same pattern Chrome recommends for
// long-running SW work.

import { Agent } from '../lib/agent.js';
import { session, local, KEYS, getSettings, updateSettings } from '../lib/storage.js';
import { newCounters, recordApproval } from '../lib/usage.js';
import { check, loadBuiltinCategories } from '../lib/allowlist.js';
import { toolResultWrap } from '../lib/prompt-defense.js';

const snapshotCache = new Map();
let activeTaskByTab = new Map();
let currentAgent = null;
let currentTask = null;
let loopRunning = false;
// Connected UI ports (popup + sidebar). Broadcasts are pushed to all of these
// so live events (task_started, tool_executing, tool_result, done, ...) reach
// the UIs. Messages are also sent via chrome.runtime.sendMessage as a fallback.
const uiPorts = new Set();
const SNAPSHOT_CACHE_SIZE = 20;
const LOOP_ALARM = 'webnav-loop';
const HEARTBEAT_ALARM = 'agent-heartbeat';

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

chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.33 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || !alarm.name) return;
  if (alarm.name === HEARTBEAT_ALARM) {
    if (currentTask) {
      try { await session.set(KEYS.AGENT(currentTask.id) + ':hb', Date.now()); } catch {}
    }
  } else if (alarm.name === LOOP_ALARM) {
    // The loop alarm fires — run one step.
    if (!loopRunning) {
      loopRunning = true;
      loop().finally(() => { loopRunning = false; });
    }
  }
});

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

async function resumeIfAny() {
  await ensureDefaultProfile();
  const all = await session.list('agent:');
  for (const [key, payload] of Object.entries(all)) {
    if (!payload || !payload.state) continue;
    if (['done', 'aborted', 'error'].includes(payload.state.status)) continue;
    if (key.endsWith(':hb')) continue;
    const lastBeat = payload._heartbeat || payload.startedAt || 0;
    if (Date.now() - lastBeat > 5 * 60 * 1000 && !['awaiting_approval', 'awaiting_user'].includes(payload.state.status)) {
      payload.state.status = 'error';
      payload.state.error = { kind: 'error', message: 'orphaned' };
      await session.set(key, payload);
      continue;
    }
    await startAgent(payload, true);
  }
}

// --- port connections ---
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
        stopCurrentTask().catch((e) => console.error(e));
      }
    });
    port.onDisconnect.addListener(() => {
      uiPorts.delete(port);
    });
    sendStatusToPort(port);
  }
});

function sendStatusToPort(port) {
  try {
    if (!currentTask) {
      port.postMessage({ kind: 'idle' });
      return;
    }
    port.postMessage({
      kind: 'status',
      task: {
        id: currentTask.id,
        goal: currentTask.goal,
        status: currentTask.state.status,
        counters: currentTask.counters,
        thinking: currentTask.state.thinking || null
      }
    });
  } catch (e) { /* port closed */ }
}

function broadcastAll(event) {
  // Push to every connected UI port (popup + sidebar). This is the primary
  // live channel — the UIs listen on their ports, not on runtime.onMessage.
  for (const port of uiPorts) {
    try { port.postMessage(event); } catch (e) { /* port closed */ }
  }
  // Fallback: also fire runtime.sendMessage for any context that listens that way.
  try { chrome.runtime.sendMessage(event).catch(() => {}); } catch {}
}

// --- message API ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg) { sendResponse({ ok: false, error: 'empty' }); return; }
      switch (msg.type) {
        case 'START_TASK': {
          const r = await startTask(msg.goal, msg.profileId);
          sendResponse(r);
          break;
        }
        case 'STOP_TASK': {
          await stopCurrentTask();
          sendResponse({ ok: true });
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
          const isOllamaCloud = /^https:\/\/ollama\.com\/v1$/i.test(cleanBase);
          
          // Ollama native (local) doesn't use Bearer auth. Only send auth header for
          // Ollama Cloud and other OpenAI-compatible backends.
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
              lastErr = 'connected but no models returned';
              lastErrKind = 'empty';
            } else {
              const snippet = (await res.text().catch(() => '') || '').slice(0, 200);
              if (res.status === 401 || res.status === 403) {
                lastErrKind = 'auth';
                lastErr = `HTTP ${res.status} — authentication failed. Check your API key.${snippet ? ' (' + snippet + ')' : ''}`;
              } else {
                lastErrKind = 'http';
                lastErr = `HTTP ${res.status}${snippet ? ': ' + snippet : ''}`;
              }
            }
          } catch (e) {
            lastErrKind = 'network';
            lastErr = e && e.message ? e.message : String(e);
          }

          // Fallback: try the native Ollama endpoint (e.g. https://ollama.com/api/tags
          // or http://localhost:11434/api/tags). Mainly helps local Ollama.
          const nativeBase = cleanBase.replace(/\/v1$/, '');
          try {
            const res2 = await fetch(nativeBase + '/api/tags', { method: 'GET', headers: authHeaders });
            if (res2.ok) {
              const body2 = await res2.json();
              if (Array.isArray(body2.models) && body2.models.length > 0) {
                sendResponse({ ok: true, models: body2.models.map(m => m.name).filter(Boolean) });
                return;
              }
            } else if (lastErrKind === 'network' || !lastErr) {
              if (res2.status === 401 || res2.status === 403) { lastErrKind = 'auth'; lastErr = `HTTP ${res2.status} — authentication failed. Check your API key.`; }
              else { lastErrKind = 'http'; lastErr = `HTTP ${res2.status}`; }
            }
          } catch (e) {
            if (lastErrKind === 'network' || !lastErr) lastErr = e && e.message ? e.message : String(e);
          }

          // Craft a cause-specific, actionable message instead of always blaming the key.
          let message;
          if (lastErrKind === 'network') {
            message = isLocal
              ? `Could not reach ${cleanBase}. Is the local server running? (e.g. start Ollama, then visit ${cleanBase.replace(/\/v1$/, '')} in a browser.)`
              : `Could not reach ${cleanBase}. Check the Base URL and your connection. For Ollama Cloud use https://ollama.com/v1 — not https://ollama.com/api/v1.`;
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
          // Real key validation: send an actual (minimal) chat completion and
          // accept only a 2xx response with a usable message. Unlike
          // /v1/models (which is public on Ollama Cloud), this endpoint
          // rejects bad/missing keys with 401/403.
          const { baseUrl, key, model } = msg;
          const cleanBase = (baseUrl || '').replace(/\/+$/, '');
          const headers = { 'Content-Type': 'application/json' };
          if (key) headers['Authorization'] = `Bearer ${key}`;
          const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(cleanBase);
          const body = JSON.stringify({
            model: model || 'gpt-oss:20b',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            temperature: 0
          });
          try {
            const res = await fetch(cleanBase + '/chat/completions', { method: 'POST', headers, body });
            if (res.ok) {
              sendResponse({ ok: true, status: res.status });
            } else {
              const snippet = (await res.text().catch(() => '') || '').slice(0, 200);
              let message;
              if (res.status === 401 || res.status === 403) {
                message = `Authentication failed (HTTP ${res.status}). Your API key is missing, invalid, or not authorized for this model.${snippet ? ' — ' + snippet : ''}`;
              } else if (res.status === 404) {
                message = `HTTP 404 at ${cleanBase}/chat/completions. Check the Base URL${model ? '' : ' and model name'}. For Ollama Cloud use https://ollama.com/v1.`;
              } else {
                message = `Server returned HTTP ${res.status}.${snippet ? ' — ' + snippet : ''}`;
              }
              sendResponse({ ok: false, kind: 'http', status: res.status, error: message });
            }
          } catch (e) {
            const msg2 = e && e.message ? e.message : String(e);
            const message = isLocal
              ? `Could not reach ${cleanBase}. Is the local server running? (${msg2})`
              : `Could not reach ${cleanBase}. Check the Base URL and connection. For Ollama Cloud use https://ollama.com/v1 — not https://ollama.com/api/v1. (${msg2})`;
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
          if (!currentTask) { sendResponse({ ok: true, task: null }); return; }
          sendResponse({ ok: true, task: { id: currentTask.id, goal: currentTask.goal, status: currentTask.state.status, counters: currentTask.counters, state: currentTask.state, tabId: currentTask.tabId } });
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

async function startTask(goal, profileId) {
  if (!goal || !goal.trim()) return { ok: false, error: 'empty_goal' };
  if (currentTask && !['done', 'aborted', 'error'].includes(currentTask.state.status)) {
    return { ok: false, error: 'another_task_running' };
  }
  await ensureDefaultProfile();
  const settings = await getSettings();
  if (!settings.allowlistMode) {
    return { ok: false, error: 'first_run_required', message: 'Open Options to pick an allowlist mode before starting a task.' };
  }
  const profiles = (await local.get(KEYS.PROFILES, [])) || [];
  const profile = (profileId && profiles.find(p => p.id === profileId)) || profiles.find(p => p.isDefault) || profiles[0];
  if (!profile) return { ok: false, error: 'no_profile' };
  
  // Attach the stored API key to the profile so AIClient can use it.
  // local.get() returns the value at the key directly (not wrapped), so the
  // returned value is the key string itself (or null).
  const storedKey = await local.get(KEYS.PROFILE_KEY(profile.id), null);
  if (storedKey) {
    profile.apiKey = storedKey;
  }
  
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) return { ok: false, error: 'no_active_tab' };
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
  activeTaskByTab.set(tab.id, id);
  await startAgent(task, false);
  return { ok: true, taskId: id };
}

async function startAgent(task, isResume) {
  currentTask = task;
  currentAgent = { taskId: task.id, agent: new Agent(task) };
  // Only announce a new task on a fresh start. Resumes must not re-emit
  // task_started, or the popup will wipe its log and re-show the goal as a
  // brand-new run.
  if (!isResume) {
    broadcastAll({ kind: 'task_started', taskId: task.id, goal: task.goal });
    // Take an initial snapshot opportunistically (best-effort).
    try {
      const r = await chrome.tabs.sendMessage(task.tabId, { type: 'SNAPSHOT' });
      if (r && r.snapshot) {
        task.state.lastSnapshot = r.snapshot;
        task.state.pageContext = { url: r.snapshot.url, title: r.snapshot.title, origin: r.snapshot.origin };
        cacheSnapshot(task.tabId, r.snapshot);
      }
    } catch {}
  } else {
    // On resume, if the task was paused waiting for user input or approval, re-broadcast
    // the pending event so the sidebar/popup can re-show the modal.
    if (task.state && task.state.status === 'awaiting_user' && task.state.pendingAskUser) {
      broadcastAll({ kind: 'ask_user', taskId: task.id, args: task.state.pendingAskUser });
    }
    if (task.state && task.state.status === 'awaiting_approval' && task.state.pendingToolCall) {
      broadcastAll({ kind: 'approval_requested', taskId: task.id, call: task.state.pendingToolCall.call, risk: task.state.pendingToolCall.risk });
    }
  }
  scheduleLoop();
}

function scheduleLoop() {
  // Use a chrome.alarm to wake the SW instead of relying on a busy setTimeout
  // chain. The alarm handler at the top of the file kicks off the loop if it
  // is not already running.
  if (loopRunning) {
    // Loop is already alive — no need to arm the alarm, the in-flight step
    // will reschedule on completion.
    return;
  }
  try {
    chrome.alarms.create(LOOP_ALARM, { delayInMinutes: 1 / 60 }); // ~1 second
  } catch {
    // Fallback: kick the loop directly if the alarm API is unavailable.
    loopRunning = true;
    loop().finally(() => { loopRunning = false; });
  }
}

async function loop() {
  if (!currentAgent || !currentTask) return;
  // Grab local references so concurrent nullification of globals doesn't crash us.
  const agent = currentAgent.agent;
  const task = currentTask;
  // One step per loop iteration. The alarm reschedules us for the next step.
  // This way the SW can be killed by Chrome between steps without losing
  // progress; resumeIfAny() will pick the task back up on next start.
  const state = task.state;
  if (['done', 'aborted', 'error'].includes(state.status)) {
    releaseTask();
    return;
  }
  if (state.status === 'awaiting_approval') {
    // If mode is "always-allow", auto-approve so the agent never gets stuck.
    // Check both the task's cached settings AND the live settings (mode may have changed mid-task).
    try {
      const liveSettings = await getSettings();
      if (liveSettings.confirmationMode === 'always-allow' || (task.settings && task.settings.confirmationMode === 'always-allow')) {
        const r = await agent.handleApprovalResponse('allow-once');
        if (r && r.status === 'executing_tool') {
          await agent.executeTool();
        }
      } else {
        return; // wait for user response
      }
    } catch (e) {
      console.error('[webnav] auto-approval failed', e);
      releaseTask();
      return;
    }
  }
  if (state.status === 'awaiting_user') {
    return; // wait for user response
  }
  try {
    const r = await agent.runStep();
    if (agent.isAborted()) { releaseTask(); return; }
    if (r && r.status === 'executing_tool') {
      const er = await agent.executeTool();
      if (agent.isAborted()) { releaseTask(); return; }
      if (er && er.status === 'awaiting_user') return; // user will reschedule
    }
  } catch (e) {
    console.error('[webnav] step error', e);
    broadcastAll({ kind: 'error', taskId: task.id, error: e.message });
    try { await agent.abort({ kind: 'error', message: e.message }); } catch {}
    releaseTask();
    return;
  }

  // Re-arm the alarm for the next step. If the SW is killed in between, the
  // next alarm will resume the task via resumeIfAny().
  if (currentTask && !['done', 'aborted', 'error'].includes(currentTask.state.status)
      && !['awaiting_approval', 'awaiting_user'].includes(currentTask.state.status)) {
    try { chrome.alarms.create(LOOP_ALARM, { delayInMinutes: 1 / 60 }); } catch {}
  } else if (currentTask && ['done', 'aborted', 'error'].includes(currentTask.state.status)) {
    releaseTask();
  }
}

function releaseTask() {
  // Keep currentTask around for a brief GET_CURRENT_TASK query, but clear the
  // agent so the next START_TASK can run. Actually we just null both to keep
  // things simple and consistent.
  if (currentTask && ['done', 'aborted', 'error'].includes(currentTask.state.status)) {
    currentTask = null;
    currentAgent = null;
  }
}

async function stopCurrentTask() {
  if (currentAgent && currentAgent.agent) {
    await currentAgent.agent.abort({ kind: 'aborted', message: 'user_stopped' });
  }
  currentAgent = null;
  currentTask = null;
}

async function handleApprovalResponse(taskId, decision) {
  if (!currentTask || currentTask.id !== taskId) {
    // Try to restore from session storage (SW may have restarted).
    const restored = await restoreTaskById(taskId);
    if (!restored) { sendMessageError('task_not_found'); return; }
  }
  if (currentTask.state.status !== 'awaiting_approval') {
    sendMessageError('not_awaiting_approval');
    return;
  }
  // Grab local ref so re-entrant nullification of globals doesn't crash us.
  const agent = currentAgent.agent;
  const r = await agent.handleApprovalResponse(decision);
  if (r && r.status === 'executing_tool') {
    try { await agent.executeTool(); } catch (e) { console.error('[webnav] executeTool after approval failed', e); }
  }
  scheduleLoop();
}

async function handleAskUserAnswer(taskId, answer) {
  if (!currentTask || currentTask.id !== taskId) {
    // Try to restore from session storage (SW may have restarted).
    const restored = await restoreTaskById(taskId);
    if (!restored) { sendMessageError('task_not_found'); return; }
  }
  if (currentTask.state.status !== 'awaiting_user') {
    sendMessageError('not_awaiting_user');
    return;
  }
  const agent = currentAgent.agent;
  try { await agent.handleAskUserAnswer(answer); } catch (e) { console.error('[webnav] handleAskUserAnswer failed', e); }
  scheduleLoop();
}

// The SW hooks the broadcast function so agent.js can push live events
// to all connected UI ports. See the module-scope variable below.

function sendMessageError(error) {
  // Best-effort: tell all listeners the request was rejected.
  try { chrome.runtime.sendMessage({ kind: 'error', error }).catch(() => {}); } catch {}
}

async function restoreTaskById(taskId) {
  try {
    const obj = await session.get(KEYS.AGENT(taskId));
    if (!obj) return false;
    await startAgent(obj, true);
    return true;
  } catch {
    return false;
  }
}

// --- tab events ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'SNAPSHOT' });
      if (r && r.snapshot) cacheSnapshot(tabId, r.snapshot);
    } catch {}
  }
  if (changeInfo.url) {
    invalidateSnapshot(tabId);
    if (currentTask && currentTask.tabId === tabId) {
      // The agent will re-snapshot on its next step.
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  snapshotCache.delete(tabId);
  try { await session.remove(KEYS.SNAPSHOT(tabId)); } catch {}
  if (currentTask && currentTask.tabId === tabId) {
    broadcastAll({ kind: 'error', taskId: currentTask.id, error: 'active_tab_closed' });
    try { if (currentAgent) await currentAgent.agent.abort({ kind: 'aborted', message: 'active_tab_closed' }); } catch {}
    currentAgent = null;
    currentTask = null;
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (currentTask && currentTask.tabId !== tabId) {
    currentTask.tabId = tabId;
    activeTaskByTab.set(tabId, currentTask.id);
    try { await session.set(KEYS.AGENT(currentTask.id), currentTask); } catch {}
  }
});

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
