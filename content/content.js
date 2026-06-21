// content/content.js
// Content script entrypoint. Listens for messages from the service worker.

(function () {
  if (window.__webnavContentLoaded) return;
  window.__webnavContentLoaded = true;

  // Inject outline style once.
  if (!document.getElementById('__webnav_styles__')) {
    const s = document.createElement('style');
    s.id = '__webnav_styles__';
    s.textContent = `.__webnav_outline__ { outline: 2px solid #f59e0b !important; outline-offset: 1px !important; box-shadow: 0 0 0 3px rgba(245,158,11,.25) !important; }`;
    (document.head || document.documentElement).appendChild(s);
  }

  function describeElement(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    };
  }

  function takeSnapshot() {
    if (!window.__webnavElementId) throw new Error('element-id not loaded');
    window.__webnavElementId.reset();
    const ids = window.__webnavElementId.assign(document, { maxElements: 1000 });
    const elements = window.__webnavElementId.snapshotElements();
    const elementsById = {};
    for (const e of elements) elementsById[e.id] = e;
    const url = location.href;
    const title = document.title;
    let origin = '';
    try { origin = new URL(url).origin; } catch {}
    const snap = {
      url, title, origin,
      capturedAt: Date.now(),
      elementCount: elements.length,
      elements,
      elementsById
    };
    snap.hash = window.__webnavElementId.hashSnapshot(snap);
    return snap;
  }

  function execute(call) {
    if (!window.__webnavElementId) return { ok: false, error: 'no_element_id' };
    if (call.tool === 'click') {
      const el = window.__webnavElementId.resolve(call.args.id);
      if (!el) return { ok: false, stale: true, error: 'stale_id' };
      const ok = window.__webnavDom.dispatchClick(el);
      return { ok, snapshot: takeSnapshot() };
    }
    if (call.tool === 'type_text') {
      const el = window.__webnavElementId.resolve(call.args.id);
      if (!el) return { ok: false, stale: true, error: 'stale_id' };
      const ok = window.__webnavDom.typeText(el, String(call.args.text), !!call.args.pressEnter);
      return { ok, snapshot: takeSnapshot() };
    }
    if (call.tool === 'extract_text') {
      let el = null;
      if (call.args.id) el = window.__webnavElementId.resolve(call.args.id);
      const text = window.__webnavDom.extractText(el, call.args.max);
      return { ok: true, text };
    }
    if (call.tool === 'scroll') {
      window.__webnavDom.scroll(call.args.direction, call.args.amount);
      return { ok: true, snapshot: takeSnapshot() };
    }
    if (call.tool === 'press_key') {
      window.__webnavDom.pressKey(call.args.key);
      return { ok: true, snapshot: takeSnapshot() };
    }
    if (call.tool === 'wait_for') {
      return window.__webnavDom.waitFor(call.args);
    }
    return { ok: false, error: 'unhandled_tool' };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (!msg || typeof msg !== 'object') { sendResponse({ ok: false, error: 'bad_message' }); return false; }
      if (msg.type === 'SNAPSHOT') {
        const snap = takeSnapshot();
        sendResponse({ ok: true, snapshot: snap });
        return false;
      }
      if (msg.type === 'EXECUTE') {
        const r = execute(msg.call);
        sendResponse(r);
        return false;
      }
      if (msg.type === 'PRESS_KEY') {
        window.__webnavDom.pressKey(msg.key);
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === 'SCROLL') {
        window.__webnavDom.scroll(msg.direction, msg.amount);
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === 'WAIT_FOR') {
        window.__webnavDom.waitFor(msg.args).then(sendResponse);
        return true;
      }
      if (msg.type === 'HIGHLIGHT') {
        window.__webnavDom.highlight(msg.ids);
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === 'PING') {
        sendResponse({ ok: true });
        return false;
      }
      sendResponse({ ok: false, error: 'unknown_message' });
      return false;
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
      return false;
    }
  });
})();
