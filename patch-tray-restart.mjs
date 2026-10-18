#!/usr/bin/env node
/**
 * DSH 桌面版托盘「重启」补丁工具。
 *
 * 用法：
 *   node patch-tray-restart.mjs            # 应用补丁（幂等）
 *   node patch-tray-restart.mjs --check    # 只检查状态，不写入
 *   node patch-tray-restart.mjs --dry-run  # 在 %TEMP% 的 asar 副本上完整演练
 *   node patch-tray-restart.mjs --revert   # 从最近一次备份回滚
 *
 * 可选参数：--install-dir <路径>  --asar <app.asar 路径>  --backup <备份目录>
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { computeIntegrity, openAsar, powershell, readEntry, readFuseWire, replaceInHeader, sha256, writeRange } from './src/asar.mjs';
import { applyPatch, inspect } from './src/patch.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET_ENTRY = 'lib/main.js';
const EXE_NAME = 'DeepSeek Harness.exe';
const INTEGRITY_FUSE = 'EnableEmbeddedAsarIntegrityValidation';

/** 临时目录兜底：某些嵌入环境里 os.tmpdir() 可能不可用。 */
function tempDir() {
  let fallback;
  try {
    fallback = tmpdir();
  } catch {
    fallback = undefined;
  }
  const candidates = [process.env.TEMP, process.env.TMP, fallback, process.env.SystemRoot ? join(process.env.SystemRoot, 'Temp') : undefined];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return process.cwd();
}

function log(message) {
  console.log('[dsh-tray] ' + message);
}

function warn(message) {
  console.warn('[dsh-tray] ' + message);
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { mode: 'apply', installDir: undefined, asarPath: undefined, backupDir: undefined, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--check') options.mode = 'check';
    else if (arg === '--revert') options.mode = 'revert';
    else if (arg === '--dry-run') options.mode = 'dry-run';
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--install-dir') options.installDir = argv[++index];
    else if (arg === '--asar') options.asarPath = argv[++index];
    else if (arg === '--backup') options.backupDir = argv[++index];
    else fail('无法识别的参数：' + arg + '（使用 --help 查看用法）');
  }
  return options;
}

function printHelp() {
  console.log([
    'DSH 桌面版托盘「重启」补丁工具',
    '',
    '  node patch-tray-restart.mjs            应用补丁（已打过则跳过）',
    '  node patch-tray-restart.mjs --check    只检查补丁与运行环境状态',
    '  node patch-tray-restart.mjs --dry-run  在临时副本上完整演练，不改动安装目录',
    '  node patch-tray-restart.mjs --revert   从最近一次备份回滚',
    '',
    '可选：--install-dir <路径>  --asar <app.asar>  --backup <备份目录>',
  ].join('\n'));
}

/** 归一化候选路径，向上查找包含 resources/app.asar 的安装目录。 */
function normalizeInstallDir(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return undefined;
  let current = candidate.trim().replace(/^"|"$/g, '');
  if (current.includes(',')) current = current.split(',')[0];
  if (!existsSync(current)) current = dirname(current);
  for (let depth = 0; depth < 6; depth++) {
    if (current && existsSync(join(current, 'resources', 'app.asar'))) return current;
    const parent = dirname(current);
    if (!current || parent === current) break;
    current = parent;
  }
  return undefined;
}

/** 依次用运行进程、注册表卸载项、开始菜单快捷方式与常见路径探测安装目录。 */
function probeInstallDirs() {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$found = New-Object System.Collections.Generic.List[string]',
    'Get-Process -Name "DeepSeek Harness" | Select-Object -First 1 -ExpandProperty Path | ForEach-Object { if ($_) { $found.Add($_) } }',
    '$keys = @("HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*", "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*", "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*")',
    'Get-ItemProperty $keys | Where-Object { $_.DisplayName -like "*DeepSeek*Harness*" -or $_.DisplayName -like "*DeepSeek*" } | ForEach-Object {',
    '  if ($_.InstallLocation) { $found.Add($_.InstallLocation) }',
    '  if ($_.DisplayIcon) { $found.Add($_.DisplayIcon) }',
    '}',
    '$roots = @((Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs"), (Join-Path $env:ProgramData "Microsoft\\Windows\\Start Menu\\Programs"))',
    'foreach ($root in $roots) {',
    '  Get-ChildItem -LiteralPath $root -Recurse -Filter "*.lnk" | Where-Object { $_.Name -like "*DeepSeek*" -or $_.Name -like "*Harness*" -or $_.Name -like "*dsh*" } | ForEach-Object {',
    '    try { $shell = New-Object -ComObject WScript.Shell; $target = $shell.CreateShortcut($_.FullName).TargetPath; if ($target) { $found.Add($target) } } catch {}',
    '  }',
    '}',
    '$found | Select-Object -Unique | ConvertTo-Json -Compress',
  ].join('; ');
  const result = powershell(script);
  const candidates = [];
  if (result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed)) candidates.push(...parsed);
      else candidates.push(parsed);
    } catch {
      warn('安装目录探测输出无法解析，忽略：' + result.stdout.slice(0, 200));
    }
  }
  for (const key of ['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const base = process.env[key];
    if (!base) continue;
    candidates.push(join(base, 'dsh'));
    candidates.push(join(base, 'Programs', 'dsh'));
    candidates.push(join(base, 'DeepSeek Harness'));
  }
  return candidates;
}

function resolveTargets(options) {
  const asarCandidates = [];
  if (options.asarPath) asarCandidates.push(resolve(options.asarPath));
  const installCandidates = [];
  if (options.installDir) installCandidates.push(options.installDir);
  installCandidates.push(...probeInstallDirs());
  for (const candidate of installCandidates) {
    const installDir = normalizeInstallDir(candidate);
    if (installDir) asarCandidates.push(join(installDir, 'resources', 'app.asar'));
  }
  const asarPath = asarCandidates.find((path) => existsSync(path));
  if (!asarPath) {
    fail('未能定位 DSH 桌面版的 resources/app.asar。请用 --install-dir <安装目录> 显式指定。');
  }
  const installDir = normalizeInstallDir(asarPath) ?? dirname(dirname(asarPath));
  const exePath = findExecutable(installDir);
  return { installDir, asarPath, exePath };
}

function findExecutable(installDir) {
  const named = join(installDir, EXE_NAME);
  if (existsSync(named)) return named;
  try {
    const executables = readdirSync(installDir)
      .filter((name) => name.toLowerCase().endsWith('.exe'))
      .map((name) => ({ name, size: statSync(join(installDir, name)).size }))
      .sort((a, b) => b.size - a.size);
    if (executables.length > 0) return join(installDir, executables[0].name);
  } catch {
    /* 忽略：无权限或目录缺失时保持 undefined */
  }
  return undefined;
}

/** fuse 预检：只要没有启用 asar 完整性校验，就可以安全地原地改写。 */
async function checkFuses(exePath) {
  if (!exePath) return { status: 'unknown', reason: '未找到桌面版可执行文件' };
  const wire = await readFuseWire(exePath);
  if (!wire) return { status: 'unknown', reason: '未在可执行文件中找到 fuse wire' };
  const integrity = wire.entries.find((entry) => entry.name === INTEGRITY_FUSE);
  if (integrity === undefined) return { status: 'unknown', reason: 'fuse wire 中缺少 ' + INTEGRITY_FUSE };
  if (integrity.enabled) {
    return { status: 'blocked', reason: INTEGRITY_FUSE + ' 已启用：改写 asar 会被完整性校验拒绝', wire };
  }
  return { status: 'ok', wire };
}

function describeFuses(wire) {
  if (!wire) return;
  log('fuse 状态：' + wire.entries.map((entry) => entry.name + '=' + (entry.enabled ? '1' : '0')).join(' '));
}

async function readVersion(archive) {
  try {
    const { buffer } = await readEntry(archive, 'package.json');
    return JSON.parse(buffer.toString('utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 用 node --check 校验补丁结果仍是合法模块。 */
function verifySyntax(buffer) {
  const file = join(tempDir(), 'dsh-tray-patch-check-' + process.pid + '-' + Date.now() + '.mjs');
  writeFileSync(file, buffer);
  try {
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', env, windowsHide: true });
    if (result.status !== 0) {
      fail('补丁结果未通过语法校验：' + ((result.stderr ?? '') + (result.stdout ?? '')).trim());
    }
  } finally {
    rmSync(file, { force: true });
  }
}

function backupRootFor(options) {
  return options.backupDir ? resolve(options.backupDir) : join(SCRIPT_DIR, 'backup');
}

function writeBackup(info, backupRoot) {
  const directory = join(backupRoot, info.version + '-' + info.originalSha.slice(0, 8));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'main.js.bin'), info.originalBuffer);
  writeFileSync(join(directory, 'meta.json'), JSON.stringify(info.meta, null, 2) + '\n', 'utf8');
  return directory;
}

function listBackups(backupRoot) {
  const root = backupRoot;
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => existsSync(join(path, 'meta.json')) && existsSync(join(path, 'main.js.bin')))
    .map((path) => ({ path, meta: JSON.parse(readFileSync(join(path, 'meta.json'), 'utf8')) }))
    .sort((a, b) => String(b.meta.createdAt).localeCompare(String(a.meta.createdAt)));
}

async function collectStatus(targets) {
  const archive = await openAsar(targets.asarPath, { writable: false });
  try {
    const version = await readVersion(archive);
    const { entry, buffer } = await readEntry(archive, TARGET_ENTRY);
    return {
      version,
      entry,
      buffer,
      sha256: sha256(buffer),
      state: inspect(buffer),
    };
  } finally {
    await archive.handle.close();
  }
}

async function applyTo(asarPath, { targets, backup = false, label = 'asar', backupRoot }) {
  const archive = await openAsar(asarPath, { writable: true });
  try {
    const version = await readVersion(archive);
    const { entry, offset, buffer } = await readEntry(archive, TARGET_ENTRY);
    const before = inspect(buffer);
    if (before.patched) {
      log(label + '：已打过补丁，跳过（版本 ' + version + '）');
      return { changed: false };
    }
    const { buffer: patched, report } = applyPatch(buffer);
    verifySyntax(patched);
    log(label + '：新增 ' + report.addedBytes + ' 字节、回收 ' + report.reclaimedBytes + ' 字节、补齐 ' + report.paddingBytes + ' 字节');
    log(label + '：sha256 ' + report.sha256Before.slice(0, 12) + '… -> ' + report.sha256After.slice(0, 12) + '…');

    const integrity = entry.integrity ?? {};
    const next = computeIntegrity(patched, {
      algorithm: integrity.algorithm ?? 'SHA256',
      blockSize: integrity.blockSize ?? 4194304,
    });

    let backupDirectory;
    if (backup) {
      backupDirectory = writeBackup({
        version,
        originalSha: report.sha256Before,
        originalBuffer: buffer,
        meta: {
          createdAt: new Date().toISOString(),
          installDir: targets.installDir,
          asarPath,
          asarSize: archive.stat.size,
          version,
          entry: { path: TARGET_ENTRY, size: Number(entry.size), offset: Number(entry.offset) },
          original: { sha256: report.sha256Before, integrity },
          patched: { sha256: report.sha256After, integrity: next },
        },
      }, backupRoot);
      log(label + '：已备份原始内容到 ' + backupDirectory);
    }

    await writeRange(archive, patched, archive.dataOffset + offset);

    const pairs = new Map();
    if (typeof integrity.hash === 'string') pairs.set(integrity.hash, next.hash);
    if (Array.isArray(integrity.blocks)) {
      integrity.blocks.forEach((hash, index) => {
        if (typeof hash === 'string') pairs.set(hash, next.blocks[index] ?? next.hash);
      });
    }
    for (const [from, to] of pairs) {
      if (from === to) continue;
      const occurrences = countOccurrences(archive.jsonBuffer, from);
      if (occurrences === 0) {
        warn(label + '：头部未找到待更新的 hash 片段，integrity 元数据可能不同步（运行时不做校验，可忽略）');
        continue;
      }
      await replaceInHeader(archive, from, to);
    }
    return { changed: true, report, version, backupDirectory };
  } finally {
    await archive.handle.close();
  }
}

function countOccurrences(haystack, needle) {
  const from = Buffer.from(needle, 'utf8');
  let count = 0;
  let cursor = haystack.indexOf(from);
  while (cursor >= 0) {
    count++;
    cursor = haystack.indexOf(from, cursor + from.length);
  }
  return count;
}

async function verifyResult(asarPath, expectedSha) {
  const archive = await openAsar(asarPath, { writable: false });
  try {
    const { entry, buffer } = await readEntry(archive, TARGET_ENTRY);
    const actual = sha256(buffer);
    if (actual !== expectedSha) fail('回读校验失败：内容 sha256 不一致');
    if (entry.integrity && entry.integrity.hash !== expectedSha) {
      warn('回读校验：头部 integrity.hash 与内容不匹配（运行时不做校验，可忽略）');
    }
    return { size: Number(entry.size), offset: Number(entry.offset), asarSize: archive.stat.size };
  } finally {
    await archive.handle.close();
  }
}

async function runApply(options, targets) {
  const fuses = await checkFuses(targets.exePath);
  describeFuses(fuses.wire);
  if (fuses.status === 'blocked') fail(fuses.reason);
  if (fuses.status === 'unknown') warn('fuse 预检未通过（' + fuses.reason + '），继续执行');

  const asarPath = options.mode === 'dry-run' ? makeDryRunCopy(targets.asarPath) : targets.asarPath;
  if (options.mode === 'dry-run') log('演练副本：' + asarPath);
  const result = await applyTo(asarPath, {
    targets,
    backup: options.mode !== 'dry-run',
    backupRoot: backupRootFor(options),
  });
  if (result.changed) {
    const details = await verifyResult(asarPath, result.report.sha256After, result.report.sha256After);
    log('回读校验通过：lib/main.js ' + details.size + ' 字节 @ ' + details.offset + '，asar 总长 ' + details.asarSize);
  }
  if (options.mode === 'dry-run') {
    rmSync(dirname(asarPath), { recursive: true, force: true });
    log('演练副本已清理');
    log('RESULT: DRY RUN OK');
    return 0;
  }
  if (result.changed) {
    log('');
    log('补丁已应用。接下来请：');
    log('  1. 在系统托盘中右键 DSH 图标并选择「退出 DeepSeek Harness」');
    log('  2. 重新启动 DSH，托盘右键菜单中即会出现「重启」');
    log('RESULT: PATCH APPLIED');
  } else {
    log('无需改动。若托盘仍没有「重启」，请重启一次 DSH 以加载当前文件。');
    log('RESULT: ALREADY PATCHED');
  }
  return 0;
}

function makeDryRunCopy(asarPath) {
  const directory = join(tempDir(), 'dsh-tray-patch-dry-run-' + Date.now());
  mkdirSync(directory, { recursive: true });
  const copy = join(directory, 'app.asar');
  log('复制 asar 到临时目录（约 ' + Math.round(statSync(asarPath).size / 1024 / 1024) + ' MB）…');
  copyFileSync(asarPath, copy);
  return copy;
}

async function runCheck(targets) {
  log('安装目录：' + targets.installDir);
  log('asar 路径：' + targets.asarPath);
  if (targets.exePath) log('可执行文件：' + targets.exePath);
  const fuses = await checkFuses(targets.exePath);
  describeFuses(fuses.wire);
  log('fuse 预检：' + (fuses.status === 'ok' ? '通过（未启用 asar 完整性校验）' : fuses.status === 'blocked' ? '不通过：' + fuses.reason : '未知：' + fuses.reason));
  const status = await collectStatus(targets);
  log('应用版本：' + status.version);
  log('lib/main.js：' + status.buffer.length + ' 字节，sha256 ' + status.sha256);
  log('补丁状态：' + (status.state.patched ? '已打补丁' : status.state.hasMenuAnchor && status.state.hasCtorAnchor ? '未打补丁（锚点正常）' : '未打补丁，但锚点异常，需要人工适配'));
  log('RESULT: ' + (status.state.patched ? 'ALREADY PATCHED' : 'NOT PATCHED'));
  return 0;
}

async function runRevert(options, targets) {
  const backupRoot = backupRootFor(options);
  const directMeta = options.backupDir ? join(backupRoot, 'meta.json') : undefined;
  const backups = directMeta && existsSync(directMeta)
    ? [{ path: backupRoot, meta: JSON.parse(readFileSync(directMeta, 'utf8')) }]
    : listBackups(backupRoot);
  if (backups.length === 0) fail('找不到可用备份，无法回滚（备份位于 ' + backupRoot + '）');
  const latest = backups[0];
  const originalBuffer = readFileSync(join(latest.path, 'main.js.bin'));
  log('使用备份：' + latest.path);

  const archive = await openAsar(targets.asarPath, { writable: true });
  try {
    const { entry, offset, buffer } = await readEntry(archive, TARGET_ENTRY);
    if (originalBuffer.length !== buffer.length) {
      fail('备份长度（' + originalBuffer.length + '）与当前条目长度（' + buffer.length + '）不一致，拒绝回滚');
    }
    const currentSha = sha256(buffer);
    if (latest.meta.patched && currentSha !== latest.meta.patched.sha256) {
      warn('当前文件 sha256 与备份记录的补丁后版本不一致（当前 ' + currentSha.slice(0, 12) + '…），可能是应用升级过');
    }
    await writeRange(archive, originalBuffer, archive.dataOffset + offset);
    const original = latest.meta.original ?? {};
    const pairs = new Map();
    if (latest.meta.patched?.integrity?.hash && original.integrity?.hash) {
      pairs.set(latest.meta.patched.integrity.hash, original.integrity.hash);
    }
    for (const [from, to] of pairs) {
      if (from === to) continue;
      if (countOccurrences(archive.jsonBuffer, from) === 0) {
        warn('头部未找到补丁记录的 hash 片段，跳过 integrity 还原');
        continue;
      }
      await replaceInHeader(archive, from, to);
    }
    log('已回滚 lib/main.js（' + originalBuffer.length + ' 字节）');
  } finally {
    await archive.handle.close();
  }
  const status = await collectStatus(targets);
  log('回滚后 sha256：' + status.sha256 + '，补丁状态：' + (status.state.patched ? '仍为已打补丁' : '已恢复原状'));
  log('请重启一次 DSH 使其生效。');
  log('RESULT: ' + (status.state.patched ? 'REVERT FAILED' : 'REVERTED'));
  return 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const targets = resolveTargets(options);
  if (!existsSync(targets.asarPath)) fail('asar 不存在：' + targets.asarPath);
  log('目标：' + targets.asarPath);
  if (options.mode === 'check') return runCheck(targets);
  if (options.mode === 'revert') return runRevert(options, targets);
  return runApply(options, targets);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === 'EACCES' || code === 'EPERM') {
      console.error('[dsh-tray] 失败：没有写入安装目录的权限。请以管理员身份运行（右键 patch-tray-restart.cmd → 以管理员身份运行）。');
    } else if (code === 'EBUSY') {
      console.error('[dsh-tray] 失败：app.asar 正被占用。请先从系统托盘退出 DSH，再运行本工具。');
    } else {
      console.error('[dsh-tray] 失败：' + message);
    }
    console.error('[dsh-tray] RESULT: FAILED');
    process.exit(1);
  });
