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
