'use strict';
/**
 * 零依赖纯 Node.js 渲染层构建脚本 (build-renderer.js)
 *
 * 职责：
 * 将 src/renderer/ 下按职责拆分的子模块：
 *  - styles.css (纯 CSS 样式定义)
 *  - template.html (Shadow DOM 结构模板)
 *  - i18n.js (插件面板内简/繁/英词库与翻译引擎)
 *  - context-budget-engine.js (上下文窗口与额度预算纯函数引擎)
 *  - colors.js (外观主题模式、五套色板预设与顶栏胶囊显隐控制)
 *  - dropdown.js (自定义下拉控制器与纯美金月度订阅支出设置)
 *  - popover-router.js (一对一专属浮层状态路由、共享设置页、重启确认与外部点击/ESC 关闭)
 *  - topbar-dock.js (宿主标题栏停靠、原生窗口控制区预留、响应式收缩与物理像素对齐定位)
 *  - context-view.js (当前会话上下文窗口、最近调用卡片、会话时间线、附件扫描与窗口规格看板)
 *  - speed-view.js (实时流式生成速度评估、顶栏速度徽章与跨模型速度对比图表)
 *  - tokens-view.js (累计 Token 用量、模型分布、API 价值折算与历史水位增量入账)
 *  - quota-view.js (模型额度看板、套餐详情、共享额度池、动态进度环与定时刷新)
 *  - heatmap.js (热力图网格、周/月/年/累计视图与错误诊断展示映射)
 *  - main.js (外层 IIFE 壳层、热重载状态继承、共享状态声明、轮询主循环、销毁与测试接口)
 * 组合输出至根目录的 meter-renderer.js；修改渲染层时以 src/renderer 为准。
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src', 'renderer');
const targetFile = path.join(rootDir, 'meter-renderer.js');

const TRUNCATION_PATTERN = /truncated for diff preview/i;

/**
 * 检查源码文件是否混入编辑器/工具预览截断标记；
 * 一旦发现立即抛出带准确文件路径与行号的错误中止构建，绝不自动覆盖源码或写入产物。
 */
function assertNoTruncationMarker(filePath, content) {
  const match = TRUNCATION_PATTERN.exec(content);
  if (!match) return;
  const idx = match.index;
  const prefix = content.slice(0, idx);
  const lines = prefix.split(/\r?\n/);
  const lineNum = lines.length;
  const colNum = lines[lines.length - 1].length + 1;
  const err = new Error(
    `[构建中止] 检测到源码截断标记 (truncated for diff preview): ${filePath}:${lineNum}:${colNum}。已保留现场文件与未提交修改，请先备份并比较后再执行独立恢复。`
  );
  err.code = 'ERR_SOURCE_TRUNCATED';
  err.filePath = filePath;
  err.line = lineNum;
  err.column = colNum;
  throw err;
}

function readVerifiedRendererSource(dir, fileName) {
  const fullPath = path.join(dir, fileName);
  const raw = fs.readFileSync(fullPath, 'utf8');
  assertNoTruncationMarker(fullPath, raw);
  return raw;
}

function resolveDomainModuleDir(effSrcDir, fileName) {
  if (effSrcDir !== srcDir && !fs.existsSync(path.join(effSrcDir, fileName))) {
    return srcDir;
  }
  return effSrcDir;
}

function indentModule(raw) {
  return '  ' + raw.trim();
}

function buildRenderer(options = {}) {
  const effRootDir = options.rootDir ? path.resolve(options.rootDir) : rootDir;
  const effSrcDir = options.srcDir ? path.resolve(options.srcDir) : path.join(effRootDir, 'src', 'renderer');
  const effTargetFile = options.targetFile ? path.resolve(options.targetFile) : path.join(effRootDir, 'meter-renderer.js');

  const pkg = JSON.parse(fs.readFileSync(path.join(effRootDir, 'package.json'), 'utf8'));
  const meterVersion = pkg.version || '0.8.5';

  const styles = readVerifiedRendererSource(effSrcDir, 'styles.css').trim();
  let template = readVerifiedRendererSource(effSrcDir, 'template.html').trim();
  template = template.replace(/<span id="v">v[^<]*<\/span>/g, `<span id="v">v${meterVersion}</span>`);

  const colors = readVerifiedRendererSource(effSrcDir, 'colors.js');
  const i18n = readVerifiedRendererSource(effSrcDir, 'i18n.js');
  const budgetEngine = readVerifiedRendererSource(effSrcDir, 'context-budget-engine.js');
  const dropdown = readVerifiedRendererSource(effSrcDir, 'dropdown.js');
  const heatmap = readVerifiedRendererSource(effSrcDir, 'heatmap.js');
  let mainTemplate = readVerifiedRendererSource(effSrcDir, 'main.js');

  const popoverRouter = readVerifiedRendererSource(resolveDomainModuleDir(effSrcDir, 'popover-router.js'), 'popover-router.js');
  const topbarDock = readVerifiedRendererSource(resolveDomainModuleDir(effSrcDir, 'topbar-dock.js'), 'topbar-dock.js');
  const contextView = readVerifiedRendererSource(resolveDomainModuleDir(effSrcDir, 'context-view.js'), 'context-view.js');
  const speedView = readVerifiedRendererSource(resolveDomainModuleDir(effSrcDir, 'speed-view.js'), 'speed-view.js');
  const tokensView = readVerifiedRendererSource(resolveDomainModuleDir(effSrcDir, 'tokens-view.js'), 'tokens-view.js');
  const quotaView = readVerifiedRendererSource(resolveDomainModuleDir(effSrcDir, 'quota-view.js'), 'quota-view.js');

  // 注入或同步构建期版本常量
  const versionConst = `  const METER_VERSION = '${meterVersion}';\n`;
  if (mainTemplate.includes('const METER_VERSION =')) {
    mainTemplate = mainTemplate.replace(/const METER_VERSION = '[^']*';/, `const METER_VERSION = '${meterVersion}';`);
  } else {
    mainTemplate = mainTemplate.replace(/\(function \(\) \{/, `(function () {\n${versionConst}`);
  }

  const domString = `  shadow.innerHTML = \`<style>\n    ${styles.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${')}\n  </style>\n\n  ${template.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${')}\`;`;

  const output = mainTemplate
    .replace('  /* @INSERT_STYLES_AND_TEMPLATE */', () => domString)
    .replace('  /* @INSERT_I18N_MODULE */', () => indentModule(i18n))
    .replace('  /* @INSERT_BUDGET_ENGINE_MODULE */', () => indentModule(budgetEngine))
    .replace('  /* @INSERT_COLORS_MODULE */', () => indentModule(colors))
    .replace('  /* @INSERT_DROPDOWN_MODULE */', () => indentModule(dropdown))
    .replace('  /* @INSERT_POPOVER_ROUTER_MODULE */', () => indentModule(popoverRouter))
    .replace('  /* @INSERT_TOPBAR_DOCK_MODULE */', () => indentModule(topbarDock))
    .replace('  /* @INSERT_CONTEXT_VIEW_MODULE */', () => indentModule(contextView))
    .replace('  /* @INSERT_SPEED_VIEW_MODULE */', () => indentModule(speedView))
    .replace('  /* @INSERT_TOKENS_VIEW_MODULE */', () => indentModule(tokensView))
    .replace('  /* @INSERT_QUOTA_VIEW_MODULE */', () => indentModule(quotaView))
    .replace('  /* @INSERT_HEATMAP_MODULE */', () => indentModule(heatmap));

  const unreplacedMatch = /\/\* @INSERT_[A-Z0-9_]+ \*\//.exec(output);
  if (unreplacedMatch) {
    throw new Error(`[构建中止] 存在未替换的模块插入标记: ${unreplacedMatch[0]}`);
  }

  fs.writeFileSync(effTargetFile, output, 'utf8');
  console.log(`[构建成功] 渲染层构建完成: ${effTargetFile} (v${meterVersion}, ${Buffer.byteLength(output, 'utf8')} 字节)`);
}

if (require.main === module) {
  buildRenderer();
}

module.exports = { buildRenderer, assertNoTruncationMarker, readVerifiedRendererSource };
