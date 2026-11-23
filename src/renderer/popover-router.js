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
      activeSessionModelLabel = hostSelected.productLabel || hostSelected.rawText || null;
      activeSessionProductKey = hostSelected.productKey;
      activeSessionEffort = hostSelected.effort;
      activeSessionModelConfirmed = true;
    } else if (activeSessionProductKey) {
      const curProd = getKnownModelProducts().find(p => p.productKey === activeSessionProductKey);
      if (curProd && curProd.isHistorical) {
        activeSessionModelConfirmed = false;
        activeSessionProductKey = null;
        activeSessionModelKey = null;
        activeSessionModelLabel = null;
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
