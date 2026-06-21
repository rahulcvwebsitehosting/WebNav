// options/options.js
// Self-contained — no module imports. Communicates with the service worker via chrome.runtime.sendMessage.

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function fmtMs(ms) { const s = Math.round((ms || 0) / 1000); if (s < 60) return s + 's'; return Math.floor(s / 60) + 'm' + (s % 60) + 's'; }
  function fmtTok(n) { if (!n) return '0'; if (n > 1000) return (n / 1000).toFixed(1) + 'k'; return String(n); }

  // Global error reporting
  function showError(msg) {
    const el = $('global-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    console.error('[WebNav options]', msg);
  }
  window.addEventListener('error', (e) => showError('JS error: ' + (e.error && e.error.message || e.message || 'unknown')));
  window.addEventListener('unhandledrejection', (e) => showError('Promise error: ' + (e.reason && e.reason.message || e.reason || 'unknown')));

  // Storage helpers — direct, no module deps
  const KEYS = {
    SETTINGS: 'settings',
    PROFILES: 'profiles',
    PROFILE_KEY: (id) => 'profileKeys:' + id,
    HISTORY: 'history'
  };
  const DEFAULT_SETTINGS = {
    confirmationMode: 'destructive-only',
    loop: { enabled: true, sameActionLimit: 3, sequenceLength: 4, sequenceRepetitionLimit: 2 },
    redact: { passwords: false, paymentFields: false, otp: false, usernames: false, cookies: false, apiTokens: false, apiKeyShapes: false, ccHeuristic: false },
    injectionFilterSensitivity: 'medium',
    snapshot: { maxElements: 1000, maxTextLength: 160, maxIframes: 5, maxShadowDepth: 2, maxTextareaContent: 200, totalSnapshotBytes: 20480, highlightElements: true, alwaysSnapshotAfterNav: true, cacheSize: 20 },
    allowlistMode: null,
    allow: [],
    deny: [],
    userOverrides: {}
  };
  function mergeDeep(target, source) {
    if (source === null || source === undefined) return target;
    if (typeof source !== 'object' || Array.isArray(source)) return source;
    for (const k of Object.keys(source)) {
      if (k in target && typeof target[k] === 'object' && !Array.isArray(target[k]) && typeof source[k] === 'object' && !Array.isArray(source[k])) {
        target[k] = mergeDeep(target[k], source[k]);
      } else {
        target[k] = source[k];
      }
    }
    return target;
  }
  async function getSettings() {
    const obj = await chrome.storage.local.get(KEYS.SETTINGS);
    const s = obj[KEYS.SETTINGS];
    if (!s) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    return mergeDeep(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), s);
  }
  async function setSettings(s) { await chrome.storage.local.set({ [KEYS.SETTINGS]: s }); }
  async function updateSettings(patch) { const cur = await getSettings(); const next = mergeDeep(cur, patch); await setSettings(next); return next; }
  async function getProfiles() { const obj = await chrome.storage.local.get(KEYS.PROFILES); return obj[KEYS.PROFILES] || []; }
  async function setProfiles(list) { await chrome.storage.local.set({ [KEYS.PROFILES]: list }); }
  async function getHistory() { const obj = await chrome.storage.local.get(KEYS.HISTORY); return obj[KEYS.HISTORY] || []; }
  async function setHistory(list) { await chrome.storage.local.set({ [KEYS.HISTORY]: list }); }

  // Built-in deny categories — inlined (matches data/deny-categories.json)
  // NOTE: linkedin.com is in the "identity" category. With allow-all mode, this
  // is bypassed. With allow-all-non-blocked, the user must add an override
  // (or click "Allow ALL" in the dropdown above).
  const BUILTIN_CATEGORIES = {
    banking: { description: 'Banking and financial institution login portals', patterns: ['chase.com','bankofamerica.com','wellsfargo.com','citi.com','usbank.com','capitalone.com','pnc.com','tdbank.com','ally.com','schwab.com','fidelity.com','vanguard.com','hsbc.com','barclays.co.uk','lloydsbank.com','natwest.com','santander.com','ing.com','deutschebank.de','bnpparibas.com','rbc.com','scotiabank.com','bmo.com','cibc.com'] },
    payment: { description: 'Payment processor dashboards and checkout backends', patterns: ['dashboard.paypal.com','dashboard.stripe.com','braintreepayments.com','adyen.com','squareup.com','checkout.com','klarna.com','afterpay.com','affirm.com','wise.com','venmo.com','cashapp.com'] },
    crypto: { description: 'Cryptocurrency exchanges, custody, and wallets', patterns: ['coinbase.com','binance.com','kraken.com','gemini.com','crypto.com','bitstamp.net','bitfinex.com','okx.com','kucoin.com','bybit.com','metamask.io','ledger.com','trezor.io','blockchain.com'] },
    government: { description: 'Government portals and tax systems', patterns: ['irs.gov','hmrc.gov.uk','gov.uk','usa.gov','europa.eu','gouv.fr','bund.de','cra-arc.gc.ca','ato.gov.au','ird.govt.nz','agenziaentrate.gov.it','aeat.es'] },
    medical: { description: 'Health portals and insurance', patterns: ['mychart.com','epic.com','cerner.com','aetna.com','anthem.com','unitedhealthcare.com','cigna.com','humana.com','kaiserpermanente.org','nhs.uk'] },
    identity: { description: 'Single sign-on and identity providers', patterns: ['accounts.google.com','login.microsoftonline.com','okta.com','auth0.com','onelogin.com','appleid.apple.com','facebook.com','linkedin.com','github.com','gitlab.com'] },
    cloud_console: { description: 'Cloud provider consoles and infrastructure', patterns: ['console.aws.amazon.com','portal.azure.com','console.cloud.google.com','console.digitalocean.com','cloudflare.com','heroku.com','vercel.com','netlify.com'] }
  };

  // --- Tab switching ---
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.tab')) x.classList.toggle('active', x === t);
      for (const id of ['profiles', 'allowlist', 'safety', 'snapshots', 'history']) {
        const pane = $('tab-' + id);
        if (pane) pane.classList.toggle('active', id === t.dataset.tab);
      }
    });
  }

  // --- Init ---
  async function init() {
    try {
      const settings = await getSettings();
      if (!settings.allowlistMode) {
        $('first-run-banner').classList.remove('hidden');
      }
      $('first-run-save').addEventListener('click', async () => {
        const mode = $('first-run-mode').value;
        if (mode === 'allow-all') {
          const confirmed = confirm('Switch to UNRESTRICTED mode?\n\nThe agent will be able to navigate to ANY website, including banking, payment, identity, and government sites. Built-in safety categories will be disabled.\n\nContinue only if you fully trust the agent and the model.');
          if (!confirmed) return;
        }
        await updateSettings({ allowlistMode: mode });
        $('first-run-banner').classList.add('hidden');
        await renderAllowlist();
      });
      await renderProfiles();
      await renderAllowlist();
      await renderSafety();
      await renderSnapshots();
      await renderHistory();
    } catch (e) {
      showError('Init failed: ' + e.message);
      throw e;
    }
  }

  // --- Profiles ---
  async function renderProfiles() {
    const profiles = await getProfiles();
    const ul = $('profile-list');
    if (!profiles.length) {
      ul.innerHTML = '<li class="empty">No profiles yet. Click "+ Add profile" to create one.</li>';
    } else {
      ul.innerHTML = profiles.map(p => `
        <li>
          <div>
            <strong>${escapeHtml(p.name)}</strong> ${p.isDefault ? '<span class="muted">(default)</span>' : ''}
            <div class="muted">${escapeHtml(p.baseUrl || '')} &middot; ${escapeHtml(p.model || '')}</div>
          </div>
          <div>
            <button data-act="edit" data-id="${escapeHtml(p.id)}">Edit</button>
            <button data-act="del" data-id="${escapeHtml(p.id)}" class="ghost">Delete</button>
          </div>
        </li>
      `).join('');
    }
    for (const btn of ul.querySelectorAll('[data-act="edit"]')) btn.addEventListener('click', () => editProfile(btn.dataset.id));
    for (const btn of ul.querySelectorAll('[data-act="del"]')) btn.addEventListener('click', async () => {
      if (!confirm('Delete this profile?')) return;
      const list = (await getProfiles()).filter(p => p.id !== btn.dataset.id);
      await setProfiles(list);
      await chrome.storage.local.remove(KEYS.PROFILE_KEY(btn.dataset.id));
      renderProfiles();
    });
    $('add-profile').onclick = () => editProfile(null);
  }

  function getFormModel() {
    const sel = $('pf-model-select');
    const custom = ($('pf-model-custom').value || '').trim();
    if (custom) return custom;
    const selVal = sel && sel.value;
    return selVal || '';
  }

  function fetchModelsFromForm() {
    return new Promise((resolve, reject) => {
      const baseUrl = ($('pf-base').value || '').trim().replace(/\/+$/, '');
      const key = ($('pf-key').value || '').trim();
      if (!baseUrl) return reject(new Error('Enter a Base URL first.'));

      chrome.runtime.sendMessage({ type: 'FETCH_MODELS', baseUrl, key }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.ok) {
          // The service worker now returns a cause-specific message in res.error.
          const msg = (res && res.error) ? res.error : 'Connection failed for an unknown reason.';
          return reject(new Error(msg));
        }
        resolve(res.models);
      });
    });
  }

  function populateModelDropdown(models, currentModel) {
    const sel = $('pf-model-select');
    sel.innerHTML = '<option value="">— select a model —</option>' +
      models.map(m => `<option value="${escapeHtml(m)}" ${m === currentModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
    if (models.includes(currentModel)) $('pf-model-custom').value = '';
    $('pf-model-status').textContent = `✓ ${models.length} model${models.length === 1 ? '' : 's'} found (catalog is public — click "Test connection" to verify your API key).`;
    $('pf-model-status').style.color = 'var(--muted)';
  }

  function editProfile(id) {
    const form = $('profile-form');
    form.classList.remove('hidden');
    $('pf-model-status').textContent = '';
    $('pf-model-select').innerHTML = '<option value="">— fetch models first —</option>';

    (async () => {
      const profiles = await getProfiles();
      const p = id ? profiles.find(x => x.id === id) : null;
      // Provider preset defaults to "custom" for existing profiles so we don't
      // clobber a saved Base URL. For new profiles we default to local Ollama.
      $('pf-provider').value = p ? 'custom' : 'local';
      $('pf-name').value = p ? p.name : '';
      $('pf-base').value = p ? p.baseUrl : 'http://localhost:11434/v1';
      $('pf-key').value = '';
      $('pf-model-custom').value = p ? p.model : '';
      $('pf-temp').value = p && p.temperature != null ? p.temperature : 0.2;
      $('pf-maxtokens').value = p && p.maxTokens != null ? p.maxTokens : 0;
      $('pf-max').value = p && p.maxSteps ? p.maxSteps : 25;
      $('pf-pcost').value = p && p.costPer1kPromptTokens ? p.costPer1kPromptTokens : 0;
      $('pf-ccost').value = p && p.costPer1kCompletionTokens ? p.costPer1kCompletionTokens : 0;
      $('pf-default').checked = p ? !!p.isDefault : (profiles.length === 0);
      form.dataset.id = id || '';

      if (id) {
        const savedKeyObj = await chrome.storage.local.get(KEYS.PROFILE_KEY(id));
        const savedKey = savedKeyObj[KEYS.PROFILE_KEY(id)] || '';
        if (savedKey) {
          try {
            $('pf-key').value = savedKey;
            const models = await fetchModelsFromForm();
            populateModelDropdown(models, p ? p.model : '');
            $('pf-key').value = '';
          } catch {}
        }
      }
    })();

    // Provider preset: fill Base URL + hint when the user picks one.
    $('pf-provider').onchange = () => {
      const presets = {
        local: { base: 'http://localhost:11434/v1', keyHint: 'Required for cloud APIs (sk-…, ollama_…). Local Ollama needs no key.' },
        cloud: { base: 'https://ollama.com/v1', keyHint: 'Paste your Ollama Cloud API key (from ollama.com).' },
        openrouter: { base: 'https://openrouter.ai/api/v1', keyHint: 'Paste your OpenRouter API key (from openrouter.ai/keys).' },
        'opencode-zen': { base: 'https://opencode.ai/zen/v1', keyHint: 'Paste your OpenCode Zen API key (from opencode.ai/auth).' },
        gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyHint: 'Paste your Google AI Studio API key (from aistudio.google.com).' },
        custom: null
      };
      const choice = $('pf-provider').value;
      const preset = presets[choice];
      if (preset) {
        $('pf-base').value = preset.base;
        $('pf-key').placeholder = preset.keyHint;
      }
    };
    // Fire once so the placeholder hint matches the default preset.
    $('pf-provider').onchange();

    $('pf-fetch-models').onclick = async () => {
      const btn = $('pf-fetch-models');
      btn.disabled = true;
      btn.textContent = 'Fetching…';
      $('pf-model-status').textContent = 'Connecting…';
      $('pf-model-status').style.color = 'var(--muted)';
      try {
        const models = await fetchModelsFromForm();
        const current = getFormModel();
        populateModelDropdown(models, current);
      } catch (e) {
        $('pf-model-status').textContent = '✗ ' + e.message;
        $('pf-model-status').style.color = 'var(--danger)';
      } finally {
        btn.disabled = false;
        btn.textContent = '⟳ Fetch models';
      }
    };

    $('pf-test').onclick = testConnectionFromForm;
    $('pf-cancel').onclick = () => form.classList.add('hidden');

    $('pf-save').onclick = async () => {
      try {
        const model = getFormModel();
        if (!model) { alert('Please select or type a model name.'); return; }
        const profiles = await getProfiles();
        const newId = id || ('pf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
        const data = {
          id: newId,
          name: ($('pf-name').value || '').trim() || 'Untitled',
          baseUrl: ($('pf-base').value || '').trim() || 'http://localhost:11434/v1',
          model,
          temperature: Number($('pf-temp').value) || 0.2,
          maxTokens: Number($('pf-maxtokens').value) || 0,
          maxSteps: Number($('pf-max').value) || 25,
          costPer1kPromptTokens: Number($('pf-pcost').value) || 0,
          costPer1kCompletionTokens: Number($('pf-ccost').value) || 0,
          isDefault: $('pf-default').checked
        };
        const keyInput = ($('pf-key').value || '').trim();
        if (keyInput) await chrome.storage.local.set({ [KEYS.PROFILE_KEY(newId)]: keyInput });
        let next;
        if (id) next = profiles.map(x => x.id === id ? Object.assign({}, x, data) : x);
        else next = profiles.concat([data]);
        if (data.isDefault) next = next.map(x => Object.assign({}, x, { isDefault: x.id === data.id }));
        await setProfiles(next);
        form.classList.add('hidden');
        await renderProfiles();
      } catch (e) {
        showError('Save failed: ' + e.message);
      }
    };
  }

  async function testConnectionFromForm() {
    const btn = $('pf-test');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Testing…';
    $('pf-model-status').textContent = 'Verifying key with a real chat request…';
    $('pf-model-status').style.color = 'var(--muted)';
    try {
      const baseUrl = ($('pf-base').value || '').trim().replace(/\/+$/, '');
      const key = ($('pf-key').value || '').trim();
      const model = getFormModel();
      if (!baseUrl) throw new Error('Enter a Base URL first.');
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', baseUrl, key, model }, (r) => {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(r || { ok: false, error: 'no response' });
        });
      });
      if (!res.ok) throw new Error(res.error || 'Connection failed for an unknown reason.');
      $('pf-model-status').textContent = '✓ Connected! Your Base URL and API key are valid.';
      $('pf-model-status').style.color = 'var(--ok)';
    } catch (e) {
      $('pf-model-status').textContent = '✗ ' + e.message;
      $('pf-model-status').style.color = 'var(--danger)';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test connection';
    }
  }

  // --- Allowlist ---
  async function renderAllowlist() {
    const settings = await getSettings();
    $('allowlist-mode').value = settings.allowlistMode || 'allow-all-non-blocked';
    const updateUnrestrictedWarning = () => {
      const warn = $('unrestricted-warning');
      if (!warn) return;
      if ($('allowlist-mode').value === 'allow-all') warn.classList.remove('hidden');
      else warn.classList.add('hidden');
    };
    updateUnrestrictedWarning();
    $('allowlist-mode').onchange = async (e) => {
      const newMode = e.target.value;
      if (newMode === 'allow-all') {
        const confirmed = confirm('Switch to UNRESTRICTED mode?\n\nThe agent will be able to navigate to ANY website, including banking, payment, identity, and government sites. Built-in safety categories will be disabled.\n\nContinue only if you fully trust the agent and the model.');
        if (!confirmed) {
          // Revert dropdown
          e.target.value = settings.allowlistMode || 'allow-all-non-blocked';
          return;
        }
      }
      await updateSettings({ allowlistMode: newMode });
      updateUnrestrictedWarning();
    };

    $('allow-add').onclick = async () => {
      const v = ($('allow-input').value || '').trim();
      if (!v) return;
      const list = (settings.allow || []).slice();
      if (!list.includes(v)) list.push(v);
      await updateSettings({ allow: list });
      $('allow-input').value = '';
      renderAllowlist();
    };
    $('deny-add').onclick = async () => {
      const v = ($('deny-input').value || '').trim();
      if (!v) return;
      const list = (settings.deny || []).slice();
      if (!list.includes(v)) list.push(v);
      await updateSettings({ deny: list });
      $('deny-input').value = '';
      renderAllowlist();
    };

    $('allow-list').innerHTML = (settings.allow || []).map(p => `<li><code>${escapeHtml(p)}</code><button data-rm="allow" data-p="${escapeHtml(p)}" class="ghost">Remove</button></li>`).join('') || '<li class="empty">No allow patterns.</li>';
    $('deny-list').innerHTML = (settings.deny || []).map(p => `<li><code>${escapeHtml(p)}</code><button data-rm="deny" data-p="${escapeHtml(p)}" class="ghost">Remove</button></li>`).join('') || '<li class="empty">No deny patterns.</li>';
    for (const b of document.querySelectorAll('[data-rm]')) {
      b.onclick = async () => {
        const list = (settings[b.dataset.rm] || []).filter(x => x !== b.dataset.p);
        await updateSettings({ [b.dataset.rm]: list });
        renderAllowlist();
      };
    }

    const overrides = settings.userOverrides || {};
    const cont = $('categories');
    cont.innerHTML = Object.keys(BUILTIN_CATEGORIES).map(key => {
      const cat = BUILTIN_CATEGORIES[key];
      const list = overrides[key] || [];
      const listHtml = list.length ? '<div class="overrides">Overrides: ' + list.map(p => `<code>${escapeHtml(p)}</code>`).join(' ') + '</div>' : '';
      return `
        <div class="category">
          <h4>${escapeHtml(cat.description)} <span class="muted">(${escapeHtml(key)})</span></h4>
          <div class="desc">${(cat.patterns || []).length} patterns hardcoded</div>
          <div class="row">
            <input data-cat="${escapeHtml(key)}" type="text" placeholder="example.com" />
            <button data-add="${escapeHtml(key)}" class="primary">Add override</button>
          </div>
          ${listHtml}
        </div>
      `;
    }).join('');
    for (const btn of document.querySelectorAll('[data-add]')) {
      btn.onclick = async () => {
        const key = btn.dataset.add;
        const inp = document.querySelector('[data-cat="' + key + '"]');
        const v = (inp.value || '').trim();
        if (!v) return;
        const confirmWord = prompt('Type the category name "' + key + '" to confirm overriding the deny list for ' + v + ':');
        if (confirmWord !== key) { alert('Confirmation did not match.'); return; }
        const next = JSON.parse(JSON.stringify(overrides));
        next[key] = (next[key] || []).concat([v]);
        await updateSettings({ userOverrides: next });
        renderAllowlist();
      };
    }
  }

  // --- Safety ---
  const REDACT_RULES = [
    { key: 'passwords', label: 'Redact password fields' },
    { key: 'paymentFields', label: 'Redact credit-card fields (cc-number, cvv, exp, ...)' },
    { key: 'otp', label: 'Redact OTP / one-time-code fields' },
    { key: 'usernames', label: 'Redact usernames (when paired with a password)' },
    { key: 'cookies', label: 'Redact Cookie / Set-Cookie headers in text' },
    { key: 'apiTokens', label: 'Redact "Authorization: Bearer ..." tokens' },
    { key: 'apiKeyShapes', label: 'Redact common API-key shapes (sk-..., ghp_..., AIza..., xox...-...)' },
    { key: 'ccHeuristic', label: 'Redact 16-digit numbers near payment keywords' }
  ];

  async function renderSafety() {
    const settings = await getSettings();
    $('conf-mode').value = settings.confirmationMode || 'destructive-only';
    $('conf-mode').onchange = async (e) => { await updateSettings({ confirmationMode: e.target.value }); };

    const loop = settings.loop || {};
    $('loop-enabled').checked = loop.enabled !== false;
    $('loop-same').value = loop.sameActionLimit || 3;
    $('loop-len').value = loop.sequenceLength || 4;
    $('loop-rep').value = loop.sequenceRepetitionLimit || 2;
    for (const id of ['loop-enabled', 'loop-same', 'loop-len', 'loop-rep']) {
      $(id).onchange = async () => {
        await updateSettings({ loop: {
          enabled: $('loop-enabled').checked,
          sameActionLimit: Number($('loop-same').value) || 3,
          sequenceLength: Number($('loop-len').value) || 4,
          sequenceRepetitionLimit: Number($('loop-rep').value) || 2
        }});
      };
    }

    const redact = settings.redact || DEFAULT_SETTINGS.redact;
    const cont = $('redact-rules');
    cont.innerHTML = REDACT_RULES.map(r => `
      <div class="rule">
        <label class="check">
          <input type="checkbox" data-redact="${r.key}" ${redact[r.key] ? 'checked' : ''} />
          ${escapeHtml(r.label)}
        </label>
      </div>
    `).join('');
    for (const c of cont.querySelectorAll('[data-redact]')) {
      c.onchange = async () => {
        const next = Object.assign({}, redact, { [c.dataset.redact]: c.checked });
        await updateSettings({ redact: next });
      };
    }

    $('inj-sens').value = settings.injectionFilterSensitivity || 'medium';
    $('inj-sens').onchange = async (e) => { await updateSettings({ injectionFilterSensitivity: e.target.value }); };
  }

  // --- Snapshots ---
  async function renderSnapshots() {
    const settings = await getSettings();
    const cap = settings.snapshot || DEFAULT_SETTINGS.snapshot;
    $('cap-elements').value = cap.maxElements || 1000;
    $('cap-text').value = cap.maxTextLength || 160;
    $('cap-iframes').value = cap.maxIframes || 5;
    $('cap-shadow').value = cap.maxShadowDepth || 2;
    $('cap-textarea').value = cap.maxTextareaContent || 200;
    $('cap-bytes').value = cap.totalSnapshotBytes || 20480;
    $('cap-cache').value = cap.cacheSize || 20;
    $('cap-highlight').checked = cap.highlightElements !== false;
    $('cap-snapnav').checked = cap.alwaysSnapshotAfterNav !== false;
    for (const id of ['cap-elements', 'cap-text', 'cap-iframes', 'cap-shadow', 'cap-textarea', 'cap-bytes', 'cap-cache', 'cap-highlight', 'cap-snapnav']) {
      $(id).onchange = async () => {
        await updateSettings({ snapshot: {
          maxElements: Number($('cap-elements').value) || 1000,
          maxTextLength: Number($('cap-text').value) || 160,
          maxIframes: Number($('cap-iframes').value) || 5,
          maxShadowDepth: Number($('cap-shadow').value) || 2,
          maxTextareaContent: Number($('cap-textarea').value) || 200,
          totalSnapshotBytes: Number($('cap-bytes').value) || 20480,
          cacheSize: Number($('cap-cache').value) || 20,
          highlightElements: $('cap-highlight').checked,
          alwaysSnapshotAfterNav: $('cap-snapnav').checked
        }});
      };
    }
  }

  // --- History ---
  async function renderHistory() {
    const list = await getHistory();
    $('history-size').textContent = list.length + ' task' + (list.length === 1 ? '' : 's');
    const body = $('history-body');
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">No completed tasks yet.</td></tr>';
    } else {
      body.innerHTML = list.map(r => `
        <tr>
          <td>${new Date(r.startedAt).toLocaleString()}</td>
          <td class="goal" title="${escapeHtml(r.goal)}">${escapeHtml(r.goal)}</td>
          <td>${escapeHtml(r.status)}</td>
          <td>${r.stepsTaken || 0}</td>
          <td>${r.modelCalls || 0}</td>
          <td>${fmtTok(r.totalTokens)}</td>
          <td>${fmtMs(r.elapsedTime)}</td>
          <td><button data-del="${escapeHtml(r.taskId)}" class="ghost">Delete</button></td>
        </tr>
      `).join('');
    }
    for (const b of body.querySelectorAll('[data-del]')) {
      b.onclick = async () => {
        const next = list.filter(x => x.taskId !== b.dataset.del);
        await setHistory(next);
        renderHistory();
      };
    }
    $('history-export').onclick = async () => {
      const data = JSON.stringify(list, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'webnav-history.json';
      a.click();
      URL.revokeObjectURL(url);
    };
    $('history-clear').onclick = async () => {
      if (!confirm('Delete ALL history? This cannot be undone.')) return;
      await chrome.storage.local.remove(KEYS.HISTORY);
      renderHistory();
    };
  }

  init();
})();
