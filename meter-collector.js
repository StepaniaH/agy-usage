'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { normalizeLoopbackOrigin } = require('./local-api');
const { fileURLToPath } = require('url');
const { spawn, spawnSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const origDateNow = Date.now;
const origFsMethods = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  copyFileSync: fs.copyFileSync,
  renameSync: fs.renameSync,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  existsSync: fs.existsSync
};
const { safeWriteJsonSync, safeReadJsonSync, withFileLockSync } = require('./meter-storage');
const {
  conversationWorkspaces,
  extractWorkspacePathFromUri,
  extractWorkspaceFromTrajectory,
  extractWorkspaceFromTranscriptFile,
  resolveCliExecutable,
  resolveCliWorkspace,
  buildCliSpawnEnv,
  launchCliSession
} = require('./meter-cli-launcher');

const {
  analyzeSteps,
  summarize,
  add,
  empty,
  measure,
  summarizeApiCost,
  calculateReferenceModelCost,
  resolveEffectivePlanStatus,
  sanitizeLegacyPlanTierName,
  parseUserPlanStatus,
  buildModelQuotaSnapshot,
  isDecorativeBadgeTagTitle,
  getModelPoolKey,
  getSharedQuotaGroupKey,
  extractCallId,
  parseGeneratorCall,
  extractModelString,
  normalizeModelId,
  resolveStableModelId,
  UNATTRIBUTED_MODEL_KEY,
  resolveModelUsageBucket,
  computeCacheReadStats,
  summarizeCacheReadStats,
  summarizeDailyMapCacheStats,
  normalizeSessionCallRecord,
  groupSessionCallsByTurns,
  isValidSpeedSample,
  MAX_SPEED_SAMPLES_PER_MODEL,
  calculateRequestApiCost
} = require('./meter-core');
const { PROJECT_VERSION } = require('./modules-config');

let cachedPython = undefined;
function resolvePython() {
  if (cachedPython !== undefined) return cachedPython;
  const home = os.homedir();
  const candidates = [];
  if (process.env.AG_METER_PYTHON) candidates.push(process.env.AG_METER_PYTHON);
  candidates.push(
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'bin/python3')
  );
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).size > 0) {
        cachedPython = p;
        return cachedPython;
      }
    } catch { }
  }
  for (const cmd of ['python3', 'python']) {
    try {
      const check = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 3000 });
      if (check.status === 0 && check.stdout.trim()) {
        cachedPython = check.stdout.trim().split(/\r?\n/)[0];
        return cachedPython;
      }
    } catch { }
  }
  cachedPython = null;
  return null;
}

/**
 * 规范化模型标识符（小写且去掉 proto 常见 MODEL_ 前缀）
 * @param {string} raw
 * @returns {string}
 */
function normalizeModelKeyForCap(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().toLowerCase().replace(/^model_/, '');
}

/**
 * 读取正整数能力数值；非正数或非法值统一返回 null
 * @param {unknown} v
 * @returns {number|null}
 */
function toPositiveIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 读取非负整数能力数值（如 minThinkingBudget/maxOutputTokens 为 0）
 * @param {unknown} v
 * @returns {number|null}
 */
function toNonNegativeIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * 解析 LanguageServerService.GetAvailableModels 响应为安全能力映射表
 * 仅提取数值/枚举/标签元数据，绝不保留敏感或无关负载
 * @param {object|null|undefined} raw
 * @returns {Record<string, object>}
 */
function parseAvailableModelsResponse(raw) {
  const out = Object.create(null);
  const modelsObj = raw?.response?.models || raw?.models || (raw && typeof raw === 'object' && !Array.isArray(raw) && !raw.userStatus ? raw : null);
  if (!modelsObj || typeof modelsObj !== 'object') return out;

  const entries = Array.isArray(modelsObj)
    ? modelsObj.map(item => [item?.model || item?.modelId || item?.id || '', item])
    : Object.entries(modelsObj);

  for (const [entryKey, d] of entries) {
    if (!d || typeof d !== 'object') continue;
    const rawId = String(d.model || d.modelId || entryKey || '').trim();
    if (!rawId) continue;
    const normKey = normalizeModelKeyForCap(rawId);
    const entry = {
      modelId: rawId,
      normalizedId: normKey,
      displayName: typeof d.displayName === 'string' && d.displayName.trim() ? d.displayName.trim() : null,
      maxTokens: toPositiveIntOrNull(d.maxTokens ?? d.max_tokens),
      maxOutputTokens: toNonNegativeIntOrNull(d.maxOutputTokens ?? d.max_output_tokens),
      thinkingBudget: toNonNegativeIntOrNull(d.thinkingBudget ?? d.thinking_budget),
      minThinkingBudget: toNonNegativeIntOrNull(d.minThinkingBudget ?? d.min_thinking_budget),
      thinkingLevel: typeof (d.thinkingLevel ?? d.thinking_level) === 'string' ? (d.thinkingLevel ?? d.thinking_level) : null,
      supportsModelInfoOverride: typeof (d.supportsModelInfoOverride ?? d.supports_model_info_override) === 'boolean'
        ? Boolean(d.supportsModelInfoOverride ?? d.supports_model_info_override)
        : null,
      modelProvider: typeof (d.modelProvider ?? d.model_provider) === 'string' ? (d.modelProvider ?? d.model_provider) : null,
      disabled: typeof d.disabled === 'boolean' ? d.disabled : null,
      recommended: typeof d.recommended === 'boolean' ? d.recommended : null,
      tagTitle: typeof (d.tagTitle ?? d.tag_title) === 'string' ? (d.tagTitle ?? d.tag_title).trim() : null,
      tagDescription: typeof (d.tagDescription ?? d.tag_description) === 'string' ? (d.tagDescription ?? d.tag_description).trim() : null,
      capabilitySource: 'get_available_models'
    };
    if (normKey) out[normKey] = entry;
    if (entryKey && normalizeModelKeyForCap(entryKey) && !out[normalizeModelKeyForCap(entryKey)]) {
      out[normalizeModelKeyForCap(entryKey)] = entry;
    }
  }
  return out;
}

/**
 * 从会话 steps[].metadata.modelInfo 中提取实测上报的模型能力元数据
 * 严格隐私边界：仅提取 ModelInfo 数值与枚举标识，绝不读取/存储任何用户消息文本或令牌
 * @param {Array<object>} steps
 * @returns {Record<string, object>}
 */
function extractObservedModelInfoFromSteps(steps) {
  const out = Object.create(null);
  if (!Array.isArray(steps)) return out;
  for (const s of steps) {
    const md = s?.metadata;
    const mi = md?.modelInfo || md?.model_info;
    if (!mi || typeof mi !== 'object') continue;
    const rawId = String(
      mi.modelId || mi.model_id || md.requestedModel?.model || md.generatorModel?.model || ''
    ).trim();
    const normKey = normalizeModelKeyForCap(rawId);
    const maxTokens = toPositiveIntOrNull(mi.maxTokens ?? mi.max_tokens);
    const maxOutputTokens = toNonNegativeIntOrNull(mi.maxOutputTokens ?? mi.max_output_tokens);
    if (!normKey || (!maxTokens && maxOutputTokens === null)) continue;
    out[normKey] = {
      modelId: rawId,
      normalizedId: normKey,
      displayName: typeof (mi.displayName ?? mi.display_name) === 'string' ? (mi.displayName ?? mi.display_name).trim() : null,
      maxTokens,
      maxOutputTokens,
      thinkingBudget: toNonNegativeIntOrNull(mi.thinkingBudget ?? mi.thinking_budget),
      minThinkingBudget: toNonNegativeIntOrNull(mi.minThinkingBudget ?? mi.min_thinking_budget),
      thinkingLevel: typeof (mi.thinkingLevel ?? mi.thinking_level) === 'string' ? (mi.thinkingLevel ?? mi.thinking_level) : null,
      capabilitySource: 'step_model_info'
    };
  }
  return out;
}

/**
 * 将 GetAvailableModels 与 Step.metadata.modelInfo 的能力字段安全合并到 cascadeModelConfigs
 * 不做按模型名称猜上限；缺失能力保持 null
 */
function mergeModelCapabilitiesIntoConfigs(configs, availableMap = null, stepCapsMap = null) {
  const list = Array.isArray(configs) ? configs.slice() : [];
  const availEntries = availableMap && typeof availableMap === 'object' ? Object.values(availableMap) : [];
  const stepEntries = stepCapsMap && typeof stepCapsMap === 'object' ? Object.values(stepCapsMap) : [];

  const lookupCap = (candidates, label) => {
    for (const c of candidates) {
      const k = normalizeModelKeyForCap(c);
      if (!k) continue;
      if (availableMap?.[k]) return availableMap[k];
      if (stepCapsMap?.[k]) return stepCapsMap[k];
    }
    const cleanLbl = typeof label === 'string' ? label.trim().toLowerCase() : '';
    if (cleanLbl) {
      const aMatches = availEntries.filter(e => e?.displayName && e.displayName.toLowerCase() === cleanLbl);
      if (aMatches.length === 1) return aMatches[0];
      const sMatches = stepEntries.filter(e => e?.displayName && e.displayName.toLowerCase() === cleanLbl);
      if (sMatches.length === 1) return sMatches[0];
    }
    return null;
  };

  const merged = list.map(cfg => {
    if (!cfg || typeof cfg !== 'object') return cfg;
    const cap = lookupCap([cfg.modelId, cfg.model, cfg.modelOrAlias?.model, cfg.modelOrAlias?.alias], cfg.label || cfg.modelDisplayName);
    if (!cap) return cfg;
    const next = { ...cfg };
    if (next.maxTokens == null && cap.maxTokens != null) next.maxTokens = cap.maxTokens;
    if (next.maxOutputTokens == null && cap.maxOutputTokens != null) next.maxOutputTokens = cap.maxOutputTokens;
    if (next.thinkingBudget == null && cap.thinkingBudget != null) next.thinkingBudget = cap.thinkingBudget;
    if (next.minThinkingBudget == null && cap.minThinkingBudget != null) next.minThinkingBudget = cap.minThinkingBudget;
    if (!next.thinkingLevel && cap.thinkingLevel) next.thinkingLevel = cap.thinkingLevel;
    if (next.supportsModelInfoOverride == null && cap.supportsModelInfoOverride != null) {
      next.supportsModelInfoOverride = cap.supportsModelInfoOverride;
    }
    if (!next.modelProvider && cap.modelProvider) next.modelProvider = cap.modelProvider;
    if (!next.capabilitySource && cap.capabilitySource) next.capabilitySource = cap.capabilitySource;
    if (next.disabled === undefined && cap.disabled !== null) next.disabled = cap.disabled;
    if (!next.tagTitle && cap.tagTitle) next.tagTitle = cap.tagTitle;
    if (!next.tagDescription && cap.tagDescription) next.tagDescription = cap.tagDescription;
    return next;
  });

  return merged;
}

function sanitizeCascadeModelConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const tagTitle = typeof c.tagTitle === 'string' ? c.tagTitle.trim() : '';
  const tagDesc = typeof c.tagDescription === 'string' ? c.tagDescription.trim() : '';
  const isTagUnavailable = /unavailable|disabled|不可用|无权限|無權限/i.test(tagTitle);
  const isDecoTag = isDecorativeBadgeTagTitle(tagTitle);
  const isUnavail = Boolean(
    c.unavailable === true ||
    c.isUnavailable === true ||
    c.status === 'unavailable' ||
    c.disabled === true ||
    c.enabled === false ||
    isTagUnavailable
  );
  const isHist = Boolean(
    c.isHistorical === true ||
    c.historical === true ||
    c.deprecated === true ||
    c.isDeprecated === true ||
    (typeof c.label === 'string' && /\(legacy\)|\(deprecated\)|\(old\)/i.test(c.label))
  );
  const rawReason = String(c.unavailabilityReason || c.disabledReason || c.reason || '').trim();
  const safeReason = (rawReason && !isDecorativeBadgeTagTitle(rawReason)) ? rawReason : null;
  const fallbackTagReason = isUnavail ? (tagDesc || (!isDecoTag && tagTitle ? tagTitle : null)) : null;
  return {
    modelId: c.modelId || c.model || '',
    label: c.label || c.modelDisplayName || c.modelId || '',
    modelOrAlias: c.modelOrAlias || null,
    value: c.value !== undefined ? c.value : undefined,
    modelAlias: c.modelAlias !== undefined ? c.modelAlias : undefined,
    quotaInfo: c.quotaInfo ? {
      remainingFraction: typeof c.quotaInfo.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null,
      resetTime: c.quotaInfo.resetTime || null
    } : null,
    tagTitle: tagTitle || null,
    tagDescription: tagDesc || null,
    contextWindowOptions: Array.isArray(c.contextWindowOptions) ? c.contextWindowOptions : undefined,
    maxTokens: toPositiveIntOrNull(c.maxTokens ?? c.max_tokens),
    maxOutputTokens: toNonNegativeIntOrNull(c.maxOutputTokens ?? c.max_output_tokens),
    thinkingBudget: toNonNegativeIntOrNull(c.thinkingBudget ?? c.thinking_budget),
    minThinkingBudget: toNonNegativeIntOrNull(c.minThinkingBudget ?? c.min_thinking_budget),
    thinkingLevel: typeof (c.thinkingLevel ?? c.thinking_level) === 'string' ? (c.thinkingLevel ?? c.thinking_level) : null,
    supportsModelInfoOverride: typeof (c.supportsModelInfoOverride ?? c.supports_model_info_override) === 'boolean'
      ? Boolean(c.supportsModelInfoOverride ?? c.supports_model_info_override)
      : null,
    modelProvider: typeof (c.modelProvider ?? c.model_provider) === 'string' ? (c.modelProvider ?? c.model_provider) : null,
    capabilitySource: typeof c.capabilitySource === 'string' ? c.capabilitySource : null,
    disabled: c.disabled === true,
    allowedTiers: Array.isArray(c.allowedTiers) ? c.allowedTiers.slice() : undefined,
    unavailable: isUnavail,
    unavailabilityReason: safeReason || fallbackTagReason || null,
    notice: c.notice || c.clientNotice || c.warning || (!isUnavail && tagTitle && (!isDecoTag || tagDesc) ? `${tagTitle}${tagDesc ? `：${tagDesc}` : ''}` : null),
    isHistorical: isHist,
    releaseDate: c.releaseDate || null,
    family: c.family || null,
    effort: c.effort || null
  };
}

const FILES_CACHE_MAX_ENTRIES = 512;
const CONVERSATIONS_CACHE_MAX_ENTRIES = 32;
const filesCache = new Map();
const conversations = new Map();
const csrfTokenByOrigin = new Map();
let pythonQueue = Promise.resolve();

function setBoundedMap(map, key, val, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function request(origin, method, body, token, signal = null) {
  const url = method ? `${origin}/exa.language_server_pb.LanguageServerService/${method}` : origin + '/';
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('请求已取消');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.request(url, {
      agent: false,
      rejectUnauthorized: false,
      method: method ? 'POST' : 'GET',
      headers: method ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {},
      ...(signal ? { signal } : {})
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 96 * 1024 * 1024) {
          req.destroy(new Error('本地响应过大，扫描不完整'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (signal?.aborted) {
          const err = new Error('请求已取消');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        const text = Buffer.concat(chunks).toString();
        if (response.statusCode !== 200) reject(new Error(`本机接口 HTTP ${response.statusCode}`));
        else { try { resolve(method ? JSON.parse(text) : text); } catch (e) { reject(e); } }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('本机接口读取超时')));
    req.on('error', reject);
    req.end(method ? JSON.stringify(body) : undefined);
  });
}

function pythonScan(items, signal = null) {
  const task = pythonQueue.then(() => {
    if (signal?.aborted) return items.map(item => ({ key: item.key, ...empty(), status: 'unknown', unknownParts: ['扫描已切换会话取消'] }));
    return runPythonScan(items, signal);
  });
  pythonQueue = task.catch(() => { });
  return task;
}

function runPythonScan(items, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve(items.map(item => ({ key: item.key, ...empty(), status: 'unknown', unknownParts: ['扫描已切换会话取消'] })));
    const py = resolvePython();
    if (!py) return reject(new Error('本地 Python 解析环境不可用'));
    const source = fs.readFileSync(path.join(__dirname, 'attachment_scan.py'), 'utf8');
    const child = spawn(py, ['-I', '-c', source, '--json-lines'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', timedOut = false, aborted = false;
    const completed = [];
    const onAbort = () => { aborted = true; try { child.kill(); } catch { } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    child.stdout.on('data', chunk => { output += chunk; let at; while ((at = output.indexOf('\n')) >= 0) { const line = output.slice(0, at).trim(); output = output.slice(at + 1); if (line) { try { completed.push(JSON.parse(line)); } catch { } } } }); child.stderr.on('data', chunk => { if (errors.length < 1000) errors += chunk; });
    child.on('error', e => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', code => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); const reason = aborted ? '扫描已切换会话取消' : timedOut ? '扫描超时，未完成部分不计为零' : code !== 0 ? '解析进程失败：' + errors.slice(0, 160) : '附件没有返回解析结果'; const done = new Set(completed.map(v => v.key)); for (const item of items) if (!done.has(item.key)) completed.push({ key: item.key, ...empty(), status: 'unknown', unknownParts: [reason] }); resolve(completed); });
    child.stdin.on('error', () => { }); child.stdin.end(JSON.stringify(items));
  });
}

function getImageDimensions(buf) {
  try {
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4D) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] === 0xFF && [0xC0, 0xC1, 0xC2, 0xC3].includes(buf[offset + 1])) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        } else if (buf[offset] === 0xFF) {
          const len = buf.readUInt16BE(offset + 2);
          offset += 2 + len;
        } else {
          offset++;
        }
      }
    }
  } catch { }
  return { width: null, height: null };
}

function calcImageTokens(w, h) {
  if (!w || !h) return [258, 1120];
  if (w <= 384 && h <= 384) return [258, 258];
  const tiles = Math.ceil(w / 768) * Math.ceil(h / 768);
  const tok = tiles * 258;
  return [tok, Math.max(tok, (w > 384 || h > 384) ? 1120 : 258)];
}

async function scanFiles(media, scanOptions = {}) {
  const signal = scanOptions?.signal || null;
  const results = new Map(), work = [];
  for (const item of media) {
    if (signal?.aborted) break;
    try {
      if (item.inlineData) {
        const mime = String(item.mime || '').toLowerCase();
        const buf = Buffer.from(item.inlineData, 'base64');
        if (mime.startsWith('image/')) {
          const dims = getImageDimensions(buf);
          const [low, high] = calcImageTokens(dims.width, dims.height);
          results.set(item.uri, {
            status: 'parsed',
            width: dims.width,
            height: dims.height,
            chars: 0,
            dimensions: dims.width ? `${dims.width}×${dims.height}` : null,
            bytes: buf.length,
            low,
            high,
            unknownParts: []
          });
          continue;
        } else if (mime.startsWith('text/') || mime === 'application/json' || mime === 'text/csv') {
          const text = buf.toString('utf8');
          const m = measure(text);
          results.set(item.uri, {
            status: 'parsed',
            chars: text.length,
            bytes: buf.length,
            low: m.low,
            high: m.high,
            unknownParts: []
          });
          continue;
        } else {
          const est = Math.ceil(buf.length / 4);
          results.set(item.uri, {
            status: 'parsed',
            chars: buf.length,
            bytes: buf.length,
            low: Math.ceil(est * 0.7),
            high: Math.ceil(est * 1.4),
            unknownParts: []
          });
          continue;
        }
      }
      if (!item.uri || /^https?:/i.test(item.uri)) throw new Error('无可用本地附件，内容未知');
      const targetPath = item.uri.startsWith('file:') ? fileURLToPath(item.uri) : item.uri;
      let target;
      let stat;
      try {
        target = await fs.promises.realpath(targetPath);
        stat = await fs.promises.stat(target);
      } catch (fsErr) {
        if (fsErr && (fsErr.code === 'ENOENT' || fsErr.code === 'ENOTDIR')) {
          throw new Error('附件文件不存在或已移动');
        }
        throw fsErr;
      }
      if (!stat.isFile()) throw new Error('附件不是普通文件');
      const key = `${target.toLowerCase()}|${stat.size}|${stat.mtimeMs}`;
      if (filesCache.has(key)) {
        const hit = filesCache.get(key);
        setBoundedMap(filesCache, key, hit, FILES_CACHE_MAX_ENTRIES);
        results.set(item.uri, hit);
      } else {
        work.push({ key: item.uri, path: target, cacheKey: key });
      }
    } catch (e) { results.set(item.uri, { ...empty(), status: 'unknown', unknownParts: [item.reason || e.message] }); }
  }
  if (work.length && !signal?.aborted) {
    try {
      const parsed = await pythonScan(work.map(({ key, path }) => ({ key, path })), signal);
      for (const result of parsed) {
        const job = work.find(w => w.key === result.key);
        if (job) {
          if (result && result.status !== 'unknown') {
            setBoundedMap(filesCache, job.cacheKey, result, FILES_CACHE_MAX_ENTRIES);
          }
          results.set(job.key, result);
        }
      }
    } catch (e) { for (const job of work) results.set(job.key, { ...empty(), status: 'unknown', unknownParts: [e.message] }); }
  }
  return media.map(item => ({ ...item, ...(results.get(item.uri) || { ...empty(), status: 'unknown', unknownParts: ['未返回附件统计'] }), uri: undefined, key: undefined }));
}

let collectSeqCounter = 0;
const latestCollectSeqByOrigin = new Map();

async function collect(origin, id, options = {}) {
  const safeOrigin = normalizeLoopbackOrigin(origin);
  if (!safeOrigin || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('无效本机会话');
  origin = safeOrigin;
  const key = `${origin}/${id}`;
  const supersede = options.supersedePrevious === true;
  const mySeq = supersede ? (++collectSeqCounter) : 0;
  const abortController = supersede ? new AbortController() : null;
  if (supersede) {
    const prevLatest = latestCollectSeqByOrigin.get(origin);
    if (prevLatest && prevLatest.id !== id && prevLatest.abortController) {
      try { prevLatest.abortController.abort(); } catch { }
    }
    latestCollectSeqByOrigin.set(origin, { seq: mySeq, id, abortController });
  }
  const isSuperseded = () => {
    if (!supersede) return false;
    const latest = latestCollectSeqByOrigin.get(origin);
    return Boolean((latest && latest.seq > mySeq && latest.id !== id) || abortController?.signal?.aborted);
  };
  const previous = conversations.get(key);
  if (previous?.pending) return previous.pending;
  if (options.force) filesCache.clear();
  if (!options.force && previous?.result && Date.now() - previous.at < 12000) return previous.result;
  const task = (async () => {
    const signal = abortController?.signal || null;
    try {
      let token = !options.force ? csrfTokenByOrigin.get(origin) : null;
      if (!token) {
        const html = await request(origin, null, null, null, signal);
        if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
        token = JSON.parse(html.match(/window.__APP_CONFIG__ = (.*?);/)[1]).csrfToken;
        csrfTokenByOrigin.set(origin, token);
      }
      const call = async (method, body) => {
        try {
          return await request(origin, method, body, token, signal);
        } catch (err) {
          if (err && /HTTP 40[13]/.test(String(err.message || '')) && !signal?.aborted) {
            csrfTokenByOrigin.delete(origin);
            const html = await request(origin, null, null, null, signal);
            token = JSON.parse(html.match(/window.__APP_CONFIG__ = (.*?);/)[1]).csrfToken;
            csrfTokenByOrigin.set(origin, token);
            return await request(origin, method, body, token, signal);
          }
          throw err;
        }
      };
      const full = await call('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 3 });
      if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      const trajectory = full.trajectory;
      if (!trajectory) throw new Error('未取得会话历史，无法完整统计');
      const wsPath = extractWorkspaceFromTrajectory(trajectory);
      if (wsPath) conversationWorkspaces.set(id.toLowerCase(), wsPath);
      const steps = trajectory.steps || [];
      const expected = Number(full.numTotalSteps ?? steps.length);
      while (steps.length < expected) {
        if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
        const page = await call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: steps.length, trajectoryVerbosity: 3 });
        if (!page.steps?.length) throw new Error(`历史仅取得 ${steps.length}/${expected} 步，扫描未完成`);
        steps.push(...page.steps);
      }
      if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      const session = analyzeSteps(steps);
      const stepCapabilities = extractObservedModelInfoFromSteps(steps);
      const attachments = await scanFiles(session.media, { signal });
      if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      const attachmentTotal = empty();
      for (const a of attachments) { const n = a.references || 1; add(attachmentTotal, Object.fromEntries(['chars', 'bytes', 'low', 'high'].map(k => [k, (a[k] || 0) * n]))); }
      const total = add({ ...session.total }, attachmentTotal);
      let latest = null;
      const count = Number(full.numTotalGeneratorMetadata ?? trajectory.generatorMetadata?.length ?? 0);
      const tail = await call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: Math.max(0, count - 3), includeMessages: false });
      let cachedHostUserStatus = cachedUserStatusByOrigin.get(normalizeQuotaOriginScope({ origin }))?.status || null;
      let knownCascadeConfigs = Array.isArray(cachedHostUserStatus?.cascadeModelConfigs) ? cachedHostUserStatus.cascadeModelConfigs : [];
      const hasAnyCap = knownCascadeConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      if (!knownCascadeConfigs.length || !hasAnyCap) {
        try {
          const freshStatus = await fetchUserStatusFromHost({ origin });
          if (freshStatus) cachedHostUserStatus = freshStatus;
          if (Array.isArray(freshStatus?.cascadeModelConfigs) && freshStatus.cascadeModelConfigs.length) {
            knownCascadeConfigs = freshStatus.cascadeModelConfigs;
          }
        } catch { }
      }
      const mergedCascadeConfigs = mergeModelCapabilitiesIntoConfigs(
        knownCascadeConfigs,
        cachedHostUserStatus?.availableModelDetails || null,
        stepCapabilities
      );
      let latestModel = null;
      let latestCallId = null;
      let latestCallRecord = null;
      const recentGeneratorCalls = [];
      for (const m of (tail.generatorMetadata || [])) {
        const callMeta = parseGeneratorCall(m, id, 'desktop', { cascadeModelConfigs: mergedCascadeConfigs });
        if (callMeta) {
          const normCall = normalizeSessionCallRecord(callMeta, { cascadeId: id, cascadeModelConfigs: mergedCascadeConfigs });
          if (normCall) recentGeneratorCalls.push(normCall);
        }
      }
      for (const m of (tail.generatorMetadata || []).slice().reverse()) {
        latest = summarize(m, { cascadeModelConfigs: mergedCascadeConfigs });
        if (latest) {
          latestModel = m.chatModel;
          const callMeta = parseGeneratorCall(m, id, 'desktop', { cascadeModelConfigs: mergedCascadeConfigs });
          latestCallId = callMeta?.callId || null;
          if (callMeta) {
            latestCallRecord = normalizeSessionCallRecord(callMeta, { cascadeId: id, cascadeModelConfigs: mergedCascadeConfigs });
          }
          break;
        }
      }
      const system = latestModel ? measure((latestModel.promptSections || []).map(p => p.content || '').join('\n') || latestModel.systemPrompt || '') : empty();
      const definitions = latestModel ? measure(JSON.stringify(latestModel.tools || [])) : empty();
      session.groups.system = system; session.groups.definitions = definitions;
      add(total, system); add(total, definitions);
      if (session.currentError) {
        const fromStep = summarize({ chatModel: { retryInfos: [{ error: session.currentError.text }] } }, {
          currentModel: latest?.model || latestModel?.modelDisplayName || latestModel?.model || '',
          cascadeModelConfigs: mergedCascadeConfigs,
          previousValidContext: latest
        });
        if (fromStep?.error) {
          latest = {
            ...(latest || {}),
            error: fromStep.error,
            errorClassification: fromStep.errorClassification,
            exceeded: fromStep.exceeded,
            network: fromStep.network,
            serviceLimit: fromStep.serviceLimit || latest?.serviceLimit || null,
            status: fromStep.status,
            actual: fromStep.exceeded ? null : (latest?.actual ?? null),
            percent: fromStep.exceeded ? null : (latest?.percent ?? null),
            estimated: latest?.actual == null
          };
        }
      }
    const unknownFiles = attachments.filter(a => a.status !== 'parsed').length;
    const compactCascadeConfigs = mergedCascadeConfigs.map(sanitizeCascadeModelConfig).filter(Boolean);
    const modelCapabilitiesById = {
      ...(cachedHostUserStatus?.availableModelDetails || {}),
      ...stepCapabilities
    };
    const result = { version: PROJECT_VERSION, conversation: id, workspacePath: wsPath || null, latest, latestCallId, latestCallRecord, recentGeneratorCalls, generatorCount: count, cascadeModelConfigs: compactCascadeConfigs, modelCapabilitiesById, session: { ...session, media: undefined, attachmentTotal, total, attachments, unknownFiles, complete: unknownFiles === 0, scope: '全量可读取历史 + 上传附件 + 当前系统提示与工具定义；不将每轮重复输入累加；非服务端分词结果' }, scannedAt: Date.now(), errors: [] };
    if (isSuperseded()) {
      conversations.delete(key);
      return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
    }
    setBoundedMap(conversations, key, { result, at: Date.now() }, CONVERSATIONS_CACHE_MAX_ENTRIES);
    return result;
    } catch (err) {
      if (isSuperseded() || (err && err.name === 'AbortError' && signal?.aborted)) {
        return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      }
      throw err;
    }
  })();
  setBoundedMap(conversations, key, { ...previous, pending: task }, CONVERSATIONS_CACHE_MAX_ENTRIES);
  try { return await task; } catch (e) { conversations.delete(key); throw e; }
}

let cachedTokenHistory = null;
let cachedTokenHistoryAt = 0;

function formatLocalDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 检查是否为 SQLite 伴生文件或临时文件
function isCompanionOrTempFile(fileName) {
  const lower = fileName.toLowerCase();
  return lower.endsWith('-wal') ||
    lower.endsWith('-shm') ||
    lower.endsWith('-journal') ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.lock') ||
    lower.endsWith('.bak');
}

// 尝试安全读取 LanguageServer 的 GetUserStatus

// ============================================================================
// 逐请求已计价账本持久化、合成数据隔离与幂等入账
// ============================================================================
const ledgerCacheByPath = new Map();

function normalizeLedgerKey(filePath) {
  return path.resolve(filePath);
}

function isSyntheticCall(callId, call = {}) {
  if (!callId) return false;
  const sId = String(callId).toLowerCase();
  const cId = String(call?.cascadeId || '').toLowerCase();
  return sId.startsWith('test_') ||
    sId.startsWith('fixture_') ||
    sId.startsWith('synthetic_') ||
    sId.includes('desktop_response_001') ||
    cId.includes('verify') ||
    cId.includes('test') ||
    cId.includes('mock');
}

function getPricingLedgerPath(overridePathOrDir) {
  if (overridePathOrDir) {
    if (overridePathOrDir.endsWith('.json')) return overridePathOrDir;
    return path.join(overridePathOrDir, 'pricing_ledger_v1.json');
  }
  if (process.env.AG_DIR) {
    return path.join(process.env.AG_DIR, 'pricing_ledger_v1.json');
  }
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini', 'antigravity', 'pricing_ledger_v1.json');
}

function createUnreadableLedger(filePath, error, isCorrupted = false, phase = 'unreadable_guard', code = undefined) {
  return {
    version: '1.0.0',
    updatedAt: '',
    calls: {},
    ...(isCorrupted ? { __corrupted: true } : {}),
    __unreadable: true,
    __guardPhase: phase,
    ...(code ? { __code: code } : {}),
    __corruptedPath: filePath,
    __error: error || '账本文件当前不可读'
  };
}

function quarantineSyntheticCalls(overridePathOrDir, options = {}) {
  const fsImpl = (options && options.fs) || fs;
  const p = path.resolve(getPricingLedgerPath(overridePathOrDir));
  const cacheKey = normalizeLedgerKey(p);
  const qPath = p.replace('pricing_ledger_v1.json', 'pricing_ledger_quarantine.json');

  try {
    const readRes = safeReadJsonSync(p, null, { fs: fsImpl });
    if (!readRes.exists || !readRes.ok || !readRes.data || typeof readRes.data !== 'object') {
      return { quarantinedCount: 0 };
    }
    const raw = readRes.data;
    const calls = raw.calls || {};
    const quarantined = {};
    const kept = {};

    for (const [id, call] of Object.entries(calls)) {
      if (isSyntheticCall(id, call)) {
        quarantined[id] = call;
      } else {
        kept[id] = call;
      }
    }

    const qCount = Object.keys(quarantined).length;
    if (qCount > 0) {
      let qData = { version: '1.0.0', quarantinedAt: new Date().toISOString(), calls: {} };
      const qRead = safeReadJsonSync(qPath, null, { fs: fsImpl });
      if (qRead.exists && qRead.ok && qRead.data && typeof qRead.data === 'object') {
        qData = qRead.data;
      }
      qData.calls = { ...qData.calls, ...quarantined };
      safeWriteJsonSync(qPath, qData, { fs: fsImpl });

      raw.calls = kept;
      raw.updatedAt = new Date().toISOString();
      const saveRes = safeWriteJsonSync(p, raw, { fs: fsImpl });
      if (saveRes.ok) {
        ledgerCacheByPath.delete(cacheKey);
      }
    }
    return { quarantinedCount: qCount };
  } catch {
    return { quarantinedCount: 0 };
  }
}

function loadPricingLedger(overridePathOrDir, options = {}) {
  const fsImpl = (options && options.fs) || fs;
  const p = path.resolve(getPricingLedgerPath(overridePathOrDir));
  const cacheKey = normalizeLedgerKey(p);
  const def = { version: '1.0.0', updatedAt: '', calls: {} };

  let st = null;
  try {
    st = fsImpl.statSync(p);
  } catch (statErr) {
    ledgerCacheByPath.delete(cacheKey);
    if (statErr && statErr.code === 'ENOENT') {
      return def;
    }
    return createUnreadableLedger(p, statErr?.message || '检查账本文件状态失败', false, 'unreadable_guard', statErr?.code);
  }

  if (!st || typeof st.isFile !== 'function' || !st.isFile()) {
    ledgerCacheByPath.delete(cacheKey);
    const nonFileCode = (st && typeof st.isDirectory === 'function' && st.isDirectory()) ? 'EISDIR' : 'EINVAL';
    return createUnreadableLedger(p, '账本目标路径不是普通文件', false, 'unreadable_guard', nonFileCode);
  }

  if (!options?.fs) {
    const cached = ledgerCacheByPath.get(cacheKey);
    if (cached && !cached.ledger?.__corrupted && !cached.ledger?.__unreadable && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.ledger;
    }
  }

  const bakPath = p.replace(/\.json$/i, '') + '.bak.json';
  const readRes = safeReadJsonSync(p, null, {
    fs: fsImpl,
    backupPath: bakPath,
    validate: (data) => data && typeof data === 'object' && typeof data.calls === 'object'
  });

  if (!readRes.exists) {
    ledgerCacheByPath.delete(cacheKey);
    // statSync 已确认文件存在，后续读取却返回 exists: false 时必须阻断写入，防止瞬态异常清空账本
    return createUnreadableLedger(p, readRes.error || '账本文件状态不一致（stat 存在但读取返回不存在）', false, 'unreadable_guard', readRes.code || 'ENOENT');
  }

  if (readRes.corrupted && !readRes.recoveredFromBackup) {
    ledgerCacheByPath.delete(cacheKey);
    // 文件存在但损坏且无备份可恢复，绝不能当作正常空数据覆盖
    return createUnreadableLedger(p, readRes.error, true, 'corrupted_guard', readRes.code);
  }

  if (!readRes.ok || !readRes.data || typeof readRes.data !== 'object') {
    ledgerCacheByPath.delete(cacheKey);
    return createUnreadableLedger(p, readRes.error || '读取账本文件失败', false, 'unreadable_guard', readRes.code);
  }

  const raw = readRes.data;
  const ledger = { version: raw.version || '1.0.0', updatedAt: raw.updatedAt || '', calls: { ...(raw.calls || {}) } };
  let hasSynthetic = false;
  for (const [id, call] of Object.entries(ledger.calls)) {
    if (isSyntheticCall(id, call)) {
      hasSynthetic = true;
      break;
    }
  }
  if (hasSynthetic) {
    quarantineSyntheticCalls(overridePathOrDir, options);
    const cleanedRes = safeReadJsonSync(p, null, { fs: fsImpl });
    if (cleanedRes.exists && cleanedRes.ok && cleanedRes.data && typeof cleanedRes.data === 'object') {
      ledger.calls = { ...(cleanedRes.data.calls || {}) };
      ledger.updatedAt = cleanedRes.data.updatedAt || '';
    }
  }

  // 读取阶段在内存态自动消解可确认为同一调用的历史双键 (responseId + cascadeId#stepIndex)，不在纯读路径写盘
  if (reconcileConfirmableDuplicateStepCalls(ledger.calls)) {
    Object.defineProperty(ledger, '__hadDuplicateStepKeys', { value: true, configurable: true });
  }

  // 正常落盘数据建立自动滚动备份，供损坏时恢复
  if (!readRes.corrupted) {
    try {
      if (!fsImpl.existsSync(bakPath) || Math.random() < 0.1) {
        fsImpl.copyFileSync(p, bakPath);
      }
    } catch { }
  }

  if (readRes.ok && !hasSynthetic && !options?.fs) {
    try {
      const stAfter = fsImpl.statSync(p);
      if (stAfter.isFile() && stAfter.mtimeMs === st.mtimeMs && stAfter.size === st.size) {
        ledgerCacheByPath.set(cacheKey, { ledger, mtimeMs: stAfter.mtimeMs, size: stAfter.size });
      } else {
        ledgerCacheByPath.delete(cacheKey);
      }
    } catch {
      ledgerCacheByPath.delete(cacheKey);
    }
  }
  return ledger;
}

function savePricingLedger(ledger, overridePathOrDir, options = {}) {
  const fsImpl = (options && options.fs) || fs;
  if (ledger && (ledger.__corrupted || ledger.__unreadable)) {
    const errMsg = ledger.__corrupted
      ? '原账本数据已损坏且未从备份恢复，已阻止以空数据覆盖原有历史'
      : `原账本当前不可读 (${ledger.__error || 'I/O 异常'})，已阻止写入覆盖原有历史`;
    return {
      ok: false,
      phase: ledger.__guardPhase || (ledger.__corrupted ? 'corrupted_guard' : 'unreadable_guard'),
      ...(ledger.__code ? { code: ledger.__code } : {}),
      error: errMsg
    };
  }
  const p = path.resolve(getPricingLedgerPath(overridePathOrDir));
  const cacheKey = normalizeLedgerKey(p);
  const res = safeWriteJsonSync(p, ledger, {
    fs: fsImpl,
    validate: (data) => data && typeof data === 'object' && typeof data.calls === 'object'
  });
  if (res.ok && !options?.fs) {
    try {
      const st = fsImpl.statSync(p);
      if (st.isFile()) {
        const cachedCopy = {
          version: ledger.version || '1.0.0',
          updatedAt: ledger.updatedAt || '',
          calls: { ...(ledger.calls || {}) }
        };
        if (reconcileConfirmableDuplicateStepCalls(cachedCopy.calls)) {
          Object.defineProperty(cachedCopy, '__hadDuplicateStepKeys', { value: true, configurable: true });
        }
        ledgerCacheByPath.set(cacheKey, { ledger: cachedCopy, mtimeMs: st.mtimeMs, size: st.size });
      }
    } catch { }
  }
  return res;
}

function createRecordResult(ok, changed, error, phase, code) {
  return {
    ok: !!ok,
    changed: !!changed,
    error: error || undefined,
    phase: phase || undefined,
    ...(code ? { code } : {}),
    valueOf() { return this.changed; }
  };
}

function hasSpeedMetrics(rec) {
  if (!rec || typeof rec !== 'object') return false;
  return rec.durationSec != null || rec.tps != null || rec.ttftSec != null || rec.streamingSec != null;
}

function getCallSortTimestamp(rec) {
  if (!rec) return 0;
  if (Number.isFinite(Number(rec.timestamp)) && Number(rec.timestamp) > 0) return Number(rec.timestamp);
  if (rec.created_at) {
    const t = Date.parse(rec.created_at);
    if (Number.isFinite(t) && t > 0) return t;
  }
  if (rec.date) {
    const t = Date.parse(rec.date);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return Number(rec.updatedAt) || 0;
}

/**
 * 每个准确模型 ID 最多保留最近 200 条速度样本；超出的只清除速度字段，计费与 token 数据保留不动
 */
function pruneExcessSpeedSamples(draftCalls, limit = MAX_SPEED_SAMPLES_PER_MODEL || 200) {
  if (!draftCalls || typeof draftCalls !== 'object') return false;
  const byModel = new Map();
  for (const [callId, rec] of Object.entries(draftCalls)) {
    if (!rec || !hasSpeedMetrics(rec)) continue;
    const exactId = String(rec.modelExactId || resolveStableModelId(rec) || rec.model || '').trim().toLowerCase();
    if (!exactId) continue;
    if (!byModel.has(exactId)) byModel.set(exactId, []);
    byModel.get(exactId).push({ callId, ts: getCallSortTimestamp(rec) });
  }
  let pruned = false;
  for (const entries of byModel.values()) {
    if (entries.length <= limit) continue;
    entries.sort((a, b) => b.ts - a.ts);
    for (let i = limit; i < entries.length; i++) {
      const rec = draftCalls[entries[i].callId];
      if (!rec) continue;
      const copy = { ...rec };
      delete copy.ttftSec;
      delete copy.streamingSec;
      delete copy.durationSec;
      delete copy.tps;
      delete copy.origin;
      draftCalls[entries[i].callId] = copy;
      pruned = true;
    }
  }
  return pruned;
}

function parseStepFallbackKey(callId, cascadeId) {
  if (typeof callId !== 'string' || !callId.includes('#')) return null;
  const hashIdx = callId.lastIndexOf('#');
  if (hashIdx <= 0) return null;
  const idPart = callId.slice(0, hashIdx);
  const stepPart = callId.slice(hashIdx + 1);
  if (!/^\d+$/.test(stepPart)) return null;
  if (cascadeId && idPart.toLowerCase() !== String(cascadeId).toLowerCase()) return null;
  return { cascadeId: cascadeId ? String(cascadeId) : idPart, stepIndex: Number(stepPart) };
}

function isStepFallbackCallId(callId, cascadeId) {
  return parseStepFallbackKey(callId, cascadeId) !== null;
}

function extractCallStepNumbers(c, fallbackKey = null) {
  const steps = [];
  if (!c) return steps;
  if (c.stepIndex !== null && c.stepIndex !== undefined && c.stepIndex !== '' && Number.isInteger(Number(c.stepIndex)) && Number(c.stepIndex) >= 0) {
    steps.push(Number(c.stepIndex));
  }
  if (Array.isArray(c.stepIndices)) {
    for (const s of c.stepIndices) {
      if (s !== null && s !== undefined && s !== '' && Number.isInteger(Number(s)) && Number(s) >= 0 && !steps.includes(Number(s))) {
        steps.push(Number(s));
      }
    }
  }
  if (!steps.length) {
    const parsed = parseStepFallbackKey(c.callId || fallbackKey, c.cascadeId);
    if (parsed) steps.push(parsed.stepIndex);
  }
  return steps;
}

function getCallTokenBreakdown(c) {
  if (!c || typeof c !== 'object') return { inp: 0, cap: 0, out: 0, think: 0, tot: 0 };
  const inp = Number(c.inputTokens ?? c.input_tokens ?? c.input ?? 0) || 0;
  const cap = Number(c.cacheTokens ?? c.cacheReadTokens ?? c.cache_read_tokens ?? c.cached ?? 0) || 0;
  const out = Number(c.outputTokens ?? c.output_tokens ?? c.output ?? 0) || 0;
  const think = Number(c.thinkingTokens ?? c.thinking_output_tokens ?? c.thinking ?? 0) || 0;
  const computedTot = inp + cap + out;
  const rawTot = Number(c.totalTokens ?? 0) || 0;
  return { inp, cap, out, think, tot: computedTot > 0 ? computedTot : rawTot };
}

function isPlaceholderModel(raw) {
  if (!raw || typeof raw !== 'string') return false;
  return /^model_placeholder_/i.test(raw.trim());
}

function getCollectorModelRank(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 0;
  if (isPlaceholderModel(s)) return 1;
  if (!normalizeModelId(s)) return 2;
  return 3;
}

function areModelsCompatible(mA, mB) {
  const a = typeof mA === 'string' ? mA.trim() : '';
  const b = typeof mB === 'string' ? mB.trim() : '';
  if (!a || !b || isPlaceholderModel(a) || isPlaceholderModel(b)) return true;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const normA = normalizeModelId(a);
  const normB = normalizeModelId(b);
  if (normA && normB) return normA === normB;
  return false;
}

function pickRicherModel(primaryModel, secondaryModel) {
  const a = typeof primaryModel === 'string' ? primaryModel.trim() : '';
  const b = typeof secondaryModel === 'string' ? secondaryModel.trim() : '';
  if (!a) return b;
  if (!b) return a;
  const rankA = getCollectorModelRank(a);
  const rankB = getCollectorModelRank(b);
  if (rankB > rankA) return b;
  if (rankA > rankB) return a;
  return a;
}

function extractNormalizedDateInfo(e) {
  if (!e || typeof e !== 'object') {
    return { rank: 0, date: null, created_at: null, dateSource: null, dateIsProvisional: true };
  }
  const rawDate = (e.date && /^\d{4}-\d{2}-\d{2}/.test(String(e.date))) ? String(e.date).slice(0, 10) : null;
  const isProv = e.dateIsProvisional === true || e.dateSource === 'provisional';
  if (isProv) {
    return {
      rank: rawDate ? 1 : 0,
      date: rawDate,
      created_at: null,
      dateSource: rawDate ? 'provisional' : null,
      dateIsProvisional: true
    };
  }
  let parsedLocalFromCreated = null;
  if (e.created_at) {
    const dt = new Date(e.created_at);
    if (!Number.isNaN(dt.getTime())) {
      parsedLocalFromCreated = formatLocalDateKey(dt);
    }
  }
  if (e.dateSource === 'transcript' && (rawDate || parsedLocalFromCreated)) {
    return {
      rank: 4,
      date: parsedLocalFromCreated || rawDate,
      created_at: e.created_at ? String(e.created_at) : null,
      dateSource: 'transcript',
      dateIsProvisional: false
    };
  }
  if (parsedLocalFromCreated) {
    return {
      rank: 3,
      date: parsedLocalFromCreated,
      created_at: String(e.created_at),
      dateSource: e.dateSource || 'created_at',
      dateIsProvisional: false
    };
  }
  if (rawDate) {
    return {
      rank: 2,
      date: rawDate,
      created_at: null,
      dateSource: e.dateSource || 'explicit_date',
      dateIsProvisional: false
    };
  }
  return { rank: 0, date: null, created_at: null, dateSource: null, dateIsProvisional: true };
}

function compareCallUsage(uA, uB) {
  if (uA.tot !== uB.tot) return uA.tot - uB.tot;
  return uA.out - uB.out;
}

function extractSourceRevision(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.sourceRevision ?? entry.revision ?? entry.metadataRevision;
  if (raw !== undefined && raw !== null && raw !== '') {
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  const rawUpdated = entry.updated_at ?? entry.sourceUpdatedAt;
  if (rawUpdated !== undefined && rawUpdated !== null && rawUpdated !== '') {
    const ts = typeof rawUpdated === 'number' ? rawUpdated : Date.parse(String(rawUpdated));
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

function compareSourceRevision(incRev, baseRev) {
  const a = typeof incRev === 'number' && Number.isFinite(incRev) ? incRev : null;
  const b = typeof baseRev === 'number' && Number.isFinite(baseRev) ? baseRev : null;
  if (a === null && b === null) return 0;
  if (a !== null && b === null) return 1;
  if (a === null && b !== null) return -1;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

function shouldAdoptSameRankAuthDate(baseEntry, incomingEntry, baseDateInfo, incDateInfo, usageCmp, revCmp, forceIncomingDate = false) {
  const incomingIsStaleStatus = baseEntry.status === 'final' && Boolean(incomingEntry.status) && incomingEntry.status !== 'final';
  if (incomingIsStaleStatus || !incDateInfo.date) return false;
  if (!baseDateInfo.date) return true;
  if (forceIncomingDate) return true;
  if (baseEntry.status !== 'final' && incomingEntry.status === 'final' && usageCmp >= 0 && revCmp >= 0) return true;
  if (revCmp > 0 && usageCmp >= 0) return true;
  if (usageCmp > 0 && revCmp >= 0) return true;
  return false;
}

function mergeSameCallRecords(baseEntry, incomingEntry, canonicalKey, explicitStep = null, preferIncomingModel = false, preferIncomingDate = false) {
  const uBase = getCallTokenBreakdown(baseEntry);
  const uInc = getCallTokenBreakdown(incomingEntry);
  const baseRev = extractSourceRevision(baseEntry);
  const incRev = extractSourceRevision(incomingEntry);
  const usageCmp = compareCallUsage(uInc, uBase);
  const revCmp = compareSourceRevision(incRev, baseRev);
  const incomingIsStaleStatus = baseEntry.status === 'final' && Boolean(incomingEntry.status) && incomingEntry.status !== 'final';
  const takeIncUsage = !incomingIsStaleStatus && (usageCmp > 0 || (usageCmp === 0 && revCmp > 0));

  const inp = takeIncUsage ? uInc.inp : uBase.inp;
  const cap = takeIncUsage ? uInc.cap : uBase.cap;
  const out = takeIncUsage ? uInc.out : uBase.out;
  const think = takeIncUsage ? (uInc.out < uBase.out ? Math.min(uInc.out, uInc.think) : Math.max(uBase.think, uInc.think)) : uBase.think;
  const tot = takeIncUsage ? uInc.tot : uBase.tot;

  const mergedModel = preferIncomingModel && !incomingIsStaleStatus
    ? pickRicherModel(incomingEntry.model, baseEntry.model)
    : pickRicherModel(baseEntry.model, incomingEntry.model);

  const resolvedStep = explicitStep
    ?? baseEntry.stepIndex
    ?? incomingEntry.stepIndex
    ?? extractCallStepNumbers(baseEntry)[0]
    ?? extractCallStepNumbers(incomingEntry)[0]
    ?? null;

  const resolvedCascadeId = baseEntry.cascadeId
    || incomingEntry.cascadeId
    || parseStepFallbackKey(baseEntry.callId, null)?.cascadeId
    || parseStepFallbackKey(incomingEntry.callId, null)?.cascadeId
    || undefined;

  const baseDateInfo = extractNormalizedDateInfo(baseEntry);
  const incDateInfo = extractNormalizedDateInfo(incomingEntry);
  const adoptSameRankDate = incDateInfo.rank >= 2 &&
    incDateInfo.rank === baseDateInfo.rank &&
    shouldAdoptSameRankAuthDate(baseEntry, incomingEntry, baseDateInfo, incDateInfo, usageCmp, revCmp, preferIncomingDate);
  let chosenDateInfo;
  if (incDateInfo.rank > baseDateInfo.rank) {
    chosenDateInfo = incDateInfo;
  } else if (baseDateInfo.rank > incDateInfo.rank) {
    chosenDateInfo = baseDateInfo;
  } else if (adoptSameRankDate) {
    chosenDateInfo = incDateInfo;
  } else if (incDateInfo.rank === 1 && baseDateInfo.date && incDateInfo.date) {
    chosenDateInfo = baseDateInfo.date <= incDateInfo.date ? baseDateInfo : incDateInfo;
  } else {
    chosenDateInfo = baseDateInfo.date ? baseDateInfo : incDateInfo;
  }

  const mergedStatus = (baseEntry.status === 'final' || incomingEntry.status === 'final')
    ? 'final'
    : (incomingEntry.status || baseEntry.status || 'final');
  const mergedRev = !incomingIsStaleStatus && revCmp >= 0 ? (incRev ?? baseRev) : baseRev;

  // 保护已有测速指标与精确模型元数据不被无测速的后续校准覆盖
  const preservedExactId = incomingEntry.modelExactId || baseEntry.modelExactId;
  const preservedLabel = incomingEntry.modelLabel || baseEntry.modelLabel;
  const preservedEffort = incomingEntry.effort || baseEntry.effort;
  const keepSpeed = (!hasSpeedMetrics(baseEntry) && hasSpeedMetrics(incomingEntry) && isValidSpeedSample(incomingEntry))
    ? {
      ...(incomingEntry.ttftSec != null ? { ttftSec: incomingEntry.ttftSec } : {}),
      ...(incomingEntry.streamingSec != null ? { streamingSec: incomingEntry.streamingSec } : {}),
      ...(incomingEntry.durationSec != null ? { durationSec: incomingEntry.durationSec } : {}),
      ...(incomingEntry.tps != null ? { tps: incomingEntry.tps } : {}),
      ...(incomingEntry.origin ? { origin: incomingEntry.origin } : {})
    }
    : (hasSpeedMetrics(baseEntry)
      ? {
        ...(baseEntry.ttftSec != null ? { ttftSec: baseEntry.ttftSec } : {}),
        ...(baseEntry.streamingSec != null ? { streamingSec: baseEntry.streamingSec } : {}),
        ...(baseEntry.durationSec != null ? { durationSec: baseEntry.durationSec } : {}),
        ...(baseEntry.tps != null ? { tps: baseEntry.tps } : {}),
        ...(baseEntry.origin ? { origin: baseEntry.origin } : {})
      }
      : {});

  const merged = {
    ...baseEntry,
    ...(!incomingIsStaleStatus && takeIncUsage ? incomingEntry : {}),
    ...(chosenDateInfo === incDateInfo && incomingEntry.timestamp !== undefined ? { timestamp: incomingEntry.timestamp } : {}),
    callId: canonicalKey,
    source: baseEntry.source || incomingEntry.source || 'desktop',
    ...(resolvedCascadeId ? { cascadeId: resolvedCascadeId } : {}),
    stepIndex: resolvedStep,
    model: mergedModel,
    ...(preservedExactId ? { modelExactId: preservedExactId } : {}),
    ...(preservedLabel ? { modelLabel: preservedLabel } : {}),
    ...(preservedEffort ? { effort: preservedEffort } : {}),
    inputTokens: inp,
    cacheTokens: cap,
    cacheReadTokens: cap,
    outputTokens: out,
    thinkingTokens: think,
    totalTokens: tot,
    status: mergedStatus,
    date: chosenDateInfo.date,
    created_at: chosenDateInfo.created_at,
    ...(chosenDateInfo.dateSource ? { dateSource: chosenDateInfo.dateSource } : {}),
    dateIsProvisional: Boolean(chosenDateInfo.dateIsProvisional),
    ...(mergedRev !== null ? { sourceRevision: mergedRev } : {}),
    ...keepSpeed,
    updatedAt: Date.now()
  };
  if (!chosenDateInfo.dateSource) {
    delete merged.dateSource;
  }
  if (mergedRev === null) {
    delete merged.sourceRevision;
  }

  const costCalc = calculateRequestApiCost(merged);
  if (costCalc.isPriced) {
    merged.modelKey = costCalc.modelKey;
    merged.isPriced = true;
    merged.costUSD = costCalc.costUSD ?? 0;
  } else {
    merged.modelKey = costCalc.modelKey || normalizeModelId(merged.model) || null;
    merged.isPriced = false;
    merged.costUSD = 0;
  }
  merged.isEstimated = Boolean(baseEntry.isEstimated && incomingEntry.isEstimated);
  return merged;
}

// 判定跨键单候选 (real, syn) 是否有充分证据确认为同一调用：已完成的非零真实记录严禁接受跨键异构 ID 的用量改写
function isConfirmableSingleStepMatch(real, syn) {
  if (!real || !syn) return false;
  if (!areModelsCompatible(real.model, syn.model)) return false;
  const uReal = getCallTokenBreakdown(real);
  const uSyn = getCallTokenBreakdown(syn);
  if (uReal.inp === uSyn.inp && uReal.cap === uSyn.cap && uReal.out === uSyn.out) {
    return true;
  }
  if (real.status === 'streaming' || uReal.tot === 0) {
    return true;
  }
  if ((syn.status === 'streaming' || uSyn.tot === 0) && compareCallUsage(uSyn, uReal) <= 0) {
    return true;
  }
  return false;
}

function callSemanticSignature(c) {
  if (!c || typeof c !== 'object') return '';
  const u = getCallTokenBreakdown(c);
  const rev = extractSourceRevision(c);
  return [
    String(c.callId || ''),
    String(c.source || 'desktop'),
    String(c.cascadeId || ''),
    c.stepIndex ?? '',
    String(c.model || ''),
    String(c.modelKey || ''),
    String(c.modelExactId || ''),
    String(c.status || ''),
    Boolean(c.isEstimated),
    Boolean(c.isPriced),
    Number(c.costUSD || 0),
    u.inp,
    u.cap,
    u.out,
    u.think,
    u.tot,
    c.durationSec ?? '',
    c.tps ?? '',
    String(c.date || ''),
    String(c.created_at || ''),
    String(c.dateSource || ''),
    Boolean(c.dateIsProvisional),
    rev ?? ''
  ].join('|');
}

function hasCallsMapChanged(beforeCalls = {}, afterCalls = {}) {
  const bKeys = Object.keys(beforeCalls);
  const aKeys = Object.keys(afterCalls);
  if (bKeys.length !== aKeys.length) return true;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(beforeCalls, k)) return true;
    if (callSemanticSignature(beforeCalls[k]) !== callSemanticSignature(afterCalls[k])) return true;
  }
  return false;
}

function reconcileConfirmableDuplicateStepCalls(callsObj) {
  if (!callsObj || typeof callsObj !== 'object') return false;
  const synItems = [];
  const realItems = [];

  for (const [key, entry] of Object.entries(callsObj)) {
    if (!entry || typeof entry !== 'object') continue;
    const parsedKey = parseStepFallbackKey(key, entry.cascadeId);
    if (parsedKey) {
      synItems.push({
        synKey: key,
        syn: entry,
        synSrc: entry.source || 'desktop',
        synCid: parsedKey.cascadeId.toLowerCase(),
        synStep: parsedKey.stepIndex
      });
    } else {
      realItems.push({ realKey: key, real: entry });
    }
  }

  if (!synItems.length || !realItems.length) return false;

  // 按 (source, cascadeId) 建立局部哈希索引，将 O(syn * real) 降至线性 O(syn + real)
  const synCidSet = new Set();
  for (let i = 0; i < synItems.length; i++) {
    synCidSet.add(`${synItems[i].synSrc}\0${synItems[i].synCid}`);
  }
  const ruleAIndex = new Map();
  const ruleBIndex = new Map();
  for (let i = 0; i < realItems.length; i++) {
    const item = realItems[i];
    const { realKey, real } = item;
    const src = real.source || 'desktop';
    const cid = String(real.cascadeId || '').toLowerCase();
    const srcCid = `${src}\0${cid}`;
    if (!synCidSet.has(srcCid)) continue;
    const stepNums = extractCallStepNumbers(real, realKey);
    if (stepNums.length > 0) {
      for (let j = 0; j < stepNums.length; j++) {
        const aKey = `${srcCid}\0${stepNums[j]}`;
        let list = ruleAIndex.get(aKey);
        if (!list) { list = []; ruleAIndex.set(aKey, list); }
        list.push(item);
      }
    } else {
      const uReal = getCallTokenBreakdown(real);
      const bKey = `${srcCid}\0${uReal.inp}:${uReal.cap}:${uReal.out}`;
      let list = ruleBIndex.get(bKey);
      if (!list) { list = []; ruleBIndex.set(bKey, list); }
      list.push(item);
    }
  }

  let reconciled = false;
  const usedRealKeys = new Set();
  const unmatchedSyn = [];

  // Rule A: 同 (source, cascadeId) 下显式包含相同 stepIndex 且模型兼容的真实 responseId 记录
  for (const sItem of synItems) {
    const { synKey, syn, synSrc, synCid, synStep } = sItem;
    const indexedA = ruleAIndex.get(`${synSrc}\0${synCid}\0${synStep}`);
    const cands = indexedA ? indexedA.filter(({ realKey, real }) => {
      if (usedRealKeys.has(realKey) || !callsObj[realKey]) return false;
      return areModelsCompatible(real.model, syn.model);
    }) : [];

    let matchedRealKey = null;
    if (cands.length === 1) {
      if (isConfirmableSingleStepMatch(cands[0].real, syn)) {
        matchedRealKey = cands[0].realKey;
      }
    } else if (cands.length > 1) {
      const uSyn = getCallTokenBreakdown(syn);
      if (uSyn.inp + uSyn.cap + uSyn.out > 0) {
        const exactCands = cands.filter(({ real }) => {
          const uReal = getCallTokenBreakdown(real);
          return uReal.inp === uSyn.inp && uReal.cap === uSyn.cap && uReal.out === uSyn.out;
        });
        if (exactCands.length === 1) {
          matchedRealKey = exactCands[0].realKey;
        }
      }
    }

    if (matchedRealKey && callsObj[matchedRealKey]) {
      callsObj[matchedRealKey] = mergeSameCallRecords(callsObj[matchedRealKey], syn, matchedRealKey, synStep, false);
      delete callsObj[synKey];
      usedRealKeys.add(matchedRealKey);
      reconciled = true;
    } else {
      unmatchedSyn.push(sItem);
    }
  }

  // Rule B: 遗留 stepIndex == null 的真实记录，按唯一非零 (source, cascadeId, inp, cap, out) + 兼容模型 1-to-1 消重
  if (unmatchedSyn.length) {
    const synByUsage = new Map();
    for (const sItem of unmatchedSyn) {
      const uSyn = getCallTokenBreakdown(sItem.syn);
      if (uSyn.inp + uSyn.cap + uSyn.out <= 0) continue;
      const uKey = `${sItem.synSrc}:${sItem.synCid}:${uSyn.inp}:${uSyn.cap}:${uSyn.out}`;
      let list = synByUsage.get(uKey);
      if (!list) { list = []; synByUsage.set(uKey, list); }
      list.push(sItem);
    }

    for (const [, synGroup] of synByUsage.entries()) {
      if (synGroup.length !== 1) continue;
      const { synKey, syn, synSrc, synCid, synStep } = synGroup[0];
      const uSyn = getCallTokenBreakdown(syn);
      const indexedB = ruleBIndex.get(`${synSrc}\0${synCid}\0${uSyn.inp}:${uSyn.cap}:${uSyn.out}`);
      const cands = indexedB ? indexedB.filter(({ realKey, real }) => {
        if (usedRealKeys.has(realKey) || !callsObj[realKey]) return false;
        return areModelsCompatible(real.model, syn.model);
      }) : [];

      if (cands.length === 1) {
        const matchedRealKey = cands[0].realKey;
        callsObj[matchedRealKey] = mergeSameCallRecords(callsObj[matchedRealKey], syn, matchedRealKey, synStep, false);
        delete callsObj[synKey];
        usedRealKeys.add(matchedRealKey);
        reconciled = true;
      }
    }
  }

  return reconciled;
}

function recordModelCalls(newCalls = [], options = {}) {
  if (!Array.isArray(newCalls) || !newCalls.length) return createRecordResult(true, false);
  const targetDir = typeof options === 'string' ? options : (options.ledgerPath || options.agDir);
  const fsOpt = (options && typeof options === 'object' && options.fs) ? { fs: options.fs } : undefined;
  const resolvedLedgerPath = path.resolve(getPricingLedgerPath(targetDir));

  const executeLocked = () => {
    // 持锁期间强制失效内存缓存，确保跨进程场景读到前一进程刚落盘的最新账本状态
    if (!fsOpt) {
      ledgerCacheByPath.delete(normalizeLedgerKey(resolvedLedgerPath));
    }
    const ledger = loadPricingLedger(targetDir, fsOpt);

    if (ledger.__corrupted || ledger.__unreadable) {
      const prefix = ledger.__corrupted
        ? '账本已损坏，阻止空覆盖'
        : `账本当前不可读 (${ledger.__error || 'I/O 异常'})，阻止覆盖`;
      return createRecordResult(
        false,
        false,
        `${prefix} (${ledger.__corruptedPath})`,
        ledger.__guardPhase || (ledger.__corrupted ? 'corrupted_guard' : 'unreadable_guard'),
        ledger.__code
      );
    }

    // 第一阶段：每条传入记录仅按自身 targetKey 入表或同键合并，避免逐条贪心跨键绑定引发输入顺序依赖
    const beforeCalls = ledger.calls || {};
    const draftCalls = { ...beforeCalls };

    for (const call of newCalls) {
      if (!call || !call.callId) continue;
      // 默认阻止测试样例和合成调用污染生产账本
      if (!options.allowSynthetic && isSyntheticCall(call.callId, call)) continue;

      const targetKey = String(call.callId);
      const incomingFallback = parseStepFallbackKey(targetKey, call.cascadeId);
      const callCidRaw = call.cascadeId || incomingFallback?.cascadeId;
      const existing = draftCalls[targetKey];

      // 严格账号归属：仅接受明确已核实账号字段或显式传入的 options.accountScopeKey / confirmedAccountEmail
      const rawAcctEmail = (typeof call.accountEmail === 'string' && call.accountEmail.includes('@'))
        ? call.accountEmail.trim().toLowerCase()
        : ((typeof options.confirmedAccountEmail === 'string' && options.confirmedAccountEmail.includes('@'))
          ? options.confirmedAccountEmail.trim().toLowerCase()
          : '');
      const resolvedScopeKey = (typeof call.accountScopeKey === 'string' && /^acct_[0-9a-f]{16}$/i.test(call.accountScopeKey.trim()))
        ? call.accountScopeKey.trim()
        : (rawAcctEmail ? buildAccountScopeKey(rawAcctEmail) : ((typeof options.accountScopeKey === 'string' && /^acct_[0-9a-f]{16}$/i.test(options.accountScopeKey.trim())) ? options.accountScopeKey.trim() : null));
      const resolvedAttrConf = resolvedScopeKey
        ? (call.accountAttributionConfidence || options.accountAttributionConfidence || (call.isKeepalive ? 'keepalive_bound' : 'live_confirmed_account'))
        : (call.accountAttributionConfidence || 'unattributed');

      if (!existing) {
        const normalizedStep = extractCallStepNumbers(call, targetKey)[0] ?? null;
        const uInc = getCallTokenBreakdown(call);
        const dInfo = extractNormalizedDateInfo(call);
        const incRev = extractSourceRevision(call);
        const nextEntry = {
          ...call,
          callId: targetKey,
          ...(resolvedScopeKey ? { accountScopeKey: resolvedScopeKey } : {}),
          accountAttributionConfidence: resolvedAttrConf,
          ...(call.isKeepalive ? { isKeepalive: true } : {}),
          ...(callCidRaw && !call.cascadeId ? { cascadeId: callCidRaw } : {}),
          ...(normalizedStep !== null && call.stepIndex == null ? { stepIndex: normalizedStep } : {}),
          ...(call.totalTokens == null && uInc.tot > 0 ? { totalTokens: uInc.tot } : {}),
          ...(dInfo.date ? { date: dInfo.date } : {}),
          ...(dInfo.created_at ? { created_at: dInfo.created_at } : (dInfo.dateIsProvisional ? { created_at: null } : {})),
          ...(dInfo.dateSource ? { dateSource: dInfo.dateSource } : {}),
          dateIsProvisional: Boolean(dInfo.dateIsProvisional),
          ...(incRev !== null ? { sourceRevision: incRev } : {}),
          updatedAt: Date.now()
        };
        if (incRev === null) {
          delete nextEntry.sourceRevision;
        }
        if (dInfo.date && dInfo.date !== call.date) {
          const recalc = calculateRequestApiCost(nextEntry);
          if (recalc.isPriced) {
            nextEntry.modelKey = recalc.modelKey;
            nextEntry.isPriced = true;
            nextEntry.costUSD = recalc.costUSD ?? 0;
          }
        }
        draftCalls[targetKey] = nextEntry;
        continue;
      }

      const uExist = getCallTokenBreakdown(existing);
      const uCall = getCallTokenBreakdown(call);
      const usageCmp = compareCallUsage(uCall, uExist);
      const existRev = extractSourceRevision(existing);
      const callRev = extractSourceRevision(call);
      const revCmp = compareSourceRevision(callRev, existRev);
      const incomingIsStaleStatus = existing.status === 'final' && Boolean(call.status) && call.status !== 'final';
      const isUsageRollback = incomingIsStaleStatus || (existing.status === 'final' && usageCmp < 0);
      const existDateInfo = extractNormalizedDateInfo(existing);
      const callDateInfo = extractNormalizedDateInfo(call);
      const trustIncomingTranscriptDate = Boolean(options.trustTranscriptDate && callDateInfo.dateSource === 'transcript');
      const adoptIncomingSameRankDate = callDateInfo.rank >= 2 &&
        callDateInfo.rank === existDateInfo.rank &&
        shouldAdoptSameRankAuthDate(existing, call, existDateInfo, callDateInfo, usageCmp, revCmp, trustIncomingTranscriptDate);
      const sameRankAuthDateProgressed = adoptIncomingSameRankDate && (
        callDateInfo.date !== existDateInfo.date ||
        (callDateInfo.rank >= 3 && Boolean(callDateInfo.created_at) && callDateInfo.created_at !== existDateInfo.created_at)
      );
      const dateProgressed = (
        callDateInfo.rank > existDateInfo.rank ||
        sameRankAuthDateProgressed ||
        (existing.date && existDateInfo.date && existing.date !== existDateInfo.date)
      ) && Boolean(callDateInfo.date || existDateInfo.date);
      const stateProgressed = existing.status !== 'final' && call.status === 'final';
      const usageProgressed = !incomingIsStaleStatus && usageCmp > 0;
      const revisionUsageProgressed = !isUsageRollback && usageCmp === 0 && revCmp > 0 && (
        uCall.inp !== uExist.inp || uCall.cap !== uExist.cap || uCall.think !== uExist.think
      );
      const revisionMetaProgressed = !isUsageRollback && revCmp > 0 && callRev !== existRev;
      const modelProgressed = getCollectorModelRank(call.model) > getCollectorModelRank(existing.model);
      const speedProgressed = !hasSpeedMetrics(existing) && hasSpeedMetrics(call) && isValidSpeedSample(call);
      const modelExactProgressed = !existing.modelExactId && Boolean(call.modelExactId);
      const recalcExist = calculateRequestApiCost(existing);
      const costOutOfSync = Boolean(recalcExist.isPriced) !== Boolean(existing.isPriced)
        || (recalcExist.isPriced && Number(existing.costUSD || 0) !== Number(recalcExist.costUSD || 0));
      const pricingProgressed = costOutOfSync || ((!existing.isPriced || !existing.costUSD) && Boolean((call.isPriced && call.costUSD > 0) || normalizeModelId(call.model || existing.model)));
      const resolvedStepIndex = existing.stepIndex ?? call.stepIndex ?? extractCallStepNumbers(existing, targetKey)[0] ?? extractCallStepNumbers(call, targetKey)[0] ?? null;
      const metaProgressed = (existing.stepIndex == null && resolvedStepIndex != null) || (!existing.cascadeId && Boolean(callCidRaw)) || modelExactProgressed;

      if (modelProgressed || metaProgressed || dateProgressed || (!isUsageRollback && (stateProgressed || usageProgressed || revisionUsageProgressed || revisionMetaProgressed || pricingProgressed || speedProgressed))) {
        draftCalls[targetKey] = mergeSameCallRecords(
          existing,
          call,
          targetKey,
          resolvedStepIndex,
          !isUsageRollback && revCmp >= 0,
          adoptIncomingSameRankDate
        );
      }
    }

    // 第二阶段：在完整候选集（既有记录 + 整批新入账记录）上统一执行无顺序依赖的充分证据跨键消解
    reconcileConfirmableDuplicateStepCalls(draftCalls);
    pruneExcessSpeedSamples(draftCalls);

    const changed = Boolean(ledger.__hadDuplicateStepKeys) || hasCallsMapChanged(beforeCalls, draftCalls);

    if (changed) {
      const draftLedger = {
        ...ledger,
        calls: draftCalls,
        updatedAt: new Date().toISOString()
      };
      const saveRes = savePricingLedger(draftLedger, targetDir, fsOpt);
      if (!saveRes.ok) {
        return createRecordResult(false, false, saveRes.error || '保存账本落盘失败', saveRes.phase, saveRes.code);
      }
      // 同步落盘物理隔离的分账号账本目录（account_ledgers/<accountScopeKey>.json 与 unattributed.json）
      if (!fsOpt || typeof fsOpt.fs?.writeFileSync === 'function') {
        try {
          syncAccountLedgerPartitions(resolvedLedgerPath, draftCalls, fsOpt?.fs || fs);
        } catch { }
      }
      // 账本变化时失效聚合热缓存（含按 agDir 隔离作用域的扫描缓存）
      cachedTokenHistoryAt = 0;
    }

    return createRecordResult(true, changed);
  };

  if (fsOpt) {
    return executeLocked();
  }
  return withFileLockSync(resolvedLedgerPath, executeLocked);
}

/**
 * 将账本 calls 按 accountScopeKey 严格拆分为独立账号分片与 unattributed.json
 * 不同账号数据绝不互相混合，未归属历史单独隔离。
 */
function syncAccountLedgerPartitions(resolvedLedgerPath, callsMap = {}, fsImpl = fs) {
  const partDir = path.join(path.dirname(resolvedLedgerPath), 'account_ledgers');
  if (!fsImpl.existsSync(partDir)) {
    fsImpl.mkdirSync(partDir, { recursive: true });
  }
  const buckets = new Map();
  buckets.set('unattributed', {});
  for (const [callId, rec] of Object.entries(callsMap || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const rawKey = (typeof rec.accountScopeKey === 'string' && /^acct_[0-9a-f]{16}$/i.test(rec.accountScopeKey.trim()))
      ? rec.accountScopeKey.trim()
      : 'unattributed';
    if (!buckets.has(rawKey)) buckets.set(rawKey, {});
    buckets.get(rawKey)[callId] = rec;
  }
  const nowIso = new Date().toISOString();
  for (const [scopeKey, partCalls] of buckets.entries()) {
    const targetFile = path.join(partDir, `${scopeKey}.json`);
    const payload = JSON.stringify({
      version: 1,
      accountScopeKey: scopeKey,
      updatedAt: nowIso,
      callCount: Object.keys(partCalls).length,
      calls: partCalls
    });
    const tmp = `${targetFile}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, payload, 'utf8');
    fsImpl.renameSync(tmp, targetFile);
  }
}

/**
 * 查询某账号在某模型共享池与指定时间区间内的本地实测消耗（专供 ELV-57 配额变化对照使用）
 */
function summarizeAccountWindowUsage({ agDir, ledgerPath, accountScopeKey, poolKey, startMs, endMs } = {}) {
  const targetDir = ledgerPath || agDir;
  const ledger = loadPricingLedger(targetDir);
  const calls = ledger?.calls && typeof ledger.calls === 'object' ? Object.values(ledger.calls) : [];
  const start = Number(startMs) || 0;
  const end = Number(endMs) || Date.now();
  let requestCount = 0;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let keepaliveRequests = 0;
  let keepaliveTokens = 0;

  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    if (accountScopeKey && call.accountScopeKey !== accountScopeKey) continue;
    if (call.accountAttributionConfidence === 'unattributed') continue;
    const ts = getCallSortTimestamp(call) ?? Number(call.timestamp) ?? (call.created_at ? Date.parse(call.created_at) : NaN);
    if (!Number.isFinite(ts) || ts < start || ts > end) continue;
    if (poolKey) {
      const rawModel = call.modelExactId || extractModelString(call) || call.model || '';
      const sharedKey = typeof getSharedQuotaGroupKey === 'function' ? getSharedQuotaGroupKey(rawModel || call.modelLabel || '') : null;
      const singlePoolKey = typeof getModelPoolKey === 'function' ? getModelPoolKey(rawModel, call.modelLabel || '') : null;
      if (sharedKey !== poolKey && singlePoolKey !== poolKey) continue;
    }
    const u = getCallTokenBreakdown(call);
    const tot = u.tot || (u.inp + u.cap + u.out);
    requestCount += 1;
    uncachedInputTokens += u.inp;
    cacheReadTokens += u.cap;
    outputTokens += u.out;
    totalTokens += tot;
    if (call.isKeepalive) {
      keepaliveRequests += 1;
      keepaliveTokens += tot;
    }
  }

  return {
    requestCount,
    uncachedInputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    keepaliveRequests,
    keepaliveTokens
  };
}

// ============================================================================
// 用户自定义订阅配置与插件栏偏好持久化（按账号隔离 + default 回退 + 损坏自愈）
// ============================================================================
function getCustomPlanPath(overridePathOrDir) {
  if (overridePathOrDir) {
    if (overridePathOrDir.endsWith('.json')) return overridePathOrDir;
    return path.join(overridePathOrDir, 'custom_plan_v1.json');
  }
  if (process.env.AG_DIR) {
    return path.join(process.env.AG_DIR, 'custom_plan_v1.json');
  }
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini', 'antigravity', 'custom_plan_v1.json');
}

const VALID_PANEL_LANGUAGES = new Set(['zh-CN', 'zh-TW', 'en']);
const VALID_THEME_MODES = new Set(['auto', 'dark', 'light']);
const VALID_HEAT_PRESETS = new Set(['violet', 'emerald', 'ocean', 'amber', 'graphite']);
const TOPBAR_PILL_KEYS = ['quota', 'context', 'speed', 'tokens', 'cli'];

function sanitizeTopbarPills(rawPills) {
  if (!rawPills || typeof rawPills !== 'object' || Array.isArray(rawPills)) return undefined;
  const out = {};
  for (const k of TOPBAR_PILL_KEYS) {
    out[k] = rawPills[k] !== false;
  }
  if (!TOPBAR_PILL_KEYS.some(k => out[k])) {
    out.context = true;
  }
  return out;
}

function sanitizeUiPreferences(rawUi, prevUi = {}) {
  const merged = {
    ...(prevUi && typeof prevUi === 'object' && !Array.isArray(prevUi) ? prevUi : {}),
    ...(rawUi && typeof rawUi === 'object' && !Array.isArray(rawUi) ? rawUi : {})
  };
  delete merged.autoCheckUpdate;
  if (merged.restartVerification === null) delete merged.restartVerification;
  if (merged.panelLanguage !== undefined && !VALID_PANEL_LANGUAGES.has(merged.panelLanguage)) {
    delete merged.panelLanguage;
  }
  if (merged.themeMode !== undefined && !VALID_THEME_MODES.has(merged.themeMode)) {
    delete merged.themeMode;
  }
  if (merged.heatPreset !== undefined && !VALID_HEAT_PRESETS.has(merged.heatPreset)) {
    delete merged.heatPreset;
  }
  if (merged.topbarPills !== undefined) {
    const cleanPills = sanitizeTopbarPills(merged.topbarPills);
    if (cleanPills) merged.topbarPills = cleanPills;
    else delete merged.topbarPills;
  }
  if (merged.billingDay !== undefined) {
    const bd = Math.floor(Number(merged.billingDay));
    if (Number.isFinite(bd) && bd >= 1 && bd <= 31) merged.billingDay = bd;
    else delete merged.billingDay;
  }
  if (merged.costScope !== undefined) {
    if (merged.costScope !== 'period' && merged.costScope !== 'cycle' && merged.costScope !== 'all') {
      delete merged.costScope;
    }
  }
  return merged;
}

function sanitizeAccountPlanEntry(entry, accountKey = 'default') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const account = String(entry.account || entry.email || accountKey || 'default').trim().toLowerCase() || 'default';

  let spendUSD = null;
  if (entry.monthlySpendUSD !== undefined && entry.monthlySpendUSD !== null && entry.monthlySpendUSD !== '') {
    const num = Number(entry.monthlySpendUSD);
    if (Number.isFinite(num) && num >= 0) spendUSD = Number(num.toFixed(2));
  } else if (entry.isZeroExtraCost === true) {
    spendUSD = 0;
  } else if (entry.actualPricePaid !== undefined && entry.actualPricePaid !== null && entry.actualPricePaid !== '') {
    const num = Number(entry.actualPricePaid);
    if (Number.isFinite(num) && num >= 0) {
      if (num === 0) {
        spendUSD = 0;
      } else if (entry.priceMode !== 'preset' && entry.priceSource !== 'preset_region') {
        const rawCur = String(entry.subscriptionCurrency || entry.currency || 'USD').trim().toUpperCase();
        if (rawCur === 'USD') spendUSD = Number(num.toFixed(2));
      }
    }
  }

  const out = {
    account,
    currency: 'USD',
    currencySymbol: '$',
    actualPricePaid: spendUSD,
    monthlySpendUSD: spendUSD,
    isZeroExtraCost: spendUSD === 0,
    priceMode: spendUSD !== null ? 'custom' : 'unset',
    updatedAt: typeof entry.updatedAt === 'string' && entry.updatedAt ? entry.updatedAt : new Date().toISOString()
  };
  if (typeof entry.tierName === 'string' && entry.tierName.trim()) {
    out.tierName = sanitizeLegacyPlanTierName(entry.tierName.trim());
    if (typeof entry.tierKey === 'string' && entry.tierKey.trim()) out.tierKey = entry.tierKey.trim();
  }
  return out;
}

function loadCustomPlanSettings(overridePathOrDir) {
  const p = getCustomPlanPath(overridePathOrDir);
  const def = {
    version: '2.0.0',
    updatedAt: '',
    lastAccount: 'default',
    accounts: {},
    uiPreferences: {}
  };
  try {
    if (!fs.existsSync(p)) return def;
    const content = fs.readFileSync(p, 'utf8');
    if (!content.trim()) return def;
    let raw;
    try {
      raw = JSON.parse(content);
    } catch {
      try {
        const bakCorrupt = p.replace(/\.json$/i, '') + '.corrupt.bak.json';
        fs.copyFileSync(p, bakCorrupt);
      } catch { }
      return { ...def, recoveredFromCorruption: true };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...def, recoveredFromCorruption: true };
    }

    const accounts = {};
    if (!raw.accounts && (raw.monthlySpendUSD !== undefined || raw.actualPricePaid !== undefined || raw.isZeroExtraCost !== undefined)) {
      const legacyEntry = sanitizeAccountPlanEntry(raw, raw.email || raw.account || 'default');
      if (legacyEntry && (legacyEntry.actualPricePaid !== null || legacyEntry.tierName)) {
        accounts[legacyEntry.account] = legacyEntry;
        accounts['default'] = { ...legacyEntry, account: 'default' };
      }
    } else if (raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
      for (const [k, v] of Object.entries(raw.accounts)) {
        const cleanKey = String(k).trim().toLowerCase();
        const sanitized = sanitizeAccountPlanEntry(v, cleanKey);
        if (sanitized && (sanitized.actualPricePaid !== null || sanitized.tierName)) {
          accounts[cleanKey] = sanitized;
        }
      }
    }

    const uiPreferences = sanitizeUiPreferences(raw.uiPreferences);

    return {
      version: raw.version || '2.0.0',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      lastAccount: typeof raw.lastAccount === 'string' ? raw.lastAccount : 'default',
      accounts,
      uiPreferences
    };
  } catch {
    return def;
  }
}

function saveCustomPlanSettingsDetailed(settings, overridePathOrDir) {
  const p = getCustomPlanPath(overridePathOrDir);
  const res = safeWriteJsonSync(p, settings, {
    validate: (data) => data && typeof data === 'object' && !Array.isArray(data)
  });
  if (!res.ok) {
    return { ok: false, error: res.error || '写入配置文件失败', phase: res.phase, path: p };
  }
  return { ok: true, path: p };
}

function saveCustomPlanSettings(settings, overridePathOrDir) {
  return saveCustomPlanSettingsDetailed(settings, overridePathOrDir).ok;
}

function setCustomPlanForAccount(accountKey, customData = {}, overridePathOrDir) {
  if (!accountKey) return false;
  const settings = loadCustomPlanSettings(overridePathOrDir);
  const key = String(accountKey).trim().toLowerCase();
  const merged = sanitizeAccountPlanEntry({
    ...(settings.accounts[key] || {}),
    ...customData,
    account: key,
    updatedAt: new Date().toISOString()
  }, key);
  if (!merged) return false;
  settings.accounts[key] = merged;
  settings.accounts['default'] = {
    ...merged,
    account: 'default'
  };
  if (key !== 'default') settings.lastAccount = key;
  settings.updatedAt = new Date().toISOString();
  return saveCustomPlanSettings(settings, overridePathOrDir);
}

function clearCustomPlanForAccount(accountKey, overridePathOrDir) {
  if (!accountKey) return false;
  const settings = loadCustomPlanSettings(overridePathOrDir);
  const key = String(accountKey).trim().toLowerCase();
  delete settings.accounts[key];
  delete settings.accounts['default'];
  settings.updatedAt = new Date().toISOString();
  return saveCustomPlanSettings(settings, overridePathOrDir);
}

function resolveAccountCustomPlan(customSettingsAll, currentAccountKey) {
  if (!customSettingsAll || !customSettingsAll.accounts) return null;
  const accMap = customSettingsAll.accounts;
  if (currentAccountKey) {
    const k = String(currentAccountKey).trim().toLowerCase();
    if (accMap[k]) return accMap[k];
    if (k !== 'default') return null;
  }
  if (!currentAccountKey || currentAccountKey === 'default') {
    if (customSettingsAll.lastAccount && accMap[customSettingsAll.lastAccount]) {
      return accMap[customSettingsAll.lastAccount];
    }
    if (accMap['default']) return accMap['default'];
  }
  return null;
}

function getPluginSettings(options = {}) {
  const targetDir = typeof options === 'string' ? options : options?.agDir;
  const settings = loadCustomPlanSettings(targetDir);
  const email = options?.email || cachedTokenHistory?.planStatus?.email || null;
  const customPlan = resolveAccountCustomPlan(settings, email);
  const uiPrefs = settings.uiPreferences || {};
  return {
    ok: true,
    customPlan,
    uiPreferences: uiPrefs,
    savedHeatView: uiPrefs.savedHeatView,
    panelLanguage: (uiPrefs.panelLanguage && VALID_PANEL_LANGUAGES.has(uiPrefs.panelLanguage)) ? uiPrefs.panelLanguage : 'en',
    themeMode: uiPrefs.themeMode || 'auto',
    heatPreset: uiPrefs.heatPreset || 'violet',
    topbarPills: sanitizeTopbarPills(uiPrefs.topbarPills) || { quota: true, context: true, speed: true, tokens: true, cli: true },
    accounts: settings.accounts || {},
    updatedAt: settings.updatedAt || '',
    recoveredFromCorruption: Boolean(settings.recoveredFromCorruption)
  };
}

function savePluginSettings(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: '无效的设置参数' };
  }
  const targetDir = typeof options === 'string' ? options : (options?.targetDir || options?.agDir || payload?.targetDir || payload?.agDir);
  const settings = loadCustomPlanSettings(targetDir);
  const rawKey = payload.account || payload.email || cachedTokenHistory?.planStatus?.email || settings.lastAccount || 'default';
  const key = String(rawKey).trim().toLowerCase() || 'default';

  if (payload.clearPlan === true) {
    delete settings.accounts[key];
    if (key === 'default' || settings.lastAccount === key) {
      delete settings.accounts['default'];
      settings.lastAccount = 'default';
    }
  } else if (payload.customPlan && typeof payload.customPlan === 'object') {
    const prev = settings.accounts[key] || {};
    const inputPlan = payload.customPlan;
    const rawSpend = inputPlan.monthlySpendUSD !== undefined ? inputPlan.monthlySpendUSD : inputPlan.actualPricePaid;
    if (rawSpend === null || rawSpend === '') {
      delete settings.accounts[key];
      if (key === 'default' || settings.lastAccount === key) {
        delete settings.accounts['default'];
      }
    } else {
      if (rawSpend !== undefined) {
        const parsedNum = Number(rawSpend);
        if (!Number.isFinite(parsedNum) || parsedNum < 0) {
          return { ok: false, error: '月度实付金额必须为大于或等于 0 的有效美元数值' };
        }
      }
      const mergedRaw = {
        ...prev,
        ...inputPlan,
        currency: 'USD',
        account: key,
        updatedAt: new Date().toISOString()
      };
      const sanitized = sanitizeAccountPlanEntry(mergedRaw, key);
      if (!sanitized) {
        return { ok: false, error: '订阅设置格式无效' };
      }
      settings.accounts[key] = sanitized;
      if (key !== 'default') settings.lastAccount = key;
      settings.accounts['default'] = { ...sanitized, account: 'default' };
    }
  }

  const topLevelUiPrefs = {};
  if (typeof payload.savedHeatView === 'string' && payload.savedHeatView) {
    topLevelUiPrefs.savedHeatView = payload.savedHeatView;
  }
  if (typeof payload.panelLanguage === 'string' && VALID_PANEL_LANGUAGES.has(payload.panelLanguage)) {
    topLevelUiPrefs.panelLanguage = payload.panelLanguage;
  }
  if (typeof payload.themeMode === 'string' && VALID_THEME_MODES.has(payload.themeMode)) {
    topLevelUiPrefs.themeMode = payload.themeMode;
  }
  if (typeof payload.heatPreset === 'string' && VALID_HEAT_PRESETS.has(payload.heatPreset)) {
    topLevelUiPrefs.heatPreset = payload.heatPreset;
  }
  if (payload.topbarPills && typeof payload.topbarPills === 'object') {
    topLevelUiPrefs.topbarPills = payload.topbarPills;
  }

  const hasIncomingUi = (payload.uiPreferences && typeof payload.uiPreferences === 'object' && !Array.isArray(payload.uiPreferences))
    || Object.keys(topLevelUiPrefs).length > 0;
  if (hasIncomingUi) {
    const combined = {
      ...(payload.uiPreferences && typeof payload.uiPreferences === 'object' && !Array.isArray(payload.uiPreferences) ? payload.uiPreferences : {}),
      ...topLevelUiPrefs,
      updatedAt: new Date().toISOString()
    };
    settings.uiPreferences = sanitizeUiPreferences(combined, settings.uiPreferences);
  }

  delete settings.recoveredFromCorruption;
  settings.updatedAt = new Date().toISOString();
  const writeRes = saveCustomPlanSettingsDetailed(settings, targetDir);
  if (!writeRes.ok) {
    return { ok: false, error: writeRes.error || '配置落盘失败' };
  }

  const activeCustom = resolveAccountCustomPlan(settings, key === 'default' ? null : key);
  const baseLive = cachedTokenHistory?.rawPlanStatus || cachedTokenHistory?.planStatus || null;
  const effectivePlanStatus = resolveEffectivePlanStatus(baseLive, activeCustom, {
    cachedLivePlan: baseLive,
    currentEmail: key === 'default' ? (baseLive?.email || null) : key
  });

  if (!targetDir && cachedTokenHistory) {
    cachedTokenHistory.planStatus = effectivePlanStatus;
    cachedTokenHistory.customPlanSettings = activeCustom;
    cachedTokenHistory.uiPreferences = settings.uiPreferences;
  }
  let archiveSyncWarning = null;
  let archiveSynced = false;
  try {
    const home = process.env.USERPROFILE || os.homedir();
    const agDir = targetDir && !targetDir.endsWith('.json') ? targetDir : (process.env.AG_DIR || path.join(home, '.gemini', 'antigravity'));
    const archivePathV2 = path.join(agDir, 'token_usage_archive_v2.json');
    if (fs.existsSync(archivePathV2)) {
      const readRes = safeReadJsonSync(archivePathV2, null);
      if (readRes.ok && readRes.data && typeof readRes.data === 'object') {
        const v2Raw = { ...readRes.data };
        v2Raw.planStatus = effectivePlanStatus;
        v2Raw.customPlanSettings = activeCustom;
        const writeArch = safeWriteJsonSync(archivePathV2, v2Raw);
        if (!writeArch.ok) {
          archiveSyncWarning = writeArch.error || '写入 v2 归档文件失败';
        } else {
          archiveSynced = true;
        }
      } else if (readRes.corrupted) {
        archiveSyncWarning = 'v2 归档文件内容已损坏，已阻止回写覆盖以保护原始数据';
      }
    }
  } catch (err) {
    archiveSyncWarning = err?.message || '同步派生归档时发生未知异常';
  }

  return {
    ok: true,
    partial: archiveSyncWarning !== null,
    warning: archiveSyncWarning ? `主配置已保存，但派生归档同步失败: ${archiveSyncWarning}` : undefined,
    archiveSynced,
    path: writeRes.path,
    savedAt: settings.updatedAt,
    customPlan: activeCustom,
    planStatus: effectivePlanStatus,
    uiPreferences: settings.uiPreferences
  };
}

const cachedUserStatusByOrigin = new Map();
const cachedQuotaStateByOrigin = new Map();
const activeQuotaFetchByOrigin = new Map();

function normalizeQuotaOriginScope(options = {}) {
  const raw = typeof options.origin === 'string' ? options.origin.trim() : '';
  return raw || '__default__';
}

function buildAccountScopeKey(emailOrId) {
  const raw = typeof emailOrId === 'string' ? emailOrId.trim().toLowerCase() : '';
  if (!raw) return 'anonymous';
  return 'acct_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function resetQuotaHostCacheForTest() {
  cachedUserStatusByOrigin.clear();
  cachedQuotaStateByOrigin.clear();
  activeQuotaFetchByOrigin.clear();
}

function classifyQuotaFetchError(err) {
  const msg = String(err?.message || err || '未知错误').trim();
  const lower = msg.toLowerCase();
  if (/enoent|devtoolsactiveport/i.test(lower)) {
    return { kind: 'network', message: '本地额度服务尚未就绪，请稍后重试' };
  }
  if (/timeout|timed out|etimedout|deadline/i.test(lower)) {
    return { kind: 'timeout', message: '请求语言服务超时' };
  }
  if (/econnrefused|econnreset|enotfound|not running|unreachable|network|socket|connect/i.test(lower)) {
    return { kind: 'network', message: '未能连接到 Antigravity 本地服务' };
  }
  if (/unauthorized|forbidden|401|403|csrf|鉴权/i.test(lower)) {
    return { kind: 'auth', message: '本地鉴权失败或已失效' };
  }
  return { kind: 'network', message: msg || '额度数据获取失败' };
}

/**
 * 并发拉取宿主模型额度池与可用模型详情，带多窗口 origin 隔离、并发去重、短缓存、失败分级及账号切换检测
 * @param {Object} options - 支持 force / origin / backendSource / userStatus / quotaSummary / connect 等参数
 */
async function fetchQuotaSnapshotFromHost(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const force = options.force === true;
  const hasStaticFixture = options.userStatus !== undefined || options.quotaSummary !== undefined || options.error !== undefined;
  const originScope = normalizeQuotaOriginScope(options);
  const backendSource = typeof options.backendSource === 'string' && options.backendSource.trim()
    ? options.backendSource.trim()
    : 'host';

  // 短缓存防刷（仅在非强制刷新且无静态测试桩时生效，15s 内复用同 origin 结果）
  const prevCachedQuota = cachedQuotaStateByOrigin.get(originScope) || null;
  if (!force && !hasStaticFixture && !options.agDir && prevCachedQuota && (nowMs - prevCachedQuota.fetchedAtMs < 15000)) {
    if (prevCachedQuota.backendSource === backendSource && prevCachedQuota.collectorVersion === PROJECT_VERSION) {
      return prevCachedQuota;
    }
    return {
      ...prevCachedQuota,
      collectorVersion: PROJECT_VERSION,
      backendVersion: PROJECT_VERSION,
      backendSource
    };
  }

  // 如果已有相同 origin 请求进行中，直接合并等待，避免重复请求
  const activePromise = activeQuotaFetchByOrigin.get(originScope) || null;
  if (!hasStaticFixture && activePromise) {
    if (!force) return activePromise;
    try { await activePromise; } catch { }
  }

  const runFetch = async () => {
    let userStatusRes = null;
    let quotaSummaryRes = null;
    let fetchError = null;
    let errorKind = null;

    if (options.error) {
      const classified = classifyQuotaFetchError(options.error);
      fetchError = classified.message;
      errorKind = classified.kind;
    } else if (options.userStatus !== undefined || options.quotaSummary !== undefined) {
      userStatusRes = options.userStatus || null;
      quotaSummaryRes = options.quotaSummary || null;
    } else {
      try {
        const connector = typeof options.connect === 'function' ? options.connect : require('./local-api').connect;
        const api = await connector(options.origin ? { origin: options.origin } : undefined);
        const [uRes, qRes] = await Promise.allSettled([
          api.call('GetUserStatus', {}),
          api.call('RetrieveUserQuotaSummary', {})
        ]);
        if (uRes.status === 'fulfilled' && uRes.value) {
          userStatusRes = uRes.value;
        }
        if (qRes.status === 'fulfilled' && qRes.value) {
          quotaSummaryRes = qRes.value;
        }
        if (!userStatusRes && !quotaSummaryRes) {
          const firstErr = uRes.status === 'rejected' ? uRes.reason : (qRes.status === 'rejected' ? qRes.reason : new Error('宿主未返回额度数据'));
          const classified = classifyQuotaFetchError(firstErr);
          fetchError = classified.message;
          errorKind = classified.kind;
        }
      } catch (e) {
        const classified = classifyQuotaFetchError(e);
        fetchError = classified.message;
        errorKind = classified.kind;
      }
    }

    const doneAtMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const rawConfigs = userStatusRes?.userStatus?.cascadeModelConfigData?.clientModelConfigs
      || userStatusRes?.cascadeModelConfigData?.clientModelConfigs
      || [];
    const sanitizedConfigs = Array.isArray(rawConfigs)
      ? rawConfigs.map(sanitizeCascadeModelConfig).filter(Boolean)
      : [];
    const parsedPlan = userStatusRes ? parseUserPlanStatus(userStatusRes) : null;
    const rawEmail = parsedPlan?.email || userStatusRes?.userStatus?.email || '';
    const scopeQuotaState = cachedQuotaStateByOrigin.get(originScope) || null;
    const scopeUserEntry = cachedUserStatusByOrigin.get(originScope) || null;
    const prevAccountScopeKey = scopeUserEntry?.accountScopeKey || scopeQuotaState?.accountScopeKey || null;
    const nextScopeKey = rawEmail ? buildAccountScopeKey(rawEmail) : (prevAccountScopeKey || 'anonymous');

    // 账号切换检测：一旦发现同 origin 作用域下账号变化，立即清掉旧账号缓存，绝不跨账号残留旧额度
    const accountSwitched = Boolean(
      rawEmail &&
      prevAccountScopeKey &&
      nextScopeKey !== prevAccountScopeKey
    );
    if (accountSwitched) {
      cachedQuotaStateByOrigin.delete(originScope);
      cachedUserStatusByOrigin.delete(originScope);
    }
    if (rawEmail) {
      const existingEntry = cachedUserStatusByOrigin.get(originScope) || {};
      cachedUserStatusByOrigin.set(originScope, {
        ...existingEntry,
        accountScopeKey: nextScopeKey
      });
    }

    if (fetchError) {
      // 保留同 origin 同账号最后一次有效原始响应以产出 stale 状态；无旧数据时产出 error 状态
      const curScoped = cachedQuotaStateByOrigin.get(originScope) || null;
      const prevRaw = (!accountSwitched && curScoped?._raw) ? curScoped._raw : null;
      const snapshot = buildModelQuotaSnapshot({
        cascadeModelConfigs: prevRaw?.cascadeModelConfigs || [],
        quotaSummaryRes: prevRaw?.quotaSummaryRes || null,
        planStatus: prevRaw?.planStatus || null,
        currentModel: options.currentModel || null,
        browsePoolKey: options.browsePoolKey || null,
        fetchMeta: {
          fetchedAtMs: prevRaw?.fetchedAtMs || null,
          error: fetchError,
          errorKind
        },
        nowMs: doneAtMs
      });
      const prevPlanSafe = prevRaw?.planStatus ? {
        status: prevRaw.planStatus.status,
        tierKey: prevRaw.planStatus.tierKey,
        tierId: prevRaw.planStatus.tierId || null,
        teamsTier: prevRaw.planStatus.teamsTier || null,
        tierName: sanitizeLegacyPlanTierName(prevRaw.planStatus.tierName || null),
        planName: sanitizeLegacyPlanTierName(prevRaw.planStatus.planName || null),
        email: prevRaw.planStatus.email || null,
        officialPriceMonthly: prevRaw.planStatus.officialPriceMonthly ?? null,
        promptCredits: prevRaw.planStatus.promptCredits || null,
        flowCredits: prevRaw.planStatus.flowCredits || null
      } : null;
      const out = {
        ok: false,
        collectorVersion: PROJECT_VERSION,
        backendVersion: PROJECT_VERSION,
        backendSource,
        originScope,
        accountScopeKey: prevRaw?.accountScopeKey || nextScopeKey,
        accountSwitched,
        fetchedAtMs: doneAtMs,
        lastSuccessAtMs: prevRaw?.fetchedAtMs || null,
        error: fetchError,
        errorKind,
        planStatus: prevPlanSafe,
        planTierSummary: prevPlanSafe ? {
          status: prevPlanSafe.status,
          tierKey: prevPlanSafe.tierKey,
          tierId: prevPlanSafe.tierId,
          teamsTier: prevPlanSafe.teamsTier,
          tierName: prevPlanSafe.tierName,
          planName: prevPlanSafe.planName
        } : null,
        snapshot,
        _raw: prevRaw
      };
      if (!hasStaticFixture && !options.agDir && curScoped) {
        cachedQuotaStateByOrigin.set(originScope, { ...curScoped, error: fetchError, errorKind, snapshot });
      }
      return out;
    }

    const rawRecord = {
      cascadeModelConfigs: sanitizedConfigs,
      quotaSummaryRes,
      planStatus: parsedPlan,
      fetchedAtMs: doneAtMs,
      accountScopeKey: nextScopeKey
    };

    const snapshot = buildModelQuotaSnapshot({
      cascadeModelConfigs: sanitizedConfigs,
      quotaSummaryRes,
      planStatus: parsedPlan,
      currentModel: options.currentModel || null,
      browsePoolKey: options.browsePoolKey || null,
      fetchMeta: {
        fetchedAtMs: doneAtMs,
        error: null,
        errorKind: null
      },
      nowMs: doneAtMs
    });

    const livePlanSafe = parsedPlan ? {
      status: parsedPlan.status,
      tierKey: parsedPlan.tierKey,
      tierId: parsedPlan.tierId || null,
      teamsTier: parsedPlan.teamsTier || null,
      tierName: sanitizeLegacyPlanTierName(parsedPlan.tierName || null),
      planName: sanitizeLegacyPlanTierName(parsedPlan.planName || null),
      email: parsedPlan.email || null,
      officialPriceMonthly: parsedPlan.officialPriceMonthly ?? null,
      promptCredits: parsedPlan.promptCredits || null,
      flowCredits: parsedPlan.flowCredits || null
    } : null;

    const out = {
      ok: true,
      collectorVersion: PROJECT_VERSION,
      backendVersion: PROJECT_VERSION,
      backendSource,
      originScope,
      accountScopeKey: nextScopeKey,
      accountSwitched,
      fetchedAtMs: doneAtMs,
      lastSuccessAtMs: doneAtMs,
      error: null,
      errorKind: null,
      planStatus: livePlanSafe,
      planTierSummary: livePlanSafe ? {
        status: livePlanSafe.status,
        tierKey: livePlanSafe.tierKey,
        tierId: livePlanSafe.tierId,
        teamsTier: livePlanSafe.teamsTier,
        tierName: livePlanSafe.tierName,
        planName: livePlanSafe.planName
      } : null,
      snapshot,
      cascadeModelConfigs: sanitizedConfigs,
      _raw: rawRecord
    };

    if (!hasStaticFixture && !options.agDir) {
      cachedQuotaStateByOrigin.set(originScope, out);
    }
    return out;
  };

  if (!hasStaticFixture) {
    const p = runFetch().finally(() => {
      if (activeQuotaFetchByOrigin.get(originScope) === p) activeQuotaFetchByOrigin.delete(originScope);
    });
    activeQuotaFetchByOrigin.set(originScope, p);
    return p;
  }
  return runFetch();
}

async function fetchUserStatusFromHost(options = {}) {
  if (options && options.userStatus !== undefined) {
    if (!options.userStatus) return null;
    const parsed = parseUserPlanStatus(options.userStatus);
    const configs = options.userStatus?.userStatus?.cascadeModelConfigData?.clientModelConfigs || options.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const availMap = options.availableModels ? parseAvailableModelsResponse(options.availableModels) : {};
    if (parsed) {
      if (Object.keys(availMap).length) parsed.availableModelDetails = availMap;
      if (configs.length) parsed.cascadeModelConfigs = mergeModelCapabilitiesIntoConfigs(configs, availMap);
    }
    return parsed;
  }
  const originScope = normalizeQuotaOriginScope(options);
  const cachedEntry = cachedUserStatusByOrigin.get(originScope) || null;
  if (!options.agDir && !options.force && cachedEntry?.status && Date.now() - (cachedEntry.fetchedAt || 0) < 60000) {
    return cachedEntry.status;
  }
  try {
    const { connect } = require('./local-api');
    const api = await connect(options.origin ? { origin: options.origin } : undefined);
    const [res, availRes] = await Promise.all([
      api.call('GetUserStatus', {}),
      api.call('GetAvailableModels', { forceRefresh: false }).catch(() => null)
    ]);
    const parsed = parseUserPlanStatus(res);
    const configs = res?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const availMap = availRes ? parseAvailableModelsResponse(availRes) : {};
    if (parsed) {
      if (Object.keys(availMap).length) parsed.availableModelDetails = availMap;
      if (configs.length) parsed.cascadeModelConfigs = mergeModelCapabilitiesIntoConfigs(configs, availMap);
    }
    if (parsed && !options.agDir) {
      const nextScope = parsed.email ? buildAccountScopeKey(parsed.email) : null;
      const prevScope = cachedEntry?.accountScopeKey || null;
      if (nextScope && prevScope && nextScope !== prevScope) {
        cachedQuotaStateByOrigin.delete(originScope);
      }
      cachedUserStatusByOrigin.set(originScope, {
        status: parsed,
        fetchedAt: Date.now(),
        accountScopeKey: nextScope || prevScope || null
      });
    }
    return parsed;
  } catch {
    return cachedEntry?.status || null;
  }
}

let activeScanPromise = null;
let activeScanScope = '';
let cachedTokenHistoryScope = '';
let currentScanSequence = 0;
const TRANSCRIPT_SKIP_DIRS = new Set(['steps', 'tasks', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);
const transcriptFileCache = new Map();

function dedupeScanPaths(paths = []) {
  const out = [];
  const seen = new Set();
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function resolvePrimaryGeminiDirs(options = {}) {
  const home = os.homedir();
  const explicitAg = options.agDir || process.env.AG_DIR || null;
  const agDir = explicitAg || path.join(home, '.gemini', 'antigravity');
  const agCliDir = options.agCliDir || process.env.AG_CLI_DIR || (
    explicitAg
      ? path.join(path.dirname(path.resolve(explicitAg)), 'antigravity-cli')
      : path.join(home, '.gemini', 'antigravity-cli')
  );
  return { home, agDir, agCliDir };
}

function getEffectiveScanScopeKey(options = {}) {
  const resolved = resolvePrimaryGeminiDirs(options);
  const agDir = path.resolve(resolved.agDir);
  const agCliDir = path.resolve(resolved.agCliDir);
  const extraDesk = dedupeScanPaths(Array.isArray(options.extraAgDirs) ? options.extraAgDirs : []);
  const extraCli = dedupeScanPaths(Array.isArray(options.extraAgCliDirs) ? options.extraAgCliDirs : []);
  return [agDir, agCliDir, ...extraDesk, ...extraCli].join('|');
}

function isFsMonkeyPatched() {
  return fs.readFileSync !== origFsMethods.readFileSync ||
    fs.writeFileSync !== origFsMethods.writeFileSync ||
    fs.copyFileSync !== origFsMethods.copyFileSync ||
    fs.renameSync !== origFsMethods.renameSync ||
    fs.readdirSync !== origFsMethods.readdirSync ||
    fs.statSync !== origFsMethods.statSync ||
    fs.existsSync !== origFsMethods.existsSync;
}

function captureCollectorEnvSnapshot() {
  const snap = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') snap[k] = v;
  }
  return snap;
}

function cloneCollectorOptionsForWorker(options = {}) {
  const out = {};
  if (!options || typeof options !== 'object') return out;
  for (const [k, v] of Object.entries(options)) {
    if (k === '_inWorker' || k === 'fs' || k === 'hostFetcher') continue;
    if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function canUseHistoryWorker(options = {}) {
  if (!isMainThread || typeof Worker !== 'function') return false;
  if (historyWorkerDisabled || options.useWorker === false || options._inWorker) return false;
  if (options.fs || options.hostFetcher) return false;
  if (Date.now !== origDateNow || isFsMonkeyPatched()) return false;
  return true;
}

let historyWorkerDisabled = false;
let historyWorkerConsecutiveErrors = 0;
let historyWorkerInstance = null;
let historyWorkerScriptPath = __filename;
let historyWorkerIdleTimer = null;
let historyWorkerReqId = 1;
const historyWorkerPending = new Map();
const HISTORY_WORKER_IDLE_MS = 45000;
const DEFAULT_HISTORY_WORKER_TIMEOUT_MS = 45000;

function clearAllHistoryWorkerPending(targetWorker = null, errReason = null) {
  for (const [id, entry] of historyWorkerPending.entries()) {
    if (targetWorker && entry.worker !== targetWorker) continue;
    historyWorkerPending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(errReason ? { _workerHandled: false, error: errReason } : null);
  }
}

function scheduleHistoryWorkerIdleCleanup() {
  if (historyWorkerIdleTimer) {
    clearTimeout(historyWorkerIdleTimer);
    historyWorkerIdleTimer = null;
  }
  if (!historyWorkerInstance || historyWorkerPending.size > 0) return;
  const idleMs = process.env.NODE_TEST_CONTEXT ? 120 : HISTORY_WORKER_IDLE_MS;
  historyWorkerIdleTimer = setTimeout(() => {
    historyWorkerIdleTimer = null;
    if (historyWorkerInstance && historyWorkerPending.size === 0) {
      const w = historyWorkerInstance;
      historyWorkerInstance = null;
      try { w.terminate(); } catch { }
    }
  }, idleMs);
  if (typeof historyWorkerIdleTimer.unref === 'function') historyWorkerIdleTimer.unref();
}

function getOrStartHistoryWorker(workerEntry = __filename) {
  const targetScript = workerEntry || __filename;
  if (historyWorkerInstance && historyWorkerScriptPath === targetScript) return historyWorkerInstance;
  if (historyWorkerInstance && historyWorkerScriptPath !== targetScript) {
    const oldW = historyWorkerInstance;
    historyWorkerInstance = null;
    clearAllHistoryWorkerPending(oldW, 'worker_replaced');
    try { oldW.terminate(); } catch { }
  }
  historyWorkerScriptPath = targetScript;
  const w = new Worker(targetScript, {
    workerData: { agCollectorHistoryWorker: true }
  });
  w.on('message', (msg) => {
    if (!msg || !msg.id) return;
    const entry = historyWorkerPending.get(msg.id);
    if (!entry) return;
    historyWorkerPending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    historyWorkerConsecutiveErrors = 0;
    if (historyWorkerPending.size === 0) {
      try { w.unref(); } catch { }
    }
    scheduleHistoryWorkerIdleCleanup();
    if (msg.ok) entry.resolve({ _workerHandled: true, result: msg.result });
    else entry.resolve({ _workerHandled: false, error: msg.error || 'Worker 执行失败' });
  });
  w.on('error', (err) => {
    historyWorkerConsecutiveErrors++;
    if (historyWorkerConsecutiveErrors >= 3) {
      historyWorkerDisabled = true;
    }
    if (historyWorkerInstance === w) historyWorkerInstance = null;
    clearAllHistoryWorkerPending(w, err?.message || 'worker_error');
    try { w.terminate(); } catch { }
  });
  w.on('exit', (code) => {
    if (code !== 0) {
      let hadPending = false;
      for (const entry of historyWorkerPending.values()) {
        if (entry.worker === w) { hadPending = true; break; }
      }
      if (hadPending) {
        historyWorkerConsecutiveErrors++;
        if (historyWorkerConsecutiveErrors >= 3) {
          historyWorkerDisabled = true;
        }
      }
    }
    if (historyWorkerInstance === w) historyWorkerInstance = null;
    clearAllHistoryWorkerPending(w, code !== 0 ? `worker_exit_${code}` : null);
  });
  // Node.js v24 注册 message 监听会隐式 ref 底层 MessagePort，必须在全部监听绑定之后再 unref
  try { w.unref(); } catch { }
  historyWorkerInstance = w;
  return w;
}

let recordCallsAsyncQueue = Promise.resolve();

function invalidateHostLedgerAndHistoryCaches() {
  ledgerCacheByPath.clear();
  cachedTokenHistory = null;
  cachedTokenHistoryAt = 0;
}

/**
 * 异步入账模型调用记录（优先交由后台 Worker 线程执行大账本读写与合并，保持串行无竞态并零阻塞主进程事件循环）
 * @param {Array<object>} newCalls
 * @param {object|string} options
 */
async function recordModelCallsAsync(newCalls = [], options = {}) {
  if (!Array.isArray(newCalls) || !newCalls.length) return { ok: true, changed: false };
  const optsObj = typeof options === 'string' ? { agDir: options } : (options && typeof options === 'object' ? options : {});
  const task = recordCallsAsyncQueue.then(async () => {
    if (canUseHistoryWorker(optsObj)) {
      const workerResp = await runHistoryWorkerTask({
        newCalls,
        options: cloneCollectorOptionsForWorker(optsObj)
      }, 'recordModelCalls', optsObj);
      if (workerResp && workerResp._workerHandled) {
        const res = workerResp.result;
        if (res && res.changed) {
          invalidateHostLedgerAndHistoryCaches();
        }
        return res;
      }
    }
    const res = recordModelCalls(newCalls, optsObj);
    if (res && res.changed) {
      invalidateHostLedgerAndHistoryCaches();
    }
    return res;
  });
  recordCallsAsyncQueue = task.catch(() => { });
  return task;
}

async function runHistoryWorkerTask(payload, cmd = 'collectTokenHistory', taskOptions = {}) {
  try {
    if (historyWorkerIdleTimer) {
      clearTimeout(historyWorkerIdleTimer);
      historyWorkerIdleTimer = null;
    }
    const workerEntry = (taskOptions && taskOptions._historyWorkerScript) || __filename;
    const timeoutMs = Number.isFinite(Number(taskOptions?.workerTimeoutMs)) && Number(taskOptions.workerTimeoutMs) > 0
      ? Number(taskOptions.workerTimeoutMs)
      : DEFAULT_HISTORY_WORKER_TIMEOUT_MS;
    const w = getOrStartHistoryWorker(workerEntry);
    const id = historyWorkerReqId++;
    return await new Promise((resolve) => {
      const entry = { resolve, timer: null, worker: w };
      entry.timer = setTimeout(() => {
        if (!historyWorkerPending.has(id)) return;
        historyWorkerPending.delete(id);
        if (historyWorkerInstance === w) historyWorkerInstance = null;
        clearAllHistoryWorkerPending(w, `Worker 任务超时 (${timeoutMs}ms)`);
        try { w.terminate(); } catch { }
        resolve({ _workerHandled: false, error: `Worker 任务超时 (${timeoutMs}ms)`, timedOut: true });
      }, timeoutMs);
      if (typeof entry.timer.unref === 'function') entry.timer.unref();
      historyWorkerPending.set(id, entry);
      try {
        try { w.ref(); } catch { }
        w.postMessage({ id, cmd, payload, env: captureCollectorEnvSnapshot() });
      } catch {
        historyWorkerPending.delete(id);
        if (historyWorkerPending.size === 0) {
          try { w.unref(); } catch { }
        }
        if (entry.timer) clearTimeout(entry.timer);
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

let cachedNodeDatabaseSync;

function getNodeDatabaseSync() {
  if (cachedNodeDatabaseSync !== undefined) return cachedNodeDatabaseSync;
  try {
    cachedNodeDatabaseSync = require('node:sqlite').DatabaseSync || null;
  } catch {
    cachedNodeDatabaseSync = null;
  }
  return cachedNodeDatabaseSync;
}

function buildSqliteUriWithQuery(dbPath, query) {
  const normalized = String(dbPath || '').replace(/\\/g, '/');
  const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
  if (encoded.startsWith('//')) {
    return `file://${encoded}?${query}`;
  }
  return `file:///${encoded.replace(/^\/+/, '')}?${query}`;
}

/**
 * 构建 SQLite 只读 immutable URI（POSIX 路径）。
 * @param {string} dbPath
 * @returns {string}
 */
function buildSqliteImmutableUri(dbPath) {
  return buildSqliteUriWithQuery(dbPath, 'immutable=1');
}

function buildSqliteModeRoUri(dbPath) {
  return buildSqliteUriWithQuery(dbPath, 'mode=ro');
}

function readPbVarint(buf, offset, end = buf.length) {
  let value = 0;
  let multiplier = 1;
  let pos = offset;
  while (pos < end && pos - offset < 10) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return { value, next: pos };
    }
    multiplier *= 128;
  }
  return null;
}

function walkPbFields(buf, start, end, onField) {
  let pos = start;
  while (pos < end) {
    const tagInfo = readPbVarint(buf, pos, end);
    if (!tagInfo) break;
    pos = tagInfo.next;
    const fieldNum = Math.floor(tagInfo.value / 8);
    const wireType = tagInfo.value % 8;
    if (fieldNum <= 0) break;

    if (wireType === 0) {
      const valInfo = readPbVarint(buf, pos, end);
      if (!valInfo) break;
      pos = valInfo.next;
      onField(fieldNum, wireType, valInfo.value, 0, 0);
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      pos += 8;
      onField(fieldNum, wireType, 0, pos - 8, pos);
    } else if (wireType === 2) {
      const lenInfo = readPbVarint(buf, pos, end);
      if (!lenInfo || lenInfo.value < 0) break;
      const valStart = lenInfo.next;
      const valEnd = valStart + lenInfo.value;
      if (valEnd > end) break;
      pos = valEnd;
      onField(fieldNum, wireType, 0, valStart, valEnd);
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
      onField(fieldNum, wireType, 0, pos - 4, pos);
    } else {
      break;
    }
  }
}

function parsePbDurationSec(buf, start, end) {
  let seconds = 0;
  let nanos = 0;
  let hasField = false;
  walkPbFields(buf, start, end, (fn, wt, val) => {
    if (wt !== 0) return;
    if (fn === 1) { seconds = val; hasField = true; }
    else if (fn === 2) { nanos = val; hasField = true; }
  });
  if (!hasField) return null;
  const secVal = seconds + nanos / 1e9;
  return Number.isFinite(secVal) && secVal >= 0 ? Number(secVal.toFixed(2)) : null;
}

/**
 * 从 gen_metadata.data 的 Protobuf 负载提取完整的步骤元数据（兼容模型 ID、展示标签、耗时、responseId 与父子关联）。
 */
function extractStepMetaFromGenMetadataBlob(rawData) {
  if (!rawData || !rawData.length) return [];
  const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  const steps = [];
  let rawModel = '';
  let label = '';
  let modelEnum = '';
  let responseId = '';
  let ttftSec = null;
  let streamingSec = null;
  let parentCascadeId = '';
  let rootCascadeId = '';
  let subagentType = '';

  walkPbFields(buf, 0, buf.length, (fn, wt, val, vs, ve) => {
    if (fn === 2) {
      if (wt === 0 && Number.isInteger(val) && val >= 0) {
        steps.push(val);
      } else if (wt === 2) {
        let p = vs;
        while (p < ve) {
          const item = readPbVarint(buf, p, ve);
          if (!item) break;
          if (Number.isInteger(item.value) && item.value >= 0) {
            steps.push(item.value);
          }
          p = item.next;
        }
      }
    } else if (fn === 1 && wt === 2) {
      walkPbFields(buf, vs, ve, (cfn, cwt, _cval, cvs, cve) => {
        if (cwt !== 2) return;
        if (cfn === 4) {
          walkPbFields(buf, cvs, cve, (ufn, uwt, _uval, uvs, uve) => {
            if (ufn === 7 && uwt === 2) {
              const str = buf.toString('utf8', uvs, uve).trim();
              if (str) responseId = str;
            }
          });
        } else if (cfn === 11) {
          const d = parsePbDurationSec(buf, cvs, cve);
          if (d !== null) ttftSec = d;
        } else if (cfn === 12) {
          const d = parsePbDurationSec(buf, cvs, cve);
          if (d !== null) streamingSec = d;
        } else if (cfn === 19) {
          const str = buf.toString('utf8', cvs, cve).trim();
          if (str) rawModel = str;
        } else if (cfn === 20) {
          let k = '';
          let v = '';
          walkPbFields(buf, cvs, cve, (kfn, kwt, _kval, kvs, kve) => {
            if (kwt !== 2) return;
            if (kfn === 1) k = buf.toString('utf8', kvs, kve).trim();
            else if (kfn === 2) v = buf.toString('utf8', kvs, kve).trim();
          });
          if (k === 'model_enum' && v) modelEnum = v;
          else if (k === 'parent_cascade_id' && v) parentCascadeId = v;
          else if (k === 'root_cascade_id' && v) rootCascadeId = v;
          else if (k === 'subagent_type' && v) subagentType = v;
        } else if (cfn === 21) {
          const str = buf.toString('utf8', cvs, cve).trim();
          if (str) label = str;
        }
      });
    }
  });

  const resolvedModel = label || rawModel || modelEnum;
  const resolvedExactId = modelEnum || rawModel || '';
  if (!steps.length) return [];
  if (!resolvedModel && !resolvedExactId && !responseId && ttftSec === null && streamingSec === null && !parentCascadeId && !rootCascadeId) {
    return [];
  }
  return steps.map(stepIndex => ({
    stepIndex,
    model: resolvedModel,
    rawModel,
    modelLabel: label,
    modelExactId: resolvedExactId,
    responseId,
    ttftSec,
    streamingSec,
    parentCascadeId,
    rootCascadeId,
    subagentType
  }));
}

/**
 * 从会话数据库 gen_metadata.data 的 Protobuf 负载提取 stepIndex -> model/label 映射（保持兼容旧签名）。
 * 顶层字段 2 为 stepIndices（单个 varint 或 packed varint），字段 1 内的 19 为 rawModel、21 为展示标签。
 * @param {Buffer|Uint8Array} rawData
 * @returns {Array<{stepIndex: number, model: string}>}
 */
function extractStepModelsFromGenMetadataBlob(rawData) {
  return extractStepMetaFromGenMetadataBlob(rawData)
    .filter(item => Boolean(item.model))
    .map(item => ({ stepIndex: item.stepIndex, model: item.model }));
}

function extractTrajectoryBlobMeta(rawData, selfCascadeId = '') {
  const out = { parentCascadeId: '', rootCascadeId: '', subagentType: '', subagentRole: '' };
  if (!rawData || !rawData.length) return out;
  const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  const selfNorm = String(selfCascadeId || '').trim().toLowerCase();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  walkPbFields(buf, 0, buf.length, (fn, wt, _val, vs, ve) => {
    if (wt !== 2) return;
    if (fn === 4) {
      walkPbFields(buf, vs, ve, (cfn, cwt, _cval, cvs, cve) => {
        if (cwt !== 2) return;
        if (cfn === 1) {
          const s = buf.toString('utf8', cvs, cve).trim();
          if (s && s.length < 64) out.subagentType = s;
        } else if (cfn === 2) {
          const s = buf.toString('utf8', cvs, cve).trim();
          if (s && s.length < 120) out.subagentRole = s;
        }
      });
    } else if (fn === 5) {
      const s = buf.toString('utf8', vs, ve).trim();
      if (uuidRe.test(s) && s.toLowerCase() !== selfNorm) out.parentCascadeId = s;
    } else if (fn === 6) {
      const s = buf.toString('utf8', vs, ve).trim();
      if (uuidRe.test(s) && s.toLowerCase() !== selfNorm) out.rootCascadeId = s;
    }
  });
  return out;
}

const conversationDbMetaCache = new Map();
const MAX_CONVERSATION_DB_CACHE_ENTRIES = 500;

function getDbFileCacheSig(dbPath) {
  try {
    const stDb = origFsMethods.statSync(dbPath);
    if (!stDb.isFile()) return null;
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    let walSize = 0;
    let walMtimeMs = 0;
    let hasWal = false;
    let hasShm = false;
    try {
      if (origFsMethods.existsSync(walPath)) {
        const stWal = origFsMethods.statSync(walPath);
        hasWal = stWal.isFile();
        walSize = stWal.size || 0;
        walMtimeMs = stWal.mtimeMs || 0;
      }
    } catch { }
    try {
      hasShm = origFsMethods.existsSync(shmPath) && origFsMethods.statSync(shmPath).isFile();
    } catch { }
    return {
      sig: `${stDb.size}:${stDb.mtimeMs}:${hasWal ? 1 : 0}:${walSize}:${walMtimeMs}:${hasShm ? 1 : 0}`,
      hasWal,
      walSize,
      hasShm
    };
  } catch {
    return null;
  }
}

/**
 * 严格只读且兼顾 WAL 一致性地读取会话 .db（不修改 .db / -wal / -shm，不以 immutable 绕过活跃锁读取撕裂页）：
 * - 当不存在非空 -wal 时，使用 ?immutable=1（零写零锁，且兼容 WSL UNC）；
 * - 当存在非空 -wal 且存在 -shm 时，使用 ?mode=ro（遵守 SQLite 锁读取一致 WAL 快照，不创建新伴生文件）；
 * - 当存在非空 -wal 但缺少 -shm 或只读受锁阻断时，安全降级返回空（保留未知，等待后续 checkpoint 后再回填）。
 */
function loadConversationDbMeta(dbPath, selfCascadeId = '') {
  const emptyResult = {
    stepMetaMap: new Map(),
    stepToModel: new Map(),
    parentCascadeId: '',
    rootCascadeId: '',
    subagentType: '',
    subagentRole: '',
    readMode: 'skipped',
    skippedReason: null
  };
  if (!dbPath || !origFsMethods.existsSync(dbPath)) {
    return { ...emptyResult, skippedReason: 'missing' };
  }
  const DatabaseSync = getNodeDatabaseSync();
  if (!DatabaseSync) {
    return { ...emptyResult, skippedReason: 'sqlite_unavailable' };
  }
  const sigInfo = getDbFileCacheSig(dbPath);
  if (!sigInfo) {
    return { ...emptyResult, skippedReason: 'stat_failed' };
  }

  const cacheKey = String(dbPath);
  const cached = conversationDbMetaCache.get(cacheKey);
  if (cached && cached.sig === sigInfo.sig) {
    return cached.value;
  }

  let targetUri = null;
  let readMode = 'immutable';
  if (!sigInfo.hasWal || sigInfo.walSize === 0) {
    targetUri = buildSqliteImmutableUri(dbPath);
    readMode = 'immutable';
  } else if (sigInfo.hasShm) {
    targetUri = buildSqliteModeRoUri(dbPath);
    readMode = 'mode_ro_wal';
  } else {
    return { ...emptyResult, readMode: 'skipped', skippedReason: 'wal_without_shm' };
  }

  const stepMetaMap = new Map();
  const stepToModel = new Map();
  let parentCascadeId = '';
  let rootCascadeId = '';
  let subagentType = '';
  let subagentRole = '';

  let db = null;
  try {
    db = new DatabaseSync(targetUri, { readOnly: true });
    try {
      const rows = db.prepare('SELECT data FROM gen_metadata').all();
      for (const row of rows) {
        const entries = extractStepMetaFromGenMetadataBlob(row?.data);
        for (const item of entries) {
          if (!item || !Number.isInteger(item.stepIndex)) continue;
          stepMetaMap.set(item.stepIndex, item);
          if (item.model) stepToModel.set(item.stepIndex, item.model);
          if (!parentCascadeId && item.parentCascadeId) parentCascadeId = item.parentCascadeId;
          if (!rootCascadeId && item.rootCascadeId) rootCascadeId = item.rootCascadeId;
          if (!subagentType && item.subagentType) subagentType = item.subagentType;
        }
      }
    } catch {
      // 忽略缺失 gen_metadata 表或非预期 schema
    }
    try {
      const tmbRows = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 2').all();
      for (const row of tmbRows) {
        const tm = extractTrajectoryBlobMeta(row?.data, selfCascadeId);
        if (!parentCascadeId && tm.parentCascadeId) parentCascadeId = tm.parentCascadeId;
        if (!rootCascadeId && tm.rootCascadeId) rootCascadeId = tm.rootCascadeId;
        if (!subagentType && tm.subagentType) subagentType = tm.subagentType;
        if (!subagentRole && tm.subagentRole) subagentRole = tm.subagentRole;
      }
    } catch {
      // 旧库可能没有 trajectory_metadata_blob
    }
  } catch (err) {
    return {
      ...emptyResult,
      readMode: 'skipped',
      skippedReason: err?.code || err?.message || 'sqlite_open_error'
    };
  } finally {
    if (db) {
      try { db.close(); } catch { }
    }
  }

  const out = {
    stepMetaMap,
    stepToModel,
    parentCascadeId,
    rootCascadeId,
    subagentType,
    subagentRole,
    readMode,
    skippedReason: null
  };
  if (conversationDbMetaCache.size >= MAX_CONVERSATION_DB_CACHE_ENTRIES) {
    const oldest = conversationDbMetaCache.keys().next().value;
    if (oldest) conversationDbMetaCache.delete(oldest);
  }
  conversationDbMetaCache.set(cacheKey, { sig: sigInfo.sig, value: out });
  return out;
}

function loadStepModelMapFromSqlite(dbPath) {
  return loadConversationDbMeta(dbPath).stepToModel;
}

function backfillMissingModelsFromConversationDb(records, convDir, options = {}) {
  if (!Array.isArray(records) || !records.length || !convDir || options.fs || isFsMonkeyPatched()) return 0;

  const targetByCascade = new Map();
  for (const rec of records) {
    if (!rec || !(rec.tot > 0)) continue;
    const needsModel = !rec.model;
    const needsMeta = !rec.modelExactId || rec.ttftSec == null || rec.streamingSec == null;
    if (!needsModel && !needsMeta) continue;
    if (!Number.isInteger(rec.stepIndex) || rec.stepIndex < 0) continue;
    const cid = String(rec.cascadeId || '').trim();
    if (!cid || cid.includes('..') || cid.includes('/') || cid.includes('\\')) continue;
    let list = targetByCascade.get(cid);
    if (!list) {
      list = [];
      targetByCascade.set(cid, list);
    }
    list.push(rec);
  }
  if (targetByCascade.size === 0) return 0;

  let filledCount = 0;
  for (const [cid, recs] of targetByCascade.entries()) {
    const dbPath = path.join(convDir, `${cid}.db`);
    const dbMeta = loadConversationDbMeta(dbPath, cid);
    if (dbMeta.stepMetaMap.size === 0) continue;
    for (const rec of recs) {
      const recovered = dbMeta.stepMetaMap.get(rec.stepIndex);
      if (!recovered) continue;
      if (!rec.model && recovered.model) {
        rec.model = recovered.model;
        filledCount++;
      }
      if (!rec.modelExactId && recovered.modelExactId) {
        rec.modelExactId = recovered.modelExactId;
      }
      if (!rec.modelLabel && recovered.modelLabel) {
        rec.modelLabel = recovered.modelLabel;
      }
      if (rec.ttftSec == null && recovered.ttftSec != null) {
        rec.ttftSec = recovered.ttftSec;
      }
      if (rec.streamingSec == null && recovered.streamingSec != null) {
        rec.streamingSec = recovered.streamingSec;
      }
      if (!rec.responseId && recovered.responseId) {
        rec.responseId = recovered.responseId;
      }
      if (!rec.parentCascadeId && (recovered.parentCascadeId || dbMeta.parentCascadeId)) {
        rec.parentCascadeId = recovered.parentCascadeId || dbMeta.parentCascadeId;
      }
      if (!rec.rootCascadeId && (recovered.rootCascadeId || dbMeta.rootCascadeId)) {
        rec.rootCascadeId = recovered.rootCascadeId || dbMeta.rootCascadeId;
      }
      if (!rec.subagentType && (recovered.subagentType || dbMeta.subagentType)) {
        rec.subagentType = recovered.subagentType || dbMeta.subagentType;
      }
    }
  }
  return filledCount;
}

function mergeModelDailyMaps(...maps) {
  const out = {};
  for (const m of maps) {
    if (!m || typeof m !== 'object') continue;
    for (const [dateKey, modelRecs] of Object.entries(m)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !modelRecs || typeof modelRecs !== 'object') continue;
      if (!out[dateKey]) out[dateKey] = {};
      for (const [mKey, rec] of Object.entries(modelRecs)) {
        if (!rec || typeof rec !== 'object') continue;
        if (!out[dateKey][mKey]) {
          out[dateKey][mKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        out[dateKey][mKey].total += Number(rec.total) || 0;
        out[dateKey][mKey].input += Number(rec.input) || 0;
        out[dateKey][mKey].output += Number(rec.output) || 0;
        out[dateKey][mKey].cache += Number(rec.cache) || 0;
        out[dateKey][mKey].steps += Number(rec.steps) || 0;
      }
    }
  }
  return out;
}

/**
 * 基于账本（含 RPC 富化模型）与未匹配 transcript 实时记录构建分来源按日按模型用量分布，
 * 并严格对齐 dailyMap 权威总额（未能归属模型的差额落入 UNATTRIBUTED_MODEL_KEY）。
 */
function buildDailyModelBreakdown(params) {
  const {
    recentRequests,
    finalCallsEntries,
    matchedTranscriptReqs,
    matchedLedgerKeys,
    resolveLedgerCallDate,
    mergedDesktop,
    mergedCli,
    mergedLegacyUnallocated,
    archiveV2,
    compactModelConfigs
  } = params;

  const modelMetaByKey = { ...(archiveV2?.modelMetaByKey || {}) };
  const matchedModels = { desktop: {}, cli: {} };
  const extraModels = { desktop: {}, cli: {} };
  const bucketMemo = new Map();

  const addModelBucket = (srcMap, dateKey, callObj, inp, cap, outp, tot, steps = 1) => {
    if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
    if (tot <= 0 && steps <= 0) return;
    const memoKey = `${callObj.model || ''}\0${callObj.modelExactId || ''}\0${callObj.modelLabel || ''}\0${callObj.effort || ''}`;
    let bucket = bucketMemo.get(memoKey);
    if (!bucket) {
      bucket = resolveModelUsageBucket(callObj, compactModelConfigs);
      if (bucketMemo.size < 2000) bucketMemo.set(memoKey, bucket);
    }
    const vKey = bucket.variantKey || UNATTRIBUTED_MODEL_KEY;
    if (bucket.isAttributed && vKey !== UNATTRIBUTED_MODEL_KEY) {
      modelMetaByKey[vKey] = {
        modelKey: bucket.modelKey,
        modelLabel: bucket.modelLabel,
        variantKey: vKey,
        variantLabel: bucket.variantLabel
      };
    }
    if (!srcMap[dateKey]) srcMap[dateKey] = {};
    if (!srcMap[dateKey][vKey]) {
      srcMap[dateKey][vKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    }
    srcMap[dateKey][vKey].total += tot;
    srcMap[dateKey][vKey].input += inp;
    srcMap[dateKey][vKey].output += outp;
    srcMap[dateKey][vKey].cache += cap;
    srcMap[dateKey][vKey].steps += steps;
  };

  for (const [ledgerKey, c] of finalCallsEntries) {
    if (!c) continue;
    const effDate = resolveLedgerCallDate(ledgerKey, c);
    if (!effDate || !/^\d{4}-\d{2}-\d{2}$/.test(effDate)) continue;
    const srcKey = c.source === 'cli' ? 'cli' : 'desktop';
    const inp = Number(c.inputTokens ?? c.input_tokens ?? c.input ?? 0) || 0;
    const cap = Number(c.cacheTokens ?? c.cacheReadTokens ?? c.cache_read_tokens ?? c.cached ?? 0) || 0;
    const outp = Number(c.outputTokens ?? c.output_tokens ?? c.output ?? 0) || 0;
    const tot = Number(c.totalTokens) || (inp + cap + outp);
    addModelBucket(matchedLedgerKeys.has(ledgerKey) ? matchedModels[srcKey] : extraModels[srcKey], effDate, c, inp, cap, outp, tot, 1);
  }

  for (const r of recentRequests) {
    if (matchedTranscriptReqs && matchedTranscriptReqs.has(r)) continue;
    const srcKey = r.source === 'cli' ? 'cli' : 'desktop';
    const inp = Number(r.inputTokens) || 0;
    const cap = Number(r.cacheTokens ?? r.cacheReadTokens ?? 0) || 0;
    const outp = Number(r.outputTokens) || 0;
    const tot = Number(r.totalTokens) || (inp + cap + outp);
    addModelBucket(matchedModels[srcKey], r.date, r, inp, cap, outp, tot, 1);
  }

  const appendScaledDayBuckets = (dayOut, srcDay, authTotal, state) => {
    if (!srcDay) return;
    for (const [mKey, rec] of Object.entries(srcDay)) {
      if (state.sumTot >= authTotal) break;
      const takeTot = Math.min(rec.total, authTotal - state.sumTot);
      const ratio = rec.total > 0 ? takeTot / rec.total : 0;
      if (!dayOut[mKey]) dayOut[mKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
      const addInp = takeTot === rec.total ? rec.input : Math.round(rec.input * ratio);
      const addOut = takeTot === rec.total ? rec.output : Math.round(rec.output * ratio);
      const addCap = takeTot === rec.total ? rec.cache : Math.max(0, takeTot - addInp - addOut);
      dayOut[mKey].total += takeTot;
      dayOut[mKey].input += addInp;
      dayOut[mKey].output += addOut;
      dayOut[mKey].cache += addCap;
      dayOut[mKey].steps += rec.steps;
      state.sumTot += takeTot;
      state.sumInp += addInp;
      state.sumOut += addOut;
      state.sumCap += addCap;
      state.sumSteps += rec.steps;
    }
  };

  const reconcileSourceMap = (srcKey, authDailyMap) => {
    const archivedModels = archiveV2?.dailyModelMapBySource?.[srcKey] || {};
    const outMap = {};
    const allDates = new Set([
      ...Object.keys(authDailyMap || {}),
      ...Object.keys(matchedModels[srcKey]),
      ...Object.keys(extraModels[srcKey])
    ]);
    for (const dateKey of allDates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
      const authRec = authDailyMap?.[dateKey];
      if (!authRec || Number(authRec.total) <= 0) continue;

      const dayOut = {};
      const scanDay = matchedModels[srcKey][dateKey];
      const extraDay = extraModels[srcKey][dateKey];
      const state = { sumTot: 0, sumInp: 0, sumOut: 0, sumCap: 0, sumSteps: 0 };

      if (scanDay || extraDay) {
        appendScaledDayBuckets(dayOut, scanDay, authRec.total, state);
        appendScaledDayBuckets(dayOut, extraDay, authRec.total, state);
      } else if (archivedModels[dateKey]) {
        for (const [mKey, rec] of Object.entries(archivedModels[dateKey])) {
          dayOut[mKey] = { ...rec };
          state.sumTot += rec.total;
          state.sumInp += rec.input;
          state.sumOut += rec.output;
          state.sumCap += rec.cache;
          state.sumSteps += rec.steps;
        }
      }

      const diffTot = Math.max(0, (Number(authRec.total) || 0) - state.sumTot);
      if (diffTot > 0) {
        if (!dayOut[UNATTRIBUTED_MODEL_KEY]) {
          dayOut[UNATTRIBUTED_MODEL_KEY] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        dayOut[UNATTRIBUTED_MODEL_KEY].total += diffTot;
        dayOut[UNATTRIBUTED_MODEL_KEY].input += Math.max(0, (Number(authRec.input) || 0) - state.sumInp);
        dayOut[UNATTRIBUTED_MODEL_KEY].output += Math.max(0, (Number(authRec.output) || 0) - state.sumOut);
        dayOut[UNATTRIBUTED_MODEL_KEY].cache += Math.max(0, (Number(authRec.cache) || 0) - state.sumCap);
        dayOut[UNATTRIBUTED_MODEL_KEY].steps += Math.max(0, (Number(authRec.steps) || 0) - state.sumSteps);
      }

      if (Object.keys(dayOut).length > 0) outMap[dateKey] = dayOut;
    }
    return outMap;
  };

  const desktopModelMap = reconcileSourceMap('desktop', mergedDesktop);
  const cliModelMap = reconcileSourceMap('cli', mergedCli);
  const unallocatedModelMap = {};
  for (const [dateKey, rec] of Object.entries(mergedLegacyUnallocated || {})) {
    if (!rec || Number(rec.total) <= 0) continue;
    unallocatedModelMap[dateKey] = { [UNATTRIBUTED_MODEL_KEY]: { ...rec } };
  }
  const allModelMap = mergeModelDailyMaps(desktopModelMap, cliModelMap, unallocatedModelMap);

  return {
    dailyModelMapBySource: {
      all: allModelMap,
      desktop: desktopModelMap,
      cli: cliModelMap
    },
    modelMetaByKey
  };
}

/**
 * 历史用量与账本聚合核心逻辑（支持在 Worker 线程或主线程直接运行）
 * @param {object} options
 * @param {object} extraContext
 */
async function collectTokenHistoryCoreAsync(options = {}, extraContext = {}) {
  const { home, agDir, agCliDir } = resolvePrimaryGeminiDirs(options);

  const archivePathV1 = path.join(agDir, 'token_usage_archive_v1.json');
  const archivePathV2 = path.join(agDir, 'token_usage_archive_v2.json');

  // 1. 读取旧 v1 归档（并在首次迁移时自动生成 .bak 备份）
  const bakPathV1 = path.join(agDir, 'token_usage_archive_v1.bak.json');
  const readV1 = safeReadJsonSync(archivePathV1, null, { backupPath: bakPathV1 });
  let legacyV1Archive = { firstUseDate: null, dailyMap: {}, maxConversations: 0 };
  if (readV1.exists) {
    if (readV1.ok && readV1.data && typeof readV1.data === 'object') {
      legacyV1Archive = readV1.data;
      if (!fs.existsSync(bakPathV1)) {
        try { fs.copyFileSync(archivePathV1, bakPathV1); } catch { }
      }
    }
  }

  // 2. 读取已有的 v2 归档
  const bakPathV2 = path.join(agDir, 'token_usage_archive_v2.bak.json');
  const readV2 = safeReadJsonSync(archivePathV2, null, { backupPath: bakPathV2 });
  let archiveV2 = {
    version: '2.0.0',
    firstUseDate: legacyV1Archive.firstUseDate || null,
    planStatus: null,
    dailyMapBySource: {
      desktop: {},
      cli: {},
      legacyUnallocated: legacyV1Archive.dailyMap || {}
    }
  };
  if (readV2.exists) {
    if (readV2.ok && readV2.data && typeof readV2.data === 'object') {
      archiveV2 = { ...archiveV2, ...readV2.data };
      if (!fs.existsSync(bakPathV2)) {
        try { fs.copyFileSync(archivePathV2, bakPathV2); } catch { }
      }
    }
  }

  let earliestDate = archiveV2.firstUseDate || legacyV1Archive.firstUseDate || null;
  const registerDate = (dateStr) => {
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      if (!earliestDate || dateStr < earliestDate) earliestDate = dateStr;
    }
  };

  // 3. 扫描桌面端与 CLI 会话文件（忽略伴生文件并仅对标准 UUID 跨根去重）
  const desktopAgDirs = dedupeScanPaths([
    agDir,
    ...(Array.isArray(options.extraAgDirs) ? options.extraAgDirs : [])
  ]);
  const cliAgDirs = dedupeScanPaths([
    agCliDir,
    ...(Array.isArray(options.extraAgCliDirs) ? options.extraAgCliDirs : [])
  ]);

  let desktopPbCount = 0;
  let cliPbCount = 0;
  const seenDesktopConvs = new Set();
  const seenCliConvs = new Set();
  const nonUuidConvDirsBySource = {
    desktop: new Map(),
    cli: new Map()
  };
  const UUID_SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:db|pb)$/i;
  const scanSessionDir = (dir, sourceName, seenSet = null) => {
    let count = 0;
    try {
      if (!fs.existsSync(dir)) return 0;
      const normDirKey = path.resolve(dir);
      for (const name of fs.readdirSync(dir)) {
        if (isCompanionOrTempFile(name)) continue;
        if (!name.endsWith('.pb') && !name.endsWith('.db')) continue;
        const p = path.join(dir, name);
        const isUuid = UUID_SESSION_FILE_RE.test(name);
        let dedupeKey;
        if (isUuid) {
          dedupeKey = name;
        } else {
          // 非 UUID 会话不仅靠文件名合并，仅在真实路径相同时视作同一个文件，或后续通过共享 responseId 事件确认镜像
          let realFile = p;
          try { realFile = fs.realpathSync(p); } catch { }
          dedupeKey = realFile;
        }
        if (seenSet && seenSet.has(dedupeKey)) continue;
        try {
          const st = fs.statSync(p);
          if (st.isFile()) {
            if (seenSet) seenSet.add(dedupeKey);
            count++;
            if (!isUuid) {
              const baseLower = name.replace(/\.(?:db|pb)$/i, '').toLowerCase();
              const dirMap = nonUuidConvDirsBySource[sourceName];
              if (dirMap) {
                if (!dirMap.has(baseLower)) dirMap.set(baseLower, new Set());
                dirMap.get(baseLower).add(normDirKey);
              }
            }
            const ts = st.birthtimeMs && st.birthtimeMs > 946684800000 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
            if (ts > 946684800000) registerDate(formatLocalDateKey(new Date(ts)));
          }
        } catch { }
      }
    } catch { }
    return count;
  };

  for (const dDir of desktopAgDirs) {
    desktopPbCount += scanSessionDir(path.join(dDir, 'conversations'), 'desktop', seenDesktopConvs);
  }
  for (const cDir of cliAgDirs) {
    cliPbCount += scanSessionDir(path.join(cDir, 'conversations'), 'cli', seenCliConvs);
  }

  // 4. 多目录遍历扫描 transcript.jsonl（跳过 steps/scratch 重型目录，软链接与环路去重）
  const visitedRealDirs = new Set();
  const transcriptJobs = [];

  const walkTranscripts = (dir, sourceName, depth = 0, convDirPath = '') => {
    if (depth > 4) return;
    try {
      if (!fs.existsSync(dir)) return;
      const normDir = path.resolve(dir);
      const normKey = normDir;
      if (visitedRealDirs.has(normKey)) return;
      visitedRealDirs.add(normKey);

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            const realTarget = fs.realpathSync(fullPath);
            const realKey = realTarget;
            const st = fs.statSync(realTarget);
            if (st.isDirectory()) {
              if (!visitedRealDirs.has(realKey)) {
                walkTranscripts(realTarget, sourceName, depth + 1, convDirPath);
              }
            } else if (entry.name === 'transcript.jsonl') {
              transcriptJobs.push({ path: realTarget, source: sourceName, convDir: convDirPath });
            }
          } catch { }
        } else if (entry.isDirectory()) {
          if (depth === 0) {
            const stdLogPath = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
            const directLogPath = path.join(fullPath, 'transcript.jsonl');
            let matchedFast = false;
            if (fs.existsSync(stdLogPath)) {
              transcriptJobs.push({ path: stdLogPath, source: sourceName, convDir: convDirPath });
              matchedFast = true;
            }
            if (fs.existsSync(directLogPath)) {
              transcriptJobs.push({ path: directLogPath, source: sourceName, convDir: convDirPath });
              matchedFast = true;
            }
            if (matchedFast) continue;
          }
          walkTranscripts(fullPath, sourceName, depth + 1, convDirPath);
        } else if (entry.name === 'transcript.jsonl') {
          transcriptJobs.push({ path: fullPath, source: sourceName, convDir: convDirPath });
        }
      }
    } catch { }
  };

  for (const dDir of desktopAgDirs) {
    const bDir = path.join(dDir, 'brain');
    if (fs.existsSync(bDir)) walkTranscripts(bDir, 'desktop', 0, path.join(dDir, 'conversations'));
  }
  for (const cDir of cliAgDirs) {
    const cbDir = path.join(cDir, 'brain');
    if (fs.existsSync(cbDir)) walkTranscripts(cbDir, 'cli', 0, path.join(cDir, 'conversations'));
  }

  // 5. 结构化 JSON 解析 transcript.jsonl（基于 size+mtimeMs 单文件增量缓存，去重并汇总）
  const scannedBySource = {
    desktop: {},
    cli: {}
  };
  const seenEvents = new Map();
  const recentRequests = [];

  for (let jIdx = 0; jIdx < transcriptJobs.length; jIdx++) {
    const job = transcriptJobs[jIdx];
    if (jIdx > 0 && jIdx % 15 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    try {
      const st = fs.statSync(job.path);
      const cachedFile = transcriptFileCache.get(job.path);
      let fileRecords = null;

      if (cachedFile && cachedFile.size === st.size && cachedFile.mtimeMs === st.mtimeMs) {
        fileRecords = cachedFile.records;
      } else {
        fileRecords = [];
        const brainMatch = String(job.path).match(/[\\/]brain[\\/]([^\\/]+)[\\/]/i);
        const content = fs.readFileSync(job.path, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || !line.trim()) continue;
          let event = null;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          let hasValidCreatedAt = false;
          if (event.created_at) {
            const d = new Date(event.created_at);
            if (!Number.isNaN(d.getTime())) {
              hasValidCreatedAt = true;
            }
          }
          if (!hasValidCreatedAt) continue;

          let inp = 0, outp = 0, cap = 0, thinking = 0;
          const model = event.chatModel?.model || event.chatModel?.responseModel || event.model || event.modelId || '';
          const modelExactId = event.chatModel?.modelId || event.modelId || '';
          const modelLabel = event.chatModel?.modelDisplayName || '';

          if (event.input_tokens != null || event.output_tokens != null || event.cache_read_tokens != null) {
            inp = Math.max(0, Number(event.input_tokens) || 0);
            outp = Math.max(0, Number(event.output_tokens) || 0);
            cap = Math.max(0, Number(event.cache_read_tokens) || 0);
            thinking = Math.max(0, Number(event.thinking_output_tokens) || 0);
          } else if (event.chatModel?.usage) {
            const u = event.chatModel.usage;
            inp = Math.max(0, Number(u.inputTokens) || 0);
            outp = Math.max(0, Number(u.outputTokens) || 0);
            cap = Math.max(0, Number(u.cacheReadTokens) || 0);
            thinking = Math.max(0, Number(u.thinkingOutputTokens) || 0);
          }

          const tot = inp + outp + cap;
          if (tot > 0) {
            // 唯一事件标识去重 (避免复制/软链接/重复日志相加)
            const cascadeId = String(event.cascadeId || (brainMatch ? brainMatch[1] : path.basename(job.path, '.jsonl')));
            const rawStep = event.step_index ?? event.stepIndex;
            const parsedStep = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN;
            const stepIndex = Number.isInteger(parsedStep) && parsedStep >= 0 ? parsedStep : null;
            const fallbackScope = (event.cascadeId || brainMatch) ? cascadeId : job.path;
            const eventId = extractCallId(event, fallbackScope, stepIndex ?? i);

            fileRecords.push({
              eventId,
              cascadeId,
              stepIndex,
              model,
              ...(modelExactId ? { modelExactId } : {}),
              ...(modelLabel ? { modelLabel } : {}),
              inp,
              outp,
              cap,
              thinking,
              tot,
              created_at: event.created_at
            });
          } else {
            fileRecords.push({
              tot: 0,
              created_at: event.created_at
            });
          }
        }
        backfillMissingModelsFromConversationDb(fileRecords, job.convDir, options);
        if (transcriptFileCache.size > 1000) {
          const oldestKey = transcriptFileCache.keys().next().value;
          if (oldestKey) transcriptFileCache.delete(oldestKey);
        }
        transcriptFileCache.set(job.path, { size: st.size, mtimeMs: st.mtimeMs, records: fileRecords });
      }

      const jobConvNorm = job.convDir ? path.resolve(job.convDir) : '';
      for (let rIdx = 0; rIdx < fileRecords.length; rIdx++) {
        const rec = fileRecords[rIdx];
        const parsedDate = new Date(rec.created_at);
        if (Number.isNaN(parsedDate.getTime())) continue;
        const dateKey = formatLocalDateKey(parsedDate);
        registerDate(dateKey);
        if (!rec.tot || !rec.eventId) continue;

        const existingReq = seenEvents.get(rec.eventId);
        if (existingReq) {
          // 跨根重复事件绝不重复累加 Token；仅当新根回填/保留了更优模型标识时就地富化原记录
          if (getCollectorModelRank(rec.model) > getCollectorModelRank(existingReq.model)) {
            existingReq.model = rec.model;
            existingReq.modelKey = normalizeModelId(rec.model);
            const enrichedCost = calculateRequestApiCost(existingReq);
            existingReq.isPriced = enrichedCost.isPriced;
            existingReq.costUSD = enrichedCost.costUSD ?? 0;
          }
          if (!existingReq.modelExactId && rec.modelExactId) existingReq.modelExactId = rec.modelExactId;
          if (!existingReq.modelLabel && rec.modelLabel) existingReq.modelLabel = rec.modelLabel;
          // 若两个不同 convDir 下的非 UUID 同名会话共享同一真实 responseId（非 step 拼接键），证明是同一镜像会话
          if (
            !String(rec.eventId).includes('#') &&
            existingReq.source === job.source &&
            existingReq._convDirNorm &&
            jobConvNorm &&
            existingReq._convDirNorm !== jobConvNorm &&
            existingReq.cascadeId &&
            existingReq.cascadeId === rec.cascadeId &&
            !UUID_SESSION_FILE_RE.test(`${rec.cascadeId}.db`)
          ) {
            const baseLower = String(rec.cascadeId).toLowerCase();
            const mirrorKey = `${job.source}|${jobConvNorm}|${baseLower}`;
            const convDirSet = nonUuidConvDirsBySource[job.source]?.get(baseLower);
            if (convDirSet && convDirSet.has(existingReq._convDirNorm) && convDirSet.has(jobConvNorm) && !seenEvents.has(`__mirror_dedup:${mirrorKey}`)) {
              seenEvents.set(`__mirror_dedup:${mirrorKey}`, true);
              if (job.source === 'cli' && cliPbCount > 1) cliPbCount--;
              else if (job.source === 'desktop' && desktopPbCount > 1) desktopPbCount--;
            }
          }
          continue;
        }

        const srcMap = scannedBySource[job.source] || scannedBySource.desktop;
        if (!srcMap[dateKey]) {
          srcMap[dateKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        srcMap[dateKey].total += rec.tot;
        srcMap[dateKey].input += rec.inp;
        srcMap[dateKey].output += rec.outp;
        srcMap[dateKey].cache += rec.cap;
        srcMap[dateKey].steps += 1;

        const modelKey = normalizeModelId(rec.model);
        const reqObj = {
          callId: rec.eventId,
          source: job.source,
          _convDirNorm: jobConvNorm,
          cascadeId: rec.cascadeId,
          stepIndex: rec.stepIndex,
          model: rec.model,
          ...(rec.modelExactId ? { modelExactId: rec.modelExactId } : {}),
          ...(rec.modelLabel ? { modelLabel: rec.modelLabel } : {}),
          modelKey,
          inputTokens: rec.inp,
          cacheTokens: rec.cap,
          cacheReadTokens: rec.cap,
          outputTokens: rec.outp,
          thinkingTokens: rec.thinking,
          totalTokens: rec.tot,
          status: 'final',
          isEstimated: false,
          date: dateKey,
          dateSource: 'transcript',
          dateIsProvisional: false,
          created_at: rec.created_at || null,
          timestamp: parsedDate.getTime()
        };
        const costCalc = calculateRequestApiCost(reqObj);
        reqObj.isPriced = costCalc.isPriced;
        reqObj.costUSD = costCalc.costUSD ?? 0;

        seenEvents.set(rec.eventId, reqObj);
        recentRequests.push(reqObj);
      }
    } catch { }
  }

  // 6. 与旧归档做差异合并，防止简单相加或 Math.max 抹杀 CLI 增量
  // 规则：若 (desktop + cli) < legacyV1，则把差额保留为 legacyUnallocated；否则认为已被新日志完全覆盖
  const legacyDaily = legacyV1Archive.dailyMap || {};
  const mergedDesktop = { ...(archiveV2.dailyMapBySource?.desktop || {}), ...scannedBySource.desktop };
  const mergedCli = { ...(archiveV2.dailyMapBySource?.cli || {}), ...scannedBySource.cli };
  const mergedLegacyUnallocated = {};

  const allDateKeys = new Set([
    ...Object.keys(legacyDaily),
    ...Object.keys(mergedDesktop),
    ...Object.keys(mergedCli)
  ]);

  const dailyMapAll = {};
  for (const k of Array.from(allDateKeys).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    registerDate(k);
    const dRec = mergedDesktop[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    const cRec = mergedCli[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    const lRec = legacyDaily[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };

    const scannedSum = (dRec.total || 0) + (cRec.total || 0);
    let unallocatedDiff = Math.max(0, (lRec.total || 0) - scannedSum);

    if (unallocatedDiff > 0) {
      mergedLegacyUnallocated[k] = {
        total: unallocatedDiff,
        input: Math.max(0, (lRec.input || 0) - (dRec.input || 0) - (cRec.input || 0)),
        output: Math.max(0, (lRec.output || 0) - (dRec.output || 0) - (cRec.output || 0)),
        cache: Math.max(0, (lRec.cache || 0) - (dRec.cache || 0) - (cRec.cache || 0)),
        steps: Math.max(0, (lRec.steps || 0) - (dRec.steps || 0) - (cRec.steps || 0))
      };
    }

    const unRec = mergedLegacyUnallocated[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    dailyMapAll[k] = {
      total: (dRec.total || 0) + (cRec.total || 0) + (unRec.total || 0),
      input: (dRec.input || 0) + (cRec.input || 0) + (unRec.input || 0),
      output: (dRec.output || 0) + (cRec.output || 0) + (unRec.output || 0),
      cache: (dRec.cache || 0) + (cRec.cache || 0) + (unRec.cache || 0),
      steps: (dRec.steps || 0) + (cRec.steps || 0) + (unRec.steps || 0)
    };
  }

  // 7. 计算各项聚合统计指标
  const now = new Date();
  const todayKey = formatLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);
  if (!earliestDate) earliestDate = todayKey;

  let grandTotalTokens = 0, totalInputTokens = 0, totalOutputTokens = 0, totalCacheTokens = 0, totalSteps = 0;
  let todayTokens = 0, monthTokens = 0, yearTokens = 0;

  for (const [k, v] of Object.entries(dailyMapAll)) {
    if (!v) continue;
    grandTotalTokens += v.total || 0;
    totalInputTokens += v.input || 0;
    totalOutputTokens += v.output || 0;
    totalCacheTokens += v.cache || 0;
    totalSteps += v.steps || 0;
    if (k === todayKey) todayTokens += v.total || 0;
    if (k.startsWith(monthPrefix)) monthTokens += v.total || 0;
    if (k.startsWith(yearPrefix)) yearTokens += v.total || 0;
  }

  // 计算本期（本月自然月）分类汇总与步骤数
  let currentMonthInput = 0, currentMonthOutput = 0, currentMonthCache = 0, currentMonthSteps = 0;
  for (const [k, v] of Object.entries(dailyMapAll)) {
    if (k.startsWith(monthPrefix) && v) {
      currentMonthInput += v.input || 0;
      currentMonthOutput += v.output || 0;
      currentMonthCache += v.cache || 0;
      currentMonthSteps += v.steps || 0;
    }
  }

  const totalConversations = Math.max(
    legacyV1Archive.maxConversations || 0,
    transcriptJobs.length,
    desktopPbCount + cliPbCount
  );

  // 8. 自动识别套餐与用户自定义设置合并（实际读取优先于自定义优先于未知）
  let livePlanStatus = Object.prototype.hasOwnProperty.call(extraContext, 'livePlanStatus')
    ? extraContext.livePlanStatus
    : await fetchUserStatusFromHost(options);
  if (!livePlanStatus) {
    livePlanStatus = archiveV2.planStatus || parseUserPlanStatus(null);
  }

  const customSettingsAll = loadCustomPlanSettings(agDir);
  const currentAccountKey = livePlanStatus?.email || archiveV2.planStatus?.email || null;
  const currentCustom = resolveAccountCustomPlan(customSettingsAll, currentAccountKey);

  const effectivePlanStatus = resolveEffectivePlanStatus(livePlanStatus, currentCustom, {
    cachedLivePlan: archiveV2.planStatus,
    currentEmail: currentAccountKey
  });

  // 结合持久化逐请求账本与本次扫描调用：先与既有账本做双阶段 1-to-1 对齐与富化，再仅将未匹配的已计价扫描请求落盘
  const initialCallsMap = loadPricingLedger(agDir).calls || {};
  const matchedTranscriptReqs = new Set();
  const matchedLedgerKeys = new Set();
  const callEffectiveDate = new Map();
  const reqsByCallId = new Map();
  const reqsByStepKey = new Map();

  for (const r of recentRequests) {
    if (r.callId) {
      const rId = String(r.callId);
      let list = reqsByCallId.get(rId);
      if (!list) { list = []; reqsByCallId.set(rId, list); }
      list.push(r);
    }
    if (r.cascadeId && r.stepIndex !== null && r.stepIndex !== undefined) {
      const sKey = `${r.source || 'desktop'}:${String(r.cascadeId).toLowerCase()}#${r.stepIndex}`;
      let list = reqsByStepKey.get(sKey);
      if (!list) { list = []; reqsByStepKey.set(sKey, list); }
      list.push(r);
    }
  }

  // 统计每个 (source, cascadeId, stepIndex) 上的非合成账本调用数量，避免同步骤多条独立 responseId 错绑其它调用的用量
  const realLedgerCountByStepKey = new Map();
  for (const [ledgerKey, c] of Object.entries(initialCallsMap)) {
    if (!c || !c.cascadeId) continue;
    const cidKey = String(c.callId || ledgerKey);
    if (isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId)) continue;
    const cSrc = c.source || 'desktop';
    const cCid = String(c.cascadeId).toLowerCase();
    for (const stIdx of extractCallStepNumbers(c, ledgerKey)) {
      const sKey = `${cSrc}:${cCid}#${stIdx}`;
      realLedgerCountByStepKey.set(sKey, (realLedgerCountByStepKey.get(sKey) || 0) + 1);
    }
  }

  const takeUnmatchedReq = (list, predicate = null) => {
    if (!list) return null;
    for (const item of list) {
      if (matchedTranscriptReqs.has(item)) continue;
      if (predicate && !predicate(item)) continue;
      matchedTranscriptReqs.add(item);
      return item;
    }
    return null;
  };

  // 严格规则：仅允许“合成键 <-> 真实 ID”（或合成键之间）通过 stepIndex / 用量指纹兜底关联，严禁两条不同真实 ID 跨绑
  const canFallbackLink = (ledgerKey, c, cidKey, reqItem) => {
    const cIsFallback = isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId);
    const rId = String(reqItem.callId || '');
    const rIsFallback = !rId || isStepFallbackCallId(rId, reqItem.cascadeId);
    return cIsFallback || rIsFallback;
  };

  const ledgerEnrichmentCalls = [];
  const inMemoryEnrichments = new Map();

  const applyTranscriptMatch = (ledgerKey, c, cidKey, matched) => {
    const cIsFallback = isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId);
    const mId = String(matched.callId || '');
    const mIsFallback = !mId || isStepFallbackCallId(mId, matched.cascadeId);
    const targetCallId = (cIsFallback && !mIsFallback) ? mId : cidKey;

    const uC = getCallTokenBreakdown(c);
    const merged = mergeSameCallRecords(c, matched, targetCallId, null, false, true);
    const uMerged = getCallTokenBreakdown(merged);

    const keyChanged = targetCallId !== ledgerKey;
    const modelEnriched = getCollectorModelRank(merged.model) > getCollectorModelRank(c.model);
    const usageEnriched = uMerged.tot > uC.tot || (uMerged.tot === uC.tot && uMerged.out > uC.out);
    const stepEnriched = (c.stepIndex === null || c.stepIndex === undefined) && merged.stepIndex !== null && merged.stepIndex !== undefined;
    const cascadeEnriched = !c.cascadeId && Boolean(merged.cascadeId);
    const dateEnriched = String(c.date || '') !== String(merged.date || '')
      || String(c.created_at || '') !== String(merged.created_at || '')
      || Boolean(c.dateIsProvisional) !== Boolean(merged.dateIsProvisional);
    const statusEnriched = String(c.status || '') !== String(merged.status || '');
    const pricingEnriched = Boolean(c.isPriced) !== Boolean(merged.isPriced) || Number(c.costUSD || 0) !== Number(merged.costUSD || 0);

    if (keyChanged || modelEnriched || usageEnriched || stepEnriched || cascadeEnriched || dateEnriched || statusEnriched || pricingEnriched) {
      ledgerEnrichmentCalls.push(merged);
      inMemoryEnrichments.set(ledgerKey, { targetCallId, merged });
    }
    const effectiveDateVal = merged.date || matched.date || c.date || null;
    matchedLedgerKeys.add(ledgerKey);
    callEffectiveDate.set(ledgerKey, effectiveDateVal);
    if (targetCallId !== ledgerKey) {
      matchedLedgerKeys.add(targetCallId);
      callEffectiveDate.set(targetCallId, effectiveDateVal);
    }
  };

  // Pass 1A: 优先在全量账本记录上完成精确 callId 对齐，避免同键记录被其它同步骤记录抢先消费
  const unmatchedAfterExactId = [];
  for (const [ledgerKey, c] of Object.entries(initialCallsMap)) {
    if (!c) continue;
    const cidKey = String(c.callId || ledgerKey);
    let matched = takeUnmatchedReq(reqsByCallId.get(cidKey));
    if (!matched && cidKey !== ledgerKey) {
      matched = takeUnmatchedReq(reqsByCallId.get(ledgerKey));
    }
    if (matched) {
      applyTranscriptMatch(ledgerKey, c, cidKey, matched);
    } else {
      unmatchedAfterExactId.push([ledgerKey, c]);
    }
  }

  // Pass 1B: 跨键 stepIndex 对齐（施加充分证据门禁：两条均含模型且用量不同的最终态调用绝不跨键误合并）
  const unmatchedLedgerPass2 = [];
  for (const [ledgerKey, c] of unmatchedAfterExactId) {
    const cidKey = String(c.callId || ledgerKey);
    let matched = null;
    if (c.cascadeId) {
      const cSrc = c.source || 'desktop';
      const cCid = String(c.cascadeId).toLowerCase();
      const candSteps = extractCallStepNumbers(c, ledgerKey);
      const uC = getCallTokenBreakdown(c);
      for (const stIdx of candSteps) {
        const sKey = `${cSrc}:${cCid}#${stIdx}`;
        const multiRealAtStep = (realLedgerCountByStepKey.get(sKey) || 0) > 1;
        if (multiRealAtStep && (uC.inp + uC.cap + uC.out) > 0) {
          matched = takeUnmatchedReq(reqsByStepKey.get(sKey), (item) => {
            if (!canFallbackLink(ledgerKey, c, cidKey, item)) return false;
            if (!areModelsCompatible(c.model, item.model)) return false;
            const uItem = getCallTokenBreakdown(item);
            return uItem.inp === uC.inp && uItem.cap === uC.cap && uItem.out === uC.out;
          });
        } else if (!multiRealAtStep) {
          const cIsFallback = isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId);
          matched = takeUnmatchedReq(reqsByStepKey.get(sKey), (item) => {
            if (!canFallbackLink(ledgerKey, c, cidKey, item)) return false;
            const rId = String(item.callId || '');
            const rIsFallback = !rId || isStepFallbackCallId(rId, item.cascadeId);
            return (cIsFallback && !rIsFallback)
              ? isConfirmableSingleStepMatch(item, c)
              : isConfirmableSingleStepMatch(c, item);
          });
        }
        if (matched) break;
      }
    }
    if (matched) {
      applyTranscriptMatch(ledgerKey, c, cidKey, matched);
    } else {
      unmatchedLedgerPass2.push([ledgerKey, c]);
    }
  }

  // Pass 2: 兼容尚未记录 stepIndex 的历史账本条目，按同会话精确非零用量指纹 + 兼容模型双边唯一（1-to-1）匹配
  if (unmatchedLedgerPass2.length) {
    const reqsByUsageKey = new Map();
    for (const r of recentRequests) {
      if (matchedTranscriptReqs.has(r) || !r.cascadeId) continue;
      const uR = getCallTokenBreakdown(r);
      if (uR.inp + uR.cap + uR.out <= 0) continue;
      const uKey = `${r.source || 'desktop'}:${String(r.cascadeId).toLowerCase()}:${uR.inp}:${uR.cap}:${uR.out}`;
      let list = reqsByUsageKey.get(uKey);
      if (!list) { list = []; reqsByUsageKey.set(uKey, list); }
      list.push(r);
    }
    const ledgerCandsByUsageKey = new Map();
    for (const [ledgerKey, c] of unmatchedLedgerPass2) {
      if (!c.cascadeId) continue;
      if (c.stepIndex !== null && c.stepIndex !== undefined) continue;
      if (extractCallStepNumbers(c, ledgerKey).length > 0) continue;
      const uC = getCallTokenBreakdown(c);
      if (uC.inp + uC.cap + uC.out <= 0) continue;
      const uKey = `${c.source || 'desktop'}:${String(c.cascadeId).toLowerCase()}:${uC.inp}:${uC.cap}:${uC.out}`;
      let list = ledgerCandsByUsageKey.get(uKey);
      if (!list) { list = []; ledgerCandsByUsageKey.set(uKey, list); }
      list.push([ledgerKey, c, String(c.callId || ledgerKey)]);
    }
    for (const [uKey, ledgerGroup] of ledgerCandsByUsageKey.entries()) {
      const reqCandidates = (reqsByUsageKey.get(uKey) || []).filter(item => !matchedTranscriptReqs.has(item));
      if (!reqCandidates.length) continue;
      const reqToCompatibleLedgers = new Map();
      const ledgerToCompatibleReqs = new Map();
      for (const lEntry of ledgerGroup) {
        const [ledgerKey, c, cidKey] = lEntry;
        const compatReqs = reqCandidates.filter(
          item => canFallbackLink(ledgerKey, c, cidKey, item) && areModelsCompatible(c.model, item.model)
        );
        ledgerToCompatibleReqs.set(lEntry, compatReqs);
        for (const rItem of compatReqs) {
          let lList = reqToCompatibleLedgers.get(rItem);
          if (!lList) { lList = []; reqToCompatibleLedgers.set(rItem, lList); }
          lList.push(lEntry);
        }
      }
      for (const lEntry of ledgerGroup) {
        const compatReqs = ledgerToCompatibleReqs.get(lEntry) || [];
        if (compatReqs.length !== 1) continue;
        const targetReq = compatReqs[0];
        if ((reqToCompatibleLedgers.get(targetReq) || []).length !== 1) continue;
        if (matchedTranscriptReqs.has(targetReq)) continue;
        matchedTranscriptReqs.add(targetReq);
        const [ledgerKey, c, cidKey] = lEntry;
        applyTranscriptMatch(ledgerKey, c, cidKey, targetReq);
      }
    }
  }

  // 向账本写入既有记录的富化更新（补齐 model / 最新完整用量 / stepIndex）以及未匹配的已计价扫描调用
  const unmatchedPricedTranscriptReqs = recentRequests.filter(r => !matchedTranscriptReqs.has(r) && r.isPriced && r.callId);
  const ledgerUpdates = [...ledgerEnrichmentCalls, ...unmatchedPricedTranscriptReqs];
  if (ledgerUpdates.length) {
    recordModelCalls(ledgerUpdates, { agDir, trustTranscriptDate: true });
  }

  const effectiveCallsMap = { ...(loadPricingLedger(agDir).calls || {}) };
  for (const [origKey, { targetCallId, merged }] of inMemoryEnrichments.entries()) {
    if (effectiveCallsMap[targetCallId]) {
      effectiveCallsMap[targetCallId] = mergeSameCallRecords(effectiveCallsMap[targetCallId], merged, targetCallId, merged.stepIndex, false, true);
    } else if (effectiveCallsMap[origKey]) {
      if (targetCallId !== origKey) delete effectiveCallsMap[origKey];
      effectiveCallsMap[targetCallId] = merged;
    }
  }

  const finalRealKeysByStep = new Map();
  for (const [ledgerKey, c] of Object.entries(effectiveCallsMap)) {
    if (!c || !c.cascadeId) continue;
    if (isStepFallbackCallId(ledgerKey, c.cascadeId)) continue;
    const src = c.source || 'desktop';
    const cid = String(c.cascadeId).toLowerCase();
    for (const st of extractCallStepNumbers(c, ledgerKey)) {
      const sKey = `${src}:${cid}#${st}`;
      let list = finalRealKeysByStep.get(sKey);
      if (!list) { list = []; finalRealKeysByStep.set(sKey, list); }
      list.push(ledgerKey);
    }
  }
  for (const r of unmatchedPricedTranscriptReqs) {
    const rKey = String(r.callId);
    let persistedKey = effectiveCallsMap[rKey] ? rKey : null;
    if (!persistedKey && isStepFallbackCallId(rKey, r.cascadeId) && r.cascadeId && r.stepIndex !== null && r.stepIndex !== undefined) {
      const cands = (finalRealKeysByStep.get(`${r.source || 'desktop'}:${String(r.cascadeId).toLowerCase()}#${r.stepIndex}`) || [])
        .filter(k => effectiveCallsMap[k] && areModelsCompatible(effectiveCallsMap[k].model, r.model));
      if (cands.length === 1) {
        if (isConfirmableSingleStepMatch(effectiveCallsMap[cands[0]], r)) {
          persistedKey = cands[0];
        }
      } else if (cands.length > 1) {
        const uR = getCallTokenBreakdown(r);
        if (uR.inp + uR.cap + uR.out > 0) {
          const exact = cands.filter(k => {
            const uK = getCallTokenBreakdown(effectiveCallsMap[k]);
            return uK.inp === uR.inp && uK.cap === uR.cap && uK.out === uR.out;
          });
          if (exact.length === 1) persistedKey = exact[0];
        }
      }
    }
    if (!persistedKey && !isSyntheticCall(rKey, r)) {
      effectiveCallsMap[rKey] = r;
      persistedKey = rKey;
    }
    if (persistedKey) {
      matchedTranscriptReqs.add(r);
      matchedLedgerKeys.add(persistedKey);
      callEffectiveDate.set(persistedKey, r.date || effectiveCallsMap[persistedKey].date || null);
    }
  }

  const finalCallsEntries = Object.entries(effectiveCallsMap);
  const mergedCalls = finalCallsEntries.map(([, c]) => c);

  const resolveLedgerCallDate = (ledgerKey, c) => {
    const mapped = callEffectiveDate.get(ledgerKey);
    if (mapped) return String(mapped).slice(0, 10);
    const dInfo = extractNormalizedDateInfo(c);
    if (dInfo.date) return dInfo.date;
    return null;
  };

  // 按来源与日期汇总未匹配任何实时 transcript 的账本调用，用于抵扣 v2 / v1 历史归档中已被账本覆盖的份额
  const unmatchedLedgerBySourceDate = new Map();
  for (const [ledgerKey, c] of finalCallsEntries) {
    if (!c || matchedLedgerKeys.has(ledgerKey)) continue;
    const effDate = resolveLedgerCallDate(ledgerKey, c);
    if (!effDate || !/^\d{4}-\d{2}-\d{2}$/.test(effDate)) continue;
    const cSrc = c.source === 'cli' ? 'cli' : 'desktop';
    const cInp = Number(c.inputTokens ?? c.input_tokens ?? c.input ?? 0);
    const cCap = Number(c.cacheTokens ?? c.cacheReadTokens ?? c.cache_read_tokens ?? c.cached ?? 0);
    const cOut = Number(c.outputTokens ?? c.output_tokens ?? c.output ?? 0);
    const cTok = cInp + cCap + cOut;
    const mapKey = `${cSrc}:${effDate}`;
    const prev = unmatchedLedgerBySourceDate.get(mapKey) || { tokens: 0, steps: 0 };
    prev.tokens += cTok;
    prev.steps += 1;
    unmatchedLedgerBySourceDate.set(mapKey, prev);
  }

  let archDeskUncovSteps = 0, archDeskUncovTokens = 0;
  let archCliUncovSteps = 0, archCliUncovTokens = 0;
  let archMonthUncovSteps = 0, archMonthUncovTokens = 0;
  let archMonthDeskUncovSteps = 0, archMonthDeskUncovTokens = 0;
  let archMonthCliUncovSteps = 0, archMonthCliUncovTokens = 0;

  for (const k of Array.from(allDateKeys).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;

    const v2OnlyDeskTok = Math.max(0, (mergedDesktop[k]?.total || 0) - (scannedBySource.desktop[k]?.total || 0));
    const v2OnlyDeskSteps = Math.max(0, (mergedDesktop[k]?.steps || 0) - (scannedBySource.desktop[k]?.steps || 0));
    const covDesk = unmatchedLedgerBySourceDate.get(`desktop:${k}`) || { tokens: 0, steps: 0 };
    const v2UncovDeskTok = Math.max(0, v2OnlyDeskTok - covDesk.tokens);
    const v2UncovDeskSteps = v2UncovDeskTok > 0
      ? Math.max(1, v2OnlyDeskSteps - covDesk.steps)
      : Math.max(0, v2OnlyDeskSteps - covDesk.steps);
    const excessDeskTok = Math.max(0, covDesk.tokens - v2OnlyDeskTok);
    const excessDeskSteps = Math.max(0, covDesk.steps - v2OnlyDeskSteps);

    const v2OnlyCliTok = Math.max(0, (mergedCli[k]?.total || 0) - (scannedBySource.cli[k]?.total || 0));
    const v2OnlyCliSteps = Math.max(0, (mergedCli[k]?.steps || 0) - (scannedBySource.cli[k]?.steps || 0));
    const covCli = unmatchedLedgerBySourceDate.get(`cli:${k}`) || { tokens: 0, steps: 0 };
    const v2UncovCliTok = Math.max(0, v2OnlyCliTok - covCli.tokens);
    const v2UncovCliSteps = v2UncovCliTok > 0
      ? Math.max(1, v2OnlyCliSteps - covCli.steps)
      : Math.max(0, v2OnlyCliSteps - covCli.steps);
    const excessCliTok = Math.max(0, covCli.tokens - v2OnlyCliTok);
    const excessCliSteps = Math.max(0, covCli.steps - v2OnlyCliSteps);

    const rawV1Tok = mergedLegacyUnallocated[k]?.total || 0;
    const rawV1Steps = mergedLegacyUnallocated[k]?.steps || 0;
    const excessTok = excessDeskTok + excessCliTok;
    const excessSteps = excessDeskSteps + excessCliSteps;
    const v1UncovTok = Math.max(0, rawV1Tok - excessTok);
    const v1UncovSteps = v1UncovTok > 0
      ? Math.max(1, rawV1Steps - excessSteps)
      : Math.max(0, rawV1Steps - excessSteps);

    archDeskUncovTokens += v2UncovDeskTok + v1UncovTok;
    archDeskUncovSteps += v2UncovDeskSteps + v1UncovSteps;
    archCliUncovTokens += v2UncovCliTok;
    archCliUncovSteps += v2UncovCliSteps;
    if (k.startsWith(monthPrefix)) {
      archMonthDeskUncovTokens += v2UncovDeskTok + v1UncovTok;
      archMonthDeskUncovSteps += v2UncovDeskSteps + v1UncovSteps;
      archMonthCliUncovTokens += v2UncovCliTok;
      archMonthCliUncovSteps += v2UncovCliSteps;
      archMonthUncovTokens += v2UncovDeskTok + v2UncovCliTok + v1UncovTok;
      archMonthUncovSteps += v2UncovDeskSteps + v2UncovCliSteps + v1UncovSteps;
    }
  }

  // 分来源与全量动态统计未被账本覆盖的剩余未计价请求与原因
  const unmatchedRecentUnpriced = recentRequests.filter(r => !matchedTranscriptReqs.has(r) && !r.isPriced);
  const desktopRecentUnpriced = unmatchedRecentUnpriced.filter(r => r.source === 'desktop');
  const cliRecentUnpriced = unmatchedRecentUnpriced.filter(r => r.source === 'cli');

  function aggregateUnpriced(items, extraCount = 0, extraTokens = 0) {
    const reasons = { missingModel: extraCount, unsupportedModel: 0, missingUsage: 0 };
    let tokens = extraTokens;
    for (const it of items) {
      tokens += (it.inputTokens + it.cacheTokens + it.outputTokens);
      if (!it.model) reasons.missingModel++;
      else if ((it.inputTokens + it.cacheTokens + it.outputTokens) === 0) reasons.missingUsage++;
      else reasons.unsupportedModel++;
    }
    return { count: items.length + extraCount, tokens, reasons };
  }

  const deskUnpriced = aggregateUnpriced(desktopRecentUnpriced, archDeskUncovSteps, archDeskUncovTokens);
  const cliUnpriced = aggregateUnpriced(cliRecentUnpriced, archCliUncovSteps, archCliUncovTokens);

  const totalUnpricedCount = deskUnpriced.count + cliUnpriced.count;
  const totalUnpricedTokens = deskUnpriced.tokens + cliUnpriced.tokens;
  const totalUnpricedReasons = {
    missingModel: deskUnpriced.reasons.missingModel + cliUnpriced.reasons.missingModel,
    unsupportedModel: deskUnpriced.reasons.unsupportedModel + cliUnpriced.reasons.unsupportedModel,
    missingUsage: deskUnpriced.reasons.missingUsage + cliUnpriced.reasons.missingUsage
  };

  const costEstimateAll = summarizeApiCost(mergedCalls, totalUnpricedCount, totalUnpricedReasons, totalUnpricedTokens);
  const costEstimateDesktop = summarizeApiCost(mergedCalls.filter(c => (c.source || 'desktop') === 'desktop'), deskUnpriced.count, deskUnpriced.reasons, deskUnpriced.tokens);
  const costEstimateCli = summarizeApiCost(mergedCalls.filter(c => c.source === 'cli'), cliUnpriced.count, cliUnpriced.reasons, cliUnpriced.tokens);

  // 本期 (本月自然月) 账本过滤与计价分析（仅追加未被账本覆盖的本月剩余步骤与 v2/v1 遗留差额）
  const currentMonthCalls = finalCallsEntries
    .filter(([ledgerKey, c]) => {
      if (!c) return false;
      const effDate = resolveLedgerCallDate(ledgerKey, c);
      return effDate && effDate.startsWith(monthPrefix);
    })
    .map(([, c]) => c);
  const currentMonthUnmatchedReqs = unmatchedRecentUnpriced.filter(r => r.date && String(r.date).startsWith(monthPrefix));
  const currentMonthDesktopUnmatched = currentMonthUnmatchedReqs.filter(r => (r.source || 'desktop') === 'desktop');
  const currentMonthCliUnmatched = currentMonthUnmatchedReqs.filter(r => r.source === 'cli');
  const monthUnpriced = aggregateUnpriced(currentMonthUnmatchedReqs, archMonthUncovSteps, archMonthUncovTokens);
  const monthDeskUnpriced = aggregateUnpriced(currentMonthDesktopUnmatched, archMonthDeskUncovSteps, archMonthDeskUncovTokens);
  const monthCliUnpriced = aggregateUnpriced(currentMonthCliUnmatched, archMonthCliUncovSteps, archMonthCliUncovTokens);
  const costEstimateCurrentMonth = summarizeApiCost(
    currentMonthCalls,
    monthUnpriced.count,
    monthUnpriced.reasons,
    monthUnpriced.tokens
  );
  const costEstimateCurrentMonthDesktop = summarizeApiCost(
    currentMonthCalls.filter(c => (c.source || 'desktop') === 'desktop'),
    monthDeskUnpriced.count,
    monthDeskUnpriced.reasons,
    monthDeskUnpriced.tokens
  );
  const costEstimateCurrentMonthCli = summarizeApiCost(
    currentMonthCalls.filter(c => c.source === 'cli'),
    monthCliUnpriced.count,
    monthCliUnpriced.reasons,
    monthCliUnpriced.tokens
  );

  // 按日计费聚合映射（供自然月 / 自定义订阅周期瞬时切换，零重复扫描）
  const dailyCostMapBySource = { all: {}, desktop: {}, cli: {} };
  const ensureDailyCostBucket = (src, dayKey) => {
    if (!dailyCostMapBySource[src][dayKey]) {
      dailyCostMapBySource[src][dayKey] = {
        pricedCostUSD: 0,
        inputCostUSD: 0,
        cacheCostUSD: 0,
        outputCostUSD: 0,
        inputTokens: 0,
        cacheTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        pricedTokens: 0,
        unpricedTokens: 0,
        pricedRequestsCount: 0,
        unpricedRequestsCount: 0,
        unpricedReasons: { missingModel: 0, unsupportedModel: 0, missingUsage: 0 },
        byModel: {},
        unpricedByModel: {}
      };
    }
    return dailyCostMapBySource[src][dayKey];
  };
  const recordDailyCostCall = (src, dayKey, req) => {
    if (!dayKey) return;
    const b = ensureDailyCostBucket(src, dayKey);
    const calc = calculateRequestApiCost(req);
    if (calc.isPriced) {
      b.pricedCostUSD = Number((b.pricedCostUSD + calc.costUSD).toFixed(6));
      b.inputCostUSD = Number((b.inputCostUSD + (calc.inputCostUSD || 0)).toFixed(6));
      b.cacheCostUSD = Number((b.cacheCostUSD + (calc.cacheCostUSD || 0)).toFixed(6));
      b.outputCostUSD = Number((b.outputCostUSD + (calc.outputCostUSD || 0)).toFixed(6));
      b.inputTokens += (calc.inputTokens || 0);
      b.cacheTokens += (calc.cacheTokens || 0);
      b.outputTokens += (calc.outputTokens || 0);
      b.thinkingTokens += (calc.thinkingTokens || 0);
      b.pricedTokens += calc.totalTokens;
      b.pricedRequestsCount += 1;
      if (!b.byModel[calc.modelKey]) b.byModel[calc.modelKey] = { requests: 0, costUSD: 0, tokens: 0 };
      b.byModel[calc.modelKey].requests += 1;
      b.byModel[calc.modelKey].costUSD = Number((b.byModel[calc.modelKey].costUSD + calc.costUSD).toFixed(6));
      b.byModel[calc.modelKey].tokens += calc.totalTokens;
    } else {
      const inp = Number(req.inputTokens ?? req.input_tokens ?? req.input ?? 0) || 0;
      const cap = Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? req.cached ?? 0) || 0;
      const outp = Number(req.outputTokens ?? req.output_tokens ?? req.output ?? 0) || 0;
      const tot = Math.max(0, inp) + Math.max(0, cap) + Math.max(0, outp);
      b.unpricedRequestsCount += 1;
      b.unpricedTokens += tot;
      const rawM = extractModelString(req);
      if (!rawM) b.unpricedReasons.missingModel += 1;
      else if (tot === 0) b.unpricedReasons.missingUsage += 1;
      else {
        b.unpricedReasons.unsupportedModel += 1;
        const mLabel = String(rawM).trim();
        if (mLabel) {
          if (!b.unpricedByModel[mLabel]) b.unpricedByModel[mLabel] = { requests: 0, tokens: 0 };
          b.unpricedByModel[mLabel].requests += 1;
          b.unpricedByModel[mLabel].tokens += tot;
        }
      }
    }
  };
  for (const [ledgerKey, c] of finalCallsEntries) {
    if (!c) continue;
    const effDate = resolveLedgerCallDate(ledgerKey, c);
    if (!effDate) continue;
    const src = c.source === 'cli' ? 'cli' : 'desktop';
    recordDailyCostCall('all', effDate, c);
    recordDailyCostCall(src, effDate, c);
  }
  for (const r of unmatchedRecentUnpriced) {
    const effDate = r?.date ? String(r.date).slice(0, 10) : '';
    if (!effDate) continue;
    const src = r.source === 'cli' ? 'cli' : 'desktop';
    recordDailyCostCall('all', effDate, r);
    recordDailyCostCall(src, effDate, r);
  }

  // 9. 参考模型折算（官方标准价格表 2026-11-08）
  const referenceCostAll = calculateReferenceModelCost({
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheTokens: totalCacheTokens,
    totalTokens: grandTotalTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-08',
    mode: 'all'
  });

  const referenceCostCurrentMonth = calculateReferenceModelCost({
    inputTokens: currentMonthInput,
    outputTokens: currentMonthOutput,
    cacheTokens: currentMonthCache,
    totalTokens: monthTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-08',
    mode: 'all'
  });

  const referenceCostHybrid = calculateReferenceModelCost({
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheTokens: totalCacheTokens,
    totalTokens: grandTotalTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-09',
    mode: 'unpriced_only',
    knownUsage: {
      byCategory: costEstimateAll.byCategory,
      costUSD: costEstimateAll.pricedCostUSD
    }
  });

  const referenceCostCurrentMonthHybrid = calculateReferenceModelCost({
    inputTokens: currentMonthInput,
    outputTokens: currentMonthOutput,
    cacheTokens: currentMonthCache,
    totalTokens: monthTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-09',
    mode: 'unpriced_only',
    knownUsage: {
      byCategory: costEstimateCurrentMonth.byCategory,
      costUSD: costEstimateCurrentMonth.pricedCostUSD
    }
  });

  const costEstimate = costEstimateAll;

  const speedRecords = mergedCalls
    .filter(c => isValidSpeedSample(c))
    .map(c => ({
      callId: c.callId,
      model: c.model,
      modelExactId: c.modelExactId || resolveStableModelId(c, livePlanStatus?.cascadeModelConfigs || []) || null,
      modelLabel: c.modelLabel || c.model || null,
      effort: c.effort || null,
      inputTokens: c.inputTokens,
      cacheReadTokens: c.cacheReadTokens ?? c.cacheTokens ?? 0,
      outputTokens: c.outputTokens,
      ttftSec: c.ttftSec ?? null,
      streamingSec: c.streamingSec ?? null,
      durationSec: c.durationSec,
      tps: c.tps ?? null,
      origin: c.origin === 'speed-test' ? 'speed-test' : 'chat',
      status: c.status,
      isEstimated: Boolean(c.isEstimated),
      date: c.date || null,
      created_at: c.created_at || null,
      timestamp: getCallSortTimestamp(c) || null
    }));

  const compactModelConfigs = Array.isArray(livePlanStatus?.cascadeModelConfigs)
    ? livePlanStatus.cascadeModelConfigs.map(sanitizeCascadeModelConfig).filter(Boolean)
    : [];

  // 汇总最近 8 天各共享额度池真实消耗事件（供 5h / weekly 双周期剩余 Token 约数校准使用）
  // 统计口径：原始 inputTokens + cacheReadTokens + outputTokens 之和；同时计算全历史最小已知调用时间戳以判断周期起点覆盖完整性
  const quotaNowMs = Date.now();
  const quotaCutoffMs = quotaNowMs - 8 * 86400000;
  const quotaRecentCutoffMs = quotaNowMs - 86400000;
  const seenQuotaCallIds = new Set();
  const recentModelUsage = [];
  const olderQuotaBuckets = new Map();
  let allKnownCallsMinTs = null;
  const pushQuotaUsageCall = (call) => {
    if (!call || typeof call !== 'object') return;
    if (call.callId && seenQuotaCallIds.has(call.callId)) return;
    const rawTs = getCallSortTimestamp(call) ?? call.timestamp ?? (call.created_at ? new Date(call.created_at).getTime() : NaN);
    const ts = Number(rawTs);
    if (!Number.isFinite(ts) || ts <= 0 || ts > quotaNowMs + 60000) return;
    if (allKnownCallsMinTs === null || ts < allKnownCallsMinTs) {
      allKnownCallsMinTs = ts;
    }
    if (ts < quotaCutoffMs) return;
    const rawModel = call.modelExactId || extractModelString(call) || call.model || '';
    const poolKey = typeof getModelPoolKey === 'function' ? getModelPoolKey(rawModel, call.modelLabel || '') : 'unknown';
    const sharedGroupKey = typeof getSharedQuotaGroupKey === 'function' ? getSharedQuotaGroupKey(rawModel || poolKey) : 'unknown';
    if ((!poolKey || poolKey === 'unknown') && (!sharedGroupKey || sharedGroupKey === 'unknown')) return;
    const inp = Math.max(0, Number(call.inputTokens || 0));
    const cache = Math.max(0, Number(call.cacheTokens ?? call.cacheReadTokens ?? 0));
    const outp = Math.max(0, Number(call.outputTokens || 0));
    const sumParts = inp + cache + outp;
    const totalTokens = Number(call.totalTokens ?? sumParts);
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;
    if (call.callId) seenQuotaCallIds.add(call.callId);
    if (ts >= quotaRecentCutoffMs) {
      recentModelUsage.push({
        id: call.callId || null,
        poolKey,
        sharedGroupKey,
        ts,
        inputTokens: inp,
        cacheTokens: cache,
        outputTokens: outp,
        totalTokens
      });
    } else {
      const bTs = Math.floor(ts / 900000) * 900000;
      const bKey = `${sharedGroupKey}:${poolKey}:${bTs}`;
      const existingB = olderQuotaBuckets.get(bKey);
      if (existingB) {
        existingB.inputTokens += inp;
        existingB.cacheTokens += cache;
        existingB.outputTokens += outp;
        existingB.totalTokens += totalTokens;
      } else {
        olderQuotaBuckets.set(bKey, {
          poolKey,
          sharedGroupKey,
          ts: bTs,
          inputTokens: inp,
          cacheTokens: cache,
          outputTokens: outp,
          totalTokens
        });
      }
    }
  };
  for (const c of mergedCalls) pushQuotaUsageCall(c);
  for (const c of recentRequests) pushQuotaUsageCall(c);
  for (const b of olderQuotaBuckets.values()) recentModelUsage.push(b);
  const quotaUsageCoverageStartMs = allKnownCallsMinTs !== null ? Math.max(quotaCutoffMs, allKnownCallsMinTs) : null;

  const modelBreakdown = buildDailyModelBreakdown({
    recentRequests,
    finalCallsEntries,
    matchedTranscriptReqs,
    matchedLedgerKeys,
    resolveLedgerCallDate,
    mergedDesktop,
    mergedCli,
    mergedLegacyUnallocated,
    archiveV2,
    compactModelConfigs
  });

  const cacheReadStatsAll = summarizeDailyMapCacheStats(dailyMapAll);
  const cacheReadStatsDesktop = summarizeDailyMapCacheStats(mergedDesktop);
  const cacheReadStatsCli = summarizeDailyMapCacheStats(mergedCli);
  const currentMonthCacheReadStatsAll = summarizeDailyMapCacheStats(dailyMapAll, monthPrefix);
  const currentMonthCacheReadStatsDesktop = summarizeDailyMapCacheStats(mergedDesktop, monthPrefix);
  const currentMonthCacheReadStatsCli = summarizeDailyMapCacheStats(mergedCli, monthPrefix);

  const prevAccountEmail = Object.prototype.hasOwnProperty.call(extraContext, 'prevAccountEmail')
    ? extraContext.prevAccountEmail
    : (collectTokenHistoryAsync._lastAccountEmail || null);
  const out = {
    schemaVersion: PROJECT_VERSION,
    version: PROJECT_VERSION,
    accountScopeKey: currentAccountKey ? buildAccountScopeKey(currentAccountKey) : null,
    currentAccountEmail: currentAccountKey || null,
    isAccountSwitched: Boolean(
      currentAccountKey &&
      prevAccountEmail &&
      String(prevAccountEmail).toLowerCase() !== String(currentAccountKey).toLowerCase()
    ),
    updatedAt: `${todayKey} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
    firstUseDate: earliestDate,
    quotaUsageCoverageStartMs,
    quotaUsageAccounting: 'raw_input_cache_output',
    recentModelUsage,
    speedRecords,
    cascadeModelConfigs: compactModelConfigs,
    modelCapabilitiesById: livePlanStatus?.availableModelDetails || null,
    currentPeriod: {
      key: monthPrefix,
      label: `${monthPrefix} (自然月)`,
      isCurrentMonth: true
    },
    sources: {
      desktop: {
        conversationsCount: desktopPbCount,
        transcriptsCount: transcriptJobs.filter(j => j.source === 'desktop').length
      },
      cli: {
        dirExists: cliAgDirs.some(d => fs.existsSync(d)),
        conversationsCount: cliPbCount,
        transcriptsCount: transcriptJobs.filter(j => j.source === 'cli').length
      }
    },
    planStatus: effectivePlanStatus,
    rawPlanStatus: livePlanStatus,
    customPlanSettings: currentCustom,
    uiPreferences: customSettingsAll.uiPreferences || {},
    costEstimate,
    costEstimateCurrentMonth,
    costEstimateBySource: {
      all: costEstimateAll,
      desktop: costEstimateDesktop,
      cli: costEstimateCli
    },
    costEstimateCurrentMonthBySource: {
      all: costEstimateCurrentMonth,
      desktop: costEstimateCurrentMonthDesktop,
      cli: costEstimateCurrentMonthCli
    },
    cacheReadStatsBySource: {
      all: cacheReadStatsAll,
      desktop: cacheReadStatsDesktop,
      cli: cacheReadStatsCli
    },
    currentMonthCacheReadStatsBySource: {
      all: currentMonthCacheReadStatsAll,
      desktop: currentMonthCacheReadStatsDesktop,
      cli: currentMonthCacheReadStatsCli
    },
    referenceCost: {
      all: referenceCostAll,
      currentMonth: referenceCostCurrentMonth,
      hybrid: referenceCostHybrid,
      currentMonthHybrid: referenceCostCurrentMonthHybrid
    },
    summary: {
      grandTotalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      todayTokens,
      monthTokens,
      yearTokens,
      currentMonthInput,
      currentMonthOutput,
      currentMonthCache,
      cacheReadStats: cacheReadStatsAll,
      currentMonthCacheReadStats: currentMonthCacheReadStatsAll,
      totalSteps,
      totalConversations,
      firstUseDate: earliestDate,
      activeDaysCount: Object.keys(dailyMapAll).length,
      costEstimate,
      costEstimateCurrentMonth,
      referenceCost: {
        all: referenceCostAll,
        currentMonth: referenceCostCurrentMonth,
        hybrid: referenceCostHybrid,
        currentMonthHybrid: referenceCostCurrentMonthHybrid
      }
    },
    dailyMap: dailyMapAll,
    dailyMapBySource: {
      all: dailyMapAll,
      desktop: mergedDesktop,
      cli: mergedCli,
      legacyUnallocated: mergedLegacyUnallocated
    },
    dailyModelMapBySource: modelBreakdown.dailyModelMapBySource,
    dailyCostMap: dailyCostMapBySource.all,
    dailyCostMapBySource,
    modelMetaByKey: modelBreakdown.modelMetaByKey
  };

  const unattributedModelTokens = Object.values(modelBreakdown.dailyModelMapBySource?.all || {}).reduce(
    (acc, dayRec) => acc + (Number(dayRec?.[UNATTRIBUTED_MODEL_KEY]?.total) || 0),
    0
  );
  const archiveSig = `${agDir}|${earliestDate}|${totalConversations}|${grandTotalTokens}|${totalSteps}|m:${Object.keys(modelBreakdown.modelMetaByKey).length}|u:${unattributedModelTokens}|${effectivePlanStatus?.tierKey || ''}|${effectivePlanStatus?.tierName || ''}|${effectivePlanStatus?.tierId || ''}|${effectivePlanStatus?.teamsTier || ''}|${effectivePlanStatus?.actualPricePaid ?? ''}|${effectivePlanStatus?.currency || ''}|${costEstimate?.pricedCostUSD ?? ''}`;
  const isStaleCheck = typeof extraContext.isStale === 'function' ? extraContext.isStale : null;
  if (isStaleCheck && isStaleCheck()) {
    return { out, archiveSig: null, accountKey: currentAccountKey || null, stale: true };
  }

  // 持久化保存到 v2 与 v1 归档（仅在数据变化或文件不存在时原子写入，减少高频磁盘 I/O）
  const prevArchiveSig = Object.prototype.hasOwnProperty.call(extraContext, 'prevArchiveSig')
    ? extraContext.prevArchiveSig
    : collectTokenHistoryAsync._lastArchiveSig;
  try {
    const shouldWriteArchive = options.agDir || archiveSig !== prevArchiveSig || !fs.existsSync(archivePathV2) || !fs.existsSync(archivePathV1);
    if (shouldWriteArchive) {
      const v2Payload = {
        version: '2.0.0',
        firstUseDate: earliestDate,
        updatedAt: out.updatedAt,
        maxConversations: totalConversations,
        planStatus: effectivePlanStatus,
        costEstimate,
        costEstimateCurrentMonth,
        referenceCost: out.referenceCost,
        dailyMapBySource: out.dailyMapBySource,
        dailyModelMapBySource: modelBreakdown.dailyModelMapBySource,
        modelMetaByKey: modelBreakdown.modelMetaByKey
      };
      safeWriteJsonSync(archivePathV2, v2Payload);

      // 同时写回 v1 格式以保持向下完全兼容
      const v1Payload = {
        firstUseDate: earliestDate,
        maxConversations: totalConversations,
        updatedAt: out.updatedAt,
        dailyMap: dailyMapAll
      };
      safeWriteJsonSync(archivePathV1, v1Payload);
    }
  } catch { }

  return {
    out,
    archiveSig,
    accountKey: currentAccountKey ? String(currentAccountKey) : null,
    stale: false
  };
}

/**
 * 异步收集历史 Token 用量与成本汇总（优先后台 Worker 线程执行，避免阻塞宿主主进程事件循环）
 * @param {object} options
 */
async function collectTokenHistoryAsync(options = {}) {
  const scopeKey = getEffectiveScanScopeKey(options);
  const canCacheByScope = !options.fs && !options.hostFetcher && !options.customPlan;
  if (!options.force && canCacheByScope && cachedTokenHistory && cachedTokenHistoryScope === scopeKey && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  if (!options.force && !options.agDir && activeScanPromise && activeScanScope === scopeKey) {
    return activeScanPromise;
  }

  const thisScanSeq = ++currentScanSequence;
  const runner = (async () => {
    const livePlanStatus = await fetchUserStatusFromHost(options);
    const prevAccountEmail = collectTokenHistoryAsync._lastAccountEmail || null;
    const prevArchiveSig = collectTokenHistoryAsync._lastArchiveSig || null;

    let result = null;
    if (canUseHistoryWorker(options)) {
      const workerResp = await runHistoryWorkerTask({
        options: cloneCollectorOptionsForWorker(options),
        livePlanStatus,
        prevAccountEmail,
        prevArchiveSig
      }, 'collectTokenHistory', options);
      if (workerResp && workerResp._workerHandled && workerResp.result && workerResp.result.out) {
        result = workerResp.result;
      }
    }

    if (!result) {
      result = await collectTokenHistoryCoreAsync(options, {
        livePlanStatus,
        prevAccountEmail,
        prevArchiveSig,
        isStale: () => !options.agDir && thisScanSeq !== currentScanSequence
      });
    }

    if (!options.agDir && thisScanSeq !== currentScanSequence) {
      return result.out;
    }
    if (result.archiveSig) {
      collectTokenHistoryAsync._lastArchiveSig = result.archiveSig;
    }
    if (canCacheByScope) {
      if (!options.agDir && result.accountKey) collectTokenHistoryAsync._lastAccountEmail = result.accountKey;
      cachedTokenHistory = result.out;
      cachedTokenHistoryScope = scopeKey;
      cachedTokenHistoryAt = Date.now();
    }
    return result.out;
  })();

  if (!options.agDir) {
    activeScanScope = scopeKey;
    const tracked = runner.finally(() => {
      if (activeScanPromise === tracked) {
        activeScanPromise = null;
        activeScanScope = '';
      }
    });
    activeScanPromise = tracked;
    return tracked;
  }
  return runner;
}

/**
 * 从单个 transcript.jsonl 提取用户轮次标记、模型调用记录与可验证的子代理调用关联。
 */
function parseTranscriptForSessionTimeline(transcriptPath, cascadeId, convDir, sourceName = 'desktop', extraOpts = {}) {
  const turns = [];
  const calls = [];
  const subagentLinks = [];
  const uuidExtractRe = /"conversationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { turns, calls, subagentLinks };
  }

  let content = '';
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return { turns, calls, subagentLinks };
  }

  const dbMeta = convDir && !extraOpts.fs && !isFsMonkeyPatched()
    ? loadConversationDbMeta(path.join(convDir, `${cascadeId}.db`), cascadeId)
    : null;

  const lines = content.split(/\r?\n/);
  const explicitUserTurns = [];
  const fallbackUserTurns = [];
  const pendingInvokes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }

    const rawStep = event.step_index ?? event.stepIndex;
    const parsedStep = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN;
    const stepIndex = Number.isInteger(parsedStep) && parsedStep >= 0 ? parsedStep : null;
    const createdAt = event.created_at || event.createdAt || null;
    const ts = createdAt ? Date.parse(createdAt) : NaN;
    const validTs = Number.isFinite(ts) && ts > 0 ? ts : null;

    if (event.type === 'USER_INPUT' || event.type === 'user' || event.role === 'user') {
      const textBody = typeof event.content === 'string' ? event.content : (typeof event.text === 'string' ? event.text : '');
      const rawPreview = textBody.replace(/\s+/g, ' ').trim().slice(0, 120);
      const turnEntry = {
        stepIndex,
        timestamp: validTs,
        created_at: createdAt,
        source: event.source || 'USER_EXPLICIT',
        preview: rawPreview
      };
      if (event.source === 'SYSTEM_SDK') {
        fallbackUserTurns.push(turnEntry);
      } else {
        explicitUserTurns.push(turnEntry);
      }
      continue;
    }

    if (Array.isArray(event.tool_calls)) {
      for (const tc of event.tool_calls) {
        if (!tc || !tc.name) continue;
        if (tc.name === 'invoke_subagent' || tc.name === 'send_message') {
          const cleanArg = (v) => (typeof v === 'string' ? v.replace(/^"|"$/g, '').trim() : '');
          pendingInvokes.push({
            stepIndex,
            toolName: tc.name,
            role: cleanArg(tc.args?.Role),
            typeName: cleanArg(tc.args?.TypeName),
            recipient: cleanArg(tc.args?.Recipient)
          });
        }
      }
    }

    if (typeof event.content === 'string' && event.content.includes('conversationId')) {
      let m;
      uuidExtractRe.lastIndex = 0;
      while ((m = uuidExtractRe.exec(event.content)) !== null) {
        const childCid = m[1];
        if (!childCid || childCid.toLowerCase() === String(cascadeId).toLowerCase()) continue;
        // 寻找紧邻前文的 invoke_subagent 调用以定位准确父步骤和 Role/TypeName
        let matchedInvoke = null;
        for (let pIdx = pendingInvokes.length - 1; pIdx >= 0; pIdx--) {
          const inv = pendingInvokes[pIdx];
          if (inv.toolName === 'invoke_subagent' && (stepIndex === null || inv.stepIndex === null || Math.abs(stepIndex - inv.stepIndex) <= 15)) {
            matchedInvoke = inv;
            break;
          }
        }
        const alreadyLinked = subagentLinks.find(l => l.childCid.toLowerCase() === childCid.toLowerCase());
        if (!alreadyLinked) {
          subagentLinks.push({
            childCid,
            parentCascadeId: cascadeId,
            parentStepIndex: matchedInvoke?.stepIndex ?? stepIndex,
            subagentRole: matchedInvoke?.role || '',
            subagentType: matchedInvoke?.typeName || '',
            confidence: 'verified_tool_output'
          });
        }
      }
    }

    const u = event.chatModel?.usage || null;
    const hasTokenFields = event.input_tokens != null || event.output_tokens != null || event.cache_read_tokens != null || u != null;
    if (!hasTokenFields && !event.error && event.type !== 'PLANNER_RESPONSE') continue;

    const inp = event.input_tokens != null ? Number(event.input_tokens || 0) : (u?.inputTokens != null ? Number(u.inputTokens || 0) : null);
    const outp = event.output_tokens != null ? Number(event.output_tokens || 0) : (u?.outputTokens != null ? Number(u.outputTokens || 0) : null);
    const cap = event.cache_read_tokens != null ? Number(event.cache_read_tokens || 0) : (u?.cacheReadTokens != null ? Number(u.cacheReadTokens || 0) : null);
    const thinking = event.thinking_output_tokens != null ? Number(event.thinking_output_tokens || 0) : (u?.thinkingOutputTokens != null ? Number(u.thinkingOutputTokens || 0) : 0);

    const dbStep = (dbMeta && stepIndex !== null) ? dbMeta.stepMetaMap.get(stepIndex) : null;
    const model = event.chatModel?.model || event.chatModel?.responseModel || event.model || event.modelId || dbStep?.model || '';
    const modelExactId = event.chatModel?.modelId || event.modelId || dbStep?.modelExactId || '';
    const modelLabel = event.chatModel?.modelDisplayName || dbStep?.modelLabel || '';

    const callId = dbStep?.responseId || extractCallId(event, cascadeId, stepIndex ?? i);
    if (!callId) continue;

    const hasUsageNums = inp !== null || cap !== null || outp !== null;
    if (!hasUsageNums && !event.error) continue;

    calls.push({
      callId,
      cascadeId,
      source: sourceName,
      stepIndex,
      model,
      ...(modelExactId ? { modelExactId } : {}),
      ...(modelLabel ? { modelLabel } : {}),
      inputTokens: inp,
      cacheReadTokens: cap,
      cacheTokens: cap,
      outputTokens: outp,
      thinkingTokens: thinking,
      totalTokens: hasUsageNums ? ((inp || 0) + (cap || 0) + (outp || 0)) : null,
      hasInputCacheFields: inp !== null || cap !== null,
      ttftSec: dbStep?.ttftSec ?? null,
      streamingSec: dbStep?.streamingSec ?? null,
      status: event.status === 'RUNNING' ? 'streaming' : 'final',
      ...(event.error ? { error: String(event.error) } : {}),
      date: validTs ? formatLocalDateKey(new Date(validTs)) : null,
      dateSource: 'transcript',
      dateIsProvisional: false,
      created_at: createdAt,
      timestamp: validTs
    });
  }

  const chosenTurns = explicitUserTurns.length ? explicitUserTurns : fallbackUserTurns;
  for (const t of chosenTurns) turns.push(t);
  return { turns, calls, subagentLinks, dbMeta };
}

const subagentParentIndexCache = { dirMtimesKey: '', byParent: new Map(), at: 0 };

/**
 * 基于目录签名缓存扫描所有可用根目录 conversations/*.db，查找显式记录了 parentCascadeId / rootCascadeId 的子代理会话。
 */
function findSubagentChildrenFromConvDirs(parentCascadeId, convDirs = [], options = {}) {
  if (!parentCascadeId || options.fs || isFsMonkeyPatched()) return [];
  const normParent = String(parentCascadeId).trim().toLowerCase();
  const dirSigParts = [];
  const uniqueConvDirs = dedupeScanPaths(convDirs);
  for (const d of uniqueConvDirs) {
    try {
      if (origFsMethods.existsSync(d)) {
        const st = origFsMethods.statSync(d);
        dirSigParts.push(`${d}:${st.mtimeMs}`);
      }
    } catch { }
  }
  const dirKey = dirSigParts.join('|');
  if (subagentParentIndexCache.dirMtimesKey !== dirKey || (Date.now() - subagentParentIndexCache.at) > 60000) {
    const nextByParent = new Map();
    for (const cDir of uniqueConvDirs) {
      try {
        if (!origFsMethods.existsSync(cDir)) continue;
        for (const name of origFsMethods.readdirSync(cDir)) {
          if (!name.endsWith('.db')) continue;
          const cid = name.slice(0, -3);
          const dbMeta = loadConversationDbMeta(path.join(cDir, name), cid);
          const pRaw = String(dbMeta.parentCascadeId || '').trim();
          const rRaw = String(dbMeta.rootCascadeId || '').trim();
          const parentKeys = new Set([pRaw.toLowerCase(), rRaw.toLowerCase()].filter(k => k && k !== cid.toLowerCase()));
          for (const pk of parentKeys) {
            let list = nextByParent.get(pk);
            if (!list) { list = []; nextByParent.set(pk, list); }
            if (!list.some(item => item.childCid === cid && item.convDir === cDir)) {
              list.push({
                childCid: cid,
                parentCascadeId: pRaw || rRaw,
                rootCascadeId: rRaw || pRaw,
                subagentType: dbMeta.subagentType || '',
                subagentRole: dbMeta.subagentRole || '',
                convDir: cDir
              });
            }
          }
        }
      } catch { }
    }
    subagentParentIndexCache.dirMtimesKey = dirKey;
    subagentParentIndexCache.byParent = nextByParent;
    subagentParentIndexCache.at = Date.now();
  }
  return subagentParentIndexCache.byParent.get(normParent) || [];
}

/**
 * 聚合指定会话的按用户轮次请求时间线与可验证子代理调用（仅只读访问，复用现有本地目录与账本）。
 */
async function collectSessionTimelineCoreAsync(cascadeId, options = {}) {
  const cid = String(cascadeId || '').trim();
  if (!cid || cid.includes('..') || cid.includes('/') || cid.includes('\\')) {
    return { cascadeId: cid, turns: [], unlinkedSubagentCalls: [], totalCalls: 0, mainCallsCount: 0, subagentCallsCount: 0, cacheSummary: summarizeCacheReadStats([]), latestCall: null, subagentLinks: [] };
  }

  const { agDir, agCliDir } = resolvePrimaryGeminiDirs(options);

  const rootEntries = [
    ...dedupeScanPaths([agDir, ...(Array.isArray(options.extraAgDirs) ? options.extraAgDirs : [])]).map(d => ({ dir: d, source: 'desktop' })),
    ...dedupeScanPaths([agCliDir, ...(Array.isArray(options.extraAgCliDirs) ? options.extraAgCliDirs : [])]).map(d => ({ dir: d, source: 'cli' }))
  ];

  const allTurns = [];
  const allCalls = [];
  const subagentMap = new Map();
  let mainDbMeta = null;

  const findTranscriptForCid = (targetCid) => {
    for (const r of rootEntries) {
      const candidates = [
        path.join(r.dir, 'brain', targetCid, '.system_generated', 'logs', 'transcript.jsonl'),
        path.join(r.dir, 'brain', targetCid, 'transcript.jsonl')
      ];
      for (const tp of candidates) {
        if (fs.existsSync(tp)) {
          return { path: tp, convDir: path.join(r.dir, 'conversations'), source: r.source };
        }
      }
    }
    return null;
  };

  // 1. 解析主会话自身 transcript + .db
  const mainFile = findTranscriptForCid(cid);
  if (mainFile) {
    const parsed = parseTranscriptForSessionTimeline(mainFile.path, cid, mainFile.convDir, mainFile.source, options);
    allTurns.push(...parsed.turns);
    allCalls.push(...parsed.calls);
    if (parsed.dbMeta) mainDbMeta = parsed.dbMeta;
    for (const link of parsed.subagentLinks) {
      subagentMap.set(link.childCid.toLowerCase(), link);
    }
  } else if (!options.fs && !isFsMonkeyPatched()) {
    for (const r of rootEntries) {
      const dbP = path.join(r.dir, 'conversations', `${cid}.db`);
      if (fs.existsSync(dbP)) {
        mainDbMeta = loadConversationDbMeta(dbP, cid);
        break;
      }
    }
  }

  // 2. 合并前端 / RPC 传入的 liveSteps（识别当前尚未写入磁盘的最新轮次与 invoke_subagent 调用）
  if (Array.isArray(options.liveSteps) && options.liveSteps.length) {
    for (let idx = 0; idx < options.liveSteps.length; idx++) {
      const s = options.liveSteps[idx];
      if (!s || typeof s !== 'object') continue;
      const stepIndex = Number.isInteger(Number(s.stepIndex ?? s.idx)) ? Number(s.stepIndex ?? s.idx) : idx;
      if (s.userInput) {
        const u = s.userInput;
        const rawPreview = String(u.userResponse || (u.items || []).map(item => item.text || '').join(' ') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const already = allTurns.some(t => t.stepIndex === stepIndex);
        if (!already) {
          allTurns.push({
            stepIndex,
            timestamp: s.timestamp || (s.createdAt ? Date.parse(s.createdAt) : null),
            created_at: s.createdAt || null,
            source: u.source || 'USER_EXPLICIT',
            preview: rawPreview
          });
        }
      }
    }
  }

  // 3. 合并来自当前会话 RPC / 前端传来的 liveCalls
  const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];
  if (Array.isArray(options.liveCalls)) {
    for (const c of options.liveCalls) {
      if (!c || typeof c !== 'object') continue;
      if (c.cascadeId && String(c.cascadeId).toLowerCase() !== cid.toLowerCase()) continue;
      const dbStep = (mainDbMeta && Number.isInteger(Number(c.stepIndex)))
        ? mainDbMeta.stepMetaMap.get(Number(c.stepIndex))
        : null;
      allCalls.push({
        ...c,
        cascadeId: c.cascadeId || cid,
        modelExactId: c.modelExactId || dbStep?.modelExactId || resolveStableModelId(c, cascadeConfigs) || undefined,
        modelLabel: c.modelLabel || dbStep?.modelLabel || undefined
      });
    }
  }

  // 4. 合并本地 pricing_ledger_v1.json 中当前会话（及其子代理）的持久化记录
  const ledger = loadPricingLedger(agDir, options.fs ? { fs: options.fs } : undefined);
  const ledgerCalls = ledger && ledger.calls && typeof ledger.calls === 'object' ? Object.values(ledger.calls) : [];
  const normCid = cid.toLowerCase();
  for (const lc of ledgerCalls) {
    if (!lc || !lc.cascadeId) continue;
    if (String(lc.cascadeId).toLowerCase() === normCid) {
      allCalls.push(lc);
    }
  }

  // 5. 发现基于 .db parent_cascade_id / root_cascade_id 的可验证子代理会话
  const dbChildren = findSubagentChildrenFromConvDirs(cid, rootEntries.map(r => path.join(r.dir, 'conversations')), options);
  for (const dc of dbChildren) {
    const k = dc.childCid.toLowerCase();
    const existing = subagentMap.get(k);
    if (!existing) {
      subagentMap.set(k, {
        childCid: dc.childCid,
        parentCascadeId: dc.parentCascadeId || cid,
        parentStepIndex: null,
        subagentRole: dc.subagentRole || '',
        subagentType: dc.subagentType || '',
        confidence: 'verified_db_meta'
      });
    } else if (!existing.subagentType && dc.subagentType) {
      existing.subagentType = dc.subagentType;
    }
  }

  // 6. 读取所有已验证关联子代理的 transcript + .db + ledger 调用
  const subagentLinks = Array.from(subagentMap.values());
  for (const link of subagentLinks) {
    const childFile = findTranscriptForCid(link.childCid);
    const childNorm = link.childCid.toLowerCase();
    if (childFile) {
      const childParsed = parseTranscriptForSessionTimeline(childFile.path, link.childCid, childFile.convDir, childFile.source, options);
      for (const cc of childParsed.calls) {
        allCalls.push({
          ...cc,
          agentRole: 'subagent',
          parentCascadeId: link.parentCascadeId || cid,
          parentStepIndex: link.parentStepIndex ?? null,
          subagentType: link.subagentType || childParsed.dbMeta?.subagentType || '',
          subagentRole: link.subagentRole || childParsed.dbMeta?.subagentRole || '',
          attributionConfidence: link.confidence
        });
      }
    }
    for (const lc of ledgerCalls) {
      if (!lc || !lc.cascadeId) continue;
      if (String(lc.cascadeId).toLowerCase() === childNorm) {
        allCalls.push({
          ...lc,
          agentRole: 'subagent',
          parentCascadeId: link.parentCascadeId || cid,
          parentStepIndex: link.parentStepIndex ?? null,
          subagentType: link.subagentType || '',
          subagentRole: link.subagentRole || '',
          attributionConfidence: link.confidence
        });
      }
    }
  }

  const grouped = groupSessionCallsByTurns(allTurns, allCalls, {
    cascadeId: cid,
    cascadeModelConfigs: cascadeConfigs,
    userStatus: options.userStatus || null
  });
  return {
    ...grouped,
    subagentLinks,
    subagentNote: mainDbMeta?.skippedReason ? `db_${mainDbMeta.skippedReason}` : null
  };
}

async function collectSessionTimelineAsync(cascadeId, options = {}) {
  if (canUseHistoryWorker(options)) {
    const workerResp = await runHistoryWorkerTask({
      cascadeId,
      options: cloneCollectorOptionsForWorker(options)
    }, 'collectSessionTimeline', options);
    if (workerResp && workerResp._workerHandled && workerResp.result) {
      return workerResp.result;
    }
  }
  return collectSessionTimelineCoreAsync(cascadeId, options);
}

if (!isMainThread && workerData && workerData.agCollectorHistoryWorker && parentPort) {
  parentPort.on('message', async (msg) => {
    const { id, cmd, payload, env } = msg || {};
    const prevEnv = {};
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        prevEnv[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    try {
      if (cmd === 'collectTokenHistory') {
        const opts = { ...(payload?.options || {}), _inWorker: true };
        const result = await collectTokenHistoryCoreAsync(opts, {
          livePlanStatus: payload?.livePlanStatus ?? null,
          prevAccountEmail: payload?.prevAccountEmail ?? null,
          prevArchiveSig: payload?.prevArchiveSig ?? null
        });
        parentPort.postMessage({ id, ok: true, result });
      } else if (cmd === 'recordModelCalls') {
        const opts = { ...(payload?.options || {}), _inWorker: true };
        const result = recordModelCalls(payload?.newCalls || [], opts);
        // createRecordResult 附带 valueOf 函数，跨 Worker 边界时须剥离函数属性避免 StructuredClone 抛 DataCloneError
        const plainResult = {
          ok: result ? result.ok !== false : false,
          changed: Boolean(result && result.changed),
          ...(result?.error ? { error: result.error } : {}),
          ...(result?.phase ? { phase: result.phase } : {}),
          ...(result?.code ? { code: result.code } : {})
        };
        parentPort.postMessage({ id, ok: true, result: plainResult });
      } else if (cmd === 'collectSessionTimeline') {
        const opts = { ...(payload?.options || {}), _inWorker: true };
        const result = await collectSessionTimelineCoreAsync(payload?.cascadeId || '', opts);
        parentPort.postMessage({ id, ok: true, result });
      } else {
        throw new Error(`Unknown collector worker command: ${cmd}`);
      }
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
    } finally {
      for (const [k, oldV] of Object.entries(prevEnv)) {
        if (oldV === undefined) delete process.env[k];
        else process.env[k] = oldV;
      }
    }
  });
}

function collectTokenHistory(options = {}) {
  const scopeKey = getEffectiveScanScopeKey(options);
  const canCacheByScope = !options.fs && !options.hostFetcher && !options.customPlan;
  // 同步封装：如果缓存可用直接返回，否则启动异步刷新并返回缓存或空壳
  if (!options.force && canCacheByScope && cachedTokenHistory && cachedTokenHistoryScope === scopeKey && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  // 触发异步更新
  void collectTokenHistoryAsync(options);
  return (cachedTokenHistory && cachedTokenHistoryScope === scopeKey) ? cachedTokenHistory : {
    schemaVersion: PROJECT_VERSION,
    version: PROJECT_VERSION,
    loading: true,
    updatedAt: '',
    firstUseDate: null,
    planStatus: parseUserPlanStatus(null),
    costEstimate: { pricedCostUSD: 0, coveragePercent: 0, byModel: {} },
    summary: { grandTotalTokens: 0, todayTokens: 0, monthTokens: 0, yearTokens: 0, totalConversations: 0, activeDaysCount: 0 },
    quotaUsageCoverageStartMs: null,
    quotaUsageAccounting: 'raw_input_cache_output',
    recentModelUsage: [],
    dailyMap: {},
    dailyMapBySource: { all: {}, desktop: {}, cli: {} }
  };
}

// ============================================================================
// 一键启动 CLI 模式已抽离至 meter-cli-launcher.js，当前文件保持完全兼容导出
// ============================================================================

// ============================================================================
// 本地 live-runtime 同步与 Node 运行时解析（100% 零外网连接）
// ============================================================================

function resolveNodeRuntime() {
  const isElectron = Boolean(process.versions && process.versions.electron);
  if (isElectron) {
    return {
      runtime: process.execPath,
      args: [],
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      isElectron: true
    };
  }
  const cleanEnv = Object.assign({}, process.env);
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  return {
    runtime: process.execPath || 'node',
    args: [],
    env: cleanEnv,
    isElectron: false
  };
}

const LIVE_RUNTIME_FILES = [
  'package.json',
  'cli.js',
  'install.js',
  'restore.js',
  'live-host.js',
  'local-api.js',
  'meter-main.js',
  'meter-core.js',
  'meter-renderer.js',
  'meter-collector.js',
  'meter-storage.js',
  'meter-cli-launcher.js',
  'attachment_scan.py',
  'asar-engine.js',
  'modules-config.js',
  'modular-installer.js'
];

function getLiveRuntimeDir(customStateDir = null) {
  const { getStateDir } = require('./asar-engine');
  const stateDir = customStateDir || getStateDir();
  return path.join(stateDir, 'live-runtime');
}

function syncLiveRuntimeBundle(sourceDir, options = {}) {
  try {
    if (!sourceDir || !fs.existsSync(path.join(sourceDir, 'live-host.js')) || !fs.existsSync(path.join(sourceDir, 'meter-core.js'))) {
      return null;
    }
    const { getStateDir } = require('./asar-engine');
    const stateDir = options.stateDir || getStateDir();
    if ((process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && !options.stateDir) {
      const lowerState = stateDir.toLowerCase();
      const lowerTmp = os.tmpdir().toLowerCase();
      if (!lowerState.includes(lowerTmp)) {
        return null;
      }
    }
    const targetDir = getLiveRuntimeDir(stateDir);
    fs.mkdirSync(targetDir, { recursive: true });
    let copiedCount = 0;
    for (const rel of LIVE_RUNTIME_FILES) {
      const src = path.join(sourceDir, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(targetDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const tmpDst = `${dst}.tmp-${process.pid}-${Date.now()}`;
      fs.copyFileSync(src, tmpDst);
      fs.renameSync(tmpDst, dst);
      copiedCount++;
    }
    let pkgVersion = options.version || null;
    try {
      if (!pkgVersion && fs.existsSync(path.join(sourceDir, 'package.json'))) {
        pkgVersion = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8')).version || null;
      }
    } catch {}
    safeWriteJsonSync(path.join(targetDir, '.runtime-manifest.json'), {
      version: pkgVersion || PROJECT_VERSION,
      copiedCount,
      updatedAt: new Date().toISOString()
    });
    return targetDir;
  } catch {
    return null;
  }
}

module.exports = {
  sanitizeCascadeModelConfig,
  parseAvailableModelsResponse,
  extractObservedModelInfoFromSteps,
  mergeModelCapabilitiesIntoConfigs,
  fetchUserStatusFromHost,
  fetchQuotaSnapshotFromHost,
  buildAccountScopeKey,
  resetQuotaHostCacheForTest,
  collect,
  collectTokenHistory,
  collectTokenHistoryAsync,
  getEffectiveScanScopeKey,
  buildSqliteImmutableUri,
  extractStepModelsFromGenMetadataBlob,
  extractStepMetaFromGenMetadataBlob,
  extractTrajectoryBlobMeta,
  loadConversationDbMeta,
  loadStepModelMapFromSqlite,
  backfillMissingModelsFromConversationDb,
  collectSessionTimelineCoreAsync,
  collectSessionTimelineAsync,
  scanFiles,
  pythonScan,
  resolvePython,
  isCompanionOrTempFile,
  formatLocalDateKey,
  recordModelCalls,
  recordModelCallsAsync,
  syncAccountLedgerPartitions,
  summarizeAccountWindowUsage,
  loadPricingLedger,
  savePricingLedger,
  getPricingLedgerPath,
  isSyntheticCall,
  quarantineSyntheticCalls,
  getCustomPlanPath,
  sanitizeAccountPlanEntry,
  loadCustomPlanSettings,
  saveCustomPlanSettings,
  saveCustomPlanSettingsDetailed,
  setCustomPlanForAccount,
  clearCustomPlanForAccount,
  resolveAccountCustomPlan,
  getPluginSettings,
  savePluginSettings,
  sanitizeTopbarPills,
  sanitizeUiPreferences,
  resolveCliExecutable,
  resolveCliWorkspace,
  buildCliSpawnEnv,
  launchCliSession,
  LIVE_RUNTIME_FILES,
  getLiveRuntimeDir,
  syncLiveRuntimeBundle,
  resolveNodeRuntime
};
