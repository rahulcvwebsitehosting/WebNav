// lib/storage.js
// Thin wrappers over chrome.storage.session / .local with JSON safety.

export const session = {
  async get(key) {
    if (!chrome?.storage?.session) return null;
    const obj = await chrome.storage.session.get(key);
    return obj ? obj[key] : null;
  },
  async set(key, value) {
    if (!chrome?.storage?.session) return;
    await chrome.storage.session.set({ [key]: value });
  },
  async remove(key) {
    if (!chrome?.storage?.session) return;
    await chrome.storage.session.remove(key);
  },
  async list(prefix) {
    if (!chrome?.storage?.session) return {};
    const all = await chrome.storage.session.get(null);
    if (!prefix) return all;
    const out = {};
    for (const k of Object.keys(all)) {
      if (k.startsWith(prefix)) out[k] = all[k];
    }
    return out;
  }
};

export const local = {
  async get(key, defaultValue) {
    if (!chrome?.storage?.local) return defaultValue;
    const obj = await chrome.storage.local.get(key);
    return key in obj ? obj[key] : defaultValue;
  },
  async set(key, value) {
    if (!chrome?.storage?.local) return;
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    if (!chrome?.storage?.local) return;
    await chrome.storage.local.remove(key);
  },
  async list(prefix) {
    if (!chrome?.storage?.local) return {};
    const all = await chrome.storage.local.get(null);
    if (!prefix) return all;
    const out = {};
    for (const k of Object.keys(all)) {
      if (k.startsWith(prefix)) out[k] = all[k];
    }
    return out;
  }
};

export const KEYS = {
  SETTINGS: 'settings',
  PROFILES: 'profiles',
  PROFILE_KEY: (id) => `profileKeys:${id}`,
  ALLOWLIST_MODE: 'allowlistMode',
  USER_OVERRIDES: 'userOverrides',
  ALLOW: 'allow',
  DENY: 'deny',
  HISTORY: 'history',
  USAGE_DAILY: (date) => `usage:${date}`,
  USAGE_SESSION: 'usage:session',
  CURRENT_TASK: 'currentTaskId',
  FIRST_RUN_DONE: 'firstRunDone',
  REDACTION_BANNER_DISMISSED: 'redactionBannerDismissed',
  AGENT: (id) => `agent:${id}`,
  SNAPSHOT: (tabId) => `snapshot:${tabId}`,
  APPROVED_PAIRS: (id) => `approvedPairs:${id}`,
  RECENT_ACTIONS: (id) => `recentActions:${id}`,
  INJECTION_HITS: (id) => `injectionHits:${id}`,
  TRANSCRIPT: (id) => `transcripts:${id}`
};

export const DEFAULT_SETTINGS = {
  confirmationMode: 'destructive-only',
  loop: { enabled: true, sameActionLimit: 3, sequenceLength: 4, sequenceRepetitionLimit: 2 },
  redact: { passwords: false, paymentFields: false, otp: false, usernames: false, cookies: false, apiTokens: false, apiKeyShapes: false, ccHeuristic: false },
  riskOverrides: {},
  injectionFilterSensitivity: 'medium',
  snapshot: {
    maxElements: 1000, maxTextLength: 160,
    maxIframes: 5, maxShadowDepth: 2, maxTextareaContent: 200,
    totalSnapshotBytes: 20480,
    highlightElements: true,
    alwaysSnapshotAfterNav: true,
    cacheSize: 20
  },
  allowlistMode: null,
  allow: [],
  deny: [],
  userOverrides: {},
  showCostEstimates: true,
  defaultCurrency: 'USD',
  sidebarTheme: 'auto',
  transcriptVerbosity: 'normal'
};

export async function getSettings() {
  const s = await local.get(KEYS.SETTINGS, null);
  if (!s) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  // Merge with defaults so newer settings have values.
  return mergeDeep(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), s);
}

export async function setSettings(s) {
  await local.set(KEYS.SETTINGS, s);
}

export async function updateSettings(patch) {
  const cur = await getSettings();
  const next = mergeDeep(cur, patch);
  await setSettings(next);
  return next;
}

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

export function defaultRedactSettings() {
  return {
    passwords: false,
    paymentFields: false,
    otp: false,
    usernames: false,
    cookies: false,
    apiTokens: false,
    apiKeyShapes: false,
    ccHeuristic: false
  };
}

export function dateKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
