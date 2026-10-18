# dsh-quick-restart

> One-click "Restart" entry for the DSH desktop system tray on Windows.

给 DSH 桌面版的系统托盘右键菜单加一项**「重启」**：安装 / 卸载 / 更新组件后一键重启生效，不必再手动「托盘退出 → 重新启动」。

## 效果

托盘右键菜单：

    打开 DeepSeek Harness
    ──────────────────────
    重启                    ← 本工具新增
    ──────────────────────
    退出 DeepSeek Harness

点击「重启」：没有进行中的任务时立即重启；Host 报告有进行中任务或已排定的定时任务时，先弹官方确认框，取消则不重启。

## 环境要求

- Windows 10 / 11（托盘项只在 Windows 上创建）
- 已安装 DSH 桌面版
- Node.js 18+，或使用 DSH 自带的运行时（入口脚本会自动查找）
- 写入安装目录需要管理员权限

## 快速开始

1. 克隆本仓库到任意目录；
2. 双击 `patch-tray-restart.cmd`（自动请求管理员权限），窗口最后出现 `RESULT: PATCH APPLIED` 即成功；
3. 系统托盘右键 DSH 图标 → 退出 DeepSeek Harness，然后重新启动 DSH；
4. 托盘右键菜单中即出现「重启」。

备选入口：右键 `patch-tray-restart.ps1` → 使用 PowerShell 运行；或在管理员终端直接执行 `node patch-tray-restart.mjs`。

## 用法

| 操作 | 命令 |
| --- | --- |
| 应用补丁 | 双击 `patch-tray-restart.cmd` |
| 只检查状态 | `node patch-tray-restart.mjs --check` |
| 演练（不改安装目录） | `node patch-tray-restart.mjs --dry-run` |
| 回滚 | `node patch-tray-restart.mjs --revert` |

可选参数：`--install-dir <安装目录>`、`--asar <app.asar 路径>`、`--backup <备份目录>`。

## 原理

DSH 桌面版的托盘由 Electron 主进程创建，代码位于安装目录 `resources/app.asar` 内的 `lib/main.js`。原菜单模板只有「打开」「退出」两项，而官方已内置重启所需的一切：文案 `restartApplication`（中文「重启」/ 英文 "Restart"），以及 `app.relaunch()` + `quitWithoutConfirmation()`（开发模式的「重启应用与 Host」用的就是它）。

本工具只做两处最小插入：

1. 托盘菜单模板中插入一个菜单项，调用 `this.options.restart()`；
2. `new DesktopTray({...})` 的构造参数中插入 `restart` 回调：先取退出确认，再 `app.relaunch()` 并跳过重复询问。

因为 asar 头部记录了每个文件的 `offset/size`，补丁**不改变文件长度**：先回收目标文件内的行级注释，再在文件末尾补齐差额空白，随后同步更新头部 integrity 哈希。因此无需解包或重打包上百 MB 的 asar，其余上万个条目与头部布局完全不受影响。

写入前会解析可执行文件的 Electron fuse wire；若 `EnableEmbeddedAsarIntegrityValidation` 被启用，工具会拒绝执行。

## 升级后要重做

DSH 桌面版更新会整体替换安装目录，补丁随之失效：升级后重新运行一次即可（工具幂等，锚点失配时会拒绝执行，不会写出坏文件）。

## 回滚

`node patch-tray-restart.mjs --revert` 从最近一次备份还原 `lib/main.js` 与头部哈希；备份位于 `backup/`（已在 .gitignore 中排除），回滚后同样需要重启 DSH。

## 排错

| 现象 | 处理 |
| --- | --- |
| 提示没有写入权限 | 以管理员身份运行入口脚本 |
| 提示 app.asar 被占用 | 先从托盘退出 DSH，再运行 |
| 提示锚点缺失 / 不唯一 / 可回收空间不足 | 上游改动了托盘代码，需要人工适配 `src/patch.mjs` 中的锚点常量 |
| 托盘没有「重启」 | 未重启 DSH，或之后被更新覆盖；用 `--check` 查看状态 |
| 入口脚本报一堆 “××不是内部或外部命令” | 脚本被按非 UTF-8 代码页解析。仓库内的 `.cmd` / `.ps1` 刻意保持纯 ASCII，请勿改存为带中文的编码 |
| 控制台里中文显示为乱码 | 不影响执行，看末尾的 `RESULT:` 标记行 |

## 目录结构

    patch-tray-restart.mjs   主入口：apply / --check / --dry-run / --revert
    patch-tray-restart.cmd   双击入口（UAC 提权 + 定位 Node.js），纯 ASCII
    patch-tray-restart.ps1   备用入口（PowerShell），纯 ASCII
    src/asar.mjs             asar 解析、定长原地写入、fuse wire 读取、安装目录探测
    src/patch.mjs            锚点替换与等长空间腾挪规则
    backup/                  运行时生成的回滚备份（不入库）

## 说明与免责

- 本仓库只包含补丁工具本身，不包含 DSH 及其桌面版的任何源码；代码中出现的少量字符串仅用于在安装包内定位插入点。
- 工具会修改官方安装包文件，属于非官方支持的做法，请自行评估风险；DSH 升级后需要重跑。
- 许可证见 [LICENSE](LICENSE)。
