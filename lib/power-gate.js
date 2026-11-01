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
  /* 【先展开已知环境变量，再剥壳】
   * 漏拦样本 `cmd /c %ComSpec% /c shutdown /s` 的成因就在这里：
   * 外层 cmd /c 剥掉之后剩下 `%ComSpec% /c shutdown /s`，
   * 而内层外壳写的是变量名而不是 "cmd"，剥壳正则自然认不出来。
   * 展开后它变成 C:\Windows\System32\cmd.exe /c shutdown /s —— 这时
   * 路径前缀 + /c 就能被下面的壳正则吃到（见 SHELL_PATH_PREFIX）。
   * 放在这里而不是调用方，是为了让「剥壳」这件事本身对变量也成立。 */
  s = expandKnownEnv(s);
  // 去外层引号
  s = s.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();

  /* 反复剥壳（最多 4 层，防 `cmd /c powershell -c ...` 这种嵌套）。
   *
   * 三种壳：
   *   cmd [/开关]... /c|/k   —— cmd 的开关可以出现在 /c 之前
   *   powershell [-参数]... -c|-Command|-EncodedCommand|-
   *   pwsh 同上
   *
   * 【cmd 的开关可以出现在 /c 之前，原正则只认「cmd 空格直接跟 /c」】
   * 实测穿透的写法（都会在 cmd.exe 里真的执行内层命令）：
   *   cmd /d /c shutdown /s        /d 关闭 AutoRun
   *   cmd /e:on /c shutdown /s     /e 开命令扩展
   *   cmd /u /c shutdown /s        UNC 输出
   * 现在允许 `/c` 前面出现任意个 `/字母[:值]` 形式的开关。 */
  const CMD_SHELL = /(?:[^\x20\x22\x27]*[\\/])?cmd(?:\.exe)?\s+(?:\/[a-z](?::[^\s]+)?\s+)*\/[ck]\s+/i;
  const PS_SHELL = /(?:[^\x20\x22\x27]*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+.*?-(?:c|Command|EncodedCommand)\s+/i;
  const PS_SHELL_ALT = /(?:[^\x20\x22\x27]*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+-c\s+/i;
  for (let i = 0; i < 4; i++) {
    let rest = null;
    /* 逐个试三种壳，命中就剥掉前缀；-EncodedCommand 的 base64 后面单独处理。 */
    for (const re of [CMD_SHELL, PS_SHELL, PS_SHELL_ALT]) {
      const m = s.match(re);
      if (m) { rest = s.slice(m[0].length).trim(); break; }
    }
    if (rest == null) break;
    // 去掉包裹的引号（powershell -c "Stop-Computer"）
    rest = rest.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (rest === s || !rest) break;
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

  /* 【空白归一不能吃掉换行】
   * PowerShell 把换行当**语句分隔符**（实测 ps('echo hi\nWrite-Output X')
   * 两条都执行了），而 cmd 只执行第一条。早期这里是 s.replace(/\s+/g, ' ')：
   * 换行被折成空格，于是 `echo hi\nshutdown /s` 归一后只剩一段、
   * 首词是 echo，走到文本豁免就被整条放行 —— 真关机照跑。
   * 现在只折空格与制表符，换行原样留给 splitSegments 当分隔符。 */
  return s.replace(/[^\S\r\n]+/g, ' ').replace(/[ \t]+$/gm, '').trim().toLowerCase();
}

/* 纯文本命令：它们会把后面的词当**文本**输出/查找，不会执行它。
 * 只在「整条命令的每一段都是这一类」时才放行（见 isPowerCommand 第 2 步）。 */
const TEXT_CMDS_RE = /^\s*(echo|type|findstr|grep|where|dir|set|title|more|cat|head|tail)\b/i;

/* ================== 环境变量展开 ==================
 * 【为什么必须展开 %ComSpec%】
 * 实测漏拦：`cmd /c %ComSpec% /c shutdown /s`。
 * 内层外壳写成变量就不是字面量 "cmd"，剥壳正则认不出来；首词变成 "%comspec%"，
 * 词根判定也因此失效 —— 一条能真关机的命令被整条放行。
 *
 * 只展开**本机确定存在、语义固定**的那几个。其它变量不展开：
 * 展开不了就等于判不出来，而判不出来必须 fail-closed（见 hasUnknownVar），
 * 所以「换个变量名试试」不会变成绕过路径。
 */
const KNOWN_ENV = {
  comspec: () => process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
  systemroot: () => process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
  windir: () => process.env.windir || process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows',
  systemdrive: () => process.env.SystemDrive || 'C:',
};

/**
 * 展开已知环境变量（%VAR% 形式，大小写不敏感）。未知变量原样保留。
 * @param {string} text
 * @returns {string}
 */
function expandKnownEnv(text) {
  return String(text == null ? '' : text).replace(/%([^%\s]+)%/g, (whole, name) => {
    const fn = KNOWN_ENV[String(name).toLowerCase()];
    if (!fn) return whole;
    try { return fn(); } catch (e) { return whole; }
  });
}

/**
 * 命令里是否残留「未展开的变量」。
 * 用来做 fail-closed：`%FOO% shutdown /s` 这种判不出内层是什么的写法
 * 一律按需要门禁处理 —— 「解不出来就不放行」比放过一条真关机安全。
 * @param {string} text
 * @returns {boolean}
 */
function hasUnknownVar(text) {
  return /%[^%\s]+%/.test(String(text == null ? '' : text));
}

/* 整条命令是不是「全是文本命令」。空串不算（不能让空命令走这条豁免）。 */
function allTextSegments(text) {
  const segs = splitSegments(text);
  if (!segs.length) return false;
  return segs.every((s) => TEXT_CMDS_RE.test(s));
}

/* 取消关机 / 查看帮助的**安全段落**判定。
 *
 * 【必须逐段判，不能对整条命令判】早期是
 *   if (SAFE_ARGS_RE.test(' ' + norm) && /^shutdown/.test(norm)) return false;
 * 也就是「整条命令以 shutdown 开头 + 出现过 /a」就整条放行，于是
 *   shutdown /a & shutdown /s           （后面那段真的关机）
 *   shutdown /s /t 0 & shutdown /a       （顺序颠倒同样穿透）
 * 全被放行。这里要求**每一段**都是 shutdown 且都带 /a 或 /?，
 * 任何一段不是就交给后面的危险词判定去处理。
 *
 * @param {string} text
 * @returns {boolean}
 */
function allSafeShutdown(text) {
  const segs = splitSegments(text);
  if (!segs.length) return false;
  return segs.every((seg) => /^shutdown\b/i.test(seg.trim()) && SAFE_ARGS_RE.test(' ' + seg.trim()));
}

/**
 * 判断一条命令是否属于「电源操作」。
 * @param {string} cmd
 * @returns {boolean} true = 需要 system-power 门禁
 */
function isPowerCommand(cmd) {
  const raw0 = String(cmd == null ? '' : cmd);
  if (!raw0.trim()) return false;

  /* 【0) 先展开已知环境变量，否则 `%ComSpec% /c shutdown /s` 直接穿透】
   * 实测漏拦的一种写法：
   *   cmd /c %ComSpec% /c shutdown /s
   * 里层外壳是 %ComSpec%（= C:\Windows\System32\cmd.exe），它不是一个能以
   * 字面量识别的 "cmd"，于是剥壳剥不动、首词变成 "%comspec%"，词根判定也失效。
   * 这里只展开本机确定存在的那几个变量（大小写不敏感）；
   * 其余未知变量不展开 —— 但下面第 5 步会把「含未展开变量且无法判定」的情形
   * 按 fail-closed 处理，避免「换个变量名就绕过去」。
   */
  const raw = expandKnownEnv(raw0);

  /* 1) 安全放行：取消关机 / 查看帮助。逐段判（见 allSafeShutdown 的注释）。
   *    `shutdown /a` 与 `cmd /c shutdown /a` 都要放行，所以先看剥壳后的形态；
   *    raw 那一次是为了覆盖「没有外壳、直接就是 shutdown /a」的情形。 */
  const norm = normalizeCommand(raw);
  if (allSafeShutdown(norm)) return false;
  if (allSafeShutdown(raw)) return false;

  /* 2) 纯文本命令直接放行：`echo shutdown`、`type shutdown.txt` 只是在文本里
   *    提到这个词，不会执行关机。必须在词根匹配**之前**判断，
   *    否则剥壳后的文本里仍含 shutdown 而误拦。
   *
   *    【必须逐段判，不能拿整条原文去测】早期这里是
   *      if (TEXT_CMDS_RE.test(raw)) return false;
   *    而 TEXT_CMDS_RE 是 ^ 锚定的：只要**整条命令的第一个词**是 echo，
   *    整条就被放行，后面串接的真命令根本没被检查。实测穿透的三条：
   *      echo hi & shutdown /s /t 0
   *      type nul & shutdown /s
   *      dir > x.txt && shutdown /s
   *    （exec:run 的 shellType='cmd' 会真的执行它们。）
   *    现在改为「所有段落都是文本命令才放行」。
   *
   *    【只判 raw，不再判 norm】raw 才是真正被交给 shell 执行的那串东西；
   *    norm 是剥掉外壳后的形态，它的分段边界和真实语句边界并不总是一致
   *    （换行就是例子：PowerShell 认换行，而 cmd 不认）。多判一次 norm
   *    只会多出一条「看起来更宽松」的放行路径，没有对应的真实语义。 */
  if (allTextSegments(raw)) return false;

  /* 2.5) fail-closed：判不出来的写法一律按「需要门禁」处理。
   *
   * (a) -EncodedCommand / -e / /ec 这类 base64/编码参数**无法安全解码**。
   *     实测漏拦：powershell -EncodedCommand UwB0AG8AcAAtAEMAbwBtAHAAdQB0AGUAcgA=
   *     （解出来就是 Stop-Computer）。我们可以真的去解 base64，但那样等于
   *     在门禁里实现一个 PowerShell 解码器 —— 永远有下一个没覆盖的编码形式。
   *     取舍：解不出来就不放行。用户真要用这类命令，去设置里开「系统电源操作」。
   *
   * (b) 命令里残留未展开的变量（%FOO%）：同样判不出来。
   *     已展开的 %ComSpec% / %SystemRoot% 等不算（见 expandKnownEnv）。 */
  if (/(^|\s)(-EncodedCommand|-e|-[a-z]*e)\b/i.test(raw) || /\s\/ec\s/i.test(raw)) {
    /* 只认「powershell 系」的编码参数，避免把 -e 之类的普通开关误当电源。
     * 但 -EncodedCommand 本身与解释器无关，出现即拒。 */
    if (/-EncodedCommand\b/i.test(raw) || /^(?:powershell|pwsh)\b[^\n]*\s(-e|-[a-z]*e)\b/i.test(norm || raw)) {
      return true;
    }
    if (/\s\/ec\s/i.test(raw) && /^(?:powershell|pwsh)\b/i.test(norm || raw)) return true;
  }
  if (hasUnknownVar(raw)) {
    /* 未知变量 + 无危险词根：保守起见仍按危险处理，因为变量可能展开成任何东西。
     * 纯文本命令已在上面放行，所以 `echo %PATH%` 之类不受影响。 */
    return true;
  }

  /* 3) + 4) 判定「可执行位」里是不是危险词。
   *
   * 【为什么不能对整条命令做词根匹配】
   * 旧实现对 norm / raw **整串**扫词根，而 `.` `\` `:` `,` 都不算 \w 或 -，
   * 于是文件名里带 shutdown 的普通命令全被拦下：
   *   del shutdown.log / ren shutdown.txt x.txt / copy shutdown.exe d:\
   *   tasklist | findstr shutdown / move shutdown.log backup\ / notepad shutdown.log
   * 全是日常操作，却会弹「高危功能已关闭」。
   *
   * 【正确判据】危险词必须出现在「可执行位」——即管道/串接后的每个子命令的首词
   * （剥掉目录前缀与 .exe），或紧随 start / call 这类启动器之后的那个词。
   * 出现在参数位、路径位一律不算。
   * 例外：rundll32 是电源入口，它的参数里出现 powrprof / setSuspendState /
   * LockWorkStation 仍要拦（这是 `rundll32 powrprof.dll,SetSuspendState` 的真实形态）。 */
  for (const srcText of [norm, raw]) {
    if (execHeads(srcText).some((h) => isDangerHead(h))) return true;
    /* 【for 循环体里的命令也算「可执行位」】
     * 实测漏拦：`for %i in (x) do shutdown /s`。
     * 这一段的首词是 "for" 而不是危险词 —— 真正要执行的命令在 do 之后。
     * 同理 `for /f ... do shutdown /s`、`for %i in (x) do (shutdown /s)`。
     * 这里把 do 之后的部分、以及括号组内的内容各当独立的命令集合再判一次。 */
    for (const seg of splitSegments(srcText)) {
      if (/^for\b/i.test(seg.trim())) {
        const body = seg.replace(/[\s\S]*?\bdo\b/i, '');
        if (execHeads(body).some((h) => isDangerHead(h))) return true;
      }
    }
    /* 括号组 ( ... ) 里也可能藏着命令：`(shutdown /s)`、`for %i in (x) do (shutdown /s)` */
    for (const seg of splitSegments(srcText)) {
      for (const g of extractParens(seg)) {
        if (execHeads(g).some((h) => isDangerHead(h))) return true;
        const body = g.replace(/[\s\S]*?\bdo\b/i, '');
        if (/do\b/i.test(g) && execHeads(body).some((h) => isDangerHead(h))) return true;
      }
    }
    // rundll32 参数位特判
    for (const seg of splitSegments(srcText)) {
      const head = headWord(seg);
      if (head === 'rundll32') {
        const joined = DANGER_TOKENS.map((t) => t.replace(/[-]/g, '\\-')).join('|');
        if (new RegExp(joined, 'i').test(seg)) return true;
      }
    }
  }
  return false;
}

/* 取出文本里所有最外层括号组的内容（只覆盖常见写法，不做完整解析）。 */
function extractParens(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  let depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') { if (depth === 0) start = i + 1; depth++; }
    else if (s[i] === ')') { if (depth > 0) { depth--; if (depth === 0 && start > 0) out.push(s.slice(start, i)); } }
  }
  return out;
}

/* 把命令按管道/串接符切成子命令。
 *
 * 【为什么要自己做词法扫描，而不是 split(/[|&;]/)】
 * 早期是一条正则 split，有两个洞：
 *   1) 不认引号 —— `app.exe --msg "hello & shutdown now"` 会被从 & 处切开，
 *      切出来的 `shutdown now` 又成了「可执行位」，于是普通参数被误判成电源操作；
 *   2) 不认换行 —— PowerShell 用换行分隔命令，`shutdown /s` 单独一行写在
 *      另一条命令后面时不会被切成独立段落。
 * 现在按引号状态逐字符扫：引号内的 | & ; 一律不算分隔符，
 * 换行永远算分隔符（连续多个分隔符合并成一个）。 */
function splitSegments(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\n' || c === '\r') { out.push(cur); cur = ''; continue; }
    if (c === '|' || c === '&' || c === ';') {
      out.push(cur);
      cur = '';
      /* || && 这类双写算一个分隔符 */
      while (i + 1 < s.length && (s[i + 1] === '|' || s[i + 1] === '&')) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/* 取一条子命令的「首词」：剥掉引导引号、目录前缀与 .exe，跳过 start/call 这类启动器 */
function headWord(seg) {
  let s = String(seg || '').trim();
  for (let guard = 0; guard < 3; guard++) {
    const m = s.match(/^start\s+""\s+/i) || s.match(/^start\s+/i) || s.match(/^call\s+/i);
    if (!m) break;
    s = s.slice(m[0].length).trim();
  }
  const tok = (s.match(/^["']?([^"' ]+)/) || [])[1] || '';
  return tok
    .replace(/^.*[\\/]/, '')   // 去掉目录前缀，C:\Windows\System32\shutdown.exe -> shutdown.exe
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

/* 所有子命令的首词 */
function execHeads(text) {
  return splitSegments(text).map(headWord).filter(Boolean);
}

/* 首词是否危险词（允许带连字符与否两种写法） */
function isDangerHead(head) {
  const h = String(head || '').toLowerCase();
  for (const tok of DANGER_TOKENS) {
    const t = tok.toLowerCase();
    if (h === t || h === t.replace(/[-]/g, '')) return true;
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
