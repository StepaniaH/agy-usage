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
      const cBySrc = ANTIGRAVITY_TOKEN_DATA.dailyCostMapBySource || {};
      ANTIGRAVITY_TOKEN_DATA.dailyCostMap = src === 'all'
        ? (cBySrc.all || ANTIGRAVITY_TOKEN_DATA.dailyCostMap || {})
        : (cBySrc[src] || {});
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

  // 费用估算范围（自然月 / 订阅周期 / 全量）与估值模式（默认混合模式：已识别按实际模型费率，仅未收录残差按参考模型折算）
  let activeCostScope = 'period'; // 'period' | 'cycle' | 'all'
  let costModelMode = 'hybrid'; // 'hybrid' | 'identified' | 'ref'
  let costBillingDay = 1;
  let costPrefsHydrated = false;

  const COST_MODEL_DISPLAY_NAMES = {
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
    'gemini-4-carbon': 'Gemini 4 Carbon',
    'gemini-4-argon': 'Gemini 4 Argon',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5'
  };

  function populateBillingDayOptions() {
    const sel = el('cost-billing-day-select');
    if (!sel || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    sel.innerHTML = '';
    for (let d = 1; d <= 31; d += 1) {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = t('cost.billingDayOpt', { d });
      sel.appendChild(opt);
    }
    sel.value = String(costBillingDay);
  }
  populateBillingDayOptions();

  function persistCostPrefs() {
    if (typeof window?.contextMeterAPI?.saveSettings === 'function' || hasLiveHttpBridge()) {
      void saveSettingsPayloadBridge({
        uiPreferences: {
          billingDay: costBillingDay,
          costScope: activeCostScope
        }
      });
    }
  }

  function hydrateCostPrefsFromSettings(uiPrefs) {
    if (costPrefsHydrated || !uiPrefs || typeof uiPrefs !== 'object') return;
    let changed = false;
    const bd = Math.floor(Number(uiPrefs.billingDay));
    if (Number.isFinite(bd) && bd >= 1 && bd <= 31) {
      costBillingDay = bd;
      const sel = el('cost-billing-day-select');
      if (sel) sel.value = String(costBillingDay);
      changed = true;
    }
    if (uiPrefs.costScope === 'period' || uiPrefs.costScope === 'cycle' || uiPrefs.costScope === 'all') {
      activeCostScope = uiPrefs.costScope;
      setPillActive(el('cost-btn-scope-period'), activeCostScope === 'period');
      setPillActive(el('cost-btn-scope-cycle'), activeCostScope === 'cycle');
      setPillActive(el('cost-btn-scope-all'), activeCostScope === 'all');
      changed = true;
    }
    if (changed) costPrefsHydrated = true;
  }

  function switchCostScope(scope, persist = true) {
    activeCostScope = (scope === 'cycle' || scope === 'all') ? scope : 'period';
    costPrefsHydrated = true;
    setPillActive(el('cost-btn-scope-period'), activeCostScope === 'period');
    setPillActive(el('cost-btn-scope-cycle'), activeCostScope === 'cycle');
    setPillActive(el('cost-btn-scope-all'), activeCostScope === 'all');
    if (persist) persistCostPrefs();
    renderActiveCostEstimateView();
  }
  el('cost-btn-scope-period')?.addEventListener('click', () => switchCostScope('period', true));
  el('cost-btn-scope-cycle')?.addEventListener('click', () => switchCostScope('cycle', true));
  el('cost-btn-scope-all')?.addEventListener('click', () => switchCostScope('all', true));
  el('cost-billing-day-select')?.addEventListener('change', (e) => {
    const val = Math.floor(Number(e?.target?.value));
    if (Number.isFinite(val) && val >= 1 && val <= 31) {
      costBillingDay = val;
      costPrefsHydrated = true;
      persistCostPrefs();
      renderActiveCostEstimateView();
    }
  });

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
    hydrateCostPrefsFromSettings(ANTIGRAVITY_TOKEN_DATA.uiPreferences || window?.__AGContextMeterSettings?.uiPreferences);
    const isPeriod = activeCostScope === 'period';
    const isCycle = activeCostScope === 'cycle';
    const isMonthlyWindow = isPeriod || isCycle;
    const titleEl = el('cost-card-title');
    const periodTag = el('cost-period-tag');
    const billingRow = el('cost-billing-day-row');
    const billingRangeTxt = el('cost-billing-range-txt');
    const billingSel = el('cost-billing-day-select');
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
    const inRateEl = el('ref-cost-input-rate');
    const caVal = el('ref-cost-cache-val');
    const caTok = el('ref-cost-cache-tok');
    const caRateEl = el('ref-cost-cache-rate');
    const outVal = el('ref-cost-output-val');
    const outTok = el('ref-cost-output-tok');
    const outRateEl = el('ref-cost-output-rate');

    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const cycleRange = (isCycle && core?.computeBillingCycleRange)
      ? core.computeBillingCycleRange(new Date(), costBillingDay)
      : null;

    if (billingRow) billingRow.style.display = isCycle ? 'flex' : 'none';
    if (billingSel) {
      if (billingSel.options?.length === 0 || (billingSel.options?.[0] && billingSel.options[0].textContent !== t('cost.billingDayOpt', { d: 1 }))) {
        populateBillingDayOptions();
      }
      if (billingSel.value !== String(costBillingDay)) billingSel.value = String(costBillingDay);
    }
    if (billingRangeTxt && cycleRange) billingRangeTxt.textContent = cycleRange.fullLabel;

    if (titleEl) {
      titleEl.textContent = isCycle ? t('cost.titleCycle') : (isPeriod ? t('cost.title') : t('cost.titleAll'));
    }
    if (periodTag) {
      if (isCycle && cycleRange) {
        periodTag.textContent = cycleRange.label;
      } else {
        const pKey = ANTIGRAVITY_TOKEN_DATA.currentPeriod?.label || t('cost.periodTag');
        periodTag.textContent = isPeriod ? pKey : t('cost.allHistory');
      }
    }

    // 1. 提取当前范围真实用量与折算数据
    const emptyCostEst = { pricedCostUSD: 0, pricedRequestsCount: 0, unpricedRequestsCount: 0, coveragePercent: null, byModel: {}, unpricedByModel: {}, byCategory: { inputTokens: 0, cacheTokens: 0, outputTokens: 0, thinkingTokens: 0 } };
    let curIn = 0;
    let curCa = 0;
    let curOut = 0;
    let curTotal = 0;
    let curRef = {};
    let curIdentified = emptyCostEst;
    let rawHybrid = null;

    if (isCycle && cycleRange && core?.aggregateDailyCostRange) {
      const scopedDailyMap = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
      const dcSourceMap = ANTIGRAVITY_TOKEN_DATA.dailyCostMapBySource || {};
      const scopedDailyCostMap = activeTokenSource === 'all'
        ? (dcSourceMap.all || ANTIGRAVITY_TOKEN_DATA.dailyCostMap || {})
        : (dcSourceMap[activeTokenSource] || ANTIGRAVITY_TOKEN_DATA.dailyCostMap || {});
      const agg = core.aggregateDailyCostRange(scopedDailyMap, scopedDailyCostMap, cycleRange.startDate, cycleRange.endDate);
      curIn = agg.totals.inputTokens;
      curCa = agg.totals.cacheTokens;
      curOut = agg.totals.outputTokens;
      curTotal = agg.totals.totalTokens;
      curIdentified = agg.costEstimate;
    } else {
      curIn = isPeriod
        ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthInput || 0)
        : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalInputTokens || 0);
      curCa = isPeriod
        ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthCache || 0)
        : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalCacheTokens || 0);
      curOut = isPeriod
        ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthOutput || 0)
        : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalOutputTokens || 0);
      curTotal = isPeriod
        ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.monthTokens || (curIn + curCa + curOut))
        : Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens || (curIn + curCa + curOut));

      const refAll = ANTIGRAVITY_TOKEN_DATA.referenceCost?.all || {};
      const refMonth = ANTIGRAVITY_TOKEN_DATA.referenceCost?.currentMonth || {};
      curRef = isPeriod ? refMonth : refAll;

      const ceSourceMap = ANTIGRAVITY_TOKEN_DATA.costEstimateBySource || {};
      const ceAll = activeTokenSource === 'all'
        ? (ceSourceMap.all || ANTIGRAVITY_TOKEN_DATA.costEstimate || emptyCostEst)
        : (ceSourceMap[activeTokenSource] || emptyCostEst);
      const ceMonthSourceMap = ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonthBySource || {};
      const cePeriod = activeTokenSource === 'all'
        ? (ceMonthSourceMap.all || ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth || ceAll)
        : (ceMonthSourceMap[activeTokenSource] || emptyCostEst);
      curIdentified = isPeriod ? cePeriod : ceAll;

      rawHybrid = isPeriod
        ? ANTIGRAVITY_TOKEN_DATA.referenceCost?.currentMonthHybrid
        : ANTIGRAVITY_TOKEN_DATA.referenceCost?.hybrid;
    }

    let apiCost = 0;
    let pillText = t('cost.covFull');
    let pillClass = 'key-pill pill-good';

    // 2. 估值模式计算
    let effectiveRef = curRef;
    if ((effectiveRef.totalCostUSD === undefined || effectiveRef.totalCostUSD === null) && curTotal > 0) {
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

    let effectiveHybrid = rawHybrid?.hybrid ? rawHybrid : null;
    if (!effectiveHybrid) {
      const knownCostRaw = Number(curIdentified.pricedCostUSD || 0);
      if (knownCostRaw === 0 && effectiveRef.totalCostUSD !== undefined && effectiveRef.totalCostUSD !== null) {
        const refTot = Number(effectiveRef.totalCostUSD || 0);
        effectiveHybrid = {
          hybrid: {
            knownCostUSD: 0,
            unpricedResidualTokens: curTotal || Number(effectiveRef.totalTokens || 0),
            unpricedResidualCostUSD: refTot,
            combinedTotalUSD: refTot,
            residualTokensBreakdown: {
              input: curIn || Number(effectiveRef.inputTokens || 0),
              cache: curCa || Number(effectiveRef.cacheTokens || 0),
              output: curOut || Number(effectiveRef.outputTokens || 0),
              inputCostUSD: Number(effectiveRef.inputCostUSD ?? ((curIn || Number(effectiveRef.inputTokens || 0)) * rateIn / 1e6)),
              cacheCostUSD: Number(effectiveRef.cacheCostUSD ?? ((curCa || Number(effectiveRef.cacheTokens || 0)) * rateCa / 1e6)),
              outputCostUSD: Number(effectiveRef.outputCostUSD ?? ((curOut || Number(effectiveRef.outputTokens || 0)) * rateOut / 1e6))
            },
            totalBreakdown: {
              hasKnownCategoryCosts: true,
              input: curIn || Number(effectiveRef.inputTokens || 0),
              cache: curCa || Number(effectiveRef.cacheTokens || 0),
              output: curOut || Number(effectiveRef.outputTokens || 0),
              knownInput: 0,
              knownCache: 0,
              knownOutput: 0,
              inputCostUSD: Number(effectiveRef.inputCostUSD ?? ((curIn || Number(effectiveRef.inputTokens || 0)) * rateIn / 1e6)),
              cacheCostUSD: Number(effectiveRef.cacheCostUSD ?? ((curCa || Number(effectiveRef.cacheTokens || 0)) * rateCa / 1e6)),
              outputCostUSD: Number(effectiveRef.outputCostUSD ?? ((curOut || Number(effectiveRef.outputTokens || 0)) * rateOut / 1e6))
            }
          }
        };
      } else {
        const hIn = curIn || Number(effectiveRef.inputTokens || 0);
        const hCa = curCa || Number(effectiveRef.cacheTokens || 0);
        const hOut = curOut || Number(effectiveRef.outputTokens || 0);
        const hTot = curTotal || Number(effectiveRef.totalTokens || (hIn + hCa + hOut));
        if (hTot > 0 || knownCostRaw > 0) {
          if (core && core.calculateReferenceModelCost) {
            effectiveHybrid = core.calculateReferenceModelCost({
              inputTokens: hIn,
              outputTokens: hOut,
              cacheTokens: hCa,
              totalTokens: hTot
            }, 'gemini-3.8-flash', {
              pricingDate: '2026-11-09',
              mode: 'unpriced_only',
              knownUsage: {
                byCategory: curIdentified.byCategory,
                costUSD: curIdentified.pricedCostUSD
              }
            });
          }
        }
      }
    }

    const showFlatRate = costModelMode === 'ref';
    if (inRateEl) {
      inRateEl.textContent = ` ($${rateIn.toFixed(2)}/M)`;
      inRateEl.style.display = showFlatRate ? '' : 'none';
    }
    if (caRateEl) {
      caRateEl.textContent = ` ($${rateCa.toFixed(3)}/M)`;
      caRateEl.style.display = showFlatRate ? '' : 'none';
    }
    if (outRateEl) {
      outRateEl.textContent = ` ($${rateOut.toFixed(2)}/M)`;
      outRateEl.style.display = showFlatRate ? '' : 'none';
    }

    // 更新小摘要来源与时间描述行及非实付常驻标识
    const scopeDescEl = el('cost-scope-desc');
    if (scopeDescEl) {
      const srcName = activeTokenSource === 'desktop' ? t('tokens.srcDesktopLabel') : activeTokenSource === 'cli' ? 'CLI' : t('tokens.srcAllLabel');
      const pLabel = isCycle && cycleRange
        ? cycleRange.label
        : (isPeriod ? (ANTIGRAVITY_TOKEN_DATA.currentPeriod?.label || t('cost.periodTag')) : t('cost.allHistory'));
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
      const h = effectiveHybrid?.hybrid || {};
      const knownCost = Number(h.knownCostUSD || 0);
      const resCost = Number(h.unpricedResidualCostUSD || 0);
      const hasHybridCombined = h.combinedTotalUSD !== undefined && h.combinedTotalUSD !== null;
      apiCost = hasHybridCombined ? Number(h.combinedTotalUSD) : Number(effectiveRef.totalCostUSD || 0);

      if (grandVal) {
        if (apiCost > 0) {
          grandVal.textContent = `$${apiCost.toFixed(2)}`;
          grandVal.title = resCost === 0 && knownCost > 0
            ? t('cost.hybridAllPriced')
            : t('cost.hybridSub', { known: knownCost.toFixed(2), res: resCost.toFixed(2) });
        } else if (curTotal > 0 && curIn === 0 && curCa === 0 && curOut === 0) {
          grandVal.textContent = t('cost.notReady');
          grandVal.title = t('cost.notReady');
        } else {
          grandVal.textContent = '$0.00';
          grandVal.title = t('cost.noRecords');
        }
      }
      if (grandSub) {
        if (knownCost > 0 && resCost === 0) {
          grandSub.textContent = t('cost.hybridAllPriced');
        } else if (knownCost > 0 || resCost > 0) {
          grandSub.textContent = t('cost.hybridSub', {
            known: knownCost.toFixed(2),
            res: resCost.toFixed(2)
          });
        } else {
          grandSub.textContent = t('cost.refSub', {
            model: effectiveRef.modelDisplayName || 'Gemini 3.8 Flash',
            in: rateIn.toFixed(2),
            ca: rateCa.toFixed(3),
            out: rateOut.toFixed(2)
          });
        }
      }
      pillText = t('cost.hybridBadge');
      pillClass = 'key-pill pill-muted';

      const tb = h.totalBreakdown;
      const rb = h.residualTokensBreakdown || {};
      const hasKnownCatCosts = Boolean(
        tb?.hasKnownCategoryCosts ||
        curIdentified.byCategory?.inputCostUSD !== undefined ||
        curIdentified.byCategory?.cacheCostUSD !== undefined ||
        curIdentified.byCategory?.outputCostUSD !== undefined
      );
      if (tb?.hasKnownCategoryCosts) {
        if (inVal) inVal.textContent = `$${Number(tb.inputCostUSD || 0).toFixed(2)}`;
        if (inTok) inTok.textContent = `${fmtYi(tb.input ?? curIn)} tok`;
        if (caVal) caVal.textContent = `$${Number(tb.cacheCostUSD || 0).toFixed(2)}`;
        if (caTok) caTok.textContent = t('cost.tokCacheDiscount', { tok: fmtYi(tb.cache ?? curCa) });
        if (outVal) outVal.textContent = `$${Number(tb.outputCostUSD || 0).toFixed(2)}`;
        if (outTok) outTok.textContent = `${fmtYi(tb.output ?? curOut)} tok`;
      } else if (hasKnownCatCosts) {
        const resInC = Number(rb.inputCostUSD ?? (Number(rb.input || 0) * rateIn / 1e6));
        const resCaC = Number(rb.cacheCostUSD ?? (Number(rb.cache || 0) * rateCa / 1e6));
        const resOutC = Number(rb.outputCostUSD ?? (Number(rb.output || 0) * rateOut / 1e6));
        if (inVal) inVal.textContent = `$${(Number(curIdentified.byCategory?.inputCostUSD || 0) + resInC).toFixed(2)}`;
        if (inTok) inTok.textContent = `${fmtYi(curIn)} tok`;
        if (caVal) caVal.textContent = `$${(Number(curIdentified.byCategory?.cacheCostUSD || 0) + resCaC).toFixed(2)}`;
        if (caTok) caTok.textContent = t('cost.tokCacheDiscount', { tok: fmtYi(curCa) });
        if (outVal) outVal.textContent = `$${(Number(curIdentified.byCategory?.outputCostUSD || 0) + resOutC).toFixed(2)}`;
        if (outTok) outTok.textContent = `${fmtYi(curOut)} tok`;
      } else {
        if (inVal) inVal.textContent = `$${Number(rb.inputCostUSD ?? (Number(rb.input || 0) * rateIn / 1e6)).toFixed(2)}`;
        if (inTok) inTok.textContent = knownCost > 0 ? t('cost.tokResidual', { tok: fmtYi(rb.input || 0) }) : `${fmtYi(curIn)} tok`;
        if (caVal) caVal.textContent = `$${Number(rb.cacheCostUSD ?? (Number(rb.cache || 0) * rateCa / 1e6)).toFixed(2)}`;
        if (caTok) caTok.textContent = knownCost > 0 ? t('cost.tokResidual', { tok: fmtYi(rb.cache || 0) }) : t('cost.tokCacheDiscount', { tok: fmtYi(curCa) });
        if (outVal) outVal.textContent = `$${Number(rb.outputCostUSD ?? (Number(rb.output || 0) * rateOut / 1e6)).toFixed(2)}`;
        if (outTok) outTok.textContent = knownCost > 0 ? t('cost.tokResidual', { tok: fmtYi(rb.output || 0) }) : `${fmtYi(curOut)} tok`;
      }
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

      const hasActualCatCosts = (
        curIdentified.byCategory?.inputCostUSD !== undefined ||
        curIdentified.byCategory?.cacheCostUSD !== undefined ||
        curIdentified.byCategory?.outputCostUSD !== undefined
      );
      const idInCost = hasActualCatCosts
        ? Number(curIdentified.byCategory?.inputCostUSD || 0)
        : ((curIdentified.byCategory?.inputTokens || 0) * rateIn / 1e6);
      const idCaCost = hasActualCatCosts
        ? Number(curIdentified.byCategory?.cacheCostUSD || 0)
        : ((curIdentified.byCategory?.cacheTokens || 0) * rateCa / 1e6);
      const idOutCost = hasActualCatCosts
        ? Number(curIdentified.byCategory?.outputCostUSD || 0)
        : ((curIdentified.byCategory?.outputTokens || 0) * rateOut / 1e6);

      if (inVal) inVal.textContent = `$${idInCost.toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIdentified.byCategory?.inputTokens || 0)} tok`;
      if (caVal) caVal.textContent = `$${idCaCost.toFixed(2)}`;
      if (caTok) caTok.textContent = `${fmtYi(curIdentified.byCategory?.cacheTokens || 0)} tok`;
      if (outVal) outVal.textContent = `$${idOutCost.toFixed(2)}`;
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

    const extraNoCompare = isMonthlyWindow ? '' : t('cost.allNoCompare');
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
        const ratioSuffix = (isMonthlyWindow && paidNum > 0 && apiCost > 0)
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
      if (!isMonthlyWindow) {
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

    // 5. 详细已计价与未收录费率模型说明
    if (breakdown) {
      const modelKeys = Object.keys(curIdentified.byModel || {})
        .sort((a, b) => (Number(curIdentified.byModel[b]?.costUSD || 0) - Number(curIdentified.byModel[a]?.costUSD || 0)));
      const fmtCostShort = (c) => {
        const n = Number(c || 0);
        if (n > 0 && n < 0.01) return '<$0.01';
        return `$${n.toFixed(2)}`;
      };
      const modelDetails = modelKeys.map((k) => {
        const name = COST_MODEL_DISPLAY_NAMES[k] || k;
        const m = curIdentified.byModel[k];
        return `${name} ${fmtCostShort(m.costUSD)} (${fmtYi(m.tokens)})`;
      }).join(' · ');

      let unpricedNote = '';
      const unpricedMap = curIdentified.unpricedByModel || {};
      const unpricedEntries = Object.entries(unpricedMap)
        .filter(([, v]) => Number(v?.tokens || 0) > 0)
        .sort((a, b) => Number(b[1].tokens || 0) - Number(a[1].tokens || 0));
      let explainedUnpricedTok = 0;
      if (unpricedEntries.length > 0) {
        explainedUnpricedTok = unpricedEntries.reduce((acc, [, v]) => acc + Number(v.tokens || 0), 0);
        const listStr = unpricedEntries.slice(0, 4).map(([name, v]) => `${name} (${fmtYi(v.tokens)})`).join(' · ');
        unpricedNote += t('cost.unpricedModelsNote', { models: listStr });
      }
      const totalUnpricedTok = Number(curIdentified.unpricedTokens || 0);
      const legacyUnpricedTok = Math.max(0, totalUnpricedTok - explainedUnpricedTok);
      if (legacyUnpricedTok > 0) {
        unpricedNote += t('cost.unpricedLegacyNote', { tok: fmtYi(legacyUnpricedTok) });
      }

      breakdown.textContent = t('cost.breakdownPrefix', {
        details: modelDetails || t('cost.breakdownNone'),
        note: unpricedNote
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
      ANTIGRAVITY_TOKEN_DATA.dailyCostMap = normalized.dailyCostMap || (activeTokenSource === 'all' ? (payload.dailyCostMap || {}) : {});
      ANTIGRAVITY_TOKEN_DATA.dailyCostMapBySource = normalized.dailyCostMapBySource || payload.dailyCostMapBySource || null;
      if (payload.uiPreferences) ANTIGRAVITY_TOKEN_DATA.uiPreferences = payload.uiPreferences;
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
      if (payload.dailyCostMapBySource) {
        ANTIGRAVITY_TOKEN_DATA.dailyCostMapBySource = payload.dailyCostMapBySource;
        ANTIGRAVITY_TOKEN_DATA.dailyCostMap = activeTokenSource === 'all'
          ? (payload.dailyCostMapBySource.all || {})
          : (payload.dailyCostMapBySource[activeTokenSource] || {});
      } else if (payload.dailyCostMap) {
        ANTIGRAVITY_TOKEN_DATA.dailyCostMap = activeTokenSource === 'all' ? payload.dailyCostMap : {};
      }
      if (payload.uiPreferences) ANTIGRAVITY_TOKEN_DATA.uiPreferences = payload.uiPreferences;
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
