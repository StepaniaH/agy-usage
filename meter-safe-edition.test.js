'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const core = require('./meter-core');
const collector = require('./meter-collector');

test('Safe Edition Invariant 1: 高危/中危、在线更新脚本及 Windows 专属文件已彻底移除', () => {
  const mustNotExist = [
    'meter-context-unlock.js',
    'meter-enhance.js',
    'macos-binary-utils.js',
    'unlock',
    'meter-accounts.js',
    'meter-proxy.js',
    'i18n',
    'src/i18n',
    'install.bat',
    'uninstall.bat',
    'scripts/cli-window-helper.exe',
    'scripts/cli-window-helper.cs',
    'scripts/macos-ci-verify.js',
    'scripts/auto_demo_record.js',
    'scripts/verify-isolated-update-sync.js',
    'meter-update-delivery.test.js'
  ];

  for (const rel of mustNotExist) {
    assert.equal(
      fs.existsSync(path.join(ROOT, rel)),
      false,
      `高危/中危、在线自更新或 Windows 专属文件不应存在: ${rel}`
    );
  }
});

test('Safe Edition Invariant 2: 100% 零外网请求、零请求预算篡改、零直连 Google OAuth/CloudCode、零二进制改写', () => {
  const rendererBundle = fs.readFileSync(path.join(ROOT, 'meter-renderer.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'meter-main.js'), 'utf8');
  const liveHostSrc = fs.readFileSync(path.join(ROOT, 'live-host.js'), 'utf8');
  const collectorSrc = fs.readFileSync(path.join(ROOT, 'meter-collector.js'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'meter-core.js'), 'utf8');

  const forbiddenInRenderer = [
    'WebSocket.prototype.send =',
    'XMLHttpRequest.prototype.send =',
    'SendUserCascadeMessage',
    '__AG_METER_ON_SEND_MESSAGE__',
    'cloudcode-pa.googleapis.com',
    'oauth2.googleapis.com',
    'api.github.com',
    'releases.atom',
    'applyContextUnlock',
    'applyEnhancePatch',
    'switchAccount',
    '/check-update',
    '/apply-update',
    'checkAppUpdate',
    'applyAppUpdate',
    'color-picker-popover',
    'SUBSCRIPTION_REGIONS_PRESET',
    'convertToCNY'
  ];
  for (const pattern of forbiddenInRenderer) {
    assert.equal(
      rendererBundle.includes(pattern),
      false,
      `meter-renderer.js 严禁包含已移除的外网/高危/冗余标识: ${pattern}`
    );
  }

  const forbiddenBackend = [
    'cloudcode-pa.googleapis.com',
    'oauth2.googleapis.com',
    'api.github.com',
    'releases.atom',
    'githubusercontent.com',
    'requestGithubUrl',
    'openSocks5Tunnel',
    'openHttpConnectTunnel',
    'checkUpdateAsync',
    'applyUpdateAsync',
    'context-meter:check-update',
    'context-meter:apply-update',
    '/check-update',
    '/apply-update',
    'meter-context-unlock',
    'meter-enhance',
    'meter-accounts',
    'meter-proxy',
    'win32'
  ];
  for (const [name, content] of [['meter-main.js', mainSrc], ['live-host.js', liveHostSrc], ['meter-collector.js', collectorSrc]]) {
    for (const pat of forbiddenBackend) {
      assert.equal(content.includes(pat), false, `${name} 严禁包含 ${pat}`);
    }
  }

  assert.equal(coreSrc.includes('SUBSCRIPTION_REGIONS_PRESET'), false);
  assert.equal(coreSrc.includes('SUBSCRIPTION_ACQUISITION_PRESETS'), false);
  assert.equal(coreSrc.includes('convertToCNY'), false);
  assert.equal(collector.checkUpdateAsync, undefined);
  assert.equal(collector.applyUpdateAsync, undefined);
  assert.equal(collector.requestGithubUrl, undefined);
});

test('Safe Edition Invariant 3: modular-installer 生成纯只读挂载代码（无 checkUpdate/applyUpdate），且升级/卸载干净剥离旧版标签', () => {
  const {
    TAGS,
    generateMeterUtilsCode,
    generateMeterPreloadCode,
    cleanUtilsSource,
    cleanPreloadSource
  } = require('./modular-installer');

  const utilsObj = generateMeterUtilsCode();
  const utilsCode = Object.values(utilsObj).join('\n');
  const preloadCode = generateMeterPreloadCode();

  assert.ok(utilsCode.includes(TAGS.METER_UTILS_START) && utilsCode.includes(TAGS.METER_UTILS_END));
  assert.equal(utilsCode.includes('ProxyNoTun'), false);
  assert.equal(utilsCode.includes('executeJavaScript'), false);

  assert.ok(preloadCode.includes(TAGS.METER_PRELOAD_START) && preloadCode.includes(TAGS.METER_PRELOAD_END));
  assert.equal(preloadCode.includes('executeJavaScript'), false);
  assert.equal(preloadCode.includes('SendUserCascadeMessage'), false);
  assert.equal(preloadCode.includes('Chinese Localization'), false);
  assert.equal(preloadCode.includes('__AGY_I18N'), false);
  assert.equal(preloadCode.includes('checkUpdate'), false);
  assert.equal(preloadCode.includes('applyUpdate'), false);

  const legacyUtils = [
    'const host = 1;',
    TAGS.PROXY_START,
    'require("./meter-proxy");',
    TAGS.PROXY_END,
    TAGS.METER_UTILS_START,
    'require("./meter-main");',
    TAGS.METER_UTILS_END
  ].join('\n');
  assert.equal(cleanUtilsSource(legacyUtils).trim(), 'const host = 1;');

  const legacyPreload = [
    'const hostPreload = true;',
    TAGS.CHINESE_START,
    'window.__AGY_I18N_CONFIG__ = {};',
    TAGS.CHINESE_END,
    TAGS.METER_PRELOAD_START,
    'require("./meter-core");',
    TAGS.METER_PRELOAD_END
  ].join('\n');
  assert.equal(cleanPreloadSource(legacyPreload).trim(), 'const hostPreload = true;');
});

test('Safe Edition Invariant 4: context-budget-engine 仅保留纯只读模型规格推导能力', () => {
  const engine = require('./src/renderer/context-budget-engine');
  assert.equal(typeof engine.deriveModelCapabilitySummary, 'function');
  assert.equal(typeof engine.stripModelEnumPrefix, 'function');
  assert.equal(typeof engine.modelEnumNumberToName, 'function');
  assert.equal(engine.mutateSendCascadeJsonBody, undefined);
  assert.equal(engine.mutateSendCascadeConnectFrame, undefined);
  assert.equal(engine.encodeVarint, undefined);

  const summary = engine.deriveModelCapabilitySummary({
    members: [
      { modelId: 'gemini-3-1-pro-high', effort: 'high', maxTokens: 1048576, maxOutputTokens: 65536, capabilitySources: ['get_available_models'] }
    ]
  });
  assert.equal(summary.maxTokens, 1048576);
  assert.equal(summary.maxOutputTokens, 65536);
  assert.equal(summary.modelTheoreticalMaxTokens, 983040);
  assert.equal(summary.stockDefaultBudget, 256000);
});

test('Safe Edition Invariant 5: 发布打包脚本仅面向 macOS 与 Linux', () => {
  const pkgScript = fs.readFileSync(path.join(ROOT, 'scripts', 'package-release.js'), 'utf8');
  assert.equal(pkgScript.includes('windows_amd64'), false);
  assert.equal(pkgScript.includes('windows_arm64'), false);
  assert.ok(pkgScript.includes('darwin_arm64'));
  assert.ok(pkgScript.includes('linux_amd64'));
});

test('Safe Edition Invariant 6: 极简纯 USD 月度实付、5 套精选配色与顶栏指标显隐保底防护', () => {
  // 1. 纯 USD 实付解析与遗留外币过滤
  const livePro = {
    status: 'identified',
    tierKey: 'pro',
    tierName: 'Google AI Pro',
    email: 'dev@example.com',
    officialPriceMonthly: 19.99
  };
  const effPaid = core.resolveEffectivePlanStatus(livePro, { email: 'dev@example.com', monthlySpendUSD: 19.99 });
  assert.equal(effPaid.currency, 'USD');
  assert.equal(effPaid.actualPricePaid, 19.99);
  assert.equal(effPaid.priceMode, 'custom');

  const effFree = core.resolveEffectivePlanStatus(livePro, { email: 'dev@example.com', monthlySpendUSD: 0 });
  assert.equal(effFree.actualPricePaid, 0);
  assert.equal(effFree.isZeroExtraCost, true);

  // 历史遗留非 USD 预设（如 29000 KRW）不得被误读为 $29,000 USD
  const effLegacyKrw = core.resolveEffectivePlanStatus(livePro, {
    email: 'dev@example.com',
    currency: 'KRW',
    actualPricePaid: 29000,
    priceMode: 'preset'
  });
  assert.equal(effLegacyKrw.actualPricePaid, null);
  assert.equal(effLegacyKrw.officialPriceMonthly, 19.99);

  // 2. 渲染层 5 套精选配色 + 顶栏指标显隐（至少保留 1 个面板入口）
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'meter-renderer.js'), 'utf8');
  const elements = new Map();
  const makeEl = () => {
    const attrs = new Map();
    const props = new Map();
    return {
      hidden: false,
      checked: true,
      disabled: false,
      value: '',
      textContent: '',
      children: [],
      style: {
        display: '',
        background: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener() {},
      removeEventListener() {},
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
    }
  });
  let first = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    document: {
      createElement: () => { if (first) { first = false; return host; } return makeEl(); },
      documentElement: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
      hidden: false
    },
    window: { __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: () => new Promise(() => {}) } },
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
  const api = sandbox.__AGContextMeter;

  try {
    for (const preset of ['violet', 'emerald', 'ocean', 'amber', 'graphite']) {
      assert.equal(api.setHeatPreset(preset), true);
      assert.equal(api.getHeatPreset(), preset);
      assert.equal(api.getHeatPalette().length, 5);
    }
    // 兼容旧版名称自动映射
    assert.equal(api.setHeatPreset('green'), true);
    assert.equal(api.getHeatPreset(), 'emerald');

    // 顶栏指标显隐：依次隐藏 quota, speed, tokens 均可成功，但尝试再隐藏最后一个面板入口 context 时必须拒绝
    assert.equal(api.setTopbarPillVisible('cli', false), true);
    assert.equal(elements.get('badge-cli').getAttribute('data-user-hidden'), 'true');
    assert.equal(api.setTopbarPillVisible('quota', false), true);
    assert.equal(api.setTopbarPillVisible('speed', false), true);
    assert.equal(api.setTopbarPillVisible('tokens', false), true);
    // 此时仅剩 context 一个面板入口，禁止关闭最后一个面板入口以防锁死
    assert.equal(api.setTopbarPillVisible('context', false), false);
    assert.equal(api.getTopbarPills().context, true);
    assert.equal(elements.get('badge').getAttribute('data-user-hidden'), null);
  } finally {
    api.dispose();
  }
});

test('Safe Edition Invariant 7: 四胶囊一对一纯粹专属浮层、无跨界总 Tab、动态 SVG 圆环保留与零右键切主题陷阱', () => {
  const tplHtml = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  // 1. 保留顶栏动态 SVG 进度圆环（#quota-ring-svg 与 #ring-svg），且无跨界四合一总 Tab 栏（#tab-wb-quota / #tab-wb-tokens 已移除）
  assert.equal(tplHtml.includes('id="quota-ring-svg"'), true, '必须保留额度动态 SVG 环状图');
  assert.equal(tplHtml.includes('id="ring-svg"'), true, '必须保留上下文动态 SVG 环状图');
  assert.equal(tplHtml.includes('id="tab-wb-quota"'), false, '禁止在专属浮层内放置跨界总 Tab');
  assert.equal(tplHtml.includes('id="tab-wb-tokens"'), false, '禁止在专属浮层内放置跨界总 Tab');
  assert.equal(tplHtml.includes('id="quota-plan-credits-card"'), true);
  assert.equal(tplHtml.includes('id="p-det-prompt-credits"'), false, '不应展示旧版静态占位 Prompt 池');
  assert.equal(tplHtml.includes('id="p-det-flow-credits"'), false, '不应展示旧版静态占位 Flow 池');
  assert.equal(tplHtml.includes('id="btn-cost-details-toggle"'), false);

  const vm = require('node:vm');
  const core = require('./meter-core');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'meter-renderer.js'), 'utf8');

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
      style: {
        left: '', top: '', right: '', maxWidth: '', maxHeight: '', transformOrigin: '', display: '',
        setProperty(k, v) { props.set(k, v); },
        removeProperty(k) { props.delete(k); },
        getPropertyValue(k) { return props.get(k) || ''; }
      },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
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
      trigger(type) {
        for (const fn of (listeners.get(type) || [])) fn({ preventDefault() {}, stopPropagation() {} });
      },
      appendChild() {},
      replaceChildren() {},
      remove() {},
      getBoundingClientRect: () => ({ left: 800, top: 8, right: 920, bottom: 36, width: 120, height: 28 })
    };
  };
  const host = makeEl();
  host.attachShadow = () => ({
    set innerHTML(_v) {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl());
      return elements.get(id);
    }
  });
  let first = true;
  const sandbox = {
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/22222222-2222-2222-2222-222222222222' },
    document: {
      createElement: () => { if (first) { first = false; return host; } return makeEl(); },
      documentElement: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
      hidden: false
    },
    window: { innerWidth: 1280, innerHeight: 800, __APP_CONFIG__: { csrfToken: 'test' }, contextMeterAPI: { scan: () => new Promise(() => {}) } },
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
  const api = sandbox.__AGContextMeter;

  try {
    // 2. 右键点击顶栏胶囊绝不静默切换主题
    assert.equal(api.getThemeMode(), 'auto');
    elements.get('badge').trigger('contextmenu');
    elements.get('badge-quota').trigger('contextmenu');
    elements.get('badge-speed').trigger('contextmenu');
    elements.get('badge-tokens').trigger('contextmenu');
    assert.equal(api.getThemeMode(), 'auto', '顶栏胶囊右键不得静默修改主题模式');

    // 3. 四个顶栏胶囊严格一对一展示对应专属标题与内容，互不串味（默认英文界面）
    assert.equal(api.getPanelLanguage(), 'en');
    elements.get('badge-quota').click();
    assert.equal(elements.get('panel-main-title').textContent, 'Model Quota');
    assert.equal(elements.get('panel-quota').hidden, false);
    assert.equal(elements.get('ctx-tabs-bar').hidden, true);

    elements.get('badge-speed').click();
    assert.equal(elements.get('panel-main-title').textContent, 'Output Speed');
    assert.equal(elements.get('pane-ctx-speed').hidden, false);
    assert.equal(elements.get('ctx-tabs-bar').hidden, true);

    elements.get('badge-tokens').click();
    assert.equal(elements.get('panel-main-title').textContent, 'Cumulative Usage');
    assert.equal(elements.get('panel-tokens').hidden, false);
    assert.equal(api.getWorkbenchStateForTest().wide, true);

    elements.get('badge').click();
    assert.equal(elements.get('panel-main-title').textContent, 'Context Window');
    assert.equal(elements.get('pane-ctx-session').hidden, false);
    assert.equal(elements.get('ctx-tabs-bar').hidden, false);
  } finally {
    api.dispose();
  }
});

test('Safe Edition Invariant 8: 模块化渲染架构、单色线性 SVG 图标统一与零装饰性 Emoji 回归守卫', () => {
  // 1. 验证 6 个拆分的领域模块均存在于 src/renderer/，且 main.js 保持精简外壳 (< 1200 行)
  const requiredRendererModules = [
    'topbar-dock.js',
    'popover-router.js',
    'quota-view.js',
    'context-view.js',
    'speed-view.js',
    'tokens-view.js'
  ];
  for (const modName of requiredRendererModules) {
    const modPath = path.join(ROOT, 'src', 'renderer', modName);
    assert.equal(fs.existsSync(modPath), true, `缺失渲染层领域模块: src/renderer/${modName}`);
  }
  const mainJsLines = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'main.js'), 'utf8').split('\n').length;
  assert.ok(mainJsLines < 1200, `src/renderer/main.js 应保持精简模块化外壳 (< 1200 行)，当前: ${mainJsLines}`);

  // 2. 验证 template.html 与 i18n.js 零彩色/装饰性 Emoji，且保留动态进度圆环与单色线性 SVG 图标
  const tplHtml = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'i18n.js'), 'utf8');
  const decorativeEmojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{2712}\u{2715}-\u{27BF}\uFE0F]/u;

  assert.equal(decorativeEmojiRe.test(tplHtml), false, 'src/renderer/template.html 不得包含装饰性/彩色 Emoji (⚡/⚙️ 等)');
  assert.equal(decorativeEmojiRe.test(i18nSrc), false, 'src/renderer/i18n.js 不得包含装饰性/彩色 Emoji (💰/🚀/🎉 等)');

  assert.equal(tplHtml.includes('id="quota-ring-svg"'), true, '必须保留 #quota-ring-svg 动态进度圆环');
  assert.equal(tplHtml.includes('id="ring-svg"'), true, '必须保留 #ring-svg 动态进度圆环');
  assert.match(tplHtml, /id="badge-speed-icon"[^>]*>\s*<svg\b/, '#badge-speed-icon 必须使用线性 SVG 图标');
  assert.match(tplHtml, /id="btn-ctx-settings"[^>]*>\s*<svg\b/, '#btn-ctx-settings 必须使用线性 SVG 图标');

  // 3. 验证运行态速度刷新不会用字符覆写 #badge-speed-icon 内部 SVG，仅同步 currentColor 着色
  const speedViewSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'speed-view.js'), 'utf8');
  assert.equal(/topBolt\.textContent\s*=/.test(speedViewSrc), false, 'speed-view.js 不得覆写 #badge-speed-icon 的内部 SVG');
});

test('Safe Edition Invariant 9: 历史「子档未知」缓存彻底自愈、token-history 透传 origin 与防御性文案清零', () => {
  // 1. 即使历史归档/自定义设置/实况对象遗留「（子档未知）」，resolveEffectivePlanStatus 也必须彻底净化
  const legacyCached = {
    status: 'identified',
    tierKey: 'ultra',
    tierName: 'Google AI Ultra（子档未知）',
    planName: 'Google AI Ultra (子档未知)',
    email: 'dev@example.com'
  };
  const fromCached = core.resolveEffectivePlanStatus(null, null, { cachedLivePlan: legacyCached, currentEmail: 'dev@example.com' });
  assert.equal(fromCached.tierName, 'Google AI Ultra');
  assert.equal(fromCached.planName, 'Google AI Ultra');

  const fromLive = core.resolveEffectivePlanStatus(legacyCached, null, { currentEmail: 'dev@example.com' });
  assert.equal(fromLive.tierName, 'Google AI Ultra');

  const fromCustom = core.resolveEffectivePlanStatus(null, { email: 'dev@example.com', tierName: 'Google AI Ultra（子档未知）' }, { currentEmail: 'dev@example.com' });
  assert.equal(fromCustom.tierName, 'Google AI Ultra');

  // 2. meter-main.js 与 live-host.js 均必须把 origin 透传给 collectTokenHistoryAsync，避免无 CDP 时退回旧磁盘缓存
  const mainSrc = fs.readFileSync(path.join(ROOT, 'meter-main.js'), 'utf8');
  const liveHostSrc = fs.readFileSync(path.join(ROOT, 'live-host.js'), 'utf8');
  assert.match(mainSrc, /collectTokenHistoryAsync\(\{\s*force:\s*force === true,\s*origin:\s*url\.origin\s*\}\)/);
  assert.match(liveHostSrc, /collectTokenHistoryAsync\(\{\s*force:\s*request\.force === true,\s*origin:\s*targetOrigin\s*\}\)/);

  // 3. 验证主要防御性免责文案、设置页防御性底栏与第三方外链已彻底清零
  const tplHtml = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'i18n.js'), 'utf8');
  const ctxViewSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'context-view.js'), 'utf8');
  const routerSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'popover-router.js'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'meter-core.js'), 'utf8');
  const combinedUi = `${tplHtml}\n${i18nSrc}\n${ctxViewSrc}\n${routerSrc}`;
  const forbiddenDefensiveCopy = [
    '不切换当前会话模型',
    '不改变当前会话模型',
    '无额外网络探测请求',
    '不按模型名称硬编码猜测',
    '这不代表额度已耗尽',
    '不计算无限倍数',
    '避免跨月虚高',
    '仅作资源等值参考，非实际账单扣费',
    '本地只读 · 零外网',
    'Local Read-Only · Offline',
    'elviscjn-cjn',
    'linux.do',
    'id="safe-runtime-card"',
    'id="btn-github-repo-ctx"',
    'id="speed-active-test-note"',
    'id="quota-basis-note"',
    'id="quota-pools-browse-hint"'
  ];
  for (const phrase of forbiddenDefensiveCopy) {
    assert.equal(combinedUi.includes(phrase), false, `UI 源码不应再包含冗余防御性文案、外链或节点: ${phrase}`);
  }
  assert.equal(coreSrc.includes('elviscjn-cjn'), false, 'meter-core.js 不应硬编码他人仓库外链');
  assert.equal(coreSrc.includes('linux.do'), false, 'meter-core.js 不应硬编码外部论坛链接');
  assert.equal(mainSrc.includes('context-meter:open-external'), false, 'meter-main.js 不应暴露外链跳转通道');
});

test('Safe Edition Invariant 10: 死代码/陈旧资源已清理，开源文档、隐私边界与 MIT 上游署名完整合规', () => {
  // 1. 废弃多账号筛选 UI、旧参考费用抽屉、陈旧上游资源与过时文档已彻底移除
  const removedPaths = ['assets', 'README.en.md', 'README.es.md', 'README.ja.md', 'README.ko.md', 'RELEASE_NOTES.md', 'plugin.json'];
  for (const rel of removedPaths) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `陈旧资源或文档应已移除: ${rel}`);
  }
  const tplHtml = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'template.html'), 'utf8');
  const tokensViewSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'tokens-view.js'), 'utf8');
  const collectorSrc = fs.readFileSync(path.join(ROOT, 'meter-collector.js'), 'utf8');
  assert.equal(tplHtml.includes('id="token-account-bar"'), false);
  assert.equal(tplHtml.includes('id="ref-cost-drawer-body"'), false);
  assert.equal(tokensViewSrc.includes('syncTokenAccountFilterOptions'), false);
  assert.equal(collectorSrc.includes('buildAccountUsageBreakdown'), false);

  // 2. MIT License 与上游来源仓库署名完整保留，英文主 README 与简中 README 互通，且含 AI 一键安装指南
  const licenseTxt = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  const noticeTxt = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  const readmeTxt = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const readmeZhTxt = fs.readFileSync(path.join(ROOT, 'README.zh-CN.md'), 'utf8');
  const agentsTxt = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  assert.match(licenseTxt, /MIT License/);
  assert.match(licenseTxt, /Copyright \(c\) 2026 Antigravity Context Viewer Contributors/);
  assert.match(noticeTxt, /https:\/\/github\.com\/elviscjn-cjn\/antigravity-context-viewer/);
  assert.match(noticeTxt, /MIT License/);
  assert.match(readmeTxt, /README\.zh-CN\.md/, '英文主 README 应保留简中 README 入口');
  assert.match(readmeTxt, /## Installation/, '主 README 应包含英文安装章节');
  assert.match(readmeTxt, /https:\/\/github\.com\/StepaniaH\/agy-usage/, '主 README 应指向本仓库地址');
  assert.match(readmeTxt, /https:\/\/github\.com\/elviscjn-cjn\/antigravity-context-viewer/);
  assert.match(readmeTxt, /MIT License/);
  assert.match(readmeZhTxt, /README\.md/, '简中 README 应保留英文主 README 入口');
  assert.match(readmeZhTxt, /https:\/\/github\.com\/StepaniaH\/agy-usage/, '简中 README 应指向本仓库地址');
  assert.match(readmeZhTxt, /https:\/\/github\.com\/elviscjn-cjn\/antigravity-context-viewer/);
  assert.equal(readmeTxt.includes('install.bat'), false, 'README 不应残留 Windows 安装指令');
  assert.equal(readmeTxt.includes('meter-enhance'), false, 'README 不应残留已移除模块说明');
  assert.equal(agentsTxt.includes('/Users/'), false, 'AGENTS.md 不应包含本机个人目录路径');
});
