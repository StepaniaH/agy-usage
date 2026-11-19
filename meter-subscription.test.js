'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const {
  loadCustomPlanSettings,
  savePluginSettings,
  getPluginSettings
} = require('./meter-collector');

const source = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

function session(unknown = 0) {
  return {
    groups: Object.fromEntries(['user', 'assistant', 'thinking', 'tools', 'summaries', 'system', 'definitions'].map(k => [k, core.empty()])),
    total: { chars: 100, low: 10, high: 50 },
    attachmentTotal: core.empty(),
    attachments: [],
    unknownFiles: unknown,
    steps: 10,
    userMessages: 2,
    assistantMessages: 3
  };
}

function harness(scanSession = session()) {
  const elements = new Map();
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
      children: [], hidden: false, textContent: '', value: '', checked: false, disabled: false,
      addEventListener(type, fn) {
        if (!listeners.has(el)) listeners.set(el, new Map());
        listeners.get(el).set(type, fn);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      remove() {},
      appendChild(x) { this.children.push(x); },
      replaceChildren() { this.children = []; },
      click() { listeners.get(el)?.get('click')?.(); },
      getBoundingClientRect() { return { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 }; },
      trigger(type, ev = {}) { listeners.get(el)?.get(type)?.(ev); }
    };
    return el;
  };
  const host = element();
  host.attachShadow = () => ({
    set innerHTML(_value) {},
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }
  });
  const pending = [], scans = [], timers = [];
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => element(),
      documentElement: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
      hidden: false
    },
    window: {
      __APP_CONFIG__: { csrfToken: 'test' },
      contextMeterAPI: {
        scan: id => new Promise(resolve => scans.push({ id, resolve })),
        getSettings: async () => ({ ok: true, customPlan: null }),
        saveSettings: async (req) => ({ ok: true, customPlan: req.customPlan || null })
      }
    },
    localStorage: { getItem: k => (k === 'ag_panel_language' ? 'zh-CN' : null), setItem() {}, removeItem() {} },
    __AGContextMeterCore: core,
    AbortController: global.AbortController,
    Date,
    setTimeout: (cb) => { if (typeof cb === 'function') setTimeout(cb, 0); return 1; },
    clearTimeout: () => {},
    setInterval(callback) { timers.push(callback); return 1; },
    clearInterval: () => {},
    fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); }
  };
  let first = true;
  sandbox.document.createElement = () => { if (first) { first = false; return host; } return element(); };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    sandbox,
    host,
    pending,
    scans,
    elements,
    tick: () => timers[0](),
    flush: () => new Promise(resolve => setImmediate(resolve)),
    finishScan(i = 0) {
      scans[i].resolve({ ok: true, data: { session: scanSession, scannedAt: Date.now(), latest: null } });
    }
  };
}

function response(chatModel) {
  return { ok: true, json: async () => ({ generatorMetadata: [{ chatModel }] }) };
}

test('极简月度实付（纯 USD）：$19.99、$0 免费与清除操作实时更新摘要、API 对照及无 CNY 噪音', async () => {
  const h = harness();
  h.finishScan();
  h.pending[0].resolve(response({
    usage: { inputTokens: 10000, outputTokens: 1000 },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
  }));
  await h.flush();

  const api = h.sandbox.__AGContextMeter;
  const nowYmd = new Date().toISOString().slice(0, 10);

  api.setTokenHistoryForTest({
    summary: { grandTotalTokens: 10000000, todayTokens: 1000000, monthTokens: 10000000 },
    dailyMap: {
      [nowYmd]: { total: 10000000, input: 4000000, cache: 5000000, output: 1000000, steps: 20 }
    },
    referenceCost: {
      currentMonth: { totalCostUSD: 70.00, inputCostUSD: 20, cacheCostUSD: 20, outputCostUSD: 30 },
      all: { totalCostUSD: 70.00, inputCostUSD: 20, cacheCostUSD: 20, outputCostUSD: 30 }
    },
    planStatus: {
      status: 'identified',
      tierKey: 'pro',
      tierName: 'Google AI Pro',
      email: 'test_user@enterprise.invalid',
      officialPriceMonthly: 19.99,
      actualPricePaid: null
    }
  });

  const priceVal = h.elements.get('plan-summary-price-val');
  const detPrice = h.elements.get('p-det-price');
  const detPriceTag = h.elements.get('p-det-price-tag');
  const spendInput = h.elements.get('input-monthly-spend-usd');

  // 1. 初始未设实付：展示官方公开参考 $19.99/月，无任何 ¥ / CNY 字样
  assert.equal(priceVal.textContent, '$19.99/月');
  assert.equal(detPrice.textContent, '$19.99/月');
  assert.equal(detPriceTag.textContent, '公开参考价');
  assert.doesNotMatch(h.elements.get('t-total-cost').textContent, /¥|CNY/);

  // 2. 用户填入月度实付 $14.00 并保存 -> $70.00 / $14.00 = 5.0x
  spendInput.value = '14';
  h.elements.get('btn-monthly-spend-save').click();
  await h.flush();

  assert.equal(priceVal.textContent, '$14/月');
  assert.equal(detPrice.textContent, '$14/月');
  assert.equal(detPriceTag.textContent, '实付');
  assert.equal(api.getPlanSettings().actualPricePaid, 14);
  assert.match(h.elements.get('cost-sub-line').textContent, /\$14\.00.*5\.0x/);

  // 3. 点击「设为 $0」 -> 免费/包含权益，不产生除以零 Infinity
  h.elements.get('btn-monthly-spend-free').click();
  await h.flush();
  assert.equal(priceVal.textContent, '$0/月');
  assert.equal(api.getPlanSettings().actualPricePaid, 0);
  assert.equal(api.getPlanSettings().isZeroExtraCost, true);
  assert.doesNotMatch(h.elements.get('cost-sub-line').textContent, /Infinity|NaN/);

  // 4. 点击「清除」 -> 恢复公开参考状态
  h.elements.get('btn-monthly-spend-clear').click();
  await h.flush();
  assert.equal(api.getPlanSettings().actualPricePaid, null);
  assert.equal(detPriceTag.textContent, '公开参考价');

  api.dispose();
});

test('并发 restoreSettingsFromHost 与倒序回包防护，用户最新保存的 USD 实付不被旧恢复覆盖', async () => {
  const h = harness();
  const api = h.sandbox.__AGContextMeter;

  let resolveSlowGet = null;
  h.sandbox.window.contextMeterAPI.getSettings = () => new Promise(resolve => {
    resolveSlowGet = resolve;
  });

  // 发起一个慢速恢复请求
  const restorePromise = api.restoreSettingsForTest();

  // 在慢速恢复返回之前，用户主动保存月度实付 $9.99
  api.saveMonthlySpendUSD(9.99);
  await h.flush();
  assert.equal(api.getPlanSettings().actualPricePaid, 9.99);

  // 旧的恢复请求迟到返回旧值 $25.00 -> 必须被 userActionSeq 丢弃！
  resolveSlowGet({
    ok: true,
    customPlan: { account: 'default', currency: 'USD', actualPricePaid: 25, monthlySpendUSD: 25, priceMode: 'custom' }
  });
  await restorePromise;
  await h.flush();

  assert.equal(api.getPlanSettings().actualPricePaid, 9.99, '迟到的旧恢复回包绝不能覆盖用户最新输入');
  api.dispose();
});

test('独立配置目录持久化、多账号隔离与损坏配置自动恢复', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sub-usd-iso-'));
  try {
    const rA = savePluginSettings({
      email: 'alice@example.com',
      customPlan: { monthlySpendUSD: 19.99 }
    }, { agDir: tmpDir });
    assert.equal(rA.ok, true);
    assert.equal(rA.planStatus.actualPricePaid, 19.99);
    assert.equal(rA.planStatus.currency, 'USD');

    // 未配置账号 bob 严禁串用 alice 的实付配置
    const rBob = getPluginSettings({ agDir: tmpDir, email: 'bob@example.com' });
    assert.equal(rBob.customPlan, null);

    // bob 配置 $0 免费权益
    savePluginSettings({
      email: 'bob@example.com',
      customPlan: { monthlySpendUSD: 0 }
    }, { agDir: tmpDir });

    assert.equal(getPluginSettings({ agDir: tmpDir, email: 'alice@example.com' }).customPlan.actualPricePaid, 19.99);
    assert.equal(getPluginSettings({ agDir: tmpDir, email: 'bob@example.com' }).customPlan.actualPricePaid, 0);

    // 损坏文件自动备份恢复
    fs.writeFileSync(path.join(tmpDir, 'custom_plan_v1.json'), '{broken json', 'utf8');
    const recovered = loadCustomPlanSettings(tmpDir);
    assert.equal(recovered.recoveredFromCorruption, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
