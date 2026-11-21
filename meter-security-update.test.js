'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 设置隔离环境：避免 tryHotInject 探测宿主真实端口超时
const isolatedAppData = path.join(os.tmpdir(), 'ag-meter-isolated-appdata');
fs.mkdirSync(isolatedAppData, { recursive: true });
process.env.APPDATA = isolatedAppData;
process.env.AG_METER_TEST_MODE = '1';

const { builtinAsar, loadAsarEngine } = require('./asar-engine');
const asar = loadAsarEngine();
const { install, tryHotInject } = require('./install');
const { restore } = require('./restore');
const {
  resolveNodeRuntime
} = require('./meter-collector');
const core = require('./meter-core');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 辅助写入可写流并等待完全落盘
 */
function writeStreamAsync(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    stream.end(chunk);
  });
}

/**
 * 辅助函数：快速在临时目录生成一个合法的 mock ASAR
 */
async function createMockHostAsar(dir, version = '0.1.0', utilsContent = null) {
  const rand = Math.random().toString(36).slice(2, 8);
  const src = path.join(dir, `mock-src-${version}-${rand}`);
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'antigravity', version }), 'utf8');

  const defaultUtils = `"use strict";
function setupNodeWrapper(env) {
}
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
}
`;
  fs.writeFileSync(path.join(src, 'dist', 'utils.js'), utilsContent || defaultUtils, 'utf8');
  fs.writeFileSync(path.join(src, 'dist', 'preload.js'), '// mock preload\nconst electron_1 = require("electron");\n', 'utf8');

  const asarPath = path.join(dir, `app-${version}-${rand}.asar`);
  await builtinAsar.createPackageWithOptions(src, asarPath, {});
  try { fs.rmSync(src, { recursive: true, force: true }); } catch {}
  return asarPath;
}

// ============================================================================
// 问题 1 测试集：修复重新安装可能覆盖新版宿主的问题
// ============================================================================

test('安装安全性 1.1：宿主升级后重新安装，以新版宿主为打包基底，绝不覆盖降回旧版本', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-install-upgrade-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    // 1. 初始化旧版本宿主 0.1.0
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);

    // 2. 首次安装到 0.1.0
    const manifestV1 = await install({ path: targetAsar });
    assert.equal(manifestV1.version, '0.1.0');
    assert.ok(fs.existsSync(manifestV1.backup));
    assert.match(manifestV1.backup, /app-0\.1\.0-.*-base\.asar/);

    // 3. 模拟宿主自身升级到 0.2.0（ASAR 内容被宿主更新覆盖）
    const v2Path = await createMockHostAsar(tmpDir, '0.2.0');
    fs.copyFileSync(v2Path, targetAsar);
    const hostV2Sha = sha256(fs.readFileSync(targetAsar));
    assert.notEqual(hostV2Sha, manifestV1.patchedSha256);

    // 4. 用户再次运行安装
    const manifestV2 = await install({ path: targetAsar });

    // 验证：必须基于 0.2.0 打包，记录版本必须是 0.2.0，且备份也是 0.2.0
    assert.equal(manifestV2.version, '0.2.0', '重新安装后记录的版本必须是新宿主版本 0.2.0');
    assert.match(manifestV2.backup, /app-0\.2\.0-.*-base\.asar/);
    const installedPkg = JSON.parse(builtinAsar.extractFile(targetAsar, 'package.json').toString('utf8'));
    assert.equal(installedPkg.version, '0.2.0', '目标 ASAR 内 package.json 必须是 0.2.0，严禁降级回 0.1.0');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装安全性 1.2：正常重新安装（当前文件匹配已知补丁哈希时允许使用校验通过的原始备份）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-install-reinstall-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);

    // 首次安装
    const m1 = await install({ path: targetAsar });
    assert.equal(sha256(fs.readFileSync(targetAsar)), m1.patchedSha256);

    // 第二次重装：当前 ASAR 匹配 m1.patchedSha256
    const m2 = await install({ path: targetAsar });
    assert.equal(m2.version, '0.1.0');
    assert.equal(sha256(fs.readFileSync(targetAsar)), m2.patchedSha256);
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装安全性 1.3：安装记录目标路径不同，不选用旧记录备份', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-install-diffpath-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const asarA = path.join(tmpDir, 'appA.asar');
    const asarB = path.join(tmpDir, 'appB.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    const v2Path = await createMockHostAsar(tmpDir, '0.2.0');
    fs.copyFileSync(v1Path, asarA);
    fs.copyFileSync(v2Path, asarB);

    // 先安装到 A
    await install({ path: asarA });

    // 随后安装到 B（不同路径）
    const mB = await install({ path: asarB });
    assert.equal(mB.version, '0.2.0', '安装到路径 B 时必须以 B 自身为基底，不得使用 A 的旧备份');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装安全性 1.4：当前文件包含未知补丁痕迹且哈希不匹配安装记录时，明确报错拒绝安装以保持文件不变', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-install-unrecognized-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    // 创建一个包含未知补丁痕迹的 mock utils
    const unknownUtils = `"use strict";
function setupNodeWrapper(env) {
}
require("./meter-main").installContextMeter(win);
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
}
`;
    const asarPath = await createMockHostAsar(tmpDir, '0.1.0', unknownUtils);
    fs.copyFileSync(asarPath, targetAsar);
    const beforeSha = sha256(fs.readFileSync(targetAsar));

    // 执行安装，必须报错
    await assert.rejects(
      async () => { await install({ path: targetAsar }); },
      /当前 ASAR 包含未知的补丁修改痕迹且哈希不匹配安装记录/
    );

    const afterSha = sha256(fs.readFileSync(targetAsar));
    assert.equal(beforeSha, afterSha, '报错后必须保持当前文件绝对不变');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装安全性 1.5：接口签名不兼容时明确报错，保持原文件不变', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-install-incompatible-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    // 缺少 setupNodeWrapper 标记
    const incompatibleUtils = `"use strict";
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
}
`;
    const asarPath = await createMockHostAsar(tmpDir, '0.1.0', incompatibleUtils);
    fs.copyFileSync(asarPath, targetAsar);
    const beforeSha = sha256(fs.readFileSync(targetAsar));

    await assert.rejects(
      async () => { await install({ path: targetAsar }); },
      /Unexpected createWindow\/setupNodeWrapper/
    );

    const afterSha = sha256(fs.readFileSync(targetAsar));
    assert.equal(beforeSha, afterSha, '报错后当前文件未被修改');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装安全性 1.6：同版本不同安装目标的备份物理隔离，防止 restore 时将 A 的旧备份错误覆盖到 B', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-backup-isolation-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const asarA = path.join(tmpDir, 'appA.asar');
    const asarB = path.join(tmpDir, 'appB.asar');

    // 创建两份同为 0.1.0 但内部 utils 注释不同的 ASAR
    const utilsA = `"use strict";\n// Unique package A identifier\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager, options) {\n    void win.loadURL(url);\n}\n`;
    const utilsB = `"use strict";\n// Unique package B identifier\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager, options) {\n    void win.loadURL(url);\n}\n`;

    const dirA = path.join(tmpDir, 'mock-a');
    const dirB = path.join(tmpDir, 'mock-b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const vAPath = await createMockHostAsar(dirA, '0.1.0', utilsA);
    const vBPath = await createMockHostAsar(dirB, '0.1.0', utilsB);
    fs.copyFileSync(vAPath, asarA);
    fs.copyFileSync(vBPath, asarB);

    const origShaA = sha256(fs.readFileSync(asarA));
    const origShaB = sha256(fs.readFileSync(asarB));
    assert.notEqual(origShaA, origShaB, 'A 和 B 的原始 ASAR 内容必须不同');

    // 1. 先安装到 A
    const manifestA = await install({ path: asarA });
    assert.equal(manifestA.version, '0.1.0');

    // 2. 接着安装到 B（同版本 0.1.0 但不同目标路径）
    const manifestB = await install({ path: asarB });
    assert.equal(manifestB.version, '0.1.0');

    // 验证备份文件路径与名称已按目标路径隔离
    assert.notEqual(manifestA.backup, manifestB.backup, 'A 和 B 的 backup 路径必须物理隔离');
    assert.notEqual(manifestA.previousInstalledBackup, manifestB.previousInstalledBackup, 'A 和 B 的 previousInstalledBackup 必须物理隔离');

    // 3. 执行 restore()，此时系统 manifest 记录的是 B
    const restoreRes = await restore();
    assert.equal(restoreRes.restored, asarB);

    // 4. 关键验证：B 还原后内容必须严格等于 B 的原始包哈希，绝不等于 A 的原始包
    const restoredShaB = sha256(fs.readFileSync(asarB));
    assert.equal(restoredShaB, origShaB, 'B 还原后的内容必须严格等于 B 原始包');
    assert.notEqual(restoredShaB, origShaA, 'B 绝对不能被错误还原为 A 的内容');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 问题 2 测试集：修复卸载缺少当前文件归属校验的问题
// ============================================================================

test('卸载安全性 2.1：当前文件匹配 patchedSha256 且备份哈希正确时允许还原', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-ok-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    const origSha = sha256(fs.readFileSync(targetAsar));

    // 安装
    const manifest = await install({ path: targetAsar });
    assert.notEqual(sha256(fs.readFileSync(targetAsar)), origSha);

    // 卸载还原
    const res = await restore();
    assert.equal(res.restored, targetAsar);
    assert.equal(sha256(fs.readFileSync(targetAsar)), origSha, '还原后文件哈希必须恢复为原始备份哈希');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('卸载安全性 2.2：当前文件已经等于目标备份时，幂等返回 alreadyRestored: true', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-idempotent-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    // 第一次还原
    const res1 = await restore();
    assert.equal(res1.alreadyRestored, undefined);

    // 第二次重复还原：幂等返回
    const res2 = await restore();
    assert.equal(res2.alreadyRestored, true, '已还原状态下再次卸载必须幂等成功');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('卸载安全性 2.3：宿主已升级或文件被外部改变后，拒绝覆盖还原并说明原因', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-protect-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    // 模拟宿主在此期间升级了（文件内容变为新版本 0.2.0）
    const v2Path = await createMockHostAsar(tmpDir, '0.2.0');
    fs.copyFileSync(v2Path, targetAsar);
    const upgradedSha = sha256(fs.readFileSync(targetAsar));

    // 尝试执行 restore，必须被拒绝！
    await assert.rejects(
      async () => { await restore(); },
      /已被宿主升级、第三方补丁或其他操作改变.*拒绝覆盖还原以保护宿主文件/
    );

    // 校验文件保持未被破坏
    assert.equal(sha256(fs.readFileSync(targetAsar)), upgradedSha, '拒绝覆盖后宿主新文件未被篡改');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('卸载安全性 2.4：备份文件被损坏时拒绝还原，不修改当前文件', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-corrupt-backup-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    const m = await install({ path: targetAsar });

    // 破坏所有备份文件
    if (m.backup && fs.existsSync(m.backup)) fs.writeFileSync(m.backup, 'corrupted backup');
    if (m.previousInstalledBackup && fs.existsSync(m.previousInstalledBackup)) fs.writeFileSync(m.previousInstalledBackup, 'corrupted backup');
    const currentSha = sha256(fs.readFileSync(targetAsar));

    await assert.rejects(
      async () => { await restore(); },
      /Backup checksum mismatch; refusing restore/
    );

    assert.equal(sha256(fs.readFileSync(targetAsar)), currentSha, '备份损坏时当前目标文件保持不变');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('安装异常恢复 1.7：当前文件包含补丁痕迹且哈希与清单脱节，但存在合规原版备份时，自动安全采信原版备份重新安装', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-recovery-install-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    const origSha = sha256(fs.readFileSync(targetAsar));

    // 1. 初次正常安装
    const m1 = await install({ path: targetAsar });
    assert.equal(m1.originalSha256, origSha);

    // 2. 模拟文件被外部二次改动（例如热更新或重新打补丁），导致当前文件哈希与清单中的 patchedSha256 脱节
    // 但内部依旧保留着本插件的补丁痕迹
    fs.appendFileSync(targetAsar, '\n');

    const desyncedSha = sha256(fs.readFileSync(targetAsar));
    assert.notEqual(desyncedSha, m1.patchedSha256, '模拟文件哈希已与安装清单脱节');

    // 3. 再次运行安装：安装器必须能够自动识别该脱节状态，并通过校验匹配的官方原版备份安全重新注入！
    const m2 = await install({ path: targetAsar });
    assert.equal(m2.originalSha256, origSha, '重新安装必须继承并核验原版备份');
    assert.notEqual(m2.patchedSha256, desyncedSha, '必须生成新的合法补丁哈希');

    // 验证重新注入后的文件包含合法补丁
    const newUtils = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(newUtils.includes('installContextMeter(win)'));
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('卸载异常恢复 2.5：当前文件包含补丁痕迹且哈希与清单脱节，但原版备份完好时，自动安全执行纯净原版还原', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-recovery-restore-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '0.1.0');
    fs.copyFileSync(v1Path, targetAsar);
    const origSha = sha256(fs.readFileSync(targetAsar));

    // 1. 初次正常安装
    const m1 = await install({ path: targetAsar });

    // 2. 模拟文件哈希脱节但包含补丁痕迹
    fs.appendFileSync(targetAsar, '\n');

    // 3. 运行 restore --force：必须能够将文件完整还原为官方原版！
    const res = await restore({ path: targetAsar, force: true });
    assert.equal(sha256(fs.readFileSync(targetAsar)), origSha, '必须成功还原为官方纯净原版');
    assert.equal(res.restored, targetAsar);

    // 4. 重复卸载：幂等返回 alreadyRestored
    const res2 = await restore({ path: targetAsar, force: true });
    assert.equal(res2.alreadyRestored, true, '自愈后再次卸载必须幂等成功');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 问题 4 & 3 测试集：更新入口来源校验、受控重定向与异步子进程执行
// ============================================================================


test('子进程更新 3.1：运行时解析区分 Node 与 Electron 运行环境', () => {
  // 1. 模拟非 Electron 环境
  const prevElectronVer = process.versions.electron;
  delete process.versions.electron;
  const nodeRuntime = resolveNodeRuntime();
  assert.equal(nodeRuntime.isElectron, false);
  assert.equal(nodeRuntime.env.ELECTRON_RUN_AS_NODE, undefined);

  // 2. 模拟 Electron 环境
  process.versions.electron = '32.1.0';
  try {
    const electronRuntime = resolveNodeRuntime();
    assert.equal(electronRuntime.isElectron, true);
    assert.equal(electronRuntime.env.ELECTRON_RUN_AS_NODE, '1', 'Electron 环境必须设置 ELECTRON_RUN_AS_NODE=1');
  } finally {
    if (prevElectronVer !== undefined) process.versions.electron = prevElectronVer;
    else delete process.versions.electron;
  }
});


test('热注入安全 6.1：CDP 返回 exceptionDetails 时 tryHotInject 判定失败返回 false，无异常时返回 true', async () => {
  const http = require('node:http');

  function decodeWsFrame(buf) {
    if (buf.length < 2) return null;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const isMasked = (buf[1] & 0x80) !== 0;
    if (isMasked) offset += 4;
    if (buf.length < offset + len) return null;
    const data = Buffer.alloc(len);
    if (isMasked) {
      const mask = buf.subarray(offset - 4, offset);
      for (let i = 0; i < len; i++) {
        data[i] = buf[offset + i] ^ mask[i % 4];
      }
    } else {
      buf.copy(data, 0, offset, offset + len);
    }
    return {
      text: data.toString('utf8'),
      totalBytes: offset + len
    };
  }

  function encodeWsText(text) {
    const payload = Buffer.from(text, 'utf8');
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return Buffer.concat([header, payload]);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-hotinject-'));
  const prevHome = process.env.HOME;
  const prevXdgConfig = process.env.XDG_CONFIG_HOME;
  const prevCdpPort = process.env.AG_CDP_PORT;
  process.env.HOME = tmpDir;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');

  let mockReturnException = true;
  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const p = server.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        type: 'page',
        url: 'https://127.0.0.1:12345/main.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/1`
      }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    let recvBuf = Buffer.alloc(0);
    socket.on('data', chunk => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      while (true) {
        const frame = decodeWsFrame(recvBuf);
        if (!frame) break;
        recvBuf = recvBuf.subarray(frame.totalBytes);

        try {
          const msg = JSON.parse(frame.text);
          let respPayload;
          if (mockReturnException) {
            respPayload = {
              id: msg.id,
              result: {
                exceptionDetails: {
                  text: 'Uncaught SyntaxError: Unexpected identifier',
                  lineNumber: 1
                }
              }
            };
          } else {
            respPayload = {
              id: msg.id,
              result: {
                value: 'injected successfully'
              }
            };
          }
          socket.write(encodeWsText(JSON.stringify(respPayload)));
        } catch {}
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.AG_CDP_PORT = String(port);

  for (const portDir of [
    path.join(tmpDir, 'Library', 'Application Support', 'Antigravity'),
    path.join(tmpDir, '.config', 'Antigravity')
  ]) {
    fs.mkdirSync(portDir, { recursive: true });
    fs.writeFileSync(path.join(portDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/mock\n`);
  }

  try {
    mockReturnException = true;
    const failRes = await tryHotInject();
    assert.equal(failRes, false, '当 CDP 返回 exceptionDetails 时，tryHotInject 必须判定注入失败并返回 false');

    mockReturnException = false;
    const okRes = await tryHotInject();
    assert.equal(okRes, true, '当 CDP 执行无异常时，tryHotInject 必须返回 true');
  } finally {
    for (const s of activeSockets) {
      try { s.destroy(); } catch {}
    }
    await new Promise(resolve => server.close(resolve));
    if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
    if (prevXdgConfig !== undefined) process.env.XDG_CONFIG_HOME = prevXdgConfig; else delete process.env.XDG_CONFIG_HOME;
    if (prevCdpPort !== undefined) process.env.AG_CDP_PORT = prevCdpPort; else delete process.env.AG_CDP_PORT;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 专项复核测试集：识别误覆盖、保护无关内容、防跨版本回退与失败恢复
// ============================================================================

test('专项复核 1：同版本不同构建与第三方修改并存（必须保留第三方代码，严禁误丢弃）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-preserve-third-party-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const thirdPartyUtils = `"use strict";
// Third-Party Custom Localization Patch v2
globalThis.__customChineseLocalization = true;
function setupNodeWrapper(env) {
    if (globalThis.__customChineseLocalization) env.LANG = "zh_CN.UTF-8";
}
function createWindow(url, storageManager, options) {
    void win.loadURL(url);
}
`;
    const hostPath = await createMockHostAsar(tmpDir, '2.31.2', thirdPartyUtils);
    fs.copyFileSync(hostPath, targetAsar);

    // 1. 初次安装
    await install({ path: targetAsar });

    // 2. 模拟文件哈希微变（脱节）但带有第三方修改与旧插件痕迹
    fs.appendFileSync(targetAsar, '\n');

    // 3. 再次运行安装（重装升级）
    await install({ path: targetAsar });

    // 4. 断言：第三方修改必须完好保留！
    const resUtils = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(resUtils.includes('Third-Party Custom Localization Patch v2'), '必须完整保留第三方的自定义注释');
    assert.ok(resUtils.includes('globalThis.__customChineseLocalization = true;'), '必须完整保留第三方定义的全局变量');
    assert.ok(resUtils.includes('env.LANG = "zh_CN.UTF-8"'), '必须完整保留第三方定制的逻辑');
    assert.ok(resUtils.includes('installContextMeter(win)'), '必须成功注入最新版插件代码');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 2：新版宿主仍含插件痕迹（严禁宿主版本意外回退回旧备份）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-prevent-host-downgrade-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    // 1. 在旧版宿主 2.30.0 上安装本插件，留下 2.30.0 的备份
    const v1Path = await createMockHostAsar(tmpDir, '2.30.0');
    fs.copyFileSync(v1Path, targetAsar);
    const m1 = await install({ path: targetAsar });
    assert.equal(m1.version, '2.30.0');

    // 2. 宿主跨版本升级到了 2.31.2，外部操作残留了插件痕迹
    const v2ResidualUtils = `"use strict";
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    require("./meter-main").installContextMeter(win);
    void win.loadURL(url);
}
`;
    const v2Path = await createMockHostAsar(tmpDir, '2.31.2', v2ResidualUtils);
    fs.copyFileSync(v2Path, targetAsar);

    // 3. 执行安装：必须基于当前 2.31.2 打包，严禁将宿主版本回退为旧备份 2.30.0！
    const m2 = await install({ path: targetAsar });
    assert.equal(m2.version, '2.31.2', '宿主版本必须继承当前宿主 2.31.2，绝不能回退为旧备份 2.30.0');
    const installedPkg = JSON.parse(builtinAsar.extractFile(targetAsar, 'package.json').toString('utf8'));
    assert.equal(installedPkg.version, '2.31.2', 'ASAR 内部版本必须是 2.31.2');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 3：当前文件不含插件但清单陈旧（卸载时必须拒绝覆盖当前纯净新文件）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-stale-manifest-restore-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    const cleanHost = await createMockHostAsar(tmpDir, '2.31.2', `"use strict";\n// Official clean freshly installed\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager, options) {\n    void win.loadURL(url);\n}\n`);
    fs.copyFileSync(cleanHost, targetAsar);
    const cleanSha = sha256(fs.readFileSync(targetAsar));

    // 执行卸载：必须拒绝覆盖，保护用户的新文件！
    await assert.rejects(
      async () => { await restore({ path: targetAsar }); },
      /拒绝覆盖还原以保护宿主文件/
    );
    assert.equal(sha256(fs.readFileSync(targetAsar)), cleanSha, '拒绝后当前纯净文件未被破坏');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 4：外部备份属于不同版本或无效（--backup 严格校验，拒绝并保持原文件不变）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-explicit-backup-validation-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const vHost = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(vHost, targetAsar);
    const beforeSha = sha256(fs.readFileSync(targetAsar));

    // 1. 传入不存在的文件路径
    await assert.rejects(
      async () => { await install({ path: targetAsar, backup: path.join(tmpDir, 'nonexistent.asar') }); },
      /指定的 --backup 文件不存在或无效/
    );

    // 2. 传入版本不匹配的备份 (2.30.0 vs 2.31.2)
    const mismatchedBackup = await createMockHostAsar(tmpDir, '2.30.0');
    await assert.rejects(
      async () => { await install({ path: targetAsar, backup: mismatchedBackup }); },
      /指定的 --backup 宿主版本.*不匹配/
    );

    assert.equal(sha256(fs.readFileSync(targetAsar)), beforeSha, '参数无效时目标文件必须保持不变');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 5：改写中断与失败恢复机制（快照原子回退保护）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-rollback-protection-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const vHost = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(vHost, targetAsar);
    const beforeSha = sha256(fs.readFileSync(targetAsar));

    const origCopy = fs.copyFileSync;
    let didThrow = false;
    try {
      fs.copyFileSync = (src, dest) => {
        if (dest === targetAsar && !didThrow) {
          didThrow = true;
          throw new Error('Simulated disk full or I/O failure during file write');
        }
        return origCopy(src, dest);
      };

      await assert.rejects(
        async () => { await install({ path: targetAsar }); },
        /Simulated disk full or I\/O failure/
      );

      assert.equal(sha256(fs.readFileSync(targetAsar)), beforeSha, '异常中断后目标文件必须完整还原无损坏');
    } finally {
      fs.copyFileSync = origCopy;
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 6：restore 卸载时原位清洗保留第三方修改（反例 A 修复断言）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-preserve-mod-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    const staging = path.join(tmpDir, 'staging-post-mod');
    fs.mkdirSync(staging);
    builtinAsar.extractAll(targetAsar, staging);
    const thirdPartyMarker = '// Custom User Third-Party Feature Injection';
    fs.appendFileSync(path.join(staging, 'dist', 'utils.js'), '\n' + thirdPartyMarker + '\n');
    await builtinAsar.createPackageWithOptions(staging, targetAsar, {});
    fs.rmSync(staging, { recursive: true, force: true });

    const res = await restore({ path: targetAsar });
    assert.equal(res.inPlaceCleaned, true, '必须优先走原位清洗卸载');

    const restoredUtils = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(restoredUtils.includes(thirdPartyMarker), '卸载后第三方修改必须完好保留，严禁被旧备份覆盖丢弃');
    assert.equal(restoredUtils.includes('installContextMeter'), false, '本插件挂载代码必须已被彻底移除');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 7：改写目标后发生后续异常时的真实快照回滚（反例 B 修复断言）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-rollback-manifest-failure-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const vHost = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(vHost, targetAsar);
    const beforeSha = sha256(fs.readFileSync(targetAsar));

    const origWriteFile = fs.writeFileSync;
    fs.writeFileSync = (p, data, opt) => {
      if (typeof p === 'string' && p.endsWith('installation.json')) {
        throw new Error('Simulated disk full or permission error while saving installation.json');
      }
      return origWriteFile(p, data, opt);
    };

    try {
      await assert.rejects(
        async () => { await install({ path: targetAsar }); },
        /Simulated disk full or permission error while saving installation.json/
      );

      const afterSha = sha256(fs.readFileSync(targetAsar));
      assert.equal(afterSha, beforeSha, '写清单失败后目标文件必须完整恢复为改写前快照状态');
    } finally {
      fs.writeFileSync = origWriteFile;
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 8：restore 自定义 --path 严格归属校验（反例 C 修复断言）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-path-ownership-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetA = path.join(tmpDir, 'target-a', 'app.asar');
    const targetB = path.join(tmpDir, 'target-b', 'app.asar');
    fs.mkdirSync(path.dirname(targetA), { recursive: true });
    fs.mkdirSync(path.dirname(targetB), { recursive: true });

    const hostA = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(hostA, targetA);
    const hostB = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(hostB, targetB);

    await install({ path: targetA });

    await assert.rejects(
      async () => { await restore({ path: targetB }); },
      /与安装记录中的目标.*不一致，拒绝跨目标还原/
    );
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 9：原有 autoHideMenuBar 不被误删且 JS 语法校验通过（反例 D 修复断言）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-preserve-menubar-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const customMenuBarUtils = `"use strict";
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    const win = { autoHideMenuBar: true };
    void win.loadURL(url);
}
`;
    const host = await createMockHostAsar(tmpDir, '2.31.2', customMenuBarUtils);
    fs.copyFileSync(host, targetAsar);

    await install({ path: targetAsar });
    fs.appendFileSync(targetAsar, '\n');
    await install({ path: targetAsar });

    const finalUtils = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(finalUtils.includes('const win = { autoHideMenuBar: true };'), '宿主原有的 autoHideMenuBar 绝不能被清洗逻辑误删！');

    const vm = require('vm');
    assert.doesNotThrow(() => {
      new vm.Script(finalUtils, { filename: 'dist/utils.js' });
    }, '最终 utils.js 必须是合法且可编译执行的 JavaScript 脚本');
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('纯只读监控安装验证 10：仅注入 ContextMeter 标签，且自动清洗历史遗留 Proxy / Chinese 标签', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-pure-meter-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const host = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(host, targetAsar);

    const { TAGS, validateSyntax } = require('./modular-installer');
    await install({ path: targetAsar });
    const u1 = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    const p1 = builtinAsar.extractFile(targetAsar, 'dist/preload.js').toString('utf8');

    assert.ok(u1.includes(TAGS.METER_UTILS_START), '上下文模块 utils 成对标记必须存在');
    assert.ok(p1.includes(TAGS.METER_PRELOAD_START), '上下文模块 preload 成对标记必须存在');
    assert.equal(u1.includes(TAGS.PROXY_START), false, '不得存在免 TUN 代理标记');
    assert.equal(p1.includes(TAGS.CHINESE_START), false, '不得存在客户端汉化标记');
    assert.ok(validateSyntax(u1, 'dist/utils.js'));
    assert.ok(validateSyntax(p1, 'dist/preload.js'));
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 11：restore 原位卸载写入目标时发生 I/O 异常时的快照回滚（断言目标文件未被写坏）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-write-failure-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    // 增加第三方修改使其进入原位解构卸载路径
    const staging = path.join(tmpDir, 'staging-mod');
    fs.mkdirSync(staging);
    builtinAsar.extractAll(targetAsar, staging);
    fs.appendFileSync(path.join(staging, 'dist', 'utils.js'), '\n// Third Party Modification\n');
    await builtinAsar.createPackageWithOptions(staging, targetAsar, {});
    fs.rmSync(staging, { recursive: true, force: true });

    const beforeRestoreSha = sha256(fs.readFileSync(targetAsar));

    // Mock: 模拟在将原位清洗后的文件写回目标时抛出 I/O 错误
    const origCopy = fs.copyFileSync;
    let didThrow = false;
    fs.copyFileSync = (src, dest) => {
      if (dest === targetAsar && !didThrow) {
        didThrow = true;
        // 模拟文件被截断/破坏时抛出异常
        throw new Error('Simulated disk full or I/O failure while writing restored ASAR');
      }
      return origCopy(src, dest);
    };

    try {
      await assert.rejects(
        async () => { await restore({ path: targetAsar }); },
        /Simulated disk full or I\/O failure while writing restored ASAR/
      );

      // 断言：必须真实从快照回滚，目标文件完整保留原状，绝不留下损坏文件！
      const afterRestoreSha = sha256(fs.readFileSync(targetAsar));
      assert.equal(afterRestoreSha, beforeRestoreSha, '原位卸载写入失败后目标文件必须完整恢复为改写前快照状态');
    } finally {
      fs.copyFileSync = origCopy;
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 12：restore 原位卸载替换成功后写清单失败时的快照回滚（断言文件与清单保持一致）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-restore-manifest-failure-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v1Path = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(v1Path, targetAsar);
    await install({ path: targetAsar });

    const staging = path.join(tmpDir, 'staging-mod');
    fs.mkdirSync(staging);
    builtinAsar.extractAll(targetAsar, staging);
    fs.appendFileSync(path.join(staging, 'dist', 'utils.js'), '\n// Third Party Modification\n');
    await builtinAsar.createPackageWithOptions(staging, targetAsar, {});
    fs.rmSync(staging, { recursive: true, force: true });

    const beforeRestoreSha = sha256(fs.readFileSync(targetAsar));

    // Mock: 模拟在写回 targetAsar 成功后，写入 installation.json 失败
    const origWriteFile = fs.writeFileSync;
    fs.writeFileSync = (p, data, opt) => {
      if (typeof p === 'string' && p.endsWith('installation.json')) {
        throw new Error('Simulated disk full while updating installation.json during restore');
      }
      return origWriteFile(p, data, opt);
    };

    try {
      await assert.rejects(
        async () => { await restore({ path: targetAsar }); },
        /Simulated disk full while updating installation.json during restore/
      );

      // 断言：写清单失败后必须自动回滚目标文件，确保文件与清单不脱节
      const afterRestoreSha = sha256(fs.readFileSync(targetAsar));
      assert.equal(afterRestoreSha, beforeRestoreSha, '卸载写清单失败后目标文件必须完整恢复为改写前快照状态');
    } finally {
      fs.writeFileSync = origWriteFile;
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 15：ASAR 模块检测验证：inspectDiskModules 零异常、零 process.noAsar 副作用', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-electron-asar-env-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'test-target.asar');
    const host = await createMockHostAsar(tmpDir, '2.31.2');
    fs.copyFileSync(host, targetAsar);

    await install({ path: targetAsar });

    const { inspectDiskModules } = require('./modules-config');
    const beforeNodeNoAsar = process.noAsar;
    const diskFromNode = inspectDiskModules(targetAsar);
    assert.equal(process.noAsar, beforeNodeNoAsar, 'Node 环境下 inspectDiskModules 不得篡改 process.noAsar');
    assert.equal(diskFromNode.found, true);
    assert.equal(diskFromNode.meter, true);
    assert.equal(diskFromNode.meterReady, true);
    assert.equal(diskFromNode.chinese, false);
    assert.equal(diskFromNode.proxy, false);
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('专项复核 16：Electron original-fs 回退、ASAR 路径分隔符统一与真缺失准确报错', async () => {
  const Module = require('module');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-meter-ready-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'host.asar');
    const host = await createMockHostAsar(tmpDir, '2.32.1');
    fs.copyFileSync(host, targetAsar);
    await install({ path: targetAsar });

    const { inspectDiskModules } = require('./modules-config');

    const nodeDisk = inspectDiskModules(targetAsar);
    assert.equal(nodeDisk.found, true);
    assert.equal(nodeDisk.meterReady, true);

    const slashNormalizedDisk = inspectDiskModules(targetAsar, {
      _builtinAsar: {
        extractFile: (p, rel) => require('./asar-engine').builtinAsar.extractFile(p, rel),
        listPackage: () => ['dist\\meter-main.js', 'dist\\meter-core.js']
      }
    });
    assert.equal(slashNormalizedDisk.meterReady, true, '无前导斜杠或分隔符差异不得导致 meterReady 误报 false');

    const missingFileDisk = inspectDiskModules(targetAsar, {
      _builtinAsar: {
        extractFile: (p, rel) => require('./asar-engine').builtinAsar.extractFile(p, rel),
        listPackage: () => ['/dist/meter-main.js']
      }
    });
    assert.equal(missingFileDisk.found, true);
    assert.equal(missingFileDisk.meter, true);
    assert.equal(missingFileDisk.meterReady, false, '真实缺失 meter-core.js 时不得错报 meterReady = true');

    const origLoad = Module._load;
    const prevElectronVer = process.versions.electron;
    let originalFsCalled = false;
    try {
      Object.defineProperty(process.versions, 'electron', { value: '33.0.0', configurable: true });
      const interceptedFs = new Proxy(fs, {
        get(target, prop) {
          if (prop === 'openSync') {
            return (p, ...rest) => {
              if (String(p).endsWith('.asar')) throw new Error('Simulated Electron VFS ASAR lock');
              return target.openSync(p, ...rest);
            };
          }
          return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
        }
      });
      const wrappedOriginalFs = new Proxy(fs, {
        get(target, prop) {
          if (prop === 'openSync') {
            return (p, ...rest) => {
              if (String(p).endsWith('.asar')) originalFsCalled = true;
              return target.openSync(p, ...rest);
            };
          }
          return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
        }
      });
      Module._load = function (request, parent, isMain) {
        if (request === 'fs') return interceptedFs;
        if (request === 'original-fs') return wrappedOriginalFs;
        return origLoad.call(this, request, parent, isMain);
      };
      delete require.cache[require.resolve('./asar-engine')];
      delete require.cache[require.resolve('./modules-config')];
      const { inspectDiskModules: electronInspect } = require('./modules-config');
      const eDisk = electronInspect(targetAsar);
      assert.equal(originalFsCalled, true, 'Electron 环境下必须通过 original-fs 读取 ASAR');
      assert.equal(eDisk.found, true);
      assert.equal(eDisk.meterReady, true, 'Electron 模拟下 disk.meterReady 必须为 true');
    } finally {
      Module._load = origLoad;
      if (prevElectronVer === undefined) delete process.versions.electron;
      else Object.defineProperty(process.versions, 'electron', { value: prevElectronVer, configurable: true });
      delete require.cache[require.resolve('./asar-engine')];
      delete require.cache[require.resolve('./modules-config')];
    }
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('离线契约：IPC 与 live-host 均不再暴露 check-update、apply-update 或 open-external 通道', async () => {
  const { registerMeterIpcHandlers, MAIN_CAPABILITIES } = require('./meter-main');
  const handlers = {};
  registerMeterIpcHandlers({ handle: (ch, fn) => { handlers[ch] = fn; } });

  assert.equal(handlers['context-meter:check-update'], undefined);
  assert.equal(handlers['context-meter:apply-update'], undefined);
  assert.equal(handlers['context-meter:open-external'], undefined);
  assert.equal(MAIN_CAPABILITIES.checkUpdate, undefined);
  assert.equal(MAIN_CAPABILITIES.applyUpdate, undefined);

  const { createLiveRequestHandler, LIVE_CAPABILITIES, ALLOWED_ROUTES } = require('./live-host');
  assert.equal(LIVE_CAPABILITIES.checkUpdate, undefined);
  assert.equal(LIVE_CAPABILITIES.applyUpdate, undefined);
  assert.equal(ALLOWED_ROUTES.includes('/check-update'), false);
  assert.equal(ALLOWED_ROUTES.includes('/apply-update'), false);

  const handler = createLiveRequestHandler({
    api: { origin: 'https://127.0.0.1:5173' },
    secret: 'tok123'
  });

  for (const forbiddenRoute of ['/check-update', '/apply-update']) {
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = forbiddenRoute;
    req.headers = {
      origin: 'https://127.0.0.1:5173',
      'x-ag-context-token': 'tok123'
    };
    let statusCode = 0;
    await handler(req, {
      setHeader() {},
      writeHead(code) { statusCode = code; },
      end() {}
    });
    assert.equal(statusCode, 403, `已删除的在线更新路由 ${forbiddenRoute} 必须返回 403`);
  }
});

test('宿主兼容：Antigravity v2.34+ 使用 loadHubWindowUrl(win, url, ...) 锚点可正常安装、重复安装与原位还原', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-v234-hub-loader-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');

  try {
    const targetAsar = path.join(tmpDir, 'app.asar');
    const v234Utils = `"use strict";
async function loadHubWindowUrl(win, targetUrl, options) {
    await win.loadURL(targetUrl);
}
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    const win = {};
    const skipBootstrapMint = Boolean(options?.partition || options?.navigationPolicy);
    void loadHubWindowUrl(win, url, { skipBootstrapMint });
    return win;
}
`;
    const host = await createMockHostAsar(tmpDir, '2.34.0', v234Utils);
    fs.copyFileSync(host, targetAsar);

    const { TAGS, validateSyntax } = require('./modular-installer');
    await install({ path: targetAsar });
    const u1 = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.ok(u1.includes(TAGS.METER_UTILS_START), 'v2.34+ 应成功注入 METER_UTILS_START 标记');
    assert.ok(u1.includes('    void loadHubWindowUrl(win, url, { skipBootstrapMint });'), '原有 loadHubWindowUrl 调用必须完整保留');
    assert.ok(validateSyntax(u1, 'dist/utils.js'));

    // 重复安装应通过原位清洗自证
    await install({ path: targetAsar });
    const u2 = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.equal(u2.split(TAGS.METER_UTILS_START).length, 2, '重复安装不得产生重复注入块');
    assert.ok(validateSyntax(u2, 'dist/utils.js'));

    // 原位卸载应完整清理
    await restore({ path: targetAsar, inPlace: true });
    const u3 = builtinAsar.extractFile(targetAsar, 'dist/utils.js').toString('utf8');
    assert.equal(u3.includes(TAGS.METER_UTILS_START), false, '原位还原后不应残留注入标记');
    assert.ok(u3.includes('    void loadHubWindowUrl(win, url, { skipBootstrapMint });'));
    assert.ok(validateSyntax(u3, 'dist/utils.js'));
  } finally {
    if (prevStateDir !== undefined) process.env.AG_METER_STATE_DIR = prevStateDir;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('宿主兼容：Antigravity v2.34+ 启用 authBootstrap 后 local-api 优先读取同 origin 的主进程内存 CSRF Token', async () => {
  const { resolveHostAuthBootstrapToken, connect } = require('./local-api');

  const mockAuthBootstrap = {
    getActiveLsBaseUrl: () => 'https://127.0.0.1:54321',
    getActiveLsCsrfToken: () => 'host-admin-csrf-token-v234'
  };

  assert.equal(
    resolveHostAuthBootstrapToken('https://127.0.0.1:54321', mockAuthBootstrap),
    'host-admin-csrf-token-v234',
    '匹配当前 active LS origin 时应返回内存 CSRF Token'
  );
  assert.equal(
    resolveHostAuthBootstrapToken('https://127.0.0.1:59999', mockAuthBootstrap),
    null,
    '不同端口 origin 绝不能复用错误实例的 CSRF Token'
  );

  const api = await connect({
    origin: 'https://127.0.0.1:54321',
    authBootstrap: mockAuthBootstrap
  });
  assert.equal(api.origin, 'https://127.0.0.1:54321');
  assert.equal(typeof api.call, 'function');
});
