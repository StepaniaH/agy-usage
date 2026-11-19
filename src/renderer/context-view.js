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
