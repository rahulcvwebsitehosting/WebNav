// content/content.js
// Content script entrypoint. Listens for messages from the service worker.

(function () {
  if (window.__webnavContentLoaded) return;
  window.__webnavContentLoaded = true;

  // ── Base styles (outline + overlay) ──────────────────────────────────────────
  if (!document.getElementById('__webnav_styles__')) {
    const s = document.createElement('style');
    s.id = '__webnav_styles__';
    s.textContent = [
      /* Element highlight outline */
      '.__webnav_outline__{outline:2px solid #f59e0b!important;outline-offset:1px!important;box-shadow:0 0 0 3px rgba(245,158,11,.25)!important;}',

      /* Full-viewport teal glow overlay — blocks user interaction when AI is active */
      '#__webnav_ai_overlay__{',
      '  position:fixed;inset:0;z-index:2147483644;pointer-events:all;',
      '  background:rgba(0,210,230,0.022);',
      '  animation:__wn_bpulse__ 2s ease-in-out infinite;',
      '}',
      '@keyframes __wn_bpulse__{',
      '  0%,100%{box-shadow:inset 0 0 0 3px rgba(0,210,230,0.88),inset 0 0 50px rgba(0,210,230,0.13);}',
      '  50%    {box-shadow:inset 0 0 0 3px rgba(0,150,255,0.88),inset 0 0 70px rgba(0,150,255,0.20);}',
      '}',

      /* Corner accent brackets */
      '.webnav-corner{position:fixed;z-index:2147483645;width:22px;height:22px;pointer-events:none;',
      '  animation:__wn_cpulse__ 2s ease-in-out infinite;}',
      '.webnav-corner.tl{top:0;left:0;border-top:3px solid #00d2e6;border-left:3px solid #00d2e6;}',
      '.webnav-corner.tr{top:0;right:0;border-top:3px solid #00d2e6;border-right:3px solid #00d2e6;}',
      '.webnav-corner.bl{bottom:0;left:0;border-bottom:3px solid #00d2e6;border-left:3px solid #00d2e6;}',
      '.webnav-corner.br{bottom:0;right:0;border-bottom:3px solid #00d2e6;border-right:3px solid #00d2e6;}',
      '@keyframes __wn_cpulse__{0%,100%{border-color:#00d2e6;opacity:1;}50%{border-color:#0096ff;opacity:0.55;}}',

      /* Pause pill */
      '#__webnav_pause_pill__{',
      '  position:fixed;bottom:20px;left:50%;transform:translateX(-50%);',
      '  z-index:2147483647;',
      '  background:rgba(6,10,22,0.93);',
      '  border:1px solid rgba(0,210,230,0.68);',
      '  border-radius:999px;',
      '  color:#d8f6ff;',
      '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
      '  font-size:13px;font-weight:600;',
      '  padding:9px 20px;',
      '  cursor:pointer;pointer-events:all;',
      '  display:flex;align-items:center;gap:9px;',
      '  box-shadow:0 4px 24px rgba(0,0,0,0.68),0 0 18px rgba(0,210,230,0.28);',
      '  backdrop-filter:blur(14px);',
      '  animation:__wn_pillin__ 0.35s cubic-bezier(0.22,1,0.36,1);',
      '  white-space:nowrap;user-select:none;',
      '}',
      '#__webnav_pause_pill__:hover{',
      '  background:rgba(18,28,50,0.97);',
      '  border-color:rgba(0,210,230,1);',
      '  box-shadow:0 4px 28px rgba(0,0,0,0.75),0 0 28px rgba(0,210,230,0.5);',
      '}',
      '@keyframes __wn_pillin__{',
      '  from{opacity:0;transform:translateX(-50%) translateY(14px);}',
      '  to  {opacity:1;transform:translateX(-50%) translateY(0);}',
      '}',
      '.webnav-pill-dot{',
      '  width:8px;height:8px;background:#00d2e6;border-radius:50%;flex-shrink:0;',
      '  animation:__wn_dotpulse__ 1.4s ease-in-out infinite;',
      '}',
      '@keyframes __wn_dotpulse__{',
      '  0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(0,210,230,0.6);}',
      '  50%    {transform:scale(1.35);box-shadow:0 0 0 5px rgba(0,210,230,0);}',
      '}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── AI Overlay ────────────────────────────────────────────────────────────────
  let _overlay = null;
  let _corners = [];
  let _pill = null;

  function showAiOverlay() {
    if (_overlay) return; // already visible

    const root = document.documentElement || document.body;

    _overlay = document.createElement('div');
    _overlay.id = '__webnav_ai_overlay__';
    root.appendChild(_overlay);

    for (const cls of ['tl', 'tr', 'bl', 'br']) {
      const c = document.createElement('div');
      c.className = 'webnav-corner ' + cls;
      root.appendChild(c);
      _corners.push(c);
    }

    _pill = document.createElement('div');
    _pill.id = '__webnav_pause_pill__';
    _pill.innerHTML = '<span class="webnav-pill-dot"></span><span>⏸ Pause WebNav</span>';
    _pill.title = 'Stop the AI task running on this tab';
    _pill.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'STOP_TASK' }); } catch {}
    });
    root.appendChild(_pill);
  }

  function hideAiOverlay() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
    for (const c of _corners) { try { c.remove(); } catch {} }
    _corners = [];
    if (_pill) { _pill.remove(); _pill = null; }
  }

  // ── Snapshot helpers ──────────────────────────────────────────────────────────
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

  // ── Message listener ──────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (!msg || typeof msg !== 'object') { sendResponse({ ok: false, error: 'bad_message' }); return false; }

      // Overlay control messages
      if (msg.type === 'AI_OVERLAY_SHOW') { showAiOverlay(); sendResponse({ ok: true }); return false; }
      if (msg.type === 'AI_OVERLAY_HIDE') { hideAiOverlay(); sendResponse({ ok: true }); return false; }

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
