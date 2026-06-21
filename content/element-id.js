// content/element-id.js
// Per-tab assignment of stable opaque IDs to interactive elements.
// Internal Map<HTMLElement, string>; reverse Map<string, HTMLElement> for fast resolve.
// IDs reset on each new snapshot.

(function () {
  const state = {
    nextSeq: 0,
    byEl: new WeakMap(),
    byId: new Map(),
    iframeIndex: 0
  };

  function reset() {
    state.nextSeq = 0;
    state.byEl = new WeakMap();
    state.byId = new Map();
    state.iframeIndex = 0;
  }

  function assign(root, opts) {
    if (!root) return [];
    const cap = (opts && opts.maxElements) || 1000;
    const out = [];
    const interactiveSelector = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"], [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"]), [onclick], summary, label';
    try {
      const nodes = root.querySelectorAll(interactiveSelector);
      for (const el of nodes) {
        if (out.length >= cap) break;
        if (!isVisible(el)) continue;
        if (state.byEl.has(el)) {
          out.push(state.byEl.get(el));
          continue;
        }
        const id = `e_${(state.nextSeq++).toString(36)}`;
        state.byEl.set(el, id);
        state.byId.set(id, el);
        out.push(id);
      }
    } catch (e) { /* root might be detached */ }
    return out;
  }

  function resolve(id) {
    return state.byId.get(id) || null;
  }

  function snapshotElements() {
    const elements = [];
    for (const [id, el] of state.byId.entries()) {
      elements.push(describe(el, id));
    }
    return elements;
  }

  function describe(el, id) {
    const tag = el.tagName ? el.tagName.toUpperCase() : 'UNKNOWN';
    const role = el.getAttribute('role') || implicitRole(el);
    const aria = el.getAttribute('aria-label') || '';
    const text = textOf(el).slice(0, 160);
    const placeholder = el.getAttribute && el.getAttribute('placeholder') || '';
    const name = el.getAttribute && el.getAttribute('name') || '';
    const type = el.getAttribute && el.getAttribute('type') || '';
    const autocomplete = el.getAttribute && el.getAttribute('autocomplete') || '';
    const href = (el.getAttribute && el.getAttribute('href')) || '';
    const value = (el.value != null) ? String(el.value) : '';
    const rect = el.getBoundingClientRect ? [rectRound(el.getBoundingClientRect().left), rectRound(el.getBoundingClientRect().top), rectRound(el.getBoundingClientRect().width), rectRound(el.getBoundingClientRect().height)] : [0, 0, 0, 0];
    const inViewport = isInViewport(el);
    const hasDownloadAttr = !!(el.hasAttribute && el.hasAttribute('download'));
    const isInForm = !!(el.closest && el.closest('form'));
    const isSubmit = isSubmitEl(el);
    return { id, tag, role, text, aria, placeholder, name, type, autocomplete, href, value, rect, inViewport, hasDownloadAttr, isInForm, isSubmit };
  }

  function rectRound(n) { return Math.round(n); }

  function implicitRole(el) {
    const tag = el.tagName;
    if (!tag) return '';
    const t = tag.toLowerCase();
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'button') return 'button';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'submit' || ty === 'button') return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'email' || ty === 'tel' || ty === 'text' || ty === 'url' || ty === 'search') return 'textbox';
      if (ty === 'password') return 'textbox';
      return 'textbox';
    }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'combobox';
    if (t === 'summary') return 'button';
    return '';
  }

  function textOf(el) {
    if (!el) return '';
    // Use accessible name when possible.
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.getAttribute('alt')) return el.getAttribute('alt');
    if (el.getAttribute('title')) return el.getAttribute('title');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return el.value || el.placeholder || '';
    }
    // innerText would be best but is heavy; use textContent trimmed.
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.nodeType !== 1) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
    return true;
  }

  function isInViewport(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }

  function isSubmitEl(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'button') {
      const t = (el.getAttribute('type') || 'submit').toLowerCase();
      return t === 'submit';
    }
    if (tag === 'input') return (el.getAttribute('type') || '').toLowerCase() === 'submit';
    return false;
  }

  function hashSnapshot(snap) {
    // Light fingerprint: url + title + first 12 element sigs.
    const sigs = (snap.elements || []).slice(0, 12).map(e => `${e.tag}|${e.role}|${(e.text || '').slice(0, 40)}|${(e.aria || '').slice(0, 40)}`).join('||');
    let h = 5381;
    const s = (snap.url || '') + '###' + (snap.title || '') + '###' + sigs;
    for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
    return (h >>> 0).toString(36);
  }

  // Expose
  window.__webnavElementId = {
    reset, assign, resolve, snapshotElements, describe, hashSnapshot,
    state
  };
})();
