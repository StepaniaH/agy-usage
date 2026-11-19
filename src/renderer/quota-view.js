  // =========================================================================
  // 模型额度看板、套餐详情、共享额度池、动态进度环与定时刷新 (quota-view.js)
  // =========================================================================
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
