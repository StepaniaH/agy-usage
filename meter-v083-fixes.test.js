const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('./meter-core');

// 引入构建后的 renderer 脚本进行纯隔离测试
const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function createTestHarness(options = {}) {
  const elements = new Map();
  const docElements = new Map();
  const listeners = new Map();

  const makeElement = (tag = 'div') => {
    const attrs = new Map();
    const props = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      style: {
        display: '',
        opacity: '',
        cssText: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      children,
      hidden: false,
      textContent: '',
      innerHTML: '',
      disabled: false,
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      get childNodes() { return this.children; },
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
        },
        toggle(c, force) {
          if (force !== undefined) {
            if (force) this.add(c); else this.remove(c);
          } else {
            if (this.contains(c)) this.remove(c); else this.add(c);
          }
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        const elListeners = listeners.get(el);
        if (!elListeners.has(type)) elListeners.set(type, []);
        elListeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const elListeners = listeners.get(el);
        if (!elListeners || !elListeners.has(type)) return;
        const list = elListeners.get(type);
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      },
      trigger(type, event = {}) {
        const elListeners = listeners.get(el);
        const handlers = elListeners?.get(type) || [];
        for (const handler of handlers) handler(event);
      },
      click() { this.trigger('click'); },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id' && v) docElements.set(String(v), el);
        if (k === 'class') attrs.set('class', String(v || ''));
      },
      getAttribute(k) { return attrs.get(k) ?? null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(child) {
        children.push(child);
        child.parentElement = el;
        child.parentNode = el;
        return child;
      },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx !== -1) children.splice(idx, 1);
        child.parentElement = null;
        child.parentNode = null;
        return child;
      },
      querySelector(sel) {
        return children.find(c => {
          if (sel.startsWith('#')) return c.id === sel.slice(1);
          if (sel.startsWith('.')) return c.classList.contains(sel.slice(1));
          return false;
        }) || null;
      },
      querySelectorAll() { return []; },
      replaceChildren() { this.children = []; },
      getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 }; }
    };
    return el;
  };

  const shadow = {
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      const el = makeElement('div');
      el.id = id;
      elements.set(id, el);
      return el;
    },
    querySelector(sel) {
      if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
      return null;
    },
    querySelectorAll() { return []; },
    appendChild() {},
    innerHTML: ''
  };

  const doc = {
    getElementById(id) {
      if (docElements.has(id)) return docElements.get(id);
      return shadow.getElementById(id);
    },
    querySelector(sel) {
      if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
      return null;
    },
    querySelectorAll() { return []; },
    createElement(tag) { return makeElement(tag); },
    body: makeElement('body'),
    documentElement: makeElement('html'),
    title: 'Workspace - Antigravity',
    addEventListener() {},
    removeEventListener() {}
  };

  const localStore = new Map();
  const localStorage = {
    getItem: k => localStore.get(k) || null,
    setItem: (k, v) => localStore.set(k, String(v)),
    removeItem: k => localStore.delete(k),
    clear: () => localStore.clear()
  };

  let restartCalled = false;
  const mockApi = {
    getSettings: async () => ({ ok: true, data: {} }),
    saveSettings: async (p) => ({ ok: true, data: p }),
    restartHost: async () => { restartCalled = true; return { ok: true }; },
    getModulesStatus: async () => ({ ok: true, data: { modules: { meter: { enabled: true } } } })
  };

  const intervals = [];
  const sandbox = {
    console,
    Date,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    JSON,
    AbortController,
    fetch: async () => ({ ok: false }),
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: () => {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: doc,
    window: {
      document: doc,
      localStorage,
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
      contextMeterAPI: mockApi,
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage,
    navigator: { platform: 'MacIntel' },
    __AGContextMeterCore: core,
    ANTIGRAVITY_TOKEN_DATA: {
      summary: { grandTotalTokens: 0, todayTokens: 0, monthTokens: 0, yearTokens: 0, totalConversations: 0 }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;

  const hostEl = makeElement('div');
  hostEl.remove = () => {};
  hostEl.attachShadow = () => shadow;
  doc.createElement = (tag) => {
    if (tag === 'div') return hostEl;
    return makeElement(tag);
  };

  if (typeof options?.setupSandbox === 'function') options.setupSandbox(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    sandbox,
    doc,
    elements,
    api: sandbox.__AGContextMeter,
    tick: () => intervals[0] && intervals[0](),
    getRestartCalled: () => restartCalled
  };
}

test('4 胶囊一对一专属浮层架构（模型额度 / 上下文窗口 / 生成速度 / 累计用量）与独立设置视图、三语言标题统一', async () => {
  const h = createTestHarness();
  const api = h.api;

  const btnSession = h.elements.get('tab-ctx-session');
  const btnModels = h.elements.get('tab-ctx-models');
  const btnSettings = h.elements.get('btn-ctx-settings');
  assert.ok(btnSession && btnModels && btnSettings, '上下文浮层轻量双切换与顶栏设置入口必须存在');

  api.setPanelLanguage('zh-CN');
  assert.equal(api.translateForTest('quota.popover.title'), '模型额度');
  assert.equal(api.translateForTest('context.popover.title'), '上下文窗口');
  assert.equal(api.translateForTest('speed.popover.title'), '生成速度');
  assert.equal(api.translateForTest('tokens.popover.title'), '累计 Token 用量');
  api.setPanelLanguage('zh-TW');
  assert.equal(api.translateForTest('quota.popover.title'), '模型額度');
  assert.equal(api.translateForTest('context.popover.title'), '上下文視窗');
  api.setPanelLanguage('en');
  assert.equal(api.translateForTest('speed.popover.title'), 'Output Speed');
  assert.equal(api.translateForTest('tokens.popover.title'), 'Cumulative Usage');

  // 点额度时绝不显示上下文的 [当前会话 | 窗口规格] 切换条，标题只显示“Model Quota”
  h.elements.get('badge-quota').click();
  assert.equal(h.elements.get('ctx-tabs-bar').hidden, true);
  assert.equal(h.elements.get('panel-main-title').textContent, 'Model Quota');

  btnSettings.click();
  const st = api.getContextPreferencesState();
  assert.equal(st.activeContextTab, 'settings', '当前活动视图应为 settings');
  assert.equal(h.elements.get('pane-ctx-settings').hidden, false, '配置页应显示');
  h.elements.get('btn-ctx-settings-back').click();
  assert.equal(h.elements.get('panel-quota').hidden, false, '点击返回恢复刚才的额度专属浮层');
  h.api.dispose();
});

test('顶部三语言「简｜繁｜EN」分段按钮即时切换与持久化', async () => {
  const h = createTestHarness();
  const api = h.api;

  const btnTopZh = h.elements.get('btn-top-lang-zh-CN');
  const btnTopTw = h.elements.get('btn-top-lang-zh-TW');
  const btnTopEn = h.elements.get('btn-top-lang-en');
  assert.ok(btnTopZh && btnTopTw && btnTopEn, '顶部必须存在三语言独立分段按钮');

  btnTopTw.click();
  assert.equal(api.getPanelLanguage(), 'zh-TW');
  assert.equal(btnTopTw.classList.contains('active'), true);
  assert.equal(btnTopZh.classList.contains('active'), false);
  assert.equal(h.sandbox.localStorage.getItem('ag_panel_language'), 'zh-TW');

  btnTopEn.click();
  assert.equal(api.getPanelLanguage(), 'en');
  assert.equal(btnTopEn.classList.contains('active'), true);
  assert.equal(btnTopTw.classList.contains('active'), false);
  assert.equal(h.sandbox.localStorage.getItem('ag_panel_language'), 'en');

  btnTopZh.click();
  assert.equal(api.getPanelLanguage(), 'zh-CN');
  assert.equal(btnTopZh.classList.contains('active'), true);
  assert.equal(h.sandbox.localStorage.getItem('ag_panel_language'), 'zh-CN');
  h.api.dispose();
});

test('极简纯 USD 订阅卡片英文与繁体无中文残留且不含 CNY 折合', async () => {
  const h = createTestHarness();
  const api = h.api;

  const testPlan = {
    tierName: 'Google AI Pro',
    status: 'identified',
    actualPricePaid: 19.99,
    priceMode: 'custom',
    hasCustomSettings: true,
    currency: 'USD',
    currencySymbol: '$'
  };

  api.setTokenHistoryForTest({
    summary: { grandTotalTokens: 10000, todayTokens: 1000 },
    planStatus: testPlan
  });
  api.setPanelLanguage('en');

  const detPrice = h.elements.get('p-det-price');
  const detTag = h.elements.get('p-det-price-tag');
  assert.equal(detPrice.textContent, '$19.99/mo');
  assert.equal(/月付|折合|CNY/.test(detPrice.textContent), false);
  assert.equal(/用户实付|公开参考/.test(detTag.textContent), false);

  api.setPanelLanguage('zh-TW');
  assert.match(detPrice.textContent, /\$19\.99\/月/);
  h.api.dispose();
});

test('冷启动与连续5次会话切换性能隔离：切路由不强刷全量历史、加载中可开关面板且不泄露旧会话数值', async () => {
  const historyCalls = [];
  const pendingHistory = [];
  const pendingScans = [];
  const pendingFetches = [];
  const listeners = new Map();
  const elements = new Map();
  const docElements = new Map();

  const makeEl = (tag = 'div') => {
    const attrs = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      style: { display: '', opacity: '', cssText: '', setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
      children,
      hidden: false,
      textContent: '',
      innerHTML: '',
      disabled: false,
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v)); if (v) docElements.set(String(v), el); },
      get childNodes() { return this.children; },
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') docElements.set(String(v), el); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(type, fn) { if (!listeners.has(el)) listeners.set(el, new Map()); listeners.get(el).set(type, fn); },
      removeEventListener() {},
      appendChild(c) { children.push(c); return c; },
      replaceChildren() { this.children = []; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      click() { listeners.get(el)?.get('click')?.({ preventDefault() {}, stopPropagation() {} }); },
      getBoundingClientRect() { return { top: 8, left: 600, right: 680, bottom: 32, width: 80, height: 24 }; }
    };
    return el;
  };

  const shadow = {
    innerHTML: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const el = makeEl('div');
        el.id = id;
        if (id.startsWith('panel-')) el.hidden = true;
        elements.set(id, el);
      }
      return elements.get(id);
    },
    querySelector(sel) { return sel.startsWith('#') ? this.getElementById(sel.slice(1)) : null; },
    querySelectorAll() { return []; }
  };

  const hostEl = makeEl('div');
  hostEl.remove = () => {};
  hostEl.attachShadow = () => shadow;
  const intervals = [];
  const doc = {
    getElementById: id => docElements.get(id) || shadow.getElementById(id),
    querySelector: sel => sel.startsWith('#') ? doc.getElementById(sel.slice(1)) : null,
    querySelectorAll: () => [],
    createElement: (() => { let first = true; return tag => { if (first) { first = false; return hostEl; } return makeEl(tag); }; })(),
    body: makeEl('body'),
    documentElement: makeEl('html'),
    addEventListener() {},
    removeEventListener() {},
    hidden: false
  };
  const sandbox = {
    console, Date, Math, String, Number, Boolean, Array, Object, RegExp, JSON, AbortController,
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: doc,
    window: {
      __APP_CONFIG__: { csrfToken: 'test-csrf' },
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
      document: doc,
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
      contextMeterAPI: {
        getSettings: async () => ({ ok: true, data: {} }),
        getTokenHistory: force => new Promise(resolve => {
          historyCalls.push(Boolean(force));
          pendingHistory.push(resolve);
        }),
        getQuota: () => new Promise(() => {}),
        scan: id => new Promise(resolve => pendingScans.push({ id, resolve }))
      }
    },
    localStorage: { getItem: k => (k === 'ag_panel_language' ? 'zh-CN' : null), setItem() {}, removeItem() {} },
    __AGContextMeterCore: core,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    fetch(url, opts) { return new Promise(resolve => pendingFetches.push({ url, opts, resolve })); }
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const api = sandbox.__AGContextMeter;
  try {
    assert.equal(historyCalls.length, 1);
    assert.equal(historyCalls[0], false, '冷启动历史采集必须使用非强制 force=false');
    const initialPercentText = elements.get('percent').textContent;
    const initialAmountText = elements.get('amount').textContent;
    assert.match(initialAmountText, /真实量未知/);

    elements.get('badge').click();
    assert.equal(elements.get('panel').hidden, false, '历史与扫描未返回时上下文面板仍须立即打开');
    elements.get('badge').click();
    assert.equal(elements.get('panel').hidden, true, '上下文面板须可立即关闭');

    elements.get('badge-quota').click();
    assert.equal(elements.get('panel-quota').hidden, false, '额度未就绪时额度面板仍须立即打开');
    elements.get('badge-quota').click();

    pendingHistory[0]({
      ok: true,
      data: {
        updatedAt: '2026-11-16 04:00:00',
        summary: { grandTotalTokens: 123456, todayTokens: 5000, monthTokens: 50000, yearTokens: 123456 },
        dailyMap: { '2026-11-16': { total: 5000, input: 4000, cache: 500, output: 500, steps: 2 } }
      }
    });
    await new Promise(r => setTimeout(r, 15));

    pendingFetches[0].resolve({
      ok: true,
      json: async () => ({
        generatorMetadata: [{ chatModel: { usage: { inputTokens: 80000 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } } } }]
      })
    });
    await new Promise(r => setTimeout(r, 15));
    assert.match(elements.get('percent').textContent, /^40\.0%/);
    assert.match(elements.get('amount').textContent, /80K \(40%\)/);

    elements.get('badge-tokens').click();
    assert.equal(elements.get('panel-tokens').hidden, false);
    assert.equal(historyCalls.length, 1, '打开 Token 面板复用有效缓存，不重新全盘重扫');

    const routes = ['22222222', '33333333', '44444444', '55555555', '66666666'];
    for (const r of routes) {
      const p = `/c/${r}-1111-1111-1111-111111111111`;
      sandbox.location.pathname = p;
      sandbox.window.location.pathname = p;
      intervals[0]();
      assert.equal(elements.get('percent').textContent, initialPercentText, `切至 ${r} 瞬间绝不能残留上个会话的 40%`);
      assert.match(elements.get('amount').textContent, /真实量未知/, `切至 ${r} 瞬间须立即显示真实量未知`);
      assert.equal(api.snapshot().latest, null);
    }
    assert.equal(historyCalls.includes(true), false, '连续 5 次切路由绝不能触发强制 getTokenHistory(true)');
    assert.equal(historyCalls.length, 1, '切路由期间不得新增任何全量历史重扫');

    const oldScan = pendingScans[0];
    oldScan.resolve({
      ok: true,
      data: {
        conversation: oldScan.id,
        scannedAt: Date.now() + 9999,
        latest: { actual: 199000, max: 200000, percent: 99, limitType: 'default' },
        session: { userMessages: 10, assistantMessages: 10, groups: {}, total: { chars: 100, low: 10, high: 20 }, attachments: [], unknownFiles: 0, complete: true }
      }
    });
    await new Promise(r => setTimeout(r, 15));
    assert.equal(api.snapshot().latest, null, '旧会话迟到 scan 不得覆盖新会话 66666666');
    assert.equal(elements.get('percent').textContent, initialPercentText);
  } finally {
    api.dispose();
  }
});

test('collectTokenHistoryAsync 后台 Worker 隔离执行、保持主线程低停顿且返回一致汇总', async () => {
  const os = require('node:os');
  const { collectTokenHistoryAsync } = require('./meter-collector');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-worker-hist-'));
  const brainDir = path.join(tempDir, 'brain', '11111111-1111-1111-1111-111111111111');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(brainDir, 'transcript.jsonl'), [
    JSON.stringify({
      created_at: '2026-11-16T02:00:00.000Z',
      model: 'gemini-3.8-flash',
      chatModel: {
        usage: { inputTokens: 1500, cacheReadTokens: 500, outputTokens: 300, responseId: 'resp_worker_test_1' }
      }
    })
  ].join('\n'), 'utf8');

  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - last - 10;
    if (gap > maxGap) maxGap = gap;
    last = now;
  }, 10);

  try {
    const res = await collectTokenHistoryAsync({
      agDir: tempDir,
      agCliDir: path.join(tempDir, 'nonexistent-cli'),
      force: true,
      userStatus: null
    });
    assert.equal(res.summary.grandTotalTokens, 2300);
    assert.equal(res.summary.totalInputTokens, 1500);
    assert.equal(res.summary.totalCacheTokens, 500);
    assert.equal(res.summary.totalOutputTokens, 300);
    assert.ok(fs.existsSync(path.join(tempDir, 'token_usage_archive_v2.json')), 'Worker 路径必须完成 v2 归档持久化');
    assert.ok(maxGap < 500, `Worker 执行期间主线程事件循环停顿过大: ${maxGap.toFixed(1)}ms`);
  } finally {
    clearInterval(timer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recordModelCallsAsync 后台 Worker 串行入账与 O(S+R) 索引化消重在大规模账本下不阻塞主线程', async () => {
  const os = require('node:os');
  const { performance } = require('node:perf_hooks');
  const { recordModelCalls, recordModelCallsAsync, loadPricingLedger } = require('./meter-collector');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-record-async-'));

  try {
    const seedCalls = [];
    for (let i = 0; i < 2000; i++) {
      seedCalls.push({
        callId: `resp_bulk_${i}`,
        source: 'desktop',
        cascadeId: `conv-bulk-${i % 40}`,
        stepIndex: i,
        model: 'gemini-3.8-flash',
        inputTokens: 1000 + i,
        cacheTokens: 200,
        outputTokens: 150,
        status: 'final',
        created_at: '2026-11-16T01:00:00.000Z'
      });
    }
    const seedRes = recordModelCalls(seedCalls, { agDir: tempDir });
    assert.equal(seedRes.ok, true);

    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const gap = now - last - 10;
      if (gap > maxGap) maxGap = gap;
      last = now;
    }, 10);

    try {
      const incoming = [
        {
          callId: 'conv-bulk-7#7',
          source: 'desktop',
          cascadeId: 'conv-bulk-7',
          stepIndex: 7,
          model: 'gemini-3.8-flash',
          inputTokens: 1007,
          cacheTokens: 200,
          outputTokens: 150,
          status: 'final',
          created_at: '2026-11-16T01:00:00.000Z'
        },
        {
          callId: 'resp_async_new_9999',
          source: 'desktop',
          cascadeId: 'conv-bulk-7',
          stepIndex: 99,
          model: 'gemini-3.8-flash',
          inputTokens: 5500,
          cacheTokens: 500,
          outputTokens: 420,
          status: 'final',
          created_at: '2026-11-16T02:30:00.000Z'
        }
      ];
      const r1 = await recordModelCallsAsync(incoming, { agDir: tempDir });
      assert.equal(r1.ok, true);
      assert.equal(r1.changed, true);

      const r2 = await recordModelCallsAsync([seedCalls[0]], { agDir: tempDir });
      assert.equal(r2.ok, true);
      assert.equal(r2.changed, false);

      const after = loadPricingLedger(tempDir);
      assert.ok(after.calls['resp_async_new_9999'], '新增记录必须持久化至账本');
      assert.equal(after.calls['conv-bulk-7#7'], undefined, '重复 step fallback 应被准确消重合并');
      assert.ok(maxGap < 500, `recordModelCallsAsync 不应阻塞主线程事件循环: maxGap=${maxGap.toFixed(1)}ms`);
    } finally {
      clearInterval(timer);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('analyzeSteps 工具步骤流式统计与 getKnownModelProducts 缓存命中及配置变更失效验证', async () => {
  const { analyzeSteps } = require('./meter-core');
  const stepResult = analyzeSteps([
    {
      userInput: { userResponse: '你好 Antigravity' }
    },
    {
      toolCall: {
        name: 'run_cmd',
        args: { command: 'echo hello', nested: ['a', 'b', 123, true] },
        metadata: 'should_be_skipped'
      },
      type: 'TOOL_CALL',
      media: [{ uri: 'file:///tmp/demo.png', mimeType: 'image/png', description: 'demo' }]
    }
  ]);
  assert.ok(stepResult.groups.tools.chars > 0);
  assert.ok(stepResult.groups.tools.bytes >= stepResult.groups.tools.chars);
  assert.equal(stepResult.media.length, 1, '工具步骤顶层 media 仍需计入附件清单');
  assert.equal(stepResult.media[0].name, 'demo');

  const h = createTestHarness();
  try {
    h.api.setSpeedRecordsForTest([
      { callId: 'sp1', modelExactId: 'gemini-3.8-flash', model: 'Gemini 3.8 Flash', durationSec: 1.1, tps: 80 },
      { callId: 'sp2', modelExactId: 'gemini-3.8-flash', model: 'Gemini 3.8 Flash', durationSec: 1.2, tps: 82 }
    ], [
      { callId: 'sc1', modelExactId: 'gemini-4-carbon', model: 'Gemini 4 Carbon' }
    ]);
    const list1 = h.api.getKnownModelProductsForTest();
    const list2 = h.api.getKnownModelProductsForTest();
    assert.ok(list1.some(p => p.productKey.includes('gemini-4-carbon')));
    assert.equal(list1.length, list2.length);
    list1[0].members.push({ modelId: 'mutated-clone' });
    const list3 = h.api.getKnownModelProductsForTest();
    assert.ok(!list3[0].members.some(m => m.modelId === 'mutated-clone'), '缓存返回副本不应被外部数组修改污染');

    h.api.setModelCapabilitiesForTest({
      'gemini-4-carbon': { maxTokens: 1000000, maxOutputTokens: 65536 }
    });
    const list4 = h.api.getKnownModelProductsForTest();
    const carbonProd = list4.find(p => p.productKey.includes('gemini-4-carbon'));
    assert.ok(carbonProd);
    assert.equal(carbonProd.members[0].maxTokens, 1000000, '能力表变更必须立即穿透产品缓存');
  } finally {
    h.api.dispose();
  }
});

test('SPA history.pushState 切换路由在微任务内立即清除旧会话显示且 dispose 还原原生 history', async () => {
  let sbRef = null;
  const rawPush = function (_s, _t, url) {
    if (typeof url === 'string' && sbRef) {
      sbRef.location.pathname = url;
      sbRef.window.location.pathname = url;
    }
  };
  const rawReplace = function (_s, _t, url) {
    if (typeof url === 'string' && sbRef) {
      sbRef.location.pathname = url;
      sbRef.window.location.pathname = url;
    }
  };
  const h = createTestHarness({
    setupSandbox(sb) {
      sbRef = sb;
      sb.history = { pushState: rawPush, replaceState: rawReplace };
    }
  });
  try {
    h.api.setContextLatestForTest({
      model: 'gemini-3.8-flash',
      contextUsed: 50000,
      contextLimit: 200000,
      inputTokens: 40000,
      outputTokens: 10000,
      totalTokens: 50000,
      hasChatModel: true,
      hasValidInput: true,
      isFinal: true
    });
    const beforeSnap = h.api.snapshot();
    assert.ok(beforeSnap.latest, '初始会话应有已加载数据');

    sbRef.history.pushState({}, '', '/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    await Promise.resolve();
    await Promise.resolve();
    const afterSnap = h.api.snapshot();
    assert.equal(afterSnap.route, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    assert.equal(afterSnap.latest, null, '切会话后未等待 500ms 定时器也必须在微任务内清空旧会话数据');
  } finally {
    h.api.dispose();
    assert.equal(sbRef.history.pushState, rawPush, 'dispose 应精确还原原始 pushState');
    assert.equal(sbRef.history.replaceState, rawReplace, 'dispose 应精确还原原始 replaceState');
  }
});
