'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { spawn } = require('child_process');

// 会话与项目工作区对应关系的内存缓存
const conversationWorkspaces = new Map();

/**
 * 从 URI 字符串安全解析为本地工作区绝对路径（兼容 file:// 格式与中文/空格转义）
 */
function extractWorkspacePathFromUri(uriStr) {
  if (!uriStr || typeof uriStr !== 'string') return null;
  try {
    const trimmed = uriStr.trim();
    if (trimmed.startsWith('file://')) {
      return path.resolve(fileURLToPath(trimmed));
    }
    if (path.isAbsolute(trimmed)) {
      return path.resolve(trimmed);
    }
  } catch {
    try {
      const decoded = decodeURIComponent(uriStr.replace(/^file:\/\/\/?/i, ''));
      const normalized = '/' + decoded.replace(/^\/+/, '');
      if (path.isAbsolute(normalized)) return path.resolve(normalized);
    } catch {}
  }
  return null;
}

/**
 * 从轨迹元数据解析工作区路径
 */
function extractWorkspaceFromTrajectory(trajectory) {
  try {
    const meta = trajectory?.metadata || trajectory?.trajectoryMetadata || {};
    const wsList = Array.isArray(meta.workspaces) ? meta.workspaces : [];
    for (const ws of wsList) {
      const cand = extractWorkspacePathFromUri(ws?.workspaceFolderAbsoluteUri || ws?.gitRootAbsoluteUri);
      if (cand && fs.existsSync(cand)) return cand;
    }
    const uriList = Array.isArray(meta.workspaceUris) ? meta.workspaceUris : [];
    for (const u of uriList) {
      const cand = extractWorkspacePathFromUri(u);
      if (cand && fs.existsSync(cand)) return cand;
    }
  } catch {}
  return null;
}

/**
 * 从会话日志文件头部提取工作区路径
 */
function extractWorkspaceFromTranscriptFile(transcriptPath) {
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(16384);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.slice(0, bytes).toString('utf8');
      const m1 = head.match(/Command Working Directory:\s*([^\r\n\\"]+)/i);
      if (m1 && m1[1]) {
        const cand = m1[1].trim();
        if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return path.resolve(cand);
      }
      const m2 = head.match(/Active Workspaces:\s*(?:\\n|\r?\n)\s*-\s*([^\r\n\\"]+)/i);
      if (m2 && m2[1]) {
        const cand = m2[1].trim();
        if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return path.resolve(cand);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return null;
}

/**
 * 探测 Antigravity CLI (agy) 可执行文件路径（macOS / Linux）
 */
function resolveCliExecutable(customCliPath, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if (customCliPath !== undefined && customCliPath !== null && String(customCliPath).trim() !== '') {
    const explicit = path.resolve(String(customCliPath).trim());
    try {
      if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) {
        return { ok: true, cliPath: explicit, exePath: explicit, source: 'explicit' };
      }
    } catch {}
    return {
      ok: false,
      code: 'CLI_NOT_FOUND',
      cliPath: explicit,
      error: `指定的 Antigravity CLI 路径不存在或不可用: ${explicit}`
    };
  }

  const home = options.homeDir || os.homedir();
  const candidates = [];
  if (env.AG_CLI_PATH) candidates.push({ p: env.AG_CLI_PATH, src: 'env_AG_CLI_PATH' });

  if (platform === 'darwin') {
    const appRoots = Array.isArray(options.macAppRoots)
      ? options.macAppRoots
      : [
          '/Applications/Antigravity.app',
          path.join(home, 'Applications', 'Antigravity.app'),
          '/Applications/Antigravity IDE.app',
          path.join(home, 'Applications', 'Antigravity IDE.app'),
          '/Applications/Google Antigravity.app',
          path.join(home, 'Applications', 'Google Antigravity.app')
        ];
    for (const appRoot of appRoots) {
      candidates.push(
        { p: path.join(appRoot, 'Contents', 'Resources', 'app', 'bin', 'agy'), src: 'mac_app_bin' },
        { p: path.join(appRoot, 'Contents', 'Resources', 'bin', 'agy'), src: 'mac_resources_bin' }
      );
    }
    candidates.push(
      { p: path.join(home, '.gemini', 'antigravity', 'bin', 'agy'), src: 'gemini_bin' },
      { p: path.join(home, '.local', 'bin', 'agy'), src: 'local_bin' },
      { p: '/opt/homebrew/bin/agy', src: 'homebrew_bin' },
      { p: '/usr/local/bin/agy', src: 'usr_local_bin' }
    );
  } else {
    candidates.push(
      { p: path.join(home, '.gemini', 'antigravity', 'bin', 'agy'), src: 'gemini_bin' },
      { p: path.join(home, '.local', 'bin', 'agy'), src: 'local_bin' },
      { p: '/usr/local/bin/agy', src: 'usr_local_bin' }
    );
  }

  for (const item of candidates) {
    try {
      if (item.p && fs.existsSync(item.p) && fs.statSync(item.p).isFile()) {
        return {
          ok: true,
          cliPath: item.p,
          exePath: item.p,
          source: item.src
        };
      }
    } catch {}
  }

  const pathDirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of pathDirs) {
    const full = path.join(d, 'agy');
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return { ok: true, cliPath: full, exePath: full, source: 'PATH' };
      }
    } catch {}
  }

  return {
    ok: false,
    code: 'CLI_NOT_FOUND',
    cliPath: null,
    error: '未找到已安装的 Antigravity CLI (agy)。请将 agy 加入 PATH，或通过 AG_CLI_PATH 指定可执行文件。'
  };
}

/**
 * 探测并解析当前最适合的 CLI 项目工作目录
 */
async function resolveCliWorkspace(options = {}) {
  const home = options.homeDir || os.homedir();
  const agDir = options.agDir || process.env.AG_DIR || path.join(home, '.gemini', 'antigravity');
  const configDir = options.configDir || path.join(home, '.gemini', 'config');
  const platform = options.platform || process.platform;
  const appDataDir = options.appDataDir || process.env.APPDATA || (
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'))
  );

  if (options.cwd !== undefined && options.cwd !== null && String(options.cwd).trim() !== '') {
    const rawCwd = String(options.cwd).trim();
    const resolvedCwd = extractWorkspacePathFromUri(rawCwd) || path.resolve(rawCwd);
    try {
      if (fs.existsSync(resolvedCwd) && fs.statSync(resolvedCwd).isDirectory()) {
        return { ok: true, cwd: resolvedCwd, source: 'explicit_cwd' };
      }
    } catch {}
    if (options.strictCwd) {
      return { ok: false, code: 'CWD_NOT_FOUND', cwd: resolvedCwd, error: `指定的工作目录不存在或无法访问: ${resolvedCwd}` };
    }
  }

  const cascadeId = options.cascadeId && /^[a-f\d-]{36}$/i.test(String(options.cascadeId).trim())
    ? String(options.cascadeId).trim().toLowerCase()
    : null;

  if (cascadeId) {
    const cachedWs = conversationWorkspaces.get(cascadeId);
    if (cachedWs && fs.existsSync(cachedWs)) {
      return { ok: true, cwd: cachedWs, source: 'conversation_cache' };
    }
    const tPath = path.join(agDir, 'brain', cascadeId, '.system_generated', 'logs', 'transcript.jsonl');
    const fromTranscript = extractWorkspaceFromTranscriptFile(tPath);
    if (fromTranscript) {
      conversationWorkspaces.set(cascadeId, fromTranscript);
      return { ok: true, cwd: fromTranscript, source: 'conversation_transcript' };
    }
    try {
      const { connect } = require('./local-api');
      const api = await connect();
      const full = await api.call('GetCascadeTrajectory', { cascadeId, trajectoryVerbosity: 1 });
      const wsPath = extractWorkspaceFromTrajectory(full?.trajectory);
      if (wsPath) {
        conversationWorkspaces.set(cascadeId, wsPath);
        return { ok: true, cwd: wsPath, source: 'conversation_trajectory' };
      }
    } catch {}
  }

  try {
    const storagePath = path.join(appDataDir, 'Antigravity', 'app_storage.json');
    if (fs.existsSync(storagePath)) {
      const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      const lastProjId = storage['new-convo-last-selected-project'];
      if (lastProjId && typeof lastProjId === 'string') {
        const projFile = path.join(configDir, 'projects', `${lastProjId}.json`);
        if (fs.existsSync(projFile)) {
          const proj = JSON.parse(fs.readFileSync(projFile, 'utf8'));
          const resources = proj?.projectResources?.resources || [];
          for (const res of resources) {
            const uri = res?.gitFolder?.folderUri || res?.folderUri;
            const folderPath = extractWorkspacePathFromUri(uri);
            if (folderPath && fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
              return { ok: true, cwd: folderPath, source: 'last_selected_project', projectName: proj.name || lastProjId };
            }
          }
        }
      }
    }
  } catch {}

  const defaultCandidates = [
    options.defaultDir,
    path.join(home, 'Documents', 'antigravity'),
    home
  ].filter(Boolean);

  for (const cand of defaultCandidates) {
    try {
      const resolved = path.resolve(cand);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return { ok: true, cwd: resolved, source: 'default_fallback' };
      }
    } catch {}
  }

  return { ok: true, cwd: home, source: 'homedir_fallback' };
}

/**
 * 安全转义 POSIX 命令行参数（免疫 Shell 注入）
 */
function escapePosixArg(arg) {
  if (arg === undefined || arg === null) return "''";
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

/**
 * 探测 macOS 本机 kitty.app（当显式指定 Terminal.app 或检查 AppleScript 时跳过）
 */
function resolveKittyApp(options = {}) {
  if (options.preferredTerminal === 'Terminal.app' || options._inspectAppleScript === true) {
    return null;
  }
  const candidates = Array.isArray(options.kittyAppRoots)
    ? options.kittyAppRoots
    : ['/Applications/kitty.app', path.join(options.homeDir || os.homedir(), 'Applications', 'kitty.app')];

  for (const appRoot of candidates) {
    if (!appRoot || typeof appRoot !== 'string') continue;
    const binPath = path.join(appRoot, 'Contents', 'MacOS', 'kitty');
    try {
      if (fs.existsSync(binPath) && fs.statSync(binPath).isFile()) {
        return { appPath: appRoot, binPath };
      }
    } catch {}
  }
  return null;
}

/**
 * 为交互式 CLI 子进程构建干净环境（移除 Electron 内部标记与 NO_COLOR，恢复真彩终端支持）
 */
function buildCliSpawnEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NO_COLOR;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

/**
 * 组装启动环境并调度启动 Antigravity CLI 会话（支持 macOS 与 Linux）
 */
async function launchCliSession(options = {}) {
  const cliInfo = resolveCliExecutable(options.cliPath, options);
  if (!cliInfo.ok) {
    return cliInfo;
  }

  const wsInfo = await resolveCliWorkspace(options);
  if (!wsInfo.ok) {
    return wsInfo;
  }

  const cwd = wsInfo.cwd;
  const model = (typeof options.model === 'string' && /^[a-zA-Z0-9._-]+$/.test(options.model.trim()))
    ? options.model.trim()
    : 'gemini-3.8-flash-high';
  const extraArgs = Array.isArray(options.args)
    ? options.args.filter(a => typeof a === 'string' && a.trim().length > 0 && !/[\r\n\0]/.test(a))
    : [];

  const cliArgs = ['--model', model, ...extraArgs];
  const env = buildCliSpawnEnv(options.env || process.env);

  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      cliPath: cliInfo.cliPath,
      exePath: cliInfo.exePath,
      cliSource: cliInfo.source,
      cwd,
      cwdSource: wsInfo.source,
      model,
      args: cliArgs,
      env: {
        NO_COLOR: env.NO_COLOR,
        TERM: env.TERM,
        COLORTERM: env.COLORTERM,
        HTTP_PROXY: env.HTTP_PROXY,
        HTTPS_PROXY: env.HTTPS_PROXY
      }
    };
  }

  try {
    const runtimePlatform = options.platform || process.platform;
    if (runtimePlatform === 'darwin') {
      const preferredShell = (env.SHELL && typeof env.SHELL === 'string' && fs.existsSync(env.SHELL))
        ? env.SHELL
        : (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
      const safeShell = escapePosixArg(preferredShell);
      const safeCwd = escapePosixArg(cwd);
      const safeCli = escapePosixArg(cliInfo.exePath);
      const safeArgs = cliArgs.map(escapePosixArg).join(' ');

      const kittyInfo = resolveKittyApp(options);
      if (kittyInfo) {
        const kittyEnvAssigns = [
          `COLORTERM=${escapePosixArg(env.COLORTERM)}`
        ];
        for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
          if (env[k]) kittyEnvAssigns.push(`${k}=${escapePosixArg(env[k])}`);
        }
        const kittyShellCmd = `cd ${safeCwd} && export ${kittyEnvAssigns.join(' ')} && ${safeCli} ${safeArgs}; exec ${safeShell} -l`;
        const openArgs = ['-na', kittyInfo.appPath, '--args', '-d', cwd, preferredShell, '-lc', kittyShellCmd];

        if (options._inspectMacLaunch === true) {
          return {
            ok: true,
            dryRun: true,
            terminal: 'kitty.app',
            kittyAppPath: kittyInfo.appPath,
            shell: preferredShell,
            shellCmd: kittyShellCmd,
            openArgs,
            cliPath: cliInfo.cliPath,
            exePath: cliInfo.exePath,
            cliSource: cliInfo.source,
            cwd,
            cwdSource: wsInfo.source,
            model,
            args: cliArgs
          };
        }

        const spawner = typeof options._spawn === 'function' ? options._spawn : spawn;
        const child = spawner('/usr/bin/open', openArgs, {
          detached: true,
          stdio: 'ignore',
          env
        });
        child.unref?.();

        return {
          ok: true,
          nativePlacement: false,
          fallback: false,
          terminal: 'kitty.app',
          kittyAppPath: kittyInfo.appPath,
          shell: preferredShell,
          pid: child.pid || null,
          cliPath: cliInfo.cliPath,
          exePath: cliInfo.exePath,
          cliSource: cliInfo.source,
          cwd,
          cwdSource: wsInfo.source,
          model,
          args: cliArgs
        };
      }

      const envAssigns = [
        `TERM=${escapePosixArg(env.TERM)}`,
        `COLORTERM=${escapePosixArg(env.COLORTERM)}`
      ];
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
        if (env[k]) envAssigns.push(`${k}=${escapePosixArg(env[k])}`);
      }
      const shellCmd = `cd ${safeCwd} && export ${envAssigns.join(' ')} && ${safeCli} ${safeArgs}; exec ${safeShell} -l`;
      const escapedScriptCmd = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const appleScript = `tell application "Terminal"\n  do script "${escapedScriptCmd}"\n  activate\nend tell`;

      if (options._inspectAppleScript === true || options._inspectMacLaunch === true) {
        return {
          ok: true,
          dryRun: true,
          terminal: 'Terminal.app',
          shell: preferredShell,
          shellCmd,
          appleScript,
          cliPath: cliInfo.cliPath,
          exePath: cliInfo.exePath,
          cliSource: cliInfo.source,
          cwd,
          cwdSource: wsInfo.source,
          model,
          args: cliArgs
        };
      }

      const spawner = typeof options._spawn === 'function' ? options._spawn : spawn;
      const child = spawner('osascript', ['-e', appleScript], {
        detached: true,
        stdio: 'ignore',
        env
      });
      child.unref?.();

      return {
        ok: true,
        nativePlacement: false,
        fallback: false,
        terminal: 'Terminal.app',
        shell: preferredShell,
        pid: child.pid || null,
        cliPath: cliInfo.cliPath,
        exePath: cliInfo.exePath,
        cliSource: cliInfo.source,
        cwd,
        cwdSource: wsInfo.source,
        model,
        args: cliArgs
      };
    } else if (runtimePlatform === 'linux') {
      const candidateTerminals = [
        { bin: 'x-terminal-emulator', buildArgs: cmd => ['-e', `bash -c ${escapePosixArg(cmd + '; exec bash')}`] },
        { bin: 'gnome-terminal', buildArgs: cmd => ['--', 'bash', '-c', `${cmd}; exec bash`] },
        { bin: 'konsole', buildArgs: cmd => ['-e', 'bash', '-c', `${cmd}; exec bash`] },
        { bin: 'xfce4-terminal', buildArgs: cmd => ['-x', 'bash', '-c', `${cmd}; exec bash`] },
        { bin: 'xterm', buildArgs: cmd => ['-e', 'bash', '-c', `${cmd}; exec bash`] }
      ];

      const safeCwd = escapePosixArg(cwd);
      const safeCli = escapePosixArg(cliInfo.exePath);
      const safeArgs = cliArgs.map(escapePosixArg).join(' ');
      const targetCommand = `cd ${safeCwd} && ${safeCli} ${safeArgs}`;

      let foundTerm = null;
      const pathDirs = String((options.env || process.env).PATH || '').split(path.delimiter).filter(Boolean);
      for (const t of candidateTerminals) {
        for (const dir of pathDirs) {
          const full = path.join(dir, t.bin);
          if (fs.existsSync(full)) {
            foundTerm = { full, t };
            break;
          }
        }
        if (foundTerm) break;
      }

      if (!foundTerm) {
        return {
          ok: false,
          code: 'NO_TERMINAL_EMULATOR',
          error: '未在系统中检测到支持的图形终端模拟器（需安装 x-terminal-emulator、gnome-terminal、konsole 或 xterm）',
          cliPath: cliInfo.cliPath,
          cwd
        };
      }

      const spawner = typeof options._spawn === 'function' ? options._spawn : spawn;
      const termArgs = foundTerm.t.buildArgs(targetCommand);
      const child = spawner(foundTerm.full, termArgs, {
        cwd,
        env,
        detached: true,
        stdio: 'ignore'
      });
      child.unref?.();

      return {
        ok: true,
        nativePlacement: false,
        fallback: false,
        terminal: foundTerm.t.bin,
        pid: child.pid || null,
        cliPath: cliInfo.cliPath,
        exePath: cliInfo.exePath,
        cliSource: cliInfo.source,
        cwd,
        cwdSource: wsInfo.source,
        model,
        args: cliArgs
      };
    }

    return {
      ok: false,
      code: 'PLATFORM_UNSUPPORTED',
      error: `不支持的操作系统平台: ${runtimePlatform}（仅支持 macOS 与 Linux）`,
      cliPath: cliInfo.cliPath,
      cwd
    };
  } catch (err) {
    return {
      ok: false,
      code: 'LAUNCH_ERROR',
      error: `启动 Antigravity CLI 异常: ${err?.message || err}`,
      cliPath: cliInfo.cliPath,
      cwd
    };
  }
}

module.exports = {
  conversationWorkspaces,
  extractWorkspacePathFromUri,
  extractWorkspaceFromTrajectory,
  extractWorkspaceFromTranscriptFile,
  resolveCliExecutable,
  resolveCliWorkspace,
  resolveKittyApp,
  escapePosixArg,
  buildCliSpawnEnv,
  launchCliSession
};
