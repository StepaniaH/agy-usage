'use strict';
require('./check-release-manifest');
/**
 * Release Packager for agy-usage (macOS & Linux)
 * Builds 4 platform-specific zip bundles (darwin_arm64, darwin_amd64, linux_amd64, linux_arm64)
 * and generates checksums.txt.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const outDirArgIdx = process.argv.indexOf('--out-dir');
const DIST_DIR = outDirArgIdx !== -1 && process.argv[outDirArgIdx + 1]
  ? path.resolve(process.argv[outDirArgIdx + 1])
  : (process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(ROOT_DIR, 'dist', 'release'));

const COMMON_FILES = [
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
  'modular-installer.js',
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'AGENTS.md',
  'LICENSE',
  'NOTICE'
];

const PLATFORMS = [
  { name: 'darwin_amd64', scripts: ['install.sh', 'uninstall.sh'] },
  { name: 'darwin_arm64', scripts: ['install.sh', 'uninstall.sh'] },
  { name: 'linux_amd64', scripts: ['install.sh', 'uninstall.sh'] },
  { name: 'linux_arm64', scripts: ['install.sh', 'uninstall.sh'] }
];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  return pkg.version || '0.8.8';
}

function packagePlatform(plat, version) {
  const platName = plat.name;
  const zipFilename = `agy-usage_${version}_${platName}.zip`;
  const zipPath = path.join(DIST_DIR, zipFilename);

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const stagingDir = path.join(os.tmpdir(), `ag-pkg-${platName}-${stamp}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const fileList = [...COMMON_FILES, ...plat.scripts];
    for (const rel of fileList) {
      const src = path.join(ROOT_DIR, rel);
      if (!fs.existsSync(src)) {
        throw new Error(`缺少必需的发布文件: ${rel}，拒绝打包！`);
      }
      const dest = path.join(stagingDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });

      if (rel.endsWith('.sh')) {
        const content = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
        fs.writeFileSync(dest, content, { encoding: 'utf8', mode: 0o755 });
      } else {
        fs.copyFileSync(src, dest);
      }
    }

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    const zipRes = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: stagingDir, stdio: 'pipe' });
    if (zipRes.status !== 0 || !fs.existsSync(zipPath)) {
      const pyCode = [
        'import os, sys, zipfile',
        'src, dst = sys.argv[1], sys.argv[2]',
        'with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zf:',
        '    for root, _, files in os.walk(src):',
        '        for name in files:',
        '            full = os.path.join(root, name)',
        '            zf.write(full, os.path.relpath(full, src))'
      ].join('\n');
      const pyRes = spawnSync('python3', ['-c', pyCode, stagingDir, zipPath], { stdio: 'pipe' });
      if (pyRes.status !== 0 || !fs.existsSync(zipPath)) {
        throw new Error(`打包 ${zipFilename} 失败: ${(zipRes.stderr || pyRes.stderr || Buffer.alloc(0)).toString('utf8') || '未知错误'}`);
      }
    }

    const sz = fs.statSync(zipPath).size;
    const sha = sha256File(zipPath);
    console.log(`[Packaging] 成功打包 ${zipFilename} (${sz} 字节) - SHA-256: ${sha.slice(0, 16)}...`);
    return { name: zipFilename, path: zipPath, sha256: sha, size: sz };
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

function main() {
  console.log('[Packaging] Building latest meter-renderer.js from src/renderer/...');
  execFileSync('node', [path.join(ROOT_DIR, 'scripts', 'build-renderer.js')], { stdio: 'inherit' });

  const version = getVersion();
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const results = [];
  for (const plat of PLATFORMS) {
    const r = packagePlatform(plat, version);
    results.push(r);
  }

  const checksumLines = results.map(r => `${r.sha256}  ${r.name}`).join('\n') + '\n';
  const checksumFile = path.join(DIST_DIR, 'checksums.txt');
  fs.writeFileSync(checksumFile, checksumLines, 'utf8');
  console.log(`[Packaging] 已生成 checksums.txt (共 ${results.length} 个资产包)`);

  return results;
}

if (require.main === module) {
  main();
}

module.exports = { main, packagePlatform, COMMON_FILES, PLATFORMS };
