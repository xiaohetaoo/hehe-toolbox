'use strict';
/* 电源命令识别（纯函数）。
 *
 * 【为什么抽进 lib/】
 * 原来这段判定直接写在 main.js 里，测试为了"测它"把同样的正则**又抄了一遍**。
 * 抄出来的正则在 main.js 改动后不会跟着变，于是测试永远全绿 —— 这叫「假绿」。
 * 现在唯一实现在这里，main.js 与测试都 require 它，改一处两边同步。
 *
 * 【为什么这类命令要单独识别】
 * `shutdown` / `Restart-Computer` 等可以通过「执行任意命令」这个出口绕过高危门禁。
 * 用户没在设置里开启「系统电源操作」时，这些命令必须被拦住。
 *
 * ================== 这次修了什么（v0.1.9） ==================
 * 原实现是 `^\\s*(shutdown(\\s|$)|...)` 这种**锚定行首**的单层正则，
 * 以下等价写法全部穿透门禁（已逐条实测）：
 *
 *   shutdown.exe /s /t 0          → 「.」导致 shutdown(\s|$) 不匹配
 *   cmd /c shutdown /s            → 行首是 cmd
 *   powershell -c "Stop-Computer" → Stop-Computer 不在行首
 *   rundll32.exe user32.dll,LockWorkStation → 完全没这个分支
 *
 * 改为**两段式**：
 *   1) 剥壳：去掉命令解释器前缀（cmd /c、powershell -c、cmd.exe /c …），
 *      以及路径前缀（C:\Windows\System32\shutdown.exe → shutdown），
 *      再去掉 .exe 后缀；
 *   2) 词根匹配：在当前这一段以及**整条命令**里同时找危险词根。
 *      同时保留白名单式的放行（shutdown /a、shutdown /?）。
 */

/* 危险词根：出现在命令的任何位置都视为电源操作。
 * 用「词根 + 词边界」而不是行首锚定，才能覆盖 `cmd /c shutdown` 这类叠壳写法。 */
const DANGER_TOKENS = [
  'shutdown',
  'stop-computer',
  'restart-computer',
  'setsuspendstate',
  'lockworkstation',      // 锁屏也算电源类（与 DANGEROUS_POWER_ACTIONS 的 lock 对齐）
  'powrprof'              // rundll32 powrprof.dll,SetSuspendState
];

/* 安全放行：取消关机 / 查看帮助。它们含 shutdown 但不执行关机。 */
const SAFE_ARGS_RE = /\s\/(a|\?)(\s|$)/i;

/**
 * 把命令「剥壳」到可判定的形式：
 *   - 去掉外层命令解释器（cmd /c、cmd.exe /c、powershell -c、powershell.exe -Command …）
 *   - 去掉可执行文件的路径前缀与 .exe 后缀
 *   - 引号去掉、连续空白归一、转小写
 */
function normalizeCommand(cmd) {
  let s = String(cmd == null ? '' : cmd).trim();
  // 去外层引号
  s = s.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();

  /* 反复剥壳（最多 4 层，防 `cmd /c powershell -c ...` 这种嵌套）
   * 匹配:
   *   cmd /c ...            cmd /k ...
   *   cmd.exe /c ...
   *   powershell -c ...     powershell.exe -Command ...
   *   pwsh -c ...
   */
  for (let i = 0; i < 4; i++) {
    const m = s.match(/^(?:cmd(?:\.exe)?\s+\/[ck]\s+|(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*?-(?:c|Command|encodedcommand|-)\s+|(?:powershell|pwsh)(?:\.exe)?\s+-c\s+)([\s\S]+)$/i);
    if (!m) break;
    let rest = m[1].trim();
    // 去掉包裹的引号（powershell -c "Stop-Computer"）
    rest = rest.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (rest === s) break;
    s = rest;
  }

  /* 去掉路径前缀与 .exe：C:\Windows\System32\shutdown.exe → shutdown */
  const firstToken = s.split(/[\s]+/)[0] || '';
  if (firstToken) {
    let base = firstToken;
    // 引号内的路径
    base = base.replace(/^['"]|['"]$/g, '');
    if (/[\\/]/.test(base)) {
      base = base.split(/[\\/]/).pop() || base; // 只保留文件名
      s = s.slice(firstToken.length).trim();
      s = base + (s ? ' ' + s : '');
    }
    // 去 .exe
    s = s.replace(/(^|\s)([\w.-]+)\.exe(?=\s|$)/gi, '$1$2');
  }

  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 判断一条命令是否属于「电源操作」。
 * @param {string} cmd
 * @returns {boolean} true = 需要 system-power 门禁
 */
function isPowerCommand(cmd) {
  const raw = String(cmd == null ? '' : cmd);
  if (!raw.trim()) return false;

  /* 1) 安全放行：取消关机 / 查看帮助。
   *    必须在剥壳前后都能认出：`shutdown /a` 与 `cmd /c shutdown /a` 都要放行。 */
  const norm = normalizeCommand(raw);
  if (SAFE_ARGS_RE.test(' ' + norm) && /^shutdown/.test(norm)) return false;
  if (SAFE_ARGS_RE.test(' ' + raw) && /^\s*shutdown\s/i.test(raw)) return false;

  /* 2) 纯文本命令直接放行：`echo shutdown`、`type shutdown.txt` 只是在文本里
   *    提到这个词，不会执行关机。必须在词根匹配**之前**判断，
   *    否则剥壳后的文本里仍含 shutdown 而误拦。 */
  const TEXT_CMDS_RE = /^\s*(echo|type|findstr|grep|where|dir|set|title|more|cat|head|tail)\b/i;
  if (TEXT_CMDS_RE.test(raw)) return false;
  if (TEXT_CMDS_RE.test(norm)) return false;

  /* 3) 剥壳后的命令里找危险词根（词根 + 边界） */
  const hay = ' ' + norm + ' ';
  for (const tok of DANGER_TOKENS) {
    const re = new RegExp('(^|[^\\w-])' + tok.replace(/[-]/g, '\\-') + '($|[^\\w-])', 'i');
    if (re.test(hay)) return true;
  }

  /* 4) 未剥壳成功的复杂写法（如 `start "" shutdown`）也要兜住：
   *    对原文再扫一遍词根。但**必须排除**「只是文本里提到 shutdown」的场景，
   *    例如 `echo shutdown`、`type shutdown.txt` —— 这些不执行关机。 */
  const rawHay = ' ' + raw.toLowerCase().replace(/\s+/g, ' ') + ' ';

  for (const tok of DANGER_TOKENS) {
    const re = new RegExp('(^|[^\\w-])' + tok.replace(/[-]/g, '\\-') + '($|[^\\w-])', 'i');
    if (re.test(rawHay)) {
      // 若整条命令只是 shutdown /a 或 /?，已在第 1 步放行，不会走到这
      return true;
    }
  }
  return false;
}

/**
 * 门禁判定：需要拦截时返回错误描述，否则返回 null。
 * 把「是否拦截」与「抛不抛异常」分开，便于测试直接断言。
 * @param {string} cmd
 * @param {boolean} enabled 用户是否已开启「系统电源操作」
 */
function checkPowerGate(cmd, enabled) {
  if (!isPowerCommand(cmd)) return null;
  if (enabled) return null;
  return '「关机 / 重启 / 休眠」属于高危功能，已默认关闭。请到「设置 → 高危功能」中开启后再使用。';
}

/* 兼容旧导出名（测试与其它模块可能引用） */
const POWER_CMD_RE = /\b(shutdown|stop-computer|restart-computer|setsuspendstate|lockworkstation)\b|\bpowrprof\b/i;
const POWER_CANCEL_RE = SAFE_ARGS_RE;

module.exports = {
  DANGER_TOKENS,
  POWER_CMD_RE,
  POWER_CANCEL_RE,
  normalizeCommand,
  isPowerCommand,
  checkPowerGate
};
