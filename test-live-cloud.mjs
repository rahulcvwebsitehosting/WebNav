// LIVE test: drives the REAL Agent against the REAL Ollama Cloud API.
// Goal: "open youtube" — confirms the extension's chat -> tool-call -> execute
// loop works with a real cloud key. Throws away no real browsing; chrome.tabs
// is mocked so navigate() is recorded, not executed.
process.chdir('C:/Users/saini/Downloads/BrowserExt');

const API_KEY = 'd45e2a3b026143568857cb44329e0e53.hBFAoTYpQdwFU73XpG7DahJF';
const BASE_URL = 'https://ollama.com/v1';
const MODEL = 'gpt-oss:20b';

const navLog = [];
globalThis.self = globalThis;

const localData = { 'profileKeys:pf1': API_KEY };

const chrome = {
  storage: {
    local: {
      get: async (k) => (typeof k === 'string' && k in localData) ? { [k]: localData[k] } : {},
      set: async () => {}, remove: async () => {}
    },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} }
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://example.com', title: 'Example' }],
    update: async (id, props) => { navLog.push('tabs.update ' + id + ' ' + JSON.stringify(props)); return { id }; },
    create: async (props) => { navLog.push('tabs.create ' + JSON.stringify(props)); return { id: 2 }; },
    get: async (id) => ({ id, status: 'complete' }),
    goBack: async (id) => { navLog.push('goBack ' + id); },
    reload: async (id) => { navLog.push('reload ' + id); },
    sendMessage: async () => ({ ok: true, snapshot: { url: 'https://example.com', title: 'Example', origin: 'https://example.com', capturedAt: Date.now(), elementCount: 1, elements: [{ id: 'e_1', tag: 'A', text: 'link' }], elementsById: { e_1: { id: 'e_1', tag: 'A', text: 'link' } }, hash: 'h' } })
  },
  scripting: { executeScript: async () => {} },
  runtime: { sendMessage: () => Promise.resolve(), getURL: (p) => p, onMessage: { addListener: () => {} } }
};
globalThis.chrome = chrome;

(async () => {
  const { Agent } = await import('./lib/agent.js');
  const { newCounters } = await import('./lib/usage.js');
  const { setBuiltinCategories } = await import('./lib/allowlist.js');
  const { setPSLData } = await import('./lib/psl.js');
  setBuiltinCategories({ version: 't', categories: { banking: { patterns: ['chase.com'] } } });
  setPSLData('com\nnet\norg\n');

  const task = {
    id: 'live1', goal: 'open youtube', profileId: 'pf1',
    profile: { id: 'pf1', name: 'Ollama Cloud', baseUrl: BASE_URL, model: MODEL, temperature: 0.2, maxSteps: 4, isDefault: true },
    settings: {
      confirmationMode: 'destructive-only',
      loop: { enabled: true, sameActionLimit: 3, sequenceLength: 4, sequenceRepetitionLimit: 2 },
      redact: {}, injectionFilterSensitivity: 'medium',
      allow: [], deny: [], userOverrides: {}
    },
    tabId: 1,
    state: { status: 'running', messages: [{ kind: 'goal', role: 'user', content: 'open youtube' }], stepsTaken: 0, lastSnapshot: null, pageContext: { url: 'https://example.com', title: 'Example', origin: 'https://example.com' }, pendingToolCall: null, pendingAskUser: null, finalAnswer: null, error: null },
    counters: newCounters(), approvedPairs: [], recentActions: [], injectionHitsTotal: 0, maxSteps: 4, maxWallTime: 60000, startedAt: Date.now()
  };

  const agent = new Agent(task);
  console.log('Goal: "open youtube" | model:', MODEL, '| baseUrl:', BASE_URL, '\n');

  for (let step = 1; step <= 4; step++) {
    console.log('--- Step ' + step + ' ---');
    const r = await agent.runStep();
    console.log('  runStep =>', r.status);
    if (r.status === 'done' || r.status === 'error' || r.status === 'aborted') break;
    if (r.status === 'executing_tool') {
      const er = await agent.executeTool();
      console.log('  executeTool =>', er.status);
      if (er.status === 'done' || er.status === 'error' || er.status === 'aborted') break;
    }
  }

  console.log('\n=== RESULT ===');
  console.log('Final status:', task.state.status);
  console.log('Final answer:', task.state.finalAnswer || '(none)');
  if (task.state.error) console.log('Error:', JSON.stringify(task.state.error));
  console.log('Navigation actions:', navLog.length ? navLog : '(none)');
  console.log('Model calls:', task.counters.modelCalls, '| Tool executions:', task.counters.toolExecutions, '| Parse errors:', task.counters.parseErrors);

  // Verdict
  const navigated = navLog.some(n => /youtube/i.test(n));
  if (task.state.status === 'done') {
    console.log(navigated ? '\nLIVE CLOUD TEST PASSED: task completed AND navigated to youtube.' : '\nLIVE CLOUD TEST: task completed (model may have used a different approach).');
  } else {
    console.log('\nLIVE CLOUD TEST: task did not reach "done". See details above.');
  }
})().catch(e => { console.error('TEST ERROR:', e); console.error(e.stack); process.exit(1); });
