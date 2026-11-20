const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), core = require('./meter-core');
const source = fs.readFileSync(require('node:path').join(__dirname, 'meter-renderer.js'), 'utf8');
function session(unknown = 0) { return { groups: Object.fromEntries(['user','assistant','thinking','tools','summaries','system','definitions'].map(k => [k,core.empty()])), total: { chars: 100, low: 10, high: 50 }, attachmentTotal: core.empty(), attachments: unknown ? [{ name: '<img onerror=bad>', status: 'unknown', unknownParts: ['图像 token 未知'], chars: 0, source: 'user' }] : [], unknownFiles: unknown, steps: 10, userMessages: 2, assistantMessages: 3 }; }
function harness(scanSession = session()) {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();
  const element = () => {
    const attrs = new Map();
    const props = new Map();
    const el = {
      style: {
        display: '',
        opacity: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children: [], hidden: false, textContent: '',
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      classList: {
        add(c) {
          const current = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          if (!current.includes(c)) current.push(c);
          attrs.set('class', current.join(' '));
        },
        remove(c) {
          const current = (attrs.get('class') || '').split(/\s+/).filter(x => x && x !== c);
          attrs.set('class', current.join(' '));
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), el);
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) {
        if (k === 'id') {
          const id = attrs.get('id');
          if (id && docElements.get(id) === el) docElements.delete(id);
        }
        attrs.delete(k);
      },
      remove() {
        if (this.parentElement && Array.isArray(this.parentElement.children)) {
          const idx = this.parentElement.children.indexOf(this);
          if (idx >= 0) this.parentElement.children.splice(idx, 1);
        }
        const myId = attrs.get('id');
        if (myId && docElements.get(myId) === this) {
          docElements.delete(myId);
        }
      },
      appendChild(x) {
        if (x) {
          x.parentElement = this;
          this.children.push(x);
          const xId = x.id || (typeof x.getAttribute === 'function' ? x.getAttribute('id') : null);
          if (xId) docElements.set(xId, x);
        }
      },
      querySelectorAll(sel) {
        const found = [];
        const check = node => {
          if (!node) return;
          if (sel === '#ag-wco-spacer' && (node.id === 'ag-wco-spacer' || node.getAttribute?.('id') === 'ag-wco-spacer')) {
            found.push(node);
          }
          if (Array.isArray(node.children)) {
            for (const child of node.children) check(child);
          }
        };
        for (const child of this.children) check(child);
        return found;
      },
      replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.appendChild(n); },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };
  const host = element(); host.attachShadow = () => ({ set innerHTML(value) {}, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } });
  const pending = [], scans = [], timers = [];
  const lsStore = new Map([['ag_panel_language', 'zh-CN']]);
  const sandbox = { location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' }, document: { createElement: () => element(), getElementById: id => docElements.get(id) || null, documentElement: { appendChild() {} }, addEventListener() {}, removeEventListener() {}, hidden: false }, window: { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: id => new Promise(resolve => scans.push({ id, resolve })) } }, localStorage: { getItem: k => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: k => lsStore.delete(k) }, __AGContextMeterCore: core, AbortController, Date, setTimeout: () => 1, clearTimeout() {}, setInterval(callback) { timers.push(callback); return 1; }, clearInterval() {}, fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); } };
  // First createElement call is the host; later calls are safe text-only file rows.
  let first = true; sandbox.document.createElement = () => { if (first) { first = false; return host; } return element(); };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  return { sandbox, host, pending, scans, elements, tick: () => timers[0](), flush: () => new Promise(resolve => setImmediate(resolve)), finishScan(i = 0) { scans[i].resolve({ ok: true, data: { session: scanSession, scannedAt: Date.now(), latest: null } }); } };
}
function response(chatModel) { return { ok: true, json: async () => ({ generatorMetadata: [{ chatModel }] }) }; }
test('late old request and old full-scan responses cannot contaminate a newly selected chat', async () => {
  const h = harness(); h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222'; h.tick();
  assert.equal(h.pending[0].options.signal.aborted, true);
  h.pending[1].resolve(response({ usage: { inputTokens: 10000 } })); h.finishScan(1); await h.flush();
  h.pending[0].resolve(response({ usage: { inputTokens: 900000 } })); h.scans[0].resolve({ ok: true, data: { session: session(1), latest: null, scannedAt: Date.now() } }); await h.flush();
  assert.equal(h.sandbox.__AGContextMeter.snapshot().latest.actual, 10000); assert.equal(h.sandbox.__AGContextMeter.snapshot().scan.session.unknownFiles, 0); h.sandbox.__AGContextMeter.dispose();
});
test('server overflow dominates low client estimate, missing images and successful old usage', async () => {
  const h = harness(session(1)); h.finishScan();
  h.pending[0].resolve(response({ usage: { inputTokens: 9000 }, chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 127117, maxContextTokens: 256000 } }, retryInfos: [{ error: 'The input token count exceeds the maximum number of tokens allowed 1048576.' }] })); await h.flush();
  assert.match(h.elements.get('amount').textContent, /服务端超限/); assert.match(h.elements.get('status').textContent, /本地估算不可靠/); assert.equal(h.elements.get('percent').textContent, '—'); assert.doesNotMatch(h.elements.get('status').textContent, /生成中|充足|正常/); h.sandbox.__AGContextMeter.dispose();
});
test('unknown attachments appear as unknown in totals and file names are literal text', async () => {
  const h = harness(session(1)); h.finishScan(); h.pending[0].resolve(response({ usage: { inputTokens: 1000 } })); await h.flush();
  assert.match(h.elements.get('session-total').textContent, /未知内容/); assert.match(h.elements.get('coverage').textContent, /1 个含未计内容/);
  assert.equal(h.elements.get('files').children[0].children[0].textContent, '<img onerror=bad> '); h.sandbox.__AGContextMeter.dispose();
});
test('a visible newer failure is not cleared by polling old successful metadata', async () => {
  const s = session(); s.currentError = { index: 907, text: 'The input token count exceeds the maximum number of tokens allowed 1048576.' };
  const h = harness(s); h.finishScan(); await h.flush();
  h.pending[0].resolve(response({ usage: { inputTokens: 120000 } })); await h.flush();
  assert.match(h.elements.get('amount').textContent, /服务端超限/); assert.equal(h.sandbox.__AGContextMeter.snapshot().latest.actual, null); h.sandbox.__AGContextMeter.dispose();
});
test('backend estimate never becomes a capacity percentage', async () => {
  const h = harness(); h.finishScan(); h.pending[0].resolve(response({ chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 1000, maxContextTokens: 256000 } } })); await h.flush();
  assert.equal(h.elements.get('percent').textContent, '—'); assert.match(h.elements.get('amount').textContent, /真实量未知/); h.sandbox.__AGContextMeter.dispose();
});
test('failed history scan stays explicitly incomplete instead of claiming there were no attachments', async () => {
  const h = harness(); h.scans[0].resolve({ ok: false, error: 'missing file' }); h.pending[0].resolve({ ok: false, status: 503 }); await h.flush();
  assert.equal(h.elements.get('session-total').textContent, '扫描未完成'); assert.match(h.elements.get('coverage').textContent, /missing file/); h.sandbox.__AGContextMeter.dispose();
});
test('home screen clears previous conversation and cancels in-flight requests', () => {
  const h = harness(); h.sandbox.location.pathname = '/'; h.tick(); assert.equal(h.sandbox.__AGContextMeter.snapshot().scan, null); assert.equal(h.pending[0].options.signal.aborted, true); h.sandbox.__AGContextMeter.dispose();
});
test('badge renders visual progress bar and concise context number when unhovered', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({ usage: { inputTokens: 214624, outputTokens: 1454 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } } })); await h.flush();
  assert.equal(h.elements.get('bar-fill').style.width, '84.40546875%');
  assert.match(h.elements.get('amount').textContent, /^216(?:\.1)?K \(84%\)$/);
  assert.match(h.elements.get('hover-extra').textContent, /\/ 256K/);
  assert.equal(h.elements.get('key-used').textContent, '216.1K (84.4%)');
  assert.equal(h.elements.get('key-limit').textContent, '256K');
  assert.match(h.elements.get('key-remaining').textContent, /39\.9K \(15\.6%\)/);
  assert.match(h.elements.get('key-takeaway').textContent, /已使用 84\.4%/);
  assert.equal(h.elements.get('key-badge').textContent, '偏高');
  h.sandbox.__AGContextMeter.dispose();
});
test('key summary card shows overflow alert and zeroes remaining when exceeded', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({ retryInfos: [{ error: 'The input token count exceeds the maximum number of tokens allowed 1048576.' }] })); await h.flush();
  assert.equal(h.elements.get('bar-fill').style.width, '100%');
  assert.equal(h.elements.get('amount').textContent, '服务端超限');
  assert.equal(h.elements.get('key-badge').textContent, '已超限');
  assert.equal(h.elements.get('key-remaining').textContent, '0 (已溢出)');
  assert.match(h.elements.get('key-takeaway').textContent, /已超出服务端最大限制/);
  h.sandbox.__AGContextMeter.dispose();
});
test('theme mode switches freely between light and dark', () => {
  const h = harness();
  assert.equal(typeof h.sandbox.__AGContextMeter.theme(), 'string');
  h.sandbox.__AGContextMeter.setTheme('light');
  assert.equal(h.sandbox.__AGContextMeter.theme(), 'light');
  h.sandbox.__AGContextMeter.setTheme('dark');
  assert.equal(h.sandbox.__AGContextMeter.theme(), 'dark');
  h.sandbox.__AGContextMeter.dispose();
});
test('speed badge and speed summary card accurately render model output speed and duration', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({
    timeToFirstToken: '8.395092700s',
    streamingDuration: '12.902455200s',
    usage: {
      inputTokens: 4335,
      outputTokens: 2388,
      thinkingOutputTokens: 1260,
      responseOutputTokens: 1128
    },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
  }));
  await h.flush();
  assert.equal(h.elements.get('speed-amount').textContent, '185.1 tok/s');
  assert.match(h.elements.get('speed-hover-extra').textContent, /21\.3s/);
  assert.match(h.elements.get('badge-speed').title, /185\.1 tok\/s/);
  assert.equal(h.elements.get('speed-val').textContent, '185.1 tok/s');
  assert.equal(h.elements.get('speed-duration').textContent, '21.3s');
  assert.equal(h.elements.get('speed-ttft').textContent, '8.4s');
  assert.match(h.elements.get('speed-tokens').textContent, /2,388 tok/);
  assert.equal(h.elements.get('speed-badge').textContent, '83.7 分 · A');
  assert.match(h.elements.get('speed-takeaway').textContent, /83\.8 分|整体均速 112\.1 tok\/s/);
  h.sandbox.__AGContextMeter.dispose();
});
test('drawer toggle controls secondary technical details visibility', () => {
  const h = harness();
  const btn = h.elements.get('btn-toggle-details');
  const body = h.elements.get('drawer-body');
  const arrow = h.elements.get('drawer-arrow');
  assert.ok(btn);
  assert.ok(body);
  btn.click();
  assert.equal(body.style.display, 'block');
  assert.equal(arrow.textContent, '▲ 点击收起明细');
  btn.click();
  assert.equal(body.style.display, 'none');
  assert.equal(arrow.textContent, '▼ 点击展开明细');
  h.sandbox.__AGContextMeter.dispose();
});
test('unified workbench panel and anti-hover-misclick switching across session and tokens', () => {
  const h = harness();
  const bContext = h.elements.get('badge');
  const bSpeed = h.elements.get('badge-speed');
  const bTokens = h.elements.get('badge-tokens');
  const pPanel = h.elements.get('panel');
  const paneSession = h.elements.get('pane-ctx-session');
  const pTokens = h.elements.get('panel-tokens');

  assert.ok(pPanel);
  assert.ok(pTokens);
  assert.equal(pPanel.hidden, true);
  assert.equal(pTokens.hidden, true);

  // Click Context badge -> opens unified workbench on Session tab
  bContext.click();
  assert.equal(pPanel.hidden, false);
  assert.equal(paneSession.hidden, false);
  assert.equal(pTokens.hidden, true);

  // Hover over Tokens badge while open -> does NOT accidentally switch (anti-misclick)
  bTokens.trigger('mouseenter');
  assert.equal(pPanel.hidden, false);
  assert.equal(paneSession.hidden, false);
  assert.equal(pTokens.hidden, true);

  // Left click on Tokens badge -> switches unified workbench to Tokens tab (700px wide)
  bTokens.click();
  assert.equal(pPanel.hidden, false);
  assert.equal(paneSession.hidden, true);
  assert.equal(pTokens.hidden, false);
  assert.equal(pPanel.getAttribute('data-wb-wide'), 'true');

  // Hover over Speed / Context badge -> does NOT switch back
  bSpeed.trigger('mouseenter');
  bContext.trigger('mouseenter');
  assert.equal(pTokens.hidden, false);

  // Left click Context badge -> switches back to Session tab (480px compact)
  bContext.click();
  assert.equal(pPanel.hidden, false);
  assert.equal(paneSession.hidden, false);
  assert.equal(pTokens.hidden, true);
  assert.equal(pPanel.getAttribute('data-wb-wide'), null);

  // Close button closes unified workbench and marks all panes hidden
  h.elements.get('close').click();
  assert.equal(pPanel.hidden, true);
  assert.equal(pTokens.hidden, true);

  h.sandbox.__AGContextMeter.dispose();
});

test('circular ring indicator and 3-layer tooltip bubble match reference hierarchy on hover and focus', async () => {
  const h = harness(); h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 36500, outputTokens: 500 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 475000 } }
  }));
  await h.flush();

  const ringFill = h.elements.get('ring-fill');
  const tip = h.elements.get('context-tooltip');
  const tipTitle = h.elements.get('ctx-tip-title');
  const tipPct = h.elements.get('ctx-tip-pct');
  const tipDetail = h.elements.get('ctx-tip-detail');
  const badge = h.elements.get('badge');

  assert.equal(ringFill.getAttribute('data-ring-state'), 'determinate');
  // 37k / 475k = 7.789% -> rounds to 8% used (92% remaining)
  assert.equal(tipTitle.textContent, '上下文窗口：');
  assert.equal(tipPct.textContent, '8% 已用（剩余 92%）');
  assert.equal(tipDetail.textContent, '已用 37k token，共 475k');

  // Hover opens tooltip, mouseleave closes
  assert.equal(tip.getAttribute('data-visible'), 'false');
  badge.trigger('mouseenter');
  assert.equal(tip.getAttribute('data-visible'), 'true');
  badge.trigger('mouseleave');
  assert.equal(tip.getAttribute('data-visible'), 'false');

  // Keyboard focus opens tooltip, blur closes
  badge.trigger('focus');
  assert.equal(tip.getAttribute('data-visible'), 'true');
  badge.trigger('blur');
  assert.equal(tip.getAttribute('data-visible'), 'false');

  h.sandbox.__AGContextMeter.dispose();
});

test('unknown capacity and estimated states never draw ring as 0% or 100% and preserve estimation labels', async () => {
  const h = harness(); h.finishScan();
  // Case 1: estimated only, no actual server usage
  h.pending[0].resolve(response({
    chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 42000, maxContextTokens: 256000 } }
  }));
  await h.flush();

  const ringFill = h.elements.get('ring-fill');
  const tipTitle = h.elements.get('ctx-tip-title');
  const tipPct = h.elements.get('ctx-tip-pct');
  const tipDetail = h.elements.get('ctx-tip-detail');

  assert.equal(ringFill.getAttribute('data-ring-state'), 'estimated');
  assert.equal(ringFill.getAttribute('stroke-dasharray'), '3.2 4.97');
  assert.match(tipTitle.textContent, /本地估算/);
  assert.match(tipPct.textContent, /仅估算/);
  assert.match(tipDetail.textContent, /≈ 42k token，共 256k/);

  h.sandbox.__AGContextMeter.dispose();
});

test('progressive width collapse transitions smoothly across 4 stages with hysteresis and preserves full access in ring-only mode', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  assert.equal(api.getLayoutMode(), 'wide');
  // Collapse wide -> compact (<195)
  assert.equal(api.setAvailableWidthForTest(180), 'compact');
  // Hysteresis deadband: 200 (<210) stays compact instead of oscillating back to wide
  assert.equal(api.setAvailableWidthForTest(200), 'compact');
  // Expand back to wide (>=210)
  assert.equal(api.setAvailableWidthForTest(215), 'wide');

  // Collapse to minimal (<135)
  assert.equal(api.setAvailableWidthForTest(120), 'minimal');
  assert.equal(api.setAvailableWidthForTest(142), 'minimal'); // hysteresis (<150)

  // Collapse to ring-only (<68)
  assert.equal(api.setAvailableWidthForTest(55), 'ring-only');
  assert.equal(api.setAvailableWidthForTest(75), 'ring-only'); // hysteresis (<82)
  assert.equal(api.setAvailableWidthForTest(90), 'minimal');

  // In ring-only mode, clicking the ring opens workbench, and overflow menu reaches token & speed views
  api.setAvailableWidthForTest(50);
  h.elements.get('badge').click();
  assert.equal(h.elements.get('panel').hidden, false);
  h.elements.get('overflow-tokens-btn')?.click();
  assert.equal(h.elements.get('panel').hidden, false);
  assert.equal(h.elements.get('panel-tokens').hidden, false);
  h.elements.get('overflow-speed-btn')?.click();
  assert.equal(h.elements.get('panel').hidden, false);
  assert.equal(api.getWorkbenchStateForTest().activeTab, 'speed');

  api.dispose();
});

test('5 curated palettes and theme modes update heatmap & accent variables without masking high-occupancy alerts', async () => {
  const h = harness(); h.finishScan();
  const api = h.sandbox.__AGContextMeter;

  api.setHeatPreset('emerald');
  assert.equal(api.getHeatPreset(), 'emerald');
  assert.equal(h.host.style.getPropertyValue('--ag-heat-lvl-4'), '#86efac');

  h.pending[0].resolve(response({
    usage: { inputTokens: 240000, outputTokens: 2000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
  }));
  await h.flush();
  assert.equal(h.host.getAttribute('data-occupancy'), 'danger');
  assert.match(h.elements.get('ctx-tip-title').textContent, /高占用告警/);
  assert.match(h.elements.get('ctx-tip-pct').textContent, /接近上限/);

  api.resetAppearanceDefaults();
  assert.equal(api.getHeatPreset(), 'violet');
  api.dispose();
});

test('window controls overlay spacer, convPane flex-grow self-healing, and clean dispose', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  assert.equal(api.version, pkgVersion);

  // 1. Antigravity 1.x: class contains 'top-0'
  const cluster1x = h.sandbox.document.createElement();
  cluster1x.className = 'absolute right-0 top-0 z-50 flex items-center';
  cluster1x.getBoundingClientRect = () => ({ top: 0, left: 1200, right: 1440, bottom: 40, width: 240, height: 40 });
  const auxToggle1x = h.sandbox.document.createElement();
  auxToggle1x.setAttribute('data-testid', 'toggle-aux-sidebar');
  auxToggle1x.closest = sel => sel.includes('top-0') ? cluster1x : null;

  h.sandbox.document.querySelector = sel => {
    if (sel.includes('toggle-aux-sidebar')) return auxToggle1x;
    return null;
  };
  assert.equal(api.findTopRightClusterForTest(), cluster1x, 'Must detect Antigravity 1.x cluster with top-0 class');

  // 2. Antigravity 2.x: top: 0px is inline style, class has no top-0
  const cluster2x = h.sandbox.document.createElement();
  cluster2x.className = 'absolute right-0 z-50 flex items-center shrink-0';
  cluster2x.style.top = '0px';
  cluster2x.getBoundingClientRect = () => ({ top: 0, left: 1200, right: 1440, bottom: 40, width: 240, height: 40 });
  const auxToggle2x = h.sandbox.document.createElement();
  auxToggle2x.setAttribute('data-testid', 'toggle-aux-sidebar');
  auxToggle2x.closest = sel => sel.includes('top-0') ? null : (sel.includes('right-0') ? cluster2x : null);

  h.sandbox.document.querySelector = sel => {
    if (sel.includes('toggle-aux-sidebar')) return auxToggle2x;
    return null;
  };
  assert.equal(api.findTopRightClusterForTest(), cluster2x, 'Must detect Antigravity 2.x cluster with style="top: 0px;"');

  // 3. Fallback when auxToggle is missing: matches cluster2x via fallback selector
  h.sandbox.document.querySelector = sel => {
    if (sel === 'div.absolute.right-0.z-50') return cluster2x;
    return null;
  };
  assert.equal(api.findTopRightClusterForTest(), cluster2x, 'Fallback must find top-right cluster');

  // 4. Safety: strictly reject unrelated floating layers
  // 4a. Scrollbar track (w-3, right-0.5, top-0.5)
  const scrollbar = h.sandbox.document.createElement();
  scrollbar.className = 'group absolute top-0.5 bottom-0.5 right-0.5 w-3 z-30';
  scrollbar.getBoundingClientRect = () => ({ top: 0, left: 1435, right: 1440, bottom: 800, width: 5, height: 800 });

  // 4b. Full-height side drawer / panel
  const sideDrawer = h.sandbox.document.createElement();
  sideDrawer.className = 'absolute right-0 top-12 bottom-0 w-80 bg-white';
  sideDrawer.getBoundingClientRect = () => ({ top: 48, left: 1120, right: 1440, bottom: 800, width: 320, height: 752 });

  // 4c. Bottom toast notification
  const bottomToast = h.sandbox.document.createElement();
  bottomToast.className = 'absolute right-0 bottom-4 z-50';
  bottomToast.getBoundingClientRect = () => ({ top: 760, left: 1200, right: 1440, bottom: 800, width: 240, height: 40 });

  for (const unrelated of [scrollbar, sideDrawer, bottomToast]) {
    h.sandbox.document.querySelector = sel => {
      if (sel === 'div.absolute.right-0.z-50') return unrelated;
      return null;
    };
    assert.equal(api.findTopRightClusterForTest(), null, `Must safely reject unrelated floating element: ${unrelated.className}`);
  }

  // 5. WCO spacer width calculation & mounting on Windows (at top: 0px, no top-0 class)
  h.sandbox.document.querySelector = sel => {
    if (sel.includes('toggle-aux-sidebar')) return auxToggle2x;
    return null;
  };
  const wcoWidth = api.computeWindowControlsWidthForTest(cluster2x);
  assert.equal(wcoWidth, 138, 'Windows with no menubar should allocate 138px for titleBarOverlay');

  api.syncWindowControlsOverlayForTest();
  assert.equal(cluster2x.children.length, 1);
  const spacer = cluster2x.children[0];
  assert.equal(spacer.id, 'ag-wco-spacer');
  assert.equal(spacer.style.cssText, 'width:138px;height:100%;flex-shrink:0;pointer-events:none;');
  assert.equal(h.sandbox.document.getElementById('ag-wco-spacer'), spacer, 'ag-wco-spacer must be accessible in document');

  // 6. When toolbar moves down (top >= 20), findTopRightCluster returns null, and syncWindowControlsOverlay removes the old spacer
  cluster2x.style.top = '25px';
  cluster2x.getBoundingClientRect = () => ({ top: 25, left: 1200, right: 1440, bottom: 65, width: 240, height: 40 });
  assert.equal(api.findTopRightClusterForTest(), null, 'findTopRightCluster must return null when toolbar moves down to top >= 20');
  api.syncWindowControlsOverlayForTest();
  assert.equal(cluster2x.children.length, 0, 'Spacer must be cleanly removed from toolbar when moved down');
  assert.equal(h.sandbox.document.getElementById('ag-wco-spacer'), null, 'ag-wco-spacer must be removed from document');

  // 7. Standalone compute check: when top menu bar is present (top >= 20), WCO width is 0
  const clusterWithMenu = h.sandbox.document.createElement();
  clusterWithMenu.className = 'absolute right-0 z-50 flex items-center shrink-0';
  clusterWithMenu.style.top = '35px';
  clusterWithMenu.getBoundingClientRect = () => ({ top: 35, left: 1200, right: 1440, bottom: 75, width: 240, height: 40 });
  assert.equal(api.computeWindowControlsWidthForTest(clusterWithMenu), 0);

  // 8. On macOS (Darwin/MacIntel), WCO width is 0
  h.sandbox.navigator = { platform: 'MacIntel' };
  assert.equal(api.computeWindowControlsWidthForTest(cluster2x), 0);
  api.dispose();
});

test('floating panels reposition clear of left project sidebar and overlay right auxiliary pane without clipping', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  // Simulate left project sidebar expanded (0..256px) and right auxiliary pane open (host right = 610px in 1280px window)
  h.sandbox.window.innerWidth = 1280;
  h.sandbox.window.innerHeight = 800;
  h.host.getBoundingClientRect = () => ({ left: 420, top: 6, right: 610, bottom: 34, width: 190, height: 28 });
  h.sandbox.document.querySelector = sel => {
    if (sel === 'div[role="navigation"]') {
      return { getBoundingClientRect: () => ({ left: 0, top: 0, right: 256, bottom: 800, width: 256, height: 800 }) };
    }
    return null;
  };

  h.elements.get('badge-tokens').click();
  const pPanel = h.elements.get('panel');
  const pTokens = h.elements.get('panel-tokens');
  assert.equal(pPanel.hidden, false);
  assert.equal(pTokens.hidden, false);
  const leftPx = parseInt(pPanel.style.left, 10);
  // Must be >= 256 + 12 = 268px (never occluded by left project sidebar) and extend rightward over Aux Pane
  assert.equal(leftPx, 268);
  assert.equal(pPanel.style.right, 'auto');
  assert.ok(leftPx + 700 <= 1280 - 12);

  api.dispose();
});

test('theme mode (auto/dark/light) and curated palettes harmonize dark & light 5-stop scales', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  api.setTheme('dark');
  api.setHeatPreset('ocean');
  assert.equal(api.getThemeMode(), 'dark');
  const darkPalette = api.getHeatPalette();
  assert.equal(darkPalette.length, 5);
  assert.equal(darkPalette[4], '#93c5fd');

  api.setTheme('light');
  assert.equal(api.getThemeMode(), 'light');
  const lightPalette = api.getHeatPalette();
  assert.equal(lightPalette[4], '#1e3a8a');
  assert.notEqual(lightPalette[0], darkPalette[0]);

  api.resetAppearanceDefaults();
  assert.equal(api.getThemeMode(), 'auto');
  assert.equal(api.getHeatPreset(), 'violet');
  api.dispose();
});

test('timeline starts at actual firstUseDate with zero leading blank cells and supports multi-year archive pagination', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // Verify custom firstUseDate (2026-10-20)
  api.setTokenHistoryForTest({
    firstUseDate: '2026-10-20',
    dailyMap: {
      '2026-10-20': { total: 3594989, input: 738031, output: 52244, cache: 2804714, steps: 63 }
    }
  });
  h.elements.get('badge-tokens').click();
  const win1 = api.getTimelineWindow();
  assert.equal(win1.firstUseDate, '2026-10-20');
  assert.equal(win1.winStart, '2026-10-20');
  assert.equal(h.elements.get('first-use-badge').textContent, '首次使用：2026年10月20日');

  const colsBox = h.elements.get('h-grid-cols');
  assert.equal(colsBox.children.length, 52);
  const firstCell = colsBox.children[0].children[0];
  assert.equal(firstCell.getAttribute('data-date'), '2026-10-20');

  // Simulate multi-year archive (e.g., first use 2025-03-15) -> rolling 12-month window with pagination clamped >= firstUseDate
  api.setTokenHistoryForTest({
    firstUseDate: '2025-03-15',
    dailyMap: {
      '2025-03-15': { total: 12000000, input: 10000000, output: 1000000, cache: 1000000, steps: 80 }
    }
  });
  const win2 = api.getTimelineWindow();
  assert.equal(win2.firstUseDate, '2025-03-15');
  assert.equal(h.elements.get('first-use-badge').textContent, '首次使用：2025年3月15日');
  assert.equal(win2.canPrev, true);

  // Page back to earliest history; winStart must never go earlier than 2025-03-15
  h.elements.get('h-page-prev').click();
  h.elements.get('h-page-prev').click();
  h.elements.get('h-page-prev').click();
  const winEarliest = api.getTimelineWindow();
  assert.equal(winEarliest.winStart, '2025-03-15');
  assert.equal(winEarliest.canPrev, false);
  assert.equal(winEarliest.canNext, true);

  api.dispose();
});

test('topbar pill visibility toggles hide selected badges and enforce keeping at least 1 panel entry visible', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  assert.deepEqual({ ...api.getTopbarPills() }, { quota: true, context: true, speed: true, tokens: true, cli: true });
  assert.equal(api.setTopbarPillVisible('cli', false), true);
  assert.equal(h.elements.get('badge-cli').getAttribute('data-user-hidden'), 'true');
  assert.equal(api.setTopbarPillVisible('quota', false), true);
  assert.equal(api.setTopbarPillVisible('speed', false), true);
  assert.equal(api.setTopbarPillVisible('context', false), true);
  assert.equal(h.host.getAttribute('data-context-hidden'), 'true');

  // Now 'tokens' is the last remaining panel-opening pill -> must refuse hiding it!
  assert.equal(api.setTopbarPillVisible('tokens', false), false);
  assert.equal(api.getTopbarPills().tokens, true);

  api.resetAppearanceDefaults();
  assert.equal(h.host.getAttribute('data-context-hidden'), null);
  assert.deepEqual({ ...api.getTopbarPills() }, { quota: true, context: true, speed: true, tokens: true, cli: true });
  api.dispose();
});

test('heatmap top-row anti-clipping padding and popover Chinese translations for Prompt, Output, Cache', () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  // 1) Ensure .heat-scroll-box has padding to prevent top cell hover outline clipping
  assert.match(source, /\.heat-scroll-box\s*\{[^}]*padding:\s*6px 6px 4px 6px/);
  assert.match(source, /\.pop-det-trans\s*\{[^}]*font-size:\s*10px/);

  // 2) Trigger daily heatmap cell click
  api.setTokenHistoryForTest({
    firstUseDate: '2026-10-20',
    dailyMap: {
      '2026-10-20': { total: 3594989, input: 738031, output: 52244, cache: 2804714, steps: 63 }
    }
  });
  h.elements.get('badge-tokens').click();
  const colsBox = h.elements.get('h-grid-cols');
  assert.ok(colsBox && colsBox.children.length > 0, 'grid columns should exist');
  const firstCol = colsBox.children[0];
  const firstCell = firstCol.children[0];
  assert.ok(firstCell, 'first cell should exist');

  // Trigger click on firstCell
  firstCell.click();

  const heatPopVal = h.elements.get('heat-pop-val');
  const heatPopDet = h.elements.get('heat-pop-det');
  assert.ok(heatPopVal, 'heatPopVal element exists');
  assert.ok(heatPopDet, 'heatPopDet element exists');

  // Value contains 'Tokens' and appended reference cost
  assert.match(heatPopVal.textContent, /Tokens/);
  assert.match(heatPopVal.textContent, /≈ \$/);

  // Detail section has 3 columns with Chinese translations directly beneath Prompt, Output, Cache
  assert.match(heatPopDet.innerHTML, /Prompt:[\s\S]*?<span class="pop-det-trans">提示词<\/span>/);
  assert.match(heatPopDet.innerHTML, /Output:[\s\S]*?<span class="pop-det-trans">输出<\/span>/);
  assert.match(heatPopDet.innerHTML, /Cache:[\s\S]*?<span class="pop-det-trans">缓存<\/span>/);

  api.dispose();
});

test('default current period API reference amount, independent subscription spend, and reference cost drawer', async () => {
  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 50000, outputTokens: 2000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const mockPayload = {
    updatedAt: '2026-11-08 19:00:00',
    currentPeriod: {
      key: '2026-11',
      label: '2026-11 (自然月)',
      isCurrentMonth: true
    },
    planStatus: {
      status: 'identified',
      tierKey: 'pro',
      tierName: 'Google AI Pro',
      email: 'test@example.com',
      region: '未知',
      regionSource: 'unknown',
      actualPricePaid: null,
      officialPriceMonthly: 19.99,
      priceRangeNote: '$19.99/月（公开参考）',
      priceSource: 'official_reference',
      currency: 'USD',
      billingCycle: '月付（公开参考）'
    },
    costEstimate: {
      pricedCostUSD: 0.05,
      pricedRequestsCount: 2,
      unpricedRequestsCount: 100,
      coveragePercent: 2.0,
      unpricedTokens: 500000,
      unpricedReasons: { missingModel: 100, unsupportedModel: 0, missingUsage: 0 },
      byModel: { 'gemini-3.8-flash': { costUSD: 0.05, tokens: 20000 } }
    },
    costEstimateCurrentMonth: {
      pricedCostUSD: 0.03,
      pricedRequestsCount: 1,
      unpricedRequestsCount: 20,
      coveragePercent: 4.8,
      unpricedTokens: 100000,
      unpricedReasons: { missingModel: 20, unsupportedModel: 0, missingUsage: 0 },
      byModel: { 'gemini-3.8-flash': { costUSD: 0.03, tokens: 10000 } }
    },
    referenceCost: {
      currentMonth: {
        modelKey: 'gemini-3.8-flash',
        totalCostUSD: 69.50,
        inputCostUSD: 18.00,
        inputTokens: 24000000,
        cacheCostUSD: 41.50,
        cacheTokens: 553333333,
        outputCostUSD: 10.00,
        outputTokens: 2666667
      },
      all: {
        modelKey: 'gemini-3.8-flash',
        totalCostUSD: 211.64,
        inputCostUSD: 56.73,
        inputTokens: 75639212,
        cacheCostUSD: 123.58,
        cacheTokens: 1647757871,
        outputCostUSD: 31.33,
        outputTokens: 8354728
      },
      hybrid: {
        modelKey: 'gemini-3.8-flash',
        hybrid: {
          knownCostUSD: 0.05,
          unpricedResidualCostUSD: 211.59,
          combinedTotalUSD: 211.64,
          residualTokensBreakdown: {
            input: 75619212,
            cache: 1647757871,
            output: 8352728
          }
        }
      },
      currentMonthHybrid: {
        modelKey: 'gemini-3.8-flash',
        hybrid: {
          knownCostUSD: 0.03,
          unpricedResidualCostUSD: 69.47,
          combinedTotalUSD: 69.50,
          residualTokensBreakdown: {
            input: 23990000,
            cache: 553333333,
            output: 2666667
          }
        }
      }
    }
  };

  h.sandbox.__AGContextMeter.applyTokenHistoryPayload(mockPayload);
  h.elements.get('badge-tokens').click();
  h.elements.get('tok-view-cost').click();

  // 1) 验证首屏默认并列展示：已记录用量按公开API折算金额（绝不显示为 $0）与用户实际支出
  const titleEl = h.elements.get('cost-card-title');
  const periodTag = h.elements.get('cost-period-tag');
  const grandVal = h.elements.get('cost-grand-val');
  assert.equal(titleEl.textContent, '本期 API 参考金额');
  assert.equal(periodTag.textContent, '2026-11 (自然月)');
  assert.equal(grandVal.textContent, '$69.50');

  // 2) 验证并列展示的订阅支出（严禁回本或节省词汇）
  const subSpendVal = h.elements.get('cost-sub-spend-val');
  const subNote = h.elements.get('cost-sub-compare-note');
  assert.match(subSpendVal.textContent, /实付未知/);
  assert.match(subNote.textContent, /公开参考价 \$19\.99\/月/);

  // 3) 切换为“仅已识别模型”模式：展示已识别记录 $0.03
  h.elements.get('cost-btn-mode-identified').click();
  assert.equal(grandVal.textContent, '$0.03');
  assert.equal(h.elements.get('cost-coverage-pill').textContent, '4.8% 计价覆盖');

  // 4) 切换回“参考模型折算”并切换至“全量历史”
  h.elements.get('cost-btn-mode-ref').click();
  h.elements.get('cost-btn-scope-all').click();
  assert.equal(titleEl.textContent, '全量 API 参考金额');
  assert.equal(grandVal.textContent, '$211.64');
  assert.equal(h.elements.get('cost-diff-summary').textContent, '全量累计');

  // 5) 测试 API 参考视图内聚的极简 USD 实付：设为 $0 免费并同步估值卡片
  h.elements.get('cost-btn-scope-period').click();
  h.elements.get('btn-monthly-spend-free').click();
  await h.flush();
  assert.equal(h.elements.get('p-det-price').textContent, '$0/月');
  assert.equal(h.elements.get('p-det-price-tag').textContent, '免费');
  assert.equal(h.elements.get('cost-sub-spend-val').textContent, '$0');
  assert.match(h.elements.get('cost-sub-compare-note').textContent, /免费权益/);

  // 6) 清除自定义月度实付
  h.elements.get('btn-monthly-spend-clear').click();
  await h.flush();
  assert.equal(h.elements.get('p-det-price-tag').textContent, '公开参考价');
  h.sandbox.__AGContextMeter.dispose();
});

test('integrated verification: legacy payload without referenceCost calculates dynamically, zero-flash prevention, and compact/detail expansion', async () => {
  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 50000, outputTokens: 2000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const todayStr = (new Date()).toISOString().slice(0, 10);
  const legacyPayload = {
    updatedAt: `${todayStr} 12:00:00`,
    dailyMap: {
      [todayStr]: { total: 31000, input: 10000, cache: 20000, output: 1000, steps: 5 }
    },
    // 故意不传 referenceCost，模拟旧版后台
    summary: {
      grandTotalTokens: 31000,
      totalInputTokens: 10000,
      totalCacheTokens: 20000,
      totalOutputTokens: 1000,
      monthTokens: 31000,
      currentMonthInput: 10000,
      currentMonthCache: 20000,
      currentMonthOutput: 1000
    }
  };

  // 1. 验证旧版 payload 能正确动态补齐参考金额，不显示 $0.00，且分类 tokens 完整
  h.sandbox.__AGContextMeter.applyTokenHistoryPayload(legacyPayload);
  h.elements.get('badge-tokens').click();
  h.elements.get('tok-view-cost').click();

  const grandVal = h.elements.get('cost-grand-val');
  assert.notEqual(grandVal.textContent, '$0.00');
  assert.equal(grandVal.textContent, '$0.01');

  // 分类 token 和金额验证
  const inVal = h.elements.get('ref-cost-input-val');
  const inTok = h.elements.get('ref-cost-input-tok');
  assert.equal(inVal.textContent, '$0.01');
  assert.match(inTok.textContent, /10K|1\.0万|10\.0K|10000/);

  // 2. 验证有效数据存在时，传入空 payload 或 loading 状态不会把顶栏和卡片清零（防归零闪烁）
  const badgeAmt = h.elements.get('token-amount');
  assert.equal(badgeAmt.textContent, '31.0K');

  const emptyLoadingPayload = { loading: true, dailyMap: {}, summary: { grandTotalTokens: 0 } };
  h.sandbox.__AGContextMeter.applyTokenHistoryPayload(emptyLoadingPayload);
  assert.equal(badgeAmt.textContent, '31.0K'); // 保持原有效值，严禁变 0！
  assert.equal(grandVal.textContent, '$0.01');

  // 3. 验证 700px 宽屏稳态完整直展、常驻“API折算 · 非实付”及子视图切换零宽度跳变
  const detailsPane = h.elements.get('cost-details-pane');
  const tokensMain = h.elements.get('tokens-main-view');
  const nonPaidBadge = h.elements.get('cost-non-paid-badge');
  const scopeDesc = h.elements.get('cost-scope-desc');
  const pPanel = h.elements.get('panel');

  const costViewLeft = parseInt(pPanel.style.left, 10);
  assert.equal(detailsPane.style.display, 'block');
  assert.equal(tokensMain.style.display, 'none');
  assert.equal(nonPaidBadge.textContent, '参考估值');
  assert.match(scopeDesc.textContent, /全部来源/);
  assert.equal(pPanel.getAttribute('data-wb-wide'), 'true');

  // 4. 切换回 Token 统计视图，热力图恢复且面板锚点与 700px 宽度不产生任何跳变
  h.elements.get('tok-view-tokens').click();
  assert.equal(tokensMain.style.display, 'block');
  assert.equal(parseInt(pPanel.style.left, 10), costViewLeft);
  assert.equal(pPanel.getAttribute('data-wb-wide'), 'true');

  h.sandbox.__AGContextMeter.dispose();
});

test('tray/root startup visibility, minimal USD spend save/fail feedback, detail collapse lifecycle, and CLI launch', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  h.sandbox.location.pathname = '/';
  h.tick();
  assert.equal(h.host.hidden, false);
  assert.equal(h.host.getAttribute('data-has-session'), 'false');
  assert.equal(h.elements.get('badge-pct-val').textContent, '--%');
  assert.equal(api.ensureAlive(), true);

  let shouldFailSave = false;
  h.sandbox.window.contextMeterAPI.saveSettings = async (payload) => {
    if (shouldFailSave) return { ok: false, error: '模拟磁盘只读无法写入' };
    return { ok: true, customPlan: payload.customPlan };
  };

  api.saveMonthlySpendUSD(19.99);
  await h.flush();
  assert.equal(api.getPlanSettings().actualPricePaid, 19.99);
  assert.equal(api.getPlanSettings().currency, 'USD');
  assert.equal(api.getPlanSettings().lastSaveResult.ok, true);

  shouldFailSave = true;
  api.saveMonthlySpendUSD(9.99);
  await h.flush();
  assert.equal(api.getPlanSettings().lastSaveResult.ok, false);
  assert.match(h.elements.get('plan-save-feedback').textContent, /保存失败.*模拟磁盘只读/);
  shouldFailSave = false;

  h.elements.get('badge-tokens').click();
  h.elements.get('h-sum-sub-ratio-wrap').click();
  assert.equal(h.elements.get('cost-estimate-card').style.display, 'block');
  assert.equal(h.elements.get('plan-detail-card').style.display, 'block');

  let cliMockResult = { ok: true, cwd: '/Users/dev/project', cliPath: '/usr/local/bin/agy' };
  h.sandbox.window.contextMeterAPI.launchCli = async (opts) => ({ ...cliMockResult, receivedOpts: opts });
  h.elements.get('badge-cli').click();
  await h.flush();
  assert.equal(api.getLastCliLaunchResult().ok, true);
  assert.match(h.elements.get('cli-launch-toast').textContent, /已启动 Antigravity CLI/);

  cliMockResult = { ok: false, error: '未找到 agy' };
  h.elements.get('badge-cli').click();
  await h.flush();
  assert.equal(api.getLastCliLaunchResult().ok, false);
  assert.match(h.elements.get('cli-launch-toast').textContent, /启动 CLI 失败.*未找到 agy/);

  api.dispose();
});

test('network errors are consistently displayed across badge, tooltip, and key summary without clearing context metrics', async () => {
  const h = harness();
  h.finishScan();

  // 发生网络故障 (idle timeout + context deadline exceeded)
  h.pending[0].resolve(response({
    modelDisplayName: 'Gemini 4 Argon (High)',
    usage: { inputTokens: 538645, outputTokens: 268 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 983040, estimatedTokensUsed: 538913 } },
    retryInfos: [{ error: 'request failed: stream idle timeout (5m0s): context deadline exceeded', usage: { model: 'gemini' } }]
  }));
  await h.flush();

  // 验证三处对齐：
  // 1. 顶部徽章
  assert.equal(h.elements.get('badge-pct-val').textContent, '网络');
  assert.equal(h.elements.get('amount').textContent, '网络故障');

  // 2. 悬停提示气泡
  h.elements.get('badge').trigger('mouseenter');
  assert.equal(h.elements.get('ctx-tip-title').textContent, '网络连接（连接故障）：');
  assert.equal(h.elements.get('ctx-tip-pct').textContent, '网络连接失败或超时');
  assert.match(h.elements.get('ctx-tip-detail').textContent, /超时|网络/);
  assert.doesNotMatch(h.elements.get('ctx-tip-detail').textContent, /未送达服务端/);

  // 3. 核心用量速览卡片
  assert.equal(h.elements.get('key-badge').textContent, '网络故障');
  assert.match(h.elements.get('key-takeaway').textContent, /网络连接出现异常/);
  // 解耦验证：非超限错误保留预算与已有上下文，绝不归零
  assert.equal(h.elements.get('key-limit').textContent, '983K');
  assert.notEqual(h.elements.get('key-used').textContent, '—');
  assert.notEqual(h.elements.get('key-remaining').textContent, '0 (已溢出)');

  h.sandbox.__AGContextMeter.dispose();
});

test('quota exhaustion status across badge, tooltip, and summary displays affected pool and reset time', async () => {
  const h = harness();
  h.finishScan();

  // 明确模型额度耗尽 (周限额耗尽)
  h.pending[0].resolve(response({
    modelDisplayName: 'Gemini 4 Argon (High)',
    usage: { inputTokens: 538645, outputTokens: 268 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 983040, estimatedTokensUsed: 538913 } },
    retryInfos: [{ error: 'rpc error: code = ResourceExhausted desc = Quota exceeded for weekly pool', usage: { model: 'gemini' } }]
  }));
  await h.flush();

  // 验证三处对齐为额度耗尽：
  assert.equal(h.elements.get('badge-pct-val').textContent, '额度耗尽');
  assert.equal(h.elements.get('amount').textContent, '额度耗尽');
  assert.equal(h.elements.get('key-badge').textContent, '额度耗尽');
  assert.match(h.elements.get('key-takeaway').textContent, /额度已耗尽.*可手动切换/);

  h.sandbox.__AGContextMeter.dispose();
});

test('model and conversation switching isolates previous error state and recovers on successful response', async () => {
  const h = harness();

  // 1. 发起成功请求 -> 状态恢复为正常百分比
  h.tick();
  await h.flush();
  const req = h.pending.shift();
  assert.ok(req);
  req.resolve({
    ok: true,
    json: async () => ({
      generatorMetadata: [
        {
          chatModel: {
            modelDisplayName: 'Gemini 3.8 Flash (High)',
            usage: { inputTokens: 40000, outputTokens: 200 },
            chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
          }
        }
      ]
    })
  });
  await h.flush();

  // 验证正常状态
  assert.equal(h.elements.get('badge-pct-val').textContent, '16%');
  assert.match(h.elements.get('amount').textContent, /40\.2K/);
  assert.equal(h.elements.get('key-badge').textContent, '正常');

  // 2. 切换会话后清空旧状态
  h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
  h.tick();
  await h.flush();
  assert.equal(h.elements.get('badge-pct-val').textContent, '--%');
  assert.equal(h.elements.get('amount').textContent, '真实量未知');

  h.sandbox.__AGContextMeter.dispose();
});

test('5 heatmap views switching, segmented pill slider active state, and settings persistence', async () => {
  let savedSettings = null;
  const h = harness();
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    saveSettings: payload => { savedSettings = payload; return { ok: true }; }
  };
  const api = h.sandbox.__AGContextMeter;

  // 默认是 daily 视图
  assert.equal(api.getActiveHeatView(), 'daily');
  assert.equal(h.elements.get('h-tab-daily').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-daily-box').style.display, 'block');

  // 1. 切换至 weekly 视图
  api.switchHeatView('weekly');
  assert.equal(api.getActiveHeatView(), 'weekly');
  assert.equal(h.elements.get('h-tab-weekly').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-tab-daily').getAttribute('aria-selected'), 'false');
  assert.equal(h.elements.get('h-weekly-box').style.display, 'flex');
  assert.equal(h.elements.get('h-daily-box').style.display, 'none');
  assert.equal(savedSettings?.savedHeatView, 'weekly');

  // 2. 切换至 monthly 视图
  api.switchHeatView('monthly');
  assert.equal(api.getActiveHeatView(), 'monthly');
  assert.equal(h.elements.get('h-tab-monthly').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-monthly-box').style.display, 'flex');
  assert.equal(h.elements.get('h-weekly-box').style.display, 'none');
  assert.equal(savedSettings?.savedHeatView, 'monthly');

  // 3. 切换至 yearly 视图
  api.switchHeatView('yearly');
  assert.equal(api.getActiveHeatView(), 'yearly');
  assert.equal(h.elements.get('h-tab-yearly').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-yearly-box').style.display, 'flex');
  assert.equal(h.elements.get('h-monthly-box').style.display, 'none');
  assert.equal(savedSettings?.savedHeatView, 'yearly');

  // 4. 切换至 cum 视图
  api.switchHeatView('cum');
  assert.equal(api.getActiveHeatView(), 'cum');
  assert.equal(h.elements.get('h-tab-cum').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-cum-box').style.display, 'block');
  assert.equal(h.elements.get('h-yearly-box').style.display, 'none');
  assert.equal(savedSettings?.savedHeatView, 'cum');

  // 5. 切换回 daily
  api.switchHeatView('daily');
  assert.equal(api.getActiveHeatView(), 'daily');
  assert.equal(h.elements.get('h-tab-daily').getAttribute('aria-selected'), 'true');
  assert.equal(h.elements.get('h-daily-box').style.display, 'block');
  assert.equal(savedSettings?.savedHeatView, 'daily');

  api.dispose();
});

test('monthly view layout algorithm: 28/29/30/31 days across multiple viewport WxH, square cells and no overflow', () => {
  function calculateBestGrid(days, W, H, gap = 5) {
    let bestR = 1, bestC = days, bestS = 0;
    for (let r = 1; r <= 7; r++) {
      const c = Math.ceil(days / r);
      const s = Math.min((W - (c - 1) * gap) / c, (H - (r - 1) * gap) / r);
      if (s > bestS) {
        bestS = s;
        bestR = r;
        bestC = c;
      }
    }
    const s = Math.floor(bestS);
    const totalW = bestC * s + (bestC - 1) * gap;
    const totalH = bestR * s + (bestR - 1) * gap;
    return { r: bestR, c: bestC, s, totalW, totalH, days };
  }

  const testDimensions = [
    { W: 670, H: 95 },
    { W: 500, H: 90 },
    { W: 800, H: 110 },
    { W: 400, H: 80 }
  ];
  const testMonthDays = [28, 29, 30, 31];

  for (const { W, H } of testDimensions) {
    for (const days of testMonthDays) {
      const res = calculateBestGrid(days, W, H);
      assert.ok(res.s > 0, `Cell size should be positive for days=${days}, W=${W}, H=${H}`);
      assert.ok(res.c * res.r >= days, `Grid capacity (${res.c}x${res.r}) must fit ${days} days`);
      assert.ok(res.totalW <= W, `Grid total width (${res.totalW}) exceeded container width (${W})`);
      assert.ok(res.totalH <= H, `Grid total height (${res.totalH}) exceeded container height (${H})`);
      if (W === 670 && H === 95) {
        assert.ok(res.s >= 18, `For 670x95, cell size ${res.s} should be >= 18px`);
      }
    }
  }
});

test('yearly view bubble chart: area proportional to tokens (sqrt mapping), future exclusion, and peak badge', () => {
  const Rmin = 6;
  const Rmax = 24;
  const maxTokens = 1000000;

  function computeRadius(tokens, isFuture) {
    if (isFuture || tokens <= 0) return Rmin;
    const ratio = Math.sqrt(tokens / maxTokens);
    return Rmin + ratio * (Rmax - Rmin);
  }

  assert.equal(computeRadius(0, false), Rmin);
  assert.equal(computeRadius(maxTokens, false), Rmax);
  const r25 = computeRadius(250000, false);
  assert.equal(r25, Rmin + 0.5 * (Rmax - Rmin));
  const rRatio = (computeRadius(40000, false) - Rmin) / (computeRadius(10000, false) - Rmin);
  assert.ok(Math.abs(rRatio - 2) < 1e-9, 'Radius expansion should be square-root mapped');
  assert.equal(computeRadius(500000, true), Rmin);
});

test('all-period reference cost and source switching reactivity on cards & popovers', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  const payload = {
    schemaVersion: '0.8.0',
    version: '0.8.0',
    summary: { grandTotalTokens: 500000, todayTokens: 100000, monthTokens: 300000, yearTokens: 500000, totalConversations: 5 },
    dailyMap: {
      '2026-11-09': { input: 80000, cache: 10000, output: 10000, total: 100000 },
      '2026-11-10': { input: 80000, cache: 10000, output: 10000, total: 100000 }
    },
    dailyMapBySource: {
      all: {
        '2026-11-09': { input: 80000, cache: 10000, output: 10000, total: 100000 },
        '2026-11-10': { input: 80000, cache: 10000, output: 10000, total: 100000 }
      },
      desktop: {
        '2026-11-09': { input: 40000, cache: 5000, output: 5000, total: 50000 },
        '2026-11-10': { input: 40000, cache: 5000, output: 5000, total: 50000 }
      },
      cli: {
        '2026-11-09': { input: 40000, cache: 5000, output: 5000, total: 50000 },
        '2026-11-10': { input: 40000, cache: 5000, output: 5000, total: 50000 }
      }
    }
  };

  api.applyTokenHistoryPayload(payload);

  const tTotalCost = h.elements.get('t-total-cost');
  assert.ok(tTotalCost, 'Total cost element exists');
  assert.match(tTotalCost.textContent, /≈ \$/);
  assert.match(tTotalCost.textContent, /日均/);

  h.elements.get('src-tab-desktop').click();
  assert.match(tTotalCost.textContent, /≈ \$/);

  api.dispose();
});

test('Settings view omits defensive footer banners, external GitHub links, and online update checkers', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  assert.equal(api.openGithubRepo, undefined);

  const tplHtml = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  assert.equal(tplHtml.includes('id="safe-runtime-card"'), false);
  assert.equal(tplHtml.includes('id="btn-github-repo-ctx"'), false);
  assert.equal(tplHtml.includes('id="btn-github-repo"'), false);
  assert.equal(tplHtml.includes('id="update-popover"'), false);
  assert.equal(tplHtml.includes('id="btn-check-update"'), false);

  api.dispose();
});

test('只读模型规格分页与外观配置视图：模型列表直展、元数据推导、实测预算与返回导航', async () => {
  const savedPayloads = [];
  const h = harness();
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getSettings: async () => ({ ok: true }),
    saveSettings: async (payload) => {
      savedPayloads.push(payload);
      return { ok: true };
    },
    getModulesStatus: async () => ({
      ok: true,
      runtime: { edition: 'safe-readonly' }
    })
  };

  h.elements.get('badge').click();
  await h.flush();
  const api = h.sandbox.__AGContextMeter;
  api.setContextLatestForTest({
    model: 'Gemini 4 Argon (Low)',
    modelId: 'gemini-4-argon-low',
    status: 'reported',
    used: 42000,
    budget: 256000,
    serviceLimit: 1000000,
    remaining: 214000,
    speed: { tps: 88.5, durationSec: 2.0, ttftSec: 0.4, outputTokens: 177 }
  }, [
    { modelId: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)', maxTokens: 1048576, maxOutputTokens: 65536 },
    { modelId: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', maxTokens: 200000, maxOutputTokens: 64000 }
  ]);
  await h.flush();

  assert.equal(h.elements.get('pane-ctx-session').hidden, false);
  assert.equal(h.elements.get('pane-ctx-models').hidden, true);
  assert.equal(h.elements.get('pane-ctx-speed').hidden, true);
  assert.equal(h.elements.get('speed-val').textContent, '88.5 tok/s');

  // 切换到“模型规格”分页：工具栏与列表默认可见，只读展示模型容量与实测预算
  h.elements.get('tab-ctx-models').click();
  await h.flush();
  assert.equal(h.elements.get('pane-ctx-models').hidden, false);
  assert.equal(h.elements.get('pane-ctx-session').hidden, true);
  assert.equal(h.elements.get('ctx-model-list').hidden, false);
  assert.match(h.elements.get('ctx-cap-window').textContent, /1,048,576 tokens/);
  assert.match(h.elements.get('ctx-cap-output').textContent, /65,536 tokens/);
  assert.match(h.elements.get('ctx-cap-model-max').textContent, /983,040 tokens/);
  assert.match(h.elements.get('ctx-card-observed-budget').textContent, /256K/);
  assert.match(h.elements.get('ctx-card-service-limit').textContent, /1M/);

  const selectEl = h.elements.get('ctx-model-select');
  selectEl.value = 'product:anthropic:claude-sonnet-4.6';
  selectEl.trigger('change', { target: { value: 'product:anthropic:claude-sonnet-4.6' } });
  await h.flush();
  assert.equal(savedPayloads.length, 0, '切换查看模型不得产生任何写配置操作');
  assert.match(h.elements.get('ctx-cap-window').textContent, /200,000 tokens/);

  // 打开全局设置视图，验证一级 Tab 栏收起、色板与安全说明存在且可一键返回原业务分页
  h.elements.get('btn-ctx-settings').click();
  await h.flush();
  assert.equal(h.elements.get('pane-ctx-settings').hidden, false);
  assert.equal(h.elements.get('ctx-tabs-bar').hidden, true);
  assert.ok(h.elements.get('preset-btn-violet'));
  assert.ok(h.elements.get('chk-pill-quota'));
  assert.equal(h.elements.get('btn-ctx-settings').getAttribute('aria-pressed'), 'true');
  h.elements.get('btn-ctx-settings-back').click();
  assert.equal(h.elements.get('pane-ctx-settings').hidden, true);
  assert.equal(h.elements.get('ctx-tabs-bar').hidden, false);
  assert.equal(h.elements.get('pane-ctx-models').hidden, false);

  const tplHtml = fs.readFileSync(require('node:path').join(__dirname, 'src', 'renderer', 'template.html'), 'utf8');
  assert.equal(tplHtml.includes('id="appearance-presets-card"'), true);
  assert.equal(tplHtml.includes('id="topbar-pills-card"'), true);
  assert.equal(tplHtml.includes('id="safe-runtime-card"'), false);
  assert.equal(tplHtml.includes('id="proxy-notun-drawer"'), false);
  assert.equal(tplHtml.includes('id="ctx-adjust-box"'), false);
  assert.equal(tplHtml.includes('id="quota-accounts-section"'), false);
  assert.equal(tplHtml.includes('id="btn-client-lang-zh-CN"'), false);

  api.dispose();
});

test('速度对比分页：零网络请求与零 IPC 发送，正确绘制柱状图/折线图并标注样本少', async () => {
  const h = harness();
  h.finishScan();
  await h.flush();
  const api = h.sandbox.__AGContextMeter;

  h.elements.get('badge-speed').click();
  await h.flush();
  // harness 默认 replaceChildren 不保留子节点，此处启用以检查 SVG 绘制元素
  h.elements.get('speed-bar-svg').replaceChildren = function(...nodes) { this.children = nodes; };
  h.elements.get('speed-line-svg').replaceChildren = function(...nodes) { this.children = nodes; };

  const fetchBefore = h.pending.length;
  const scansBefore = h.scans.length;

  const now = Date.now();
  api.setSpeedRecordsForTest([
    { callId: 'c1', modelExactId: 'gemini-4-argon-low', modelLabel: 'Gemini 4 Argon (Low)', status: 'final', outputTokens: 120, durationSec: 2, tps: 60, ttftSec: 0.5, timestamp: now - 5000 },
    { callId: 'c2', modelExactId: 'gemini-4-argon-low', modelLabel: 'Gemini 4 Argon (Low)', status: 'final', outputTokens: 200, durationSec: 2, tps: 100, ttftSec: 0.7, timestamp: now - 3000 },
    { callId: 'c3', modelExactId: 'claude-sonnet-4-6', modelLabel: 'Claude Sonnet 4.6', status: 'final', outputTokens: 160, durationSec: 2, tps: 80, ttftSec: 0.9, timestamp: now - 4000 },
    { callId: 'c4', modelExactId: 'claude-sonnet-4-6', modelLabel: 'Claude Sonnet 4.6', status: 'final', outputTokens: 180, durationSec: 2, tps: 90, ttftSec: 1.0, timestamp: now - 2000 },
    { callId: 'c5', modelExactId: 'claude-sonnet-4-6', modelLabel: 'Claude Sonnet 4.6', status: 'final', outputTokens: 200, durationSec: 2, tps: 100, ttftSec: 1.1, timestamp: now - 1000 }
  ]);
  // 再切换到其他专属浮层切回“生成速度”，确认打开页面不触发网络请求与 IPC
  h.elements.get('badge').click();
  h.elements.get('badge-speed').click();
  await h.flush();

  assert.equal(h.pending.length, fetchBefore, '打开速度对比页不得发起任何 fetch 请求');
  assert.equal(h.scans.length, scansBefore, '打开速度对比页不得发起任何 scan/IPC');
  assert.equal(h.elements.get('speed-bar-empty').hidden, true);
  assert.equal(h.elements.get('speed-line-empty').hidden, true);

  const collectNodeTexts = (node) => {
    if (!node) return [];
    const arr = [];
    if (node.textContent) arr.push(node.textContent);
    if (Array.isArray(node.children)) {
      for (const ch of node.children) arr.push(...collectNodeTexts(ch));
    }
    return arr;
  };
  const barTexts = collectNodeTexts(h.elements.get('speed-bar-svg')).join(' | ');
  assert.match(barTexts, /样本少/);
  assert.ok(h.elements.get('speed-line-svg').children.length > 0, '折线图 SVG 应生成绘制节点');

  // 切换指标到首字延迟
  h.elements.get('speed-metric-ttft').click();
  assert.equal(h.elements.get('speed-bar-title').textContent, '首字延迟对比');

  // 单图表卡模式切换：默认模型对比，切换单模型趋势后双 SVG 数据保持就绪
  assert.equal(h.elements.get('speed-chart-pane-bar').hidden, false);
  assert.equal(h.elements.get('speed-chart-pane-line').hidden, true);
  h.elements.get('speed-view-mode-line').click();
  assert.equal(h.elements.get('speed-chart-pane-bar').hidden, true);
  assert.equal(h.elements.get('speed-chart-pane-line').hidden, false);
  assert.ok(h.elements.get('speed-bar-svg').children.length > 0);
  assert.ok(h.elements.get('speed-line-svg').children.length > 0);
  h.elements.get('speed-view-mode-bar').click();
  assert.equal(h.elements.get('speed-chart-pane-bar').hidden, false);
  assert.equal(h.elements.get('speed-chart-pane-line').hidden, true);

  api.dispose();
});

test('插件面板三语言切换、持久化、动态文案与模型名称保留（不介入客户端界面语言）', async () => {
  let savedSettingsPayload = null;
  let storedSettings = {};
  let restartCalls = 0;

  const h = harness();
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    getSettings: async () => ({ ok: true, ...storedSettings }),
    saveSettings: async (payload) => {
      savedSettingsPayload = payload;
      storedSettings = {
        ...storedSettings,
        panelLanguage: payload.panelLanguage,
        uiPreferences: { ...(storedSettings.uiPreferences || {}), ...(payload.uiPreferences || {}) }
      };
      return { ok: true, ...storedSettings };
    },
    restartHost: async () => {
      restartCalls += 1;
      return { ok: true, supported: true };
    }
  };
  h.finishScan();
  await h.flush();
  const api = h.sandbox.__AGContextMeter;
  await api.restoreSettingsForTest();

  // 1. 默认保持简体中文 (zh-CN)
  assert.equal(api.getPanelLanguage(), 'zh-CN');
  assert.equal(api.translateForTest('tab.session'), '当前会话');
  assert.equal(api.translateForTest('tab.models'), '模型规格');
  assert.equal(api.translateForTest('tab.speed'), '速度对比');
  assert.equal(api.translateForTest('tab.settings'), '外观配置');
  assert.equal(h.elements.get('status').textContent, '请求用量与会话累计分别统计；会话 token 数始终为本地估算。');

  h.elements.get('badge').click();
  h.elements.get('btn-ctx-settings').click();
  await h.flush();
  assert.ok(h.elements.get('btn-panel-lang-zh-CN'), '面板应提供简体中文按钮');
  assert.ok(h.elements.get('btn-panel-lang-zh-TW'), '面板应提供繁體中文按钮');
  assert.ok(h.elements.get('btn-panel-lang-en'), '面板应提供 English 按钮');

  api.setContextLatestForTest({
    model: 'Gemini 3.1 Pro (High)',
    modelId: 'MODEL_PLACEHOLDER_M26',
    status: 'reported',
    used: 120000,
    budget: 512000,
    speed: { tps: 45, duration: 2.0, ttft: 0.4, streamingSec: 1.6, outputTokens: 90 }
  });
  await h.flush();

  // 2. 切换为繁體中文 -> 立即更新静态+动态文案，不触发重启
  h.elements.get('btn-panel-lang-zh-TW').click();
  await h.flush();
  assert.equal(api.getPanelLanguage(), 'zh-TW');
  assert.equal(api.translateForTest('tab.session'), '目前工作階段');
  assert.equal(api.translateForTest('tab.models'), '模型規格');
  assert.equal(api.translateForTest('tab.speed'), '速度對比');
  assert.equal(h.elements.get('panel-lang-save-badge').textContent, '已切換並儲存');
  assert.equal(savedSettingsPayload.panelLanguage, 'zh-TW');
  assert.equal(restartCalls, 0, '切换面板语言不得触发重启');
  assert.equal(h.elements.get('model').textContent, 'Gemini 3.1 Pro (High)', '模型正式名称应保持原样不被翻译');
  assert.equal(h.elements.get('speed-badge').textContent, '82.7 分 · A');
  assert.match(h.elements.get('speed-sub-label').textContent, /流式 56\.3 tok\/s/);

  const mockStaticNode = {
    getAttribute: (k) => (k === 'data-i18n' ? 'tab.session' : null),
    textContent: ''
  };
  api.applyStaticTranslationsForTest({
    querySelectorAll: (sel) => (sel === '[data-i18n]' ? [mockStaticNode] : [])
  });
  assert.equal(mockStaticNode.textContent, '目前工作階段');

  // 3. 切换为 English -> 验证静态标签、动态状态、模型名称原样保留
  h.elements.get('btn-panel-lang-en').click();
  await h.flush();
  assert.equal(api.getPanelLanguage(), 'en');
  assert.equal(api.translateForTest('tab.session'), 'Session');
  assert.equal(api.translateForTest('tab.models'), 'Model Specs');
  assert.equal(api.translateForTest('tab.speed'), 'Speed');
  assert.equal(api.translateForTest('tab.settings'), 'Appearance');
  assert.equal(h.elements.get('speed-bar-title').textContent, 'Output Speed Comparison');
  assert.equal(h.elements.get('panel-lang-save-badge').textContent, api.translateForTest('settings.panelLang.saved'));
  assert.equal(h.elements.get('model').textContent, 'Gemini 3.1 Pro (High)', '切换为 English 后模型正式名称应保持原样');
  assert.equal(h.elements.get('speed-badge').textContent, '82.7 pts · A');
  assert.match(h.elements.get('speed-sub-label').textContent, /Stream 56\.3 tok\/s/);
  assert.doesNotMatch(h.elements.get('speed-takeaway').textContent, /[\u4e00-\u9fa5]/, '英文模式速度评语不得夹带中文');

  // 4. 模拟重启恢复：重新挂载并从 getSettings 恢复为 en
  api.dispose();
  const h2 = harness();
  h2.sandbox.window.contextMeterAPI = {
    ...h2.sandbox.window.contextMeterAPI,
    getSettings: async () => ({ ok: true, ...storedSettings })
  };
  await h2.sandbox.__AGContextMeter.restoreSettingsForTest();
  await h2.flush();
  assert.equal(h2.sandbox.__AGContextMeter.getPanelLanguage(), 'en');
  assert.equal(h2.elements.get('status').textContent, 'Request usage and cumulative session totals are tracked separately; session totals are local estimates.');
  h2.sandbox.__AGContextMeter.dispose();
});

// --- PR #9 实时同步与队列测试 ---
const path = require('node:path');

test('real-time token history refresh: idle dedup, recordCalls ordering, a 5s automatic scan interval, and busy coalescing', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  // Drain initial boot scan & initial requestPoll microtasks first
  h.finishScan(0);
  await flushAsync();

  const events = [];
  let recordCallsDeferred = null;
  const historyDeferredQueue = [];
  let autoResolveHistory = true;

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const ids = calls.map(c => c.callId).join(',');
      events.push(`recordCalls:${ids}`);
      if (recordCallsDeferred) {
        const p = recordCallsDeferred.promise;
        recordCallsDeferred = null;
        return p;
      }
      return Promise.resolve({ ok: true, changed: false });
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      if (!autoResolveHistory) {
        return new Promise(resolve => {
          historyDeferredQueue.push({ force: Boolean(force), resolve });
        });
      }
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 12:30:00',
          summary: { grandTotalTokens: 40000, todayTokens: 4000 },
          dailyMap: { '2026-11-12': { total: 4000, input: 3000, cache: 500, output: 500, steps: 1 } }
        }
      });
    }
  };

  try {
    // (a) Initial hydration poll resolves a final row (changed: false) -> recorded once, then repeated idle 3s polls do NOT re-invoke recordCalls or getTokenHistory
    const idleRow = {
      stepIndices: [2],
      chatModel: {
        modelDisplayName: 'Gemini 3.8 Flash (High)',
        responseModel: 'gemini-3.8-flash',
        usage: { inputTokens: 10000, cacheReadTokens: 2000, outputTokens: 500, responseId: 'resp-idle-1' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
      }
    };
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-idle-1']);

    events.length = 0;
    // Idle 3s poll #2 with identical final row
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 2);
    h.pending[1].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Idle poll #2 with unchanged final row must not call recordCalls or getTokenHistory');

    // Idle 3s poll #3 with identical final row
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 3);
    h.pending[2].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Idle poll #3 with unchanged final row must not call recordCalls or getTokenHistory');

    // (b) Streaming row does not trigger recordCalls/getTokenHistory; newly-final transition awaits recordCalls strictly BEFORE getTokenHistory(true)
    const streamingRow = {
      isStreaming: true,
      status: 'streaming',
      stepIndices: [5],
      chatModel: {
        modelDisplayName: 'Gemini 3.8 Flash (High)',
        usage: { inputTokens: 12000, outputTokens: 120, responseId: 'resp-live-2' }
      }
    };
    fakeNow += 3500;
    h.tick();
    h.pending[3].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow, streamingRow] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'In-flight streaming row must not trigger final ledger write or token history rescan');

    let resolveRecord;
    recordCallsDeferred = {
      promise: new Promise(r => { resolveRecord = r; })
    };
    const finalRow2 = {
      stepIndices: [5],
      chatModel: {
        modelDisplayName: 'Gemini 3.8 Flash (High)',
        responseModel: 'gemini-3.8-flash',
        timeToFirstToken: '1.2s',
        streamingDuration: '2.0s',
        usage: { inputTokens: 12000, cacheReadTokens: 4000, outputTokens: 600, responseId: 'resp-live-2' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
      }
    };
    fakeNow += 3500;
    h.tick();
    h.pending[4].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow, finalRow2] }) });
    await flushAsync();

    // Context badge updates immediately without blocking on recordCalls, while getTokenHistory(true) waits for recordCalls!
    assert.equal(api.snapshot().latest.actual, 16600);
    assert.deepEqual(events, ['recordCalls:resp-live-2'], 'getTokenHistory must NOT fire before recordCalls resolves');

    events.push('resolvingRecordCalls');
    resolveRecord({ ok: true, changed: true });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp-live-2',
      'resolvingRecordCalls',
      'getTokenHistory:true'
    ], 'getTokenHistory(true) must fire strictly after recordCalls resolves');

    // Usage progression on an already-final row triggers once, then stabilizes
    events.length = 0;
    const calibratedRow2 = {
      ...finalRow2,
      chatModel: {
        ...finalRow2.chatModel,
        usage: { inputTokens: 12000, cacheReadTokens: 4000, outputTokens: 950, responseId: 'resp-live-2' }
      }
    };
    fakeNow += 3500;
    h.tick();
    h.pending[5].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow, calibratedRow2] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-live-2'], 'Ledger writes should proceed during the scan cooldown');

    fakeNow += 1499;
    h.tick();
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-live-2'], 'No automatic scan before five seconds');

    fakeNow += 1;
    h.tick();
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-live-2', 'getTokenHistory:true']);

    events.length = 0;
    fakeNow += 2000;
    h.tick();
    h.pending[6].resolve({ ok: true, json: async () => ({ generatorMetadata: [idleRow, calibratedRow2] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Calibrated final row must not re-trigger on subsequent idle poll');

    // (c) Concurrent syncTokenHistoryFromHost requests while historySyncBusy coalesce into at most ONE trailing getTokenHistory(true)
    events.length = 0;
    autoResolveHistory = false;

    void api.syncTokenHistoryFromHost(false);
    await flushAsync();
    assert.equal(historyDeferredQueue.length, 1);
    assert.equal(historyDeferredQueue[0].force, false);
    assert.deepEqual(events, ['getTokenHistory:false']);

    // Fire 5 overlapping refresh requests (including opening #panel-tokens and explicit force=true calls) while busy
    void api.syncTokenHistoryFromHost(false);
    h.elements.get('badge-tokens').click(); // showPanel('tokens') -> syncTokenHistoryFromHost(true)
    void api.syncTokenHistoryFromHost(true);
    void api.syncTokenHistoryFromHost(true);
    void api.syncTokenHistoryFromHost(false);
    await flushAsync();

    assert.equal(historyDeferredQueue.length, 1, 'No parallel getTokenHistory calls while historySyncBusy is true');
    assert.deepEqual(events, ['getTokenHistory:false']);

    // Resolve the in-flight sync -> must launch AT MOST ONE trailing sync, upgraded to force=true
    historyDeferredQueue[0].resolve({
      ok: true,
      data: {
        updatedAt: '2026-11-12 12:31:00',
        summary: { grandTotalTokens: 50000, todayTokens: 5000 },
        dailyMap: { '2026-11-12': { total: 5000, input: 4000, cache: 500, output: 500, steps: 2 } }
      }
    });
    await flushAsync();

    assert.equal(historyDeferredQueue.length, 2, 'Exactly one trailing getTokenHistory call must start');
    assert.equal(historyDeferredQueue[1].force, true, 'Trailing coalesced call must preserve force=true');
    assert.deepEqual(events, ['getTokenHistory:false', 'getTokenHistory:true']);

    // Resolve the trailing sync -> must settle cleanly with zero extra calls and render latest payload
    historyDeferredQueue[1].resolve({
      ok: true,
      data: {
        updatedAt: '2026-11-12 12:31:05',
        summary: { grandTotalTokens: 88000, todayTokens: 8000 },
        dailyMap: { '2026-11-12': { total: 8000, input: 6000, cache: 1000, output: 1000, steps: 3 } }
      }
    });
    await flushAsync();

    assert.equal(historyDeferredQueue.length, 2, 'No extra trailing syncs after coalesced sync finishes');
    assert.equal(h.elements.get('token-amount').textContent, '88.0K');

    // Also verify non-forced requests arriving while busy coalesce into ONE trailing getTokenHistory(false)
    events.length = 0;
    historyDeferredQueue.length = 0;
    void api.syncTokenHistoryFromHost(true);
    await flushAsync();
    assert.equal(historyDeferredQueue.length, 1);
    assert.equal(historyDeferredQueue[0].force, true);
    void api.syncTokenHistoryFromHost(false);
    void api.syncTokenHistoryFromHost(false);
    await flushAsync();
    historyDeferredQueue[0].resolve({
      ok: true,
      data: { updatedAt: '2026-11-12 12:31:10', summary: { grandTotalTokens: 88000, todayTokens: 8000 }, dailyMap: {} }
    });
    await flushAsync();
    assert.equal(historyDeferredQueue.length, 2);
    assert.equal(historyDeferredQueue[1].force, false, 'Non-forced pending syncs keep nextForce=false');
    historyDeferredQueue[1].resolve({
      ok: true,
      data: { updatedAt: '2026-11-12 12:31:12', summary: { grandTotalTokens: 88000, todayTokens: 8000 }, dailyMap: {} }
    });
    await flushAsync();
    assert.deepEqual(events, ['getTokenHistory:true', 'getTokenHistory:false']);

    // Verify 15s polling fallback still works when >15000ms elapses
    events.length = 0;
    autoResolveHistory = true;
    fakeNow += 16000;
    h.tick();
    await flushAsync();
    assert.deepEqual(events, ['getTokenHistory:false']);
  } finally {
    api.dispose();
  }
});

test('requestPoll retries recordCalls on next 3s poll after failure or rejection and commits only on ok:true', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  let attempt = 0;
  const origWarn = console.warn;
  console.warn = () => {};

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      attempt++;
      const ids = calls.map(c => c.callId).join(',');
      events.push(`recordCalls#${attempt}:${ids}`);
      if (attempt === 1) {
        return Promise.resolve({ ok: false, error: 'write failed' });
      }
      if (attempt === 2) {
        return Promise.reject(new Error('IPC channel busy'));
      }
      return Promise.resolve({ ok: true, changed: true });
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 14:25:00',
          summary: { grandTotalTokens: 64000, todayTokens: 14000 },
          dailyMap: { '2026-11-12': { total: 14000, input: 10000, cache: 3000, output: 1000, steps: 1 } }
        }
      });
    }
  };

  const finalRow = {
    stepIndices: [3],
    chatModel: {
      modelDisplayName: 'Gemini 4 Carbon (High)',
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 10000, cacheReadTokens: 3000, outputTokens: 1000, responseId: 'resp-retry-1' },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  };

  try {
    // Poll 1: recordCalls returns { ok: false, error: 'write failed' } -> must NOT commit or call getTokenHistory(true)
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [finalRow] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls#1:resp-retry-1'], 'Failed recordCalls (ok:false) must not trigger getTokenHistory(true)');

    // Poll 2 (next 3s tick): identical finalRow -> retried (#2), rejects -> must NOT commit or call getTokenHistory(true)
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 2);
    h.pending[1].resolve({ ok: true, json: async () => ({ generatorMetadata: [finalRow] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls#2:resp-retry-1'], 'Rejected recordCalls must not trigger getTokenHistory(true) and must stay retryable');

    // Poll 3 (next 3s tick): identical finalRow -> retried (#3), succeeds ({ ok: true, changed: true }) -> commits & triggers getTokenHistory(true)
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 3);
    h.pending[2].resolve({ ok: true, json: async () => ({ generatorMetadata: [finalRow] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls#3:resp-retry-1', 'getTokenHistory:true'], 'Successful retry must trigger getTokenHistory(true)');
    assert.equal(h.elements.get('token-amount').textContent, '64.0K');

    // Poll 4 (next 3s tick): identical finalRow -> already committed in syncedFinalMap, zero further recordCalls attempts!
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 4);
    h.pending[3].resolve({ ok: true, json: async () => ({ generatorMetadata: [finalRow] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Once recordCalls succeeds, subsequent idle polls must not re-send');
  } finally {
    console.warn = origWarn;
    api.dispose();
  }
});

test('pendingFinalCalls retains 5-row batch across offset=2 sliding window, retries via tick() without RPC rows, and re-flushes in-flight progressions', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const makeRow = (id, stepIdx, outTokens = 400) => ({
    stepIndices: [stepIdx],
    chatModel: {
      modelDisplayName: 'Gemini 4 Carbon (High)',
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 8000 + stepIdx * 100, cacheReadTokens: 2000, outputTokens: outTokens, responseId: id },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  });

  const events = [];
  const savedLedger = new Map();
  let recordBehavior = () => Promise.resolve({ ok: true, changed: true });
  const origWarn = console.warn;
  console.warn = () => {};

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const summary = calls.map(c => `${c.callId}:${c.outputTokens}`).join(',');
      events.push(`recordCalls:${summary}`);
      return recordBehavior(calls);
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 15:00:00',
          summary: { grandTotalTokens: 95000, todayTokens: 25000 },
          dailyMap: { '2026-11-12': { total: 25000, input: 18000, cache: 5000, output: 2000, steps: 5 } }
        }
      });
    }
  };

  try {
    // Part 1: Direct 5-row sliding-window failure (Poll 1 offset=0 -> Poll 2 +3.5s offset=2 with call_3..call_5 -> Poll 3 makes 0 recordCalls)
    const rowsA = [1, 2, 3, 4, 5].map(n => makeRow(`call_${n}`, n, 300));
    assert.equal(JSON.parse(h.pending[0].options.body).generatorMetadataOffset, 0);

    recordBehavior = () => Promise.resolve({ ok: false, error: 'disk write failed' });
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: rowsA }) });
    await flushAsync();

    assert.equal(api.snapshot().count, 5);
    assert.deepEqual(events, [
      'recordCalls:call_1:300,call_2:300,call_3:300,call_4:300,call_5:300'
    ], 'Poll 1 attempts all 5 calls and does not call getTokenHistory on failure');

    // Poll 2 (+3.5s): offset slides to Math.max(0, 5 - 3) = 2, returning ONLY call_3..call_5
    events.length = 0;
    recordBehavior = calls => {
      for (const c of calls) savedLedger.set(c.callId, c);
      return Promise.resolve({ ok: true, changed: true });
    };
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 2);
    assert.equal(JSON.parse(h.pending[1].options.body).generatorMetadataOffset, 2);
    h.pending[1].resolve({ ok: true, json: async () => ({ generatorMetadata: rowsA.slice(2) }) });
    await flushAsync();

    assert.deepEqual(events, [
      'recordCalls:call_1:300,call_2:300,call_3:300,call_4:300,call_5:300',
      'getTokenHistory:true'
    ], 'Retry must retain call_1 and call_2 despite offset=2 returning only call_3..call_5');
    assert.deepEqual(Array.from(savedLedger.keys()), ['call_1', 'call_2', 'call_3', 'call_4', 'call_5']);

    // Poll 3 (+3.5s): offset=2 returning call_3..call_5 -> 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    assert.equal(h.pending.length, 3);
    h.pending[2].resolve({ ok: true, json: async () => ({ generatorMetadata: rowsA.slice(2) }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Poll 3 must make 0 recordCalls after all 5 calls were saved');

    // Part 2: Sliding window + tick() retry when RPC is NOT polled yet AND after RPC returns []
    savedLedger.clear();
    h.sandbox.location.pathname = '/c/33333333-3333-3333-3333-333333333333';
    h.tick();
    h.finishScan(1);
    await flushAsync();
    events.length = 0;

    const rowsB = [1, 2, 3, 4, 5].map(n => makeRow(`b_${n}`, n, 250));
    const pollB1Idx = h.pending.length - 1;
    assert.equal(JSON.parse(h.pending[pollB1Idx].options.body).generatorMetadataOffset, 0);

    let resolveSlowFail;
    recordBehavior = () => new Promise(r => { resolveSlowFail = r; });
    h.pending[pollB1Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: rowsB }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:b_1:250,b_2:250,b_3:250,b_4:250,b_5:250']);

    // Slow failure finishes at +1000ms -> requestNext is +3000ms while nextFlushRetryAt is +4000ms
    events.length = 0;
    fakeNow += 1000;
    resolveSlowFail({ ok: false, error: 'ipc timeout' });
    await flushAsync();

    // At +3200ms: Poll 2 (offset=2) runs and returns ONLY b_3..b_5 BEFORE nextFlushRetryAt (+4000ms)
    fakeNow += 2200;
    h.tick();
    const pollB2Idx = h.pending.length - 1;
    assert.equal(JSON.parse(h.pending[pollB2Idx].options.body).generatorMetadataOffset, 2);
    h.pending[pollB2Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: rowsB.slice(2) }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Retry waits until nextFlushRetryAt backoff expires');

    // At +4100ms: tick() runs WITHOUT any new RPC poll (requestNext is +6200ms) -> retries all 5!
    const pendingBeforeTickRetry = h.pending.length;
    recordBehavior = () => Promise.reject(new Error('still busy'));
    fakeNow += 900;
    h.tick();
    await flushAsync();
    assert.equal(h.pending.length, pendingBeforeTickRetry, 'No RPC poll needed for tick() retry');
    assert.deepEqual(events, ['recordCalls:b_1:250,b_2:250,b_3:250,b_4:250,b_5:250']);

    // At +6500ms: Poll 3 runs and RPC returns empty [] -> pendingFinalCalls must still keep b_1..b_5!
    events.length = 0;
    fakeNow += 2400;
    h.tick();
    const pollB3Idx = h.pending.length - 1;
    h.pending[pollB3Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: [] }) });
    await flushAsync();
    assert.equal(api.snapshot().count, 0);
    assert.deepEqual(events, []);

    // At +7200ms: tick() retries again WITHOUT RPC returning any rows -> succeeds & saves all 5!
    recordBehavior = calls => {
      for (const c of calls) savedLedger.set(c.callId, c);
      return Promise.resolve({ ok: true, changed: true });
    };
    const pendingBeforeEmptyRecovery = h.pending.length;
    fakeNow += 700;
    h.tick();
    await flushAsync();
    assert.equal(h.pending.length, pendingBeforeEmptyRecovery);
    assert.deepEqual(events, [
      'recordCalls:b_1:250,b_2:250,b_3:250,b_4:250,b_5:250',
      'getTokenHistory:true'
    ], 'All 5 pending calls survive RPC [] and commit via tick() retry');
    assert.deepEqual(Array.from(savedLedger.keys()), ['b_1', 'b_2', 'b_3', 'b_4', 'b_5']);

    // Part 3: If a call progresses to larger { tot, out } while flushPendingFinalCalls is in flight, it is NOT deleted and triggers a follow-up flush
    events.length = 0;
    let resolveInFlight;
    recordBehavior = calls => new Promise(r => {
      resolveInFlight = val => {
        for (const c of calls) savedLedger.set(c.callId, c);
        r(val);
      };
    });
    fakeNow += 3500;
    h.tick();
    const pollB4Idx = h.pending.length - 1;
    h.pending[pollB4Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow('b_6', 6, 120)] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:b_6:120']);

    // While b_6:120 flush is still in flight, next poll calibrates b_6 to outputTokens=480
    fakeNow += 3500;
    h.tick();
    const pollB5Idx = h.pending.length - 1;
    h.pending[pollB5Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow('b_6', 6, 480)] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:b_6:120'], 'Single-flight guard prevents overlapping flush');

    // Prepare immediate resolution for the follow-up flush when in-flight flush completes
    const finishFirstFlush = resolveInFlight;
    recordBehavior = calls => {
      for (const c of calls) savedLedger.set(c.callId, c);
      return Promise.resolve({ ok: true, changed: true });
    };
    finishFirstFlush({ ok: true, changed: true });
    await flushAsync();

    assert.equal(savedLedger.get('b_6')?.outputTokens, 480, 'Follow-up flush must persist progressed outputTokens=480');
    assert.equal(events.includes('recordCalls:b_6:480'), true, 'Progressed pending call must trigger follow-up flush in finally');

    // Subsequent idle poll makes 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    const pollB6Idx = h.pending.length - 1;
    h.pending[pollB6Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow('b_6', 6, 480)] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'Idle poll after follow-up flush makes 0 recordCalls');
  } finally {
    console.warn = origWarn;
    api.dispose();
  }
});

test('pendingFinalCalls survives route switches across conversations and / home screen and retries via tick()', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  const savedLedger = new Map();
  let recordBehavior = () => Promise.resolve({ ok: true, changed: true });
  const origWarn = console.warn;
  console.warn = () => {};

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const desc = calls.map(c => `${c.callId}@${c.cascadeId.slice(0, 8)}`).join(',');
      events.push(`recordCalls:${desc}`);
      return recordBehavior(calls);
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 15:30:00',
          summary: { grandTotalTokens: 112000, todayTokens: 32000 },
          dailyMap: { '2026-11-12': { total: 32000, input: 24000, cache: 5000, output: 3000, steps: 2 } }
        }
      });
    }
  };

  const rowUuid1 = {
    stepIndices: [1],
    chatModel: {
      modelDisplayName: 'Gemini 4 Carbon (High)',
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 12000, cacheReadTokens: 3000, outputTokens: 1500, responseId: 'resp-route-u1' },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  };

  const rowUuid2 = {
    stepIndices: [2],
    chatModel: {
      modelDisplayName: 'Gemini 4 Carbon (High)',
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 12000, cacheReadTokens: 2000, outputTokens: 1500, responseId: 'resp-route-u2' },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  };

  try {
    // 1. In /c/11111111-..., Poll 1 fails ({ ok: false }) -> resp-route-u1 remains queued
    recordBehavior = () => Promise.resolve({ ok: false, error: 'temporary lock' });
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowUuid1] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-route-u1@11111111']);

    // 2. Switch route to /c/22222222-... AND then to / (id === null) before backoff expires
    events.length = 0;
    fakeNow += 500;
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    h.tick();
    h.finishScan(1);
    await flushAsync();

    fakeNow += 500;
    h.sandbox.location.pathname = '/';
    h.tick();
    await flushAsync();
    assert.equal(api.snapshot().route, null);
    assert.equal(api.snapshot().sessionCalls.length, 0);
    // Only route-switch getTokenHistory(true) ran; backoff (+3000ms) hasn't expired yet
    assert.equal(events.some(e => e.startsWith('recordCalls:')), false);

    // 3. Once backoff expires while STILL on / (id === null), tick() retries recordCalls, saves uuid-1's call, empties queue, and refreshes history
    events.length = 0;
    recordBehavior = calls => {
      for (const c of calls) savedLedger.set(c.callId, c);
      return Promise.resolve({ ok: true, changed: true });
    };
    fakeNow += 2500; // total +3500ms since failure
    h.tick();
    await flushAsync();

    assert.deepEqual(events, [
      'recordCalls:resp-route-u1@11111111',
      'getTokenHistory:true'
    ], 'tick() on / home route must retry and commit queued call from previous conversation');
    assert.equal(savedLedger.get('resp-route-u1')?.cascadeId, '11111111-1111-1111-1111-111111111111');
    assert.equal(h.elements.get('token-amount').textContent, '112.0K');

    // Subsequent tick() on / makes 0 recordCalls (queue is now empty)
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    assert.deepEqual(events, []);

    // 4. Also verify an in-flight flush completes and commits even if route switches to / mid-flight
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    h.tick();
    h.finishScan(2);
    await flushAsync();
    events.length = 0;

    let resolveMidFlight;
    recordBehavior = calls => new Promise(r => {
      resolveMidFlight = val => {
        for (const c of calls) savedLedger.set(c.callId, c);
        r(val);
      };
    });
    const poll2Idx = h.pending.length - 1;
    h.pending[poll2Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowUuid2] }) });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-route-u2@22222222']);

    // Switch to / while recordCalls is still in flight
    h.sandbox.location.pathname = '/';
    h.tick();
    await flushAsync();
    events.length = 0;

    resolveMidFlight({ ok: true, changed: true });
    await flushAsync();
    assert.equal(savedLedger.has('resp-route-u2'), true);
    assert.deepEqual(events, []);
    fakeNow += 5000;
    h.tick();
    await flushAsync();
    assert.deepEqual(events, ['getTokenHistory:true']);

    // Re-entering /c/22222222-... and polling rowUuid2 again must NOT re-send resp-route-u2 (syncedFinalMap preserved across routes)
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    h.tick();
    h.finishScan(3);
    await flushAsync();
    events.length = 0;
    const pollReenterIdx = h.pending.length - 1;
    h.pending[pollReenterIdx].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowUuid2] }) });
    await flushAsync();
    assert.deepEqual(events, [], 'syncedFinalMap retained across route switches prevents duplicate recordCalls on re-entry');
  } finally {
    console.warn = origWarn;
    api.dispose();
  }
});

test('flushPendingFinalCalls chunks >500 items and >900KB UTF-8 payloads for live-host limits and recovers from partial chunk failure', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const origWarn = console.warn;
  console.warn = () => {};

  // Use live-host HTTP mode (enforcing live-host.js MAX_RECORD_CALLS=500 & MAX_BODY_BYTES=1MB)
  delete h.sandbox.window.contextMeterAPI.recordCalls;
  delete h.sandbox.window.contextMeterAPI.getTokenHistory;
  h.sandbox.window.__AGContextMeterLive = { port: 43199, token: 'test-live-token' };

  const chunkLog = [];
  const savedIds = new Set();
  let failNextChunk2Once = true;
  const baseFetch = h.sandbox.fetch;
  h.sandbox.fetch = (url, options = {}) => {
    if (String(url).endsWith('/record-calls')) {
      const rawBody = String(options.body || '');
      const utf8Bytes = Buffer.byteLength(rawBody, 'utf8');
      if (utf8Bytes > 1024 * 1024) {
        chunkLog.push(`413:${utf8Bytes}`);
        return Promise.resolve({ ok: false, status: 413, json: async () => ({ ok: false, error: 'Payload too large' }) });
      }
      assert.equal(utf8Bytes <= 900 * 1024, true, `Chunk UTF-8 bytes (${utf8Bytes}) must respect 900KB ceiling`);
      const parsed = JSON.parse(rawBody);
      const calls = parsed.calls || [];
      if (calls.length > 500) {
        chunkLog.push(`400:${calls.length}`);
        return Promise.resolve({ ok: false, status: 400, json: async () => ({ ok: false, error: 'Too many calls' }) });
      }
      chunkLog.push(`chunk:${calls.length}:${calls[0]?.callId}..${calls[calls.length - 1]?.callId}`);
      if (calls.length === 1 && calls[0]?.callId === 'c_501' && failNextChunk2Once) {
        failNextChunk2Once = false;
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false, error: 'transient 503' }) });
      }
      for (const c of calls) savedIds.add(c.callId);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, changed: true }) });
    }
    if (String(url).endsWith('/token-history')) {
      const parsed = JSON.parse(String(options.body || '{}'));
      chunkLog.push(`history:${Boolean(parsed.force)}`);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            updatedAt: '2026-11-12 15:35:00',
            summary: { grandTotalTokens: 501000, todayTokens: 501000 },
            dailyMap: { '2026-11-12': { total: 501000, input: 400000, cache: 50000, output: 51000, steps: 501 } }
          }
        })
      });
    }
    if (String(url).endsWith('/get-settings')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false }) });
    }
    return baseFetch(url, options);
  };

  const makeFinalRow = (id, stepIdx, modelLabel = 'Gemini 4 Carbon (High)') => ({
    stepIndices: [stepIdx],
    chatModel: {
      modelDisplayName: modelLabel,
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 800, cacheReadTokens: 100, outputTokens: 100, responseId: id },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  });

  try {
    // (a) 501 items: Chunk 1 (500 items) succeeds and commits immediately; Chunk 2 (1 item) fails once, then retries ONLY that 1 item
    const rows501 = Array.from({ length: 501 }, (_, idx) => makeFinalRow(`c_${idx + 1}`, idx + 1));
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: rows501 }) });
    await flushAsync();

    assert.equal(savedIds.size, 500, 'Chunk 1 (500 items) must commit even when Chunk 2 fails');
    assert.deepEqual(chunkLog, [
      'chunk:500:c_1..c_500',
      'chunk:1:c_501..c_501',
      'history:true'
    ]);

    // After +3.5s backoff, tick() retries ONLY the remaining 1 item (c_501), NOT the already-confirmed 500 items!
    chunkLog.length = 0;
    fakeNow += 3500;
    h.tick();
    const poll2Idx = h.pending.length - 1;
    h.pending[poll2Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: rows501.slice(498) }) });
    await flushAsync();

    assert.equal(savedIds.size, 501, 'Remaining Chunk 2 item must succeed on retry and drain queue to 0');
    assert.deepEqual(chunkLog, ['chunk:1:c_501..c_501']);
    fakeNow += 1500;
    h.tick();
    await flushAsync();
    assert.deepEqual(chunkLog, [
      'chunk:1:c_501..c_501',
      'history:true'
    ]);

    // Idle poll makes 0 /record-calls requests
    chunkLog.length = 0;
    fakeNow += 2000;
    h.tick();
    const poll3Idx = h.pending.length - 1;
    h.pending[poll3Idx].resolve({ ok: true, json: async () => ({ generatorMetadata: rows501.slice(498) }) });
    await flushAsync();
    assert.deepEqual(chunkLog, []);

    // (b) Multi-byte UTF-8 byte-limit chunking: 12 items with 35,000 CJK chars each (~105KB UTF-8 per item -> ~1.26MB total > 1MB, though UTF-16 length is only ~420K)
    const bigCjkLabel = 'Gemini 4 ' + '测'.repeat(35000);
    const bigRows = Array.from({ length: 12 }, (_, idx) => makeFinalRow(`big_${idx + 1}`, 600 + idx, bigCjkLabel));
    fakeNow += 3500;
    h.tick();
    const pollBigIdx = h.pending.length - 1;
    h.pending[pollBigIdx].resolve({ ok: true, json: async () => ({ generatorMetadata: bigRows }) });
    await flushAsync();

    const bigChunks = chunkLog.filter(entry => entry.startsWith('chunk:'));
    assert.equal(bigChunks.length >= 2, true, `Expected >=2 UTF-8 byte-capped chunks, got: ${JSON.stringify(chunkLog)}`);
    for (let i = 1; i <= 12; i++) {
      assert.equal(savedIds.has(`big_${i}`), true, `Missing big_${i}`);
    }

    // Idle poll after byte-chunked drain makes 0 /record-calls requests
    chunkLog.length = 0;
    fakeNow += 3500;
    h.tick();
    const pollAfterBigIdx = h.pending.length - 1;
    h.pending[pollAfterBigIdx].resolve({ ok: true, json: async () => ({ generatorMetadata: bigRows.slice(9) }) });
    await flushAsync();
    assert.deepEqual(chunkLog, []);
  } finally {
    console.warn = origWarn;
    api.dispose();
  }
});

test('final call model enrichment with unchanged 100 tokens re-sends to host once (empty -> model, placeholder -> model, and in-flight enrichment)', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  const savedLedger = new Map();
  let recordBehavior = calls => {
    for (const c of calls) savedLedger.set(c.callId, c);
    return Promise.resolve({ ok: true, changed: true });
  };

  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const desc = calls.map(c => `${c.callId}:${c.model || '(empty)'}:${c.modelKey || '(nokey)'}:${c.totalTokens}`).join(',');
      events.push(`recordCalls:${desc}`);
      return recordBehavior(calls);
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 15:55:00',
          summary: { grandTotalTokens: 120000, todayTokens: 12000 },
          dailyMap: { '2026-11-12': { total: 12000, input: 8000, cache: 2000, output: 2000, steps: 3 } }
        }
      });
    }
  };

  const makeRow100 = (id, stepIdx, modelDisplayName = '') => ({
    stepIndices: [stepIdx],
    status: 'final',
    chatModel: {
      ...(modelDisplayName ? { modelDisplayName } : {}),
      usage: { inputTokens: 60, cacheReadTokens: 0, outputTokens: 40, responseId: id },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  });

  try {
    // (a1) model: "" -> model: "Gemini 4 Carbon" with identical 100 tokens
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-1', 1, '')] }) });
    await flushAsync();
    assert.equal(savedLedger.get('resp-mdl-1')?.model, '');
    assert.equal(savedLedger.get('resp-mdl-1')?.isPriced, false);
    assert.deepEqual(events, [
      'recordCalls:resp-mdl-1:(empty):(nokey):100',
      'getTokenHistory:true'
    ]);

    // Unchanged empty-model poll makes 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-1', 1, '')] }) });
    await flushAsync();
    assert.deepEqual(events, []);

    // Model populates to "Gemini 4 Carbon" while tokens stay at 100 (60 in + 40 out) -> MUST re-send & refresh history!
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-1', 1, 'Gemini 4 Carbon')] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp-mdl-1:Gemini 4 Carbon:gemini-4-carbon:100',
      'getTokenHistory:true'
    ]);
    assert.equal(savedLedger.get('resp-mdl-1')?.model, 'Gemini 4 Carbon');
    assert.equal(savedLedger.get('resp-mdl-1')?.modelKey, 'gemini-4-carbon');
    assert.equal(savedLedger.get('resp-mdl-1')?.isPriced, true);

    // Subsequent identical poll makes 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-1', 1, 'Gemini 4 Carbon')] }) });
    await flushAsync();
    assert.deepEqual(events, []);

    // (a2) Placeholder ("MODEL_PLACEHOLDER_M18" -> "Gemini 4 Argon (High)") and unmapped slug ("unknown-preview-v0" -> "Gemini 4 Carbon") with unchanged 100 tokens
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [
          makeRow100('resp-ph-unmapped', 2, 'unknown-preview-v0'),
          makeRow100('resp-ph-mapped', 3, 'MODEL_PLACEHOLDER_M18')
        ]
      })
    });
    await flushAsync();
    assert.equal(savedLedger.get('resp-ph-unmapped')?.modelKey, null);
    assert.equal(savedLedger.get('resp-ph-mapped')?.modelKey, null);
    assert.equal(savedLedger.get('resp-ph-mapped')?.isPriced, false);

    events.length = 0;
    fakeNow += 5000;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [
          makeRow100('resp-ph-unmapped', 2, 'Gemini 4 Carbon'),
          makeRow100('resp-ph-mapped', 3, 'Gemini 4 Argon (High)')
        ]
      })
    });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp-ph-unmapped:Gemini 4 Carbon:gemini-4-carbon:100,resp-ph-mapped:Gemini 4 Argon (High):gemini-4-argon:100',
      'getTokenHistory:true'
    ]);
    assert.equal(savedLedger.get('resp-ph-unmapped')?.isPriced, true);
    assert.equal(savedLedger.get('resp-ph-mapped')?.model, 'Gemini 4 Argon (High)');
    assert.equal(savedLedger.get('resp-ph-mapped')?.modelKey, 'gemini-4-argon');
    assert.equal(savedLedger.get('resp-ph-mapped')?.isPriced, true);

    // Subsequent identical poll makes 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [
          makeRow100('resp-ph-unmapped', 2, 'Gemini 4 Carbon'),
          makeRow100('resp-ph-mapped', 3, 'Gemini 4 Argon (High)')
        ]
      })
    });
    await flushAsync();
    assert.deepEqual(events, []);

    // (a3) In-flight model enrichment while model:"" flush is still awaiting
    events.length = 0;
    let resolveFirstInFlight;
    recordBehavior = calls => new Promise(r => {
      resolveFirstInFlight = val => {
        for (const c of calls) savedLedger.set(c.callId, c);
        r(val);
      };
    });
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-inflight', 4, '')] })
    });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-mdl-inflight:(empty):(nokey):100']);

    // Enriched model arrives while first flush is still in flight
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-inflight', 4, 'Gemini 4 Carbon')] })
    });
    await flushAsync();
    assert.deepEqual(events, ['recordCalls:resp-mdl-inflight:(empty):(nokey):100']);

    const finishFirst = resolveFirstInFlight;
    recordBehavior = calls => {
      for (const c of calls) savedLedger.set(c.callId, c);
      return Promise.resolve({ ok: true, changed: true });
    };
    finishFirst({ ok: true, changed: true });
    await flushAsync();

    assert.equal(savedLedger.get('resp-mdl-inflight')?.model, 'Gemini 4 Carbon');
    assert.equal(savedLedger.get('resp-mdl-inflight')?.isPriced, true);
    assert.equal(events.includes('recordCalls:resp-mdl-inflight:Gemini 4 Carbon:gemini-4-carbon:100'), true);

    // Next identical poll makes 0 recordCalls
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({ generatorMetadata: [makeRow100('resp-mdl-inflight', 4, 'Gemini 4 Carbon')] })
    });
    await flushAsync();
    assert.deepEqual(events, []);
  } finally {
    api.dispose();
  }
});

test('oversized >1 MiB first item never head-of-line blocks normal queued items and is quarantined in Live HTTP and recordCalls modes', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = Date.now();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  h.finishScan(0);
  await flushAsync();

  const origWarn = console.warn;
  console.warn = () => {};

  const makeRow = (id, stepIdx, modelLabel = 'Gemini 4 Carbon') => ({
    stepIndices: [stepIdx],
    status: 'final',
    chatModel: {
      modelDisplayName: modelLabel,
      responseModel: 'gemini-4-carbon',
      usage: { inputTokens: 500, cacheReadTokens: 100, outputTokens: 100, responseId: id },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  });

  // ~1.2 MiB UTF-8 string ('超' is 3 UTF-8 bytes -> 410,000 * 3 = 1,230,000 bytes > 1 MiB)
  const over1MiBLabel = 'Gemini 4 Carbon ' + '超'.repeat(410000);
  // ~950 KiB UTF-8 string (320,000 * 3 = 960,000 bytes -> >900 KiB and <=1 MiB)
  const mid950KiBLabel = 'Gemini 4 Carbon ' + '中'.repeat(320000);

  try {
    // Part 1: Live HTTP mode (>1 MiB first item + 950 KiB 413 item + normal items behind them)
    delete h.sandbox.window.contextMeterAPI.recordCalls;
    delete h.sandbox.window.contextMeterAPI.getTokenHistory;
    h.sandbox.window.__AGContextMeterLive = { port: 43299, token: 'live-tok' };

    const liveEvents = [];
    const liveSaved = new Set();
    const baseFetch = h.sandbox.fetch;
    h.sandbox.fetch = (url, options = {}) => {
      if (String(url).endsWith('/record-calls')) {
        const rawBody = String(options.body || '');
        const utf8Bytes = Buffer.byteLength(rawBody, 'utf8');
        const parsed = JSON.parse(rawBody);
        const ids = (parsed.calls || []).map(c => c.callId).join(',');
        if (utf8Bytes > 1024 * 1024 || ids === 'mid_413_live') {
          liveEvents.push(`http413:${ids}`);
          return Promise.resolve({ ok: false, status: 413, json: async () => ({ ok: false, error: 'Payload too large' }) });
        }
        liveEvents.push(`liveSaved:${ids}`);
        for (const c of parsed.calls || []) liveSaved.add(c.callId);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, changed: true }) });
      }
      if (String(url).endsWith('/token-history')) {
        const parsed = JSON.parse(String(options.body || '{}'));
        liveEvents.push(`liveHistory:${Boolean(parsed.force)}`);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            data: {
              updatedAt: '2026-11-12 16:00:00',
              summary: { grandTotalTokens: 1400, todayTokens: 1400 },
              dailyMap: { '2026-11-12': { total: 1400, input: 1000, cache: 200, output: 200, steps: 2 } }
            }
          })
        });
      }
      if (String(url).endsWith('/get-settings')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false }) });
      }
      return baseFetch(url, options);
    };

    // Enqueue >1 MiB item FIRST, 950 KiB 413 item SECOND, and normal items AFTER them!
    const liveBatch = [
      makeRow('huge_live_1', 1, over1MiBLabel),
      makeRow('mid_413_live', 2, mid950KiBLabel),
      makeRow('norm_live_1', 3),
      makeRow('norm_live_2', 4)
    ];
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: liveBatch }) });
    await flushAsync();

    // Normal items MUST drain FIRST without head-of-line blocking, >1 MiB item quarantined immediately, 413 item quarantined on 413!
    assert.deepEqual(Array.from(liveSaved), ['norm_live_1', 'norm_live_2']);
    assert.deepEqual(liveEvents, [
      'liveSaved:norm_live_1,norm_live_2',
      'http413:mid_413_live',
      'liveHistory:true'
    ]);

    // Subsequent poll + tick() with identical rows must NOT re-enqueue quarantined items or spin!
    liveEvents.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: liveBatch }) });
    await flushAsync();
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    assert.deepEqual(liveEvents, [], 'Quarantined oversized items must not retry infinitely on subsequent polls/ticks');

    // Part 2: IPC recordCalls mode rejecting >1 MiB payloads while normal items behind it drain first
    const ipcEvents = [];
    const ipcSaved = new Set();
    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      recordCalls: calls => {
        const bytes = Buffer.byteLength(JSON.stringify({ calls }), 'utf8');
        const ids = calls.map(c => c.callId).join(',');
        if (bytes > 1024 * 1024) {
          ipcEvents.push(`ipcRejectOversize:${ids}`);
          return Promise.resolve({ ok: false, error: 'Payload exceeds 1MiB' });
        }
        ipcEvents.push(`ipcSaved:${ids}`);
        for (const c of calls) ipcSaved.add(c.callId);
        return Promise.resolve({ ok: true, changed: true });
      },
      getTokenHistory: force => {
        ipcEvents.push(`ipcHistory:${Boolean(force)}`);
        return Promise.resolve({
          ok: true,
          data: {
            updatedAt: '2026-11-12 16:01:00',
            summary: { grandTotalTokens: 2800, todayTokens: 2800 },
            dailyMap: { '2026-11-12': { total: 2800, input: 2000, cache: 400, output: 400, steps: 4 } }
          }
        });
      }
    };

    const ipcBatch = [
      makeRow('huge_ipc_1', 10, over1MiBLabel),
      makeRow('norm_ipc_1', 11),
      makeRow('norm_ipc_2', 12)
    ];
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: ipcBatch }) });
    await flushAsync();

    assert.deepEqual(Array.from(ipcSaved), ['norm_ipc_1', 'norm_ipc_2']);
    assert.deepEqual(ipcEvents, [
      'ipcSaved:norm_ipc_1,norm_ipc_2',
      'ipcRejectOversize:huge_ipc_1',
      'ipcHistory:true'
    ], 'Normal items drain first; rejected >1 MiB IPC item is quarantined after single attempt');

    // Subsequent poll + tick() makes 0 further recordCalls attempts!
    ipcEvents.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: ipcBatch }) });
    await flushAsync();
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    assert.deepEqual(ipcEvents, []);

    // Part 3: Transient IPC write failures on >1 MiB records (EBUSY / Promise reject) must NOT be misclassified as oversize — must retry & succeed!
    let transientHugeAttempt = 0;
    h.sandbox.window.contextMeterAPI = {
      ...h.sandbox.window.contextMeterAPI,
      recordCalls: calls => {
        const ids = calls.map(c => c.callId).join(',');
        if (ids === 'huge_ipc_code_limit') {
          ipcEvents.push(`ipcCodeQuarantine:${ids}`);
          return Promise.resolve({ ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'limit hit' });
        }
        if (ids === 'huge_ipc_transient') {
          transientHugeAttempt++;
          ipcEvents.push(`ipcHugeAttempt#${transientHugeAttempt}:${ids}`);
          if (transientHugeAttempt === 1) {
            return Promise.resolve({ ok: false, error: '保存账本落盘失败: EBUSY' });
          }
          if (transientHugeAttempt === 2) {
            return Promise.reject(new Error('EBUSY: resource busy'));
          }
          for (const c of calls) ipcSaved.add(c.callId);
          return Promise.resolve({ ok: true, changed: true });
        }
        ipcEvents.push(`ipcSaved:${ids}`);
        for (const c of calls) ipcSaved.add(c.callId);
        return Promise.resolve({ ok: true, changed: true });
      }
    };

    // Attempt 1: >1 MiB item fails transiently with EBUSY while normal items behind it still save immediately
    const ipcTransientBatch1 = [
      makeRow('huge_ipc_transient', 20, over1MiBLabel),
      makeRow('norm_ipc_3', 21)
    ];
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: ipcTransientBatch1 }) });
    await flushAsync();

    assert.equal(ipcSaved.has('norm_ipc_3'), true, 'Normal record behind transient >1 MiB item must save immediately');
    assert.equal(ipcSaved.has('huge_ipc_transient'), false);
    assert.deepEqual(ipcEvents, [
      'ipcSaved:norm_ipc_3',
      'ipcHugeAttempt#1:huge_ipc_transient',
      'ipcHistory:true'
    ]);

    // Attempt 2 (+3.5s, with a new normal record norm_ipc_4 arriving): norm_ipc_4 drains first, then >1 MiB retries (#2) and rejects transiently
    ipcEvents.length = 0;
    const ipcTransientBatch2 = [
      makeRow('huge_ipc_transient', 20, over1MiBLabel),
      makeRow('norm_ipc_3', 21),
      makeRow('norm_ipc_4', 22)
    ];
    fakeNow += 3500;
    h.tick();
    // Wait: tick() starts retry #2 immediately if no new normal item arrived yet; verify retry #2 ran, then Poll 2 delivers norm_ipc_4 which drains immediately!
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: ipcTransientBatch2 }) });
    await flushAsync();

    assert.equal(ipcSaved.has('norm_ipc_4'), true, 'New normal record must drain immediately even while >1 MiB item is in retry backoff');
    assert.equal(ipcEvents.includes('ipcHugeAttempt#2:huge_ipc_transient'), true);
    assert.equal(ipcEvents.includes('ipcSaved:norm_ipc_4'), true);

    // Attempt 3 (+3.5s via tick() without needing RPC rows): >1 MiB record retries (#3), succeeds, saves, and refreshes token history!
    ipcEvents.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [] }) });
    await flushAsync();

    assert.equal(ipcSaved.has('huge_ipc_transient'), true, 'Transiently failing >1 MiB IPC record must NOT be quarantined and must commit on retry');
    assert.deepEqual(ipcEvents, [
      'ipcHugeAttempt#3:huge_ipc_transient',
      'ipcHistory:true'
    ]);

    // Subsequent poll with huge_ipc_transient makes 0 recordCalls (committed in syncedFinalMap), while explicit code:PAYLOAD_TOO_LARGE quarantines in 1 attempt
    ipcEvents.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [
          makeRow('huge_ipc_transient', 20, over1MiBLabel),
          makeRow('huge_ipc_code_limit', 23, over1MiBLabel)
        ]
      })
    });
    await flushAsync();
    assert.deepEqual(ipcEvents, ['ipcCodeQuarantine:huge_ipc_code_limit']);

    ipcEvents.length = 0;
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    assert.deepEqual(ipcEvents, ['ipcHistory:true'], 'The deferred history refresh runs without re-sending either oversized record');
  } finally {
    console.warn = origWarn;
    api.dispose();
  }
});

test('[P2] renderer watermark re-sends when RPC upgrades provisional date to authoritative date (same-cost cross-month & cross-rate-tier) without transcript log', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls } = require('./meter-collector');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-renderer-date-upgrade-'));
  const ledgerPath = path.join(tempDir, 'pricing_ledger_v1.json');
  const prevWindow = globalThis.window;
  const origDateNow = Date.now;

  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = new Date(2026, 10, 12, 23, 59, 58).getTime(); // 本地 2026-11-12 23:59:58
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  globalThis.window = h.sandbox.window;
  Date.now = () => fakeNow;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const desc = calls.map(c => `${c.callId}:${c.date}:${c.dateSource || 'none'}:${c.costUSD}`).join(',');
      events.push(`recordCalls:${desc}`);
      const res = recordModelCalls(calls, { agDir: tempDir });
      return Promise.resolve({ ok: res.ok, changed: res.changed, error: res.error, phase: res.phase });
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-12 23:59:59',
          summary: { grandTotalTokens: 405000, todayTokens: 0 },
          dailyMap: { '2026-10-28': { total: 405000, input: 300000, cache: 100000, output: 5000, steps: 1 } }
        }
      });
    }
  };

  try {
    // 1) 首次轮询：RPC 未返回时间，临时打上 2026-11-12（Claude Opus 5.5 费率 $1.32）并写入磁盘账本
    const rowProvisionalNov = {
      stepIndices: [1],
      status: 'final',
      chatModel: {
        modelDisplayName: 'Claude Opus 5.5 (High)',
        usage: { inputTokens: 300000, cacheReadTokens: 100000, outputTokens: 5000, responseId: 'resp_rpc_late_date' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowProvisionalNov] }) });
    await flushAsync();

    assert.deepEqual(events, [
      'recordCalls:resp_rpc_late_date:2026-11-12:provisional:1.32',
      'getTokenHistory:true'
    ]);
    let disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_rpc_late_date.date, '2026-11-12');
    assert.equal(disk.calls.resp_rpc_late_date.dateIsProvisional, true);

    // 2) 跨零点进入 2026-11-13 00:00:03，但 RPC 仍无真实时间（依然是 provisional）：不得产生跨零点无效重传
    events.length = 0;
    fakeNow = new Date(2026, 10, 13, 0, 0, 3).getTime();
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowProvisionalNov] }) });
    await flushAsync();
    assert.deepEqual(events, [], '仍为临时日期时跨零点轮询不得误触发重复入账');

    // 3) RPC 后补真实日期 2026-10-28（Token 与 $1.32 费用完全相同，且无本地 transcript.jsonl）：渲染层必须识别日期来源提升并重传落盘！
    events.length = 0;
    fakeNow += 3500;
    const rowAuthoritativeOct = {
      ...rowProvisionalNov,
      created_at: '2026-10-28T09:00:00Z'
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowAuthoritativeOct] }) });
    await flushAsync();

    assert.deepEqual(events, [
      'recordCalls:resp_rpc_late_date:2026-10-28:created_at:1.32',
      'getTokenHistory:true'
    ], 'RPC 补齐真实日期后必须触发单次重传并刷新历史');
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_rpc_late_date.date, '2026-10-28');
    assert.equal(disk.calls.resp_rpc_late_date.dateIsProvisional, false);
    assert.equal(disk.calls.resp_rpc_late_date.costUSD, 1.32);

    // 4) 后续相同轮询稳定零重发
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowAuthoritativeOct] }) });
    await flushAsync();
    assert.deepEqual(events, []);

    // 5) 跨调价日回拨（临时 2026-12-02 $1.22 -> RPC 后补真实 2026-11-25 $0.61，费用下降）：同样重传 1 次并将 $0.61 落盘，后续稳定零重发
    events.length = 0;
    fakeNow = new Date(2026, 11, 2, 10, 0, 0).getTime(); // 2026-12-02
    const rowCarbonProvDec = {
      stepIndices: [2],
      status: 'final',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_rpc_rate_drop' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    h.tick();
    if (h.scans.length > 1) h.finishScan(h.scans.length - 1);
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowAuthoritativeOct, rowCarbonProvDec] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_rpc_rate_drop:2026-12-02:provisional:1.22',
      'getTokenHistory:true'
    ]);

    events.length = 0;
    fakeNow += 5000;
    const rowCarbonAuthNov = {
      ...rowCarbonProvDec,
      created_at: '2026-11-25T10:00:00Z'
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowAuthoritativeOct, rowCarbonAuthNov] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_rpc_rate_drop:2026-11-25:created_at:0.61',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_rpc_rate_drop.date, '2026-11-25');
    assert.equal(disk.calls.resp_rpc_rate_drop.costUSD, 0.61);

    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowAuthoritativeOct, rowCarbonAuthNov] }) });
    await flushAsync();
    assert.deepEqual(events, [], '费用随真实日期下调落盘后，后续轮询不得因旧高价水位误判或重发');
  } finally {
    Date.now = origDateNow;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    api.dispose();
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});


test('[P3] provisional Carbon call crossing 11-30 -> 12-01 rate-hike midnight does not trigger spurious cost-growth re-send', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls } = require('./meter-collector');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-renderer-prov-rate-midnight-'));
  const ledgerPath = path.join(tempDir, 'pricing_ledger_v1.json');
  const prevWindow = globalThis.window;
  const origDateNow = Date.now;

  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = new Date(2026, 10, 30, 23, 59, 58).getTime(); // 本地 2026-11-30 23:59:58
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  globalThis.window = h.sandbox.window;
  Date.now = () => fakeNow;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const desc = calls.map(c => `${c.callId}:${c.date}:${c.dateSource || 'none'}:${c.costUSD}`).join(',');
      events.push(`recordCalls:${desc}`);
      const res = recordModelCalls(calls, { agDir: tempDir });
      return Promise.resolve({ ok: res.ok, changed: res.changed, error: res.error, phase: res.phase });
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-11-30 23:59:59',
          summary: { grandTotalTokens: 360000, todayTokens: 360000 },
          dailyMap: { '2026-11-30': { total: 360000, input: 250000, cache: 100000, output: 10000, steps: 1 } }
        }
      });
    }
  };

  try {
    // 1) 2026-11-30 23:59:58 首次观测无时间戳 Carbon 调用：按 11-30 费率 ($0.61) 记临时日期并落盘
    const rowCarbonProv = {
      stepIndices: [1],
      status: 'final',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_carbon_prov_midnight' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonProv] }) });
    await flushAsync();

    assert.deepEqual(events, [
      'recordCalls:resp_carbon_prov_midnight:2026-11-30:provisional:0.61',
      'getTokenHistory:true'
    ]);
    assert.equal(api.snapshot().sessionCostTotal, 0.61);

    // 2) 跨过 11-30 -> 12-01 调价零点（未锚定时按 12-01 会变成 $1.22）：仍为临时日期且用量未变，不得触发任何重传，面板费用保持 $0.61
    events.length = 0;
    fakeNow = new Date(2026, 11, 1, 0, 0, 3).getTime(); // 本地 2026-12-01 00:00:03
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonProv] }) });
    await flushAsync();
    assert.deepEqual(events, [], '仍为临时日期跨过 Carbon 调价零点时不得因费率上涨触发无效重传');
    assert.equal(api.snapshot().sessionCostTotal, 0.61);

    // 3) 切换会话清空 sessionCallsMap 后再切回原会话（仍在 12-01）：凭 syncedFinalMap 锚定 11-30 临时日期，依然零重传且会话费用保持 $0.61
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    fakeNow += 3500;
    h.tick();
    await flushAsync();

    h.sandbox.location.pathname = '/c/11111111-1111-1111-1111-111111111111';
    fakeNow += 3500;
    h.tick();
    if (h.scans.length > 0) h.finishScan(h.scans.length - 1);
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonProv] }) });
    await flushAsync();
    assert.deepEqual(events, [], '跨路由切回后仍不得因 12-01 调价触发无效重传');
    assert.equal(api.snapshot().sessionCostTotal, 0.61);

    // 4) 同在 12-01 仍为临时日期时，若真实用量增长（如配比变化 + 输出增至 15k）：必须按锚定的 11-30 费率 ($0.755) 重传更新，而非 12-01 费率
    events.length = 0;
    fakeNow += 3500;
    const rowCarbonProgressedUsage = {
      ...rowCarbonProv,
      chatModel: {
        ...rowCarbonProv.chatModel,
        usage: { inputTokens: 300000, cacheReadTokens: 50000, outputTokens: 15000, responseId: 'resp_carbon_prov_midnight' }
      }
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonProgressedUsage] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_carbon_prov_midnight:2026-11-30:provisional:0.755',
      'getTokenHistory:true'
    ]);
    let disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_carbon_prov_midnight.date, '2026-11-30');
    assert.equal(disk.calls.resp_carbon_prov_midnight.costUSD, 0.755);

    // 5) 随后 RPC 补齐真实本地 2026-12-01 时间戳：日期来源升阶 (1 -> 3)，按 12-01 费率 ($1.51) 校准落盘，后续轮询零重发
    events.length = 0;
    fakeNow += 5000;
    const rowCarbonAuthDec = {
      ...rowCarbonProgressedUsage,
      created_at: new realDate(2026, 11, 1, 0, 0, 1).toISOString()
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonAuthDec] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_carbon_prov_midnight:2026-12-01:created_at:1.51',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_carbon_prov_midnight.date, '2026-12-01');
    assert.equal(disk.calls.resp_carbon_prov_midnight.dateIsProvisional, false);
    assert.equal(disk.calls.resp_carbon_prov_midnight.costUSD, 1.51);

    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowCarbonAuthDec] }) });
    await flushAsync();
    assert.deepEqual(events, []);
  } finally {
    Date.now = origDateNow;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    api.dispose();
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});


test('[P2] same-rank authoritative created_at revision updates persisted ledger date & costUSD and settles cleanly', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { recordModelCalls } = require('./meter-collector');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-renderer-same-rank-date-'));
  const ledgerPath = path.join(tempDir, 'pricing_ledger_v1.json');
  const prevWindow = globalThis.window;
  const origDateNow = Date.now;

  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  const flushAsync = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  let fakeNow = new Date(2026, 11, 1, 12, 0, 0).getTime();
  const realDate = h.sandbox.Date;
  const MockDate = function (...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  };
  MockDate.now = () => fakeNow;
  MockDate.parse = realDate.parse;
  MockDate.UTC = realDate.UTC;
  h.sandbox.Date = MockDate;

  globalThis.window = h.sandbox.window;
  Date.now = () => fakeNow;

  h.finishScan(0);
  await flushAsync();

  const events = [];
  h.sandbox.window.contextMeterAPI = {
    ...h.sandbox.window.contextMeterAPI,
    recordCalls: calls => {
      const res = recordModelCalls(calls, { agDir: tempDir });
      const desc = calls.map(c => `${c.callId}:${c.date}:${c.costUSD}:changed=${res.changed}`).join(',');
      events.push(`recordCalls:${desc}`);
      return Promise.resolve({ ok: res.ok, changed: res.changed, error: res.error, phase: res.phase, code: res.code });
    },
    getTokenHistory: force => {
      events.push(`getTokenHistory:${Boolean(force)}`);
      return Promise.resolve({
        ok: true,
        data: {
          updatedAt: '2026-12-01 12:00:00',
          summary: { grandTotalTokens: 360000, todayTokens: 360000 },
          dailyMap: { '2026-12-01': { total: 360000, input: 250000, cache: 100000, output: 10000, steps: 1 } }
        }
      });
    }
  };

  try {
    // 1) 初始权威时间 2026-11-12 入账 ($0.61, sourceRevision: 1)
    const rowNov = {
      stepIndices: [1],
      status: 'final',
      sourceRevision: 1,
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_same_rank_e2e' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    h.pending[0].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNov] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_same_rank_e2e:2026-11-12:0.61:changed=true',
      'getTokenHistory:true'
    ]);
    let disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_same_rank_e2e.date, '2026-11-12');
    assert.equal(disk.calls.resp_same_rank_e2e.costUSD, 0.61);

    // 2) 同等级 created_at 正向修正至 2026-12-01 (sourceRevision: 2, 同用量 360k)：后端返回 changed=true 并更新磁盘为 12-01 / $1.22
    events.length = 0;
    fakeNow += 6000;
    const rowDec = {
      ...rowNov,
      sourceRevision: 2,
      created_at: '2026-12-01T10:00:00Z'
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowDec] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_same_rank_e2e:2026-12-01:1.22:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_same_rank_e2e.date, '2026-12-01');
    assert.equal(disk.calls.resp_same_rank_e2e.costUSD, 1.22);
    assert.equal(api.snapshot().sessionCostTotal, 1.22);

    // 2b) 新修正 -> 同用量旧包 (rev=1 及无版本旧包) -> 重复旧包（含切路由再切回）：严禁重发或回滚日期/费用
    const rowNovUnversioned = { ...rowNov };
    delete rowNovUnversioned.sourceRevision;
    for (const staleVariant of [rowNov, rowNov, rowNovUnversioned]) {
      events.length = 0;
      fakeNow += 3500;
      h.tick();
      h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [staleVariant] }) });
      await flushAsync();
      assert.deepEqual(events, [], '同用量旧包及重复旧包不得触发重传');
      assert.equal(api.snapshot().sessionCostTotal, 1.22);
    }
    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    h.sandbox.location.pathname = '/c/11111111-1111-1111-1111-111111111111';
    fakeNow += 3500;
    h.tick();
    if (h.scans.length > 0) h.finishScan(h.scans.length - 1);
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovUnversioned] }) });
    await flushAsync();
    assert.deepEqual(events, [], '跨路由切回后收到同用量旧包依然零重发、零回滚');
    assert.equal(api.snapshot().sessionCostTotal, 1.22);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_same_rank_e2e.date, '2026-12-01');
    assert.equal(disk.calls.resp_same_rank_e2e.costUSD, 1.22);

    // 3) 同等级 created_at 逆向修正回 2026-11-15 (sourceRevision: 3)：双向校准更新磁盘回 2026-11-15 / $0.61，随后迟到 rev=2 零重发
    events.length = 0;
    fakeNow += 6000;
    const rowNovRevised = {
      ...rowNov,
      sourceRevision: 3,
      created_at: '2026-11-15T10:00:00Z'
    };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_same_rank_e2e:2026-11-15:0.61:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_same_rank_e2e.date, '2026-11-15');
    assert.equal(disk.calls.resp_same_rank_e2e.costUSD, 0.61);
    assert.equal(api.snapshot().sessionCostTotal, 0.61);

    for (const staleAfterRev3 of [rowDec, rowDec]) {
      events.length = 0;
      fakeNow += 3500;
      h.tick();
      h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [staleAfterRev3] }) });
      await flushAsync();
      assert.deepEqual(events, [], '逆向校准后迟到的高费率旧修订包不得触发重发');
      assert.equal(api.snapshot().sessionCostTotal, 0.61);
    }

    // 4) 无版本冲突交替场景 ([11-12, 12-01, 11-12, 12-01])：保持首个已确认权威日期，零反复重发
    events.length = 0;
    fakeNow += 6000;
    const rowUnvA = {
      stepIndices: [2],
      status: 'final',
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 250000, cacheReadTokens: 100000, outputTokens: 10000, responseId: 'resp_unv_alt' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    const rowUnvB = { ...rowUnvA, created_at: '2026-12-01T10:00:00Z' };
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised, rowUnvA] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_unv_alt:2026-11-12:0.61:changed=true',
      'getTokenHistory:true'
    ]);
    for (const alt of [rowUnvB, rowUnvA, rowUnvB]) {
      events.length = 0;
      fakeNow += 3500;
      h.tick();
      h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised, alt] }) });
      await flushAsync();
      assert.deepEqual(events, [], '两版无版本同用量快照交替到达时不得重发震荡');
      assert.equal(api.snapshot().sessionCostTotal, 1.22); // 0.61 + 0.61
    }

    // 5) “总量增加、输出量下降”交叉变化前后端联动：input=100k,out=20k,tot=120k,11-12 ($0.40) -> input=130k,out=10k,tot=140k,12-01 ($0.72)
    fakeNow += 6000;
    const rowCross1 = {
      stepIndices: [3],
      status: 'final',
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 20000, responseId: 'resp_cross_e2e' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    };
    const rowCross2 = {
      ...rowCross1,
      created_at: '2026-12-01T10:00:00Z',
      chatModel: {
        ...rowCross1.chatModel,
        usage: { inputTokens: 130000, cacheReadTokens: 0, outputTokens: 10000, responseId: 'resp_cross_e2e' }
      }
    };
    h.tick();
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised, rowUnvA, rowCross1] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_cross_e2e:2026-11-12:0.4:changed=true',
      'getTokenHistory:true'
    ]);

    fakeNow += 6000;
    h.tick();
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised, rowUnvA, rowCross2] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_cross_e2e:2026-12-01:0.72:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_cross_e2e.inputTokens, 130000);
    assert.equal(disk.calls.resp_cross_e2e.outputTokens, 10000);
    assert.equal(disk.calls.resp_cross_e2e.totalTokens, 140000);
    assert.equal(disk.calls.resp_cross_e2e.date, '2026-12-01');
    assert.equal(disk.calls.resp_cross_e2e.costUSD, 0.72);
    assert.equal(Number(api.snapshot().sessionCostTotal.toFixed(4)), 1.94); // 0.61 + 0.61 + 0.72

    // 迟到的旧交叉快照 (120k/20k, 11-12) 到达时零重发，磁盘与面板完全一致
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRevised, rowUnvA, rowCross1] }) });
    await flushAsync();
    assert.deepEqual(events, []);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_cross_e2e.totalTokens, 140000);
    assert.equal(disk.calls.resp_cross_e2e.outputTokens, 10000);
    assert.equal(disk.calls.resp_cross_e2e.date, '2026-12-01');
    assert.equal(disk.calls.resp_cross_e2e.costUSD, 0.72);

    // 6a) 仅显式修订号提升 (sourceRevision: 3 -> 4，日期/总量/输出均未变)：提交 1 次更新账本版本，随后零重发
    fakeNow += 6000;
    const rowNovRev4 = { ...rowNovRevised, sourceRevision: 4 };
    h.tick();
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_same_rank_e2e:2026-11-15:0.61:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_same_rank_e2e.sourceRevision, 4);

    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2] }) });
    await flushAsync();
    assert.deepEqual(events, [], '仅修订号提升提交确认后，后续相同修订号轮询必须零重发');

    // 6b) 同总量/输出量下输入与缓存重新分配导致费用下降 (rev=1: inp=1M,cap=0,$2.10 -> rev=2: inp=100k,cap=900k,$0.39) 及迟到旧版防护
    fakeNow += 6000;
    const rowSplitRev1 = {
      stepIndices: [4],
      status: 'final',
      sourceRevision: 1,
      created_at: '2026-11-12T10:00:00Z',
      chatModel: {
        modelDisplayName: 'Gemini 4 Carbon (High)',
        responseModel: 'gemini-4-carbon',
        usage: { inputTokens: 1000000, cacheReadTokens: 0, outputTokens: 10000, responseId: 'resp_split_rebalance' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1048576 } }
      }
    };
    const rowSplitRev2 = {
      ...rowSplitRev1,
      sourceRevision: 2,
      chatModel: {
        ...rowSplitRev1.chatModel,
        usage: { inputTokens: 100000, cacheReadTokens: 900000, outputTokens: 10000, responseId: 'resp_split_rebalance' }
      }
    };
    h.tick();
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2, rowSplitRev1] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_split_rebalance:2026-11-12:2.1:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_split_rebalance.inputTokens, 1000000);
    assert.equal(disk.calls.resp_split_rebalance.cacheTokens, 0);
    assert.equal(disk.calls.resp_split_rebalance.costUSD, 2.1);

    fakeNow += 6000;
    h.tick();
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2, rowSplitRev2] }) });
    await flushAsync();
    assert.deepEqual(events, [
      'recordCalls:resp_split_rebalance:2026-11-12:0.39:changed=true',
      'getTokenHistory:true'
    ]);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_split_rebalance.inputTokens, 100000);
    assert.equal(disk.calls.resp_split_rebalance.cacheTokens, 900000);
    assert.equal(disk.calls.resp_split_rebalance.costUSD, 0.39);
    assert.equal(disk.calls.resp_split_rebalance.sourceRevision, 2);
    assert.equal(Number(api.snapshot().sessionCostTotal.toFixed(4)), 2.33); // 0.61 + 0.61 + 0.72 + 0.39

    // 迟到的高费用旧版本 rev=1 ($2.10) 在同路由与跨路由切回后均不得覆盖或重发
    events.length = 0;
    fakeNow += 3500;
    h.tick();
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2, rowSplitRev1] }) });
    await flushAsync();
    assert.deepEqual(events, []);
    assert.equal(Number(api.snapshot().sessionCostTotal.toFixed(4)), 2.33);

    h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
    fakeNow += 3500;
    h.tick();
    await flushAsync();
    h.sandbox.location.pathname = '/c/11111111-1111-1111-1111-111111111111';
    fakeNow += 3500;
    h.tick();
    if (h.scans.length > 0) h.finishScan(h.scans.length - 1);
    await flushAsync();
    events.length = 0;
    h.pending[h.pending.length - 1].resolve({ ok: true, json: async () => ({ generatorMetadata: [rowNovRev4, rowUnvA, rowCross2, rowSplitRev1] }) });
    await flushAsync();
    assert.deepEqual(events, [], '跨路由切回后收到同总量高费用旧版本 rev=1 仍不得覆盖或重发');
    assert.equal(Number(api.snapshot().sessionCostTotal.toFixed(4)), 2.33);
    disk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(disk.calls.resp_split_rebalance.inputTokens, 100000);
    assert.equal(disk.calls.resp_split_rebalance.cacheTokens, 900000);
    assert.equal(disk.calls.resp_split_rebalance.costUSD, 0.39);
  } finally {
    Date.now = origDateNow;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    api.dispose();
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('PR #13 & PR #21: 弹窗动态锚点定位、首帧显示前预设坐标、无缩放/left防抖与繁中术语回归', async () => {
  const pathMod = require('node:path');
  const cssSrc = fs.readFileSync(pathMod.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  // 1. 验证 styles.css 无 .ag-unit:active transform 缩放且 #panel-tokens 无 left transition
  const activeBlock = cssSrc.match(/\.ag-unit:active\s*\{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(activeBlock, /transform\s*:\s*scale/i, '.ag-unit:active 不应有按压缩放');
  const tokensRule = cssSrc.match(/#panel-tokens\s*\{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(tokensRule, /\bleft\s+\./i, '#panel-tokens 不应对 left 做过渡动画');
  assert.match(cssSrc, /#overflow-menu\s*\{[^}]*box-sizing\s*:\s*border-box/i);

  // 2. 验证每个触发按钮锚点（badge / badge-speed / badge-tokens / badge-quota / overflow）与先定位再显示
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    h.sandbox.window.innerWidth = 1280;
    h.sandbox.window.innerHeight = 800;
    h.host.getBoundingClientRect = () => ({ left: 820, top: 6, width: 320, height: 28, right: 1140, bottom: 34 });
    h.elements.get('badge').getBoundingClientRect = () => ({ left: 820, top: 6, width: 88, height: 28, right: 908, bottom: 34 });
    h.elements.get('badge-speed').getBoundingClientRect = () => ({ left: 912, top: 6, width: 64, height: 28, right: 976, bottom: 34 });
    h.elements.get('badge-tokens').getBoundingClientRect = () => ({ left: 980, top: 6, width: 68, height: 28, right: 1048, bottom: 34 });
    h.elements.get('badge-quota').getBoundingClientRect = () => ({ left: 1052, top: 6, width: 52, height: 28, right: 1104, bottom: 34 });
    h.elements.get('badge-overflow').getBoundingClientRect = () => ({ left: 1108, top: 6, width: 28, height: 28, right: 1136, bottom: 34 });

    // 验证 showPanel 在 hidden=false 前已将 style.left 写入
    let leftWhenUnhidden = null;
    const panel = h.elements.get('panel');
    let hiddenVal = true;
    Object.defineProperty(panel, 'hidden', {
      get: () => hiddenVal,
      set: (v) => {
        if (v === false) leftWhenUnhidden = panel.style.left;
        hiddenVal = Boolean(v);
      }
    });

    h.elements.get('badge').click();
    assert.ok(leftWhenUnhidden && leftWhenUnhidden !== '', '取消 hidden 前必须已预设 style.left');
    assert.equal(panel.style.left, `${908 - 460}px`);
    assert.equal(h.elements.get('badge').getAttribute('aria-expanded'), 'true');
    assert.equal(h.elements.get('badge-speed').getAttribute('aria-expanded'), 'false');

    h.elements.get('badge-speed').click();
    assert.equal(panel.style.left, `${976 - 460}px`);
    assert.equal(h.elements.get('badge-speed').getAttribute('aria-expanded'), 'true');

    h.elements.get('badge-tokens').click();
    assert.equal(panel.style.left, `${1048 - 700}px`);
    assert.equal(panel.getAttribute('data-wb-wide'), 'true');

    h.elements.get('badge-quota').click();
    assert.equal(panel.style.left, `${1104 - 460}px`);
    assert.equal(panel.getAttribute('data-wb-wide'), null);

    // 溢出入口打开 tokens / quota 时必须对齐 badge-overflow 而非隐藏按钮
    h.elements.get('badge-overflow').click();
    assert.equal(h.elements.get('overflow-menu').hidden, false);
    assert.equal(h.elements.get('overflow-menu').style.left, `${1136 - 220}px`);
    h.elements.get('overflow-tokens-btn').click();
    assert.equal(panel.style.left, `${1136 - 700}px`);
    h.elements.get('overflow-quota-btn').click();
    assert.equal(panel.style.left, `${1136 - 460}px`);

    // 窄屏越界钳位
    h.sandbox.window.innerWidth = 600;
    h.host.getBoundingClientRect = () => ({ left: 400, top: 6, width: 180, height: 28, right: 580, bottom: 34 });
    h.elements.get('badge').getBoundingClientRect = () => ({ left: 400, top: 6, width: 60, height: 28, right: 460, bottom: 34 });
    h.elements.get('badge').click();
    assert.equal(panel.style.left, '12px');

    // 3. 验证 PR #21 繁中译文与参数占位符完好
    h.elements.get('btn-top-lang-zh-TW').click();
    await h.flush();
    assert.equal(api.translateForTest('badge.tokens.aria'), 'Token 用量總覽');
    assert.equal(api.translateForTest('colors.btn.restore'), '還原');
    assert.equal(api.translateForTest('diag.auth.tipTitle'), '帳號權限（身分異常）：');
    assert.equal(api.translateForTest('badge.corpus.scanning'), '對話掃描中…');
    assert.equal(api.translateForTest('cost.scopeAll'), '完整歷史紀錄');
  } finally {
    api.dispose();
  }
});

test('ELV-84: 静止浮层避免常驻合成层与冗余模糊，混合 DPI 坐标对齐像素网格并在跨屏变更时重排与清理', async () => {
  // 1. CSS 静态防虚契约断言（构建产物 meter-renderer.js）
  assert.match(source, /font:12px\/1\.4 [^;]*"Microsoft YaHei UI"/, '应优先使用 Microsoft YaHei UI 改善 100% 缩放 ClearType');
  assert.match(source, /\.ag-panel\{[^}]*transform:none;[^}]*\}/, '.ag-panel 静止打开态必须回退到 transform:none');
  assert.doesNotMatch(source, /\.ag-panel\{[^}]*will-change:opacity,transform;/, '.ag-panel 不应常驻 will-change:opacity,transform');
  assert.doesNotMatch(source, /\.ag-panel\{[^}]*contain:layout paint;/, '.ag-panel 不应常驻 contain:layout paint');
  assert.match(source, /#context-tooltip\[data-visible="true"\]\{[^}]*transform:none;/, '悬停气泡可见态应使用 transform:none');
  assert.doesNotMatch(source, /#overflow-menu\{[^}]*will-change:opacity,transform;/, '溢出菜单不应常驻 will-change');
  assert.match(source, /\.ag-dropdown-wrapper\.is-open \.ag-dropdown-menu\{[^}]*transform:none;/, '打开的下拉列表应使用 transform:none');
  assert.doesNotMatch(source, /\.ag-dropdown-menu\{[^}]*backdrop-filter:blur\(24px\)/, '不透明背景的下拉列表不得叠加 backdrop-filter:blur(24px)');
  assert.match(source, /@keyframes agSmoothExpand\{\s*0%\{[^}]*\}\s*100%\{[^}]*transform:none;/, '展开关键帧结束态应使用 transform:none');
  assert.doesNotMatch(source, /animation:\s*agSmoothExpand[^;]*forwards/, '折叠展开动画不得使用 forwards 永久锁定合成层');
  assert.match(source, /\.view-pane-fade\{[^}]*transform:none/, '视图切换容器静止态应使用 transform:none');

  // 2. 运行态设备像素网格对齐与跨屏 DPI change 事件测试
  const ctx = {};
  const winListeners = new Map();
  const mqlListeners = new Map();
  let mqlRemoved = 0;
  const mockHost = {
    style: { setProperty() {}, removeProperty() {}, top: '', right: '', left: '', zIndex: '' },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    remove() {},
    getBoundingClientRect: () => ({ left: 1210.4, top: 6.3, right: 1410.3, bottom: 34.1, width: 199.9, height: 27.8 }),
    attachShadow() {
      return {
        _innerHTML: '',
        set innerHTML(v) { this._innerHTML = v; },
        get innerHTML() { return this._innerHTML; },
        getElementById: id => {
          if (!mockElements.has(id)) mockElements.set(id, makeEl(id));
          return mockElements.get(id);
        },
        querySelector: () => null,
        querySelectorAll: () => []
      };
    }
  };
  const makeEl = id => {
    const attrs = new Map([['id', id]]);
    return {
      id,
      hidden: id.startsWith('panel') || id === 'overflow-menu' || id === 'color-picker-popover',
      textContent: '',
      value: '',
      children: [],
      style: { display: '', top: '', left: '', right: '', maxWidth: '', maxHeight: '', transformOrigin: '', setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, contains() { return false; } },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener() {},
      removeEventListener() {},
      replaceChildren() {},
      appendChild() {},
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 1300.3, top: 6.2, right: 1410.3, bottom: 34.1, width: 110, height: 27.9 })
    };
  };
  const mockElements = new Map();
  for (const id of ['badge', 'badge-quota', 'badge-tokens', 'badge-overflow', 'panel', 'panel-quota', 'panel-tokens', 'overflow-menu', 'update-popover', 'btn-check-update', 'context-tooltip', 'color-picker-popover', 'v']) {
    mockElements.set(id, makeEl(id));
  }
  const winObj = {
    devicePixelRatio: 1.75,
    innerWidth: 1646,
    innerHeight: 1029,
    addEventListener(type, fn) { winListeners.set(type, fn); },
    removeEventListener(type, fn) { if (winListeners.get(type) === fn) winListeners.delete(type); },
    matchMedia(query) {
      return {
        media: query,
        matches: true,
        addEventListener(type, fn) { if (type === 'change') mqlListeners.set(query, fn); },
        removeEventListener(type, fn) { if (type === 'change' && mqlListeners.get(query) === fn) { mqlListeners.delete(query); mqlRemoved++; } }
      };
    }
  };
  let isFirstCreate = true;
  const docObj = {
    body: { appendChild() {}, children: [] },
    documentElement: { appendChild() {} },
    createElement: () => {
      if (isFirstCreate) {
        isFirstCreate = false;
        return mockHost;
      }
      return makeEl('dyn');
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null
  };
  Object.assign(ctx, {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    __AGContextMeterCore: core,
    window: Object.assign(winObj, { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: async () => ({ ok: true, data: { session: session(), scannedAt: Date.now(), latest: null } }) } }),
    document: docObj,
    globalThis: null,
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: () => new Promise(() => {}),
    AbortController,
    URL,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    Promise,
    Error,
    getComputedStyle: () => ({ color: '', backgroundColor: '' })
  });
  ctx.globalThis = ctx;
  ctx.window.window = winObj;
  vm.runInNewContext(source, ctx);
  try {
    const panel = mockElements.get('panel');
    panel.hidden = false;
    // 1.75x 下验证物理像素对齐：val * 1.75 应为整数
    const top175 = parseFloat(panel.style.top);
    const left175 = parseFloat(panel.style.left);
    assert.ok(Number.isFinite(top175) && Number.isFinite(left175), '175% DPI 下应计算出面板坐标');
    assert.equal(Math.round(top175 * 1.75), top175 * 1.75, '175% DPI 下 top 必须落在物理像素边界上');
    assert.equal(Math.round(left175 * 1.75), left175 * 1.75, '175% DPI 下 left 必须落在物理像素边界上');
    const prevGeomKey = panel._lastPlacedGeomKey;
    assert.match(prevGeomKey, /\|1\.75$/, 'geomKey 应记录当前 dpr');

    // 模拟拖到 1920x1080 @ 100% 屏幕：触发 resolution: 1.75dppx 的 change
    const changeFn = mqlListeners.get('(resolution: 1.75dppx)');
    assert.equal(typeof changeFn, 'function', '应注册当前 DPI 的 matchMedia 监听');
    winObj.devicePixelRatio = 1;
    winObj.innerWidth = 1920;
    winObj.innerHeight = 1080;
    mockElements.get('badge').getBoundingClientRect = () => ({ left: 1700.4, top: 6.2, right: 1810.4, bottom: 34.4, width: 110, height: 28.2 });
    changeFn();
    const top100 = parseFloat(panel.style.top);
    const left100 = parseFloat(panel.style.left);
    assert.equal(Math.floor(top100), top100, '100% DPI 下 top 必须严格取整');
    assert.equal(Math.floor(left100), left100, '100% DPI 下 left 必须严格取整');
    assert.match(panel._lastPlacedGeomKey, /\|1$/, '切换 DPI 后应重算并更新 geomKey');
    assert.equal(typeof mqlListeners.get('(resolution: 1dppx)'), 'function', '变更后应重新订阅新 DPI (1dppx) 的监听');
  } finally {
    ctx.__AGContextMeter.dispose();
    assert.ok(mqlRemoved >= 1, 'dispose() 时必须取消 DPI matchMedia 监听');
  }
});

test('By Model usage view: renders stacked bars, percentages, 7d/30d, variant/cache toggles, and hover tooltip', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const yesterdayDt = new Date(Date.now() - 86400000);
    const yKey = `${yesterdayDt.getFullYear()}-${String(yesterdayDt.getMonth() + 1).padStart(2, '0')}-${String(yesterdayDt.getDate()).padStart(2, '0')}`;
    const tKey = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    const modelMetaByKey = {
      'gemini-4-hydrogen:xhigh': { modelKey: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen', variantKey: 'gemini-4-hydrogen:xhigh', variantLabel: 'Gemini 4 Hydrogen (XHigh)' },
      'gemini-4-hydrogen:medium': { modelKey: 'gemini-4-hydrogen', modelLabel: 'Gemini 4 Hydrogen', variantKey: 'gemini-4-hydrogen:medium', variantLabel: 'Gemini 4 Hydrogen (Medium)' },
      'gemini-4-argon:high': { modelKey: 'gemini-4-argon', modelLabel: 'Gemini 4 Argon', variantKey: 'gemini-4-argon:high', variantLabel: 'Gemini 4 Argon (High)' }
    };

    api.applyTokenHistoryPayload({
      schemaVersion: '0.8.5',
      summary: { grandTotalTokens: 1000000, todayTokens: 600000, totalConversations: 4 },
      dailyMap: {
        [yKey]: { total: 400000, input: 100000, cache: 250000, output: 50000, steps: 4 },
        [tKey]: { total: 600000, input: 150000, cache: 350000, output: 100000, steps: 6 }
      },
      dailyMapBySource: {
        all: {
          [yKey]: { total: 400000, input: 100000, cache: 250000, output: 50000, steps: 4 },
          [tKey]: { total: 600000, input: 150000, cache: 350000, output: 100000, steps: 6 }
        },
        desktop: {
          [tKey]: { total: 200000, input: 50000, cache: 100000, output: 50000, steps: 2 }
        },
        cli: {
          [yKey]: { total: 400000, input: 100000, cache: 250000, output: 50000, steps: 4 },
          [tKey]: { total: 400000, input: 100000, cache: 250000, output: 50000, steps: 4 }
        }
      },
      dailyModelMapBySource: {
        all: {
          [yKey]: {
            'gemini-4-hydrogen:medium': { total: 300000, input: 75000, cache: 185000, output: 40000, steps: 3 },
            'gemini-4-argon:high': { total: 100000, input: 25000, cache: 65000, output: 10000, steps: 1 }
          },
          [tKey]: {
            'gemini-4-hydrogen:xhigh': { total: 500000, input: 120000, cache: 300000, output: 80000, steps: 5 },
            __unattributed__: { total: 100000, input: 30000, cache: 50000, output: 20000, steps: 1 }
          }
        },
        desktop: {
          [tKey]: {
            'gemini-4-hydrogen:xhigh': { total: 200000, input: 50000, cache: 100000, output: 50000, steps: 2 }
          }
        },
        cli: {
          [yKey]: {
            'gemini-4-hydrogen:medium': { total: 300000, input: 75000, cache: 185000, output: 40000, steps: 3 },
            'gemini-4-argon:high': { total: 100000, input: 25000, cache: 65000, output: 10000, steps: 1 }
          },
          [tKey]: {
            'gemini-4-hydrogen:xhigh': { total: 300000, input: 70000, cache: 200000, output: 30000, steps: 3 },
            __unattributed__: { total: 100000, input: 30000, cache: 50000, output: 20000, steps: 1 }
          }
        }
      },
      modelMetaByKey
    });

    // Switch to By Model view
    h.elements.get('tok-view-models').click();
    assert.equal(h.elements.get('model-usage-view').style.display, 'block');
    assert.equal(h.elements.get('tokens-main-view').style.display, 'none');
    assert.equal(h.elements.get('cost-estimate-card').style.display, 'none');

    const barsEl = h.elements.get('model-usage-bars');
    const legendEl = h.elements.get('model-usage-legend');
    assert.equal(barsEl.children.length, 7);
    assert.equal(legendEl.children.length, 3); // Hydrogen, Argon, Unattributed
    assert.equal(h.elements.get('model-usage-window-total').textContent, '1.0M Tokens');
    assert.equal(h.elements.get('model-toggle-unattr').style.display, 'inline-flex');

    // Hover today's bar (last column) -> shows heat-pop details
    barsEl.children[6].trigger('mouseenter');
    assert.equal(h.elements.get('heat-pop').style.opacity, '1');
    assert.match(h.elements.get('heat-pop-val').textContent, /600\.0K Tokens/);

    // Switch to variant breakdown
    h.elements.get('model-group-variant').click();
    assert.equal(legendEl.children.length, 4); // XHigh, Medium, Argon High, Unattributed

    // Hide unattributed -> 3 variants and 900.0K total
    h.elements.get('model-toggle-unattr').click();
    assert.equal(legendEl.children.length, 3);
    assert.equal(h.elements.get('model-usage-window-total').textContent, '900.0K Tokens');

    // Switch to 30d and noCache
    h.elements.get('model-period-30d').click();
    assert.equal(barsEl.children.length, 30);
    h.elements.get('model-metric-nocache').click();
    assert.equal(h.elements.get('model-usage-window-total').textContent, '350.0K Tokens');

    // Source switch to desktop
    h.elements.get('src-tab-desktop').click();
    assert.equal(h.elements.get('model-usage-window-total').textContent, '100.0K Tokens');
    assert.equal(legendEl.children.length, 1);

    // Switch back to all sources and verify variant effort shade + dark/light theme color adaptation
    h.elements.get('src-tab-all').click();
    h.sandbox.__AGContextMeter.setTheme('dark');
    assert.equal(legendEl.children[0].children[0].style.background, '#826cc3'); // gemini-4-hydrogen:xhigh shade

    h.elements.get('model-group-model').click();
    h.elements.get('model-metric-total').click();
    h.elements.get('model-toggle-unattr').click(); // show unattributed again
    assert.equal(legendEl.children.length, 3);
    assert.equal(legendEl.children[0].children[0].style.background, '#a78bfa');
    assert.equal(legendEl.children[1].children[0].style.background, '#6366f1');
    assert.equal(legendEl.children[2].children[0].style.background, 'rgba(161, 161, 170, 0.28)');

    h.sandbox.__AGContextMeter.setTheme('light');
    assert.equal(legendEl.children[0].children[0].style.background, '#7c3aed');
    assert.equal(legendEl.children[1].children[0].style.background, '#4f46e5');
    assert.equal(legendEl.children[2].children[0].style.background, 'rgba(113, 113, 122, 0.24)');

    h.sandbox.__AGContextMeter.setTheme('dark');
    assert.equal(legendEl.children[0].children[0].style.background, '#a78bfa');
  } finally {
    api.dispose();
  }
});

test('panel language defaults unconditionally to English without host locale sniffing and still supports manual switching', async () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const core = require('./meter-core');

  const runWithLocaleEnv = ({ htmlLang = '', hostLocale = '', navLang = '', appConfigLocale = '', savedLang = 'auto' } = {}) => {
    const elements = new Map();
    const makeEl = () => {
      const attrs = new Map();
      const props = new Map();
      const listeners = new Map();
      return {
        hidden: false,
        textContent: '',
        innerHTML: '',
        value: '',
        checked: true,
        disabled: false,
        children: [],
        style: {
          display: '', left: '', top: '', right: '', maxWidth: '', maxHeight: '', transformOrigin: '',
          setProperty(k, v) { props.set(k, v); },
          removeProperty(k) { props.delete(k); },
          getPropertyValue(k) { return props.get(k) || ''; }
        },
        classList: {
          _set: new Set(),
          add(...cls) { cls.forEach(c => this._set.add(c)); },
          remove(...cls) { cls.forEach(c => this._set.delete(c)); },
          contains(c) { return this._set.has(c); }
        },
        setAttribute(k, v) { attrs.set(k, String(v)); },
        getAttribute(k) { return attrs.get(k) ?? null; },
        removeAttribute(k) { attrs.delete(k); },
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
        removeEventListener() {},
        click() {
          for (const fn of (listeners.get('click') || [])) fn({ preventDefault() {}, stopPropagation() {} });
        },
        appendChild() {},
        replaceChildren() {},
        remove() {},
        getBoundingClientRect: () => ({ left: 100, top: 10, right: 200, bottom: 38, width: 100, height: 28 })
      };
    };
    const host = makeEl();
    host.attachShadow = () => ({
      set innerHTML(_v) {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeEl());
        return elements.get(id);
      },
      querySelectorAll: () => []
    });
    let first = true;
    const saved = [];
    const docEl = { lang: htmlLang, getAttribute: k => (k === 'lang' ? htmlLang : null), appendChild() {} };
    const winObj = {
      __APP_CONFIG__: { csrfToken: 'test', ...(appConfigLocale ? { locale: appConfigLocale } : {}) },
      ...(hostLocale ? { __AGContextMeterBootBackend: { hostLocale } } : {}),
      contextMeterAPI: {
        scan: () => new Promise(() => {}),
        getSettings: async () => ({ ok: true, panelLanguage: savedLang, uiPreferences: {} }),
        saveSettings: async (p) => { saved.push(p); return { ok: true }; }
      }
    };
    const sandbox = {
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
      document: {
        createElement: () => { if (first) { first = false; return host; } return makeEl(); },
        documentElement: docEl,
        addEventListener() {},
        removeEventListener() {},
        hidden: false
      },
      window: winObj,
      navigator: navLang ? { language: navLang, languages: [navLang] } : {},
      __AGContextMeterCore: core,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      AbortController,
      Date,
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
      fetch: () => new Promise(() => {})
    };
    vm.createContext(sandbox);
    vm.runInContext(rendererSrc, sandbox);
    return { api: sandbox.__AGContextMeter, elements, saved };
  };

  // 1. Even when host HTML/app/navigator locales are all zh-CN and legacy settings say 'auto', default is unconditionally 'en'
  const rDefault = runWithLocaleEnv({ htmlLang: 'zh-CN', hostLocale: 'zh-CN', navLang: 'zh-CN', appConfigLocale: 'zh-CN', savedLang: 'auto' });
  try {
    await new Promise(r => setImmediate(r));
    assert.equal(rDefault.api.getPanelLanguage(), 'en');
    assert.equal(rDefault.api.translateForTest('tab.session'), 'Session');
    assert.equal(rDefault.elements.get('btn-top-lang-en').classList.contains('active'), true);

    // 2. Manual switching to zh-CN / zh-TW / en still works and persists cleanly
    rDefault.elements.get('btn-top-lang-zh-CN').click();
    await new Promise(r => setImmediate(r));
    assert.equal(rDefault.api.getPanelLanguage(), 'zh-CN');
    assert.equal(rDefault.saved.at(-1)?.panelLanguage, 'zh-CN');

    rDefault.elements.get('btn-top-lang-zh-TW').click();
    await new Promise(r => setImmediate(r));
    assert.equal(rDefault.api.getPanelLanguage(), 'zh-TW');
    assert.equal(rDefault.api.translateForTest('tab.models'), '模型規格');
    assert.equal(rDefault.saved.at(-1)?.panelLanguage, 'zh-TW');

    rDefault.elements.get('btn-top-lang-en').click();
    await new Promise(r => setImmediate(r));
    assert.equal(rDefault.api.getPanelLanguage(), 'en');
    assert.equal(rDefault.saved.at(-1)?.panelLanguage, 'en');
  } finally {
    rDefault.api.dispose();
  }

  // 3. Previously saved explicit user preference ('zh-TW') is still restored from host settings
  const rSavedTw = runWithLocaleEnv({ savedLang: 'zh-TW' });
  try {
    await new Promise(r => setImmediate(r));
    assert.equal(rSavedTw.api.getPanelLanguage(), 'zh-TW');
  } finally {
    rSavedTw.api.dispose();
  }
});

test('new session (route null and empty /c/<uuid>) clears previous high-occupancy ring, summary card, tooltip, and technical drawer', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;
  h.scans[0].resolve({
    ok: true,
    data: {
      scannedAt: Date.now(),
      latest: null,
      session: {
        steps: 14,
        userMessages: 7,
        assistantMessages: 7,
        total: { chars: 180000, bytes: 180000, low: 45000, high: 60000 },
        groups: { user: { low: 10000, high: 12000 }, assistant: { low: 35000, high: 48000 }, thinking: { low: 0, high: 0 }, tools: { low: 0, high: 0 }, summaries: { low: 0, high: 0 } },
        attachments: [],
        unknownFiles: 0
      }
    }
  });
  h.pending[0].resolve(response({
    modelDisplayName: 'Gemini 4 Neon (High)',
    usage: { inputTokens: 480000, outputTokens: 2300 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
  }));
  await h.flush();

  // Confirm previous session is at 94% Critical (danger red ring + 482.3K / 512K)
  assert.equal(h.host.getAttribute('data-occupancy'), 'danger');
  assert.equal(h.elements.get('badge-pct-val').textContent, '94%');
  assert.equal(h.elements.get('ring-fill').getAttribute('data-ring-state'), 'determinate');
  assert.equal(h.elements.get('key-hero-pct').textContent, '94%');
  assert.equal(h.elements.get('key-badge').textContent, '紧张');
  assert.equal(h.elements.get('key-used').textContent, '482.3K (94.2%)');
  assert.equal(h.elements.get('key-limit').textContent, '512K');

  // 1. Switch to New Session (no route: '/')
  h.sandbox.location.pathname = '/';
  h.tick();

  assert.equal(h.host.getAttribute('data-has-session'), 'false');
  assert.equal(h.host.getAttribute('data-occupancy'), 'normal');
  assert.equal(h.elements.get('ring-fill').getAttribute('data-ring-state'), 'idle');
  assert.equal(h.elements.get('ring-fill').style.opacity, '0');
  assert.match(h.elements.get('ring-fill').getAttribute('stroke-dasharray'), /^0 /);
  assert.equal(h.elements.get('badge-pct-val').textContent, '--%');
  assert.equal(h.elements.get('overflow-context-val').textContent, '--%');

  // Popover summary card must NOT show stale 94% / 482.3K / 512K / Critical
  assert.equal(h.elements.get('key-bar-fill').style.width, '0%');
  assert.equal(h.elements.get('key-hero-pct').hidden, false);
  assert.equal(h.elements.get('key-hero-pct').textContent, '--%');
  assert.equal(h.elements.get('key-hero-pct').getAttribute('data-tone'), 'muted');
  assert.equal(h.elements.get('key-badge').textContent, '新会话');
  assert.equal(h.elements.get('key-badge').className, 'key-pill pill-muted');
  assert.equal(h.elements.get('key-used').textContent, '0');
  assert.equal(h.elements.get('key-limit').textContent, '—');
  assert.equal(h.elements.get('key-remaining').textContent, '—');
  assert.equal(h.elements.get('key-takeaway').hidden, false);
  assert.match(h.elements.get('key-takeaway').textContent, /尚未开始会话/);
  assert.equal(h.elements.get('round-cost-bar').hidden, true);
  assert.equal(h.elements.get('latest-call-card').hidden, true);

  // Tooltip and technical drawer must NOT retain previous session's data
  assert.equal(h.elements.get('ctx-tip-pct').textContent, '新会话 · 尚未开始');
  assert.match(h.elements.get('ctx-tip-detail').textContent, /发送首条消息/);
  assert.equal(h.elements.get('model').textContent, '');
  assert.equal(h.elements.get('request-status').textContent, '尚未开始会话');
  assert.equal(h.elements.get('actual').textContent, '—');
  assert.equal(h.elements.get('budget').textContent, '—');
  assert.equal(h.elements.get('percent').textContent, '—');
  assert.equal(h.elements.get('steps').textContent, '—');
  assert.equal(h.elements.get('refresh').disabled, true);
  assert.match(h.elements.get('files').children[0].textContent, /未打开会话/);

  // Language switch to EN while on new session updates all empty-state labels cleanly
  await api.setPanelLanguage('en', { persist: false });
  assert.equal(h.elements.get('key-badge').textContent, 'New Session');
  assert.equal(h.elements.get('ctx-tip-pct').textContent, 'New session · Not started');
  assert.match(h.elements.get('key-takeaway').textContent, /No active session yet/);
  await api.setPanelLanguage('zh-CN', { persist: false });

  // 2. Switch to a brand-new empty session WITH a UUID route (/c/22222222-...)
  h.sandbox.location.pathname = '/c/22222222-2222-2222-2222-222222222222';
  h.tick();
  // Immediately while loading: neutral reading state (never "本地估算" without an estimate)
  assert.equal(h.host.getAttribute('data-occupancy'), 'normal');
  assert.equal(h.elements.get('key-badge').textContent, '读取中');
  assert.equal(h.elements.get('key-used').textContent, '—');
  assert.match(h.elements.get('key-takeaway').textContent, /正在读取当前会话/);

  // Poll resolves with 0 generatorMetadata rows & scan resolves with 0 steps
  const emptyPoll = h.pending.at(-1);
  emptyPoll.resolve({ ok: true, status: 200, json: async () => ({ generatorMetadata: [] }) });
  h.scans.at(-1).resolve({
    ok: true,
    data: {
      scannedAt: Date.now(),
      latest: null,
      session: {
        steps: 0,
        userMessages: 0,
        assistantMessages: 0,
        total: { chars: 0, bytes: 0, low: 0, high: 0 },
        groups: { user: { low: 0, high: 0 }, assistant: { low: 0, high: 0 }, thinking: { low: 0, high: 0 }, tools: { low: 0, high: 0 }, summaries: { low: 0, high: 0 } },
        attachments: [],
        unknownFiles: 0
      }
    }
  });
  await h.flush();

  assert.equal(h.host.getAttribute('data-occupancy'), 'normal');
  assert.equal(h.elements.get('ring-fill').getAttribute('data-ring-state'), 'idle');
  assert.equal(h.elements.get('ring-fill').style.opacity, '0');
  assert.equal(h.elements.get('badge-pct-val').textContent, '--%');
  assert.equal(h.elements.get('key-hero-pct').textContent, '--%');
  assert.equal(h.elements.get('key-hero-pct').getAttribute('data-tone'), 'muted');
  assert.equal(h.elements.get('key-badge').textContent, '未开始');
  assert.equal(h.elements.get('key-used').textContent, '0');
  assert.equal(h.elements.get('key-limit').textContent, '—');
  assert.equal(h.elements.get('key-remaining').textContent, '—');
  assert.match(h.elements.get('key-takeaway').textContent, /尚无对话记录/);
  assert.equal(h.elements.get('ctx-tip-pct').textContent, '空会话 · 尚未发送消息');
  assert.equal(h.elements.get('request-status').textContent, '尚无请求记录');
  assert.equal(h.elements.get('refresh').disabled, false);

  api.dispose();
});

test('API Est. Cost defaults to hybrid actual-model pricing and renders actual per-category card costs without flat-rate labels', async () => {
  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 10000, outputTokens: 1000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const core = require('./meter-core');
  // gemini-4-carbon (2026-11-18): $2.00 / $0.10 / $10.00 per 1M -> in $20, cache $10, out $10 = $40
  const calls = [
    { model: 'gemini-4-carbon', date: '2026-11-18', inputTokens: 10000000, cacheTokens: 100000000, outputTokens: 1000000 }
  ];
  const ce = core.summarizeApiCost(calls, 1, { unsupportedModel: 1 }, 22200000);
  // Total includes residual 2M input, 20M cache, 200K output (unpriced -> 3.8 Flash: $1.50 + $1.50 + $0.75 = $3.75)
  const refMonth = core.calculateReferenceModelCost(
    { inputTokens: 12000000, cacheTokens: 120000000, outputTokens: 1200000, totalTokens: 133200000 },
    'gemini-3.8-flash',
    { pricingDate: '2026-11-18', mode: 'all' }
  );
  const refMonthHybrid = core.calculateReferenceModelCost(
    { inputTokens: 12000000, cacheTokens: 120000000, outputTokens: 1200000, totalTokens: 133200000 },
    'gemini-3.8-flash',
    { pricingDate: '2026-11-18', mode: 'unpriced_only', knownUsage: { byCategory: ce.byCategory, costUSD: ce.pricedCostUSD } }
  );

  h.sandbox.__AGContextMeter.applyTokenHistoryPayload({
    updatedAt: '2026-11-18 12:00:00',
    currentPeriod: { key: '2026-11', label: '2026-11 (自然月)', isCurrentMonth: true },
    summary: {
      grandTotalTokens: 133200000,
      totalInputTokens: 12000000,
      totalCacheTokens: 120000000,
      totalOutputTokens: 1200000,
      monthTokens: 133200000,
      currentMonthInput: 12000000,
      currentMonthCache: 120000000,
      currentMonthOutput: 1200000
    },
    costEstimate: ce,
    costEstimateCurrentMonth: ce,
    referenceCost: {
      all: refMonth,
      currentMonth: refMonth,
      hybrid: refMonthHybrid,
      currentMonthHybrid: refMonthHybrid
    }
  });

  h.elements.get('badge-tokens').click();
  h.elements.get('tok-view-cost').click();

  // 1) Default mode is hybrid: actual carbon ($40.00) + residual 3.8 Flash ($3.75) = $43.75 (NOT $22.50 reference-only)
  assert.equal(h.elements.get('cost-grand-val').textContent, '$43.75');
  assert.equal(h.elements.get('ref-cost-input-val').textContent, '$21.50');
  assert.equal(h.elements.get('ref-cost-cache-val').textContent, '$11.50');
  assert.equal(h.elements.get('ref-cost-output-val').textContent, '$10.75');
  assert.equal(h.elements.get('ref-cost-input-rate').style.display, 'none');
  assert.match(h.elements.get('cost-breakdown-info').textContent, /Gemini 4 Carbon \$40\.00/);

  // 2) Switch to Identified only: actual carbon ($40.00), cards show actual carbon category costs ($20 / $10 / $10)
  h.elements.get('cost-btn-mode-identified').click();
  assert.equal(h.elements.get('cost-grand-val').textContent, '$40.00');
  assert.equal(h.elements.get('ref-cost-input-val').textContent, '$20.00');
  assert.equal(h.elements.get('ref-cost-cache-val').textContent, '$10.00');
  assert.equal(h.elements.get('ref-cost-output-val').textContent, '$10.00');
  assert.equal(h.elements.get('ref-cost-input-rate').style.display, 'none');

  // 3) Switch to Reference model: flat 3.8 Flash ($22.50 = $9.00 + $9.00 + $4.50) and flat-rate labels shown
  h.elements.get('cost-btn-mode-ref').click();
  assert.equal(h.elements.get('cost-grand-val').textContent, '$22.50');
  assert.equal(h.elements.get('ref-cost-input-val').textContent, '$9.00');
  assert.equal(h.elements.get('ref-cost-cache-val').textContent, '$9.00');
  assert.equal(h.elements.get('ref-cost-output-val').textContent, '$4.50');
  assert.equal(h.elements.get('ref-cost-input-rate').style.display, '');

  h.sandbox.__AGContextMeter.dispose();
});

test('API Est. Cost supports subscription billing cycle toggle and explains unpriced models', async () => {
  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 10000, outputTokens: 1000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const today = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const todayYmd = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  h.sandbox.__AGContextMeter.applyTokenHistoryPayload({
    updatedAt: `${todayYmd} 12:00:00`,
    currentPeriod: { key: todayYmd.slice(0, 7), label: `${todayYmd.slice(0, 7)} (自然月)`, isCurrentMonth: true },
    summary: {
      grandTotalTokens: 33300000,
      totalInputTokens: 3000000,
      totalCacheTokens: 30000000,
      totalOutputTokens: 300000,
      monthTokens: 33300000,
      currentMonthInput: 3000000,
      currentMonthCache: 30000000,
      currentMonthOutput: 300000
    },
    dailyMap: {
      [todayYmd]: { input: 3000000, cache: 30000000, output: 300000, total: 33300000 }
    },
    dailyCostMap: {
      [todayYmd]: {
        pricedCostUSD: 4,
        inputCostUSD: 2,
        cacheCostUSD: 1,
        outputCostUSD: 1,
        inputTokens: 1000000,
        cacheTokens: 10000000,
        outputTokens: 100000,
        pricedTokens: 11100000,
        unpricedTokens: 22200000,
        pricedRequestsCount: 1,
        unpricedRequestsCount: 1,
        byModel: { 'gemini-4-carbon': { requests: 1, costUSD: 4, tokens: 11100000 } },
        unpricedByModel: { 'Gemini 4 Neon': { requests: 1, tokens: 22200000 } }
      }
    }
  });

  h.elements.get('badge-tokens').click();
  h.elements.get('tok-view-cost').click();
  h.elements.get('cost-btn-scope-cycle').click();

  assert.equal(h.elements.get('cost-billing-day-row').style.display, 'flex');
  assert.equal(h.elements.get('cost-card-title').textContent, '本周期 API 参考金额');
  // Carbon $4.00 + residual Neon (2M in $1.50 + 20M cache $1.50 + 200K out $0.75 = $3.75) = $7.75
  assert.equal(h.elements.get('cost-grand-val').textContent, '$7.75');
  assert.match(h.elements.get('cost-breakdown-info').textContent, /Gemini 4 Carbon \$4\.00/);
  assert.match(h.elements.get('cost-breakdown-info').textContent, /Gemini 4 Neon/);

  h.sandbox.__AGContextMeter.dispose();
});
