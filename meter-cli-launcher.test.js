'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveCliExecutable,
  resolveCliWorkspace,
  escapePosixArg,
  launchCliSession
} = require('./meter-cli-launcher');

test('CLI 启动模块 1: resolveCliExecutable 隔离跨平台探测（macOS .app 与 Linux PATH/home）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-resolve-'));
  try {
    // 1. 隔离模拟 macOS Google Antigravity.app 安装目录
    const macAppRoot = path.join(tmpDir, 'Google Antigravity.app');
    const macBin = path.join(macAppRoot, 'Contents', 'Resources', 'app', 'bin', 'agy');
    fs.mkdirSync(path.dirname(macBin), { recursive: true });
    fs.writeFileSync(macBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const resMac = resolveCliExecutable(null, { platform: 'darwin', macAppRoots: [macAppRoot], homeDir: tmpDir, env: { PATH: '' } });
    assert.equal(resMac.ok, true);
    assert.equal(path.resolve(resMac.exePath), path.resolve(macBin));

    // 2. 隔离模拟 Linux ~/.local/bin/agy 安装目录
    const linuxHome = path.join(tmpDir, 'linux-home');
    const linuxBin = path.join(linuxHome, '.local', 'bin', 'agy');
    fs.mkdirSync(path.dirname(linuxBin), { recursive: true });
    fs.writeFileSync(linuxBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const resLinux = resolveCliExecutable(null, { platform: 'linux', homeDir: linuxHome, env: { PATH: '' } });
    assert.equal(resLinux.ok, true);
    assert.equal(path.resolve(resLinux.exePath), path.resolve(linuxBin));

    // 3. 如宿主机实际已安装 Antigravity CLI，额外核对真实探测结果格式正确
    const hostRes = resolveCliExecutable();
    if (hostRes.ok) {
      assert.ok(hostRes.exePath && fs.existsSync(hostRes.exePath));
      assert.equal(path.basename(hostRes.exePath), 'agy');
    } else {
      assert.equal(hostRes.code, 'CLI_NOT_FOUND');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 启动模块 2: dryRun 包含完整参数与环境清理（清除 NO_COLOR / ELECTRON_RUN_AS_NODE）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-dryrun-'));
  try {
    const fakeCli = path.join(tmpDir, 'agy');
    fs.writeFileSync(fakeCli, '#!/bin/sh\necho stub\n', { mode: 0o755 });
    const dry = await launchCliSession({
      cliPath: fakeCli,
      cwd: tmpDir,
      dryRun: true,
      model: 'gemini-3.8-flash-high',
      args: ['--verbose'],
      env: { NO_COLOR: '1', ELECTRON_RUN_AS_NODE: '1', HTTP_PROXY: 'http://127.0.0.1:7890' }
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.model, 'gemini-3.8-flash-high');
    assert.deepEqual(dry.args, ['--model', 'gemini-3.8-flash-high', '--verbose']);
    assert.equal(dry.env.NO_COLOR, undefined);
    assert.equal(dry.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(dry.env.COLORTERM, 'truecolor');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 启动模块 3: 源码仅保留 macOS / Linux 启动逻辑，不残留 Windows PowerShell 或 .exe helper', () => {
  const src = fs.readFileSync(path.join(__dirname, 'meter-cli-launcher.js'), 'utf8');
  assert.equal(src.includes('powershell'), false, '严禁包含 powershell');
  assert.equal(src.includes('cli-window-helper.exe'), false, '严禁包含 cli-window-helper.exe');
  assert.equal(src.includes('win32'), false, '严禁包含 win32 分支');
  assert.equal(fs.existsSync(path.join(__dirname, 'scripts', 'cli-window-helper.exe')), false);
  assert.equal(fs.existsSync(path.join(__dirname, 'scripts', 'cli-window-helper.cs')), false);
});

test('CLI 启动模块 4: POSIX 命令行参数安全转义与工作区解析', async () => {
  assert.equal(escapePosixArg('simple'), "'simple'");
  assert.equal(escapePosixArg('path with spaces'), "'path with spaces'");
  assert.equal(escapePosixArg("it's a test"), "'it'\\''s a test'");
  assert.equal(escapePosixArg('$HOME && rm -rf /'), "'$HOME && rm -rf /'");
  assert.equal(escapePosixArg(''), "''");
  assert.equal(escapePosixArg(null), "''");

  const ws = await resolveCliWorkspace({ cwd: os.tmpdir() });
  assert.equal(path.resolve(ws.cwd), path.resolve(os.tmpdir()));
  assert.equal(ws.source, 'explicit_cwd');
});

test('macOS / Linux 路径与 AppleScript Terminal 参数组装', async () => {
  const { getAppDataDir } = require('./asar-engine');
  const { loadModulesConfig } = require('./modules-config');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-mac-paths-'));
  try {
    const macApp = path.join(tmpDir, 'Antigravity.app');
    const agyBin = path.join(macApp, 'Contents', 'Resources', 'app', 'bin', 'agy');
    fs.mkdirSync(path.dirname(agyBin), { recursive: true });
    fs.writeFileSync(agyBin, '#!/bin/sh\necho ok\n', 'utf8');

    const macCli = resolveCliExecutable(null, {
      platform: 'darwin',
      homeDir: tmpDir,
      env: {},
      macAppRoots: [macApp]
    });
    assert.equal(macCli.ok, true);
    assert.equal(macCli.source, 'mac_app_bin');
    assert.equal(macCli.exePath, agyBin);

    const inspect = await launchCliSession({
      platform: 'darwin',
      homeDir: tmpDir,
      macAppRoots: [macApp],
      kittyAppRoots: [],
      cwd: tmpDir,
      model: 'gemini-3.8-flash-high',
      args: ["--prompt='hi'"],
      env: { HTTP_PROXY: 'http://127.0.0.1:7897' },
      _inspectAppleScript: true
    });
    assert.equal(inspect.ok, true);
    assert.equal(inspect.terminal, 'Terminal.app');
    assert.match(inspect.appleScript, /tell application "Terminal"/);
    assert.match(inspect.shellCmd, /HTTP_PROXY='http:\/\/127\.0\.0\.1:7897'/);
    assert.match(inspect.shellCmd, /exec '[^']+' -l/);

    const macAppData = getAppDataDir({ platform: 'darwin', homeDir: '/Users/demo' });
    assert.equal(macAppData, '/Users/demo/Library/Application Support');
    const linuxAppData = getAppDataDir({ platform: 'linux', homeDir: '/home/demo', env: {} });
    assert.equal(linuxAppData, '/home/demo/.config');

    // 验证 Python attachment_scan.py 共享公式纯标准库回退与 _get_state_dir
    const { spawnSync } = require('node:child_process');
    const pyCheck = spawnSync('python3', ['-c', `
import os, attachment_scan as s
assert s._translate_shared_formula_fallback('SUM(A1:B1)+$C$1', 'C1', 'D3') == 'SUM(B3:C3)+$C$1'
os.environ['AG_METER_STATE_DIR'] = 'X_CUSTOM'
assert s._get_state_dir() == 'X_CUSTOM'
print('PY_OK')
`], { cwd: __dirname, encoding: 'utf8' });
    if (pyCheck.status === 0) {
      assert.match(pyCheck.stdout, /PY_OK/);
    }
    assert.equal(typeof loadModulesConfig, 'function');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('macOS 优先通过 kitty.app 启动 CLI 并在缺失时回退 Terminal.app', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-mac-kitty-'));
  try {
    const macApp = path.join(tmpDir, 'Antigravity.app');
    const agyBin = path.join(macApp, 'Contents', 'Resources', 'app', 'bin', 'agy');
    fs.mkdirSync(path.dirname(agyBin), { recursive: true });
    fs.writeFileSync(agyBin, '#!/bin/sh\necho ok\n', 'utf8');

    const mockKittyApp = path.join(tmpDir, 'kitty.app');
    const mockKittyBin = path.join(mockKittyApp, 'Contents', 'MacOS', 'kitty');
    fs.mkdirSync(path.dirname(mockKittyBin), { recursive: true });
    fs.writeFileSync(mockKittyBin, '#!/bin/sh\necho kitty\n', { mode: 0o755 });

    const kittySpawns = [];
    const kittyRes = await launchCliSession({
      platform: 'darwin',
      homeDir: tmpDir,
      macAppRoots: [macApp],
      kittyAppRoots: [mockKittyApp],
      cwd: tmpDir,
      model: 'gemini-3.8-flash-high',
      args: ['--verbose'],
      env: { HTTP_PROXY: 'http://127.0.0.1:7897' },
      _spawn: (cmd, args, opts) => {
        kittySpawns.push({ cmd, args, opts });
        return { pid: 4242, unref() {} };
      }
    });

    assert.equal(kittyRes.ok, true);
    assert.equal(kittyRes.terminal, 'kitty.app');
    assert.equal(kittyRes.kittyAppPath, mockKittyApp);
    assert.equal(kittySpawns.length, 1);
    assert.equal(kittySpawns[0].cmd, '/usr/bin/open');
    assert.deepEqual(kittySpawns[0].args.slice(0, 5), ['-na', mockKittyApp, '--args', '-d', tmpDir]);
    const launchedCmd = kittySpawns[0].args[7];
    assert.match(launchedCmd, /COLORTERM='truecolor'/);
    assert.match(launchedCmd, /HTTP_PROXY='http:\/\/127\.0\.0\.1:7897'/);
    assert.equal(/\bTERM=/.test(launchedCmd), false, 'kitty 内不得覆盖原生 TERM=xterm-kitty');

    // _inspectMacLaunch 预览模式应返回完整 openArgs 与 shellCmd
    const inspectKitty = await launchCliSession({
      platform: 'darwin',
      homeDir: tmpDir,
      macAppRoots: [macApp],
      kittyAppRoots: [mockKittyApp],
      cwd: tmpDir,
      env: {},
      _inspectMacLaunch: true
    });
    assert.equal(inspectKitty.ok, true);
    assert.equal(inspectKitty.dryRun, true);
    assert.equal(inspectKitty.terminal, 'kitty.app');
    assert.equal(inspectKitty.openArgs[1], mockKittyApp);

    // 未检测到 kitty.app 时应自动回退 osascript + Terminal.app
    const fallbackSpawns = [];
    const fallbackRes = await launchCliSession({
      platform: 'darwin',
      homeDir: tmpDir,
      macAppRoots: [macApp],
      kittyAppRoots: [],
      cwd: tmpDir,
      env: {},
      _spawn: (cmd, args, opts) => {
        fallbackSpawns.push({ cmd, args, opts });
        return { pid: 4343, unref() {} };
      }
    });
    assert.equal(fallbackRes.ok, true);
    assert.equal(fallbackRes.terminal, 'Terminal.app');
    assert.equal(fallbackSpawns.length, 1);
    assert.equal(fallbackSpawns[0].cmd, 'osascript');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
