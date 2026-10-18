/**
 * asar 归档的解析、定长原地写入，以及 Electron fuse wire 读取。
 *
 * 本模块只做"读 + 同长度覆盖写"：asar 头部记录每个文件的 offset/size，
 * 因此只要新内容字节数不超过原条目，就可以原地改写而不触碰其它条目与头部布局。
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

/** asar 头部固定前缀长度（两个 UInt32 字段 + JSON 长度字段）。 */
const HEADER_MAGIC_LENGTH = 16;

/** Electron fuse wire 的定位哨兵，见 electron/fuses/fuse_wire.cc。 */
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');

/** FuseV1Options 的序号含义（未列出的新选项按序号打印）。 */
const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
];

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 打开 asar 并解析头部；writable 为 true 时允许同长度覆盖写。 */
export async function openAsar(filePath, { writable = false } = {}) {
  const handle = await open(filePath, writable ? 'r+' : 'r');
  try {
    const stat = await handle.stat();
    const head = Buffer.alloc(HEADER_MAGIC_LENGTH);
    await handle.read(head, 0, head.length, 0);
    const pickleLength = head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    if (jsonLength <= 0 || jsonLength > 256 * 1024 * 1024) throw new Error('asar: 头部 JSON 长度异常');
    const jsonBuffer = Buffer.alloc(jsonLength);
    await handle.read(jsonBuffer, 0, jsonLength, HEADER_MAGIC_LENGTH);
    let header;
    try {
      header = JSON.parse(jsonBuffer.toString('utf8'));
    } catch (error) {
      throw new Error('asar: 头部 JSON 解析失败（文件可能已损坏）');
    }
    return {
      handle,
      stat,
      header,
      jsonBuffer,
      jsonOffset: HEADER_MAGIC_LENGTH,
      jsonLength,
      dataOffset: 8 + pickleLength,
      filePath,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** 按 "lib/main.js" 形式查找头部条目。 */
export function entryOf(header, entryPath) {
  let node = { files: header.files };
  for (const part of entryPath.split('/')) {
    if (node === undefined || node.files === undefined) return undefined;
    node = node.files[part];
  }
  return node && node.files === undefined ? node : undefined;
}

/** 读取一个条目的完整内容。 */
export async function readEntry(archive, entryPath) {
  const entry = entryOf(archive.header, entryPath);
  if (entry === undefined) throw new Error('asar: 找不到条目 ' + entryPath);
  const size = Number(entry.size);
  const offset = Number(entry.offset);
  const buffer = Buffer.alloc(size);
  await archive.handle.read(buffer, 0, size, archive.dataOffset + offset);
  return { entry, size, offset, buffer };
}

/** 从指定位置写入，直到全部写完。 */
export async function writeRange(archive, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await archive.handle.write(buffer, written, buffer.length - written, position + written);
    if (bytesWritten <= 0) throw new Error('asar: 写入未取得进展');
    written += bytesWritten;
  }
}

/** 用等长新值覆盖旧值，返回覆盖处的文件偏移列表。 */
export async function replaceInHeader(archive, fromHex, toHex) {
  if (fromHex.length !== toHex.length) throw new Error('asar: 头部替换必须等长');
  const from = Buffer.from(fromHex, 'utf8');
  const to = Buffer.from(toHex, 'utf8');
  const positions = [];
  let cursor = archive.jsonBuffer.indexOf(from);
  while (cursor >= 0) {
    positions.push(cursor);
    cursor = archive.jsonBuffer.indexOf(from, cursor + from.length);
  }
  for (const at of positions) {
    archive.jsonBuffer.set(to, at);
    await writeRange(archive, to, archive.jsonOffset + at);
  }
  return positions;
}

/** 按 asar integrity 规则计算分块哈希。 */
export function computeIntegrity(buffer, { algorithm = 'SHA256', blockSize = 4194304 } = {}) {
  const blocks = [];
  for (let index = 0; index < buffer.length; index += blockSize) {
    blocks.push(sha256(buffer.subarray(index, Math.min(index + blockSize, buffer.length))));
  }
  return { algorithm, hash: sha256(buffer), blockSize, blocks };
}

/** 读取 Electron 可执行文件的 fuse wire；读不到时返回 undefined。 */
export async function readFuseWire(executablePath) {
  const handle = await open(executablePath, 'r');
  try {
    const stat = await handle.stat();
    const chunkSize = 8 * 1024 * 1024;
    const scratch = Buffer.alloc(chunkSize + FUSE_SENTINEL.length);
    let position = 0;
    let carried = 0;
    while (position < stat.size) {
      const { bytesRead } = await handle.read(scratch, carried, chunkSize, position);
      if (bytesRead <= 0) break;
      const haystack = scratch.subarray(0, carried + bytesRead);
      const found = haystack.lastIndexOf(FUSE_SENTINEL);
      if (found >= 0) {
        const wirePosition = position - carried + found + FUSE_SENTINEL.length;
        const wire = Buffer.alloc(64);
        await handle.read(wire, 0, wire.length, wirePosition);
        const version = wire[0];
        const count = wire[1];
        const values = [];
        for (let index = 0; index < count; index++) values.push(wire[2 + index] === 0x31);
        return {
          version,
          count,
          values,
          entries: values.map((enabled, index) => ({ index, name: FUSE_NAMES[index] ?? 'option[' + index + ']', enabled })),
        };
      }
      carried = FUSE_SENTINEL.length - 1;
      scratch.copy(scratch, 0, carried + bytesRead - carried, carried + bytesRead);
      position += bytesRead;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** 执行一段 PowerShell（UTF-16LE + Base64，避免引号转义问题）。 */
export function powershell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 },
  );
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error,
  };
}
