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

/* 安全放行：取消关机 / 查看帮助。它们含 shutdown 但不执行关机。
 *
 * 【这只是「必要条件」，不是充分条件】
/* 安全放行：取消关机 / 查看帮助。它们含 shutdown 但不执行关机。
 *
 * 【这只是「必要条件」，不是充分条件】
 * 早期 allSafeShutdown 直接用它做判据，于是只要段里出现 /a 或 /? 就放行：
 *   shutdown /a /s        → 放行（真会关机：/s 才是执行动作）
 *   shutdown /s /a        → 放行
 *   shutdown /? /s        → 放行
 *   shutdown /a /r /t 0   → 放行
 * 实测这四条 isPowerCommand 全部返回 false。而含 & 的多段写法
 * （`shutdown /s /t 0 & shutdown /a`）能被拦下，说明漏洞只在**段内**。
 * 现在这个正则只用来快速排除，真正的判据是下面的 SAFE_ONLY 严格枚举。
 *
 * 【横杠写法必须同样放行】Windows 的 shutdown.exe 对 /a 与 -a 完全等价
 * （微软文档两种形式都列），`shutdown -a` 是取消关机的真实命令。
 * 只认斜杠会把横杠形式误拦成"高危功能已关闭" —— 用户想取消刚才
 * 误设的关机反而被门禁挡住。审查轮黑盒实测抓到（v0.8.3 收尾后）。 */
const SAFE_ARGS_RE = /\s[/-](a|\?)(\s|$)/i;

/* 【安全段的严格判据：只允许 shutdown + /a 或 /?】
 * 某一段除了 `shutdown` 与 `/a`（或 `/?`）之外，不得出现任何一个
 * 会真的执行电源动作的开关。宁可多拦（多弹一次确认框），
 * 也不能漏放一条真关机 —— 放行的代价是用户的机器被关掉。
 *
 * 【为什么只列会"执行动作"的开关，不列 /t /f】
 * /t（倒计时）与 /f（强杀进程）**单独出现时不执行任何电源动作**：
 * 它们只是修饰参数，必须配 /s、/r、/g 等才有意义。而配对的情况已经被
 * /s、/r、/g 本身拦住了。
 * 实测反例：`shutdown /a /t 0` 是「立即取消已排定的关机」，
 * 把它也拦下来就是误伤（既有测试 mustAllow 里就锁着这一条）。
 * 判据要贴合语义，不能为了"看起来更严"把正常命令也一起关掉。
 *
 * 【斜杠与横杠都要认】同 SAFE_ARGS_RE：shutdown -s 与 /s 一样会关机，
 * 漏掉横杠形式 = `shutdown -s /t 0` 直接穿透门禁（黑盒实测确认）。 */
const UNSAFE_SWITCH_RE = /(^|\s)[/|-](s|sg|r|g|h|l|p|m|d|c)(\s|$|\d|:)/i;

/* 命令长度上限（字符）。超过就不分析、直接按需要门禁处理。
 * 依据：正常电源命令行不到 200 字符；而正则在大输入上的耗时曾实测到
 * 40000 字符约 2 秒（同步阻塞主进程）。见 isPowerCommand 里的说明。 */
const POWER_CMD_MAX_LEN = 8192;

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

  /* 【不带空格的壳形态必须先归一化】
   * `cmd/c shutdown /s`、`cmd.exe/c shutdown /s` 这两种写法在 cmd.exe 里
   * 确实会执行内层命令（实测 `cmd/c echo XXX`、`cmd.exe/c echo XXX` 都打印了 XXX），
   * 但下面的壳正则要求 `cmd` 与 `/c` 之间有空白，于是认不出来。
   * 更糟的是后面「削路径前缀」那一步：它看到 `cmd/c` 里的 `/`，
   * 以为是路径分隔符，把首词削成了 `c` —— 于是连词根都不见了。
   * 所以先在这里把 `/c`、`/k` 前补一个空格，让它变成正则认识的标准形态。
   * 只动紧跟在 cmd/cmd.exe 后面的那一个开关，不影响真正的路径。 */
  s = s.replace(/^(cmd|cmd\.exe)\/([ck])\b/i, '$1 /$2');

  /* 【记录：路径前缀 + 无空格 /c 不修，因为它本来就不执行】
   * 审查提过一条语义缺口：`C:\Windows\System32\cmd/c shutdown /s` 判 false。
   * 逐条实测（cmd 层 4 种、PowerShell 层 3 种、引号变体）结论一致：
   *   · cmd 层：`<路径>/cmd/c xxx` → 「系统找不到指定的路径」/「目录名无效」，
   *     内层命令**不执行**（用唯一标记串验证，标记从未出现）；
   *   · PowerShell 层：`<路径>\cmd/c xxx` → 「无法将…识别为 cmdlet」，
   *     同样不执行（PowerShell 里要写成 `& "路径\cmd.exe" /c xxx`）。
   * 也就是说它是**我们判得更严**，不是被绕过。
   * 放宽识别去"补"它没有安全收益（少拦一条本来就无害的写法），
   * 只会扩大识别面、增加误拦。所以这里只记录，不改判据。
   * scripts/test-powergate-ps.js 的 PB1+PB2 把「确实不执行」这个前提钉住了：
   * 若哪天 Windows 改了行为，那两条会先红。 */

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
  /* 【三条壳正则的路径前缀不能跨空格，且必须锚定段首】
   * 原来写的是 `(?:[^\x20\x22\x27]*[\\/])?` —— 它允许前缀里出现任意非空白字符，
   * 在一条长命令上会先贪婪吃掉一大段再回溯，复杂度接近 O(n²)：
   * 实测 20000 字符时三条各约 160ms，40000 字符合计约 2s，
   * 而这条路径来自渲染层 IPC / 命令收藏 / 导入 —— 属于公开通道，
   * 一个四万字符的字符串就能同步阻塞主进程两秒。
   * 现在：① 前缀限定为「不含空白的路径片段」，② 用 ^ 锚定段首，
   * 引擎一眼就知道该从哪开始匹配，不再回溯。
   * 上面的 `s.replace(/^(cmd|cmd\.exe)\/([ck])\b/i, ...)` 已经把无空格的
   * cmd/c 归一成标准形态，所以这里不需要再兼容那种写法。 */
  const SHELL_PREFIX = '(?:[^\\s"\'\\\\/]*[\\\\/])?';
  const CMD_SHELL = new RegExp('^' + SHELL_PREFIX + 'cmd(?:\\.exe)?\\s+(?:\\/[a-z](?::[^\\s]+)?\\s+)*\\/[ck]\\s+', 'i');
  const PS_SHELL = new RegExp('^' + SHELL_PREFIX + '(?:powershell|pwsh)(?:\\.exe)?\\s+[\\s\\S]*?-(?:c|Command|EncodedCommand)\\s+', 'i');
  const PS_SHELL_ALT = new RegExp('^' + SHELL_PREFIX + '(?:powershell|pwsh)(?:\\.exe)?\\s+-c\\s+', 'i');
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

  /* 去掉路径前缀与 .exe：C:\Windows\System32\shutdown.exe → shutdown
   *
   * 【不能把「命令 + 开关」当成路径削掉】
   * 旧逻辑只要首词里出现 `/` 就当成路径：`cmd/c` 两半之后首词是 `cmd/c`，
   * 它被削成 `c`，命令本身丢了 —— 上面虽然已经把带空格的形态归一化，
   * 但其它形式的 `xx/yy` 仍可能在别的环节出现。
   * 所以这里加一道判断：首词以 `/` 开头（是开关而不是路径）时跳过。
   * 真正的 Windows 路径不会以 `/` 开头（`/c` 这种是 cmd 的开关）。 */
  const firstToken = s.split(/[\s]+/)[0] || '';
  if (firstToken) {
    let base = firstToken;
    // 引号内的路径
    base = base.replace(/^['"]|['"]$/g, '');
    const looksLikeSwitch = base.startsWith('/') || base.startsWith('-');
    if (!looksLikeSwitch && /[\\/]/.test(base)) {
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

/* ================== -EncodedCommand 的缩写形态 ==================
 * 【为什么不能只认字面量 -EncodedCommand】
 * PowerShell 的参数允许**无歧义前缀缩写**，`-EncodedCommand` 因此有一整串
 * 等价写法。旧实现只认 `-EncodedCommand` 和 `-e`（正则 `-[a-z]*e\b`），
 * 中间的 `-ec` / `-en` / `-enc` / `-Enco` / `-Encoded` 全部放行。
 *
 * 实测（spawnSync 直接起 powershell.exe，载荷 `Write-Output PWNED`，
 * 换用另一段载荷 `ZZZ-DISTINCT` 复验结论一致）：
 *
 *   会执行 base64 载荷的写法：
 *     -e                （PowerShell 把 -e 当 -EncodedCommand）
 *     -ec               （同上，**注意它不是 "encodedcommand" 的前缀**）
 *     -en  -enc  -enco  -encoded  -encodedc ... -encodedcommand
 *                         （"encodedcommand" 的真前缀，长度 >= 2 全部有效）
 *
 *   不会执行的写法（不能误伤）：
 *     -ea -ep -ex         （被当成别的参数，走帮助/静默退出）
 *     -eb -ed -ef ... -ez （报 "not recognized"）
 *     -ecc -ecm -ecx -ecn -ence -nco -n -coded ...（同样 not recognized）
 *     -ExecutionPolicy / -File / -NoExit / -NonInteractive（正常参数）
 *
 * 所以判据是两条并集：
 *   ① name === 'e' 或 'ec'
 *   ② name 是 'encodedcommand' 的前缀且长度 >= 2
 * `-e` 在别的命令行里是常见开关（如 findstr -e），所以 ① 里的 'e'
 * 只在命令行确实是 powershell/pwsh 系时才生效，与旧实现保守程度一致；
 * 'ec' 与其他前缀没有第二含义，不必限定外壳。
 * scripts/test-powergate.js 的 PG-ENC-* 把这套实测结论逐条钉住了。 */
const ENCODED_CMD_NAME = 'encodedcommand';

/**
 * 某个开关名是否等价于 PowerShell 的 -EncodedCommand。
 * @param {string} name 不含前导 - 的开关名
 * @returns {boolean}
 */
function isEncodedFlagName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (n === 'ec') return true;
  if (n.length >= 2 && ENCODED_CMD_NAME.startsWith(n)) return true;
  return false;
}

/**
 * 命令里是否出现 -EncodedCommand 的（可能缩写的）形态。
 * @param {string} raw 原始命令行
 * @returns {boolean}
 */
function hasEncodedFlag(raw) {
  const s = String(raw == null ? '' : raw);
  /* 只扫 `-开关` 形态。`/ec` 这类 cmd 写法留在外面按「必须跟着 powershell 系」
   * 单独判 —— 那个判据更窄，放宽会平白多出误拦（cmd 的 /e 是命令扩展开关）。 */
  const reDash = /(^|[\s"'(|&;])-([A-Za-z]+)/g;
  let m;
  while ((m = reDash.exec(s)) !== null) {
    if (isEncodedFlagName(m[2])) return true;
  }
  /* 单字符 -e / -E：只在 powershell 系命令行里算编码参数。 */
  if (/(^|[\s"'(|&;])-[eE](?=$|[\s"':])/.test(s) && /(^|[\s"'(|&;])(powershell|pwsh)(\.exe)?\b/i.test(s)) return true;
  return false;
}

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
  const s = String(text == null ? '' : text);
  /* 【cmd 的 %VAR% 与 PowerShell 的 $env:VAR 都要展开】
   * 漏拦样本（实测在 ps 里会执行，门禁却放行）：
   *   & $env:ComSpec /c shutdown /s
   * 以前只认 %VAR%，$env:ComSpec 原样留着 → 首词是 "$env:comspec"、
   * 不是危险词 → 整条放行。两种语法在本机指向同一个 cmd.exe，必须一样处理。
   * 仍然只展开 KNOWN_ENV 里那几个确定存在的变量：未知变量留给 hasUnknownVar
   * 做 fail-closed，所以「换个变量名」不会变成绕过路径。 */
  const withCmdVars = s.replace(/%([^%\s]+)%/g, (whole, name) => {
    const fn = KNOWN_ENV[String(name).toLowerCase()];
    if (!fn) return whole;
    try { return fn(); } catch (e) { return whole; }
  });
  return withCmdVars.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (whole, name) => {
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
  return segs.every((seg) => {
    let t = seg.trim();
    /* 【if <条件> shutdown /a 也要放行】
     * 条件式只取条件成立后执行的命令 —— 它仍是"取消关机"，无害。
     * 不剥这一层的话 `if 1==1 shutdown /a` 会被判成电源操作而误拦，
     * 用户想取消刚排的关机反而被门禁挡住（与 shutdown -a 那次同类）。
     * 注意：只把 body 拿去做安全判定，**整段仍要过 UNSAFE_SWITCH_RE**——
     * 否则 `if 1==1 shutdown /a /s` 会靠 /a 蒙混。 */
    if (/^if\b/i.test(t)) {
      const body = stripIfCondition(t);
      if (!body) return false;
      /* 整段不许含执行性开关（条件里若藏了 /s 也算不安全） */
      if (UNSAFE_SWITCH_RE.test(t)) return false;
      t = body;
    }
    /* 必须先是以 shutdown 开头的一段，且含有 /a 或 /? */
    if (!/^shutdown\b/i.test(t)) return false;
    if (!SAFE_ARGS_RE.test(' ' + t)) return false;
    /* 【严格枚举：段内不得出现任何会执行电源动作的开关】
     * SAFE_ARGS_RE 只回答「有没有 /a」，回答不了「有没有别的」。
     * 这里补上后 half 条件才成立：`shutdown /a /s` 含 /a 但也含 /s，判不安全。
     * 判据的代价是「shutdown /a /t 5」这种极少见的写法也会被拦 —— 可以接受，
     * 多一次确认框远好于放行一条真关机。 */
    return !UNSAFE_SWITCH_RE.test(t);
  });
}

/**
 * 判断一条命令是否属于「电源操作」。
 * @param {string} cmd
 * @returns {boolean} true = 需要 system-power 门禁
 */
function isPowerCommand(cmd) {
  const raw0 = String(cmd == null ? '' : cmd);
  if (!raw0.trim()) return false;

  /* 【超长命令直接 fail-closed】
   * 这条判定跑在主进程的同步路径上（渲染层 IPC / 命令收藏 / 导入都会进来），
   * 而它的主体是一串正则。实测 40000 字符时要 2 秒左右 —— 足以冻结界面。
   * 电源门禁的职责是「宁可多问一次」，所以超长时直接按需要门禁处理，
   * 不去分析内容。这个上限远大于任何真实电源命令（正常的 shutdown 命令行
   * 连同参数不到 200 字符），不会误伤。 */
  if (raw0.length > POWER_CMD_MAX_LEN) return true;

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
  if (hasEncodedFlag(raw) || /\s\/ec\s/i.test(raw)) {
    /* 只认「powershell 系」的编码参数，避免把 -e 之类的普通开关误当电源。
     * 但编码参数本身与解释器无关，出现即拒（见 hasEncodedFlag 的注释）。
     * 注：`/ec` 是 cmd 那侧的旧写法，仍然按「后面必须跟着 powershell 系」判。 */
    if (hasEncodedFlag(raw)) return true;
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
    /* 【cmd / PowerShell 的 if 语句：真正要执行的东西在条件之后】
     * 漏拦实测（全部返回 false，但在 cmd / PowerShell 里**真的会关机**）：
     *   if 1==1 shutdown /s
     *   if exist C:\Windows shutdown /s /t 0
     *   cmd /c if 1==1 shutdown /s
     *   powershell -c "if ($true) { Stop-Computer }"
     * 根因：段首是 "if"，首词既不是危险词也不是可识别的外壳，
     * 剥壳逻辑无从下手 —— 和当初 for 循环体漏拦（455 行）完全同构。
     * 判据：剥掉 `if [not] <条件>` 前缀后再取首词。 */
    for (const seg of splitSegments(srcText)) {
      if (!/^if\b/i.test(seg.trim())) continue;
      const body = stripIfCondition(seg);
      if (body && execHeads(body).some((h) => isDangerHead(h))) return true;
    }
    /* 【PowerShell 的 { } 脚本块】
     * 漏拦实测（全部会执行）：
     *   powershell -c "if ($true) { Stop-Computer }"
     *   powershell -c "& { Stop-Computer }"
     *   powershell -c "foreach ($i in 1..1) { Stop-Computer }"
     *   powershell -c "while ($true) { Stop-Computer }"
     * 花括号是 PS 的语句块定界符，块内是独立可执行位；
     * cmd 的 `( ... )` 已有 extractParens 覆盖，两侧对称补上 extractBraces。 */
    for (const seg of splitSegments(srcText)) {
      for (const g of extractBraces(seg)) {
        if (execHeads(g).some((h) => isDangerHead(h))) return true;
        /* 块里还嵌套 if 的情况也顺带覆盖 */
        for (const inner of splitSegments(g)) {
          if (/^if\b/i.test(inner.trim())) {
            const b = stripIfCondition(inner);
            if (b && execHeads(b).some((h) => isDangerHead(h))) return true;
          }
        }
      }
    }
    /* 【Invoke-Expression / iex：字符串即代码】
     * 漏拦实测（全部会执行）：
     *   powershell -c "Invoke-Expression Stop-Computer"
     *   powershell -c "iex 'Stop-Computer'"
     * 它们的第一个参数是一段**待解释的脚本**，静态分析拿不到结构 ——
     * 首词 "iex"/"invoke-expression" 不在危险词里，整条放行。
     *
     * 【为什么这里 fail-closed】与 `-EncodedCommand` 同一个取舍：
     * 内容编成字符串就不可静态判定，此时按"可能是电源操作"处理。
     * 误伤面很小：正常用 iex 跑的是安装脚本/配置片段，本工具箱的命令收藏
     * 里几乎不会出现；而漏放的代价是机器被关掉。
     * 只在这种启动器的**整段**里找危险词根，不做全局匹配 ——
     * `echo iex` 这类文本提到的情况由 allTextSegments 先放行。 */
    for (const seg of splitSegments(srcText)) {
      const head = headWord(seg);
      if (head === 'iex' || head === 'invoke-expression') {
        const joined = DANGER_TOKENS.map((t) => t.replace(/[-]/g, '\\-')).join('|');
        if (new RegExp(joined, 'i').test(seg)) return true;
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
    /* 【调用运算符 + 变量：变量装的是什么，静态判不出来】
     * 实测会执行的写法（门禁原来全放行）：
     *   $x="C:\Windows\System32\cmd.exe"; & $x /c shutdown /s
     *   & $x /c shutdown /s
     * 首词是 "$x"，既不是危险词也不是可识别的外壳，剥壳逻辑无从下手。
     *
     * 【判据必须在原文上做，不能逐段做】
     * splitSegments 把 `;` 当分隔符时，会把**紧随其后的 `&` 一并吃掉**
     * （`; & $x …` 切成两段，第二段只剩 `$x …`）。于是"段首有没有调用运算符"
     * 这个信息在分段后就丢了 —— 实测逐段判漏掉了这一条。
     * 所以在原文上找「`&`/`.` + 空白 + `$变量`」这个真正的执行形态。
     *
     * 【为什么只在这种形态下 fail-closed】对照实测（PB6 锁着）：
     *   `& $x /c echo M`  → 执行了
     *   `$x /c echo M`    → 没执行（PowerShell 不把变量当命令名，除非用 & / .）
     * 没有调用运算符时不必拦，否则 `echo $env:PATH` 这类纯文本会被误伤，
     * 用户嫌烦就会把高危开关常开 —— 门禁反而失效。 */
    if (/(?:^|[\s;&|])[&.][ \t]+\$[A-Za-z_{]/.test(srcText)) {
      const joined = DANGER_TOKENS.map((t) => t.replace(/[-]/g, '\\-')).join('|');
      if (new RegExp(joined, 'i').test(srcText)) return true;
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

/* 取出所有最外层花括号组的内容 —— PowerShell 的语句块定界符。
 *
 * 【为什么必须和 extractParens 分开】两种括号在不同 shell 里语义不同，
 * 混在一个扫描里会把 `if (1) { x }` 的括号与花括号交替配错。
 * extractParens 已经服务于 cmd 的 `( … )` 组，这里只管 PS 的 `{ … }`。
 *
 * 【不做完整解析】与 extractParens 同样的取舍：只取最外层、
 * 不处理引号内的花括号（引号内是字面量，本来就不执行）。
 * 漏掉的极端写法（嵌套引号再嵌花括号）不影响 fail-closed 方向 ——
 * 那段内容仍会作为整段的一部分被 execHeads 看过首词。 */
function extractBraces(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  let depth = 0, start = -1;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    /* 引号内的花括号是字面量，不参与配对 */
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') { if (depth === 0) start = i + 1; depth++; }
    else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) { out.push(s.slice(start, i)); start = -1; }
      }
    }
  }
  return out;
}

/* 剥掉 cmd / PowerShell 的 `if [not] <条件>` 前缀，返回条件之后那部分。
 *
 * 【为什么要专门剥，而不是简单按空白切】if 的条件形态差异很大：
 *   if 1==1 shutdown /s                条件是一个词
 *   if exist C:\Windows shutdown /s    条件是两个词（exist + 路径）
 *   if not exist X shutdown /s         前面还有 not
 *   if ($true) { Stop-Computer }       PS 写法，条件是括号组
 *   if %errorlevel%==0 shutdown /s     变量比较
 * 逐种枚举必然漏。这里的判据是「找到第一个长得像**命令**的记号」：
 * 括号组条件先整体跳过；否则按空白推进，跳过 errorlevel/exist/defined 这类
 * 条件关键字与纯比较式（含 ==、!=、<、> 或不含路径特征的字面量）。
 *
 * 【宁可多剥一点也不能少剥】剥多了 → body 里包含真正的命令 → 照样拦得住；
 * 剥少了 → body 停在条件上 → 漏拦。所以遇到拿不准的记号也跳过。
 * 唯一的硬边界：body 不能为空（否则 `if` 单独一个词会被判成危险）。
 */
function stripIfCondition(seg) {
  let s = String(seg || '').trim();
  const m = s.match(/^if\b\s*/i);
  if (!m) return '';
  s = s.slice(m[0].length);
  /* 可选的 not */
  s = s.replace(/^not\b\s*/i, '');
  /* PS 的括号条件：整体跳过（配平扫描，允许嵌套） */
  if (s[0] === '(') {
    let depth = 0, end = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end >= 0) s = s.slice(end + 1).trim();
  } else {
    /* cmd 条件：跳过条件关键字 + 紧随其后的一个记号（路径/值），
     * 以及任何含比较运算符的记号。最多跳 3 个，避免把命令名也吃掉 ——
     * 但如果跳过之后 body 为空，就把最后一个记号还回去。 */
    const toks = s.split(/\s+/);
    const keep = [];
    let i = 0;
    const COND_KEYWORDS = /^(exist|defined|errorlevel|cmdextversion|not)$/i;
    const CMP = /(==|!=|<=|>=|<|>)/;
    let skipped = 0;
    while (i < toks.length && skipped < 3) {
      const t = toks[i];
      if (COND_KEYWORDS.test(t) || CMP.test(t)) { skipped++; i++; continue; }
      /* 关键字后面的那个记号（exist 的路径、defined 的变量名） */
      if (i > 0 && COND_KEYWORDS.test(toks[i - 1])) { skipped++; i++; continue; }
      break;
    }
    keep.push(...toks.slice(i));
    s = keep.join(' ').trim();
  }
  return s;
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
  /* 【PowerShell 的调用运算符：& 与 . 必须先剥掉】
   * 漏拦样本（实测在 ps 里**都会执行**，而 isPowerCommand 返回 false）：
   *   & "C:\Windows\System32\cmd.exe" /c shutdown /s
   *   . "C:\Windows\System32\cmd.exe" /c shutdown /s
   *   & "cmd" /c shutdown /s
   *   & $env:ComSpec /c shutdown /s
   * 它们的段首是 & / .，首词因此是 "&" 或 "." —— 不是危险词，整条放行。
   * normalizeCommand 的壳正则要求 cmd 出现在**段首**，救不了这一层。
   *
   * 【为什么只剥运算符、不把「出现 $变量」一律判危险】
   * 实测对照（scripts/test-powergate-ps.js 的 PB6 锁着）：
   *   `& $x /c echo M`   → 执行了（有调用运算符）
   *   `$x /c echo M`     → 没执行（PowerShell 不会把变量当命令名，除非用 & / .）
   *   `& $env:ComSpec …` → 执行了
   * 所以判据落在「**调用运算符之后**的那个词」上：它若是变量或带路径的外壳，
   * 剥壳逻辑照常往下走；没有运算符的变量写法不必拦，免得误伤
   * `echo $env:PATH` 这类纯文本。
   *
   * 【只剥段首那一个】cmd 里 & 是串接符（splitSegments 已经切开），
   * 中段的 & 到这里时已经是另一段的段首了。 */
  const callOp = s.match(/^[&.]\s+/);
  if (callOp) s = s.slice(callOp[0].length).trim();
  for (let guard = 0; guard < 5; guard++) {
    /* 【Start-Process 必须先于 start 处理】
     * 两者都以 "start" 开头，而 start 的剥壳正则 /^start\s+/i 只认
     * "start" 后面跟空白。`Start-Process shutdown` 里 start 之后紧跟的是
     * "-process"，本不该被那条正则吃掉 —— 但 PowerShell 的写法更麻烦：
     *   powershell -c "Start-Process shutdown"
     * 剥掉 powershell 外壳后首词是 "start-process"，不在危险词里，于是漏拦。
     * 实测确认：下面三种原本全部返回 false（漏拦）：
     *   Start-Process shutdown
     *   powershell -c "Start-Process shutdown"
     *   powershell -Command "Start-Process shutdown -ArgumentList /s"
     * Start-Process 就是 PowerShell 版的 start，语义完全等价，必须一起剥。 */
    const m = s.match(/^start\s+""\s+/i)
      || s.match(/^start-process\s+/i)
      || s.match(/^start\s+/i)
      || s.match(/^call\s+/i);
    if (!m) break;
    s = s.slice(m[0].length).trim();
    /* 【必须把 start 自己的开关也剥掉，否则整条绕过】
     * `start` 的第一个参数可以是开关而不是程序名：
     *   start /b shutdown /s      后台启动
     *   start /min shutdown /s    最小化启动
     *   start /wait shutdown /s   等待其结束
     *   start "" /b shutdown /s   标题为空串 + 开关
     * 只剥 `start ` 的话，s 停在 "/b shutdown /s"，首词成了 "/b"，
     * 根本不是危险词 —— isPowerCommand 返回 false，门禁被绕过。
     * 实测确认：这四种写法原本全部漏拦；而 `start shutdown /s`
     * （后面直接就是程序名）反而拦得住，说明漏的正是开关这一步。
     * 开关可以叠多个，所以循环剥；形态是 /x 或 /x:y，
     * 不会与程序名（不含前导斜杠）混淆。
     *
     * Start-Process 的开关是 -参数 形态（-FilePath / -ArgumentList），
     * 同样要剥 —— 否则 `Start-Process -FilePath shutdown` 的首词会变成
     * "-filepath"。 */
    for (let k = 0; k < 8; k++) {
      const sw = s.match(/^\/[a-z]+(?::[^\s]+)?\s+/i) || s.match(/^-[a-z]+\s+/i);
      if (!sw) break;
      s = s.slice(sw[0].length).trim();
    }
  }
  /* 【还要继续剥 cmd / powershell 这层外壳】
   * 漏拦样本：start /b cmd /c shutdown /s、start cmd /c shutdown /s。
   * 剥掉 start 与它的开关后，首词是 "cmd" —— 而 cmd 不是危险词，
   * 里层的 shutdown 从来没被看到。
   * normalizeCommand 的壳正则要求 cmd 在**行首**（^ 锚定语义），
   * 而这里的 cmd 前面还有 start，所以那条路径也救不了。
   *
   * 所以在取首词时也剥一次壳：遇到 cmd /c|/k 或 powershell -c|-Command，
   * 把外壳连同它的开关一起吃掉，继续看后面那个真正的程序名。
   * 这样 `start /b cmd /c shutdown /s` 的首词就落到 shutdown 上。
   * 与 CMD_SHELL / PS_SHELL 保持同一套开关语法（/字母[:值] | -参数）。
   *
   * 【外壳可能被引号包着】`& "C:\Windows\System32\cmd.exe" /c shutdown /s`
   * 是 PowerShell 调用运算符形态，实测会真的执行。若只允许裸路径前缀，
   * 引号会让正则失配，首词退化成 "cmd"，危险词仍看不到。
   * 所以路径前缀两侧各允许一个引号（单/双都行）。 */
  for (let guard = 0; guard < 4; guard++) {
    /* 【开关本身也可能被引号包着】`& 'cmd' '/c' shutdown /s` 实测会执行。
     * 只给路径加引号兜底不够 —— 开关被单独引起来的写法同样常见。 */
    const cmdShell = s.match(/^["']?(?:[^\s"']*[\\/])?cmd(?:\.exe)?["']?\s+(?:\/[a-z](?::[^\s]+)?\s+)*["']?\/[ck]["']?\s+/i);
    if (cmdShell) { s = s.slice(cmdShell[0].length).trim(); continue; }
    const psShell = s.match(/^["']?(?:[^\s"']*[\\/])?(?:powershell|pwsh)(?:\.exe)?["']?\s+(?:-[a-z]+\s+)*-(?:c|command|encodedcommand)\s+/i);
    if (psShell) { s = s.slice(psShell[0].length).trim(); continue; }
    break;
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
