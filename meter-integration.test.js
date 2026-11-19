'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = require('./meter-core');
const {
  loadCustomPlanSettings,
  savePluginSettings,
  getPluginSettings,
  launchCliSession
} = require('./meter-collector');

const rendererSource = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');

test('月度实付 USD 与外观偏好（主题/精选配色/顶栏指标）多轮轮询防回退', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-cases-1-'));
  try {
    const email = 'developer@enterprise.invalid';
    const saveRes = savePluginSettings({
      email,
      customPlan: {
        monthlySpendUSD: 15.5
      },
      themeMode: 'dark',
      heatPreset: 'ocean',
      topbarPills: { quota: true, context: true, speed: false, tokens: true, cli: false }
    }, { agDir: tmpDir });

    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.planStatus.currency, 'USD');
    assert.equal(saveRes.planStatus.actualPricePaid, 15.5);

    for (let cycle = 1; cycle <= 3; cycle++) {
      const polled = getPluginSettings({ agDir: tmpDir, email });
      assert.equal(polled.ok, true);
      assert.equal(polled.customPlan.currency, 'USD');
      assert.equal(polled.customPlan.actualPricePaid, 15.5);
      assert.equal(polled.themeMode, 'dark');
      assert.equal(polled.heatPreset, 'ocean');
      assert.equal(polled.topbarPills.speed, false);
      assert.equal(polled.topbarPills.cli, false);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('快速连续修改月度实付 USD 以最新落盘值为准', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-cases-2-'));
  try {
    const email = 'concurrency@example.invalid';
    const op1 = savePluginSettings({
      email,
      customPlan: { monthlySpendUSD: 27.99 }
    }, { agDir: tmpDir });

    const op2 = savePluginSettings({
      email,
      customPlan: { monthlySpendUSD: 19.99 }
    }, { agDir: tmpDir });

    assert.equal(op1.ok, true);
    assert.equal(op2.ok, true);

    const finalState = getPluginSettings({ agDir: tmpDir, email });
    assert.equal(finalState.customPlan.currency, 'USD');
    assert.equal(finalState.customPlan.actualPricePaid, 19.99);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('虚构账号独立隔离、初期无账号回退与清除月度实付', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-cases-3-'));
  try {
    const accA = 'alice@company.invalid';
    const accB = 'bob@university.invalid';

    savePluginSettings({
      email: accA,
      customPlan: { monthlySpendUSD: 19.99 }
    }, { agDir: tmpDir });

    const resBInitial = getPluginSettings({ agDir: tmpDir, email: accB });
    assert.equal(resBInitial.customPlan, null, '新账号 B 初始应无配置，不得窃取账号 A 的设置');

    savePluginSettings({
      email: accB,
      customPlan: { monthlySpendUSD: 0 }
    }, { agDir: tmpDir });

    const resA = getPluginSettings({ agDir: tmpDir, email: accA });
    const resB = getPluginSettings({ agDir: tmpDir, email: accB });
    assert.equal(resA.customPlan.actualPricePaid, 19.99);
    assert.equal(resB.customPlan.actualPricePaid, 0);

    // 启动初期尚无邮箱 (email: null) 验证可回退到 lastAccount
    const resStartup = getPluginSettings({ agDir: tmpDir, email: null });
    assert.ok(resStartup.customPlan !== null);

    // 清除账号 A 配置
    savePluginSettings({ email: accA, clearPlan: true }, { agDir: tmpDir });
    assert.equal(getPluginSettings({ agDir: tmpDir, email: accA }).customPlan, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('无保存桥接或写盘失败时无假成功反馈', () => {
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fail-dir-'));
  fs.mkdirSync(path.join(badDir, 'custom_plan_v1.json'), { recursive: true });
  try {
    const failRes = savePluginSettings({
      email: 'fail@test.invalid',
      customPlan: { monthlySpendUSD: 19.99 }
    }, { agDir: badDir });

    assert.equal(failRes.ok, false);
    assert.match(failRes.error, /目录|失败/);
  } finally {
    fs.rmSync(badDir, { recursive: true, force: true });
  }
});

test('$0 免费/包含权益在 resolveEffectivePlanStatus 中准确识别为 isZeroExtraCost', () => {
  const customGift = {
    isZeroExtraCost: true,
    actualPricePaid: 0
  };

  const effective = core.resolveEffectivePlanStatus(null, customGift);
  assert.equal(effective.isZeroExtraCost, true);
  assert.equal(effective.actualPricePaid, 0);
  assert.equal(effective.currency, 'USD');
  assert.match(effective.priceRangeNote, /\$0/);
});

// ============================================================================
// 6. 验证 CLI 启动环境修正：移除了 NO_COLOR，注入了 COLORTERM
// ============================================================================
test('插件交互式 CLI 子进程环境配置清除 NO_COLOR 并保留色彩支持', async () => {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-env-'));
  const cliPath = path.join(cliDir, 'agy');
  fs.writeFileSync(cliPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  const prevNoColor = process.env.NO_COLOR;
  const prevTerm = process.env.TERM;
  const prevColorTerm = process.env.COLORTERM;

  try {
    process.env.NO_COLOR = '1';
    process.env.TERM = 'dumb';
    delete process.env.COLORTERM;

    const dryRun = await launchCliSession({
      cliPath,
      cwd: cliDir,
      dryRun: true,
      model: 'gemini-3.8-flash-high'
    });

    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.env.NO_COLOR, undefined, 'CLI 子进程环境必须清除 NO_COLOR');
    assert.equal(dryRun.env.COLORTERM, 'truecolor', 'CLI 子进程 COLORTERM 必须为 truecolor');
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
    if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor; else delete process.env.NO_COLOR;
    if (prevTerm !== undefined) process.env.TERM = prevTerm; else delete process.env.TERM;
    if (prevColorTerm !== undefined) process.env.COLORTERM = prevColorTerm; else delete process.env.COLORTERM;
  }
});

// ============================================================================
// 8. 验证渲染层 CLI 按钮按压即刻回弹、启动防重入与状态恢复
// ============================================================================
test('渲染层顶部 CLI 按钮解耦按压反馈与启动加载态，松开即刻回弹且防重入', () => {
  const src = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'main.js'), 'utf8');
  assert.ok(src.includes('data-pressed'), '必须支持 data-pressed 即刻按压反馈');
  assert.ok(src.includes('pointerdown'), '必须监听 pointerdown 触发按压态');
  assert.ok(src.includes('pointerup'), '必须监听 pointerup 立即释放按压态');
  assert.ok(src.includes('pointercancel'), '必须监听 pointercancel 释放按压态');
  assert.ok(src.includes('mouseleave'), '必须监听 mouseleave 释放按压态');
  assert.ok(src.includes('blur'), '必须监听 blur 释放按压态');
  assert.ok(src.includes('cliLaunchBusy'), '必须包含 cliLaunchBusy 防快速重复点击');
  assert.ok(src.includes('showCliToast'), '启动失败或启动中必须提供明确可读提示');

  const css = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'styles.css'), 'utf8');
  assert.ok(css.includes('#badge-cli:active') || css.includes('[data-pressed="true"]'), '样式必须包含轻量按压缩放与高亮反馈');
  assert.ok(!css.includes('#badge-cli[data-busy="true"]{\n      opacity:0.65;'), '不能仅将整个按钮变灰代替启动过程');
});

// ============================================================================
// 10. 单元测试验证：主窗口关闭拦截判定与多路径边界（辅助窗口放行、多窗口关闭、后台运行设置尊重与退出放行）
// ============================================================================
test('单元测试：主窗口关闭拦截判定与多路径边界（辅助窗口放行、多窗口关闭、后台运行设置尊重与退出放行）', () => {
  const { shouldInterceptWindowClose, setAppQuitting } = require('./meter-main');

  const mainWin1 = { isVisible: () => true, isDestroyed: () => false };
  const mainWin2 = { isVisible: () => true, isDestroyed: () => false };
  const auxPopupWindow = { isVisible: () => true, isDestroyed: () => false };

  try {
    setAppQuitting(false);

    // 路径 1: 唯一的已确认主会话窗口 + 允许后台运行 -> 拦截并隐藏保留会话
    const shouldHide = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => true,
      getHubWindows: () => [mainWin1]
    });
    assert.equal(shouldHide, true, '唯一的主会话窗口在后台常驻开启时必须拦截隐藏');

    // 路径 2: 辅助/弹窗窗口（不在 getHubWindows 列表中） -> 绝不拦截，避免影响辅助窗口
    const auxResult = shouldInterceptWindowClose(auxPopupWindow, {
      isBackgroundEnabled: () => true,
      getHubWindows: () => [mainWin1]
    });
    assert.equal(auxResult, false, '辅助窗口/弹窗不在主窗口列表中，必须放行正常关闭');

    // 路径 3: 多主窗口存在时，关闭其中一个窗口 -> 放行关闭辅助多开窗口
    const multiWinResult = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => true,
      getHubWindows: () => [mainWin1, mainWin2]
    });
    assert.equal(multiWinResult, false, '存在其他可见主窗口时，放行关闭多开窗口');

    // 路径 4: 宿主后台常驻设置明确关闭 -> 尊重宿主设置，放行关闭
    const noBgResult = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => false,
      getHubWindows: () => [mainWin1]
    });
    assert.equal(noBgResult, false, '宿主未开启后台常驻时，必须放行关闭退出');

    // 路径 5: 获取窗口列表或读取设置失败/异常 -> 绝不默认隐藏，放行正常关闭
    const errorResult1 = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => { throw new Error('settings read failed'); },
      getHubWindows: () => [mainWin1]
    });
    assert.equal(errorResult1, false, '读取设置异常时绝不默认隐藏，必须安全放行');

    const errorResult2 = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => true,
      getHubWindows: () => { throw new Error('getHubWindows failed'); }
    });
    assert.equal(errorResult2, false, '获取窗口列表异常时绝不默认隐藏，必须安全放行');

    // 路径 6: 应用退出中（before-quit / will-quit） -> 放行关闭彻底释放
    setAppQuitting(true);
    const quittingResult = shouldInterceptWindowClose(mainWin1, {
      isBackgroundEnabled: () => true,
      getHubWindows: () => [mainWin1]
    });
    assert.equal(quittingResult, false, '应用退出状态下严禁拦截，确保窗口正常销毁退出');
  } finally {
    setAppQuitting(false);
  }
});

// ============================================================================
// 11. 单元测试验证：BaseWindow / WebContentsView 架构适配与 WebContents 严格探测
// ============================================================================
test('单元测试：BaseWindow / WebContentsView 架构适配与 WebContents 严格探测（PR #6 整合）', async () => {
  const { getWindowWebContents, installContextMeter } = require('./meter-main');

  // 场景 1: 传统 BrowserWindow 具备直接 webContents
  const fakeDirectWc = { isDestroyed: () => false, getURL: () => 'https://127.0.0.1:49999/' };
  const mockBrowserWin = { webContents: fakeDirectWc, isDestroyed: () => false };
  assert.equal(getWindowWebContents(mockBrowserWin), fakeDirectWc, '传统 BrowserWindow 必须直接返回 webContents');

  // 场景 2: BaseWindow 具备 contentView.children，包含遮罩 curtainView 与主 hubWcv
  const curtainWc = { isDestroyed: () => false, getURL: () => 'data:text/html,<!doctype html>...' };
  const hubWc = { isDestroyed: () => false, getURL: () => 'https://127.0.0.1:51234/' };
  const mockBaseWin = {
    isDestroyed: () => false,
    contentView: {
      children: [
        { webContents: curtainWc },
        { webContents: hubWc }
      ]
    }
  };
  const resolvedWc = getWindowWebContents(mockBaseWin);
  assert.equal(resolvedWc, hubWc, 'BaseWindow 必须精准匹配本地主服务 hubWcv，坚决排除 data: 协议的遮罩 curtainView');

  // 场景 3: BaseWindow 创建初期尚未挂载 WebContentsView，installContextMeter 延迟安全探测与清理
  let closedListener = null;
  const mockPendingWin = {
    isDestroyed: () => false,
    contentView: { children: [] },
    on() {},
    once(event, fn) {
      if (event === 'closed') closedListener = fn;
    }
  };
  installContextMeter(mockPendingWin);

  // 模拟窗口在挂载完成前被关闭
  if (typeof closedListener === 'function') {
    assert.doesNotThrow(() => closedListener(), '窗口关闭时清理探测定时器绝不抛错');
  }
});
