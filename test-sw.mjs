// End-to-end test for the service-worker message handlers.
// Imports the REAL service worker, drives its onMessage listener, and proves:
//   1. START_TASK is gated by allowlistMode (first_run_required).
//   2. SET_ALLOWLIST_MODE persists the mode.
//   3. After setting the mode, START_TASK succeeds.
process.chdir('C:/Users/saini/Downloads/BrowserExt');

// --- chrome mock ---
const localStore = {};
const sessionStore = {};
let onMessageListener = null;

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onMessage: { addListener: (fn) => { onMessageListener = fn; } },
    openOptionsPage: async () => {},
    sendMessage: () => Promise.resolve(),
    getURL: (p) => p,
    lastError: null
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} }
  },
  sidePanel: { open: async () => {} },
  storage: {
    local: {
      get: async (k) => {
        if (k === null) return Object.assign({}, localStore);
        if (typeof k === 'string') return k in localStore ? { [k]: localStore[k] } : {};
        if (Array.isArray(k)) { const out = {}; for (const x of k) if (x in localStore) out[x] = localStore[x]; return out; }
        if (typeof k === 'object') { const out = {}; for (const x of Object.keys(k)) out[x] = x in localStore ? localStore[x] : k[x]; return out; }
        return {};
      },
      set: async (o) => { Object.assign(localStore, o); },
      remove: async (k) => { if (Array.isArray(k)) k.forEach(x => delete localStore[x]); else delete localStore[k]; }
    },
    session: {
      get: async (k) => { if (k === null) return Object.assign({}, sessionStore); if (typeof k === 'string') return k in sessionStore ? { [k]: sessionStore[k] } : {}; return {}; },
      set: async (o) => { Object.assign(sessionStore, o); },
      remove: async (k) => { if (Array.isArray(k)) k.forEach(x => delete sessionStore[x]); else delete sessionStore[k]; }
    }
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://example.com', title: 'Example' }],
    update: async () => {},
    get: async () => ({ id: 1, status: 'complete' }),
    goBack: async () => {},
    reload: async () => {},
    create: async () => ({ id: 2 }),
    sendMessage: async () => ({ ok: true, snapshot: { url: 'https://example.com', title: 'Example', origin: 'https://example.com', capturedAt: Date.now(), elements: [], elementsById: {}, elementCount: 0, hash: 'x' } }),
    onUpdated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    onActivated: { addListener: () => {} }
  },
  scripting: { executeScript: async () => {} }
};

// In a service worker `self` === globalThis; Node doesn't define it by default.
globalThis.self = globalThis;

// fetch mock: serve the bundled data files + a fake model response.
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('deny-categories')) return { ok: true, json: async () => ({ version: 't', categories: { banking: { patterns: ['chase.com'] } } }) };
  if (u.includes('psl')) return { ok: true, text: async () => 'com\nnet\norg\n' };
  // Model endpoint
  if (u.includes('/chat/completions')) {
    return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'finish', arguments: '{"answer":"done"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) };
  }
  if (u.includes('/models')) return { ok: true, json: async () => ({ data: [{ id: 'qwen2.5' }] }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

// Helper to send a message to the registered onMessage listener.
function send(msg) {
  return new Promise((resolve) => {
    onMessageListener(msg, {}, (resp) => resolve(resp));
  });
}

(async () => {
  // Import the real service worker. This registers the onMessage listener.
  await import('./background/service-worker.js');
  if (!onMessageListener) throw new Error('SW did not register an onMessage listener');

  // Ensure a profile exists (the SW seeds a default on install; do it explicitly here).
  await send({ type: 'GET_PROFILES' });

  // Seed a profile key so the agent can authenticate.
  await chrome.storage.local.set({ 'profileKeys:pf_default_ollama': 'test-key' });

  // 1) START_TASK before allowlistMode is set => first_run_required
  let r1 = await send({ type: 'START_TASK', goal: 'open youtube', profileId: 'pf_default_ollama' });
  console.log('1) START_TASK before mode:', r1.ok ? 'UNEXPECTED ok' : r1.error);
  if (r1.error !== 'first_run_required') { console.log('FAIL: expected first_run_required'); process.exit(1); }

  // 2) SET_ALLOWLIST_MODE with an invalid mode => rejected
  let r2bad = await send({ type: 'SET_ALLOWLIST_MODE', mode: 'bogus' });
  console.log('2a) SET_ALLOWLIST_MODE(bogus):', r2bad.ok ? 'UNEXPECTED ok' : r2bad.error);
  if (r2bad.ok) { console.log('FAIL: bogus mode accepted'); process.exit(1); }

  // 3) SET_ALLOWLIST_MODE with a valid mode => ok
  let r3 = await send({ type: 'SET_ALLOWLIST_MODE', mode: 'allow-all-non-blocked' });
  console.log('3) SET_ALLOWLIST_MODE(valid):', r3.ok ? 'ok -> ' + r3.allowlistMode : r3.error);
  if (!r3.ok || r3.allowlistMode !== 'allow-all-non-blocked') { console.log('FAIL: valid mode not saved'); process.exit(1); }

  // 4) Verify it persisted to storage.
  const settings = (await send({ type: 'GET_SETTINGS' })).settings;
  console.log('4) persisted allowlistMode:', settings.allowlistMode);
  if (settings.allowlistMode !== 'allow-all-non-blocked') { console.log('FAIL: mode not persisted'); process.exit(1); }

  // 5) START_TASK again => now ok (the gate is passed).
  let r5 = await send({ type: 'START_TASK', goal: 'open youtube', profileId: 'pf_default_ollama' });
  console.log('5) START_TASK after mode:', r5.ok ? 'ok -> taskId ' + r5.taskId : r5.error);
  if (!r5.ok) { console.log('FAIL: task still blocked after setting mode'); process.exit(1); }

  console.log('\nSERVICE WORKER HANDLER TEST PASSED');
})().catch(e => { console.error('TEST ERROR:', e); console.error(e.stack); process.exit(1); });
