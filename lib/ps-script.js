'use strict';
/* Windows PowerShell 脚本的编码约定（更新/回滚脚本共用）。
 *
 * 【为什么必须有这一层】
 * 便携版「重启并替换」会把 `%APPDATA%\核核工具箱\update\...` 这条路径以
 * 单引号字符串的形式嵌进 .ps1，然后 `powershell.exe -File` 直接执行。
 * Windows PowerShell 5.1 对**没有 BOM** 的 .ps1 按系统 ANSI 代码页解码
 * （zh-CN 是 GBK，英文系统是 1252）：UTF-8 的中文字节被读成乱码 →
 * `Get-Item -LiteralPath $newExe` 找不到文件 → catch → exit 1。
 *
 * 实测（PSVersion 5.1.26100.9818，同一段代码、同一个中文路径）：
 *   无 BOM 写盘 → `Test-Path -LiteralPath $p` 输出 MISSING
 *   加 BOM 写盘 → 输出 EXISTS
 *
 * 结果是「重启并替换」100% 失败且不留可见错误：主进程 1 秒后已经
 * app.exit(0)，用户重启回来还是旧版本。rollback.ps1 同病，所以兜底也坏。
 *
 * 【为什么单独成文件】替换脚本的生成逻辑在 main.js 里内联，没法整体在
 * 纯 Node 下执行；把「加不加 BOM」这一条抽成纯函数后，测试就能真的把它
 * 写到磁盘、用 powershell.exe 跑一遍断言 EXISTS —— 而不是只对源码做
 * 字符串断言（历史上正是字符串断言让这个缺陷活了下来）。
 *
 * ⚠️ 保持零依赖：lib/ 下的模块不允许 require electron。
 */

const BOM = '\uFEFF';

/**
 * 给脚本内容加 UTF-8 BOM，保证 Windows PowerShell 5.1 按 UTF-8 解码。
 * 已经是 BOM 开头时不重复加（幂等）。
 * @param {string} text
 * @returns {string}
 */
function withBom(text) {
  const s = String(text == null ? '' : text);
  return s.startsWith(BOM) ? s : BOM + s;
}

module.exports = { BOM, withBom };