// content/dom-utils.js
// DOM helpers used by content.js to execute tool calls.

(function () {
  function dispatchClick(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      return true;
    } catch (e) {
      try { el.click(); return true; } catch { return false; }
    }
  }

  function typeText(el, text, pressEnter) {
    if (!el) return false;
    try {
      el.focus();
    } catch {}
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      try {
        // Set value + dispatch input/change for React/Vue handlers.
        const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (el.isContentEditable) {
      // Selection at end, insert text.
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      } catch (e) {
        el.textContent = (el.textContent || '') + text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      el.textContent = (el.textContent || '') + text;
    }
    if (pressEnter) pressKey('Enter');
    return true;
  }

  function pressKey(key) {
    const map = { 'Enter': 'Enter', 'Tab': 'Tab', 'Escape': 'Escape', 'Backspace': 'Backspace' };
    const k = map[key] || key;
    try {
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keypress', { key: k, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
    } catch {}
  }

  function scroll(direction, amount) {
    const a = Number(amount) || 0;
    if (direction === 'down') window.scrollBy(0, a);
    else if (direction === 'up') window.scrollBy(0, -a);
    else if (direction === 'right') window.scrollBy(a, 0);
    else if (direction === 'left') window.scrollBy(-a, 0);
  }

  async function waitFor({ selector, id, text, timeout }) {
    const t = Math.max(100, Math.min(60000, Number(timeout) || 5000));
    const start = Date.now();
    while (Date.now() - start < t) {
      if (id && window.__webnavElementId && window.__webnavElementId.resolve(id)) return { ok: true, found: true };
      if (selector) {
        try { if (document.querySelector(selector)) return { ok: true, found: true, selector }; } catch {}
      }
      if (text) {
        if ((document.body.innerText || '').includes(text)) return { ok: true, found: true, text };
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return { ok: false, error: 'timeout' };
  }

  function extractText(el, max) {
    if (!el) return (document.body.innerText || '').slice(0, max || 8000);
    return (el.innerText || el.textContent || '').slice(0, max || 8000);
  }

  function highlight(ids) {
    try {
      document.querySelectorAll('.__webnav_outline__').forEach(n => n.classList.remove('__webnav_outline__'));
      for (const id of (ids || [])) {
        const el = window.__webnavElementId && window.__webnavElementId.resolve(id);
        if (el) el.classList.add('__webnav_outline__');
      }
    } catch {}
  }

  window.__webnavDom = { dispatchClick, typeText, pressKey, scroll, waitFor, extractText, highlight };
})();
