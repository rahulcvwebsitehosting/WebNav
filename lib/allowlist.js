// lib/allowlist.js
// Domain allowlist / denylist matching.

import { getRegistrableDomain, originOf, loadPSL } from './psl.js';

const BUILTIN_CATEGORIES_URL = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
  ? chrome.runtime.getURL('data/deny-categories.json')
  : 'data/deny-categories.json';

let CATEGORIES_CACHE = null;

export async function loadBuiltinCategories() {
  if (CATEGORIES_CACHE) return CATEGORIES_CACHE;
  try {
    const res = await fetch(BUILTIN_CATEGORIES_URL);
    CATEGORIES_CACHE = await res.json();
  } catch {
    CATEGORIES_CACHE = { version: '0.0.0-fallback', categories: {} };
  }
  return CATEGORIES_CACHE;
}

export function setBuiltinCategories(obj) {
  CATEGORIES_CACHE = obj;
}

// Pattern matching.
//   'example.com'           -> registrable domain 'example.com'
//   '*.example.com'         -> any subdomain of 'example.com'
//   'https://example.com/x' -> URL prefix
function matchesPattern(host, registrable, pattern) {
  if (!pattern) return false;
  const p = pattern.trim();
  if (!p) return false;
  if (p.startsWith('http://') || p.startsWith('https://')) {
    return false; // caller should check URL prefixes separately
  }
  if (p.startsWith('*.')) {
    const base = p.slice(2).toLowerCase();
    if (host === base) return true;
    return host.endsWith('.' + base);
  }
  const target = p.toLowerCase();
  return registrable === target || host === target;
}

function matchesUrlPrefix(url, pattern) {
  if (!pattern.startsWith('http://') && !pattern.startsWith('https://')) return false;
  return url.toLowerCase().startsWith(pattern.toLowerCase());
}

const BAD_SCHEMES = ['javascript:', 'data:', 'blob:', 'vbscript:', 'file:', 'chrome:', 'chrome-extension:', 'view-source:', 'about:', 'devtools:'];

export function classifyUrlScheme(url) {
  if (typeof url !== 'string') return { ok: false, reason: 'not a string' };
  const lower = url.trim().toLowerCase();
  for (const s of BAD_SCHEMES) {
    if (lower.startsWith(s)) return { ok: false, reason: `blocked_scheme: ${s}` };
  }
  // Reject credentials in URL
  try {
    const u = new URL(url);
    if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' };
    if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: `non_http_scheme: ${u.protocol}` };
    return { ok: true, url: u.toString(), origin: originOf(u.toString()), hostname: u.hostname.toLowerCase() };
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
}

/**
 * Check a URL against the allowlist configuration.
 * config = { allow: [pattern,...], deny: [pattern,...], userOverrides: { categoryKey: [pattern,...] }, mode: 'allow-all-non-blocked' | 'explicit-allow' | 'confirm-per-domain' | 'allow-all' }
 * builtinDeny = { categories: { banking: { patterns: [...] }, ... } }
 * Returns { allow: bool, reason: string, matchedCategory?: string }
 */
export async function check(url, config, builtinDeny) {
  const scheme = classifyUrlScheme(url);
  if (!scheme.ok) return { allow: false, reason: scheme.reason };
  const { origin, hostname } = scheme;
  const reg = await getRegistrableDomain(hostname, await loadPSL());
  if (!reg) return { allow: false, reason: 'invalid_hostname' };

  // Mode: allow-all — completely unrestricted. Only the URL-scheme sanity check
  // above and the user's own deny list still apply. No built-in category blocks.
  if (config.mode === 'allow-all') {
    for (const p of (config.deny || [])) {
      if (matchesPattern(hostname, reg, p) || matchesUrlPrefix(url, p)) {
        return { allow: false, reason: `user_deny: ${p}`, origin, hostname, registrable: reg };
      }
    }
    return { allow: true, reason: 'unrestricted_mode', origin, hostname, registrable: reg };
  }

  // 1) Built-in categories first. The user can override a specific pattern via userOverrides.
  const bd = builtinDeny || (await loadBuiltinCategories());
  for (const [catKey, cat] of Object.entries(bd.categories || {})) {
    const patterns = cat.patterns || [];
    if (patterns.some(p => matchesPattern(hostname, reg, p))) {
      const overrides = (config.userOverrides && config.userOverrides[catKey]) || [];
      const isOverridden = overrides.some(p => matchesPattern(hostname, reg, p));
      if (!isOverridden) {
        return { allow: false, reason: `builtin_deny: ${catKey}`, matchedCategory: catKey, origin, hostname, registrable: reg };
      }
    }
  }

  // 2) User deny list
  for (const p of (config.deny || [])) {
    if (matchesPattern(hostname, reg, p) || matchesUrlPrefix(url, p)) {
      return { allow: false, reason: `user_deny: ${p}`, origin, hostname, registrable: reg };
    }
  }

  // 3) If allow list is non-empty, require a match.
  const allowList = config.allow || [];
  if (allowList.length > 0) {
    const ok = allowList.some(p => matchesPattern(hostname, reg, p) || matchesUrlPrefix(url, p));
    if (!ok) return { allow: false, reason: 'not_in_allow_list', origin, hostname, registrable: reg };
  }

  return { allow: true, reason: 'ok', origin, hostname, registrable: reg };
}

export function isCrossOrigin(originA, originB) {
  if (!originA || !originB) return true;
  return originA !== originB;
}
