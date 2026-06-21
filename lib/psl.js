// lib/psl.js
// Minimal Public Suffix List helpers (eTLD+1 extraction).
// A small bundled PSL ships at data/psl.txt; this loader parses it on first use.

let CACHE = null; // Map<string, true> where key is the suffix (e.g. "co.uk" or "com")
let LOADING = null;

function parse(text) {
  const map = new Map();
  for (let raw of text.split(/\r?\n/)) {
    raw = raw.trim();
    if (!raw || raw.startsWith('//')) continue;
    // Skip inline rules (e.g. "*.ck") - we only need the suffix list itself
    if (raw.startsWith('*.')) raw = raw.slice(2);
    map.set(raw.toLowerCase(), true);
  }
  return map;
}

export async function loadPSL() {
  if (CACHE) return CACHE;
  if (LOADING) return LOADING;
  LOADING = (async () => {
    try {
      const url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL('data/psl.txt')
        : 'data/psl.txt';
      const res = await fetch(url);
      if (!res.ok) throw new Error('failed to fetch PSL: ' + res.status);
      const text = await res.text();
      CACHE = parse(text);
      return CACHE;
    } catch (e) {
      // Fall back to a tiny built-in PSL so the extension still works offline.
      CACHE = parse(FALLBACK_PSL);
      return CACHE;
    } finally {
      LOADING = null;
    }
  })();
  return LOADING;
}

export function setPSLData(text) {
  CACHE = parse(text);
  LOADING = null;
}

const FALLBACK_PSL = `com
net
org
io
co
ai
app
dev
me
info
biz
us
uk
co.uk
gov.uk
ac.uk
de
fr
jp
cn
ru
br
in
au
ca
eu
nl
se
no
fi
dk
pl
it
es
ch
at
be
cz
ie
gr
hu
pt
ro
sk
tr
ua
mx
ar
cl
co.jp
com.au
com.br
com.cn
com.hk
com.sg
com.tw
com.mx
co.in
co.za
co.kr
co.id
co.il
io.uk
me.uk
net.uk
org.uk
ac.jp
ne.jp
or.jp
`;

function isSuffix(suf, psl) {
  return psl.has(suf);
}

/**
 * Extract the registrable domain (eTLD+1) from a hostname.
 * Returns null on failure.
 */
export function getRegistrableDomain(hostname, psl) {
  if (!hostname) return null;
  const host = hostname.toLowerCase().replace(/:\d+$/, '');
  if (!host || host === 'localhost') return null;
  const parts = host.split('.');
  if (parts.length < 2) return null;
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (isSuffix(candidate, psl)) {
      // This is a suffix; the domain is the part above it.
      if (i === 0) return candidate; // bare TLD (e.g. "co.uk" itself) — treat as itself
      return parts.slice(i - 1).join('.');
    }
  }
  // No suffix match — fall back to last two labels.
  return parts.slice(-2).join('.');
}

/**
 * Lightweight origin extraction (scheme + registrable domain).
 */
export function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol + '//' + u.hostname + (u.port ? ':' + u.port : '');
  } catch { return null; }
}
