'use strict';
/**
 * 模块状态与版本配置管理 (modules-config.js)
 * 纯只读安全版：仅管理 ContextMeter 监控组件配置、文件互斥锁与磁盘 ASAR 状态检查。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getStateDir, findAsarPath, loadAsarEngine, builtinAsar } = require('./asar-engine');
const { safeWriteJsonSync } = require('./meter-storage');

const SCHEMA_VERSION = '0.8.8';
const FALLBACK_PROJECT_VERSION = '0.8.8';

function resolveProjectVersion() {
  for (const pkgPath of [
    path.join(__dirname, 'package.json'),
    path.join(__dirname, '..', 'package.json')
  ]) {
    try {
      if (fs.existsSync(pkgPath)) {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (
          parsed &&
          typeof parsed.version === 'string' &&
          parsed.version.trim() &&
          (parsed.name === 'agy-usage' || parsed.name === 'antigravity-context-viewer' || fs.existsSync(path.join(path.dirname(pkgPath), 'meter-core.js')))
        ) {
          return parsed.version.trim();
        }
      }
    } catch {}
  }
  return FALLBACK_PROJECT_VERSION;
}

const PROJECT_VERSION = resolveProjectVersion();

const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  modules: {
    meter: {
      enabled: true
    }
  }
};

function resolveModulesStateDir(options = {}) {
  if (options && typeof options.stateDir === 'string' && options.stateDir.trim()) {
    return path.resolve(options.stateDir.trim());
  }
  return getStateDir();
}

function getModulesConfigPath(options = {}) {
  return path.join(resolveModulesStateDir(options), 'modules.json');
}

function loadModulesConfig(options = {}) {
  const cfgPath = getModulesConfigPath(options);
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!fs.existsSync(cfgPath)) {
    return base;
  }
  try {
    const rawText = fs.readFileSync(cfgPath, 'utf8');
    if (!rawText || !rawText.trim()) {
      return {
        ...base,
        __configCorrupted: true,
        __configError: '配置文件为空',
        _meta: { corrupted: true, error: '配置文件为空', path: cfgPath }
      };
    }
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.modules !== undefined && (!parsed.modules || typeof parsed.modules !== 'object' || Array.isArray(parsed.modules)))) {
      return {
        ...base,
        __configCorrupted: true,
        __configError: '配置结构无效',
        _meta: { corrupted: true, error: '配置结构无效', path: cfgPath }
      };
    }
    if (parsed.modules?.meter && typeof parsed.modules.meter.enabled === 'boolean') {
      base.modules.meter.enabled = parsed.modules.meter.enabled;
    }
    return base;
  } catch (err) {
    const errMsg = err?.message || 'JSON 解析失败';
    return {
      ...base,
      __configCorrupted: true,
      __configError: errMsg,
      _meta: {
        corrupted: true,
        error: errMsg,
        path: cfgPath
      }
    };
  }
}

function saveModulesConfig(cfg, options = {}) {
  const cfgPath = getModulesConfigPath(options);
  try {
    if (fs.existsSync(cfgPath)) {
      const existingRaw = fs.readFileSync(cfgPath, 'utf8');
      let isBad = !existingRaw || !existingRaw.trim();
      if (!isBad) {
        try {
          const p = JSON.parse(existingRaw);
          if (!p || typeof p !== 'object' || Array.isArray(p) || (p.modules !== undefined && (!p.modules || typeof p.modules !== 'object' || Array.isArray(p.modules)))) {
            isBad = true;
          }
        } catch {
          isBad = true;
        }
      }
      if (isBad) {
        const bakPath = `${cfgPath}.corrupt.${Date.now()}.bak`;
        fs.writeFileSync(bakPath, existingRaw, 'utf8');
      }
    }
  } catch {}
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    modules: {
      meter: {
        enabled: cfg?.modules?.meter?.enabled !== false
      }
    }
  };
  return safeWriteJsonSync(cfgPath, payload, {
    validate: parsed => Boolean(parsed && parsed.modules && typeof parsed.modules.meter?.enabled === 'boolean')
  });
}

/**
 * 基于文件系统的跨进程互斥锁（保护 ASAR 安装与还原）
 */
function acquireFileLock(targetFile, options = {}) {
  const lockPath = `${path.resolve(targetFile)}.lock`;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 60000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      fs.closeSync(fd);
      let released = false;
      return {
        lockPath,
        release() {
          if (released) return;
          released = true;
          try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch {}
        }
      };
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const st = fs.statSync(lockPath);
          let lockDead = (Date.now() - st.mtimeMs) > staleMs;
          if (!lockDead) {
            const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (raw?.pid && Number.isInteger(raw.pid)) {
              try { process.kill(raw.pid, 0); } catch (killErr) {
                if (killErr && killErr.code === 'ESRCH') lockDead = true;
              }
            }
          }
          if (lockDead) {
            try { fs.unlinkSync(lockPath); continue; } catch {}
          }
        } catch {}
      }
      if (Date.now() >= deadline) {
        throw new Error(`获取目标文件互斥锁超时 (${lockPath})：当前有其他安装或卸载任务正在操作该目标。`);
      }
      const waitUntil = Date.now() + 80;
      while (Date.now() < waitUntil) { /* short spin */ }
    }
  }
}

const diskModulesCache = new Map();

function invalidateDiskModulesCache(customAsarPath = null) {
  if (!customAsarPath) {
    diskModulesCache.clear();
    return;
  }
  try {
    diskModulesCache.delete(path.resolve(customAsarPath));
  } catch {
    diskModulesCache.clear();
  }
}

function inspectDiskModules(customAsarPath = null, options = {}) {
  const { TAGS } = require('./modular-installer');
  let asarPath;
  try {
    asarPath = findAsarPath(customAsarPath);
  } catch (e) {
    return { found: false, asarPath: customAsarPath || null, meter: false, meterReady: false, chinese: false, proxy: false, error: e.message };
  }

  const useCache = options.useCache !== false && !options._builtinAsar;
  const cacheKey = path.resolve(asarPath);
  let statSig = null;
  try {
    const st = fs.statSync(asarPath);
    statSig = `${st.size}:${st.mtimeMs}`;
    if (useCache && diskModulesCache.has(cacheKey)) {
      const hit = diskModulesCache.get(cacheKey);
      if (hit && hit.statSig === statSig) return hit.result;
    }
  } catch {}

  const asar = options._builtinAsar || loadAsarEngine();
  const primaryAsar = options._builtinAsar || builtinAsar || asar;
  let utilsStr = '';
  let preloadStr = '';
  let entries = [];
  try {
    try {
      utilsStr = Buffer.from(primaryAsar.extractFile(asarPath, 'dist/utils.js')).toString('utf8');
    } catch {
      utilsStr = Buffer.from(asar.extractFile(asarPath, 'dist/utils.js')).toString('utf8');
    }
    try {
      preloadStr = Buffer.from(primaryAsar.extractFile(asarPath, 'dist/preload.js')).toString('utf8');
    } catch {
      preloadStr = Buffer.from(asar.extractFile(asarPath, 'dist/preload.js')).toString('utf8');
    }
    try {
      entries = primaryAsar.listPackage(asarPath);
    } catch {
      entries = asar.listPackage(asarPath);
    }
  } catch (e) {
    return { found: false, asarPath, meter: false, meterReady: false, chinese: false, proxy: false, error: e.message };
  }

  const normalizedEntries = new Set(
    (Array.isArray(entries) ? entries : []).map(item => {
      const clean = String(item || '').replace(/\\/g, '/').replace(/^\/+/, '');
      return clean ? '/' + clean : '';
    }).filter(Boolean)
  );

  const meterInjected = utilsStr.includes(TAGS.METER_UTILS_START) || utilsStr.includes('installContextMeter');
  const meterPreload = preloadStr.includes(TAGS.METER_PRELOAD_START) || preloadStr.includes('contextMeterAPI');
  const meterFilesOk = normalizedEntries.has('/dist/meter-main.js') && normalizedEntries.has('/dist/meter-core.js');
  const meterReady = meterInjected && meterPreload && meterFilesOk;

  const result = {
    found: true,
    asarPath,
    meter: meterInjected,
    meterReady,
    chinese: false,
    proxy: false
  };
  if (useCache && statSig) {
    diskModulesCache.set(cacheKey, { statSig, result });
  }
  return result;
}

function getHostCoreBuildId(baseDir = null) {
  try {
    const root = baseDir || __dirname;
    const h = crypto.createHash('sha256');
    for (const f of [
      'cli.js',
      'install.js',
      'restore.js',
      'live-host.js',
      'local-api.js',
      'meter-main.js',
      'meter-core.js',
      'meter-collector.js',
      'meter-storage.js',
      'meter-cli-launcher.js',
      'modules-config.js',
      'asar-engine.js',
      'package.json'
    ]) {
      const p = path.join(root, f);
      if (fs.existsSync(p)) h.update(f + ':').update(fs.readFileSync(p));
    }
    return h.digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

module.exports = {
  SCHEMA_VERSION,
  PROJECT_VERSION,
  DEFAULT_CONFIG,
  getModulesConfigPath,
  loadModulesConfig,
  saveModulesConfig,
  acquireFileLock,
  inspectDiskModules,
  invalidateDiskModulesCache,
  getHostCoreBuildId
};
