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
