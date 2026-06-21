// Full end-to-end agent loop test with mocked fetch + chrome APIs.
process.chdir('C:/Users/saini/Downloads/BrowserExt');

const chrome = {
  storage: {
    local: (() => {
      const data = {};
      return {
        get: async (k, d) => {
          if (k === null || k === undefined) return Object.assign({}, data);
          if (typeof k === 'string') return k in data ? { [k]: data[k] } : d === undefined ? {} : { [k]: d };
          if (Array.isArray(k)) { const out = {}; for (const x of k) out[x] = x in data ? data[x] : (d || {})[x]; return out; }
          return d || {};
        },
        set: async (o) => { Object.assign(data, o); },
        remove: async (k) => { if (Array.isArray(k)) k.forEach(x => delete data[x]); else delete data[k]; }
      };
    })(),
    session: (() => {
      const data = {};
      return {
        get: async (k) => k in data ? { [k]: data[k] } : {},
        set: async (o) => { Object.assign(data, o); },
        remove: async (k) => { if (Array.isArray(k)) k.forEach(x => delete data[x]); else delete data[k]; }
      };
    })()
  },
  tabs: {
    sendMessage: async (tabId, msg) => {
      if (msg.type === 'SNAPSHOT') return { ok: true, snapshot: { url: 'https://example.com', title: 'Example', origin: 'https://example.com', capturedAt: Date.now(), elementCount: 0, elements: [], elementsById: {}, hash: 'abc' } };
      if (msg.type === 'EXECUTE') return { ok: true, snapshot: { url: 'https://example.com', title: 'Example', origin: 'https://example.com', capturedAt: Date.now(), elementCount: 0, elements: [], elementsById: {}, hash: 'abc' } };
      return { ok: true };
    },
    query: async () => [{ id: 1, url: 'https://example.com', title: 'Example' }],
    update: async (id, props) => { console.log('  tabs.update', id, props); return { id }; },
    create: async (props) => { console.log('  tabs.create', props); return { id: 2 }; },
    goBack: async (id) => { console.log('  tabs.goBack', id); return; },
    reload: async (id, opts) => { console.log('  tabs.reload', id, opts); return; },
    get: async (id) => ({ id, status: 'complete' })
  },
  scripting: { executeScript: async () => {} },
  runtime: { sendMessage: (msg) => { /* noop */ }, getURL: (p) => p, onMessage: { addListener: () => {} } }
};
globalThis.chrome = chrome;

let modelResponses = [];
let modelCallCount = 0;

const MOCK_DENY_CATEGORIES = {
  version: '2026-06-13',
  categories: {
    banking: { description: 'Banking', patterns: ['chase.com'] },
    payment: { description: 'Payment', patterns: ['dashboard.paypal.com'] },
    crypto: { description: 'Crypto', patterns: ['coinbase.com'] },
    government: { description: 'Government', patterns: ['irs.gov'] },
    medical: { description: 'Medical', patterns: ['mychart.com'] },
    identity: { description: 'Identity', patterns: ['accounts.google.com'] },
    cloud_console: { description: 'Cloud', patterns: ['console.aws.amazon.com'] }
  }
};

const MOCK_PSL_TEXT = `// Mock PSL
com
net
org
io
co.uk
`;

globalThis.fetch = async (url, opts) => {
  const urlStr = String(url);
  if (urlStr.includes('/chat/completions')) {
    modelCallCount++;
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    console.log('  model call #' + modelCallCount + ', messages=' + (body.messages || []).length);
    const response = modelResponses[modelCallCount - 1];
    if (!response) throw new Error('no mock response for model call ' + modelCallCount);
    return { ok: true, json: async () => response };
  }
  if (urlStr.includes('deny-categories')) {
    return { ok: true, json: async () => MOCK_DENY_CATEGORIES };
  }
  if (urlStr.includes('psl')) {
    return { ok: true, text: async () => MOCK_PSL_TEXT };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

(async () => {
  const { Agent } = await import('./lib/agent.js');
  const { newCounters } = await import('./lib/usage.js');
  const { setBuiltinCategories } = await import('./lib/allowlist.js');
  const { setPSLData } = await import('./lib/psl.js');

  // Pre-seed caches so fetch is only called for the model API.
  setBuiltinCategories(MOCK_DENY_CATEGORIES);
  setPSLData(MOCK_PSL_TEXT);

  const task = {
    id: 't1',
    goal: 'Test task: navigate to example.com and finish',
    profileId: 'pf1',
    profile: { id: 'pf1', name: 'Test', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5', temperature: 0.2, maxSteps: 5, isDefault: true },
    settings: {
      confirmationMode: 'destructive-only',
      loop: { enabled: true, sameActionLimit: 3, sequenceLength: 4, sequenceRepetitionLimit: 2 },
      redact: { passwords: false, paymentFields: false, otp: false, usernames: false, cookies: false, apiTokens: false, apiKeyShapes: false, ccHeuristic: false },
      injectionFilterSensitivity: 'medium',
      allow: [], deny: [], userOverrides: {}
    },
    tabId: 1,
    state: {
      status: 'running',
      messages: [{ kind: 'goal', role: 'user', content: 'Test task' }],
      stepsTaken: 0,
      lastSnapshot: { url: 'https://example.com', title: 'Example', origin: 'https://example.com', capturedAt: Date.now(), elementCount: 0, elements: [], elementsById: {}, hash: 'abc' },
      pageContext: { url: 'https://example.com', title: 'Example', origin: 'https://example.com' },
      pendingToolCall: null, pendingAskUser: null, finalAnswer: null, error: null
    },
    counters: newCounters(),
    approvedPairs: [],
    recentActions: [],
    injectionHitsTotal: 0,
    maxSteps: 5,
    maxWallTime: 60000,
    startedAt: Date.now()
  };

  // Model returns: navigate, then finish.
  modelResponses = [
    { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'navigate', arguments: '{"url":"https://example.org"}' } }] } }], usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } },
    { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: '2', type: 'function', function: { name: 'finish', arguments: '{"answer":"Task complete!"}' } }] } }], usage: { prompt_tokens: 250, completion_tokens: 8, total_tokens: 258 } }
  ];

  const agent = new Agent(task);

  console.log('Step 1: model decides to navigate');
  let r = await agent.runStep();
  console.log('  runStep result:', r.status);
  if (r.status === 'executing_tool') {
    let er = await agent.executeTool();
    console.log('  executeTool result:', er.status);
  }

  console.log('Step 2: model decides to finish');
  r = await agent.runStep();
  console.log('  runStep result:', r.status);
  if (r.status === 'executing_tool') {
    let er = await agent.executeTool();
    console.log('  executeTool result:', er.status);
  }

  console.log('Final state:', task.state.status);
  console.log('Final answer:', task.state.finalAnswer);
  console.log('Counters:', JSON.stringify({ steps: task.counters.toolExecutions, calls: task.counters.modelCalls, tokens: task.counters.totalTokens, wallMs: task.counters.elapsedTime }, null, 2));

  if (task.state.status === 'done' && task.state.finalAnswer === 'Task complete!') {
    console.log('AGENT LOOP TEST PASSED');
  } else {
    console.log('AGENT LOOP TEST FAILED');
  }
})().catch(e => { console.error('TEST ERROR:', e); console.error(e.stack); process.exit(1); });
