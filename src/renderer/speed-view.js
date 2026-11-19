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
