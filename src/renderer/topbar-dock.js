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
