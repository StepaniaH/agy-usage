'use strict';
/**
 * Antigravity 纯只读安全版模块注入与清洗调度引擎 (modular-installer.js)
 * 职责：
 * 1. 管理 ContextMeter 只读看板的最小化主进程与 Preload 桥接注入；
 * 2. 不注入任何代理改写、不注入客户端 DOM 汉化、不注入主世界请求装饰器；
 * 3. 安装与卸载共用原位手术刀清洗逻辑，兼容清理历史旧版遗留的 Proxy / Chinese / Decorator 标记；
 * 4. 每次改写均通过 vm.Script 进行前置与后置 JavaScript 语法校验。
 */

const vm = require('vm');

const TAGS = {
  // 保留历史标签定义以便升级或还原时精准清洗旧版遗留代码块
  PROXY_START: '// --- Antigravity Proxy NoTun Injection Start ---',
  PROXY_END: '// --- Antigravity Proxy NoTun Injection End ---',
  CHINESE_START: '// --- Antigravity Chinese Localization Injection Start ---',
  CHINESE_END: '// --- Antigravity Chinese Localization Injection End ---',
  METER_UTILS_START: '// --- Antigravity Context Meter utils Injection Start ---',
  METER_UTILS_END: '// --- Antigravity Context Meter utils Injection End ---',
  METER_PRELOAD_START: '// --- Antigravity Context Meter preload Injection Start ---',
  METER_PRELOAD_END: '// --- Antigravity Context Meter preload Injection End ---'
};

/**
 * 校验 JavaScript 脚本语法合法性
 */
function validateSyntax(code, filename = 'script.js') {
  if (typeof code !== 'string') return false;
  try {
    new vm.Script(code, { filename });
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成上下文监控模块的 utils 挂载代码（纯只读挂载，不含代理环境篡改或 Windows 菜单栏修改）
 */
function generateMeterUtilsCode() {
  const storageFallbackLine = '    if (storageManager) globalThis.__agDefaultStorageManager = storageManager; else if (globalThis.__agDefaultStorageManager) storageManager = globalThis.__agDefaultStorageManager;';
  const hookLine = '    require("./meter-main").installContextMeter(win);\n';
  return {
    storageFallback: `\n${storageFallbackLine}`,
    windowLoadHook: `${TAGS.METER_UTILS_START}\n${hookLine}${TAGS.METER_UTILS_END}\n`,
    focusHook: `\n        try { require("./meter-main").installContextMeter(wins[0]); require("./meter-main").ensureMeterInjected(wins[0], { force: true }); } catch {}`,
    createHook: `\n        try { require("./meter-main").installContextMeter(_mWin); require("./meter-main").ensureMeterInjected(_mWin, { force: true }); } catch {}`
  };
}

/**
 * 生成上下文监控模块的 preload 注入代码（纯只读窄桥接，不含 executeJavaScript 主世界请求装饰器）
 */
function generateMeterPreloadCode() {
  return `\n${TAGS.METER_PRELOAD_START}
// Context Meter: narrow read-only observability IPC bridge
electron_1.contextBridge.exposeInMainWorld("contextMeterAPI", { getRuntimeInfo: () => electron_1.ipcRenderer.invoke("context-meter:runtime-info"), scan: (id, force) => electron_1.ipcRenderer.invoke("context-meter:scan", id, force === true), getTokenHistory: (force) => electron_1.ipcRenderer.invoke("context-meter:token-history", force === true), getSessionTimeline: (id, opts) => electron_1.ipcRenderer.invoke("context-meter:session-timeline", id, opts), getQuota: (opts) => electron_1.ipcRenderer.invoke("context-meter:get-quota", opts), recordCalls: (calls) => electron_1.ipcRenderer.invoke("context-meter:record-calls", calls), getSettings: (opts) => electron_1.ipcRenderer.invoke("context-meter:get-settings", opts), saveSettings: (payload) => electron_1.ipcRenderer.invoke("context-meter:save-settings", payload), launchCli: (opts) => electron_1.ipcRenderer.invoke("context-meter:launch-cli", opts), restartHost: () => electron_1.ipcRenderer.invoke("context-meter:restart-host") });
${TAGS.METER_PRELOAD_END}\n`;
}

/**
 * 原位手术刀清洗 utils.js（同时清除历史旧版可能残留的 Proxy / 菜单栏注入）
 */
function cleanUtilsSource(source) {
  if (!source || typeof source !== 'string') return source;
  let code = source;

  const proxyRegex = new RegExp(`\\n?\\s*${TAGS.PROXY_START}[\\s\\S]*?${TAGS.PROXY_END}\\n?`, 'g');
  code = code.replace(proxyRegex, '\n');

  const meterRegex = new RegExp(`\\n?\\s*${TAGS.METER_UTILS_START}[\\s\\S]*?${TAGS.METER_UTILS_END}\\n?`, 'g');
  code = code.replace(meterRegex, '\n');

  const storageFallbackLine = '    if (storageManager) globalThis.__agDefaultStorageManager = storageManager; else if (globalThis.__agDefaultStorageManager) storageManager = globalThis.__agDefaultStorageManager;';
  code = code
    .replace(/\s*try\s*\{\s*require\("\.\/meter-main"\)\.ensureProxyEnvironment\(process\.env\);\s*\}\s*catch\s*\{\}\r?\n?/g, '')
    .replace(/\s*try\s*\{\s*require\("\.\/meter-main"\)\.ensureProxyEnvironment\(env\);\s*\}\s*catch\s*\{\}\r?\n?/g, '')
    .replace('\n' + storageFallbackLine, '')
    .replace(/\s*require\("\.\/meter-main"\)\.installContextMeter\(win\);?\r?\n?/g, '')
    .replace(/\n\s*try\s*\{\s*require\("\.\/meter-main"\)\.installContextMeter\(wins\[0\]\);[\s\S]*?\}\s*catch\s*\{\}/g, '')
    .replace(/const _mWin = createWindow\(`\$\{constants_1\.WINDOW_ORIGIN\}:\$\{port\}\/`\);\s*\n\s*try\s*\{\s*require\("\.\/meter-main"\)\.installContextMeter\(_mWin\);[\s\S]*?\}\s*catch\s*\{\}/g, 'createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);')
    .replace(/\n {8}autoHideMenuBar:\s*true,/, '');

  return code;
}

/**
 * 原位手术刀清洗 preload.js（同时清除历史旧版可能残留的汉化与装饰器标记）
 */
function cleanPreloadSource(source) {
  if (!source || typeof source !== 'string') return source;
  let code = source;

  const chineseRegex = new RegExp(`\\n?\\s*${TAGS.CHINESE_START}[\\s\\S]*?${TAGS.CHINESE_END}\\n?`, 'g');
  code = code.replace(chineseRegex, '\n');

  const meterRegex = new RegExp(`\\n?\\s*${TAGS.METER_PRELOAD_START}[\\s\\S]*?${TAGS.METER_PRELOAD_END}\\n?`, 'g');
  code = code.replace(meterRegex, '\n');

  const legacyMeterRegex = /\r?\n?\/\/ Context Meter v2: narrow read-only conversation scan API\r?\nelectron_1\.contextBridge\.exposeInMainWorld\("contextMeterAPI",\s*\{[\s\S]*?\}\);\r?\n?/g;
  code = code.replace(legacyMeterRegex, '\n');

  return code;
}

/**
 * 校验清洗后的 utils 结构合法性与 JavaScript 语法
 */
function verifyCleanStructure(cleanUtils) {
  if (!cleanUtils) return false;
  if (cleanUtils.includes('installContextMeter')) return false;
  if (cleanUtils.includes(TAGS.PROXY_START) || cleanUtils.includes(TAGS.METER_UTILS_START)) return false;
  const marker = '    void win.loadURL(url);';
  const setupNodeMarker = 'function setupNodeWrapper(env) {';
  const structuralOk = cleanUtils.split(marker).length === 2 && cleanUtils.includes(setupNodeMarker);
  return structuralOk && validateSyntax(cleanUtils, 'dist/utils.js');
}

module.exports = {
  TAGS,
  validateSyntax,
  generateMeterUtilsCode,
  generateMeterPreloadCode,
  cleanUtilsSource,
  cleanPreloadSource,
  verifyCleanStructure
};
