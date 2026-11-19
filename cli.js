#!/usr/bin/env node
'use strict';
process.noAsar = true;

/**
 * Antigravity Context Meter CLI (macOS & Linux Safe Read-Only Edition)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { loadAsarEngine, getStateDir, getAppDataDir, isIsolatedTestPath } = require('./asar-engine');
const { discoverAntigravityCdp, createCdpClient, parseExplicitPort, normalizeLoopbackOrigin } = require('./local-api');
const {
  install,
  findAsarPath,
  tryHotInject,
  tryHotInjectDetailed,
  probeLiveHostRuntimeInfo,
  shutdownLiveHostGracefully,
  extractAsarFile,
  getRendererBuildId,
  getHostCoreBuildId,
  getWatchBundleBuildId
} = require('./install');
const { restore, tryHotDispose } = require('./restore');
const { resolvePython, syncLiveRuntimeBundle } = require('./meter-collector');
const { PROJECT_VERSION } = require('./modules-config');

const LOCAL_EDITION_ID = 'StepaniaH/agy-usage';

const asar = loadAsarEngine();

function isPidAliveForUser(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function getWatchPidPath(stateDir = null) {
  return path.join(stateDir || getStateDir(), 'watch.pid');
}

function getWatchMetaPath(stateDir = null) {
  return path.join(stateDir || getStateDir(), 'watch-meta.json');
}

function readWatchMetaInfo(stateDir = null) {
  const metaPath = getWatchMetaPath(stateDir);
  try {
    if (!fs.existsSync(metaPath)) return null;
    const raw = fs.readFileSync(metaPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number.isInteger(Number(parsed.pid)) && Number(parsed.pid) > 0 ? Number(parsed.pid) : null,
      script: typeof parsed.script === 'string' ? parsed.script : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      repo: typeof parsed.repo === 'string' ? parsed.repo : null,
      buildId: typeof parsed.buildId === 'string' ? parsed.buildId : null,
      rendererBuildId: typeof parsed.rendererBuildId === 'string' ? parsed.rendererBuildId : null,
      hostBuildId: typeof parsed.hostBuildId === 'string' ? parsed.hostBuildId : null,
      rendererMtimeMs: Number.isFinite(parsed.rendererMtimeMs) ? parsed.rendererMtimeMs : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
    };
  } catch {
    return null;
  }
}

function readWatchLockInfo(stateDir = null) {
  const pidPath = getWatchPidPath(stateDir);
  try {
    if (!fs.existsSync(pidPath)) return null;
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      const n = Number(parsed?.pid);
      if (!Number.isInteger(n) || n <= 0) return null;
      return {
        pid: n,
        format: 'json',
        script: typeof parsed.script === 'string' ? parsed.script : null,
        version: typeof parsed.version === 'string' ? parsed.version : null,
        repo: typeof parsed.repo === 'string' ? parsed.repo : null,
        buildId: typeof parsed.buildId === 'string' ? parsed.buildId : null,
        rendererBuildId: typeof parsed.rendererBuildId === 'string' ? parsed.rendererBuildId : null
      };
    }
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    return { pid: n, format: 'legacy', script: null, version: null, repo: null, buildId: null, rendererBuildId: null };
  } catch {
    return null;
  }
}

function readWatchPid(stateDir = null) {
  const info = readWatchLockInfo(stateDir);
  return info ? info.pid : null;
}

function inspectProcessCommandPosix(pid, customInspector = null) {
  if (typeof customInspector === 'function') {
    try { return String(customInspector(pid) || ''); } catch { return ''; }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function shouldTakeOverWatchLock(lockInfo, options = {}) {
  if (!lockInfo || !lockInfo.pid) return false;
  const expectedScript = path.resolve(options.watchScript || __filename);
  const expectedVersion = options.expectedVersion || PROJECT_VERSION;
  const expectedRepo = options.expectedRepo || LOCAL_EDITION_ID;
  const hasExplicitBuildId = options.expectedBuildId !== undefined;
  const expectedBuildId = hasExplicitBuildId
    ? options.expectedBuildId
    : (options.expectedBundleBuildId !== undefined
      ? options.expectedBundleBuildId
      : getWatchBundleBuildId(options.bundleDir || null));

  if (lockInfo.format === 'json') {
    const sameScript = Boolean(lockInfo.script && path.resolve(lockInfo.script) === expectedScript);
    const sameVersion = lockInfo.version === expectedVersion;
    const sameRepo = lockInfo.repo === expectedRepo;
    const sameBuildId = !expectedBuildId || lockInfo.buildId === expectedBuildId;
    if (!(sameScript && sameVersion && sameRepo && sameBuildId)) {
      return true;
    }
    if (!hasExplicitBuildId && options.stateDir && options.requireWatchMeta !== false) {
      const meta = readWatchMetaInfo(options.stateDir);
      if (!meta) return true;
      if (meta.pid && Number(meta.pid) !== Number(lockInfo.pid)) return true;
      if (expectedBuildId && meta.buildId !== expectedBuildId) return true;
    }
    return false;
  }

  const cmd = inspectProcessCommandPosix(lockInfo.pid, options._inspectProcessCommand);
  if (cmd && cmd.includes('cli.js') && cmd.includes('watch')) {
    return !cmd.includes(expectedScript) || Boolean(expectedBuildId);
  }
  return false;
}

async function terminateProcessGracefully(pid, graceMs = 2000) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  if (!isPidAliveForUser(n)) return false;
  try {
    process.kill(n, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAliveForUser(n)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  if (isPidAliveForUser(n)) {
    try { process.kill(n, 'SIGKILL'); } catch {}
  }
  return true;
}

async function stopLiveBridge(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const statePath = path.join(stateDir, '.live-session.json');
  const legacyPath = path.join(__dirname, '.live-session.json');
  let stopped = false;
  let stoppedPid = null;
  for (const liveFile of Array.from(new Set([statePath, legacyPath]))) {
    if (!fs.existsSync(liveFile)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
      if (info && info.pid) {
        await shutdownLiveHostGracefully(info);
        stopped = true;
        stoppedPid = info.pid;
      }
    } catch {}
    try { if (fs.existsSync(liveFile)) fs.unlinkSync(liveFile); } catch {}
  }
  return { stopped, pid: stoppedPid };
}

async function queryLiveWindow(options = {}) {
  try {
    const appData = getAppDataDir(options);
    if ((process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && !options.port && !options.appDataDir) {
      if (!isIsolatedTestPath(appData)) {
        return { running: false };
      }
    }
    const discovered = await discoverAntigravityCdp(options);
    const matchedTargets = Array.isArray(discovered.pages) ? discovered.pages : [];
    const target = discovered.page || matchedTargets[0];
    const port = discovered.port;
    if (!target) return { running: true, cdpPort: port, pageFound: false, origins: [] };
    const origin = normalizeLoopbackOrigin(target.url) || new URL(target.url).origin;
    const origins = Array.from(new Set(matchedTargets.map(p => normalizeLoopbackOrigin(p.url)).filter(Boolean)));

    const client = await createCdpClient(target.webSocketDebuggerUrl, { timeoutMs: 4000 });
    try {
      const status = await client.evaluateValue(`(async () => {
        const s = window.__AGContextMeter?.snapshot();
        const root = document.getElementById('ag-context-meter')?.shadowRoot;
        let ipcRuntimeInfo = null;
        if (typeof window.contextMeterAPI?.getRuntimeInfo === 'function') {
          try { ipcRuntimeInfo = await window.contextMeterAPI.getRuntimeInfo(); } catch {}
        }
        const bootBackend = window.__AGContextMeterBootBackend || null;
        const backendStatus = typeof window.__AGContextMeter?.getBackendStatusForTest === 'function'
          ? window.__AGContextMeter.getBackendStatusForTest()
          : null;
        const quotaState = typeof window.__AGContextMeter?.getModelQuotaStateForTest === 'function'
          ? window.__AGContextMeter.getModelQuotaStateForTest()
          : null;
        return {
          active: Boolean(window.__AGContextMeter),
          version: window.__AGContextMeter?.version || null,
          hasIpcBridge: Boolean(window.contextMeterAPI?.scan && window.contextMeterAPI?.saveSettings && window.contextMeterAPI?.launchCli),
          hasQuotaIpcBridge: Boolean(window.contextMeterAPI?.getQuota),
          hasRestartBridge: Boolean(window.contextMeterAPI?.restartHost),
          ipcBackendVersion: ipcRuntimeInfo?.backendVersion || bootBackend?.backendVersion || null,
          liveBridgeAttached: window.__AGContextMeterLive ? {
            version: window.__AGContextMeterLive.version || null,
            port: window.__AGContextMeterLive.port || null,
            backendSource: window.__AGContextMeterLive.backendSource || 'live-host'
          } : null,
          effectiveBackendSource: backendStatus?.backendSource || (ipcRuntimeInfo?.backendVersion ? 'electron-ipc' : null),
          effectiveBackendVersion: backendStatus?.backendVersion || quotaState?.state?.collectorVersion || ipcRuntimeInfo?.backendVersion || null,
          badgeText: root?.getElementById('amount')?.textContent || null,
          route: s?.route || null,
          latest: s?.latest || null
        };
      })()`, { timeoutMs: 4000 });
      return { running: true, cdpPort: port, pageFound: true, origin, origins, windowCount: matchedTargets.length, ...(status || {}) };
    } finally {
      client.close();
    }
  } catch (e) {
    return { running: false, error: e.message };
  }
}

async function ensureLiveBridgeIfNeeded(liveSnapshot = null, options = {}) {
  const live = liveSnapshot || await queryLiveWindow(options);
  if (!live.running || !live.pageFound) {
    return { needed: false, ready: false, reason: 'no_running_window', liveInfo: null, previousLiveInfo: null };
  }
  let currentPkgVersion = null;
  try {
    currentPkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || null;
  } catch {}

  const stateDir = options.stateDir || getStateDir();
  const statePath = path.join(stateDir, '.live-session.json');
  const legacyPath = path.join(__dirname, '.live-session.json');
  const liveSessionPath = fs.existsSync(statePath) ? statePath : legacyPath;

  let existingInfo = null;
  if (fs.existsSync(liveSessionPath)) {
    try {
      existingInfo = JSON.parse(fs.readFileSync(liveSessionPath, 'utf8'));
    } catch {}
  }

  const expectedOrigins = Array.isArray(live.origins) && live.origins.length
    ? live.origins
    : (live.origin ? [live.origin] : []);

  const electronIpcAligned = Boolean(
    live.hasIpcBridge &&
    live.hasQuotaIpcBridge &&
    currentPkgVersion &&
    live.ipcBackendVersion === currentPkgVersion
  );
  if (electronIpcAligned) {
    return {
      needed: false,
      ready: true,
      backendSource: 'electron-ipc',
      backendVersion: live.ipcBackendVersion,
      clearStaleLiveBridge: true,
      liveInfo: null,
      previousLiveInfo: existingInfo
    };
  }

  const coversAllOrigins = (info) => {
    if (!info) return false;
    const covered = new Set([...(Array.isArray(info.origins) ? info.origins : []), info.origin].filter(Boolean));
    return expectedOrigins.every(o => covered.has(o));
  };

  const expectedHostBuildId = getHostCoreBuildId(__dirname);
  if (existingInfo && existingInfo.pid) {
    const info = existingInfo;
    let pidAlive = false;
    try { process.kill(info.pid, 0); pidAlive = true; } catch {}
    const infoBuildMatch = !expectedHostBuildId || info.hostBuildId === expectedHostBuildId;
    if (pidAlive && coversAllOrigins(info) && info.hasQuota && (!currentPkgVersion || info.version === currentPkgVersion) && infoBuildMatch) {
      const probe = await probeLiveHostRuntimeInfo(info, expectedOrigins[0]);
      const probeBuildMatch = !expectedHostBuildId || probe?.hostBuildId === expectedHostBuildId;
      if (probe && probe.ok && probe.capabilities?.quota && (!currentPkgVersion || probe.backendVersion === currentPkgVersion) && probeBuildMatch) {
        return {
          needed: true,
          ready: true,
          reused: true,
          backendSource: 'live-host',
          backendVersion: probe.backendVersion || info.version,
          liveInfo: { ...info, capabilities: probe.capabilities || info.capabilities },
          previousLiveInfo: null
        };
      }
    }
  }

  const stagingStamp = path.join(stateDir, `.live-session.staging.${process.pid}.${Date.now()}.json`);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    if (fs.existsSync(stagingStamp)) fs.unlinkSync(stagingStamp);
  } catch {}

  const liveRuntimeScript = path.join(stateDir, 'live-runtime', 'live-host.js');
  let syncedRuntimeDir = null;
  try {
    syncedRuntimeDir = syncLiveRuntimeBundle(__dirname, { version: currentPkgVersion, stateDir });
  } catch {}
  const hostEntryScript = (syncedRuntimeDir && fs.existsSync(liveRuntimeScript))
    ? liveRuntimeScript
    : (fs.existsSync(liveRuntimeScript) && !__dirname.toLowerCase().includes(os.tmpdir().toLowerCase())
      ? liveRuntimeScript
      : path.join(__dirname, 'live-host.js'));

  const childEnv = {
    ...process.env,
    ...(options.stateDir ? { AG_METER_STATE_DIR: stateDir } : {}),
    ...(options.appDataDir ? { APPDATA: options.appDataDir } : {}),
    AG_LIVE_STAMP_PATH: stagingStamp,
    ...(expectedOrigins.length ? { AG_LIVE_ORIGINS: JSON.stringify(expectedOrigins) } : {})
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const originsB64 = expectedOrigins.length
    ? Buffer.from(JSON.stringify(expectedOrigins), 'utf8').toString('base64')
    : '';
  const hostArgs = [hostEntryScript, '--stamp', stagingStamp];
  if (originsB64) hostArgs.push('--origins-b64', originsB64);

  let spawnedChild = null;
  let spawnedPid = null;
  let newInfo = null;
  try {
    spawnedChild = spawn(process.execPath, hostArgs, {
      cwd: path.dirname(hostEntryScript),
      detached: true,
      stdio: 'ignore',
      env: childEnv
    });
    spawnedChild.unref();
    spawnedPid = spawnedChild.pid || null;

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      if (!fs.existsSync(stagingStamp)) continue;
      try {
        const cand = JSON.parse(fs.readFileSync(stagingStamp, 'utf8'));
        if (cand && cand.pid && cand.port && cand.token) {
          process.kill(cand.pid, 0);
          const probe = await probeLiveHostRuntimeInfo(cand, expectedOrigins[0]);
          if (probe && probe.ok && (!currentPkgVersion || probe.backendVersion === currentPkgVersion)) {
            newInfo = {
              ...cand,
              version: probe.backendVersion || cand.version || currentPkgVersion,
              backendSource: 'live-host',
              capabilities: probe.capabilities || cand.capabilities || null,
              origins: probe.origins || cand.origins || expectedOrigins
            };
            break;
          }
        }
      } catch {}
    }
  } catch {}

  try { if (fs.existsSync(stagingStamp)) fs.unlinkSync(stagingStamp); } catch {}

  if (!newInfo) {
    const killPid = spawnedPid || spawnedChild?.pid;
    if (killPid) {
      try { process.kill(killPid); } catch {}
    }
    return {
      needed: true,
      ready: false,
      reason: 'live_host_probe_failed',
      liveInfo: null,
      previousLiveInfo: existingInfo
    };
  }

  try {
    const tmpMain = `${statePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpMain, JSON.stringify(newInfo, null, 2));
    fs.renameSync(tmpMain, statePath);
  } catch {
    try { fs.writeFileSync(statePath, JSON.stringify(newInfo, null, 2)); } catch {}
  }

  const prevToShutdown = (existingInfo && existingInfo.pid && existingInfo.pid !== newInfo.pid)
    ? existingInfo
    : null;
  return {
    needed: true,
    ready: true,
    reused: false,
    backendSource: 'live-host',
    backendVersion: newInfo.version,
    liveInfo: newInfo,
    previousLiveInfo: prevToShutdown,
    statePath
  };
}

async function rollbackPreparedLiveBridge(bridgePrep) {
  if (!bridgePrep || bridgePrep.reused || !bridgePrep.liveInfo) return { rolledBack: false };
  const statePath = bridgePrep.statePath || path.join(getStateDir(), '.live-session.json');
  try {
    await shutdownLiveHostGracefully(bridgePrep.liveInfo);
  } catch {}
  try {
    if (bridgePrep.previousLiveInfo) {
      const tmpRestore = `${statePath}.rollback-${process.pid}`;
      fs.writeFileSync(tmpRestore, JSON.stringify(bridgePrep.previousLiveInfo, null, 2));
      fs.renameSync(tmpRestore, statePath);
    } else if (fs.existsSync(statePath)) {
      const cur = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (cur && cur.pid === bridgePrep.liveInfo.pid) {
        fs.unlinkSync(statePath);
      }
    }
  } catch {}
  return { rolledBack: true };
}

async function runWatchDaemon(options = {}) {
  const { loadModulesConfig } = require('./modules-config');
  const stateDir = options.stateDir || getStateDir();
  const rootDir = options.bundleDir ? path.resolve(options.bundleDir) : __dirname;
  const pidPath = getWatchPidPath(stateDir);
  const metaPath = getWatchMetaPath(stateDir);
  const expectedScript = path.resolve(options.watchScript || __filename);
  const expectedVersion = options.expectedVersion || PROJECT_VERSION;
  const expectedRepo = options.expectedRepo || LOCAL_EDITION_ID;
  const rendererFilePath = path.join(rootDir, 'meter-renderer.js');

  const getRendererMtimeMs = () => {
    try {
      return fs.statSync(rendererFilePath).mtimeMs;
    } catch {
      return null;
    }
  };

  let activeRendererBuildId = options.expectedBuildId !== undefined
    ? options.expectedBuildId
    : getRendererBuildId(rendererFilePath);
  let activeBundleBuildId = options.expectedBuildId !== undefined
    ? options.expectedBuildId
    : (options.expectedBundleBuildId !== undefined ? options.expectedBundleBuildId : getWatchBundleBuildId(rootDir));
  const startupHostBuildId = getHostCoreBuildId(rootDir);
  const startedAtIso = new Date().toISOString();

  let replacedPid = null;
  const existingLock = readWatchLockInfo(stateDir);
  const existingPid = existingLock ? existingLock.pid : null;
  if (existingPid && existingPid !== process.pid && isPidAliveForUser(existingPid)) {
    const takeoverOpts = {
      ...options,
      stateDir,
      bundleDir: rootDir,
      watchScript: expectedScript,
      expectedVersion,
      expectedRepo,
      expectedBundleBuildId: activeBundleBuildId
    };
    if (shouldTakeOverWatchLock(existingLock, takeoverOpts)) {
      if (!options.silent) {
        console.log(`🔄 [Watch] 检测到旧版或异源守护进程 (PID ${existingPid})，正在安全接管...`);
      }
      await terminateProcessGracefully(existingPid, 2000);
      await stopLiveBridge({ stateDir });
      try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch {}
      await new Promise(r => setTimeout(r, 60));
      replacedPid = existingPid;
    } else {
      if (!options.silent) {
        console.log(`ℹ️ [Watch] 已有运行中的守护进程 (PID ${existingPid})，本次实例自动退出。`);
      }
      return { ok: true, alreadyRunning: true, pid: existingPid };
    }
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const persistWatchLockAndMeta = () => {
    const rendererMtimeMs = getRendererMtimeMs();
    fs.writeFileSync(pidPath, JSON.stringify({
      pid: process.pid,
      script: expectedScript,
      version: expectedVersion,
      repo: expectedRepo,
      buildId: activeBundleBuildId,
      rendererBuildId: activeRendererBuildId
    }) + '\n', 'utf8');
    fs.writeFileSync(metaPath, JSON.stringify({
      pid: process.pid,
      script: expectedScript,
      version: expectedVersion,
      repo: expectedRepo,
      buildId: activeBundleBuildId,
      rendererBuildId: activeRendererBuildId,
      hostBuildId: startupHostBuildId,
      rendererMtimeMs,
      startedAt: startedAtIso,
      updatedAt: new Date().toISOString()
    }, null, 2) + '\n', 'utf8');
  };
  persistWatchLockAndMeta();

  const startupTimeoutMs = options.startupTimeoutMs ?? Number(process.env.AG_WATCH_STARTUP_TIMEOUT_MS || 60000);
  const startupPollMs = options.startupPollMs ?? Number(process.env.AG_WATCH_STARTUP_POLL_MS || 1000);
  const pollIntervalMs = options.pollIntervalMs ?? Number(process.env.AG_WATCH_POLL_MS || 3000);
  const maxConsecutiveMisses = options.maxConsecutiveMisses ?? Number(process.env.AG_WATCH_MAX_MISSES || 3);
  const maxCycles = options.maxCycles ?? Infinity;

  let stopped = false;
  let selfReloaded = false;
  let wakeSleep = null;
  const sleep = ms => new Promise(resolve => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });

  const requestStop = () => {
    stopped = true;
    if (wakeSleep) wakeSleep();
  };

  const onSigInt = () => requestStop();
  const onSigTerm = () => requestStop();
  if (options.handleSignals !== false) {
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
  }
  if (options.signal && typeof options.signal.addEventListener === 'function') {
    if (options.signal.aborted) requestStop();
    else options.signal.addEventListener('abort', requestStop, { once: true });
  }

  const cleanupLockfile = () => {
    try {
      if (readWatchPid(stateDir) === process.pid) {
        if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      }
    } catch {}
  };

  const startedAt = Date.now();
  let windowEverSeen = false;
  let consecutiveMisses = 0;
  let injectedCount = 0;
  let disposedCount = 0;
  let cycles = 0;
  let exitReason = 'stopped';

  const discoverFn = typeof options._discoverWindow === 'function'
    ? options._discoverWindow
    : () => queryLiveWindow(options);
  const ensureBridgeFn = typeof options._ensureBridge === 'function'
    ? options._ensureBridge
    : (liveSnap) => ensureLiveBridgeIfNeeded(liveSnap, { ...options, stateDir });
  const hotInjectFn = typeof options._hotInject === 'function'
    ? options._hotInject
    : (injectOpts) => tryHotInjectDetailed({ ...options, ...injectOpts, stateDir });
  const hotDisposeFn = typeof options._hotDispose === 'function'
    ? options._hotDispose
    : () => tryHotDispose(options);

  try {
    while (!stopped && cycles < maxCycles) {
      cycles++;

      const currentHostBuildId = getHostCoreBuildId(rootDir);
      const currentRendererBuildId = options.expectedBuildId !== undefined
        ? options.expectedBuildId
        : getRendererBuildId(rendererFilePath);
      const currentBundleBuildId = options.expectedBuildId !== undefined
        ? options.expectedBuildId
        : (options.expectedBundleBuildId !== undefined ? options.expectedBundleBuildId : getWatchBundleBuildId(rootDir));

      if (startupHostBuildId && currentHostBuildId && currentHostBuildId !== startupHostBuildId) {
        const isTestEnv = process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
        const shouldSelfReload = options.selfReloadOnHostChange === true ||
          (!isTestEnv && options.selfReloadOnHostChange !== false && maxCycles === Infinity);
        if (shouldSelfReload) {
          if (!options.silent) {
            console.log(`🔄 [Watch] 检测到核心宿主脚本已更新 (${startupHostBuildId} -> ${currentHostBuildId})，正在热重启守护进程...`);
          }
          await stopLiveBridge({ stateDir });
          cleanupLockfile();
          const reloadArgs = [expectedScript, 'watch'];
          if (options.port) reloadArgs.push('--port', String(options.port));
          const reloadSpawner = options._spawnSelfReload || spawn;
          const child = reloadSpawner(process.execPath, reloadArgs, {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, AG_METER_STATE_DIR: stateDir }
          });
          child?.unref?.();
          selfReloaded = true;
          exitReason = 'host_bundle_reloaded';
          break;
        }
      }

      if (currentRendererBuildId !== activeRendererBuildId || currentBundleBuildId !== activeBundleBuildId) {
        activeRendererBuildId = currentRendererBuildId;
        activeBundleBuildId = currentBundleBuildId;
        persistWatchLockAndMeta();
      }

      const live = await discoverFn();
      const hasWindow = Boolean(live && live.running && live.pageFound);

      if (!hasWindow) {
        if (!windowEverSeen) {
          if (Date.now() - startedAt >= startupTimeoutMs) {
            exitReason = 'startup_timeout';
            break;
          }
          await sleep(startupPollMs);
          continue;
        }

        consecutiveMisses++;
        if (consecutiveMisses >= maxConsecutiveMisses) {
          exitReason = 'window_closed';
          break;
        }
        await sleep(pollIntervalMs);
        continue;
      }

      windowEverSeen = true;
      consecutiveMisses = 0;

      let meterEnabled = true;
      try {
        const cfg = loadModulesConfig({ stateDir });
        if (cfg?.modules?.meter?.enabled === false) {
          meterEnabled = false;
        }
      } catch {}

      if (!meterEnabled) {
        const didDispose = await hotDisposeFn();
        if (didDispose) disposedCount++;
        await stopLiveBridge({ stateDir });
      } else {
        const expectedOrigins = Array.isArray(live.origins) && live.origins.length
          ? live.origins
          : (live.origin ? [live.origin] : []);
        let coveredByLiveSession = false;
        try {
          const lp = path.join(stateDir, '.live-session.json');
          if (fs.existsSync(lp)) {
            const info = JSON.parse(fs.readFileSync(lp, 'utf8'));
            const covered = new Set([...(Array.isArray(info?.origins) ? info.origins : []), info?.origin].filter(Boolean));
            coveredByLiveSession = Boolean(
              info?.pid &&
              isPidAliveForUser(info.pid) &&
              info?.version === expectedVersion &&
              expectedOrigins.every(o => covered.has(o))
            );
          }
        } catch {}

        const needsBridge = Boolean(
          (!live.hasIpcBridge || live.ipcBackendVersion !== expectedVersion) &&
          (!coveredByLiveSession || !live.liveBridgeAttached || live.liveBridgeAttached.version !== expectedVersion)
        );
        const needsInject = Boolean(
          !live.active ||
          live.version !== expectedVersion ||
          (live.effectiveBackendVersion && live.effectiveBackendVersion !== expectedVersion) ||
          needsBridge
        );

        if (needsBridge || needsInject) {
          const bridgePrep = await ensureBridgeFn(live);
          const report = await hotInjectFn({
            source: 'cli-watch',
            liveInfo: bridgePrep?.liveInfo || null,
            liveVerified: Boolean(bridgePrep?.ready && bridgePrep?.liveInfo),
            preferLiveHost: Boolean(bridgePrep?.ready && bridgePrep?.backendSource === 'live-host'),
            clearStaleLiveBridge: Boolean(bridgePrep?.clearStaleLiveBridge)
          });
          if (report?.ok) {
            injectedCount += Number(report.injectedCount || 1);
            if (bridgePrep?.previousLiveInfo) {
              await shutdownLiveHostGracefully(bridgePrep.previousLiveInfo);
            }
          } else if (bridgePrep && !bridgePrep.reused && bridgePrep.liveInfo) {
            await rollbackPreparedLiveBridge(bridgePrep);
          }
        }
      }

      if (cycles >= maxCycles) {
        exitReason = 'max_cycles';
        break;
      }
      await sleep(pollIntervalMs);
    }
  } finally {
    if (options.handleSignals !== false) {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
    }
    if (!selfReloaded) {
      if (exitReason === 'window_closed' || exitReason === 'stopped' || exitReason === 'startup_timeout') {
        await stopLiveBridge({ stateDir });
      }
      cleanupLockfile();
    }
  }

  return {
    ok: true,
    pid: process.pid,
    replacedPid,
    exitReason,
    cycles,
    injectedCount,
    disposedCount,
    selfReloaded
  };
}

async function stopWatchDaemon(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const pidPath = getWatchPidPath(stateDir);
  const metaPath = getWatchMetaPath(stateDir);
  const watchPid = readWatchPid(stateDir);
  let watchStopped = false;

  if (watchPid && isPidAliveForUser(watchPid)) {
    watchStopped = await terminateProcessGracefully(watchPid, 2500);
  }
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch {}
  try {
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch {}

  const bridgeRes = await stopLiveBridge({ stateDir });
  return {
    ok: true,
    watchStopped,
    watchPid: watchPid || null,
    liveBridgeStopped: bridgeRes.stopped,
    liveBridgePid: bridgeRes.pid
  };
}

async function cmdStatus(customPath, cdpOptions = {}) {
  let asarPath = null;
  let version = null;
  let asarPatched = false;
  let diskVersion = null;
  let pluginVersion = null;
  try {
    pluginVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || null;
  } catch {}
  try {
    asarPath = findAsarPath(customPath);
    version = JSON.parse(extractAsarFile(asarPath, 'package.json').toString('utf8')).version;
    const utilsSource = extractAsarFile(asarPath, 'dist/utils.js').toString('utf8');
    asarPatched = utilsSource.includes('installContextMeter(win)');
    try {
      const manifestRaw = extractAsarFile(asarPath, 'dist/meter-manifest.json');
      const mObj = JSON.parse(manifestRaw.toString('utf8'));
      if (mObj?.version) diskVersion = mObj.version;
    } catch {}
    if (!diskVersion && asarPatched) {
      const mPath = path.join(getStateDir(), 'installation.json');
      if (fs.existsSync(mPath)) {
        const inst = JSON.parse(fs.readFileSync(mPath, 'utf8'));
        if (inst?.meterVersion) diskVersion = inst.meterVersion;
      }
    }
  } catch {}

  const live = await queryLiveWindow(cdpOptions);
  let liveSessionInfo = null;
  try {
    const lp = path.join(getStateDir(), '.live-session.json');
    if (fs.existsSync(lp)) {
      const raw = JSON.parse(fs.readFileSync(lp, 'utf8'));
      liveSessionInfo = { port: raw.port, pid: raw.pid, version: raw.version, backendSource: raw.backendSource || 'live-host', origins: raw.origins || (raw.origin ? [raw.origin] : []) };
    }
  } catch {}
  const watchPid = readWatchPid();
  const py = resolvePython();
  const report = {
    pluginVersion,
    diskVersion: diskVersion || null,
    asarPath,
    antigravityVersion: version,
    asarPatched,
    watcherRunning: Boolean(watchPid && isPidAliveForUser(watchPid)),
    watcherPid: (watchPid && isPidAliveForUser(watchPid)) ? watchPid : null,
    versions: {
      diskVersion: diskVersion || null,
      rendererVersion: live.version || null,
      ipcBackendVersion: live.ipcBackendVersion || null,
      liveHostVersion: liveSessionInfo?.version || null,
      effectiveBackendSource: live.effectiveBackendSource || live.liveBridgeAttached?.backendSource || null,
      effectiveBackendVersion: live.effectiveBackendVersion || live.liveBridgeAttached?.version || null
    },
    liveSession: liveSessionInfo,
    liveWindow: live,
    pythonAttachmentScanner: py || 'unavailable (optional)'
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function cmdCheck(customPath, cdpOptions = {}) {
  let pluginVersion = 'unknown';
  try {
    pluginVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown';
  } catch {}
  console.log(`🔍 [Antigravity 对话上下文查看器 v${pluginVersion}] 正在执行环境预检...`);
  console.log(`  - Node.js 运行时: ${process.version} (${process.execPath})`);
  try {
    const asarPath = findAsarPath(customPath);
    const version = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).version;
    console.log(`  - Antigravity 路径: ${asarPath} (v${version})`);
  } catch (e) {
    console.error(`  ❌ Antigravity 路径探测失败: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const py = resolvePython();
  console.log(`  - Python 附件深度解析器: ${py || '未检测到（基础上下文统计不受影响）'}`);
  const live = await queryLiveWindow(cdpOptions);
  console.log(`  - 运行中窗口 CDP 状态: ${live.running ? `已连接 (端口 ${live.cdpPort})` : '客户端未运行或未开启调试端口'}`);
  console.log('✅ 环境预检通过！');
}

async function main() {
  const args = process.argv.slice(2);
  const VALUE_FLAGS = new Set(['--path', '--backup', '--port']);
  let cmd = 'install';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('-')) {
      cmd = a.toLowerCase();
      break;
    }
  }
  const pathIdx = args.indexOf('--path');
  const customPath = pathIdx >= 0 ? args[pathIdx + 1] : null;
  const backupIdx = args.indexOf('--backup');
  const customBackup = backupIdx >= 0 ? args[backupIdx + 1] : null;
  const portIdx = args.indexOf('--port');
  const explicitPort = portIdx >= 0 ? parseExplicitPort(args[portIdx + 1]) : null;
  if (portIdx >= 0 && !explicitPort) {
    throw new Error(`无效的 --port 参数: ${args[portIdx + 1]}`);
  }
  const cdpOptions = explicitPort ? { port: explicitPort, strictPort: true } : {};
  const isForce = args.includes('--force');

  if (cmd === 'install') {
    const meterVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    console.log(`🚀 [agy-usage v${meterVersion}] 正在安装上下文查看器组件...`);
    const liveBefore = await queryLiveWindow(cdpOptions);
    const bridgePrep = await ensureLiveBridgeIfNeeded(liveBefore, cdpOptions);
    const hotInjectOptions = {
      ...cdpOptions,
      source: 'cli-install',
      liveInfo: bridgePrep.liveInfo || null,
      liveVerified: Boolean(bridgePrep.ready && bridgePrep.liveInfo),
      preferLiveHost: Boolean(bridgePrep.ready && bridgePrep.backendSource === 'live-host'),
      clearStaleLiveBridge: Boolean(bridgePrep.clearStaleLiveBridge)
    };
    let manifest;
    try {
      manifest = await install({ path: customPath, backup: customBackup, force: isForce, hotInjectOptions });
    } catch (installErr) {
      await rollbackPreparedLiveBridge(bridgePrep);
      throw installErr;
    }

    if (manifest.liveInjected && bridgePrep.previousLiveInfo) {
      await shutdownLiveHostGracefully(bridgePrep.previousLiveInfo);
    } else if (!manifest.liveInjected) {
      await rollbackPreparedLiveBridge(bridgePrep);
    }

    const reportBackendVersion = manifest.hotInjectReport?.backendVersion || bridgePrep.backendVersion || null;
    const reportBackendSource = manifest.hotInjectReport?.backendSource || bridgePrep.backendSource || null;
    const backendAligned = Boolean(
      manifest.liveInjected &&
      reportBackendVersion === meterVersion
    );
    const hasStaleMainProcess = Boolean(
      manifest.liveInjected &&
      !backendAligned &&
      liveBefore.running &&
      liveBefore.hasIpcBridge
    );
    console.log(`✅ 插件 v${manifest.meterVersion} 安装完成 (Antigravity 宿主 v${manifest.version})`);
    console.log(`✅ ASAR 组件注入完成: ${manifest.installed} (校验 ${manifest.originalFilesVerified} 个原文件)`);
    const { inspectDiskModules } = require('./modules-config');
    const disk = inspectDiskModules(manifest.installed);
    console.log(`   - 磁盘状态: ${disk.meterReady ? '✅ 已就绪' : '⚠️ 未就绪'}`);
    if (manifest.liveInjected && backendAligned) {
      console.log(`   - 运行中窗口: ✅ 界面与后台已热加载为 v${meterVersion} (${reportBackendSource === 'live-host' ? 'Live-Host 接管，无需重启' : 'Electron IPC 已对齐，无需重启'})`);
    } else if (manifest.liveInjected) {
      console.log(`   - 运行中窗口: ⚠️ 界面已热挂载为 v${meterVersion}，后台将在重启客户端后切换至新版 IPC`);
    } else {
      console.log('   - 运行中窗口: ⏳ 将在下次启动 Antigravity 时自动生效');
    }
    if (process.env.AG_EMIT_INSTALL_META === '1') {
      console.log('__AG_INSTALL_META__=' + JSON.stringify({
        meterVersion: manifest.meterVersion,
        liveInjected: Boolean(manifest.liveInjected),
        backendHotReloaded: Boolean(backendAligned),
        backendVersion: reportBackendVersion,
        backendSource: reportBackendSource,
        hasStaleMainProcess,
        hotInjectReport: manifest.hotInjectReport || null
      }));
    }
  } else if (cmd === 'live') {
    const liveBefore = await queryLiveWindow(cdpOptions);
    const bridgePrep = await ensureLiveBridgeIfNeeded(liveBefore, cdpOptions);
    let report;
    try {
      report = await tryHotInjectDetailed({
        ...cdpOptions,
        source: 'cli-live',
        liveInfo: bridgePrep.liveInfo || null,
        liveVerified: Boolean(bridgePrep.ready && bridgePrep.liveInfo),
        preferLiveHost: Boolean(bridgePrep.ready && bridgePrep.backendSource === 'live-host'),
        clearStaleLiveBridge: Boolean(bridgePrep.clearStaleLiveBridge)
      });
    } catch (liveErr) {
      await rollbackPreparedLiveBridge(bridgePrep);
      throw liveErr;
    }
    if (!report.ok) {
      await rollbackPreparedLiveBridge(bridgePrep);
      throw new Error('未检测到运行中的 Antigravity 主窗口，请先打开 Antigravity 或使用 node cli.js watch。');
    }
    if (bridgePrep.previousLiveInfo) {
      await shutdownLiveHostGracefully(bridgePrep.previousLiveInfo);
    }
    console.log(`✅ 已通过 CDP 热注入当前运行的 ${report.injectedCount}/${report.windowCount} 个 Antigravity 窗口！`);
  } else if (cmd === 'watch') {
    console.log('👀 [agy-usage] 免改盘守护模式启动中（不修改 app.asar）...');
    const res = await runWatchDaemon(cdpOptions);
    if (!res.alreadyRunning && !res.selfReloaded) {
      console.log(`👋 守护模式已停止 (${res.exitReason})，已清理临时桥接状态。`);
    }
  } else if (cmd === 'stop-watch') {
    const res = await stopWatchDaemon();
    if (res.watchStopped || res.liveBridgeStopped) {
      console.log(`✅ 已停止守护进程与本地桥接服务 (watch: ${res.watchStopped ? res.watchPid : '未运行'}, live-host: ${res.liveBridgeStopped ? res.liveBridgePid : '未运行'})`);
    } else {
      console.log('ℹ️ 当前没有正在运行的 watch 或 live-host 进程。');
    }
  } else if (cmd === 'restore' || cmd === 'uninstall') {
    await stopWatchDaemon();
    const res = await restore({ path: customPath, force: isForce, ...cdpOptions });
    console.log(`✅ 已完成卸载还原: ${res.restored}`);
    console.log(`   - 磁盘处理方式: ${res.inPlaceCleaned ? '原位精准剥离（保留宿主其他内容）' : '官方原版备份整包还原'}`);
    console.log(`   - 运行实例状态: ${res.hotDisposed ? '已通过 CDP 即时销毁运行实例' : '重启客户端后彻底清理'}`);
  } else if (cmd === 'status') {
    await cmdStatus(customPath, cdpOptions);
  } else if (cmd === 'check') {
    await cmdCheck(customPath, cdpOptions);
  } else {
    console.log(`用法:
  node cli.js install [--path <app.asar>]   持久化安装并热注入当前运行窗口
  node cli.js watch [--port <port>]         免改盘后台守护模式（随客户端启动自动挂载，关闭后自动退出）
  node cli.js stop-watch                    停止正在运行的 watch 守护进程与本地桥接服务
  node cli.js live [--port <port>]          免改盘 CDP 热挂载到当前运行窗口
  node cli.js status [--port <port>]        查看安装状态与当前对话实时上下文用量
  node cli.js check [--port <port>]         执行前置环境健康检查
  node cli.js restore [--path <app.asar>]   一键无损卸载并恢复备份`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ 执行失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  cmdStatus,
  cmdCheck,
  queryLiveWindow,
  ensureLiveBridgeIfNeeded,
  rollbackPreparedLiveBridge,
  stopLiveBridge,
  runWatchDaemon,
  stopWatchDaemon,
  getWatchPidPath,
  getWatchMetaPath,
  readWatchMetaInfo,
  readWatchLockInfo,
  readWatchPid,
  shouldTakeOverWatchLock,
  getRendererBuildId,
  getHostCoreBuildId,
  getWatchBundleBuildId,
  tryHotDispose
};
