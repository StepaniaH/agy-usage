(function () {
  const METER_VERSION = '0.0.1';

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
    resolvePlaceholderModelInfo
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

  shadow.innerHTML = `<style>
    :host{
      position:fixed;top:6px;right:138px;z-index:2147483000;
      font:12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif;
      font-variant-numeric:tabular-nums;
      -webkit-app-region:no-drag;user-select:none;display:inline-flex;align-items:center;gap:2px;
      height:28px;flex-shrink:0;vertical-align:middle;

      /* 优先复用 Antigravity 0 级宿主主题变量，无变量时回退深色默认值 */
      --ag-toolbar-fg:var(--secondary-foreground,#b8b8c0);
      --ag-toolbar-fg-hover:var(--foreground,#ececef);
      --ag-toolbar-bg:transparent;
      --ag-toolbar-bg-hover:var(--secondary,rgba(255,255,255,0.08));
      --ag-toolbar-bg-active:var(--secondary,rgba(255,255,255,0.12));
      --ag-toolbar-border-focus:var(--primary,rgba(128,128,128,0.45));
      --ag-divider:var(--border,rgba(255,255,255,0.08));

      /* 圆环与各指标默认主题色 */
      --ag-ring-track-default:rgba(255,255,255,0.20);
      --ag-ring-used-default:#e6e6eb;
      --ag-ring-warn:#f59e0b;
      --ag-ring-danger:#ef4444;

      --ag-context-text-default:#ececef;
      --ag-speed-default:#b8b8c0;
      --ag-token-total-default:#b8b8c0;
      --ag-token-accent-default:#a78bfa;

      /* 0 级主题背景与 Surface Tint 轻盈海拔层级（替代多重嵌套实线边框） */
      --ag-bg-panel-default:var(--ag-host-bg,var(--background,#16161a));
      --ag-unified-bg:var(--ag-custom-panel-bg,var(--ag-bg-panel-default));
      --ag-surface-1:rgba(255,255,255,0.044);
      --ag-surface-2:rgba(255,255,255,0.075);
      --ag-surface-tile:rgba(255,255,255,0.068);
      --ag-tile-shadow:none;
      --ag-surface-hover:rgba(255,255,255,0.10);
      --ag-hairline:rgba(255,255,255,0.065);

      --ag-float-bg:var(--ag-unified-bg);
      --ag-float-border:rgba(255,255,255,0.12);
      --ag-float-shadow:0 14px 36px rgba(0,0,0,0.54),0 2px 8px rgba(0,0,0,0.32);

      --ag-bg-panel:var(--ag-unified-bg);
      --ag-border-panel:rgba(255,255,255,0.10);
      --ag-shadow-panel:0 22px 54px rgba(0,0,0,0.62),0 4px 14px rgba(0,0,0,0.34),inset 0 1px 0 rgba(255,255,255,0.06);
      --ag-text-primary:#ececef;
      --ag-text-secondary:#c8c8d0;
      --ag-text-muted:#8a8a94;
      --ag-border-subtle:rgba(255,255,255,0.07);

      /* 一级卡片与二级子表面海拔映射（轻柔底色分层，避免三层实线框套娃） */
      --ag-bg-card:var(--ag-surface-1);
      --ag-bg-card-hover:var(--ag-surface-2);
      --ag-border-card:var(--ag-hairline);
      --ag-bg-subcard:var(--ag-surface-2);
      --ag-border-subcard:transparent;
      --ag-bg-status:var(--ag-surface-1);
      --ag-text-status:#c8c8d0;

      --ag-btn-bg:var(--ag-surface-1);
      --ag-btn-hover:var(--ag-surface-hover);
      --ag-btn-border:rgba(255,255,255,0.10);
      --ag-btn-border-hover:rgba(255,255,255,0.20);
      --ag-btn-text:#d4d4d8;

      --ag-pill-muted-bg:var(--ag-surface-2);
      --ag-pill-muted-border:var(--ag-hairline);
      --ag-pill-muted-text:#9a9aa2;

      --ag-track-bg:rgba(255,255,255,0.11);
      --ag-track-shadow:none;

      --ag-heat-bg:var(--ag-surface-1);
      --ag-heat-lvl-0:#27272a;
      --ag-heat-lvl-1:#3f1e6b;
      --ag-heat-lvl-2:#652ab7;
      --ag-heat-lvl-3:#9053f8;
      --ag-heat-lvl-4:#c084fc;
      --ag-heat-outline:#ffffff;

      --ag-pop-bg:var(--ag-unified-bg);
      --ag-pop-border:var(--ag-float-border);
      --ag-pop-shadow:var(--ag-float-shadow);
      --ag-pop-text:var(--ag-text-primary);
      --ag-pop-muted:var(--ag-text-secondary);
      --ag-pop-sub:var(--ag-text-muted);

      --ag-scrollbar-thumb:rgba(255,255,255,0.16);
      --ag-scrollbar-hover:rgba(255,255,255,0.28);

      --ag-bg-input:rgba(255,255,255,0.055);
      --ag-select-option-bg:#222226;
      --ag-select-option-fg:#ececef;

      color-scheme:dark;
      color:var(--ag-text-primary);
    }

    /* 融入宿主原生布局容器时参与正常 Flexbox 空间分配 */
    :host([data-dock="flow"]){
      position:relative !important;top:auto !important;right:auto !important;left:auto !important;bottom:auto !important;z-index:20;
      margin-right:4px;
    }

    /* 窗口非活动状态适度降低顶栏对比度 */
    :host([data-window-active="false"]) .ag-unit{
      opacity:0.72;
    }
    :host([data-window-active="false"]) .ag-unit:hover,
    :host([data-window-active="false"]) .ag-unit:focus-visible{
      opacity:1;
    }

    /* 浅色模式规范（与 0 级浅色主题协调，采用轻盈灰阶海拔表面） */
    :host([data-theme="light"]),
    :host([data-panel-tone="light"]){
      --ag-toolbar-fg:#52525b;
      --ag-toolbar-fg-hover:#18181b;
      --ag-toolbar-bg:transparent;
      --ag-toolbar-bg-hover:rgba(0,0,0,0.06);
      --ag-toolbar-bg-active:rgba(0,0,0,0.10);
      --ag-toolbar-border-focus:rgba(0,0,0,0.35);
      --ag-divider:rgba(0,0,0,0.08);

      --ag-ring-track-default:rgba(0,0,0,0.18);
      --ag-ring-used-default:#18181b;
      --ag-ring-warn:#d97706;
      --ag-ring-danger:#dc2626;

      --ag-context-text-default:#18181b;
      --ag-speed-default:#52525b;
      --ag-token-total-default:#52525b;
      --ag-token-accent-default:#7c3aed;

      --ag-bg-panel-default:var(--ag-host-bg,var(--background,#ffffff));
      --ag-unified-bg:var(--ag-custom-panel-bg,var(--ag-bg-panel-default));
      --ag-surface-1:#f4f5f8;
      --ag-surface-2:#eaedf2;
      --ag-surface-tile:#ffffff;
      --ag-tile-shadow:0 1px 2px rgba(15,23,42,0.055),0 0 0 0.5px rgba(15,23,42,0.05);
      --ag-surface-hover:#e3e7ee;
      --ag-hairline:rgba(15,23,42,0.055);

      --ag-float-bg:var(--ag-unified-bg);
      --ag-float-border:rgba(15,23,42,0.09);
      --ag-float-shadow:0 12px 32px rgba(15,23,42,0.12),0 2px 8px rgba(15,23,42,0.05);

      --ag-bg-panel:var(--ag-unified-bg);
      --ag-border-panel:rgba(15,23,42,0.09);
      --ag-shadow-panel:0 20px 50px rgba(15,23,42,0.14),0 4px 14px rgba(15,23,42,0.06);
      --ag-text-primary:#18181b;
      --ag-text-secondary:#3f3f46;
      --ag-text-muted:#71717a;
      --ag-border-subtle:rgba(0,0,0,0.07);

      --ag-bg-card:var(--ag-surface-1);
      --ag-bg-card-hover:var(--ag-surface-2);
      --ag-border-card:var(--ag-hairline);
      --ag-bg-subcard:var(--ag-surface-2);
      --ag-border-subcard:transparent;
      --ag-bg-status:var(--ag-surface-1);
      --ag-text-status:#27272a;

      --ag-btn-bg:var(--ag-surface-1);
      --ag-btn-hover:var(--ag-surface-hover);
      --ag-btn-border:rgba(0,0,0,0.10);
      --ag-btn-border-hover:rgba(0,0,0,0.20);
      --ag-btn-text:#18181b;

      --ag-pill-muted-bg:var(--ag-surface-2);
      --ag-pill-muted-border:var(--ag-hairline);
      --ag-pill-muted-text:#52525b;

      --ag-track-bg:rgba(0,0,0,0.08);
      --ag-track-shadow:none;

      --ag-heat-bg:var(--ag-surface-1);
      --ag-heat-lvl-0:#e4e4e7;
      --ag-heat-lvl-1:#e9d5ff;
      --ag-heat-lvl-2:#c084fc;
      --ag-heat-lvl-3:#9333ea;
      --ag-heat-lvl-4:#6b21a8;
      --ag-heat-outline:#18181b;

      --ag-scrollbar-thumb:rgba(0,0,0,0.16);
      --ag-scrollbar-hover:rgba(0,0,0,0.28);

      --ag-bg-input:rgba(0,0,0,0.038);
      --ag-select-option-bg:#ffffff;
      --ag-select-option-fg:#18181b;

      color-scheme:light;
      color:var(--ag-text-primary);
    }

    *{box-sizing:border-box}
    .sr-only{
      position:absolute!important;width:1px!important;height:1px!important;
      padding:0!important;margin:-1px!important;overflow:hidden!important;
      clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;
    }
    ::-webkit-scrollbar{width:5px;height:5px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--ag-scrollbar-thumb);border-radius:3px}
    ::-webkit-scrollbar-thumb:hover{background:var(--ag-scrollbar-hover)}
    button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0;font-variant-numeric:tabular-nums}
    button:focus-visible{outline:1.5px solid var(--ag-toolbar-border-focus);outline-offset:1px}

    /* Basic Unit: 原生工具栏级别精密小单元 */
    .ag-unit{
      display:inline-flex;align-items:center;justify-content:center;
      height:28px;padding:0 7px;border-radius:8px;border:1px solid transparent;
      background:var(--ag-toolbar-bg);color:var(--ag-toolbar-fg);
      white-space:nowrap;font-variant-numeric:tabular-nums;
      font-size:12px;font-weight:500;letter-spacing:-0.01em;gap:4px;
      transition:background-color .14s ease,color .14s ease,border-color .14s ease,opacity .14s ease;
      flex-shrink:0;
    }
    .ag-unit:hover,.ag-unit:focus-visible,.ag-unit[aria-expanded="true"]{
      background:var(--ag-toolbar-bg-hover);
      color:var(--ag-toolbar-fg-hover);
    }
    .ag-unit:active{
      background:var(--ag-toolbar-bg-active);
    }

    /* 单元 1: 上下文动态进度小圆环 */
    #badge.ag-unit-ring{
      width:auto!important;min-width:28px;height:28px;padding:0 6px 0 4px;gap:3px;
      display:inline-flex;align-items:center;justify-content:center;
    }
    :host([data-layout="ring-only"]) #badge.ag-unit-ring{
      width:28px!important;min-width:28px!important;padding:0!important;gap:0!important;
    }
    .ring-svg{width:18px;height:18px;display:block;flex-shrink:0;overflow:visible}
    .ring-track{stroke:var(--ag-custom-ring-track,var(--ag-ring-track-default))}
    .ring-fill{
      stroke:var(--ag-custom-ring-used,var(--ag-ring-used-default));
      transition:stroke-dasharray .22s ease,opacity .15s ease;
    }
    :host([data-occupancy="warn"]) .ring-fill{stroke:var(--ag-ring-warn)}
    :host([data-occupancy="danger"]) .ring-fill{stroke:var(--ag-ring-danger)}
    .meter-bar-fill{width:0;height:100%}

    /* 单元 0: 模型额度动态圆环入口 */
    #badge-quota.ag-unit-quota{
      width:auto;min-width:28px;height:28px;padding:0 5px 0 4px;gap:3px;
      display:inline-flex;align-items:center;justify-content:center;color:var(--ag-toolbar-fg);
    }
    .quota-ring-svg{width:18px;height:18px;display:block;flex-shrink:0;overflow:visible}
    .quota-ring-track{stroke:var(--ag-custom-ring-track,var(--ag-ring-track-default))}
    .quota-ring-fill{
      stroke:#22c55e;
      transition:stroke-dashoffset .22s cubic-bezier(0.22,1,0.36,1),stroke .18s ease,opacity .15s ease;
    }
    #badge-quota[data-quota-state="available"] .quota-ring-fill{stroke:#22c55e}
    #badge-quota[data-quota-state="low"] .quota-ring-fill{stroke:#f59e0b}
    #badge-quota[data-quota-state="exhausted"] .quota-ring-fill{stroke:#ef4444}
    #badge-quota[data-quota-state="no_permission"] .quota-ring-fill{stroke:#a855f7}
    #badge-quota[data-quota-state="stale"] .quota-ring-fill{stroke:#eab308;opacity:0.8}
    #badge-quota[data-quota-state="error"] .quota-ring-fill{stroke:#f97316}
    #badge-quota[data-quota-state="unknown"] .quota-ring-fill{stroke:var(--ag-text-muted);opacity:0.65}
    .quota-badge-metric{display:inline-flex;align-items:flex-start;line-height:1;gap:1px}
    .quota-badge-val{
      font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;
      color:var(--ag-text-primary);white-space:nowrap;line-height:1.05;min-width:0;text-align:left;
    }
    #badge-quota[data-quota-state="exhausted"] .quota-badge-val{color:#f87171}
    #badge-quota[data-quota-state="error"] .quota-badge-val{color:#fb923c}
    #badge-quota[data-quota-state="no_permission"] .quota-badge-val{color:#c084fc}
    :host([data-theme="light"]) #badge-quota[data-quota-state="exhausted"] .quota-badge-val{color:#dc2626}
    :host([data-theme="light"]) #badge-quota[data-quota-state="error"] .quota-badge-val{color:#ea580c}
    :host([data-theme="light"]) #badge-quota[data-quota-state="no_permission"] .quota-badge-val{color:#7e22ce}
    .quota-badge-tag{
      font-size:10px;font-weight:600;padding:0;margin-left:1px;margin-top:-1px;border:none;border-radius:0;
      background:transparent;color:var(--ag-text-secondary);
      line-height:1;letter-spacing:-0.02em;white-space:nowrap;opacity:0.85;font-variant-numeric:tabular-nums;
    }
    :host([data-layout="compact"]) #badge-quota{padding:0 4px 0 3px;gap:3px}
    :host([data-layout="compact"]) .quota-badge-tag{display:none!important}
    :host([data-layout="minimal"]) #badge-quota,
    :host([data-layout="ring-only"]) #badge-quota{display:none!important}

    /* 单元 2: 输出速度（单色线性闪电 SVG） */
    #badge-speed{
      color:var(--ag-custom-speed,var(--ag-speed-default));
      min-width:54px;justify-content:flex-start;
    }
    #badge-speed:hover,#badge-speed:focus-visible,#badge-speed[aria-expanded="true"]{
      color:var(--ag-custom-speed,var(--ag-toolbar-fg-hover));
    }
    .speed-icon{
      width:13px;height:13px;display:inline-flex;align-items:center;justify-content:center;
      flex-shrink:0;opacity:0.92;line-height:1;
    }
    #badge-speed .speed-icon{transition:color .18s ease}
    #speed-amount{
      font-variant-numeric:tabular-nums;display:inline-block;min-width:32px;text-align:left;color:inherit;
    }

    /* 单元 3: 累计 Token 用量 */
    #badge-tokens{
      color:var(--ag-custom-token-total,var(--ag-token-total-default));
      min-width:68px;justify-content:flex-start;
    }
    #badge-tokens:hover,#badge-tokens:focus-visible,#badge-tokens[aria-expanded="true"]{
      color:var(--ag-custom-token-total,var(--ag-toolbar-fg-hover));
    }
    .token-fire-dot{
      width:13px;height:13px;display:inline-flex;align-items:center;justify-content:center;
      color:var(--ag-custom-token-accent,var(--ag-token-accent-default));flex-shrink:0;opacity:0.95;
    }
    .badge-pct-val{
      font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;
      color:var(--ag-custom-context-text,var(--ag-context-text-default));padding-left:2px;
    }
    :host([data-layout="ring-only"]) .badge-pct-val{display:none!important}
    #token-amount{
      font-variant-numeric:tabular-nums;display:inline-block;min-width:38px;text-align:left;color:inherit;
    }

    /* 下拉选择框与选项在深浅主题下的高对比度保底 */
    select{
      background-color:var(--ag-bg-input) !important;
      color:var(--ag-text-primary,#ececef) !important;
      border:1px solid var(--ag-hairline) !important;
      border-radius:6px;outline:none;color-scheme:dark;font-variant-numeric:tabular-nums;
    }
    :host([data-theme="light"]) select,
    :host([data-panel-tone="light"]) select{
      background-color:var(--ag-bg-input,#f4f4f5) !important;
      color:var(--ag-text-primary,#18181b) !important;
      border-color:var(--ag-hairline) !important;
      color-scheme:light;
    }
    select option{
      background-color:var(--ag-select-option-bg,#27272a) !important;
      color:var(--ag-select-option-fg,#f4f4f5) !important;
    }
    :host([data-theme="light"]) select option,
    :host([data-panel-tone="light"]) select option{
      background-color:#ffffff !important;color:#18181b !important;
    }

    /* 单元 4: 一键启动 CLI 按钮 */
    #badge-cli{
      color:var(--ag-toolbar-fg);min-width:44px;padding:0 6px;gap:3px;justify-content:center;
      transition:transform 0.08s cubic-bezier(0.2, 0, 0, 1),background-color 0.12s ease,opacity 0.12s ease;
      user-select:none;-webkit-user-select:none;
    }
    #badge-cli:hover,#badge-cli:focus-visible{color:var(--ag-toolbar-fg-hover)}
    #badge-cli:active,
    #badge-cli[data-pressed="true"]{
      transform:scale(0.92);background:rgba(127,127,127,0.16);
    }
    #badge-cli[data-busy="true"]{cursor:wait;pointer-events:none}
    #badge-cli[data-busy="true"] .cli-icon{animation:ag-cli-pulse 0.8s ease-in-out infinite alternate}
    @keyframes ag-cli-pulse{
      0%{transform:scale(0.9);opacity:0.6}
      100%{transform:scale(1.15);opacity:1}
    }
    .cli-icon{
      font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
      font-size:10px;font-weight:700;
      color:var(--ag-custom-token-accent,var(--ag-token-accent-default));
      line-height:1;display:inline-block;transition:transform 0.15s ease;
    }

    /* CLI 启动状态提示浮层 */
    #cli-launch-toast{
      position:fixed;top:38px;right:140px;z-index:2147483650;
      max-width:360px;padding:7px 11px;border-radius:8px;
      border:1px solid var(--ag-float-border);
      background:var(--ag-float-bg);color:var(--ag-text-primary);
      box-shadow:var(--ag-float-shadow);font-size:11px;line-height:1.4;
      pointer-events:auto;transition:opacity .15s ease,transform .15s ease;
    }
    #cli-launch-toast[hidden]{display:none!important}
    #cli-launch-toast[data-tone="error"]{border-color:rgba(239,68,68,0.45);color:#f87171}
    :host([data-theme="light"]) #cli-launch-toast[data-tone="error"]{color:#dc2626}

    /* 单元 5: 窄屏溢出菜单入口 */
    #badge-overflow{width:28px;height:28px;padding:0;display:none}
    .overflow-icon{width:16px;height:16px;display:block}

    /* 渐进式宽度收缩四阶段: wide -> compact -> minimal -> ring-only */
    :host([data-layout="compact"]){gap:1px}
    :host([data-layout="compact"]) #badge-speed,
    :host([data-layout="compact"]) #badge-tokens,
    :host([data-layout="compact"]) #badge-cli{
      padding:0 5px;font-size:11px;gap:3px;
    }
    :host([data-layout="minimal"]) #badge-speed,
    :host([data-layout="minimal"]) #badge-tokens,
    :host([data-layout="minimal"]) #badge-cli{
      display:none!important;
    }
    :host([data-layout="minimal"]) #badge-overflow{display:inline-flex!important}
    :host([data-layout="ring-only"]) #badge-speed,
    :host([data-layout="ring-only"]) #badge-tokens,
    :host([data-layout="ring-only"]) #badge-cli,
    :host([data-layout="ring-only"]) #badge-overflow{
      display:none!important;
    }
    .ag-unit[data-user-hidden="true"]{display:none!important}
    :host([data-context-hidden="true"][data-layout="ring-only"]) #badge-overflow{display:inline-flex!important}

    /* 上下文悬停信息气泡 */
    #context-tooltip{
      position:fixed;top:0;left:0;z-index:2147483600;
      min-width:166px;max-width:268px;padding:9px 13px;
      border-radius:10px;border:1px solid var(--ag-float-border);
      background:var(--ag-float-bg);color:var(--ag-text-primary);
      box-shadow:var(--ag-float-shadow);
      pointer-events:none;opacity:0;visibility:hidden;
      transform:translateY(2px);
      transition:opacity .12s ease,transform .12s ease,visibility .12s ease;
      font-variant-numeric:tabular-nums;
    }
    #context-tooltip[data-visible="true"]{opacity:1;visibility:visible;transform:none;}
    .ctx-tip-title{font-size:11px;line-height:1.35;font-weight:500;color:var(--ag-text-muted);margin-bottom:2px}
    .ctx-tip-pct{font-size:13px;line-height:1.35;font-weight:600;color:var(--ag-custom-context-text,var(--ag-context-text-default));font-variant-numeric:tabular-nums}
    :host([data-occupancy="warn"]) .ctx-tip-pct{color:var(--ag-ring-warn)}
    :host([data-occupancy="danger"]) .ctx-tip-pct{color:var(--ag-ring-danger)}
    .ctx-tip-detail{font-size:12px;line-height:1.38;font-weight:500;color:var(--ag-custom-context-text,var(--ag-text-secondary));margin-top:1px;font-variant-numeric:tabular-nums}

    /* 窄屏溢出菜单浮层 */
    #overflow-menu{
      box-sizing:border-box;
      position:fixed;top:36px;right:12px;z-index:2147483500;
      width:220px;padding:6px;border-radius:10px;
      border:1px solid var(--ag-float-border);
      background:var(--ag-float-bg);color:var(--ag-text-primary);
      box-shadow:var(--ag-float-shadow);
      transform-origin:top right;
      font-variant-numeric:tabular-nums;
    }
    #overflow-menu[hidden]{display:none!important}
    .overflow-item{
      width:100%;display:flex;align-items:center;justify-content:space-between;
      padding:7px 9px;border-radius:7px;font-size:12px;color:var(--ag-text-secondary);
      text-align:left;transition:background-color .12s ease,color .12s ease;
    }
    .overflow-item:hover,.overflow-item:focus-visible{
      background:var(--ag-toolbar-bg-hover);color:var(--ag-text-primary);
    }
    .overflow-item-label{display:flex;align-items:center;gap:6px;font-weight:500}
    .overflow-item-val{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ag-text-primary)}

    /* 一对一专属指标浮层 (#panel: 常规面板 460px / 累计用量面板 700px) */
    .ag-panel{
      box-sizing:border-box;
      position:fixed;top:38px;left:auto;right:16px;z-index:2147483500;
      max-width:calc(100vw - 24px);max-height:calc(100vh - 54px);
      overflow:hidden;overflow-anchor:none;border:1px solid var(--ag-border-panel);border-radius:14px;
      background:var(--ag-bg-panel);color:var(--ag-text-primary);box-shadow:var(--ag-shadow-panel);padding:0;
      opacity:1;transform:none;visibility:visible;pointer-events:auto;
      transform-origin:top right;font-variant-numeric:tabular-nums;
      transition:opacity .16s cubic-bezier(0.16,1,0.3,1),transform .16s cubic-bezier(0.16,1,0.3,1),visibility .16s ease;
    }
    .ag-panel.ag-panel-flex{display:flex;flex-direction:column;overflow:hidden;padding:0}
    .ag-panel.ag-panel-flex .panel-header-bar{
      position:relative;top:auto;flex:0 0 auto;margin:0;padding:12px 16px 10px;
      border-bottom:1px solid var(--ag-border-subtle);background:var(--ag-bg-panel);z-index:20;
    }
    #panel{width:460px;max-width:calc(100vw - 24px)}
    #panel[data-wb-wide="true"]{width:700px;max-width:calc(100vw - 24px)}
    .ag-panel[hidden]{display:flex!important;opacity:0;transform:translateY(-6px);visibility:hidden;pointer-events:none}

    /* 动画关键帧与防虚静止态契约 */
    @keyframes agFadeIn{
      from{opacity:0;transform:translateY(4px)}
      to{opacity:1;transform:none}
    }
    @keyframes agSmoothExpand{
      0%{opacity:0;transform:translateY(-6px) scale(0.985);}
      100%{opacity:1;transform:none;}
    }
    .view-pane-fade{transition:opacity .15s ease,transform .15s ease;opacity:1;transform:none}
    #plan-detail-card:not([style*="display: none"]),
    #cost-details-pane:not([style*="display: none"]),
    .drawer-body:not([style*="display: none"]){
      animation:agSmoothExpand 0.2s cubic-bezier(0.16,1,0.3,1);
      transform-origin:top center;
    }

    /* 统一浮层标题栏与全局控制按钮 */
    .panel-header-bar{
      position:sticky;top:-14px;background:var(--ag-bg-panel);z-index:20;
      margin-top:-14px;padding-top:14px;
      display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:nowrap;
      border-bottom:1px solid var(--ag-border-subtle);padding-bottom:9px;margin-bottom:9px;
    }
    .panel-title{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto;overflow:hidden}
    .panel-title-text{
      font-size:13px;font-weight:600;letter-spacing:-0.01em;color:var(--ag-text-primary);
      min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    #v{color:var(--ag-text-muted);font-size:10px;font-weight:400;margin-left:2px;flex-shrink:0;font-variant-numeric:tabular-nums}
    .panel-header-actions{display:flex;align-items:center;gap:4px;flex-wrap:nowrap;flex-shrink:0}
    .ctx-header-subswitch{margin-right:2px}
    .ctx-header-subswitch[hidden]{display:none!important}
    .settings-header-back-btn{padding:2px 8px!important;font-size:11px!important;margin-right:2px;flex-shrink:0;background:var(--ag-surface-2)!important}
    .settings-header-back-btn[hidden]{display:none!important}

    .panel-icon-btn{
      background:none;border:0;color:var(--ag-text-muted);font-size:12px;line-height:1;
      padding:5px 7px;border-radius:6px;cursor:pointer;transition:background-color .14s ease,color .14s ease;
      display:inline-flex;align-items:center;justify-content:center;gap:3px;
    }
    .panel-icon-btn:hover{color:var(--ag-text-primary);background:var(--ag-toolbar-bg-hover)}
    .wb-settings-btn svg{display:block;flex-shrink:0}
    .wb-settings-btn[aria-pressed="true"]{
      color:var(--ag-text-primary);background:var(--ag-surface-2);box-shadow:inset 0 0 0 1px var(--ag-btn-border-hover);
    }
    #close{font-size:16px;padding:2px 7px}

    /* 浮层内容滚动区 */
    .wb-tab-pane{
      flex:1 1 auto;min-height:0;overflow-y:auto;overflow-anchor:none;overscroll-behavior:contain;
      padding:14px 16px 18px;box-sizing:border-box;width:100%;
    }
    .wb-tab-pane[hidden],.ctx-tab-pane[hidden]{display:none!important}
    #panel-quota.wb-tab-pane{padding:0;display:flex;flex-direction:column}
    .quota-panel-body{
      flex:1 1 auto;min-height:0;overflow-y:auto;overflow-anchor:none;overscroll-behavior:contain;
      padding:14px 16px 18px;box-sizing:border-box;
    }

    /* 通用药丸切换器、分段控制器与状态徽章（严格 4 级字阶） */
    .source-switch-bar{
      display:inline-flex;align-items:center;background:var(--ag-surface-2);
      border:0;border-radius:8px;padding:2.5px;gap:2px;
    }
    .switch-pill-btn{
      border:0;background:transparent;color:var(--ag-text-muted);font-size:11px;font-weight:500;
      padding:3px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;
      transition:background-color .12s ease,color .12s ease,box-shadow .12s ease;
    }
    .switch-pill-btn:hover{color:var(--ag-text-primary)}
    .switch-pill-btn.active{
      background:var(--ag-surface-tile);color:var(--ag-text-primary);font-weight:600;
      box-shadow:var(--ag-tile-shadow);
    }
    .ctx-segmented{
      display:inline-flex;align-items:center;background:var(--ag-surface-2);
      border:0;border-radius:8px;padding:2.5px;gap:2px;
    }
    .ctx-seg-btn{
      border:0;background:transparent;color:var(--ag-text-muted);font-size:11px;font-weight:500;
      padding:3px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;
      transition:background-color .12s ease,color .12s ease,box-shadow .12s ease;
    }
    .ctx-seg-btn:hover{color:var(--ag-text-primary)}
    .ctx-seg-btn.active{
      background:var(--ag-surface-tile);color:var(--ag-text-primary);font-weight:600;
      box-shadow:var(--ag-tile-shadow);
    }

    .key-pill{
      font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px;
      border:1px solid transparent;white-space:nowrap;font-variant-numeric:tabular-nums;
    }
    .pill-good,.pill-ok{color:#4ade80;background:rgba(34,197,94,0.12);border-color:rgba(34,197,94,0.24)}
    :host([data-theme="light"]) .pill-good,:host([data-theme="light"]) .pill-ok{color:#15803d;background:rgba(22,163,74,0.10);border-color:rgba(22,163,74,0.24)}
    .pill-info{color:#38bdf8;background:rgba(56,189,248,0.12);border-color:rgba(56,189,248,0.24)}
    :host([data-theme="light"]) .pill-info{color:#0369a1;background:rgba(2,132,199,0.10);border-color:rgba(2,132,199,0.24)}
    .pill-warn{color:#fbbf24;background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.25)}
    :host([data-theme="light"]) .pill-warn{color:#b45309;background:rgba(217,119,6,0.10);border-color:rgba(217,119,6,0.25)}
    .pill-danger{color:#f87171;background:rgba(239,68,68,0.13);border-color:rgba(239,68,68,0.28)}
    :host([data-theme="light"]) .pill-danger{color:#dc2626;background:rgba(220,38,38,0.09);border-color:rgba(220,38,38,0.25)}
    .pill-muted{color:var(--ag-pill-muted-text);background:var(--ag-pill-muted-bg);border-color:var(--ag-pill-muted-border)}

    /* 原生定制下拉组件 */
    .ag-dropdown-wrapper{position:relative;width:100%;box-sizing:border-box}
    .ag-dropdown-trigger{
      width:100%;box-sizing:border-box;
      display:flex;align-items:center;justify-content:space-between;gap:6px;
      padding:5px 8px;font-size:11px;color:var(--ag-text-primary);
      background:var(--ag-surface-2);border:1px solid var(--ag-hairline);border-radius:6px;
      cursor:pointer;user-select:none;
      transition:background .15s cubic-bezier(0.16,1,0.3,1),border-color .15s cubic-bezier(0.16,1,0.3,1),box-shadow .15s cubic-bezier(0.16,1,0.3,1);
    }
    .ag-dropdown-trigger:hover{background:var(--ag-surface-hover);border-color:var(--ag-btn-border-hover)}
    .ag-dropdown-wrapper.is-open .ag-dropdown-trigger{
      border-color:var(--ag-token-accent-default,#a78bfa);
      box-shadow:0 0 0 2px rgba(167,139,250,0.22);background:var(--ag-surface-2);
    }
    .ag-dropdown-arrow{
      width:10px;height:10px;display:flex;align-items:center;justify-content:center;
      flex-shrink:0;opacity:0.65;transition:transform 0.2s cubic-bezier(0.16,1,0.3,1),opacity 0.2s ease;
    }
    .ag-dropdown-wrapper.is-open .ag-dropdown-arrow{transform:rotate(180deg);opacity:1}
    .ag-dropdown-wrapper.is-open{z-index:2147483647 !important}
    .ag-dropdown-menu{
      position:absolute;top:calc(100% + 4px);left:0;right:0;
      max-height:240px;overflow-y:auto;overflow-anchor:none;
      background:var(--ag-unified-bg,#1e1e24);
      border:1px solid var(--ag-float-border,rgba(255,255,255,0.14));
      border-radius:8px;
      box-shadow:0 16px 40px rgba(0,0,0,0.60),0 4px 12px rgba(0,0,0,0.35);
      padding:4px;z-index:2147483647 !important;
      opacity:0;transform:translateY(-6px) scale(0.97);
      transform-origin:top center;pointer-events:none;
      transition:opacity 0.16s cubic-bezier(0.16,1,0.3,1),transform 0.16s cubic-bezier(0.16,1,0.3,1);
    }
    .ag-dropdown-search-wrap{
      position:sticky;top:-4px;margin:-4px -4px 4px -4px;padding:6px;
      background:var(--ag-unified-bg,#1e1e24);border-bottom:1px solid var(--ag-hairline);z-index:10;
    }
    .ag-dropdown-search-input{
      width:100%;box-sizing:border-box;background:var(--ag-bg-input);
      border:1px solid var(--ag-hairline);border-radius:5px;padding:4px 7px;font-size:11px;
      color:var(--ag-text-primary);outline:none;
    }
    .ag-dropdown-search-input:focus{border-color:var(--ag-token-accent-default,#a78bfa)}
    .ag-dropdown-wrapper.is-open .ag-dropdown-menu{opacity:1;transform:none;pointer-events:auto;}
    .ag-dropdown-item{
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      padding:6px 9px;border-radius:6px;font-size:11px;color:var(--ag-text-secondary);
      cursor:pointer;user-select:none;transition:background 0.12s ease,color 0.12s ease;min-width:0;
    }
    .ag-dropdown-item-label{
      flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    .ag-dropdown-item:hover{background:var(--ag-surface-hover);color:var(--ag-text-primary)}
    .ag-dropdown-item.is-selected{
      color:var(--ag-token-accent-default,#a78bfa);font-weight:600;background:rgba(167,139,250,0.12);
    }
    .ag-dropdown-item-check{font-size:10px;opacity:0;color:var(--ag-token-accent-default,#a78bfa);flex-shrink:0}
    .ag-dropdown-item.is-selected .ag-dropdown-item-check{opacity:1}
    .ag-dropdown-item.is-keyboard-focus{background:var(--ag-surface-hover);outline:1px solid rgba(167,139,250,0.4)}
    .ag-dropdown-wrapper.open-up .ag-dropdown-menu{
      top:auto;bottom:calc(100% + 4px);transform-origin:bottom center;transform:translateY(6px) scale(0.97);
    }
    .ag-dropdown-wrapper.is-open.open-up .ag-dropdown-menu{transform:none}
    .ag-dropdown-item-right{display:inline-flex;align-items:center;gap:6px;margin-left:auto;padding-left:6px;flex-shrink:0}
    .ag-dropdown-item-sub{font-size:10px;color:var(--ag-text-muted);margin-left:auto;padding-left:8px;font-variant-numeric:tabular-nums;white-space:nowrap;flex-shrink:0}
    .ag-dropdown-item-right .ag-dropdown-item-sub{margin-left:0;padding-left:0}
    .ag-dropdown-item:hover .ag-dropdown-item-sub{color:var(--ag-text-secondary)}
    .ag-dropdown-group-title{
      display:flex;align-items:center;gap:6px;padding:5px 8px 3px;font-size:10px;font-weight:600;
      color:var(--ag-text-muted);letter-spacing:0.2px;cursor:default;user-select:none;
      border-top:1px solid var(--ag-border-subtle);margin-top:3px;
    }
    .ag-dropdown-group-title:first-child{border-top:0;margin-top:0}
    .ag-dropdown-badge{
      font-size:10px;padding:0 5px;border-radius:9px;background:rgba(56,189,248,0.14);
      color:var(--ag-link,#38bdf8);border:1px solid rgba(56,189,248,0.28);margin-left:4px;flex-shrink:0;
    }
    .ag-dropdown-menu::-webkit-scrollbar{width:4px}
    .ag-dropdown-menu::-webkit-scrollbar-thumb{background:var(--ag-scrollbar-thumb);border-radius:4px}
    .ag-vendor-dot{width:7px;height:7px;border-radius:999px;display:inline-block;flex-shrink:0;background:var(--ag-text-muted)}

    /* ========================================================= */
    /* 专属浮层 1: 模型额度 (#panel-quota)                        */
    /* ========================================================= */
    .quota-header-updated{
      font-size:11px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums;
      white-space:nowrap;margin-right:3px;
    }
    .quota-header-updated[hidden],.quota-refresh-btn[hidden]{display:none!important}
    .quota-refresh-feedback{
      display:inline-flex;align-items:center;
      font-size:10px;font-weight:500;color:#4ade80;
      background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.24);
      padding:1px 6px;border-radius:999px;white-space:nowrap;
      opacity:1;visibility:visible;transition:opacity .18s ease,visibility .18s ease;
    }
    :host([data-theme="light"]) .quota-refresh-feedback{color:#15803d;background:#dcfce7;border-color:#86efac}
    .quota-refresh-feedback[hidden]{display:inline-flex!important;opacity:0;visibility:hidden;pointer-events:none}
    @media (max-width:440px){.quota-refresh-feedback[hidden]{display:none!important}}
    .quota-refresh-btn{
      gap:4px;font-size:11px;padding:3px 8px;border:1px solid var(--ag-btn-border);
      border-radius:6px;background:var(--ag-btn-bg);color:var(--ag-text-secondary);
      transition:background .15s ease,border-color .15s ease,color .15s ease;
    }
    .quota-refresh-btn:not(:disabled):hover{color:var(--ag-text-primary);background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}
    .quota-refresh-btn[disabled]{cursor:progress;color:var(--ag-text-primary);background:var(--ag-btn-hover)}
    .quota-refresh-icon{display:inline-block;transform-origin:center}

    .quota-banner{
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      padding:8px 11px;border-radius:8px;margin-bottom:10px;font-size:11px;line-height:1.4;
      border:1px solid rgba(245,158,11,0.32);background:rgba(245,158,11,0.10);color:var(--ag-text-primary);
    }
    .quota-banner[hidden],.quota-cur-alert[hidden],.quota-cur-est[hidden],.quota-bucket-est[hidden],#quota-plan-tier-pill[hidden],#btn-quota-banner-restart[hidden]{display:none !important}
    .quota-banner .switch-pill-btn{white-space:nowrap;flex-shrink:0}
    .quota-banner[data-tone="error"]{border-color:rgba(239,68,68,0.38);background:rgba(239,68,68,0.11)}

    .quota-plan-credits-card{
      background:var(--ag-surface-1);border:0;
      border-radius:12px;padding:11px 13px;margin-bottom:12px;display:flex;flex-direction:column;gap:9px;
    }
    .quota-plan-top-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .quota-plan-identity{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
    .quota-plan-name{font-size:12px;font-weight:600;color:var(--ag-text-primary)}
    .quota-plan-email{font-size:11px;color:var(--ag-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .quota-credits-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .quota-credit-item{
      background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);border:0;border-radius:8px;padding:7px 10px;
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      white-space:nowrap;font-size:11px;font-variant-numeric:tabular-nums;
    }
    .quota-credit-lbl{color:var(--ag-text-muted);font-size:11px;white-space:nowrap}
    .quota-credit-val{font-weight:600;color:var(--ag-text-primary);font-size:11px;font-variant-numeric:tabular-nums}

    .quota-current-card{
      background:var(--ag-surface-1);border:0;
      border-radius:12px;padding:14px 14px 13px;margin-bottom:14px;
    }
    .quota-cur-header{align-items:flex-start}
    .quota-cur-main,.quota-cur-header-main{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:2px}
    .quota-cur-hero-right{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0}
    .quota-hero-pct{
      font-size:24px;font-weight:700;letter-spacing:-0.03em;line-height:1.05;
      font-variant-numeric:tabular-nums;color:#4ade80;
    }
    .quota-hero-pct[hidden]{display:none!important}
    .quota-hero-pct[data-status="low"]{color:#fbbf24}
    .quota-hero-pct[data-status="exhausted"]{color:#f87171}
    .quota-hero-pct[data-status="stale"]{color:#eab308}
    :host([data-theme="light"]) .quota-hero-pct{color:#16a34a}
    :host([data-theme="light"]) .quota-hero-pct[data-status="low"]{color:#d97706}
    :host([data-theme="light"]) .quota-hero-pct[data-status="exhausted"]{color:#dc2626}
    :host([data-theme="light"]) .quota-hero-pct[data-status="stale"]{color:#a16207}
    .ctx-small-label{font-size:10px;color:var(--ag-text-muted)}
    .quota-cur-label,.quota-cur-eyebrow{font-size:10px;font-weight:500;color:var(--ag-text-muted)}
    .quota-cur-model-name{font-size:14px;font-weight:600;letter-spacing:-0.01em;color:var(--ag-text-primary);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .quota-cur-pool-sub{font-size:11px;color:var(--ag-text-muted);margin-top:1px}
    .quota-cur-est{
      font-size:11px;color:var(--ag-text-secondary);margin-top:3px;
      font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .quota-cur-alert{
      margin-top:8px;padding:6px 9px;border-radius:7px;font-size:11px;line-height:1.4;
      background:rgba(168,85,247,0.10);border:1px solid rgba(168,85,247,0.24);color:var(--ag-text-secondary);
    }
    .quota-cur-alert[data-kind="notice"]{background:rgba(56,189,248,0.09);border-color:rgba(56,189,248,0.24)}
    .quota-buckets-list{display:flex;flex-direction:column;gap:8px;margin-top:11px}
    .quota-bucket-row{display:flex;flex-direction:column;gap:5px}
    .quota-bucket-meta{display:flex;justify-content:space-between;align-items:center;font-size:11px;gap:6px;font-variant-numeric:tabular-nums}
    .quota-bucket-name{color:var(--ag-text-secondary);font-weight:500}
    .quota-bucket-val{font-weight:600;font-variant-numeric:tabular-nums;color:var(--ag-text-primary);text-align:right}
    .quota-pct-num{display:inline-block;min-width:34px;text-align:right;font-variant-numeric:tabular-nums}
    .quota-bucket-est{font-size:10px;color:var(--ag-text-muted);line-height:1.35;font-variant-numeric:tabular-nums}
    .quota-bar-track{position:relative;width:100%;height:6px;border-radius:999px;background:var(--ag-track-bg);overflow:hidden}
    .quota-bar-fill{width:100%;height:100%;border-radius:999px;background:#22c55e;transform-origin:left center;transform:scaleX(var(--quota-scale,0));transition:transform .22s cubic-bezier(0.22,1,0.36,1),background-color .18s ease;will-change:transform}
    .quota-bar-fill[data-status="low"]{background:#f59e0b}
    .quota-bar-fill[data-status="exhausted"]{background:#ef4444}
    .quota-bar-fill[data-status="no_permission"]{background:#a855f7}
    .quota-bar-fill[data-status="unknown"]{background:var(--ag-text-muted)}
    .quota-bar-charge-stage{
      position:absolute;left:0;top:0;bottom:0;width:0;border-radius:3px;overflow:hidden;pointer-events:none;
      --quota-charge-bg:linear-gradient(90deg,rgba(34,197,94,0.92) 0%,#4ade80 62%,#bbf7d0 100%);
    }
    .quota-bar-charge-stage[hidden]{display:none!important}
    .quota-bar-charge-stage[data-status="low"]{--quota-charge-bg:linear-gradient(90deg,rgba(245,158,11,0.92) 0%,#fbbf24 62%,#fef08a 100%)}
    .quota-bar-charge-stage[data-status="exhausted"]{--quota-charge-bg:linear-gradient(90deg,rgba(239,68,68,0.92) 0%,#f87171 62%,#fecaca 100%)}
    :host([data-theme="light"]) .quota-bar-charge-stage{--quota-charge-bg:linear-gradient(90deg,rgba(22,163,74,0.94) 0%,#4ade80 68%,#dcfce7 100%)}
    :host([data-theme="light"]) .quota-bar-charge-stage[data-status="low"]{--quota-charge-bg:linear-gradient(90deg,rgba(217,119,6,0.94) 0%,#fbbf24 68%,#fef3c7 100%)}
    :host([data-theme="light"]) .quota-bar-charge-stage[data-status="exhausted"]{--quota-charge-bg:linear-gradient(90deg,rgba(220,38,38,0.94) 0%,#f87171 68%,#fee2e2 100%)}
    .quota-bar-charge-fill{
      position:absolute;inset:0;border-radius:3px;background:var(--quota-charge-bg);
      transform-origin:left center;transform:scaleX(0);opacity:0;will-change:transform,opacity;
    }
    .quota-bar-charge-sheen{
      position:absolute;top:0;bottom:0;left:0;width:62%;
      background:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,255,255,0.82) 50%,rgba(255,255,255,0) 100%);
      transform:translateX(-120%);opacity:0;will-change:transform,opacity;
    }
    .quota-bar-track[data-charging="true"] .quota-bar-charge-fill{animation:ag-quota-bar-charge-fill 720ms linear forwards}
    .quota-bar-track[data-charging="true"] .quota-bar-charge-sheen{animation:ag-quota-bar-charge-sheen 720ms linear forwards}
    @keyframes ag-quota-bar-charge-fill{
      0%{transform:scaleX(0);opacity:0.96;animation-timing-function:cubic-bezier(0.22,1,0.36,1)}
      55%{transform:scaleX(1);opacity:1}
      76%{transform:scaleX(1);opacity:0.9;animation-timing-function:ease-out}
      100%{transform:scaleX(1);opacity:0}
    }
    @keyframes ag-quota-bar-charge-sheen{
      0%,34%{transform:translateX(-115%);opacity:0;animation-timing-function:cubic-bezier(0.35,0,0.25,1)}
      43%{opacity:1}
      76%{transform:translateX(175%);opacity:0.95}
      85%,100%{transform:translateX(190%);opacity:0}
    }

    .quota-pools-header{display:flex;justify-content:space-between;align-items:baseline;margin:2px 0 8px;gap:8px}
    .quota-subsec-title,.quota-pools-title{font-size:12px;font-weight:600;color:var(--ag-text-secondary)}
    .quota-pools-list{display:flex;flex-direction:column;gap:9px}
    .quota-pool-card{
      background:var(--ag-surface-1);border:1px solid transparent;
      border-radius:12px;padding:11px 13px;cursor:pointer;transition:border-color .14s ease,background-color .14s ease;
    }
    .quota-pool-card:hover{background:var(--ag-surface-2)}
    .quota-pool-card[data-active-current="true"]{border-color:rgba(34,197,94,0.38)}
    .quota-pool-card[data-browsing="true"]{box-shadow:inset 0 0 0 1px rgba(56,189,248,0.45)}
    .quota-pool-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px}
    .quota-pool-title{font-size:12px;font-weight:600;color:var(--ag-text-primary);line-height:1.35}
    .quota-pool-tags{display:flex;align-items:center;gap:4px;flex-shrink:0;flex-wrap:wrap}
    .quota-current-tag{font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(56,189,248,0.14);color:#38bdf8;border:1px solid rgba(56,189,248,0.28);font-weight:600}
    :host([data-theme="light"]) .quota-current-tag{color:#0284c7;background:#e0f2fe;border-color:#7dd3fc}
    .quota-models-chips{
      margin-top:8px;padding-top:7px;border-top:1px solid var(--ag-hairline);
      font-size:11px;color:var(--ag-text-muted);line-height:1.35;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .quota-models-chips[hidden]{display:none!important}

    /* ========================================================= */
    /* 专属浮层 2: 上下文窗口 (#pane-ctx-session / #pane-ctx-models) */
    /* ========================================================= */
    h3{margin:0;font-size:13px;font-weight:600;color:var(--ag-text-primary)}
    h4{margin:12px 0 5px;font-size:11px;font-weight:600;color:var(--ag-text-secondary)}
    p{margin:5px 0;color:var(--ag-text-muted);font-size:11px}

    #key-summary{
      background:var(--ag-surface-1);border:0;
      border-radius:12px;padding:14px;margin:0 0 12px;
    }
    .key-header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:9px}
    .key-summary-hero-header{align-items:flex-end;margin-bottom:10px}
    .key-title-stack{display:flex;flex-direction:column;gap:2px}
    .ctx-hero-pct{
      font-size:24px;font-weight:700;letter-spacing:-0.03em;line-height:1.05;
      font-variant-numeric:tabular-nums;color:var(--ag-text-primary);
    }
    .ctx-hero-pct[hidden]{display:none!important}
    .ctx-hero-pct[data-tone="muted"]{color:var(--ag-text-muted)}
    .ctx-hero-pct[data-tone="warn"]{color:var(--ag-ring-warn)}
    .ctx-hero-pct[data-tone="danger"]{color:var(--ag-ring-danger)}
    .key-title{font-size:11px;font-weight:500;color:var(--ag-text-muted);display:flex;align-items:center;gap:5px}
    .key-bar-track{width:100%;height:6px;background:var(--ag-custom-ring-track,var(--ag-track-bg));border-radius:999px;overflow:hidden;margin-bottom:11px}
    .key-bar-fill{height:100%;width:0%;border-radius:999px;background:var(--ag-custom-ring-used,var(--bar-color,#69c0ff));transition:width .24s ease,background-color .2s ease}
    :host([data-occupancy="warn"]) .key-bar-fill{background:var(--ag-ring-warn)}
    :host([data-occupancy="danger"]) .key-bar-fill{background:var(--ag-ring-danger)}
    .key-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;text-align:center;margin-bottom:9px;min-width:0}
    .key-stat{background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);padding:9px 7px;border-radius:9px;border:0;min-width:0}
    .key-stat-label{font-size:10px;color:var(--ag-text-muted);margin-bottom:3px;overflow-wrap:anywhere}
    .key-stat-val{
      font-size:13px;font-weight:700;letter-spacing:-0.01em;color:var(--ag-text-primary);
      font-variant-numeric:tabular-nums;overflow-wrap:anywhere;word-break:break-word;white-space:normal;line-height:1.25;
    }
    #key-used{color:var(--ag-custom-context-text,var(--ag-text-primary))}
    .key-takeaway{font-size:11px;color:var(--ag-text-secondary);padding-top:8px;border-top:1px solid var(--ag-hairline);line-height:1.45}
    .key-takeaway[hidden]{display:none!important}

    .round-cost-bar{
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      font-size:11px;font-variant-numeric:tabular-nums;
    }
    .round-cost-bar[hidden]{display:none!important}
    .round-cost-footer{
      margin:8px 0 0!important;padding:7px 0 0!important;border:0!important;
      border-top:1px dashed var(--ag-hairline)!important;border-radius:0!important;background:transparent!important;
      font-size:11px;
    }
    .round-cost-primary{font-size:11px;font-weight:600;color:var(--ag-text-primary);font-variant-numeric:tabular-nums}
    .round-cost-secondary{font-size:11px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums}

    /* 最新调用与会话时间线 */
    @keyframes agCallEnter{
      from{opacity:0;transform:translateY(5px)}
      to{opacity:1;transform:translateY(0)}
    }
    .latest-call-card{
      background:var(--ag-surface-1);border:0;border-radius:12px;
      padding:12px 13px;margin-top:12px;display:flex;flex-direction:column;gap:8px;min-width:0;
    }
    .latest-call-card[hidden]{display:none!important}
    .latest-call-header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}
    .latest-call-title-wrap{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
    .latest-call-title{font-size:12px;font-weight:600;color:var(--ag-text-primary);white-space:nowrap}
    .latest-call-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
    .latest-call-time{font-size:10px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums}
    .latest-call-link-btn{
      background:var(--ag-surface-2);border:1px solid var(--ag-hairline);color:var(--ag-text-secondary);
      border-radius:5px;padding:2px 8px;font-size:10px;cursor:pointer;white-space:nowrap;
    }
    .latest-call-link-btn:hover{background:var(--ag-btn-hover);color:var(--ag-text-primary);border-color:var(--ag-btn-border-hover)}
    .call-agent-badge{
      display:inline-flex;align-items:center;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:600;
      background:rgba(59,130,246,0.14);color:#60a5fa;border:1px solid rgba(59,130,246,0.26);white-space:nowrap;
    }
    .call-agent-badge.is-subagent{
      background:rgba(167,139,250,0.14);color:var(--ag-custom-token-accent,#a78bfa);border-color:rgba(167,139,250,0.32);
    }
    .call-agent-badge.is-unknown{
      background:var(--ag-surface-2);color:var(--ag-text-muted);border-color:var(--ag-hairline);
    }
    :host([data-theme="light"]) .call-agent-badge{color:#2563eb;background:rgba(37,99,235,0.10)}
    :host([data-theme="light"]) .call-agent-badge.is-subagent{color:#7c3aed;background:rgba(124,58,237,0.10)}
    .latest-call-new-banner{
      width:100%;text-align:center;padding:5px 8px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;
      background:rgba(37,99,235,0.14);color:#60a5fa;border:1px solid rgba(37,99,235,0.32);
    }
    :host([data-theme="light"]) .latest-call-new-banner{color:#1d4ed8;background:rgba(37,99,235,0.09)}
    .latest-call-new-banner[hidden]{display:none!important}
    .latest-call-body{min-width:0}
    .latest-call-body.is-entering{animation:agCallEnter .21s cubic-bezier(0.16,1,0.3,1) both}
    .latest-call-summary-row{
      display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;
      background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);border:1px solid transparent;border-radius:8px;
      padding:8px 10px;cursor:pointer;min-width:0;transition:background-color .12s ease,border-color .12s ease;
    }
    .latest-call-summary-row:hover{border-color:var(--ag-btn-border-hover);background:var(--ag-surface-hover)}
    .latest-call-model-wrap{display:flex;align-items:center;gap:5px;min-width:0;flex:1 1 140px}
    .latest-call-model{font-size:12px;font-weight:600;color:var(--ag-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    .call-effort-tag{
      font-size:10px;font-weight:600;padding:1px 5px;border-radius:4px;white-space:nowrap;flex-shrink:0;
      background:var(--ag-surface-1);border:1px solid var(--ag-hairline);color:var(--ag-text-secondary);
    }
    .latest-call-metrics{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums;min-width:0}
    .latest-call-metric-item{white-space:nowrap;font-variant-numeric:tabular-nums}
    .latest-call-expand-caret{font-size:10px;color:var(--ag-text-muted);flex-shrink:0;transition:transform .16s ease}
    .latest-call-summary-row[aria-expanded="true"] .latest-call-expand-caret{transform:rotate(180deg)}
    .latest-call-details{
      margin-top:6px;background:var(--ag-surface-2);border-radius:7px;
      padding:8px 10px;font-size:11px;line-height:1.45;min-width:0;overflow:hidden;
    }
    .call-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 10px;min-width:0}
    .call-detail-cell{display:flex;flex-direction:column;gap:2px;min-width:0}
    .call-detail-k{font-size:10px;color:var(--ag-text-muted);overflow-wrap:anywhere;white-space:normal}
    .call-detail-v{font-size:11px;font-weight:500;color:var(--ag-text-primary);overflow-wrap:anywhere;word-break:break-word;white-space:normal;font-variant-numeric:tabular-nums}
    .call-detail-note{font-size:10px;line-height:1.4;color:var(--ag-text-secondary);margin-top:2px;overflow-wrap:anywhere;white-space:normal}
    .tier-color-swatch{display:inline-block;width:7px;height:7px;border-radius:999px;margin-right:4px;vertical-align:middle;flex-shrink:0}
    .call-detail-error{
      margin-top:6px;padding:6px 8px;border-radius:6px;font-size:11px;overflow-wrap:anywhere;
      background:rgba(239,68,68,0.10);border:1px solid rgba(239,68,68,0.26);color:#f87171;
    }
    :host([data-theme="light"]) .call-detail-error{color:#dc2626}
    .call-detail-error[hidden]{display:none!important}
    .call-score-badge{
      display:inline-flex;align-items:center;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:700;
      border:1px solid transparent;white-space:nowrap;font-variant-numeric:tabular-nums;
    }
    .call-score-badge[hidden]{display:none!important}

    .session-timeline-drawer{
      margin-top:7px;padding-top:8px;border-top:1px solid var(--ag-hairline);
      display:flex;flex-direction:column;gap:7px;min-width:0;
    }
    .session-timeline-summary{
      font-size:10px;color:var(--ag-text-muted);line-height:1.45;background:var(--ag-surface-2);
      border-radius:6px;padding:6px 8px;font-variant-numeric:tabular-nums;
    }
    .session-timeline-list{display:flex;flex-direction:column;gap:6px;max-height:360px;overflow-y:auto;padding-right:2px}
    .timeline-turn-card{background:var(--ag-surface-2);border-radius:7px;overflow:hidden;min-width:0}
    .timeline-turn-hdr{
      width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 9px;
      background:transparent;border:none;color:inherit;cursor:pointer;text-align:left;min-width:0;
    }
    .timeline-turn-hdr:hover{background:var(--ag-surface-hover)}
    .timeline-turn-left{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
    .timeline-turn-idx{font-size:10px;font-weight:700;color:var(--ag-custom-token-accent,#60a5fa);white-space:nowrap;flex-shrink:0;font-variant-numeric:tabular-nums}
    .timeline-turn-prompt{font-size:11px;font-weight:500;color:var(--ag-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    .timeline-turn-meta{font-size:10px;color:var(--ag-text-muted);white-space:nowrap;flex-shrink:0;font-variant-numeric:tabular-nums}
    .timeline-turn-body{padding:0 8px 7px;display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--ag-hairline)}
    .timeline-call-row{
      display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;margin-top:4px;
      border-radius:6px;background:var(--ag-surface-1);border:1px solid var(--ag-hairline);
      font-size:11px;cursor:pointer;min-width:0;flex-wrap:wrap;
    }
    .timeline-call-row:hover{border-color:var(--ag-btn-border-hover)}
    .timeline-call-row.is-subagent{margin-left:14px;border-left:2px solid var(--ag-custom-token-accent,#a78bfa)}
    .timeline-call-row.is-selected{border-color:var(--ag-custom-token-accent,#60a5fa)}
    .timeline-call-main{display:flex;align-items:center;gap:5px;min-width:0;flex:1 1 130px}
    .timeline-call-stats{display:flex;align-items:center;gap:6px;color:var(--ag-text-secondary);font-size:10px;font-variant-numeric:tabular-nums;flex-wrap:wrap}
    .session-timeline-unlinked{
      background:var(--ag-surface-2);border:1px dashed var(--ag-hairline);border-radius:6px;padding:6px 8px;
      display:flex;flex-direction:column;gap:4px;
    }
    .session-timeline-unlinked-title{font-size:10px;font-weight:600;color:var(--ag-text-muted)}
    .session-timeline-more-wrap{display:flex;justify-content:center;padding-top:2px}
    .session-timeline-more-wrap[hidden],.session-timeline-unlinked[hidden]{display:none!important}
    .ctx-compact-link-btn{
      background:var(--ag-surface-2);border:1px solid var(--ag-hairline);color:var(--ag-text-primary);
      border-radius:6px;padding:4px 10px;font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap;flex-shrink:0;
    }
    .ctx-compact-link-btn:hover{background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}

    /* 底层技术参数折叠抽屉 */
    .tech-drawer{margin-top:12px;border-top:0;padding-top:0}
    .drawer-trigger{
      width:100%;display:flex;justify-content:space-between;align-items:center;
      background:var(--ag-surface-1);border:0;
      border-radius:10px;padding:9px 12px;color:var(--ag-text-secondary);font-size:11px;font-weight:500;
      cursor:pointer;transition:background-color .15s ease,color .15s ease;
    }
    .drawer-trigger:hover{background:var(--ag-surface-2);color:var(--ag-text-primary);border-color:var(--ag-btn-border-hover)}
    .drawer-trigger-left{display:flex;align-items:center;gap:6px}
    .drawer-arrow{font-size:10px;color:var(--ag-text-muted);font-weight:600}
    .drawer-body{margin-top:9px}
    .drawer-body dl{display:grid;grid-template-columns:1fr auto;gap:5px 10px;margin:0;font-size:11px}
    .drawer-body dt{color:var(--ag-text-muted);font-size:11px}
    .drawer-body dd{margin:0;text-align:right;color:var(--ag-text-primary);font-size:11px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;max-width:270px}
    #status{padding:7px 10px;border:0;border-left:2.5px solid var(--tone,#666);border-radius:5px;background:var(--ag-bg-status);color:var(--ag-text-status);font-weight:500;font-size:11px}
    #model{overflow-wrap:anywhere;font-size:11px;color:var(--ag-text-muted)}
    #note,#coverage,#updated{font-size:10px;color:var(--ag-text-muted);line-height:1.45}
    #refresh{
      border:1px solid var(--ag-btn-border);border-radius:6px;background:var(--ag-btn-bg);
      color:var(--ag-btn-text);font-size:11px;padding:4px 10px;margin-top:8px;
      transition:background-color .14s ease,border-color .14s ease;
    }
    #refresh:hover:not(:disabled){background:var(--ag-btn-hover);border-color:var(--ag-btn-border-hover)}
    #files{max-height:220px;overflow:auto}
    .file{padding:7px 0;border-top:1px solid var(--ag-border-subtle)}
    .file-name{overflow-wrap:anywhere;color:var(--ag-text-primary);font-size:11px}
    .file-detail{color:var(--ag-text-muted);font-size:10px;font-variant-numeric:tabular-nums}
    .file-unknown{color:#e6b865;font-size:10px}
    :host([data-theme="light"]) .file-unknown{color:#b45309}

    /* 窗口规格子视图 (#pane-ctx-models) */
    .ctx-models-toolbar{
      display:flex;align-items:center;justify-content:flex-end;gap:8px;
      padding:0 2px 8px;margin-bottom:2px;
    }
    .ctx-models-toolbar[hidden]{display:none!important}
    .ctx-model-select{display:none}
    .ctx-mini-link-btn{
      background:none;border:0;color:var(--ag-link,#38bdf8);font-size:10px;padding:2px 4px;
      cursor:pointer;white-space:nowrap;flex-shrink:0;text-decoration:underline;text-underline-offset:2px;
    }
    .ctx-mini-link-btn[hidden]{display:none!important}
    .ctx-compact-trigger{padding:4px 8px!important;font-size:11px!important;max-width:100%}
    .ctx-compact-trigger .ag-dropdown-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}

    .ctx-model-list{
      display:flex;flex-direction:column;gap:6px;max-height:190px;overflow-y:auto;overflow-anchor:none;
      background:var(--ag-surface-1);border:0;border-radius:12px;padding:8px;margin-bottom:12px;
    }
    .ctx-model-group{display:flex;flex-direction:column;gap:2px}
    .ctx-model-group-hdr{display:flex;align-items:center;gap:5px;font-size:10px;font-weight:600;color:var(--ag-text-muted);padding:2px 5px}
    .ctx-model-group-hdr.is-history-hdr{margin-top:4px;border-top:1px dashed var(--ag-hairline);padding-top:6px;opacity:0.85}
    .ctx-product-row{
      display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;text-align:left;
      background:transparent;border:1px solid transparent;border-radius:6px;padding:5px 8px;
      cursor:pointer;color:var(--ag-text-secondary);font-size:11px;transition:background .12s ease,border-color .12s ease;
    }
    .ctx-product-row:hover{background:var(--ag-surface-2);color:var(--ag-text-primary)}
    .ctx-product-row.is-active{background:rgba(37,99,235,0.14);border-color:rgba(37,99,235,0.38);color:var(--ag-text-primary);font-weight:600}
    .ctx-product-row.is-unavailable{opacity:0.65}
    .ctx-product-row-history-tag{font-size:10px;padding:0 4px;border-radius:3px;background:var(--ag-surface-2);color:var(--ag-text-muted);flex-shrink:0}
    .ctx-product-row-unavailable-tag{font-size:10px;padding:0 4px;border-radius:3px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.28);color:#ef4444;flex-shrink:0}
    .ctx-product-row-notice-tag{font-size:10px;padding:0 4px;border-radius:3px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.28);color:#f59e0b;flex-shrink:0}
    .ctx-product-row-left{display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden}
    .ctx-product-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ctx-product-row-right{display:flex;align-items:center;gap:5px;flex-shrink:0;font-size:10px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums}
    .ctx-product-row-val{font-variant-numeric:tabular-nums}

    .ctx-model-quota-chip{
      display:inline-flex;align-items:center;gap:4px;padding:1px 6px 1px 4px;border-radius:999px;
      background:var(--ag-surface-2);border:1px solid var(--ag-hairline);font-size:10px;font-weight:600;
      line-height:14px;font-variant-numeric:tabular-nums;color:var(--ag-text-secondary);white-space:nowrap;flex-shrink:0;
      transition:border-color .18s ease,background-color .18s ease,color .18s ease;
    }
    .ctx-model-quota-chip.is-dropdown{padding:1px 5px 1px 4px;font-size:10px}
    .ctx-model-quota-chip.is-card{padding:2px 7px 2px 5px;font-size:10px}
    .ctx-quota-ring-svg{width:13px;height:13px;display:block;flex-shrink:0;overflow:visible}
    .ctx-quota-ring-track{stroke:var(--ag-custom-ring-track,var(--ag-ring-track-default))}
    .ctx-quota-ring-fill{stroke:#22c55e;transition:stroke-dashoffset .24s cubic-bezier(0.22,1,0.36,1),stroke .18s ease,opacity .15s ease}
    .ctx-model-quota-chip[data-quota-state="available"]{background:rgba(34,197,94,0.10);border-color:rgba(34,197,94,0.26);color:#4ade80}
    .ctx-model-quota-chip[data-quota-state="available"] .ctx-quota-ring-fill{stroke:#22c55e}
    .ctx-model-quota-chip[data-quota-state="low"]{background:rgba(245,158,11,0.11);border-color:rgba(245,158,11,0.30);color:#fbbf24}
    .ctx-model-quota-chip[data-quota-state="low"] .ctx-quota-ring-fill{stroke:#f59e0b}
    .ctx-model-quota-chip[data-quota-state="exhausted"]{background:rgba(239,68,68,0.11);border-color:rgba(239,68,68,0.30);color:#f87171}
    .ctx-model-quota-chip[data-quota-state="exhausted"] .ctx-quota-ring-fill{stroke:#ef4444}
    .ctx-model-quota-chip[data-quota-state="no_permission"]{background:rgba(168,85,247,0.11);border-color:rgba(168,85,247,0.28);color:#c084fc}
    .ctx-model-quota-chip[data-quota-state="no_permission"] .ctx-quota-ring-fill{stroke:#a855f7}
    .ctx-model-quota-chip[data-quota-state="stale"]{background:rgba(234,179,8,0.10);border-color:rgba(234,179,8,0.28);color:#facc15}
    .ctx-model-quota-chip[data-quota-state="stale"] .ctx-quota-ring-fill{stroke:#eab308;opacity:0.85}
    .ctx-model-quota-chip[data-quota-state="error"]{background:rgba(249,115,22,0.10);border-color:rgba(249,115,22,0.28);color:#fb923c}
    .ctx-model-quota-chip[data-quota-state="error"] .ctx-quota-ring-fill{stroke:#f97316}
    .ctx-model-quota-chip[data-quota-state="unknown"]{background:var(--ag-surface-2);border-color:var(--ag-hairline);color:var(--ag-text-muted)}
    .ctx-model-quota-chip[data-quota-state="unknown"] .ctx-quota-ring-fill{stroke:var(--ag-text-muted);opacity:0.65}
    :host([data-theme="light"]) .ctx-model-quota-chip[data-quota-state="available"]{color:#15803d}
    :host([data-theme="light"]) .ctx-model-quota-chip[data-quota-state="low"]{color:#b45309}
    :host([data-theme="light"]) .ctx-model-quota-chip[data-quota-state="exhausted"]{color:#dc2626}
    :host([data-theme="light"]) .ctx-model-quota-chip[data-quota-state="no_permission"]{color:#7e22ce}
    :host([data-theme="light"]) .ctx-model-quota-chip[data-quota-state="stale"]{color:#a16207}
    :host([data-theme="light"]) .ctx-model-quota-chip[data-quota-state="error"]{color:#ea580c}

    .ctx-detail-card{
      background:var(--ag-surface-1);border:0;
      border-radius:12px;padding:13px 14px;margin-bottom:8px;display:flex;flex-direction:column;gap:10px;
    }
    .ctx-card-top{display:flex;flex-direction:column;gap:3px}
    .ctx-card-vendor-row{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:10px;color:var(--ag-text-muted)}
    .ctx-card-vendor-left{display:inline-flex;align-items:center;gap:6px;min-width:0}
    .ctx-card-vendor-name{font-size:10px;font-weight:600;color:var(--ag-text-secondary)}
    .ctx-card-quota-slot{display:inline-flex;align-items:center;margin-left:auto;flex-shrink:0}
    .ctx-card-quota-slot[hidden]{display:none!important}
    .ctx-card-product-name{font-size:13px;font-weight:600;color:var(--ag-text-primary);line-height:1.3;overflow-wrap:anywhere;word-break:break-word}
    .ctx-card-efforts-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:10px;color:var(--ag-text-secondary)}
    .ctx-card-efforts-list{font-size:10px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums}
    .ctx-card-session-effort{font-size:10px;font-weight:600;color:var(--ag-link,#38bdf8)}
    .ctx-card-session-effort[hidden]{display:none!important}

    .ctx-cap-ref-card{background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);border-radius:9px;padding:10px 11px;display:flex;flex-direction:column;gap:6px}
    .ctx-cap-ref-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px}
    .ctx-cap-item{display:flex;flex-direction:column;gap:2px;min-width:0}
    .ctx-cap-lbl{font-size:10px;color:var(--ag-text-muted);font-weight:500}
    .ctx-cap-val{font-size:12px;font-weight:600;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}

    .ctx-card-metrics,.ctx-card-metrics-spaced{display:flex;flex-direction:column;gap:6px;margin-top:1px}
    .ctx-metric-row{
      display:grid;grid-template-columns:60px minmax(0,1fr) auto;align-items:start;gap:6px 8px;
      padding:6px 9px;background:var(--ag-surface-2);border:0;border-left:2.5px solid var(--ag-text-muted);
      border-radius:6px;font-size:11px;
    }
    .ctx-metric-observed{border-left-color:var(--ag-custom-speed,var(--ag-speed-default,#38bdf8))}
    .ctx-metric-client{border-left-color:var(--ag-text-muted)}
    .ctx-metric-label{font-size:10px;color:var(--ag-text-muted);font-weight:500;padding-top:1px;flex-shrink:0}
    .ctx-metric-value-col{display:flex;flex-direction:column;gap:3px;min-width:0}
    .ctx-metric-value{font-size:11px;font-weight:600;color:var(--ag-text-primary);display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-variant-numeric:tabular-nums;min-width:0;overflow-wrap:anywhere}
    .ctx-metric-side{font-size:10px;color:var(--ag-text-muted);white-space:nowrap;padding-top:2px;min-width:0;overflow-wrap:anywhere}
    .ctx-metric-service-limit{font-size:10px;color:#f59e0b;font-weight:500;font-variant-numeric:tabular-nums}
    .ctx-metric-service-limit[hidden],.ctx-card-hints[hidden]{display:none!important}
    .ctx-speed-effort-lines{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums}
    .ctx-inline-link-btn{background:none;border:0;padding:0;color:var(--ag-link,#38bdf8);font-size:10px;font-weight:500;cursor:pointer;text-align:left;align-self:flex-start}
    .ctx-inline-link-btn:hover{text-decoration:underline}
    .ctx-card-hints{display:flex;flex-direction:column;gap:4px;border-top:1px dashed var(--ag-hairline);padding-top:6px;font-size:10px;color:var(--ag-text-secondary);line-height:1.4}
    .ctx-card-hint-item{padding:5px 8px;background:var(--ag-surface-2);border-radius:5px;border-left:2px solid var(--ag-ring-warn,#f59e0b)}

    /* ========================================================= */
    /* 专属浮层 3: 生成速度与对比 (#pane-ctx-speed)               */
    /* ========================================================= */
    .unified-call-speed-card,.speed-summary-card{
      background:var(--ag-surface-1);border:0;
      border-radius:12px;padding:14px;margin:0 0 12px;
    }
    .speed-kpi-grid{grid-template-columns:1.32fr 0.82fr 0.84fr 1.02fr;gap:7px}
    #speed-summary .key-stat-val{font-size:13px;white-space:nowrap}
    .speed-kpi-accent{color:var(--ag-text-primary)}
    #speed-val.speed-kpi-accent{
      font-size:13.5px;font-weight:700;letter-spacing:-0.015em;white-space:nowrap;
      color:var(--ag-custom-token-accent,var(--ag-token-accent-default));
    }
    .speed-badge-group{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
    .speed-sub-label{
      font-size:10px;color:var(--ag-text-secondary);margin-top:6px;line-height:1.35;
      display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-variant-numeric:tabular-nums;
    }
    .speed-sub-label[hidden]{display:none!important}
    .speed-breakdown-details{
      margin-top:8px;background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);border-radius:8px;
      padding:9px 11px;font-size:11px;line-height:1.4;min-width:0;overflow:hidden;
    }

    .ctx-speed-toolbar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin-bottom:10px}
    .ctx-chart-card{
      background:var(--ag-surface-1);border:0;
      border-radius:12px;padding:12px 14px;margin-bottom:8px;display:flex;flex-direction:column;gap:9px;
    }
    .ctx-chart-header{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}
    .ctx-chart-subheader{padding-top:7px;border-top:1px solid var(--ag-hairline)}
    .ctx-line-header{flex-wrap:nowrap}
    .ctx-chart-title{font-size:12px;font-weight:600;color:var(--ag-text-primary)}
    .ctx-chart-subtitle{font-size:11px;font-weight:600;color:var(--ag-text-secondary);white-space:nowrap}
    .speed-chart-subpane{display:flex;flex-direction:column;gap:8px}
    .speed-chart-subpane[hidden]{display:none!important}
    .ctx-speed-dropdown{min-width:170px;max-width:260px;flex:1}
    .ctx-speed-dropdown .ag-dropdown-menu{min-width:270px;left:auto;right:0}
    .ctx-svg-wrap{position:relative;width:100%;overflow:hidden}
    .ctx-speed-svg{display:block;width:100%;height:auto;font-family:inherit;font-variant-numeric:tabular-nums}
    .ctx-chart-tooltip{
      position:absolute;z-index:30;pointer-events:none;background:var(--ag-pop-bg);
      border:1px solid var(--ag-pop-border);border-radius:7px;padding:6px 9px;
      box-shadow:var(--ag-pop-shadow);font-size:10px;color:var(--ag-pop-text);
      line-height:1.4;max-width:220px;font-variant-numeric:tabular-nums;
    }
    .ctx-chart-tooltip[hidden],.ctx-speed-empty[hidden],.ctx-svg-wrap[hidden]{display:none!important}
    .ctx-chart-note{font-size:10px;color:var(--ag-text-muted);line-height:1.4}
    .ctx-speed-empty{
      font-size:11px;color:var(--ag-text-muted);text-align:center;padding:18px 8px;
      background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);border-radius:8px;
    }

    /* ========================================================= */
    /* 专属浮层 4: 累计 Token 用量 (#panel-tokens)                */
    /* ========================================================= */
    #view-tokens{display:flex;flex-direction:column;gap:11px}
    .tokens-unified-toolbar{
      display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:2px;
    }

    .token-stat-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-bottom:11px}
    .t-card{
      background:var(--ag-surface-1);border:0;border-radius:12px;
      padding:12px 13px;display:flex;flex-direction:column;gap:3px;min-width:0;
      transition:background-color .14s ease;
    }
    .t-card:hover{background:var(--ag-surface-2)}
    .t-card-lbl{
      font-size:11px;font-weight:500;color:var(--ag-text-secondary);
      display:flex;align-items:center;justify-content:space-between;gap:4px;min-width:0;
      white-space:nowrap;line-height:1.35;
    }
    .t-card-tag{
      font-size:10px;font-weight:500;color:var(--ag-text-muted);background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);
      padding:1px 5px;border-radius:4px;white-space:nowrap;flex-shrink:0;
    }
    .t-card-val{
      font-size:20px;font-weight:700;color:var(--ag-text-primary);
      letter-spacing:-0.025em;line-height:1.18;font-variant-numeric:tabular-nums;margin-top:2px;
    }
    #t-total-val{color:var(--ag-custom-token-total,var(--ag-text-primary))}
    #t-today-val{color:var(--ag-custom-token-accent,var(--ag-text-primary))}
    .t-card-sub{font-size:10px;color:var(--ag-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
    .t-card-cost{font-size:10px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}

    .token-cache-breakdown{
      display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;
      background:var(--ag-surface-1);border:0;border-radius:10px;
      padding:9px 13px;margin:0 0 11px;font-size:11px;line-height:1.35;font-variant-numeric:tabular-nums;
    }
    .tcb-item{display:inline-flex;align-items:baseline;gap:5px;min-width:0}
    .tcb-lbl{color:var(--ag-text-muted);font-size:10px;white-space:nowrap}
    .tcb-val{color:var(--ag-text-primary);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
    .tcb-ratio-item{margin-left:auto}
    .tcb-ratio-val{color:var(--ag-custom-token-accent,var(--ag-token-accent-default))}
    .tcb-note{flex:1 1 100%;font-size:10px;color:var(--ag-text-muted);margin-top:1px}
    .tcb-note[hidden]{display:none!important}

    /* 热力图活动面板 */
    .heatmap-section{background:var(--ag-heat-bg);border:0;border-radius:12px;padding:13px 14px}
    .heat-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:nowrap;margin-bottom:10px}
    .heat-header-left{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;min-width:0}
    .heat-title{font-size:12px;font-weight:600;color:var(--ag-text-primary);white-space:nowrap}
    .first-use-badge{
      font-size:10px;font-weight:500;color:var(--ag-text-muted);
      background:transparent;border-radius:0;padding:0;font-variant-numeric:tabular-nums;
    }
    .heat-win-nav{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums}
    .heat-nav-btn{
      border:1px solid var(--ag-btn-border);background:var(--ag-btn-bg);color:var(--ag-text-secondary);
      border-radius:5px;padding:1px 6px;font-size:11px;line-height:1.25;cursor:pointer;
    }
    .heat-nav-btn:hover:not(:disabled){background:var(--ag-btn-hover);color:var(--ag-text-primary)}
    .heat-nav-btn:disabled{opacity:0.35;cursor:default}
    .heat-tabs{
      position:relative;display:inline-flex;align-items:center;
      background:var(--ag-surface-2);border:1px solid var(--ag-hairline);
      border-radius:9999px;padding:2px;gap:2px;user-select:none;
    }
    .heat-tab-thumb{
      position:absolute;top:2px;bottom:2px;left:0;width:0;border-radius:9999px;
      background:var(--ag-tab-thumb-bg,var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa)));
      opacity:0.25;pointer-events:none;
      transition:transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),width 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
      will-change:transform,width;
    }
    @media (prefers-reduced-motion: reduce){.heat-tab-thumb{transition:none!important}}
    .heat-tab-btn{
      position:relative;z-index:1;border:0;background:transparent;
      color:var(--ag-text-muted);font-size:11px;font-weight:500;
      padding:3px 10px;border-radius:9999px;cursor:pointer;transition:color .14s ease;outline:none;white-space:nowrap;
    }
    .heat-tab-btn:hover{color:var(--ag-text-primary)}
    .heat-tab-btn.active{color:var(--ag-text-primary);font-weight:600}
    .heat-tab-btn:focus-visible{box-shadow:0 0 0 1.5px var(--ag-token-accent-default,#a78bfa)}

    .heat-scroll-box{overflow-x:auto;overflow-y:hidden;padding:6px 6px 4px 6px}
    .heat-grid-cols{display:flex;gap:2.5px}
    .heat-week-col{display:flex;flex-direction:column;gap:2.5px}
    .heat-cell{width:9px;height:9px;border-radius:2px;background:var(--ag-heat-lvl-0);cursor:pointer;transition:transform .12s ease}
    .heat-cell:hover{transform:scale(1.3);z-index:5;outline:1.5px solid var(--ag-heat-outline)}
    .heat-cell.is-future{opacity:0.36}
    .heat-cell.is-today{outline:1.5px solid var(--ag-custom-token-accent,var(--ag-token-accent-default));outline-offset:0.5px}
    .lvl-0{background:var(--ag-heat-lvl-0)}
    .lvl-1{background:var(--ag-heat-lvl-1)}
    .lvl-2{background:var(--ag-heat-lvl-2)}
    .lvl-3{background:var(--ag-heat-lvl-3)}
    .lvl-4{background:var(--ag-heat-lvl-4)}

    .heat-months{position:relative;height:18px;margin-top:4px;font-size:10px;color:var(--ag-text-muted);overflow:hidden}
    .heat-month-item{position:absolute;white-space:nowrap}

    #h-weekly-box{display:none;height:105px;align-items:flex-end;gap:3px;border-bottom:1px solid var(--ag-hairline);padding-bottom:3px}
    .w-bar-col{flex:1;height:100%;display:flex;align-items:flex-end;cursor:pointer}
    .w-bar-fill{width:100%;border-radius:2px 2px 0 0;background:var(--ag-heat-lvl-0);min-height:3px;transition:height .22s ease,background-color .14s ease}
    .w-bar-col:hover .w-bar-fill{background:var(--ag-custom-token-accent,var(--ag-heat-lvl-4))!important}

    #h-monthly-box{display:none;height:105px;width:100%;box-sizing:border-box;align-items:center;justify-content:center}
    .heat-month-grid{display:grid;width:100%;height:100%;align-content:center;justify-content:center}
    .heat-month-cell{display:flex;align-items:center;justify-content:center;border-radius:3px;cursor:pointer;transition:transform .12s ease}
    .heat-month-cell:hover{transform:scale(1.18);z-index:5;outline:1.5px solid var(--ag-heat-outline,#fff)}
    .heat-month-cell-num{font-size:10px;font-weight:600;color:rgba(255,255,255,0.9);text-shadow:0 1px 2px rgba(0,0,0,0.65);pointer-events:none;font-variant-numeric:tabular-nums}
    :host([data-theme="light"]) .heat-month-cell-num{color:#18181b;text-shadow:none}

    #h-yearly-box{display:none;height:105px;width:100%;box-sizing:border-box;align-items:center;justify-content:center}
    .heat-yearly-svg{width:100%;height:105px;display:block;overflow:visible}
    @keyframes bubblePopIn{0%{transform:scale(0.6);opacity:0}100%{transform:scale(1);opacity:1}}
    .heat-yearly-bubble-group{transform-origin:center center;animation:bubblePopIn 0.22s cubic-bezier(0.16,1,0.3,1) both;cursor:pointer}
    @media (prefers-reduced-motion: reduce){.heat-yearly-bubble-group{animation:none!important}}
    .heat-yearly-bubble-group:hover circle.bubble-main{filter:brightness(1.22);stroke:var(--ag-text-primary);stroke-width:1.5px}

    #h-cum-box{display:none;height:105px;position:relative}
    canvas#h-cum-canvas{width:100%;height:105px;display:block}

    .heat-summary-bar{
      display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;
      margin-top:9px;padding:8px 12px;background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);border-radius:9px;
      font-size:11px;font-variant-numeric:tabular-nums;
    }
    .heat-sum-item{display:inline-flex;align-items:center;gap:4px}
    .heat-sum-label{color:var(--ag-text-muted);font-size:10px}
    .heat-sum-val{color:var(--ag-text-primary);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
    .heat-sum-accent{color:var(--ag-custom-token-accent,var(--ag-token-accent-default))}
    .heat-sum-clickable{cursor:pointer;border-radius:4px;padding:1px 4px;transition:background-color .12s ease}
    .heat-sum-clickable:hover{background:var(--ag-toolbar-bg-hover)}

    .heat-footer-row{
      display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;
      margin-top:8px;font-size:11px;color:var(--ag-text-muted);
    }
    .heat-footer-note{font-size:10px;color:var(--ag-text-muted)}
    .heat-legend-scale{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:var(--ag-text-muted)}
    .heat-leg-swatch{
      width:10px;height:10px;padding:0;border-radius:2px;
      border:1px solid var(--ag-hairline);background:var(--swatch-color,var(--ag-heat-lvl-0));
      cursor:default;flex-shrink:0;
    }

    .heat-popover{
      position:fixed;pointer-events:none;background:var(--ag-pop-bg);border:1px solid var(--ag-pop-border);
      border-radius:9px;padding:8px 11px;box-shadow:var(--ag-pop-shadow);z-index:2147483600;
      opacity:0;transform:translate(-50%,-100%) translateY(-6px);transition:opacity .12s ease;
      font-variant-numeric:tabular-nums;
    }
    .pop-date{font-size:11px;color:var(--ag-pop-muted)}
    .pop-val{font-size:13px;font-weight:600;color:var(--ag-pop-text);margin:2px 0 4px;font-variant-numeric:tabular-nums}
    .pop-det{font-size:10px;color:var(--ag-pop-sub);margin-top:2px;display:flex;gap:12px;align-items:flex-start}
    .pop-det-col{display:inline-flex;flex-direction:column;align-items:flex-start;gap:2px}
    .pop-det-val{font-size:11px;font-weight:500;color:var(--ag-pop-sub);font-variant-numeric:tabular-nums;white-space:nowrap}
    .pop-det-trans{font-size:10px;color:var(--ag-pop-muted);opacity:0.88;white-space:nowrap;line-height:1.2}

    /* 按模型 Token 用量视图 (#model-usage-view) */
    .model-usage-card{
      background:var(--ag-surface-1);border:0;
      border-radius:12px;padding:14px 15px;margin-bottom:6px;
    }
    .model-usage-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
    .model-usage-title{font-size:13px;font-weight:600;color:var(--ag-text-primary);margin-bottom:2px}
    .model-usage-subtitle{font-size:11px;color:var(--ag-text-muted);line-height:1.4}
    .model-usage-controls{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:12px}
    .model-usage-right-ctrls{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
    .model-unattr-btn{border:1px solid var(--ag-hairline);padding:3px 8px;background:var(--ag-surface-2)}
    .model-usage-nav-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
    .model-usage-range-wrap{display:flex;align-items:center;gap:8px}
    .model-usage-range-lbl{font-size:12px;font-weight:500;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums}
    .model-win-pill{font-variant-numeric:tabular-nums}
    .model-usage-nav-btns{display:flex;align-items:center;gap:4px}
    .model-usage-chart-wrap{position:relative;padding-top:10px;margin-bottom:14px}
    .model-usage-gridlines{
      position:absolute;left:0;right:0;top:10px;height:148px;
      display:flex;flex-direction:column;justify-content:space-between;pointer-events:none;
    }
    .model-usage-gridline{position:relative;border-top:1px solid rgba(148,163,184,0.14);width:100%}
    .model-chart-max-lbl{position:absolute;right:0;top:-14px;font-size:10px;color:var(--ag-text-muted);opacity:0.85;font-variant-numeric:tabular-nums}
    .model-usage-bars{position:relative;z-index:1;height:148px;display:flex;align-items:flex-end;gap:8px;padding:0 6px}
    .model-usage-bars.compact-30{gap:3px;padding:0 2px}
    .model-usage-col{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;cursor:pointer}
    .model-usage-stack{
      width:100%;max-width:44px;display:flex;flex-direction:column;overflow:hidden;
      border-radius:3px 3px 0 0;transition:filter .14s,transform .14s;
    }
    .model-usage-bars.compact-30 .model-usage-stack{max-width:18px}
    .model-usage-col:hover .model-usage-stack{filter:brightness(1.1)}
    .model-usage-seg{width:100%;min-height:2px;opacity:0.9;transition:height .2s cubic-bezier(0.16,1,0.3,1),opacity .14s}
    .model-usage-col:hover .model-usage-seg{opacity:1}
    .model-usage-empty-bar{width:100%;max-width:44px;height:2px;border-radius:2px 2px 0 0;background:rgba(148,163,184,0.16)}
    .model-usage-bars.compact-30 .model-usage-empty-bar{max-width:18px}
    .model-usage-xaxis{display:flex;align-items:center;gap:8px;padding:6px 6px 0;border-top:1px solid rgba(148,163,184,0.18)}
    .model-usage-xaxis.compact-30{gap:3px;padding:6px 2px 0}
    .model-usage-xlabel{flex:1;min-width:0;text-align:center;font-size:10px;color:var(--ag-text-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
    .model-usage-empty{text-align:center;padding:24px 0;font-size:11px;color:var(--ag-text-muted)}
    .model-usage-legend{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 14px;padding-top:4px;max-height:220px;overflow-y:auto}
    .model-legend-item{display:flex;align-items:stretch;gap:9px;min-width:0}
    .model-legend-bar{width:3px;border-radius:999px;flex-shrink:0;min-height:30px}
    .model-legend-text{display:flex;flex-direction:column;justify-content:center;min-width:0}
    .model-legend-name{font-size:11px;color:var(--ag-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
    .model-legend-val-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
    .model-legend-pct{font-size:15px;font-weight:700;color:var(--ag-text-primary);line-height:1.15;letter-spacing:-0.01em;font-variant-numeric:tabular-nums}
    .model-legend-meta{font-size:10px;color:var(--ag-text-muted);white-space:nowrap;font-variant-numeric:tabular-nums}

    /* API 参考金额与订阅性价比卡片 (#cost-estimate-card) */
    .cost-full-card{
      background:var(--ag-surface-1);border:0;
      border-radius:12px;padding:14px 15px;margin-bottom:4px;font-variant-numeric:tabular-nums;
    }
    .cost-full-top-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px}
    .cost-top-title-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
    .cost-card-title,.cost-card-heading{font-size:12px;font-weight:600;color:var(--ag-text-primary)}
    .cost-meta-pill{font-size:10px;padding:1px 7px;font-variant-numeric:tabular-nums}
    .cost-scope-actions{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}
    .cost-compact-pill{padding:2px 8px;font-size:11px;border-radius:6px;background:var(--ag-surface-2)}
    .cost-compact-pill.active{background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow)}

    .cost-hero-grid{
      display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;
      padding-bottom:12px;margin-bottom:11px;border-bottom:1px solid var(--ag-hairline);
    }
    .cost-grand-val{
      font-size:24px;font-weight:700;letter-spacing:-0.03em;line-height:1.12;
      color:var(--ag-text-primary);font-variant-numeric:tabular-nums;
    }
    .cost-scope-desc{font-size:11px;color:var(--ag-text-muted);margin-top:3px;font-variant-numeric:tabular-nums}
    .cost-grand-sub{font-size:11px;color:var(--ag-text-secondary);text-align:right;line-height:1.45;font-variant-numeric:tabular-nums}

    .cost-mode-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:9px}
    .cost-mode-lbl{font-size:11px;font-weight:500;color:var(--ag-text-secondary)}
    .cost-summary-strip{
      display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;
      padding:7px 11px;border-radius:8px;background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);margin-bottom:10px;
      font-size:11px;font-variant-numeric:tabular-nums;
    }
    .cost-usage-summary,.cost-usage-summary-txt{font-size:11px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums}
    .cost-diff-summary,.cost-diff-summary-txt{font-size:10px;color:var(--ag-text-muted);font-variant-numeric:tabular-nums}
    .cost-diff-summary[hidden]{display:none!important}

    .ref-cost-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:11px}
    .ref-cost-card,.ref-cost-subcard{background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);border:0;border-radius:9px;padding:10px 11px}
    .ref-cost-lbl{font-size:10px;color:var(--ag-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ref-cost-val{font-size:15px;font-weight:700;color:var(--ag-text-primary);font-variant-numeric:tabular-nums;margin-top:2px;line-height:1.2}
    .ref-cost-tok{font-size:10px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums}

    .cost-roi-card{background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);border-radius:10px;padding:11px 12px}
    .cost-roi-header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .cost-roi-title-group,.cost-roi-title-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .cost-roi-title{font-size:12px;font-weight:600;color:var(--ag-text-primary)}
    .cost-roi-price-pill{font-size:11px;font-weight:600;color:var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa));font-variant-numeric:tabular-nums}
    .plan-save-feedback{font-size:10px;font-weight:500;color:#4ade80}
    :host([data-theme="light"]) .plan-save-feedback{color:#15803d}
    .cost-sub-line-wrap{font-size:11px;color:var(--ag-text-secondary);font-variant-numeric:tabular-nums}

    .minimal-spend-controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .cost-spend-controls{margin-top:8px}
    .minimal-spend-input-wrap{
      display:inline-flex;align-items:center;flex:1;min-width:130px;max-width:190px;
      padding:0 8px;border-radius:6px;background:var(--ag-bg-input);border:1px solid var(--ag-hairline);
    }
    .minimal-spend-input-wrap:focus-within{border-color:var(--ag-token-accent-default,#a78bfa)}
    .minimal-spend-prefix{font-size:11px;color:var(--ag-text-muted);margin-right:3px;font-weight:600}
    .minimal-spend-input-wrap input{
      width:100%;border:0;outline:none;background:transparent;color:var(--ag-text-primary);
      font-size:11px;padding:5px 0;font-variant-numeric:tabular-nums;
    }
    .btn-spend-clear,.cost-clear-btn{border:1px solid var(--ag-hairline);color:var(--ag-text-muted)}
    .cost-breakdown-info{margin-top:9px;font-size:11px;color:var(--ag-text-secondary);line-height:1.45;font-variant-numeric:tabular-nums}
    .cost-disclaimer-note{
      margin-top:7px;padding-top:7px;border-top:1px solid var(--ag-hairline);
      font-size:10px;color:var(--ag-text-muted);line-height:1.4;
    }

    /* ========================================================= */
    /* 共享设置视图 (#pane-ctx-settings: macOS 分组偏好行风格)     */
    /* ========================================================= */
    .ctx-settings-card{
      background:var(--ag-surface-1);border:0;
      border-radius:12px;padding:13px 14px;margin-bottom:12px;display:flex;flex-direction:column;gap:9px;
    }
    .ctx-settings-card-hdr{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .ctx-settings-card-title{font-size:12px;font-weight:600;color:var(--ag-text-primary)}

    .color-reset-btn{
      font-size:10px;padding:3px 8px;border-radius:6px;
      border:0;background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);color:var(--ag-text-secondary);
      transition:background-color .12s ease,color .12s ease;
    }
    .color-reset-btn:hover{color:var(--ag-text-primary);background:var(--ag-surface-hover)}
    .color-reset-btn[data-mode="auto"]{opacity:0.55}

    .appearance-row{
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      padding:6px 0 9px;border-bottom:1px solid var(--ag-hairline);
    }
    .appearance-row-lbl{font-size:11px;font-weight:500;color:var(--ag-text-secondary)}
    .appearance-palette-block{padding-top:2px}
    .appearance-palette-lbl{display:block;margin-bottom:7px}

    .heat-preset-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .palette-grid-5{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:7px}
    .heat-preset-btn{
      display:inline-flex;align-items:center;justify-content:space-between;gap:5px;padding:7px 9px;border-radius:8px;
      border:1px solid transparent;background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);color:var(--ag-text-secondary);
      font-size:11px;cursor:pointer;transition:border-color .12s ease,background-color .12s ease,color .12s ease;
    }
    .heat-preset-btn:hover{color:var(--ag-text-primary);background:var(--ag-surface-hover)}
    .heat-preset-btn[data-active="true"]{
      color:var(--ag-text-primary);border-color:var(--ag-custom-token-accent,var(--ag-token-accent-default));
      font-weight:600;
    }
    .heat-preset-dots{display:inline-flex;gap:2px}
    .heat-preset-dots i{width:7px;height:7px;border-radius:1.5px;display:inline-block}

    .pill-toggles-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:2px}
    .pill-toggle-item{
      display:flex;align-items:center;gap:7px;padding:8px 10px;border-radius:8px;
      background:var(--ag-surface-tile);box-shadow:var(--ag-tile-shadow);border:1px solid transparent;
      font-size:11px;color:var(--ag-text-primary);cursor:pointer;user-select:none;
      transition:border-color .12s ease,background-color .12s ease;
    }
    .pill-toggle-item:hover{background:var(--ag-surface-hover);border-color:var(--ag-btn-border-hover)}
    .pill-toggle-item svg{flex-shrink:0;opacity:0.9}
    .pill-toggle-name{font-size:11px;font-weight:500}
    .pill-toggle-item input[type="checkbox"]{margin:0;accent-color:var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))}
    .pill-toggle-item input[type="checkbox"]:disabled{opacity:0.45;cursor:not-allowed}

    /* 重启确认模态弹窗 */
    .ag-modal-overlay{
      position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(3px);
      z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;
      animation:agFadeIn .15s ease-out;
    }
    .ag-modal-overlay[hidden]{display:none !important}
    .ag-modal-card{
      background:var(--ag-bg-panel);border:1px solid var(--ag-border-panel);border-radius:12px;
      padding:16px 18px;max-width:340px;width:100%;
      box-shadow:0 16px 40px rgba(0,0,0,0.6),0 2px 10px rgba(0,0,0,0.3);
      display:flex;flex-direction:column;gap:12px;
    }
    .ag-modal-title{font-size:13px;font-weight:600;color:var(--ag-text-primary)}
    .ag-modal-body{font-size:11px;line-height:1.5;color:var(--ag-text-secondary)}
    .ag-modal-feedback{font-size:11px;line-height:1.4;padding:6px 8px;border-radius:6px;background:var(--ag-surface-2);color:var(--ag-text-primary)}
    .ag-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
    .unlock-btn{display:inline-flex;align-items:center;justify-content:center;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s ease;white-space:nowrap}
    .unlock-btn:disabled{opacity:0.5;cursor:not-allowed}
    .unlock-btn-primary{background:#2563eb;color:#fff;border:1px solid #1d4ed8}
    .unlock-btn-primary:hover:not(:disabled){background:#1d4ed8}
    .unlock-btn-secondary{background:var(--ag-surface-2);color:var(--ag-text-primary);border:1px solid var(--ag-hairline)}
    .unlock-btn-secondary:hover:not(:disabled){background:var(--ag-surface-hover)}

    /* 响应式断点与无障碍减弱动态偏好 */
    @media (max-width:500px){
      #panel{width:calc(100vw - 24px)}
      .ref-cost-grid{grid-template-columns:1fr}
      .token-stat-cards{grid-template-columns:repeat(2,minmax(0,1fr))}
    }
    @media (max-width:480px){
      .tcb-ratio-item{margin-left:0}
      .latest-call-metrics{gap:6px}
      .timeline-call-row.is-subagent{margin-left:8px}
      #speed-summary .key-stats{grid-template-columns:repeat(2,minmax(0,1fr))!important}
      .panel-header-bar{gap:5px}
      .panel-icon-btn{width:24px;height:24px}
    }
    @media (max-width:440px){
      .model-usage-legend{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .call-detail-grid{grid-template-columns:1fr}
      .pill-toggles-grid{grid-template-columns:1fr}
    }
    @media (max-width:740px){
      #panel[data-wb-wide="true"]{width:calc(100vw - 24px)}
    }
    @media (prefers-reduced-motion: reduce){
      *,.ag-unit,.ring-fill,.quota-ring-fill,.ctx-quota-ring-fill,.ctx-model-quota-chip,.quota-bar-fill,.quota-bar-charge-stage,.quota-bar-charge-fill,.quota-bar-charge-sheen,.quota-refresh-icon,.key-bar-fill,.ag-panel,#context-tooltip,.heat-cell,.w-bar-fill,.latest-call-body,.latest-call-body.is-entering{
        transition:none!important;animation:none!important;
      }
      .quota-bar-charge-stage{display:none!important}
    }
  </style>

  <!-- 顶部基本单元 0: 模型额度动态圆环入口（工具组最左侧） -->
<button id="badge-quota" class="ag-unit ag-unit-quota" type="button" aria-label="模型剩余额度与重置状态"
  data-i18n-aria="badge.quota.aria" aria-expanded="false" data-quota-state="unknown" title="模型额度看板">
  <svg id="quota-ring-svg" class="quota-ring-svg" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle id="quota-ring-track" class="quota-ring-track" cx="9" cy="9" r="6.5" fill="none" stroke-width="2.1">
    </circle>
    <circle id="quota-ring-fill" class="quota-ring-fill" cx="9" cy="9" r="6.5" fill="none" stroke-width="2.1"
      stroke-linecap="round" transform="rotate(-90 9 9)" stroke-dasharray="10 30.84" stroke-dashoffset="0"></circle>
  </svg>
  <span class="quota-badge-metric">
    <span id="quota-badge-val" class="quota-badge-val" data-i18n="quota.state.unknown">未知</span>
    <span id="quota-badge-tag" class="quota-badge-tag" hidden></span>
  </span>
</button>

<!-- 顶部基本单元 1: 上下文动态小圆环（与速度入口紧邻） -->
<button id="badge" class="ag-unit ag-unit-ring" type="button" aria-label="会话与上下文统计" data-i18n-aria="badge.aria"
  aria-describedby="context-tooltip" aria-expanded="false">
  <svg id="ring-svg" class="ring-svg" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle id="ring-track" class="ring-track" cx="9" cy="9" r="6.5" fill="none" stroke-width="2.1"></circle>
    <circle id="ring-fill" class="ring-fill" cx="9" cy="9" r="6.5" fill="none" stroke-width="2.1" stroke-linecap="round"
      transform="rotate(-90 9 9)" stroke-dasharray="3.2 4.97"></circle>
  </svg>
  <span id="badge-pct-val" class="badge-pct-val">--%</span>
  <div id="bar-wrap" class="sr-only" aria-hidden="true">
    <div id="bar-fill" class="meter-bar-fill"></div>
  </div>
  <span id="amount" class="sr-only" data-i18n="badge.reading">读取中…</span>
  <span id="hover-wrap" class="sr-only"><span id="hover-extra"></span></span>
</button>

<!-- 顶部基本单元 2: 输出速度 (tok/s) -->
<button id="badge-speed" class="ag-unit" type="button" aria-label="模型输出速度与耗时统计" data-i18n-aria="badge.speed.aria"
  aria-expanded="false">
  <span id="badge-speed-icon" class="speed-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="13" height="13"
      fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
      <path d="M9.2 1.8L3.6 9h4.1l-.9 5.2L12.4 7H8.3l.9-5.2z"></path>
    </svg></span>
  <span id="speed-amount">-- tok/s</span>
  <span id="speed-hover-extra" class="sr-only"></span>
</button>

<!-- 顶部基本单元 3: 累计 Token 用量（细线统计图标） -->
<button id="badge-tokens" class="ag-unit" type="button" aria-label="Token 用量一览" data-i18n-aria="badge.tokens.aria"
  aria-expanded="false">
  <span class="token-fire-dot" aria-hidden="true"><svg viewBox="0 0 16 16" width="13" height="13" fill="none"
      stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 13V9M8 13V4M13 13V7"></path>
    </svg></span>
  <span id="token-amount">--</span>
  <span id="token-hover-extra" class="sr-only"></span>
</button>

<!-- 顶部基本单元 4: 一键启动 CLI 模式 -->
<button id="badge-cli" class="ag-unit" type="button" aria-label="启动 CLI" data-i18n-aria="badge.cli.aria"
  title="一键启动 Antigravity CLI 终端（自动进入当前项目目录）" data-i18n-title="badge.cli.title">
  <span class="cli-icon" aria-hidden="true">&gt;_</span>
  <span id="cli-label">CLI</span>
</button>

<!-- 顶部基本单元 5: 窄屏或隐藏项兜底溢出菜单按钮 -->
<button id="badge-overflow" class="ag-unit" type="button" aria-label="更多统计指标" data-i18n-aria="badge.overflow.aria"
  aria-expanded="false">
  <svg class="overflow-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.25"></circle>
    <circle cx="8" cy="8" r="1.25"></circle>
    <circle cx="12.5" cy="8" r="1.25"></circle>
  </svg>
</button>

<!-- CLI 启动反馈提示气泡 -->
<div id="cli-launch-toast" hidden role="status" aria-live="polite"></div>

<!-- 上下文圆环悬停/聚焦信息气泡 -->
<div id="context-tooltip" role="tooltip" data-visible="false" data-placement="bottom">
  <div id="ctx-tip-title" class="ctx-tip-title" data-i18n="tip.title.default">上下文窗口：</div>
  <div id="ctx-tip-pct" class="ctx-tip-pct" data-i18n="tip.pct.notReady">数据尚未就绪</div>
  <div id="ctx-tip-detail" class="ctx-tip-detail" data-i18n="tip.detail.loading">正在读取当前会话上下文用量…</div>
</div>

<!-- 窄屏与已隐藏顶栏项兜底菜单 -->
<div id="overflow-menu" hidden aria-label="更多统计快捷菜单" data-i18n-aria="overflow.aria">
  <button id="overflow-quota-btn" class="overflow-item" type="button">
    <span class="overflow-item-label">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" stroke-opacity="0.28"></circle>
        <path d="M8 2.5A5.5 5.5 0 1 1 2.8 9.8" stroke-linecap="round"></path>
      </svg>
      <span data-i18n="overflow.quota">模型额度</span>
    </span>
    <span id="overflow-quota-val" class="overflow-item-val">--</span>
  </button>
  <button id="overflow-context-btn" class="overflow-item" type="button">
    <span class="overflow-item-label">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" stroke-opacity="0.28"></circle>
        <path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke-linecap="round"></path>
      </svg>
      <span data-i18n="overflow.context">上下文窗口</span>
    </span>
    <span id="overflow-context-val" class="overflow-item-val">--%</span>
  </button>
  <button id="overflow-speed-btn" class="overflow-item" type="button">
    <span class="overflow-item-label">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9.2 1.8L3.6 9h4.1l-.9 5.2L12.4 7H8.3l.9-5.2z"></path>
      </svg>
      <span data-i18n="overflow.speed">输出速度</span>
    </span>
    <span id="overflow-speed-val" class="overflow-item-val">-- tok/s</span>
  </button>
  <button id="overflow-tokens-btn" class="overflow-item" type="button">
    <span class="overflow-item-label">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <path d="M3 13V9M8 13V4M13 13V7"></path>
      </svg>
      <span data-i18n="overflow.tokens">累计用量</span>
    </span>
    <span id="overflow-tokens-val" class="overflow-item-val">--</span>
  </button>
  <button id="overflow-cli-btn" class="overflow-item" type="button">
    <span class="overflow-item-label"><span class="cli-icon">&gt;_</span><span data-i18n="overflow.cli">启动 CLI 终端</span></span>
    <span id="overflow-cli-val" class="overflow-item-val">agy</span>
  </button>
</div>

<!-- 热力图浮动 Tooltip -->
<div class="heat-popover" id="heat-pop">
  <div class="pop-date" id="heat-pop-date">10月24日</div>
  <div class="pop-val" id="heat-pop-val">2.47亿 个 Token</div>
  <div class="pop-det" id="heat-pop-det"></div>
</div>

<!-- 一对一专属浮层外壳 (#panel: 按所点顶栏胶囊精准锚定并切换为对应单一领域专属视图，无跨界总 Tab 栏) -->
<section id="panel" class="ag-panel ag-panel-flex" hidden aria-label="指标详情浮层" data-i18n-aria="panel.wb.aria">
  <!-- 极简统一标题栏：专属标题 | 场景辅助操作 + 设置 + 关闭 -->
  <div class="panel-header-bar">
    <div class="panel-title">
      <button id="btn-ctx-settings-back" class="switch-pill-btn settings-header-back-btn" type="button" hidden
        data-i18n="settings.backBtn">← 返回</button>
      <span id="panel-main-title" class="panel-title-text"
        data-i18n="context.popover.title">上下文窗口</span>
      <span id="v">v0.0.1</span>
      <span id="quota-plan-tier-pill" class="sr-only" hidden></span>
    </div>
    <div class="panel-header-actions">
      <!-- 仅在「上下文窗口」专属浮层显示的轻量双切换：[当前会话 | 窗口规格] -->
      <div id="ctx-tabs-bar" class="ctx-segmented ctx-header-subswitch" role="tablist" aria-label="上下文视图切换"
        data-i18n-aria="tabs.aria">
        <button id="tab-ctx-session" class="ctx-seg-btn active" type="button" role="tab" aria-selected="true"
          data-ctx-submode="session" data-i18n="ctx.sub.session">当前会话</button>
        <button id="tab-ctx-models" class="ctx-seg-btn" type="button" role="tab" aria-selected="false"
          data-ctx-submode="models" data-i18n="ctx.sub.specs">窗口规格</button>
      </div>

      <!-- 仅在「模型额度」专属浮层显示的精简更新时间与手动刷新操作 -->
      <span id="quota-refresh-feedback" class="quota-refresh-feedback" hidden
        data-i18n="quota.refresh.upToDate">已更新</span>
      <span id="quota-time-updated" class="quota-header-updated" hidden>—</span>
      <button id="btn-quota-refresh" class="panel-icon-btn quota-refresh-btn" type="button" hidden aria-label="手动刷新模型额度"
        data-i18n-aria="quota.refresh.aria" title="手动刷新模型额度" data-i18n-title="quota.refresh.aria">
        <span class="quota-refresh-icon" aria-hidden="true">↻</span>
        <span id="quota-refresh-text" data-i18n="quota.refresh.btn">刷新</span>
      </button>

      <!-- 全局统一设置与关闭入口 -->
      <button id="btn-ctx-settings" class="panel-icon-btn wb-settings-btn" type="button" aria-pressed="false"
        aria-label="面板与顶栏设置" data-i18n-aria="settings.paneTitle" title="面板与顶栏设置"
        data-i18n-title="settings.paneTitle"><svg viewBox="0 0 16 16" width="14" height="14" fill="none"
          stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="2.2"></circle>
          <path
            d="M7.01 3.25L7.21 1.75H8.79L8.99 3.25L10.66 3.94L11.86 3.02L12.98 4.14L12.06 5.34L12.75 7.01L14.25 7.21V8.79L12.75 8.99L12.06 10.66L12.98 11.86L11.86 12.98L10.66 12.06L8.99 12.75L8.79 14.25H7.21L7.01 12.75L5.34 12.06L4.14 12.98L3.02 11.86L3.94 10.66L3.25 8.99L1.75 8.79V7.21L3.25 7.01L3.94 5.34L3.02 4.14L4.14 3.02L5.34 3.94Z">
          </path>
        </svg></button>
      <button id="close" class="panel-icon-btn" type="button" aria-label="收起详情"
        data-i18n-aria="header.close.aria">×</button>
    </div>
  </div>

  <!-- ========================================================= -->
  <!-- 专属浮层 1 (对应 #badge-quota): 模型额度 (460px)            -->
  <!-- ========================================================= -->
  <div id="panel-quota" class="wb-tab-pane" role="region" aria-label="模型额度" hidden>
    <div id="view-quota" class="quota-panel-body">
      <div id="quota-banner" class="quota-banner" hidden>
        <span id="quota-banner-text"></span>
        <button id="btn-quota-banner-retry" class="switch-pill-btn" type="button" data-i18n="quota.retry">重试</button>
        <button id="btn-quota-banner-restart" class="switch-pill-btn active" type="button" hidden
          data-i18n="quota.restartBtn">重启客户端</button>
      </div>

      <!-- 套餐等级与 Prompt / Flow Credits 概览 -->
      <div id="quota-plan-credits-card" class="quota-plan-credits-card">
        <div class="quota-plan-top-row">
          <div class="quota-plan-identity">
            <span class="quota-plan-name" id="p-det-name">Google AI Pro</span>
            <span class="quota-plan-email" id="p-det-account">—</span>
            <span id="plan-summary-text" class="sr-only"></span>
            <span id="p-det-credits" class="sr-only" hidden>—</span>
          </div>
        </div>
        <div class="quota-credits-grid">
          <div class="quota-credit-item">
            <span class="quota-credit-lbl" data-i18n="plan.dt.promptCredits">Prompt 池</span>
            <span class="quota-credit-val" id="p-det-prompt-credits">—</span>
          </div>
          <div class="quota-credit-item">
            <span class="quota-credit-lbl" data-i18n="plan.dt.flowCredits">Flow 池</span>
            <span class="quota-credit-val" id="p-det-flow-credits">—</span>
          </div>
        </div>
      </div>

      <div id="quota-current-card" class="quota-current-card">
        <div class="key-header quota-cur-header">
          <div class="quota-cur-main quota-cur-header-main">
            <div class="ctx-small-label quota-cur-label quota-cur-eyebrow" data-i18n="quota.current.label">当前会话模型</div>
            <div id="quota-cur-model" class="quota-cur-model-name">—</div>
            <div id="quota-cur-pool" class="quota-cur-pool-sub"></div>
            <div id="quota-cur-est" class="quota-cur-est" hidden></div>
          </div>
          <div class="quota-cur-hero-right">
            <span id="quota-cur-hero-pct" class="quota-hero-pct" hidden>—</span>
            <span id="quota-cur-status" class="key-pill pill-muted">未知</span>
          </div>
        </div>
        <div id="quota-cur-alert" class="quota-cur-alert" hidden></div>
        <div id="quota-cur-buckets" class="quota-buckets-list"></div>
      </div>

      <div class="quota-pools-header">
        <span class="quota-subsec-title quota-pools-title"
          data-i18n="quota.pools.heading">额度池</span>
      </div>
      <div id="quota-pools-list" class="quota-pools-list"></div>
    </div>
  </div>

  <!-- ========================================================= -->
  <!-- 专属浮层 2A (对应 #badge -> 当前会话): 上下文窗口 (460px)     -->
  <!-- ========================================================= -->
  <div id="pane-ctx-session" class="wb-tab-pane ctx-tab-pane" role="region" aria-labelledby="tab-ctx-session">
    <!-- 卡片 1: 上下文窗口容量与会话估值 -->
    <div id="key-summary">
      <div class="key-header key-summary-hero-header">
        <div class="key-title-stack">
          <span class="key-title" data-i18n="session.keySummary.title">当前窗口占用</span>
          <span id="key-hero-pct" class="ctx-hero-pct" hidden>—</span>
        </div>
        <span id="key-badge" class="key-pill pill-muted" data-i18n="session.badge.reading">读取中</span>
      </div>
      <div class="key-bar-track">
        <div id="key-bar-fill" class="key-bar-fill"></div>
      </div>
      <div class="key-stats">
        <div class="key-stat">
          <div class="key-stat-label" data-i18n="session.stat.used">当前已用</div>
          <div id="key-used" class="key-stat-val">—</div>
        </div>
        <div class="key-stat">
          <div class="key-stat-label" data-i18n="session.stat.limit">预算上限</div>
          <div id="key-limit" class="key-stat-val">—</div>
        </div>
        <div class="key-stat">
          <div class="key-stat-label" data-i18n="session.stat.remaining">剩余可用</div>
          <div id="key-remaining" class="key-stat-val">—</div>
        </div>
      </div>
      <div id="key-takeaway" class="key-takeaway" hidden data-i18n="session.keyTakeaway.loading">正在计算核心指标…</div>
      <div id="round-cost-bar" class="round-cost-bar round-cost-footer" title="当前模型调用的 API 等值参考金额"
        data-i18n-title="session.costBar.title">
        <span id="round-cost-text" class="round-cost-primary" data-i18n="session.roundCost.dash">本轮估值：—</span>
        <span id="session-cost-text" class="round-cost-secondary" data-i18n="session.sessionCost.dash">当前会话合计：—</span>
      </div>
    </div>

    <!-- 卡片 2: 最新模型调用与当前会话请求时间线（速度详情已独立至生成速度专属浮层） -->
    <div id="latest-call-card" class="latest-call-card" hidden>
      <div class="latest-call-header">
        <div class="latest-call-title-wrap">
          <span class="latest-call-title" data-i18n="session.latestCall.title">最新调用</span>
          <span id="latest-call-status-pill" class="key-pill pill-muted">--</span>
          <span id="latest-call-agent-pill" class="call-agent-badge" hidden>主代理</span>
        </div>
        <div class="latest-call-actions">
          <span id="latest-call-time" class="latest-call-time">—</span>
          <button id="btn-session-history-toggle" class="latest-call-link-btn" type="button" aria-expanded="false"
            data-i18n="session.timeline.viewHistory">查看历史</button>
        </div>
      </div>

      <button id="latest-call-new-banner" class="latest-call-new-banner" type="button" hidden
        data-i18n="session.latestCall.newAvailable">有新调用完成 · 点击查看最新</button>

      <div id="latest-call-body" class="latest-call-body">
        <div id="latest-call-summary-row" class="latest-call-summary-row" role="button" tabindex="0"
          aria-expanded="false">
          <div class="latest-call-model-wrap">
            <span id="latest-call-model" class="latest-call-model">—</span>
            <span id="latest-call-effort" class="call-effort-tag" hidden>—</span>
          </div>
          <div class="latest-call-metrics">
            <span id="latest-call-score-inline" class="call-score-badge" hidden>—</span>
            <span id="latest-call-tokens-inline" class="latest-call-metric-item">—</span>
            <span id="latest-call-cache-inline" class="latest-call-metric-item">—</span>
            <span id="latest-call-duration-inline" class="latest-call-metric-item">—</span>
          </div>
          <span id="btn-latest-call-toggle" class="latest-call-expand-caret" aria-hidden="true">▾</span>
        </div>

        <div id="latest-call-details" class="latest-call-details" style="display:none;">
          <div class="call-detail-grid" id="latest-call-detail-grid"></div>
          <div id="latest-call-error-box" class="call-detail-error" hidden></div>
        </div>
      </div>

      <div id="session-timeline-drawer" class="session-timeline-drawer" style="display:none;">
        <div id="session-timeline-summary" class="session-timeline-summary"></div>
        <div id="session-timeline-list" class="session-timeline-list"></div>
        <div id="session-timeline-unlinked" class="session-timeline-unlinked" hidden></div>
        <div id="session-timeline-more-wrap" class="session-timeline-more-wrap" hidden>
          <button id="btn-timeline-load-more" class="ctx-compact-link-btn" type="button"
            data-i18n="session.timeline.loadMore">加载更多轮次</button>
        </div>
      </div>
    </div>

    <!-- 折叠抽屉: 底层技术参数与附件审计 -->
    <div class="tech-drawer">
      <button id="btn-toggle-details" class="drawer-trigger" aria-expanded="false" type="button">
        <span class="drawer-trigger-left">
          <span data-i18n="session.techDrawer.title">底层技术参数与附件审计</span>
        </span>
        <span id="drawer-arrow" class="drawer-arrow" data-i18n="session.techDrawer.expand">▼ 点击展开明细</span>
      </button>
      <div id="drawer-body" class="drawer-body" style="display:none;">
        <p id="status" data-i18n="session.tech.checking">正在核对请求和附件…</p>
        <p id="model"></p>
        <h4 data-i18n="session.tech.latestReq">最近一次请求</h4>
        <dl>
          <dt data-i18n="session.tech.reqStatus">请求状态</dt>
          <dd id="request-status">—</dd>
          <dt data-i18n="session.tech.actual">实返输入＋输出</dt>
          <dd id="actual">—</dd>
          <dt data-i18n="session.tech.estimate">客户端估算</dt>
          <dd id="estimate">—</dd>
          <dt data-i18n="session.tech.budget">客户端预算</dt>
          <dd id="budget">—</dd>
          <dt data-i18n="session.tech.serviceLimit">服务端报错上限</dt>
          <dd id="service-limit">—</dd>
          <dt data-i18n="session.tech.percent">预算占比</dt>
          <dd id="percent">—</dd>
        </dl>
        <h4 data-i18n="session.tech.sessionHeading">会话累计内容 · 本地估算</h4>
        <dl>
          <dt data-i18n="session.tech.sessionTotal">可读文本估算</dt>
          <dd id="session-total" data-i18n="session.tech.scanning">扫描中…</dd>
          <dt data-i18n="session.tech.characters">读取字符数</dt>
          <dd id="characters">—</dd>
          <dt data-i18n="session.tech.user">用户消息</dt>
          <dd id="user">—</dd>
          <dt data-i18n="session.tech.assistant">模型回复</dt>
          <dd id="assistant">—</dd>
          <dt data-i18n="session.tech.thinking">思考内容</dt>
          <dd id="thinking">—</dd>
          <dt data-i18n="session.tech.tools">工具调用与输出</dt>
          <dd id="tools">—</dd>
          <dt data-i18n="session.tech.summaries">压缩摘要</dt>
          <dd id="summaries">—</dd>
          <dt data-i18n="session.tech.system">系统提示与工具</dt>
          <dd id="system">—</dd>
          <dt data-i18n="session.tech.attachments">附件文本</dt>
          <dd id="attachment-total">—</dd>
          <dt data-i18n="session.tech.steps">步骤完整性</dt>
          <dd id="steps">—</dd>
        </dl>
        <p id="coverage"></p>
        <h4 data-i18n="session.tech.filesHeading">附件逐项检查</h4>
        <div id="files"></div>
        <button id="refresh" type="button" data-i18n="session.tech.rescan">重新扫描会话与附件</button>
        <p id="note" data-i18n-html="session.tech.note">会话累计文本与附件 Token 为本地估算。</p>
        <p id="updated"></p>
      </div>
    </div>
  </div>

  <!-- ========================================================= -->
  <!-- 专属浮层 2B (对应 #badge -> 窗口规格): 各模型上下文窗口上限  -->
  <!-- ========================================================= -->
  <div id="pane-ctx-models" class="wb-tab-pane ctx-tab-pane" role="region" aria-labelledby="tab-ctx-models" hidden>
    <div id="subpane-model-specs">
      <div class="ctx-models-toolbar" id="ctx-models-toolbar" hidden>
        <select id="ctx-model-select" class="ctx-model-select" aria-label="查看模型" data-i18n-aria="panel.ctx.viewModel"
          style="display:none"></select>
        <button id="btn-ctx-back-current" class="ctx-mini-link-btn" type="button" hidden title="回到当前会话正在使用的模型"
          data-i18n="panel.ctx.backCurrent" data-i18n-title="panel.ctx.backCurrentTitle">回到当前模型</button>
      </div>

      <div id="ctx-model-list" class="ctx-model-list" aria-label="按厂商分组的模型产品列表" data-i18n-aria="models.list.aria"></div>

      <div id="ctx-model-card" class="ctx-detail-card">
        <div class="ctx-card-top">
          <div class="ctx-card-vendor-row">
            <span class="ctx-card-vendor-left">
              <span id="ctx-card-vendor-dot" class="ag-vendor-dot"></span>
              <span id="ctx-card-vendor-name" class="ctx-card-vendor-name">—</span>
            </span>
            <span id="ctx-card-quota-slot" class="ctx-card-quota-slot" hidden></span>
          </div>
          <div id="ctx-card-product-name" class="ctx-card-product-name" data-i18n="models.card.waiting">等待读取模型…</div>
          <div class="ctx-card-efforts-row">
            <span id="ctx-card-efforts-list" class="ctx-card-efforts-list"
              data-i18n="models.card.effortsEmpty">可用档位：—</span>
            <span id="ctx-card-session-effort" class="ctx-card-session-effort" hidden>当前会话：—</span>
          </div>
        </div>

        <div class="ctx-cap-ref-card" id="ctx-capability-ref">
          <div class="ctx-cap-ref-grid">
            <div class="ctx-cap-item">
              <span class="ctx-cap-lbl" data-i18n="models.cap.window">模型总窗口</span>
              <span class="ctx-cap-val" id="ctx-cap-window">—</span>
            </div>
            <div class="ctx-cap-item">
              <span class="ctx-cap-lbl" data-i18n="models.cap.output">最大输出</span>
              <span class="ctx-cap-val" id="ctx-cap-output">—</span>
            </div>
            <div class="ctx-cap-item">
              <span class="ctx-cap-lbl" data-i18n="models.cap.modelMax">理论输入上限</span>
              <span class="ctx-cap-val" id="ctx-cap-model-max">—</span>
            </div>
            <div class="ctx-cap-item">
              <span class="ctx-cap-lbl" data-i18n="models.cap.stockDefault">默认预算</span>
              <span class="ctx-cap-val" id="ctx-cap-default">—</span>
            </div>
          </div>
        </div>

        <div class="ctx-card-metrics ctx-card-metrics-spaced">
          <div class="ctx-metric-row ctx-metric-observed">
            <span class="ctx-metric-label" data-i18n="models.card.observedBudget">实测预算</span>
            <div class="ctx-metric-value-col">
              <span class="ctx-metric-value" id="ctx-card-observed-budget"
                data-i18n="models.card.observedBudgetNone">尚未观测</span>
              <span class="ctx-metric-service-limit" id="ctx-card-service-limit" hidden></span>
            </div>
            <span class="ctx-metric-side" data-i18n="models.card.observedBudgetSide">对话中实际分配</span>
          </div>
          <div class="ctx-metric-row ctx-metric-observed">
            <span class="ctx-metric-label" data-i18n="models.card.observedSpeed">实测速度</span>
            <div class="ctx-metric-value-col">
              <div id="ctx-card-observed-speed" class="ctx-speed-effort-lines"
                data-i18n="models.card.observedSpeedNone">暂无实测数据</div>
              <button id="btn-card-goto-speed" class="ctx-inline-link-btn" type="button"
                data-i18n="models.card.gotoSpeed">查看速度对比 ›</button>
            </div>
          </div>
          <div class="ctx-metric-row ctx-metric-client" id="ctx-card-tier-caps-row" hidden>
            <span class="ctx-metric-label" data-i18n="models.card.tierCaps">档位能力</span>
            <div class="ctx-metric-value-col">
              <div id="ctx-card-tier-caps" class="ctx-speed-effort-lines">—</div>
            </div>
          </div>
        </div>
        <div id="ctx-card-hints" class="ctx-card-hints" hidden></div>
      </div>
    </div>
  </div>

  <!-- ========================================================= -->
  <!-- 专属浮层 3 (对应 #badge-speed): 生成速度与跨模型对比 (460px) -->
  <!-- ========================================================= -->
  <div id="pane-ctx-speed" class="wb-tab-pane ctx-tab-pane" role="region" aria-label="生成速度与对比" hidden>
    <!-- 顶部卡片：当前最新响应流式速度、首字延迟与耗时拆解 -->
    <div id="speed-summary" class="unified-call-speed-card speed-summary-card">
      <div class="key-header">
        <span class="key-title speed-kpi-accent" data-i18n="session.speedSummary.titleNoBolt">最新响应速度</span>
        <div class="speed-badge-group">
          <span id="speed-badge" class="key-pill pill-muted" data-i18n="session.speed.pending">待生成</span>
          <button id="btn-speed-breakdown-toggle" class="latest-call-link-btn" type="button" aria-expanded="false"
            hidden data-i18n="session.speed.details">拆解</button>
        </div>
      </div>
      <div class="key-stats speed-kpi-grid">
        <div class="key-stat">
          <div class="key-stat-label" id="speed-val-label" data-i18n="session.speed.streamRate">纯流式速度</div>
          <div id="speed-val" class="key-stat-val speed-kpi-accent">—</div>
        </div>
        <div class="key-stat">
          <div class="key-stat-label" data-i18n="session.speed.ttft">首字延迟</div>
          <div id="speed-ttft" class="key-stat-val">—</div>
        </div>
        <div class="key-stat">
          <div class="key-stat-label" data-i18n="session.speed.duration">生成耗时</div>
          <div id="speed-duration" class="key-stat-val">—</div>
        </div>
        <div class="key-stat">
          <div class="key-stat-label" data-i18n="session.speed.tokens">本次输出</div>
          <div id="speed-tokens" class="key-stat-val">—</div>
        </div>
      </div>
      <div id="speed-sub-label" class="speed-sub-label" hidden></div>
      <div id="speed-takeaway" class="key-takeaway" data-i18n="session.speed.wait">等待首次模型输出产生速度统计…</div>
      <div id="speed-breakdown-details" class="speed-breakdown-details" style="display:none;">
        <div class="call-detail-grid" id="speed-breakdown-grid"></div>
      </div>
    </div>

    <!-- 下方区域：各模型与档位历史速度对比 -->
    <div class="ctx-speed-toolbar">
      <div class="ctx-segmented" role="group" aria-label="时间范围" data-i18n-aria="speed.range.aria">
        <button id="speed-range-7d" class="ctx-seg-btn active" type="button" data-speed-range="7"
          data-i18n="speed.range.7d">近 7 天</button>
        <button id="speed-range-30d" class="ctx-seg-btn" type="button" data-speed-range="30"
          data-i18n="speed.range.30d">近 30 天</button>
        <button id="speed-range-all" class="ctx-seg-btn" type="button" data-speed-range="all"
          data-i18n="speed.range.all">全部</button>
      </div>
      <div id="speed-origin-filter-wrap" class="ctx-segmented" role="group" aria-label="样本来源"
        data-i18n-aria="speed.origin.aria">
        <button id="speed-origin-all" class="ctx-seg-btn active" type="button" data-speed-origin="all"
          data-i18n="speed.origin.all">全部来源</button>
        <button id="speed-origin-chat" class="ctx-seg-btn" type="button" data-speed-origin="chat"
          data-i18n="speed.origin.chat">日常对话</button>
      </div>
    </div>

    <div class="ctx-chart-card" id="speed-unified-chart-card">
      <div class="ctx-chart-header">
        <div class="ctx-segmented" role="tablist" aria-label="对比指标" data-i18n-aria="speed.metric.aria">
          <button id="speed-view-mode-bar" class="ctx-seg-btn active" type="button" role="tab" aria-selected="true"
            data-speed-view="bar" data-i18n="speed.viewMode.bar">模型对比</button>
          <button id="speed-view-mode-line" class="ctx-seg-btn" type="button" role="tab" aria-selected="false"
            data-speed-view="line" data-i18n="speed.viewMode.line">单模型趋势</button>
        </div>
      </div>

      <div id="speed-chart-pane-bar" class="speed-chart-subpane">
        <div class="ctx-chart-header ctx-chart-subheader">
          <span id="speed-bar-title" class="ctx-chart-title ctx-chart-subtitle"
            data-i18n="speed.barTitle.tps">输出速度对比</span>
          <div class="ctx-segmented" role="group" aria-label="对比指标" data-i18n-aria="speed.metric.aria">
            <button id="speed-metric-tps" class="ctx-seg-btn active" type="button" data-speed-metric="tps"
              data-i18n="speed.metric.tps">输出速度</button>
            <button id="speed-metric-ttft" class="ctx-seg-btn" type="button" data-speed-metric="ttft"
              data-i18n="speed.metric.ttft">首字延迟</button>
            <button id="speed-metric-duration" class="ctx-seg-btn" type="button" data-speed-metric="duration"
              data-i18n="speed.metric.duration">总耗时</button>
          </div>
        </div>
        <div id="speed-bar-empty" class="ctx-speed-empty" hidden data-i18n="speed.empty">还没有可用的速度记录。正常对话后会自动积累。</div>
        <div id="speed-bar-chart-wrap" class="ctx-svg-wrap">
          <svg id="speed-bar-svg" class="ctx-speed-svg" role="img" aria-label="各模型与档位速度对比柱状图"
            data-i18n-aria="speed.barSvg.aria"></svg>
          <div id="speed-bar-tooltip" class="ctx-chart-tooltip" hidden></div>
        </div>
        <div id="speed-bar-note" class="ctx-chart-note" data-i18n="speed.barNote">按中位数统计 · 不足 3 条标为样本少</div>
      </div>

      <div id="speed-chart-pane-line" class="speed-chart-subpane" hidden>
        <div class="ctx-chart-header ctx-chart-subheader ctx-line-header">
          <span class="ctx-chart-title ctx-chart-subtitle" data-i18n="speed.lineTitle">单模型速度趋势</span>
          <div id="speed-model-dropdown-wrap" class="ag-dropdown-wrapper ctx-speed-dropdown">
            <div id="speed-model-dropdown-trigger" class="ag-dropdown-trigger ctx-compact-trigger" tabindex="0"
              title="选择一个模型与档位查看速度变化" data-i18n-title="speed.linePickTitle">
              <span id="speed-model-dropdown-label" class="ag-dropdown-label"
                data-i18n="speed.lineNoModel">暂无模型记录</span>
              <div class="ag-dropdown-arrow">
                <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5"
                  stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 1l4 4 4-4" />
                </svg>
              </div>
            </div>
            <div id="speed-model-dropdown-menu" class="ag-dropdown-menu"></div>
          </div>
        </div>
        <div id="speed-line-empty" class="ctx-speed-empty" data-i18n="speed.empty">还没有可用的速度记录。正常对话后会自动积累。</div>
        <div id="speed-line-chart-wrap" class="ctx-svg-wrap" hidden>
          <svg id="speed-line-svg" class="ctx-speed-svg" role="img" aria-label="所选模型与档位历史输出速度折线图"
            data-i18n-aria="speed.lineSvg.aria"></svg>
          <div id="speed-line-tooltip" class="ctx-chart-tooltip" hidden></div>
        </div>
      </div>
    </div>
  </div>

  <!-- ========================================================= -->
  <!-- 专属浮层 4 (对应 #badge-tokens): 累计 Token 用量 (700px)   -->
  <!-- ========================================================= -->
  <div id="panel-tokens" class="wb-tab-pane" role="region" aria-label="累计 Token 用量" hidden>
    <div id="view-tokens">
      <div class="tokens-unified-toolbar">
        <div class="source-switch-bar">
          <button id="src-tab-all" class="switch-pill-btn active" type="button" data-i18n="tokens.src.all">全部</button>
          <button id="src-tab-desktop" class="switch-pill-btn" type="button"
            data-i18n="tokens.src.desktop">桌面端</button>
          <button id="src-tab-cli" class="switch-pill-btn" type="button" data-i18n="tokens.src.cli">CLI</button>
        </div>

        <div class="source-switch-bar">
          <button id="tok-view-tokens" class="switch-pill-btn active" type="button"
            data-i18n="tokens.view.tokens">Token 统计</button>
          <button id="tok-view-models" class="switch-pill-btn" type="button"
            data-i18n="tokens.view.models">按模型</button>
          <button id="tok-view-cost" class="switch-pill-btn" type="button"
            data-i18n="tokens.view.cost">API 参考金额</button>
        </div>
      </div>

      <div id="tokens-main-view">
        <div class="token-stat-cards" id="token-stat-cards">
          <div class="t-card">
            <div class="t-card-lbl">
              <span data-i18n="tokens.card.total">累计用量</span>
              <span class="t-card-tag" data-i18n="tokens.card.includeCache">含缓存</span>
            </div>
            <div class="t-card-val" id="t-total-val">--</div>
            <div class="t-card-sub" id="t-total-sub" data-i18n="common.loading">读取中...</div>
            <div class="t-card-cost" id="t-total-cost" data-i18n="tokens.card.costPlaceholder">≈ $0.00 · 日均 $0.00</div>
          </div>
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.today">今日使用</span></div>
            <div class="t-card-val" id="t-today-val">--</div>
            <div class="t-card-sub" id="t-today-sub" data-i18n="common.loading">读取中...</div>
            <div class="t-card-cost" id="t-today-cost">≈ $0.00</div>
          </div>
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.month">本月使用</span></div>
            <div class="t-card-val" id="t-month-val">--</div>
            <div class="t-card-sub" id="t-month-sub" data-i18n="common.loading">读取中...</div>
            <div class="t-card-cost" id="t-month-cost" data-i18n="tokens.card.costPlaceholder">≈ $0.00 · 日均 $0.00</div>
          </div>
          <div class="t-card">
            <div class="t-card-lbl"><span data-i18n="tokens.card.year">年度使用</span></div>
            <div class="t-card-val" id="t-year-val">--</div>
            <div class="t-card-sub" id="t-year-sub" data-i18n="common.loading">读取中...</div>
            <div class="t-card-cost" id="t-year-cost" data-i18n="tokens.card.costPlaceholder">≈ $0.00 · 日均 $0.00</div>
          </div>
        </div>

        <div id="token-cache-breakdown" class="token-cache-breakdown">
          <div class="tcb-item">
            <span class="tcb-lbl" data-i18n="tokens.cache.uncachedInput">未缓存输入</span>
            <strong class="tcb-val" id="tcb-input-val">--</strong>
          </div>
          <div class="tcb-item">
            <span class="tcb-lbl" data-i18n="tokens.cache.cacheRead">缓存读取</span>
            <strong class="tcb-val" id="tcb-cache-val">--</strong>
          </div>
          <div class="tcb-item">
            <span class="tcb-lbl" data-i18n="tokens.cache.totalInput">总输入</span>
            <strong class="tcb-val" id="tcb-total-input-val">--</strong>
          </div>
          <div class="tcb-item">
            <span class="tcb-lbl" data-i18n="tokens.cache.output">输出</span>
            <strong class="tcb-val" id="tcb-output-val">--</strong>
          </div>
          <div class="tcb-item tcb-ratio-item">
            <span class="tcb-lbl" data-i18n="tokens.cache.ratio">缓存占比</span>
            <strong class="tcb-val tcb-ratio-val" id="tcb-ratio-val">--</strong>
          </div>
          <div class="tcb-note" id="tcb-note" hidden></div>
        </div>

        <div class="heatmap-section">
          <div class="heat-header">
            <div class="heat-header-left">
              <div class="heat-title" data-i18n="tokens.heat.title">Token 活动</div>
              <div class="heat-win-nav">
                <button id="h-page-prev" class="heat-nav-btn" type="button" title="查看更早的 12 个月窗口"
                  data-i18n-title="tokens.heat.prevTitle" disabled>‹</button>
                <span id="h-win-range">--</span>
                <button id="h-page-next" class="heat-nav-btn" type="button" title="查看更新的 12 个月窗口"
                  data-i18n-title="tokens.heat.nextTitle" disabled>›</button>
              </div>
            </div>
            <div class="heat-tabs" id="heat-tabs-bar" role="tablist" aria-label="热力图统计周期"
              data-i18n-aria="tokens.heat.tabsAria">
              <div class="heat-tab-thumb" id="heat-tab-thumb" aria-hidden="true"></div>
              <button class="heat-tab-btn active" id="h-tab-daily" role="tab" aria-selected="true" type="button"
                tabindex="0" data-i18n="tokens.heat.daily">每天</button>
              <button class="heat-tab-btn" id="h-tab-weekly" role="tab" aria-selected="false" type="button" tabindex="-1"
                data-i18n="tokens.heat.weekly">每周</button>
              <button class="heat-tab-btn" id="h-tab-monthly" role="tab" aria-selected="false" type="button"
                tabindex="-1" data-i18n="tokens.heat.monthly">每月</button>
              <button class="heat-tab-btn" id="h-tab-yearly" role="tab" aria-selected="false" type="button"
                tabindex="-1" data-i18n="tokens.heat.yearly">今年</button>
              <button class="heat-tab-btn" id="h-tab-cum" role="tab" aria-selected="false" type="button" tabindex="-1"
                data-i18n="tokens.heat.cum">累计总量</button>
            </div>
          </div>
          <div class="heat-scroll-box" id="h-scroll-box">
            <div id="h-daily-box">
              <div class="heat-grid-cols" id="h-grid-cols"></div>
              <div class="heat-months" id="h-months"></div>
            </div>
            <div id="h-weekly-box" style="display:none"></div>
            <div id="h-monthly-box" style="display:none"></div>
            <div id="h-yearly-box" style="display:none"></div>
            <div id="h-cum-box" style="display:none">
              <canvas id="h-cum-canvas"></canvas>
            </div>
          </div>
          <div id="h-summary-bar" class="heat-summary-bar">
            <div class="heat-sum-item">
              <span class="heat-sum-label" data-i18n="tokens.heat.sumTokens">区间合计:</span>
              <span id="h-sum-tokens" class="heat-sum-val">-- Tokens</span>
            </div>
            <div class="heat-sum-item">
              <span class="heat-sum-label" data-i18n="tokens.heat.sumCost">预估费用:</span>
              <span id="h-sum-cost" class="heat-sum-val">≈ $0.00</span>
            </div>
            <div class="heat-sum-item">
              <span class="heat-sum-label" data-i18n="tokens.heat.sumDailyAvg">折合每天:</span>
              <span id="h-sum-daily-avg" class="heat-sum-val">$0.00</span>
            </div>
            <div class="heat-sum-item">
              <span class="heat-sum-label" data-i18n="tokens.heat.sumActiveAvg">活跃日均:</span>
              <span id="h-sum-active-avg" class="heat-sum-val" data-i18n="tokens.heat.activeAvgPlaceholder">$0.00
                (0天)</span>
            </div>
            <div id="h-sum-sub-ratio-wrap" class="heat-sum-item heat-sum-clickable" style="display:none" role="button"
              tabindex="0" title="点击跳转至 API 参考金额调整月度实付">
              <span class="heat-sum-label" data-i18n="tokens.heat.sumSubRatio">订阅性价比:</span>
              <span id="h-sum-sub-ratio" class="heat-sum-val heat-sum-accent">--</span>
            </div>
          </div>
          <div class="heat-footer-row">
            <span id="first-use-badge" class="first-use-badge heat-footer-note"
              data-i18n="tokens.heat.firstUsePlaceholder">首次使用：--</span>
            <div id="heat-legend-scale" class="heat-legend-scale">
              <span data-i18n="tokens.heat.less">少</span>
              <span id="heat-leg-0" class="heat-leg-swatch"></span>
              <span id="heat-leg-1" class="heat-leg-swatch"></span>
              <span id="heat-leg-2" class="heat-leg-swatch"></span>
              <span id="heat-leg-3" class="heat-leg-swatch"></span>
              <span id="heat-leg-4" class="heat-leg-swatch"></span>
              <span data-i18n="tokens.heat.more">多</span>
            </div>
          </div>
        </div>
      </div>

      <div id="model-usage-view" class="model-usage-card" style="display:none">
        <div class="model-usage-header">
          <div>
            <div class="model-usage-title" data-i18n="modelsUsage.title">按模型 Token 用量</div>
            <div id="model-usage-subtitle" class="model-usage-subtitle" data-i18n="modelsUsage.subtitle">查看桌面端与 CLI 各模型每日 Token 消耗及占比分布。</div>
          </div>
        </div>

        <div class="model-usage-controls">
          <div class="source-switch-bar">
            <button id="model-period-7d" class="switch-pill-btn active" type="button">7d</button>
            <button id="model-period-30d" class="switch-pill-btn" type="button">30d</button>
          </div>
          <div class="model-usage-right-ctrls">
            <div class="source-switch-bar">
              <button id="model-group-model" class="switch-pill-btn active" type="button"
                data-i18n="modelsUsage.groupModel">按模型</button>
              <button id="model-group-variant" class="switch-pill-btn" type="button"
                data-i18n="modelsUsage.groupVariant">按档位</button>
            </div>
            <div class="source-switch-bar">
              <button id="model-metric-total" class="switch-pill-btn active" type="button"
                data-i18n="modelsUsage.metricTotal">含缓存</button>
              <button id="model-metric-nocache" class="switch-pill-btn" type="button"
                data-i18n="modelsUsage.metricNoCache">不含缓存</button>
            </div>
            <button id="model-toggle-unattr" class="switch-pill-btn model-unattr-btn" type="button" style="display:none"
              data-i18n="modelsUsage.hideUnattr">隐藏未标明</button>
          </div>
        </div>

        <div class="model-usage-nav-row">
          <div class="model-usage-range-wrap">
            <span id="model-usage-range-label" class="model-usage-range-lbl">--</span>
            <span id="model-usage-window-total" class="key-pill pill-muted model-win-pill">--</span>
          </div>
          <div class="model-usage-nav-btns">
            <button id="btn-model-win-prev" class="heat-nav-btn" type="button" title="查看更早区间"
              data-i18n-title="modelsUsage.prevTitle">‹</button>
            <button id="btn-model-win-next" class="heat-nav-btn" type="button" title="查看更新区间"
              data-i18n-title="modelsUsage.nextTitle" disabled>›</button>
          </div>
        </div>

        <div id="model-usage-chart-wrap" class="model-usage-chart-wrap">
          <div class="model-usage-gridlines" aria-hidden="true">
            <div class="model-usage-gridline"><span id="model-chart-max-lbl" class="model-chart-max-lbl"></span></div>
            <div class="model-usage-gridline"></div>
            <div class="model-usage-gridline"></div>
            <div class="model-usage-gridline"></div>
          </div>
          <div id="model-usage-bars" class="model-usage-bars"></div>
          <div id="model-usage-xaxis" class="model-usage-xaxis"></div>
        </div>

        <div id="model-usage-empty" class="model-usage-empty" style="display:none" data-i18n="modelsUsage.empty">当前时间窗暂无 Token 用量记录</div>
        <div id="model-usage-legend" class="model-usage-legend"></div>
      </div>

      <div id="cost-estimate-card" class="cost-full-card" style="display:none">
        <div class="cost-full-top-bar">
          <div class="cost-top-title-group">
            <span id="cost-card-title" class="cost-card-title cost-card-heading" data-i18n="cost.title">本期 API 参考金额</span>
            <span id="cost-period-tag" class="key-pill pill-muted cost-meta-pill"
              data-i18n="cost.periodTag">本月自然月</span>
            <span id="cost-non-paid-badge" class="key-pill pill-muted cost-meta-pill"
              data-i18n="cost.nonPaidBadge">参考估值</span>
          </div>
          <div class="cost-scope-actions">
            <button id="cost-btn-scope-period" class="switch-pill-btn cost-compact-pill active" type="button"
              data-i18n="cost.scopePeriod">本期</button>
            <button id="cost-btn-scope-all" class="switch-pill-btn cost-compact-pill" type="button"
              data-i18n="cost.scopeAll">全量历史</button>
            <span id="cost-coverage-pill" class="key-pill pill-muted cost-meta-pill">100%</span>
          </div>
        </div>

        <div class="cost-hero-grid">
          <div>
            <div id="cost-grand-val" class="cost-grand-val">$0.00</div>
            <div id="cost-scope-desc" class="cost-scope-desc">—</div>
          </div>
          <div id="cost-grand-sub" class="cost-grand-sub">—</div>
        </div>

        <div id="cost-details-pane">
          <div class="cost-mode-row">
            <span class="cost-mode-lbl" data-i18n="cost.modeLabel">估值模式:</span>
            <div class="source-switch-bar">
              <button id="cost-btn-mode-ref" class="switch-pill-btn cost-compact-pill active" type="button"
                data-i18n="cost.modeRef">参考模型估算</button>
              <button id="cost-btn-mode-hybrid" class="switch-pill-btn cost-compact-pill" type="button"
                data-i18n="cost.modeHybrid">混合模式</button>
              <button id="cost-btn-mode-identified" class="switch-pill-btn cost-compact-pill" type="button"
                data-i18n="cost.modeIdentified">仅已识别模型</button>
            </div>
          </div>

          <div class="cost-summary-strip">
            <span id="cost-usage-summary" class="cost-usage-summary cost-usage-summary-txt">—</span>
            <span id="cost-diff-summary" class="cost-diff-summary cost-diff-summary-txt">—</span>
          </div>

          <div id="ref-cost-breakdown-cards" class="ref-cost-grid">
            <div class="t-card ref-cost-card ref-cost-subcard">
              <div class="ref-cost-lbl"><span data-i18n="cost.card.input">输入 Token</span> ($0.75/M)</div>
              <div id="ref-cost-input-val" class="ref-cost-val">$0.00</div>
              <div id="ref-cost-input-tok" class="ref-cost-tok">0 tok</div>
            </div>
            <div class="t-card ref-cost-card ref-cost-subcard">
              <div class="ref-cost-lbl"><span data-i18n="cost.card.cache">缓存读取 (优惠)</span> ($0.075/M)</div>
              <div id="ref-cost-cache-val" class="ref-cost-val">$0.00</div>
              <div id="ref-cost-cache-tok" class="ref-cost-tok">0 tok</div>
            </div>
            <div class="t-card ref-cost-card ref-cost-subcard">
              <div class="ref-cost-lbl"><span data-i18n="cost.card.output">输出 Token</span> ($3.75/M)</div>
              <div id="ref-cost-output-val" class="ref-cost-val">$0.00</div>
              <div id="ref-cost-output-tok" class="ref-cost-tok">0 tok</div>
            </div>
          </div>

          <div id="plan-detail-card" class="cost-roi-card">
            <div class="cost-roi-header">
              <div class="cost-roi-title-group cost-roi-title-row">
                <span class="cost-roi-title" data-i18n="cost.roiCard.title">月度订阅实付对比 (USD)</span>
                <span id="plan-summary-price-val" class="cost-roi-price-pill">$19.99/月</span>
                <span id="p-det-price" class="sr-only">$19.99/月</span>
                <span id="p-det-price-tag" class="key-pill pill-muted cost-meta-pill"
                  data-i18n="plan.tag.publicRef">公开参考价</span>
                <span id="plan-save-feedback" class="plan-save-feedback" style="display:none"></span>
              </div>
              <div id="cost-sub-line-wrap" class="cost-sub-line-wrap">
                <span id="cost-sub-line" data-i18n="cost.subUnknown">订阅实付：未填写</span>
                <span id="cost-sub-spend-val" style="display:none">—</span>
                <span id="cost-sub-compare-note" style="display:none"></span>
                <span id="cost-sub-spend-lbl" style="display:none"></span>
              </div>
            </div>
            <div class="minimal-spend-controls cost-spend-controls">
              <div class="minimal-spend-input-wrap">
                <span class="minimal-spend-prefix">$</span>
                <input id="input-monthly-spend-usd" type="number" min="0" step="0.01" placeholder="19.99（免费填 0）"
                  data-i18n-placeholder="plan.spend.placeholder" />
              </div>
              <button id="btn-monthly-spend-free" class="switch-pill-btn" type="button"
                data-i18n="plan.spend.btnFree">设为 $0</button>
              <button id="btn-monthly-spend-save" class="switch-pill-btn active" type="button"
                data-i18n="plan.form.save">保存</button>
              <button id="btn-monthly-spend-clear" class="switch-pill-btn btn-spend-clear cost-clear-btn" type="button"
                data-i18n="plan.form.clear">清除</button>
            </div>
          </div>

          <div id="cost-breakdown-info" class="cost-breakdown-info" data-i18n="cost.analyzing">
            正在分析请求模型与计价覆盖率…
          </div>

          <div class="cost-disclaimer-note" data-i18n="cost.disclaimer">
            按公开 API 单价折算（缓存 10%），仅作参考。
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ========================================================= -->
  <!-- 共享设置视图 (设置: 语言 / 主题与精选色板 / 顶栏指标)            -->
  <!-- ========================================================= -->
  <div id="pane-ctx-settings" class="wb-tab-pane ctx-tab-pane" role="region" aria-label="面板与顶栏设置" hidden>
    <div class="ctx-settings-card" id="appearance-presets-card">
      <div class="ctx-settings-card-hdr">
        <div class="ctx-settings-card-title" data-i18n="settings.appearance.title">语言、主题与精选配色</div>
        <button id="btn-reset-appearance" class="color-reset-btn" type="button"
          data-i18n="settings.appearance.reset">恢复默认外观</button>
      </div>

      <div class="appearance-row">
        <span class="appearance-row-lbl" data-i18n="settings.panelLang.label">界面语言</span>
        <div id="panel-lang-top-segmented" class="ctx-segmented" role="group" aria-label="插件面板语言"
          data-i18n-aria="settings.panelLang.aria">
          <button id="btn-top-lang-zh-CN" class="ctx-seg-btn" type="button" data-panel-lang="zh-CN" title="简体中文"
            aria-label="简体中文">简</button>
          <button id="btn-top-lang-zh-TW" class="ctx-seg-btn" type="button" data-panel-lang="zh-TW" title="繁體中文"
            aria-label="繁體中文">繁</button>
          <button id="btn-top-lang-en" class="ctx-seg-btn active" type="button" data-panel-lang="en" title="English"
            aria-label="English">EN</button>
        </div>
      </div>

      <div class="appearance-row">
        <span class="appearance-row-lbl" data-i18n="settings.themeMode.label">主题模式</span>
        <div id="theme-mode-segmented" class="ctx-segmented" role="group" aria-label="主题模式"
          data-i18n-aria="settings.themeMode.label">
          <button id="btn-theme-mode-auto" class="ctx-seg-btn active" type="button" data-theme-mode="auto"
            data-i18n="settings.themeMode.auto">跟随宿主</button>
          <button id="btn-theme-mode-dark" class="ctx-seg-btn" type="button" data-theme-mode="dark"
            data-i18n="settings.themeMode.dark">深色</button>
          <button id="btn-theme-mode-light" class="ctx-seg-btn" type="button" data-theme-mode="light"
            data-i18n="settings.themeMode.light">浅色</button>
        </div>
      </div>

      <div class="appearance-palette-block">
        <div class="appearance-row-lbl appearance-palette-lbl" data-i18n="settings.palette.label">主题配色</div>
        <div class="heat-preset-group palette-grid-5" id="heat-preset-group">
          <button id="preset-btn-violet" class="heat-preset-btn" type="button" data-heat-preset="violet" data-active="true">
            <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#3f1e6b"></i><i
                style="background:#652ab7"></i><i style="background:#9053f8"></i><i style="background:#c084fc"></i></span>
            <span data-i18n="settings.palette.violet">紫罗兰</span>
          </button>
          <button id="preset-btn-emerald" class="heat-preset-btn" type="button" data-heat-preset="emerald" data-active="false">
            <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#14532d"></i><i
                style="background:#15803d"></i><i style="background:#22c55e"></i><i style="background:#86efac"></i></span>
            <span data-i18n="settings.palette.emerald">经典绿</span>
          </button>
          <button id="preset-btn-ocean" class="heat-preset-btn" type="button" data-heat-preset="ocean" data-active="false">
            <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#1e3a8a"></i><i
                style="background:#1d4ed8"></i><i style="background:#3b82f6"></i><i style="background:#93c5fd"></i></span>
            <span data-i18n="settings.palette.ocean">深海蓝</span>
          </button>
          <button id="preset-btn-amber" class="heat-preset-btn" type="button" data-heat-preset="amber" data-active="false">
            <span class="heat-preset-dots"><i style="background:#27272a"></i><i style="background:#78350f"></i><i
                style="background:#b45309"></i><i style="background:#f59e0b"></i><i style="background:#fde68a"></i></span>
            <span data-i18n="settings.palette.amber">琥珀金</span>
          </button>
          <button id="preset-btn-graphite" class="heat-preset-btn" type="button" data-heat-preset="graphite" data-active="false">
            <span class="heat-preset-dots"><i style="background:#232326"></i><i style="background:#3f3f46"></i><i
                style="background:#52525b"></i><i style="background:#a1a1aa"></i><i style="background:#e4e4e7"></i></span>
            <span data-i18n="settings.palette.graphite">石墨灰</span>
          </button>
        </div>
      </div>
    </div>

    <div class="ctx-settings-card" id="topbar-pills-card">
      <div class="ctx-settings-card-hdr">
        <div class="ctx-settings-card-title" data-i18n="settings.pills.title">顶栏常驻指标</div>
      </div>
      <div class="pill-toggles-grid" id="topbar-pills-grid">
        <label class="pill-toggle-item">
          <input id="chk-pill-quota" type="checkbox" checked />
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" stroke-opacity="0.28"></circle>
            <path d="M8 2.5A5.5 5.5 0 1 1 2.8 9.8" stroke-linecap="round"></path>
          </svg>
          <span class="pill-toggle-name" data-i18n="settings.pills.quota">模型额度</span>
        </label>
        <label class="pill-toggle-item">
          <input id="chk-pill-context" type="checkbox" checked />
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" stroke-opacity="0.28"></circle>
            <path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke-linecap="round"></path>
          </svg>
          <span class="pill-toggle-name" data-i18n="settings.pills.context">上下文占比</span>
        </label>
        <label class="pill-toggle-item">
          <input id="chk-pill-speed" type="checkbox" checked />
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9.2 1.8L3.6 9h4.1l-.9 5.2L12.4 7H8.3l.9-5.2z"></path>
          </svg>
          <span class="pill-toggle-name" data-i18n="settings.pills.speed">输出速度</span>
        </label>
        <label class="pill-toggle-item">
          <input id="chk-pill-tokens" type="checkbox" checked />
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M3 13V9M8 13V4M13 13V7"></path>
          </svg>
          <span class="pill-toggle-name" data-i18n="settings.pills.tokens">累计用量</span>
        </label>
        <label class="pill-toggle-item">
          <input id="chk-pill-cli" type="checkbox" checked />
          <span class="cli-icon" aria-hidden="true">&gt;_</span>
          <span class="pill-toggle-name" data-i18n="settings.pills.cli">CLI 终端</span>
        </label>
      </div>
    </div>
  </div>

  <!-- 全局统一居中重启确认模态弹窗 -->
  <div id="global-restart-modal" class="ag-modal-overlay" hidden role="dialog" aria-modal="true"
    aria-labelledby="modal-restart-title">
    <div class="ag-modal-card">
      <div id="modal-restart-title" class="ag-modal-title" data-i18n="models.restartConfirm.title">重启 Antigravity 客户端</div>
      <div id="modal-restart-text" class="ag-modal-body" data-i18n="models.restartConfirm.text">重启会中断正在运行的任务。请先保存未保存的内容。</div>
      <div id="modal-restart-feedback" class="ag-modal-feedback" hidden></div>
      <div class="ag-modal-actions">
        <button id="btn-modal-restart-cancel" class="unlock-btn unlock-btn-secondary" type="button"
          data-i18n="models.restartConfirm.cancel">取消</button>
        <button id="btn-modal-restart-confirm" class="unlock-btn unlock-btn-primary" type="button"
          data-i18n="models.restartConfirm.go">确认重启</button>
      </div>
    </div>
  </div>
</section>`;

  (document.body || document.documentElement).appendChild(host);
  const el = id => shadow.getElementById(id);
  // =========================================================================
// 模块 0: 插件面板三语言国际化 (默认 English / 简体中文 / 繁體中文)
// =========================================================================
const DEFAULT_PANEL_LANGUAGE = 'en';
const VALID_PANEL_LANGUAGES = new Set(['zh-CN', 'zh-TW', 'en']);

function normalizePanelLanguage(lang) {
  if (typeof lang !== 'string') return DEFAULT_PANEL_LANGUAGE;
  const trimmed = lang.trim();
  if (VALID_PANEL_LANGUAGES.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'tw') return 'zh-TW';
  if (lower === 'zh-cn' || lower === 'zh-hans' || lower === 'zh') return 'zh-CN';
  return DEFAULT_PANEL_LANGUAGE;
}

let currentPanelLanguage = DEFAULT_PANEL_LANGUAGE;
try {
  const initialLocalLang = typeof localStorage !== 'undefined' ? localStorage?.getItem?.('ag_panel_language') : null;
  if (initialLocalLang && VALID_PANEL_LANGUAGES.has(initialLocalLang)) {
    currentPanelLanguage = initialLocalLang;
  }
} catch { }

function getPanelLanguage() {
  return currentPanelLanguage;
}

const PANEL_I18N = {
  'badge.aria': { 'zh-CN': '会话与上下文统计', 'zh-TW': '對話與 Context 統計', en: 'Session and context statistics' },
  'badge.reading': { 'zh-CN': '读取中…', 'zh-TW': '讀取中…', en: 'Loading…' },
  'badge.speed.aria': { 'zh-CN': '模型输出速度与耗时统计', 'zh-TW': '模型輸出速度與耗時統計', en: 'Model output speed and latency' },
  'badge.tokens.aria': { 'zh-CN': 'Token 用量一览', 'zh-TW': 'Token 用量總覽', en: 'Token usage overview' },
  'badge.cli.aria': { 'zh-CN': '启动 CLI', 'zh-TW': '啟動 CLI', en: 'Launch CLI' },
  'badge.cli.title': { 'zh-CN': '一键启动 Antigravity CLI 终端（自动进入当前项目目录）', 'zh-TW': '一鍵啟動 Antigravity CLI 終端機（自動進入目前專案目錄）', en: 'Launch Antigravity CLI in the current workspace' },
  'badge.overflow.aria': { 'zh-CN': '更多统计指标', 'zh-TW': '更多統計指標', en: 'More metrics' },
  'tip.title.default': { 'zh-CN': '上下文窗口：', 'zh-TW': 'Context 視窗：', en: 'Context window:' },
  'tip.pct.notReady': { 'zh-CN': '数据尚未就绪', 'zh-TW': '資料尚未就緒', en: 'Data not ready' },
  'tip.detail.loading': { 'zh-CN': '正在读取当前会话上下文用量…', 'zh-TW': '正在讀取目前對話 Context 用量…', en: 'Reading current session context usage…' },
  'overflow.aria': { 'zh-CN': '更多统计快捷菜单', 'zh-TW': '更多統計快捷選單', en: 'More metrics menu' },
  'overflow.speed': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output speed' },
  'overflow.tokens': { 'zh-CN': '累计用量', 'zh-TW': '累計用量', en: 'Total Usage' },
  'overflow.cli': { 'zh-CN': '启动 CLI 终端', 'zh-TW': '啟動 CLI 終端機', en: 'Launch CLI' },
  'cli.launched': { 'zh-CN': '已启动 Antigravity CLI（目录：{cwd}）', 'zh-TW': '已啟動 Antigravity CLI（目錄：{cwd}）', en: 'Launched Antigravity CLI (cwd: {cwd})' },
  'panel.ctx.viewModel': { 'zh-CN': '查看模型', 'zh-TW': '檢視模型', en: 'Model' },
  'panel.ctx.viewModelTitle': { 'zh-CN': '按厂商查看不同模型的能力规格与实时额度', 'zh-TW': '依廠商檢視不同模型的能力規格與即時額度', en: 'Inspect model capabilities and live quota by vendor' },
  'panel.ctx.loadingModels': { 'zh-CN': '正在读取模型…', 'zh-TW': '正在讀取模型…', en: 'Loading models…' },
  'panel.ctx.backCurrent': { 'zh-CN': '回到当前模型', 'zh-TW': '回到目前模型', en: 'Back to current' },
  'panel.ctx.backCurrentTitle': { 'zh-CN': '回到当前会话正在使用的模型', 'zh-TW': '回到目前工作階段正在使用的模型', en: 'Switch back to the active session model' },
  'header.close.aria': { 'zh-CN': '收起详情', 'zh-TW': '收起詳細資訊', en: 'Close panel' },
  'tabs.aria': { 'zh-CN': '上下文面板分页', 'zh-TW': '上下文面板分頁', en: 'Context panel tabs' },
  'tab.session': { 'zh-CN': '当前会话', 'zh-TW': '目前工作階段', en: 'Session' },
  'tab.models': { 'zh-CN': '模型规格', 'zh-TW': '模型規格', en: 'Model Specs' },
  'tab.speed': { 'zh-CN': '速度对比', 'zh-TW': '速度對比', en: 'Speed' },
  'tab.settings': { 'zh-CN': '外观配置', 'zh-TW': '外觀配置', en: 'Appearance' },
  'models.cap.stockDefault': { 'zh-CN': '默认预算', 'zh-TW': '預設預算', en: 'Default Budget' },
  'session.costBar.title': { 'zh-CN': '当前模型调用的 API 等值参考金额', 'zh-TW': '目前模型呼叫的 API 等值參考金額', en: 'Estimated API-equivalent cost for this session' },
  'session.roundCost.dash': { 'zh-CN': '本轮估值：—', 'zh-TW': '本輪估算：—', en: 'This turn: —' },
  'session.sessionCost.dash': { 'zh-CN': '当前会话合计：—', 'zh-TW': '目前對話合計：—', en: 'Session total: —' },
  'session.keySummary.title': { 'zh-CN': '当前窗口占用', 'zh-TW': '目前視窗佔用', en: 'Active Window Usage' },
  'session.badge.reading': { 'zh-CN': '读取中', 'zh-TW': '讀取中', en: 'Loading' },
  'session.stat.used': { 'zh-CN': '当前已用', 'zh-TW': '目前已用', en: 'Used' },
  'session.stat.limit': { 'zh-CN': '预算上限', 'zh-TW': '預算上限', en: 'Budget Limit' },
  'session.stat.remaining': { 'zh-CN': '剩余可用', 'zh-TW': '剩餘可用', en: 'Remaining' },
  'session.keyTakeaway.loading': { 'zh-CN': '正在计算核心指标…', 'zh-TW': '正在計算核心指標…', en: 'Calculating key metrics…' },
  'session.speed.pending': { 'zh-CN': '待生成', 'zh-TW': '待生成', en: 'Idle' },
  'session.speed.duration': { 'zh-CN': '生成耗时', 'zh-TW': '生成耗時', en: 'Duration' },
  'session.speed.ttft': { 'zh-CN': '首字延迟', 'zh-TW': '首字延遲', en: 'TTFT' },
  'session.speed.tokens': { 'zh-CN': '本次输出', 'zh-TW': '本次輸出', en: 'Output' },
  'session.speed.wait': { 'zh-CN': '等待首次模型输出产生速度统计…', 'zh-TW': '等待首次模型輸出產生速度統計…', en: 'Waiting for the first model response…' },
  'session.techDrawer.title': { 'zh-CN': '底层技术参数与附件审计', 'zh-TW': '底層技術參數與附件審計', en: 'Technical & Attachment Audit' },
  'session.techDrawer.expand': { 'zh-CN': '▼ 点击展开明细', 'zh-TW': '▼ 點擊展開明細', en: '▼ Show details' },
  'session.techDrawer.collapse': { 'zh-CN': '▲ 点击收起明细', 'zh-TW': '▲ 點擊收起明細', en: '▲ Hide details' },
  'session.tech.checking': { 'zh-CN': '正在核对请求和附件…', 'zh-TW': '正在核對請求與附件…', en: 'Checking requests and attachments…' },
  'session.tech.latestReq': { 'zh-CN': '最近一次请求', 'zh-TW': '最近一次請求', en: 'Latest Request' },
  'session.tech.reqStatus': { 'zh-CN': '请求状态', 'zh-TW': '請求狀態', en: 'Status' },
  'session.tech.actual': { 'zh-CN': '实返输入＋输出', 'zh-TW': '實返輸入＋輸出', en: 'Reported in + out' },
  'session.tech.estimate': { 'zh-CN': '客户端估算', 'zh-TW': '用戶端估算', en: 'Client estimate' },
  'session.tech.budget': { 'zh-CN': '客户端预算', 'zh-TW': '用戶端預算', en: 'Client budget' },
  'session.tech.serviceLimit': { 'zh-CN': '服务端报错上限', 'zh-TW': '伺服器端報錯上限', en: 'Server error limit' },
  'session.tech.percent': { 'zh-CN': '预算占比', 'zh-TW': '預算佔比', en: 'Budget share' },
  'session.tech.sessionHeading': { 'zh-CN': '会话累计内容 · 本地估算', 'zh-TW': '對話累計內容 · 本機估算', en: 'Session Content · Local Est.' },
  'session.tech.sessionTotal': { 'zh-CN': '可读文本估算', 'zh-TW': '可讀文字估算', en: 'Readable text est.' },
  'session.tech.scanning': { 'zh-CN': '扫描中…', 'zh-TW': '掃描中…', en: 'Scanning…' },
  'session.tech.characters': { 'zh-CN': '读取字符数', 'zh-TW': '讀取字元數', en: 'Characters read' },
  'session.tech.user': { 'zh-CN': '用户消息', 'zh-TW': '使用者訊息', en: 'User messages' },
  'session.tech.assistant': { 'zh-CN': '模型回复', 'zh-TW': '模型回覆', en: 'Assistant replies' },
  'session.tech.thinking': { 'zh-CN': '思考内容', 'zh-TW': '思考內容', en: 'Thinking' },
  'session.tech.tools': { 'zh-CN': '工具调用与输出', 'zh-TW': '工具呼叫與輸出', en: 'Tools & outputs' },
  'session.tech.summaries': { 'zh-CN': '压缩摘要', 'zh-TW': '壓縮摘要', en: 'Summaries' },
  'session.tech.system': { 'zh-CN': '系统提示与工具', 'zh-TW': '系統提示與工具', en: 'System & tools' },
  'session.tech.attachments': { 'zh-CN': '附件文本', 'zh-TW': '附件文字', en: 'Attachment text' },
  'session.tech.steps': { 'zh-CN': '步骤完整性', 'zh-TW': '步驟完整性', en: 'Step coverage' },
  'session.tech.filesHeading': { 'zh-CN': '附件逐项检查', 'zh-TW': '附件逐項檢查', en: 'Attachment Inspection' },
  'session.tech.rescan': { 'zh-CN': '重新扫描会话与附件', 'zh-TW': '重新掃描對話與附件', en: 'Rescan session & files' },
  'session.tech.note': { 'zh-CN': '会话累计文本与附件 Token 为本地估算。', 'zh-TW': '工作階段累計文字與附件 Token 為本機估算。', en: 'Session text and attachment tokens are local estimates.' },
  'models.list.aria': { 'zh-CN': '按厂商分组的模型产品列表', 'zh-TW': '依廠商分組的模型產品清單', en: 'Models grouped by vendor' },
  'models.list.empty': { 'zh-CN': '暂无已知模型，发一条消息或等待模型列表加载后显示。', 'zh-TW': '暫無已知模型，發送一則訊息或等待模型清單載入後顯示。', en: 'No models detected yet. Send a message or wait for the model list to load.' },
  'models.restartConfirm.text': { 'zh-CN': '重启会中断正在运行的任务。请先保存未保存的内容。', 'zh-TW': '重新啟動會中斷正在執行的任務。請先儲存未儲存的內容。', en: 'Restarting will interrupt active tasks. Please save any unsaved work first.' },
  'models.restartConfirm.cancel': { 'zh-CN': '取消', 'zh-TW': '取消', en: 'Cancel' },
  'models.restartConfirm.go': { 'zh-CN': '重启', 'zh-TW': '重新啟動', en: 'Restart' },
  'models.restart.restarting': { 'zh-CN': '正在重启客户端…', 'zh-TW': '正在重新啟動用戶端…', en: 'Restarting client…' },
  'models.restart.notExited': { 'zh-CN': '客户端没有退出，可能被取消或正在等待。请手动重启。', 'zh-TW': '用戶端沒有結束，可能被取消或正在等待。請手動重新啟動。', en: 'The client did not exit (cancelled or busy). Please restart manually.' },
  'models.card.waiting': { 'zh-CN': '等待读取模型…', 'zh-TW': '等待讀取模型…', en: 'Waiting for model…' },
  'models.card.effortsEmpty': { 'zh-CN': '可用档位：—', 'zh-TW': '可用檔位：—', en: 'Efforts: —' },
  'models.card.sessionEffort': { 'zh-CN': '当前会话：{effort}', 'zh-TW': '目前會話：{effort}', en: 'Session: {effort}' },
  'models.card.modelUnavailable': { 'zh-CN': '不可用', 'zh-TW': '不可用', en: 'Unavailable' },
  'models.card.observedBudget': { 'zh-CN': '实测预算', 'zh-TW': '實測預算', en: 'Observed Budget' },
  'models.card.observedBudgetNone': { 'zh-CN': '尚未观测', 'zh-TW': '尚未觀測', en: 'Not observed yet' },
  'models.card.observedBudgetSide': { 'zh-CN': '对话中实际分配', 'zh-TW': '對話中實際分配', en: 'Allocated in live turns' },
  'models.card.observedSpeed': { 'zh-CN': '实测速度', 'zh-TW': '實測速度', en: 'Observed Speed' },
  'models.card.observedSpeedNone': { 'zh-CN': '暂无实测数据', 'zh-TW': '暫無實測資料', en: 'No speed data yet' },
  'models.card.gotoSpeed': { 'zh-CN': '查看速度对比 ›', 'zh-TW': '檢視速度對比 ›', en: 'Compare speed ›' },
  'models.cap.window': { 'zh-CN': '模型总窗口', 'zh-TW': '模型總視窗', en: 'Context Window' },
  'models.cap.output': { 'zh-CN': '最大输出', 'zh-TW': '最大輸出', en: 'Max Output' },
  'models.cap.modelMax': { 'zh-CN': '理论输入上限', 'zh-TW': '理論輸入上限', en: 'Input Cap' },
  'models.cap.formulaLbl': { 'zh-CN': '来源与计算说明', 'zh-TW': '來源與計算說明', en: 'Source & Formula' },
  'models.card.tierCaps': { 'zh-CN': '档位能力', 'zh-TW': '檔位能力', en: 'Tier Capabilities' },
  'msg.unknownErr': { 'zh-CN': '未知错误', 'zh-TW': '未知錯誤', en: 'Unknown error' },
  'speed.range.aria': { 'zh-CN': '时间范围', 'zh-TW': '時間範圍', en: 'Time range' },
  'speed.range.7d': { 'zh-CN': '近 7 天', 'zh-TW': '近 7 天', en: '7D' },
  'speed.range.30d': { 'zh-CN': '近 30 天', 'zh-TW': '近 30 天', en: '30D' },
  'speed.range.all': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
  'speed.origin.aria': { 'zh-CN': '样本来源', 'zh-TW': '樣本來源', en: 'Sample origin' },
  'speed.origin.all': { 'zh-CN': '全部来源', 'zh-TW': '全部來源', en: 'All sources' },
  'speed.origin.chat': { 'zh-CN': '日常对话', 'zh-TW': '日常對話', en: 'Chat' },
  'speed.metric.aria': { 'zh-CN': '对比指标', 'zh-TW': '對比指標', en: 'Metric' },
  'speed.metric.tps': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Speed' },
  'speed.metric.ttft': { 'zh-CN': '首字延迟', 'zh-TW': '首字延遲', en: 'TTFT' },
  'speed.metric.duration': { 'zh-CN': '总耗时', 'zh-TW': '總耗時', en: 'Duration' },
  'speed.barTitle.tps': { 'zh-CN': '输出速度对比', 'zh-TW': '輸出速度對比', en: 'Output Speed Comparison' },
  'speed.barTitle.ttft': { 'zh-CN': '首字延迟对比', 'zh-TW': '首字延遲對比', en: 'First-Token Latency (TTFT)' },
  'speed.barTitle.duration': { 'zh-CN': '总耗时对比', 'zh-TW': '總耗時對比', en: 'Total Duration Comparison' },
  'speed.empty': { 'zh-CN': '还没有可用的速度记录。正常对话后会自动积累。', 'zh-TW': '還沒有可用的速度記錄。正常對話後會自動累積。', en: 'No speed samples yet. Samples are recorded automatically during normal chats.' },
  'speed.barNote': { 'zh-CN': '按中位数统计 · 不足 3 条标为样本少', 'zh-TW': '依中位數統計 · 不足 3 筆標為樣本少', en: 'Median per model · <3 samples marked Low n' },
  'speed.viewMode.bar': { 'zh-CN': '模型对比', 'zh-TW': '模型對比', en: 'Comparison' },
  'speed.viewMode.line': { 'zh-CN': '单模型趋势', 'zh-TW': '單模型趨勢', en: 'Model Trend' },
  'speed.lineTitle': { 'zh-CN': '单模型速度趋势', 'zh-TW': '單模型速度趨勢', en: 'Model Speed Trend' },
  'speed.linePickTitle': { 'zh-CN': '选择一个模型与档位查看速度变化', 'zh-TW': '選擇一個模型與檔位檢視速度變化', en: 'Select a model & effort to view speed trend' },
  'speed.lineNoModel': { 'zh-CN': '暂无模型记录', 'zh-TW': '暫無模型記錄', en: 'No model records' },
  'speed.lowSample': { 'zh-CN': '样本少', 'zh-TW': '樣本少', en: 'Low n' },
  'speed.samples': { 'zh-CN': '{n} 条', 'zh-TW': '{n} 筆', en: '{n} samples' },
  'settings.panelLang.aria': { 'zh-CN': '插件面板语言', 'zh-TW': '外掛面板語言', en: 'Panel language' },
  'settings.panelLang.saved': { 'zh-CN': '已切换并保存', 'zh-TW': '已切換並儲存', en: 'Saved' },
  'settings.panelLang.saveLocal': { 'zh-CN': '已切换（仅本地生效）', 'zh-TW': '已切換（僅本機生效）', en: 'Applied locally' },
  'dropdown.searchPlaceholder': { 'zh-CN': '搜索...', 'zh-TW': '搜尋...', en: 'Search...' },
  'dropdown.empty': { 'zh-CN': '未找到匹配项', 'zh-TW': '找不到相符項目', en: 'No matching items' },
  'dropdown.modelSearch': { 'zh-CN': '搜索模型或厂商…', 'zh-TW': '搜尋模型或廠商…', en: 'Search model or vendor…' },
  'dropdown.modelEmpty': { 'zh-CN': '未找到匹配的模型', 'zh-TW': '找不到符合的模型', en: 'No matching models' },
  'dropdown.speedSearch': { 'zh-CN': '搜索模型或档位…', 'zh-TW': '搜尋模型或檔位…', en: 'Search model or effort…' },
  'dropdown.speedEmpty': { 'zh-CN': '未找到匹配的模型记录', 'zh-TW': '找不到符合的模型記錄', en: 'No matching speed records' },
  'tokens.sourceLabel': { 'zh-CN': '来源:', 'zh-TW': '來源:', en: 'Source:' },
  'tokens.src.all': { 'zh-CN': '全部', 'zh-TW': '全部', en: 'All' },
  'tokens.src.desktop': { 'zh-CN': '桌面端', 'zh-TW': '桌面端', en: 'Desktop' },
  'tokens.src.cli': { 'zh-CN': 'CLI', 'zh-TW': 'CLI', en: 'CLI' },
  'tokens.view.tokens': { 'zh-CN': 'Token 统计', 'zh-TW': 'Token 統計', en: 'Token Stats' },
  'tokens.view.models': { 'zh-CN': '按模型', 'zh-TW': '依模型', en: 'By Model' },
  'tokens.view.cost': { 'zh-CN': 'API 参考金额', 'zh-TW': 'API 參考金額', en: 'API Est. Cost' },
  'modelsUsage.title': { 'zh-CN': '按模型 Token 用量', 'zh-TW': '依模型 Token 用量', en: 'Usage history' },
  'modelsUsage.subtitle': { 'zh-CN': '查看桌面端与 CLI 各模型每日 Token 消耗及占比分布。', 'zh-TW': '檢視桌面端與 CLI 各模型每日 Token 消耗及佔比分布。', en: 'Daily token consumption and share by model across Desktop and CLI.' },
  'modelsUsage.groupModel': { 'zh-CN': '按模型', 'zh-TW': '依模型', en: 'By model' },
  'modelsUsage.groupVariant': { 'zh-CN': '按档位', 'zh-TW': '依檔位', en: 'By variant' },
  'modelsUsage.metricTotal': { 'zh-CN': '含缓存', 'zh-TW': '含快取', en: 'All tokens' },
  'modelsUsage.metricNoCache': { 'zh-CN': '不含缓存', 'zh-TW': '不含快取', en: 'Excl. cache' },
  'modelsUsage.hideUnattr': { 'zh-CN': '隐藏未标明', 'zh-TW': '隱藏未標明', en: 'Hide unattributed' },
  'modelsUsage.showUnattr': { 'zh-CN': '仅已标明 ✓', 'zh-TW': '僅已標明 ✓', en: 'Attributed only ✓' },
  'modelsUsage.unattributed': { 'zh-CN': '未标明模型', 'zh-TW': '未標明模型', en: 'Unattributed' },
  'modelsUsage.prevTitle': { 'zh-CN': '查看更早时间段', 'zh-TW': '檢視更早時段', en: 'Previous period' },
  'modelsUsage.nextTitle': { 'zh-CN': '查看更新时间段', 'zh-TW': '檢視更新時段', en: 'Next period' },
  'modelsUsage.empty': { 'zh-CN': '当前时间窗暂无 Token 用量记录', 'zh-TW': '目前時間窗尚無 Token 用量紀錄', en: 'No token usage recorded in this period' },
  'modelsUsage.stepsSuffix': { 'zh-CN': '{n} 次', 'zh-TW': '{n} 次', en: '{n} reqs' },
  'tokens.card.total': { 'zh-CN': '累计用量', 'zh-TW': '累計用量', en: 'Total' },
  'tokens.card.includeCache': { 'zh-CN': '含缓存', 'zh-TW': '含快取', en: 'Incl. cache' },
  'tokens.card.today': { 'zh-CN': '今日使用', 'zh-TW': '今日使用', en: 'Today' },
  'tokens.card.month': { 'zh-CN': '本月使用', 'zh-TW': '本月使用', en: 'This Month' },
  'tokens.card.year': { 'zh-CN': '年度使用', 'zh-TW': '年度使用', en: 'This Year' },
  'tokens.cache.uncachedInput': { 'zh-CN': '未缓存输入', 'zh-TW': '未快取輸入', en: 'Uncached In' },
  'tokens.cache.cacheRead': { 'zh-CN': '缓存读取', 'zh-TW': '快取讀取', en: 'Cache Read' },
  'tokens.cache.totalInput': { 'zh-CN': '总输入', 'zh-TW': '總輸入', en: 'Total In' },
  'tokens.cache.output': { 'zh-CN': '输出', 'zh-TW': '輸出', en: 'Output' },
  'tokens.cache.ratio': { 'zh-CN': '缓存占比', 'zh-TW': '快取佔比', en: 'Cache Ratio' },
  'tokens.cache.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'tokens.cache.na': { 'zh-CN': '不适用', 'zh-TW': '不適用', en: 'N/A' },
  'tokens.cache.partialNote': { 'zh-CN': '已排除 {n} 条缺失细分的旧记录', 'zh-TW': '已排除 {n} 筆缺少細分的舊記錄', en: 'Excludes {n} legacy record(s) without split' },
  'tokens.cache.weightedNote': { 'zh-CN': '', 'zh-TW': '', en: '' },
  'tokens.cache.missingNote': { 'zh-CN': '缺少缓存细分字段', 'zh-TW': '缺少快取細分欄位', en: 'Cache split unavailable' },
  'tokens.cache.zeroInputNote': { 'zh-CN': '总输入为 0', 'zh-TW': '總輸入為 0', en: 'Total input is 0' },
  'session.speedSummary.titleNoBolt': { 'zh-CN': '最新响应速度', 'zh-TW': '最新回應速度', en: 'Latest Response Speed' },
  'session.speed.streamRate': { 'zh-CN': '纯流式速度', 'zh-TW': '純流式速度', en: 'Stream Speed' },
  'session.speed.shortSampleBadge': { 'zh-CN': '短样本', 'zh-TW': '短樣本', en: 'Short sample' },
  'session.speed.shortWindowEst': { 'zh-CN': '短窗口估算 (参考)', 'zh-TW': '短視窗估算 (參考)', en: 'Short-Window Est. (Ref)' },
  'session.speed.shortWindowNote': { 'zh-CN': '输出较短，未计入主速度', 'zh-TW': '輸出較短，未計入主速度', en: 'Short output; excluded from headline speed' },
  'session.speed.details': { 'zh-CN': '拆解', 'zh-TW': '拆解', en: 'Details' },
  'session.speed.hideDetails': { 'zh-CN': '收起', 'zh-TW': '收起', en: 'Hide' },
  'session.speed.breakdown.eScore': { 'zh-CN': '综合效率评分', 'zh-TW': '綜合效率評分', en: 'Efficiency E' },
  'session.speed.breakdown.ttft': { 'zh-CN': '首字延迟档位', 'zh-TW': '首字延遲檔位', en: 'TTFT Tier' },
  'session.speed.breakdown.stream': { 'zh-CN': '纯流式速度档位', 'zh-TW': '純流式速度檔位', en: 'Stream Speed Tier' },
  'session.speed.breakdown.overall': { 'zh-CN': '整体平均速率 (对照)', 'zh-TW': '整體平均速率 (對照)', en: 'Overall Avg (Ref)' },
  'session.speed.breakdown.duration': { 'zh-CN': '总生成耗时档位', 'zh-TW': '總生成耗時檔位', en: 'Total Duration Tier' },
  'session.speed.breakdown.stability': { 'zh-CN': '流式稳定性评估', 'zh-TW': '流式穩定性評估', en: 'Stream Stability' },
  'session.speed.breakdown.basis': { 'zh-CN': '体量调节依据', 'zh-TW': '體量調節依據', en: 'Scale Basis' },
  'session.speed.stabilityOk': { 'zh-CN': '输出平稳 ({n} 块 · CV {cv})', 'zh-TW': '輸出平穩 ({n} 塊 · CV {cv})', en: 'Steady ({n} chunks · CV {cv})' },
  'session.speed.stabilityHighVar': { 'zh-CN': '波动较大 ({n} 块 · CV {cv})', 'zh-TW': '波動較大 ({n} 塊 · CV {cv})', en: 'High variance ({n} chunks · CV {cv})' },
  'session.speed.stabilityUnverified': { 'zh-CN': '样本不足', 'zh-TW': '樣本不足', en: 'Insufficient samples' },
  'session.speed.scoreSkippedSparse': { 'zh-CN': '样本不足', 'zh-TW': '樣本不足', en: 'Low sample' },
  'session.speed.scoreSkippedMissing': { 'zh-CN': '数据不足', 'zh-TW': '資料不足', en: 'Missing data' },
  'session.speed.mockTag': { 'zh-CN': '模拟验收', 'zh-TW': '模擬驗收', en: 'Mock Verification' },
  'session.latestCall.unknownMappedModel': { 'zh-CN': '未知模型 (无映射 · 原始 {id})', 'zh-TW': '未知模型 (無對映 · 原始 {id})', en: 'Unknown Model (Unmapped · {id})' },
  'session.latestCall.rawIdNote': { 'zh-CN': '原始 ID: {id}', 'zh-TW': '原始 ID: {id}', en: 'Raw ID: {id}' },
  'session.latestCall.title': { 'zh-CN': '最新调用', 'zh-TW': '最新呼叫', en: 'Latest Call' },
  'session.latestCall.newAvailable': { 'zh-CN': '有新调用完成 · 点击查看最新', 'zh-TW': '有新呼叫完成 · 點擊檢視最新', en: 'New call available · Click to view latest' },
  'session.latestCall.statusSuccess': { 'zh-CN': '成功', 'zh-TW': '成功', en: 'Done' },
  'session.latestCall.statusStreaming': { 'zh-CN': '生成中', 'zh-TW': '產生中', en: 'Streaming' },
  'session.latestCall.statusCanceled': { 'zh-CN': '已取消', 'zh-TW': '已取消', en: 'Canceled' },
  'session.latestCall.statusFailed': { 'zh-CN': '失败', 'zh-TW': '失敗', en: 'Failed' },
  'session.latestCall.statusUnknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'session.latestCall.agentMain': { 'zh-CN': '主代理', 'zh-TW': '主代理', en: 'Main' },
  'session.latestCall.agentSub': { 'zh-CN': '子代理', 'zh-TW': '子代理', en: 'Subagent' },
  'session.latestCall.agentUnknown': { 'zh-CN': '未知归属', 'zh-TW': '未知歸屬', en: 'Unattributed' },
  'session.latestCall.inlineTokens': { 'zh-CN': '入 {inp} · 出 {out}', 'zh-TW': '入 {inp} · 出 {out}', en: 'In {inp} · Out {out}' },
  'session.latestCall.inlineTokensTip': { 'zh-CN': '总输入 {total}（未缓存 {uncached} + 缓存读取 {cache}）· 输出 {out}', 'zh-TW': '總輸入 {total}（未快取 {uncached} + 快取讀取 {cache}）· 輸出 {out}', en: 'Total In {total} (Uncached {uncached} + Cache {cache}) · Out {out}' },
  'session.latestCall.inlineCache': { 'zh-CN': '缓存 {val}', 'zh-TW': '快取 {val}', en: 'Cache {val}' },
  'session.latestCall.inlineCacheTip': { 'zh-CN': '缓存读取 {cache} / 总输入 {total} = {pct}', 'zh-TW': '快取讀取 {cache} / 總輸入 {total} = {pct}', en: 'Cache Read {cache} / Total In {total} = {pct}' },
  'session.latestCall.fieldTime': { 'zh-CN': '调用时间', 'zh-TW': '呼叫時間', en: 'Call Time' },
  'session.latestCall.fieldModelId': { 'zh-CN': '稳定模型标识', 'zh-TW': '穩定模型識別碼', en: 'Model ID' },
  'session.latestCall.fieldModelLabel': { 'zh-CN': '展示名与档位', 'zh-TW': '顯示名稱與檔位', en: 'Display & Effort' },
  'session.latestCall.fieldInput': { 'zh-CN': '输入 (未缓存)', 'zh-TW': '輸入 (未快取)', en: 'Input (Uncached)' },
  'session.latestCall.fieldCacheRead': { 'zh-CN': '缓存读取', 'zh-TW': '快取讀取', en: 'Cache Read' },
  'session.latestCall.fieldTotalInput': { 'zh-CN': '总输入 (输入+缓存)', 'zh-TW': '總輸入 (輸入+快取)', en: 'Total Input' },
  'session.latestCall.fieldOutput': { 'zh-CN': '输出 (含思考)', 'zh-TW': '輸出 (含思考)', en: 'Output (incl. think)' },
  'session.latestCall.fieldCacheRatio': { 'zh-CN': '缓存读取占比', 'zh-TW': '快取讀取佔比', en: 'Cache Read Ratio' },
  'session.latestCall.fieldTtft': { 'zh-CN': '首字延迟', 'zh-TW': '首字延遲', en: 'TTFT' },
  'session.latestCall.fieldDuration': { 'zh-CN': '总耗时', 'zh-TW': '總耗時', en: 'Duration' },
  'session.latestCall.fieldAgent': { 'zh-CN': '代理归属', 'zh-TW': '代理歸屬', en: 'Agent Attribution' },
  'session.latestCall.fieldStatus': { 'zh-CN': '调用状态', 'zh-TW': '呼叫狀態', en: 'Status' },
  'session.latestCall.unknownVal': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'session.latestCall.naVal': { 'zh-CN': '不适用', 'zh-TW': '不適用', en: 'N/A' },
  'session.timeline.viewHistory': { 'zh-CN': '查看历史', 'zh-TW': '檢視歷史', en: 'History' },
  'session.timeline.hideHistory': { 'zh-CN': '收起历史', 'zh-TW': '收合歷史', en: 'Hide History' },
  'session.timeline.loading': { 'zh-CN': '正在读取当前会话请求时间线…', 'zh-TW': '正在讀取目前工作階段請求時間線…', en: 'Loading session timeline…' },
  'session.timeline.empty': { 'zh-CN': '当前会话暂无可展示的历史请求记录。', 'zh-TW': '目前工作階段尚無可顯示的歷史請求紀錄。', en: 'No recorded calls found in this session yet.' },
  'session.timeline.loadMore': { 'zh-CN': '加载更早轮次 ({n})', 'zh-TW': '載入更早輪次 ({n})', en: 'Load earlier turns ({n})' },
  'session.timeline.summary': { 'zh-CN': '{turns} 轮 · {calls} 次调用（主 {main} / 子 {sub}） · 会话缓存占比 {cache}', 'zh-TW': '{turns} 輪 · {calls} 次呼叫（主 {main} / 子 {sub}） · 工作階段快取佔比 {cache}', en: '{turns} turn(s) · {calls} call(s) (main {main} / sub {sub}) · Session cache {cache}' },
  'session.timeline.turnLabel': { 'zh-CN': '第 {n} 轮', 'zh-TW': '第 {n} 輪', en: 'Turn {n}' },
  'session.timeline.turnNoPrompt': { 'zh-CN': '（用户轮次记录）', 'zh-TW': '（使用者輪次紀錄）', en: '(User turn)' },
  'session.timeline.turnSummary': { 'zh-CN': '{calls} 次 · 入 {inp} / 缓 {cap} / 出 {out}', 'zh-TW': '{calls} 次 · 入 {inp} / 快 {cap} / 出 {out}', en: '{calls} · In {inp} / Cache {cap} / Out {out}' },
  'session.timeline.unlinkedTitle': { 'zh-CN': '未归属到具体轮次的调用 / 子代理 ({n})', 'zh-TW': '未歸屬至具體輪次的呼叫 / 子代理 ({n})', en: 'Unlinked / Unattributed Calls ({n})' },
  'tokens.heat.title': { 'zh-CN': 'Token 活动', 'zh-TW': 'Token 活動', en: 'Token Activity' },
  'tokens.heat.daily': { 'zh-CN': '每天', 'zh-TW': '每天', en: 'Daily' },
  'tokens.heat.weekly': { 'zh-CN': '每周', 'zh-TW': '每週', en: 'Weekly' },
  'tokens.heat.monthly': { 'zh-CN': '每月', 'zh-TW': '每月', en: 'Monthly' },
  'tokens.heat.yearly': { 'zh-CN': '今年', 'zh-TW': '今年', en: 'Year' },
  'tokens.heat.cum': { 'zh-CN': '累计总量', 'zh-TW': '累計總量', en: 'Cumulative' },
  'tokens.heat.sumTokens': { 'zh-CN': '区间合计:', 'zh-TW': '區間合計:', en: 'Range total:' },
  'tokens.heat.sumCost': { 'zh-CN': '预估费用:', 'zh-TW': '預估費用:', en: 'Est. cost:' },
  'tokens.heat.sumDailyAvg': { 'zh-CN': '折合每天:', 'zh-TW': '折合每天:', en: 'Daily avg:' },
  'tokens.heat.sumActiveAvg': { 'zh-CN': '活跃日均:', 'zh-TW': '活躍日均:', en: 'Active avg:' },
  'tokens.heat.sumSubRatio': { 'zh-CN': '订阅性价比:', 'zh-TW': '訂閱性價比:', en: 'Plan value:' },
  'tokens.heat.disclaimer': { 'zh-CN': '优先按逐请求明细入账', 'zh-TW': '優先依逐請求明細入帳', en: 'Uses per-request ledger when available' },
  'tokens.heat.tip': { 'zh-CN': '悬浮或点击查看详情', 'zh-TW': '懸停或點擊檢視詳情', en: 'Hover or click for details' },
  'tokens.heat.less': { 'zh-CN': '少', 'zh-TW': '少', en: 'Less' },
  'tokens.heat.more': { 'zh-CN': '多', 'zh-TW': '多', en: 'More' },
  'colors.btn.restore': { 'zh-CN': '恢复', 'zh-TW': '還原', en: 'Reset' },
  'theme.light': { 'zh-CN': '浅色', 'zh-TW': '淺色', en: 'Light' },
  'theme.dark': { 'zh-CN': '深色', 'zh-TW': '深色', en: 'Dark' },
  'theme.autoTitle': { 'zh-CN': '当前主题：跟随宿主 ({mode})\n点击切换为：浅色模式', 'zh-TW': '目前主題：跟隨宿主 ({mode})\n點擊切換為：淺色模式', en: 'Theme: Follow IDE ({mode})\nClick to switch to Light' },
  'theme.lightTitle': { 'zh-CN': '当前主题：浅色模式 (固定)\n点击切换为：深色模式', 'zh-TW': '目前主題：淺色模式 (固定)\n點擊切換為：深色模式', en: 'Theme: Light (Fixed)\nClick to switch to Dark' },
  'theme.darkTitle': { 'zh-CN': '当前主题：深色模式 (固定)\n点击切换为：跟随宿主', 'zh-TW': '目前主題：深色模式 (固定)\n點擊切換為：跟隨宿主', en: 'Theme: Dark (Fixed)\nClick to switch to Follow IDE' },
  'cost.streamingEst': { 'zh-CN': '生成中暂估', 'zh-TW': '生成中暫估', en: 'Streaming est.' },
  'cost.returnedEst': { 'zh-CN': '按已返回用量估算', 'zh-TW': '依已回應用量估算', en: 'Based on returned usage' },
  'cost.latestTurn': { 'zh-CN': '最近调用 {val} · {label}', 'zh-TW': '最近呼叫 {val} · {label}', en: 'Latest turn {val} · {label}' },
  'cost.unpriced': { 'zh-CN': '暂无法估值', 'zh-TW': '暫無法估值', en: 'Unpriced' },
  'cost.turnUnpriced': { 'zh-CN': '本轮模型未计价', 'zh-TW': '本輪模型未計價', en: 'Turn unpriced' },
  'cost.latestDash': { 'zh-CN': '最近调用估值：—', 'zh-TW': '最近呼叫估值：—', en: 'Latest turn: —' },
  'cost.sessionTotal': { 'zh-CN': '当前会话合计约 ${val}', 'zh-TW': '目前工作階段合計約 ${val}', en: 'Session total ≈ ${val}' },
  'cost.sessionPricedTotal': { 'zh-CN': '已计价合计约 ${val}', 'zh-TW': '已計價合計約 ${val}', en: 'Priced total ≈ ${val}' },
  'cost.modelTip': { 'zh-CN': '模型：{model}\n输入：{input} tok\n缓存：{cache} tok\n输出：{output} tok\n参考金额：${cost}', 'zh-TW': '模型：{model}\n輸入：{input} tok\n快取：{cache} tok\n輸出：{output} tok\n參考金額：${cost}', en: 'Model: {model}\nInput: {input} tok\nCache: {cache} tok\nOutput: {output} tok\nEst. cost: ${cost}' },
  'cost.unpricedTip': { 'zh-CN': '模型：{model}（公开费率未收录）', 'zh-TW': '模型：{model}（公開費率未收錄）', en: 'Model: {model} (public rate unavailable)' },
  'cost.missingModel': { 'zh-CN': '缺少模型信息', 'zh-TW': '缺少模型資訊', en: 'Missing model info' },
  'models.list.currentTag': { 'zh-CN': '当前', 'zh-TW': '目前', en: 'Current' },
  'models.card.serviceLimit': { 'zh-CN': '服务端报错上限：{val}', 'zh-TW': '伺服器端報錯上限：{val}', en: 'Server error limit: {val}' },
  'models.card.observedTitle': { 'zh-CN': '实际分配预算：{val} tokens', 'zh-TW': '實際分配預算：{val} tokens', en: 'Allocated budget: {val} tokens' },
  'models.card.serviceLimitTitle': { 'zh-CN': '服务端报错上限：{val} tokens', 'zh-TW': '伺服器端報錯上限：{val} tokens', en: 'Server error limit: {val} tokens' },
  'models.card.speedLineText': { 'zh-CN': '{prefix}{tps} tokens/秒 · 近 {count} 次中位数{low}{ts}', 'zh-TW': '{prefix}{tps} tokens/秒 · 近 {count} 次中位數{low}{ts}', en: '{prefix}{tps} tok/s · median of {count}{low}{ts}' },
  'models.card.lowSampleParen': { 'zh-CN': '（样本少）', 'zh-TW': '（樣本少）', en: ' (low n)' },
  'models.dropdown.empty': { 'zh-CN': '暂无已知模型', 'zh-TW': '暫無已知模型', en: 'No models yet' },
  'speed.unitSec': { 'zh-CN': '{val} 秒', 'zh-TW': '{val} 秒', en: '{val} s' },
  'speed.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'speed.originProbe': { 'zh-CN': '主动测试', 'zh-TW': '主動測試', en: 'Probe' },
  'speed.tip.samples': { 'zh-CN': '样本数：{n}{low}', 'zh-TW': '樣本數：{n}{low}', en: 'Samples: {n}{low}' },
  'speed.tip.timeRange': { 'zh-CN': '时间范围：{range}', 'zh-TW': '時間範圍：{range}', en: 'Range: {range}' },
  'speed.tip.medOut': { 'zh-CN': '输出 tokens 中位数：{val}', 'zh-TW': '輸出 tokens 中位數：{val}', en: 'Median output tokens: {val}' },
  'speed.tip.medIn': { 'zh-CN': '输入 tokens 中位数：{val}', 'zh-TW': '輸入 tokens 中位數：{val}', en: 'Median input tokens: {val}' },
  'speed.tip.time': { 'zh-CN': '时间：{val}', 'zh-TW': '時間：{val}', en: 'Time: {val}' },
  'speed.tip.output': { 'zh-CN': '输出：{val} tokens', 'zh-TW': '輸出：{val} tokens', en: 'Output: {val} tokens' },
  'speed.tip.ttft': { 'zh-CN': '首字延迟：{val}', 'zh-TW': '首字延遲：{val}', en: 'TTFT: {val}' },
  'speed.tip.origin': { 'zh-CN': '来源：{val}', 'zh-TW': '來源：{val}', en: 'Source: {val}' },
  'speed.tip.tpsLine': { 'zh-CN': '#{idx} · {tps} tokens/秒', 'zh-TW': '#{idx} · {tps} tokens/秒', en: '#{idx} · {tps} tok/s' },
  'tip.title.normal': { 'zh-CN': '上下文窗口：', 'zh-TW': 'Context 視窗：', en: 'Context window:' },
  'tip.title.stale': { 'zh-CN': '上下文窗口（数据过期）：', 'zh-TW': '上下文視窗（資料過期）：', en: 'Context window (stale):' },
  'tip.title.high90': { 'zh-CN': '上下文窗口（高占用告警）：', 'zh-TW': '上下文視窗（高佔用警示）：', en: 'Context window (high usage):' },
  'tip.title.high75': { 'zh-CN': '上下文窗口（占用偏高）：', 'zh-TW': '上下文視窗（佔用偏高）：', en: 'Context window (elevated):' },
  'tip.title.est': { 'zh-CN': '上下文窗口（本地估算）：', 'zh-TW': '上下文視窗（本機估算）：', en: 'Context window (local est.):' },
  'tip.pct.staleVal': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 统计延迟）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 統計延遲）', en: '{used}% used ({rem}% left · delayed)' },
  'tip.pct.staleUnknown': { 'zh-CN': '统计读取延迟（剩余未知）', 'zh-TW': '統計讀取延遲（剩餘未知）', en: 'Stats delayed (remaining unknown)' },
  'tip.pct.high90': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 接近上限）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 接近上限）', en: '{used}% used ({rem}% left · near limit)' },
  'tip.pct.high75': { 'zh-CN': '{used}% 已用（剩余 {rem}% · 占用偏高）', 'zh-TW': '{used}% 已用（剩餘 {rem}% · 佔用偏高）', en: '{used}% used ({rem}% left · elevated)' },
  'tip.pct.normal': { 'zh-CN': '{used}% 已用（剩余 {rem}%）', 'zh-TW': '{used}% 已用（剩餘 {rem}%）', en: '{used}% used ({rem}% left)' },
  'tip.pct.noBudget': { 'zh-CN': '容量未知（未返回上限）', 'zh-TW': '容量未知（未回傳上限）', en: 'Limit unknown (not returned)' },
  'tip.pct.estOnly': { 'zh-CN': '真实占比未知（仅估算）', 'zh-TW': '真實佔比未知（僅估算）', en: 'Actual % unknown (estimate only)' },
  'tip.pct.waitStats': { 'zh-CN': '等待请求统计（仅归档估算）', 'zh-TW': '等待請求統計（僅封存估算）', en: 'Waiting for stats (archive est.)' },
  'tip.pct.noSession': { 'zh-CN': '新会话 · 尚未开始', 'zh-TW': '新對話 · 尚未開始', en: 'New session · Not started' },
  'tip.pct.emptySession': { 'zh-CN': '空会话 · 尚未发送消息', 'zh-TW': '空對話 · 尚未發送訊息', en: 'Empty session · No turns yet' },
  'tip.detail.usedOfBudget': { 'zh-CN': '已用 {used} token，共 {budget}{inc}', 'zh-TW': '已用 {used} token，共 {budget}{inc}', en: '{used} / {budget} tokens used{inc}' },
  'tip.detail.usedNoBudget': { 'zh-CN': '已用 {used} token，总容量未知', 'zh-TW': '已用 {used} token，總容量未知', en: '{used} tokens used, limit unknown' },
  'tip.detail.estUsed': { 'zh-CN': '已用 ≈ {used} token{budget}', 'zh-TW': '已用 ≈ {used} token{budget}', en: 'Used ≈ {used} tokens{budget}' },
  'tip.detail.estBudgetPart': { 'zh-CN': '，共 {budget}', 'zh-TW': '，共 {budget}', en: ' of {budget}' },
  'tip.detail.estNoBudgetPart': { 'zh-CN': '，总容量未知', 'zh-TW': '，總容量未知', en: ', limit unknown' },
  'tip.detail.sessionEst': { 'zh-CN': '会话估算 ≈ {low}–{high} token', 'zh-TW': '工作階段估算 ≈ {low}–{high} token', en: 'Session est. ≈ {low}–{high} tokens' },
  'tip.detail.sessionCum': { 'zh-CN': '会话累计 ≈ {low}–{high} token', 'zh-TW': '工作階段累計 ≈ {low}–{high} token', en: 'Session cumulative ≈ {low}–{high} tokens' },
  'tip.detail.waitBg': { 'zh-CN': '正在等待后台更新统计数据', 'zh-TW': '正在等待背景更新統計資料', en: 'Waiting for background stats update' },
  'tip.detail.readingSession': { 'zh-CN': '正在读取当前会话上下文用量…', 'zh-TW': '正在讀取目前對話 Context 用量…', en: 'Reading current session context usage…' },
  'tip.detail.noSession': { 'zh-CN': '发送首条消息后自动追踪上下文占用', 'zh-TW': '發送首則訊息後自動追蹤上下文佔用', en: 'Send a message to track context usage' },
  'tip.detail.emptySession': { 'zh-CN': '已用 0 token，首轮回复后显示预算上限', 'zh-TW': '已用 0 token，首輪回覆後顯示預算上限', en: '0 tokens used; budget appears after first turn' },
  'tip.detail.incSuffix': { 'zh-CN': '（含未知附件）', 'zh-TW': '（含未知附件）', en: ' (incl. unknown files)' },
  'badge.noSession': { 'zh-CN': '未打开会话', 'zh-TW': '未打開對話', en: 'No active chat' },
  'badge.emptySession': { 'zh-CN': '新会话（空）', 'zh-TW': '新對話（空）', en: 'Empty chat' },
  'badge.clickOpenCli': { 'zh-CN': ' · 点击查看或启动 CLI', 'zh-TW': ' · 點擊檢視或啟動 CLI', en: ' · Click to view or launch CLI' },
  'badge.delayed': { 'zh-CN': '统计延迟', 'zh-TW': '統計延遲', en: 'Delayed' },
  'badge.actualUnknown': { 'zh-CN': '真实量未知', 'zh-TW': '真實量未知', en: 'Actual unknown' },
  'badge.tokensTitle': { 'zh-CN': 'Token 用量一览（点击展开详情）', 'zh-TW': 'Token 用量總覽（點擊展開詳細資訊）', en: 'Token Usage Overview (click to open)' },
  'badge.speedCalc': { 'zh-CN': '计算中…', 'zh-TW': '計算中…', en: 'Calculating…' },
  'badge.speedHoverIdle': { 'zh-CN': ' · 待生成', 'zh-TW': ' · 待生成', en: ' · Idle' },
  'badge.speedTitleIdle': { 'zh-CN': '模型输出速度与耗时 (tok/s)', 'zh-TW': '模型輸出速度與耗時 (tok/s)', en: 'Model output speed & latency (tok/s)' },
  'badge.speedTitleWait': { 'zh-CN': '正在等待模型返回或计算生成指标…', 'zh-TW': '正在等待模型回傳或計算生成指標…', en: 'Waiting for model response or metrics…' },
  'badge.speedTitleDetail': { 'zh-CN': '最新模型输出速度：{tps} tok/s{streaming}\n总耗时：{duration}s (首字 {ttft}s + 流式 {streamSec}s)\n本次产出：{output} tokens', 'zh-TW': '最新模型輸出速度：{tps} tok/s{streaming}\n總耗時：{duration}s (首字 {ttft}s + 流式 {streamSec}s)\n本次產出：{output} tokens', en: 'Latest output speed: {tps} tok/s{streaming}\nTotal: {duration}s (TTFT {ttft}s + streaming {streamSec}s)\nOutput: {output} tokens' },
  'badge.speedStreamingPart': { 'zh-CN': ' (流式 {tps} tok/s)', 'zh-TW': ' (流式 {tps} tok/s)', en: ' (streaming {tps} tok/s)' },
  'badge.corpus.range': { 'zh-CN': '会话{range}{inc}', 'zh-TW': '工作階段{range}{inc}', en: 'Chat {range}{inc}' },
  'badge.corpus.incPlus': { 'zh-CN': '＋未知', 'zh-TW': '＋未知', en: '+unknown' },
  'badge.corpus.scanning': { 'zh-CN': '会话扫描中…', 'zh-TW': '對話掃描中…', en: 'Scanning chat…' },
  'badge.corpus.pending': { 'zh-CN': '会话待扫描', 'zh-TW': '對話待掃描', en: 'Chat scan pending' },
  'badge.status.stale': { 'zh-CN': '最近请求统计读取异常或延迟，不能判断剩余空间。', 'zh-TW': '最近請求統計讀取異常或延遲，不能判斷剩餘空間。', en: 'Latest request stats delayed or unavailable; remaining space cannot be determined.' },
  'badge.status.scanErr': { 'zh-CN': '全会话扫描未完成：{err}', 'zh-TW': '全工作階段掃描未完成：{err}', en: 'Session scan incomplete: {err}' },
  'badge.status.incomplete': { 'zh-CN': '存在 {count} 个附件含未知内容；会话总量仍未计全，不能据此保证不会超限。', 'zh-TW': '存在 {count} 個附件含未知內容；工作階段總量仍未計全，無法據此保證不會超限。', en: '{count} attachment(s) contain unreadable content; cumulative total is incomplete.' },
  'badge.status.estimated': { 'zh-CN': '只有客户端估算，附件等内容可能未计全；当前请求真实占用未知。', 'zh-TW': '僅有用戶端估算，附件等內容可能未計全；目前請求真實佔用未知。', en: 'Client estimate only; attachments may be omitted and actual usage is unknown.' },
  'badge.status.normal': { 'zh-CN': '请求用量与会话累计分别统计；会话 token 数始终为本地估算。', 'zh-TW': '請求用量與工作階段累計分別統計；工作階段 token 數始終為本機估算。', en: 'Request usage and cumulative session totals are tracked separately; session totals are local estimates.' },
  'cli.busy': { 'zh-CN': 'CLI 正在启动中，请稍候…', 'zh-TW': 'CLI 正在啟動中，請稍候…', en: 'CLI is launching, please wait…' },
  'cli.noBridge': { 'zh-CN': '本地桥接服务未连接，请执行 node cli.js install 或重启客户端', 'zh-TW': '本機橋接服務未連線，請執行 node cli.js install 或重新啟動用戶端', en: 'Local bridge is not connected. Run `node cli.js install` or restart the client.' },
  'cli.defaultCwd': { 'zh-CN': '默认', 'zh-TW': '預設', en: 'Default' },
  'cli.notFound': { 'zh-CN': '未检测到可用的 Antigravity CLI (agy)，请检查安装路径', 'zh-TW': '未偵測到可用的 Antigravity CLI (agy)，請檢查安裝路徑', en: 'Antigravity CLI (agy) was not found. Check your installation path.' },
  'cli.failed': { 'zh-CN': '启动 CLI 失败：{err}', 'zh-TW': '啟動 CLI 失敗：{err}', en: 'Failed to launch CLI: {err}' },
  'cli.exception': { 'zh-CN': '启动 CLI 发生异常', 'zh-TW': '啟動 CLI 發生異常', en: 'Unexpected error launching CLI' },
  'drawer.colors.expand': { 'zh-CN': '▼ 展开设置', 'zh-TW': '▼ 展開設定', en: '▼ Expand' },
  'drawer.colors.collapse': { 'zh-CN': '▲ 收起设置', 'zh-TW': '▲ 收起設定', en: '▲ Collapse' },
  'key.overflowUsed': { 'zh-CN': '超限', 'zh-TW': '超限', en: 'Exceeded' },
  'key.overflowRem': { 'zh-CN': '0 (已溢出)', 'zh-TW': '0 (已溢位)', en: '0 (Overflow)' },
  'key.estShort': { 'zh-CN': '约 {val} (估算)', 'zh-TW': '約 {val} (估算)', en: '~{val} (est.)' },
  'key.estPrefix': { 'zh-CN': '约 {val}', 'zh-TW': '約 {val}', en: '~{val}' },
  'key.pending': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Pending' },
  'key.pill.tight': { 'zh-CN': '紧张', 'zh-TW': '緊張', en: 'Critical' },
  'key.pill.elevated': { 'zh-CN': '偏高', 'zh-TW': '偏高', en: 'High' },
  'key.pill.normal': { 'zh-CN': '正常', 'zh-TW': '正常', en: 'Normal' },
  'key.pill.est': { 'zh-CN': '估算', 'zh-TW': '估算', en: 'Estimate' },
  'key.pill.reading': { 'zh-CN': '读取中', 'zh-TW': '讀取中', en: 'Reading' },
  'key.pill.newSession': { 'zh-CN': '新会话', 'zh-TW': '新對話', en: 'New Session' },
  'key.pill.emptySession': { 'zh-CN': '未开始', 'zh-TW': '未開始', en: 'Empty' },
  'key.takeaway.90': { 'zh-CN': '上下文已消耗 {pct}%，仅剩约 {rem} tokens，接近预算上限！建议清理冗余上下文。', 'zh-TW': '上下文已消耗 {pct}%，僅剩約 {rem} tokens，接近預算上限！建議清理多餘上下文。', en: 'Context usage is at {pct}% (~{rem} tokens left), near the limit. Consider trimming context.' },
  'key.takeaway.75': { 'zh-CN': '已使用 {pct}%，剩余可用空间约 {rem} tokens，注意大文件或长输出。', 'zh-TW': '已使用 {pct}%，剩餘可用空間約 {rem} tokens，注意大型檔案或長輸出。', en: '{pct}% used (~{rem} tokens left). Watch large files or long outputs.' },
  'key.takeaway.ok': { 'zh-CN': '当前用量健康（{pct}%），剩余可用空间充足（约 {rem} tokens），可正常继续对话。', 'zh-TW': '目前用量健康（{pct}%），剩餘可用空間充足（約 {rem} tokens），可正常繼續對話。', en: 'Healthy usage ({pct}%), plenty of room (~{rem} tokens left).' },
  'key.takeaway.est': { 'zh-CN': '本地估算（待服务端返回实际用量）', 'zh-TW': '本機估算（待伺服器回傳實際用量）', en: 'Local estimate (awaiting reported usage)' },
  'key.takeaway.loading': { 'zh-CN': '正在读取当前会话上下文用量…', 'zh-TW': '正在讀取目前對話上下文用量…', en: 'Reading current session context usage…' },
  'key.takeaway.noSession': { 'zh-CN': '当前尚未开始会话，发送首条消息后将自动追踪上下文窗口占用。', 'zh-TW': '目前尚未開始對話，發送首則訊息後將自動追蹤上下文視窗佔用。', en: 'No active session yet. Send a message to start tracking context window usage.' },
  'key.takeaway.emptySession': { 'zh-CN': '当前会话尚无对话记录，发送首条消息后将自动显示上下文占用与预算上限。', 'zh-TW': '目前工作階段尚無對話記錄，發送首則訊息後將自動顯示上下文佔用與預算上限。', en: 'This session has no turns yet. Usage and budget will appear after the first message.' },
  'speed.pill.fast': { 'zh-CN': '极速', 'zh-TW': '極速', en: 'Fast' },
  'speed.pill.smooth': { 'zh-CN': '流畅', 'zh-TW': '流暢', en: 'Smooth' },
  'speed.pill.good': { 'zh-CN': '良好', 'zh-TW': '良好', en: 'Good' },
  'speed.pill.slow': { 'zh-CN': '偏慢', 'zh-TW': '偏慢', en: 'Slow' },
  'speed.pill.calc': { 'zh-CN': '计算中', 'zh-TW': '計算中', en: 'Calculating' },
  'speed.pill.idle': { 'zh-CN': '待生成', 'zh-TW': '待生成', en: 'Idle' },
  'speed.takeaway.ok': { 'zh-CN': '输出{tone}（{tps} tok/s{stream}），总耗时 {dur}s 内生成 {tok} tokens{model}。', 'zh-TW': '輸出{tone}（{tps} tok/s{stream}），總耗時 {dur}s 內產生 {tok} tokens{model}。', en: 'Output {tone} ({tps} tok/s{stream}), generated {tok} tokens in {dur}s{model}.' },
  'speed.tone.smooth': { 'zh-CN': '流畅', 'zh-TW': '流暢', en: 'smooth' },
  'speed.tone.steady': { 'zh-CN': '平稳', 'zh-TW': '平穩', en: 'steady' },
  'speed.streamPart': { 'zh-CN': '，纯流式传输达 {tps} tok/s', 'zh-TW': '，純串流傳輸達 {tps} tok/s', en: ', streaming {tps} tok/s' },
  'speed.takeaway.idle': { 'zh-CN': '等待当前或下一次模型输出完成，将自动计算精确输出速度 (tok/s)、首字延迟与总耗时。', 'zh-TW': '等待目前或下一次模型輸出完成，將自動計算精確輸出速度 (tok/s)、首字延遲與總耗時。', en: 'Waiting for the next model response to measure output speed (tok/s), TTFT, and duration.' },
  'tech.modelPlaceholder': { 'zh-CN': '模型标识：{id}', 'zh-TW': '模型識別：{id}', en: 'Model ID: {id}' },
  'tech.modelMissing': { 'zh-CN': '未返回模型信息', 'zh-TW': '未回傳模型資訊', en: 'No model info returned' },
  'tech.req.exceeded': { 'zh-CN': '输入超限（已失败）', 'zh-TW': '輸入超限（已失敗）', en: 'Input limit exceeded (failed)' },
  'tech.req.network': { 'zh-CN': '网络故障（非超限）', 'zh-TW': '網路故障（非超限）', en: 'Network error (not overflow)' },
  'tech.req.failed': { 'zh-CN': '已失败', 'zh-TW': '已失敗', en: 'Failed' },
  'tech.req.reported': { 'zh-CN': '已返回实际统计', 'zh-TW': '已回傳實際統計', en: 'Actual stats returned' },
  'tech.req.estimated': { 'zh-CN': '只有本地估算', 'zh-TW': '只有本機估算', en: 'Local estimate only' },
  'tech.status.noSession': { 'zh-CN': '当前未打开会话，暂无请求或附件记录。', 'zh-TW': '目前未打開對話，暫無請求或附件記錄。', en: 'No active session; no requests or attachments yet.' },
  'tech.req.noSession': { 'zh-CN': '尚未开始会话', 'zh-TW': '尚未開始對話', en: 'No active session' },
  'tech.req.emptySession': { 'zh-CN': '尚无请求记录', 'zh-TW': '尚無請求記錄', en: 'No requests yet' },
  'tech.req.waiting': { 'zh-CN': '等待统计，未确认执行状态', 'zh-TW': '等待統計，未確認執行狀態', en: 'Awaiting stats; status unconfirmed' },
  'tech.actual.exceeded': { 'zh-CN': '>{val}（实际总数未返回）', 'zh-TW': '>{val}（實際總數未回傳）', en: '>{val} (actual total not returned)' },
  'tech.actual.exceededNoLim': { 'zh-CN': '已超限；实际数值未知', 'zh-TW': '已超限；實際數值未知', en: 'Exceeded; actual count unknown' },
  'tech.actual.unknown': { 'zh-CN': '真实用量未知', 'zh-TW': '真實用量未知', en: 'Actual usage unknown' },
  'tech.est.val': { 'zh-CN': '约 {val} · {note}', 'zh-TW': '約 {val} · {note}', en: '~{val} · {note}' },
  'tech.est.under': { 'zh-CN': '已证实低估', 'zh-TW': '已證實低估', en: 'Confirmed underestimate' },
  'tech.est.ref': { 'zh-CN': '仅供参考', 'zh-TW': '僅供參考', en: 'For reference only' },
  'tech.est.none': { 'zh-CN': '未提供', 'zh-TW': '未提供', en: 'Not provided' },
  'tech.svcLim.val': { 'zh-CN': '{val}', 'zh-TW': '{val}', en: '{val}' },
  'tech.svcLim.none': { 'zh-CN': '—', 'zh-TW': '—', en: '—' },
  'tech.pct.val': { 'zh-CN': '{pct}%', 'zh-TW': '{pct}%', en: '{pct}%' },
  'tech.pct.none': { 'zh-CN': '—', 'zh-TW': '—', en: '—' },
  'tech.plusUnknown': { 'zh-CN': ' ＋ 未知内容', 'zh-TW': ' ＋ 未知內容', en: ' + unknown' },
  'tech.plusUnknownShort': { 'zh-CN': ' ＋ 未知', 'zh-TW': ' ＋ 未知', en: ' + unknown' },
  'tech.scanIncomplete': { 'zh-CN': '扫描未完成', 'zh-TW': '掃描未完成', en: 'Scan incomplete' },
  'tech.scanning': { 'zh-CN': '扫描中…', 'zh-TW': '掃描中…', en: 'Scanning…' },
  'tech.stepsVal': { 'zh-CN': '{steps} 条；{user} 条用户消息／{assistant} 条回复', 'zh-TW': '{steps} 筆；{user} 則使用者訊息／{assistant} 則回覆', en: '{steps} steps; {user} user / {assistant} assistant' },
  'tech.stepsNone': { 'zh-CN': '尚未完成全量读取', 'zh-TW': '尚未完成全量讀取', en: 'Full history not loaded yet' },
  'tech.coverageVal': { 'zh-CN': '{total} 个附件条目（{user} 个上传、{assistant} 个模型/工具输出）；{read} 个已读到文本，{unknown} 个含未计内容。{rescan}{err}', 'zh-TW': '{total} 個附件項目（{user} 個上傳、{assistant} 個模型/工具輸出）；{read} 個已讀到文字，{unknown} 個含未計內容。{rescan}{err}', en: '{total} attachment(s) ({user} uploaded, {assistant} model/tool); {read} readable, {unknown} with unread content.{rescan}{err}' },
  'tech.coverageRescan': { 'zh-CN': ' 正在重新扫描…', 'zh-TW': ' 正在重新掃描…', en: ' Rescanning…' },
  'tech.coverageErr': { 'zh-CN': ' 最近重扫失败，当前为旧结果：{err}', 'zh-TW': ' 最近重掃失敗，目前為舊結果：{err}', en: ' Latest rescan failed (showing prior data): {err}' },
  'tech.coverageScanning': { 'zh-CN': '正在扫描整段归档，不依赖页面已加载的聊天条数。', 'zh-TW': '正在掃描整段封存，不依賴頁面已載入的聊天筆數。', en: 'Scanning full archive regardless of rendered chat items.' },
  'tech.coverageNoSession': { 'zh-CN': '当前未打开会话。', 'zh-TW': '目前未打開對話。', en: 'No active session.' },
  'tech.updatedVal': { 'zh-CN': '请求统计 {req} · 全量扫描 {scan}', 'zh-TW': '請求統計 {req} · 全量掃描 {scan}', en: 'Request stats {req} · Full scan {scan}' },
  'tech.updatedNoSession': { 'zh-CN': '等待新会话开始', 'zh-TW': '等待新對話開始', en: 'Waiting for a session to start' },
  'tech.unread': { 'zh-CN': '未读取', 'zh-TW': '未讀取', en: 'Unread' },
  'tech.unfinished': { 'zh-CN': '未完成', 'zh-TW': '未完成', en: 'Pending' },
  'files.noSession': { 'zh-CN': '当前未打开会话。', 'zh-TW': '目前未打開對話。', en: 'No active session.' },
  'files.reading': { 'zh-CN': '正在读取全量会话附件引用…', 'zh-TW': '正在讀取全量工作階段附件引用…', en: 'Reading session attachment references…' },
  'files.empty': { 'zh-CN': '归档中没有上传附件引用。', 'zh-TW': '封存中沒有上傳附件引用。', en: 'No attachment references in archive.' },
  'files.refs': { 'zh-CN': '（引用 {n} 次）', 'zh-TW': '（引用 {n} 次）', en: ' ({n} refs)' },
  'files.px': { 'zh-CN': '{w}×{h} 像素', 'zh-TW': '{w}×{h} 像素', en: '{w}×{h} px' },
  'files.chars': { 'zh-CN': '{n} 字符', 'zh-TW': '{n} 字元', en: '{n} chars' },
  'files.tokUnknown': { 'zh-CN': '内容 token 未知', 'zh-TW': '內容 token 未知', en: 'Token count unknown' },
  'files.assistantPrefix': { 'zh-CN': '模型输出附件 · ', 'zh-TW': '模型輸出附件 · ', en: 'Model/tool attachment · ' },
  'files.sheets': { 'zh-CN': ' · {sheets} 个工作表，{cells} 个单元格', 'zh-TW': ' · {sheets} 個工作表，{cells} 個儲存格', en: ' · {sheets} sheets, {cells} cells' },
  'files.hiddenSheets': { 'zh-CN': '（含 {n} 个隐藏表）', 'zh-TW': '（含 {n} 個隱藏工作表）', en: ' ({n} hidden)' },
  'files.unknownPrefix': { 'zh-CN': '未计全：{parts}', 'zh-TW': '未計全：{parts}', en: 'Partial: {parts}' },
  'heat.today': { 'zh-CN': '（今日）', 'zh-TW': '（今日）', en: ' (Today)' },
  'heat.firstUse': { 'zh-CN': '（首次使用）', 'zh-TW': '（首次使用）', en: ' (First use)' },
  'heat.future': { 'zh-CN': '未来日期（待产生记录）', 'zh-TW': '未來日期（尚無記錄）', en: 'Future date (no records yet)' },
  'heat.prompt': { 'zh-CN': '提示词', 'zh-TW': '提示詞', en: 'Prompt' },
  'heat.output': { 'zh-CN': '输出', 'zh-TW': '輸出', en: 'Output' },
  'heat.cache': { 'zh-CN': '缓存', 'zh-TW': '快取', en: 'Cache' },
  'heat.weeklyTotal': { 'zh-CN': 'Weekly Total · 周累计 (折合日均 ${avg})', 'zh-TW': 'Weekly Total · 週累計 (折合日均 ${avg})', en: 'Weekly Total (daily avg ${avg})' },
  'heat.cumSuffix': { 'zh-CN': ' (累计)', 'zh-TW': ' (累計)', en: ' (Cumulative)' },
  'heat.cumTotal': { 'zh-CN': 'Cumulative Total · 截至当日累计 (折合日均 ${avg})', 'zh-TW': 'Cumulative Total · 截至當日累計 (折合日均 ${avg})', en: 'Cumulative Total to Date (daily avg ${avg})' },
  'heat.activeDays': { 'zh-CN': '${avg} ({days}天)', 'zh-TW': '${avg} ({days}天)', en: '${avg} ({days}d)' },
  'heat.roi': { 'zh-CN': '{ratio}x 回本', 'zh-TW': '{ratio}x 回本', en: '{ratio}x ROI' },
  'heat.peak': { 'zh-CN': '峰值', 'zh-TW': '尖峰', en: 'Peak' },
  'models.list.historyGroup': { 'zh-CN': '仅历史记录 / 本地设置', 'zh-TW': '僅歷史記錄 / 本機設定', en: 'History / Local Only' },
  'models.list.historyTag': { 'zh-CN': '仅历史', 'zh-TW': '僅歷史', en: 'History' },
  'plan.detail.toggleOpen': { 'zh-CN': '详情 ▼', 'zh-TW': '詳細資訊 ▼', en: 'Details ▼' },
  'plan.detail.toggleClose': { 'zh-CN': '详情收回 ▲', 'zh-TW': '收回詳細資訊 ▲', en: 'Hide ▲' },
  'plan.summary.identified': { 'zh-CN': '已自动识别', 'zh-TW': '已自動識別', en: 'Auto-detected' },
  'plan.summary.custom': { 'zh-CN': '自定义生效', 'zh-TW': '自訂生效', en: 'Custom' },
  'plan.summary.unknown': { 'zh-CN': '未识别/默认', 'zh-TW': '未識別/預設', en: 'Default / Unknown' },
  'plan.summary.perMonth': { 'zh-CN': '/月', 'zh-TW': '/月', en: '/mo' },
  'plan.dt.promptCredits': { 'zh-CN': 'Prompt 池', 'zh-TW': 'Prompt 池', en: 'Prompt' },
  'plan.dt.flowCredits': { 'zh-CN': 'Flow 池', 'zh-TW': 'Flow 池', en: 'Flow' },
  'plan.account.unknown': { 'zh-CN': '未识别当前登录邮箱', 'zh-TW': '未識別目前登入信箱', en: 'Signed-in email not detected' },
  'plan.tag.manualFree': { 'zh-CN': '免费', 'zh-TW': '免費', en: 'Free' },
  'plan.tag.userPaid': { 'zh-CN': '实付', 'zh-TW': '實付', en: 'Paid' },
  'plan.tag.publicRef': { 'zh-CN': '公开参考价', 'zh-TW': '公開參考價', en: 'Public ref' },
  'models.restartConfirm.title': { 'zh-CN': '重启 Antigravity 客户端', 'zh-TW': '重新啟動 Antigravity 用戶端', en: 'Restart Antigravity Client' },
  'plan.credits.avail': { 'zh-CN': '{avail} 可用 / {monthly} 月额度', 'zh-TW': '{avail} 可用 / {monthly} 月額度', en: '{avail} left / {monthly} monthly' },
  'plan.form.clear': { 'zh-CN': '清除', 'zh-TW': '清除', en: 'Clear' },
  'plan.form.save': { 'zh-CN': '保存', 'zh-TW': '儲存', en: 'Save' },
  'cost.title': { 'zh-CN': '本期 API 参考金额', 'zh-TW': '本期 API 參考金額', en: 'Current Period API Value' },
  'cost.periodTag': { 'zh-CN': '本月自然月', 'zh-TW': '本月自然月', en: 'This Month' },
  'cost.nonPaidBadge': { 'zh-CN': '参考估值', 'zh-TW': '參考估值', en: 'Est. Value' },
  'cost.subUnknown': { 'zh-CN': '订阅实付：未填写', 'zh-TW': '訂閱實付：未填寫', en: 'Plan paid: Not set' },
  'cost.btnExpand': { 'zh-CN': '展开详情 ▼', 'zh-TW': '展開詳細資訊 ▼', en: 'Show details ▼' },
  'cost.btnCollapse': { 'zh-CN': '收起详情 ▴', 'zh-TW': '收起詳細資訊 ▴', en: 'Hide details ▴' },
  'cost.scopePeriod': { 'zh-CN': '本期', 'zh-TW': '本期', en: 'This period' },
  'cost.scopeAll': { 'zh-CN': '全量历史', 'zh-TW': '完整歷史紀錄', en: 'All history' },
  'cost.modeLabel': { 'zh-CN': '估值模式:', 'zh-TW': '估算模式:', en: 'Pricing mode:' },
  'cost.modeRef': { 'zh-CN': '参考模型估算', 'zh-TW': '參考模型估算', en: 'Reference model' },
  'cost.modeHybrid': { 'zh-CN': '混合模式', 'zh-TW': '混合模式', en: 'Hybrid' },
  'cost.modeIdentified': { 'zh-CN': '仅已识别模型', 'zh-TW': '僅已識別模型', en: 'Identified only' },
  'cost.card.input': { 'zh-CN': '输入 Token', 'zh-TW': '輸入 Token', en: 'Input Tokens' },
  'cost.card.cache': { 'zh-CN': '缓存读取 (优惠)', 'zh-TW': '快取讀取 (優惠)', en: 'Cache Read (discounted)' },
  'cost.card.output': { 'zh-CN': '输出 Token', 'zh-TW': '輸出 Token', en: 'Output Tokens' },
  'cost.analyzing': { 'zh-CN': '正在分析请求模型与计价覆盖率…', 'zh-TW': '正在分析請求模型與計價覆蓋率…', en: 'Analyzing model calls and pricing coverage…' },
  'cost.disclaimer': { 'zh-CN': '按公开 API 单价折算（缓存 10%），仅作参考。', 'zh-TW': '依公開 API 單價換算（快取 10%），僅供參考。', en: 'Estimated at public API rates (10% cache read) for reference.' },
  'tokens.firstUse': { 'zh-CN': '首次使用：{date}', 'zh-TW': '首次使用：{date}', en: 'First use: {date}' },
  'cost.titleAll': { 'zh-CN': '全量 API 参考金额', 'zh-TW': '全量 API 參考金額', en: 'All-Time API Value' },
  'cost.allHistory': { 'zh-CN': '全历史累计', 'zh-TW': '全歷史累計', en: 'All history' },
  'cost.approx': { 'zh-CN': '约 ${val}', 'zh-TW': '約 ${val}', en: '~${val}' },
  'cost.notReady': { 'zh-CN': '数据未就绪', 'zh-TW': '資料尚未就緒', en: 'Not ready' },
  'cost.noRecords': { 'zh-CN': '暂无记录', 'zh-TW': '暫無記錄', en: 'No records' },
  'cost.refSub': { 'zh-CN': '统一按 {model} 估算 (输入 ${in} / 缓存 ${ca} / 输出 ${out} 每百万 Token)', 'zh-TW': '統一依 {model} 估算 (輸入 ${in} / 快取 ${ca} / 輸出 ${out} 每百萬 Token)', en: 'Estimated via {model} (In ${in} / Cache ${ca} / Out ${out} per 1M)' },
  'cost.hybridSub': { 'zh-CN': '混合模式：已识别 ${known} + 未知折算 ${res}', 'zh-TW': '混合模式：已識別 ${known} + 未知換算 ${res}', en: 'Hybrid: Identified ${known} + Residual ${res}' },
  'cost.hybridBadge': { 'zh-CN': '混合模式折算', 'zh-TW': '混合模式換算', en: 'Hybrid mode' },
  'cost.identSub': { 'zh-CN': '仅计入 {n} 条已知真实模型调用', 'zh-TW': '僅計入 {n} 筆已知真實模型呼叫', en: 'Only {n} identified model call(s) included' },
  'cost.identSubNone': { 'zh-CN': '暂无已识别模型记录', 'zh-TW': '暫無已識別模型記錄', en: 'No identified model calls' },
  'cost.covPct': { 'zh-CN': '{pct}% 计价覆盖', 'zh-TW': '{pct}% 計價覆蓋', en: '{pct}% priced' },
  'cost.tokCacheDiscount': { 'zh-CN': '{tok} tok (优惠)', 'zh-TW': '{tok} tok (優惠)', en: '{tok} tok (disc.)' },
  'cost.tokResidual': { 'zh-CN': '剩余 {tok} tok', 'zh-TW': '剩餘 {tok} tok', en: 'Rem. {tok} tok' },
  'cost.usageSummary': { 'zh-CN': '累计处理 Token: {total} (含 {cache} 缓存读取)', 'zh-TW': '累計處理 Token: {total} (含 {cache} 快取讀取)', en: 'Total tokens: {total} (incl. {cache} cache)' },
  'cost.diffAll': { 'zh-CN': '全量累计', 'zh-TW': '全量累計', en: 'All-time' },
  'cost.diffFree': { 'zh-CN': '免费权益 · 等值 +${val}', 'zh-TW': '免費權益 · 等值 +${val}', en: 'Free plan · ~+${val} value' },
  'cost.diffPaid': { 'zh-CN': '较实付差额 {sign}${val}', 'zh-TW': '較實付差額 {sign}${val}', en: 'vs. paid {sign}${val}' },
  'cost.diffUnknown': { 'zh-CN': '', 'zh-TW': '', en: '' },
  'cost.subLineFree': { 'zh-CN': '订阅额外实付：{sym}0 ({src})', 'zh-TW': '訂閱額外實付：{sym}0 ({src})', en: 'Extra plan paid: {sym}0 ({src})' },
  'cost.subLinePaid': { 'zh-CN': '订阅实付：{sym}{val}{cny} ({cycle}{exp})', 'zh-TW': '訂閱實付：{sym}{val}{cny} ({cycle}{exp})', en: 'Plan paid: {sym}{val}{cny} ({cycle}{exp})' },
  'cost.breakdownPrefix': { 'zh-CN': '已识别真实模型明细：{details}{note}。', 'zh-TW': '已識別真實模型明細：{details}{note}。', en: 'Identified models: {details}{note}.' },
  'cost.breakdownNone': { 'zh-CN': '暂无已匹配真实模型', 'zh-TW': '暫無已匹配真實模型', en: 'No matched model calls yet' },
  'tokens.dailyAvg': { 'zh-CN': ' · 日均 ${val}', 'zh-TW': ' · 日均 ${val}', en: ' · Avg ${val}/d' },
  'tokens.srcAllLabel': { 'zh-CN': '全部来源', 'zh-TW': '全部來源', en: 'All Sources' },
  'tokens.srcDesktopLabel': { 'zh-CN': '桌面端', 'zh-TW': '桌面端', en: 'Desktop' },
  'models.card.effortsList': { 'zh-CN': '可用档位：{list}', 'zh-TW': '可用檔位：{list}', en: 'Efforts: {list}' },
  'models.card.effortStandard': { 'zh-CN': '可用档位：标准', 'zh-TW': '可用檔位：標準', en: 'Efforts: Standard' },
  'diag.ctx.badge': { 'zh-CN': '超限', 'zh-TW': '超限', en: 'Limit' },
  'diag.ctx.amount': { 'zh-CN': '服务端超限', 'zh-TW': '伺服器端超限', en: 'Server Limit' },
  'diag.ctx.keyBadge': { 'zh-CN': '已超限', 'zh-TW': '已超限', en: 'Exceeded' },
  'diag.ctx.hover': { 'zh-CN': ' · 100% 已溢出', 'zh-TW': ' · 100% 已超限', en: ' · 100% overflow' },
  'diag.ctx.tipTitle': { 'zh-CN': '上下文窗口（超限告警）：', 'zh-TW': 'Context 視窗（超限警示）：', en: 'Context Window (Exceeded):' },
  'diag.ctx.tipPct': { 'zh-CN': '100% 已用（已超出上限）', 'zh-TW': '100% 已用（已超出上限）', en: '100% used (exceeded)' },
  'diag.ctx.tipDetailLim': { 'zh-CN': '已超上限，共 {lim} token', 'zh-TW': '已超上限，共 {lim} token', en: 'Exceeded {lim} tokens' },
  'diag.ctx.tipDetailDef': { 'zh-CN': '服务端已拒绝输入（超出容量上限）', 'zh-TW': '伺服器端已拒絕輸入（超出容量上限）', en: 'Input rejected by server (over limit)' },
  'diag.ctx.status': { 'zh-CN': '服务端已拒绝：输入超限{lim}。本地估算不可靠，需精简或新建会话。', 'zh-TW': '伺服器端已拒絕：輸入超限{lim}。本機估算不可靠，需精簡或新建會話。', en: 'Server rejected: input exceeded{lim}. Trim context or start a new chat.' },
  'diag.ctx.statusLim': { 'zh-CN': '（上限 {lim} tokens）', 'zh-TW': '（上限 {lim} tokens）', en: ' (limit {lim} tokens)' },
  'diag.ctx.takeaway': { 'zh-CN': '已超出服务端最大限制{lim}，当前对话已被拒绝。需精简或新建会话。', 'zh-TW': '已超出伺服器端最大限制{lim}，目前對話已被拒絕。需精簡或新建會話。', en: 'Exceeded server max limit{lim}; current chat rejected. Trim or start new chat.' },
  'diag.quota.badge': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Quota' },
  'diag.quota.amount': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Out of Quota' },
  'diag.quota.hover': { 'zh-CN': ' · 模型额度用尽，可切换模型', 'zh-TW': ' · 模型配額用盡，可切換模型', en: ' · Model quota exhausted' },
  'diag.quota.tipTitle': { 'zh-CN': '模型额度（额度耗尽）：', 'zh-TW': '模型額度（額度耗盡）：', en: 'Model Quota (Exhausted):' },
  'diag.quota.tipPct': { 'zh-CN': '当前模型配额已用尽', 'zh-TW': '目前模型配額已用盡', en: 'Current model quota exhausted' },
  'diag.quota.reset': { 'zh-CN': '，预计将于 {time} 重置', 'zh-TW': '，預計將於 {time} 重置', en: ', resets around {time}' },
  'diag.quota.tipDetail': { 'zh-CN': '{pool}额度已耗尽{reset}。可手动切换至其他可用模型', 'zh-TW': '{pool}額度已耗盡{reset}。可手動切換至其他可用模型', en: '{pool} quota exhausted{reset}. Switch to another model.' },
  'diag.quota.status': { 'zh-CN': '模型额度耗尽：{pool}额度已耗尽{reset}。可手动切换至其他可用模型。', 'zh-TW': '模型額度耗盡：{pool}額度已耗盡{reset}。可手動切換至其他可用模型。', en: 'Quota exhausted: {pool} quota depleted{reset}. Switch to another model.' },
  'diag.quota.takeaway': { 'zh-CN': '{pool}额度已耗尽{reset}。可手动切换至其他可用模型继续对话。', 'zh-TW': '{pool}額度已耗盡{reset}。可手動切換至其他可用模型繼續對話。', en: '{pool} quota exhausted{reset}. Switch to another model to continue.' },
  'diag.rate.badge': { 'zh-CN': '限流', 'zh-TW': '限流', en: '429' },
  'diag.rate.amount': { 'zh-CN': '请求限流', 'zh-TW': '請求限流', en: 'Rate Limited' },
  'diag.rate.hover': { 'zh-CN': ' · 触发频率限制，请稍候', 'zh-TW': ' · 已達速率限制，請稍候', en: ' · Rate limited, wait a moment' },
  'diag.rate.tipTitle': { 'zh-CN': '请求限制（请求过频）：', 'zh-TW': '請求限制（請求過頻）：', en: 'Rate Limit (Too Many Requests):' },
  'diag.rate.tipPct': { 'zh-CN': '触发服务端频率限制（429）', 'zh-TW': '觸發伺服器端頻率限制（429）', en: 'Server rate limit (429)' },
  'diag.rate.retry': { 'zh-CN': '（建议等待 {sec} 秒）', 'zh-TW': '（建議等待 {sec} 秒）', en: ' (retry in {sec}s)' },
  'diag.rate.tipDetail': { 'zh-CN': '请求过于频繁{retry}，请稍候重试', 'zh-TW': '請求過於頻繁{retry}，請稍候重試', en: 'Too many requests{retry}, try again later' },
  'diag.rate.status': { 'zh-CN': '请求频率限制：请求过于频繁，触发服务端限制（429）{retry}。稍候重试即可恢复。', 'zh-TW': '請求頻率限制：請求過於頻繁，觸發伺服器端限制（429）{retry}。稍候重試即可恢復。', en: 'Rate limited (429){retry}. Wait and retry.' },
  'diag.rate.takeaway': { 'zh-CN': '触发服务端请求频率限制（HTTP 429）{retry}，短时间内发送请求过多，稍候重试即可恢复。', 'zh-TW': '觸發伺服器端請求頻率限制（HTTP 429）{retry}，短時間內發送請求過多，稍候重試即可恢復。', en: 'HTTP 429 rate limit{retry}. Wait briefly and retry.' },
  'diag.net.defDiag': { 'zh-CN': '连接中断或超时', 'zh-TW': '連線中斷或逾時', en: 'Connection dropped or timed out' },
  'diag.net.badge': { 'zh-CN': '网络', 'zh-TW': '網路', en: 'Network' },
  'diag.net.amount': { 'zh-CN': '网络故障', 'zh-TW': '網路故障', en: 'Network Error' },
  'diag.net.hover': { 'zh-CN': ' · 连接异常，请检查网络', 'zh-TW': ' · 連線異常，請檢查網路', en: ' · Connection error, check network' },
  'diag.net.tipTitle': { 'zh-CN': '网络连接（连接故障）：', 'zh-TW': '網路連線（連線故障）：', en: 'Network (Connection Failed):' },
  'diag.net.tipPct': { 'zh-CN': '网络连接失败或超时', 'zh-TW': '網路連線失敗或逾時', en: 'Connection failed or timed out' },
  'diag.net.tipDetail': { 'zh-CN': '连接异常（{diag}）。请检查本地网络代理与连接', 'zh-TW': '連線異常（{diag}）。請檢查本機網路代理與連線', en: 'Connection error ({diag}). Check proxy & network.' },
  'diag.net.status': { 'zh-CN': '网络连接异常：{diag}。请检查本地网络代理与网络链路设置。', 'zh-TW': '網路連線異常：{diag}。請檢查本機網路代理與網路鏈路設定。', en: 'Network error: {diag}. Check local proxy and network settings.' },
  'diag.net.takeaway': { 'zh-CN': '网络连接出现异常（{diag}）。请检查本地网络代理与链路状态。', 'zh-TW': '網路連線出現異常（{diag}）。請檢查本機網路代理與鏈路狀態。', en: 'Network error ({diag}). Check proxy and connection.' },
  'diag.auth.badge': { 'zh-CN': '认证', 'zh-TW': '認證', en: 'Auth' },
  'diag.auth.amount': { 'zh-CN': '认证失败', 'zh-TW': '認證失敗', en: 'Auth Failed' },
  'diag.auth.keyBadge': { 'zh-CN': '认证异常', 'zh-TW': '認證異常', en: 'Auth Error' },
  'diag.auth.hover': { 'zh-CN': ' · 权限不足或登录异常', 'zh-TW': ' · 權限不足或登入異常', en: ' · Unauthorized or session expired' },
  'diag.auth.tipTitle': { 'zh-CN': '账号权限（身份异常）：', 'zh-TW': '帳號權限（身分異常）：', en: 'Account Auth (Error):' },
  'diag.auth.tipPct': { 'zh-CN': '身份认证失败或缺少权限', 'zh-TW': '身分認證失敗或缺少權限', en: 'Authentication failed or unauthorized' },
  'diag.auth.tipDetail': { 'zh-CN': '身份认证失败或无权限访问，请检查账号登录状态', 'zh-TW': '身分認證失敗或無權限存取，請檢查帳號登入狀態', en: 'Auth failed or no access. Check sign-in status.' },
  'diag.auth.status': { 'zh-CN': '身份认证失败或无访问权限，请检查账号登录状态或订阅权限。', 'zh-TW': '身分認證失敗或無存取權限，請檢查帳號登入狀態或訂閱權限。', en: 'Authentication failed or unauthorized (401/403). Check account sign-in.' },
  'diag.auth.takeaway': { 'zh-CN': '身份认证失败或无访问权限（401/403）。请检查账号登录状态或订阅权限。', 'zh-TW': '身分認證失敗或無存取權限（401/403）。請檢查帳號登入狀態或訂閱權限。', en: 'Auth failed or forbidden (401/403). Check account sign-in or plan.' },
  'diag.svc.badge': { 'zh-CN': '服务异常', 'zh-TW': '服務異常', en: '503' },
  'diag.svc.amount': { 'zh-CN': '服务受限', 'zh-TW': '服務受限', en: 'Unavailable' },
  'diag.svc.hover': { 'zh-CN': ' · 服务端繁忙，请稍候', 'zh-TW': ' · 伺服器端繁忙，請稍候', en: ' · Server overloaded, wait briefly' },
  'diag.svc.tipTitle': { 'zh-CN': '服务端状态（服务受限）：', 'zh-TW': '伺服器端狀態（服務受限）：', en: 'Service Status (Unavailable):' },
  'diag.svc.tipPct': { 'zh-CN': '模型服务暂不可用或过载', 'zh-TW': '模型服務暫不可用或過載', en: 'Model service overloaded or unavailable' },
  'diag.svc.tipDetail': { 'zh-CN': '服务端暂时过载或维护中，请稍后重试', 'zh-TW': '伺服器端暫時過載或維護中，請稍後重試', en: 'Server overloaded or under maintenance. Retry later.' },
  'diag.svc.status': { 'zh-CN': '模型服务暂不可用或处于高负载（503/Overloaded），请稍后重试。', 'zh-TW': '模型服務暫無法使用或處於高負載（503/Overloaded），請稍後重試。', en: 'Model service unavailable or overloaded (503). Retry later.' },
  'diag.svc.takeaway': { 'zh-CN': '服务端暂时不可用或处于高负载（503/Overloaded），请稍后重试。', 'zh-TW': '伺服器端暫時不可用或處於高負載（503/Overloaded），請稍後重試。', en: 'Service unavailable or overloaded (503). Retry later.' },
  'diag.cancel.badge': { 'zh-CN': '已取消', 'zh-TW': '已取消', en: 'Cancelled' },
  'diag.cancel.amount': { 'zh-CN': '请求取消', 'zh-TW': '請求取消', en: 'Cancelled' },
  'diag.cancel.hover': { 'zh-CN': ' · 请求已取消', 'zh-TW': ' · 請求已取消', en: ' · Request cancelled' },
  'diag.cancel.tipTitle': { 'zh-CN': '请求状态（已取消）：', 'zh-TW': '請求狀態（已取消）：', en: 'Request Status (Cancelled):' },
  'diag.cancel.tipPct': { 'zh-CN': '本次请求被中止或取消', 'zh-TW': '本次請求被中止或取消', en: 'Request aborted or cancelled' },
  'diag.cancel.tipDetail': { 'zh-CN': '本次生成已被用户取消或中断，可重新发送消息', 'zh-TW': '本次生成已被使用者取消或中斷，可重新發送訊息', en: 'Generation cancelled. Resend message if needed.' },
  'diag.cancel.status': { 'zh-CN': '请求已取消：当前轮次生成被中断。', 'zh-TW': '請求已取消：目前輪次生成被中斷。', en: 'Request cancelled: current generation aborted.' },
  'diag.cancel.takeaway': { 'zh-CN': '本轮生成已被用户取消或中断，未完整输出。', 'zh-TW': '本輪生成已被使用者取消或中斷，未完整輸出。', en: 'Generation cancelled before completion.' },
  'diag.quota.defPool': { 'zh-CN': '当前模型', 'zh-TW': '目前模型', en: 'Current model' },
  'diag.unknown.badge': { 'zh-CN': '待确认', 'zh-TW': '待確認', en: 'Error' },
  'diag.unknown.amount': { 'zh-CN': '请求异常', 'zh-TW': '請求異常', en: 'Request Error' },
  'diag.unknown.keyBadge': { 'zh-CN': '原因待确认', 'zh-TW': '原因待確認', en: 'Unconfirmed' },
  'diag.unknown.hover': { 'zh-CN': ' · 失败原因待确认', 'zh-TW': ' · 失敗原因待確認', en: ' · Reason unconfirmed' },
  'diag.unknown.tipTitle': { 'zh-CN': '请求状态（原因待确认）：', 'zh-TW': '請求狀態（原因待確認）：', en: 'Request Status (Unconfirmed):' },
  'diag.unknown.tipPct': { 'zh-CN': '最近请求失败（原因未知）', 'zh-TW': '最近請求失敗（原因未知）', en: 'Recent request failed (unknown reason)' },
  'diag.unknown.tipDetail': { 'zh-CN': '当前无法确认具体原因（{diag}）', 'zh-TW': '目前無法確認具體原因（{diag}）', en: 'Cannot confirm exact reason ({diag})' },
  'diag.unknown.status': { 'zh-CN': '最近请求遇到错误，当前无法独立确认具体原因（{diag}）。', 'zh-TW': '最近請求遇到錯誤，目前無法獨立確認具體原因（{diag}）。', en: 'Recent request failed; cannot confirm exact reason ({diag}).' },
  'diag.unknown.takeaway': { 'zh-CN': '最近请求遇到错误，当前无法独立确认具体原因（{diag}）。', 'zh-TW': '最近請求遇到錯誤，目前無法獨立確認具體原因（{diag}）。', en: 'Recent request failed; cannot confirm exact reason ({diag}).' },
  'tokens.badge.today': { 'zh-CN': ' · 今日 {val}', 'zh-TW': ' · 今日 {val}', en: ' · Today {val}' },
  'common.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'common.notProvided': { 'zh-CN': '未提供', 'zh-TW': '未提供', en: 'Not provided' },
  'common.loading': { 'zh-CN': '读取中...', 'zh-TW': '讀取中...', en: 'Loading...' },
  'tokens.heat.firstUsePlaceholder': { 'zh-CN': '首次使用：--', 'zh-TW': '首次使用：--', en: 'First use: --' },
  'tokens.card.costPlaceholder': { 'zh-CN': '≈ $0.00 · 日均 $0.00', 'zh-TW': '≈ $0.00 · 日均 $0.00', en: '≈ $0.00 · $0.00/d' },
  'tokens.heat.activeAvgPlaceholder': { 'zh-CN': '$0.00 (0天)', 'zh-TW': '$0.00 (0天)', en: '$0.00 (0d)' },
  'tokens.card.todaySub': { 'zh-CN': '{n} 会话实时累加', 'zh-TW': '{n} 會話即時累加', en: '{n} chat(s) live' },
  'tokens.card.monthSub': { 'zh-CN': '日均约 {val}', 'zh-TW': '日均約 {val}', en: '~{val}/day avg' },
  'tokens.card.yearSub': { 'zh-CN': '{n} 天活动记录', 'zh-TW': '{n} 天活動記錄', en: '{n} active day(s)' },
  'tokens.range.month': { 'zh-CN': '{y}年{m}月', 'zh-TW': '{y}年{m}月', en: '{y}-{m}' },
  'tokens.range.year': { 'zh-CN': '{y}年', 'zh-TW': '{y}年', en: '{y}' },
  'tokens.range.yearToToday': { 'zh-CN': '{y}年（1月1日–今天）', 'zh-TW': '{y}年（1月1日–今天）', en: '{y} (Jan 1 – Today)' },
  'heatmap.pop.inProgress': { 'zh-CN': '（进行中）', 'zh-TW': '（進行中）', en: ' (Current)' },
  'heatmap.pop.peak': { 'zh-CN': '（年度峰值）', 'zh-TW': '（年度尖峰）', en: ' (Peak)' },
  'heatmap.pop.future': { 'zh-CN': '未来月份（尚未产生用量）', 'zh-TW': '未來月份（尚無用量）', en: 'Future month (no usage)' },
  'heatmap.pop.monthlyDet': { 'zh-CN': '月度合计 · 折合日均 ${avg} (活跃 {days} 天)', 'zh-TW': '月度合計 · 折合日均 ${avg} (活躍 {days} 天)', en: 'Monthly Total · Avg ${avg}/d ({days} active days)' },
  'cost.subSpendLabel': { 'zh-CN': '本人同期实际支出', 'zh-TW': '本人同期實際支出', en: 'Your Actual Spend' },
  'cost.freePromo': { 'zh-CN': '免费活动', 'zh-TW': '免費活動', en: 'Free promo' },
  'cost.subSpend': { 'zh-CN': '订阅支出', 'zh-TW': '訂閱支出', en: 'Plan spend' },
  'cost.paidLabel': { 'zh-CN': '实付', 'zh-TW': '實付', en: 'Paid' },
  'cost.paidUnknown': { 'zh-CN': '实付未知', 'zh-TW': '實付未知', en: 'Paid unknown' },
  'cost.publicRefMonthly': { 'zh-CN': '公开参考价 ${p}/月', 'zh-TW': '公開參考價 ${p}/月', en: 'Public ref ${p}/mo' },
  'cost.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'cost.noPlanData': { 'zh-CN': '未获取到套餐数据', 'zh-TW': '未取得方案資料', en: 'No plan data' },
  'cost.allNoCompare': { 'zh-CN': '', 'zh-TW': '', en: '' },
  'cost.expiredTag': { 'zh-CN': ' · 已到期', 'zh-TW': ' · 已到期', en: ' · Expired' },
  'cost.freeActive': { 'zh-CN': '免费权益{extra}', 'zh-TW': '免費權益{extra}', en: 'Free plan{extra}' },
  'cost.covFull': { 'zh-CN': '100% 折算覆盖', 'zh-TW': '100% 換算覆蓋', en: '100% priced' },
  'cost.refApprox': { 'zh-CN': '约 ${val}', 'zh-TW': '約 ${val}', en: '~${val}' },
  'dropdown.autoSaved': { 'zh-CN': '已自动保存', 'zh-TW': '已自動儲存', en: 'Auto-saved' },
  'dropdown.saveFailed': { 'zh-CN': '保存失败', 'zh-TW': '儲存失敗', en: 'Save failed' },
  'dropdown.saveFailedDetail': { 'zh-CN': '保存失败：{msg}', 'zh-TW': '儲存失敗：{msg}', en: 'Save failed: {msg}' },
  'dropdown.writeCfgFailed': { 'zh-CN': '无法写入配置文件', 'zh-TW': '無法寫入設定檔', en: 'Cannot write settings file' },
  'dropdown.noPersistBridge': { 'zh-CN': '未连接持久化服务，无法保存', 'zh-TW': '未連線至持久化服務，無法儲存', en: 'Persistence bridge unavailable' },
  'dropdown.persistErr': { 'zh-CN': '持久化异常', 'zh-TW': '持久化異常', en: 'Persistence error' },
  'speed.barSvg.aria': { 'zh-CN': '各模型与档位速度对比柱状图', 'zh-TW': '各模型與檔位速度對比長條圖', en: 'Model & effort speed comparison bar chart' },
  'speed.lineSvg.aria': { 'zh-CN': '所选模型与档位历史输出速度折线图', 'zh-TW': '所選模型與檔位歷史輸出速度折線圖', en: 'Selected model & effort speed trend line chart' },
  'client.restart.hostNotSupported': { 'zh-CN': '当前窗口为热注入或预览模式，不支持一键重启客户端，请手动完全退出后重新打开。', 'zh-TW': '目前視窗為熱注入或預覽模式，不支援一鍵重啟用戶端，請手動完全結束後重新開啟。', en: 'Current mode does not support one-click host restart. Fully quit and reopen Antigravity manually.' },
  'client.restart.triggering': { 'zh-CN': '正在通知客户端退出并重启…', 'zh-TW': '正在通知用戶端結束並重新啟動…', en: 'Requesting Antigravity restart…' },
  'client.restart.failed': { 'zh-CN': '无法自动重启：{err}，请手动完全退出后重新打开客户端。', 'zh-TW': '無法自動重啟：{err}，請手動完全結束後重新開啟用戶端。', en: 'Auto-restart failed: {err}. Please quit and reopen Antigravity manually.' },
  'msg.noHostBridge': { 'zh-CN': '未连接到宿主设置桥接', 'zh-TW': '未連線到宿主設定橋接', en: 'Host settings bridge is not connected' },
  'tokens.heat.prevTitle': { 'zh-CN': '上一个周期', 'zh-TW': '上一個週期', en: 'Previous period' },
  'tokens.heat.nextTitle': { 'zh-CN': '下一个周期', 'zh-TW': '下一個週期', en: 'Next period' },
  'tokens.heat.tabsAria': { 'zh-CN': '热力图时间维度', 'zh-TW': '熱力圖時間維度', en: 'Heatmap time dimension' },
  'badge.quota.aria': { 'zh-CN': '模型剩余额度与重置状态', 'zh-TW': '模型剩餘額度與重設狀態', en: 'Model remaining quota and reset status' },
  'overflow.quota': { 'zh-CN': '模型额度', 'zh-TW': '模型額度', en: 'Model Quota' },
  'quota.refresh.aria': { 'zh-CN': '手动刷新模型额度', 'zh-TW': '手動重新整理模型額度', en: 'Refresh model quota' },
  'quota.refresh.btn': { 'zh-CN': '刷新', 'zh-TW': '重新整理', en: 'Refresh' },
  'quota.refresh.busy': { 'zh-CN': '刷新中', 'zh-TW': '更新中', en: 'Syncing' },
  'quota.refresh.upToDate': { 'zh-CN': '已更新', 'zh-TW': '已更新', en: 'Up to date' },
  'quota.retry': { 'zh-CN': '重试', 'zh-TW': '重試', en: 'Retry' },
  'quota.time.updated': { 'zh-CN': '更新 {time}', 'zh-TW': '更新 {time}', en: 'Updated {time}' },
  'quota.time.nextRefresh': { 'zh-CN': '下次自动刷新', 'zh-TW': '下次自動重新整理', en: 'Next Refresh' },
  'quota.time.reset': { 'zh-CN': '当前额度重置', 'zh-TW': '目前額度重設', en: 'Quota Reset' },
  'quota.time.paused': { 'zh-CN': '后台已暂停', 'zh-TW': '背景已暫停', en: 'Paused (bg)' },
  'quota.time.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'quota.current.label': { 'zh-CN': '当前会话模型', 'zh-TW': '目前工作階段模型', en: 'Active Session Model' },
  'quota.current.unmatched': { 'zh-CN': '暂未识别当前模型', 'zh-TW': '暫未識別目前模型', en: 'Active model not detected' },
  'quota.current.tag': { 'zh-CN': '当前使用', 'zh-TW': '目前使用', en: 'Active' },
  'quota.pools.heading': { 'zh-CN': '额度池', 'zh-TW': '額度池', en: 'Quota Pools' },
  'quota.pools.empty': { 'zh-CN': '暂无额度池数据，点击刷新重试。', 'zh-TW': '暫無額度池資料，點擊重新整理重試。', en: 'No quota pool data yet. Click Refresh.' },
  'quota.est.approx': { 'zh-CN': '≈ 剩余 {tokens}', 'zh-TW': '≈ 剩餘 {tokens}', en: '≈ {tokens} left' },
  'quota.est.exhausted': { 'zh-CN': '≈ 剩余 0（额度耗尽）', 'zh-TW': '≈ 剩餘 0（額度耗盡）', en: '0 tokens left (exhausted)' },
  'quota.est.waiting': { 'zh-CN': '暂无法估算（等待有效消耗样本）', 'zh-TW': '暫無法估算（等待有效消耗樣本）', en: 'Estimate unavailable (awaiting samples)' },
  'quota.est.incomplete': { 'zh-CN': '暂无法估算（检测到未采集消耗或采样失真）', 'zh-TW': '暫無法估算（偵測到未採集消耗或採樣失真）', en: 'Estimate unavailable (external usage or sample distortion)' },
  'quota.est.expired': { 'zh-CN': '暂无法估算（历史校准已过期）', 'zh-TW': '暫無法估算（歷史校準已過期）', en: 'Estimate unavailable (calibration expired)' },
  'quota.est.coverageIncomplete': { 'zh-CN': '暂无法估算（缺少本周期完整覆盖记录）', 'zh-TW': '暫無法估算（缺少本週期完整覆蓋記錄）', en: 'Estimate unavailable (incomplete cycle coverage)' },
  'quota.est.basisDelta': { 'zh-CN': '实耗差值校准 · 估算值', 'zh-TW': '實耗差值校準 · 估算值', en: 'Delta calibrated · estimate' },
  'quota.est.basisCycle': { 'zh-CN': '本周期实耗推算 · 估算值', 'zh-TW': '本週期實耗推算 · 估算值', en: 'Cycle usage est. · estimate' },
  'quota.est.basisCached': { 'zh-CN': '沿用上周期校准参考（待本周期复核）', 'zh-TW': '沿用上週期校準參考（待本週期覆核）', en: 'Prior-cycle calibration ref. (unverified)' },
  'quota.est.basisStaleDivergence': { 'zh-CN': '历史校准不可靠（检测到未采集消耗）', 'zh-TW': '歷史校準不可靠（偵測到未採集消耗）', en: 'Stale calibration unreliable (external usage detected)' },
  'quota.est.mixedModels': { 'zh-CN': '同池混用模型', 'zh-TW': '同池混用模型', en: 'mixed pool models' },
  'quota.est.cycleUsed': { 'zh-CN': '本期已用 {used}', 'zh-TW': '本期已用 {used}', en: '{used} used' },
  'quota.state.available': { 'zh-CN': '正常可用', 'zh-TW': '正常可用', en: 'Available' },
  'quota.state.low': { 'zh-CN': '余量较低', 'zh-TW': '餘量較低', en: 'Low' },
  'quota.state.exhausted': { 'zh-CN': '额度耗尽', 'zh-TW': '額度耗盡', en: 'Exhausted' },
  'quota.state.no_permission': { 'zh-CN': '权限不足', 'zh-TW': '權限不足', en: 'No Access' },
  'quota.state.stale': { 'zh-CN': '数据过期', 'zh-TW': '資料過期', en: 'Stale' },
  'quota.state.error': { 'zh-CN': '刷新失败', 'zh-TW': '重新整理失敗', en: 'Failed' },
  'quota.state.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'quota.short.exhausted': { 'zh-CN': '耗尽', 'zh-TW': '耗盡', en: '0% Empty' },
  'quota.short.no_permission': { 'zh-CN': '无权限', 'zh-TW': '無權限', en: 'No Access' },
  'quota.short.error': { 'zh-CN': '失败', 'zh-TW': '失敗', en: 'Failed' },
  'quota.short.stale': { 'zh-CN': '过期', 'zh-TW': '過期', en: 'Stale' },
  'quota.short.unknown': { 'zh-CN': '未知', 'zh-TW': '未知', en: 'Unknown' },
  'quota.staleBanner': { 'zh-CN': '当前展示历史缓存数据（{reason}），请手动刷新确认最新额度。', 'zh-TW': '目前顯示歷史快取資料（{reason}），請手動重新整理確認最新額度。', en: 'Showing cached data ({reason}). Refresh to verify latest quota.' },
  'quota.errorBanner': { 'zh-CN': '额度获取失败：{reason}', 'zh-TW': '額度取得失敗：{reason}', en: 'Quota fetch failed: {reason}' },
  'quota.bridgeMissing': { 'zh-CN': '额度接口桥接尚未加载（如刚完成安装或更新，请重启 Antigravity 后生效）', 'zh-TW': '額度介面橋接尚未載入（如剛完成安裝或更新，請重新啟動 Antigravity 後生效）', en: 'Quota bridge is not loaded yet (restart Antigravity after install/update to activate)' },
  'quota.pendingRestartBanner': { 'zh-CN': '主进程更新尚未重启生效，当前额度或套餐解析可能来自旧版本进程，请重启客户端完成加载。', 'zh-TW': '主程序更新尚未重新啟動生效，目前額度或方案解析可能來自舊版程序，請重新啟動用戶端完成載入。', en: 'Update pending restart: quota/plan parsing may reflect the previous main-process version. Restart client to complete.' },
  'quota.backendMismatchBanner': { 'zh-CN': '界面已热加载为 v{uiVer}，但实际后台仍由旧版 ({backendVer} / {source}) 处理；如需完整新版主进程能力，请重启客户端。', 'zh-TW': '介面已熱載入為 v{uiVer}，但實際後台仍由舊版 ({backendVer} / {source}) 處理；如需完整新版主程序能力，請重新啟動用戶端。', en: 'UI hot-reloaded to v{uiVer}, but backend still runs v{backendVer} ({source}). Restart client to complete upgrade.' },
  'quota.restartBtn': { 'zh-CN': '重启客户端', 'zh-TW': '重新啟動用戶端', en: 'Restart Client' },
  'quota.resetPassReason': { 'zh-CN': '已到重置时间待确认', 'zh-TW': '已到重設時間待確認', en: 'Reset window reached, pending verify' },
  'quota.ageExpiredReason': { 'zh-CN': '距上次获取已超过 3 分钟', 'zh-TW': '距上次取得已超過 3 分鐘', en: 'Cached over 3m ago' },
  'quota.modelChip.tooltip': { 'zh-CN': '{model} · 池: {pool} · {status} ({value})', 'zh-TW': '{model} · 池: {pool} · {status} ({value})', en: '{model} · Pool: {pool} · {status} ({value})' },
  'quota.modelChip.unpooled': { 'zh-CN': '未归属当前账号额度池', 'zh-TW': '未歸屬目前帳號額度池', en: 'Not in active quota pools' },
  'quota.modelChip.resetPart': { 'zh-CN': '重置: {reset}', 'zh-TW': '重設: {reset}', en: 'Reset: {reset}' },
  'quota.modelChip.historyHint': { 'zh-CN': '仅历史记录 / 本地配置', 'zh-TW': '僅歷史記錄 / 本機設定', en: 'History / local preference only' },
  'quota.popover.title': { 'zh-CN': '模型额度', 'zh-TW': '模型額度', en: 'Model Quota' },
  'context.popover.title': { 'zh-CN': '上下文窗口', 'zh-TW': '上下文視窗', en: 'Context Window' },
  'speed.popover.title': { 'zh-CN': '生成速度', 'zh-TW': '生成速度', en: 'Output Speed' },
  'tokens.popover.title': { 'zh-CN': '累计 Token 用量', 'zh-TW': '累計 Token 用量', en: 'Cumulative Usage' },
  'ctx.sub.session': { 'zh-CN': '当前会话', 'zh-TW': '目前工作階段', en: 'Session' },
  'ctx.sub.specs': { 'zh-CN': '窗口规格', 'zh-TW': '視窗規格', en: 'Model Limits' },
  'panel.wb.aria': { 'zh-CN': '指标详情浮层', 'zh-TW': '指標詳情浮層', en: 'Metric Details Popover' },
  'overflow.context': { 'zh-CN': '上下文窗口', 'zh-TW': '上下文視窗', en: 'Context Window' },
  'cost.roiCard.title': { 'zh-CN': '月度订阅实付对比 (USD)', 'zh-TW': '月度訂閱實付對比 (USD)', en: 'Monthly Subscription ROI (USD)' },
  'settings.paneTitle': { 'zh-CN': '面板与顶栏设置', 'zh-TW': '面板與頂欄設定', en: 'Popover & Topbar Settings' },
  'settings.backBtn': { 'zh-CN': '← 返回', 'zh-TW': '← 返回', en: '← Back' },
  'settings.panelLang.label': { 'zh-CN': '界面语言', 'zh-TW': '介面語言', en: 'Language' },
  'settings.appearance.title': { 'zh-CN': '语言、主题与精选配色', 'zh-TW': '語言、主題與精選配色', en: 'Language, Theme & Palettes' },
  'settings.appearance.reset': { 'zh-CN': '恢复默认外观', 'zh-TW': '恢復預設外觀', en: 'Reset Appearance' },
  'settings.themeMode.label': { 'zh-CN': '主题模式', 'zh-TW': '主題模式', en: 'Theme Mode' },
  'settings.themeMode.auto': { 'zh-CN': '跟随宿主', 'zh-TW': '跟隨宿主', en: 'Auto (Host)' },
  'settings.themeMode.dark': { 'zh-CN': '深色', 'zh-TW': '深色', en: 'Dark' },
  'settings.themeMode.light': { 'zh-CN': '浅色', 'zh-TW': '淺色', en: 'Light' },
  'settings.palette.label': { 'zh-CN': '主题配色', 'zh-TW': '主題配色', en: 'Color Palette' },
  'settings.palette.violet': { 'zh-CN': '紫罗兰', 'zh-TW': '紫羅蘭', en: 'Violet' },
  'settings.palette.emerald': { 'zh-CN': '经典绿', 'zh-TW': '經典綠', en: 'Emerald' },
  'settings.palette.ocean': { 'zh-CN': '深海蓝', 'zh-TW': '深海藍', en: 'Ocean' },
  'settings.palette.amber': { 'zh-CN': '琥珀金', 'zh-TW': '琥珀金', en: 'Amber' },
  'settings.palette.graphite': { 'zh-CN': '石墨灰', 'zh-TW': '石墨灰', en: 'Graphite' },
  'settings.pills.title': { 'zh-CN': '顶栏常驻指标', 'zh-TW': '頂欄常駐指標', en: 'Topbar Indicators' },
  'settings.pills.quota': { 'zh-CN': '模型额度', 'zh-TW': '模型額度', en: 'Model Quota' },
  'settings.pills.context': { 'zh-CN': '上下文占比', 'zh-TW': '上下文佔比', en: 'Context %' },
  'settings.pills.speed': { 'zh-CN': '输出速度', 'zh-TW': '輸出速度', en: 'Output Speed' },
  'settings.pills.tokens': { 'zh-CN': '累计用量', 'zh-TW': '累計用量', en: 'Total Tokens' },
  'settings.pills.cli': { 'zh-CN': 'CLI 终端', 'zh-TW': 'CLI 終端', en: 'CLI Terminal' },
  'plan.spend.placeholder': { 'zh-CN': '19.99（免费填 0）', 'zh-TW': '19.99（免費填 0）', en: '19.99 (0 if free)' },
  'plan.spend.btnFree': { 'zh-CN': '设为 $0', 'zh-TW': '設為 $0', en: 'Set $0' },
  'plan.spend.invalid': { 'zh-CN': '请输入大于或等于 0 的美元金额', 'zh-TW': '請輸入大於或等於 0 的美元金額', en: 'Enter a valid USD amount >= 0' },
  'plan.spend.unsetBadge': { 'zh-CN': '未设实付', 'zh-TW': '未設實付', en: 'Spend unset' }
};

function t(key, vars = null) {
  const entry = PANEL_I18N[key];
  let text = entry
    ? (entry[currentPanelLanguage] ?? entry['zh-CN'] ?? key)
    : key;
  if (vars && typeof vars === 'object') {
    text = text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
  }
  return text;
}

function applyStaticPanelTranslations(rootNode = shadow) {
  if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return;
  for (const node of rootNode.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    if (key) node.textContent = t(key);
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-html]')) {
    const key = node.getAttribute('data-i18n-html');
    if (key) node.innerHTML = t(key);
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-title]')) {
    const key = node.getAttribute('data-i18n-title');
    if (key) node.setAttribute('title', t(key));
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-aria]')) {
    const key = node.getAttribute('data-i18n-aria');
    if (key) node.setAttribute('aria-label', t(key));
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-aria-label]')) {
    const key = node.getAttribute('data-i18n-aria-label');
    if (key) node.setAttribute('aria-label', t(key));
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-color-label]')) {
    const key = node.getAttribute('data-i18n-color-label');
    if (key) node.setAttribute('data-color-label', t(key));
  }
  for (const node of rootNode.querySelectorAll('[data-i18n-placeholder]')) {
    const key = node.getAttribute('data-i18n-placeholder');
    if (key) node.setAttribute('placeholder', t(key));
  }
}

const BACKEND_EXACT_TRANSLATIONS = {
  '未知错误': { 'zh-TW': '未知錯誤', en: 'Unknown error' },
  '无效的设置参数': { 'zh-TW': '無效的設定參數', en: 'Invalid settings payload' },
  '宿主暂不支持重启': { 'zh-TW': '宿主暫不支援重新啟動', en: 'Host restart is not supported' },
  '写入失败': { 'zh-TW': '寫入失敗', en: 'Write failed' },
  '未连接到宿主设置桥接': { 'zh-TW': '未連線到宿主設定橋接', en: 'Host settings bridge is not connected' },
  '尚未检测到可选模型，请先开启对话或等待列表读取。': { 'zh-TW': '尚未偵測到可選模型，請先開啟對話或等待清單讀取。', en: 'No models detected yet. Start a chat or wait for the list to load.' },
  '后台尚未就绪': { 'zh-TW': '背景服務尚未就緒', en: 'Backend is not ready yet' },
  '读取超时': { 'zh-TW': '讀取逾時', en: 'Request timed out' },
  '完整重启 Antigravity 后启用附件扫描': { 'zh-TW': '完整重新啟動 Antigravity 後啟用附件掃描', en: 'Fully restart Antigravity to enable attachment scanning' },
  '扫描未返回有效结果': { 'zh-TW': '掃描未回傳有效結果', en: 'Scan returned no valid result' },
  '仅允许本机主聊天窗口': { 'zh-TW': '僅允許本機主聊天視窗', en: 'Local main chat window only' },
  '入账失败': { 'zh-TW': '入帳失敗', en: 'Failed to record usage' }
};


function localizeUnknownLabel(val) {
  if (val === null || val === undefined || val === '') return t('speed.unknown');
  const s = String(val).trim();
  if (s === '未知' || s === 'Unknown' || s.includes('未在当前会话中获取')) return t('speed.unknown');
  return s;
}

function translateBackendText(text) {
  if (text === null || text === undefined) return '';
  const str = String(text);
  if (currentPanelLanguage === 'zh-CN') return str;
  const trimmed = str.trim();
  const hit = BACKEND_EXACT_TRANSLATIONS[trimmed];
  if (hit && hit[currentPanelLanguage]) return hit[currentPanelLanguage];

  // 模式化翻译：ASAR 未注入模块提示
  const asarMissingMatch = trimmed.match(/^当前客户端磁盘\s*ASAR\s*未注入(.+?)组件（或组件不完整）。/);
  if (asarMissingMatch) {
    const modRaw = asarMissingMatch[1].trim();
    if (currentPanelLanguage === 'en') {
      return `${modRaw} module is missing or incomplete in Antigravity app.asar. Quit Antigravity and run node cli.js install from the repository directory.`;
    }
    return `目前用戶端磁碟 ASAR 尚未注入${modRaw}元件（或元件不完整）。請完全結束 Antigravity 後執行 node cli.js install 完成注入。`;
  }

  // 模式化翻译：文件名/目标被占用或锁定
  const inUseMatch = trimmed.match(/^(.+?)\s*被占用$/);
  if (inUseMatch) {
    return currentPanelLanguage === 'en' ? `${inUseMatch[1]} is in use` : `${inUseMatch[1]} 正被佔用`;
  }
  const lockedMatch = trimmed.match(/^(.+?)\s*被锁定$/);
  if (lockedMatch) {
    return currentPanelLanguage === 'en' ? `${lockedMatch[1]} is locked` : `${lockedMatch[1]} 已被鎖定`;
  }
  const colonMatch = trimmed.match(/^([^:：]{2,40})[:：]\s*(.+)$/);
  if (colonMatch) {
    const prefix = colonMatch[1].trim();
    const rest = colonMatch[2].trim();
    const prefixHit = BACKEND_EXACT_TRANSLATIONS[prefix];
    if (prefixHit && prefixHit[currentPanelLanguage]) {
      const sep = currentPanelLanguage === 'en' ? ': ' : '：';
      return `${prefixHit[currentPanelLanguage]}${sep}${translateBackendText(rest)}`;
    }
  }
  // 防止英文模式下未知中文后端文本泄漏造成中英混杂拼接
  if (currentPanelLanguage === 'en' && /[\u4e00-\u9fa5]/.test(trimmed)) {
    return 'Backend operation failed (check desktop log for details)';
  }
  return str;
}

function formatVendorLabel(vendor) {
  if (!vendor) return currentPanelLanguage === 'en' ? 'Other' : '其他';
  if (vendor === '其他') return currentPanelLanguage === 'en' ? 'Other' : '其他';
  return vendor;
}
  (function (root) {
  'use strict';

  const DEFAULT_MAX_TOKENS = 2097152;
  const STOCK_DEFAULT_CLAMP_TOKENS = 256000;

  const STATIC_MODEL_ENUM_MAP = {
    235: 'chat_20706',
    246: 'google_gemini_2_5_pro',
    269: 'chat_23310',
    281: 'claude_4_sonnet',
    282: 'claude_4_sonnet_thinking',
    290: 'claude_4_opus',
    291: 'claude_4_opus_thinking',
    312: 'google_gemini_2_5_flash',
    313: 'google_gemini_2_5_flash_thinking',
    327: 'google_gemini_for_google_2_5_pro',
    328: 'google_gemini_nemosreef',
    329: 'google_gemini_2_5_flash_thinking_tools',
    330: 'google_gemini_2_5_flash_lite',
    331: 'google_gemini_2_5_pro_eval',
    332: 'google_gemini_2_5_flash_image_preview',
    333: 'claude_4_5_sonnet',
    334: 'claude_4_5_sonnet_thinking',
    335: 'google_gemini_computer_use_experimental',
    336: 'google_gemini_horizondawn',
    337: 'google_gemini_pureprism',
    338: 'google_gemini_gentleisland',
    339: 'google_gemini_rainsong',
    340: 'claude_4_5_haiku',
    341: 'claude_4_5_haiku_thinking',
    342: 'openai_gpt_oss_120b_medium',
    343: 'google_gemini_orionfire',
    346: 'google_jarvis_proxy',
    347: 'google_gemini_cosmicforge',
    348: 'google_gemini_riftrunner',
    349: 'google_jarvis_v4s',
    350: 'google_gemini_infinityjet',
    351: 'google_gemini_infinitybloom',
    352: 'google_gemini_riftrunner_thinking_low',
    353: 'google_gemini_riftrunner_thinking_high',
    354: 'google_gemini_example_gemax_sampler'
  };

  function stripModelEnumPrefix(raw) {
    if (raw === null || raw === undefined) return '';
    const s = String(raw).trim();
    if (!s) return '';
    return s.replace(/^MODEL_/i, '');
  }

  function modelEnumNumberToName(num) {
    const n = Number(num);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (STATIC_MODEL_ENUM_MAP[n]) return STATIC_MODEL_ENUM_MAP[n].toUpperCase();
    if (n >= 1000 && n < 2000) return `PLACEHOLDER_M${n - 1000}`;
    return null;
  }

  /**
   * 纯只读汇总模型结构化能力元数据（总窗口、最大输出、理论输入上限、官方默认检查点上限及思考档位）。
   * 不含任何请求拦截或上限改写逻辑。
   */
  function deriveModelCapabilitySummary(product, _unused = null, modelCapabilitiesById = null) {
    const members = Array.isArray(product?.members) ? product.members : [];
    const capById = modelCapabilitiesById && typeof modelCapabilitiesById === 'object' ? modelCapabilitiesById : null;

    const findCapForMember = (m) => {
      if (!capById || !m) return null;
      const candidates = [m.modelId, m.modelOrAlias?.model, m.label]
        .filter(Boolean)
        .map(v => stripModelEnumPrefix(v).toLowerCase());
      for (const k of candidates) {
        if (k && capById[k]) return capById[k];
      }
      return null;
    };

    const tierDetails = [];
    for (const m of members) {
      const extCap = findCapForMember(m);
      const maxTokens = Number.isSafeInteger(Number(m?.maxTokens)) && Number(m.maxTokens) > 0
        ? Number(m.maxTokens)
        : (Number.isSafeInteger(Number(extCap?.maxTokens)) && Number(extCap.maxTokens) > 0 ? Number(extCap.maxTokens) : null);
      const rawOut = m?.maxOutputTokens ?? extCap?.maxOutputTokens;
      const maxOutputTokens = rawOut !== null && rawOut !== undefined && Number.isSafeInteger(Number(rawOut)) && Number(rawOut) >= 0
        ? Number(rawOut)
        : null;
      const thinkingBudget = m?.thinkingBudget ?? extCap?.thinkingBudget ?? null;
      const thinkingLevel = m?.thinkingLevel || extCap?.thinkingLevel || null;
      const capabilitySource = m?.capabilitySource || extCap?.capabilitySource || null;
      if (maxTokens !== null || maxOutputTokens !== null || thinkingLevel || thinkingBudget !== null) {
        tierDetails.push({
          modelId: m.modelId || null,
          effort: m.effort || null,
          maxTokens,
          maxOutputTokens,
          thinkingBudget,
          thinkingLevel,
          capabilitySource
        });
      }
    }

    const withWindow = tierDetails.filter(t => t.maxTokens !== null);
    const withOutput = tierDetails.filter(t => t.maxOutputTokens !== null);
    const uniqueWindows = Array.from(new Set(withWindow.map(t => t.maxTokens)));
    const uniqueOutputs = Array.from(new Set(withOutput.map(t => t.maxOutputTokens)));

    const maxTokens = uniqueWindows.length > 0 ? Math.min(...uniqueWindows) : null;
    const maxOutputTokens = uniqueOutputs.length > 0 ? Math.max(...uniqueOutputs) : null;
    const hasTierVariance = uniqueWindows.length > 1 || uniqueOutputs.length > 1;
    const sources = Array.from(new Set(tierDetails.map(t => t.capabilitySource).filter(Boolean)));

    let modelTheoreticalMaxTokens = null;
    let dynamicDefaultBudget = null;
    let stockDefaultBudget = null;
    if (maxTokens !== null && maxOutputTokens !== null && maxTokens > maxOutputTokens) {
      const reserve = Math.max(maxOutputTokens, 40000);
      dynamicDefaultBudget = maxTokens > reserve ? (maxTokens - reserve) : 0;
      modelTheoreticalMaxTokens = Math.min(DEFAULT_MAX_TOKENS, maxTokens - maxOutputTokens);
      stockDefaultBudget = Math.min(dynamicDefaultBudget, STOCK_DEFAULT_CLAMP_TOKENS);
    }

    let formulaNote = null;
    if (maxTokens !== null && maxOutputTokens !== null && maxTokens > maxOutputTokens) {
      formulaNote = '模型理论输入上限 = maxTokens - maxOutputTokens（宿主原生默认按 min(maxTokens - max(maxOutputTokens, 40,000), 256,000) 分配检查点预算）';
    } else if (maxTokens !== null && maxOutputTokens === null) {
      formulaNote = '宿主仅返回总窗口 maxTokens，缺少 maxOutputTokens，暂无法推导理论输入上限';
    }

    return {
      productKey: product?.productKey || null,
      productLabel: product?.productLabel || null,
      maxTokens,
      maxOutputTokens,
      modelTheoreticalMaxTokens,
      dynamicDefaultBudget,
      stockDefaultBudget,
      effectiveDefaultBudget: stockDefaultBudget,
      hasMetadata: maxTokens !== null && maxOutputTokens !== null,
      hasPartialMetadata: (maxTokens !== null) !== (maxOutputTokens !== null),
      hasTierVariance,
      tierDetails,
      sources,
      formulaNote
    };
  }

  const api = {
    DEFAULT_MAX_TOKENS,
    STOCK_DEFAULT_CLAMP_TOKENS,
    STATIC_MODEL_ENUM_MAP,
    stripModelEnumPrefix,
    modelEnumNumberToName,
    deriveModelCapabilitySummary
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.__AGContextBudgetEngine = api;
  }
})(globalThis);
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


  // =========================================================================
  // 模块 1: 主题模式（跟随宿主 / 深色 / 浅色）、5 套精选配色与顶栏指标显隐控制
  // =========================================================================
  const THEME_MODE_STORAGE_KEY = 'ag_theme_mode';
  const HEAT_PRESET_STORAGE_KEY = 'ag_heat_preset_v1';
  const TOPBAR_PILLS_STORAGE_KEY = 'ag_topbar_pills_v1';

  const LEGACY_PRESET_ALIASES = {
    purple: 'violet',
    green: 'emerald',
    blue: 'ocean',
    yellow: 'amber',
    red: 'amber'
  };

  const HEAT_PRESETS = {
    violet: {
      dark: ['#27272a', '#3f1e6b', '#652ab7', '#9053f8', '#c084fc'],
      light: ['#e4e4e7', '#e9d5ff', '#c084fc', '#9333ea', '#6b21a8'],
      accentDark: '#a78bfa',
      accentLight: '#7c3aed',
      totalDark: '#c084fc',
      totalLight: '#7c3aed'
    },
    emerald: {
      dark: ['#27272a', '#14532d', '#15803d', '#22c55e', '#86efac'],
      light: ['#e4e4e7', '#bbf7d0', '#4ade80', '#16a34a', '#14532d'],
      accentDark: '#34d399',
      accentLight: '#059669',
      totalDark: '#4ade80',
      totalLight: '#15803d'
    },
    ocean: {
      dark: ['#27272a', '#1e3a8a', '#1d4ed8', '#3b82f6', '#93c5fd'],
      light: ['#e4e4e7', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'],
      accentDark: '#60a5fa',
      accentLight: '#2563eb',
      totalDark: '#93c5fd',
      totalLight: '#1d4ed8'
    },
    amber: {
      dark: ['#27272a', '#78350f', '#b45309', '#f59e0b', '#fde68a'],
      light: ['#e4e4e7', '#fde68a', '#fbbf24', '#d97706', '#78350f'],
      accentDark: '#fbbf24',
      accentLight: '#d97706',
      totalDark: '#fcd34d',
      totalLight: '#b45309'
    },
    graphite: {
      dark: ['#232326', '#3f3f46', '#52525b', '#a1a1aa', '#e4e4e7'],
      light: ['#e4e4e7', '#d4d4d8', '#a1a1aa', '#52525b', '#18181b'],
      accentDark: '#d4d4d8',
      accentLight: '#3f3f46',
      totalDark: '#e4e4e7',
      totalLight: '#18181b'
    }
  };

  const TOPBAR_PILL_MAP = {
    quota: 'badge-quota',
    context: 'badge',
    speed: 'badge-speed',
    tokens: 'badge-tokens',
    cli: 'badge-cli'
  };
  const TOPBAR_PILL_KEYS = Object.keys(TOPBAR_PILL_MAP);
  const PANEL_PILL_KEYS = ['quota', 'context', 'speed', 'tokens'];

  function normalizePresetName(rawName) {
    if (!rawName || typeof rawName !== 'string') return 'violet';
    const key = rawName.trim().toLowerCase();
    if (HEAT_PRESETS[key]) return key;
    if (LEGACY_PRESET_ALIASES[key]) return LEGACY_PRESET_ALIASES[key];
    return 'violet';
  }

  let currentThemeMode = 'auto';
  let heatPreset = 'violet';
  const topbarPills = {
    quota: true,
    context: true,
    speed: true,
    tokens: true,
    cli: true
  };

  try {
    if (typeof localStorage !== 'undefined') {
      const savedMode = localStorage.getItem(THEME_MODE_STORAGE_KEY);
      if (savedMode && ['auto', 'dark', 'light'].includes(savedMode)) {
        currentThemeMode = savedMode;
      }
      const savedPreset = localStorage.getItem(HEAT_PRESET_STORAGE_KEY);
      if (savedPreset) {
        heatPreset = normalizePresetName(savedPreset);
      }
      const savedPillsRaw = localStorage.getItem(TOPBAR_PILLS_STORAGE_KEY);
      if (savedPillsRaw) {
        const parsedPills = JSON.parse(savedPillsRaw);
        if (parsedPills && typeof parsedPills === 'object') {
          for (const k of TOPBAR_PILL_KEYS) {
            if (typeof parsedPills[k] === 'boolean') topbarPills[k] = parsedPills[k];
          }
          if (!PANEL_PILL_KEYS.some(k => topbarPills[k])) {
            topbarPills.context = true;
          }
        }
      }
    }
  } catch {}

  function clampNum(n, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
  }

  function rgbToHex(r, g, b) {
    const to2 = v => clampNum(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    return `#${to2(r)}${to2(g)}${to2(b)}`;
  }

  function hexToRgb(hexStr) {
    if (!hexStr || typeof hexStr !== 'string') return null;
    const clean = hexStr.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(clean)) return null;
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
    const num = parseInt(full, 16);
    if (Number.isNaN(num)) return null;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function hslToRgb(h, s, l) {
    const hn = ((Number(h) % 360) + 360) % 360;
    const sn = clampNum(Number(s), 0, 100) / 100;
    const ln = clampNum(Number(l), 0, 100) / 100;
    const c = (1 - Math.abs(2 * ln - 1)) * sn;
    const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    const m = ln - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (hn < 60) { r1 = c; g1 = x; }
    else if (hn < 120) { r1 = x; g1 = c; }
    else if (hn < 180) { g1 = c; b1 = x; }
    else if (hn < 240) { g1 = x; b1 = c; }
    else if (hn < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255)
    };
  }

  function normalizeHex(input) {
    if (!input || typeof input !== 'string') return null;
    const s = input.trim();
    if (!s || /^transparent$/i.test(s)) return null;
    const direct = hexToRgb(s);
    if (direct) return rgbToHex(direct.r, direct.g, direct.b);
    const mRgb = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*[,/]\s*([\d.]+%?))?/i);
    if (mRgb) {
      if (mRgb[4] !== undefined) {
        const alphaRaw = mRgb[4].endsWith('%') ? Number(mRgb[4].slice(0, -1)) / 100 : Number(mRgb[4]);
        if (!Number.isNaN(alphaRaw) && alphaRaw <= 0.01) return null;
      }
      return rgbToHex(Number(mRgb[1]), Number(mRgb[2]), Number(mRgb[3]));
    }
    const mHsl = s.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?(?:\s*[,/]\s*([\d.]+%?))?/i);
    if (mHsl) {
      if (mHsl[4] !== undefined) {
        const alphaRaw = mHsl[4].endsWith('%') ? Number(mHsl[4].slice(0, -1)) / 100 : Number(mHsl[4]);
        if (!Number.isNaN(alphaRaw) && alphaRaw <= 0.01) return null;
      }
      const rgb = hslToRgb(Number(mHsl[1]), Number(mHsl[2]), Number(mHsl[3]));
      return rgbToHex(rgb.r, rgb.g, rgb.b);
    }
    return null;
  }

  function parseRgbLuminance(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    const rgb = hexToRgb(normalizeHex(colorStr));
    if (rgb) return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return null;
  }

  function getHostZeroLevelBg(isLight) {
    const fallback = isLight ? '#ffffff' : '#181818';
    try {
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const rootEl = document.body || document.documentElement;
        if (rootEl) {
          const cs = window.getComputedStyle(rootEl);
          const candidates = [
            cs.getPropertyValue('--background')?.trim(),
            cs.backgroundColor?.trim()
          ].filter(Boolean);
          for (const raw of candidates) {
            const norm = normalizeHex(raw);
            if (!norm) continue;
            const lum = parseRgbLuminance(norm);
            const normIsLight = lum != null ? lum > 0.55 : Boolean(isLight);
            if (normIsLight === Boolean(isLight)) return norm;
            return fallback;
          }
        }
      }
    } catch {}
    return fallback;
  }

  function getSystemTheme() {
    try {
      const body = document.body;
      const doc = document.documentElement;
      if (body?.classList?.contains('theme-light') || body?.classList?.contains('light') || doc?.classList?.contains('light') || body?.classList?.contains('vscode-light')) return 'light';
      if (body?.classList?.contains('theme-dark') || body?.classList?.contains('dark') || doc?.classList?.contains('dark') || body?.classList?.contains('vscode-dark')) return 'dark';
      if (doc?.style?.colorScheme === 'light') return 'light';
      if (doc?.style?.colorScheme === 'dark') return 'dark';
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && (body || doc)) {
        const cs = window.getComputedStyle(body || doc);
        const bgVar = cs.getPropertyValue('--background') || cs.backgroundColor;
        const lum = parseRgbLuminance(bgVar);
        if (lum != null) return lum > 0.55 ? 'light' : 'dark';
      }
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
      }
    } catch {}
    return 'dark';
  }

  function resolveTheme() {
    if (currentThemeMode === 'light') return 'light';
    if (currentThemeMode === 'dark') return 'dark';
    return getSystemTheme();
  }

  function getEffectiveHeatmapScale() {
    const isLight = resolveTheme() === 'light';
    const presetObj = HEAT_PRESETS[heatPreset] || HEAT_PRESETS.violet;
    return (isLight ? presetObj.light : presetObj.dark).slice();
  }

  function getActiveAccentColor() {
    const isLight = resolveTheme() === 'light';
    const presetObj = HEAT_PRESETS[heatPreset] || HEAT_PRESETS.violet;
    return isLight ? presetObj.accentLight : presetObj.accentDark;
  }

  function persistAppearancePreferences() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(THEME_MODE_STORAGE_KEY, currentThemeMode);
        localStorage.setItem(HEAT_PRESET_STORAGE_KEY, heatPreset);
        localStorage.setItem(TOPBAR_PILLS_STORAGE_KEY, JSON.stringify(topbarPills));
      }
    } catch {}
    if (typeof saveSettingsPayloadBridge === 'function') {
      void saveSettingsPayloadBridge({
        themeMode: currentThemeMode,
        heatPreset,
        topbarPills: { ...topbarPills }
      });
    }
  }

  function applyHeatmapPalette() {
    const isLight = resolveTheme() === 'light';
    const presetObj = HEAT_PRESETS[heatPreset] || HEAT_PRESETS.violet;
    const scale = isLight ? presetObj.light : presetObj.dark;
    const accent = isLight ? presetObj.accentLight : presetObj.accentDark;
    const totalCol = isLight ? presetObj.totalLight : presetObj.totalDark;

    for (let i = 0; i < 5; i++) {
      host.style.setProperty(`--ag-heat-lvl-${i}`, scale[i]);
      const legEl = el(`heat-leg-${i}`);
      if (legEl) {
        legEl.style.background = scale[i];
      }
    }
    host.style.setProperty('--ag-custom-token-accent', accent);
    host.style.setProperty('--ag-custom-token-total', totalCol);

    try {
      const group = el('heat-preset-group');
      if (group?.querySelectorAll) {
        group.querySelectorAll('[data-heat-preset]').forEach(btn => {
          const pName = normalizePresetName(btn.getAttribute('data-heat-preset'));
          const active = pName === heatPreset;
          btn.setAttribute('data-active', String(active));
          btn.setAttribute('aria-pressed', String(active));
          if (btn.classList) btn.classList.toggle('active', active);
        });
      } else {
        for (const pKey of Object.keys(HEAT_PRESETS)) {
          const btn = el(`preset-btn-${pKey}`);
          if (btn) {
            const active = pKey === heatPreset;
            btn.setAttribute('data-active', String(active));
            btn.setAttribute('aria-pressed', String(active));
          }
        }
      }
    } catch {}
  }

  function refreshActiveChartViews() {
    if (typeof activeHeatView !== 'undefined') {
      if (activeHeatView === 'weekly' && typeof renderHeatmapWeekly === 'function') renderHeatmapWeekly();
      else if (activeHeatView === 'monthly' && typeof renderHeatmapMonthly === 'function') renderHeatmapMonthly();
      else if (activeHeatView === 'yearly' && typeof renderHeatmapYearly === 'function') renderHeatmapYearly();
      else if (activeHeatView === 'cum' && typeof renderHeatmapCum === 'function') renderHeatmapCum();
      if (typeof updateHeatTabThumb === 'function') updateHeatTabThumb();
    }
    const modelViewEl = el('model-usage-view');
    if (modelViewEl && modelViewEl.style && modelViewEl.style.display === 'block' && typeof renderModelUsageView === 'function') {
      renderModelUsageView();
    }
  }

  function syncThemeModeButtons() {
    for (const mode of ['auto', 'dark', 'light']) {
      const btn = el(`btn-theme-mode-${mode}`);
      if (!btn) continue;
      const isActive = currentThemeMode === mode;
      btn.classList?.toggle?.('active', isActive);
      const cls = String(btn.getAttribute('class') || 'ctx-seg-btn').replace(/\bactive\b/g, '').trim();
      btn.setAttribute('class', isActive ? `${cls} active` : cls);
      btn.setAttribute('aria-pressed', String(isActive));
    }
  }

  function applyTheme() {
    const activeTheme = resolveTheme();
    host.setAttribute('data-theme', activeTheme);
    const hostBg = getHostZeroLevelBg(activeTheme === 'light');
    host.style.setProperty('--ag-host-bg', hostBg);
    const btns = [el('theme-toggle'), el('theme-toggle-tokens')].filter(Boolean);
    btns.forEach(btn => {
      if (currentThemeMode === 'auto') {
        btn.textContent = activeTheme === 'light' ? '🌗' : '🌓';
        btn.title = t('theme.autoTitle', { mode: activeTheme === 'light' ? t('theme.light') : t('theme.dark') });
      } else if (currentThemeMode === 'light') {
        btn.textContent = '☀️';
        btn.title = t('theme.lightTitle');
      } else {
        btn.textContent = '🌙';
        btn.title = t('theme.darkTitle');
      }
    });
    syncThemeModeButtons();
    applyHeatmapPalette();
    refreshActiveChartViews();
  }

  function setThemeMode(mode, options = {}) {
    if (!['auto', 'dark', 'light'].includes(mode)) return false;
    currentThemeMode = mode;
    applyTheme();
    if (options.persist !== false) {
      persistAppearancePreferences();
    } else {
      try { localStorage?.setItem(THEME_MODE_STORAGE_KEY, currentThemeMode); } catch {}
    }
    return true;
  }

  function cycleTheme() {
    const next = currentThemeMode === 'auto' ? 'light' : (currentThemeMode === 'light' ? 'dark' : 'auto');
    setThemeMode(next, { persist: true });
  }

  function setHeatPreset(presetName, options = {}) {
    const norm = normalizePresetName(presetName);
    if (!HEAT_PRESETS[norm]) return false;
    heatPreset = norm;
    applyHeatmapPalette();
    refreshActiveChartViews();
    if (options.persist !== false) {
      persistAppearancePreferences();
    } else {
      try { localStorage?.setItem(HEAT_PRESET_STORAGE_KEY, heatPreset); } catch {}
    }
    return true;
  }

  function applyTopbarPills(incomingPills = null, options = {}) {
    if (incomingPills && typeof incomingPills === 'object') {
      for (const k of TOPBAR_PILL_KEYS) {
        if (typeof incomingPills[k] === 'boolean') {
          topbarPills[k] = incomingPills[k];
        }
      }
      if (!PANEL_PILL_KEYS.some(k => topbarPills[k])) {
        topbarPills.context = true;
      }
    }

    const enabledPanelCount = PANEL_PILL_KEYS.filter(k => topbarPills[k]).length;

    for (const key of TOPBAR_PILL_KEYS) {
      const visible = Boolean(topbarPills[key]);
      const badgeEl = el(TOPBAR_PILL_MAP[key]);
      if (badgeEl) {
        if (visible) {
          badgeEl.removeAttribute('data-user-hidden');
          badgeEl.hidden = false;
        } else {
          badgeEl.setAttribute('data-user-hidden', 'true');
          badgeEl.hidden = true;
        }
      }
      const chkEl = el(`chk-pill-${key}`);
      if (chkEl) {
        chkEl.checked = visible;
        const isLastPanelEntry = PANEL_PILL_KEYS.includes(key) && visible && enabledPanelCount <= 1;
        chkEl.disabled = isLastPanelEntry;
      }
    }

    if (!topbarPills.context) {
      host.setAttribute('data-context-hidden', 'true');
    } else {
      host.removeAttribute('data-context-hidden');
    }

    if (options.persist) {
      persistAppearancePreferences();
    } else {
      try { localStorage?.setItem(TOPBAR_PILLS_STORAGE_KEY, JSON.stringify(topbarPills)); } catch {}
    }

    if (!options.skipLayout && typeof updateResponsiveLayout === 'function') {
      updateResponsiveLayout(true);
    }
  }

  function setTopbarPillVisible(key, visible, options = {}) {
    if (!Object.prototype.hasOwnProperty.call(TOPBAR_PILL_MAP, key)) return false;
    const nextVal = Boolean(visible);
    if (!nextVal && PANEL_PILL_KEYS.includes(key)) {
      const remainingPanels = PANEL_PILL_KEYS.filter(k => k !== key && topbarPills[k]);
      if (remainingPanels.length === 0) {
        applyTopbarPills(null, { persist: false, skipLayout: true });
        return false;
      }
    }
    topbarPills[key] = nextVal;
    applyTopbarPills(null, { persist: options.persist !== false, skipLayout: options.skipLayout });
    return true;
  }

  function getTopbarPills() {
    return { ...topbarPills };
  }

  function resetAppearanceDefaults(options = {}) {
    currentThemeMode = 'auto';
    heatPreset = 'violet';
    for (const k of TOPBAR_PILL_KEYS) topbarPills[k] = true;
    applyTheme();
    applyTopbarPills(null, { persist: options.persist !== false });
  }

  let themeObserver = null;
  try {
    if (typeof MutationObserver !== 'undefined' && document.body) {
      themeObserver = new MutationObserver(() => {
        if (currentThemeMode === 'auto') applyTheme();
      });
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
      if (document.documentElement) {
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
      }
    }
  } catch {}

  for (const mode of ['auto', 'dark', 'light']) {
    el(`btn-theme-mode-${mode}`)?.addEventListener('click', () => {
      ++userActionSeq;
      setThemeMode(mode, { persist: true });
    });
  }

  for (const pKey of Object.keys(HEAT_PRESETS)) {
    el(`preset-btn-${pKey}`)?.addEventListener('click', () => {
      ++userActionSeq;
      setHeatPreset(pKey, { persist: true });
    });
  }

  for (const pillKey of TOPBAR_PILL_KEYS) {
    el(`chk-pill-${pillKey}`)?.addEventListener('change', (e) => {
      if (isHydratingUiControls) return;
      ++userActionSeq;
      const ok = setTopbarPillVisible(pillKey, Boolean(e.target?.checked), { persist: true });
      if (!ok && e.target) e.target.checked = true;
    });
  }

  el('btn-reset-appearance')?.addEventListener('click', () => {
    ++userActionSeq;
    resetAppearanceDefaults({ persist: true });
  });

  applyTheme();
  applyTopbarPills(null, { persist: false, skipLayout: true });
  function closeAllDropdowns(exceptWrap = null) {
    const rootScope = (typeof shadow !== 'undefined' && shadow && shadow.querySelectorAll) ? shadow : (typeof document !== 'undefined' ? document : null);
    try {
      rootScope?.querySelectorAll?.('.ag-dropdown-wrapper.is-open')?.forEach(w => {
        if (w !== exceptWrap) removeClass(w, 'is-open');
      });
    } catch {}
  }

  function initDropdownController(cfg) {
    const wrap = el(cfg.wrapId);
    const trigger = el(cfg.triggerId);
    const label = el(cfg.labelId);
    const menu = el(cfg.menuId);
    const linkedSelect = cfg.selectId ? el(cfg.selectId) : null;
    if (!wrap || !trigger || !label || !menu) return null;
    if (trigger._bound) return wrap._controller || null;
    trigger._bound = true;

    let keyboardFocusIndex = -1;
    let listScrollTimer = null;
    let lastClosedMenuSig = '';
    const renderedItemMap = new Map();

    function clearListScrollTimer() {
      if (listScrollTimer) {
        clearTimeout(listScrollTimer);
        listScrollTimer = null;
      }
    }

    function focusNoScroll(targetEl) {
      if (!targetEl || typeof targetEl.focus !== 'function') return;
      try {
        targetEl.focus({ preventScroll: true });
      } catch {
        targetEl.focus();
      }
    }

    function scrollChildNearestInContainer(scrollBox, childEl) {
      if (!scrollBox || !childEl) return;
      if (typeof scrollBox.getBoundingClientRect !== 'function' || typeof childEl.getBoundingClientRect !== 'function') return;
      try {
        const boxRect = scrollBox.getBoundingClientRect();
        const itemRect = childEl.getBoundingClientRect();
        if (!boxRect || !itemRect || boxRect.height <= 0 || itemRect.height <= 0) return;
        const searchBar = menu.querySelector ? menu.querySelector('.ag-dropdown-search-wrap') : null;
        const stickyTopH = (searchBar && typeof searchBar.getBoundingClientRect === 'function')
          ? Math.max(0, Math.round(searchBar.getBoundingClientRect().height || 0))
          : 0;
        const visTop = boxRect.top + stickyTopH;
        const visBottom = boxRect.bottom;
        const curScroll = Number(scrollBox.scrollTop) || 0;
        if (itemRect.top < visTop) {
          scrollBox.scrollTop = Math.max(0, curScroll - (visTop - itemRect.top + 4));
        } else if (itemRect.bottom > visBottom) {
          scrollBox.scrollTop = curScroll + (itemRect.bottom - visBottom + 4);
        }
      } catch { }
    }

    function renderMenu(kw = '', menuOpts = {}) {
      clearListScrollTimer();
      menu.innerHTML = '';
      if (typeof menu.replaceChildren === 'function') menu.replaceChildren();
      keyboardFocusIndex = -1;

      const searchWrap = document.createElement('div');
      searchWrap.className = 'ag-dropdown-search-wrap';
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'ag-dropdown-search-input';
      searchInput.placeholder = (typeof cfg.searchPlaceholder === 'function' ? cfg.searchPlaceholder() : cfg.searchPlaceholder) || t('dropdown.searchPlaceholder');
      searchInput.value = kw;
      searchWrap.appendChild(searchInput);
      menu.appendChild(searchWrap);

      searchInput.addEventListener('click', (e) => e?.stopPropagation?.());
      searchInput.addEventListener('input', (e) => {
        renderList(e.target.value.trim().toLowerCase(), { scrollSelected: false });
      });

      const listContainer = document.createElement('div');
      listContainer.className = 'ag-dropdown-list-container';
      menu.appendChild(listContainer);

      let visibleItems = [];

      function updateKeyboardHighlight(newIdx) {
        const itemEls = listContainer.querySelectorAll ? listContainer.querySelectorAll('.ag-dropdown-item') : (listContainer.children || []);
        if (!itemEls.length) return;
        keyboardFocusIndex = Math.max(0, Math.min(newIdx, itemEls.length - 1));
        Array.from(itemEls).forEach((elNode, idx) => {
          if (idx === keyboardFocusIndex) {
            addClass(elNode, 'is-keyboard-focus');
            scrollChildNearestInContainer(menu, elNode);
          } else {
            removeClass(elNode, 'is-keyboard-focus');
          }
        });
      }

      function renderList(searchKey = '', listOpts = {}) {
        clearListScrollTimer();
        if (typeof listContainer.replaceChildren === 'function') listContainer.replaceChildren();
        listContainer.innerHTML = '';
        renderedItemMap.clear();
        const allItems = cfg.getOptions();
        const selectedVal = cfg.getSelectedValue();

        const matchesItem = it => {
          if (!searchKey) return true;
          if (cfg.filterItem) return cfg.filterItem(it, searchKey);
          const t1 = String(it.label || '').toLowerCase();
          const t2 = String(it.value || '').toLowerCase();
          const t3 = String(it.code || '').toLowerCase();
          const aliases = (it.aliases || []).map(a => String(a).toLowerCase());
          return t1.includes(searchKey) || t2.includes(searchKey) || t3.includes(searchKey) || aliases.some(a => a.includes(searchKey));
        };

        const renderEntries = [];
        let pendingHeader = null;
        visibleItems = [];
        for (const it of allItems) {
          if (it && it.isGroupHeader) {
            pendingHeader = it;
            continue;
          }
          if (matchesItem(it)) {
            if (pendingHeader) {
              renderEntries.push(pendingHeader);
              pendingHeader = null;
            }
            renderEntries.push(it);
            visibleItems.push(it);
          }
        }

        if (!visibleItems.length) {
          const emptyDiv = document.createElement('div');
          emptyDiv.style.cssText = 'padding:10px;text-align:center;color:var(--ag-text-muted);font-size:11px';
          emptyDiv.textContent = (typeof cfg.emptyText === 'function' ? cfg.emptyText() : cfg.emptyText) || t('dropdown.empty');
          listContainer.appendChild(emptyDiv);
          return;
        }

        let selectableIdx = 0;
        renderEntries.forEach((opt) => {
          if (opt && opt.isGroupHeader) {
            const groupEl = document.createElement('div');
            groupEl.className = 'ag-dropdown-group-title';
            groupEl.setAttribute?.('role', 'presentation');
            if (opt.dotColor) {
              const dot = document.createElement('span');
              dot.className = 'ag-vendor-dot';
              dot.style.backgroundColor = opt.dotColor;
              groupEl.appendChild(dot);
            }
            const lbl = document.createElement('span');
            lbl.textContent = opt.label || '';
            groupEl.appendChild(lbl);
            listContainer.appendChild(groupEl);
            return;
          }

          const idx = selectableIdx++;
          const itemEl = document.createElement('div');
          const isSelected = cfg.isItemSelected ? cfg.isItemSelected(opt, selectedVal) : (opt.value === selectedVal);
          itemEl.className = 'ag-dropdown-item' + (isSelected ? ' is-selected' : '');
          itemEl.setAttribute?.('data-index', String(idx));
          itemEl.setAttribute?.('data-value', String(opt.value || ''));
          if (opt.tooltip) itemEl.title = opt.tooltip;

          const leftSpan = document.createElement('span');
          leftSpan.className = 'ag-dropdown-item-label';
          leftSpan.textContent = opt.displayLeft || opt.label;
          if (!itemEl.title && leftSpan.textContent) itemEl.title = leftSpan.textContent;
          itemEl.appendChild(leftSpan);

          if (opt.badgeText) {
            const b = document.createElement('span');
            b.className = 'ag-dropdown-badge';
            b.textContent = opt.badgeText;
            itemEl.appendChild(b);
          }

          const rightSpan = document.createElement('span');
          rightSpan.className = 'ag-dropdown-item-sub';
          if (opt.displayRight) {
            rightSpan.textContent = opt.displayRight;
          }

          const extraEl = typeof cfg.renderOptionExtras === 'function' ? cfg.renderOptionExtras(opt) : null;

          const check = document.createElement('span');
          check.className = 'ag-dropdown-item-check';
          check.textContent = '✓';

          if (extraEl) {
            const rightGroup = document.createElement('span');
            rightGroup.className = 'ag-dropdown-item-right';
            rightGroup.appendChild(extraEl);
            if (opt.displayRight) rightGroup.appendChild(rightSpan);
            itemEl.appendChild(rightGroup);
          } else if (opt.displayRight) {
            itemEl.appendChild(rightSpan);
          }
          itemEl.appendChild(check);

          renderedItemMap.set(opt.value, { itemEl, extraEl });

          itemEl.addEventListener('click', (e) => {
            e?.stopPropagation?.();
            selectOption(opt);
          });

          listContainer.appendChild(itemEl);
        });

        if (listOpts.scrollSelected === true) {
          listScrollTimer = setTimeout(() => {
            listScrollTimer = null;
            if (!hasClass(wrap, 'is-open')) return;
            const selNode = listContainer.querySelector ? listContainer.querySelector('.ag-dropdown-item.is-selected') : null;
            scrollChildNearestInContainer(menu, selNode);
          }, 30);
        }
      }

      function selectOption(opt) {
        clearListScrollTimer();
        clearInputFocusTimer();
        removeClass(wrap, 'is-open');
        const text = cfg.getLabelText ? cfg.getLabelText(opt) : (opt.label || opt.value);
        label.textContent = text;
        if (linkedSelect) {
          runWithUiHydration(() => {
            linkedSelect.value = opt.value;
          });
        }
        if (cfg.onSelect) cfg.onSelect(opt);
        focusNoScroll(trigger);
      }

      renderList(kw, menuOpts);

      const keyHandler = (e) => {
        if (!hasClass(wrap, 'is-open')) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault?.();
          updateKeyboardHighlight(keyboardFocusIndex + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault?.();
          updateKeyboardHighlight(keyboardFocusIndex <= 0 ? 0 : keyboardFocusIndex - 1);
        } else if (e.key === 'Enter') {
          e.preventDefault?.();
          if (keyboardFocusIndex >= 0 && visibleItems[keyboardFocusIndex]) {
            selectOption(visibleItems[keyboardFocusIndex]);
          } else if (visibleItems.length === 1) {
            selectOption(visibleItems[0]);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault?.();
          clearListScrollTimer();
          clearInputFocusTimer();
          removeClass(wrap, 'is-open');
          focusNoScroll(trigger);
        }
      };

      searchInput.addEventListener('keydown', keyHandler);
      menu.addEventListener('keydown', keyHandler);
    }

    let inputFocusTimer = null;
    function clearInputFocusTimer() {
      if (inputFocusTimer) {
        clearTimeout(inputFocusTimer);
        inputFocusTimer = null;
      }
    }

    renderMenu('', { scrollSelected: false });

    function toggleOpen() {
      const isOpen = hasClass(wrap, 'is-open');
      if (!isOpen) {
        closeAllDropdowns(wrap);
        clearInputFocusTimer();

        try {
          const rect = trigger.getBoundingClientRect?.() || { bottom: 0, top: 0 };
          const spaceBelow = (typeof window !== 'undefined' ? (window.innerHeight || 800) : 800) - rect.bottom;
          if (spaceBelow < 240 && rect.top > 240) {
            addClass(wrap, 'open-up');
          } else {
            removeClass(wrap, 'open-up');
          }
        } catch {
          removeClass(wrap, 'open-up');
        }

        addClass(wrap, 'is-open');
        renderMenu('', { scrollSelected: true });
        inputFocusTimer = setTimeout(() => {
          inputFocusTimer = null;
          if (!hasClass(wrap, 'is-open')) return;
          const input = menu.querySelector ? menu.querySelector('.ag-dropdown-search-input') : null;
          focusNoScroll(input);
        }, 50);
      } else {
        clearListScrollTimer();
        clearInputFocusTimer();
        removeClass(wrap, 'is-open');
      }
    }

    trigger.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      toggleOpen();
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault?.();
        toggleOpen();
      } else if (e.key === 'Escape') {
        clearListScrollTimer();
        clearInputFocusTimer();
        removeClass(wrap, 'is-open');
      }
    });

    const controller = {
      refresh: () => {
        const val = cfg.getSelectedValue();
        const opts = cfg.getOptions();
        const found = opts.find(o => !o.isGroupHeader && o.value === val);
        const nextText = found
          ? (cfg.getLabelText ? cfg.getLabelText(found) : (found.label || found.value))
          : (typeof cfg.emptyLabel === 'function' ? cfg.emptyLabel() : cfg.emptyLabel);
        if (nextText != null && label.textContent !== nextText) {
          label.textContent = nextText;
        }
        if (!hasClass(wrap, 'is-open')) {
          const optsSig = `${val || ''}|` + opts.map(o => `${o.value || ''}:${o.label || ''}:${o.displayRight || ''}:${o.badgeText || ''}:${o.isGroupHeader ? 1 : 0}`).join(';');
          if (optsSig !== lastClosedMenuSig) {
            lastClosedMenuSig = optsSig;
            renderMenu('', { scrollSelected: false });
          }
        }
      },
      isOpen: () => hasClass(wrap, 'is-open'),
      updateItemsInPlace: (updater) => {
        if (typeof updater !== 'function') return;
        for (const [val, entry] of renderedItemMap.entries()) {
          updater(val, entry.itemEl, entry.extraEl);
        }
      },
      close: () => {
        clearListScrollTimer();
        clearInputFocusTimer();
        removeClass(wrap, 'is-open');
      },
      open: () => toggleOpen()
    };
    wrap._controller = controller;
    return controller;
  }

  if (typeof shadow !== 'undefined' && shadow && shadow.addEventListener) {
    shadow.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.ag-dropdown-wrapper')) {
        closeAllDropdowns();
      }
    });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.ag-dropdown-wrapper')) {
        closeAllDropdowns();
      }
    });
  }

  // =========================================================================
  // 极简订阅月度实付（纯 USD）持久化与详情折叠控制器
  // =========================================================================
  let planDetailExpanded = false;
  let lastSavedCustomPlan = null;
  let lastSaveResult = { ok: true, error: '' };
  let saveFeedbackTimer = null;
  let currentSaveSeq = 0;

  function showPlanSaveFeedback(ok, message) {
    lastSaveResult = { ok: Boolean(ok), error: ok ? '' : (message || t('dropdown.saveFailed')) };
    const fb = el('plan-save-feedback');
    if (!fb) return;
    if (saveFeedbackTimer) {
      clearTimeout(saveFeedbackTimer);
      saveFeedbackTimer = null;
    }
    fb.style.display = 'inline-block';
    fb.style.color = ok ? '#22c55e' : '#ef4444';
    fb.textContent = ok ? (message || t('dropdown.autoSaved')) : t('dropdown.saveFailedDetail', { msg: message || t('dropdown.writeCfgFailed') });
    if (ok) {
      saveFeedbackTimer = setTimeout(() => {
        if (fb) fb.style.display = 'none';
        saveFeedbackTimer = null;
      }, 2800);
    }
  }

  function setPlanDetailExpanded(expanded, options = {}) {
    planDetailExpanded = Boolean(expanded);
    if (!options.skipReposition && typeof positionFloatingPanels === 'function') {
      positionFloatingPanels();
    }
    return planDetailExpanded;
  }

  async function persistSettingsToHost(payload = {}) {
    const thisSeq = ++currentSaveSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = payload.email || ps.email || 'default';
    const customObj = payload.customPlan || null;

    const hasIpc = typeof window !== 'undefined' && typeof window.contextMeterAPI?.saveSettings === 'function';
    const hasLive = typeof window !== 'undefined' && Boolean(window.__AGContextMeterLive?.port);
    if (!hasIpc && !hasLive) {
      showPlanSaveFeedback(false, t('dropdown.noPersistBridge'));
      return { ok: false, error: 'NO_HOST_BRIDGE' };
    }

    try {
      let res = null;
      const savePayload = { ...payload, email, saveSeq: thisSeq };
      if (typeof callBackendWithPriority === 'function') {
        const out = await callBackendWithPriority({
          ipcCall: hasIpc ? () => window.contextMeterAPI.saveSettings(savePayload) : null,
          liveRoute: '/save-settings',
          liveBody: savePayload
        });
        res = out.result;
      } else if (hasIpc) {
        res = await window.contextMeterAPI.saveSettings(savePayload);
      } else if (hasLive) {
        const live = window.__AGContextMeterLive;
        const resp = await fetch(`http://127.0.0.1:${live.port}/save-settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify(savePayload)
        });
        if (!resp.ok) {
          showPlanSaveFeedback(false, `HTTP ${resp.status}`);
          return { ok: false, error: `HTTP ${resp.status}` };
        }
        res = await resp.json().catch(() => null);
      }

      if (thisSeq < currentSaveSeq) {
        return { ok: true, superseded: true };
      }

      if (!res || res.ok === false) {
        const errMsg = translateBackendText(res?.error) || t('dropdown.writeCfgFailed');
        showPlanSaveFeedback(false, errMsg);
        return { ok: false, error: errMsg };
      }

      if (payload.clearPlan) {
        lastSavedCustomPlan = null;
        ANTIGRAVITY_TOKEN_DATA.customPlanSettings = null;
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = {
            ...(window.__AGContextMeterSettings || {}),
            ok: true,
            customPlan: null
          };
        }
        try {
          if (email && email !== 'default') localStorage?.removeItem('ag_custom_plan_' + String(email).toLowerCase());
          localStorage?.removeItem('ag_custom_plan_default');
        } catch {}
      } else {
        const savedPlan = res.customPlan || customObj;
        lastSavedCustomPlan = savedPlan ? { ...savedPlan } : null;
        ANTIGRAVITY_TOKEN_DATA.customPlanSettings = lastSavedCustomPlan;
        if (typeof window !== 'undefined' && savedPlan) {
          window.__AGContextMeterSettings = {
            ...(window.__AGContextMeterSettings || {}),
            ok: true,
            customPlan: { ...savedPlan }
          };
        }
        try {
          if (savedPlan) {
            const jsonStr = JSON.stringify(savedPlan);
            if (email && email !== 'default') {
              localStorage?.setItem('ag_custom_plan_' + String(email).toLowerCase(), jsonStr);
            }
            localStorage?.setItem('ag_custom_plan_default', jsonStr);
          }
        } catch {}
      }

      showPlanSaveFeedback(true, t('dropdown.autoSaved'));
      return res;
    } catch (err) {
      if (thisSeq >= currentSaveSeq) {
        showPlanSaveFeedback(false, err?.message || t('dropdown.persistErr'));
      }
      return { ok: false, error: err?.message || t('dropdown.persistErr') };
    }
  }

  function applyCustomPlanObjectLocally(customObj, email = 'default') {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const rawLive = ANTIGRAVITY_TOKEN_DATA.rawPlanStatus || null;
    ANTIGRAVITY_TOKEN_DATA.customPlanSettings = customObj ? { ...customObj } : null;

    if (core && core.resolveEffectivePlanStatus) {
      ANTIGRAVITY_TOKEN_DATA.planStatus = core.resolveEffectivePlanStatus(rawLive, customObj, { currentEmail: email });
    } else if (customObj) {
      const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
      const spend = customObj.monthlySpendUSD !== undefined ? customObj.monthlySpendUSD : customObj.actualPricePaid;
      ANTIGRAVITY_TOKEN_DATA.planStatus = {
        ...ps,
        currency: 'USD',
        currencySymbol: '$',
        actualPricePaid: spend ?? null,
        monthlySpendUSD: spend ?? null,
        isZeroExtraCost: spend === 0,
        priceMode: spend !== null && spend !== undefined ? 'custom' : 'unset',
        priceSource: spend !== null && spend !== undefined ? 'custom' : 'unset'
      };
    }
    renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
    renderActiveCostEstimateView();
    if (typeof renderActiveHeatView === 'function') renderActiveHeatView(false);
  }

  function saveMonthlySpendUSD(rawVal) {
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const str = rawVal !== undefined && rawVal !== null ? String(rawVal).trim() : (el('input-monthly-spend-usd')?.value?.trim() ?? '');
    if (str === '') {
      clearMonthlySpendUSD();
      return false;
    }
    const num = Number(str);
    if (!Number.isFinite(num) || num < 0) {
      showPlanSaveFeedback(false, t('plan.spend.invalid'));
      return false;
    }
    const cleanUSD = Number(num.toFixed(2));
    const customObj = {
      account: email,
      currency: 'USD',
      currencySymbol: '$',
      actualPricePaid: cleanUSD,
      monthlySpendUSD: cleanUSD,
      isZeroExtraCost: cleanUSD === 0,
      priceMode: 'custom',
      updatedAt: new Date().toISOString()
    };
    applyCustomPlanObjectLocally(customObj, email);
    void persistSettingsToHost({ email, customPlan: customObj });
    return true;
  }

  function clearMonthlySpendUSD() {
    ++userActionSeq;
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const email = ps.email || 'default';
    const rawLive = ANTIGRAVITY_TOKEN_DATA.rawPlanStatus || null;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    ANTIGRAVITY_TOKEN_DATA.customPlanSettings = null;
    if (core && core.resolveEffectivePlanStatus) {
      ANTIGRAVITY_TOKEN_DATA.planStatus = core.resolveEffectivePlanStatus(rawLive, null, { currentEmail: email });
    }
    const inp = el('input-monthly-spend-usd');
    if (inp) inp.value = '';
    renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
    renderActiveCostEstimateView();
    if (typeof renderActiveHeatView === 'function') renderActiveHeatView(false);
    void persistSettingsToHost({ email, clearPlan: true });
    return true;
  }

  el('btn-monthly-spend-save')?.addEventListener('click', () => {
    saveMonthlySpendUSD();
  });
  el('btn-monthly-spend-free')?.addEventListener('click', () => {
    const inp = el('input-monthly-spend-usd');
    if (inp) inp.value = '0';
    saveMonthlySpendUSD(0);
  });
  el('btn-monthly-spend-clear')?.addEventListener('click', () => {
    clearMonthlySpendUSD();
  });
  el('input-monthly-spend-usd')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault?.();
      saveMonthlySpendUSD();
    }
  });
  // =========================================================================
  // 一对一专属浮层状态路由、共享设置页、重启确认弹窗与全局点击/ESC 关闭 (popover-router.js)
  // =========================================================================
  const CTX_ACTIVE_TAB_KEY = 'ag_ctx_active_tab';
  let activeWorkbenchTab = 'context'; // 'quota' | 'context' | 'speed' | 'tokens'
  let activeContextSubmode = 'session'; // 'session' | 'models' (only within 'context' popover)
  let activeContextTab = 'session';   // 'session' | 'models' | 'speed' | 'quota' | 'tokens' | 'settings'
  let isContextSettingsView = false;
  let activePanelAnchorId = 'badge';

  try {
    const savedTab = localStorage?.getItem(CTX_ACTIVE_TAB_KEY);
    if (savedTab === 'models') {
      activeWorkbenchTab = 'context';
      activeContextSubmode = 'models';
      activeContextTab = 'models';
    } else if (savedTab === 'speed' || savedTab === 'quota' || savedTab === 'tokens') {
      activeWorkbenchTab = savedTab;
      activeContextTab = savedTab;
    } else if (savedTab === 'session') {
      activeWorkbenchTab = 'context';
      activeContextSubmode = 'session';
      activeContextTab = 'session';
    }
  } catch { }

  function syncActiveContextTabAlias() {
    if (isContextSettingsView) {
      activeContextTab = 'settings';
    } else if (activeWorkbenchTab === 'context') {
      activeContextTab = activeContextSubmode === 'models' ? 'models' : 'session';
    } else {
      activeContextTab = activeWorkbenchTab;
    }
    return activeContextTab;
  }

  let restartTimeoutTimer = null;
  let hostSupportsRestart = true;

  const btnTabSession = el('tab-ctx-session');
  const btnTabModels = el('tab-ctx-models');
  const paneSession = el('pane-ctx-session');
  const paneQuota = el('panel-quota');
  const paneTokens = el('panel-tokens');
  const paneModels = el('pane-ctx-models');
  const paneSpeed = el('pane-ctx-speed');
  const paneSettings = el('pane-ctx-settings');
  const ctxTabsBar = el('ctx-tabs-bar');
  const btnCtxSettings = el('btn-ctx-settings');
  const btnCtxSettingsBack = el('btn-ctx-settings-back');
  const btnCardGotoSpeed = el('btn-card-goto-speed');
  const btnCtxBackCurrent = el('btn-ctx-back-current');

  const globalRestartModal = el('global-restart-modal');
  const modalRestartFeedback = el('modal-restart-feedback');
  const btnModalRestartCancel = el('btn-modal-restart-cancel');
  const btnModalRestartConfirm = el('btn-modal-restart-confirm');

  function isAnyPanelOpen() {
    return !el('panel').hidden;
  }

  function syncTopbarAriaExpanded(panelIsOpen) {
    const bContext = el('badge');
    const bSpeed = el('badge-speed');
    const bTokens = el('badge-tokens');
    const bQuota = el('badge-quota');
    if (!panelIsOpen || isContextSettingsView) {
      bContext?.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens?.setAttribute('aria-expanded', 'false');
      bQuota?.setAttribute('aria-expanded', 'false');
      return;
    }
    bQuota?.setAttribute('aria-expanded', String(activeWorkbenchTab === 'quota'));
    bTokens?.setAttribute('aria-expanded', String(activeWorkbenchTab === 'tokens'));
    bSpeed?.setAttribute('aria-expanded', String(activeWorkbenchTab === 'speed'));
    bContext?.setAttribute('aria-expanded', String(activeWorkbenchTab === 'context'));
  }

  function triggerActiveWorkbenchSideEffects() {
    if (isContextSettingsView) return;
    if (activeWorkbenchTab === 'tokens') {
      renderActiveHeatView(true);
      const hasCachedHistory = Boolean(ANTIGRAVITY_TOKEN_DATA.updatedAt || ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens);
      if (!hasCachedHistory || !lastHistorySync || (Date.now() - lastHistorySync) > 15000) {
        void syncTokenHistoryFromHost(false);
      }
    } else if (activeWorkbenchTab === 'quota') {
      if (typeof renderQuotaBoard === 'function') renderQuotaBoard();
      if (typeof maybeRefreshQuotaOnOpen === 'function') void maybeRefreshQuotaOnOpen();
    } else if (activeWorkbenchTab === 'speed') {
      renderSpeedComparisonTab?.();
    } else if (activeWorkbenchTab === 'context' && activeContextSubmode === 'models') {
      renderModelSettingsTab?.();
      if (typeof syncModelListQuotaIndicators === 'function') syncModelListQuotaIndicators(null, Date.now(), true);
    }
  }

  function showPanel(target, opts = {}) {
    const pPanel = el('panel');
    const pTokens = el('panel-tokens');
    const pQuota = el('panel-quota');
    const pSpeed = el('pane-ctx-speed');
    const pOverflow = el('overflow-menu');
    const bOverflow = el('badge-overflow');

    if (pOverflow) pOverflow.hidden = true;
    bOverflow?.setAttribute('aria-expanded', 'false');

    if (!target || target === 'none') {
      if (typeof clearQuotaBarChargeAnimations === 'function') {
        clearQuotaBarChargeAnimations();
      }
      pPanel.hidden = true;
      if (pTokens) pTokens.hidden = true;
      if (pQuota) pQuota.hidden = true;
      if (pSpeed) pSpeed.hidden = true;
      syncTopbarAriaExpanded(false);
      hidePopover();
      syncHostStackingElevation(false);
      return;
    }

    hideContextTooltip();
    if (opts.anchorId) {
      activePanelAnchorId = opts.anchorId;
    }

    if (target === 'tokens') {
      activeWorkbenchTab = 'tokens';
      isContextSettingsView = false;
    } else if (target === 'quota') {
      activeWorkbenchTab = 'quota';
      isContextSettingsView = false;
    } else if (target === 'speed') {
      activeWorkbenchTab = 'speed';
      isContextSettingsView = false;
    } else if (target === 'models') {
      activeWorkbenchTab = 'context';
      activeContextSubmode = 'models';
      isContextSettingsView = false;
    } else if (target === 'settings') {
      isContextSettingsView = true;
    } else if (target === 'session') {
      activeWorkbenchTab = 'context';
      activeContextSubmode = 'session';
      isContextSettingsView = false;
    } else if (target === 'context') {
      if (!opts.preserveTab) {
        activeWorkbenchTab = 'context';
        activeContextSubmode = 'session';
        isContextSettingsView = false;
      }
    }

    if (activeWorkbenchTab !== 'quota' && typeof clearQuotaBarChargeAnimations === 'function') {
      clearQuotaBarChargeAnimations();
    }

    syncActiveContextTabAlias();
    try {
      if (!isContextSettingsView) localStorage?.setItem(CTX_ACTIVE_TAB_KEY, activeContextTab);
    } catch { }

    syncTopbarAriaExpanded(true);
    syncHostStackingElevation(true);
    positionFloatingPanels();
    pPanel.hidden = false;
    applyContextViewVisibility?.();
    triggerActiveWorkbenchSideEffects();
  }

  function toggle(open, tab = 'session') {
    if (!open) {
      showPanel('none');
    } else {
      showPanel(tab === 'context' ? 'session' : tab);
    }
  }

  function toggleContext(anchorId = 'badge') {
    if (!el('panel').hidden && !isContextSettingsView && activeWorkbenchTab === 'context' && activePanelAnchorId === anchorId) {
      showPanel('none');
    } else {
      showPanel('session', { anchorId: anchorId || 'badge' });
    }
  }

  function toggleSpeed(anchorId = 'badge-speed') {
    if (!el('panel').hidden && !isContextSettingsView && activeWorkbenchTab === 'speed' && activePanelAnchorId === anchorId) {
      showPanel('none');
    } else {
      showPanel('speed', { anchorId: anchorId || 'badge-speed' });
    }
  }

  function toggleTokens(anchorId = 'badge-tokens') {
    if (!el('panel').hidden && !isContextSettingsView && activeWorkbenchTab === 'tokens' && activePanelAnchorId === anchorId) {
      showPanel('none');
    } else {
      showPanel('tokens', { anchorId: anchorId || 'badge-tokens' });
    }
  }

  function toggleQuota(anchorId = 'badge-quota') {
    if (!el('panel').hidden && !isContextSettingsView && activeWorkbenchTab === 'quota' && activePanelAnchorId === anchorId) {
      showPanel('none');
    } else {
      showPanel('quota', { anchorId: anchorId || 'badge-quota' });
    }
  }

  function toggleOverflowMenu() {
    const pOverflow = el('overflow-menu');
    if (!pOverflow) return;
    const willOpen = pOverflow.hidden;
    showPanel('none');
    hideContextTooltip();
    if (willOpen) positionFloatingPanels();
    pOverflow.hidden = !willOpen;
    el('badge-overflow')?.setAttribute('aria-expanded', String(willOpen));
    syncHostStackingElevation(willOpen);
  }
  el('badge-quota')?.addEventListener('click', () => toggleQuota('badge-quota'));
  el('badge').addEventListener('click', () => toggleContext('badge'));
  el('badge-speed')?.addEventListener('click', () => toggleSpeed('badge-speed'));
  el('badge-tokens').addEventListener('click', () => toggleTokens('badge-tokens'));
  el('badge-overflow')?.addEventListener('click', toggleOverflowMenu);
  el('overflow-context-btn')?.addEventListener('click', () => {
    showPanel('session', { anchorId: 'badge-overflow' });
  });
  el('overflow-quota-btn')?.addEventListener('click', () => {
    showPanel('quota', { anchorId: 'badge-overflow' });
  });
  el('overflow-speed-btn')?.addEventListener('click', () => {
    showPanel('speed', { anchorId: 'badge-overflow' });
  });
  el('overflow-tokens-btn')?.addEventListener('click', () => {
    showPanel('tokens', { anchorId: 'badge-overflow' });
  });
  el('close').addEventListener('click', () => showPanel('none'));

  function applyContextViewVisibility() {
    syncActiveContextTabAlias();
    const isPanelVisible = !el('panel')?.hidden;

    // 专属浮层动态标题：点哪个胶囊就纯粹显示对应领域的标题，无跨界总 Tab
    const mainTitleEl = el('panel-main-title');
    if (mainTitleEl) {
      const titleKey = isContextSettingsView
        ? 'settings.paneTitle'
        : activeWorkbenchTab === 'quota'
          ? 'quota.popover.title'
          : activeWorkbenchTab === 'speed'
            ? 'speed.popover.title'
            : activeWorkbenchTab === 'tokens'
              ? 'tokens.popover.title'
              : 'context.popover.title';
      mainTitleEl.setAttribute?.('data-i18n', titleKey);
      mainTitleEl.textContent = t(titleKey);
    }
    const verEl = el('v');
    if (verEl) {
      verEl.hidden = !isContextSettingsView;
    }
    if (btnCtxSettingsBack) {
      btnCtxSettingsBack.hidden = !isContextSettingsView;
    }

    // [当前会话 | 窗口规格] 轻量双切换仅在「上下文窗口」专属浮层显示
    if (ctxTabsBar) {
      ctxTabsBar.hidden = isContextSettingsView || activeWorkbenchTab !== 'context';
    }

    if (paneSettings) paneSettings.hidden = !isContextSettingsView;
    if (paneQuota) paneQuota.hidden = !isPanelVisible || isContextSettingsView || activeWorkbenchTab !== 'quota';
    if (paneTokens) paneTokens.hidden = !isPanelVisible || isContextSettingsView || activeWorkbenchTab !== 'tokens';
    if (paneSpeed) paneSpeed.hidden = !isPanelVisible || isContextSettingsView || activeWorkbenchTab !== 'speed';
    if (paneSession) paneSession.hidden = isContextSettingsView || activeWorkbenchTab !== 'context' || activeContextSubmode !== 'session';
    if (paneModels) paneModels.hidden = isContextSettingsView || activeWorkbenchTab !== 'context' || activeContextSubmode !== 'models';

    // 顶栏额度更新时间与刷新按钮仅在「模型额度」专属浮层可见
    const showQuotaHeaderActions = !isContextSettingsView && activeWorkbenchTab === 'quota';
    const quotaTimeUpdatedEl = el('quota-time-updated');
    if (quotaTimeUpdatedEl) {
      quotaTimeUpdatedEl.hidden = !showQuotaHeaderActions;
    }
    const btnQuotaRefreshEl = el('btn-quota-refresh');
    if (btnQuotaRefreshEl) {
      btnQuotaRefreshEl.hidden = !showQuotaHeaderActions;
    }
    if (btnCtxSettings) {
      btnCtxSettings.setAttribute('aria-pressed', String(isContextSettingsView));
    }

    const isCtxSession = !isContextSettingsView && activeWorkbenchTab === 'context' && activeContextSubmode === 'session';
    const isCtxModels = !isContextSettingsView && activeWorkbenchTab === 'context' && activeContextSubmode === 'models';
    setPillActive(btnTabSession, isCtxSession);
    setPillActive(btnTabModels, isCtxModels);
    btnTabSession?.setAttribute('aria-selected', String(isCtxSession));
    btnTabModels?.setAttribute('aria-selected', String(isCtxModels));
  }

  let prevTabBeforeSettings = 'session';

  function switchContextTab(tabName) {
    if (tabName !== 'session' && tabName !== 'quota' && tabName !== 'tokens' && tabName !== 'models' && tabName !== 'speed' && tabName !== 'settings') return;
    if (!isContextSettingsView && tabName === 'settings') {
      prevTabBeforeSettings = syncActiveContextTabAlias();
    }

    if (tabName === 'settings') {
      isContextSettingsView = true;
    } else {
      isContextSettingsView = false;
      if (tabName === 'speed') {
        activeWorkbenchTab = 'speed';
      } else if (tabName === 'models') {
        activeWorkbenchTab = 'context';
        activeContextSubmode = 'models';
      } else if (tabName === 'session') {
        activeWorkbenchTab = 'context';
        activeContextSubmode = 'session';
      } else {
        activeWorkbenchTab = tabName;
      }
      if (activeWorkbenchTab !== 'quota' && typeof clearQuotaBarChargeAnimations === 'function') {
        clearQuotaBarChargeAnimations();
      }
    }

    const nextAlias = syncActiveContextTabAlias();
    try {
      if (!isContextSettingsView) localStorage?.setItem(CTX_ACTIVE_TAB_KEY, nextAlias);
    } catch { }

    applyContextViewVisibility();
    syncTopbarAriaExpanded(!el('panel')?.hidden);
    triggerActiveWorkbenchSideEffects();
    positionFloatingPanels();
  }

  function openContextSettings() {
    if (el('panel')?.hidden) showPanel('context', { preserveTab: true });
    switchContextTab('settings');
    positionFloatingPanels();
  }

  function closeContextSettings() {
    switchContextTab(prevTabBeforeSettings || 'session');
    positionFloatingPanels();
  }

  btnTabSession?.addEventListener('click', () => switchContextTab('session'));
  btnTabModels?.addEventListener('click', () => switchContextTab('models'));
  btnCtxSettings?.addEventListener('click', () => {
    if (isContextSettingsView) closeContextSettings();
    else openContextSettings();
  });
  btnCtxSettingsBack?.addEventListener('click', () => closeContextSettings());

  btnCardGotoSpeed?.addEventListener('click', () => {
    const products = getKnownModelProducts();
    const curProd = products.find(p => p.productKey === selectedProductKey) || products[0];
    if (curProd) {
      const mergedCalls = mergeAvailableSpeedCalls();
      const targetMember = curProd.members.find(m => m.modelId === activeSessionModelKey)
        || curProd.members.find(m => mergedCalls.some(c => c.modelExactId === m.modelId && isValidSpeedSampleSafe(c)))
        || curProd.members[0];
      if (targetMember) selectedSpeedExactModelId = targetMember.modelId;
    }
    const speedBtn = el('badge-speed');
    if (speedBtn && speedBtn.getAttribute?.('data-user-hidden') !== 'true') {
      activePanelAnchorId = 'badge-speed';
    }
    switchContextTab('speed');
  });

  btnCtxBackCurrent?.addEventListener('click', () => {
    const hostSelected = extractHostSelectedModel();
    if (hostSelected && hostSelected.productKey) {
      activeSessionModelKey = hostSelected.modelId;
      activeSessionProductKey = hostSelected.productKey;
      activeSessionEffort = hostSelected.effort;
      activeSessionModelConfirmed = true;
    } else if (activeSessionProductKey) {
      const curProd = getKnownModelProducts().find(p => p.productKey === activeSessionProductKey);
      if (curProd && curProd.isHistorical) {
        activeSessionModelConfirmed = false;
        activeSessionProductKey = null;
        activeSessionModelKey = null;
      }
    }
    if (!activeSessionModelConfirmed || !activeSessionProductKey) return;
    manualModelSelection = false;
    selectedProductKey = activeSessionProductKey;
    selectedEditModelKey = activeSessionModelKey || activeSessionProductKey;
    renderHeaderModelDropdown();
    renderModelSettingsTab();
  });

  applyContextViewVisibility();

  async function saveSettingsPayloadBridge(payload = {}) {
    const ipcFn = window.contextMeterAPI?.saveSettings
      ? () => window.contextMeterAPI.saveSettings(payload)
      : null;
    if (!ipcFn && !hasLiveHttpBridge()) {
      return { ok: false, error: t('msg.noHostBridge') };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute: '/save-settings',
        liveBody: payload
      });
      return out.result || { ok: false, error: t('msg.noHostBridge') };
    } catch (e) {
      return { ok: false, error: e?.message || t('msg.noHostBridge') };
    }
  }

  async function invokeRestartHostApi() {
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.restartHost === 'function') {
      return await window.contextMeterAPI.restartHost();
    }
    if (hasLiveHttpBridge()) {
      try {
        return await postLiveHttpEndpoint('/restart-host', {});
      } catch {
        return { ok: true, supported: false };
      }
    }
    return { ok: true, supported: false };
  }

  let isRestartInProgress = false;

  async function executeClientRestart() {
    if (isRestartInProgress) return;
    isRestartInProgress = true;
    if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = true;

    if (modalRestartFeedback) {
      modalRestartFeedback.textContent = t('client.restart.triggering');
      modalRestartFeedback.hidden = false;
    }

    const res = await invokeRestartHostApi();
    if (!res || res.supported === false) {
      hostSupportsRestart = false;
      if (modalRestartFeedback) {
        modalRestartFeedback.textContent = t('client.restart.hostNotSupported');
        modalRestartFeedback.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      return;
    }
    if (res.ok === false) {
      if (modalRestartFeedback) {
        modalRestartFeedback.textContent = t('client.restart.failed', { err: translateBackendText(res.error) || t('msg.unknownErr') });
        modalRestartFeedback.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      return;
    }

    if (modalRestartFeedback) {
      modalRestartFeedback.textContent = t('models.restart.restarting');
      modalRestartFeedback.hidden = false;
    }
    if (restartTimeoutTimer) clearTimeout(restartTimeoutTimer);
    restartTimeoutTimer = setTimeout(() => {
      if (!state.disposed && modalRestartFeedback) {
        modalRestartFeedback.textContent = t('models.restart.notExited');
        modalRestartFeedback.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
    }, 15000);
  }

  function openClientRestartConfirmFlow() {
    if (!hostSupportsRestart) {
      renderQuotaBoard?.();
      return;
    }
    if (globalRestartModal) {
      if (modalRestartFeedback) {
        modalRestartFeedback.textContent = '';
        modalRestartFeedback.hidden = true;
      }
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      isRestartInProgress = false;
      globalRestartModal.hidden = false;
    }
  }

  btnModalRestartCancel?.addEventListener('click', () => {
    if (globalRestartModal) globalRestartModal.hidden = true;
  });
  globalRestartModal?.addEventListener('click', (e) => {
    if (e.target === globalRestartModal) {
      globalRestartModal.hidden = true;
    }
  });
  btnModalRestartConfirm?.addEventListener('click', () => executeClientRestart());

  // -------------------------------------------------------------
  // 插件面板显示语言（自动跟随宿主 / 简 / 繁 / EN，仅作用于本插件 Shadow DOM 面板）
  // -------------------------------------------------------------
  const panelLangBtns = {
    'zh-CN': el('btn-panel-lang-zh-CN'),
    'zh-TW': el('btn-panel-lang-zh-TW'),
    en: el('btn-panel-lang-en')
  };
  const panelTopLangBtns = {
    'zh-CN': el('btn-top-lang-zh-CN'),
    'zh-TW': el('btn-top-lang-zh-TW'),
    en: el('btn-top-lang-en')
  };
  const panelLangSaveBadge = el('panel-lang-save-badge');

  function syncPanelLanguageButtons(lang) {
    const activeKey = normalizePanelLanguage(lang ?? currentPanelLanguage);
    for (const [k, btn] of Object.entries(panelLangBtns)) {
      if (!btn) continue;
      const active = k === activeKey;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    }
    for (const [k, btn] of Object.entries(panelTopLangBtns)) {
      if (!btn) continue;
      const active = k === activeKey;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
      btn.setAttribute?.('aria-selected', String(active));
    }
  }

  async function applyPanelLanguage(lang, opts = {}) {
    const nextLang = normalizePanelLanguage(lang);
    const persist = opts.persist !== false;
    setPanelLanguageInternal(nextLang);
    syncPanelLanguageButtons(nextLang);
    applyStaticPanelTranslations(shadow);

    try {
      if (colorDrawerArrow && colorDrawerBody) {
        const open = colorDrawerBody.style.display === 'block';
        colorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      if (drawerArrow && drawerBody) {
        const open = drawerBody.style.display === 'block';
        drawerArrow.textContent = open ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
      }
      if (tokenColorDrawerArrow && tokenColorDrawerBody) {
        const open = tokenColorDrawerBody.style.display === 'block';
        tokenColorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      const btnCostDet = el('btn-cost-details-toggle');
      const costDetBody = el('cost-details-pane');
      if (btnCostDet && costDetBody) {
        const open = costDetBody.style.display === 'block';
        btnCostDet.textContent = open ? t('cost.btnCollapse') : t('cost.btnExpand');
      }
      const btnPlanDet = el('btn-plan-detail-toggle');
      if (btnPlanDet) {
        btnPlanDet.textContent = planDetailExpanded ? t('plan.detail.toggleClose') : t('plan.detail.toggleOpen');
      }
    } catch { }
    try { if (typeof applyTheme === 'function') applyTheme(); } catch { }
    try { render(); } catch { }
    try { renderSessionCost(); } catch { }
    try { if (typeof renderQuotaBoard === 'function') renderQuotaBoard(); } catch { }
    try { renderHeaderModelDropdown(); } catch { }
    try { renderModelSettingsTab(); } catch { }
    try { renderSpeedComparisonTab(); } catch { }
    try {
      if (typeof renderPlanDetail === 'function' && ANTIGRAVITY_TOKEN_DATA?.planStatus) {
        renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
      } else {
        const pv = el('plan-summary-price-val');
        if (pv && /^\$19\.99\/(月|mo)$/.test(String(pv.textContent || '').trim())) {
          pv.textContent = `$19.99${t('plan.summary.perMonth')}`;
        }
      }
      if (typeof refreshRegionPresetSelectOptions === 'function') refreshRegionPresetSelectOptions();
      if (typeof refreshDirectCountryDisplay === 'function') refreshDirectCountryDisplay();
      if (typeof refreshDirectRegionDisplay === 'function') refreshDirectRegionDisplay();
      if (typeof refreshDirectCurrencyDisplay === 'function') refreshDirectCurrencyDisplay();
    } catch { }
    try {
      if (typeof applyTokenHistoryPayload === 'function' && ANTIGRAVITY_TOKEN_DATA) {
        applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA);
      }
    } catch { }

    if (persist) {
      userActionSeq++;
      try { localStorage?.setItem('ag_panel_language', nextLang); } catch { }
      const res = await saveSettingsPayloadBridge({
        panelLanguage: nextLang,
        uiPreferences: { panelLanguage: nextLang }
      });
      if (panelLangSaveBadge) {
        panelLangSaveBadge.textContent = res?.ok ? t('settings.panelLang.saved') : t('settings.panelLang.saveLocal');
        panelLangSaveBadge.className = `key-pill ${res?.ok ? 'pill-ok' : 'pill-warn'}`;
        panelLangSaveBadge.hidden = false;
      }
    }
  }

  function setPanelLanguageInternal(lang) {
    currentPanelLanguage = normalizePanelLanguage(lang);
  }

  for (const [langCode, btn] of Object.entries(panelLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  for (const [langCode, btn] of Object.entries(panelTopLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  async function restoreSettingsFromHost() {
    if (state.disposed) return;
    const thisSeq = ++restoreRequestSeq;
    const startActionSeq = userActionSeq;
    try {
      let settingsRes = null;
      const currentEmail = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || 'default';

      // 权威配置同步：宿主通信桥接可用时，以宿主最新持久化配置为准，避免启动快照覆盖最新状态
      const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getSettings === 'function')
        ? () => window.contextMeterAPI.getSettings({ email: currentEmail })
        : null;
      if (ipcFn || hasLiveHttpBridge()) {
        try {
          const out = await callBackendWithPriority({
            ipcCall: ipcFn,
            liveRoute: '/get-settings',
            liveBody: { email: currentEmail }
          });
          settingsRes = out.result;
        } catch { }
      }
      if (!settingsRes?.ok && typeof window !== 'undefined' && window.__AGContextMeterSettings?.ok) {
        settingsRes = window.__AGContextMeterSettings;
      }

      // 若在网络等待期间有更新的恢复请求完成或用户发生了最新主动修改，丢弃旧回包！
      if (thisSeq < restoreRequestSeq || userActionSeq > startActionSeq) {
        return;
      }

      if (settingsRes?.ok) {
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = {
            ...(window.__AGContextMeterSettings || {}),
            ok: true,
            ...(settingsRes.customPlan ? { customPlan: { ...settingsRes.customPlan } } : {}),
            uiPreferences: { ...(settingsRes.uiPreferences || {}) }
          };
        }
        renderHeaderModelDropdown();
        renderModelSettingsTab();
        const savedView = settingsRes.savedHeatView || settingsRes.uiPreferences?.savedHeatView;
        if (savedView && ['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(savedView)) {
          switchHeatView(savedView, false);
        }
        const savedTheme = settingsRes.themeMode || settingsRes.uiPreferences?.themeMode;
        if (savedTheme && ['auto', 'dark', 'light'].includes(savedTheme)) {
          setThemeMode(savedTheme, { persist: false });
        }
        const savedPreset = settingsRes.heatPreset || settingsRes.uiPreferences?.heatPreset;
        if (savedPreset) {
          setHeatPreset(savedPreset, { persist: false });
        }
        const savedPills = settingsRes.topbarPills || settingsRes.uiPreferences?.topbarPills;
        if (savedPills && typeof savedPills === 'object') {
          runWithUiHydration(() => {
            applyTopbarPills(savedPills, { persist: false });
          });
        }
        const savedLang = settingsRes.panelLanguage || settingsRes.uiPreferences?.panelLanguage;
        if (savedLang && VALID_PANEL_LANGUAGES.has(savedLang)) {
          if (savedLang !== currentPanelLanguage) {
            await applyPanelLanguage(savedLang, { persist: false });
          } else {
            syncPanelLanguageButtons(savedLang);
          }
        }
      } else {
        try {
          const localLang = localStorage?.getItem('ag_panel_language');
          if (localLang && VALID_PANEL_LANGUAGES.has(localLang)) {
            if (localLang !== currentPanelLanguage) {
              await applyPanelLanguage(localLang, { persist: false });
            } else {
              syncPanelLanguageButtons(localLang);
            }
          }
        } catch { }
      }

      if (settingsRes?.ok && settingsRes.customPlan && typeof settingsRes.customPlan === 'object') {
        lastSavedCustomPlan = { ...settingsRes.customPlan };
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = {
            ...(window.__AGContextMeterSettings || {}),
            ok: true,
            customPlan: { ...settingsRes.customPlan }
          };
        }

        const email = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || settingsRes.customPlan?.account || currentEmail || 'default';
        try {
          const jsonStr = JSON.stringify(settingsRes.customPlan);
          if (email && email !== 'default') localStorage?.setItem('ag_custom_plan_' + String(email).toLowerCase(), jsonStr);
          localStorage?.setItem('ag_custom_plan_default', jsonStr);
        } catch { }
        applyCustomPlanObjectLocally(settingsRes.customPlan, email);
      } else {
        // 回退检查 localStorage
        const email = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || 'default';
        const key = email && email !== 'default' ? 'ag_custom_plan_' + String(email).toLowerCase() : 'ag_custom_plan_default';
        const savedRaw = localStorage?.getItem(key) || localStorage?.getItem('ag_custom_plan_default');
        if (savedRaw) {
          const parsed = JSON.parse(savedRaw);
          if (parsed && typeof parsed === 'object') {
            lastSavedCustomPlan = { ...parsed };
            applyCustomPlanObjectLocally(parsed, parsed.account || email);
          }
        }
      }
    } catch { }
  }

  const outside = e => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (!path.includes(host)) {
      toggle(false);
      hideContextTooltip();
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
    }
  };
  const escape = e => {
    if (e.key === 'Escape') {
      toggle(false);
      hideContextTooltip();
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      el('badge')?.focus?.();
    }
  };
  document.addEventListener('click', outside);
  document.addEventListener('keydown', escape);


  function getWorkbenchStateForTestImpl() {
    return {
      open: !el('panel')?.hidden,
      activeTab: activeWorkbenchTab,
      contextSubmode: activeContextSubmode,
      activeContextTab: syncActiveContextTabAlias(),
      settingsOpen: isContextSettingsView,
      wide: isWideWorkbench(),
      anchorId: activePanelAnchorId
    };
  }
  // =========================================================================
  // 顶栏停靠、原生窗口控制区测量、渐进式宽度响应与浮层物理像素定位 (topbar-dock.js)
  // =========================================================================
  let resizeObserver = null;
  let hostDomObserver = null;
  let observedTitlebar = null;
  let layoutRaf = 0;
  const earlyDisposeHooks = [];
  const earlyForceDispose = () => {
    state.disposed = true;
    for (const controller of state.controllers) {
      try { controller.abort(); } catch { }
    }
    if (layoutRaf && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(layoutRaf); } catch { }
      layoutRaf = 0;
    }
    while (earlyDisposeHooks.length) {
      const hook = earlyDisposeHooks.pop();
      try { hook(); } catch { }
    }
    try { resizeObserver?.disconnect?.(); } catch { }
    try { hostDomObserver?.disconnect?.(); } catch { }
    if (globalThis.__AGContextMeterActiveHost === host) {
      globalThis.__AGContextMeterActiveHost = null;
    }
    activeDisposers.delete(earlyForceDispose);
    try { host.remove?.(); } catch { }
  };
  globalThis.__AGContextMeterActiveHost = host;
  host.__agForceDispose = earlyForceDispose;
  activeDisposers.add(earlyForceDispose);

  function findHostTitlebar() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      return document.querySelector('[class*="@container/titlebar"]');
    } catch {
      return null;
    }
  }

  function isTopRightToolbarCluster(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    const cls = el.className || '';
    if (typeof cls !== 'string') return false;
    const classList = typeof el.classList?.contains === 'function'
      ? el.classList
      : { contains: c => cls.split(/\s+/).includes(c) };
    if (!classList.contains('absolute') || !classList.contains('right-0')) return false;

    const styleTop = el.style?.top || el.getAttribute('style') || '';
    const hasTopClass = classList.contains('top-0');
    const hasTopStyle = /(?:^|;)\s*top:\s*0(?:px)?(?:\s*;|$)/i.test(styleTop);
    const rectTop = el.getBoundingClientRect ? el.getBoundingClientRect().top : 0;
    if (el.getBoundingClientRect && rectTop >= 20) return false;
    const isAtTop = hasTopClass || hasTopStyle || (rectTop <= 10 && rectTop >= 0);
    if (!isAtTop) return false;

    // 排除明显非顶栏容器（右侧全高抽屉、全屏浮层或带有明确非零高度下沉定位的浮层）
    if (classList.contains('bottom-0') || classList.contains('h-screen') || classList.contains('h-full')) {
      return false;
    }

    // 排除右侧滚动条滑槽（特征：包含 top-0.5 / bottom-0.5 / w-3 等滚动条特征）
    if (classList.contains('w-3') || classList.contains('right-0.5')) {
      return false;
    }

    // 必须符合顶栏控制按钮容器特征：
    // a) 包含右侧栏切换按钮
    // b) 或包含 z-50 并具有 flex / items-center 水平布局
    const hasAuxToggle = Boolean(el.querySelector && el.querySelector('[data-testid="toggle-aux-sidebar"]'));
    const hasToolbarLayout = classList.contains('z-50') && (classList.contains('items-center') || classList.contains('flex'));

    return hasAuxToggle || hasToolbarLayout;
  }

  function findTopRightCluster() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      // 1. 优先从右侧栏切换按钮向上寻找最近的顶栏容器
      const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxToggle?.closest) {
        // 先尝试带 top-0 的经典结构（Antigravity 1.x）
        let cluster = auxToggle.closest('div.absolute.right-0.top-0');
        if (cluster && isTopRightToolbarCluster(cluster)) return cluster;
        // 兼容 Antigravity 2.x（top: 0px 写在内联 style，class 无 top-0）
        cluster = auxToggle.closest('div.absolute.right-0');
        if (cluster && isTopRightToolbarCluster(cluster)) return cluster;
      }

      // 2. 备用安全探测：当 auxToggle 尚未挂载或被动态卸载时，精确匹配顶栏容器
      // 严格检查顶部坐标与容器特征，绝不误伤滚动条、侧栏抽屉或模态弹窗
      const selectors = [
        'div.h-screen.w-screen > div.flex-1 > div.absolute.right-0.top-0.z-50',
        'div.h-screen.w-screen > div.flex-1 > div.absolute.right-0.z-50',
        'div.absolute.right-0.z-50'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && isTopRightToolbarCluster(el)) return el;
      }
      return null;
    } catch {
      return null;
    }
  }

  // 动态计算右上角原生窗口控制区（Minimize / Maximize / Close）独占宽度（CSS px）
  function computeWindowControlsWidth(topRight) {
    if (!topRight) return 0;
    try {
      const plat = (typeof navigator !== 'undefined' && navigator.platform) || '';
      if (/^Mac|iPhone|iPad/i.test(plat)) return 0;
      if (topRight?.getBoundingClientRect) {
        const tr = topRight.getBoundingClientRect();
        // 若顶部已单独渲染菜单栏（top >= 20），则 40px 工具栏不在窗口顶边，无需重复留白
        if (tr.height > 0 && tr.top >= 20) return 0;
      }
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
      // 优先 1: 标准 WCO 接口 navigator.windowControlsOverlay
      const wco = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : null;
      if (wco?.visible && typeof wco.getTitlebarAreaRect === 'function') {
        const rect = wco.getTitlebarAreaRect();
        if (rect && rect.width > 0 && vw > 0 && rect.width < vw) {
          return Math.max(0, Math.ceil(vw - rect.right));
        }
      }
      // 优先 2: 根据 Electron titleBarOverlay 几何规格（Windows 3 颗原生控制按钮共 138 OS DIP）与实时缩放比动态换算
      let zoomFactor = 1;
      if (typeof window !== 'undefined') {
        const nativeZoom = window.electronNative?.getZoomLevel?.();
        if (typeof nativeZoom === 'number' && nativeZoom >= 0.25 && nativeZoom <= 5) {
          zoomFactor = nativeZoom;
        } else if (window.outerWidth > 0 && window.innerWidth > 0) {
          const ratio = window.outerWidth / window.innerWidth;
          if (ratio >= 0.25 && ratio <= 5) zoomFactor = ratio;
        }
      }
      const rawCssWidth = Math.ceil(138 / zoomFactor);
      let existingSpacerWidth = 0;
      if (topRight?.querySelectorAll) {
        const spacers = topRight.querySelectorAll('div[aria-hidden="true"]');
        for (const sp of spacers) {
          if (sp.id !== 'ag-wco-spacer' && sp.getBoundingClientRect) {
            existingSpacerWidth += Math.round(sp.getBoundingClientRect().width || parseFloat(sp.style?.width) || 0);
          }
        }
      }
      return Math.max(0, rawCssWidth - existingSpacerWidth);
    } catch {
      return 98;
    }
  }

  function syncWindowControlsOverlay() {
    if (state.disposed) return;
    try {
      const topRight = findTopRightCluster();
      const wcoWidth = computeWindowControlsWidth(topRight);
      const spacer = typeof document.getElementById === 'function' ? document.getElementById('ag-wco-spacer') : null;
      if (topRight && typeof document.createElement === 'function' && wcoWidth > 0) {
        let activeSpacer = spacer;
        if (!activeSpacer || activeSpacer.parentElement !== topRight) {
          activeSpacer?.remove?.();
          activeSpacer = document.createElement('div');
          activeSpacer.id = 'ag-wco-spacer';
          activeSpacer.setAttribute('aria-hidden', 'true');
          topRight.appendChild(activeSpacer);
        }
        const targetCss = `width:${wcoWidth}px;height:100%;flex-shrink:0;pointer-events:none;`;
        if (activeSpacer.style.cssText !== targetCss) {
          activeSpacer.style.cssText = targetCss;
        }
      } else {
        if (spacer) {
          spacer.remove();
        }
        if (topRight?.querySelectorAll) {
          const oldSpacers = topRight.querySelectorAll('#ag-wco-spacer');
          for (const s of oldSpacers) {
            s.remove?.();
          }
        }
      }

      if (typeof document.head !== 'undefined' && document.head && typeof document.createElement === 'function') {
        let styleEl = typeof document.getElementById === 'function' ? document.getElementById('ag-topbar-host-fix') : null;
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'ag-topbar-host-fix';
          document.head.appendChild(styleEl);
        }
        const cssText = [
          '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] {',
          '  padding-right: calc(var(--right-cluster-width, 140px) - 4px) !important;',
          '}',
          wcoWidth > 0 ? [
            '[class*="@container/titlebar"],',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id],',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child {',
            '  -webkit-app-region: drag;',
            '}',
            '[class*="@container/titlebar"] button,',
            '[class*="@container/titlebar"] a,',
            '[class*="@container/titlebar"] input,',
            '[class*="@container/titlebar"] [role="button"],',
            '[data-testid="pane-titlebar-toolbar"] > *,',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] button,',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] [data-tab-id],',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child button,',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child a,',
            '#ag-context-meter {',
            '  -webkit-app-region: no-drag;',
            '}'
          ].join('\n') : ''
        ].join('\n');
        if (styleEl.textContent !== cssText) {
          styleEl.textContent = cssText;
        }
      }
      syncNativeOverlayTheme();
    } catch { }
  }

  let layoutMeasurementDirty = true;
  let cachedMeasuredAvailWidth = null;
  let cachedMeasuredAvailAt = 0;
  let cachedMeasuredWinWidth = 0;

  function ensureHostDocked() {
    if (state.disposed) return;
    if (globalThis.__AGContextMeterActiveHost && globalThis.__AGContextMeterActiveHost !== host) {
      earlyForceDispose();
      return;
    }
    // 热路径短路：宿主已稳固停靠在预期标题栏内且尺寸未标脏时，跳过 DOM 遍历与强制布局查询
    if (
      !layoutMeasurementDirty
      && host.isConnected
      && host.getAttribute('data-dock') === 'flow'
      && observedTitlebar
      && observedTitlebar.isConnected
      && observedTitlebar.contains(host)
      && host.parentElement
    ) {
      return;
    }
    syncWindowControlsOverlay();
    const titlebar = findHostTitlebar();
    if (titlebar) {
      // 自愈保护：若主对话区（div.flex[style*="min-width"]）的 inline flex-grow 被意外清空，立即恢复为 1，绝不覆写其他分栏属性
      try {
        const convPane = titlebar.closest?.('div.flex[style*="min-width"]');
        if (convPane?.style && (!convPane.style.flexGrow || convPane.style.flexGrow === '0')) {
          convPane.style.flexGrow = '1';
        }
      } catch { }

      let targetContainer = titlebar;
      try {
        const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
        if (rightGroup && rightGroup !== titlebar.firstElementChild) {
          targetContainer = rightGroup;
        }
      } catch { }

      if (host.parentElement !== targetContainer) {
        if (targetContainer.firstChild && targetContainer !== titlebar) {
          targetContainer.insertBefore(host, targetContainer.firstChild);
        } else {
          targetContainer.appendChild(host);
        }
      }
      host.setAttribute('data-dock', 'flow');
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
      } catch { }
      host.style.right = '';
      host.style.top = '';

      if (observedTitlebar !== titlebar) {
        observedTitlebar = titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver.observe(titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch { }
      }
    } else {
      const fallbackParent = document.body || document.documentElement;
      if (fallbackParent && host.parentElement !== fallbackParent) {
        fallbackParent.appendChild(host);
      }
      host.setAttribute('data-dock', 'fixed');
      updateFixedFallbackPosition();
    }
    updateResponsiveLayout(layoutMeasurementDirty);
  }

  function findNativeTopRightAnchor() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const openIdeBtn = buttons.find(b => {
        const text = (b.textContent || '').trim();
        return (text === 'Open IDE' || text === '打开 IDE' || text.includes('Open IDE') || text.includes('打开 IDE')) && b.getBoundingClientRect?.().top < 50;
      });
      if (openIdeBtn) {
        const parentGroup = openIdeBtn.closest('div.flex.items-center, div.absolute.right-0') || openIdeBtn;
        return parentGroup;
      }
      const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxToggle?.closest) {
        return auxToggle.closest('div.absolute.right-0.top-0') || auxToggle;
      }
      return document.querySelector('div.absolute.right-0.top-0');
    } catch {
      return null;
    }
  }

  function updateFixedFallbackPosition() {
    if (host.getAttribute?.('data-dock') === 'flow') {
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
      } catch { }
      host.style.right = '';
      host.style.top = '';
      return;
    }
    try {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      let rightOffset = 144;
      const anchor = findNativeTopRightAnchor();
      if (anchor?.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.left > 0 && r.left < vw) {
          rightOffset = Math.max(144, Math.ceil(vw - r.left + 6));
        }
      }
      host.style.top = '6px';
      host.style.right = `${rightOffset}px`;
    } catch { }
  }

  // 带迟滞区间（Hysteresis）的四阶段渐进收缩计算，防止临界宽度抖动
  function computeNextLayoutMode(availWidth, currentMode) {
    // 阈值设计：
    // wide <-> compact: 收缩 < 195px, 恢复 >= 210px
    // compact <-> minimal: 收缩 < 135px, 恢复 >= 150px
    // minimal <-> ring-only: 收缩 < 68px, 恢复 >= 82px
    if (availWidth == null || Number.isNaN(availWidth)) return 'wide';
    if (currentMode === 'wide') {
      if (availWidth < 68) return 'ring-only';
      if (availWidth < 135) return 'minimal';
      if (availWidth < 195) return 'compact';
      return 'wide';
    }
    if (currentMode === 'compact') {
      if (availWidth >= 210) return 'wide';
      if (availWidth < 68) return 'ring-only';
      if (availWidth < 135) return 'minimal';
      return 'compact';
    }
    if (currentMode === 'minimal') {
      if (availWidth >= 210) return 'wide';
      if (availWidth >= 150) return 'compact';
      if (availWidth < 68) return 'ring-only';
      return 'minimal';
    }
    // currentMode === 'ring-only'
    if (availWidth >= 210) return 'wide';
    if (availWidth >= 150) return 'compact';
    if (availWidth >= 82) return 'minimal';
    return 'ring-only';
  }

  function measureAvailableWidth(force = false) {
    try {
      const now = Date.now();
      const curWinW = typeof window !== 'undefined' ? (window.innerWidth || 0) : 0;
      if (
        !force
        && !layoutMeasurementDirty
        && cachedMeasuredAvailWidth !== null
        && curWinW === cachedMeasuredWinWidth
        && now - cachedMeasuredAvailAt < 300
      ) {
        return cachedMeasuredAvailWidth;
      }
      const titlebar = findHostTitlebar();
      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(8, titleInner.getBoundingClientRect().left - tbRect.left)
            : (tbRect.left < 168 ? (168 - tbRect.left) : 12);
          const titleRealW = titleEl?.scrollWidth ? Math.min(320, titleEl.scrollWidth) : 160;
          const minTitleWidth = Math.max(150, titleRealW);
          let nativeButtonsWidth = 64;
          let rightPad = 8;
          const rightGroup = host.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen = typeof document.querySelector === 'function'
              && !!document.querySelector('[data-testid="aux-pane-sash"]');
            const root = typeof document.querySelector === 'function'
              ? document.querySelector('div.h-screen.w-screen')
              : null;
            const rightClusterVar = root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(8, (parseFloat(rightClusterVar) || 44) - 4);
            } else if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
              rightPad = parseFloat(window.getComputedStyle(rightGroup).paddingRight) || 0;
            }
            if (rightGroup.children) {
              let sum = 0;
              for (const child of rightGroup.children) {
                if (child !== host && child.getBoundingClientRect) {
                  sum += child.getBoundingClientRect().width;
                }
              }
              if (sum > 0) nativeButtonsWidth = sum + 6;
            }
          }
          const avail = tbRect.width - contentStart - minTitleWidth - rightPad - nativeButtonsWidth;
          cachedMeasuredAvailWidth = avail;
          cachedMeasuredAvailAt = now;
          cachedMeasuredWinWidth = curWinW;
          layoutMeasurementDirty = false;
          return avail;
        }
      }
      if (typeof window !== 'undefined' && window.innerWidth) {
        const avail = window.innerWidth - 360;
        cachedMeasuredAvailWidth = avail;
        cachedMeasuredAvailAt = now;
        cachedMeasuredWinWidth = curWinW;
        layoutMeasurementDirty = false;
        return avail;
      }
    } catch { }
    return 400;
  }

  function applyLayoutMode(nextMode) {
    if (!nextMode) return;
    const prev = state.layoutMode;
    state.layoutMode = nextMode;
    host.setAttribute('data-layout', nextMode);
    if (prev !== nextMode) {
      if (nextMode !== 'minimal') {
        const om = el('overflow-menu');
        if (om) om.hidden = true;
        el('badge-overflow')?.setAttribute('aria-expanded', 'false');
      }
      syncSpeedBadgeText();
    }
    renderSessionCost();
  }

  function updateResponsiveLayout(forceMeasure = false) {
    if (state.disposed) return;
    if (forceMeasure) layoutMeasurementDirty = true;
    syncWindowControlsOverlay();
    const avail = measureAvailableWidth(forceMeasure);
    const nextMode = computeNextLayoutMode(avail, state.layoutMode);
    applyLayoutMode(nextMode);
    if (state.tooltipOpen) positionContextTooltip();
    if (isAnyPanelOpen() || !el('overflow-menu')?.hidden) positionFloatingPanels();
  }

  function scheduleLayoutSync() {
    if (state.disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (layoutRaf) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        ensureHostDocked();
      });
    } else {
      ensureHostDocked();
    }
  }

  // 定位上下文悬停气泡：空间足够时优先在圆环上方，顶部空间不足时自动翻转至下方，左右防裁切
  function positionContextTooltip() {
    const tip = el('context-tooltip');
    const badge = el('badge');
    if (!tip || !badge || !badge.getBoundingClientRect) return;
    try {
      const bRect = badge.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const tRect = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { width: 190, height: 66 };
      const tipW = tRect.width || 190;
      const tipH = tRect.height || 66;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const gap = 7;

      const spaceAbove = bRect.top;
      const spaceBelow = vh - bRect.bottom;
      let top;
      if (spaceAbove >= tipH + gap + 6 || spaceAbove > spaceBelow) {
        top = bRect.top - tipH - gap;
        tip.setAttribute('data-placement', 'top');
      } else {
        top = bRect.bottom + gap;
        tip.setAttribute('data-placement', 'bottom');
      }
      top = snapToDevicePixel(Math.max(6, Math.min(vh - tipH - 6, top)));

      let left = bRect.left + bRect.width / 2 - tipW / 2;
      left = snapToDevicePixel(Math.max(8, Math.min(vw - tipW - 8, left)));

      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
    } catch { }
  }

  function showContextTooltip() {
    const tip = el('context-tooltip');
    if (!tip || !el('panel')?.hidden) return;
    state.tooltipOpen = true;
    tip.setAttribute('data-visible', 'true');
    positionContextTooltip();
  }

  function hideContextTooltip() {
    const tip = el('context-tooltip');
    if (!tip) return;
    state.tooltipOpen = false;
    tip.setAttribute('data-visible', 'false');
  }

  let elevatedStackAncestor = null;

  function syncHostStackingElevation(elevate) {
    try {
      if (elevate) {
        const z0 = host.closest?.('div.relative.z-0');
        if (z0?.style) {
          elevatedStackAncestor = z0;
          z0.style.zIndex = '40';
        }
      } else if (elevatedStackAncestor?.style) {
        elevatedStackAncestor.style.zIndex = '';
        elevatedStackAncestor = null;
      }
    } catch { }
  }

  function getLeftProjectSidebarRight(vw) {
    try {
      if (typeof document.querySelector === 'function') {
        const navEl = document.querySelector('div[role="navigation"]');
        if (navEl?.getBoundingClientRect) {
          const nr = navEl.getBoundingClientRect();
          if (nr.width > 0 && nr.left <= 8 && nr.right > 0 && nr.right < vw - 260) {
            return Math.ceil(nr.right);
          }
        }
      }
    } catch { }
    return 0;
  }

  function isWideWorkbench() {
    return !isContextSettingsView && activeWorkbenchTab === 'tokens';
  }

  function positionFloatingPanels() {
    if (!host.getBoundingClientRect) return;
    try {
      const hRect = host.getBoundingClientRect();
      if (hRect.width === 0 && hRect.height === 0) return;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const navRight = getLeftProjectSidebarRight(vw);
      const minLeft = navRight > 0 ? Math.max(12, navRight + 12) : 12;

      const placePanel = (panelEl, targetW, anchorBtn) => {
        if (!panelEl) return;
        const bRect = (anchorBtn && anchorBtn.getBoundingClientRect && anchorBtn !== host && anchorBtn.getBoundingClientRect().right > hRect.left)
          ? anchorBtn.getBoundingClientRect()
          : hRect;
        const dpr = getEffectiveDpr();
        const top = snapToDevicePixel(Math.max(36, Math.min(vh - 120, (bRect.bottom || hRect.bottom) + 6)));
        const maxAvailW = Math.max(260, vw - minLeft - 12);
        const finalW = Math.min(targetW, maxAvailW);

        // 核心锚点：右侧精确对齐到触发按钮右边缘，并按当前 DPI 物理像素网格对齐
        let left = snapToDevicePixel(bRect.right - finalW);
        left = Math.min(left, snapToDevicePixel(vw - finalW - 12));
        left = Math.max(snapToDevicePixel(minLeft), left);

        const maxWidthPx = Math.max(260, vw - left - 12);
        const maxHeightPx = Math.max(160, vh - top - 16);
        const geomKey = `${top}|${left}|${maxWidthPx}|${maxHeightPx}|${targetW}|${dpr}`;
        if (panelEl._lastPlacedGeomKey === geomKey) return;
        panelEl._lastPlacedGeomKey = geomKey;

        panelEl.style.top = `${top}px`;
        panelEl.style.left = `${left}px`;
        panelEl.style.right = 'auto';
        panelEl.style.maxWidth = `${maxWidthPx}px`;
        panelEl.style.maxHeight = `${maxHeightPx}px`;
        panelEl.style.transformOrigin = 'top right';
      };

      const wbPanel = el('panel');
      const isWide = isWideWorkbench();
      if (wbPanel) {
        if (isWide) wbPanel.setAttribute?.('data-wb-wide', 'true');
        else wbPanel.removeAttribute?.('data-wb-wide');
      }
      placePanel(wbPanel, isWide ? 700 : 460, el(activePanelAnchorId) || el('badge'));
      placePanel(el('overflow-menu'), 220, el('badge-overflow'));
    } catch { }
  }

  let lastObservedHostModelSig = null;
  let hostModelSyncTimer = null;
  let domMutationThrottleTimer = null;
  function scheduleHostModelSync() {
    try {
      if (state.disposed || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
      if (hostModelSyncTimer) return;
      hostModelSyncTimer = setTimeout(() => {
        hostModelSyncTimer = null;
        try {
          if (state.disposed || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
          const trig = document.querySelector('[data-testid="model-selector-trigger"]');
          const nextSig = trig ? `${trig.getAttribute?.('aria-label') || ''}|${trig.textContent || ''}` : '';
          if (nextSig === lastObservedHostModelSig) return;
          lastObservedHostModelSig = nextSig;
          if (typeof syncContextModelSelectionFromState === 'function') {
            syncContextModelSelectionFromState();
          }
        } catch { }
      }, 60);
    } catch { }
  }

  function flushHostDomMutationCheck() {
    domMutationThrottleTimer = null;
    if (state.disposed) return;
    if (!host.isConnected || host.getAttribute('data-dock') !== 'flow' || !findHostTitlebar()?.contains?.(host)) {
      scheduleLayoutSync();
    }
    scheduleHostModelSync();
  }

  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout(true));
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined' && document.body) {
      hostDomObserver = new MutationObserver(() => {
        if (state.disposed) return;
        // 轻量 O(1) 检查优先，其余全量/选择器查询合并节流至低频窗口，防止聊天吐字与切会话卡顿
        if (!host.isConnected || host.getAttribute('data-dock') !== 'flow') {
          layoutMeasurementDirty = true;
          scheduleLayoutSync();
        }
        if (!domMutationThrottleTimer) {
          domMutationThrottleTimer = setTimeout(flushHostDomMutationCheck, 180);
        }
      });
      hostDomObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
    }
  } catch { }

  const onWindowResize = () => updateResponsiveLayout(true);
  const handleDpiOrZoomChange = () => {
    try {
      for (const id of ['panel', 'overflow-menu']) {
        const node = el(id);
        if (node) node._lastPlacedGeomKey = '';
      }
      layoutMeasurementDirty = true;
      updateResponsiveLayout(true);
      if (state.tooltipOpen) positionContextTooltip();
    } catch { }
  };
  let removeDpiWatcher = null;
  const attachDpiWatcher = () => {
    try {
      if (removeDpiWatcher) {
        removeDpiWatcher();
        removeDpiWatcher = null;
      }
      if (state.disposed || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
      const mql = window.matchMedia(`(resolution: ${getEffectiveDpr()}dppx)`);
      if (!mql) return;
      const onChange = () => {
        if (state.disposed) return;
        attachDpiWatcher();
        handleDpiOrZoomChange();
      };
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        removeDpiWatcher = () => {
          try { mql.removeEventListener?.('change', onChange); } catch { }
        };
      } else if (typeof mql.addListener === 'function') {
        mql.addListener(onChange);
        removeDpiWatcher = () => {
          try { mql.removeListener?.(onChange); } catch { }
        };
      }
    } catch { }
  };
  const onWindowFocus = () => {
    host.setAttribute('data-window-active', 'true');
    if (typeof onQuotaWindowFocus === 'function') onQuotaWindowFocus();
  };
  const onWindowBlur = () => {
    host.setAttribute('data-window-active', 'false');
    if (typeof onQuotaWindowBlur === 'function') onQuotaWindowBlur();
  };
  try {
    window.addEventListener?.('resize', onWindowResize);
    window.addEventListener?.('focus', onWindowFocus);
    window.addEventListener?.('blur', onWindowBlur);
    navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);
    attachDpiWatcher();
    earlyDisposeHooks.push(() => {
      try {
        window.removeEventListener?.('resize', onWindowResize);
        window.removeEventListener?.('focus', onWindowFocus);
        window.removeEventListener?.('blur', onWindowBlur);
        navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
        if (removeDpiWatcher) {
          removeDpiWatcher();
          removeDpiWatcher = null;
        }
        if (hostModelSyncTimer) { clearTimeout(hostModelSyncTimer); hostModelSyncTimer = null; }
        if (domMutationThrottleTimer) { clearTimeout(domMutationThrottleTimer); domMutationThrottleTimer = null; }
      } catch { }
    });
  } catch { }

  ensureHostDocked();

  // 上下文圆环悬停与键盘聚焦气泡（面板打开时不通过悬停误切，且移除顶栏胶囊右键静默切主题以防触控板误触）
  el('badge').addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen()) {
      showContextTooltip();
    }
  });
  el('badge').addEventListener('mouseleave', () => {
    hideContextTooltip();
  });
  el('badge').addEventListener('focus', () => {
    if (!isAnyPanelOpen()) showContextTooltip();
  });
  el('badge').addEventListener('blur', () => {
    hideContextTooltip();
  });


  function setAvailableWidthForTestImpl(width) {
    const next = computeNextLayoutMode(width, state.layoutMode);
    applyLayoutMode(next);
    return state.layoutMode;
  }
  // =========================================================================
  // 会话上下文窗口、最近调用卡片、会话时间线、附件扫描与模型规格看板 (context-view.js)
  // =========================================================================
  const ctxModelSelect = el('ctx-model-select');
  const ctxModelListEl = el('ctx-model-list');
  const ctxCardVendorDot = el('ctx-card-vendor-dot');
  const ctxCardVendorName = el('ctx-card-vendor-name');
  const ctxCardQuotaSlot = el('ctx-card-quota-slot');
  const ctxCardProductName = el('ctx-card-product-name');
  const ctxCardEffortsList = el('ctx-card-efforts-list');
  const ctxCardSessionEffort = el('ctx-card-session-effort');
  const ctxCardObservedBudgetEl = el('ctx-card-observed-budget');
  const ctxCardServiceLimitEl = el('ctx-card-service-limit');
  const ctxCardObservedSpeedEl = el('ctx-card-observed-speed');
  const ctxCardHintsEl = el('ctx-card-hints');
  const ctxCapWindowEl = el('ctx-cap-window');
  const ctxCapOutputEl = el('ctx-cap-output');
  const ctxCapModelMaxEl = el('ctx-cap-model-max');
  const ctxCapDefaultEl = el('ctx-cap-default');
  const ctxCapFormulaEl = el('ctx-cap-formula');
  const ctxCardTierCapsRowEl = el('ctx-card-tier-caps-row');
  const ctxCardTierCapsEl = el('ctx-card-tier-caps');

  let activeSessionModelKey = null;
  let activeSessionProductKey = null;
  let activeSessionEffort = null;
  let activeSessionModelConfirmed = false;
  let selectedEditModelKey = null;
  let selectedProductKey = null;
  let manualModelSelection = false;
  const observedByModelId = new Map();

  let ctxHeaderDropdownCtrl = null;
  function renderSessionCost() {
    const roundCostBar = el('round-cost-bar');
    const roundCostText = el('round-cost-text');
    const sessionCostText = el('session-cost-text');
    if (!roundCostText || !sessionCostText) return;
    const activeCalls = state.sessionCalls || [];
    const latestCall = activeCalls[activeCalls.length - 1];
    const computedSessTotal = activeCalls.reduce((sum, c) => sum + (c && c.isPriced && Number.isFinite(Number(c.costUSD)) ? Math.max(0, Number(c.costUSD)) : 0), 0);
    const sessTotal = computedSessTotal > 0 ? computedSessTotal : (Number.isFinite(Number(state.sessionCostTotal)) ? Math.max(0, Number(state.sessionCostTotal)) : 0);
    const hasUnpricedCalls = activeCalls.some(c => c && !c.isPriced);
    if ((!latestCall || !latestCall.isPriced) && sessTotal <= 0) {
      if (roundCostBar) roundCostBar.hidden = true;
      roundCostText.textContent = latestCall ? t('cost.unpriced') : t('cost.latestDash');
      roundCostText.title = latestCall
        ? (latestCall.model ? t('cost.unpricedTip', { model: latestCall.model }) : t('cost.missingModel'))
        : '';
      sessionCostText.textContent = t('session.sessionCost.dash');
      return;
    }
    if (roundCostBar) roundCostBar.hidden = false;
    if (latestCall && latestCall.isPriced) {
      const roundCost = latestCall.costUSD || 0;
      const roundCostStr = roundCost < 0.01 ? '<$0.01' : `≈$${roundCost.toFixed(4)}`;
      const estLabel = latestCall.status === 'streaming' ? t('cost.streamingEst') : t('cost.returnedEst');
      roundCostText.textContent = t('cost.latestTurn', { val: roundCostStr, label: estLabel });
      roundCostText.title = t('cost.modelTip', {
        model: latestCall.model,
        input: fmt(latestCall.inputTokens),
        cache: fmt(latestCall.cacheTokens),
        output: fmt(latestCall.outputTokens),
        cost: roundCost.toFixed(6)
      });
    } else if (latestCall) {
      roundCostText.textContent = t('cost.turnUnpriced');
      roundCostText.title = latestCall.model ? t('cost.unpricedTip', { model: latestCall.model }) : t('cost.missingModel');
    } else {
      roundCostText.textContent = t('cost.latestDash');
      roundCostText.title = '';
    }
    sessionCostText.textContent = sessTotal > 0
      ? (hasUnpricedCalls ? t('cost.sessionPricedTotal', { val: sessTotal.toFixed(4) }) : t('cost.sessionTotal', { val: sessTotal.toFixed(4) }))
      : t('session.sessionCost.dash');
  }

  function withStepError(value, metadata) {
    const error = state.scan?.session?.currentError;
    if (!error || value?.error) return value;
    const lastStep = Math.max(-1, ...(metadata?.stepIndices || []), metadata?.chatModel?.chatStartMetadata?.startStepIndex ?? -1);
    if (lastStep > error.index) return value;
    const failure = summarize({ chatModel: { retryInfos: [{ error: error.text }] } }, {
      currentModel: value?.model || state.latest?.model || '',
      cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [],
      previousValidContext: value
    });
    return {
      ...(value || {}),
      error: failure.error,
      errorClassification: failure.errorClassification,
      exceeded: failure.exceeded,
      network: failure.network,
      serviceLimit: failure.serviceLimit || value?.serviceLimit || null,
      status: failure.status,
      // 解耦：保留已有有效上下文数据，不归零、不清空
      used: value?.used ?? failure?.used ?? null,
      actual: failure.exceeded ? null : (value?.actual ?? null),
      estimate: value?.estimate ?? failure?.estimate ?? null,
      budget: value?.budget ?? failure?.budget ?? null,
      percent: failure.exceeded ? 100 : (value?.percent ?? null),
      estimated: value?.actual == null
    };
  }

  function groupProductSafe(input) {
    if (typeof groupModelProduct === 'function') return groupModelProduct(input || {});
    const rawId = String(input?.modelId || input?.label || 'unknown').trim();
    const low = rawId.toLowerCase();
    const vendor = low.includes('claude') ? 'Anthropic' : (low.includes('gpt') || low.includes('o1') || low.includes('o3')) ? 'OpenAI' : (low.includes('gemini') ? 'Google' : '其他');
    return { productKey: low, productLabel: input?.label || rawId, vendor, effort: input?.effort || null };
  }

  function resolveStableModelKeyClient(rawOrLatest) {
    if (!rawOrLatest) return null;
    if (typeof resolveStableModelId === 'function') {
      const resolved = resolveStableModelId(rawOrLatest, state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []);
      if (resolved) return resolved;
    }
    if (typeof rawOrLatest === 'string') {
      const s = rawOrLatest.trim().toLowerCase();
      return s || null;
    }
    const str = String(rawOrLatest.modelId || rawOrLatest.modelRaw || rawOrLatest.model || '').trim().toLowerCase();
    return str || null;
  }

  /**
   * 仅从宿主真实输入框选择器只读读取当前选中模型（严格排除插件自身 #ag-context-meter DOM，零请求拦截）
   */
  function extractHostSelectedModel() {
    if (typeof document === 'undefined') return null;
    const triggers = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('[data-testid="model-selector-trigger"]'))
      : (typeof document.querySelector === 'function' ? [document.querySelector('[data-testid="model-selector-trigger"]')].filter(Boolean) : []);
    if (!triggers.length) return null;

    let trigger = null;
    for (const candidate of triggers) {
      if (!candidate) continue;
      if (host && typeof host.contains === 'function' && host.contains(candidate)) continue;
      if (typeof candidate.closest === 'function' && candidate.closest('#ag-context-meter')) continue;
      if (typeof candidate.getBoundingClientRect === 'function') {
        const rect = candidate.getBoundingClientRect();
        if (rect && rect.width === 0 && rect.height === 0) continue;
      }
      trigger = candidate;
      break;
    }
    if (!trigger) return null;

    let effort = null;
    const effortEl = trigger.querySelector?.('[data-testid="model-selector-effort-option"]')
      || trigger.querySelector?.('[data-effort]');
    if (effortEl) {
      effort = effortEl.getAttribute?.('data-effort') || effortEl.textContent?.trim() || null;
    }

    const clone = trigger.cloneNode ? trigger.cloneNode(true) : trigger;
    const svgs = clone.querySelectorAll ? clone.querySelectorAll('svg, [aria-hidden="true"]') : [];
    if (svgs && svgs.forEach) svgs.forEach(s => s.remove());
    const rawText = (clone.textContent || '').trim();
    if (!rawText) return null;

    const effortCaseMap = {
      'extra high': 'Extra High',
      xhigh: 'XHigh',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      extra: 'Extra',
      minimal: 'Minimal',
      max: 'Max'
    };
    let baseText = rawText;
    const mParen = rawText.match(/^(.*?)\s*\((Extra High|XHigh|Low|Medium|High|Extra|Minimal|Max)\)\s*$/i);
    if (mParen) {
      baseText = mParen[1].trim() || rawText;
      if (!effort) effort = mParen[2];
    } else {
      const mTrail = rawText.match(/^(.*?)\s+(Extra High|XHigh|Low|Medium|High|Minimal|Max)\s*$/i);
      if (mTrail) {
        baseText = mTrail[1].trim() || rawText;
        if (!effort) effort = mTrail[2];
      }
    }
    const normEffort = effort ? (effortCaseMap[String(effort).trim().toLowerCase()] || effort) : null;
    const parenLabel = (normEffort && baseText && !baseText.includes('(')) ? `${baseText} (${normEffort})` : rawText;

    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const resolveCand = (cand) => cand
      ? (resolveStableModelKeyClient(cand) || (typeof resolveStableModelId === 'function' ? resolveStableModelId(cand, configs) : null))
      : null;
    const stableId = resolveCand(parenLabel) || resolveCand(rawText) || resolveCand(baseText);
    const g = groupProductSafe({
      modelId: stableId || parenLabel,
      label: parenLabel,
      effort: normEffort
    });

    return {
      rawText,
      modelId: stableId || parenLabel,
      productKey: g.productKey,
      productLabel: g.productLabel || baseText,
      effort: normEffort || g.effort || null,
      source: 'dom_trigger'
    };
  }

  function getProductCapabilitySummary(product) {
    if (!product) return null;
    if (typeof budgetEngine.deriveModelCapabilitySummary === 'function') {
      return budgetEngine.deriveModelCapabilitySummary(product, null, state.modelCapabilitiesById || null);
    }
    return null;
  }

  function formatProductSpecShort(product) {
    const cap = getProductCapabilitySummary(product);
    if (cap?.maxTokens) return formatKShort(cap.maxTokens);
    return '—';
  }

  let modelCapabilitiesVersion = 1;

  function mergeCapabilitiesMapClient(incomingMap) {
    if (!incomingMap || typeof incomingMap !== 'object') return;
    if (!state.modelCapabilitiesById || typeof state.modelCapabilitiesById !== 'object') {
      state.modelCapabilitiesById = {};
    }
    let updated = false;
    for (const [rawKey, rawVal] of Object.entries(incomingMap)) {
      if (!rawVal || typeof rawVal !== 'object') continue;
      const k = String(rawKey).trim().toLowerCase().replace(/^model_/, '');
      if (!k) continue;
      state.modelCapabilitiesById[k] = {
        ...(state.modelCapabilitiesById[k] || {}),
        ...rawVal
      };
      updated = true;
    }
    if (updated) modelCapabilitiesVersion++;
  }

  let cachedKnownProductsSnapshot = null;

  /** 将所有已知模型、当前会话和历史调用按产品维度分组 */
  function getKnownModelProducts() {
    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const speedRecords = ANTIGRAVITY_TOKEN_DATA.speedRecords || [];
    const sessionCalls = state.sessionCalls || [];
    const latest = state.latest || null;
    const capsMap = state.modelCapabilitiesById || null;

    let configsSig = '';
    if (Array.isArray(configs) && configs.length) {
      for (let i = 0; i < configs.length; i++) {
        const c = configs[i];
        configsSig += `${c?.modelId || c?.modelOrAlias?.model || ''}:${c?.maxTokens ?? ''}:${c?.maxOutputTokens ?? ''}:${c?.disabled ? 1 : 0}:${c?.unavailable ? 1 : 0}:${c?.isHistorical ? 1 : 0}:${c?.capabilitySource || ''};`;
      }
    }
    const latestSig = latest ? `${latest.modelId || ''}|${latest.modelRaw || ''}|${latest.model || ''}|${latest.effort || ''}` : '';
    const capsLen = capsMap ? Object.keys(capsMap).length : 0;
    const speedLen = Array.isArray(speedRecords) ? speedRecords.length : 0;
    const sessLen = Array.isArray(sessionCalls) ? sessionCalls.length : 0;
    const speedEdge = speedLen ? `${speedRecords[0]?.modelExactId || speedRecords[0]?.model || ''}|${speedRecords[speedLen - 1]?.callId || speedRecords[speedLen - 1]?.modelExactId || ''}` : '';
    const sessEdge = sessLen ? `${sessionCalls[0]?.modelExactId || sessionCalls[0]?.model || ''}|${sessionCalls[sessLen - 1]?.callId || sessionCalls[sessLen - 1]?.model || ''}` : '';

    if (
      cachedKnownProductsSnapshot
      && cachedKnownProductsSnapshot.configsRef === configs
      && cachedKnownProductsSnapshot.configsSig === configsSig
      && cachedKnownProductsSnapshot.speedRef === speedRecords
      && cachedKnownProductsSnapshot.speedLen === speedLen
      && cachedKnownProductsSnapshot.speedEdge === speedEdge
      && cachedKnownProductsSnapshot.sessRef === sessionCalls
      && cachedKnownProductsSnapshot.sessLen === sessLen
      && cachedKnownProductsSnapshot.sessEdge === sessEdge
      && cachedKnownProductsSnapshot.latestSig === latestSig
      && cachedKnownProductsSnapshot.capsVer === modelCapabilitiesVersion
      && cachedKnownProductsSnapshot.capsLen === capsLen
    ) {
      return cachedKnownProductsSnapshot.result.map(p => ({ ...p, members: p.members.slice() }));
    }

    const productMap = new Map();
    const slugToKey = new Map();
    const ensureProduct = (meta, fromAccountCatalog = false) => {
      const g = groupProductSafe(meta);
      if (!g.productKey) return null;
      const keyParts = g.productKey.split(':');
      const keySlug = keyParts.length >= 3 ? keyParts.slice(2).join(':') : '';
      let targetKey = g.productKey;
      // 若同一产品 slug 在列表里既有明确厂商又有"其他"厂商，合并到明确厂商条目下（不合并不同前缀或代际）
      if (keySlug && !productMap.has(targetKey) && slugToKey.has(keySlug)) {
        const existingKey = slugToKey.get(keySlug);
        const existingProd = productMap.get(existingKey);
        if (existingProd && (g.vendor === '其他' || existingProd.vendor === '其他')) {
          if (existingProd.vendor === '其他' && g.vendor !== '其他') {
            productMap.delete(existingKey);
            existingProd.productKey = targetKey;
            existingProd.vendor = g.vendor;
            productMap.set(targetKey, existingProd);
            slugToKey.set(keySlug, targetKey);
          } else {
            targetKey = existingKey;
          }
        }
      }
      let prod = productMap.get(targetKey);
      if (!prod) {
        prod = {
          productKey: targetKey,
          productLabel: g.productLabel,
          vendor: g.vendor || '其他',
          inAccountCatalog: Boolean(fromAccountCatalog),
          unavailable: Boolean(meta.unavailable),
          unavailabilityReason: meta.unavailabilityReason || null,
          notice: meta.notice || null,
          isHistorical: Boolean(meta.isHistorical),
          members: new Map()
        };
        productMap.set(targetKey, prod);
        if (keySlug && (!slugToKey.has(keySlug) || g.vendor !== '其他')) {
          slugToKey.set(keySlug, targetKey);
        }
      } else if (fromAccountCatalog) {
        prod.inAccountCatalog = true;
        if (meta.notice && !prod.notice) prod.notice = meta.notice;
        if (meta.isHistorical !== undefined) prod.isHistorical = prod.isHistorical && Boolean(meta.isHistorical);
      }
      if (meta.modelId) {
        const mid = String(meta.modelId).trim().toLowerCase();
        const prev = prod.members.get(mid);
        const capEntry = state.modelCapabilitiesById?.[mid.replace(/^model_/, '')]
          || state.modelCapabilitiesById?.[String(meta.modelOrAlias?.model || '').trim().toLowerCase().replace(/^model_/, '')]
          || null;
        prod.members.set(mid, {
          modelId: mid,
          label: meta.label || prev?.label || mid,
          effort: g.effort || prev?.effort || null,
          maxTokens: meta.maxTokens ?? capEntry?.maxTokens ?? prev?.maxTokens ?? null,
          maxOutputTokens: meta.maxOutputTokens ?? capEntry?.maxOutputTokens ?? prev?.maxOutputTokens ?? null,
          thinkingBudget: meta.thinkingBudget ?? capEntry?.thinkingBudget ?? prev?.thinkingBudget ?? null,
          minThinkingBudget: meta.minThinkingBudget ?? capEntry?.minThinkingBudget ?? prev?.minThinkingBudget ?? null,
          thinkingLevel: meta.thinkingLevel || capEntry?.thinkingLevel || prev?.thinkingLevel || null,
          supportsModelInfoOverride: meta.supportsModelInfoOverride ?? capEntry?.supportsModelInfoOverride ?? prev?.supportsModelInfoOverride ?? null,
          capabilitySource: meta.capabilitySource || capEntry?.capabilitySource || prev?.capabilitySource || null,
          unavailable: meta.unavailable !== undefined ? Boolean(meta.unavailable) : (prev?.unavailable || false),
          unavailabilityReason: meta.unavailabilityReason || prev?.unavailabilityReason || null,
          notice: meta.notice || prev?.notice || null,
          isHistorical: meta.isHistorical !== undefined ? Boolean(meta.isHistorical) : (prev?.isHistorical || false)
        });
      }
      return prod;
    };

    if (Array.isArray(configs)) {
      for (const c of configs) {
        const stableId = resolveStableModelKeyClient(c) || c?.modelId || c?.modelOrAlias?.model;
        ensureProduct({
          modelId: stableId,
          label: c?.label || c?.modelId || stableId,
          modelOrAlias: c?.modelOrAlias,
          effort: c?.effort,
          maxTokens: c?.maxTokens,
          maxOutputTokens: c?.maxOutputTokens,
          thinkingBudget: c?.thinkingBudget,
          minThinkingBudget: c?.minThinkingBudget,
          thinkingLevel: c?.thinkingLevel,
          supportsModelInfoOverride: c?.supportsModelInfoOverride,
          capabilitySource: c?.capabilitySource,
          unavailable: Boolean(c?.unavailable || c?.disabled),
          unavailabilityReason: c?.unavailabilityReason || c?.tagDescription || null,
          notice: c?.notice,
          isHistorical: c?.isHistorical
        }, true);
      }
    }

    if (latest?.modelId || latest?.modelRaw || latest?.model) {
      const stableId = resolveStableModelKeyClient(latest);
      ensureProduct({
        modelId: stableId,
        label: latest.model || stableId,
        modelOrAlias: latest.modelOrAlias,
        effort: latest.effort
      }, false);
    }

    // 先按 (modelId, label, effort) 去重，避免成百上千条同模型历史/会话调用重复执行产品分组
    const seenCallModels = new Set();
    const processCallList = (list) => {
      if (!Array.isArray(list)) return;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c) continue;
        const mid = c.modelExactId || c.modelId || c.model;
        if (!mid) continue;
        const lbl = c.modelLabel || c.model || mid;
        const eff = c.effort || '';
        const sig = `${mid}\0${lbl}\0${eff}`;
        if (seenCallModels.has(sig)) continue;
        seenCallModels.add(sig);
        ensureProduct({
          modelId: mid,
          label: lbl,
          effort: eff || undefined
        }, false);
      }
    };
    processCallList(speedRecords);
    processCallList(sessionCalls);

    const rankEffort = { Minimal: 1, Low: 2, Medium: 3, High: 4, XHigh: 5, Extra: 6, 'Extra High': 7, Max: 8 };
    const result = Array.from(productMap.values()).map(p => {
      const members = Array.from(p.members.values()).sort((a, b) => (rankEffort[a.effort] || 99) - (rankEffort[b.effort] || 99));
      const allUnavailable = members.length > 0 && members.every(m => m.unavailable);
      const partialUnavailable = members.length > 0 && !allUnavailable && members.some(m => m.unavailable);
      const isUnavailable = members.length > 0 ? allUnavailable : Boolean(p.unavailable);
      const isHistorical = members.length > 0 ? (members.every(m => m.isHistorical) || !p.inAccountCatalog) : (p.isHistorical || (!p.inAccountCatalog));
      const notice = p.notice || members.find(m => m.notice)?.notice || null;
      const reason = isUnavailable
        ? (p.unavailabilityReason || members.find(m => m.unavailable && m.unavailabilityReason)?.unavailabilityReason || null)
        : (partialUnavailable ? (members.find(m => m.unavailable && m.unavailabilityReason)?.unavailabilityReason || null) : null);
      return {
        productKey: p.productKey,
        productLabel: p.productLabel,
        vendor: p.vendor,
        inAccountCatalog: p.inAccountCatalog,
        unavailable: isUnavailable,
        partialUnavailable,
        unavailabilityReason: reason,
        notice,
        isHistorical,
        members
      };
    });
    result.sort((a, b) => {
      const va = VENDOR_ORDER.indexOf(a.vendor);
      const vb = VENDOR_ORDER.indexOf(b.vendor);
      if (va !== vb) return (va === -1 ? 99 : va) - (vb === -1 ? 99 : vb);
      return a.productLabel.localeCompare(b.productLabel);
    });

    cachedKnownProductsSnapshot = {
      configsRef: configs,
      configsSig,
      speedRef: speedRecords,
      speedLen,
      speedEdge,
      sessRef: sessionCalls,
      sessLen,
      sessEdge,
      latestSig,
      capsVer: modelCapabilitiesVersion,
      capsLen,
      result
    };
    return result.map(p => ({ ...p, members: p.members.slice() }));
  }

  function getSelectedProductObj() {
    const products = getKnownModelProducts();
    if (!products.length) return null;
    if (selectedProductKey) {
      const found = products.find(p => p.productKey === selectedProductKey);
      if (found) return found;
    }
    if (activeSessionProductKey) {
      const activeFound = products.find(p => p.productKey === activeSessionProductKey);
      if (activeFound) return activeFound;
    }
    return products[0];
  }

  const MINI_QUOTA_RING_RADIUS = 5.5;
  const MINI_QUOTA_RING_CIRC = 2 * Math.PI * MINI_QUOTA_RING_RADIUS;
  const modelListChipByProductKey = new Map();
  let lastModelQuotaSyncSig = '';

  /**
   * 安全获取额度视图（防止初始化阶段提前触发时出现 TDZ 异常）。
   */
  function getSafeQuotaViewForModelList(nowMs = Date.now()) {
    if (!quotaStateInitialized || typeof computeEffectiveQuotaView !== 'function') return null;
    try {
      return computeEffectiveQuotaView(nowMs);
    } catch {
      return null;
    }
  }

  /**
   * 兼容浏览器与精简测试环境的 SVG 节点创建函数。
   */
  function createQuotaSvgEl(tag) {
    if (typeof document === 'undefined') return null;
    if (typeof document.createElementNS === 'function') {
      return document.createElementNS('http://www.w3.org/2000/svg', tag);
    }
    return typeof document.createElement === 'function' ? document.createElement(tag) : null;
  }

  /**
   * 将模型产品对象映射到共享额度池并生成小圆环展示摘要。
   */
  function resolveProductQuotaSummary(product, quotaView = null, nowMs = Date.now()) {
    const core = typeof __AGContextMeterCore !== 'undefined'
      ? __AGContextMeterCore
      : (globalThis.__AGContextMeterCore || null);
    const view = quotaView || getSafeQuotaViewForModelList(nowMs);
    const unknownText = t('quota.short.unknown');
    if (!product) {
      return {
        status: 'unknown',
        statusLabel: getQuotaStatusLabelText('unknown'),
        shortText: unknownText,
        fraction: null,
        poolKey: '',
        poolTitle: '',
        tooltip: '',
        ariaLabel: unknownText
      };
    }

    const pools = Array.isArray(view?.pools) ? view.pools : [];
    const membersList = Array.isArray(product.members)
      ? product.members
      : Array.from(product.members?.values?.() || []);
    const candidateIds = new Set();
    const candidateLabels = new Set();
    const pKeyLower = String(product.productKey || '').trim().toLowerCase();
    const pLabelLower = String(product.productLabel || '').trim().toLowerCase();
    if (pLabelLower) candidateLabels.add(pLabelLower);
    for (const m of membersList) {
      if (m?.modelId) candidateIds.add(String(m.modelId).trim().toLowerCase());
      if (m?.label) candidateLabels.add(String(m.label).trim().toLowerCase());
    }

    let matchedPool = null;
    let matchedModel = null;
    const isHistoryOnly = Boolean(product.isHistorical || !product.inAccountCatalog);

    // 1. 优先通过 productKey / modelIds / aliases 精确命中账号额度池模型（仅历史记录模型不借用当前活跃额度池）
    if (!isHistoryOnly) {
      for (const pool of pools) {
        for (const m of (pool.models || [])) {
          const mProdKey = String(m.productKey || '').trim().toLowerCase();
          const mLabel = String(m.productLabel || '').trim().toLowerCase();
          const mIds = Array.isArray(m.modelIds) ? m.modelIds.map(x => String(x || '').trim().toLowerCase()) : [];
          const mAliases = Array.isArray(m.aliases) ? m.aliases.map(x => String(x || '').trim().toLowerCase()) : [];
          const hit =
            (pKeyLower && mProdKey && mProdKey === pKeyLower) ||
            mIds.some(id => candidateIds.has(id)) ||
            mAliases.some(a => candidateIds.has(a) || candidateLabels.has(a)) ||
            (mLabel && candidateLabels.has(mLabel));
          if (hit) {
            matchedPool = pool;
            matchedModel = m;
            break;
          }
        }
        if (matchedPool) break;
      }

      // 2. 次级按共享额度池键归并当前账号目录内的模型
      if (!matchedPool && core?.getSharedQuotaGroupKey) {
        const probeInput = {
          modelId: membersList[0]?.modelId || product.productKey,
          label: product.productLabel || membersList[0]?.label || ''
        };
        const gKey = core.getSharedQuotaGroupKey(probeInput);
        if (gKey) {
          matchedPool = pools.find(p => p.poolKey === gKey) || null;
        }
      }
    }

    const syncState = view?.syncState || 'unknown';
    const isNoPerm = Boolean(matchedModel?.noPermission || matchedPool?.noPermission || product.unavailable);
    let status = 'unknown';
    let shortText = unknownText;
    let fraction = null;

    if (isNoPerm) {
      status = 'no_permission';
      shortText = t('quota.short.no_permission');
    } else if (syncState === 'error' && !matchedPool) {
      status = 'error';
      shortText = t('quota.short.error');
    } else if (matchedPool) {
      fraction = matchedPool.remainingFraction;
      if (fraction === null || fraction === undefined) {
        status = syncState === 'stale' ? 'stale' : 'unknown';
        shortText = t(`quota.short.${status}`);
      } else if (matchedPool.isExhausted || fraction === 0) {
        status = syncState === 'stale' ? 'stale' : 'exhausted';
        shortText = t('quota.short.exhausted');
      } else {
        status = syncState === 'stale' ? 'stale' : (fraction <= 0.2 ? 'low' : 'available');
        shortText = core?.formatQuotaPercentText
          ? core.formatQuotaPercentText(fraction)
          : (matchedPool.percentText || `${Math.round(fraction * 100)}%`);
      }
    } else if (product.isHistorical || !product.inAccountCatalog) {
      status = 'unknown';
      shortText = unknownText;
    } else {
      status = syncState === 'stale' ? 'stale' : 'unknown';
      shortText = t(`quota.short.${status}`);
    }

    const statusLabel = typeof getQuotaStatusLabelText === 'function'
      ? getQuotaStatusLabelText(status)
      : status;
    const poolName = matchedPool?.title || (product.isHistorical ? t('quota.modelChip.historyHint') : t('quota.modelChip.unpooled'));
    const tipParts = [
      t('quota.modelChip.tooltip', {
        model: product.productLabel,
        pool: poolName,
        status: statusLabel,
        value: shortText
      })
    ];
    if (matchedPool?.hasResetTime && matchedPool.resetTimeText) {
      const cdStr = Number.isFinite(matchedPool.resetAtMs)
        ? ` (${formatCountdownMsCompact((matchedPool.resetAtMs || 0) - nowMs)})`
        : '';
      tipParts.push(t('quota.modelChip.resetPart', { reset: `${matchedPool.resetTimeText}${cdStr}` }));
    }
    const reason = matchedModel?.unavailabilityReason || product.unavailabilityReason;
    if (isNoPerm && reason) tipParts.push(String(reason));
    if (matchedModel?.noticeText) tipParts.push(String(matchedModel.noticeText));
    if (syncState === 'error' && view?.lastError && !matchedPool && !isNoPerm) {
      tipParts.push(String(view.lastError));
    }
    const tooltip = tipParts.join(' · ');

    return {
      status,
      statusLabel,
      shortText,
      fraction,
      poolKey: matchedPool?.poolKey || '',
      poolTitle: matchedPool?.title || '',
      tooltip,
      ariaLabel: tooltip
    };
  }

  /**
   * 更新小额度圆环芯片的圆弧进度、语义状态、数值文本与悬浮说明。
   */
  function updateMiniQuotaChipElement(chip, summary) {
    if (!chip || !summary) return;
    setQuotaAttrIfChanged(chip, 'data-quota-state', summary.status || 'unknown');
    setQuotaAttrIfChanged(chip, 'data-pool-key', summary.poolKey || '');
    setQuotaAttrIfChanged(chip, 'aria-label', summary.ariaLabel || summary.shortText);
    if (chip.title !== summary.tooltip) chip.title = summary.tooltip;
    if (chip._valNode && chip._valNode.textContent !== summary.shortText) {
      chip._valNode.textContent = summary.shortText;
    }
    const fill = chip._ringFill;
    if (!fill) return;
    if (summary.status === 'unknown' || (summary.fraction == null && summary.status === 'stale')) {
      setQuotaAttrIfChanged(fill, 'stroke-dasharray', '8 26.56');
      setQuotaAttrIfChanged(fill, 'stroke-dashoffset', '0');
    } else if (
      summary.fraction == null ||
      summary.status === 'exhausted' ||
      summary.status === 'no_permission' ||
      summary.status === 'error'
    ) {
      setQuotaAttrIfChanged(fill, 'stroke-dasharray', `0 ${MINI_QUOTA_RING_CIRC.toFixed(2)}`);
      setQuotaAttrIfChanged(fill, 'stroke-dashoffset', '0');
    } else {
      const clamped = Math.max(0, Math.min(1, Number(summary.fraction) || 0));
      const arcLen = clamped > 0 ? Math.max(1.6, clamped * MINI_QUOTA_RING_CIRC) : 0;
      const dashStr = `${MINI_QUOTA_RING_CIRC.toFixed(2)} ${MINI_QUOTA_RING_CIRC.toFixed(2)}`;
      const offsetStr = (MINI_QUOTA_RING_CIRC - arcLen).toFixed(2);
      setQuotaAttrIfChanged(fill, 'stroke-dasharray', dashStr);
      setQuotaAttrIfChanged(fill, 'stroke-dashoffset', offsetStr);
    }
  }

  /**
   * 创建贴近原生 UI 的小额度圆环进度与状态芯片节点。
   */
  function createMiniQuotaChipElement(summary, opts = {}) {
    const chip = document.createElement('span');
    chip.className = `ctx-model-quota-chip${opts.variant ? ` is-${opts.variant}` : ''}`;
    const svg = createQuotaSvgEl('svg');
    let fill = null;
    if (svg) {
      svg.setAttribute?.('class', 'ctx-quota-ring-svg');
      svg.setAttribute?.('width', '13');
      svg.setAttribute?.('height', '13');
      svg.setAttribute?.('viewBox', '0 0 16 16');
      svg.setAttribute?.('aria-hidden', 'true');
      const track = createQuotaSvgEl('circle');
      if (track) {
        track.setAttribute?.('class', 'ctx-quota-ring-track');
        track.setAttribute?.('cx', '8');
        track.setAttribute?.('cy', '8');
        track.setAttribute?.('r', String(MINI_QUOTA_RING_RADIUS));
        track.setAttribute?.('fill', 'none');
        track.setAttribute?.('stroke-width', '2');
        svg.appendChild(track);
      }
      fill = createQuotaSvgEl('circle');
      if (fill) {
        fill.setAttribute?.('class', 'ctx-quota-ring-fill');
        fill.setAttribute?.('cx', '8');
        fill.setAttribute?.('cy', '8');
        fill.setAttribute?.('r', String(MINI_QUOTA_RING_RADIUS));
        fill.setAttribute?.('fill', 'none');
        fill.setAttribute?.('stroke-width', '2');
        fill.setAttribute?.('stroke-linecap', 'round');
        fill.setAttribute?.('transform', 'rotate(-90 8 8)');
        svg.appendChild(fill);
      }
      chip.appendChild(svg);
    }
    const valNode = document.createElement('span');
    valNode.className = 'ctx-model-quota-val';
    chip.appendChild(valNode);
    chip._ringFill = fill;
    chip._valNode = valNode;
    updateMiniQuotaChipElement(chip, summary);
    return chip;
  }

  /**
   * 原地同步模型列表、下拉选择器与选中模型卡片中的小额度圆环状态，避免重建闪烁。
   */
  function syncModelListQuotaIndicators(quotaView = null, nowMs = Date.now(), force = false) {
    const view = quotaView || getSafeQuotaViewForModelList(nowMs);
    if (!view) return;
    const poolSig = (view.pools || [])
      .map(p => `${p.poolKey}:${p.remainingFraction ?? 'n'}:${p.noPermission ? 1 : 0}:${p.hasResetTime ? Math.floor(((p.resetAtMs || 0) - nowMs) / 60000) : 'x'}`)
      .join('|');
    const sig = `${view.syncState || ''}|${currentPanelLanguage}|${selectedProductKey || ''}|${poolSig}`;
    if (!force && sig === lastModelQuotaSyncSig) return;
    lastModelQuotaSyncSig = sig;

    const products = getKnownModelProducts();
    const byKey = new Map(products.map(p => [p.productKey, p]));
    const summaryCache = new Map();
    const getSummary = (prod) => {
      if (!prod) return null;
      if (!summaryCache.has(prod.productKey)) {
        summaryCache.set(prod.productKey, resolveProductQuotaSummary(prod, view, nowMs));
      }
      return summaryCache.get(prod.productKey);
    };

    for (const [pKey, entry] of modelListChipByProductKey.entries()) {
      const prod = byKey.get(pKey);
      if (!prod || !entry?.chipEl) continue;
      const summary = getSummary(prod);
      updateMiniQuotaChipElement(entry.chipEl, summary);
      if (entry.rowEl && entry.rowEl.title !== summary.tooltip) {
        entry.rowEl.title = summary.tooltip;
      }
    }

    if (ctxHeaderDropdownCtrl && typeof ctxHeaderDropdownCtrl.updateItemsInPlace === 'function') {
      ctxHeaderDropdownCtrl.updateItemsInPlace((val, itemEl, extraEl) => {
        const prod = byKey.get(val);
        if (!prod) return;
        const summary = getSummary(prod);
        if (extraEl) updateMiniQuotaChipElement(extraEl, summary);
        if (itemEl && itemEl.title !== summary.tooltip) itemEl.title = summary.tooltip;
      });
    }

    if (ctxCardQuotaSlot) {
      const currentProd = getSelectedProductObj();
      if (!currentProd) {
        ctxCardQuotaSlot.hidden = true;
      } else {
        const summary = getSummary(currentProd);
        ctxCardQuotaSlot.hidden = false;
        if (!ctxCardQuotaSlot._chipEl) {
          ctxCardQuotaSlot._chipEl = createMiniQuotaChipElement(summary, { variant: 'card' });
          if (typeof ctxCardQuotaSlot.replaceChildren === 'function') {
            ctxCardQuotaSlot.replaceChildren(ctxCardQuotaSlot._chipEl);
          } else {
            ctxCardQuotaSlot.appendChild(ctxCardQuotaSlot._chipEl);
          }
        } else {
          updateMiniQuotaChipElement(ctxCardQuotaSlot._chipEl, summary);
        }
      }
    }
  }

  function renderHeaderModelDropdown() {
    const products = getKnownModelProducts();
    if (!selectedProductKey && products.length) {
      selectedProductKey = activeSessionProductKey || products[0].productKey;
    }
    const currentProd = products.find(p => p.productKey === selectedProductKey) || products[0] || null;
    if (currentProd) {
      selectedProductKey = currentProd.productKey;
      selectedEditModelKey = (activeSessionProductKey === currentProd.productKey && activeSessionModelKey)
        ? activeSessionModelKey
        : (currentProd.members[0]?.modelId || currentProd.productKey);
    }

    if (btnCtxBackCurrent) {
      const shouldHideBack = !(manualModelSelection && activeSessionModelConfirmed && activeSessionProductKey && selectedProductKey && selectedProductKey !== activeSessionProductKey);
      btnCtxBackCurrent.hidden = shouldHideBack;
      const modelsToolbar = el('ctx-models-toolbar');
      if (modelsToolbar) modelsToolbar.hidden = shouldHideBack;
    }

    if (ctxModelSelect && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      if (typeof ctxModelSelect.replaceChildren === 'function') {
        const optionEntries = products.map((p) => {
          const specShort = formatProductSpecShort(p);
          const optText = `${p.productLabel}${specShort !== '—' ? ` (${specShort})` : ''}${p.productKey === activeSessionProductKey ? ` [${t('models.list.currentTag')}]` : ''}`;
          return { value: p.productKey, text: optText };
        });
        const optsSig = `${currentPanelLanguage}|${optionEntries.map(o => `${o.value}=${o.text}`).join('|')}`;
        if (ctxModelSelect._lastOptionsSig !== optsSig) {
          ctxModelSelect._lastOptionsSig = optsSig;
          const opts = optionEntries.map((entry) => {
            const opt = document.createElement('option');
            opt.value = entry.value;
            opt.textContent = entry.text;
            return opt;
          });
          ctxModelSelect.replaceChildren(...opts);
        }
        if (selectedProductKey && ctxModelSelect.value !== selectedProductKey) {
          ctxModelSelect.value = selectedProductKey;
        }
      }
    }

    if (ctxHeaderDropdownCtrl && typeof ctxHeaderDropdownCtrl.refresh === 'function') {
      ctxHeaderDropdownCtrl.refresh();
    }
  }

  ctxModelSelect?.addEventListener('change', (e) => {
    const val = e?.target?.value || '';
    if (!val) return;
    manualModelSelection = Boolean(activeSessionProductKey && val !== activeSessionProductKey);
    selectedProductKey = val;
    renderHeaderModelDropdown();
    renderModelSettingsTab();
  });

  function renderModelListGroup(products) {
    if (!ctxModelListEl || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    const nowMs = Date.now();
    const qView = getSafeQuotaViewForModelList(nowMs);
    if (!products.length) {
      modelListChipByProductKey.clear();
      ctxModelListEl._lastStructSig = '';
      ctxModelListEl.textContent = t('models.list.empty');
      return;
    }
    const catalogConfigs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const hasAccountCatalog = Array.isArray(catalogConfigs) && catalogConfigs.length > 0;
    const structSig = `${currentPanelLanguage}|${selectedProductKey || ''}|${activeSessionProductKey || ''}|${hasAccountCatalog ? 1 : 0}|${modelCapabilitiesVersion}|` + products.map((p) => {
      return `${p.productKey}:${p.productLabel}:${p.vendor}:${p.unavailable ? 1 : 0}:${p.inAccountCatalog ? 1 : 0}:${p.isHistorical ? 1 : 0}:${formatProductSpecShort(p)}:${Boolean(p.notice)}`;
    }).join(';');

    if (ctxModelListEl._lastStructSig === structSig && modelListChipByProductKey.size > 0) {
      syncModelListQuotaIndicators(qView, nowMs, false);
      return;
    }
    ctxModelListEl._lastStructSig = structSig;
    modelListChipByProductKey.clear();

    const outerPanel = el('panel');
    const prevPanelScrollTop = (outerPanel && typeof outerPanel.scrollTop === 'number') ? outerPanel.scrollTop : 0;
    const prevScrollTop = ctxModelListEl.scrollTop || 0;
    const accountProducts = hasAccountCatalog ? products.filter(p => p.inAccountCatalog) : products;
    const historyProducts = hasAccountCatalog ? products.filter(p => !p.inAccountCatalog) : [];

    const appendGroupRows = (fragNodes, vendor, list, isHistoryGroup = false) => {
      const grp = document.createElement('div');
      grp.className = 'ctx-model-group';

      const hdr = document.createElement('div');
      hdr.className = isHistoryGroup ? 'ctx-model-group-hdr is-history-hdr' : 'ctx-model-group-hdr';
      const dot = document.createElement('span');
      dot.className = 'ag-vendor-dot';
      if (dot.style) dot.style.background = VENDOR_DOT_COLORS[vendor] || VENDOR_DOT_COLORS['其他'];
      const vTxt = document.createElement('span');
      vTxt.textContent = isHistoryGroup ? t('models.list.historyGroup') : formatVendorLabel(vendor);
      hdr.appendChild(dot);
      hdr.appendChild(vTxt);
      grp.appendChild(hdr);

      for (const prod of list) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `ctx-product-row${prod.productKey === selectedProductKey ? ' is-active' : ''}${prod.unavailable ? ' is-unavailable' : ''}`;
        row.setAttribute('data-product-key', prod.productKey);

        const left = document.createElement('span');
        left.className = 'ctx-product-row-left';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'ctx-product-row-name';
        nameSpan.textContent = prod.productLabel;
        left.appendChild(nameSpan);

        if (prod.unavailable) {
          const unavailTag = document.createElement('span');
          unavailTag.className = 'ctx-product-row-unavailable-tag';
          unavailTag.textContent = t('models.card.modelUnavailable') || '不可用';
          if (prod.unavailabilityReason) unavailTag.title = prod.unavailabilityReason;
          left.appendChild(unavailTag);
        } else if (prod.notice) {
          const noticeTag = document.createElement('span');
          noticeTag.className = 'ctx-product-row-notice-tag';
          noticeTag.textContent = 'Notice';
          noticeTag.title = typeof prod.notice === 'string' ? prod.notice : JSON.stringify(prod.notice);
          left.appendChild(noticeTag);
        }

        if (prod.productKey === activeSessionProductKey) {
          const curTag = document.createElement('span');
          curTag.className = 'ag-dropdown-badge';
          curTag.textContent = t('models.list.currentTag');
          left.appendChild(curTag);
        } else if (isHistoryGroup || prod.isHistorical) {
          const histTag = document.createElement('span');
          histTag.className = 'ctx-product-row-history-tag';
          histTag.textContent = t('models.list.historyTag');
          left.appendChild(histTag);
        }

        const right = document.createElement('span');
        right.className = 'ctx-product-row-right';
        const qSummary = resolveProductQuotaSummary(prod, qView, nowMs);
        const qChip = createMiniQuotaChipElement(qSummary, { variant: 'row' });
        right.appendChild(qChip);
        const specShort = formatProductSpecShort(prod);
        if (specShort && specShort !== '—') {
          const valSpan = document.createElement('span');
          valSpan.className = 'ctx-product-row-val';
          valSpan.textContent = specShort;
          right.appendChild(valSpan);
        }
        row.title = qSummary.tooltip;
        modelListChipByProductKey.set(prod.productKey, { rowEl: row, chipEl: qChip });

        row.appendChild(left);
        row.appendChild(right);
        row.addEventListener('click', () => {
          manualModelSelection = Boolean(activeSessionProductKey && prod.productKey !== activeSessionProductKey);
          selectedProductKey = prod.productKey;
          renderHeaderModelDropdown();
          renderModelSettingsTab();
        });
        grp.appendChild(row);
      }
      fragNodes.push(grp);
    };

    const groups = new Map();
    for (const p of accountProducts) {
      if (!groups.has(p.vendor)) groups.set(p.vendor, []);
      groups.get(p.vendor).push(p);
    }
    const fragNodes = [];
    for (const [vendor, list] of groups.entries()) {
      appendGroupRows(fragNodes, vendor, list, false);
    }
    if (historyProducts.length > 0) {
      appendGroupRows(fragNodes, '其他', historyProducts, true);
    }
    if (typeof ctxModelListEl.replaceChildren === 'function') {
      ctxModelListEl.replaceChildren(...fragNodes);
    }
    if (prevScrollTop > 0 && Math.abs((ctxModelListEl.scrollTop || 0) - prevScrollTop) > 1) {
      ctxModelListEl.scrollTop = prevScrollTop;
    }
    if (outerPanel && prevPanelScrollTop > 0 && Math.abs((outerPanel.scrollTop || 0) - prevPanelScrollTop) > 1) {
      outerPanel.scrollTop = prevPanelScrollTop;
    }
  }

  function findLatestProductObservation(product, activeConvId = null) {
    if (!product) return { latestBudgetObs: null, latestServiceLimitObs: null };
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    if (product.productKey) memberIds.add(product.productKey);
    let latestBudgetObs = null;
    let latestServiceLimitObs = null;

    for (const mid of memberIds) {
      const obs = observedByModelId.get(mid);
      if (!obs) continue;
      if (activeConvId && obs.convoId && obs.convoId !== activeConvId) continue;
      if (obs.budget > 0 && (!latestBudgetObs || obs.ts > latestBudgetObs.ts)) {
        latestBudgetObs = obs;
      }
      if (obs.serviceLimit > 0 && (!latestServiceLimitObs || obs.ts > latestServiceLimitObs.ts)) {
        latestServiceLimitObs = obs;
      }
    }
    return { latestBudgetObs, latestServiceLimitObs };
  }

  function renderModelDetailCard(product) {
    if (!product) {
      if (ctxCardProductName) ctxCardProductName.textContent = t('models.card.waiting');
      if (ctxCardVendorName) ctxCardVendorName.textContent = '—';
      if (ctxCardQuotaSlot) ctxCardQuotaSlot.hidden = true;
      if (ctxCardEffortsList) ctxCardEffortsList.textContent = t('models.card.effortsEmpty');
      if (ctxCardSessionEffort) ctxCardSessionEffort.hidden = true;
      return;
    }

    if (ctxCardVendorDot?.style) {
      ctxCardVendorDot.style.background = VENDOR_DOT_COLORS[product.vendor] || VENDOR_DOT_COLORS['其他'];
    }
    if (ctxCardVendorName) ctxCardVendorName.textContent = formatVendorLabel(product.vendor);
    if (ctxCardQuotaSlot) {
      const nowMs = Date.now();
      const qSummary = resolveProductQuotaSummary(product, null, nowMs);
      ctxCardQuotaSlot.hidden = false;
      if (!ctxCardQuotaSlot._chipEl) {
        ctxCardQuotaSlot._chipEl = createMiniQuotaChipElement(qSummary, { variant: 'card' });
        if (typeof ctxCardQuotaSlot.replaceChildren === 'function') {
          ctxCardQuotaSlot.replaceChildren(ctxCardQuotaSlot._chipEl);
        } else {
          ctxCardQuotaSlot.appendChild(ctxCardQuotaSlot._chipEl);
        }
      } else {
        updateMiniQuotaChipElement(ctxCardQuotaSlot._chipEl, qSummary);
      }
    }
    if (ctxCardProductName) {
      ctxCardProductName.textContent = product.unavailable
        ? `${product.productLabel} [${t('models.card.modelUnavailable') || '不可用'}]`
        : product.productLabel;
    }

    const efforts = product.members.map(m => m.effort).filter(Boolean);
    if (ctxCardEffortsList) {
      ctxCardEffortsList.textContent = efforts.length
        ? t('models.card.effortsList', { list: efforts.map(formatEffortZh).join(' · ') })
        : t('models.card.effortStandard');
    }
    if (ctxCardSessionEffort) {
      if (activeSessionProductKey === product.productKey && activeSessionEffort) {
        ctxCardSessionEffort.textContent = t('models.card.sessionEffort', { effort: formatEffortZh(activeSessionEffort) });
        ctxCardSessionEffort.hidden = false;
      } else {
        ctxCardSessionEffort.hidden = true;
      }
    }

    const capSummary = getProductCapabilitySummary(product);
    if (ctxCapWindowEl) {
      ctxCapWindowEl.textContent = capSummary?.maxTokens ? `${fmt(capSummary.maxTokens)} tokens` : t('common.unknown');
    }
    if (ctxCapOutputEl) {
      ctxCapOutputEl.textContent = capSummary?.maxOutputTokens != null ? `${fmt(capSummary.maxOutputTokens)} tokens` : t('common.unknown');
    }
    if (ctxCapModelMaxEl) {
      ctxCapModelMaxEl.textContent = capSummary?.modelTheoreticalMaxTokens != null
        ? `${fmt(capSummary.modelTheoreticalMaxTokens)} tokens`
        : t('common.unknown');
    }
    if (ctxCapDefaultEl) {
      ctxCapDefaultEl.textContent = capSummary?.stockDefaultBudget != null
        ? `${fmt(capSummary.stockDefaultBudget)} tokens`
        : t('common.unknown');
    }
    if (ctxCapFormulaEl) {
      ctxCapFormulaEl.textContent = '';
    }

    if (ctxCardTierCapsRowEl && ctxCardTierCapsEl) {
      if (capSummary?.tierDetails?.length) {
        ctxCardTierCapsRowEl.hidden = false;
        const lines = capSummary.tierDetails.map(td => {
          const tierName = td.effort ? formatEffortZh(td.effort) : (td.modelId || '标准');
          const winTxt = td.maxTokens ? `窗口 ${fmt(td.maxTokens)}` : '窗口未知';
          const outTxt = td.maxOutputTokens != null ? `最大输出 ${fmt(td.maxOutputTokens)}` : '输出未知';
          const maxInTxt = (td.maxTokens && td.maxOutputTokens != null && td.maxTokens > td.maxOutputTokens)
            ? `理论输入上限 ${fmt(td.maxTokens - td.maxOutputTokens)}`
            : '上限未知';
          return `${tierName}：${winTxt} / ${outTxt} / ${maxInTxt}`;
        });
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardTierCapsEl.replaceChildren === 'function') {
          ctxCardTierCapsEl.replaceChildren(...lines.map(l => {
            const d = document.createElement('div');
            d.textContent = l;
            return d;
          }));
        } else {
          ctxCardTierCapsEl.textContent = lines.join(' | ');
        }
      } else {
        ctxCardTierCapsRowEl.hidden = true;
      }
    }

    const { latestBudgetObs, latestServiceLimitObs } = findLatestProductObservation(product);
    if (ctxCardObservedBudgetEl) {
      if (latestBudgetObs?.budget > 0) {
        const effTxt = latestBudgetObs.effort ? ` · ${formatEffortZh(latestBudgetObs.effort)}` : '';
        const tTxt = latestBudgetObs.ts ? ` · ${formatMonthDayTime(latestBudgetObs.ts)}` : '';
        ctxCardObservedBudgetEl.textContent = `${formatKShort(latestBudgetObs.budget)}${effTxt}${tTxt}`;
        ctxCardObservedBudgetEl.title = t('models.card.observedTitle', { val: fmt(latestBudgetObs.budget) });
      } else {
        ctxCardObservedBudgetEl.textContent = t('models.card.observedBudgetNone');
        ctxCardObservedBudgetEl.title = '';
      }
    }
    if (ctxCardServiceLimitEl) {
      if (latestServiceLimitObs?.serviceLimit > 0) {
        const tTxt = latestServiceLimitObs.ts ? `（${formatMonthDayTime(latestServiceLimitObs.ts)}）` : '';
        ctxCardServiceLimitEl.textContent = `${t('models.card.serviceLimit', { val: formatKShort(latestServiceLimitObs.serviceLimit) })}${tTxt}`;
        ctxCardServiceLimitEl.title = t('models.card.serviceLimitTitle', { val: fmt(latestServiceLimitObs.serviceLimit) });
        ctxCardServiceLimitEl.hidden = false;
      } else {
        ctxCardServiceLimitEl.title = '';
        ctxCardServiceLimitEl.hidden = true;
      }
    }

    if (ctxCardObservedSpeedEl) {
      const mergedCalls = mergeAvailableSpeedCalls();
      const summaryRows = typeof summarizeSpeedByModel === 'function'
        ? summarizeSpeedByModel(mergedCalls, { days: 'all', cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [] })
        : [];
      const summaryByExact = new Map(summaryRows.map(r => [r.modelExactId, r]));
      const members = product.members?.length ? product.members : [{ modelId: product.productKey, label: product.productLabel, effort: null }];
      const lines = [];
      for (const m of members) {
        const stat = summaryByExact.get(m.modelId);
        const prefix = m.effort ? `${formatEffortZh(m.effort)} ` : '';
        if (stat && stat.medianTps != null) {
          const tStr = stat.maxTs ? ` · ${formatMonthDayTime(stat.maxTs)}` : '';
          const lowNote = stat.lowSample ? t('models.card.lowSampleParen') : '';
          lines.push(t('models.card.speedLineText', { prefix, tps: stat.medianTps, count: stat.count, low: lowNote, ts: tStr }));
        } else {
          lines.push(`${prefix}${t('models.card.observedSpeedNone')}`);
        }
      }
      if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardObservedSpeedEl.replaceChildren === 'function') {
        ctxCardObservedSpeedEl.replaceChildren(...lines.map(txt => {
          const d = document.createElement('div');
          d.textContent = txt;
          return d;
        }));
      } else {
        ctxCardObservedSpeedEl.textContent = lines.join(' | ');
      }
    }

    if (ctxCardHintsEl) {
      const hints = [];
      if (product.notice) {
        const nText = typeof product.notice === 'string' ? product.notice : (product.notice.message || JSON.stringify(product.notice));
        hints.push(`模型提示：${nText}`);
      }
      if (product.unavailable && product.unavailabilityReason) {
        hints.push(`不可用原因：${product.unavailabilityReason}`);
      } else if (product.partialUnavailable && product.unavailabilityReason) {
        hints.push(`部分档位受限：${product.unavailabilityReason}`);
      }
      if (hints.length > 0) {
        ctxCardHintsEl.hidden = false;
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardHintsEl.replaceChildren === 'function') {
          ctxCardHintsEl.replaceChildren(...hints.map(h => {
            const div = document.createElement('div');
            div.className = 'ctx-card-hint-item';
            div.textContent = h;
            return div;
          }));
        } else {
          ctxCardHintsEl.textContent = hints.join(' ');
        }
      } else {
        ctxCardHintsEl.hidden = true;
      }
    }
  }

  function renderModelSettingsTab() {
    const products = getKnownModelProducts();
    const currentProd = getSelectedProductObj();
    renderModelListGroup(products);
    renderModelDetailCard(currentProd);
  }

  function recordObservationFromSummary(summary, convoId, opts = {}) {
    if (!summary) return;
    const rawId = resolveStableModelKeyClient(summary);
    if (!rawId && !summary.model) return;
    const g = groupProductSafe({
      modelId: rawId || summary.model,
      label: summary.model || rawId,
      modelOrAlias: summary.modelOrAlias,
      effort: summary.effort
    });
    if (!g?.productKey) return;
    const budget = Number(summary.budget || 0);
    const serviceLimit = Number(summary.serviceLimit || 0);
    if (budget <= 0 && serviceLimit <= 0) return;
    const ts = opts.ts || Date.now();
    const entry = {
      convoId: convoId || state.activeConversationId || state.route || null,
      productKey: g.productKey,
      modelId: rawId || g.productKey,
      effort: g.effort || summary.effort || null,
      budget,
      serviceLimit,
      ts
    };
    observedByModelId.set(entry.modelId, entry);
    observedByModelId.set(g.productKey, entry);
  }

  function syncContextModelSelectionFromState() {
    const hostSelected = extractHostSelectedModel();
    let exactId = null;
    let detectedProduct = null;
    let detectedEffort = null;
    let isConfirmed = false;
    const activeConvId = state.activeConversationId || state.conversationId || state.route || null;

    if (hostSelected && hostSelected.productKey) {
      exactId = hostSelected.modelId;
      detectedProduct = hostSelected.productKey;
      detectedEffort = hostSelected.effort;
      isConfirmed = true;
    } else if (state.latest && activeConvId) {
      const candidateId = resolveStableModelKeyClient(state.latest);
      if (candidateId) {
        const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
        const matchedCfg = Array.isArray(configs) && configs.length > 0
          ? configs.find(c => (resolveStableModelKeyClient(c) || c.modelId) === candidateId)
          : null;
        const isAllowedInCatalog = Array.isArray(configs) && configs.length > 0
          ? Boolean(matchedCfg && !matchedCfg.isHistorical)
          : true;
        if (isAllowedInCatalog) {
          const g = groupProductSafe({
            modelId: candidateId,
            label: state.latest?.model || candidateId,
            modelOrAlias: state.latest?.modelOrAlias,
            effort: state.latest?.effort
          });
          exactId = candidateId;
          detectedProduct = g.productKey;
          detectedEffort = g.effort || state.latest?.effort || null;
          isConfirmed = true;
        }
      }
    }

    if (isConfirmed && exactId && detectedProduct) {
      activeSessionModelKey = exactId;
      activeSessionProductKey = detectedProduct;
      activeSessionEffort = detectedEffort;
      activeSessionModelConfirmed = true;
    } else {
      activeSessionModelConfirmed = false;
      activeSessionModelKey = null;
      activeSessionProductKey = null;
      activeSessionEffort = null;
    }

    if (activeSessionModelConfirmed && activeSessionProductKey && (!manualModelSelection || !selectedProductKey)) {
      selectedProductKey = activeSessionProductKey;
      selectedEditModelKey = activeSessionModelKey;
    }
    renderHeaderModelDropdown();
    if (typeof renderQuotaBoard === 'function') renderQuotaBoard();
    if (!isContextSettingsView && activeContextTab === 'models') {
      renderModelSettingsTab();
    } else if (!isContextSettingsView && activeContextTab === 'speed') {
      renderSpeedComparisonTab();
    }
  }

  // 二级抽屉 2（当前会话内）: 底层技术抽屉折叠展开
  const btnDetails = el('btn-toggle-details');
  const drawerBody = el('drawer-body');
  const drawerArrow = el('drawer-arrow');
  btnDetails?.addEventListener('click', () => {
    if (!drawerBody) return;
    const isHidden = drawerBody.style.display === 'none' || !drawerBody.style.display;
    drawerBody.style.display = isHidden ? 'block' : 'none';
    if (drawerArrow) drawerArrow.textContent = isHidden ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
    btnDetails.setAttribute('aria-expanded', String(isHidden));
  });


  el('refresh').addEventListener('click', () => { if (state.route && !state.scanBusy) void scan(state.generation, state.route, true); });
  function renderFiles(session) {
    const parent = el('files');
    if (!parent) return;
    if (!session) {
      const noSession = !state.route;
      const sig = `${noSession ? 'no-session' : 'none'}|${currentPanelLanguage}`;
      if (parent._lastRenderSig === sig) return;
      parent._lastRenderSig = sig;
      const item = document.createElement('p');
      item.textContent = noSession ? t('files.noSession') : t('files.reading');
      parent.replaceChildren(item);
      return;
    }
    if (!Array.isArray(session.attachments) || !session.attachments.length) {
      const sig = `empty|${currentPanelLanguage}`;
      if (parent._lastRenderSig === sig) return;
      parent._lastRenderSig = sig;
      const item = document.createElement('p');
      item.textContent = t('files.empty');
      parent.replaceChildren(item);
      return;
    }
    const filesSig = `${currentPanelLanguage}|` + session.attachments.map(file =>
      `${file.name}|${file.references}|${file.width || 0}x${file.height || 0}|${file.chars || 0}|${file.sheets ?? ''}|${file.cells || 0}|${file.hiddenSheets || 0}|${file.source || ''}|${range(file) || ''}|${(file.unknownParts || []).join(',')}`
    ).join(';');
    if (parent._lastRenderSig === filesSig) return;
    parent._lastRenderSig = filesSig;

    const nodes = [];
    for (const file of session.attachments) {
      const item = document.createElement('div'); item.className = 'file';
      const name = document.createElement('div'); name.className = 'file-name'; name.textContent = `${file.name} ${file.references > 1 ? t('files.refs', { n: file.references }) : ''}`;
      const detail = document.createElement('div'); detail.className = 'file-detail';
      const sizeInfo = file.width && file.height
        ? t('files.px', { w: file.width, h: file.height })
        : (typeof file.chars === 'number' && file.chars > 0 ? t('files.chars', { n: fmt(file.chars) }) : '');
      const tokenInfo = range(file) ? `${range(file)} token` : t('files.tokUnknown');
      const sheetsPart = file.sheets != null ? t('files.sheets', { sheets: file.sheets, cells: fmt(file.cells) }) : '';
      const hiddenPart = file.hiddenSheets ? t('files.hiddenSheets', { n: file.hiddenSheets }) : '';
      detail.textContent = `${file.source === 'assistant' ? t('files.assistantPrefix') : ''}${tokenInfo}${sizeInfo ? ` · ${sizeInfo}` : ''}${sheetsPart}${hiddenPart}`;
      item.appendChild(name); item.appendChild(detail);
      if (file.unknownParts?.length) { const unknown = document.createElement('div'); unknown.className = 'file-unknown'; unknown.textContent = t('files.unknownPrefix', { parts: file.unknownParts.join('；') }); item.appendChild(unknown); }
      nodes.push(item);
    }
    const outerPanel = el('panel');
    const prevPanelScrollTop = (outerPanel && typeof outerPanel.scrollTop === 'number') ? outerPanel.scrollTop : 0;
    parent.replaceChildren();
    for (const n of nodes) parent.appendChild(n);
    if (outerPanel && prevPanelScrollTop > 0 && Math.abs((outerPanel.scrollTop || 0) - prevPanelScrollTop) > 1) {
      outerPanel.scrollTop = prevPanelScrollTop;
    }
  }

  function hasNonEmptySessionCorpus(session) {
    if (!session) return false;
    return Boolean(
      (session.steps || 0) > 0 ||
      (session.userMessages || 0) > 0 ||
      (session.assistantMessages || 0) > 0 ||
      (session.total && ((session.total.chars || 0) > 0 || (session.total.high || 0) > 0))
    );
  }

  /**
   * 统一判定当前是否处于未开始会话（无路由）或已创建但尚无对话轮次的空会话。
   * 保证顶栏圆环、悬浮气泡、上下文浮层与底层技术抽屉严格同源，杜绝切新会话时残留上一会话数据。
   */
  function resolveSessionEmptyPhase(d, session, disp, stale) {
    if (!state.route) return 'no_session';
    if (d || disp?.isError || disp?.kind === 'canceled' || stale || state.requestError) return null;
    if (state.livePendingRequest && state.livePendingRequest.cascadeId === state.route) return null;
    if (hasNonEmptySessionCorpus(session)) return null;
    const confirmedEmptyByPoll = Boolean(state.requestAt > 0 && state.count === 0 && !state.requestBusy);
    const confirmedEmptyByScan = Boolean(state.scan && !state.scanBusy && !state.scanError && (session?.steps || 0) === 0);
    if (confirmedEmptyByPoll || confirmedEmptyByScan) return 'empty_session';
    return null;
  }

  function updateRingAndBubble(d, session, pct, danger, stale, incomplete, emptyPhase = null) {
    const ringFill = el('ring-fill');
    const tipTitle = el('ctx-tip-title');
    const tipPct = el('ctx-tip-pct');
    const tipDetail = el('ctx-tip-detail');

    // 区分常态颜色与高占用告警状态（新会话 / 空会话强制恢复常态，绝不残留上一会话告警色）
    let occupancy = 'normal';
    if (!emptyPhase) {
      if (danger || (pct != null && pct >= 90)) {
        occupancy = 'danger';
      } else if ((pct != null && pct >= 75) || stale) {
        occupancy = 'warn';
      }
    }
    host.setAttribute('data-occupancy', occupancy);

    // 1. 圆环进度与空闲/未知容量状态表达（新会话/空会话显示干净空环；未知容量显示虚线环，绝不画成 0% 或 100%）
    if (ringFill) {
      if (emptyPhase === 'no_session' || emptyPhase === 'empty_session') {
        ringFill.setAttribute('data-ring-state', 'idle');
        ringFill.setAttribute('stroke-dasharray', `0 ${RING_CIRCUMFERENCE.toFixed(2)}`);
        ringFill.style.opacity = '0';
      } else if (d?.exceeded) {
        ringFill.setAttribute('data-ring-state', 'exceeded');
        ringFill.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`);
        ringFill.style.opacity = '1';
      } else if (pct != null) {
        ringFill.setAttribute('data-ring-state', 'determinate');
        if (pct <= 0) {
          ringFill.setAttribute('stroke-dasharray', `0 ${RING_CIRCUMFERENCE.toFixed(2)}`);
          ringFill.style.opacity = '0';
        } else {
          const arcLen = Math.max(1.8, (Math.min(100, pct) / 100) * RING_CIRCUMFERENCE);
          ringFill.setAttribute('stroke-dasharray', `${arcLen.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`);
          ringFill.style.opacity = '1';
        }
      } else {
        // 容量未知 / 仅估算 / 尚未就绪：使用均匀虚线环段表示非确定比例，不画成 0% 空环或 100% 满环
        ringFill.setAttribute('data-ring-state', d?.estimated ? 'estimated' : 'unknown');
        ringFill.setAttribute('stroke-dasharray', '3.2 4.97');
        ringFill.style.opacity = '0.55';
      }
    }

    // 2. 悬停信息气泡三层文案（标题 — 使用比例 — 用量与容量）
    if (!tipTitle || !tipPct || !tipDetail) return;

    if (emptyPhase === 'no_session') {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.noSession');
      tipDetail.textContent = t('tip.detail.noSession');
      if (state.tooltipOpen) positionContextTooltip();
      return;
    }
    if (emptyPhase === 'empty_session') {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.emptySession');
      tipDetail.textContent = t('tip.detail.emptySession');
      if (state.tooltipOpen) positionContextTooltip();
      return;
    }

    const disp = resolveDisplayStatus(d, session);
    if (disp.isError || disp.kind === 'canceled') {
      tipTitle.textContent = disp.tipTitle;
      tipPct.textContent = disp.tipPct;
      tipDetail.textContent = disp.tipDetail;
    } else if (stale && d?.actual != null && d?.budget) {
      const usedRound = Math.min(100, Math.max(0, Math.round((d.actual / d.budget) * 100)));
      const remRound = Math.max(0, 100 - usedRound);
      tipTitle.textContent = t('tip.title.stale');
      tipPct.textContent = t('tip.pct.staleVal', { used: usedRound, rem: remRound });
      tipDetail.textContent = t('tip.detail.usedOfBudget', { used: fmtBubbleToken(d.actual), budget: fmtBubbleToken(d.budget), inc: '' });
    } else if (stale) {
      tipTitle.textContent = t('tip.title.stale');
      tipPct.textContent = t('tip.pct.staleUnknown');
      tipDetail.textContent = hasNonEmptySessionCorpus(session)
        ? t('tip.detail.sessionEst', { low: fmtBubbleToken(session.total.low), high: fmtBubbleToken(session.total.high) })
        : t('tip.detail.waitBg');
    } else if (d?.actual != null && d?.budget) {
      const rawPct = pct != null ? pct : (d.actual / d.budget) * 100;
      const usedRound = rawPct > 0 && rawPct < 1 ? 1 : Math.min(100, Math.max(0, Math.round(rawPct)));
      const remRound = Math.max(0, 100 - usedRound);
      if (rawPct >= 90) {
        tipTitle.textContent = t('tip.title.high90');
        tipPct.textContent = t('tip.pct.high90', { used: usedRound, rem: remRound });
      } else if (rawPct >= 75) {
        tipTitle.textContent = t('tip.title.high75');
        tipPct.textContent = t('tip.pct.high75', { used: usedRound, rem: remRound });
      } else {
        tipTitle.textContent = t('tip.title.normal');
        tipPct.textContent = t('tip.pct.normal', { used: usedRound, rem: remRound });
      }
      tipDetail.textContent = t('tip.detail.usedOfBudget', {
        used: fmtBubbleToken(d.actual),
        budget: fmtBubbleToken(d.budget),
        inc: incomplete ? t('tip.detail.incSuffix') : ''
      });
    } else if (d?.actual != null && !d?.budget) {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.noBudget');
      tipDetail.textContent = t('tip.detail.usedNoBudget', { used: fmtBubbleToken(d.actual) });
    } else if (d?.estimated || d?.estimate != null) {
      tipTitle.textContent = t('tip.title.est');
      tipPct.textContent = t('tip.pct.estOnly');
      const budgetPart = d.budget ? t('tip.detail.estBudgetPart', { budget: fmtBubbleToken(d.budget) }) : t('tip.detail.estNoBudgetPart');
      tipDetail.textContent = t('tip.detail.estUsed', { used: fmtBubbleToken(d.estimate), budget: budgetPart });
    } else if (hasNonEmptySessionCorpus(session)) {
      tipTitle.textContent = t('tip.title.est');
      tipPct.textContent = t('tip.pct.waitStats');
      tipDetail.textContent = t('tip.detail.sessionCum', { low: fmtBubbleToken(session.total.low), high: fmtBubbleToken(session.total.high) });
    } else {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.notReady');
      tipDetail.textContent = t('tip.detail.readingSession');
    }

    if (state.tooltipOpen) positionContextTooltip();
  }

  let lastCallCardLang = '';
  let timelineFetchController = null;
  let timelineFetchSeq = 0;

  function prefersReducedMotionNow() {
    try {
      return Boolean(typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function formatCallTimeStr(call) {
    if (!call) return '—';
    const rawTs = call.timestamp || (call.created_at ? Date.parse(call.created_at) : NaN);
    if (!Number.isFinite(rawTs) || rawTs <= 0) return t('session.latestCall.unknownVal');
    try {
      return new Date(rawTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch {
      return new Date(rawTs).toLocaleTimeString();
    }
  }

  function formatCallModelTitle(call) {
    if (!call) return t('session.latestCall.unknownVal');
    if (call.isPlaceholderOnly && !call.isRoutedModelVerified) {
      const rawId = call.rawPlaceholderId || call.modelExactId || call.model || '';
      return rawId ? t('session.latestCall.unknownMappedModel', { id: rawId }) : t('session.latestCall.unknownVal');
    }
    const rawLbl = call.modelLabel || (call.model && !/^model_/i.test(String(call.model)) ? String(call.model) : '');
    if (rawLbl) {
      if (typeof splitModelDisplayAndEffort === 'function') {
        const split = splitModelDisplayAndEffort(rawLbl, call.effort);
        if (split.baseLabel) return split.baseLabel;
      }
      return rawLbl;
    }
    if (call.stableModelId && !/^model_placeholder_/i.test(String(call.stableModelId))) return String(call.stableModelId);
    if (call.modelExactId && !/^model_placeholder_/i.test(String(call.modelExactId))) return String(call.modelExactId);
    if (call.model && !/^model_placeholder_/i.test(String(call.model))) return String(call.model);
    if (call.rawPlaceholderId || call.modelExactId || call.model) {
      return t('session.latestCall.unknownMappedModel', { id: call.rawPlaceholderId || call.modelExactId || call.model });
    }
    return t('session.latestCall.unknownVal');
  }

  function buildCallDisplaySignature(call) {
    if (!call) return '';
    return [
      call.callId || '',
      call.outcomeStatus || call.status || '',
      call.inputTokens ?? '',
      call.cacheReadTokens ?? '',
      call.outputTokens ?? '',
      call.totalTokens ?? '',
      call.modelExactId || call.model || '',
      call.modelLabel || '',
      call.effort || '',
      call.durationSec ?? '',
      call.ttftSec ?? '',
      call.error || '',
      call.agentRole || ''
    ].join('|');
  }

  function resolveLatestSessionCallRecord() {
    if (!state.route) return null;
    const rawPool = [];
    if (Array.isArray(state.sessionCalls)) {
      for (const c of state.sessionCalls) {
        if (c) rawPool.push(c);
      }
    }
    if (Array.isArray(state.scan?.recentGeneratorCalls)) {
      for (const c of state.scan.recentGeneratorCalls) {
        if (c) rawPool.push(c);
      }
    }
    if (state.scan?.latestCallRecord) {
      rawPool.push(state.scan.latestCallRecord);
    }
    if (!rawPool.length) return null;

    const mergedById = new Map();
    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    for (const raw of rawPool) {
      const norm = typeof normalizeSessionCallRecord === 'function'
        ? normalizeSessionCallRecord(raw, { cascadeId: state.route, cascadeModelConfigs: configs })
        : raw;
      if (!norm || !norm.callId) continue;
      const prev = mergedById.get(norm.callId);
      if (!prev) {
        mergedById.set(norm.callId, norm);
        continue;
      }
      // 同一 callId 从不同源补齐耗时、精确模型或状态，不产生第二条，并保持输入与缓存占比严格一致
      const prevTotIn = prev.hasInputCacheFields && Number.isFinite(Number(prev.totalInputTokens)) ? Number(prev.totalInputTokens) : -1;
      const normTotIn = norm.hasInputCacheFields && Number.isFinite(Number(norm.totalInputTokens)) ? Number(norm.totalInputTokens) : -1;
      const useNormSplit = norm.hasInputCacheFields && (
        !prev.hasInputCacheFields ||
        normTotIn > prevTotIn ||
        (normTotIn === prevTotIn && (prev.status === 'streaming' || norm.status !== 'streaming'))
      );
      const mergedHasSplit = Boolean(norm.hasInputCacheFields || prev.hasInputCacheFields);
      const mergedInp = useNormSplit ? norm.inputTokens : (prev.hasInputCacheFields ? prev.inputTokens : norm.inputTokens);
      const mergedCache = useNormSplit ? norm.cacheReadTokens : (prev.hasInputCacheFields ? prev.cacheReadTokens : norm.cacheReadTokens);
      const mergedOut = Math.max(Number(norm.outputTokens) || 0, Number(prev.outputTokens) || 0) || norm.outputTokens;
      const mergedTot = Math.max(Number(norm.totalTokens) || 0, Number(prev.totalTokens) || 0) || norm.totalTokens;
      const mergedCacheStats = typeof computeCacheReadStats === 'function'
        ? computeCacheReadStats({
            inputTokens: mergedHasSplit ? mergedInp : undefined,
            cacheReadTokens: mergedHasSplit ? mergedCache : undefined,
            outputTokens: mergedOut,
            totalTokens: mergedTot,
            hasInputCacheFields: mergedHasSplit
          })
        : null;
      mergedById.set(norm.callId, {
        ...prev,
        ...norm,
        modelExactId: norm.modelExactId || prev.modelExactId || null,
        modelLabel: norm.modelLabel || prev.modelLabel || null,
        effort: norm.effort || prev.effort || null,
        ttftSec: norm.ttftSec ?? prev.ttftSec ?? null,
        durationSec: norm.durationSec ?? prev.durationSec ?? null,
        tps: norm.tps ?? prev.tps ?? null,
        streamingTps: norm.streamingTps ?? prev.streamingTps ?? null,
        error: norm.error || prev.error || null,
        errorClassification: norm.errorClassification || prev.errorClassification || null,
        hasInputCacheFields: mergedCacheStats ? mergedCacheStats.hasInputCacheFields : mergedHasSplit,
        inputTokens: mergedCacheStats ? mergedCacheStats.uncachedInput : mergedInp,
        cacheReadTokens: mergedCacheStats ? mergedCacheStats.cacheRead : mergedCache,
        totalInputTokens: mergedCacheStats ? mergedCacheStats.totalInput : (useNormSplit ? norm.totalInputTokens : (prev.hasInputCacheFields ? prev.totalInputTokens : norm.totalInputTokens)),
        cacheReadRatio: mergedCacheStats ? mergedCacheStats.cacheReadRatio : (useNormSplit ? norm.cacheReadRatio : prev.cacheReadRatio),
        cacheReadPct: mergedCacheStats ? mergedCacheStats.cacheReadPct : (useNormSplit ? norm.cacheReadPct : prev.cacheReadPct),
        cacheStatus: mergedCacheStats ? mergedCacheStats.cacheStatus : (useNormSplit ? norm.cacheStatus : prev.cacheStatus),
        outputTokens: mergedOut,
        totalTokens: mergedCacheStats && mergedCacheStats.totalTokens != null ? Math.max(mergedTot || 0, mergedCacheStats.totalTokens) : mergedTot,
        timestamp: norm.timestamp || prev.timestamp || null,
        created_at: norm.created_at || prev.created_at || null,
        stepIndex: norm.stepIndex ?? prev.stepIndex ?? null
      });
    }

    const candidates = Array.from(mergedById.values());
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const ta = Number(a.timestamp) || 0;
      const tb = Number(b.timestamp) || 0;
      if (ta !== tb) return ta - tb;
      const sa = a.stepIndex != null ? Number(a.stepIndex) : -1;
      const sb = b.stepIndex != null ? Number(b.stepIndex) : -1;
      if (sa !== sb) return sa - sb;
      if (a.status === 'streaming' && b.status !== 'streaming') return 1;
      if (b.status === 'streaming' && a.status !== 'streaming') return -1;
      return 0;
    });
    return candidates[candidates.length - 1];
  }

  function isElementActivelyInspected() {
    try {
      const det = el('latest-call-details');
      const tl = el('session-timeline-drawer');
      if (det && state.latestCallDetailOpen && typeof det.matches === 'function' && det.matches(':hover')) return true;
      if (tl && state.historyDrawerOpen && typeof tl.matches === 'function' && tl.matches(':hover')) return true;
      const activeEl = shadow?.activeElement || document?.activeElement;
      if (activeEl && ((det && det.contains?.(activeEl)) || (tl && tl.contains?.(activeEl)))) return true;
      const sel = shadow?.getSelection?.() || window?.getSelection?.();
      if (sel && String(sel.toString() || '').trim().length > 0 && sel.anchorNode) {
        const card = el('latest-call-card');
        if (card && card.contains?.(sel.anchorNode)) return true;
      }
    } catch { }
    return false;
  }

  function isCallCardReadingProtected(incomingCall) {
    if (!state.displayedCallRecord || !incomingCall) return false;
    if (state.pinnedCallRecord) return true;
    const differentCall = incomingCall.callId !== state.displayedCallRecord.callId;
    if (!differentCall) return false;
    if (state.latestCallDetailOpen && state.displayedCallRecord.status !== 'streaming') return true;
    if (isElementActivelyInspected()) return true;
    return false;
  }

  function resolveCallStatusDisplay(call) {
    const out = call?.outcomeStatus || call?.status || 'unknown';
    if (out === 'streaming') return { text: t('session.latestCall.statusStreaming'), cls: 'key-pill pill-warn' };
    if (out === 'canceled') return { text: t('session.latestCall.statusCanceled'), cls: 'key-pill pill-muted' };
    if (out === 'success' || out === 'final') return { text: t('session.latestCall.statusSuccess'), cls: 'key-pill pill-good' };
    if (out === 'quota_exhausted' || out === 'context_overflow' || out === 'exceeded' || out === 'network' || out === 'network_error' || out === 'rate_limit' || out === 'failed' || call?.error) {
      return { text: t('session.latestCall.statusFailed'), cls: 'key-pill pill-danger' };
    }
    return { text: t('session.latestCall.statusUnknown'), cls: 'key-pill pill-muted' };
  }

  function formatCallCachePctText(call) {
    if (!call) return t('session.latestCall.unknownVal');
    if (call.cacheStatus === 'missing' || !call.hasInputCacheFields) return t('session.latestCall.unknownVal');
    if (call.cacheStatus === 'zero_input') return t('session.latestCall.naVal');
    if (call.cacheReadPct !== null && call.cacheReadPct !== undefined) return `${call.cacheReadPct}%`;
    return t('session.latestCall.unknownVal');
  }

  function applyLatestCallRecordToDom(call, { playAnim = false } = {}) {
    const card = el('latest-call-card');
    if (!card) return;
    const statusPill = el('latest-call-status-pill');
    const agentPill = el('latest-call-agent-pill');
    const timeEl = el('latest-call-time');
    const modelEl = el('latest-call-model');
    const effortEl = el('latest-call-effort');
    const tokInline = el('latest-call-tokens-inline');
    const cacheInline = el('latest-call-cache-inline');
    const durInline = el('latest-call-duration-inline');
    const detailGrid = el('latest-call-detail-grid');
    const errorBox = el('latest-call-error-box');
    const bodyEl = el('latest-call-body');

    const st = resolveCallStatusDisplay(call);
    if (statusPill) {
      statusPill.textContent = st.text;
      statusPill.className = st.cls;
    }

    if (agentPill) {
      if (call.agentRole === 'subagent') {
        agentPill.hidden = false;
        agentPill.className = 'call-agent-badge is-subagent';
        agentPill.textContent = call.subagentType ? `${t('session.latestCall.agentSub')} · ${call.subagentType}` : t('session.latestCall.agentSub');
      } else if (call.attributionConfidence === 'unidentified') {
        agentPill.hidden = false;
        agentPill.className = 'call-agent-badge is-unknown';
        agentPill.textContent = t('session.latestCall.agentUnknown');
      } else {
        agentPill.hidden = false;
        agentPill.className = 'call-agent-badge';
        agentPill.textContent = t('session.latestCall.agentMain');
      }
    }

    if (timeEl) timeEl.textContent = formatCallTimeStr(call);
    const modelTitle = formatCallModelTitle(call);
    if (modelEl) {
      modelEl.textContent = modelTitle;
      modelEl.title = call.modelExactId ? `${modelTitle} (${call.modelExactId})` : modelTitle;
    }
    if (effortEl) {
      if (call.effort) {
        effortEl.hidden = false;
        effortEl.textContent = call.effort;
      } else {
        effortEl.hidden = true;
        effortEl.textContent = '';
      }
    }

    const unk = t('session.latestCall.unknownVal');
    const scoreInline = el('latest-call-score-inline');
    const callEval = (typeof evaluateGenerationExperience === 'function')
      ? evaluateGenerationExperience({
          phase: call.status === 'streaming' ? 'streaming' : (call.outcomeStatus === 'canceled' ? 'canceled' : (call.error ? 'failed' : 'final')),
          outcomeStatus: call.outcomeStatus,
          ttftSec: call.ttftSec,
          streamingSec: call.streamingSec,
          totalDurationSec: call.durationSec,
          streamSpeed: call.streamingTps ?? call.streamSpeed,
          overallTps: call.tps,
          outputTokens: call.outputTokens,
          totalInputTokens: call.totalInputTokens,
          chunkCount: call.chunkCount,
          chunkIntervalsMs: call.chunkIntervalsMs,
          intervalCv: call.intervalCv,
          sampleSource: call.sampleSource || null,
          isSyntheticPoll: call.isSyntheticPoll === true,
          error: call.error
        }, currentPanelLanguage)
      : null;

    if (scoreInline) {
      if (callEval && callEval.efficiency?.available) {
        scoreInline.hidden = false;
        scoreInline.textContent = `${callEval.efficiency.score}${currentPanelLanguage === 'en' ? ' pts' : '分'} · ${callEval.efficiency.grade}`;
        scoreInline.style.color = callEval.efficiency.tier?.color || '';
        scoreInline.style.borderColor = callEval.efficiency.tier?.color || '';
        scoreInline.title = callEval.shortTitle || '';
      } else if (call.eScore != null && call.eGrade) {
        scoreInline.hidden = false;
        scoreInline.textContent = `${call.eScore}${currentPanelLanguage === 'en' ? ' pts' : '分'} · ${call.eGrade}`;
        scoreInline.style.color = callEval?.badge?.color || '';
        scoreInline.style.borderColor = callEval?.badge?.color || '';
      } else {
        scoreInline.hidden = true;
        scoreInline.textContent = '—';
        scoreInline.style.color = '';
        scoreInline.style.borderColor = '';
      }
    }

    const inpNum = call.hasInputCacheFields
      ? (call.totalInputTokens !== null && call.totalInputTokens !== undefined ? call.totalInputTokens : call.inputTokens)
      : null;
    const inpStr = inpNum !== null && inpNum !== undefined ? short(inpNum) : unk;
    const outStr = call.outputTokens !== null && call.outputTokens !== undefined ? short(call.outputTokens) : unk;
    if (tokInline) {
      tokInline.textContent = t('session.latestCall.inlineTokens', { inp: inpStr, out: outStr });
      tokInline.title = call.hasInputCacheFields && call.totalInputTokens !== null
        ? t('session.latestCall.inlineTokensTip', {
            total: fmt(call.totalInputTokens),
            uncached: fmt(call.inputTokens ?? 0),
            cache: fmt(call.cacheReadTokens ?? 0),
            out: call.outputTokens !== null && call.outputTokens !== undefined ? fmt(call.outputTokens) : unk
          })
        : '';
    }
    if (cacheInline) {
      const cachePctTxt = formatCallCachePctText(call);
      cacheInline.textContent = t('session.latestCall.inlineCache', { val: cachePctTxt });
      cacheInline.title = call.hasInputCacheFields && call.totalInputTokens !== null && call.totalInputTokens > 0
        ? t('session.latestCall.inlineCacheTip', {
            cache: fmt(call.cacheReadTokens ?? 0),
            total: fmt(call.totalInputTokens),
            pct: cachePctTxt
          })
        : '';
    }
    if (durInline) durInline.textContent = call.durationSec !== null && call.durationSec !== undefined
      ? (typeof formatHumanDuration === 'function' ? formatHumanDuration(call.durationSec, currentPanelLanguage) : `${call.durationSec}s`)
      : '—';

    if (detailGrid) {
      detailGrid.replaceChildren();
      const agentDesc = call.agentRole === 'subagent'
        ? `${t('session.latestCall.agentSub')}${call.subagentRole ? ` (${call.subagentRole})` : (call.subagentType ? ` (${call.subagentType})` : '')}${call.parentCascadeId ? ` · parent ${String(call.parentCascadeId).slice(0, 8)}` : ''}`
        : (call.attributionConfidence === 'unidentified' ? t('session.latestCall.agentUnknown') : t('session.latestCall.agentMain'));
      const fmtDurOrUnk = (v) => (v !== null && v !== undefined) ? (typeof formatHumanDuration === 'function' ? formatHumanDuration(v, currentPanelLanguage) : `${v}s`) : unk;
      const eDetailVal = callEval?.efficiency?.available
        ? `${callEval.efficiency.score} ${currentPanelLanguage === 'en' ? 'pts' : '分'} · ${callEval.efficiency.tier?.title || callEval.efficiency.grade}`
        : (call.eScore != null ? `${call.eScore} (${call.eGrade || '--'})` : (callEval?.efficiency?.skippedReason === 'insufficient_sample' ? t('session.speed.scoreSkippedSparse') : t('session.speed.scoreSkippedMissing')));
      const rawIdBadge = call.rawPlaceholderId ? ` (${t('session.latestCall.rawIdNote', { id: call.rawPlaceholderId })})` : '';
      const stableIdDisplay = (call.stableModelId && !/^model_placeholder_/i.test(String(call.stableModelId)))
        ? `${call.stableModelId}${rawIdBadge}`
        : ((call.modelExactId && !/^model_placeholder_/i.test(String(call.modelExactId)))
          ? `${call.modelExactId}${rawIdBadge}`
          : (call.rawPlaceholderId
            ? `${unk} (${t('session.latestCall.rawIdNote', { id: call.rawPlaceholderId })})`
            : (call.modelExactId || call.modelKey || unk)));
      const effortSuffix = call.effort ? String(call.effort).trim() : '';
      const hasEffortInTitle = effortSuffix && modelTitle.trim().toLowerCase().endsWith(`(${effortSuffix.toLowerCase()})`);
      const modelAndEffortDisplay = (effortSuffix && !hasEffortInTitle) ? `${modelTitle} (${effortSuffix})` : modelTitle;
      const callStreamDisplay = callEval?.isSampleSparse
        ? `${t('session.speed.shortSampleBadge')}${callEval.shortWindowEstimateSpeed != null ? ` (${t('session.speed.shortWindowEst')}: ${callEval.shortWindowEstimateSpeed} tok/s)` : ''}`
        : ((call.streamingTps ?? call.streamSpeed) != null ? `${call.streamingTps ?? call.streamSpeed} tok/s${callEval?.speedTier ? ` · ${callEval.speedTier.title}` : ''}` : unk);
      const cells = [
        [t('session.latestCall.fieldTime'), formatCallTimeStr(call)],
        [t('session.latestCall.fieldStatus'), st.text],
        [t('session.latestCall.fieldModelId'), stableIdDisplay],
        [t('session.latestCall.fieldModelLabel'), modelAndEffortDisplay],
        [t('session.latestCall.fieldInput'), call.hasInputCacheFields && call.inputTokens !== null ? fmt(call.inputTokens) : unk],
        [t('session.latestCall.fieldCacheRead'), call.hasInputCacheFields && call.cacheReadTokens !== null ? fmt(call.cacheReadTokens) : unk],
        [t('session.latestCall.fieldTotalInput'), call.hasInputCacheFields && call.totalInputTokens !== null ? fmt(call.totalInputTokens) : unk],
        [t('session.latestCall.fieldOutput'), call.outputTokens !== null && call.outputTokens !== undefined
          ? `${fmt(call.outputTokens)}${call.thinkingTokens ? ` (${fmt(call.thinkingTokens)})` : ''}`
          : unk],
        [t('session.latestCall.fieldCacheRatio'), formatCallCachePctText(call)],
        [t('session.latestCall.fieldTtft'), `${fmtDurOrUnk(call.ttftSec)}${call.ttftRatioPct != null ? ` (${call.ttftRatioPct}%)` : ''}${callEval?.ttftTier ? ` · ${callEval.ttftTier.title}` : ''}`],
        [t('session.latestCall.fieldDuration'), `${fmtDurOrUnk(call.durationSec)}${callEval?.durationTier ? ` · ${callEval.durationTier.title}` : ''}`],
        [t('session.speed.streamRate'), callStreamDisplay],
        [t('session.speed.breakdown.overall'), call.tps !== null && call.tps !== undefined ? `${call.tps} tok/s` : unk],
        [t('session.speed.breakdown.eScore'), eDetailVal],
        [t('session.latestCall.fieldAgent'), agentDesc]
      ];
      for (const [k, v] of cells) {
        const cell = document.createElement('div');
        cell.className = 'call-detail-cell';
        const kEl = document.createElement('span');
        kEl.className = 'call-detail-k';
        kEl.textContent = k;
        const vEl = document.createElement('span');
        vEl.className = 'call-detail-v';
        vEl.textContent = v;
        cell.appendChild(kEl);
        cell.appendChild(vEl);
        detailGrid.appendChild(cell);
      }
    }

    if (errorBox) {
      if (call.error || st.cls.includes('pill-danger')) {
        errorBox.hidden = false;
        const reason = call.errorClassification?.reason || '';
        errorBox.textContent = [reason, call.error].filter(Boolean).join(' · ') || st.text;
      } else {
        errorBox.hidden = true;
        errorBox.textContent = '';
      }
    }

    if (bodyEl && playAnim && !prefersReducedMotionNow()) {
      if (state.callEnterAnimTimer) {
        clearTimeout(state.callEnterAnimTimer);
        state.callEnterAnimTimer = null;
      }
      bodyEl.classList?.remove?.('is-entering');
      void bodyEl.offsetWidth;
      bodyEl.classList?.add?.('is-entering');
      state.callEnterAnimTimer = setTimeout(() => {
        state.callEnterAnimTimer = null;
        bodyEl.classList?.remove?.('is-entering');
      }, 250);
    }
  }

  function syncLatestCallDetailsVisibility() {
    const det = el('latest-call-details');
    const row = el('latest-call-summary-row');
    if (det) det.style.display = state.latestCallDetailOpen ? 'block' : 'none';
    if (row) row.setAttribute?.('aria-expanded', state.latestCallDetailOpen ? 'true' : 'false');
  }

  function renderLatestCallCard({ fromUserAction = false, skipAnim = false } = {}) {
    const card = el('latest-call-card');
    if (!card) return;
    if (!state.route) {
      card.hidden = true;
      return;
    }

    const incoming = resolveLatestSessionCallRecord();
    const target = state.pinnedCallRecord || incoming;
    if (!target) {
      card.hidden = !state.historyDrawerOpen;
      return;
    }
    card.hidden = false;

    const newBanner = el('latest-call-new-banner');
    if (!fromUserAction && isCallCardReadingProtected(incoming)) {
      if (incoming && (!state.pendingLatestCallRecord || buildCallDisplaySignature(incoming) !== buildCallDisplaySignature(state.pendingLatestCallRecord))) {
        state.pendingLatestCallRecord = incoming;
      }
      if (newBanner) newBanner.hidden = false;
      if (state.pinnedCallRecord && lastCallCardLang !== currentPanelLanguage) {
        applyLatestCallRecordToDom(state.pinnedCallRecord, { playAnim: false });
        lastCallCardLang = currentPanelLanguage;
      }
      syncLatestCallDetailsVisibility();
      return;
    }

    if (newBanner) newBanner.hidden = true;
    state.pendingLatestCallRecord = null;

    const nextSig = buildCallDisplaySignature(target);
    const langChanged = lastCallCardLang !== currentPanelLanguage;
    if (nextSig === state.displayedCallSig && !langChanged) {
      syncLatestCallDetailsVisibility();
      return;
    }

    const hadPrev = Boolean(state.displayedCallRecord);
    const isRealReplacement = hadPrev && nextSig !== state.lastAnimatedCallSig && target.status !== 'streaming';
    const shouldAnimate = !skipAnim && isRealReplacement && nextSig !== state.displayedCallSig;

    state.displayedCallRecord = target;
    state.displayedCallSig = nextSig;
    if (target.status !== 'streaming') {
      state.lastAnimatedCallSig = nextSig;
    }
    lastCallCardLang = currentPanelLanguage;
    applyLatestCallRecordToDom(target, { playAnim: shouldAnimate });
    syncLatestCallDetailsVisibility();
  }

  function renderSessionTimeline() {
    const drawer = el('session-timeline-drawer');
    const toggleBtn = el('btn-session-history-toggle');
    if (toggleBtn) {
      toggleBtn.textContent = state.historyDrawerOpen ? t('session.timeline.hideHistory') : t('session.timeline.viewHistory');
      toggleBtn.setAttribute?.('aria-expanded', state.historyDrawerOpen ? 'true' : 'false');
    }
    if (!drawer) return;
    drawer.style.display = state.historyDrawerOpen ? 'flex' : 'none';
    if (!state.historyDrawerOpen) return;

    const sumEl = el('session-timeline-summary');
    const listEl = el('session-timeline-list');
    const unlinkedEl = el('session-timeline-unlinked');
    const moreWrap = el('session-timeline-more-wrap');
    const moreBtn = el('btn-timeline-load-more');

    if (state.timelineLoading && !state.sessionTimeline) {
      if (sumEl) sumEl.textContent = t('session.timeline.loading');
      if (listEl) listEl.replaceChildren();
      if (unlinkedEl) unlinkedEl.hidden = true;
      if (moreWrap) moreWrap.hidden = true;
      return;
    }

    const tl = state.sessionTimeline;
    if (!tl || (!tl.turns?.length && !tl.unlinkedSubagentCalls?.length)) {
      if (sumEl) sumEl.textContent = state.timelineError ? translateBackendText(state.timelineError) : t('session.timeline.empty');
      if (listEl) listEl.replaceChildren();
      if (unlinkedEl) unlinkedEl.hidden = true;
      if (moreWrap) moreWrap.hidden = true;
      return;
    }

    const turns = Array.isArray(tl.turns) ? tl.turns : [];
    const cacheText = tl.cacheSummary && tl.cacheSummary.cacheStatus !== 'missing'
      ? (tl.cacheSummary.cacheStatus === 'empty'
        ? '—'
        : (tl.cacheSummary.cacheStatus === 'zero_input' ? t('session.latestCall.naVal') : `${tl.cacheSummary.cacheReadPct}%`))
      : t('session.latestCall.unknownVal');
    if (sumEl) {
      sumEl.replaceChildren();
      const sLine = document.createElement('div');
      sLine.textContent = t('session.timeline.summary', {
        turns: turns.length,
        calls: tl.totalCalls || 0,
        main: tl.mainCallsCount || 0,
        sub: tl.subagentCallsCount || 0,
        cache: cacheText
      });
      sumEl.appendChild(sLine);
    }

    if (listEl) {
      listEl.replaceChildren();
      const resolveTurnKey = (tObj) => tObj?.turnKey || `turn-${tObj?.turnIndex ?? 'x'}-${tObj?.stepIndex ?? 'na'}`;
      const descTurns = [...turns].reverse();
      if (descTurns.length > 0 && state.expandedTurnKeys.size === 0) {
        state.expandedTurnKeys.add(resolveTurnKey(descTurns[0]));
      }
      const limit = Math.max(5, Number(state.timelinePageLimit) || 10);
      const visibleTurns = descTurns.slice(0, limit);

      const createCallRow = (call) => {
        const row = document.createElement('div');
        const isSelected = state.pinnedCallRecord && state.pinnedCallRecord.callId === call.callId;
        row.className = `timeline-call-row${call.agentRole === 'subagent' ? ' is-subagent' : ''}${isSelected ? ' is-selected' : ''}`;
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');

        const main = document.createElement('div');
        main.className = 'timeline-call-main';
        const roleBadge = document.createElement('span');
        roleBadge.className = `call-agent-badge${call.agentRole === 'subagent' ? ' is-subagent' : (call.attributionConfidence === 'unidentified' ? ' is-unknown' : '')}`;
        roleBadge.textContent = call.agentRole === 'subagent'
          ? (call.subagentType ? `${t('session.latestCall.agentSub')}·${call.subagentType}` : t('session.latestCall.agentSub'))
          : (call.attributionConfidence === 'unidentified' ? t('session.latestCall.agentUnknown') : t('session.latestCall.agentMain'));
        const mName = document.createElement('span');
        mName.className = 'timeline-turn-prompt';
        const baseModelTitle = formatCallModelTitle(call);
        const effortText = call.effort ? String(call.effort).trim() : '';
        const hasEffortParen = effortText && baseModelTitle.trim().toLowerCase().endsWith(`(${effortText.toLowerCase()})`);
        mName.textContent = (effortText && !hasEffortParen) ? `${baseModelTitle} (${effortText})` : baseModelTitle;
        main.appendChild(roleBadge);
        main.appendChild(mName);

        const stats = document.createElement('div');
        stats.className = 'timeline-call-stats';
        const st = resolveCallStatusDisplay(call);
        const inpTxt = call.hasInputCacheFields ? short(call.totalInputTokens) : t('session.latestCall.unknownVal');
        const eTag = (call.eScore != null && call.eGrade)
          ? (currentPanelLanguage === 'en' ? ` · ${call.eScore}pt(${call.eGrade})` : ` · ${call.eScore}分(${call.eGrade})`)
          : '';
        stats.textContent = `${formatCallTimeStr(call)} · 入${inpTxt}/出${short(call.outputTokens || 0)} · 缓${formatCallCachePctText(call)}${eTag} · ${st.text}`;
        if (currentPanelLanguage === 'en') {
          stats.textContent = `${formatCallTimeStr(call)} · In ${inpTxt}/Out ${short(call.outputTokens || 0)} · Cache ${formatCallCachePctText(call)}${eTag} · ${st.text}`;
        }

        row.appendChild(main);
        row.appendChild(stats);
        const inspectCall = () => {
          state.pinnedCallRecord = call;
          state.latestCallDetailOpen = true;
          renderLatestCallCard({ fromUserAction: true, skipAnim: false });
          renderSessionTimeline();
        };
        row.addEventListener('click', inspectCall);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspectCall(); }
        });
        return row;
      };

      for (const turn of visibleTurns) {
        const turnKey = resolveTurnKey(turn);
        const isOpen = state.expandedTurnKeys.has(turnKey);
        const cardEl = document.createElement('div');
        cardEl.className = 'timeline-turn-card';

        const hdrBtn = document.createElement('button');
        hdrBtn.type = 'button';
        hdrBtn.className = 'timeline-turn-hdr';
        hdrBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

        const left = document.createElement('div');
        left.className = 'timeline-turn-left';
        const idxEl = document.createElement('span');
        idxEl.className = 'timeline-turn-idx';
        idxEl.textContent = t('session.timeline.turnLabel', { n: turn.turnIndex });
        const promptText = turn.preview || turn.userPromptPreview || '';
        const promptEl = document.createElement('span');
        promptEl.className = 'timeline-turn-prompt';
        promptEl.textContent = promptText || t('session.timeline.turnNoPrompt');
        if (promptText) promptEl.title = promptText;
        left.appendChild(idxEl);
        left.appendChild(promptEl);

        const metaEl = document.createElement('span');
        metaEl.className = 'timeline-turn-meta';
        metaEl.textContent = t('session.timeline.turnSummary', {
          calls: turn.calls?.length || 0,
          inp: short(turn.inputTokens || 0),
          cap: short(turn.cacheReadTokens || 0),
          out: short(turn.outputTokens || 0)
        });

        hdrBtn.appendChild(left);
        hdrBtn.appendChild(metaEl);
        hdrBtn.addEventListener('click', () => {
          if (state.expandedTurnKeys.has(turnKey)) state.expandedTurnKeys.delete(turnKey);
          else state.expandedTurnKeys.add(turnKey);
          renderSessionTimeline();
        });
        cardEl.appendChild(hdrBtn);

        if (isOpen && Array.isArray(turn.calls)) {
          const bodyEl = document.createElement('div');
          bodyEl.className = 'timeline-turn-body';
          for (const call of turn.calls) {
            bodyEl.appendChild(createCallRow(call));
          }
          cardEl.appendChild(bodyEl);
        }
        listEl.appendChild(cardEl);
      }

      if (moreWrap && moreBtn) {
        const remaining = descTurns.length - visibleTurns.length;
        if (remaining > 0) {
          moreWrap.hidden = false;
          moreBtn.textContent = t('session.timeline.loadMore', { n: remaining });
        } else {
          moreWrap.hidden = true;
        }
      }

      if (unlinkedEl) {
        const unlinked = Array.isArray(tl.unlinkedSubagentCalls) ? tl.unlinkedSubagentCalls : [];
        if (unlinked.length > 0) {
          unlinkedEl.hidden = false;
          unlinkedEl.replaceChildren();
          const uTitle = document.createElement('div');
          uTitle.className = 'session-timeline-unlinked-title';
          uTitle.textContent = t('session.timeline.unlinkedTitle', { n: unlinked.length });
          unlinkedEl.appendChild(uTitle);
          for (const uCall of unlinked) {
            unlinkedEl.appendChild(createCallRow(uCall));
          }
        } else {
          unlinkedEl.hidden = true;
          unlinkedEl.replaceChildren();
        }
      }
    }
  }

  async function fetchSessionTimeline(id, { force = false } = {}) {
    if (!id || state.disposed || id !== state.route) return null;
    if (!force && state.timelineLoading) return null;
    const seq = ++timelineFetchSeq;
    const gen = state.generation;
    state.timelineLoading = true;
    state.timelineError = '';
    if (state.historyDrawerOpen) renderSessionTimeline();

    try {
      if (timelineFetchController) {
        try { timelineFetchController.abort(); } catch { }
      }
      timelineFetchController = typeof AbortController === 'function' ? new AbortController() : null;
      const liveCalls = Array.isArray(state.sessionCalls) ? state.sessionCalls : [];
      const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      const hasIpc = typeof window !== 'undefined' && typeof window.contextMeterAPI?.getSessionTimeline === 'function';
      let timelineData = null;

      if (hasIpc || hasLiveHttpBridge()) {
        const out = await callBackendWithPriority({
          ipcCall: hasIpc ? () => window.contextMeterAPI.getSessionTimeline(id, { force, liveCalls, cascadeModelConfigs: configs }) : null,
          liveRoute: '/session-timeline',
          liveBody: { id, force, liveCalls, cascadeModelConfigs: configs },
          liveFetchOpts: timelineFetchController ? { signal: timelineFetchController.signal } : {}
        });
        const res = out?.result;
        if (res?.ok && res.data) {
          timelineData = res.data;
        } else if (res && !res.ok) {
          state.timelineError = res.error || '';
        }
      } else if (typeof groupSessionCallsByTurns === 'function') {
        timelineData = groupSessionCallsByTurns([], liveCalls, { cascadeId: id, cascadeModelConfigs: configs });
      }

      if (gen !== state.generation || seq !== timelineFetchSeq || state.disposed) return null;
      if (timelineData) {
        state.sessionTimeline = timelineData;
        state.lastTimelineFetchAt = Date.now();
      }
    } catch (e) {
      if (e?.name !== 'AbortError' && gen === state.generation && !state.disposed) {
        state.timelineError = e?.message || String(e || '');
      }
    } finally {
      if (seq === timelineFetchSeq && !state.disposed) {
        state.timelineLoading = false;
        if (state.historyDrawerOpen) renderSessionTimeline();
      }
    }
    return state.sessionTimeline;
  }

  function scheduleLatestCallRefresh({ allowTimelineRefresh = false } = {}) {
    if (state.disposed) return;
    if (allowTimelineRefresh && state.historyDrawerOpen && state.route) {
      const latest = resolveLatestSessionCallRecord();
      const sig = buildCallDisplaySignature(latest);
      if (sig && sig !== state.lastTimelineCallSig && Date.now() - state.lastTimelineFetchAt > 1200) {
        state.lastTimelineCallSig = sig;
        void fetchSessionTimeline(state.route);
      }
    }
    renderLatestCallCard();
  }

  // 渲染上下文与全局状态（无论在主页 / 新会话还是会话页 /c/<id>，始终保持顶栏圆环、气泡、摘要卡片与技术抽屉严格同源）
  function render() {
    host.hidden = false;
    host.setAttribute('data-has-session', state.route ? 'true' : 'false');
    ensureHostDocked();
    renderSessionCost();

    const hasRoute = Boolean(state.route);
    const d = hasRoute ? state.latest : null;
    const session = hasRoute ? state.scan?.session : null;
    const disp = hasRoute ? resolveDisplayStatus(d, session) : { isError: false, isOverflow: false, kind: 'normal' };
    const stale = hasRoute && Boolean(state.requestError || (state.requestAt && Date.now() - state.requestAt > 20000));
    const incomplete = hasRoute && Boolean(session?.unknownFiles > 0);
    const danger = hasRoute && Boolean(disp.isError || d?.exceeded);
    const emptyPhase = resolveSessionEmptyPhase(d, session, disp, stale);
    const hasCorpus = hasNonEmptySessionCorpus(session);

    let pct = null;
    if (!emptyPhase) {
      if (d?.exceeded) {
        pct = 100;
      } else if (d?.percent != null && !danger && !stale) {
        pct = Math.min(100, Math.max(0, d.percent));
      } else if (d?.actual != null && d?.budget && !danger && !stale) {
        pct = Math.min(100, Math.max(0, (d.actual / d.budget) * 100));
      }
    }

    const barColor = emptyPhase ? '#69c0ff' : (danger ? '#ff4d4f' : pct != null && pct >= 90 ? '#ff4d4f' : pct != null && pct >= 75 || stale || incomplete ? '#faad14' : '#69c0ff');
    const tone = emptyPhase ? '#b7c1ff' : (danger ? '#ff9292' : stale || incomplete || d?.estimated ? '#f2c46d' : '#b7c1ff');
    host.style.setProperty('--tone', tone);
    host.style.setProperty('--bar-color', barColor);

    const barFill = el('bar-fill');
    if (barFill) barFill.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');

    updateRingAndBubble(d, session, pct, danger, stale, incomplete, emptyPhase);

    syncContextModelSelectionFromState();

    const status = emptyPhase === 'no_session'
      ? t('tech.status.noSession')
      : disp.isError
        ? disp.statusText
        : stale ? t('badge.status.stale')
          : state.scanError ? t('badge.status.scanErr', { err: translateBackendText(state.scanError) })
            : incomplete ? t('badge.status.incomplete', { count: session.unknownFiles })
              : d?.estimated ? t('badge.status.estimated')
                : t('badge.status.normal');
    if (el('status')) el('status').textContent = status;

    const corpus = hasCorpus
      ? t('badge.corpus.range', { range: range(session.total), inc: incomplete ? t('badge.corpus.incPlus') : '' })
      : state.scanBusy ? t('badge.corpus.scanning') : t('badge.corpus.pending');

    const badgePctVal = el('badge-pct-val');
    if (emptyPhase === 'no_session') {
      if (el('amount')) el('amount').textContent = t('badge.noSession');
      if (badgePctVal) badgePctVal.textContent = '--%';
      setHoverExtra(t('badge.clickOpenCli'));
    } else if (emptyPhase === 'empty_session') {
      if (el('amount')) el('amount').textContent = t('badge.emptySession');
      if (badgePctVal) badgePctVal.textContent = '--%';
      setHoverExtra('');
    } else if (disp.isError || disp.kind === 'canceled') {
      if (el('amount')) el('amount').textContent = disp.amountText;
      if (badgePctVal) badgePctVal.textContent = disp.badgeText;
      setHoverExtra(disp.hoverExtra);
    } else if (stale) {
      if (el('amount')) el('amount').textContent = t('badge.delayed');
      if (badgePctVal) badgePctVal.textContent = pct != null ? `${pct.toFixed(0)}%` : '--%';
      setHoverExtra(` · ${corpus}`);
    } else if (d?.actual != null) {
      const pctStr = pct != null ? ` (${pct.toFixed(0)}%)` : '';
      if (el('amount')) el('amount').textContent = `${short(d.actual)}${pctStr}`;
      if (badgePctVal) badgePctVal.textContent = pct != null ? `${pct.toFixed(0)}%` : '--%';
      const budgetStr = d?.budget ? ` / ${short(d.budget)}` : '';
      setHoverExtra(`${budgetStr} · ${corpus}`);
    } else {
      if (el('amount')) el('amount').textContent = t('badge.actualUnknown');
      if (badgePctVal) badgePctVal.textContent = '--%';
      setHoverExtra(` · ${corpus}`);
    }

    const overflowCtxVal = el('overflow-context-val');
    if (overflowCtxVal && badgePctVal) overflowCtxVal.textContent = badgePctVal.textContent;
    if (el('badge-tokens')) el('badge-tokens').title = t('badge.tokensTitle');

    // 渲染输出速度 (统一使用 tok/s)
    const sp = d?.speed;
    const speedBadge = el('badge-speed');
    const speedHoverExtra = el('speed-hover-extra');
    syncSpeedBadgeText();
    if (speedBadge) {
      if (sp?.tps != null) {
        if (speedHoverExtra) {
          speedHoverExtra.textContent = `${sp.duration ? ` · ${sp.duration}s` : ''}${sp.outputTokens ? ` · ${short(sp.outputTokens)} tok` : ''}`;
        }
        speedBadge.title = t('badge.speedTitleDetail', {
          tps: sp.tps,
          streaming: sp.streamingTps ? t('badge.speedStreamingPart', { tps: sp.streamingTps }) : '',
          duration: sp.duration || '—',
          ttft: sp.ttft || '—',
          streamSec: sp.streamingSec || '—',
          output: fmt(sp.outputTokens)
        });
      } else if (hasRoute && state.requestBusy) {
        if (speedHoverExtra) speedHoverExtra.textContent = '';
        speedBadge.title = t('badge.speedTitleWait');
      } else {
        if (speedHoverExtra) speedHoverExtra.textContent = t('badge.speedHoverIdle');
        speedBadge.title = t('badge.speedTitleIdle');
      }
    }

    if (el('key-summary')) {
      const keyBar = el('key-bar-fill');
      const keyBadge = el('key-badge');
      const keyHeroPct = el('key-hero-pct');
      const keyUsed = el('key-used');
      const keyLimit = el('key-limit');
      const keyRemaining = el('key-remaining');
      const keyTakeaway = el('key-takeaway');

      if (keyBar) keyBar.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');
      if (keyHeroPct) {
        if (emptyPhase === 'no_session' || emptyPhase === 'empty_session') {
          keyHeroPct.hidden = false;
          keyHeroPct.textContent = '--%';
          keyHeroPct.setAttribute?.('data-tone', 'muted');
        } else if (disp.isOverflow) {
          keyHeroPct.hidden = false;
          keyHeroPct.textContent = '100%';
          keyHeroPct.setAttribute?.('data-tone', 'danger');
        } else if (pct != null) {
          keyHeroPct.hidden = false;
          keyHeroPct.textContent = `${Math.round(pct)}%`;
          keyHeroPct.setAttribute?.('data-tone', pct >= 90 ? 'danger' : (pct >= 75 ? 'warn' : 'normal'));
        } else {
          keyHeroPct.hidden = true;
          keyHeroPct.textContent = '';
          keyHeroPct.removeAttribute?.('data-tone');
        }
      }

      if (emptyPhase === 'no_session' || emptyPhase === 'empty_session') {
        if (keyBadge) {
          keyBadge.textContent = t(emptyPhase === 'no_session' ? 'key.pill.newSession' : 'key.pill.emptySession');
          keyBadge.className = 'key-pill pill-muted';
        }
        if (keyUsed) keyUsed.textContent = '0';
        if (keyLimit) keyLimit.textContent = '—';
        if (keyRemaining) keyRemaining.textContent = '—';
        if (keyTakeaway) {
          keyTakeaway.hidden = false;
          keyTakeaway.textContent = t(emptyPhase === 'no_session' ? 'key.takeaway.noSession' : 'key.takeaway.emptySession');
        }
      } else if (disp.isError || disp.kind === 'canceled') {
        if (keyBadge) {
          keyBadge.textContent = disp.keyBadgeText;
          keyBadge.className = disp.pillClass;
        }

        const usedTokenCount = d?.actual != null ? d.actual : (d?.used != null ? d.used : (d?.estimate != null ? d.estimate : (hasCorpus ? session.total.low : null)));
        const budgetTokenCount = d?.budget || (d?.serviceLimit ? d.serviceLimit : 983040);

        if (disp.isOverflow) {
          if (keyUsed) keyUsed.textContent = d.serviceLimit ? `>${short(d.serviceLimit)}` : t('key.overflowUsed');
          if (keyLimit) keyLimit.textContent = d.serviceLimit ? short(d.serviceLimit) : short(budgetTokenCount);
          if (keyRemaining) keyRemaining.textContent = t('key.overflowRem');
        } else {
          // 非超限错误：保留已有上下文用量，标明其状态，不归零、不清空
          if (keyUsed) {
            keyUsed.textContent = usedTokenCount != null ? (d?.actual != null ? `${short(usedTokenCount)}${pct != null ? ` (${pct.toFixed(1)}%)` : ''}` : t('key.estShort', { val: short(usedTokenCount) })) : '—';
          }
          if (keyLimit) keyLimit.textContent = budgetTokenCount ? short(budgetTokenCount) : '—';
          if (keyRemaining) {
            if (usedTokenCount != null && budgetTokenCount) {
              const rem = Math.max(0, budgetTokenCount - usedTokenCount);
              const remP = Math.max(0, 100 - (pct || ((usedTokenCount / budgetTokenCount) * 100)));
              keyRemaining.textContent = `${short(rem)} (${remP.toFixed(1)}%)`;
            } else {
              keyRemaining.textContent = t('key.pending');
            }
          }
        }
        if (keyTakeaway) {
          keyTakeaway.hidden = false;
          keyTakeaway.textContent = disp.keyTakeaway;
        }
      } else if (d?.actual != null && pct != null) {
        const limitVal = d.budget || 256000;
        const remainVal = Math.max(0, limitVal - d.actual);
        const remainPct = Math.max(0, 100 - pct);

        if (keyBadge) {
          if (pct >= 90) { keyBadge.textContent = t('key.pill.tight'); keyBadge.className = 'key-pill pill-danger'; }
          else if (pct >= 75) { keyBadge.textContent = t('key.pill.elevated'); keyBadge.className = 'key-pill pill-warn'; }
          else { keyBadge.textContent = t('key.pill.normal'); keyBadge.className = 'key-pill pill-good'; }
        }
        if (keyUsed) keyUsed.textContent = `${short(d.actual)} (${pct.toFixed(1)}%)`;
        if (keyLimit) keyLimit.textContent = short(limitVal);
        if (keyRemaining) keyRemaining.textContent = `${short(remainVal)} (${remainPct.toFixed(1)}%)`;
        if (keyTakeaway) {
          if (pct >= 90) {
            keyTakeaway.hidden = false;
            keyTakeaway.textContent = t('key.takeaway.90', { pct: pct.toFixed(1), rem: short(remainVal) });
          } else if (pct >= 75) {
            keyTakeaway.hidden = false;
            keyTakeaway.textContent = t('key.takeaway.75', { pct: pct.toFixed(1), rem: short(remainVal) });
          } else {
            keyTakeaway.hidden = true;
            keyTakeaway.textContent = '';
          }
        }
      } else {
        const hasEstimateData = Boolean(d?.estimated || d?.estimate != null || hasCorpus);
        if (keyBadge) { keyBadge.textContent = d?.estimated ? t('key.pill.est') : t('key.pill.reading'); keyBadge.className = 'key-pill pill-muted'; }
        if (keyUsed) keyUsed.textContent = d?.estimate ? t('key.estPrefix', { val: short(d.estimate) }) : (hasCorpus ? short(session.total.low) : '—');
        if (keyLimit) keyLimit.textContent = d?.budget ? short(d.budget) : '—';
        if (keyRemaining) keyRemaining.textContent = t('key.pending');
        if (keyTakeaway) {
          keyTakeaway.hidden = false;
          keyTakeaway.textContent = hasEstimateData ? t('key.takeaway.est') : t('key.takeaway.loading');
        }
      }
    }

    if (el('speed-summary')) {
      if (typeof evaluateGenerationExperience === 'function') {
        const evalRes = state.lastSpeedEval || evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage);
        renderSpeedExperienceInPlace(evalRes);
      } else {
        const spBadge = el('speed-badge');
        const spVal = el('speed-val');
        const spDur = el('speed-duration');
        const spTtft = el('speed-ttft');
        const spTokens = el('speed-tokens');
        const spTakeaway = el('speed-takeaway');

        if (sp?.tps != null) {
          if (spBadge) {
            if (sp.tps >= 80) { spBadge.textContent = t('speed.pill.fast'); spBadge.className = 'key-pill pill-good'; }
            else if (sp.tps >= 35) { spBadge.textContent = t('speed.pill.smooth'); spBadge.className = 'key-pill pill-good'; }
            else if (sp.tps >= 15) { spBadge.textContent = t('speed.pill.good'); spBadge.className = 'key-pill pill-warn'; }
            else { spBadge.textContent = t('speed.pill.slow'); spBadge.className = 'key-pill pill-danger'; }
          }
          if (spVal) spVal.textContent = `${sp.tps} tok/s`;
          if (spDur) spDur.textContent = sp.duration ? `${sp.duration}s` : '—';
          if (spTtft) spTtft.textContent = sp.ttft ? `${sp.ttft}s` : '—';
          if (spTokens) spTokens.textContent = `${fmt(sp.outputTokens)} tok`;
          if (spTakeaway) {
            const modelStr = d?.model ? `（${d.model}）` : '';
            const streamInfo = sp.streamingTps ? t('speed.streamPart', { tps: sp.streamingTps }) : '';
            spTakeaway.textContent = t('speed.takeaway.ok', {
              tone: sp.tps >= 35 ? t('speed.tone.smooth') : t('speed.tone.steady'),
              tps: sp.tps,
              stream: streamInfo,
              dur: sp.duration,
              tok: fmt(sp.outputTokens),
              model: modelStr
            });
          }
        } else {
          if (spBadge) { spBadge.textContent = (hasRoute && state.requestBusy) ? t('speed.pill.calc') : t('speed.pill.idle'); spBadge.className = 'key-pill pill-muted'; }
          if (spVal) spVal.textContent = '—';
          if (spDur) spDur.textContent = '—';
          if (spTtft) spTtft.textContent = '—';
          if (spTokens) spTokens.textContent = '—';
          if (spTakeaway) spTakeaway.textContent = t('speed.takeaway.idle');
        }
      }
    }

    if (emptyPhase === 'no_session') {
      if (el('model')) el('model').textContent = '';
      if (el('request-status')) el('request-status').textContent = t('tech.req.noSession');
      for (const id of ['actual', 'estimate', 'budget', 'service-limit', 'percent', 'session-total', 'characters', 'user', 'assistant', 'thinking', 'tools', 'summaries', 'system', 'attachment-total', 'steps']) {
        if (el(id)) el(id).textContent = '—';
      }
      if (el('coverage')) el('coverage').textContent = t('tech.coverageNoSession');
      if (el('updated')) el('updated').textContent = t('tech.updatedNoSession');
      if (el('refresh')) el('refresh').disabled = true;
      renderFiles(null);
      renderLatestCallCard({ skipAnim: true });
      renderSessionTimeline();
      return;
    }

    el('model').textContent = emptyPhase === 'empty_session' ? '' : (d?.model?.startsWith('MODEL_PLACEHOLDER') ? t('tech.modelPlaceholder', { id: d.model }) : d?.model || t('tech.modelMissing'));
    el('request-status').textContent = emptyPhase === 'empty_session' ? t('tech.req.emptySession') : (d?.exceeded ? t('tech.req.exceeded') : d?.network ? t('tech.req.network') : d?.error ? t('tech.req.failed') : d?.status === 'reported' ? t('tech.req.reported') : d?.status === 'estimated' ? t('tech.req.estimated') : t('tech.req.waiting'));
    el('actual').textContent = emptyPhase === 'empty_session' ? '0' : (d?.actual != null ? token(d.actual) : d?.exceeded ? t('tech.actual.exceeded', { val: fmt(d.serviceLimit || 0) }) : t('tech.actual.unknown'));
    if (d?.exceeded && !d.serviceLimit) el('actual').textContent = t('tech.actual.exceededNoLim');
    el('estimate').textContent = d?.estimate ? t('tech.est.val', { val: fmt(d.estimate), note: d.exceeded ? t('tech.est.under') : t('tech.est.ref') }) : t('tech.est.none');
    el('budget').textContent = token(d?.budget);
    el('service-limit').textContent = d?.serviceLimit ? t('tech.svcLim.val', { val: fmt(d.serviceLimit) }) : t('tech.svcLim.none');
    el('percent').textContent = d?.percent != null && !danger && !stale ? t('tech.pct.val', { pct: d.percent.toFixed(1) }) : t('tech.pct.none');
    el('session-total').textContent = session?.total ? range(session.total) + (incomplete ? t('tech.plusUnknown') : '') : state.scanError ? t('tech.scanIncomplete') : t('tech.scanning');
    el('characters').textContent = session?.total ? fmt(session.total.chars) : '—';
    for (const name of ['user', 'assistant', 'thinking', 'tools', 'summaries']) el(name).textContent = session?.groups ? range(session.groups[name]) : '—';
    el('system').textContent = session?.groups ? range({ low: (session.groups.system?.low || 0) + (session.groups.definitions?.low || 0), high: (session.groups.system?.high || 0) + (session.groups.definitions?.high || 0) }) : '—';
    el('attachment-total').textContent = session?.attachmentTotal ? range(session.attachmentTotal) + (incomplete ? t('tech.plusUnknownShort') : '') : '—';
    el('steps').textContent = session?.steps != null ? t('tech.stepsVal', { steps: fmt(session.steps), user: session.userMessages, assistant: session.assistantMessages }) : t('tech.stepsNone');
    el('coverage').textContent = Array.isArray(session?.attachments)
      ? t('tech.coverageVal', {
        total: session.attachments.length,
        user: session.attachments.filter(f => f.source === 'user').length,
        assistant: session.attachments.filter(f => f.source === 'assistant').length,
        read: session.attachments.filter(f => f.chars > 0).length,
        unknown: session.unknownFiles,
        rescan: state.scanBusy ? t('tech.coverageRescan') : '',
        err: state.scanError ? t('tech.coverageErr', { err: translateBackendText(state.scanError) }) : ''
      })
      : (state.scanError ? translateBackendText(state.scanError) : t('tech.coverageScanning'));
    el('updated').textContent = t('tech.updatedVal', {
      req: state.requestAt ? new Date(state.requestAt).toLocaleTimeString() : t('tech.unread'),
      scan: state.scan ? new Date(state.scan.scannedAt).toLocaleTimeString() : t('tech.unfinished')
    });
    el('refresh').disabled = state.scanBusy;
    scheduleLatestCallRefresh({ allowTimelineRefresh: false });
    if (state.historyDrawerOpen) renderSessionTimeline();
  }

  el('latest-call-summary-row')?.addEventListener('click', () => {
    state.latestCallDetailOpen = !state.latestCallDetailOpen;
    if (!state.latestCallDetailOpen && state.pinnedCallRecord) {
      state.pinnedCallRecord = null;
      renderSessionTimeline();
    }
    if (!state.latestCallDetailOpen && state.pendingLatestCallRecord) {
      renderLatestCallCard({ fromUserAction: true });
    } else {
      syncLatestCallDetailsVisibility();
    }
    positionFloatingPanels();
  });
  el('latest-call-summary-row')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el('latest-call-summary-row')?.click();
    }
  });
  el('latest-call-new-banner')?.addEventListener('click', () => {
    state.pinnedCallRecord = null;
    state.pendingLatestCallRecord = null;
    renderLatestCallCard({ fromUserAction: true });
    if (state.historyDrawerOpen) renderSessionTimeline();
    positionFloatingPanels();
  });
  el('btn-session-history-toggle')?.addEventListener('click', () => {
    state.historyDrawerOpen = !state.historyDrawerOpen;
    if (!state.historyDrawerOpen && state.pinnedCallRecord) {
      state.pinnedCallRecord = null;
      renderLatestCallCard({ fromUserAction: true, skipAnim: true });
    }
    renderSessionTimeline();
    if (state.historyDrawerOpen && state.route) {
      void fetchSessionTimeline(state.route, { force: !state.sessionTimeline });
    }
    positionFloatingPanels();
  });
  el('btn-timeline-load-more')?.addEventListener('click', () => {
    state.timelinePageLimit = (Number(state.timelinePageLimit) || 10) + 10;
    renderSessionTimeline();
    positionFloatingPanels();
  });

  async function requestPoll(generation, id) {
    state.requestBusy = true;
    const controller = new AbortController(); state.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const csrf = window.__APP_CONFIG__?.csrfToken; if (!csrf) throw new Error('后台尚未就绪');
      const offset = Math.max(0, state.count - 3);
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf }, body: JSON.stringify({ cascadeId: id, generatorMetadataOffset: offset, includeMessages: false }), signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json(); if (generation !== state.generation || state.disposed) return;
      const rows = data.generatorMetadata || [];
      state.count = rows.length ? offset + rows.length : 0;
      if (!state.sessionCallsMap) state.sessionCallsMap = new Map();
      if (!state.syncedFinalMap) state.syncedFinalMap = new Map();
      if (!state.pendingFinalCalls) state.pendingFinalCalls = new Map();
      if (!state.quarantinedOversizeMap) state.quarantinedOversizeMap = new Map();
      const wasHydrated = Boolean(state.callsHydrated);
      let hasNewOrProgressedPending = false;
      const modelConfigsList = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      for (let i = 0; i < rows.length; i++) {
        const call = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
        if (call && call.callId) {
          const prevSessionCall = state.sessionCallsMap.get(call.callId);
          const prevSynced = state.syncedFinalMap.get(call.callId);
          const prevPending = state.pendingFinalCalls.get(call.callId);
          const prevQuarantined = state.quarantinedOversizeMap.get(call.callId);
          let effectiveCall = (prevSessionCall && call.status === 'final' && prevSessionCall.status === 'final')
            ? mergePendingCallData(prevSessionCall, call)
            : call;
          if (prevPending && effectiveCall.status === 'final' && prevPending.status === 'final') {
            effectiveCall = mergePendingCallData(prevPending, effectiveCall);
          }
          if (effectiveCall.status === 'final') {
            if (prevSynced) {
              const effWm0 = getFinalCallWatermark(effectiveCall);
              const uCmp0 = compareWatermarkUsage(effWm0, prevSynced);
              const rCmp0 = compareSourceRevision(effWm0.sourceRevision, prevSynced.sourceRevision);
              const restoreSyncedUsage = (uCmp0 < 0 || (uCmp0 === 0 && rCmp0 < 0)) && prevSynced.inp !== undefined;
              const restoreSyncedDate = (prevSynced.dateRank || 0) >= 2 && Boolean(prevSynced.date) && !canAdoptNextDate(effWm0, prevSynced);
              const restoreSyncedRev = rCmp0 < 0 && prevSynced.sourceRevision !== null && prevSynced.sourceRevision !== undefined;
              if (restoreSyncedUsage || restoreSyncedDate || restoreSyncedRev) {
                effectiveCall = {
                  ...effectiveCall,
                  ...(restoreSyncedUsage ? {
                    inputTokens: prevSynced.inp,
                    cacheTokens: prevSynced.cap,
                    cacheReadTokens: prevSynced.cap,
                    outputTokens: prevSynced.out,
                    totalTokens: prevSynced.tot
                  } : {}),
                  ...(restoreSyncedDate ? {
                    date: prevSynced.date,
                    created_at: prevSynced.createdAt || null,
                    ...(prevSynced.dateSource ? { dateSource: prevSynced.dateSource } : {}),
                    dateIsProvisional: false
                  } : {}),
                  ...(restoreSyncedRev ? { sourceRevision: prevSynced.sourceRevision } : {})
                };
                if (restoreSyncedDate && !prevSynced.dateSource) delete effectiveCall.dateSource;
                if (typeof calculateRequestApiCost === 'function' && (effectiveCall.model || effectiveCall.modelKey)) {
                  const recalc = calculateRequestApiCost(effectiveCall);
                  if (recalc.isPriced) {
                    effectiveCall.modelKey = recalc.modelKey;
                    effectiveCall.isPriced = true;
                    effectiveCall.costUSD = recalc.costUSD ?? 0;
                  }
                }
              }
            }
            if (getDateRank(effectiveCall) === 1) {
              let earliestProvDate = effectiveCall.date ? String(effectiveCall.date).slice(0, 10) : '';
              for (const ref of [prevPending, prevSynced, prevQuarantined]) {
                const refRank = ref ? (ref.dateRank !== undefined ? ref.dateRank : getDateRank(ref)) : 0;
                const refDate = ref?.date ? String(ref.date).slice(0, 10) : '';
                if (refRank === 1 && refDate && (!earliestProvDate || refDate < earliestProvDate)) {
                  earliestProvDate = refDate;
                }
              }
              if (earliestProvDate && earliestProvDate !== String(effectiveCall.date || '').slice(0, 10)) {
                effectiveCall = { ...effectiveCall, date: earliestProvDate, created_at: null, dateSource: 'provisional', dateIsProvisional: true };
                if (typeof calculateRequestApiCost === 'function' && (effectiveCall.model || effectiveCall.modelKey)) {
                  const recalc = calculateRequestApiCost(effectiveCall);
                  if (recalc.isPriced) {
                    effectiveCall.modelKey = recalc.modelKey;
                    effectiveCall.isPriced = true;
                    effectiveCall.costUSD = recalc.costUSD ?? 0;
                  }
                }
              }
            }
          }
          state.sessionCallsMap.set(call.callId, effectiveCall);
          if (effectiveCall.status === 'final') {
            const wm = getFinalCallWatermark(effectiveCall);
            if (hasWatermarkProgressed(wm, prevSynced)) {
              if (prevQuarantined && !hasWatermarkProgressed(wm, prevQuarantined) && getSingleCallBodyBytes(effectiveCall) > MAX_FLUSH_BATCH_BYTES) {
                continue;
              }
              const prevPendingWm = prevPending ? getFinalCallWatermark(prevPending) : null;
              const progressedVsPending = hasWatermarkProgressed(wm, prevPendingWm);
              if (progressedVsPending) {
                hasNewOrProgressedPending = true;
                if (getSingleCallBodyBytes(effectiveCall) > MAX_FLUSH_BATCH_BYTES) {
                  state.nextOversizeRetryAt = 0;
                }
              }
              const notRegressedVsPending = !prevPendingWm || (
                compareWatermarkUsage(wm, prevPendingWm) >= 0 &&
                compareSourceRevision(wm.sourceRevision, prevPendingWm.sourceRevision) >= 0 &&
                canAdoptNextDate(wm, prevPendingWm) &&
                getModelRank(wm.model, wm.modelKey) >= getModelRank(prevPendingWm.model, prevPendingWm.modelKey) &&
                (wm.dateRank || 0) >= (prevPendingWm.dateRank || 0) &&
                (!prevPendingWm.modelKey || Boolean(wm.modelKey)) &&
                (!prevPendingWm.isPriced || Boolean(wm.isPriced))
              );
              if (progressedVsPending || notRegressedVsPending) {
                const nextPendingCall = prevPending ? mergePendingCallData(prevPending, effectiveCall) : effectiveCall;
                state.pendingFinalCalls.set(call.callId, nextPendingCall);
              }
            }
          }
        }
      }
      state.callsHydrated = true;
      state.sessionCalls = Array.from(state.sessionCallsMap.values());
      state.sessionCostTotal = state.sessionCalls.reduce((sum, c) => sum + (c.isPriced ? (c.costUSD || 0) : 0), 0);

      // 清除等待首字计时器（禁止用 1000ms 轮询步进时间戳伪造服务器分块流式间隔，避免误判为“输出平稳”）
      const newestPollCall = state.sessionCalls.length ? state.sessionCalls[state.sessionCalls.length - 1] : null;
      if (newestPollCall) {
        if (state.livePendingRequest && state.livePendingRequest.cascadeId === id) {
          const isNewCall = newestPollCall.callId !== state.livePendingRequest.baselineCallId;
          const gotFirstToken = (newestPollCall.outputTokens || 0) > 0 || newestPollCall.ttftSec != null || newestPollCall.status === 'final';
          if ((isNewCall && gotFirstToken) || (state.count > (state.livePendingRequest.baselineCount || 0) && gotFirstToken) || newestPollCall.error) {
            clearLivePendingRequestWait();
          }
        }
      }

      if (hasNewOrProgressedPending) {
        state.nextFlushRetryAt = 0;
      }
      if (state.pendingFinalCalls.size > 0) {
        void flushPendingFinalCalls(wasHydrated);
      }
      for (let i = rows.length - 1; i >= 0; i--) {
        const value = summarize(rows[i], { cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [] });
        if (value) {
          state.latest = withStepError(value, rows[i]);
          const callInfo = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
          recordObservationFromSummary(state.latest, id, {
            callId: callInfo?.callId || null,
            stepCount: state.count,
            ts: Date.now()
          });
          break;
        }
      }
      state.requestAt = Date.now(); state.requestError = '';
      if (state.historyDrawerOpen) scheduleLatestCallRefresh({ allowTimelineRefresh: true });
    } catch (e) { if (generation === state.generation && !state.disposed) state.requestError = e.name === 'AbortError' ? '读取超时' : e.message; }
    finally {
      clearTimeout(timeout);
      state.controllers.delete(controller);
      if (generation === state.generation && !state.disposed) {
        state.requestBusy = false;
        const latestRecNow = resolveLatestSessionCallRecord();
        const isStreamingNow = Boolean(latestRecNow && latestRecNow.status === 'streaming');
        const nextDelay = document.hidden ? 15000 : (isStreamingNow ? 1000 : 3000);
        state.requestNext = Date.now() + nextDelay;
        render();
      }
    }
  }

  async function scan(generation, id, force = false) {
    state.scanBusy = true; render();
    try {
      let result;
      const hasIpcScan = typeof window !== 'undefined' && typeof window.contextMeterAPI?.scan === 'function';
      if (!hasIpcScan && !hasLiveHttpBridge()) {
        throw new Error('完整重启 Antigravity 后启用附件扫描');
      }
      const controller = new AbortController(); state.controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 180000);
      try {
        const out = await callBackendWithPriority({
          ipcCall: hasIpcScan ? () => window.contextMeterAPI.scan(id, force) : null,
          liveRoute: '/scan',
          liveBody: { id, force },
          liveFetchOpts: { signal: controller.signal }
        });
        result = out.result;
      } finally {
        clearTimeout(timeout);
        state.controllers.delete(controller);
      }
      if (generation !== state.generation || state.disposed) return;
      if (result?.data?.abortedStale) return;
      if (!result?.ok) throw new Error(result?.error || '扫描未返回有效结果');
      state.scan = result.data; state.scanError = '';
      if (result.data.modelCapabilitiesById && typeof result.data.modelCapabilitiesById === 'object') {
        mergeCapabilitiesMapClient(result.data.modelCapabilitiesById);
      }
      if (Array.isArray(result.data.cascadeModelConfigs) && result.data.cascadeModelConfigs.length) {
        state.cascadeModelConfigs = result.data.cascadeModelConfigs;
      }
      if (result.data.scannedAt >= state.requestAt && result.data.latest) {
        state.latest = result.data.latest;
        state.requestAt = result.data.scannedAt;
        const genSteps = Number(result.data.generatorCount);
        const msgSteps = Number(result.data.session?.userMessages || 0) + Number(result.data.session?.assistantMessages || 0);
        const resolvedStepCount = Number.isFinite(genSteps) && genSteps >= 0 ? genSteps : (msgSteps > 0 ? msgSteps : state.count);
        recordObservationFromSummary(state.latest, id, {
          callId: result.data.latestCallId || null,
          stepCount: resolvedStepCount,
          ts: Number(result.data.scannedAt || Date.now())
        });
      }
      state.latest = withStepError(state.latest);
      renderFiles(result.data.session);
      if (state.historyDrawerOpen) scheduleLatestCallRefresh({ allowTimelineRefresh: true });
    } catch (e) { if (generation === state.generation && !state.disposed) state.scanError = e.message; }
    finally { if (generation === state.generation && !state.disposed) { state.scanBusy = false; state.scanNext = Date.now() + (document.hidden ? 60000 : 20000); render(); } }
  }

  let lastAvailableModelsSync = 0;
  let availableModelsFetchInFlight = false;
  async function fetchAvailableModelsIfNeeded() {
    if (availableModelsFetchInFlight) return;
    if (typeof fetch !== 'function') return;
    const csrf = typeof window !== 'undefined' ? window.__APP_CONFIG__?.csrfToken : null;
    if (!csrf) return;
    if (Date.now() - lastAvailableModelsSync < 300000 && state.modelCapabilitiesById && Object.keys(state.modelCapabilitiesById).length > 0) {
      return;
    }
    availableModelsFetchInFlight = true;
    try {
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetAvailableModels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf },
        body: JSON.stringify({ forceRefresh: false })
      });
      if (!response.ok) return;
      const data = await response.json();
      const modelsObj = data?.response?.models || data?.models;
      if (!modelsObj || typeof modelsObj !== 'object') return;
      const entries = Array.isArray(modelsObj)
        ? modelsObj.map(item => [item?.model || item?.modelId || '', item])
        : Object.entries(modelsObj);
      const nextCaps = {};
      for (const [entryKey, d] of entries) {
        if (!d || typeof d !== 'object') continue;
        const rawId = String(d.model || d.modelId || entryKey || '').trim();
        if (!rawId) continue;
        const normKey = rawId.toLowerCase().replace(/^model_/, '');
        const maxTokens = Number.isSafeInteger(Number(d.maxTokens)) && Number(d.maxTokens) > 0 ? Number(d.maxTokens) : null;
        const maxOutputTokens = d.maxOutputTokens != null && Number.isSafeInteger(Number(d.maxOutputTokens)) && Number(d.maxOutputTokens) >= 0
          ? Number(d.maxOutputTokens)
          : null;
        const rec = {
          modelId: rawId,
          displayName: d.displayName || null,
          maxTokens,
          maxOutputTokens,
          thinkingBudget: d.thinkingBudget ?? null,
          minThinkingBudget: d.minThinkingBudget ?? null,
          thinkingLevel: d.thinkingLevel || null,
          supportsModelInfoOverride: typeof d.supportsModelInfoOverride === 'boolean' ? d.supportsModelInfoOverride : null,
          capabilitySource: 'get_available_models'
        };
        if (normKey) nextCaps[normKey] = rec;
        if (entryKey) nextCaps[String(entryKey).trim().toLowerCase().replace(/^model_/, '')] = rec;
      }
      if (Object.keys(nextCaps).length > 0) {
        mergeCapabilitiesMapClient(nextCaps);
        lastAvailableModelsSync = Date.now();
        if (!isContextSettingsView && activeContextTab === 'models') {
          renderModelSettingsTab();
          renderPresetSelectionUI();
        }
      }
    } catch { }
    finally {
      availableModelsFetchInFlight = false;
    }
  }


  function getContextPreferencesStateForTest() {
    return {
      activeSessionModelKey,
      activeSessionProductKey,
      selectedEditModelKey,
      selectedProductKey,
      activeContextTab,
      isContextSettingsView
    };
  }

  function setContextLatestForTestImpl(latestObj, configs = [], capabilitiesById = null) {
    if (capabilitiesById && typeof capabilitiesById === 'object') mergeCapabilitiesMapClient(capabilitiesById);
    if (Array.isArray(configs) && configs.length) state.cascadeModelConfigs = configs;
    state.latest = latestObj;
    if (latestObj && (state.route || state.activeConversationId)) {
      recordObservationFromSummary(latestObj, state.route || state.activeConversationId, { ts: latestObj.ts || Date.now() });
    }
    manualModelSelection = false;
    render();
    return { activeSessionModelKey, activeSessionProductKey, selectedEditModelKey, selectedProductKey };
  }

  function setModelCapabilitiesForTestImpl(capabilitiesById) {
    mergeCapabilitiesMapClient(capabilitiesById);
    if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
  }

  function getLatestCallCardStateForTestImpl() {
    return {
      route: state.route,
      displayedCall: state.displayedCallRecord,
      pendingLatestCall: state.pendingLatestCallRecord,
      pinnedCall: state.pinnedCallRecord,
      detailOpen: state.latestCallDetailOpen,
      historyOpen: state.historyDrawerOpen,
      bannerVisible: Boolean(el('latest-call-new-banner') && !el('latest-call-new-banner').hidden),
      isEntering: Boolean(el('latest-call-body')?.classList?.contains?.('is-entering'))
    };
  }

  function setSessionCallsForTestImpl(calls, opts = {}) {
    if (opts.route && state.route !== opts.route) {
      state.route = opts.route;
      state.displayedCallRecord = null;
      state.displayedCallSig = '';
      state.pendingLatestCallRecord = null;
      state.pinnedCallRecord = null;
      state.latestCallDetailOpen = false;
      state.lastAnimatedCallSig = '';
    }
    if (!state.sessionCallsMap) state.sessionCallsMap = new Map();
    if (opts.replace) state.sessionCallsMap.clear();
    for (const c of (Array.isArray(calls) ? calls : [])) {
      if (c && c.callId) state.sessionCallsMap.set(c.callId, c);
    }
    state.sessionCalls = Array.from(state.sessionCallsMap.values());
    state.sessionCostTotal = state.sessionCalls.reduce((sum, c) => sum + (c && c.isPriced ? (Number(c.costUSD) || 0) : 0), 0);
    render();
    return {
      displayedCall: state.displayedCallRecord,
      pendingLatestCall: state.pendingLatestCallRecord,
      bannerVisible: Boolean(el('latest-call-new-banner') && !el('latest-call-new-banner').hidden)
    };
  }

  function setSessionTimelineForTestImpl(tl) {
    state.sessionTimeline = tl;
    if (state.historyDrawerOpen) renderSessionTimeline();
  }

  function toggleSessionHistoryForTestImpl(open) {
    state.historyDrawerOpen = open !== undefined ? Boolean(open) : !state.historyDrawerOpen;
    renderSessionTimeline();
    return state.historyDrawerOpen;
  }
  // =========================================================================
  // 实时流式生成速度评估、顶栏徽章同步与跨模型速度对比图表 (speed-view.js)
  // =========================================================================
  let speedRangeDays = '7';
  let speedOriginFilter = 'all';
  let speedMetric = 'tps';
  let speedChartMode = 'bar';
  let selectedSpeedExactModelId = null;
  let speedModelDropdownCtrl = null;

  function isValidSpeedSampleSafe(c) {
    if (typeof isValidSpeedSample === 'function') return isValidSpeedSample(c);
    return Boolean(c && c.status === 'final' && !c.estimated && Number(c.outputTokens) > 0 && Number(c.durationSec) > 0 && Number(c.tps) > 0);
  }

  function mergeAvailableSpeedCalls() {
    const byId = new Map();
    const hist = Array.isArray(ANTIGRAVITY_TOKEN_DATA.speedRecords) ? ANTIGRAVITY_TOKEN_DATA.speedRecords : [];
    for (const r of hist) {
      if (r && r.callId) byId.set(r.callId, r);
    }
    const cur = Array.isArray(state.sessionCalls) ? state.sessionCalls : [];
    for (const r of cur) {
      if (!r || !r.callId) continue;
      const prev = byId.get(r.callId);
      if (!prev || (!isValidSpeedSampleSafe(prev) && isValidSpeedSampleSafe(r)) || Number(r.outputTokens || 0) > Number(prev.outputTokens || 0)) {
        byId.set(r.callId, r);
      }
    }
    return Array.from(byId.values());
  }

  function createSvgEl(tag, attrs = {}) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return null;
    const node = typeof doc.createElementNS === 'function'
      ? doc.createElementNS('http://www.w3.org/2000/svg', tag)
      : (typeof doc.createElement === 'function' ? doc.createElement(tag) : null);
    if (!node) return null;
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null && typeof node.setAttribute === 'function') node.setAttribute(k, String(v));
    }
    return node;
  }

  function renderSpeedBarChart(groups) {
    const svg = el('speed-bar-svg');
    const wrap = el('speed-bar-chart-wrap');
    const emptyEl = el('speed-bar-empty');
    const tooltip = el('speed-bar-tooltip');
    const titleEl = el('speed-bar-title');

    const metricTitleMap = { tps: t('speed.barTitle.tps'), ttft: t('speed.barTitle.ttft'), duration: t('speed.barTitle.duration') };
    if (titleEl) titleEl.textContent = metricTitleMap[speedMetric] || t('speed.barTitle.tps');

    if (!groups.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!svg || typeof svg.replaceChildren !== 'function') return;

    const width = 420;
    const rowH = 34;
    const padTop = 8;
    const padBottom = 10;
    const labelW = 148;
    const valW = 86;
    const barAreaW = width - labelW - valW - 12;
    const height = padTop + padBottom + groups.length * rowH;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const getVal = g => speedMetric === 'ttft' ? g.medianTtft : speedMetric === 'duration' ? g.medianDuration : g.medianTps;
    const maxVal = Math.max(...groups.map(g => getVal(g) || 0), 0.1);

    const nodes = [];
    groups.forEach((g, idx) => {
      const y = padTop + idx * rowH;
      const val = getVal(g) || 0;
      const w = Math.max(4, (val / maxVal) * barAreaW);
      const effText = g.effort ? ` (${formatEffortZh(g.effort)})` : '';
      const displayLabel = `${g.productLabel}${effText}`;
      const unitStr = speedMetric === 'tps' ? `${val} tok/s` : t('speed.unitSec', { val });

      const rowGrp = createSvgEl('g', { style: 'cursor:pointer' });
      const bgHit = createSvgEl('rect', { x: 0, y, width, height: rowH - 4, rx: 4, fill: 'transparent' });
      const dot = createSvgEl('circle', {
        cx: 7,
        cy: y + 14,
        r: 3.5,
        fill: VENDOR_DOT_COLORS[g.vendor] || '#8a8a94'
      });
      const lbl = createSvgEl('text', {
        x: 15,
        y: y + 18,
        fill: 'var(--ag-text-primary, #ececef)',
        'font-size': '10.5'
      });
      if (lbl) lbl.textContent = displayLabel.length > 20 ? displayLabel.slice(0, 19) + '…' : displayLabel;

      const track = createSvgEl('rect', {
        x: labelW,
        y: y + 7,
        width: barAreaW,
        height: 14,
        rx: 3,
        fill: 'var(--ag-track-bg, rgba(255,255,255,0.08))'
      });
      const bar = createSvgEl('rect', {
        x: labelW,
        y: y + 7,
        width: w.toFixed(1),
        height: 14,
        rx: 3,
        fill: VENDOR_DOT_COLORS[g.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        opacity: g.lowSample ? '0.45' : '0.92'
      });
      const valTxt = createSvgEl('text', {
        x: labelW + barAreaW + 6,
        y: y + 18,
        fill: g.lowSample ? 'var(--ag-text-muted, #8a8a94)' : 'var(--ag-text-secondary, #c8c8d0)',
        'font-size': '10'
      });
      if (valTxt) valTxt.textContent = `${unitStr}${g.lowSample ? ` ${t('speed.lowSample')}` : ''}`;

      if (rowGrp) {
        if (bgHit) rowGrp.appendChild(bgHit);
        if (dot) rowGrp.appendChild(dot);
        if (lbl) rowGrp.appendChild(lbl);
        if (track) rowGrp.appendChild(track);
        if (bar) rowGrp.appendChild(bar);
        if (valTxt) rowGrp.appendChild(valTxt);
        rowGrp.addEventListener?.('mouseenter', () => {
          if (!tooltip) return;
          const rangeTxt = g.minTs && g.maxTs
            ? `${formatMonthDayTime(g.minTs)} ~ ${formatMonthDayTime(g.maxTs)}`
            : '—';
          tooltip.innerHTML =
            `<strong>${displayLabel}</strong><br>` +
            `${t('speed.tip.samples', { n: g.count, low: g.lowSample ? t('models.card.lowSampleParen') : '' })}<br>` +
            `${t('speed.tip.timeRange', { range: rangeTxt })}<br>` +
            `${t('speed.tip.medOut', { val: fmt(g.medianOutputTokens) })}<br>` +
            `${t('speed.tip.medIn', { val: fmt(g.medianInputTokens) })}`;
          tooltip.hidden = false;
          if (tooltip.style) {
            tooltip.style.top = `${Math.max(4, y - 4)}px`;
            tooltip.style.right = '8px';
          }
        });
        rowGrp.addEventListener?.('mouseleave', () => {
          if (tooltip) tooltip.hidden = true;
        });
        rowGrp.addEventListener?.('click', () => {
          selectedSpeedExactModelId = g.modelExactId;
          switchSpeedChartMode('line');
        });
        nodes.push(rowGrp);
      }
    });
    svg.replaceChildren(...nodes);
  }

  function renderSpeedLineChart(selectedGroup) {
    const svg = el('speed-line-svg');
    const wrap = el('speed-line-chart-wrap');
    const emptyEl = el('speed-line-empty');
    const tooltip = el('speed-line-tooltip');

    const samples = (selectedGroup?.samples || []).filter(s => s && s.tps > 0);
    if (!samples.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!svg || typeof svg.replaceChildren !== 'function') return;

    const width = 420;
    const height = 148;
    const padL = 38;
    const padR = 14;
    const padT = 14;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const maxTps = Math.max(...samples.map(s => Number(s.tps) || 0), 10);
    const minTps = Math.max(0, Math.min(...samples.map(s => Number(s.tps) || 0)) * 0.8);
    const spanTps = Math.max(1, maxTps - minTps);

    const nodes = [];
    // Y 轴参考线与刻度
    [0, 0.5, 1].forEach(ratio => {
      const y = padT + plotH * (1 - ratio);
      const val = Math.round(minTps + spanTps * ratio);
      const grid = createSvgEl('line', {
        x1: padL, y1: y.toFixed(1), x2: width - padR, y2: y.toFixed(1),
        stroke: 'var(--ag-border-subtle, rgba(255,255,255,0.08))', 'stroke-width': 1
      });
      const txt = createSvgEl('text', {
        x: padL - 5, y: (y + 3).toFixed(1), 'text-anchor': 'end',
        fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5'
      });
      if (txt) txt.textContent = String(val);
      if (grid) nodes.push(grid);
      if (txt) nodes.push(txt);
    });

    const pts = samples.map((s, idx) => {
      const x = samples.length === 1 ? padL + plotW / 2 : padL + (idx / (samples.length - 1)) * plotW;
      const y = padT + plotH * (1 - ((Number(s.tps) - minTps) / spanTps));
      return { x, y, sample: s };
    });

    if (pts.length >= 2) {
      const dAttr = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      const path = createSvgEl('path', {
        d: dAttr, fill: 'none',
        stroke: VENDOR_DOT_COLORS[selectedGroup.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        'stroke-width': 1.8
      });
      if (path) nodes.push(path);
    }

    pts.forEach((pt, idx) => {
      const circle = createSvgEl('circle', {
        cx: pt.x.toFixed(1),
        cy: pt.y.toFixed(1),
        r: 3.5,
        fill: VENDOR_DOT_COLORS[selectedGroup.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        stroke: 'var(--ag-bg-panel, #181818)',
        'stroke-width': 1.2,
        style: 'cursor:pointer'
      });
      if (circle) {
        circle.addEventListener?.('mouseenter', () => {
          if (!tooltip) return;
          const s = pt.sample;
          const originTxt = s.origin === 'speed-test' ? t('speed.originProbe') : t('speed.origin.chat');
          const ttftTxt = s.ttftSec != null ? t('speed.unitSec', { val: s.ttftSec }) : t('speed.unknown');
          tooltip.innerHTML =
            `<strong>${t('speed.tip.tpsLine', { idx: idx + 1, tps: s.tps })}</strong><br>` +
            `${t('speed.tip.time', { val: formatMonthDayTime(s.ts || s.createdAt) || '—' })}<br>` +
            `${t('speed.tip.output', { val: fmt(s.outputTokens) })}<br>` +
            `${t('speed.tip.ttft', { val: ttftTxt })}<br>` +
            `${t('speed.tip.origin', { val: originTxt })}`;
          tooltip.hidden = false;
          if (tooltip.style) {
            tooltip.style.top = '6px';
            tooltip.style.right = '8px';
          }
        });
        circle.addEventListener?.('mouseleave', () => {
          if (tooltip) tooltip.hidden = true;
        });
        nodes.push(circle);
      }
    });

    const firstLbl = createSvgEl('text', { x: padL, y: height - 6, fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5' });
    if (firstLbl) firstLbl.textContent = formatMonthDayTime(samples[0].ts || samples[0].createdAt) || '#1';
    const lastLbl = createSvgEl('text', { x: width - padR, y: height - 6, 'text-anchor': 'end', fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5' });
    if (lastLbl && samples.length > 1) lastLbl.textContent = formatMonthDayTime(samples[samples.length - 1].ts || samples[samples.length - 1].createdAt) || `#${samples.length}`;
    if (firstLbl) nodes.push(firstLbl);
    if (lastLbl) nodes.push(lastLbl);

    svg.replaceChildren(...nodes);
  }

  let lastSpeedGroups = [];

  function syncSpeedChartModeDom() {
    const isLine = speedChartMode === 'line';
    const barBtn = el('speed-view-mode-bar');
    const lineBtn = el('speed-view-mode-line');
    const barPane = el('speed-chart-pane-bar');
    const linePane = el('speed-chart-pane-line');
    setPillActive(barBtn, !isLine);
    setPillActive(lineBtn, isLine);
    barBtn?.setAttribute?.('aria-selected', isLine ? 'false' : 'true');
    lineBtn?.setAttribute?.('aria-selected', isLine ? 'true' : 'false');
    if (barPane) barPane.hidden = isLine;
    if (linePane) linePane.hidden = !isLine;
  }

  function switchSpeedChartMode(mode) {
    speedChartMode = mode === 'line' ? 'line' : 'bar';
    if (speedChartMode !== 'line') {
      speedModelDropdownCtrl?.close?.();
    }
    syncSpeedChartModeDom();
    renderSpeedComparisonTab();
    if (typeof positionFloatingPanels === 'function') positionFloatingPanels();
  }

  function renderSpeedComparisonTab() {
    syncSpeedChartModeDom();
    const mergedCalls = mergeAvailableSpeedCalls();
    const daysArg = speedRangeDays === 'all' ? 'all' : Number(speedRangeDays);
    const groups = typeof summarizeSpeedByModel === 'function'
      ? summarizeSpeedByModel(mergedCalls, {
        days: daysArg,
        origin: speedOriginFilter,
        metric: speedMetric,
        cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []
      })
      : [];
    lastSpeedGroups = groups;

    renderSpeedBarChart(groups);

    if (!selectedSpeedExactModelId || !groups.some(g => g.modelExactId === selectedSpeedExactModelId)) {
      selectedSpeedExactModelId = groups[0]?.modelExactId || null;
    }
    const chosenGroup = groups.find(g => g.modelExactId === selectedSpeedExactModelId) || null;
    const speedDropLabel = el('speed-model-dropdown-label');
    if (speedDropLabel) {
      if (chosenGroup) {
        const effStr = chosenGroup.effort ? ` · ${formatEffortZh(chosenGroup.effort)}` : '';
        speedDropLabel.textContent = `${chosenGroup.productLabel}${effStr}`;
      } else {
        speedDropLabel.textContent = t('speed.lineNoModel');
      }
    }

    if (!speedModelDropdownCtrl && typeof initDropdownController === 'function' && el('speed-model-dropdown-wrap')) {
      speedModelDropdownCtrl = initDropdownController({
        wrapId: 'speed-model-dropdown-wrap',
        triggerId: 'speed-model-dropdown-trigger',
        labelId: 'speed-model-dropdown-label',
        menuId: 'speed-model-dropdown-menu',
        emptyLabel: () => t('speed.lineNoModel'),
        searchPlaceholder: () => t('dropdown.speedSearch'),
        emptyText: () => t('dropdown.speedEmpty'),
        getSelectedValue: () => selectedSpeedExactModelId || '',
        onSelect: (opt) => {
          const val = opt?.value || '';
          if (!val) return;
          selectedSpeedExactModelId = val;
          renderSpeedComparisonTab();
        },
        getOptions: () => lastSpeedGroups.map(g => {
          const effStr = g.effort ? ` · ${formatEffortZh(g.effort)}` : '';
          return {
            value: g.modelExactId,
            label: `${g.productLabel}${effStr}`,
            displayRight: t('speed.samples', { n: g.count })
          };
        })
      });
    } else if (speedModelDropdownCtrl && typeof speedModelDropdownCtrl.refresh === 'function') {
      speedModelDropdownCtrl.refresh();
    }

    renderSpeedLineChart(chosenGroup);
  }

  const SPEED_RANGE_MAP = { 'speed-range-7d': '7', 'speed-range-30d': '30', 'speed-range-all': 'all' };
  const SPEED_ORIGIN_MAP = { 'speed-origin-all': 'all', 'speed-origin-chat': 'chat' };
  const SPEED_METRIC_MAP = { 'speed-metric-tps': 'tps', 'speed-metric-ttft': 'ttft', 'speed-metric-duration': 'duration' };

  function bindSpeedFilterGroup(map, onPick) {
    const ids = Object.keys(map);
    ids.forEach(id => {
      el(id)?.addEventListener('click', () => {
        const val = map[id];
        onPick(val);
        ids.forEach(k => setPillActive(el(k), map[k] === val));
        renderSpeedComparisonTab();
      });
    });
  }

  bindSpeedFilterGroup(SPEED_RANGE_MAP, v => { speedRangeDays = v; });
  bindSpeedFilterGroup(SPEED_ORIGIN_MAP, v => { speedOriginFilter = v; });
  bindSpeedFilterGroup(SPEED_METRIC_MAP, v => { speedMetric = v; });
  el('speed-view-mode-bar')?.addEventListener('click', () => switchSpeedChartMode('bar'));
  el('speed-view-mode-line')?.addEventListener('click', () => switchSpeedChartMode('line'));

  function stopLiveWaitTickTimer() {
    if (state.liveWaitTickTimer) {
      clearInterval(state.liveWaitTickTimer);
      state.liveWaitTickTimer = null;
    }
  }

  function clearLivePendingRequestWait() {
    state.livePendingRequest = null;
    stopLiveWaitTickTimer();
  }
  earlyDisposeHooks.push(clearLivePendingRequestWait);

  function resolveSpeedEvaluationInput() {
    if (state.speedOverrideForTest && typeof state.speedOverrideForTest === 'object') {
      return state.speedOverrideForTest;
    }
    if (state.livePendingRequest && state.route && state.livePendingRequest.cascadeId === state.route) {
      const elapsedSec = Math.max(0, (Date.now() - state.livePendingRequest.startedAtMs) / 1000);
      return {
        phase: 'waiting',
        status: 'waiting',
        elapsedSec
      };
    }
    const d = state.latest;
    if (!d) return { phase: 'idle', status: 'idle' };
    const latestRec = resolveLatestSessionCallRecord();
    const sameActiveCall = latestRec && (!d.speed || !latestRec.outputTokens || Math.abs(Number(latestRec.outputTokens) - Number(d.speed?.outputTokens || 0)) <= 50 || latestRec.status === 'streaming');
    const trackedSamples = (latestRec && state.streamSampleTracker?.byCallId?.get?.(latestRec.callId)) || null;

    if (d.status === 'canceled' || d.errorClassification?.kind === 'canceled') {
      return {
        phase: 'canceled',
        status: 'canceled',
        outcomeStatus: 'canceled',
        ttftSec: d.speed?.ttft ?? null,
        totalDurationSec: d.speed?.duration ?? null,
        outputTokens: d.speed?.outputTokens ?? null,
        error: d.error || ''
      };
    }
    if (d.exceeded || d.network || d.error || ['failed', 'quota_exhausted', 'rate_limited', 'auth_error', 'service_unavailable'].includes(d.status)) {
      return {
        phase: 'failed',
        status: d.status || 'failed',
        outcomeStatus: d.status || 'failed',
        ttftSec: d.speed?.ttft ?? null,
        totalDurationSec: d.speed?.duration ?? null,
        outputTokens: d.speed?.outputTokens ?? null,
        error: d.error || ''
      };
    }
    if (latestRec && latestRec.status === 'streaming' && latestRec.outputTokens > 0) {
      return {
        phase: 'streaming',
        status: 'streaming',
        ttftSec: latestRec.ttftSec ?? d.speed?.ttft ?? null,
        streamingSec: latestRec.streamingSec ?? d.speed?.streamingSec ?? trackedSamples?.elapsedStreamSec ?? null,
        totalDurationSec: latestRec.durationSec ?? d.speed?.duration ?? null,
        streamSpeed: latestRec.streamingTps ?? d.speed?.streamingTps ?? null,
        overallTps: latestRec.tps ?? d.speed?.tps ?? null,
        outputTokens: latestRec.outputTokens ?? d.speed?.outputTokens ?? 0,
        totalInputTokens: latestRec.totalInputTokens ?? d.input ?? null,
        chunkCount: trackedSamples?.chunks ?? latestRec.chunkCount ?? null,
        chunkIntervalsMs: trackedSamples?.intervalsMs ?? latestRec.chunkIntervalsMs ?? null
      };
    }
    if (d.speed) {
      return {
        phase: 'final',
        status: 'final',
        ttftSec: d.speed.ttft ?? null,
        streamingSec: d.speed.streamingSec ?? null,
        totalDurationSec: d.speed.duration ?? null,
        streamSpeed: d.speed.streamingTps ?? d.speed.streamSpeed ?? null,
        overallTps: d.speed.tps ?? null,
        outputTokens: d.speed.outputTokens ?? null,
        totalInputTokens: d.speed.totalInputTokens ?? d.input ?? null,
        chunkCount: (sameActiveCall && trackedSamples?.chunks) || (sameActiveCall && latestRec?.chunkCount) || null,
        chunkIntervalsMs: (sameActiveCall && trackedSamples?.intervalsMs) || (sameActiveCall && latestRec?.chunkIntervalsMs) || null
      };
    }
    if (latestRec && (latestRec.ttftSec != null || latestRec.durationSec != null || latestRec.outputTokens > 0)) {
      return {
        phase: latestRec.status === 'streaming' ? 'streaming' : 'final',
        status: latestRec.status,
        ttftSec: latestRec.ttftSec ?? null,
        streamingSec: latestRec.streamingSec ?? null,
        totalDurationSec: latestRec.durationSec ?? null,
        streamSpeed: latestRec.streamingTps ?? null,
        overallTps: latestRec.tps ?? null,
        outputTokens: latestRec.outputTokens ?? null,
        totalInputTokens: latestRec.totalInputTokens ?? null,
        chunkCount: trackedSamples?.chunks ?? latestRec.chunkCount ?? null,
        chunkIntervalsMs: trackedSamples?.intervalsMs ?? latestRec.chunkIntervalsMs ?? null
      };
    }
    return { phase: 'idle', status: 'idle' };
  }

  function applyElv91PillTone(badgeEl, evalRes) {
    if (!badgeEl || !evalRes?.badge) return;
    const sev = evalRes.badge.severity || 'neutral';
    const cls = (sev === 'good' || sev === 'fast' || sev === 'rapid' || sev === 'epic')
      ? 'pill-good'
      : (sev === 'warn' ? 'pill-warn' : ((sev === 'danger' || sev === 'critical') ? 'pill-danger' : 'pill-muted'));
    badgeEl.className = `key-pill ${cls}`;
    badgeEl.style.color = evalRes.badge.color || '';
    badgeEl.textContent = `${evalRes.badge.text || ''}`;
  }

  function renderSpeedExperienceInPlace(evalRes) {
    if (!evalRes) return;
    const isEn = currentPanelLanguage === 'en';
    const isTw = currentPanelLanguage === 'zh-TW';
    const activeColor = evalRes.badge?.color || '';

    const speedAmount = el('speed-amount');
    const overflowSpeedVal = el('overflow-speed-val');
    const topBolt = el('badge-speed-icon');
    const cardBolt = el('speed-summary-bolt');
    if (topBolt) topBolt.style.color = activeColor;
    if (cardBolt) cardBolt.style.color = activeColor;

    const isCompact = state.layoutMode === 'compact';
    const shortSampleText = t('session.speed.shortSampleBadge');
    if (speedAmount) {
      if (evalRes.phase === 'waiting') {
        speedAmount.textContent = isCompact ? evalRes.elapsedFormatted : (isEn ? `Wait ${evalRes.elapsedFormatted}` : `等待 ${evalRes.elapsedFormatted}`);
        if (overflowSpeedVal) overflowSpeedVal.textContent = `${evalRes.elapsedFormatted}`;
      } else if (evalRes.isSampleSparse) {
        speedAmount.textContent = shortSampleText;
        if (overflowSpeedVal) overflowSpeedVal.textContent = shortSampleText;
      } else if (evalRes.streamSpeed != null) {
        speedAmount.textContent = isCompact ? `${evalRes.streamSpeed}` : `${evalRes.streamSpeed} tok/s`;
        if (overflowSpeedVal) overflowSpeedVal.textContent = `${evalRes.streamSpeed} tok/s`;
      } else if (evalRes.overallTps != null) {
        speedAmount.textContent = isCompact ? `${evalRes.overallTps}` : `${evalRes.overallTps} tok/s`;
        if (overflowSpeedVal) overflowSpeedVal.textContent = `${evalRes.overallTps} tok/s`;
      } else {
        speedAmount.textContent = isCompact ? '--' : '-- tok/s';
        if (overflowSpeedVal) overflowSpeedVal.textContent = '-- tok/s';
      }
    }

    const spBadge = el('speed-badge');
    const spVal = el('speed-val');
    const spDur = el('speed-duration');
    const spTtft = el('speed-ttft');
    const spTokens = el('speed-tokens');
    const spSub = el('speed-sub-label');
    const spTakeaway = el('speed-takeaway');
    const spToggleBtn = el('btn-speed-breakdown-toggle');
    const spBreakdownDet = el('speed-breakdown-details');
    const spBreakdownGrid = el('speed-breakdown-grid');

    const spMockTag = el('speed-mock-tag');
    if (spMockTag) {
      spMockTag.hidden = !(state.speedOverrideForTest && typeof state.speedOverrideForTest === 'object');
      if (!spMockTag.hidden) spMockTag.textContent = t('session.speed.mockTag');
    }
    if (spBadge) applyElv91PillTone(spBadge, evalRes);
    if (spVal) {
      if (evalRes.phase === 'waiting') {
        spVal.textContent = isEn ? 'Waiting' : '等待首字';
      } else if (evalRes.isSampleSparse) {
        spVal.textContent = shortSampleText;
      } else if (evalRes.streamSpeed != null) {
        spVal.textContent = `${evalRes.streamSpeed} tok/s`;
      } else if (evalRes.overallTps != null) {
        spVal.textContent = `${evalRes.overallTps} tok/s`;
      } else {
        spVal.textContent = '—';
      }
    }
    if (spDur) spDur.textContent = evalRes.durationFormatted || '—';
    if (spTtft) spTtft.textContent = evalRes.ttftFormatted || '—';
    if (spTokens) spTokens.textContent = evalRes.outputTokens != null ? `${fmt(evalRes.outputTokens)} tok` : '—';

    if (spSub) {
      if (evalRes.subLabel && evalRes.phase !== 'idle') {
        spSub.hidden = false;
        spSub.textContent = evalRes.subLabel;
      } else {
        spSub.hidden = true;
        spSub.textContent = '';
      }
    }
    if (spTakeaway) {
      const avgNote = (evalRes.phase === 'final' && evalRes.overallTps != null && (evalRes.isSampleSparse || (evalRes.streamSpeed != null && Math.abs(evalRes.overallTps - evalRes.streamSpeed) >= 5)))
        ? (isEn ? ` (Overall avg ${evalRes.overallTps} tok/s)` : (isTw ? `（整體均速 ${evalRes.overallTps} tok/s）` : `（整体均速 ${evalRes.overallTps} tok/s）`))
        : '';
      spTakeaway.textContent = `${evalRes.comment || ''}${avgNote}`;
    }

    const canShowBreakdown = evalRes.phase === 'final' || evalRes.phase === 'streaming';
    if (spToggleBtn) {
      spToggleBtn.hidden = !canShowBreakdown;
      spToggleBtn.textContent = state.speedBreakdownOpen ? t('session.speed.hideDetails') : t('session.speed.details');
      spToggleBtn.setAttribute?.('aria-expanded', state.speedBreakdownOpen ? 'true' : 'false');
    }
    if (spBreakdownDet) {
      spBreakdownDet.style.display = (canShowBreakdown && state.speedBreakdownOpen) ? 'block' : 'none';
    }
    if (spBreakdownGrid && canShowBreakdown && state.speedBreakdownOpen) {
      spBreakdownGrid.replaceChildren();
      const unk = t('session.latestCall.unknownVal');
      const eText = evalRes.efficiency?.available
        ? `${evalRes.efficiency.score} ${isEn ? 'pts' : '分'} · ${evalRes.efficiency.tier?.title || evalRes.efficiency.grade}`
        : (evalRes.efficiency?.skippedReason === 'insufficient_sample' ? t('session.speed.scoreSkippedSparse') : t('session.speed.scoreSkippedMissing'));
      const stabText = evalRes.stability?.isStable
        ? t('session.speed.stabilityOk', { n: evalRes.stability.chunks, cv: evalRes.stability.intervalCv })
        : (evalRes.stability?.reason === 'high_variance'
          ? t('session.speed.stabilityHighVar', { n: evalRes.stability.chunks, cv: evalRes.stability.intervalCv })
          : t('session.speed.stabilityUnverified'));
      const fmtTierComment = (tier, elapsed) => (tier && tier.comment) ? String(tier.comment).replace('{elapsed}', elapsed || '—') : '';
      const streamCellVal = evalRes.isSampleSparse
        ? `${shortSampleText}${evalRes.shortWindowEstimateSpeed != null ? ` (${evalRes.shortWindowEstimateSpeed} tok/s)` : ''}`
        : (evalRes.speedTier ? `${evalRes.streamSpeed} tok/s · ${evalRes.speedTier.title}` : unk);
      const cells = [
        {
          k: t('session.speed.breakdown.eScore'),
          v: eText,
          color: evalRes.efficiency?.tier?.color || null,
          note: evalRes.efficiency?.tier?.comment || ''
        },
        {
          k: t('session.speed.breakdown.ttft'),
          v: evalRes.ttftTier ? `${evalRes.ttftFormatted} · ${evalRes.ttftTier.title}${evalRes.ttftRatioPct != null ? ` (${evalRes.ttftRatioPct}%)` : ''}` : unk,
          color: evalRes.ttftTier?.color || null,
          note: fmtTierComment(evalRes.ttftTier, evalRes.ttftFormatted)
        },
        {
          k: t('session.speed.breakdown.stream'),
          v: streamCellVal,
          color: evalRes.isSampleSparse ? null : (evalRes.speedTier?.color || null),
          note: evalRes.isSampleSparse ? t('session.speed.shortWindowNote') : (evalRes.speedTier?.comment || '')
        },
        {
          k: t('session.speed.breakdown.duration'),
          v: evalRes.durationTier ? `${evalRes.durationFormatted} · ${evalRes.durationTier.title}` : unk,
          color: evalRes.durationTier?.color || null,
          note: evalRes.durationTier?.comment || ''
        },
        { k: t('session.speed.breakdown.overall'), v: evalRes.overallTps != null ? `${evalRes.overallTps} tok/s` : unk, color: null, note: '' },
        { k: t('session.speed.breakdown.stability'), v: stabText, color: evalRes.stability?.isStable ? '#10B981' : null, note: '' }
      ];
      if (evalRes.isSampleSparse && evalRes.shortWindowEstimateSpeed != null) {
        cells.splice(3, 0, {
          k: t('session.speed.shortWindowEst'),
          v: `${evalRes.shortWindowEstimateSpeed} tok/s`,
          color: null,
          note: t('session.speed.shortWindowNote')
        });
      }
      if (evalRes.efficiency?.basis) {
        const b = evalRes.efficiency.basis;
        cells.push({
          k: t('session.speed.breakdown.basis'),
          v: `N=${b.N_work} · γ=${b.gamma} · w=[${b.w1}/${b.w2}/${b.w3}]`,
          color: null,
          note: ''
        });
      }
      for (const item of cells) {
        const cell = document.createElement('div');
        cell.className = 'call-detail-cell';
        const kEl = document.createElement('span');
        kEl.className = 'call-detail-k';
        kEl.textContent = item.k;
        const vEl = document.createElement('span');
        vEl.className = 'call-detail-v';
        if (item.color) {
          const dot = document.createElement('span');
          dot.className = 'tier-color-swatch';
          dot.style.backgroundColor = item.color;
          dot.setAttribute('aria-hidden', 'true');
          vEl.appendChild(dot);
          const txtEl = document.createElement('span');
          txtEl.textContent = item.v;
          vEl.appendChild(txtEl);
        } else {
          vEl.textContent = item.v;
        }
        cell.appendChild(kEl);
        cell.appendChild(vEl);
        if (item.note) {
          const noteEl = document.createElement('span');
          noteEl.className = 'call-detail-note';
          noteEl.textContent = item.note;
          cell.appendChild(noteEl);
        }
        spBreakdownGrid.appendChild(cell);
      }
    }
    state.lastSpeedEval = evalRes;
  }

  function startLivePendingRequestWait(cascadeId) {
    const cid = cascadeId || state.route;
    if (!cid) return;
    const latestRec = resolveLatestSessionCallRecord();
    state.livePendingRequest = {
      cascadeId: cid,
      startedAtMs: Date.now(),
      baselineCallId: latestRec?.callId || null,
      baselineCount: state.count || 0
    };
    const updateWaitOnly = () => {
      if (state.disposed || !state.livePendingRequest || state.livePendingRequest.cascadeId !== state.route) {
        stopLiveWaitTickTimer();
        return;
      }
      if (typeof evaluateGenerationExperience === 'function') {
        renderSpeedExperienceInPlace(evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage));
      }
    };
    updateWaitOnly();
    stopLiveWaitTickTimer();
    state.liveWaitTickTimer = setInterval(updateWaitOnly, 1000);
  }

  function syncSpeedBadgeText() {
    if (typeof evaluateGenerationExperience === 'function') {
      const evalRes = evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage);
      renderSpeedExperienceInPlace(evalRes);
      return;
    }
    const sp = state.latest?.speed;
    const speedAmount = el('speed-amount');
    const overflowSpeedVal = el('overflow-speed-val');
    if (!speedAmount) return;
    const isCompact = state.layoutMode === 'compact';
    if (sp?.tps != null) {
      speedAmount.textContent = isCompact ? `${sp.tps}` : `${sp.tps} tok/s`;
      if (overflowSpeedVal) overflowSpeedVal.textContent = `${sp.tps} tok/s`;
    } else if (state.requestBusy) {
      const calcText = t('badge.speedCalc');
      speedAmount.textContent = isCompact ? '…' : calcText;
      if (overflowSpeedVal) overflowSpeedVal.textContent = calcText;
    } else {
      speedAmount.textContent = isCompact ? '--' : '-- tok/s';
      if (overflowSpeedVal) overflowSpeedVal.textContent = '-- tok/s';
    }
  }

  el('btn-speed-breakdown-toggle')?.addEventListener('click', () => {
    state.speedBreakdownOpen = !state.speedBreakdownOpen;
    if (typeof evaluateGenerationExperience === 'function') {
      renderSpeedExperienceInPlace(evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage));
    }
    positionFloatingPanels();
  });


  function setSpeedRecordsForTestImpl(records, calls = []) {
    ANTIGRAVITY_TOKEN_DATA.speedRecords = Array.isArray(records) ? records : [];
    if (Array.isArray(calls)) state.sessionCalls = calls;
    if (!isContextSettingsView && activeContextTab === 'speed') renderSpeedComparisonTab();
    if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
  }

  function setSpeedEvaluationForTestImpl(mockInput, opts = {}) {
    state.speedOverrideForTest = mockInput || null;
    if (opts.openBreakdown !== undefined) state.speedBreakdownOpen = Boolean(opts.openBreakdown);
    if (typeof evaluateGenerationExperience === 'function') {
      const res = evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage);
      renderSpeedExperienceInPlace(res);
      return res;
    }
    return null;
  }

  function getSpeedPanelStateForTestImpl() {
    return {
      badgeText: el('speed-badge')?.textContent || '',
      badgeColor: el('speed-badge')?.style?.color || '',
      boltColor: el('badge-speed-icon')?.style?.color || '',
      summaryBoltColor: el('speed-summary-bolt')?.style?.color || state.lastSpeedEval?.badge?.color || '',
      chartMode: speedChartMode,
      speedVal: el('speed-val')?.textContent || '',
      durationVal: el('speed-duration')?.textContent || '',
      ttftVal: el('speed-ttft')?.textContent || '',
      tokensVal: el('speed-tokens')?.textContent || '',
      subLabel: el('speed-sub-label')?.textContent || '',
      takeaway: el('speed-takeaway')?.textContent || '',
      breakdownOpen: state.speedBreakdownOpen,
      lastEval: state.lastSpeedEval
    };
  }
  // =========================================================================
  // 累计 Token 用量、模型分布、API 等价价值估算与历史水位增量入账 (tokens-view.js)
  // =========================================================================
  // 数据源切换（全部 / 桌面端 / CLI）
  let activeTokenSource = 'all';
  function switchTokenSource(src) {
    activeTokenSource = src;
    try { localStorage?.setItem('ag_token_source_v1', src); } catch { }
    setPillActive(el('src-tab-all'), src === 'all');
    setPillActive(el('src-tab-desktop'), src === 'desktop');
    setPillActive(el('src-tab-cli'), src === 'cli');

    if (ANTIGRAVITY_TOKEN_DATA.rawPayload) {
      applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
    } else {
      const bySrc = ANTIGRAVITY_TOKEN_DATA.dailyMapBySource || {};
      const srcMap = src === 'all'
        ? (bySrc.all || ANTIGRAVITY_TOKEN_DATA.dailyMap || {})
        : (bySrc[src] || {});
      ANTIGRAVITY_TOKEN_DATA.dailyMap = srcMap;
      const mBySrc = ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource || {};
      ANTIGRAVITY_TOKEN_DATA.dailyModelMap = src === 'all'
        ? (mBySrc.all || ANTIGRAVITY_TOKEN_DATA.dailyModelMap || {})
        : (mBySrc[src] || {});
      renderActiveHeatView(true);
      renderActiveCostEstimateView();
      renderModelUsageView();
    }
  }
  el('src-tab-all')?.addEventListener('click', () => switchTokenSource('all'));
  el('src-tab-desktop')?.addEventListener('click', () => switchTokenSource('desktop'));
  el('src-tab-cli')?.addEventListener('click', () => switchTokenSource('cli'));

  // 视图切换（Token 统计 / 按模型 / API 参考金额）
  let activeTokenView = 'tokens';
  const initCostDetailsPane = el('cost-details-pane');
  if (initCostDetailsPane) initCostDetailsPane.style.display = 'block';
  positionFloatingPanels();

  el('h-sum-sub-ratio-wrap')?.addEventListener('click', () => {
    switchTokenView('cost');
    el('input-monthly-spend-usd')?.focus?.();
  });
  el('h-sum-sub-ratio-wrap')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault?.();
      switchTokenView('cost');
      el('input-monthly-spend-usd')?.focus?.();
    }
  });

  // 按模型 Token 统计状态与视图渲染
  let modelUsagePeriodDays = 7;
  let modelUsageOffsetDays = 0;
  let modelUsageGroupBy = 'model';
  let modelUsageMetric = 'total';
  let modelUsageHideUnattr = false;

  function formatModelDateShort(dateStr) {
    const parts = String(dateStr || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return dateStr || '';
    const [y, m, d] = parts;
    if (currentPanelLanguage === 'en') {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[m - 1] || m} ${d}`;
    }
    return `${m}/${String(d).padStart(2, '0')}`;
  }

  function formatModelRangeLabel(startStr, endStr) {
    const sp = String(startStr || '').split('-').map(Number);
    const ep = String(endStr || '').split('-').map(Number);
    if (sp.length !== 3 || ep.length !== 3) return `${startStr} – ${endStr}`;
    if (currentPanelLanguage === 'en') {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      if (sp[0] === ep[0] && sp[1] === ep[1]) {
        return `${months[sp[1] - 1]} ${sp[2]} – ${ep[2]}, ${ep[0]}`;
      }
      if (sp[0] === ep[0]) {
        return `${months[sp[1] - 1]} ${sp[2]} – ${months[ep[1] - 1]} ${ep[2]}, ${ep[0]}`;
      }
      return `${months[sp[1] - 1]} ${sp[2]}, ${sp[0]} – ${months[ep[1] - 1]} ${ep[2]}, ${ep[0]}`;
    }
    return sp[0] === ep[0]
      ? `${startStr} – ${String(ep[1]).padStart(2, '0')}-${String(ep[2]).padStart(2, '0')}`
      : `${startStr} – ${endStr}`;
  }

  function renderModelUsageView() {
    const viewEl = el('model-usage-view');
    if (!viewEl) return;

    setPillActive(el('model-period-7d'), modelUsagePeriodDays === 7);
    setPillActive(el('model-period-30d'), modelUsagePeriodDays === 30);
    setPillActive(el('model-group-model'), modelUsageGroupBy === 'model');
    setPillActive(el('model-group-variant'), modelUsageGroupBy === 'variant');
    setPillActive(el('model-metric-total'), modelUsageMetric === 'total');
    setPillActive(el('model-metric-nocache'), modelUsageMetric === 'noCache');

    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    if (!core || typeof core.summarizeModelUsageWindow !== 'function') return;

    const todayStr = formatLocalYmd(new Date());
    const todayDate = new Date(todayStr + 'T00:00:00');
    const endDt = new Date(todayDate.getTime() - modelUsageOffsetDays * 86400000);
    const endDate = formatLocalYmd(endDt);

    const bySrcModel = ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource || {};
    const hasBySrcModel = bySrcModel && typeof bySrcModel === 'object' && Object.keys(bySrcModel).length > 0;
    const dailyModelMap = hasBySrcModel
      ? (activeTokenSource === 'all' ? (bySrcModel.all || {}) : (bySrcModel[activeTokenSource] || {}))
      : (activeTokenSource === 'all' ? (ANTIGRAVITY_TOKEN_DATA.dailyModelMap || {}) : {});

    const isLightTone = host.getAttribute?.('data-theme') === 'light' || host.getAttribute?.('data-panel-tone') === 'light';
    const themeAccent = (typeof getActiveAccentColor === 'function' && heatPreset !== 'violet')
      ? getActiveAccentColor()
      : '';
    const summary = core.summarizeModelUsageWindow(dailyModelMap, {
      periodDays: modelUsagePeriodDays,
      endDate,
      groupBy: modelUsageGroupBy,
      metric: modelUsageMetric,
      hideUnattributed: modelUsageHideUnattr,
      theme: isLightTone ? 'light' : 'dark',
      accentColor: themeAccent || undefined,
      modelMetaByKey: ANTIGRAVITY_TOKEN_DATA.modelMetaByKey,
      unattributedLabel: t('modelsUsage.unattributed')
    });

    const rangeLbl = el('model-usage-range-label');
    if (rangeLbl) rangeLbl.textContent = formatModelRangeLabel(summary.startDate, summary.endDate);
    const winTotEl = el('model-usage-window-total');
    if (winTotEl) winTotEl.textContent = `${formatCompactTokenCount(summary.windowTotalTokens)} Tokens`;

    const unattrBtn = el('model-toggle-unattr');
    if (unattrBtn) {
      const showBtn = summary.hasUnattributed || modelUsageHideUnattr;
      unattrBtn.style.display = showBtn ? 'inline-flex' : 'none';
      setPillActive(unattrBtn, modelUsageHideUnattr);
      unattrBtn.textContent = modelUsageHideUnattr ? t('modelsUsage.showUnattr') : t('modelsUsage.hideUnattr');
    }

    const firstUse = ANTIGRAVITY_TOKEN_DATA.firstUseDate || ANTIGRAVITY_TOKEN_DATA.summary?.firstUseDate || null;
    const allModelDates = Object.keys(dailyModelMap || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    const earliestKnown = allModelDates[0] && (!firstUse || allModelDates[0] < firstUse) ? allModelDates[0] : firstUse;
    const prevBtn = el('btn-model-win-prev');
    const nextBtn = el('btn-model-win-next');
    if (prevBtn) prevBtn.disabled = Boolean(earliestKnown && summary.startDate <= earliestKnown);
    if (nextBtn) nextBtn.disabled = modelUsageOffsetDays <= 0;

    const maxLblEl = el('model-chart-max-lbl');
    if (maxLblEl) {
      maxLblEl.textContent = summary.maxDayTotal > 0 ? formatCompactTokenCount(summary.maxDayTotal) : '';
    }

    const barsEl = el('model-usage-bars');
    const xaxisEl = el('model-usage-xaxis');
    const legendEl = el('model-usage-legend');
    const emptyEl = el('model-usage-empty');
    const chartWrap = el('model-usage-chart-wrap');

    const hasAnyData = summary.windowTotalTokens > 0;
    if (emptyEl) emptyEl.style.display = hasAnyData ? 'none' : 'block';
    if (chartWrap) chartWrap.style.display = hasAnyData ? 'block' : 'none';

    const isCompact30 = modelUsagePeriodDays === 30;
    if (barsEl) {
      if (isCompact30) barsEl.classList?.add('compact-30');
      else barsEl.classList?.remove('compact-30');
      barsEl.replaceChildren();
    }
    if (xaxisEl) {
      if (isCompact30) xaxisEl.classList?.add('compact-30');
      else xaxisEl.classList?.remove('compact-30');
      xaxisEl.replaceChildren();
    }

    const anchorIndices = isCompact30
      ? new Set([0, 7, 14, 21, 29])
      : new Set([0, 1, 2, 3, 4, 5, 6]);
    const chartPxHeight = 140;

    summary.days.forEach((day, idx) => {
      if (barsEl) {
        const col = document.createElement('div');
        col.className = 'model-usage-col';
        if (day.total > 0 && summary.maxDayTotal > 0 && day.segments.length > 0) {
          const totalH = Math.max(4, Math.round((day.total / summary.maxDayTotal) * chartPxHeight));
          const stack = document.createElement('div');
          stack.className = 'model-usage-stack';
          stack.style.height = `${totalH}px`;

          let allocatedH = 0;
          day.segments.forEach((seg, sIdx) => {
            const segEl = document.createElement('div');
            segEl.className = 'model-usage-seg';
            let segH = Math.max(2, Math.round((seg.tokens / day.total) * totalH));
            if (sIdx === day.segments.length - 1) {
              segH = Math.max(2, totalH - allocatedH);
            }
            allocatedH += segH;
            segEl.style.height = `${segH}px`;
            segEl.style.background = seg.color;
            stack.appendChild(segEl);
          });
          col.appendChild(stack);
        } else {
          const emptyBar = document.createElement('div');
          emptyBar.className = 'model-usage-empty-bar';
          col.appendChild(emptyBar);
        }

        const showBarPop = () => {
          const hp = el('heat-pop');
          const hpDate = el('heat-pop-date');
          const hpVal = el('heat-pop-val');
          const hpDet = el('heat-pop-det');
          if (!hp || !hpDate || !hpVal || !hpDet) return;
          hpDate.textContent = day.date + (day.date === todayStr ? t('heat.today') : '');
          hpVal.textContent = day.total > 0 ? `${formatCompactTokenCount(day.total)} Tokens` : '0 Tokens';
          hpDet.replaceChildren();
          if (day.segments.length > 0) {
            hpDet.style.display = 'flex';
            hpDet.style.flexDirection = 'column';
            hpDet.style.gap = '3px';
            day.segments.slice(0, 6).forEach(seg => {
              const row = document.createElement('div');
              row.style.display = 'flex';
              row.style.justifyContent = 'space-between';
              row.style.alignItems = 'center';
              row.style.gap = '10px';
              row.style.fontSize = '10.5px';
              const left = document.createElement('span');
              left.style.display = 'inline-flex';
              left.style.alignItems = 'center';
              left.style.gap = '5px';
              const dot = document.createElement('span');
              dot.style.display = 'inline-block';
              dot.style.width = '6px';
              dot.style.height = '6px';
              dot.style.borderRadius = '999px';
              dot.style.background = seg.color;
              const nm = document.createElement('span');
              nm.textContent = seg.label;
              left.appendChild(dot);
              left.appendChild(nm);
              const right = document.createElement('span');
              right.textContent = `${formatCompactTokenCount(seg.tokens)} (${Math.round(seg.pct * 10) / 10}%)`;
              row.appendChild(left);
              row.appendChild(right);
              hpDet.appendChild(row);
            });
          } else {
            hpDet.style.display = 'none';
          }
          const r = col.getBoundingClientRect();
          hp.style.left = `${r.left + r.width / 2}px`;
          hp.style.top = `${r.top - 6}px`;
          hp.style.opacity = '1';
        };
        col.addEventListener('mouseenter', showBarPop);
        col.addEventListener('mouseleave', hidePopover);
        col.addEventListener('click', showBarPop);
        barsEl.appendChild(col);
      }

      if (xaxisEl) {
        const lbl = document.createElement('div');
        lbl.className = 'model-usage-xlabel';
        lbl.textContent = anchorIndices.has(idx) ? formatModelDateShort(day.date) : '';
        xaxisEl.appendChild(lbl);
      }
    });

    if (legendEl) {
      legendEl.replaceChildren();
      summary.legend.forEach(item => {
        const card = document.createElement('div');
        card.className = 'model-legend-item';
        const bar = document.createElement('div');
        bar.className = 'model-legend-bar';
        bar.style.background = item.color;

        const textWrap = document.createElement('div');
        textWrap.className = 'model-legend-text';

        const nameEl = document.createElement('div');
        nameEl.className = 'model-legend-name';
        nameEl.textContent = item.label;
        nameEl.title = item.label;

        const valRow = document.createElement('div');
        valRow.className = 'model-legend-val-row';

        const pctEl = document.createElement('span');
        pctEl.className = 'model-legend-pct';
        pctEl.textContent = item.pctLabel;

        const metaEl = document.createElement('span');
        metaEl.className = 'model-legend-meta';
        metaEl.textContent = `${formatCompactTokenCount(item.tokens)} · ${t('modelsUsage.stepsSuffix', { n: item.steps })}`;

        valRow.appendChild(pctEl);
        valRow.appendChild(metaEl);
        textWrap.appendChild(nameEl);
        textWrap.appendChild(valRow);
        card.appendChild(bar);
        card.appendChild(textWrap);
        legendEl.appendChild(card);
      });
    }
  }

  function switchTokenView(v) {
    activeTokenView = v;
    if (typeof hidePopover === 'function') hidePopover();

    setPillActive(el('tok-view-tokens'), v === 'tokens');
    setPillActive(el('tok-view-models'), v === 'models');
    setPillActive(el('tok-view-cost'), v === 'cost');
    const costCard = el('cost-estimate-card');
    const modelView = el('model-usage-view');
    const tokensMain = el('tokens-main-view');
    const statCards = el('token-stat-cards');

    if (costCard) {
      costCard.style.display = v === 'cost' ? 'block' : 'none';
      if (v === 'cost') {
        costCard.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
        const roiCard = el('plan-detail-card');
        if (roiCard) roiCard.style.display = 'block';
        renderActiveCostEstimateView();
      }
    }
    if (modelView) {
      modelView.style.display = v === 'models' ? 'block' : 'none';
      if (v === 'models') {
        modelView.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
        renderModelUsageView();
      }
    }
    if (tokensMain) {
      tokensMain.style.display = v === 'tokens' ? 'block' : 'none';
      if (v === 'tokens') tokensMain.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
    }
    if (statCards) statCards.style.display = v === 'tokens' ? 'grid' : 'none';
    positionFloatingPanels();
  }
  el('tok-view-tokens')?.addEventListener('click', () => switchTokenView('tokens'));
  el('tok-view-models')?.addEventListener('click', () => switchTokenView('models'));
  el('tok-view-cost')?.addEventListener('click', () => switchTokenView('cost'));
  el('model-period-7d')?.addEventListener('click', () => {
    modelUsagePeriodDays = 7;
    modelUsageOffsetDays = 0;
    renderModelUsageView();
  });
  el('model-period-30d')?.addEventListener('click', () => {
    modelUsagePeriodDays = 30;
    modelUsageOffsetDays = 0;
    renderModelUsageView();
  });
  el('model-group-model')?.addEventListener('click', () => {
    modelUsageGroupBy = 'model';
    renderModelUsageView();
  });
  el('model-group-variant')?.addEventListener('click', () => {
    modelUsageGroupBy = 'variant';
    renderModelUsageView();
  });
  el('model-metric-total')?.addEventListener('click', () => {
    modelUsageMetric = 'total';
    renderModelUsageView();
  });
  el('model-metric-nocache')?.addEventListener('click', () => {
    modelUsageMetric = 'noCache';
    renderModelUsageView();
  });
  el('model-toggle-unattr')?.addEventListener('click', () => {
    modelUsageHideUnattr = !modelUsageHideUnattr;
    renderModelUsageView();
  });
  el('btn-model-win-prev')?.addEventListener('click', () => {
    modelUsageOffsetDays += modelUsagePeriodDays;
    renderModelUsageView();
  });
  el('btn-model-win-next')?.addEventListener('click', () => {
    modelUsageOffsetDays = Math.max(0, modelUsageOffsetDays - modelUsagePeriodDays);
    renderModelUsageView();
  });

  // 费用估算范围（默认本期：自然月）与估值模式（默认参考模型折算，首屏展示真实用量价值）
  let activeCostScope = 'period'; // 'period' | 'all'
  let costModelMode = 'ref'; // 'ref' | 'hybrid' | 'identified'

  function switchCostScope(scope) {
    activeCostScope = scope;
    setPillActive(el('cost-btn-scope-period'), scope === 'period');
    setPillActive(el('cost-btn-scope-all'), scope === 'all');
    renderActiveCostEstimateView();
  }
  el('cost-btn-scope-period')?.addEventListener('click', () => switchCostScope('period'));
  el('cost-btn-scope-all')?.addEventListener('click', () => switchCostScope('all'));

  function switchCostModelMode(mode) {
    costModelMode = mode;
    setPillActive(el('cost-btn-mode-ref'), mode === 'ref');
    setPillActive(el('cost-btn-mode-hybrid'), mode === 'hybrid');
    setPillActive(el('cost-btn-mode-identified'), mode === 'identified');
    renderActiveCostEstimateView();
  }
  el('cost-btn-mode-ref')?.addEventListener('click', () => switchCostModelMode('ref'));
  el('cost-btn-mode-hybrid')?.addEventListener('click', () => switchCostModelMode('hybrid'));
  el('cost-btn-mode-identified')?.addEventListener('click', () => switchCostModelMode('identified'));

  function renderActiveCostEstimateView() {
    const isPeriod = activeCostScope === 'period';
    const titleEl = el('cost-card-title');
    const periodTag = el('cost-period-tag');
    const grandVal = el('cost-grand-val');
    const grandSub = el('cost-grand-sub');
    const covPill = el('cost-coverage-pill');
    const subSpendVal = el('cost-sub-spend-val');
    const subSpendLbl = el('cost-sub-spend-lbl');
    const subNote = el('cost-sub-compare-note');
    const usageSummary = el('cost-usage-summary');
    const diffSummary = el('cost-diff-summary');
    const breakdown = el('cost-breakdown-info');
    const roiCard = el('plan-detail-card');
    if (roiCard) roiCard.style.display = 'block';

    // 分类卡片 DOM
    const inVal = el('ref-cost-input-val');
    const inTok = el('ref-cost-input-tok');
    const caVal = el('ref-cost-cache-val');
    const caTok = el('ref-cost-cache-tok');
    const outVal = el('ref-cost-output-val');
    const outTok = el('ref-cost-output-tok');

    if (titleEl) titleEl.textContent = isPeriod ? t('cost.title') : t('cost.titleAll');
    if (periodTag) {
      const pKey = ANTIGRAVITY_TOKEN_DATA.currentPeriod?.label || t('cost.periodTag');
      periodTag.textContent = isPeriod ? pKey : t('cost.allHistory');
    }

    // 1. 提取当前范围真实用量与折算数据
    const curIn = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthInput || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalInputTokens || 0);
    const curCa = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthCache || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalCacheTokens || 0);
    const curOut = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthOutput || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalOutputTokens || 0);
    const curTotal = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.monthTokens || (curIn + curCa + curOut))
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens || (curIn + curCa + curOut));

    const refAll = ANTIGRAVITY_TOKEN_DATA.referenceCost?.all || {};
    const refMonth = ANTIGRAVITY_TOKEN_DATA.referenceCost?.currentMonth || {};
    const refHybridAll = ANTIGRAVITY_TOKEN_DATA.referenceCost?.hybrid || {};
    const refHybridMonth = ANTIGRAVITY_TOKEN_DATA.referenceCost?.currentMonthHybrid || refHybridAll;

    const curRef = isPeriod ? refMonth : refAll;
    const curHybrid = isPeriod ? refHybridMonth : refHybridAll;

    const emptyCostEst = { pricedCostUSD: 0, pricedRequestsCount: 0, unpricedRequestsCount: 0, coveragePercent: null, byModel: {}, byCategory: { inputTokens: 0, cacheTokens: 0, outputTokens: 0, thinkingTokens: 0 } };
    const ceSourceMap = ANTIGRAVITY_TOKEN_DATA.costEstimateBySource || {};
    const ceAll = activeTokenSource === 'all'
      ? (ceSourceMap.all || ANTIGRAVITY_TOKEN_DATA.costEstimate || emptyCostEst)
      : (ceSourceMap[activeTokenSource] || emptyCostEst);
    const ceMonthSourceMap = ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonthBySource || {};
    const cePeriod = activeTokenSource === 'all'
      ? (ceMonthSourceMap.all || ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth || ceAll)
      : (ceMonthSourceMap[activeTokenSource] || emptyCostEst);
    const curIdentified = isPeriod ? cePeriod : ceAll;

    let apiCost = 0;
    let pillText = t('cost.covFull');
    let pillClass = 'key-pill pill-good';

    // 2. 估值模式计算
    let effectiveRef = curRef;
    if ((effectiveRef.totalCostUSD === undefined || effectiveRef.totalCostUSD === null) && curTotal > 0) {
      const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
      if (core && core.calculateReferenceModelCost) {
        effectiveRef = core.calculateReferenceModelCost({
          inputTokens: curIn,
          outputTokens: curOut,
          cacheTokens: curCa,
          totalTokens: curTotal
        }, 'gemini-3.8-flash', { pricingDate: '2026-11-09', mode: 'all' });
      }
    }

    const rateIn = Number(effectiveRef.matchedTier?.inputPerMillion ?? 0.75);
    const rateCa = Number(effectiveRef.matchedTier?.cacheReadPerMillion ?? 0.075);
    const rateOut = Number(effectiveRef.matchedTier?.outputPerMillion ?? 3.75);

    // 更新小摘要来源与时间描述行及非实付常驻标识
    const scopeDescEl = el('cost-scope-desc');
    if (scopeDescEl) {
      const srcName = activeTokenSource === 'desktop' ? t('tokens.srcDesktopLabel') : activeTokenSource === 'cli' ? 'CLI' : t('tokens.srcAllLabel');
      const pLabel = isPeriod ? (ANTIGRAVITY_TOKEN_DATA.currentPeriod?.label || t('cost.periodTag')) : t('cost.allHistory');
      scopeDescEl.textContent = `${srcName} · ${pLabel}`;
    }
    const nonPaidBadge = el('cost-non-paid-badge');
    if (nonPaidBadge) nonPaidBadge.textContent = t('cost.nonPaidBadge');

    if (costModelMode === 'ref') {
      apiCost = Number(effectiveRef.totalCostUSD || 0);
      if (grandVal) {
        if (apiCost > 0) {
          grandVal.textContent = t('cost.approx', { val: apiCost.toFixed(2) });
          grandVal.title = `$${apiCost.toFixed(4)}`;
        } else if (curTotal > 0 && curIn === 0 && curCa === 0 && curOut === 0) {
          grandVal.textContent = t('cost.notReady');
          grandVal.title = t('cost.notReady');
        } else {
          grandVal.textContent = '$0.00';
          grandVal.title = t('cost.noRecords');
        }
      }
      if (grandSub) {
        grandSub.textContent = t('cost.refSub', {
          model: effectiveRef.modelDisplayName || 'Gemini 3.8 Flash',
          in: rateIn.toFixed(2),
          ca: rateCa.toFixed(3),
          out: rateOut.toFixed(2)
        });
      }
      pillText = t('cost.modeRef');
      pillClass = 'key-pill pill-muted';

      if (inVal) inVal.textContent = `$${Number(effectiveRef.inputCostUSD || (curIn * rateIn / 1e6)).toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIn)} tok`;
      if (caVal) caVal.textContent = `$${Number(effectiveRef.cacheCostUSD || (curCa * rateCa / 1e6)).toFixed(2)}`;
      if (caTok) caTok.textContent = t('cost.tokCacheDiscount', { tok: fmtYi(curCa) });
      if (outVal) outVal.textContent = `$${Number(effectiveRef.outputCostUSD || (curOut * rateOut / 1e6)).toFixed(2)}`;
      if (outTok) outTok.textContent = `${fmtYi(curOut)} tok`;
    } else if (costModelMode === 'hybrid') {
      const h = curHybrid.hybrid || {};
      apiCost = Number(h.combinedTotalUSD || effectiveRef.totalCostUSD || 0);
      if (grandVal) {
        grandVal.textContent = t('cost.approx', { val: apiCost.toFixed(2) });
        grandVal.title = t('cost.hybridSub', { known: h.knownCostUSD || 0, res: h.unpricedResidualCostUSD || 0 });
      }
      if (grandSub) {
        grandSub.textContent = t('cost.hybridSub', {
          known: Number(h.knownCostUSD || 0).toFixed(2),
          res: Number(h.unpricedResidualCostUSD || 0).toFixed(2)
        });
      }
      pillText = t('cost.hybridBadge');
      pillClass = 'key-pill pill-muted';

      const rb = h.residualTokensBreakdown || {};
      if (inVal) inVal.textContent = `$${Number(rb.inputCostUSD || (Number(rb.input || 0) * rateIn / 1e6)).toFixed(2)}`;
      if (inTok) inTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.input || 0) });
      if (caVal) caVal.textContent = `$${Number(rb.cacheCostUSD || (Number(rb.cache || 0) * rateCa / 1e6)).toFixed(2)}`;
      if (caTok) caTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.cache || 0) });
      if (outVal) outVal.textContent = `$${Number(rb.outputCostUSD || (Number(rb.output || 0) * rateOut / 1e6)).toFixed(2)}`;
      if (outTok) outTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.output || 0) });
    } else {
      // 仅已识别真实模型
      const pricedCount = Number(curIdentified.pricedRequestsCount || 0);
      const unpricedCount = Number(curIdentified.unpricedRequestsCount || 0);
      const totalCount = pricedCount + unpricedCount;
      apiCost = Number(curIdentified.pricedCostUSD || 0);

      if (grandVal) {
        if (totalCount === 0) {
          grandVal.textContent = t('cost.noRecords');
        } else if (pricedCount === 0) {
          grandVal.textContent = t('cost.unpriced');
          grandVal.title = t('cost.identSubNone');
        } else if (apiCost < 0.01 && apiCost > 0) {
          grandVal.textContent = '<$0.01';
          grandVal.title = `$${apiCost.toFixed(6)}`;
        } else {
          grandVal.textContent = `$${apiCost.toFixed(2)}`;
          grandVal.title = `$${apiCost.toFixed(4)}`;
        }
      }
      if (grandSub) {
        grandSub.textContent = pricedCount > 0
          ? t('cost.identSub', { n: pricedCount })
          : t('cost.identSubNone');
      }
      if (pricedCount === 0) {
        pillText = t('cost.covPct', { pct: 0 });
        pillClass = 'key-pill pill-warn';
      } else {
        const pct = curIdentified.coveragePercent != null ? curIdentified.coveragePercent : 0;
        pillText = t('cost.covPct', { pct });
        pillClass = `key-pill ${pct >= 100 ? 'pill-good' : 'pill-warn'}`;
      }

      if (inVal) inVal.textContent = `$${((curIdentified.byCategory?.inputTokens || 0) * rateIn / 1e6).toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIdentified.byCategory?.inputTokens || 0)} tok`;
      if (caVal) caVal.textContent = `$${((curIdentified.byCategory?.cacheTokens || 0) * rateCa / 1e6).toFixed(2)}`;
      if (caTok) caTok.textContent = `${fmtYi(curIdentified.byCategory?.cacheTokens || 0)} tok`;
      if (outVal) outVal.textContent = `$${((curIdentified.byCategory?.outputTokens || 0) * rateOut / 1e6).toFixed(2)}`;
      if (outTok) outTok.textContent = `${fmtYi(curIdentified.byCategory?.outputTokens || 0)} tok`;
    }

    if (covPill) {
      covPill.textContent = pillText;
      covPill.className = pillClass;
      covPill.setAttribute?.('class', pillClass);
    }

    // 3. 用户实际支出渲染（首屏并列右栏）
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const curSymbol = ps.currencySymbol || '$';
    if (subSpendLbl) subSpendLbl.textContent = t('cost.subSpendLabel');

    const extraNoCompare = isPeriod ? '' : t('cost.allNoCompare');
    if (subSpendVal && subNote) {
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        subSpendVal.textContent = `${curSymbol}0`;
        subNote.textContent = t('cost.freeActive', { src: ps.acquisitionSourceName || t('cost.freePromo'), extra: extraNoCompare });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        subSpendVal.textContent = `${curSymbol}${Number(ps.actualPricePaid).toFixed(2)}`;
        const expTag = ps.isExpired ? t('cost.expiredTag') : '';
        subNote.textContent = `${ps.acquisitionSourceName || t('cost.subSpend')} · ${t('cost.paidLabel')} (${ps.billingCycle || t('plan.summary.perMonth')})${expTag}${extraNoCompare}`;
      } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
        subSpendVal.textContent = t('cost.paidUnknown');
        subNote.textContent = `${t('cost.publicRefMonthly', { p: ps.officialPriceMonthly })}${extraNoCompare}`;
      } else {
        subSpendVal.textContent = t('cost.unknown');
        subNote.textContent = t('cost.noPlanData');
      }
    }

    const subLine = el('cost-sub-line');
    if (subLine) {
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        subLine.textContent = t('cost.subLineFree', { sym: '$', src: t('plan.tag.manualFree') });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        const paidNum = Number(ps.actualPricePaid);
        const ratioSuffix = (isPeriod && paidNum > 0 && apiCost > 0)
          ? ` · ${(apiCost / paidNum).toFixed(1)}x`
          : '';
        subLine.textContent = t('cost.subLinePaid', {
          sym: '$',
          val: paidNum.toFixed(2),
          cny: ratioSuffix,
          cycle: t('plan.summary.perMonth'),
          exp: ''
        });
      } else {
        subLine.textContent = t('cost.subUnknown');
      }
    }

    // 4. 用量与参考差额指标条（注明累计处理 Token，含缓存读取）
    if (usageSummary) {
      usageSummary.textContent = t('cost.usageSummary', { total: fmtYi(curTotal), cache: fmtYi(curCa) });
    }
    if (diffSummary) {
      let diffTxt = '';
      if (!isPeriod) {
        diffTxt = t('cost.diffAll');
      } else if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        diffTxt = t('cost.diffFree', { val: apiCost.toFixed(2) });
      } else if (ps.actualPricePaid !== null && ps.currency === 'USD') {
        const diff = apiCost - Number(ps.actualPricePaid);
        diffTxt = t('cost.diffPaid', { sign: diff >= 0 ? '+' : '', val: diff.toFixed(2) });
      } else {
        diffTxt = t('cost.diffUnknown');
      }
      diffSummary.textContent = diffTxt;
      diffSummary.hidden = !diffTxt;
    }

    // 5. 详细未计价原因说明
    if (breakdown) {
      const modelKeys = Object.keys(curIdentified.byModel || {});
      const modelDetails = modelKeys.map(k => `${k}: $${curIdentified.byModel[k].costUSD} (${fmt(curIdentified.byModel[k].tokens)} tok)`).join('; ');
      breakdown.textContent = t('cost.breakdownPrefix', {
        details: modelDetails || t('cost.breakdownNone'),
        note: ''
      });
    }
  }

  const heatPop = el('heat-pop');
  const heatPopDate = el('heat-pop-date');
  const heatPopVal = el('heat-pop-val');
  const heatPopDet = el('heat-pop-det');

  function hidePopover() {
    if (heatPop) heatPop.style.opacity = '0';
  }

  function updateHeatTabThumb() {
    const thumb = el('heat-tab-thumb');
    const tabsBar = el('heat-tabs-bar');
    const activeBtn = el(`h-tab-${activeHeatView}`);
    if (!thumb || !tabsBar || !activeBtn) return;

    const offsetLeft = activeBtn.offsetLeft || 0;
    const offsetWidth = activeBtn.offsetWidth || 0;
    thumb.style.transform = `translateX(${offsetLeft}px)`;
    thumb.style.width = `${offsetWidth}px`;

    const thumbColor = (typeof getActiveAccentColor === 'function' ? getActiveAccentColor() : '') || (typeof getEffectiveHeatmapScale === 'function' ? getEffectiveHeatmapScale()[4] : '#a78bfa');
    thumb.style.setProperty('--ag-tab-thumb-bg', thumbColor);
  }

  function renderActiveHeatView(forceRebuild = false) {
    if (activeHeatView === 'weekly') {
      renderHeatmapWeekly();
    } else if (activeHeatView === 'monthly') {
      renderHeatmapMonthly();
    } else if (activeHeatView === 'yearly') {
      renderHeatmapYearly();
    } else if (activeHeatView === 'cum') {
      renderHeatmapCum();
    } else {
      renderHeatmapGrid(forceRebuild);
    }
    computeTimelineWindow();
    updateHeatTabThumb();
  }

  function switchHeatView(view, save = true) {
    if (!['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(view)) view = 'daily';
    activeHeatView = view;

    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    views.forEach(v => {
      const tabBtn = el(`h-tab-${v}`);
      const box = el(`h-${v}-box`);
      const isActive = (v === view);
      if (tabBtn) {
        if (tabBtn.classList) {
          if (isActive) tabBtn.classList.add('active');
          else tabBtn.classList.remove('active');
        } else {
          const cls = (tabBtn.className || '').split(/\s+/).filter(c => c && c !== 'active');
          if (isActive) cls.push('active');
          tabBtn.className = cls.join(' ');
        }
        tabBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tabBtn.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      if (box) {
        if (isActive) {
          box.style.display = (v === 'weekly' || v === 'monthly' || v === 'yearly') ? 'flex' : 'block';
        } else {
          box.style.display = 'none';
        }
      }
    });

    hidePopover();
    renderActiveHeatView(true);
    updateHeatTabThumb();

    if (save && (typeof window?.contextMeterAPI?.saveSettings === 'function' || hasLiveHttpBridge())) {
      void saveSettingsPayloadBridge({ savedHeatView: view });
    }
  }

  ['daily', 'weekly', 'monthly', 'yearly', 'cum'].forEach(v => {
    el(`h-tab-${v}`)?.addEventListener('click', () => switchHeatView(v));
  });

  const tabsBarEl = el('heat-tabs-bar');
  tabsBarEl?.addEventListener('keydown', e => {
    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    const curIdx = views.indexOf(activeHeatView);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = (curIdx + 1) % views.length;
      switchHeatView(views[nextIdx]);
      el(`h-tab-${views[nextIdx]}`)?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIdx = (curIdx - 1 + views.length) % views.length;
      switchHeatView(views[prevIdx]);
      el(`h-tab-${views[prevIdx]}`)?.focus();
    }
  });

  // 初始化默认热力图视图状态与药丸滑块
  switchHeatView('daily', false);

  el('h-page-prev')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      heatMonthOffset -= 1;
    } else if (activeHeatView === 'yearly') {
      heatYearOffset -= 1;
    } else {
      heatPageOffset -= 1;
    }
    renderActiveHeatView(true);
  });
  el('h-page-next')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      if (heatMonthOffset < 0) heatMonthOffset += 1;
    } else if (activeHeatView === 'yearly') {
      if (heatYearOffset < 0) heatYearOffset += 1;
    } else {
      if (heatPageOffset < 0) heatPageOffset += 1;
    }
    renderActiveHeatView(true);
  });

  function setHoverExtra(text) {
    const extra = el('hover-extra');
    if (extra && extra.textContent !== text) {
      extra.textContent = text;
    }
  }

  function fmtYi(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1e9) return `${parseFloat((n / 1e9).toFixed(2))}B`;
    if (n >= 1e6) return `${parseFloat((n / 1e6).toFixed(2))}M`;
    if (n >= 1e3) return `${parseFloat((n / 1e3).toFixed(1))}K`;
    return n.toLocaleString('en-US');
  }

  function getLvl(t) {
    if (!t || t <= 0) return 0;
    if (t < 3e6) return 1;
    if (t < 15e6) return 2;
    if (t < 60e6) return 3;
    return 4;
  }

  function parseLocalYmd(ymd) {
    if (!ymd || typeof ymd !== 'string') return null;
    const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function formatLocalYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatDotYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  }

  function formatZhYmd(ymd) {
    const d = parseLocalYmd(ymd);
    if (!d) return ymd || '—';
    if (currentPanelLanguage === 'en') {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function addDays(baseDate, deltaDays) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    d.setDate(d.getDate() + deltaDays);
    return d;
  }

  function getFirstUseDateStr() {
    const map = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const keys = Object.keys(map).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && (map[k]?.total > 0)).sort();
    const declared = ANTIGRAVITY_TOKEN_DATA.firstUseDate;
    if (declared && /^\d{4}-\d{2}-\d{2}$/.test(declared)) {
      if (keys.length && keys[0] < declared) return keys[0];
      return declared;
    }
    if (keys.length) return keys[0];
    return formatLocalYmd(new Date());
  }

  // 计算从「实际首次使用日」起算的 12 个月（52 周 = 364 天）展示窗口，绝不展示首次使用日之前的日期
  function computeTimelineWindow() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const firstStr = getFirstUseDateStr();
    const firstDate = parseLocalYmd(firstStr) || today;
    const totalDays = 52 * 7; // 364 天（12 个月 / 52 周）
    const elapsedDays = Math.max(0, Math.floor((today.getTime() - firstDate.getTime()) / 86400000)) + 1;

    let winStart;
    let winEnd;
    let canPrev = false;
    let canNext = false;

    if (elapsedDays <= totalDays) {
      // 使用未满一年：起点固定为实际首次使用日，向后铺满 12 个月（前置空白为 0）
      heatPageOffset = 0;
      winStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
      winEnd = addDays(winStart, totalDays - 1);
    } else {
      // 使用满一年后：默认窗口滚动为「以今天结尾的最近 12 个月」，且起点永不早于首次使用日；支持 ‹ / › 翻页回看更早归档
      const latestStart = addDays(today, -(totalDays - 1));
      const stepDays = 26 * 7; // 每次翻页半年度（26 周）
      let candidateStart = addDays(latestStart, heatPageOffset * stepDays);
      if (candidateStart.getTime() <= firstDate.getTime()) {
        candidateStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
        const maxBackSteps = -Math.ceil((latestStart.getTime() - firstDate.getTime()) / (stepDays * 86400000));
        if (heatPageOffset < maxBackSteps) heatPageOffset = maxBackSteps;
      }
      winStart = candidateStart;
      winEnd = addDays(winStart, totalDays - 1);
      canPrev = winStart.getTime() > firstDate.getTime();
      canNext = heatPageOffset < 0;
    }

    const firstBadge = el('first-use-badge');
    const hasAnyActiveDate = Object.values(ANTIGRAVITY_TOKEN_DATA.dailyMap || {}).some(r => (Number(r?.total) || 0) > 0);
    const hasDeclaredFirst = Boolean(ANTIGRAVITY_TOKEN_DATA.firstUseDate && /^\d{4}-\d{2}-\d{2}$/.test(ANTIGRAVITY_TOKEN_DATA.firstUseDate));
    if (firstBadge) {
      firstBadge.textContent = (hasAnyActiveDate || hasDeclaredFirst)
        ? t('tokens.firstUse', { date: formatZhYmd(firstStr) })
        : t('tokens.firstUse', { date: '—' });
    }
    const rangeEl = el('h-win-range');
    const prevBtn = el('h-page-prev');
    const nextBtn = el('h-page-next');

    if (activeHeatView === 'monthly') {
      const targetMonthDate = new Date(today.getFullYear(), today.getMonth() + heatMonthOffset, 1);
      const targetY = targetMonthDate.getFullYear();
      const targetM = targetMonthDate.getMonth();
      const firstY = firstDate.getFullYear();
      const firstM = firstDate.getMonth();
      const targetMonthKey = targetY * 12 + targetM;
      const firstMonthKey = firstY * 12 + firstM;
      canPrev = targetMonthKey > firstMonthKey;
      canNext = heatMonthOffset < 0;
      if (rangeEl) rangeEl.textContent = t('tokens.range.month', { y: targetY, m: currentPanelLanguage === 'en' ? String(targetM + 1).padStart(2, '0') : (targetM + 1) });
    } else if (activeHeatView === 'yearly') {
      const thisY = today.getFullYear();
      const targetY = thisY + heatYearOffset;
      const firstY = firstDate.getFullYear();
      canPrev = targetY > firstY;
      canNext = heatYearOffset < 0;
      if (rangeEl) {
        rangeEl.textContent = (targetY === thisY) ? t('tokens.range.yearToToday', { y: targetY }) : t('tokens.range.year', { y: targetY });
      }
    } else {
      if (rangeEl) rangeEl.textContent = `${formatDotYmd(winStart)} – ${formatDotYmd(winEnd)}`;
    }

    if (prevBtn) prevBtn.disabled = !canPrev;
    if (nextBtn) nextBtn.disabled = !canNext;

    return { firstStr, firstDate, today, winStart, winEnd, totalDays, canPrev, canNext };
  }

  function applyTokenHistoryPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const incomingScope = payload.accountScopeKey || (payload.planStatus?.email ? String(payload.planStatus.email).trim().toLowerCase() : null);
    if (payload.isAccountSwitched || (incomingScope && typeof handleQuotaAccountSwitch === 'function' && handleQuotaAccountSwitch(incomingScope))) {
      if (typeof handleQuotaAccountSwitch === 'function') handleQuotaAccountSwitch(incomingScope || null, { forceRefresh: true });
    }
    if (payload.loading) {
      if (Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0) return false;
    }

    if (payload.isAccountSwitched) {
      ANTIGRAVITY_TOKEN_DATA.recentModelUsage = [];
      ANTIGRAVITY_TOKEN_DATA.quotaUsageCoverageStartMs = null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'quotaUsageCoverageStartMs')) {
      ANTIGRAVITY_TOKEN_DATA.quotaUsageCoverageStartMs = payload.quotaUsageCoverageStartMs ?? null;
    }
    if (Array.isArray(payload.recentModelUsage)) {
      ANTIGRAVITY_TOKEN_DATA.recentModelUsage = payload.recentModelUsage;
      if (typeof refreshQuotaTokenEstimates === 'function') {
        refreshQuotaTokenEstimates();
      }
    }
    if (Array.isArray(payload.speedRecords)) {
      ANTIGRAVITY_TOKEN_DATA.speedRecords = payload.speedRecords;
      if (!isContextSettingsView && activeContextTab === 'speed') {
        renderSpeedComparisonTab();
      } else if (!isContextSettingsView && activeContextTab === 'models') {
        renderModelSettingsTab();
      }
    }
    if (payload.modelCapabilitiesById && typeof payload.modelCapabilitiesById === 'object') {
      mergeCapabilitiesMapClient(payload.modelCapabilitiesById);
    }
    if (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0) {
      const hasExisting = Array.isArray(state.cascadeModelConfigs) && state.cascadeModelConfigs.length > 0;
      const incomingHasCaps = payload.cascadeModelConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      const existingHasCaps = hasExisting && state.cascadeModelConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      if (!hasExisting || (incomingHasCaps && !existingHasCaps)) {
        state.cascadeModelConfigs = payload.cascadeModelConfigs;
        renderHeaderModelDropdown();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
      }
    }

    const hasExistingData = Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0
      || Number(ANTIGRAVITY_TOKEN_DATA.rawPayload?.summary?.grandTotalTokens) > 0;
    const incomingAllMap = activeTokenSource === 'all'
      ? (payload.dailyMapBySource?.all || payload.dailyMap || {})
      : (payload.dailyMapBySource?.[activeTokenSource] || {});
    const incomingKeys = Object.keys(incomingAllMap);
    const incomingTotal = Number(payload.summary?.grandTotalTokens) || incomingKeys.reduce((acc, k) => acc + (Number(incomingAllMap[k]?.total) || 0), 0);
    const hasIncomingBySourceData = Boolean(
      payload.dailyMapBySource &&
      typeof payload.dailyMapBySource === 'object' &&
      Object.values(payload.dailyMapBySource).some(m => m && typeof m === 'object' && Object.keys(m).length > 0)
    );
    const hasIncomingRefCost = Boolean(payload.referenceCost?.currentMonth?.totalCostUSD || payload.referenceCost?.all?.totalCostUSD);
    const hasIncomingPayloadContent = incomingKeys.length > 0 || hasIncomingBySourceData || incomingTotal > 0 || hasIncomingRefCost;
    if (hasExistingData && !hasIncomingPayloadContent && !payload.isAccountSwitched && !payload.forceReset) {
      return false;
    }

    ANTIGRAVITY_TOKEN_DATA.rawPayload = payload;

    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const todayStr = formatLocalYmd(new Date());
    const normalized = core && typeof core.normalizeTokenHistoryPayload === 'function'
      ? core.normalizeTokenHistoryPayload(payload, { source: activeTokenSource, todayStr })
      : null;

    if (normalized) {
      ANTIGRAVITY_TOKEN_DATA.dailyMap = normalized.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = normalized.dailyMapBySource;
      ANTIGRAVITY_TOKEN_DATA.dailyModelMap = normalized.dailyModelMap || {};
      ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource = normalized.dailyModelMapBySource || payload.dailyModelMapBySource || null;
      ANTIGRAVITY_TOKEN_DATA.modelMetaByKey = normalized.modelMetaByKey || payload.modelMetaByKey || null;
      ANTIGRAVITY_TOKEN_DATA.summary = normalized.summary;
      ANTIGRAVITY_TOKEN_DATA.referenceCost = normalized.referenceCost;
      ANTIGRAVITY_TOKEN_DATA.currentPeriod = normalized.currentPeriod;
      ANTIGRAVITY_TOKEN_DATA.firstUseDate = normalized.firstUseDate ?? null;
      if (normalized.updatedAt) ANTIGRAVITY_TOKEN_DATA.updatedAt = normalized.updatedAt;
    } else {
      const srcDailyMap = activeTokenSource === 'all'
        ? (payload.dailyMapBySource?.all || payload.dailyMap || {})
        : (payload.dailyMapBySource?.[activeTokenSource] || {});
      const newMap = {};
      if (srcDailyMap && typeof srcDailyMap === 'object') {
        for (const [dKey, rec] of Object.entries(srcDailyMap)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dKey) || !rec) continue;
          newMap[dKey] = {
            total: Math.max(0, Number(rec.total) || 0),
            input: Math.max(0, Number(rec.input) || 0),
            output: Math.max(0, Number(rec.output) || 0),
            cache: Math.max(0, Number(rec.cache) || 0),
            steps: Math.max(0, Number(rec.steps) || 0)
          };
        }
      }
      ANTIGRAVITY_TOKEN_DATA.dailyMap = newMap;
      if (payload.dailyMapBySource) ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = payload.dailyMapBySource;
      if (payload.dailyModelMapBySource) {
        ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource = payload.dailyModelMapBySource;
        ANTIGRAVITY_TOKEN_DATA.dailyModelMap = activeTokenSource === 'all'
          ? (payload.dailyModelMapBySource.all || {})
          : (payload.dailyModelMapBySource[activeTokenSource] || {});
      } else if (payload.dailyModelMap) {
        ANTIGRAVITY_TOKEN_DATA.dailyModelMap = activeTokenSource === 'all' ? payload.dailyModelMap : {};
      }
      if (payload.modelMetaByKey) ANTIGRAVITY_TOKEN_DATA.modelMetaByKey = payload.modelMetaByKey;
      if (payload.updatedAt) ANTIGRAVITY_TOKEN_DATA.updatedAt = payload.updatedAt;
      if (payload.currentPeriod) ANTIGRAVITY_TOKEN_DATA.currentPeriod = payload.currentPeriod;
      if (payload.referenceCost) ANTIGRAVITY_TOKEN_DATA.referenceCost = payload.referenceCost;

      const keys = Object.keys(newMap).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && newMap[k]?.total > 0).sort();
      const monthPrefix = todayStr.slice(0, 7);
      const yearPrefix = todayStr.slice(0, 4);
      let totalTokens = 0, todayTokens = 0, monthTokens = 0, yearTokens = 0, monthDays = 0, yearDays = 0;
      let totalInput = 0, totalOutput = 0, totalCache = 0;
      let curMonthInput = 0, curMonthOutput = 0, curMonthCache = 0;
      for (const k of keys) {
        const r = newMap[k];
        const t = Number(r.total) || 0;
        totalTokens += t;
        totalInput += Number(r.input) || 0;
        totalOutput += Number(r.output) || 0;
        totalCache += Number(r.cache) || 0;
        if (k === todayStr) todayTokens += t;
        if (k.startsWith(monthPrefix)) {
          monthTokens += t;
          curMonthInput += Number(r.input) || 0;
          curMonthOutput += Number(r.output) || 0;
          curMonthCache += Number(r.cache) || 0;
          monthDays += 1;
        }
        if (k.startsWith(yearPrefix)) {
          yearTokens += t;
          yearDays += 1;
        }
      }
      const rawSum = payload.summary || {};
      const isAll = activeTokenSource === 'all';
      const fallbackFirstUse = isAll ? (payload.firstUseDate || rawSum.firstUseDate || keys[0] || null) : (keys[0] || null);
      ANTIGRAVITY_TOKEN_DATA.firstUseDate = fallbackFirstUse;
      const srcMeta = !isAll && payload.sources?.[activeTokenSource];
      const convs = isAll
        ? (Number(rawSum.totalConversations) || keys.length)
        : (srcMeta ? Math.max(Number(srcMeta.conversationsCount) || 0, Number(srcMeta.transcriptsCount) || 0) : keys.length);
      ANTIGRAVITY_TOKEN_DATA.summary = {
        grandTotalTokens: isAll ? Math.max(totalTokens, Number(rawSum.grandTotalTokens) || 0) : totalTokens,
        totalTokens: isAll ? Math.max(totalTokens, Number(rawSum.grandTotalTokens) || 0) : totalTokens,
        todayTokens: isAll ? (todayTokens > 0 ? todayTokens : (Number(rawSum.todayTokens) || 0)) : todayTokens,
        monthTokens: isAll ? Math.max(monthTokens, Number(rawSum.monthTokens) || 0) : monthTokens,
        yearTokens: isAll ? Math.max(yearTokens, Number(rawSum.yearTokens) || 0) : yearTokens,
        totalInputTokens: isAll ? Math.max(totalInput, Number(rawSum.totalInputTokens) || 0) : totalInput,
        totalOutputTokens: isAll ? Math.max(totalOutput, Number(rawSum.totalOutputTokens) || 0) : totalOutput,
        totalCacheTokens: isAll ? Math.max(totalCache, Number(rawSum.totalCacheTokens) || 0) : totalCache,
        currentMonthInput: isAll ? Math.max(curMonthInput, Number(rawSum.currentMonthInput) || 0) : curMonthInput,
        currentMonthOutput: isAll ? Math.max(curMonthOutput, Number(rawSum.currentMonthOutput) || 0) : curMonthOutput,
        currentMonthCache: isAll ? Math.max(curMonthCache, Number(rawSum.currentMonthCache) || 0) : curMonthCache,
        totalDays: keys.length,
        activeDaysCount: keys.length,
        monthActiveDays: monthDays,
        yearActiveDays: yearDays,
        totalConversations: convs,
        firstUseDate: fallbackFirstUse
      };
    }

    if (payload.planStatus || payload.customPlanSettings) {
      let mergedPlan = payload.planStatus || ANTIGRAVITY_TOKEN_DATA.planStatus || {};
      try {
        const email = mergedPlan.email || 'default';
        let customObj = lastSavedCustomPlan || payload.customPlanSettings || null;
        if (!customObj && typeof window !== 'undefined' && window.__AGContextMeterSettings?.customPlan) {
          customObj = window.__AGContextMeterSettings.customPlan;
        }
        if (!customObj) {
          const savedCustomRaw = localStorage?.getItem('ag_custom_plan_' + email.toLowerCase()) || localStorage?.getItem('ag_custom_plan_default');
          if (savedCustomRaw) customObj = JSON.parse(savedCustomRaw);
        }
        if (customObj && typeof customObj === 'object') {
          lastSavedCustomPlan = { ...customObj };
          try {
            const jsonStr = JSON.stringify(customObj);
            if (email && email !== 'default') localStorage?.setItem('ag_custom_plan_' + email.toLowerCase(), jsonStr);
            localStorage?.setItem('ag_custom_plan_default', jsonStr);
          } catch { }
          if (core && core.resolveEffectivePlanStatus) {
            mergedPlan = core.resolveEffectivePlanStatus(payload.rawPlanStatus || payload.planStatus, customObj, { currentEmail: email });
          }
        }
      } catch { }
      ANTIGRAVITY_TOKEN_DATA.planStatus = mergedPlan;
      ANTIGRAVITY_TOKEN_DATA.rawPlanStatus = payload.rawPlanStatus || payload.planStatus || mergedPlan;
      renderPlanDetail(mergedPlan);
    }

    if (payload.costEstimate) {
      ANTIGRAVITY_TOKEN_DATA.costEstimate = payload.costEstimate;
    }
    if (payload.costEstimateCurrentMonth) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth = payload.costEstimateCurrentMonth;
    }
    if (payload.costEstimateBySource) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = payload.costEstimateBySource;
    } else if (payload.costEstimate) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = {
        all: payload.costEstimate,
        desktop: payload.costEstimate,
        cli: { pricedCostUSD: 0, pricedRequestsCount: 0, unpricedRequestsCount: 0, coveragePercent: null, byModel: {} }
      };
    }

    if (payload.costEstimateCurrentMonthBySource) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonthBySource = payload.costEstimateCurrentMonthBySource;
    } else if (payload.costEstimateCurrentMonth) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonthBySource = {
        all: payload.costEstimateCurrentMonth,
        desktop: payload.costEstimateCurrentMonth,
        cli: { pricedCostUSD: 0, pricedRequestsCount: 0, unpricedRequestsCount: 0, coveragePercent: null, byModel: {}, byCategory: { inputTokens: 0, cacheTokens: 0, outputTokens: 0, thinkingTokens: 0 } }
      };
    }

    // 重新汇总卡片统计与顶栏
    const sum = ANTIGRAVITY_TOKEN_DATA.summary;
    const totalTokens = sum.grandTotalTokens;
    const shownToday = sum.todayTokens;
    const monthTokens = sum.monthTokens;
    const yearTokens = sum.yearTokens;
    const convCount = sum.totalConversations;
    const activeDayKeys = Object.entries(ANTIGRAVITY_TOKEN_DATA.dailyMap || {})
      .filter(([, rec]) => (Number(rec?.total) || 0) > 0)
      .map(([k]) => k);
    const totalDays = Number.isFinite(sum.activeDaysCount) ? sum.activeDaysCount : activeDayKeys.length;
    const monthActiveDays = Number.isFinite(sum.monthActiveDays)
      ? sum.monthActiveDays
      : activeDayKeys.filter(k => k.startsWith(todayStr.slice(0, 7))).length;
    const yearActiveDays = Number.isFinite(sum.yearActiveDays)
      ? sum.yearActiveDays
      : activeDayKeys.filter(k => k.startsWith(todayStr.slice(0, 4))).length;
    const avgMonth = monthActiveDays > 0 ? Math.round(monthTokens / monthActiveDays) : 0;

    const fmtCardM = v => {
      const n = Number(v) || 0;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(n);
    };
    const badgeAmt = el('token-amount');
    const badgeExtra = el('token-hover-extra');
    const overAmt = el('overflow-tokens-val');
    if (badgeAmt) badgeAmt.textContent = fmtCardM(totalTokens);
    if (badgeExtra) badgeExtra.textContent = t('tokens.badge.today', { val: fmtCardM(shownToday) });
    if (overAmt) overAmt.textContent = fmtCardM(totalTokens);

    const tTotalVal = el('t-total-val');
    const tTotalSub = el('t-total-sub');
    const tTodayVal = el('t-today-val');
    const tTodaySub = el('t-today-sub');
    const tMonthVal = el('t-month-val');
    const tMonthSub = el('t-month-sub');
    const tYearVal = el('t-year-val');
    const tYearSub = el('t-year-sub');

    if (tTotalVal) tTotalVal.textContent = fmtCardM(totalTokens);
    if (tTotalSub) tTotalSub.textContent = `${totalTokens.toLocaleString('en-US')} Tokens`;
    if (tTodayVal) tTodayVal.textContent = fmtCardM(shownToday);
    if (tTodaySub) tTodaySub.textContent = t('tokens.card.todaySub', { n: convCount });
    if (tMonthVal) tMonthVal.textContent = fmtCardM(monthTokens);
    if (tMonthSub) tMonthSub.textContent = t('tokens.card.monthSub', { val: fmtCardM(avgMonth) });
    if (tYearVal) tYearVal.textContent = fmtCardM(yearTokens);
    if (tYearSub) tYearSub.textContent = t('tokens.card.yearSub', { n: yearActiveDays });

    const cs = sum.cacheReadStats || {
      cacheStatus: (sum.totalInputTokens > 0 || sum.totalCacheTokens > 0)
        ? (sum.totalCacheTokens > 0 ? 'hit' : 'zero_cache')
        : (totalTokens > 0 ? 'missing' : 'empty'),
      totalUncachedInput: Number(sum.totalInputTokens) || 0,
      totalCacheRead: Number(sum.totalCacheTokens) || 0,
      totalInput: (Number(sum.totalInputTokens) || 0) + (Number(sum.totalCacheTokens) || 0),
      totalOutput: Number(sum.totalOutputTokens) || 0,
      cacheReadPct: ((Number(sum.totalInputTokens) || 0) + (Number(sum.totalCacheTokens) || 0)) > 0
        ? Number(((Number(sum.totalCacheTokens || 0) / ((Number(sum.totalInputTokens) || 0) + (Number(sum.totalCacheTokens) || 0))) * 100).toFixed(1))
        : null,
      missingCount: 0
    };
    const tcbInp = el('tcb-input-val');
    const tcbCache = el('tcb-cache-val');
    const tcbTotInp = el('tcb-total-input-val');
    const tcbOut = el('tcb-output-val');
    const tcbRatio = el('tcb-ratio-val');
    const tcbNote = el('tcb-note');
    const unknownText = t('tokens.cache.unknown');
    if (tcbInp) tcbInp.textContent = cs.cacheStatus === 'missing' ? unknownText : fmtCardM(cs.totalUncachedInput);
    if (tcbCache) tcbCache.textContent = cs.cacheStatus === 'missing' ? unknownText : fmtCardM(cs.totalCacheRead);
    if (tcbTotInp) tcbTotInp.textContent = cs.cacheStatus === 'missing' ? unknownText : fmtCardM(cs.totalInput);
    if (tcbOut) tcbOut.textContent = fmtCardM(sum.totalOutputTokens ?? cs.totalOutput ?? 0);
    if (tcbRatio) {
      if (cs.cacheStatus === 'empty') tcbRatio.textContent = '—';
      else if (cs.cacheStatus === 'missing') tcbRatio.textContent = unknownText;
      else if (cs.cacheStatus === 'zero_input') tcbRatio.textContent = t('tokens.cache.na');
      else tcbRatio.textContent = cs.cacheReadPct !== null ? `${cs.cacheReadPct}%` : unknownText;
    }
    if (tcbNote) {
      if (cs.cacheStatus === 'empty') {
        tcbNote.hidden = true;
        tcbNote.textContent = '';
      } else if (cs.cacheStatus === 'missing') {
        tcbNote.hidden = false;
        tcbNote.textContent = t('tokens.cache.missingNote');
      } else if (cs.cacheStatus === 'zero_input') {
        tcbNote.hidden = false;
        tcbNote.textContent = t('tokens.cache.zeroInputNote');
      } else if (cs.missingCount > 0) {
        tcbNote.hidden = false;
        tcbNote.textContent = t('tokens.cache.partialNote', { n: cs.missingCount });
      } else {
        tcbNote.hidden = true;
        tcbNote.textContent = '';
      }
    }

    // 聚合全周期各区间预估费用
    const allDateKeys = Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap || {});
    const nowYmd = todayStr;
    const thisMonthPrefix = nowYmd.slice(0, 7);
    const thisYearPrefix = nowYmd.slice(0, 4);

    const todayCostInfo = getDailyModelCost(ANTIGRAVITY_TOKEN_DATA.dailyMap[nowYmd], nowYmd, activeCostModel, { mode: activeCostMode });
    const totalCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, allDateKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });

    const monthKeys = allDateKeys.filter(k => k.startsWith(thisMonthPrefix) && k <= nowYmd);
    const monthCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, monthKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });

    const yearKeys = allDateKeys.filter(k => k.startsWith(thisYearPrefix) && k <= nowYmd);
    const yearCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, yearKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });

    const tTotalCost = el('t-total-cost');
    const tTodayCost = el('t-today-cost');
    const tMonthCost = el('t-month-cost');
    const tYearCost = el('t-year-cost');

    if (tTotalCost) {
      tTotalCost.textContent = `≈ $${totalCostAgg.totalCostUSD.toFixed(2)}${t('tokens.dailyAvg', { val: totalCostAgg.dailyAverageUSD.toFixed(2) })}`;
    }
    if (tTodayCost) {
      tTodayCost.textContent = `≈ $${todayCostInfo.costUSD.toFixed(2)}`;
    }
    if (tMonthCost) {
      tMonthCost.textContent = `≈ $${monthCostAgg.totalCostUSD.toFixed(2)}${t('tokens.dailyAvg', { val: monthCostAgg.dailyAverageUSD.toFixed(2) })}`;
    }
    if (tYearCost) {
      tYearCost.textContent = `≈ $${yearCostAgg.totalCostUSD.toFixed(2)}${t('tokens.dailyAvg', { val: yearCostAgg.dailyAverageUSD.toFixed(2) })}`;
    }

    // 规范化已完整保留输入/缓存/输出分类，执行费用视图渲染
    renderActiveCostEstimateView();
    renderModelUsageView();

    computeTimelineWindow();
    renderActiveHeatView(true);
    return true;
  }


  async function recordModelCallsRemote(calls) {
    if (!calls || !calls.length) return { ok: false, changed: false };
    try {
      const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.recordCalls === 'function')
        ? () => window.contextMeterAPI.recordCalls(calls)
        : null;
      if (!ipcFn && !hasLiveHttpBridge()) {
        return { ok: false, changed: false };
      }
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute: '/record-calls',
        liveBody: { calls }
      });
      const res = out.result;
      if (res && res.ok === false) {
        console.warn('Context Meter: 记录调用入账失败', res.error);
      }
      return res || { ok: false, changed: false };
    } catch (err) {
      if (err?.httpStatus) {
        console.warn(`Context Meter: 实时通道 record-calls 响应异常 HTTP ${err.httpStatus}`);
        return {
          ok: false,
          changed: false,
          status: err.httpStatus,
          ...(err.responseData?.error ? { error: err.responseData.error } : {}),
          ...(err.responseData?.phase ? { phase: err.responseData.phase } : {}),
          ...(err.responseData?.code ? { code: err.responseData.code } : {})
        };
      }
      console.warn('Context Meter: 调用入账发生异常', err);
      return { ok: false, changed: false, error: err?.message || String(err || '') };
    }
  }

  let lastHistorySync = 0;
  let historySyncBusy = false;
  let historySyncPending = false;
  let historySyncPendingForce = false;
  const AUTOMATIC_HISTORY_SYNC_INTERVAL_MS = 5000;
  let automaticHistorySyncPending = false;
  let lastAutomaticHistorySync = null;
  let startupRestorePromise = null;

  function syncPendingAutomaticHistory() {
    if (!automaticHistorySyncPending || historySyncBusy || state.disposed) return;
    const now = Date.now();
    if (lastAutomaticHistorySync !== null && now - lastAutomaticHistorySync < AUTOMATIC_HISTORY_SYNC_INTERVAL_MS) return;
    lastAutomaticHistorySync = now;
    void syncTokenHistoryFromHost(true);
  }

  async function syncTokenHistoryFromHost(force = false) {
    if (state.disposed) return;
    if (historySyncBusy) {
      historySyncPending = true;
      if (force) historySyncPendingForce = true;
      return;
    }
    const forceFlag = Boolean(force);
    if (forceFlag) automaticHistorySyncPending = false;
    historySyncBusy = true;
    lastHistorySync = Date.now();
    try {
      const fetchHistoryAsync = async () => {
        const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getTokenHistory === 'function')
          ? () => window.contextMeterAPI.getTokenHistory(forceFlag)
          : null;
        if (!ipcFn && !hasLiveHttpBridge()) return null;
        try {
          const out = await callBackendWithPriority({
            ipcCall: ipcFn,
            liveRoute: '/token-history',
            liveBody: { force: forceFlag }
          });
          return out.result || null;
        } catch {
          return null;
        }
      };
      const restoreStep = startupRestorePromise
        ? startupRestorePromise
        : restoreSettingsFromHost();
      const [, res] = await Promise.all([restoreStep, fetchHistoryAsync()]);
      if (state.disposed) return;
      if (typeof window !== 'undefined' && window.__AGContextMeterHistory) {
        if (!ANTIGRAVITY_TOKEN_DATA.updatedAt && !ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) {
          applyTokenHistoryPayload(window.__AGContextMeterHistory);
        }
      }
      if (res?.ok && res.data) {
        if (typeof window !== 'undefined') window.__AGContextMeterHistory = res.data;
        applyTokenHistoryPayload(res.data);
      }
    } catch { }
    finally {
      historySyncBusy = false;
      lastHistorySync = Date.now();
      if (historySyncPending && !state.disposed) {
        const nextForce = historySyncPendingForce;
        historySyncPending = false;
        historySyncPendingForce = false;
        void syncTokenHistoryFromHost(nextForce);
      } else {
        syncPendingAutomaticHistory();
      }
    }
  }

  const MAX_FLUSH_BATCH_CALLS = 500;
  const MAX_FLUSH_BATCH_BYTES = 900 * 1024;
  const MAX_LIVE_RECORD_BODY_BYTES = 1024 * 1024;
  const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function getUtf8ByteLength(str) {
    const s = String(str ?? '');
    if (utf8Encoder) return utf8Encoder.encode(s).length;
    if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') return Buffer.byteLength(s, 'utf8');
    let bytes = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  }

  const getSingleCallBodyBytes = call => 12 + getUtf8ByteLength(JSON.stringify(call));

  const getModelRank = (model, modelKey) => {
    const s = String(model || '').trim();
    if (!s) return 0;
    if (/^model_placeholder_/i.test(s)) return modelKey ? 2 : 1;
    return modelKey ? 3 : 2;
  };

  const getDateRank = call => {
    if (!call) return 0;
    const hasDate = Boolean(call.date && /^\d{4}-\d{2}-\d{2}/.test(String(call.date)));
    const isProv = call.dateIsProvisional === true || call.dateSource === 'provisional';
    if (isProv) return hasDate ? 1 : 0;
    let hasValidCreatedAt = false;
    if (call.created_at) {
      const dt = new Date(call.created_at);
      hasValidCreatedAt = !Number.isNaN(dt.getTime());
    }
    if (call.dateSource === 'transcript' && (hasDate || hasValidCreatedAt)) return 4;
    if (hasValidCreatedAt) return 3;
    if (hasDate) return 2;
    return 0;
  };

  const resolveWatermarkDate = call => {
    if (!call) return '';
    const isProv = call.dateIsProvisional === true || call.dateSource === 'provisional';
    if (!isProv && call.created_at) {
      const dt = new Date(call.created_at);
      if (!Number.isNaN(dt.getTime())) return formatLocalYmd(dt);
    }
    return (call.date && /^\d{4}-\d{2}-\d{2}/.test(String(call.date))) ? String(call.date).slice(0, 10) : '';
  };

  function rawRevIsPresent(val) {
    return val !== null && val !== '';
  }

  const extractSourceRevision = row => {
    if (!row || typeof row !== 'object') return null;
    const raw = row.sourceRevision ?? row.revision ?? row.metadataRevision;
    if (raw !== undefined && rawRevIsPresent(raw)) {
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
    }
    const rawUpdated = row.updated_at ?? row.sourceUpdatedAt;
    if (rawUpdated !== undefined && rawRevIsPresent(rawUpdated)) {
      const ts = typeof rawUpdated === 'number' ? rawUpdated : Date.parse(String(rawUpdated));
      if (Number.isFinite(ts)) return ts;
    }
    return null;
  };

  const compareSourceRevision = (incRev, baseRev) => {
    const a = typeof incRev === 'number' && Number.isFinite(incRev) ? incRev : null;
    const b = typeof baseRev === 'number' && Number.isFinite(baseRev) ? baseRev : null;
    if (a === null && b === null) return 0;
    if (a !== null && b === null) return 1;
    if (a === null && b !== null) return -1;
    if (a === b) return 0;
    return a > b ? 1 : -1;
  };

  const compareWatermarkUsage = (a, b) => {
    const totDiff = (a?.tot || 0) - (b?.tot || 0);
    if (totDiff !== 0) return totDiff;
    return (a?.out || 0) - (b?.out || 0);
  };

  const canAdoptNextDate = (nextWm, prevWm) => {
    if (!prevWm) return Boolean(nextWm?.date);
    const nextDateRank = nextWm?.dateRank || 0;
    const prevDateRank = prevWm?.dateRank || 0;
    if (nextDateRank > prevDateRank) return Boolean(nextWm?.date);
    if (nextDateRank < prevDateRank) return false;
    if (!nextWm?.date) return false;
    if (!prevWm?.date) return true;
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    if (nextDateRank >= 2) {
      if (revCmp > 0 && usageCmp >= 0) return true;
      if (usageCmp > 0 && revCmp >= 0) return true;
      return nextWm.date === prevWm.date && (nextWm.createdAt || '') === (prevWm.createdAt || '') && revCmp >= 0 && usageCmp >= 0;
    }
    return nextWm.date < prevWm.date;
  };

  const getFinalCallWatermark = call => ({
    inp: call?.inputTokens || 0,
    cap: call?.cacheTokens || 0,
    tot: (call?.inputTokens || 0) + (call?.cacheTokens || 0) + (call?.outputTokens || 0),
    out: call?.outputTokens || 0,
    model: String(call?.model || '').trim(),
    modelKey: String(call?.modelKey || '').trim(),
    isPriced: Boolean(call?.isPriced),
    costUSD: Number(call?.costUSD || 0),
    date: resolveWatermarkDate(call),
    createdAt: call?.created_at ? String(call.created_at) : '',
    dateSource: call?.dateSource ? String(call.dateSource) : '',
    dateRank: getDateRank(call),
    sourceRevision: extractSourceRevision(call)
  });

  function hasWatermarkProgressed(nextWm, prevWm) {
    if (!prevWm) return true;
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    if (usageCmp > 0) return true;
    if (getModelRank(nextWm.model, nextWm.modelKey) > getModelRank(prevWm.model, prevWm.modelKey)) return true;
    if (!prevWm.modelKey && Boolean(nextWm.modelKey)) return true;
    if (!prevWm.isPriced && Boolean(nextWm.isPriced)) return true;
    const nextDateRank = nextWm.dateRank || 0;
    const prevDateRank = prevWm.dateRank || 0;
    if (nextDateRank > prevDateRank) return true;
    const usageRegressed = usageCmp < 0;
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    if (!usageRegressed && revCmp > 0) return true;
    const takeNextDate = canAdoptNextDate(nextWm, prevWm);
    if (
      takeNextDate &&
      nextDateRank >= 2 &&
      nextDateRank === prevDateRank &&
      Boolean(nextWm.date) &&
      (
        nextWm.date !== prevWm.date ||
        (nextDateRank >= 3 && Boolean(nextWm.createdAt) && nextWm.createdAt !== (prevWm.createdAt || ''))
      )
    ) {
      return true;
    }
    const hasUnacceptedDate = Boolean(prevWm.date) && Boolean(nextWm.date) && nextWm.date !== prevWm.date && !takeNextDate;
    if (!usageRegressed && revCmp >= 0 && !hasUnacceptedDate && nextWm.isPriced && !(prevWm.costUSD > 0) && nextWm.costUSD > 0) return true;
    return false;
  }

  function mergeWatermarks(prevWm, nextWm) {
    if (!prevWm) return { ...nextWm };
    const nextRank = getModelRank(nextWm.model, nextWm.modelKey);
    const prevRank = getModelRank(prevWm.model, prevWm.modelKey);
    const nextDateRank = nextWm.dateRank || 0;
    const prevDateRank = prevWm.dateRank || 0;
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    const usageRegressed = usageCmp < 0;
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    const takeNextUsage = usageCmp > 0 || (usageCmp === 0 && revCmp >= 0);
    const takeNextDate = canAdoptNextDate(nextWm, prevWm);
    const mergedSourceRevision = revCmp >= 0
      ? (nextWm.sourceRevision ?? prevWm.sourceRevision ?? null)
      : (prevWm.sourceRevision ?? null);
    let mergedCost = Math.max(prevWm.isPriced ? (prevWm.costUSD || 0) : 0, nextWm.isPriced ? (nextWm.costUSD || 0) : 0);
    if (!usageRegressed && revCmp >= 0 && nextWm.isPriced && (takeNextDate || nextWm.date === prevWm.date || !prevWm.date)) {
      mergedCost = nextWm.costUSD || 0;
    }
    return {
      inp: takeNextUsage ? (nextWm.inp ?? 0) : (prevWm.inp ?? 0),
      cap: takeNextUsage ? (nextWm.cap ?? 0) : (prevWm.cap ?? 0),
      tot: takeNextUsage ? nextWm.tot : prevWm.tot,
      out: takeNextUsage ? nextWm.out : prevWm.out,
      model: nextRank >= prevRank && nextWm.model ? nextWm.model : prevWm.model,
      modelKey: nextWm.modelKey || prevWm.modelKey || '',
      isPriced: Boolean(prevWm.isPriced || nextWm.isPriced),
      costUSD: mergedCost,
      date: takeNextDate ? nextWm.date : (prevWm.date || nextWm.date || ''),
      createdAt: takeNextDate ? (nextWm.createdAt || '') : (prevWm.createdAt || ''),
      dateSource: takeNextDate ? (nextWm.dateSource || '') : (prevWm.dateSource || ''),
      dateRank: Math.max(prevDateRank, nextDateRank),
      sourceRevision: mergedSourceRevision
    };
  }

  function mergePendingCallData(prevCall, nextCall) {
    if (!prevCall) return nextCall;
    const prevWm = getFinalCallWatermark(prevCall);
    const nextWm = getFinalCallWatermark(nextCall);
    const merged = { ...nextCall };
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    const takePrevUsage = usageCmp < 0 || (usageCmp === 0 && revCmp < 0);
    if (takePrevUsage) {
      merged.inputTokens = prevCall.inputTokens;
      merged.cacheTokens = prevCall.cacheTokens;
      merged.cacheReadTokens = prevCall.cacheReadTokens;
      merged.outputTokens = prevCall.outputTokens;
      merged.thinkingTokens = prevCall.thinkingTokens;
      merged.responseTokens = prevCall.responseTokens;
      merged.totalTokens = prevCall.totalTokens;
    }
    const takeNextDate = canAdoptNextDate(nextWm, prevWm);
    const takePrevDate = !takeNextDate && Boolean(prevWm.date || (prevWm.dateRank || 0) > (nextWm.dateRank || 0));
    if (takePrevDate) {
      merged.date = prevCall.date;
      merged.created_at = prevCall.created_at;
      if (prevCall.dateSource !== undefined) merged.dateSource = prevCall.dateSource;
      else delete merged.dateSource;
      merged.dateIsProvisional = prevCall.dateIsProvisional;
      if (prevCall.timestamp !== undefined) merged.timestamp = prevCall.timestamp;
    }
    if (revCmp < 0 && prevWm.sourceRevision !== null) {
      merged.sourceRevision = prevWm.sourceRevision;
    } else if (nextWm.sourceRevision !== null) {
      merged.sourceRevision = nextWm.sourceRevision;
    } else {
      delete merged.sourceRevision;
    }
    if (getModelRank(prevWm.model, prevWm.modelKey) > getModelRank(nextWm.model, nextWm.modelKey)) {
      merged.model = prevCall.model;
    }
    if (!nextWm.modelKey && prevWm.modelKey) {
      merged.modelKey = prevCall.modelKey;
    }
    if (typeof calculateRequestApiCost === 'function' && (merged.model || merged.modelKey)) {
      const recalc = calculateRequestApiCost(merged);
      if (recalc.isPriced) {
        merged.modelKey = recalc.modelKey;
        merged.isPriced = true;
        merged.costUSD = recalc.costUSD ?? 0;
      }
    } else if (!nextWm.isPriced && prevWm.isPriced) {
      merged.isPriced = prevCall.isPriced;
      merged.costUSD = prevCall.costUSD;
    } else if (nextWm.isPriced && prevWm.isPriced && (takePrevUsage || takePrevDate) && (prevWm.costUSD || 0) > (nextWm.costUSD || 0)) {
      merged.costUSD = prevCall.costUSD;
    }
    return merged;
  }

  function takeNextPendingBatch(pendingMap) {
    const chunk = [];
    const snap = [];
    let totalBytes = 12; // '{"calls":[]}'
    for (const call of pendingMap.values()) {
      if (chunk.length >= MAX_FLUSH_BATCH_CALLS) break;
      const itemBytes = getUtf8ByteLength(JSON.stringify(call));
      if (12 + itemBytes > MAX_FLUSH_BATCH_BYTES) continue;
      const addedBytes = (chunk.length > 0 ? 1 : 0) + itemBytes;
      if (chunk.length > 0 && totalBytes + addedBytes > MAX_FLUSH_BATCH_BYTES) break;
      chunk.push(call);
      snap.push({ callId: call.callId, wm: getFinalCallWatermark(call) });
      totalBytes += addedBytes;
    }
    return { chunk, snap };
  }

  function commitConfirmedEntries(entries) {
    for (const entry of entries) {
      state.quarantinedOversizeMap?.delete(entry.callId);
      const curSynced = state.syncedFinalMap.get(entry.callId);
      const nextSynced = mergeWatermarks(curSynced, entry.wm);
      state.syncedFinalMap.set(entry.callId, nextSynced);
      const curPending = state.pendingFinalCalls.get(entry.callId);
      if (curPending && !hasWatermarkProgressed(getFinalCallWatermark(curPending), nextSynced)) {
        state.pendingFinalCalls.delete(entry.callId);
      }
    }
  }

  const EXPLICIT_OVERSIZE_RE = /\b413\b|payload\s+too\s+large|entity\s+too\s+large|body\s+too\s+large|(?:payload|body|size|record|message|batch|bytes?)\b.*(?:exceeds?|exceeded|over)\b|(?:exceeds?|exceeded|over)\b.*(?:\d+\s*(?:kib|mib|kb|mb|bytes?)|(?:size|payload|body)\s*(?:limit|max))|传输体积超限|体积超限|超出上限|超过.*上限/i;

  function isExplicitOversizeError(recRes) {
    if (!recRes || typeof recRes !== 'object') return false;
    if (recRes.status === 413) return true;
    if (recRes.code === 'PAYLOAD_TOO_LARGE' || recRes.code === 'OVERSIZE' || recRes.phase === 'oversize_guard') return true;
    return EXPLICIT_OVERSIZE_RE.test(String(recRes.error || ''));
  }

  function quarantineOversizedEntry(callId, wm) {
    if (!state.quarantinedOversizeMap) state.quarantinedOversizeMap = new Map();
    const prevQuarantined = state.quarantinedOversizeMap.get(callId);
    state.quarantinedOversizeMap.set(callId, mergeWatermarks(prevQuarantined, wm));
    const curPending = state.pendingFinalCalls.get(callId);
    if (curPending && !hasWatermarkProgressed(getFinalCallWatermark(curPending), wm) && getSingleCallBodyBytes(curPending) > MAX_FLUSH_BATCH_BYTES) {
      state.pendingFinalCalls.delete(callId);
    }
  }

  async function flushPendingFinalCalls(triggerSyncEvenIfUnchanged) {
    if (triggerSyncEvenIfUnchanged && state.flushFinalsBusy) {
      state.pendingFlushForceSync = true;
    }
    if (state.flushFinalsBusy || state.disposed || !state.pendingFinalCalls?.size) return;
    if (Date.now() < (state.nextFlushRetryAt || 0)) return;
    state.flushFinalsBusy = true;
    let anySucceeded = false;
    let anyChanged = false;
    let failedDuringLoop = false;
    try {
      while (!state.disposed && state.pendingFinalCalls.size > 0) {
        if (Date.now() < (state.nextFlushRetryAt || 0)) break;
        const { chunk, snap } = takeNextPendingBatch(state.pendingFinalCalls);
        if (!chunk.length) break;
        const recRes = await recordModelCallsRemote(chunk);
        if (state.disposed) break;
        if (recRes?.ok === true) {
          anySucceeded = true;
          if (recRes.changed) anyChanged = true;
          commitConfirmedEntries(snap);
        } else {
          failedDuringLoop = true;
          state.nextFlushRetryAt = Date.now() + (document.hidden ? 15000 : 3000);
          break;
        }
      }
      if (!state.disposed && !failedDuringLoop && state.pendingFinalCalls.size > 0 && Date.now() >= (state.nextOversizeRetryAt || 0)) {
        const oversizedItems = [];
        for (const call of state.pendingFinalCalls.values()) {
          const singleBytes = getSingleCallBodyBytes(call);
          if (singleBytes > MAX_FLUSH_BATCH_BYTES) {
            oversizedItems.push({ call, singleBytes, wm: getFinalCallWatermark(call) });
          }
        }
        for (const item of oversizedItems) {
          if (state.disposed) break;
          if (!state.pendingFinalCalls.has(item.call.callId)) continue;
          const isLiveHttpMode = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.recordCalls !== 'function' && hasLiveHttpBridge())
            || shouldPreferLiveHost(typeof window?.contextMeterAPI?.recordCalls === 'function', '/record-calls');
          if (isLiveHttpMode && item.singleBytes > MAX_LIVE_RECORD_BODY_BYTES) {
            quarantineOversizedEntry(item.call.callId, item.wm);
            console.warn(`Context Meter: 单条调用记录超过实时通道 1MiB 上限 (${item.singleBytes} bytes)，已隔离跳过: ${item.call.callId}`);
            continue;
          }
          const recRes = await recordModelCallsRemote([item.call]);
          if (state.disposed) break;
          if (recRes?.ok === true) {
            anySucceeded = true;
            if (recRes.changed) anyChanged = true;
            state.nextOversizeRetryAt = 0;
            commitConfirmedEntries([{ callId: item.call.callId, wm: item.wm }]);
          } else if ((isLiveHttpMode && (item.singleBytes > MAX_LIVE_RECORD_BODY_BYTES || recRes?.status === 413)) || isExplicitOversizeError(recRes)) {
            quarantineOversizedEntry(item.call.callId, item.wm);
            console.warn(`Context Meter: 超大调用记录入账被拒绝，已隔离跳过: ${item.call.callId}`);
          } else {
            failedDuringLoop = true;
            const retryAt = Date.now() + (document.hidden ? 15000 : 3000);
            state.nextOversizeRetryAt = retryAt;
            state.nextFlushRetryAt = retryAt;
            break;
          }
        }
      }
      if (!state.disposed && !failedDuringLoop && state.pendingFinalCalls.size > 0 && (state.nextOversizeRetryAt || 0) > Date.now()) {
        const { chunk: remainingNormal } = takeNextPendingBatch(state.pendingFinalCalls);
        if (!remainingNormal.length) {
          state.nextFlushRetryAt = state.nextOversizeRetryAt;
        }
      }
      if (!state.disposed && anySucceeded) {
        if (!failedDuringLoop && state.pendingFinalCalls.size === 0) {
          state.nextFlushRetryAt = 0;
          state.nextOversizeRetryAt = 0;
        }
        if (triggerSyncEvenIfUnchanged || state.pendingFlushForceSync || anyChanged) {
          state.pendingFlushForceSync = false;
          automaticHistorySyncPending = true;
          syncPendingAutomaticHistory();
        }
        if (typeof scheduleQuotaPostTurnRefresh === 'function') {
          scheduleQuotaPostTurnRefresh();
        }
      }
    } finally {
      state.flushFinalsBusy = false;
      if (anySucceeded && !state.disposed && state.pendingFinalCalls.size > 0 && Date.now() >= (state.nextFlushRetryAt || 0)) {
        void flushPendingFinalCalls(true);
      }
    }
  }

  function getPlanSettingsForTestImpl() {
    return {
      currency: 'USD',
      currencySymbol: '$',
      actualPricePaid: ANTIGRAVITY_TOKEN_DATA.planStatus?.actualPricePaid ?? null,
      monthlySpendUSD: ANTIGRAVITY_TOKEN_DATA.planStatus?.actualPricePaid ?? null,
      isZeroExtraCost: Boolean(ANTIGRAVITY_TOKEN_DATA.planStatus?.isZeroExtraCost),
      priceMode: ANTIGRAVITY_TOKEN_DATA.planStatus?.priceMode || 'unset',
      lastSaveResult
    };
  }

  function getTimelineWindowForTestImpl() {
    const w = computeTimelineWindow();
    return {
      firstUseDate: w.firstStr,
      winStart: formatLocalYmd(w.winStart),
      winEnd: formatLocalYmd(w.winEnd),
      totalDays: w.totalDays,
      canPrev: w.canPrev,
      canNext: w.canNext
    };
  }

  function getTokenCacheBreakdownForTestImpl() {
    return {
      input: el('tcb-input-val')?.textContent || '',
      cacheRead: el('tcb-cache-val')?.textContent || '',
      totalInput: el('tcb-total-input-val')?.textContent || '',
      output: el('tcb-output-val')?.textContent || '',
      ratio: el('tcb-ratio-val')?.textContent || '',
      note: el('tcb-note')?.textContent || ''
    };
  }
  // =========================================================================
  // 模型额度看板、套餐详情、共享额度池、动态进度环与定时刷新 (quota-view.js)
  // =========================================================================
  function formatCreditCountCompact(val) {
    if (val === null || val === undefined || val === '') return '—';
    const n = Number(val);
    if (!Number.isFinite(n)) return String(val);
    const abs = Math.abs(n);
    if (abs >= 1e9) {
      const b = n / 1e9;
      return `${Number.isInteger(b) ? b : parseFloat(b.toFixed(1))}B`;
    }
    if (abs >= 1e6) {
      const m = n / 1e6;
      return `${Number.isInteger(m) ? m : parseFloat(m.toFixed(1))}M`;
    }
    if (abs >= 10000) {
      const k = n / 1000;
      return `${Number.isInteger(k) ? k : parseFloat(k.toFixed(1))}K`;
    }
    return String(Math.round(n));
  }

  function formatCreditCountVerbose(val) {
    if (val === null || val === undefined || val === '') return '—';
    const n = Number(val);
    if (!Number.isFinite(n)) return String(val);
    return Math.round(n).toLocaleString('en-US');
  }

  function formatPlanCreditsSummary(credits) {
    const availShort = formatCreditCountCompact(credits?.available);
    const monthlyShort = formatCreditCountCompact(credits?.monthly);
    const availFull = formatCreditCountVerbose(credits?.available);
    const monthlyFull = formatCreditCountVerbose(credits?.monthly);
    return {
      shortText: `${availShort} / ${monthlyShort}`,
      fullTitle: t('plan.credits.avail', { avail: availFull, monthly: monthlyFull })
    };
  }

  function renderPlanDetail(ps) {
    if (!ps) return;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const cleanTierName = (core && typeof core.sanitizeLegacyPlanTierName === 'function')
      ? core.sanitizeLegacyPlanTierName(ps.tierName || 'Google AI Pro')
      : String(ps.tierName || 'Google AI Pro').replace(/\s*[（(]\s*子档未知\s*[）)]/g, '').trim();
    const sumTxt = el('plan-summary-text');
    if (sumTxt) {
      const modeTxt = ps.status === 'identified'
        ? t('plan.summary.identified')
        : ps.hasCustomSettings
          ? t('plan.summary.custom')
          : t('plan.summary.unknown');
      sumTxt.textContent = `${cleanTierName || 'Pro'} · ${modeTxt}`;
    }

    const priceValEl = el('plan-summary-price-val');
    const detPrice = el('p-det-price');
    const tagPrice = el('p-det-price-tag');
    const perMonthSuffix = t('plan.summary.perMonth');

    let summaryBadgeText = t('plan.spend.unsetBadge');
    let detailPriceText = '—';
    let detailTagText = t('plan.tag.publicRef');

    if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
      summaryBadgeText = `$0${perMonthSuffix}`;
      detailPriceText = `$0${perMonthSuffix}`;
      detailTagText = t('plan.tag.manualFree');
    } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined && Number.isFinite(Number(ps.actualPricePaid))) {
      const n = Number(ps.actualPricePaid);
      const numStr = n % 1 === 0 ? String(n) : n.toFixed(2);
      summaryBadgeText = `$${numStr}${perMonthSuffix}`;
      detailPriceText = `$${numStr}${perMonthSuffix}`;
      detailTagText = t('plan.tag.userPaid');
    } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined && Number.isFinite(Number(ps.officialPriceMonthly))) {
      const n = Number(ps.officialPriceMonthly);
      const numStr = n % 1 === 0 ? String(n) : n.toFixed(2);
      summaryBadgeText = `$${numStr}${perMonthSuffix}`;
      detailPriceText = `$${numStr}${perMonthSuffix}`;
      detailTagText = t('plan.tag.publicRef');
    }

    if (priceValEl) priceValEl.textContent = summaryBadgeText;
    if (detPrice) detPrice.textContent = detailPriceText;
    if (tagPrice) {
      tagPrice.style.display = 'inline-block';
      tagPrice.textContent = detailTagText;
    }

    const detName = el('p-det-name');
    if (detName) detName.textContent = cleanTierName || 'Google AI Pro';
    const detAcc = el('p-det-account');
    if (detAcc) detAcc.textContent = ps.email || t('plan.account.unknown');

    const cardEl = el('plan-detail-card');
    if (cardEl && (activeTokenView !== 'tokens' || !planDetailExpanded)) {
      cardEl.style.display = 'none';
      cardEl.classList?.remove?.('is-expanded');
    }

    const spendInput = el('input-monthly-spend-usd');
    if (spendInput && (!document.activeElement || shadow.activeElement !== spendInput)) {
      if (ps.priceMode === 'custom' && ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        spendInput.value = String(ps.actualPricePaid);
      } else if (!ps.hasCustomSettings) {
        spendInput.value = '';
      }
    }

    const pPrompt = el('p-det-prompt-credits');
    const pFlow = el('p-det-flow-credits');
    if (pPrompt && ps.promptCredits) {
      const promptPair = formatPlanCreditsSummary(ps.promptCredits);
      pPrompt.textContent = promptPair.shortText;
      pPrompt.title = promptPair.fullTitle;
      const pLegacy = el('p-det-credits');
      if (pLegacy) {
        pLegacy.textContent = promptPair.shortText;
        pLegacy.title = promptPair.fullTitle;
      }
    }
    if (pFlow && ps.flowCredits) {
      const flowPair = formatPlanCreditsSummary(ps.flowCredits);
      pFlow.textContent = flowPair.shortText;
      pFlow.title = flowPair.fullTitle;
    }
  }
  const QUOTA_REFRESH_FG_MS = 60000;
  const QUOTA_REFRESH_BG_MS = 180000;
  const QUOTA_STALE_MS = 180000;
  const QUOTA_ANIM_DURATION_MS = 220;
  const QUOTA_CAL_STORAGE_PREFIX = 'ag_quota_token_cal_v2_';
  const quotaState = {
    accountScopeKey: null,
    collectorVersion: null,
    snapshot: null,
    rawInput: null,
    browsePoolKey: null,
    busy: false,
    lastFetchedAtMs: null,
    lastSuccessAtMs: null,
    nextRefreshAtMs: null,
    error: null,
    errorKind: null,
    consecutiveErrors: 0,
    lastResetRequeryKey: null,
    autoPaused: false
  };
  quotaStateInitialized = true;
  let quotaAutoTimer = null;
  let quotaResetTimer = null;
  let quotaPostTurnTimer = null;
  let quotaFeedbackTimer = null;
  let quotaInFlightPromise = null;
  let quotaAbortController = null;
  const QUOTA_BAR_CHARGE_DURATION_MS = 720;
  let quotaRefreshSpinAnim = null;
  let quotaBarChargeTimer = null;
  let quotaBarChargePlaying = false;
  const quotaAnimRafs = new Set();
  const quotaActiveChargeRefs = new Set();
  const quotaNumAnimState = new WeakMap();
  const quotaNodeRefsMap = new WeakMap();
  let quotaCalibrationScope = null;
  let quotaCalibrationMap = {};
  let quotaLastEstComputeSig = '';
  let quotaCachedEstByKey = null;
  let quotaLastSnapshotSig = null;
  let quotaPendingSmoothAnim = false;
  let quotaBadgeLastHasFraction = false;

  function isQuotaReducedMotion() {
    try {
      return Boolean(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function clearQuotaBarChargeAnimations() {
    if (quotaBarChargeTimer) {
      clearTimeout(quotaBarChargeTimer);
      quotaBarChargeTimer = null;
    }
    quotaBarChargePlaying = false;
    for (const ref of quotaActiveChargeRefs) {
      if (ref?.track) removeQuotaAttrIfPresent(ref.track, 'data-charging');
      if (ref?.chargeStage) setQuotaHiddenIfChanged(ref.chargeStage, true);
    }
    quotaActiveChargeRefs.clear();
  }

  function triggerQuotaBarsChargeAnimation(targets) {
    if (!Array.isArray(targets) || !targets.length) return false;
    // 动画进行中不堆积或重启多轮播放；减少动态效果下交由静态提示处理
    if (quotaBarChargePlaying || isQuotaReducedMotion()) return false;
    const panelQuotaEl = el('panel-quota');
    if (!panelQuotaEl || panelQuotaEl.hidden) return false;

    const validRefs = [];
    for (const ref of targets) {
      if (ref && ref.chargeEligible && ref.track && ref.chargeStage) {
        validRefs.push(ref);
      }
    }
    if (!validRefs.length) return false;

    for (const ref of validRefs) {
      removeQuotaAttrIfPresent(ref.track, 'data-charging');
      setQuotaHiddenIfChanged(ref.chargeStage, false);
      quotaActiveChargeRefs.add(ref);
    }
    // 仅触发单次整体可见性提交，确保后续 CSS 关键帧从 0% 平滑起播
    if (typeof panelQuotaEl.offsetHeight === 'number') void panelQuotaEl.offsetHeight;
    for (const ref of validRefs) {
      setQuotaAttrIfChanged(ref.track, 'data-charging', 'true');
    }

    quotaBarChargePlaying = true;
    quotaBarChargeTimer = setTimeout(() => {
      clearQuotaBarChargeAnimations();
    }, QUOTA_BAR_CHARGE_DURATION_MS + 30);
    return true;
  }

  function triggerQuotaRefreshIconSpin() {
    if (isQuotaReducedMotion()) return;
    const btn = el('btn-quota-refresh');
    const icon = btn?.querySelector?.('.quota-refresh-icon');
    if (!icon || typeof icon.animate !== 'function') return;
    if (quotaRefreshSpinAnim && quotaRefreshSpinAnim.playState === 'running') return;
    try {
      const anim = icon.animate(
        [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'none' }
      );
      quotaRefreshSpinAnim = anim;
      const clearRef = () => {
        if (quotaRefreshSpinAnim === anim) quotaRefreshSpinAnim = null;
      };
      anim.onfinish = clearRef;
      anim.oncancel = clearRef;
    } catch { }
  }

  function clearQuotaAnimations() {
    for (const rafId of quotaAnimRafs) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    }
    quotaAnimRafs.clear();
    clearQuotaBarChargeAnimations();
    if (quotaRefreshSpinAnim) {
      try { quotaRefreshSpinAnim.cancel(); } catch { }
      quotaRefreshSpinAnim = null;
    }
  }

  function clearQuotaTimers() {
    if (quotaAutoTimer) { clearTimeout(quotaAutoTimer); quotaAutoTimer = null; }
    if (quotaResetTimer) { clearTimeout(quotaResetTimer); quotaResetTimer = null; }
    if (quotaPostTurnTimer) { clearTimeout(quotaPostTurnTimer); quotaPostTurnTimer = null; }
    if (quotaFeedbackTimer) { clearTimeout(quotaFeedbackTimer); quotaFeedbackTimer = null; }
    clearQuotaAnimations();
    try { quotaAbortController?.abort?.(); } catch { }
    quotaAbortController = null;
  }

  function loadQuotaCalibrationForScope(scopeKey) {
    const clean = scopeKey ? String(scopeKey).trim() : 'anonymous';
    if (quotaCalibrationScope === clean) return quotaCalibrationMap;
    quotaCalibrationScope = clean;
    quotaCalibrationMap = {};
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(`${QUOTA_CAL_STORAGE_PREFIX}${clean}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') quotaCalibrationMap = parsed;
        }
      }
    } catch { }
    return quotaCalibrationMap;
  }

  function saveQuotaCalibrationForScope(scopeKey, nextMap) {
    const clean = scopeKey ? String(scopeKey).trim() : 'anonymous';
    quotaCalibrationScope = clean;
    quotaCalibrationMap = nextMap && typeof nextMap === 'object' ? nextMap : {};
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${QUOTA_CAL_STORAGE_PREFIX}${clean}`, JSON.stringify(quotaCalibrationMap));
      }
    } catch { }
  }

  // 仅在值实际改变时写入 DOM，避免重复替换 Text 节点或重设属性引发重排与闪烁
  function setQuotaTextIfChanged(node, text) {
    if (!node) return;
    const next = text == null ? '' : String(text);
    if (node.textContent !== next) node.textContent = next;
  }

  function setQuotaHiddenIfChanged(node, hidden) {
    if (!node) return;
    const next = Boolean(hidden);
    if (Boolean(node.hidden) !== next) node.hidden = next;
  }

  function setQuotaAttrIfChanged(node, name, val) {
    if (!node) return;
    const next = String(val);
    if (getChildAttr(node, name) !== next) node.setAttribute(name, next);
  }

  function removeQuotaAttrIfPresent(node, name) {
    if (!node) return;
    if (getChildAttr(node, name) !== null) node.removeAttribute?.(name);
  }

  function setQuotaClassIfChanged(node, cls) {
    if (!node) return;
    const next = String(cls || '');
    if (node.className !== next) node.className = next;
  }

  function hideQuotaRefreshFeedback() {
    if (quotaFeedbackTimer) { clearTimeout(quotaFeedbackTimer); quotaFeedbackTimer = null; }
    const fb = el('quota-refresh-feedback');
    if (fb) setQuotaHiddenIfChanged(fb, true);
  }

  function showQuotaUpToDateFeedback() {
    const fb = el('quota-refresh-feedback');
    if (!fb) return;
    if (quotaFeedbackTimer) { clearTimeout(quotaFeedbackTimer); quotaFeedbackTimer = null; }
    setQuotaTextIfChanged(fb, t('quota.refresh.upToDate'));
    setQuotaHiddenIfChanged(fb, false);
    quotaFeedbackTimer = setTimeout(() => {
      quotaFeedbackTimer = null;
      if (!state.disposed && el('quota-refresh-feedback')) {
        setQuotaHiddenIfChanged(el('quota-refresh-feedback'), true);
      }
    }, 1800);
  }

  function computeQuotaVisualSignature(view) {
    if (!view || !Array.isArray(view.pools)) return 'empty';
    const parts = [
      view.currentModel?.productKey || '',
      view.activeStatus || '',
      view.badge?.fraction == null ? 'null' : view.badge.fraction.toFixed(4)
    ];
    for (const p of view.pools) {
      const bStr = (p.buckets || []).map(b => `${b.bucketId}:${b.remainingFraction == null ? 'null' : b.remainingFraction.toFixed(4)}:${b.resetAtMs || ''}`).join(',');
      parts.push(`${p.poolKey}=${p.status}=${bStr}`);
    }
    return parts.join('|');
  }

  function formatQuotaNumPctValue(pctVal) {
    if (!Number.isFinite(pctVal)) return '';
    const clamped = Math.max(0, Math.min(100, pctVal));
    if (clamped === 0) return '0%';
    if (clamped > 0 && clamped < 1) return `${Math.max(0.1, Math.round(clamped * 10) / 10)}%`;
    return `${Math.round(clamped)}%`;
  }

  function animateQuotaPercentNode(node, targetFrac, animate, fallbackText = '') {
    if (!node) return;
    const prevState = quotaNumAnimState.get(node) || { rafId: 0, currentPct: null, targetPct: null };
    if (targetFrac == null || !Number.isFinite(Number(targetFrac))) {
      if (prevState.rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(prevState.rafId);
        quotaAnimRafs.delete(prevState.rafId);
      }
      quotaNumAnimState.set(node, { rafId: 0, currentPct: null, targetPct: null });
      setQuotaTextIfChanged(node, fallbackText);
      return;
    }

    const targetPct = Math.max(0, Math.min(100, Number(targetFrac) * 100));
    const canAnimate = Boolean(
      animate &&
      !isQuotaReducedMotion() &&
      typeof requestAnimationFrame === 'function' &&
      prevState.currentPct !== null &&
      Math.abs(targetPct - prevState.currentPct) >= 0.05
    );

    if (!canAnimate) {
      if (prevState.rafId && prevState.targetPct !== null && Math.abs(prevState.targetPct - targetPct) < 0.05) {
        return;
      }
      if (prevState.rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(prevState.rafId);
        quotaAnimRafs.delete(prevState.rafId);
      }
      quotaNumAnimState.set(node, { rafId: 0, currentPct: targetPct, targetPct });
      setQuotaTextIfChanged(node, formatQuotaNumPctValue(targetPct));
      return;
    }

    if (prevState.rafId && prevState.targetPct !== null && Math.abs(prevState.targetPct - targetPct) < 0.05) {
      return;
    }

    if (prevState.rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(prevState.rafId);
      quotaAnimRafs.delete(prevState.rafId);
    }

    const startPct = prevState.currentPct;
    const startTs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const animObj = { rafId: 0, currentPct: startPct, targetPct };
    quotaNumAnimState.set(node, animObj);

    const step = (nowTs) => {
      if (state.disposed) {
        quotaAnimRafs.delete(animObj.rafId);
        animObj.rafId = 0;
        return;
      }
      const curNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const rawT = Math.min(1, Math.max(0, (curNow - startTs) / QUOTA_ANIM_DURATION_MS));
      const eased = 1 - Math.pow(1 - rawT, 3);
      const val = startPct + (targetPct - startPct) * eased;
      animObj.currentPct = val;
      setQuotaTextIfChanged(node, formatQuotaNumPctValue(val));
      if (rawT < 1) {
        animObj.rafId = requestAnimationFrame(step);
        quotaAnimRafs.add(animObj.rafId);
      } else {
        quotaAnimRafs.delete(animObj.rafId);
        animObj.rafId = 0;
        animObj.currentPct = targetPct;
        setQuotaTextIfChanged(node, formatQuotaNumPctValue(targetPct));
      }
    };
    animObj.rafId = requestAnimationFrame(step);
    quotaAnimRafs.add(animObj.rafId);
  }

  function resetQuotaState(opts = {}) {
    clearQuotaTimers();
    if (opts.clearAccountScope !== false) {
      quotaState.accountScopeKey = null;
      quotaCalibrationScope = null;
      quotaCalibrationMap = {};
    }
    quotaLastEstComputeSig = '';
    quotaCachedEstByKey = null;
    quotaLastSnapshotSig = null;
    quotaPendingSmoothAnim = false;
    quotaBadgeLastHasFraction = false;
    quotaState.snapshot = null;
    quotaState.rawInput = null;
    quotaState.browsePoolKey = null;
    quotaState.busy = false;
    quotaState.lastFetchedAtMs = null;
    quotaState.lastSuccessAtMs = null;
    quotaState.nextRefreshAtMs = null;
    quotaState.error = null;
    quotaState.errorKind = null;
    quotaState.consecutiveErrors = 0;
    quotaState.lastResetRequeryKey = null;
    quotaInFlightPromise = null;
    renderQuotaBoard();
  }

  function refreshQuotaTokenEstimates() {
    quotaLastEstComputeSig = '';
    quotaCachedEstByKey = null;
    if (!state.disposed && (quotaState.snapshot || quotaState.rawInput)) {
      renderQuotaBoard(Date.now(), { animate: false });
    }
  }

  function handleQuotaAccountSwitch(nextScopeKey, opts = {}) {
    const cleanNext = nextScopeKey ? String(nextScopeKey).trim() : null;
    const prev = quotaState.accountScopeKey;
    const changed = Boolean(cleanNext && prev && cleanNext !== prev);
    if (changed || opts.forceRefresh) {
      resetQuotaState({ clearAccountScope: true });
      if (cleanNext) quotaState.accountScopeKey = cleanNext;
      if (!state.disposed) void syncQuotaFromHost(true);
      return true;
    }
    if (cleanNext && !prev) {
      quotaState.accountScopeKey = cleanNext;
    }
    return false;
  }

  function getQuotaStatusLabelText(statusKey) {
    const keyMap = {
      available: 'quota.state.available',
      low: 'quota.state.low',
      exhausted: 'quota.state.exhausted',
      no_permission: 'quota.state.no_permission',
      stale: 'quota.state.stale',
      error: 'quota.state.error',
      unknown: 'quota.state.unknown'
    };
    return t(keyMap[statusKey] || 'quota.state.unknown');
  }

  function getQuotaShortBadgeText(statusKey) {
    const keyMap = {
      exhausted: 'quota.short.exhausted',
      no_permission: 'quota.short.no_permission',
      error: 'quota.short.error',
      stale: 'quota.short.stale',
      unknown: 'quota.short.unknown'
    };
    return keyMap[statusKey] ? t(keyMap[statusKey]) : '';
  }

  function getQuotaPillClass(statusKey) {
    if (statusKey === 'available') return 'pill-good';
    if (statusKey === 'low' || statusKey === 'stale') return 'pill-warn';
    if (statusKey === 'exhausted' || statusKey === 'error') return 'pill-danger';
    if (statusKey === 'no_permission') return 'pill-info';
    return 'pill-muted';
  }

  function formatQuotaDateTime(ms) {
    if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return t('quota.time.unknown');
    const d = new Date(Number(ms));
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yr}-${mo}-${da} ${hh}:${mi}:${ss}`;
  }

  function formatQuotaTimeShortHM(ms) {
    if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '';
    const d = new Date(Number(ms));
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mi}`;
  }

  function formatCountdownMsCompact(ms) {
    if (!Number.isFinite(Number(ms))) return t('quota.time.unknown');
    if (ms <= 0) return '0s';
    const sec = Math.ceil(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (currentPanelLanguage === 'en') {
      if (d > 0) return `${d}d ${h}h`;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m`;
      return `${s}s`;
    }
    if (d > 0) return `${d}天${h}小时`;
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分`;
    return `${s}秒`;
  }

  function formatQuotaWindowTitle(bucket) {
    if (!bucket) return '';
    if (currentPanelLanguage === 'en') {
      if (bucket.windowKey === '5h') return '5h Window';
      if (bucket.windowKey === 'weekly') return 'Weekly Window';
      if (bucket.windowKey === 'daily') return 'Daily Window';
      return 'Primary Quota';
    }
    if (currentPanelLanguage === 'zh-TW') {
      if (bucket.windowKey === '5h') return '5小時限額';
      if (bucket.windowKey === 'weekly') return '每週限額';
      if (bucket.windowKey === 'daily') return '每日限額';
      return '目前主限額';
    }
    return bucket.windowLabel || '周期限额';
  }

  function getActiveQuotaModelInput() {
    if (activeSessionModelConfirmed && (activeSessionModelKey || activeSessionProductKey)) {
      const cfgList = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      const activeKeyLower = String(activeSessionModelKey || '').trim().toLowerCase();
      const matched = activeKeyLower ? cfgList.find(c =>
        String(c?.modelId || '').trim().toLowerCase() === activeKeyLower ||
        String(c?.modelOrAlias?.model || '').trim().toLowerCase() === activeKeyLower
      ) : null;
      if (matched) return matched;
      return {
        modelId: activeSessionModelKey || '',
        label: state.latest?.model || activeSessionModelKey || activeSessionProductKey,
        productKey: activeSessionProductKey || ''
      };
    }
    if (state.latest?.modelId || state.latest?.model) {
      return {
        modelId: state.latest.modelId || state.latest.model,
        label: state.latest.model || state.latest.modelId
      };
    }
    return null;
  }

  function attachTokenEstimatesToQuotaView(view, nowMs) {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    if (!view || !Array.isArray(view.pools) || !core?.applyQuotaTokenEstimates) return view;
    const scopeKey = quotaState.accountScopeKey || view.accountScopeKey || 'anonymous';
    const usageEvents = Array.isArray(ANTIGRAVITY_TOKEN_DATA.recentModelUsage) ? ANTIGRAVITY_TOKEN_DATA.recentModelUsage : [];
    const coverageStartMs = ANTIGRAVITY_TOKEN_DATA.quotaUsageCoverageStartMs ?? null;
    const lastEvTs = usageEvents.length ? Number(usageEvents[usageEvents.length - 1]?.ts || 0) : 0;
    const poolSig = view.pools.map(p => `${p.poolKey}:${(p.buckets || []).map(b => `${b.bucketId}=${b.remainingFraction ?? 'n'}`).join(',')}`).join(';');
    const computeSig = `${scopeKey}|${view.fetchedAtMs || 0}|${coverageStartMs ?? 'null'}|${usageEvents.length}|${lastEvTs}|${poolSig}`;

    if (quotaLastEstComputeSig === computeSig && quotaCachedEstByKey) {
      const enrichedPools = view.pools.map(p => {
        const nextBuckets = (p.buckets || []).map(b => {
          const bKey = `${p.poolKey}::${b.bucketId || b.windowKey}`;
          return quotaCachedEstByKey[bKey] ? { ...b, tokenEstimate: quotaCachedEstByKey[bKey] } : b;
        });
        const pb = p.primaryBucket ? (nextBuckets.find(b => b.bucketId === p.primaryBucket.bucketId) || nextBuckets[0] || p.primaryBucket) : (nextBuckets[0] || null);
        return { ...p, buckets: nextBuckets, primaryBucket: pb, tokenEstimate: pb?.tokenEstimate || p.tokenEstimate || null };
      });
      return { ...view, pools: enrichedPools };
    }

    const calMap = loadQuotaCalibrationForScope(scopeKey);
    const applied = core.applyQuotaTokenEstimates(view, {
      accountScopeKey: scopeKey,
      usageEvents,
      historyCoverageStartMs: coverageStartMs,
      calibrationMap: calMap,
      nowMs: view.fetchedAtMs || nowMs
    });
    if (applied?.nextCalibrationMap) {
      saveQuotaCalibrationForScope(scopeKey, applied.nextCalibrationMap);
    }
    const cacheObj = {};
    for (const p of (applied?.snapshot?.pools || [])) {
      for (const b of (p.buckets || [])) {
        cacheObj[`${p.poolKey}::${b.bucketId || b.windowKey}`] = b.tokenEstimate || null;
      }
    }
    quotaLastEstComputeSig = computeSig;
    quotaCachedEstByKey = cacheObj;
    return applied?.snapshot || view;
  }

  function computeEffectiveQuotaView(nowMs = Date.now()) {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const currentModelInput = getActiveQuotaModelInput();

    // 1. 优先复用 rawInput 通过 buildModelQuotaSnapshot 完整演算（支持测试注入原始响应或本地配置变更）
    if (quotaState.rawInput && core?.buildModelQuotaSnapshot) {
      const built = core.buildModelQuotaSnapshot({
        ...quotaState.rawInput,
        currentModel: currentModelInput,
        browsePoolKey: quotaState.browsePoolKey,
        fetchMeta: {
          fetchedAtMs: quotaState.lastSuccessAtMs ?? quotaState.lastFetchedAtMs,
          nextRefreshAtMs: quotaState.nextRefreshAtMs,
          staleThresholdMs: QUOTA_STALE_MS,
          error: quotaState.error,
          errorKind: quotaState.errorKind
        },
        nowMs
      });
      return attachTokenEstimatesToQuotaView(built, nowMs);
    }

    // 2. 基于主进程返回的标准化 snapshot 重新结合当前会话模型与实时 nowMs 刷新视图状态
    const base = quotaState.snapshot;
    if (!base) {
      const hasErr = Boolean(quotaState.error);
      return {
        schemaVersion: 1,
        syncState: hasErr ? 'error' : 'unknown',
        fetchedAtMs: quotaState.lastSuccessAtMs ?? quotaState.lastFetchedAtMs,
        nextRefreshAtMs: quotaState.nextRefreshAtMs,
        staleThresholdMs: QUOTA_STALE_MS,
        lastError: quotaState.error,
        errorKind: quotaState.errorKind,
        currentModel: currentModelInput ? { productLabel: String(currentModelInput.label || currentModelInput.modelId) } : null,
        activeStatus: hasErr ? 'error' : 'unknown',
        activeStatusLabel: getQuotaStatusLabelText(hasErr ? 'error' : 'unknown'),
        badge: {
          text: getQuotaShortBadgeText(hasErr ? 'error' : 'unknown'),
          tag: hasErr ? t('quota.retry') : '',
          fraction: null,
          status: hasErr ? 'error' : 'unknown',
          statusLabel: getQuotaStatusLabelText(hasErr ? 'error' : 'unknown')
        },
        activeReset: { hasResetTime: false, resetTimeText: null, countdownText: null, isResetPassed: false },
        browsePoolKey: quotaState.browsePoolKey,
        planTierName: ANTIGRAVITY_TOKEN_DATA.planStatus?.tierName || null,
        pools: []
      };
    }

    const updatedPools = (base.pools || []).map(p => {
      const nextBuckets = (p.buckets || []).map(b => {
        if (!b.resetTimeIso || !core?.formatQuotaResetMeta) return { ...b };
        const rm = core.formatQuotaResetMeta(b.resetTimeIso, nowMs);
        return {
          ...b,
          hasResetTime: rm.hasResetTime,
          resetAtMs: rm.resetAtMs,
          resetTimeText: rm.resetTimeText,
          countdownText: rm.countdownText,
          isResetPassed: rm.isResetPassed
        };
      });
      const sel = (typeof selectPrimaryQuotaBucket === 'function')
        ? selectPrimaryQuotaBucket(nextBuckets)
        : (() => {
            const priced = nextBuckets.filter(b => b.remainingFraction !== null).sort((a, b) => a.remainingFraction - b.remainingFraction);
            return { primaryBucket: priced[0] || nextBuckets[0] || null, selectionReason: priced.length <= 1 ? 'single_window' : 'tighter_window' };
          })();
      const pb = sel.primaryBucket || p.primaryBucket || null;
      return {
        ...p,
        buckets: nextBuckets,
        primaryBucket: pb,
        selectionReason: sel.selectionReason || p.selectionReason || 'single_window',
        remainingFraction: pb?.remainingFraction ?? p.remainingFraction ?? null,
        percentText: pb?.percentText ?? p.percentText ?? null,
        isExhausted: pb ? Boolean(pb.isExhausted || pb.remainingFraction === 0) : Boolean(p.isExhausted),
        hasResetTime: Boolean(pb?.hasResetTime ?? p.hasResetTime),
        resetTimeIso: pb?.resetTimeIso ?? p.resetTimeIso ?? null,
        resetAtMs: pb?.resetAtMs ?? p.resetAtMs ?? null,
        resetTimeText: pb?.resetTimeText ?? p.resetTimeText ?? null,
        countdownText: pb?.countdownText ?? p.countdownText ?? null,
        isResetPassed: Boolean(pb?.isResetPassed ?? p.isResetPassed)
      };
    });

    // 针对实时切换后的会话模型重新匹配池与模型
    const tStr = currentModelInput
      ? String(currentModelInput.modelId || currentModelInput.label || '').trim().toLowerCase()
      : '';
    const tStripped = tStr.replace(/^model_/, '');
    let matchedPool = null;
    let matchedModel = null;
    if (tStr) {
      for (const p of updatedPools) {
        for (const m of (p.models || [])) {
          const allIds = [...(m.modelIds || []), ...(m.aliases || [])].map(x => String(x).toLowerCase());
          if (allIds.some(id => id === tStr || id.replace(/^model_/, '') === tStripped)) {
            matchedPool = p;
            matchedModel = m;
            break;
          }
          if (m.productLabel && m.productLabel.toLowerCase() === tStr) {
            matchedPool = p;
            matchedModel = m;
            break;
          }
          if (m.productKey && currentModelInput?.productKey && m.productKey === currentModelInput.productKey) {
            matchedPool = p;
            matchedModel = m;
            break;
          }
        }
        if (matchedPool) break;
      }
      if (!matchedPool && core?.getSharedQuotaGroupKey) {
        const gKey = core.getSharedQuotaGroupKey(currentModelInput);
        matchedPool = updatedPools.find(p => p.poolKey === gKey) || null;
        if (matchedPool) matchedModel = matchedPool.models?.[0] || null;
      }
    }

    const lastOkMs = quotaState.lastSuccessAtMs ?? base.fetchedAtMs ?? null;
    const ageExpired = lastOkMs !== null && (nowMs - lastOkMs > QUOTA_STALE_MS);
    const anyResetPassed = updatedPools.some(p => p.isResetPassed && p.remainingFraction === 0);
    const hasAnyPool = updatedPools.some(p => p.remainingFraction !== null || p.noPermission);
    let syncState = 'unknown';
    if (!hasAnyPool && quotaState.error) syncState = 'error';
    else if (hasAnyPool && (quotaState.error || ageExpired || anyResetPassed)) syncState = 'stale';
    else if (hasAnyPool) syncState = 'fresh';

    let activeStatus = 'unknown';
    let badgeText = t('quota.short.unknown');
    let badgeTag = '';
    let activeFraction = null;
    let activeReset = { hasResetTime: false, resetTimeText: null, countdownText: null, isResetPassed: false };

    if (syncState === 'error') {
      activeStatus = 'error';
      badgeText = t('quota.short.error');
      badgeTag = t('quota.retry');
    } else if (matchedModel?.noPermission || matchedPool?.noPermission) {
      activeStatus = 'no_permission';
      badgeText = t('quota.short.no_permission');
    } else if (matchedPool) {
      activeFraction = matchedPool.remainingFraction;
      activeReset = {
        hasResetTime: matchedPool.hasResetTime,
        resetTimeIso: matchedPool.resetTimeIso,
        resetAtMs: matchedPool.resetAtMs,
        resetTimeText: matchedPool.resetTimeText,
        countdownText: matchedPool.countdownText,
        isResetPassed: matchedPool.isResetPassed
      };
      if (matchedPool.remainingFraction === null) {
        activeStatus = syncState === 'stale' ? 'stale' : 'unknown';
        badgeText = t(syncState === 'stale' ? 'quota.short.stale' : 'quota.short.unknown');
      } else if (matchedPool.isExhausted || matchedPool.remainingFraction === 0) {
        activeStatus = syncState === 'stale' ? 'stale' : 'exhausted';
        badgeText = t('quota.short.exhausted');
        badgeTag = matchedPool.primaryBucket?.windowShort || '';
      } else {
        activeStatus = syncState === 'stale' ? 'stale' : (matchedPool.remainingFraction <= 0.2 ? 'low' : 'available');
        badgeText = core?.formatQuotaPercentText ? core.formatQuotaPercentText(matchedPool.remainingFraction) : matchedPool.percentText;
        badgeTag = syncState === 'stale' ? t('quota.short.stale') : (matchedPool.primaryBucket?.windowShort || '');
      }
    } else if (syncState === 'stale') {
      activeStatus = 'stale';
      badgeText = t('quota.short.stale');
    }

    return attachTokenEstimatesToQuotaView({
      ...base,
      syncState,
      fetchedAtMs: lastOkMs,
      nextRefreshAtMs: quotaState.nextRefreshAtMs,
      lastError: quotaState.error,
      errorKind: quotaState.errorKind,
      currentModel: matchedModel
        ? {
          productKey: matchedModel.productKey,
          productLabel: matchedModel.productLabel,
          poolKey: matchedPool.poolKey,
          poolTitle: matchedPool.title,
          noPermission: matchedModel.noPermission,
          unavailabilityReason: matchedModel.unavailabilityReason,
          noticeText: matchedModel.noticeText
        }
        : (currentModelInput ? { productLabel: String(currentModelInput.label || currentModelInput.modelId), poolKey: null, poolTitle: null } : base.currentModel),
      activeStatus,
      activeStatusLabel: getQuotaStatusLabelText(activeStatus),
      badge: {
        text: badgeText,
        tag: badgeTag,
        fraction: activeFraction,
        status: activeStatus,
        statusLabel: getQuotaStatusLabelText(activeStatus)
      },
      activeReset,
      browsePoolKey: quotaState.browsePoolKey || matchedPool?.poolKey || updatedPools[0]?.poolKey || null,
      pools: updatedPools
    }, nowMs);
  }

  function formatBucketTokenEstimateMeta(est) {
    if (!est || est.estSource === 'unavailable' || est.estSource === 'unknown') {
      return { text: '', title: '' };
    }
    if (est.estBasis === 'exhausted' || est.estSource === 'exhausted' || est.estRemainingTokens === 0) {
      const msg = t('quota.est.exhausted');
      return { text: msg, title: msg };
    }
    if (est.estBasis === 'incomplete_samples' || est.estSource === 'incomplete') {
      const msg = t('quota.est.incomplete');
      return { text: msg, title: msg };
    }
    if (est.estBasis === 'calibration_expired' || est.estSource === 'expired') {
      const msg = t('quota.est.expired');
      return { text: msg, title: msg };
    }
    if (est.estBasis === 'coverage_incomplete') {
      const msg = t('quota.est.coverageIncomplete');
      return { text: msg, title: msg };
    }
    if (est.estRemainingTokens != null && est.estRemainingShort) {
      let basisKey = 'quota.est.basisCached';
      const isDivergentStale = est.estBasis === 'stale_with_divergence' || est.estSource === 'unreliable_cached';
      if (isDivergentStale) {
        basisKey = 'quota.est.basisStaleDivergence';
      } else if (est.estBasis === 'delta_calibrated' && est.estSource === 'delta') {
        basisKey = 'quota.est.basisDelta';
      } else if (est.estBasis === 'cycle_estimated' && est.estSource === 'cycle') {
        basisKey = 'quota.est.basisCycle';
      }
      const mainPart = t('quota.est.approx', { tokens: est.estRemainingShort });
      const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
      const usedRaw = Number(est.cycleTokensUsed ?? est.recordedTokens ?? 0);
      const usedShort = usedRaw > 0
        ? (core?.formatApproxTokensShort ? core.formatApproxTokensShort(usedRaw) : short(usedRaw))
        : null;
      const usedPart = usedShort ? t('quota.est.cycleUsed', { used: usedShort }) : '';
      const staleSuffix = isDivergentStale ? ` (${t('quota.short.stale')})` : '';
      const summaryLine = `${mainPart}${usedPart ? ` · ${usedPart}` : ''}${staleSuffix}`;
      const basisPart = t(basisKey);
      const mixedPart = est.mixedPoolModels
        ? (currentPanelLanguage === 'en' ? ` (${t('quota.est.mixedModels')})` : `（${t('quota.est.mixedModels')}）`)
        : '';
      const detailTitle = `${mainPart}${usedPart ? ` · ${usedPart}` : ''} · ${basisPart}${mixedPart}`;
      return { text: summaryLine, title: detailTitle };
    }
    return { text: '', title: '' };
  }

  function formatBucketTokenEstimateLine(est) {
    return formatBucketTokenEstimateMeta(est).text;
  }

  function getChildAttr(node, name) {
    if (!node) return null;
    if (typeof node.getAttribute === 'function') return node.getAttribute(name);
    return node.attributes?.[name] ?? null;
  }

  function reconcileQuotaChildOrder(container, desiredNodes) {
    const cur = Array.from(container.children || []);
    const sameOrder = cur.length === desiredNodes.length && cur.every((n, idx) => n === desiredNodes[idx]);
    if (sameOrder) return;
    if (typeof container.removeChild === 'function' && typeof container.insertBefore === 'function') {
      const wantSet = new Set(desiredNodes);
      for (const ch of cur) {
        if (!wantSet.has(ch)) container.removeChild(ch);
      }
      for (let i = 0; i < desiredNodes.length; i++) {
        const node = desiredNodes[i];
        const atIdx = container.children[i] || null;
        if (atIdx !== node) {
          container.insertBefore(node, atIdx);
        }
      }
      return;
    }
    if (typeof container.replaceChildren === 'function') {
      container.replaceChildren(...desiredNodes);
    } else {
      if (Array.isArray(container.children)) container.children.length = 0;
      for (const n of desiredNodes) container.appendChild?.(n);
    }
  }

  function renderQuotaBucketsContainer(container, buckets, statusOverride = null, opts = {}) {
    if (!container) return;
    const list = Array.isArray(buckets) ? buckets : [];
    const animate = Boolean(opts.animate);
    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    if (!list.length) {
      reconcileQuotaChildOrder(container, []);
      return;
    }

    const existingRows = new Map();
    for (const child of Array.from(container.children || [])) {
      const bKey = getChildAttr(child, 'data-bucket-key');
      if (bKey) existingRows.set(bKey, child);
    }

    const desiredRows = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const bKey = String(b.bucketId || b.windowKey || `b-${i}`);

      let row = existingRows.get(bKey);
      let refs = row ? quotaNodeRefsMap.get(row) : null;

      if (!row || !refs) {
        row = document.createElement('div');
        row.className = 'quota-bucket-row';
        row.setAttribute('data-bucket-key', bKey);

        const meta = document.createElement('div');
        meta.className = 'quota-bucket-meta';

        const nameEl = document.createElement('span');
        nameEl.className = 'quota-bucket-name';

        const valEl = document.createElement('span');
        valEl.className = 'quota-bucket-val';
        const pctEl = document.createElement('span');
        pctEl.className = 'quota-pct-num';
        const resetEl = document.createElement('span');
        resetEl.className = 'quota-reset-span';
        valEl.appendChild(pctEl);
        valEl.appendChild(resetEl);

        meta.appendChild(nameEl);
        meta.appendChild(valEl);

        const track = document.createElement('div');
        track.className = 'quota-bar-track';
        const fillEl = document.createElement('div');
        fillEl.className = 'quota-bar-fill';
        track.appendChild(fillEl);

        // 独立充能动画层：裁剪在真实比例宽度内，绝不归零底层也不填满到 100%
        const chargeStage = document.createElement('div');
        chargeStage.className = 'quota-bar-charge-stage';
        chargeStage.hidden = true;
        const chargeFill = document.createElement('div');
        chargeFill.className = 'quota-bar-charge-fill';
        const chargeSheen = document.createElement('div');
        chargeSheen.className = 'quota-bar-charge-sheen';
        chargeStage.appendChild(chargeFill);
        chargeStage.appendChild(chargeSheen);
        track.appendChild(chargeStage);

        const estEl = document.createElement('div');
        estEl.className = 'quota-bucket-est';
        estEl.hidden = true;

        row.appendChild(meta);
        row.appendChild(track);
        row.appendChild(estEl);
        refs = {
          nameEl,
          pctEl,
          resetEl,
          track,
          fillEl,
          chargeStage,
          chargeFill,
          chargeSheen,
          chargeRef: { track, chargeStage, chargeEligible: false },
          estEl
        };
        quotaNodeRefsMap.set(row, refs);
      }

      const { nameEl, pctEl, resetEl, track, fillEl, chargeStage, chargeRef, estEl } = refs;
      if (nameEl) setQuotaTextIfChanged(nameEl, formatQuotaWindowTitle(b));

      if (pctEl) {
        if (statusOverride === 'no_permission') {
          animateQuotaPercentNode(pctEl, null, false, t('quota.short.no_permission'));
        } else if (b.remainingFraction == null) {
          animateQuotaPercentNode(pctEl, null, false, t('quota.time.unknown'));
        } else {
          animateQuotaPercentNode(pctEl, b.remainingFraction, animate, b.percentText);
        }
      }

      if (resetEl) {
        const resetSuffix = b.hasResetTime
          ? ` · ${b.resetTimeText}${b.countdownText ? ` (${b.isResetPassed ? b.countdownText : formatCountdownMsCompact((b.resetAtMs || 0) - nowMs)})` : ''}`
          : ` · ${t('quota.time.reset')}: ${t('quota.time.unknown')}`;
        setQuotaTextIfChanged(resetEl, resetSuffix);
      }

      if (fillEl) {
        const bStatus = statusOverride || (b.remainingFraction == null
          ? 'unknown'
          : (b.isExhausted || b.remainingFraction === 0 ? 'exhausted' : (b.remainingFraction <= 0.2 ? 'low' : 'available')));
        const scaleVal = b.remainingFraction == null ? 0 : Math.max(0, Math.min(1, b.remainingFraction));
        const scaleStr = scaleVal.toFixed(4);
        const stageWidthStr = `${(scaleVal * 100).toFixed(2)}%`;
        setQuotaAttrIfChanged(fillEl, 'data-status', bStatus);
        if (getChildAttr(fillEl, 'data-fraction') !== scaleStr) {
          fillEl.setAttribute('data-fraction', scaleStr);
          if (typeof fillEl.style?.setProperty === 'function') {
            fillEl.style.setProperty('--quota-scale', scaleStr);
          }
          if (fillEl.style) {
            fillEl.style.transform = `scaleX(${scaleStr})`;
          }
        }
        const chargeEligible = Boolean(
          statusOverride !== 'no_permission' &&
          bStatus !== 'no_permission' &&
          bStatus !== 'unknown' &&
          b.remainingFraction != null &&
          Number.isFinite(Number(b.remainingFraction)) &&
          scaleVal > 0
        );
        if (chargeStage) {
          setQuotaAttrIfChanged(chargeStage, 'data-status', bStatus);
          if (getChildAttr(chargeStage, 'data-fraction') !== scaleStr) {
            chargeStage.setAttribute('data-fraction', scaleStr);
            if (chargeStage.style) {
              chargeStage.style.width = stageWidthStr;
            }
          }
        }
        if (track) {
          setQuotaAttrIfChanged(track, 'data-charge-eligible', chargeEligible ? 'true' : 'false');
          if (!chargeEligible) {
            removeQuotaAttrIfPresent(track, 'data-charging');
            if (chargeStage) setQuotaHiddenIfChanged(chargeStage, true);
            if (chargeRef) quotaActiveChargeRefs.delete(chargeRef);
          }
        }
        if (chargeRef) {
          chargeRef.chargeEligible = chargeEligible;
          if (chargeEligible && Array.isArray(opts.chargeTargets)) {
            opts.chargeTargets.push(chargeRef);
          }
        }
      }

      if (estEl) {
        const estMeta = statusOverride === 'no_permission'
          ? { text: '', title: '' }
          : formatBucketTokenEstimateMeta(b.tokenEstimate);
        if (estMeta.text) {
          setQuotaHiddenIfChanged(estEl, false);
          setQuotaTextIfChanged(estEl, estMeta.text);
          if (estEl.title !== estMeta.title) estEl.title = estMeta.title;
          if (row.title !== estMeta.title) row.title = estMeta.title;
        } else {
          setQuotaHiddenIfChanged(estEl, true);
          setQuotaTextIfChanged(estEl, '');
          if (estEl.title) estEl.title = '';
          if (row.title) row.title = '';
        }
      }
      desiredRows.push(row);
    }

    reconcileQuotaChildOrder(container, desiredRows);
  }

  function renderQuotaBoard(nowMs = Date.now(), renderOpts = {}) {
    const viewQuotaBody = el('view-quota');
    const savedScrollTop = (viewQuotaBody && typeof viewQuotaBody.scrollTop === 'number') ? viewQuotaBody.scrollTop : null;
    const view = computeEffectiveQuotaView(nowMs);
    const currentSig = computeQuotaVisualSignature(view);
    const chargeBarTargets = renderOpts.chargeBars ? [] : null;
    const shouldAnimate = Boolean(
      renderOpts.animate !== undefined
        ? renderOpts.animate
        : (quotaPendingSmoothAnim && quotaLastSnapshotSig !== null && currentSig !== quotaLastSnapshotSig)
    );
    if (renderOpts.consumeAnim !== false && quotaPendingSmoothAnim) {
      quotaPendingSmoothAnim = false;
    }
    quotaLastSnapshotSig = currentSig;

    // 1. 渲染顶栏圆环入口与窄屏溢出菜单项（不只靠颜色，必含数值/状态短文本）
    const bQuota = el('badge-quota');
    const qFill = el('quota-ring-fill');
    const qVal = el('quota-badge-val');
    const qTag = el('quota-badge-tag');
    const oQuotaVal = el('overflow-quota-val');

    if (bQuota) {
      setQuotaAttrIfChanged(bQuota, 'data-quota-state', view.activeStatus || 'unknown');
      const tipModel = view.currentModel?.productLabel || t('quota.current.unmatched');
      const matchedPoolObj = (view.pools || []).find(p => p.poolKey === view.currentModel?.poolKey) || null;
      const reasonMap = {
        tighter_window: currentPanelLanguage === 'en' ? 'tightest window' : (currentPanelLanguage === 'zh-TW' ? '最緊縮視窗優先' : '最紧缩窗口优先'),
        tie_window: currentPanelLanguage === 'en' ? '5h priority on tie' : (currentPanelLanguage === 'zh-TW' ? '同餘量優先短視窗' : '同余量优先短窗口'),
        single_window: currentPanelLanguage === 'en' ? 'single window' : (currentPanelLanguage === 'zh-TW' ? '單一限額視窗' : '单一限额窗口')
      };
      const winLines = (matchedPoolObj?.buckets || []).map(b => {
        const wTag = b.windowShort || formatQuotaWindowTitle(b);
        const wReset = b.hasResetTime ? `${b.resetTimeText} (${formatCountdownMsCompact((b.resetAtMs || 0) - nowMs)})` : t('quota.time.unknown');
        return `${wTag}: ${b.percentText || t('quota.time.unknown')} (${wReset})`;
      });
      const selNote = matchedPoolObj?.primaryBucket
        ? `${matchedPoolObj.primaryBucket.windowShort || formatQuotaWindowTitle(matchedPoolObj.primaryBucket)} · ${reasonMap[matchedPoolObj.selectionReason] || ''}`
        : '';
      const updatedStr = view.fetchedAtMs ? new Date(view.fetchedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : t('quota.time.unknown');
      const poolHeader = matchedPoolObj?.title ? ` · ${matchedPoolObj.title}` : '';
      const tipReset = view.activeReset?.hasResetTime
        ? `${view.activeReset.resetTimeText} (${formatCountdownMsCompact((view.activeReset.resetAtMs || 0) - nowMs)})`
        : t('quota.time.unknown');
      const nextTitle = [
        `${tipModel}${poolHeader} · ${view.activeStatusLabel} (${view.badge.text})${selNote ? ` [${selNote}]` : ''}`,
        winLines.length ? winLines.join(' | ') : `${t('quota.time.reset')}: ${tipReset}`,
        `${currentPanelLanguage === 'en' ? 'Updated' : '更新'}: ${updatedStr}`
      ].filter(Boolean).join('\n');
      if (bQuota.title !== nextTitle) bQuota.title = nextTitle;
      setQuotaAttrIfChanged(bQuota, 'aria-label', `${t('badge.quota.aria')}: ${view.badge.text} (${view.activeStatusLabel})`);
    }
    if (qFill) {
      if (view.badge.fraction == null) {
        const nextDash = view.activeStatus === 'unknown' ? '10 30.84' : `0 ${RING_CIRCUMFERENCE.toFixed(2)}`;
        setQuotaAttrIfChanged(qFill, 'stroke-dasharray', nextDash);
        setQuotaAttrIfChanged(qFill, 'stroke-dashoffset', '0');
        quotaBadgeLastHasFraction = false;
      } else {
        const clampedFrac = Math.max(0, Math.min(1, view.badge.fraction));
        const offsetStr = (RING_CIRCUMFERENCE * (1 - clampedFrac)).toFixed(2);
        const dashStr = `${RING_CIRCUMFERENCE.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`;
        if (!quotaBadgeLastHasFraction && qFill.style && typeof qFill.getBoundingClientRect === 'function') {
          qFill.style.transition = 'none';
          qFill.setAttribute('stroke-dasharray', dashStr);
          qFill.setAttribute('stroke-dashoffset', offsetStr);
          qFill.getBoundingClientRect();
          qFill.style.transition = '';
        } else {
          setQuotaAttrIfChanged(qFill, 'stroke-dasharray', dashStr);
          setQuotaAttrIfChanged(qFill, 'stroke-dashoffset', offsetStr);
        }
        quotaBadgeLastHasFraction = true;
      }
    }
    if (qVal) {
      const hasNumericPct = view.activeStatus !== 'exhausted' && view.activeStatus !== 'no_permission' && view.activeStatus !== 'error' && view.activeStatus !== 'unknown' && view.badge.fraction != null;
      if (hasNumericPct) {
        animateQuotaPercentNode(qVal, view.badge.fraction, shouldAnimate, view.badge.text);
      } else {
        let dispVal = view.badge.text;
        if (view.activeStatus === 'exhausted') dispVal = t('quota.short.exhausted');
        else if (view.activeStatus === 'no_permission') dispVal = t('quota.short.no_permission');
        else if (view.activeStatus === 'error') dispVal = t('quota.short.error');
        else if (view.activeStatus === 'unknown' || view.badge.fraction == null) {
          dispVal = view.activeStatus === 'stale' ? t('quota.short.stale') : t('quota.short.unknown');
        }
        animateQuotaPercentNode(qVal, null, false, dispVal);
      }
    }
    if (qTag) {
      let dispTag = view.badge.tag;
      if (view.activeStatus === 'error') dispTag = t('quota.retry');
      else if (view.activeStatus === 'stale' && view.badge.fraction != null) dispTag = t('quota.short.stale');
      if (dispTag) {
        setQuotaHiddenIfChanged(qTag, false);
        setQuotaTextIfChanged(qTag, dispTag);
      } else {
        setQuotaHiddenIfChanged(qTag, true);
        setQuotaTextIfChanged(qTag, '');
      }
    }
    if (oQuotaVal) {
      const dispTxt = view.badge.fraction != null && view.activeStatus !== 'exhausted' && view.activeStatus !== 'no_permission' && view.activeStatus !== 'error'
        ? view.badge.text
        : (qVal ? qVal.textContent : view.badge.text);
      const dispTag = (qTag && !qTag.hidden) ? qTag.textContent : '';
      setQuotaTextIfChanged(oQuotaVal, dispTag ? `${dispTxt} · ${dispTag}` : dispTxt);
    }

    // 2. 刷新按钮与横幅渲染（请求中维持现有文字、宽度与卡片数据，避免闪烁与布局抽动）
    const btnRefresh = el('btn-quota-refresh');
    const txtRefresh = el('quota-refresh-text');
    if (btnRefresh) {
      if (Boolean(btnRefresh.disabled) !== Boolean(quotaState.busy)) {
        btnRefresh.disabled = Boolean(quotaState.busy);
      }
      setQuotaAttrIfChanged(btnRefresh, 'data-busy', quotaState.busy ? 'true' : 'false');
    }
    if (txtRefresh) {
      setQuotaTextIfChanged(txtRefresh, t('quota.refresh.btn'));
    }

    const tierPill = el('quota-plan-tier-pill');
    if (tierPill) {
      const tierTxt = view.planTierName || ANTIGRAVITY_TOKEN_DATA.planStatus?.tierName || '';
      if (tierTxt && tierTxt !== '未知') {
        setQuotaHiddenIfChanged(tierPill, false);
        setQuotaTextIfChanged(tierPill, tierTxt);
      } else {
        setQuotaHiddenIfChanged(tierPill, true);
      }
    }

    const bannerEl = el('quota-banner');
    const bannerTextEl = el('quota-banner-text');
    const bannerRetryBtn = el('btn-quota-banner-retry');
    const bannerRestartBtn = el('btn-quota-banner-restart');
    if (bannerEl && bannerTextEl) {
      const currentVer = METER_RENDERER_VERSION;
      const isBridgeMissing = quotaState.errorKind === 'bridge_unavailable';
      const observedBackendVer = backendStatus.backendVersion || quotaState.collectorVersion || null;
      const isStaleCollectorAfterUpdate = false;
      const isExplicitBackendMismatch = Boolean(
        !isBridgeMissing &&
        observedBackendVer &&
        observedBackendVer !== currentVer &&
        (backendStatus.hotReloadFallback || backendStatus.backendVersionMismatch)
      );
      const needsRestartAction = isBridgeMissing || isStaleCollectorAfterUpdate || isExplicitBackendMismatch;
      if (bannerRestartBtn) {
        setQuotaHiddenIfChanged(bannerRestartBtn, !(needsRestartAction && hostSupportsRestart));
      }
      if (bannerRetryBtn) {
        setQuotaHiddenIfChanged(bannerRetryBtn, isBridgeMissing);
      }

      if (isBridgeMissing) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const msg = hostSupportsRestart
          ? t('quota.bridgeMissing')
          : `${t('quota.bridgeMissing')} ${t('client.restart.hostNotSupported')}`;
        setQuotaTextIfChanged(bannerTextEl, msg);
      } else if (isStaleCollectorAfterUpdate) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const msg = hostSupportsRestart
          ? t('quota.pendingRestartBanner')
          : `${t('quota.pendingRestartBanner')} ${t('client.restart.hostNotSupported')}`;
        setQuotaTextIfChanged(bannerTextEl, msg);
      } else if (isExplicitBackendMismatch) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const baseMsg = t('quota.backendMismatchBanner', {
          uiVer: currentVer,
          backendVer: `v${observedBackendVer}`,
          source: backendStatus.backendSource || 'host'
        });
        const msg = hostSupportsRestart ? baseMsg : `${baseMsg} ${t('client.restart.hostNotSupported')}`;
        setQuotaTextIfChanged(bannerTextEl, msg);
      } else if (view.syncState === 'error' && view.lastError) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'error');
        setQuotaTextIfChanged(bannerTextEl, t('quota.errorBanner', { reason: view.lastError }));
      } else if (view.syncState === 'stale') {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const staleReason = view.lastError
          || (view.pools.some(p => p.isResetPassed && p.remainingFraction === 0) ? t('quota.resetPassReason') : t('quota.ageExpiredReason'));
        setQuotaTextIfChanged(bannerTextEl, t('quota.staleBanner', { reason: staleReason }));
      } else {
        setQuotaHiddenIfChanged(bannerEl, true);
      }
    }

    // 顶栏精简更新时间渲染（完整日期时间写入 title）
    const tUpd = el('quota-time-updated');
    if (tUpd) {
      const hm = formatQuotaTimeShortHM(view.fetchedAtMs);
      const updShort = hm ? t('quota.time.updated', { time: hm }) : '—';
      const updFull = hm
        ? t('quota.time.updated', { time: formatQuotaDateTime(view.fetchedAtMs) })
        : t('quota.time.unknown');
      setQuotaTextIfChanged(tUpd, updShort);
      if (tUpd.title !== updFull) tUpd.title = updFull;
    }

    // 当前会话模型概览卡片
    const curModelEl = el('quota-cur-model');
    const curPoolEl = el('quota-cur-pool');
    const curEstEl = el('quota-cur-est');
    const curStatusEl = el('quota-cur-status');
    const curHeroPctEl = el('quota-cur-hero-pct');
    const curAlertEl = el('quota-cur-alert');
    const curBucketsEl = el('quota-cur-buckets');

    const matchedPoolObj = view.pools.find(p => p.poolKey === view.currentModel?.poolKey);

    if (curModelEl) {
      setQuotaTextIfChanged(curModelEl, view.currentModel?.productLabel || t('quota.current.unmatched'));
    }
    if (curPoolEl) {
      setQuotaTextIfChanged(curPoolEl, view.currentModel?.poolTitle ? `${view.currentModel.poolTitle}` : '');
    }
    if (curHeroPctEl) {
      const heroHasPct = view.activeStatus !== 'no_permission' && view.activeStatus !== 'error' && view.activeStatus !== 'unknown' && view.badge.fraction != null;
      if (heroHasPct) {
        setQuotaHiddenIfChanged(curHeroPctEl, false);
        setQuotaAttrIfChanged(curHeroPctEl, 'data-status', view.activeStatus || 'available');
        setQuotaTextIfChanged(curHeroPctEl, view.badge.text || `${Math.round(view.badge.fraction * 100)}%`);
      } else {
        setQuotaHiddenIfChanged(curHeroPctEl, true);
        setQuotaTextIfChanged(curHeroPctEl, '');
      }
    }
    if (curEstEl) {
      const curEstMeta = !view.currentModel?.noPermission && matchedPoolObj?.primaryBucket?.tokenEstimate
        ? formatBucketTokenEstimateMeta(matchedPoolObj.primaryBucket.tokenEstimate)
        : { text: '', title: '' };
      if (curEstMeta.text) {
        setQuotaHiddenIfChanged(curEstEl, false);
        setQuotaTextIfChanged(curEstEl, curEstMeta.text);
        if (curEstEl.title !== curEstMeta.title) curEstEl.title = curEstMeta.title;
      } else {
        setQuotaHiddenIfChanged(curEstEl, true);
        setQuotaTextIfChanged(curEstEl, '');
        if (curEstEl.title) curEstEl.title = '';
      }
    }
    if (curStatusEl) {
      setQuotaClassIfChanged(curStatusEl, `key-pill ${getQuotaPillClass(view.activeStatus)}`);
      setQuotaTextIfChanged(curStatusEl, getQuotaStatusLabelText(view.activeStatus));
    }
    if (curAlertEl) {
      if (view.currentModel?.noPermission && view.currentModel?.unavailabilityReason) {
        setQuotaHiddenIfChanged(curAlertEl, false);
        setQuotaAttrIfChanged(curAlertEl, 'data-kind', 'noperm');
        setQuotaTextIfChanged(curAlertEl, view.currentModel.unavailabilityReason);
      } else if (
        view.currentModel?.noticeText &&
        !/^(?:new|beta|preview|updated|notice|recommended)$/i.test(String(view.currentModel.noticeText).trim())
      ) {
        setQuotaHiddenIfChanged(curAlertEl, false);
        setQuotaAttrIfChanged(curAlertEl, 'data-kind', 'notice');
        setQuotaTextIfChanged(curAlertEl, `Notice: ${view.currentModel.noticeText}`);
      } else {
        setQuotaHiddenIfChanged(curAlertEl, true);
      }
    }
    if (curBucketsEl) {
      renderQuotaBucketsContainer(
        curBucketsEl,
        matchedPoolObj?.buckets || [],
        view.currentModel?.noPermission ? 'no_permission' : null,
        { animate: shouldAnimate, nowMs, chargeTargets: view.currentModel?.noPermission ? null : chargeBarTargets }
      );
    }

    // 共享额度池列表（原地复用已有 DOM 卡片，禁止整块摧毁重排，兼顾轻量 mock DOM）
    const listEl = el('quota-pools-list');
    if (listEl) {
      if (!view.pools.length) {
        let emptyEl = Array.from(listEl.children || []).find(ch => String(ch.className || '').includes('quota-pools-empty-state')) || null;
        if (!emptyEl) {
          emptyEl = document.createElement('div');
          emptyEl.className = 'quota-pools-empty-state';
          if (emptyEl.style) emptyEl.style.cssText = 'font-size:11px;color:var(--ag-text-muted);padding:10px;text-align:center;border:1px dashed var(--ag-border-subcard);border-radius:7px';
        }
        setQuotaTextIfChanged(emptyEl, t('quota.pools.empty'));
        reconcileQuotaChildOrder(listEl, [emptyEl]);
      } else {
        const existingCards = new Map();
        for (const ch of Array.from(listEl.children || [])) {
          const pk = getChildAttr(ch, 'data-pool-key');
          if (pk) existingCards.set(pk, ch);
        }

        const desiredCards = [];
        for (let pIdx = 0; pIdx < view.pools.length; pIdx++) {
          const pool = view.pools[pIdx];
          const isCurrentPool = Boolean(view.currentModel?.poolKey && pool.poolKey === view.currentModel.poolKey);
          const isBrowsing = Boolean(view.browsePoolKey && pool.poolKey === view.browsePoolKey);

          let card = existingCards.get(pool.poolKey);
          let refs = card ? quotaNodeRefsMap.get(card) : null;

          if (!card || !refs) {
            card = document.createElement('div');
            card.className = 'quota-pool-card';
            card.setAttribute('data-pool-key', pool.poolKey);
            card.addEventListener('click', () => {
              quotaState.browsePoolKey = pool.poolKey;
              renderQuotaBoard(Date.now(), { animate: false });
            });

            const top = document.createElement('div');
            top.className = 'quota-pool-top';
            const titleEl = document.createElement('div');
            titleEl.className = 'quota-pool-title';
            const tagsEl = document.createElement('div');
            tagsEl.className = 'quota-pool-tags';
            const curTagEl = document.createElement('span');
            curTagEl.className = 'quota-current-tag';
            curTagEl.hidden = true;
            const stPill = document.createElement('span');
            stPill.className = 'key-pill quota-pool-status-pill';
            tagsEl.appendChild(curTagEl);
            tagsEl.appendChild(stPill);
            top.appendChild(titleEl);
            top.appendChild(tagsEl);

            const reasonEl = document.createElement('div');
            reasonEl.className = 'quota-pool-reason';
            if (reasonEl.style) reasonEl.style.cssText = 'font-size:10.5px;color:var(--ag-text-muted);margin-bottom:4px';
            reasonEl.hidden = true;

            const bucketsBox = document.createElement('div');
            bucketsBox.className = 'quota-buckets-list';

            const chipsBox = document.createElement('div');
            chipsBox.className = 'quota-models-chips';

            card.appendChild(top);
            card.appendChild(reasonEl);
            card.appendChild(bucketsBox);
            card.appendChild(chipsBox);
            refs = { titleEl, curTagEl, stPill, reasonEl, bucketsBox, chipsBox };
            quotaNodeRefsMap.set(card, refs);
          }

          const { titleEl, curTagEl, stPill, reasonEl, bucketsBox, chipsBox } = refs;

          if (isCurrentPool) setQuotaAttrIfChanged(card, 'data-active-current', 'true');
          else removeQuotaAttrIfPresent(card, 'data-active-current');
          if (isBrowsing) setQuotaAttrIfChanged(card, 'data-browsing', 'true');
          else removeQuotaAttrIfPresent(card, 'data-browsing');

          if (titleEl) setQuotaTextIfChanged(titleEl, pool.title);
          if (curTagEl) {
            if (isCurrentPool) {
              setQuotaHiddenIfChanged(curTagEl, false);
              setQuotaTextIfChanged(curTagEl, t('quota.current.tag'));
            } else {
              setQuotaHiddenIfChanged(curTagEl, true);
            }
          }
          if (stPill) {
            const pStatus = pool.noPermission ? 'no_permission' : (pool.status || 'unknown');
            setQuotaClassIfChanged(stPill, `key-pill quota-pool-status-pill ${getQuotaPillClass(pStatus)}`);
            const pctStr = !pool.noPermission && pool.percentText && pool.percentText !== '未知' ? ` · ${pool.percentText}` : '';
            setQuotaTextIfChanged(stPill, `${getQuotaStatusLabelText(pStatus)}${pctStr}`);
          }

          if (pool.noPermission && pool.unavailabilityReason) {
            if (reasonEl) {
              setQuotaHiddenIfChanged(reasonEl, false);
              setQuotaTextIfChanged(reasonEl, pool.unavailabilityReason);
            }
            if (bucketsBox) {
              setQuotaHiddenIfChanged(bucketsBox, true);
              renderQuotaBucketsContainer(bucketsBox, [], null, { animate: false, nowMs });
            }
          } else {
            if (reasonEl) setQuotaHiddenIfChanged(reasonEl, true);
            if (bucketsBox) {
              if (pool.buckets && pool.buckets.length) {
                setQuotaHiddenIfChanged(bucketsBox, false);
                renderQuotaBucketsContainer(bucketsBox, pool.buckets, null, { animate: shouldAnimate, nowMs, chargeTargets: chargeBarTargets });
              } else {
                setQuotaHiddenIfChanged(bucketsBox, true);
                renderQuotaBucketsContainer(bucketsBox, [], null, { animate: false, nowMs });
              }
            }
          }

          if (chipsBox) {
            const modelsList = Array.isArray(pool.models) ? pool.models : [];
            if (!modelsList.length) {
              setQuotaHiddenIfChanged(chipsBox, true);
              setQuotaTextIfChanged(chipsBox, '');
              if (chipsBox.title) chipsBox.title = '';
            } else {
              setQuotaHiddenIfChanged(chipsBox, false);
              const names = modelsList.map(m => String(m.productLabel || '').trim()).filter(Boolean);
              const countPrefix = currentPanelLanguage === 'en'
                ? `${names.length} ${names.length === 1 ? 'model' : 'models'}: `
                : (currentPanelLanguage === 'zh-TW' ? `含 ${names.length} 個模型：` : `含 ${names.length} 个模型：`);
              const summaryText = `${countPrefix}${names.join(' · ')}`;
              const fullTitle = modelsList.map(m => {
                const name = String(m.productLabel || '').trim();
                return m.noPermission ? `${name} (${t('quota.short.no_permission')})` : name;
              }).filter(Boolean).join('\n');
              const chipsSig = `${currentPanelLanguage}|${summaryText}|${fullTitle}`;
              if (getChildAttr(chipsBox, 'data-chips-sig') !== chipsSig) {
                chipsBox.setAttribute('data-chips-sig', chipsSig);
                setQuotaTextIfChanged(chipsBox, summaryText);
                if (chipsBox.title !== fullTitle) chipsBox.title = fullTitle;
              }
            }
          }
          desiredCards.push(card);
        }
        reconcileQuotaChildOrder(listEl, desiredCards);
      }
    }

    if (
      savedScrollTop !== null &&
      savedScrollTop > 0 &&
      viewQuotaBody &&
      el('panel-quota') &&
      !el('panel-quota').hidden &&
      Math.abs((viewQuotaBody.scrollTop || 0) - savedScrollTop) > 1
    ) {
      viewQuotaBody.scrollTop = savedScrollTop;
    }

    if (renderOpts.chargeBars) {
      if (isQuotaReducedMotion()) {
        showQuotaUpToDateFeedback();
      } else if (chargeBarTargets && chargeBarTargets.length > 0) {
        triggerQuotaBarsChargeAnimation(chargeBarTargets);
      }
    }

    syncModelListQuotaIndicators(view, nowMs);
    scheduleQuotaResetConfirmIfNeeded(view, nowMs);
  }

  function scheduleQuotaResetConfirmIfNeeded(view, nowMs = Date.now()) {
    if (state.disposed) return;
    if (quotaResetTimer) { clearTimeout(quotaResetTimer); quotaResetTimer = null; }
    // 找到未来最近的 resetAtMs 并设定到点 +2s 自动刷新；若刚过 reset 且尚未确认重拉则安排一次即时确认
    let soonestFutureMs = null;
    let passedKey = null;
    for (const p of (view.pools || [])) {
      for (const b of (p.buckets || [])) {
        if (!b.hasResetTime || !Number.isFinite(b.resetAtMs)) continue;
        if (b.resetAtMs > nowMs) {
          if (soonestFutureMs === null || b.resetAtMs < soonestFutureMs) soonestFutureMs = b.resetAtMs;
        } else if (b.remainingFraction === 0) {
          const rKey = `${p.poolKey}:${b.bucketId}:${b.resetTimeIso}`;
          if (quotaState.lastResetRequeryKey !== rKey) {
            passedKey = rKey;
          }
        }
      }
    }
    if (passedKey && !quotaState.busy) {
      quotaState.lastResetRequeryKey = passedKey;
      quotaResetTimer = setTimeout(() => { void syncQuotaFromHost(true); }, 1500);
      return;
    }
    if (soonestFutureMs !== null) {
      const waitMs = Math.min(2147483000, Math.max(2000, soonestFutureMs - nowMs + 2000));
      quotaResetTimer = setTimeout(() => { void syncQuotaFromHost(true); }, waitMs);
    }
  }

  function scheduleQuotaAutoRefresh(delayMs = null) {
    if (state.disposed) return;
    if (quotaAutoTimer) { clearTimeout(quotaAutoTimer); quotaAutoTimer = null; }
    const isWindowActive = host.getAttribute('data-window-active') !== 'false' && (typeof document === 'undefined' || !document.hidden);
    let interval = delayMs;
    if (!Number.isFinite(interval) || interval <= 0) {
      if (quotaState.consecutiveErrors > 0) {
        interval = Math.min(180000, 30000 * Math.pow(2, Math.min(2, quotaState.consecutiveErrors - 1)));
      } else {
        interval = isWindowActive ? QUOTA_REFRESH_FG_MS : QUOTA_REFRESH_BG_MS;
      }
    }
    quotaState.nextRefreshAtMs = Date.now() + interval;
    quotaAutoTimer = setTimeout(() => {
      quotaAutoTimer = null;
      if (!state.disposed) void syncQuotaFromHost(false, { silent: true });
    }, interval);
  }

  function onQuotaWindowFocus() {
    if (state.disposed) return;
    quotaState.autoPaused = false;
    const elapsed = quotaState.lastFetchedAtMs ? (Date.now() - quotaState.lastFetchedAtMs) : Infinity;
    if (elapsed >= 20000 && !quotaState.busy) {
      void syncQuotaFromHost(false, { silent: true });
    } else {
      scheduleQuotaAutoRefresh();
    }
  }

  function onQuotaWindowBlur() {
    if (state.disposed) return;
    scheduleQuotaAutoRefresh(QUOTA_REFRESH_BG_MS);
  }

  function scheduleQuotaPostTurnRefresh() {
    if (state.disposed) return;
    if (quotaPostTurnTimer) clearTimeout(quotaPostTurnTimer);
    quotaPostTurnTimer = setTimeout(() => {
      quotaPostTurnTimer = null;
      const elapsed = quotaState.lastFetchedAtMs ? (Date.now() - quotaState.lastFetchedAtMs) : Infinity;
      if (!state.disposed && !quotaState.busy && elapsed > 5000) {
        void syncQuotaFromHost(true);
      }
    }, 1500);
  }

  async function maybeRefreshQuotaOnOpen() {
    const elapsed = quotaState.lastFetchedAtMs ? (Date.now() - quotaState.lastFetchedAtMs) : Infinity;
    if (!quotaState.snapshot || elapsed > 15000) {
      await syncQuotaFromHost(false);
    }
  }

  function mergeQuotaConfigsPreservingCapabilities(prevConfigs, nextConfigs) {
    if (!Array.isArray(nextConfigs) || !nextConfigs.length) return Array.isArray(prevConfigs) ? prevConfigs : [];
    const prevById = new Map();
    if (Array.isArray(prevConfigs)) {
      for (const item of prevConfigs) {
        const key = String(item?.model || item?.modelId || item?.modelOrAlias?.model || '').trim().toLowerCase();
        if (key) prevById.set(key, item);
      }
    }
    return nextConfigs.map(cfg => {
      if (!cfg || typeof cfg !== 'object') return cfg;
      const key = String(cfg.model || cfg.modelId || cfg.modelOrAlias?.model || '').trim().toLowerCase();
      const prev = key ? prevById.get(key) : null;
      if (!prev) return cfg;
      const merged = { ...cfg };
      for (const field of ['maxTokens', 'maxOutputTokens', 'thinkingBudget', 'minThinkingBudget', 'thinkingLevel', 'supportsModelInfoOverride', 'capabilitySource']) {
        if ((merged[field] == null || merged[field] === '') && prev[field] != null && prev[field] !== '') {
          merged[field] = prev[field];
        }
      }
      return merged;
    });
  }

  async function syncQuotaFromHost(force = false, meta = {}) {
    if (state.disposed) return null;
    if (quotaInFlightPromise) {
      return quotaInFlightPromise;
    }

    const isManual = Boolean(meta.manual);
    const isSilent = Boolean(meta.silent) && !isManual;
    if (isManual) triggerQuotaRefreshIconSpin();
    const runner = (async () => {
      const prevSig = computeQuotaVisualSignature(computeEffectiveQuotaView(Date.now()));
      quotaState.busy = true;
      renderQuotaBoard(Date.now(), { animate: false, consumeAnim: false });
      let payload = null;
      let rpcErr = null;
      let missingBridge = false;
      let usedBackendSource = null;
      const reqStartMs = Date.now();
      try {
        const hasIpcGetQuota = typeof window !== 'undefined' && typeof window.contextMeterAPI?.getQuota === 'function';
        const hasLivePort = hasLiveHttpBridge() && hasLiveRouteCapability('/quota');
        if (!hasIpcGetQuota && !hasLivePort) {
          missingBridge = true;
          rpcErr = t('quota.bridgeMissing');
        } else {
          quotaAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const out = await callBackendWithPriority({
            ipcCall: hasIpcGetQuota ? () => window.contextMeterAPI.getQuota({ force: Boolean(force) }) : null,
            liveRoute: '/quota',
            liveBody: {
              force: Boolean(force),
              origin: typeof window !== 'undefined' ? (window.location?.origin || undefined) : undefined
            },
            liveFetchOpts: { signal: quotaAbortController?.signal }
          });
          usedBackendSource = out.source;
          const resObj = out.result;
          if (resObj?.ok && resObj.data) {
            payload = resObj.data;
          } else if (resObj?.error) {
            rpcErr = resObj.error;
          }
        }
      } catch (e) {
        if (e?.name !== 'AbortError') {
          rpcErr = e?.message || '请求模型额度失败';
        }
      } finally {
        quotaAbortController = null;
      }

      if (state.disposed) return null;
      const nowMs = Date.now();
      const quotaDurationMs = nowMs - reqStartMs;
      quotaState.busy = false;
      quotaState.lastFetchedAtMs = nowMs;

      if (payload) {
        if (payload.accountSwitched || (payload.accountScopeKey && quotaState.accountScopeKey && payload.accountScopeKey !== quotaState.accountScopeKey)) {
          clearQuotaBarChargeAnimations();
          quotaState.snapshot = null;
          quotaState.rawInput = null;
          quotaState.browsePoolKey = null;
          quotaState.lastResetRequeryKey = null;
          quotaLastEstComputeSig = '';
          quotaCachedEstByKey = null;
        }
        if (payload.accountScopeKey) quotaState.accountScopeKey = payload.accountScopeKey;
        if (payload.collectorVersion) quotaState.collectorVersion = payload.collectorVersion;
        if (usedBackendSource) {
          syncObservedBackendMeta(usedBackendSource, payload, quotaDurationMs);
          if (backendStatus.backendVersion === METER_RENDERER_VERSION && !backendStatus.backendVersionMismatch) {
          }
        }

        if (payload.ok !== false) {
          quotaState.snapshot = payload.snapshot || null;
          quotaState.rawInput = null;
          quotaState.lastSuccessAtMs = payload.lastSuccessAtMs || payload.fetchedAtMs || nowMs;
          quotaState.error = null;
          quotaState.errorKind = null;
          quotaState.consecutiveErrors = 0;
          const livePlanIncoming = payload.planStatus || (payload.planTierSummary ? { ...payload.planTierSummary } : null);
          if (livePlanIncoming && typeof livePlanIncoming === 'object') {
            const coreRef = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
            const prevRaw = ANTIGRAVITY_TOKEN_DATA.rawPlanStatus || ANTIGRAVITY_TOKEN_DATA.planStatus || {};
            const mergedRaw = {
              ...prevRaw,
              ...livePlanIncoming,
              promptCredits: livePlanIncoming.promptCredits || prevRaw.promptCredits || null,
              flowCredits: livePlanIncoming.flowCredits || prevRaw.flowCredits || null,
              email: livePlanIncoming.email || prevRaw.email || null
            };
            const curEmail = mergedRaw.email || 'default';
            const customObj = lastSavedCustomPlan || ANTIGRAVITY_TOKEN_DATA.customPlanSettings || null;
            const resolvedPlan = (coreRef && typeof coreRef.resolveEffectivePlanStatus === 'function')
              ? coreRef.resolveEffectivePlanStatus(mergedRaw, customObj, { currentEmail: curEmail })
              : mergedRaw;
            ANTIGRAVITY_TOKEN_DATA.rawPlanStatus = mergedRaw;
            ANTIGRAVITY_TOKEN_DATA.planStatus = resolvedPlan;
            renderPlanDetail(resolvedPlan);
          }
          if (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0) {
            state.cascadeModelConfigs = mergeQuotaConfigsPreservingCapabilities(
              payload.accountSwitched ? [] : state.cascadeModelConfigs,
              payload.cascadeModelConfigs
            );
            renderHeaderModelDropdown();
            syncContextModelSelectionFromState();
            if (!isContextSettingsView && activeContextTab === 'models') {
              renderModelSettingsTab();
            }
          }
        } else {
          quotaState.error = payload.error || '刷新失败';
          quotaState.errorKind = payload.errorKind || 'network';
          quotaState.consecutiveErrors += 1;
          if (payload.snapshot && !quotaState.snapshot) {
            quotaState.snapshot = payload.snapshot;
          }
        }
      } else if (rpcErr) {
        quotaState.error = rpcErr;
        quotaState.errorKind = missingBridge ? 'bridge_unavailable' : 'network';
        quotaState.consecutiveErrors += 1;
      }

      const nextView = computeEffectiveQuotaView(nowMs);
      const nextSig = computeQuotaVisualSignature(nextView);
      const hasDataChanged = nextSig !== prevSig;
      const requestSucceeded = Boolean(payload && payload.ok !== false && !rpcErr && !quotaState.error);
      const shouldAnimateChange = Boolean(hasDataChanged && !quotaState.error && prevSig !== 'empty' && !isSilent);
      const panelQuotaEl = el('panel-quota');
      const shouldChargeBars = Boolean(isManual && requestSucceeded && panelQuotaEl && !panelQuotaEl.hidden);
      quotaPendingSmoothAnim = shouldAnimateChange;
      if (!hasDataChanged && isManual && requestSucceeded) {
        showQuotaUpToDateFeedback();
      } else if (hasDataChanged || !requestSucceeded) {
        hideQuotaRefreshFeedback();
      }

      if (missingBridge) {
        clearQuotaTimers();
        quotaState.nextRefreshAtMs = null;
      } else {
        scheduleQuotaAutoRefresh();
      }
      renderQuotaBoard(nowMs, { animate: shouldAnimateChange, chargeBars: shouldChargeBars });
      return quotaState.snapshot;
    })();

    quotaInFlightPromise = runner;
    try {
      return await runner;
    } finally {
      if (quotaInFlightPromise === runner) quotaInFlightPromise = null;
    }
  }

  el('btn-quota-refresh')?.addEventListener('click', () => {
    void syncQuotaFromHost(true, { manual: true });
  });
  el('btn-quota-banner-retry')?.addEventListener('click', () => {
    void syncQuotaFromHost(true, { manual: true });
  });

  const btnQuotaBannerRestartInit = el('btn-quota-banner-restart');
  if (btnQuotaBannerRestartInit) {
    btnQuotaBannerRestartInit.hidden = true;
    btnQuotaBannerRestartInit.addEventListener('click', () => {
      openClientRestartConfirmFlow();
    });
  }
  renderQuotaBoard();

  async function verifyHotReloadAndRefreshQuota() {
    if (state.disposed) return null;
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getRuntimeInfo === 'function') {
      try {
        const rt = await window.contextMeterAPI.getRuntimeInfo();
        if (rt && rt.ok && rt.backendVersion) {
          backendStatus.ipcBackendVersion = String(rt.backendVersion);
        }
      } catch { }
    }
    if (hasLiveHttpBridge() && shouldPreferLiveHost(typeof window?.contextMeterAPI?.getQuota === 'function', '/runtime-info')) {
      try {
        const liveRt = await postLiveHttpEndpoint('/runtime-info', {});
        if (liveRt && liveRt.ok) {
          syncObservedBackendMeta('live-host', liveRt);
        }
      } catch {
        backendStatus.liveHealthy = false;
      }
    }
    const snap = await syncQuotaFromHost(true);
    return {
      rendererVersion: METER_RENDERER_VERSION,
      backendSource: backendStatus.backendSource,
      backendVersion: backendStatus.backendVersion,
      backendPid: backendStatus.backendPid,
      ipcBackendVersion: backendStatus.ipcBackendVersion,
      liveHostVersion: backendStatus.liveHostVersion,
      hotReloadFallback: backendStatus.hotReloadFallback,
      backendVersionMismatch: backendStatus.backendVersionMismatch,
      quotaAttempted: Boolean(quotaState.lastFetchedAtMs),
      quotaOk: Boolean(snap && !quotaState.error),
      quotaActiveStatus: computeEffectiveQuotaView(Date.now()).activeStatus,
      lastQuotaDurationMs: backendStatus.lastQuotaDurationMs
    };
  }


  function getModelQuotaStateForTestImpl(nowMs) {
    return {
      state: {
        accountScopeKey: quotaState.accountScopeKey,
        collectorVersion: quotaState.collectorVersion,
        browsePoolKey: quotaState.browsePoolKey,
        busy: quotaState.busy,
        lastFetchedAtMs: quotaState.lastFetchedAtMs,
        lastSuccessAtMs: quotaState.lastSuccessAtMs,
        nextRefreshAtMs: quotaState.nextRefreshAtMs,
        error: quotaState.error,
        errorKind: quotaState.errorKind,
        activeSessionModelKey
      },
      view: computeEffectiveQuotaView(Number.isFinite(nowMs) ? nowMs : Date.now())
    };
  }

  function setQuotaSnapshotForTestImpl(payload, nowMs) {
    const tNow = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (!payload) {
      resetQuotaState({ clearAccountScope: true });
      return computeEffectiveQuotaView(tNow);
    }
    const prevSig = computeQuotaVisualSignature(computeEffectiveQuotaView(tNow));
    if (payload.accountSwitched || (payload.accountScopeKey && quotaState.accountScopeKey && payload.accountScopeKey !== quotaState.accountScopeKey)) {
      resetQuotaState({ clearAccountScope: true });
    }
    if (payload.accountScopeKey) quotaState.accountScopeKey = payload.accountScopeKey;
    quotaState.error = payload.error || null;
    quotaState.errorKind = payload.errorKind || (payload.error ? 'network' : null);
    if (payload.fetchedAtMs !== undefined) quotaState.lastFetchedAtMs = payload.fetchedAtMs;
    if (payload.lastSuccessAtMs !== undefined) quotaState.lastSuccessAtMs = payload.lastSuccessAtMs;
    if (payload.nextRefreshAtMs !== undefined) quotaState.nextRefreshAtMs = payload.nextRefreshAtMs;
    if (payload.userStatusRes || payload.quotaSummaryRes || payload.cascadeModelConfigs) {
      const fallbackCfgs = (Array.isArray(state.cascadeModelConfigs) && state.cascadeModelConfigs.length > 0)
        ? state.cascadeModelConfigs
        : null;
      quotaState.rawInput = {
        userStatusRes: payload.userStatusRes || null,
        quotaSummaryRes: payload.quotaSummaryRes || null,
        cascadeModelConfigs: (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0)
          ? payload.cascadeModelConfigs
          : fallbackCfgs,
        planStatus: payload.planStatus || ANTIGRAVITY_TOKEN_DATA.planStatus || null
      };
      quotaState.snapshot = null;
      if (!payload.error && payload.lastSuccessAtMs === undefined) quotaState.lastSuccessAtMs = tNow;
    } else if (payload.snapshot !== undefined) {
      quotaState.snapshot = payload.snapshot;
      quotaState.rawInput = null;
      if (!payload.error && payload.lastSuccessAtMs === undefined && payload.snapshot?.fetchedAtMs) {
        quotaState.lastSuccessAtMs = payload.snapshot.fetchedAtMs;
      }
    }
    const nextSig = computeQuotaVisualSignature(computeEffectiveQuotaView(tNow));
    const shouldAnimate = Boolean(prevSig !== 'empty' && nextSig !== prevSig && !quotaState.error);
    renderQuotaBoard(tNow, { animate: shouldAnimate });
    return computeEffectiveQuotaView(tNow);
  }

  function selectQuotaPoolBrowseForTestImpl(poolKey) {
    quotaState.browsePoolKey = poolKey || null;
    renderQuotaBoard();
    return { browsePoolKey: quotaState.browsePoolKey, activeSessionModelKey };
  }

  function showQuotaPanelForTestImpl(open = true) {
    showPanel(open ? 'quota' : 'none');
    return !el('panel')?.hidden && !el('panel-quota')?.hidden;
  }
  function renderHeatmapGrid(forceRebuild = false) {
    const colsBox = el('h-grid-cols');
    const monthsBox = el('h-months');
    if (!colsBox || !monthsBox) return;
    const win = computeTimelineWindow();
    const sig = `${win.firstStr}:${formatLocalYmd(win.winStart)}:${Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap).length}`;
    if (!forceRebuild && colsBox.children.length > 0 && colsBox.getAttribute('data-sig') === sig) return;

    colsBox.replaceChildren();
    monthsBox.replaceChildren();
    colsBox.setAttribute('data-sig', sig);

    const todayKey = formatLocalYmd(win.today);
    const list = [];
    for (let i = 0; i < win.totalDays; i++) {
      const d = addDays(win.winStart, i);
      const key = formatLocalYmd(d);
      const isFuture = d.getTime() > win.today.getTime();
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[key];
      list.push({ date: d, key, tokens: rec ? rec.total : 0, rec, isFuture, isToday: key === todayKey });
    }

    const monthMarkers = [];
    let lastM = -1;
    let lastCol = -10;

    for (let c = 0; c < 52; c++) {
      const col = document.createElement('div');
      col.className = 'heat-week-col';
      const slice = list.slice(c * 7, (c + 1) * 7);
      const mNum = slice[0].date.getMonth() + 1;
      if (mNum !== lastM) {
        if (c - lastCol >= 3 && 52 - c >= 2) {
          monthMarkers.push({ month: mNum, colIdx: c });
          lastCol = c;
        }
        lastM = mNum;
      }

      slice.forEach(item => {
        const cell = document.createElement('div');
        const lvl = getLvl(item.tokens);
        cell.className = `heat-cell lvl-${lvl}${item.isFuture ? ' is-future' : ''}${item.isToday ? ' is-today' : ''}`;
        cell.setAttribute('data-date', item.key);
        cell.setAttribute('data-tokens', String(item.tokens));

        const showPop = () => {
          const d = item.date;
          const dateLabel = currentPanelLanguage === 'en'
            ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
          heatPopDate.textContent = `${dateLabel}${item.isToday ? t('heat.today') : (item.key === win.firstStr ? t('heat.firstUse') : '')}`;
          const costInfo = getDailyModelCost(item.rec, item.key, activeCostModel, { mode: activeCostMode });
          const costStr = costInfo.costUSD > 0 ? ` · ≈ $${costInfo.costUSD.toFixed(2)}` : '';
          heatPopVal.textContent = item.tokens > 0 ? `${fmtYi(item.tokens)} Tokens${costStr}` : (item.isFuture ? t('heat.future') : '0 Tokens');
          if (item.rec) {
            heatPopDet.innerHTML = `
              <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(item.rec.input)}</span><span class="pop-det-trans">${t('heat.prompt')}</span></div>
              <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(item.rec.output)}</span><span class="pop-det-trans">${t('heat.output')}</span></div>
              <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(item.rec.cache)}</span><span class="pop-det-trans">${t('heat.cache')}</span></div>
            `.trim();
            heatPopDet.style.display = 'flex';
          } else {
            heatPopDet.style.display = 'none';
          }
          const r = cell.getBoundingClientRect();
          heatPop.style.left = `${r.left + r.width / 2}px`;
          heatPop.style.top = `${r.top - 6}px`;
          heatPop.style.opacity = '1';
        };

        cell.addEventListener('mouseenter', showPop);
        cell.addEventListener('mouseleave', hidePopover);
        cell.addEventListener('click', showPop);

        col.appendChild(cell);
      });
      colsBox.appendChild(col);
    }

    const shortMonthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    monthMarkers.forEach(mm => {
      const lbl = document.createElement('span');
      lbl.className = 'heat-month-item';
      lbl.style.left = `${mm.colIdx * 11.5}px`;
      lbl.textContent = currentPanelLanguage === 'en' ? (shortMonthsEn[mm.month - 1] || `${mm.month}`) : `${mm.month}月`;
      monthsBox.appendChild(lbl);
    });

    updateSummaryBar('daily', list.map(x => x.key));
  }

  function renderHeatmapWeekly() {
    const box = el('h-weekly-box');
    if (!box) return;
    box.replaceChildren();

    const scale = getEffectiveHeatmapScale();
    const [cEmpty, c1, c2, c3, c4] = scale;
    const win = computeTimelineWindow();
    const totalWeeks = 52;
    const weeksData = [];
    let max = 1;

    for (let c = 0; c < totalWeeks; c++) {
      let sum = 0;
      let sDate = null, eDate = null;
      for (let r = 0; r < 7; r++) {
        const d = addDays(win.winStart, c * 7 + r);
        const k = formatLocalYmd(d);
        if (!sDate) sDate = d;
        eDate = d;
        const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
        if (rec) sum += rec.total;
      }
      if (sum > max) max = sum;
      weeksData.push({ sum, sDate, eDate, startKey: formatLocalYmd(sDate) });
    }

    weeksData.forEach(w => {
      const col = document.createElement('div');
      col.className = 'w-bar-col';
      col.setAttribute('data-week-start', w.startKey);
      const fill = document.createElement('div');
      fill.className = 'w-bar-fill';
      const pct = Math.max(3, (w.sum / max) * 100);
      fill.style.height = `${pct}%`;
      const lvl = getLvlForRange(w.sum, 'week', max);
      fill.style.backgroundColor = w.sum === 0 ? cEmpty : (scale[lvl] || c4);
      col.appendChild(fill);

      const showPop = () => {
        const weekDates = [];
        for (let r = 0; r < 7; r++) weekDates.push(formatLocalYmd(addDays(w.sDate, r)));
        const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, weekDates, activeCostModel, {
          mode: activeCostMode,
          todayStr: formatLocalYmd(win.today)
        });
        const costStr = costAgg.totalCostUSD > 0 ? ` · ≈ $${costAgg.totalCostUSD.toFixed(2)}` : '';
        heatPopDate.textContent = `${w.sDate.getFullYear()}.${w.sDate.getMonth() + 1}.${w.sDate.getDate()} - ${w.eDate.getMonth() + 1}.${w.eDate.getDate()}`;
        heatPopVal.textContent = w.sum > 0 ? `${fmtYi(w.sum)} Tokens${costStr}` : '0 Tokens';
        heatPopDet.innerHTML = `<span>${t('heat.weeklyTotal', { avg: costAgg.dailyAverageUSD.toFixed(2) })}</span>`;
        heatPopDet.style.display = 'block';
        const r = col.getBoundingClientRect();
        heatPop.style.left = `${r.left + r.width / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      col.addEventListener('mouseenter', showPop);
      col.addEventListener('mouseleave', hidePopover);
      col.addEventListener('click', showPop);

      box.appendChild(col);
    });

    const allWinDates = [];
    for (let i = 0; i < win.totalDays; i++) allWinDates.push(formatLocalYmd(addDays(win.winStart, i)));
    updateSummaryBar('weekly', allWinDates);
  }

  function renderHeatmapCum() {
    const cvs = el('h-cum-canvas');
    if (!cvs || !cvs.getContext) return;
    const ctx = cvs.getContext('2d');
    const rect = cvs.getBoundingClientRect ? cvs.getBoundingClientRect() : { width: 670 };
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const width = (rect.width || 670);
    const height = 100;
    cvs.width = width * dpr;
    cvs.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const win = computeTimelineWindow();
    const map = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const winStartKey = formatLocalYmd(win.winStart);
    // 计算窗口起点之前的历史滚存基数（支持跨年翻页时累计曲线连续）
    let running = 0;
    for (const [k, rec] of Object.entries(map)) {
      if (k < winStartKey && rec?.total > 0) running += rec.total;
    }

    const activeEnd = win.winEnd.getTime() > win.today.getTime() ? win.today : win.winEnd;
    const plotDays = Math.max(1, Math.floor((activeEnd.getTime() - win.winStart.getTime()) / 86400000) + 1);
    const points = [];

    for (let i = 0; i < plotDays; i++) {
      const d = addDays(win.winStart, i);
      const k = formatLocalYmd(d);
      const rec = map[k];
      if (rec) running += rec.total;
      points.push({ date: d, key: k, val: running });
    }

    const max = running || 1;
    const denom = Math.max(1, points.length - 1);
    const step = points.length === 1 ? width : (width / denom);

    const scale = getEffectiveHeatmapScale();
    const strokeColor = (typeof getActiveAccentColor === 'function' ? getActiveAccentColor() : '') || scale[4];
    const strokeRgb = hexToRgb(normalizeHex(strokeColor)) || { r: 192, g: 132, b: 252 };
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, `rgba(${strokeRgb.r}, ${strokeRgb.g}, ${strokeRgb.b}, 0.36)`);
    grad.addColorStop(1, `rgba(${strokeRgb.r}, ${strokeRgb.g}, ${strokeRgb.b}, 0.02)`);

    ctx.beginPath();
    ctx.moveTo(0, height);
    points.forEach((pt, idx) => {
      const x = points.length === 1 ? width / 2 : idx * step;
      const y = height - (pt.val / max) * (height - 12);
      ctx.lineTo(x, y);
    });
    if (points.length === 1) {
      const y = height - (points[0].val / max) * (height - 12);
      ctx.lineTo(width, y);
    }
    ctx.lineTo(width, height);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    points.forEach((pt, idx) => {
      const x = points.length === 1 ? 0 : idx * step;
      const y = height - (pt.val / max) * (height - 12);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (points.length === 1) {
      const y = height - (points[0].val / max) * (height - 12);
      ctx.lineTo(width, y);
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    cvs.onmousemove = e => {
      const r = cvs.getBoundingClientRect();
      const mouseX = e.clientX - r.left;
      const idx = points.length === 1 ? 0 : Math.min(points.length - 1, Math.max(0, Math.round(mouseX / step)));
      const pt = points[idx];
      const cumDates = [];
      for (const k of Object.keys(map)) {
        if (k <= pt.key) cumDates.push(k);
      }
      const costAgg = calculateIntervalCost(map, cumDates, activeCostModel, {
        mode: activeCostMode,
        todayStr: formatLocalYmd(win.today)
      });
      const costStr = costAgg.totalCostUSD > 0 ? ` · ≈ $${costAgg.totalCostUSD.toFixed(2)}` : '';
      const cumDateLabel = currentPanelLanguage === 'en'
        ? `${pt.date.getFullYear()}-${String(pt.date.getMonth() + 1).padStart(2, '0')}-${String(pt.date.getDate()).padStart(2, '0')}`
        : `${pt.date.getFullYear()}年${pt.date.getMonth() + 1}月${pt.date.getDate()}日`;
      heatPopDate.textContent = `${cumDateLabel}${t('heat.cumSuffix')}`;
      heatPopVal.textContent = `${fmtYi(pt.val)} Tokens${costStr}`;
      heatPopDet.innerHTML = `<span>${t('heat.cumTotal', { avg: costAgg.dailyAverageUSD.toFixed(2) })}</span>`;
      heatPopDet.style.display = 'block';
      heatPop.style.left = `${e.clientX}px`;
      heatPop.style.top = `${r.top + (height - (pt.val / max) * (height - 12)) - 6}px`;
      heatPop.style.opacity = '1';
    };
    cvs.onmouseleave = hidePopover;

    const allWinDates = [];
    for (let i = 0; i < win.totalDays; i++) allWinDates.push(formatLocalYmd(addDays(win.winStart, i)));
    updateSummaryBar('cum', allWinDates);
  }

  function updateSummaryBar(viewType, dateKeys = []) {
    const sumTokensEl = el('h-sum-tokens');
    const sumCostEl = el('h-sum-cost');
    const sumDailyAvgEl = el('h-sum-daily-avg');
    const sumActiveAvgEl = el('h-sum-active-avg');
    const subRatioWrapEl = el('h-sum-sub-ratio-wrap');
    const subRatioEl = el('h-sum-sub-ratio');
    if (!sumTokensEl || !sumCostEl) return;

    const win = computeTimelineWindow();
    const todayStr = formatLocalYmd(win.today);
    const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, dateKeys, activeCostModel, {
      mode: activeCostMode,
      todayStr
    });

    sumTokensEl.textContent = `${fmtYi(costAgg.totalTokens)} Tokens`;
    sumCostEl.textContent = `≈ $${costAgg.totalCostUSD.toFixed(2)}`;
    sumDailyAvgEl.textContent = `$${costAgg.dailyAverageUSD.toFixed(2)}`;
    sumActiveAvgEl.textContent = t('heat.activeDays', { avg: costAgg.activeDailyAverageUSD.toFixed(2), days: costAgg.activeDays });

    if ((viewType === 'monthly' || viewType === 'yearly') && subRatioWrapEl && subRatioEl) {
      const plan = resolveEffectivePlanStatus(ANTIGRAVITY_TOKEN_DATA.planStatus, ANTIGRAVITY_TOKEN_DATA.customPlanSettings);
      const paidVal = plan.actualPricePaid ?? plan.officialPriceMonthly ?? null;
      const isZeroCost = plan.isZeroExtraCost || paidVal === 0;
      if (!isZeroCost && paidVal !== null && Number(paidVal) > 0 && costAgg.totalCostUSD > 0) {
        const subMonthlyUSD = Number(paidVal);
        const ratio = (costAgg.totalCostUSD / (viewType === 'yearly' ? subMonthlyUSD * 12 : subMonthlyUSD)).toFixed(1);
        subRatioEl.textContent = t('heat.roi', { ratio });
        subRatioWrapEl.style.display = 'inline-flex';
      } else {
        subRatioWrapEl.style.display = 'none';
      }
    } else if (subRatioWrapEl) {
      subRatioWrapEl.style.display = 'none';
    }
  }

  function renderHeatmapMonthly() {
    const box = el('h-monthly-box');
    if (!box) return;
    box.replaceChildren();

    const scrollBox = el('h-scroll-box') || box.parentElement;
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const W = (rect && rect.width > 200) ? Math.floor(rect.width - 16) : 670;
    const H = 95;

    const scale = getEffectiveHeatmapScale();
    const win = computeTimelineWindow();
    const today = win.today;
    const todayKey = formatLocalYmd(today);

    // 计算当前所选月 (按 heatMonthOffset 自然月偏移)
    const targetDate = new Date(today.getFullYear(), today.getMonth() + heatMonthOffset, 1);
    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();
    const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();

    const gap = 5;
    let bestR = 1, bestC = daysInMonth, bestS = 0;
    for (let r = 1; r <= 7; r++) {
      const c = Math.ceil(daysInMonth / r);
      const s = Math.min((W - (c - 1) * gap) / c, (H - (r - 1) * gap) / r);
      if (s > bestS) {
        bestS = s;
        bestR = r;
        bestC = c;
      }
    }
    bestS = Math.floor(bestS);
    const showDayNum = bestS >= 22;

    const grid = document.createElement('div');
    grid.className = 'heat-month-grid';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${bestC}, ${bestS}px)`;
    grid.style.gridAutoRows = `${bestS}px`;
    grid.style.gap = `${gap}px`;
    grid.style.justifyContent = 'center';
    grid.style.alignContent = 'center';
    grid.style.height = `${H}px`;

    const dateKeys = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(targetYear, targetMonth, day);
      const k = formatLocalYmd(d);
      dateKeys.push(k);
      const isFuture = d.getTime() > today.getTime();
      const isToday = k === todayKey;
      const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
      const tokens = rec ? rec.total : 0;
      const lvl = getLvl(tokens);

      const cell = document.createElement('div');
      cell.className = `heat-month-cell heat-cell lvl-${lvl}${isFuture ? ' is-future' : ''}${isToday ? ' is-today' : ''}`;
      cell.style.width = `${bestS}px`;
      cell.style.height = `${bestS}px`;
      cell.style.backgroundColor = scale[lvl];
      cell.setAttribute('data-date', k);
      cell.setAttribute('data-tokens', String(tokens));

      if (showDayNum) {
        const numSpan = document.createElement('span');
        numSpan.className = 'heat-month-cell-num';
        numSpan.textContent = String(day);
        cell.appendChild(numSpan);
      }

      const showPop = () => {
        const costInfo = getDailyModelCost(rec, k, activeCostModel, { mode: activeCostMode });
        const costStr = costInfo.costUSD > 0 ? ` · ≈ $${costInfo.costUSD.toFixed(2)}` : '';
        const mDateLabel = currentPanelLanguage === 'en'
          ? `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          : `${targetYear}年${targetMonth + 1}月${day}日`;
        heatPopDate.textContent = `${mDateLabel}${isToday ? t('heat.today') : ''}`;
        heatPopVal.textContent = tokens > 0 ? `${fmtYi(tokens)} Tokens${costStr}` : (isFuture ? t('heat.future') : '0 Tokens');
        if (rec) {
          heatPopDet.innerHTML = `
            <div class="pop-det-col"><span class="pop-det-val">Prompt: ${fmtYi(rec.input)}</span><span class="pop-det-trans">${t('heat.prompt')}</span></div>
            <div class="pop-det-col"><span class="pop-det-val">Output: ${fmtYi(rec.output)}</span><span class="pop-det-trans">${t('heat.output')}</span></div>
            <div class="pop-det-col"><span class="pop-det-val">Cache: ${fmtYi(rec.cache)}</span><span class="pop-det-trans">${t('heat.cache')}</span></div>
          `.trim();
          heatPopDet.style.display = 'flex';
        } else {
          heatPopDet.style.display = 'none';
        }
        const r = cell.getBoundingClientRect();
        heatPop.style.left = `${r.left + r.width / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      cell.addEventListener('mouseenter', showPop);
      cell.addEventListener('mouseleave', hidePopover);
      cell.addEventListener('click', showPop);

      grid.appendChild(cell);
    }

    box.appendChild(grid);
    updateSummaryBar('monthly', dateKeys);
  }

  function renderHeatmapYearly() {
    const box = el('h-yearly-box');
    if (!box) return;
    box.replaceChildren();

    const scrollBox = el('h-scroll-box') || box.parentElement;
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const W = (rect && rect.width > 200) ? Math.floor(rect.width - 16) : 670;
    const H = 95;

    const scale = getEffectiveHeatmapScale();
    const win = computeTimelineWindow();
    const today = win.today;
    const thisYear = today.getFullYear();
    const thisMonth = today.getMonth();
    const targetYear = thisYear + heatYearOffset;

    const monthsData = [];
    const allYearDates = [];
    let maxMonthTokens = 1;

    for (let m = 0; m < 12; m++) {
      const daysCount = new Date(targetYear, m + 1, 0).getDate();
      let mTokens = 0;
      const mDates = [];
      for (let d = 1; d <= daysCount; d++) {
        const dateObj = new Date(targetYear, m, d);
        const k = formatLocalYmd(dateObj);
        mDates.push(k);
        allYearDates.push(k);
        const rec = ANTIGRAVITY_TOKEN_DATA.dailyMap[k];
        if (rec) mTokens += rec.total;
      }
      const isCurrent = (targetYear === thisYear && m === thisMonth);
      const isFuture = (targetYear > thisYear || (targetYear === thisYear && m > thisMonth));
      if (!isFuture && mTokens > maxMonthTokens) {
        maxMonthTokens = mTokens;
      }
      const shortMonthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      monthsData.push({
        monthIndex: m,
        monthName: currentPanelLanguage === 'en' ? (shortMonthsEn[m] || `${m + 1}`) : `${m + 1}月`,
        tokens: mTokens,
        dates: mDates,
        isCurrent,
        isFuture
      });
    }

    const createSvgNode = tag => {
      if (typeof document !== 'undefined' && typeof document.createElementNS === 'function') {
        return document.createElementNS('http://www.w3.org/2000/svg', tag);
      }
      return document.createElement(tag);
    };

    const svg = createSvgNode('svg');
    svg.setAttribute('class', 'heat-yearly-svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));

    const Rmin = 6;
    const Rmax = 24;
    const colW = W / 12;
    const cy = 42;

    let peakMonthIndex = -1;
    let peakTokens = 0;
    monthsData.forEach(item => {
      if (!item.isFuture && item.tokens > peakTokens) {
        peakTokens = item.tokens;
        peakMonthIndex = item.monthIndex;
      }
    });

    monthsData.forEach((item, idx) => {
      const cx = colW * idx + colW / 2;
      const g = createSvgNode('g');
      g.setAttribute('class', 'heat-yearly-bubble-group');
      g.style.animationDelay = `${idx * 20}ms`;

      let radius = Rmin;
      if (!item.isFuture && item.tokens > 0) {
        const ratio = Math.sqrt(item.tokens / maxMonthTokens);
        radius = Rmin + ratio * (Rmax - Rmin);
      }

      const lvl = item.isFuture ? 0 : getLvlForRange(item.tokens, 'month', maxMonthTokens);
      const fillCol = item.isFuture ? 'transparent' : (scale[lvl] || scale[0]);

      const circle = createSvgNode('circle');
      circle.setAttribute('class', 'bubble-main');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(radius));
      circle.setAttribute('fill', fillCol);
      circle.setAttribute('stroke', item.isFuture ? 'rgba(255,255,255,0.18)' : (item.monthIndex === peakMonthIndex ? 'var(--ag-text-primary)' : 'rgba(255,255,255,0.08)'));
      circle.setAttribute('stroke-width', item.monthIndex === peakMonthIndex ? '2' : '1');

      if (item.isFuture) {
        circle.setAttribute('stroke-dasharray', '2,2');
      }

      g.appendChild(circle);

      if (item.isCurrent) {
        const activeRing = createSvgNode('circle');
        activeRing.setAttribute('cx', String(cx));
        activeRing.setAttribute('cy', String(cy));
        activeRing.setAttribute('r', String(radius + 4));
        activeRing.setAttribute('fill', 'none');
        activeRing.setAttribute('stroke', 'var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))');
        activeRing.setAttribute('stroke-width', '1.5');
        activeRing.setAttribute('stroke-dasharray', '3,3');
        g.appendChild(activeRing);
      }

      if (item.monthIndex === peakMonthIndex && item.tokens > 0) {
        const peakBadge = createSvgNode('text');
        peakBadge.setAttribute('x', String(cx));
        peakBadge.setAttribute('y', String(cy - radius - 5));
        peakBadge.setAttribute('text-anchor', 'middle');
        peakBadge.setAttribute('font-size', '8.5');
        peakBadge.setAttribute('font-weight', '600');
        peakBadge.setAttribute('fill', 'var(--ag-custom-token-accent,var(--ag-token-accent-default,#a78bfa))');
        peakBadge.textContent = t('heat.peak');
        g.appendChild(peakBadge);
      }

      const text = createSvgNode('text');
      text.setAttribute('x', String(cx));
      text.setAttribute('y', String(H - 12));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '10');
      text.setAttribute('fill', item.isCurrent ? 'var(--ag-text-primary)' : 'var(--ag-text-muted)');
      text.setAttribute('font-weight', item.isCurrent ? '600' : '400');
      text.textContent = item.monthName;
      g.appendChild(text);

      const showPop = () => {
        const costAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, item.dates, activeCostModel, {
          mode: activeCostMode,
          todayStr: formatLocalYmd(win.today)
        });
        const costStr = costAgg.totalCostUSD > 0 ? ` · ≈ $${costAgg.totalCostUSD.toFixed(2)}` : '';
        const yearMonthLabel = currentPanelLanguage === 'en' ? `${item.monthName} ${targetYear}` : `${targetYear}年${item.monthName}`;
        heatPopDate.textContent = `${yearMonthLabel}${item.isCurrent ? t('heatmap.pop.inProgress') : (item.monthIndex === peakMonthIndex ? t('heatmap.pop.peak') : '')}`;
        heatPopVal.textContent = item.tokens > 0 ? `${fmtYi(item.tokens)} Tokens${costStr}` : (item.isFuture ? t('heatmap.pop.future') : '0 Tokens');
        heatPopDet.innerHTML = `<span>${t('heatmap.pop.monthlyDet', { avg: costAgg.dailyAverageUSD.toFixed(2), days: costAgg.activeDays })}</span>`;
        heatPopDet.style.display = 'block';

        const r = g.getBoundingClientRect ? g.getBoundingClientRect() : { left: cx, top: cy, width: radius * 2 };
        heatPop.style.left = `${r.left + (r.width || 0) / 2}px`;
        heatPop.style.top = `${r.top - 6}px`;
        heatPop.style.opacity = '1';
      };

      g.addEventListener('mouseenter', showPop);
      g.addEventListener('mouseleave', hidePopover);
      g.addEventListener('click', showPop);

      svg.appendChild(g);
    });

    box.appendChild(svg);
    updateSummaryBar('yearly', allYearDates);
  }

  // 初始化首次使用日与时间轴显示并触发后台完整历史同步
  computeTimelineWindow();
  void syncTokenHistoryFromHost();

  // 统一生成徽章、悬浮提示与速览卡片的状态数据
  function resolveDisplayStatus(d, session) {
    const ec = d?.errorClassification;
    let kind = ec?.kind || (d?.exceeded ? 'context_overflow' : d?.network ? 'network_error' : d?.error ? 'unknown' : 'none');

    // 如果没有显示分类但存在明确标志
    if (d?.exceeded) kind = 'context_overflow';

    if (kind === 'context_overflow' || d?.exceeded) {
      const sLimit = d?.serviceLimit || ec?.serviceLimit;
      const limStatus = sLimit ? t('diag.ctx.statusLim', { lim: short(sLimit) }) : '';
      const limTakeaway = sLimit ? t('diag.ctx.statusLim', { lim: fmt(sLimit) }) : '';
      return {
        kind: 'context_overflow',
        badgeText: t('diag.ctx.badge'),
        amountText: t('diag.ctx.amount'),
        keyBadgeText: t('diag.ctx.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.ctx.hover'),
        tipTitle: t('diag.ctx.tipTitle'),
        tipPct: t('diag.ctx.tipPct'),
        tipDetail: sLimit ? t('diag.ctx.tipDetailLim', { lim: fmtBubbleToken(sLimit) }) : t('diag.ctx.tipDetailDef'),
        statusText: t('diag.ctx.status', { lim: limStatus }),
        keyTakeaway: t('diag.ctx.takeaway', { lim: limTakeaway }),
        isError: true,
        isOverflow: true
      };
    }

    if (kind === 'quota_exhausted') {
      const pool = ec?.modelOrPool || d?.model || t('diag.quota.defPool');
      const resetStr = ec?.resetTimeZh ? t('diag.quota.reset', { time: ec.resetTimeZh }) : '';
      return {
        kind: 'quota_exhausted',
        badgeText: t('diag.quota.badge'),
        amountText: t('diag.quota.amount'),
        keyBadgeText: t('diag.quota.badge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.quota.hover'),
        tipTitle: t('diag.quota.tipTitle'),
        tipPct: t('diag.quota.tipPct'),
        tipDetail: t('diag.quota.tipDetail', { pool, reset: resetStr }),
        statusText: t('diag.quota.status', { pool, reset: resetStr }),
        keyTakeaway: t('diag.quota.takeaway', { pool, reset: resetStr }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'rate_limited') {
      const retryStr = ec?.retryAfterSec ? t('diag.rate.retry', { sec: ec.retryAfterSec }) : '';
      return {
        kind: 'rate_limited',
        badgeText: t('diag.rate.badge'),
        amountText: t('diag.rate.amount'),
        keyBadgeText: t('diag.rate.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.rate.hover'),
        tipTitle: t('diag.rate.tipTitle'),
        tipPct: t('diag.rate.tipPct'),
        tipDetail: t('diag.rate.tipDetail', { retry: retryStr }),
        statusText: t('diag.rate.status', { retry: retryStr }),
        keyTakeaway: t('diag.rate.takeaway', { retry: retryStr }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'network_error' || d?.network) {
      const cleanDiag = ec?.diagnostic || t('diag.net.defDiag');
      return {
        kind: 'network_error',
        badgeText: t('diag.net.badge'),
        amountText: t('diag.net.amount'),
        keyBadgeText: t('diag.net.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.net.hover'),
        tipTitle: t('diag.net.tipTitle'),
        tipPct: t('diag.net.tipPct'),
        tipDetail: t('diag.net.tipDetail', { diag: cleanDiag }),
        statusText: t('diag.net.status', { diag: cleanDiag }),
        keyTakeaway: t('diag.net.takeaway', { diag: cleanDiag }),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'auth_error') {
      return {
        kind: 'auth_error',
        badgeText: t('diag.auth.badge'),
        amountText: t('diag.auth.amount'),
        keyBadgeText: t('diag.auth.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.auth.hover'),
        tipTitle: t('diag.auth.tipTitle'),
        tipPct: t('diag.auth.tipPct'),
        tipDetail: t('diag.auth.tipDetail'),
        statusText: t('diag.auth.status'),
        keyTakeaway: t('diag.auth.takeaway'),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'service_unavailable') {
      return {
        kind: 'service_unavailable',
        badgeText: t('diag.svc.badge'),
        amountText: t('diag.svc.amount'),
        keyBadgeText: t('diag.svc.amount'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.svc.hover'),
        tipTitle: t('diag.svc.tipTitle'),
        tipPct: t('diag.svc.tipPct'),
        tipDetail: t('diag.svc.tipDetail'),
        statusText: t('diag.svc.status'),
        keyTakeaway: t('diag.svc.takeaway'),
        isError: true,
        isOverflow: false
      };
    }

    if (kind === 'canceled') {
      return {
        kind: 'canceled',
        badgeText: t('diag.cancel.badge'),
        amountText: t('diag.cancel.amount'),
        keyBadgeText: t('diag.cancel.badge'),
        pillClass: 'key-pill pill-muted',
        hoverExtra: t('diag.cancel.hover'),
        tipTitle: t('diag.cancel.tipTitle'),
        tipPct: t('diag.cancel.tipPct'),
        tipDetail: t('diag.cancel.tipDetail'),
        statusText: t('diag.cancel.status'),
        keyTakeaway: t('diag.cancel.takeaway'),
        isError: false,
        isOverflow: false
      };
    }

    if (d?.error) {
      const diag = ec?.diagnostic || d.error;
      return {
        kind: 'unknown',
        badgeText: t('diag.unknown.badge'),
        amountText: t('diag.unknown.amount'),
        keyBadgeText: t('diag.unknown.keyBadge'),
        pillClass: 'key-pill pill-danger',
        hoverExtra: t('diag.unknown.hover'),
        tipTitle: t('diag.unknown.tipTitle'),
        tipPct: t('diag.unknown.tipPct'),
        tipDetail: t('diag.unknown.tipDetail', { diag }),
        statusText: t('diag.unknown.status', { diag }),
        keyTakeaway: t('diag.unknown.takeaway', { diag }),
        isError: true,
        isOverflow: false
      };
    }

    return {
      kind: 'none',
      badgeText: '',
      amountText: '',
      keyBadgeText: '',
      pillClass: 'key-pill pill-good',
      hoverExtra: '',
      tipTitle: '',
      tipPct: '',
      tipDetail: '',
      statusText: '',
      keyTakeaway: '',
      isError: false,
      isOverflow: false
    };
  }

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
