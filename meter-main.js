'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
let ipcMain = null;
let app = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object') {
    ipcMain = electron.ipcMain;
    app = electron.app;
  }
} catch {}
const {
  collect,
  collectTokenHistoryAsync,
  collectSessionTimelineAsync,
  recordModelCalls,
  recordModelCallsAsync,
  getPluginSettings,
  savePluginSettings,
  launchCliSession
} = require('./meter-collector');
const { PROJECT_VERSION } = require('./modules-config');

const MAIN_STARTED_AT = Date.now();
const MAIN_CAPABILITIES = {
  scan: true,
  tokenHistory: true,
  sessionTimeline: true,
  quota: true,
  recordCalls: true,
  settings: true,
  launchCli: true,
  restartHost: true,
  hotReload: true
};

let lastObservedHostEmail = null;

function buildBootBackendPayload() {
  return {
    backendVersion: PROJECT_VERSION,
    backendSource: 'electron-ipc',
    pid: process.pid,
    startedAt: MAIN_STARTED_AT,
    capabilities: { ...MAIN_CAPABILITIES }
  };
}

function getMeterSource() {
  try {
    const coreCode = fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8');
    const rendererCode = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
    let bootstrap = `window.__AGContextMeterBootBackend = ${JSON.stringify(buildBootBackendPayload())};\n`;
    try {
      const settingsSnap = getPluginSettings();
      if (settingsSnap && settingsSnap.ok) {
        bootstrap += `window.__AGContextMeterSettings = ${JSON.stringify(settingsSnap)};\n`;
      }
    } catch {}
    return `${bootstrap}${coreCode}\n${rendererCode}\ntrue;`;
  } catch {
    return '';
  }
}

function isLocalMainFrameSender(event) {
  try {
    const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    const url = new URL(rawUrl);
    const portNum = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : (url.protocol === 'http:' ? 80 : 0));
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname !== '127.0.0.1' || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
    if (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) return null;
    return url;
  } catch {
    return null;
  }
}

function resolveTargetWindow(sender) {
  try {
    const { BrowserWindow } = require('electron');
    const direct = BrowserWindow.fromWebContents(sender);
    if (direct && !direct.isDestroyed()) return direct;
  } catch {}
  try {
    const utils = require('./utils');
    if (typeof utils.resolveHubWindowFromWebContents === 'function') {
      const hubWin = utils.resolveHubWindowFromWebContents(sender);
      if (hubWin && !hubWin.isDestroyed?.()) return hubWin;
    }
  } catch {}
  return null;
}

let registered = false;
let isAppQuitting = false;
const boundWindows = new WeakSet();
const boundWebContents = new WeakSet();
const injectionTimers = new WeakMap();
const wcProbeTimers = new WeakMap();

function setAppQuitting(val = true) {
  isAppQuitting = Boolean(val);
}

function getAppQuitting() {
  return isAppQuitting;
}

async function handleRestartHost(event, options = {}) {
  const url = isLocalMainFrameSender(event);
  if (!url) throw new Error('仅允许本机主聊天窗口');
  const targetApp = options?.appOverride || app;
  if (!targetApp || typeof targetApp.relaunch !== 'function' || typeof targetApp.quit !== 'function') {
    return { ok: true, supported: false };
  }
  const args = Array.isArray(options?.args)
    ? options.args
    : (Array.isArray(process.argv) ? process.argv.slice(1) : []);
  const delayMs = Number.isFinite(Number(options?.delayMs)) ? Number(options.delayMs) : 80;
  const triggerRestart = () => {
    try {
      setAppQuitting(true);
      targetApp.relaunch({ args });
      targetApp.quit();
    } catch {}
  };
  if (delayMs <= 0) {
    triggerRestart();
  } else {
    setTimeout(triggerRestart, delayMs);
  }
  return { ok: true, supported: true };
}

function registerIpcOnce() {
  if (registered || !ipcMain) return;
  registered = true;
  registerMeterIpcHandlers(ipcMain);
}

/** 注册 Meter 只读与本地设置 IPC 通道（支持单元测试注入独立 ipcTarget） */
function registerMeterIpcHandlers(ipcTarget) {
  if (!ipcTarget) return;

  ipcTarget.handle('context-meter:runtime-info', async (event) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    return {
      ok: true,
      ...buildBootBackendPayload()
    };
  });

  ipcTarget.handle('context-meter:scan', async (event, id, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return { ok: true, data: await collect(url.origin, id, { force: force === true, supersedePrevious: true }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcTarget.handle('context-meter:record-calls', async (event, calls) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const recOpts = lastObservedHostEmail ? { confirmedAccountEmail: lastObservedHostEmail } : {};
      const res = typeof recordModelCallsAsync === 'function'
        ? await recordModelCallsAsync(calls, recOpts)
        : recordModelCalls(calls, recOpts);
      if (res && typeof res === 'object') {
        if (res.ok === false) {
          return {
            ok: false,
            error: res.error || '入账失败',
            ...(res.phase ? { phase: res.phase } : {}),
            ...(res.code ? { code: res.code } : {}),
            changed: false
          };
        }
        return { ok: true, changed: !!res.changed };
      }
      return { ok: true, changed: !!res };
    } catch (e) {
      return { ok: false, error: e.message, changed: false };
    }
  });

  ipcTarget.handle('context-meter:token-history', async (event, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return { ok: true, data: await collectTokenHistoryAsync({ force: force === true, origin: url.origin }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcTarget.handle('context-meter:session-timeline', async (event, id, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const opts = options && typeof options === 'object' ? options : {};
      const safeOpts = {
        origin: url.origin,
        force: opts.force === true,
        ...(Array.isArray(opts.liveSteps) ? { liveSteps: opts.liveSteps } : {}),
        ...(Array.isArray(opts.liveCalls) ? { liveCalls: opts.liveCalls } : {}),
        ...(Array.isArray(opts.cascadeModelConfigs) ? { cascadeModelConfigs: opts.cascadeModelConfigs } : {}),
        ...(opts.userStatus && typeof opts.userStatus === 'object' ? { userStatus: opts.userStatus } : {})
      };
      const data = await collectSessionTimelineAsync(id, safeOpts);
      return { ok: true, data: { ...(data || {}), backendVersion: PROJECT_VERSION, backendSource: 'electron-ipc' } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcTarget.handle('context-meter:get-quota', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const collector = require('./meter-collector');
      const opts = typeof options === 'boolean'
        ? { force: options }
        : (options && typeof options === 'object' ? { ...options } : {});
      if (!opts.origin) opts.origin = url.origin;
      opts.backendSource = 'electron-ipc';
      const res = await collector.fetchQuotaSnapshotFromHost(opts);
      const observedEmail = res?.planStatus?.email || res?._raw?.planStatus?.email || null;
      if (observedEmail) {
        lastObservedHostEmail = String(observedEmail).trim() || null;
      }
      const { _raw, ...safePayload } = res || {};
      return { ok: true, data: safePayload };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcTarget.handle('context-meter:get-settings', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return getPluginSettings(options || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcTarget.handle('context-meter:save-settings', async (event, payload) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return savePluginSettings(payload || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcTarget.handle('context-meter:launch-cli', async (event, options) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const targetWin = resolveTargetWindow(event.sender);
      let hostBounds = null;
      if (targetWin && !targetWin.isDestroyed()) {
        try {
          hostBounds = targetWin.getBounds();
        } catch {}
      }
      const res = await launchCliSession({
        ...options,
        hostBounds
      });
      return res;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcTarget.handle('context-meter:modules-status', async (event, customAsarPath = null) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    return handleModulesStatus(event, customAsarPath);
  });

  ipcTarget.handle('context-meter:restart-host', handleRestartHost);
}

async function handleModulesStatus(_event = null, customAsarPath = null) {
  try {
    const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
    const cfg = loadModulesConfig();
    const disk = inspectDiskModules(customAsarPath || null);
    return {
      ok: true,
      data: cfg,
      disk,
      runtime: {
        edition: 'safe-readonly',
        meterActive: true
      }
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function getWindowWebContents(win) {
  if (!win || win.isDestroyed?.()) return null;
  if (win.webContents && !win.webContents.isDestroyed?.()) return win.webContents;

  try {
    const utils = require('./utils');
    if (typeof utils.getHubWebContents === 'function') {
      const wc = utils.getHubWebContents(win);
      if (wc && !wc.isDestroyed?.()) return wc;
    }
  } catch {}

  try {
    const children = win.contentView?.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child?.webContents && !child.webContents.isDestroyed?.()) {
          const url = child.webContents.getURL?.() || '';
          if (/^https?:\/\/127\.0\.0\.1:\d+\//.test(url)) return child.webContents;
        }
      }
      for (const child of children) {
        if (child?.webContents && !child.webContents.isDestroyed?.()) {
          const url = child.webContents.getURL?.() || '';
          if (!url.startsWith('data:')) return child.webContents;
        }
      }
    }
  } catch {}
  return null;
}

async function ensureMeterInjected(win, options = {}) {
  try {
    if (!win || win.isDestroyed?.()) return false;
    const wc = getWindowWebContents(win);
    if (!wc || wc.isDestroyed?.()) {
      const attempt = Number(options.attempt || 0);
      const delays = [300, 600, 1000, 1500, 2500];
      if (attempt < delays.length && win && !win.isDestroyed?.()) {
        const prevTimer = injectionTimers.get(win);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          injectionTimers.delete(win);
          void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
        }, delays[attempt]);
        injectionTimers.set(win, t);
      }
      return false;
    }
    const url = wc.getURL?.() || '';
    if (!/^https?:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      const attempt = Number(options.attempt || 0);
      const delays = [300, 600, 1000, 1500, 2500];
      if (attempt < delays.length && win && !win.isDestroyed?.()) {
        const prevTimer = injectionTimers.get(win);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          injectionTimers.delete(win);
          void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
        }, delays[attempt]);
        injectionTimers.set(win, t);
      }
      return false;
    }

    if (!options.force) {
      try {
        const alive = await wc.executeJavaScript(
          'Boolean(window.__AGContextMeter && document.getElementById("ag-context-meter") && (window.__AGContextMeter.ensureAlive ? window.__AGContextMeter.ensureAlive() : true))'
        );
        if (alive === true) return true;
      } catch {}
    }

    const runtimeSource = getMeterSource();
    if (!runtimeSource) return false;

    await wc.executeJavaScript(runtimeSource);
    return true;
  } catch (error) {
    const attempt = Number(options.attempt || 0);
    const delays = [350, 1000, 2500];
    if (attempt < delays.length && win && !win.isDestroyed?.()) {
      const prevTimer = injectionTimers.get(win);
      if (prevTimer) clearTimeout(prevTimer);
      const t = setTimeout(() => {
        injectionTimers.delete(win);
        void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
      }, delays[attempt]);
      injectionTimers.set(win, t);
    } else {
      console.warn('[Context Meter]', error?.message || String(error));
    }
    return false;
  }
}

exports.ensureMeterInjected = ensureMeterInjected;

exports.installContextMeter = function (win) {
  registerIpcOnce();
  if (!win || win.isDestroyed?.()) return;

  if (!boundWindows.has(win)) {
    boundWindows.add(win);
    const onWinVisibleOrActive = () => {
      void ensureMeterInjected(win, { force: false });
    };
    win.on?.('show', onWinVisibleOrActive);
    win.on?.('restore', onWinVisibleOrActive);
    win.on?.('focus', onWinVisibleOrActive);

    try {
      win.on?.('close', (event) => {
        if (shouldInterceptWindowClose(win)) {
          if (typeof event?.preventDefault === 'function') {
            event.preventDefault();
            if (typeof win.hide === 'function') win.hide();
          }
        }
      });
    } catch {}
  }

  const bindToWc = (wc) => {
    if (!wc || boundWebContents.has(wc)) return;
    boundWebContents.add(wc);
    wc.on('did-finish-load', () => {
      void ensureMeterInjected(win, { force: true });
    });
    wc.on('dom-ready', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('did-navigate', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('did-navigate-in-page', () => {
      void ensureMeterInjected(win, { force: false });
    });
  };

  const initialWc = getWindowWebContents(win);
  if (initialWc) {
    bindToWc(initialWc);
  } else {
    const prevProbe = wcProbeTimers.get(win);
    if (prevProbe) clearInterval(prevProbe);

    let retries = 0;
    const probeInterval = setInterval(() => {
      retries++;
      const candidateWc = getWindowWebContents(win);
      if (candidateWc) {
        clearInterval(probeInterval);
        wcProbeTimers.delete(win);
        bindToWc(candidateWc);
        void ensureMeterInjected(win, { force: false });
      } else if (retries >= 10 || !win || win.isDestroyed?.()) {
        clearInterval(probeInterval);
        wcProbeTimers.delete(win);
      }
    }, 150);
    wcProbeTimers.set(win, probeInterval);

    win.once?.('closed', () => {
      const activeTimer = wcProbeTimers.get(win);
      if (activeTimer) {
        clearInterval(activeTimer);
        wcProbeTimers.delete(win);
      }
    });
  }
};

try {
  if (app && typeof app.on === 'function') {
    app.on('before-quit', () => {
      isAppQuitting = true;
    });
    app.on('will-quit', () => {
      isAppQuitting = true;
    });
    const handleCreated = (_event, win) => {
      try {
        exports.installContextMeter(win);
        void ensureMeterInjected(win, { force: false });
      } catch {}
    };
    app.on('browser-window-created', handleCreated);
    app.on('base-window-created', handleCreated);
    app.on('activate', () => {
      try {
        const utils = require('./utils');
        const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
        for (const w of wins) {
          exports.installContextMeter(w);
          void ensureMeterInjected(w, { force: true });
        }
      } catch {}
    });
    app.on('second-instance', () => {
      try {
        const utils = require('./utils');
        setTimeout(() => {
          try {
            const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
            for (const w of wins) {
              exports.installContextMeter(w);
              void ensureMeterInjected(w, { force: true });
            }
          } catch {}
        }, 120);
      } catch {}
    });
  }
} catch {}

function isHostRunInBackgroundEnabled() {
  try {
    if (process.platform === 'darwin') return true;
    let storagePath = null;
    if (app && typeof app.getPath === 'function') {
      try {
        storagePath = path.join(app.getPath('userData'), 'app_storage.json');
      } catch {}
    }
    if (!storagePath) {
      const home = typeof os.homedir === 'function' ? os.homedir() : '';
      const appData = process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
      storagePath = path.join(appData, 'Antigravity', 'app_storage.json');
    }
    if (!fs.existsSync(storagePath)) return false;
    const content = fs.readFileSync(storagePath, 'utf8');
    const data = JSON.parse(content);
    return data?.runInBackground === 'true' || data?.runInBackground === true;
  } catch {
    return false;
  }
}

function shouldInterceptWindowClose(win, options = {}) {
  try {
    if (isAppQuitting) return false;
    const isBgEnabled = typeof options.isBackgroundEnabled === 'function'
      ? options.isBackgroundEnabled()
      : isHostRunInBackgroundEnabled();
    if (!isBgEnabled) return false;

    let wins = null;
    if (typeof options.getHubWindows === 'function') {
      wins = options.getHubWindows();
    } else {
      try {
        const utils = require('./utils');
        if (typeof utils.getHubWindows === 'function') wins = utils.getHubWindows();
      } catch {}
    }

    if (!Array.isArray(wins) || !wins.includes(win)) return false;

    const remainingVisible = wins.filter(
      w => w !== win && !w.isDestroyed?.() && (typeof w.isVisible === 'function' ? w.isVisible() : true)
    );
    return remainingVisible.length === 0;
  } catch {
    return false;
  }
}


exports.MAIN_CAPABILITIES = MAIN_CAPABILITIES;
exports.handleRestartHost = handleRestartHost;
exports.handleModulesStatus = handleModulesStatus;
exports.registerMeterIpcHandlers = registerMeterIpcHandlers;
exports.setAppQuitting = setAppQuitting;
exports.getAppQuitting = getAppQuitting;
exports.shouldInterceptWindowClose = shouldInterceptWindowClose;
exports.isHostRunInBackgroundEnabled = isHostRunInBackgroundEnabled;
exports.getWindowWebContents = getWindowWebContents;
