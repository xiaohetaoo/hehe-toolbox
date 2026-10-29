'use strict';
/* 电源命令识别（纯函数）。
 *
 * 【为什么抽进 lib/】
 * 原来这段正则直接写在 main.js 里，测试 `test-powergate.js` 为了"测它"，
 * 把同样的正则**又抄了一遍**。问题在于：
 *   抄出来的正则在 main.js 改动后**不会跟着变**，于是测试永远全绿 ——
 *   这叫「假绿」：测的是副本，不是真实现。
 * 现在唯一实现在这里，main.js require 它，测试也 require 它，
 * 改一处两边同步，不会再出现"改了主逻辑、测试没感觉"。
 *
 * 【为什么这类命令要单独识别】
 * `shutdown` / `Restart-Computer` 等可以通过「执行任意命令」这个出口绕过高危门禁。
 * 用户没在设置里开启「系统电源操作」时，这些命令必须被拦住；
 * 唯一例外是 `shutdown /a`（取消关机）—— 用户被误触关机后必须能取消，不能拦。
 */

/* 命中即视为电源操作。注意：
 * - 允许前导空白
 * - shutdown 后面必须跟空白或行尾，避免误伤 shutdownxxx 这种同名程序
 * - 兼容 PowerShell 的 SetSuspendState 与 rundll32 powrprof 休眠写法
 */
const POWER_CMD_RE = /^\s*(shutdown(\s|$)|rundll32\.exe\s+powrprof|powershell.*SetSuspendState|Stop-Computer|Restart-Computer)/i;

/* 取消关机 / 查看帮助：必须放行（安全操作）
 * - `shutdown /a`：用户被误触关机后要能取消
 * - `shutdown /?`：只是查看帮助，不执行任何操作（否则「执行任意命令」里
 *   查一下 shutdown 的用法都会被门禁拦下，体验很怪） */
const POWER_CANCEL_RE = /^\s*shutdown\s+(\/a|\/\?)(\s|$)/i;

/**
 * 判断一条命令是否属于「电源操作」。
 * @param {string} cmd
 * @returns {boolean} true = 需要 system-power 门禁
 */
function isPowerCommand(cmd) {
  const s = String(cmd == null ? '' : cmd);
  if (POWER_CANCEL_RE.test(s)) return false; // 取消关机不算危险操作
  return POWER_CMD_RE.test(s);
}

/**
 * 门禁判定：需要拦截时返回错误描述，否则返回 null。
 * 把「是否拦截」与「抛不抛异常」分开，方便测试直接断言。
 * @param {string} cmd
 * @param {boolean} enabled 用户是否已开启「系统电源操作」
 */
function checkPowerGate(cmd, enabled) {
  if (!isPowerCommand(cmd)) return null;
  if (enabled) return null;
  return '「关机 / 重启 / 休眠」属于高危功能，已默认关闭。请到「设置 → 高危功能」中开启后再使用。';
}

module.exports = { POWER_CMD_RE, POWER_CANCEL_RE, isPowerCommand, checkPowerGate };
