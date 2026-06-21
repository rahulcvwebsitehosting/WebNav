// Test the unrestricted allow-all mode.
process.chdir('C:/Users/saini/Downloads/BrowserExt');

const MOCK_PSL_TEXT = `// Mock PSL
com
net
org
io
co.uk
`;

const MOCK_DENY_CATEGORIES = {
  version: '2026-06-13',
  categories: {
    banking: { description: 'Banking', patterns: ['chase.com'] },
    identity: { description: 'Identity', patterns: ['linkedin.com', 'github.com'] }
  }
};

globalThis.fetch = async (url) => {
  const urlStr = String(url);
  if (urlStr.includes('deny-categories')) return { ok: true, json: async () => MOCK_DENY_CATEGORIES };
  if (urlStr.includes('psl')) return { ok: true, text: async () => MOCK_PSL_TEXT };
  return { ok: false, status: 404 };
};

(async () => {
  const { check } = await import('./lib/allowlist.js');
  const { setBuiltinCategories } = await import('./lib/allowlist.js');
  const { setPSLData } = await import('./lib/psl.js');

  setBuiltinCategories(MOCK_DENY_CATEGORIES);
  setPSLData(MOCK_PSL_TEXT);

  const tests = [
    {
      name: 'linkedin.com blocked in default mode',
      url: 'https://www.linkedin.com/in/me',
      config: { mode: 'allow-all-non-blocked', allow: [], deny: [], userOverrides: {} },
      expectAllow: false
    },
    {
      name: 'linkedin.com allowed in allow-all mode',
      url: 'https://www.linkedin.com/in/me',
      config: { mode: 'allow-all', allow: [], deny: [], userOverrides: {} },
      expectAllow: true
    },
    {
      name: 'example.com allowed in allow-all mode',
      url: 'https://example.com/foo',
      config: { mode: 'allow-all', allow: [], deny: [], userOverrides: {} },
      expectAllow: true
    },
    {
      name: 'example.com blocked in allow-all mode by user deny',
      url: 'https://example.com/foo',
      config: { mode: 'allow-all', allow: [], deny: ['example.com'], userOverrides: {} },
      expectAllow: false
    },
    {
      name: 'github.com allowed in allow-all mode',
      url: 'https://github.com/foo',
      config: { mode: 'allow-all', allow: [], deny: [], userOverrides: {} },
      expectAllow: true
    },
    {
      name: 'github.com blocked in default mode',
      url: 'https://github.com/foo',
      config: { mode: 'allow-all-non-blocked', allow: [], deny: [], userOverrides: {} },
      expectAllow: false
    }
  ];

  let pass = 0, fail = 0;
  for (const t of tests) {
    const r = await check(t.url, t.config);
    if (r.allow === t.expectAllow) {
      console.log('  PASS  ' + t.name + '  (reason: ' + r.reason + ')');
      pass++;
    } else {
      console.log('  FAIL  ' + t.name + '  (expected allow=' + t.expectAllow + ', got allow=' + r.allow + ', reason=' + r.reason + ')');
      fail++;
    }
  }
  console.log('');
  console.log('Results: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e); console.error(e.stack); process.exit(1); });
