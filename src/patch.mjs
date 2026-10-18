/**
 * DSH 桌面版 lib/main.js 的锚点补丁。
 *
 * 目标：在系统托盘右键菜单中，于「打开」与「退出」之间插入一项「重启」，
 * 复用官方既有的 app.relaunch() + quitWithoutConfirmation() 与任务确认对话框。
 *
 * 约束：asar 头部记录了 lib/main.js 的 offset/size，因此补丁必须**不改变文件长度**：
 * 先在目标文件内回收等量的行级注释，再在文件末尾补齐差额空白。
 */
import { sha256 } from './asar.mjs';

/** 已打补丁的判定标志。 */
export const PATCH_SIGNATURE = 'label: messages.restartApplication';

/** 托盘菜单模板的定位锚点。 */
const MENU_ANCHOR = 'tray.setContextMenu(Menu.buildFromTemplate([';
/** 菜单模板中的分隔项，新项插入到它之后。 */
const MENU_SEPARATOR = '\t\t\t{ type: "separator" },\n';
/** 新增的托盘菜单项（缩进与打包产物一致，制表符）。 */
const MENU_ITEM = [
  '\t\t\t{',
  '\t\t\t\tlabel: messages.restartApplication,',
  '\t\t\t\tclick: () => {',
  '\t\t\t\t\tthis.options.restart();',
  '\t\t\t\t}',
  '\t\t\t},',
  '',
].join('\n');

/** DesktopTray 构造调用的定位锚点。 */
const CTOR_ANCHOR = 'tray = new DesktopTray({';
/** 构造参数中的退出回调，重启回调插入到它之前。 */
const CTOR_QUIT = '\t\t\tquit: () => {\n\t\t\t\tapp.quit();\n\t\t\t}\n';
/** 新增的重启回调：先取得退出确认，再排队 relaunch 并跳过重复询问。 */
const RESTART_HANDLER = [
  '\t\t\trestart: async () => {',
  '\t\t\t\tif (quitting) return;',
  '\t\t\t\tif (!await quitConfirmation.confirm()) return;',
  '\t\t\t\tif (quitting) return;',
  '\t\t\t\tapp.relaunch();',
  '\t\t\t\tquitWithoutConfirmation();',
  '\t\t\t},',
  '',
].join('\n');

/** 可回收的行级注释（按优先级排列，仅用于腾出等量空间，无语义影响）。 */
export const SPACE_RECLAIM_BLOCKS = [
  '//#region lib/types/tray.js\n',
  '/** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */\n',
  '/** Tray icon present for the whole run, not only while the window is hidden. */\n',
  '/** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */\n',
  '/** Only an explicit acknowledgement permits the first hide; cancelled prompts remain eligible. */\n',
  '/** One-time Windows confirmation before hiding the application in the tray. */\n',
  '//#endregion\n',
];

/** 判断当前文件状态。 */
export function inspect(source) {
  const text = source.toString('utf8');
  return {
    patched: text.includes(PATCH_SIGNATURE),
    hasMenuAnchor: text.includes(MENU_ANCHOR),
    hasCtorAnchor: text.includes(CTOR_ANCHOR),
  };
}

function locateOnce(source, needle, label) {
  const buffer = Buffer.from(needle, 'utf8');
  const first = source.indexOf(buffer);
  if (first < 0) throw new Error('锚点缺失：' + label);
  if (source.indexOf(buffer, first + 1) >= 0) throw new Error('锚点不唯一：' + label);
  return first;
}

/**
 * 生成补丁后的文件内容。
 * @returns {{buffer: Buffer, report: object}}
 */
export function applyPatch(source) {
  const state = inspect(source);
  if (state.patched) throw new Error('该文件已经打过补丁');

  const menuAt = locateOnce(source, MENU_ANCHOR, 'tray.setContextMenu(...)');
  const separatorAt = source.indexOf(Buffer.from(MENU_SEPARATOR, 'utf8'), menuAt);
  if (separatorAt < 0) throw new Error('托盘菜单模板结构已变化：未在菜单模板内找到分隔项');
  const menuInsertAt = separatorAt + Buffer.byteLength(MENU_SEPARATOR, 'utf8');

  const ctorAt = locateOnce(source, CTOR_ANCHOR, 'new DesktopTray({ ... })');
  const quitAt = source.indexOf(Buffer.from(CTOR_QUIT, 'utf8'), ctorAt);
  if (quitAt < 0) throw new Error('DesktopTray 构造参数结构已变化：未找到 quit 回调');
  const ctorInsertAt = quitAt;

  const insertions = [
    { start: menuInsertAt, end: menuInsertAt, buffer: Buffer.from(MENU_ITEM, 'utf8'), label: '托盘菜单项' },
    { start: ctorInsertAt, end: ctorInsertAt, buffer: Buffer.from(RESTART_HANDLER, 'utf8'), label: '重启回调' },
  ];
  const addedBytes = insertions.reduce((total, edit) => total + edit.buffer.length, 0);

  const removals = [];
  let reclaimedBytes = 0;
  for (const block of SPACE_RECLAIM_BLOCKS) {
    if (reclaimedBytes >= addedBytes) break;
    const needle = Buffer.from(block, 'utf8');
    const at = source.indexOf(needle);
    if (at < 0) continue;
    const overlapsInsertion = insertions.some((edit) => at < edit.start && at + needle.length > edit.start);
    const overlapsRemoval = removals.some((edit) => at < edit.end && at + needle.length > edit.start);
    if (overlapsInsertion || overlapsRemoval) continue;
    removals.push({ start: at, end: at + needle.length, buffer: Buffer.alloc(0), label: block.trim().slice(0, 48) });
    reclaimedBytes += needle.length;
  }
  if (reclaimedBytes < addedBytes) {
    throw new Error(
      '可回收空间不足：需要 ' + addedBytes + ' 字节，仅找到 ' + reclaimedBytes + ' 字节。' +
      '该版本可能调整了注释结构，请人工适配 SPACE_RECLAIM_BLOCKS。',
    );
  }

  const edits = [...insertions, ...removals].sort((a, b) => (b.start - a.start) || (b.end - a.end));
  let patched = source;
  for (const edit of edits) {
    patched = Buffer.concat([patched.subarray(0, edit.start), edit.buffer, patched.subarray(edit.end)]);
  }

  if (patched.length > source.length) {
    throw new Error('补丁后长度超出原文件：' + patched.length + ' > ' + source.length);
  }
  let paddingBytes = 0;
  if (patched.length < source.length) {
    paddingBytes = source.length - patched.length;
    patched = Buffer.concat([patched, Buffer.alloc(paddingBytes, 0x0a)]);
  }

  const verify = inspect(patched);
  if (!verify.patched) throw new Error('补丁自检失败：新增标志未出现在结果中');

  return {
    buffer: patched,
    report: {
      addedBytes,
      reclaimedBytes,
      paddingBytes,
      reclaimedBlocks: removals.map((edit) => edit.label),
      sha256Before: sha256(source),
      sha256After: sha256(patched),
      lengthBefore: source.length,
      lengthAfter: patched.length,
    },
  };
}
