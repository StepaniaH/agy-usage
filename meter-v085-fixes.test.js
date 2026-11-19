'use strict';
process.noAsar = true;
process.env.AG_METER_TEST_MODE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const vm = require('vm');
const { execFileSync, spawn, spawnSync } = require('child_process');

const ROOT_DIR = __dirname;
const { loadAsarEngine, builtinAsar } = require('./asar-engine');
const { install } = require('./install');
const { restore } = require('./restore');
const {
  loadModulesConfig,
  saveModulesConfig,
  inspectDiskModules
} = require('./modules-config');
const {
  collectTokenHistoryAsync,
  recordModelCalls
} = require('./meter-collector');
const { handleModulesStatus } = require('./meter-main');
const { buildLiveRuntimeModulesMeta, createLiveRequestHandler } = require('./live-host');

const asar = loadAsarEngine();

function makeTempSandbox(prefix = 'ag-v085-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(root, 'state');
  const appData = path.join(root, 'AppData', 'Roaming');
  const localAppData = path.join(root, 'AppData', 'Local');
  const homeDir = path.join(root, 'Home');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, stateDir, appData, localAppData, homeDir };
}

function withIsolatedEnv(sb, fn) {
  const keys = ['AG_METER_STATE_DIR', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'USERPROFILE', 'XDG_STATE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  process.env.AG_METER_STATE_DIR = sb.stateDir;
  process.env.APPDATA = sb.appData;
  process.env.LOCALAPPDATA = sb.localAppData;
  process.env.HOME = sb.homeDir;
  process.env.USERPROFILE = sb.homeDir;
  process.env.XDG_STATE_HOME = sb.stateDir;
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    delete process.env[k];
  }
  const restoreEnv = () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res.finally(restoreEnv);
    }
    restoreEnv();
    return res;
  } catch (err) {
    restoreEnv();
    throw err;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 纯 Node DER 编码生成自签名 X.509 v3 RSA-SHA256 测试证书（含 SAN localhost / 127.0.0.1），无外部 CLI 依赖。
 */
function createSelfSignedLocalhostCert() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const derLen = (len) => {
    if (len < 128) return Buffer.from([len]);
    const bytes = [];
    let n = len;
    while (n > 0) {
      bytes.unshift(n & 0xff);
      n >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
  const seq = (...items) => tlv(0x30, Buffer.concat(items));
  const set = (...items) => tlv(0x31, Buffer.concat(items));
  const intBuf = (val) => {
    let b = Buffer.isBuffer(val) ? val : Buffer.from([val]);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    return tlv(0x02, b);
  };
  const bitStr = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
  const oid = (nums) => {
    const out = [nums[0] * 40 + nums[1]];
    for (let i = 2; i < nums.length; i++) {
      let v = nums[i];
      const enc = [v & 0x7f];
      v >>= 7;
      while (v > 0) {
        enc.unshift((v & 0x7f) | 0x80);
        v >>= 7;
      }
      out.push(...enc);
    }
    return tlv(0x06, Buffer.from(out));
  };
  const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
  const utc = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    const str = String(d.getUTCFullYear()).slice(-2) +
      pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
    return tlv(0x17, Buffer.from(str, 'ascii'));
  };

  const sha256WithRsaAlg = seq(oid([1, 2, 840, 113549, 1, 1, 11]), Buffer.from([0x05, 0x00]));
  const cnAttr = set(seq(oid([2, 5, 4, 3]), utf8('localhost')));
  const name = seq(cnAttr);
  const now = new Date();
  const later = new Date(now.getTime() + 7 * 86400 * 1000);
  const validity = seq(utc(now), utc(later));
  const sanVal = seq(
    tlv(0x82, Buffer.from('localhost', 'ascii')),
    tlv(0x87, Buffer.from([127, 0, 0, 1]))
  );
  const sanExt = seq(oid([2, 5, 29, 17]), tlv(0x04, sanVal));
  const exts = tlv(0xa3, seq(sanExt));

  const tbs = seq(
    tlv(0xa0, intBuf(2)),
    intBuf(crypto.randomBytes(8).map((b, idx) => (idx === 0 ? ((b & 0x7f) || 0x01) : b))),
    sha256WithRsaAlg,
    name,
    validity,
    name,
    spkiDer,
    exts
  );

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(tbs);
  const sig = signer.sign(privateKey);
  const certDer = seq(tbs, sha256WithRsaAlg, bitStr(sig));
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`
  };
}

async function createHostAsarFixture(rootDir, { version = '0.2.0', includeExtraFile = true, withUnpackedNative = false, brokenUtils = false } = {}) {
  const srcDir = path.join(rootDir, 'host-src');
  const distDir = path.join(srcDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({
    name: 'antigravity-test-host',
    version,
    main: 'dist/utils.js'
  }, null, 2));
  if (!brokenUtils) {
    fs.writeFileSync(path.join(distDir, 'utils.js'), `'use strict';
function setupNodeWrapper(env) { return env; }
function createWindow(win, url) {
    void win.loadURL(url);
}
exports.setupNodeWrapper = setupNodeWrapper;
exports.createWindow = createWindow;
exports.getHubWindows = () => [];
`);
  }
  fs.writeFileSync(path.join(distDir, 'preload.js'), `'use strict';
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('__HOST__', {});
`);
  if (includeExtraFile) {
    fs.writeFileSync(path.join(distDir, 'host-extra.js'), `exports.marker = 'KEEP_ME_${version}';\n`);
  }
  const asarPath = path.join(rootDir, 'app.asar');
  if (withUnpackedNative) {
    const customDir = path.join(srcDir, 'custom-addon', 'build');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'addon.node'), Buffer.from('FAKE_NATIVE_BINARY'));
    await builtinAsar.createPackageWithOptions(srcDir, asarPath, {
      unpackMatcher: p => p.replace(/\\/g, '/').endsWith('.node')
    });
  } else {
    await asar.createPackage(srcDir, asarPath);
  }
  return asarPath;
}

test('1. 配置损坏 fail-closed：保留损坏原件并原子备份恢复保存', () => {
  const sb = makeTempSandbox('ag-v085-cfg-');
  try {
    withIsolatedEnv(sb, () => {
      // 场景 A: modules.json 为截断损坏 JSON -> 返回安全默认配置 + 损坏元数据，并保留原损坏文件
      const modPath = path.join(sb.stateDir, 'modules.json');
      const rawTruncated = '{"schemaVersion":"0.8.8-safe","modules":{"meter":{"enabled":true';
      fs.writeFileSync(modPath, rawTruncated, 'utf8');

      const cfgCorrupted = loadModulesConfig();
      assert.equal(cfgCorrupted.modules.meter.enabled, true);
      assert.equal(cfgCorrupted.__configCorrupted, true, '必须标记 __configCorrupted');
      assert.ok(cfgCorrupted.__configError, '必须提供明确损坏错误信息');
      assert.equal(fs.readFileSync(modPath, 'utf8'), rawTruncated, '不得擅自覆写/清理损坏的 modules.json 原件');

      // 场景 B: 空文件 / 非法字段类型 -> 同样 fail-closed
      for (const badBody of ['', '   \n', '[]', JSON.stringify({ schemaVersion: '0.8.8-safe', modules: [] })]) {
        fs.writeFileSync(modPath, badBody, 'utf8');
        const c = loadModulesConfig();
        assert.equal(c.__configCorrupted, true);
        assert.equal(fs.readFileSync(modPath, 'utf8'), badBody, '非法 schema 必须原样保留供排查恢复');
      }

      // 场景 C: 坏态下执行 saveModulesConfig -> 先保留 .corrupt.*.bak 再原子写入有效新配置
      fs.writeFileSync(modPath, rawTruncated, 'utf8');
      const cleanCfg = loadModulesConfig();
      saveModulesConfig(cleanCfg);
      const baks = fs.readdirSync(sb.stateDir).filter(f => f.startsWith('modules.json.corrupt.') && f.endsWith('.bak'));
      assert.ok(baks.length >= 1, '修复写入前必须保留原损坏备份 .corrupt.*.bak');
      assert.equal(fs.readFileSync(path.join(sb.stateDir, baks[0]), 'utf8'), rawTruncated);
      const reloaded = loadModulesConfig();
      assert.equal(Boolean(reloaded.__configCorrupted), false);
      assert.equal(reloaded.modules.meter.enabled, true);
    });
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});

test('2. 卸载还原全矩阵：缺失备份原位剥离、损坏备份默认拒绝与 --in-place、升级含痕迹剥离、损坏结构拒绝', async () => {
  const sb = makeTempSandbox('ag-v085-restore-');
  try {
    await withIsolatedEnv(sb, async () => {
      // 1) 正常备份还原验证 + 保留额外非插件文件 + 缺失备份原位剥离
      const case1Dir = path.join(sb.root, 'case1');
      fs.mkdirSync(case1Dir, { recursive: true });
      const targetAsar = await createHostAsarFixture(case1Dir, { version: '0.2.0', includeExtraFile: true, withUnpackedNative: true });
      const origHash = sha256(targetAsar);

      await install({ path: targetAsar });
      assert.equal(inspectDiskModules(targetAsar).meterReady, true, '安装后应具备完整 context-meter 痕迹');

      // 删除全部备份 -> restore 自动原位手术刀剥离
      const backupDir = path.join(sb.stateDir, 'backups');
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });

      const inPlaceRes = await restore({ path: targetAsar });
      assert.equal(path.resolve(inPlaceRes.restored), path.resolve(targetAsar), '备份缺失且含插件痕迹时应原位剥离成功');
      assert.equal(inPlaceRes.inPlaceCleaned, true);

      const afterDisk = inspectDiskModules(targetAsar);
      assert.equal(afterDisk.meter, false, '原位剥离后不应残留插件模块');
      assert.equal(afterDisk.chinese, false);
      assert.equal(afterDisk.proxy, false);

      const extAfter = path.join(sb.root, 'ext-after-inplace');
      asar.extractAll(targetAsar, extAfter);
      assert.ok(fs.existsSync(path.join(extAfter, 'dist', 'host-extra.js')), '原位剥离必须保留宿主原有非插件文件');
      assert.ok(fs.existsSync(path.join(targetAsar + '.unpacked', 'custom-addon', 'build', 'addon.node')), '原位剥离必须动态保留宿主原生 unpacked');
      assert.ok(!fs.existsSync(path.join(extAfter, 'meter-main.js')), '剥离后不得残留 meter-main.js');
      assert.ok(!fs.existsSync(path.join(extAfter, 'dist', 'meter-main.js')), '剥离后不得残留 dist/meter-main.js');

      // 2) 重新安装，随后破坏备份目录下所有备份文件校验 -> 默认拒绝；显式 inPlace: true 时允许安全原位剥离
      await install({ path: targetAsar });
      const bakFiles = fs.readdirSync(backupDir).filter(f => f.endsWith('.asar'));
      assert.ok(bakFiles.length >= 1);
      for (const bf of bakFiles) {
        fs.writeFileSync(path.join(backupDir, bf), Buffer.from('CORRUPT_BACKUP_BYTES'));
      }
      await assert.rejects(
        () => restore({ path: targetAsar }),
        /Backup checksum mismatch/
      );
      const forcedInPlace = await restore({ path: targetAsar, inPlace: true });
      assert.equal(path.resolve(forcedInPlace.restored), path.resolve(targetAsar));
      assert.equal(forcedInPlace.inPlaceCleaned, true);
      assert.equal(inspectDiskModules(targetAsar).meter, false);

      // 3) 模拟宿主已升级至 0.3.0 且带有新版痕迹（叠加残留） -> 允许原位剥离并保留 0.3.0 其他文件
      await install({ path: targetAsar });
      const manifestPath = path.join(sb.stateDir, 'installation.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const upgradeTmp = path.join(sb.root, 'upg-extract');
      asar.extractAll(targetAsar, upgradeTmp);
      const pkg = JSON.parse(fs.readFileSync(path.join(upgradeTmp, 'package.json'), 'utf8'));
      pkg.version = '0.3.0';
      fs.writeFileSync(path.join(upgradeTmp, 'package.json'), JSON.stringify(pkg, null, 2));
      fs.writeFileSync(path.join(upgradeTmp, 'dist', 'new-v030.js'), 'exports.v = "0.3.0";\n');
      await builtinAsar.createPackageWithOptions(upgradeTmp, targetAsar, {
        unpackMatcher: p => p.replace(/\\/g, '/').endsWith('.node')
      });
      // 确保备份仍保留 0.2.0 版本以触发版本差异检查
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.2.0' }, null, 2));

      const upgRestore = await restore({ path: targetAsar });
      assert.equal(path.resolve(upgRestore.restored), path.resolve(targetAsar));
      assert.equal(upgRestore.inPlaceCleaned, true);
      const extUpg = path.join(sb.root, 'ext-upg-after');
      asar.extractAll(targetAsar, extUpg);
      assert.equal(JSON.parse(fs.readFileSync(path.join(extUpg, 'package.json'), 'utf8')).version, '0.3.0');
      assert.ok(fs.existsSync(path.join(extUpg, 'dist', 'new-v030.js')), '必须保留新宿主新增文件');
      assert.equal(inspectDiskModules(targetAsar).meter, false);

      // 4) 损坏目标 ASAR / 缺失关键宿主入口 -> 准确拒绝并完整保留现场字节（无残留 manifest 时也直接走结构校验拒绝）
      fs.rmSync(manifestPath, { force: true });
      const brokenDir = path.join(sb.root, 'broken');
      fs.mkdirSync(brokenDir, { recursive: true });
      const brokenAsar = await createHostAsarFixture(brokenDir, { version: '0.2.0', brokenUtils: true });
      const brokenHash = sha256(brokenAsar);
      await assert.rejects(() => restore({ path: brokenAsar }), /未检测到插件注入痕迹|结构不支持|不支持或损坏的文件结构/);
      assert.equal(sha256(brokenAsar), brokenHash, '失败时不得改动原 ASAR 字节');

      const garbageAsar = path.join(sb.root, 'garbage.asar');
      fs.writeFileSync(garbageAsar, Buffer.from('NOT_AN_ASAR_ARCHIVE'));
      await assert.rejects(() => restore({ path: garbageAsar }), /无法读取目标 ASAR|损坏/);
      assert.equal(fs.readFileSync(garbageAsar, 'utf8'), 'NOT_AN_ASAR_ARCHIVE');
    });
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});


test('6. History Worker 异常/超时不永久卡死 & 多子进程并发写入账本零丢失零损坏', async () => {
  const sb = makeTempSandbox('ag-v085-conc-');
  try {
    const hangWorker = path.join(sb.root, 'hang-worker.js');
    fs.writeFileSync(hangWorker, `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', () => { /* 故意永久不回应以模拟卡死 */ });
    `, 'utf8');

    // B. History Worker 超时/异常非零退出后不卡住后续 collectTokenHistoryAsync 队列
    const exitWorker = path.join(sb.root, 'exit-worker.js');
    fs.writeFileSync(exitWorker, `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', () => { process.exit(1); });
    `, 'utf8');
    await withIsolatedEnv(sb, async () => {
      await assert.doesNotReject(() => collectTokenHistoryAsync({
        force: true,
        agDir: path.join(sb.root, 'empty-ag'),
        _historyWorkerScript: hangWorker,
        workerTimeoutMs: 120
      }));
      await assert.doesNotReject(() => collectTokenHistoryAsync({
        force: true,
        agDir: path.join(sb.root, 'empty-ag'),
        _historyWorkerScript: exitWorker,
        workerTimeoutMs: 500
      }));
      const normalHist = await collectTokenHistoryAsync({
        force: true,
        agDir: path.join(sb.root, 'empty-ag'),
        useMainThread: true
      });
      const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
      assert.equal(normalHist.version, pkgVersion);
    });

    // C. 4 个并发子进程向同一隔离目录下的 pricing_ledger_v1.json 高并发写 4*25=100 条唯一 callId
    const isolatedAgDir = path.join(sb.root, 'ag-dir');
    fs.mkdirSync(isolatedAgDir, { recursive: true });
    const ledgerPath = path.join(isolatedAgDir, 'pricing_ledger_v1.json');
    const workerScript = path.join(sb.root, 'ledger-writer.js');
    fs.writeFileSync(workerScript, `
      const { recordModelCalls } = require(${JSON.stringify(path.join(ROOT_DIR, 'meter-collector.js'))});
      const workerId = Number(process.argv[2]);
      const agDir = process.argv[3];
      for (let i = 0; i < 25; i++) {
        const res = recordModelCalls([{
          callId: 'call-w' + workerId + '-' + i,
          ts: Date.now() + i,
          model: 'gemini-2.5-flash',
          inputTokens: 100 + i,
          outputTokens: 20 + workerId,
          totalTokens: 120 + i + workerId,
          source: 'desktop'
        }], { agDir });
        if (!res || res.ok === false) {
          throw new Error('recordModelCalls failed: ' + JSON.stringify(res));
        }
      }
    `, 'utf8');

    await Promise.all([0, 1, 2, 3].map(wid => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerScript, String(wid), isolatedAgDir], {
        env: {
          ...process.env,
          AG_METER_STATE_DIR: sb.stateDir,
          HOME: sb.homeDir,
          USERPROFILE: sb.homeDir,
          AG_METER_TEST_MODE: '1'
        },
        stdio: 'pipe'
      });
      let stderr = '';
      child.stderr.on('data', d => stderr += d);
      child.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`Child ${wid} failed (${code}): ${stderr}`));
      });
    })));

    const rawLedger = fs.readFileSync(ledgerPath, 'utf8');
    const ledgerObj = JSON.parse(rawLedger);
    assert.equal(Object.keys(ledgerObj.calls || {}).length, 100, '4 进程并发写入 100 条独立调用记录不得有任何丢失或 JSON 损坏');
    const leftoverLocks = fs.readdirSync(isolatedAgDir).filter(f => f.endsWith('.lock'));
    assert.equal(leftoverLocks.length, 0, '并发写完成后不得遗留 .lock 锁文件');
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});

test('7. install 误传参数拒绝、动态 unpackedPaths 升级重装与卸载', async () => {
  const sb = makeTempSandbox('ag-v085-install-');
  try {
    await withIsolatedEnv(sb, async () => {
      await assert.rejects(
        () => install({ asarPath: path.join(sb.root, 'should-not-matter.asar') }),
        /无效的安装选项字段 "asarPath"/
      );
      await assert.rejects(
        () => install({ targetPath: path.join(sb.root, 'should-not-matter.asar') }),
        /无效的安装选项字段 "targetPath"/
      );
      await assert.rejects(
        () => install({ path: '   ' }),
        /非空字符串/
      );

      const upDir = path.join(sb.root, 'unpacked-host');
      fs.mkdirSync(upDir, { recursive: true });
      const customAsar = await createHostAsarFixture(upDir, { version: '0.2.0', includeExtraFile: true, withUnpackedNative: true });
      await install({ path: customAsar });
      assert.ok(fs.existsSync(path.join(customAsar + '.unpacked', 'custom-addon', 'build', 'addon.node')), '首次安装后不得丢失宿主自定义 unpacked');
      await install({ path: customAsar });
      assert.ok(fs.existsSync(path.join(customAsar + '.unpacked', 'custom-addon', 'build', 'addon.node')), '二次同版重装后不得丢失宿主自定义 unpacked');
    });
  } finally {
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
  }
});
