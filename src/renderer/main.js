(function () {
  'use strict';
  if ((location.protocol !== 'https:' && location.protocol !== 'http:') || location.hostname !== '127.0.0.1') return;

  // 在替换或重载旧实例之前捕获当前打开面板、滚动位置与未保存设置草稿（同时兼容无 captureHotReloadState 的旧版本）
  let inheritedHotReloadState = null;
  try {
    if (typeof globalThis.__AGContextMeter?.captureHotReloadState === 'function') {
      inheritedHotReloadState = globalThis.__AGContextMeter.captureHotReloadState();
    } else if (typeof document !== 'undefined') {
      const prevHost = document.getElementById('ag-context-meter');
      const prevRoot = prevHost?.shadowRoot;
      if (prevRoot) {
        const readVal = id => prevRoot.getElementById(id)?.value;
        const readChk = id => Boolean(prevRoot.getElementById(id)?.checked);
        const pCtx = prevRoot.getElementById('panel');
        const pTokens = prevRoot.getElementById('panel-tokens');
        const pQuota = prevRoot.getElementById('panel-quota');
        const pSpeed = prevRoot.getElementById('pane-ctx-speed');
        const isPanelOpen = Boolean(pCtx && !pCtx.hidden);
        const openPanel = !isPanelOpen ? 'none'
          : ((pQuota && !pQuota.hidden) ? 'quota'
            : ((pTokens && !pTokens.hidden) ? 'tokens'
              : ((pSpeed && !pSpeed.hidden) ? 'speed' : 'context')));
        const isSettingsOpen = Boolean(prevRoot.getElementById('pane-ctx-settings') && !prevRoot.getElementById('pane-ctx-settings').hidden);
        const activeTab = isSettingsOpen ? 'settings'
          : ((pQuota && !pQuota.hidden) ? 'quota'
            : ((pTokens && !pTokens.hidden) ? 'tokens'
              : ((pSpeed && !pSpeed.hidden) ? 'speed'
                : (prevRoot.getElementById('tab-ctx-models')?.classList?.contains('active') ? 'models' : 'session'))));
        const scrollTops = {};
        for (const sId of ['pane-ctx-session', 'panel-tokens', 'view-quota', 'pane-ctx-models', 'pane-ctx-speed', 'pane-ctx-settings', 'ctx-model-list']) {
          const n = prevRoot.getElementById(sId);
          if (n && Number(n.scrollTop) > 0) scrollTops[sId] = Number(n.scrollTop);
        }
        const openDrawers = [];
        for (const btnId of ['btn-toggle-details']) {
          if (prevRoot.getElementById(btnId)?.getAttribute?.('aria-expanded') === 'true') {
            openDrawers.push(btnId);
          }
        }
        inheritedHotReloadState = {
          capturedAt: Date.now(),
          openPanel,
          activeContextTab: activeTab,
          isContextSettingsView: isSettingsOpen,
          scrollTops,
          openDrawers,
          drafts: {}
        };
      }
    }
  } catch { }

  globalThis.__AGContextMeter?.dispose?.();
  const activeDisposers = (globalThis.__AGContextMeterDisposers = globalThis.__AGContextMeterDisposers || new Set());
  for (const fn of Array.from(activeDisposers)) {
    try { fn(); } catch { }
  }
  activeDisposers.clear();
  // 清理此前初始化异常或重复挂载遗留的孤儿宿主容器，保证页面内永远仅有唯一实例
  try {
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('#ag-context-meter').forEach(node => {
        try {
          if (typeof node.__agForceDispose === 'function') {
            node.__agForceDispose();
            node.remove?.();
            return;
          }
          // 无主历史闭包节点：剥离 ID、隐藏且清空 shadowRoot 内容，保持其在位静默不再触发重插循环
          node.removeAttribute?.('id');
          node.setAttribute?.('data-ag-retired', '1');
          if (node.style) {
            node.style.cssText = 'display:none!important;width:0!important;height:0!important;overflow:hidden!important;pointer-events:none!important;position:absolute!important;';
          }
          if (node.shadowRoot && typeof node.shadowRoot.innerHTML === 'string') {
            node.shadowRoot.innerHTML = '';
          }
        } catch { }
      });
    }
  } catch { }
  const {
    summarize,
    parseGeneratorCall,
    calculateRequestApiCost,
    normalizeModelId,
    resolveStableModelId,
    formatEffortLabel,
    detectModelVendor,
    groupModelProduct,
    formatTokensK,
    isValidSpeedSample,
    computeMedian,
    summarizeSpeedByModel,
    computeCacheReadStats,
    summarizeCacheReadStats,
    normalizeSessionCallRecord,
    groupSessionCallsByTurns,
    ELV91_SCORE_RULE_VERSION,
    formatHumanDuration,
    computeStreamStability,
    calculateExperienceScore,
    evaluateGenerationExperience,
    getLvlForRange,
    getDailyModelCost,
    calculateIntervalCost,
    resolveEffectivePlanStatus,
    selectPrimaryQuotaBucket,
    splitModelDisplayAndEffort,
    resolvePlaceholderModelInfo,
    stripOrchestratorModelWrapper,
    normalizeModelLookupName,
    matchModelQuotaTarget
  } = (globalThis.__AGContextMeterCore || {});
  const host = document.createElement('div');
  host.id = 'ag-context-meter';
  host.setAttribute('data-layout', 'wide');
  host.setAttribute('data-dock', 'fixed');
  host.setAttribute('data-window-active', 'true');
  const shadow = host.attachShadow({ mode: 'open' });

  // Antigravity 本地真实 Token 统计基准数据（纯净初始状态，启动时由宿主实时扫描本地实际账本注入）
  const ANTIGRAVITY_TOKEN_DATA = {
    updatedAt: "",
    firstUseDate: null,
    summary: {
      grandTotalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheTokens: 0,
      todayTokens: 0,
      monthTokens: 0,
      yearTokens: 0,
      totalSteps: 0,
      totalConversations: 0,
      firstUseDate: null,
      activeDaysCount: 0
    },
    dailyMap: {},
    dailyModelMap: {},
    dailyModelMapBySource: null,
    modelMetaByKey: null,
    speedRecords: []
  };

  const RING_RADIUS = 6.5;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  /* @INSERT_STYLES_AND_TEMPLATE */

  (document.body || document.documentElement).appendChild(host);
  const el = id => shadow.getElementById(id);
  /* @INSERT_I18N_MODULE */
  /* @INSERT_BUDGET_ENGINE_MODULE */
  const budgetEngine = globalThis.__AGContextBudgetEngine || {};
  const fmt = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
  const short = v => {
    if (v == null) return '—';
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) return `${parseFloat((v / 1000).toFixed(1))}K`;
    return fmt(v);
  };
  // 悬停信息气泡专用紧凑计数格式（如 37k、475k、1.05M）
  const fmtBubbleToken = v => {
    if (v == null) return t('common.unknown');
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) {
      const k = v / 1000;
      return k >= 10 ? `${Math.round(k)}k` : `${parseFloat(k.toFixed(1))}k`;
    }
    return String(Math.round(v));
  };
  const range = value => value ? `≈ ${short(value.low)}–${short(value.high)}` : '—';
  const token = value => value == null ? t('common.notProvided') : `${fmt(value)} tokens`;
  const state = {
    route: null, count: 0, latest: null, requestAt: 0, requestError: '',
    requestBusy: false, requestNext: 0, scanBusy: false, scanNext: 0,
    scanError: '', scan: null, generation: 0, controllers: new Set(),
    disposed: false, layoutMode: 'wide', tooltipOpen: false,
    callsHydrated: false, syncedFinalMap: new Map(), pendingFinalCalls: new Map(),
    quarantinedOversizeMap: new Map(), flushFinalsBusy: false, pendingFlushForceSync: false,
    nextFlushRetryAt: 0, nextOversizeRetryAt: 0,
    displayedCallRecord: null, displayedCallSig: '', pendingLatestCallRecord: null,
    pinnedCallRecord: null, latestCallDetailOpen: false, lastAnimatedCallSig: '',
    historyDrawerOpen: false, sessionTimeline: null, timelineLoading: false,
    timelineError: '', expandedTurnKeys: new Set(), timelinePageLimit: 10,
    lastTimelineFetchAt: 0, lastTimelineCallSig: '', callRenderTimer: null,
    callEnterAnimTimer: null,
    speedBreakdownOpen: false, livePendingRequest: null, liveWaitTickTimer: null,
    streamSampleTracker: null, lastSpeedEval: null, speedOverrideForTest: null
  };
  const route = () => location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i)?.[1] || null;
  let activeHeatView = 'daily';
  let heatPageOffset = 0;
  let heatMonthOffset = 0;
  let heatYearOffset = 0;
  let activeCostModel = 'gemini-3.8-flash';
  let activeCostMode = 'ref';

  const METER_RENDERER_VERSION = typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.0.1';
  const backendStatus = {
    rendererVersion: METER_RENDERER_VERSION,
    backendSource: null,
    backendVersion: null,
    backendPid: null,
    ipcBackendVersion: (typeof window !== 'undefined' && window.__AGContextMeterBootBackend?.backendVersion)
      ? String(window.__AGContextMeterBootBackend.backendVersion)
      : null,
    liveHostVersion: (typeof window !== 'undefined' && window.__AGContextMeterLive?.version)
      ? String(window.__AGContextMeterLive.version)
      : null,
    liveHealthy: null,
    hotReloadFallback: false,
    backendVersionMismatch: false,
    lastVerifiedAtMs: null,
    lastQuotaDurationMs: null,
    lastError: null
  };

  function hasLiveHttpBridge() {
    return typeof window !== 'undefined' && Boolean(window.__AGContextMeterLive?.port && window.__AGContextMeterLive?.token);
  }

  function hasLiveRouteCapability(routePath) {
    if (!hasLiveHttpBridge()) return false;
    const caps = window.__AGContextMeterLive?.capabilities;
    if (!caps || typeof caps !== 'object') return true;
    const map = {
      '/quota': 'quota',
      '/scan': 'scan',
      '/token-history': 'tokenHistory',
      '/session-timeline': 'sessionTimeline',
      '/record-calls': 'recordCalls',
      '/get-settings': 'settings',
      '/save-settings': 'settings',
      '/launch-cli': 'launchCli'
    };
    const key = map[routePath];
    if (!key) return true;
    if (Array.isArray(caps)) return caps.includes(key);
    return caps[key] !== false;
  }

  function shouldPreferLiveHost(ipcAvailable = false, routePath = '') {
    if (!hasLiveHttpBridge()) return false;
    if (routePath && !hasLiveRouteCapability(routePath)) return false;
    if (!ipcAvailable) return true;
    if (backendStatus.liveHealthy === false) return false;
    const live = window.__AGContextMeterLive || {};
    if (backendStatus.ipcBackendVersion === METER_RENDERER_VERSION) {
      return false;
    }
    if (live.version && live.version === METER_RENDERER_VERSION) {
      return true;
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterHotReloadContext?.preferLiveHost) {
      return true;
    }
    return false;
  }

  async function postLiveHttpEndpoint(routePath, body = {}, opts = {}) {
    const live = typeof window !== 'undefined' ? window.__AGContextMeterLive : null;
    if (!live?.port || !live?.token) {
      throw new Error('LIVE_BRIDGE_UNAVAILABLE');
    }
    const headers = { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token };
    const fetchOpts = {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {})
    };
    if (opts.signal) fetchOpts.signal = opts.signal;
    const r = await fetch(`http://127.0.0.1:${live.port}${routePath}`, fetchOpts);
    if (!r.ok) {
      const errBody = typeof r.json === 'function' ? await r.json().catch(() => null) : null;
      const err = new Error(errBody?.error || `HTTP ${r.status}`);
      err.httpStatus = r.status;
      err.responseData = errBody;
      throw err;
    }
    return await r.json();
  }

  function syncObservedBackendMeta(source, payloadOrRes, durationMs = null) {
    if (Number.isFinite(durationMs)) backendStatus.lastQuotaDurationMs = durationMs;
    const ver = payloadOrRes?.collectorVersion || payloadOrRes?.backendVersion || payloadOrRes?.version || payloadOrRes?.data?.collectorVersion || payloadOrRes?.data?.backendVersion || null;
    if (source === 'live-host') {
      backendStatus.liveHealthy = true;
      backendStatus.backendSource = 'live-host';
      backendStatus.hotReloadFallback = false;
      if (ver) {
        backendStatus.backendVersion = String(ver);
        backendStatus.liveHostVersion = String(ver);
      } else if (window.__AGContextMeterLive?.version) {
        backendStatus.backendVersion = String(window.__AGContextMeterLive.version);
      }
      if (payloadOrRes?.pid) backendStatus.backendPid = payloadOrRes.pid;
    } else if (source === 'electron-ipc') {
      backendStatus.backendSource = 'electron-ipc';
      if (ver) {
        backendStatus.backendVersion = String(ver);
        backendStatus.ipcBackendVersion = String(ver);
      }
    }
    backendStatus.backendVersionMismatch = Boolean(
      backendStatus.backendVersion &&
      backendStatus.backendVersion !== METER_RENDERER_VERSION
    );
    backendStatus.lastVerifiedAtMs = Date.now();
  }

  async function callBackendWithPriority({ ipcCall = null, liveRoute = '', liveBody = {}, liveFetchOpts = {}, onFallback = null } = {}) {
    const hasIpc = typeof ipcCall === 'function';
    const preferLive = shouldPreferLiveHost(hasIpc, liveRoute);
    if (preferLive && liveRoute) {
      try {
        const res = await postLiveHttpEndpoint(liveRoute, liveBody, liveFetchOpts);
        syncObservedBackendMeta('live-host', res?.data || res);
        return { source: 'live-host', result: res };
      } catch (liveErr) {
        if (liveErr?.name === 'AbortError') throw liveErr;
        backendStatus.liveHealthy = false;
        backendStatus.lastError = liveErr?.message || String(liveErr || '');
        if (!hasIpc) throw liveErr;
        backendStatus.hotReloadFallback = true;
        if (typeof onFallback === 'function') onFallback(liveErr);
      }
    }
    if (hasIpc) {
      const res = await ipcCall();
      syncObservedBackendMeta('electron-ipc', res?.data || res);
      return { source: 'electron-ipc', result: res };
    }
    if (hasLiveHttpBridge() && liveRoute) {
      const res = await postLiveHttpEndpoint(liveRoute, liveBody, liveFetchOpts);
      syncObservedBackendMeta('live-host', res?.data || res);
      return { source: 'live-host', result: res };
    }
    return { source: 'none', result: null };
  }

  /**
   * 获取当前有效设备像素比，用于跨屏混合 DPI 下的物理像素网格对齐
   */
  function getEffectiveDpr() {
    try {
      const dpr = typeof window !== 'undefined' ? Number(window.devicePixelRatio) : 1;
      return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    } catch {
      return 1;
    }
  }

  /**
   * 将 CSS 逻辑坐标对齐到最近的物理设备像素边界，防止 100%/175% 混合缩放下出现亚像素偏移发虚
   */
  function snapToDevicePixel(px) {
    const num = Number(px);
    if (!Number.isFinite(num)) return 0;
    const dpr = getEffectiveDpr();
    return Math.round(num * dpr) / dpr;
  }

  function hasClass(node, cls) {
    if (!node) return false;
    if (node.classList?.contains) return node.classList.contains(cls);
    return String(node.className || '').split(/\s+/).includes(cls);
  }
  function addClass(node, cls) {
    if (!node) return;
    if (node.classList?.add) { node.classList.add(cls); return; }
    const cur = String(node.className || '').trim();
    if (!cur.split(/\s+/).includes(cls)) node.className = cur ? `${cur} ${cls}` : cls;
  }
  function removeClass(node, cls) {
    if (!node) return;
    if (node.classList?.remove) { node.classList.remove(cls); return; }
    const parts = String(node.className || '').split(/\s+/).filter(c => c !== cls);
    node.className = parts.join(' ');
  }

  // 纯同步 UI 控件回填防护守卫（仅在纯同步赋值代码块内开启，严禁跨越 await）
  let isHydratingUiControls = false;
  function runWithUiHydration(fn) {
    const prev = isHydratingUiControls;
    isHydratingUiControls = true;
    try {
      return fn();
    } finally {
      isHydratingUiControls = prev;
    }
  }

  // 兼容老调用声明
  let isRestoringSettings = false;

  // 异步时序保护：用户主动修改序列号与恢复请求版本号
  let userActionSeq = 0;
  let restoreRequestSeq = 0;

  function setPillActive(node, active) {
    if (!node) return;
    node.classList?.toggle?.('active', active);
    const cur = node.getAttribute('class') || 'switch-pill-btn';
    if (active) {
      if (!cur.includes('active')) node.setAttribute('class', (cur + ' active').trim());
    } else {
      node.setAttribute('class', cur.replace(/\bactive\b/g, '').trim());
    }
  }

  function formatCompactTokenCount(v) {
    const n = Number(v) || 0;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  }

  const VENDOR_ORDER = ['Google', 'Anthropic', 'OpenAI', '其他'];
  const VENDOR_DOT_COLORS = {
    Google: 'var(--ag-custom-speed, var(--ag-speed-default, #38bdf8))',
    Anthropic: 'var(--ag-ring-warn, #f59e0b)',
    OpenAI: 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))',
    '其他': 'var(--ag-text-muted, #8a8a94)'
  };

  function formatKShort(tokens) {
    const n = Number(tokens);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (typeof formatTokensK === 'function') return formatTokensK(n);
    return short(n);
  }

  function formatMonthDayTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  function formatEffortZh(effort) {
    if (!effort) return '';
    const lang = typeof getPanelLanguage === 'function' ? getPanelLanguage() : 'zh-CN';
    if (typeof formatEffortLabel === 'function') return formatEffortLabel(effort, lang);
    return String(effort);
  }

  let quotaStateInitialized = false;
  // =========================================================================
  // 一键启动 CLI 模式（当前项目目录绑定 + 中文/空格路径兼容 + 错误提示）
  // =========================================================================
  let cliLaunchBusy = false;
  let cliToastTimer = null;
  let lastCliLaunchResult = null;

  function showCliToast(message, isError = false) {
    const toast = el('cli-launch-toast');
    if (!toast) return;
    if (cliToastTimer) {
      clearTimeout(cliToastTimer);
      cliToastTimer = null;
    }
    toast.hidden = false;
    toast.setAttribute('data-tone', isError ? 'error' : 'info');
    toast.textContent = message;
    cliToastTimer = setTimeout(() => {
      toast.hidden = true;
      cliToastTimer = null;
    }, isError ? 5200 : 3200);
  }

  async function triggerLaunchCli(customOpts = {}) {
    if (cliLaunchBusy) {
      showCliToast(t('cli.busy'), false);
      return { ok: false, error: t('cli.busy') };
    }
    cliLaunchBusy = true;
    const btn = el('badge-cli');
    const label = el('cli-label');
    btn?.setAttribute('data-busy', 'true');
    if (label) label.textContent = '…';
    try {
      if (typeof document !== 'undefined' && document.activeElement?.blur) {
        document.activeElement.blur();
      }
    } catch { }

    const hostBounds = {
      x: typeof window !== 'undefined' ? (window.screenX || 0) : 0,
      y: typeof window !== 'undefined' ? (window.screenY || 0) : 0,
      width: typeof window !== 'undefined' ? (window.outerWidth || window.innerWidth || 1200) : 1200,
      height: typeof window !== 'undefined' ? (window.outerHeight || window.innerHeight || 800) : 800
    };

    const reqOpts = {
      cascadeId: state.route || undefined,
      cwd: customOpts.cwd !== undefined ? customOpts.cwd : (state.scan?.workspacePath || undefined),
      hostBounds,
      ...customOpts
    };
    try {
      let res = null;
      const ipcFn = typeof window !== 'undefined' && typeof window.contextMeterAPI?.launchCli === 'function'
        ? () => window.contextMeterAPI.launchCli(reqOpts)
        : null;
      if (ipcFn || hasLiveHttpBridge()) {
        try {
          const out = await callBackendWithPriority({
            ipcCall: ipcFn,
            liveRoute: '/launch-cli',
            liveBody: reqOpts
          });
          res = out.result;
        } catch (err) {
          res = { ok: false, error: err?.message || t('cli.notFound') };
        }
      } else {
        res = { ok: false, code: 'NO_BRIDGE', error: t('cli.noBridge') };
      }

      lastCliLaunchResult = res;
      if (res && res.ok) {
        const om = el('overflow-menu');
        if (om) om.hidden = true;
        showCliToast(t('cli.launched', { cwd: res.cwd || t('cli.defaultCwd') }), false);
        return res;
      } else {
        const errMsg = res?.error ? translateBackendText(res.error) : t('cli.notFound');
        showCliToast(t('cli.failed', { err: errMsg }), true);
        return res || { ok: false, error: errMsg };
      }
    } catch (err) {
      const errMsg = err?.message ? translateBackendText(err.message) : t('cli.exception');
      lastCliLaunchResult = { ok: false, error: errMsg };
      showCliToast(t('cli.failed', { err: errMsg }), true);
      return lastCliLaunchResult;
    } finally {
      cliLaunchBusy = false;
      btn?.removeAttribute('data-busy');
      btn?.removeAttribute('data-pressed');
      if (label) label.textContent = 'CLI';
    }
  }

  const badgeCliEl = el('badge-cli');
  if (badgeCliEl) {
    const releasePress = () => {
      badgeCliEl.removeAttribute('data-pressed');
    };
    badgeCliEl.addEventListener('pointerdown', () => {
      badgeCliEl.setAttribute('data-pressed', 'true');
    });
    badgeCliEl.addEventListener('pointerup', releasePress);
    badgeCliEl.addEventListener('pointercancel', releasePress);
    badgeCliEl.addEventListener('mouseleave', releasePress);
    badgeCliEl.addEventListener('blur', releasePress);
    badgeCliEl.addEventListener('click', () => {
      releasePress();
      void triggerLaunchCli();
    });
  }
  el('overflow-cli-btn')?.addEventListener('click', () => { void triggerLaunchCli(); });


  /* @INSERT_COLORS_MODULE */
  /* @INSERT_DROPDOWN_MODULE */
  /* @INSERT_POPOVER_ROUTER_MODULE */
  /* @INSERT_TOPBAR_DOCK_MODULE */
  /* @INSERT_CONTEXT_VIEW_MODULE */
  /* @INSERT_SPEED_VIEW_MODULE */
  /* @INSERT_TOKENS_VIEW_MODULE */
  /* @INSERT_QUOTA_VIEW_MODULE */
  /* @INSERT_HEATMAP_MODULE */

  let quotaTickCounter = 0;
  let hasTriggeredInitialQuotaSync = false;
  function tick() {
    if (state.disposed || (globalThis.__AGContextMeterActiveHost && globalThis.__AGContextMeterActiveHost !== host)) {
      earlyForceDispose();
      return;
    }
    if (!host.isConnected) {
      ensureHostDocked();
    }
    const id = route();
    if (id !== state.route) {
      for (const controller of state.controllers) controller.abort(); state.controllers.clear(); state.generation++;
      if (timelineFetchController) {
        try { timelineFetchController.abort(); } catch { }
        timelineFetchController = null;
      }
      if (state.callRenderTimer) { clearTimeout(state.callRenderTimer); state.callRenderTimer = null; }
      if (state.callEnterAnimTimer) { clearTimeout(state.callEnterAnimTimer); state.callEnterAnimTimer = null; }
      clearLivePendingRequestWait();
      if (state.sessionCallsMap) state.sessionCallsMap.clear();
      if (state.expandedTurnKeys) state.expandedTurnKeys.clear();
      Object.assign(state, {
        route: id, count: 0, latest: null, sessionCalls: [], sessionCostTotal: 0,
        callsHydrated: false, requestAt: 0, requestError: '', requestBusy: false, requestNext: 0,
        scanBusy: false, scanNext: 0, scanError: '', scan: null,
        displayedCallRecord: null, displayedCallSig: '', pendingLatestCallRecord: null,
        pinnedCallRecord: null, latestCallDetailOpen: false, lastAnimatedCallSig: '',
        historyDrawerOpen: false, sessionTimeline: null, timelineLoading: false,
        timelineError: '', timelinePageLimit: 10, lastTimelineFetchAt: 0, lastTimelineCallSig: '',
        speedBreakdownOpen: false, streamSampleTracker: null, lastSpeedEval: null, speedOverrideForTest: null
      });
      // 避免切换会话后立刻撞上 15s 周期历史刷新，若已做过同步则确保至少留出 7s 窗口给当前会话优先加载
      if (lastHistorySync > 0) {
        lastHistorySync = Math.max(lastHistorySync, Date.now() - 8000);
      }
      toggle(false); hideContextTooltip(); renderFiles(null); render();
    }
    if (id && !state.requestBusy && Date.now() >= state.requestNext) void requestPoll(state.generation, id);
    if (id && !state.scanBusy && Date.now() >= state.scanNext) void scan(state.generation, id);
    if (!state.disposed && state.pendingFinalCalls?.size && !state.flushFinalsBusy && Date.now() >= (state.nextFlushRetryAt || 0)) {
      void flushPendingFinalCalls(false);
    }
    syncPendingAutomaticHistory();
    if (!hasTriggeredInitialQuotaSync) {
      hasTriggeredInitialQuotaSync = true;
      if (!quotaState.snapshot && !quotaState.busy && !quotaInFlightPromise) {
        void syncQuotaFromHost(false);
      }
    }
    if (Date.now() - lastHistorySync > 15000) {
      const isInitialSync = lastHistorySync === 0;
      lastHistorySync = Date.now();
      void syncTokenHistoryFromHost(false);
      if (!isInitialSync && activeContextTab === 'models' && !isContextSettingsView) {
        void fetchAvailableModelsIfNeeded();
      }
    }
    quotaTickCounter = (quotaTickCounter + 1) % 2;
    if (quotaTickCounter === 0 && el('panel-quota') && !el('panel-quota').hidden) {
      renderQuotaBoard(Date.now());
    }
  }

  const timer = setInterval(tick, 500);
  // 监听 SPA 路由跳转，切会话微任务内立即清旧状态并发起新会话采集，消除轮询间隙旧数据残留
  let routeHookScheduled = false;
  const scheduleImmediateRouteTick = () => {
    if (routeHookScheduled || state.disposed) return;
    routeHookScheduled = true;
    Promise.resolve().then(() => {
      routeHookScheduled = false;
      if (!state.disposed && route() !== state.route) tick();
    });
  };
  let origPushState = null;
  let origReplaceState = null;
  let wrappedPushState = null;
  let wrappedReplaceState = null;
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('popstate', scheduleImmediateRouteTick);
  }
  if (typeof globalThis.history === 'object' && globalThis.history) {
    if (typeof globalThis.history.pushState === 'function') {
      origPushState = globalThis.history.pushState;
      wrappedPushState = function (...args) {
        const res = origPushState.apply(this, args);
        scheduleImmediateRouteTick();
        return res;
      };
      try { globalThis.history.pushState = wrappedPushState; } catch { wrappedPushState = null; }
    }
    if (typeof globalThis.history.replaceState === 'function') {
      origReplaceState = globalThis.history.replaceState;
      wrappedReplaceState = function (...args) {
        const res = origReplaceState.apply(this, args);
        scheduleImmediateRouteTick();
        return res;
      };
      try { globalThis.history.replaceState = wrappedReplaceState; } catch { wrappedReplaceState = null; }
    }
  }
  function captureHotReloadState() {
    if (inheritedHotReloadState) return inheritedHotReloadState;
    const pCtx = el('panel');
    const pTokens = el('panel-tokens');
    const pQuota = el('panel-quota');
    const pSpeed = el('pane-ctx-speed');
    const isPanelOpen = Boolean(pCtx && !pCtx.hidden);
    const openPanel = !isPanelOpen ? 'none'
      : ((pQuota && !pQuota.hidden) ? 'quota'
        : ((pTokens && !pTokens.hidden) ? 'tokens'
          : ((pSpeed && !pSpeed.hidden) ? 'speed' : 'context')));
    const scrollTops = {};
    for (const sId of ['pane-ctx-session', 'panel-tokens', 'view-quota', 'pane-ctx-models', 'pane-ctx-speed', 'pane-ctx-settings', 'ctx-model-list']) {
      const n = el(sId);
      if (n && Number(n.scrollTop) > 0) scrollTops[sId] = Number(n.scrollTop);
    }
    const openDrawers = [];
    for (const btnId of ['btn-toggle-details']) {
      if (el(btnId)?.getAttribute?.('aria-expanded') === 'true') {
        openDrawers.push(btnId);
      }
    }
    return {
      capturedAt: Date.now(),
      openPanel,
      activeContextTab: syncActiveContextTabAlias(),
      isContextSettingsView,
      browsePoolKey: quotaState.browsePoolKey || null,
      scrollTops,
      openDrawers,
      drafts: {}
    };
  }

  function applyInheritedHotReloadState(saved) {
    if (!saved || typeof saved !== 'object' || state.disposed) return;
    if (saved.browsePoolKey) {
      quotaState.browsePoolKey = saved.browsePoolKey;
    }
    if (saved.openPanel && saved.openPanel !== 'none') {
      if (saved.isContextSettingsView) {
        showPanel('settings');
      } else if (saved.activeContextTab) {
        showPanel(saved.activeContextTab);
      } else {
        showPanel(saved.openPanel);
      }
    }
    if (Array.isArray(saved.openDrawers)) {
      for (const btnId of saved.openDrawers) {
        const btn = el(btnId);
        if (btn && btn.getAttribute?.('aria-expanded') !== 'true') {
          try { btn.click(); } catch { }
        }
      }
    }
    const scrollTops = saved.scrollTops || {};
    const restoreScrolls = () => {
      if (state.disposed) return;
      for (const [sId, topVal] of Object.entries(scrollTops)) {
        const node = el(sId);
        if (node && Number(topVal) > 0) node.scrollTop = Number(topVal);
      }
    };
    restoreScrolls();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(restoreScrolls);
    }
    setTimeout(restoreScrolls, 40);
    setTimeout(restoreScrolls, 140);
  }

  globalThis.__AGContextMeter = {
    version: METER_RENDERER_VERSION,
    ensureAlive: () => {
      if (state.disposed) return false;
      ensureHostDocked();
      render();
      return true;
    },
    theme: () => resolveTheme(),
    getThemeMode: () => currentThemeMode,
    setTheme: mode => setThemeMode(mode, { persist: true }),
    getHeatPreset: () => heatPreset,
    setHeatPreset: preset => setHeatPreset(preset, { persist: true }),
    getHeatPalette: () => getEffectiveHeatmapScale(),
    getActiveAccentColor: () => getActiveAccentColor(),
    getTopbarPills: () => getTopbarPills(),
    setTopbarPillVisible: (key, visible) => setTopbarPillVisible(key, visible, { persist: true }),
    resetAppearanceDefaults: () => resetAppearanceDefaults({ persist: true }),
    applyTokenHistoryPayload,
    setTokenHistoryForTest: payload => applyTokenHistoryPayload(payload),
    getPlanDetailExpanded: () => planDetailExpanded,
    setPlanDetailExpanded,
    switchTokenView,
    switchHeatView: view => switchHeatView(view),
    getActiveHeatView: () => activeHeatView,
    renderHeatmapMonthly: () => renderHeatmapMonthly(),
    renderHeatmapYearly: () => renderHeatmapYearly(),
    updateHeatTabThumb: () => updateHeatTabThumb(),
    saveMonthlySpendUSD: val => saveMonthlySpendUSD(val),
    clearMonthlySpendUSD: () => clearMonthlySpendUSD(),
    getPlanSettings: () => getPlanSettingsForTestImpl(),
    restoreSettingsFromHost,
    syncTokenHistoryFromHost,
    launchCli: opts => triggerLaunchCli(opts),
    getLastCliLaunchResult: () => lastCliLaunchResult,
    getTimelineWindow: () => getTimelineWindowForTestImpl(),
    repositionPanelsForTest: () => positionFloatingPanels(),
    getLayoutMode: () => state.layoutMode,
    setAvailableWidthForTest: width => setAvailableWidthForTestImpl(width),
    findTopRightClusterForTest: () => findTopRightCluster(),
    syncWindowControlsOverlayForTest: () => syncWindowControlsOverlay(),
    computeWindowControlsWidthForTest: el => computeWindowControlsWidth(el),
    getContextPreferencesState: () => getContextPreferencesStateForTest(),
    setContextLatestForTest: (latestObj, configs, capabilitiesById) => setContextLatestForTestImpl(latestObj, configs, capabilitiesById),
    setModelCapabilitiesForTest: capabilitiesById => setModelCapabilitiesForTestImpl(capabilitiesById),
    switchContextTabForTest: tab => switchContextTab(tab),
    openContextSettingsForTest: opts => openContextSettings(opts),
    setSpeedRecordsForTest: (records, calls) => setSpeedRecordsForTestImpl(records, calls),
    getKnownModelProductsForTest: () => getKnownModelProducts(),
    getPanelLanguage: () => getPanelLanguage(),
    setPanelLanguage: (lang, opts) => applyPanelLanguage(lang, opts),
    restoreSettingsForTest: () => restoreSettingsFromHost(),
    translateForTest: (key, vars) => t(key, vars),
    applyStaticTranslationsForTest: rootNode => applyStaticPanelTranslations(rootNode),
    getModelQuotaStateForTest: nowMs => getModelQuotaStateForTestImpl(nowMs),
    setQuotaSnapshotForTest: (payload, nowMs) => setQuotaSnapshotForTestImpl(payload, nowMs),
    refreshQuotaForTest: (force = false, meta = {}) => syncQuotaFromHost(Boolean(force), meta),
    selectQuotaPoolBrowseForTest: poolKey => selectQuotaPoolBrowseForTestImpl(poolKey),
    showQuotaPanelForTest: (open = true) => showQuotaPanelForTestImpl(open),
    getWorkbenchStateForTest: () => getWorkbenchStateForTestImpl(),
    snapshot: () => ({ route: state.route, count: state.count, latest: state.latest, scan: state.scan, requestError: state.requestError, scanError: state.scanError, scanBusy: state.scanBusy, layoutMode: state.layoutMode, sessionCalls: state.sessionCalls, sessionCostTotal: state.sessionCostTotal }),
    captureHotReloadState,
    verifyHotReloadAndRefreshQuota,
    getBackendStatusForTest: () => ({
      ...backendStatus,
      collectorVersion: quotaState.collectorVersion,
      hasLiveHttpBridge: hasLiveHttpBridge(),
      shouldPreferLiveHost: shouldPreferLiveHost(typeof window?.contextMeterAPI?.getQuota === 'function', '/quota')
    }),
    getRuntimeVersionReport: () => ({
      rendererVersion: METER_RENDERER_VERSION,
      backendSource: backendStatus.backendSource,
      backendVersion: backendStatus.backendVersion,
      backendPid: backendStatus.backendPid,
      ipcBackendVersion: backendStatus.ipcBackendVersion,
      liveHostVersion: backendStatus.liveHostVersion,
      hotReloadFallback: backendStatus.hotReloadFallback,
      backendVersionMismatch: backendStatus.backendVersionMismatch,
      lastQuotaDurationMs: backendStatus.lastQuotaDurationMs
    }),
    getLatestCallCardStateForTest: () => getLatestCallCardStateForTestImpl(),
    setSessionCallsForTest: (calls, opts) => setSessionCallsForTestImpl(calls, opts),
    setSessionTimelineForTest: tl => setSessionTimelineForTestImpl(tl),
    toggleSessionHistoryForTest: open => toggleSessionHistoryForTestImpl(open),
    setSpeedEvaluationForTest: (mockInput, opts) => setSpeedEvaluationForTestImpl(mockInput, opts),
    getSpeedPanelStateForTest: () => getSpeedPanelStateForTestImpl(),
    getTokenCacheBreakdownForTest: () => getTokenCacheBreakdownForTestImpl(),
    isDisposedForTest: () => Boolean(state.disposed),
    dispose() {
      earlyForceDispose();
      clearQuotaTimers();
      clearInterval(timer);
      clearLivePendingRequestWait();
      if (timelineFetchController) {
        try { timelineFetchController.abort(); } catch { }
        timelineFetchController = null;
      }
      if (state.callRenderTimer) { clearTimeout(state.callRenderTimer); state.callRenderTimer = null; }
      if (state.callEnterAnimTimer) { clearTimeout(state.callEnterAnimTimer); state.callEnterAnimTimer = null; }
      try { globalThis.removeEventListener?.('popstate', scheduleImmediateRouteTick); } catch { }
      try {
        if (wrappedPushState && globalThis.history?.pushState === wrappedPushState && origPushState) {
          globalThis.history.pushState = origPushState;
        }
        if (wrappedReplaceState && globalThis.history?.replaceState === wrappedReplaceState && origReplaceState) {
          globalThis.history.replaceState = origReplaceState;
        }
      } catch { }
      syncHostStackingElevation(false);
      try { themeObserver?.disconnect(); } catch { }
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', escape);
      try { document.getElementById('ag-wco-spacer')?.remove?.(); } catch { }
      try { document.getElementById('ag-topbar-host-fix')?.remove?.(); } catch { }
      host.remove();
    }
  };
  syncPanelLanguageButtons(currentPanelLanguage);
  applyStaticPanelTranslations(shadow);
  if (inheritedHotReloadState) {
    applyInheritedHotReloadState(inheritedHotReloadState);
  }
  startupRestorePromise = restoreSettingsFromHost().finally(() => {
    startupRestorePromise = null;
    if (inheritedHotReloadState) {
      applyInheritedHotReloadState(inheritedHotReloadState);
      inheritedHotReloadState = null;
    }
  });
  render();
  tick();
})();
