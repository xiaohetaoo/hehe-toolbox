const { handlerIndex } = require('./lib/seg-from-handler');
'use strict';
const path = require('path');
const assert = require('assert');
/* 电源门禁回归：v0.1.9 修「等价写法绕过」。
 *
 * 旧实现是行首锚定单层正则，以下写法全部穿透（实测）：
 *   shutdown.exe /s /t 0
 *   cmd /c shutdown /s
 *   powershell -c "Stop-Computer"
 *   rundll32.exe user32.dll,LockWorkStation
 * 现在改为「剥壳 + 词根匹配」。
 *
 * 本测试直接 require lib/power-gate.js（main.js 用的同一份实现）。
 */
/* 主进程全部源码（迁移来的 round13 用例要点名 handler）。 */
const { readMain } = require('./lib/harness');
const mainSrc = readMain({ raw: true });
const PG = require('../lib/power-gate');
const ROOT = path.join(__dirname, '..');
/* 读项目内文件（迁移来的用例用）。 */
const fsx = require('fs');
function read(rel) { return fsx.readFileSync(require('path').join(__dirname, '..', rel), 'utf8'); }
const stripComments = require('../lib/src-scan').stripComments;
const gate = require('../lib/power-gate');
const B = String.fromCharCode(92);

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

const mustBlock = [
  'shutdown /s /t 0',
  'shutdown /r /t 0',
  'shutdown',
  'shutdown.exe /s /t 0',                       // .exe 后缀
  'cmd /c shutdown /s',                          // 外层 cmd
  'cmd.exe /c shutdown /s',
  'cmd /c "shutdown /s"',                        // 引号
  'powershell -c "Stop-Computer"',               // 外层 powershell
  'powershell -c Stop-Computer',
  'powershell.exe -Command Restart-Computer',
  'pwsh -c Restart-Computer',
  'cmd /c powershell -c Restart-Computer',       // 双层嵌套
  'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
  'rundll32.exe user32.dll,LockWorkStation',     // 原实现完全漏掉
  'Stop-Computer -Force',
  'Restart-Computer',
  '  \tshutdown /s',                             // 前导空白
  (B === '\\' ? 'C:' + B + 'Windows' + B + 'System32' + B + 'shutdown.exe /s' : ''),

  /* 【start 的开关形态：本轮实测抓到的漏拦】
   * `start` 的第一个参数可以是它自己的开关而不是程序名。
   * 早先 headWord 只剥 `start ` 这一层，于是剥完停在 "/b shutdown /s"，
   * 首词成了 "/b" —— 不是危险词，整条被放行。
   * 而 `start shutdown /s`（后面直接就是程序名）反而拦得住，
   * 说明漏的正是「开关」这一步，不是 start 本身没处理。
   * 下面四种开关形态实测全部漏拦，现在都要拦住。 */
  'start /b shutdown /s /t 0',
  'start /min shutdown /s',
  'start "" /b shutdown /s',
  'start /wait shutdown /s',
  'start shutdown /s',
  /* start 后面再接一层外壳：剥掉 start 后首词是 cmd，
   * 里层的 shutdown 从来没被看到。 */
  'start /b cmd /c shutdown /s',
  'start cmd /c shutdown /s',

  /* 【Start-Process：PowerShell 版的 start，同样能启动 shutdown】
   * 实测全部漏拦。`Start-Process` 以 start 开头，但 start 的剥壳正则
   * 要求后面跟空白，所以它不会被误剥 —— 也就完全没被处理过。 */
  'Start-Process shutdown',
  'powershell -c "Start-Process shutdown"',
  'powershell -Command "Start-Process shutdown -ArgumentList /s"',
  'Start-Process -FilePath shutdown'
];

const mustAllow = [
  'shutdown /a',                                 // 取消关机
  'shutdown /?',                                 // 查看帮助
  'cmd /c shutdown /a',
  'shutdown /a /t 0',
  'ipconfig /flushdns',
  'ping 127.0.0.1',
  'tasklist',
  'dir C:' + B,                                  // 结尾反斜杠
  'echo shutdown',                               // 只是文本里提到
  'type shutdown.txt',
  'shutdownx /s',                                // 同名但不是它,

  /* 文件名里含 shutdown 的日常操作：旧实现对整串做词根匹配，
     而 . \ : 都不算边界，于是这些全被误拦成「高危功能已关闭」。 */
  'del shutdown.log',
  'ren shutdown.txt x.txt',
  'copy shutdown.exe d:' + B,
  'tasklist | findstr shutdown',
  'move shutdown.log backup' + B,
  'notepad shutdown.log',
  'dir shutdown.log',
  '',
  null,
  undefined
];

/* ---- 1. 必须拦截 ---- */
/* 断言「某处调用 powerGate 时必须把 cmd 与 args 拼成整条再判」。
 * 分开判会漏掉 cmd.exe /c shutdown 这类包装 —— 单看 argv[0] 是 cmd.exe，无害。 */
function assertPowerArgIsWholeCommand(body, label) {
  const marker = 'assertPowerAllowed(';
  const at = body.indexOf(marker);
  assert.ok(at >= 0, label + ' 里找不到 assertPowerAllowed');
  const start = at + marker.length;
  let depth = 1, end = -1;
  for (let k = start; k < body.length; k++) {
    const c = body[k];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  assert.ok(end > start, label + ' 里 assertPowerAllowed 的实参不完整');
  const arg = body.slice(start, end).trim();
  assert.ok(/\.join\(\s*' '\s*\)/.test(arg),
    label + ' 没有把 cmd 与 args 拼成整条命令再判 —— 分开判会漏掉 ' +
    '`cmd.exe` + `/c shutdown /s /t 0` 这类组合。实际实参：' + arg);
  /* 必须同时用了命令行主体与 args，而不是只用其中一个。
   * 注意用 /i：实现里变量叫 flatArgs（首字母大写），区分大小写会误判。 */
  assert.ok(/(cmd|command)/i.test(arg) && /args/i.test(arg),
    label + ' 的判定实参应同时包含命令与参数：' + arg);
  return arg;
}

t('全部等价写法都被识别（v0.1.9 核心）', () => {
  const missed = mustBlock.filter((c) => c && !gate.isPowerCommand(c));
  assert.deepStrictEqual(missed, [], '漏拦: ' + missed.join(' | '));
});

/* 逐条单独报告，便于定位 */
for (const [i, c] of mustBlock.entries()) {
  if (!c) continue;
  t('拦截[' + (i + 1) + ']: ' + c.slice(0, 46), () => {
    assert.ok(gate.isPowerCommand(c), '应当拦截但放过了');
  });
}

/* ---- 2. 必须放行（不能误伤） ---- */
t('安全命令与文本命令不误判', () => {
  const wrong = mustAllow.filter((c) => c && gate.isPowerCommand(c));
  assert.deepStrictEqual(wrong, [], '误拦: ' + wrong.join(' | '));
});

/* ---- 3. 剥壳函数本身 ---- */
t('normalizeCommand 剥掉 cmd /c 外壳', () => {
  assert.strictEqual(gate.normalizeCommand('cmd /c shutdown /s'), 'shutdown /s');
});
t('normalizeCommand 剥掉 powershell -c 外壳与引号', () => {
  assert.strictEqual(gate.normalizeCommand('powershell -c "Stop-Computer"'), 'stop-computer');
});
t('normalizeCommand 去路径前缀与 .exe', () => {
  const s = 'C:' + B + 'Windows' + B + 'System32' + B + 'shutdown.exe /s';
  assert.strictEqual(gate.normalizeCommand(s), 'shutdown /s');
});
t('normalizeCommand 双层嵌套也能剥到底', () => {
  assert.ok(gate.normalizeCommand('cmd /c powershell -c Restart-Computer').startsWith('restart-computer'));
});

/* ---- 4. 门禁整体 ---- */
t('未开启时拒绝，开启后放行', () => {
  assert.ok(gate.checkPowerGate('cmd /c shutdown /s', false), '未开启应拒绝');
  assert.strictEqual(gate.checkPowerGate('cmd /c shutdown /s', true), null, '开启后应放行');
});
t('取消关机即使未开启也放行', () => {
  assert.strictEqual(gate.checkPowerGate('shutdown /a', false), null);
});

/* ---- 5. main.js 必须使用这份实现（防空挂） ---- */
t('main.js 引用了 lib/power-gate 且无本地正则副本', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  /* 锁的是：「main.js 引用了 lib/power-gate 且无本地正则副本」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(src.includes("require('./lib/power-gate')"), '未引用共享实现');
  /* 锁的是：「main.js 引用了 lib/power-gate 且无本地正则副本」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/const POWER_CMD_RE\s*=/.test(src), 'main.js 仍有本地 POWER_CMD_RE');
  /* 锁的是：「main.js 引用了 lib/power-gate 且无本地正则副本」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/powerGate\.checkPowerGate/.test(src), 'assertPowerAllowed 未委托');
});

t('文件名/参数里带危险词的日常命令不被误拦', () => {
  const pg = require('../lib/power-gate');
  const SAFE = [
    'del shutdown.log', 'ren shutdown.txt x.txt', 'copy shutdown.exe d:\\',
    'tasklist | findstr shutdown', 'move shutdown.log backup\\',
    'notepad shutdown.log', 'type shutdown.txt', 'echo shutdown',
    'python shutdown.py', 'node shutdown.js', 'git commit -m "shutdown fix"',
    'mkdir shutdown_backup', 'attrib +r shutdown.log', 'msiexec /i shutdown.msi',
    'taskkill /f /im shutdown.exe', 'del C:\\Windows\\System32\\shutdown.exe',
  ];
  const wrong = SAFE.filter((c) => pg.isPowerCommand(c));
  assert.deepStrictEqual(wrong, [], '被误判为电源命令：' + wrong.join(' | '));
});

t('真正的电源命令仍然拦得住', () => {
  const pg = require('../lib/power-gate');
  const DANGER = [
    'shutdown /s /t 0', 'shutdown -h now', 'cmd /c shutdown /s',
    'powershell -Command "Stop-Computer"',
    'rundll32 powrprof.dll,SetSuspendState 0,1,0',
  ];
  const missed = DANGER.filter((c) => !pg.isPowerCommand(c));
  assert.deepStrictEqual(missed, [], '漏拦了真正的电源命令：' + missed.join(' | '));
});

/* ============ ④b 托盘/通知跟随语言 ============ */

t('纯文本命令的豁免不能作用在整条命令上（链式命令必须被拦）', () => {
  const P = require('../lib/power-gate.js');
  for (const cmd of ['echo hi & shutdown /s /t 0', 'type nul & shutdown /s', 'dir > x.txt && shutdown /s',
    'cmd /c echo hi & shutdown /s', 'foo.exe\r\nshutdown /s']) {
    assert.strictEqual(P.isPowerCommand(cmd), true, '穿透了：' + cmd);
  }
  /* 真·纯文本仍要放行，否则日常命令会被误拦 */
  for (const cmd of ['echo shutdown', 'type shutdown.txt', 'dir shutdown.log', 'tasklist | findstr shutdown',
    'echo a; echo b', 'echo shutdown & echo ok']) {
    assert.strictEqual(P.isPowerCommand(cmd), false, '被误拦：' + cmd);
  }
});

t('分段要认引号：参数里的 & 不该被当成命令分隔符（PG-4）', () => {
  const P = require('../lib/power-gate.js');
  assert.strictEqual(P.isPowerCommand('app.exe --msg "hello & shutdown now"'), false,
    '引号内的 & 被当成了分隔符（普通参数被误判成电源操作）');
  assert.strictEqual(P.isPowerCommand("app.exe --msg 'x; shutdown /s'"), false);
  assert.strictEqual(P.isPowerCommand('echo hi & shutdown /s'), true, '引号外的真命令仍要拦');
});

/* ================= ⑤ 链接体检 ================= */

t('/a 豁免必须逐段判：混着真关机命令时要拦', () => {
  const P = require('../lib/power-gate.js');
  for (const cmd of ['shutdown /a & shutdown /s', 'shutdown /s /t 0 & shutdown /a',
    'shutdown /? & shutdown /s']) {
    assert.strictEqual(P.isPowerCommand(cmd), true, '穿透了：' + cmd);
  }
  /* 真·取消/帮助仍要放行 */
  for (const cmd of ['shutdown /a', 'shutdown /?', 'cmd /c shutdown /a', 'shutdown /a /t 0']) {
    assert.strictEqual(P.isPowerCommand(cmd), false, '被误拦：' + cmd);
  }
});

t('换行不能被归一成空格（PowerShell 认换行当分隔符）', () => {
  const P = require('../lib/power-gate.js');
  assert.ok(P.normalizeCommand('echo hi\nshutdown /s').indexOf('\n') !== -1,
    'normalizeCommand 把换行吃掉了：' + JSON.stringify(P.normalizeCommand('echo hi\nshutdown /s')));
  for (const cmd of ['echo hi\nshutdown /s', 'echo shutdown\nshutdown /s', 'exit\nshutdown /s /t 0']) {
    assert.strictEqual(P.isPowerCommand(cmd), true, '换行绕过了门禁：' + JSON.stringify(cmd));
  }
  /* 真文本仍放行 */
  assert.strictEqual(P.isPowerCommand('echo shutdown'), false);
  assert.strictEqual(P.isPowerCommand('type shutdown.txt'), false);
});

t('不再对 norm 做「整条都是文本命令」的豁免', () => {
  const code = stripComments(read('lib/power-gate.js'));
  /* 锁的是：把文本豁免判据从 raw 改回 norm。norm 是剥壳后的形态，
   * 它的分段边界和真实语句边界不一致（换行就是例子），多判一次 norm
   * 只会多出一条「看起来更宽松」的放行路径，没有对应的真实语义。 */
  assert.ok(!/allTextSegments\(norm\)/.test(code),
    '仍保留了 allTextSegments(norm) —— 那是一条没有真实语义的放行路径');
  /* 锁的是：raw 的逐段判定被删。raw 才是真正交给 shell 执行的那串字符，
   * 删掉它等于让「整条命令都是文本命令」这个豁免作用到链式命令上，
   * `echo hi & shutdown /s` 会被整条放行。 */
  assert.ok(/allTextSegments\(raw\)/.test(code), 'raw 的逐段判定必须保留');
});

/* ================= ③ 分批 ================= */

t('6a 三种新绕过必须全部拦下', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  const must = [
    'cmd /c %ComSpec% /c shutdown /s',
    'powershell -EncodedCommand UwB0AG8AcAAtAEMAbwBtAHAAdQB0AGUAcgA=',
    'for %i in (x) do shutdown /s',
  ];
  for (const c of must) {
    assert.strictEqual(PG.isPowerCommand(c), true, '未拦下：' + c);
  }
});

t('6b 原有 8 种对照仍然拦下（不能改坏）', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  const must = [
    'shutdown /s', 'cmd /c shutdown /s', 'shutdown.exe /s',
    'echo hi & shutdown /s', 'rundll32 powrprof.dll,SetSuspendState 0,1,0',
    'call shutdown /s', 'start shutdown /s',
  ];
  for (const c of must) assert.strictEqual(PG.isPowerCommand(c), true, '未拦下：' + c);
});

t('6c 不能误伤日常命令', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  const B = String.fromCharCode(92);
  const allow = ['echo shutdown', 'shutdown /a', 'type shutdown.txt', 'del shutdown.log',
    'copy shutdown.exe D:' + B, 'tasklist | findstr shutdown'];
  for (const c of allow) assert.strictEqual(PG.isPowerCommand(c), false, '误拦了：' + c);
});

t('6d 未展开的变量 fail-closed，已知变量要能展开', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 未知变量：判不出来 → 按需要门禁（fail-closed） */
  assert.strictEqual(PG.isPowerCommand('%FOO% shutdown /s'), true, '未知变量 + 危险词应当拦截');
  /* 纯文本里的 %VAR% 不算（已被文本豁免放行） */
  assert.strictEqual(PG.isPowerCommand('echo %PATH%'), false, 'echo 只是打印变量，不该拦');
  /* 已知变量展开后应能剥壳 */
  const norm = PG.normalizeCommand('cmd /c %ComSpec% /c shutdown /s');
  assert.ok(!/%comspec%/.test(norm), 'normalizeCommand 没有展开 %ComSpec%：' + norm);
});

/* ==================== 7. clean-junk 来源校验 ==================== */

t('8a 电源门禁：cmd 与 args 必须拼成整条再判（分开判会漏掉 cmd.exe /c shutdown）', () => {
  const i = handlerIndex(mainSrc, 'exec:run');
  const j = handlerIndex(mainSrc, 'exec:stream');
  assertPowerArgIsWholeCommand(mainSrc.slice(i, j), 'exec:run');

  /* 行为验证：证明「分开判」确实会让这些命令通过（否则这条测试守的是空气） */
  const c1 = PG.isPowerCommand('cmd.exe');
  const a1 = PG.isPowerCommand('/c shutdown /s /t 0');
  const whole1 = PG.isPowerCommand('cmd.exe /c shutdown /s /t 0');
  assert.strictEqual(c1, false, '前置：cmd.exe 单独不是危险命令');
  assert.strictEqual(a1, false, '前置：参数串单独被剥壳后也不命中');
  assert.strictEqual(whole1, true, '前置：拼起来必须被识别为电源命令');
  /* 结论：只要实现是分开判的，c1/a1 都为 false，就放行了 whole1 —— 正是缺陷形态 */
});

t('8b 电源门禁：powershell -Command Stop-Computer 同样要被整条判住', () => {
  const body = mainSrc.slice(handlerIndex(mainSrc, 'exec:stream'), handlerIndex(mainSrc, 'job:kill'));
  assertPowerArgIsWholeCommand(body, 'exec:stream');
  assert.strictEqual(PG.isPowerCommand('powershell.exe'), false);
  assert.strictEqual(PG.isPowerCommand('-NoProfile -Command Stop-Computer'), false);
  assert.strictEqual(PG.isPowerCommand('powershell.exe -NoProfile -Command Stop-Computer'), true,
    '前置：整条拼接必须命中');
});

t('8c 电源门禁：无害命令与 shutdown /a 仍要放行（别矫枉过正）', () => {
  assert.strictEqual(PG.isPowerCommand('cmd.exe /c dir'), false);
  assert.strictEqual(PG.isPowerCommand('cmd.exe /c shutdown /a'), false, '取消关机必须放行');
  assert.strictEqual(PG.isPowerCommand('powershell.exe -Command Get-Date'), false);
  assert.strictEqual(PG.isPowerCommand('notepad.exe shutdown.log'), false, '文件名里带 shutdown 不算');
});

/* ==================== 9. 跨盘提交不能裸 rename ==================== */

t('26 power-gate：cmd 开关形（/d /c）与解释器包装不能绕过', () => {
  const PGg = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 这些都是「没开系统电源操作」时也必须被认出来的写法 */
  const mustBlock = [
    'shutdown /s /t 0',
    'cmd /c shutdown /s',
    'cmd /d /c shutdown /s',
    'cmd /e:on /c shutdown /s',
    'powershell -Command Stop-Computer',
    'powershell -NoProfile -Command Restart-Computer',
  ];
  for (const c of mustBlock) {
    assert.ok(PGg.isPowerCommand(c), '应被识别为电源命令：' + c);
  }
  /* 而无害的必须放行 */
  for (const c of ['cmd /c dir', 'cmd /d /c ver', 'powershell -Command Get-Date',
    'shutdown /a', 'cmd /c shutdown /a', 'notepad shutdown.log']) {
    assert.ok(!PGg.isPowerCommand(c), '不该被当成电源命令：' + c);
  }
});

t('27 不带空格的 cmd 壳形态不能绕过（cmd/c、cmd.exe/c、带引号变体）', () => {
  /* 锁的是：normalizeCommand 只认「cmd 与 /c 之间有空白」的写法，
   * 于是 cmd/c 这类真实可执行的写法整条被放行。 */
  const bypass = [
    'cmd/c shutdown /s',
    'cmd/c "shutdown /s"',
    'cmd.exe/c shutdown /s',
    'cmd /k shutdown /s',
  ];
  for (const c of bypass) {
    assert.strictEqual(PG.isPowerCommand(c), true, '应被识别为电源命令：' + c);
  }
  /* 锁的是：为了拦住上面几条而把正常命令也一起拦了。 */
  for (const c of ['cmd /c dir', 'cmd/c dir', 'cmd.exe/c ver']) {
    assert.strictEqual(PG.isPowerCommand(c), false, '不该被当成电源命令：' + c);
  }
});

t('28 shutdown 段内混入其它开关时不能靠 /a 蒙混放行', () => {
  /* 锁的是：allSafeShutdown 只查「有没有 /a」，
   * 于是 shutdown /a /s 这种「取消 + 关机」被当成安全段放行。 */
  const bypass = [
    'shutdown /a /s',
    'shutdown /s /a',
    'shutdown /? /s',
    'shutdown /a /r /t 0',
  ];
  for (const c of bypass) {
    assert.strictEqual(PG.isPowerCommand(c), true, '应被识别为电源命令：' + c);
  }
  /* 锁的是：严格枚举把真正的「只取消/只看帮助」也拦了。
   * /t 单独出现只是修饰倒计时，不执行动作（既有 mustAllow 也锁着这条）。 */
  for (const c of ['shutdown /a', 'shutdown /?', 'shutdown /a /?', 'shutdown /a /t 0']) {
    assert.strictEqual(PG.isPowerCommand(c), false, '纯取消/帮助必须放行：' + c);
  }
});

t('28b 横杠写法与斜杠完全等价（shutdown -a 放行、-s 拦下）', () => {
  /* 锁的是：SAFE_ARGS_RE / UNSAFE_SWITCH_RE 只认斜杠 ——
   * Windows 的 shutdown.exe 对 /x 与 -x 完全等价（微软文档两种形式都列）。
   * 后果双向：① `shutdown -a`（用户想取消误设的关机）被门禁误拦；
   * ② 更糟的是 `shutdown -s /t 0` 直接穿透门禁 —— 那是真关机。
   * 审查轮黑盒实测抓到（v0.8.3 收尾后）。 */
  const mustAllow = ['shutdown -a', 'shutdown -?', 'shutdown -a /t 0', 'shutdown -a -t 0', 'cmd /c shutdown -a'];
  for (const c of mustAllow) {
    assert.strictEqual(PG.isPowerCommand(c), false, '横杠纯取消/帮助必须放行：' + c);
  }
  const mustDeny = ['shutdown -s', 'shutdown -r /t 0', 'shutdown -s /t 0', 'shutdown -g', 'shutdown -h', 'cmd /c shutdown -s'];
  for (const c of mustDeny) {
    assert.strictEqual(PG.isPowerCommand(c), true, '横杠真关机必须拦截：' + c);
  }
  /* 锁的是：多段混合（横杠取消 + 斜杠关机）不能因前段安全而放行。 */
  assert.strictEqual(PG.isPowerCommand('shutdown -a & shutdown /s'), true,
    '「取消 & 真关机」必须整体拦截');
});

t('31 if / 花括号块 / iex 里的命令不许绕过门禁（F1）', () => {
  /* 锁的是：判定只认「段首首词」——`if` 的条件之后、PS 的 `{ }` 块内、
   * `iex` 的字符串参数里的命令全部不在视线内。
   * 实测（无门禁开关时）：这 9 条 isPowerCommand 全返回 false，
   * 而在 cmd / PowerShell 里**真的会关机**。
   * 与当初 for 循环体漏拦（455 行注释）完全同构，修法也同构。 */
  const mustDeny = [
    'if 1==1 shutdown /s',
    'if exist C:\\Windows shutdown /s /t 0',
    'if not exist C:\\x shutdown /s',
    'if %errorlevel%==0 shutdown /s',
    'cmd /c if 1==1 shutdown /s',
    'powershell -c "if ($true) { Stop-Computer }"',
    'powershell -c "& { Stop-Computer }"',
    'powershell -c "Invoke-Expression Stop-Computer"',
    "powershell -c \"iex 'Stop-Computer'\"",
    'powershell -c "foreach ($i in 1..1) { Stop-Computer }"',
    'powershell -c "while ($true) { Stop-Computer }"',
    'if 1==1 (shutdown /s)',
  ];
  for (const c of mustDeny) {
    assert.strictEqual(PG.isPowerCommand(c), true, 'if/块/iex 里的关机必须拦截：' + c);
  }

  /* 【不许为了拦而误伤日常命令】门禁一旦开始误报，用户就会把高危开关
   * 常开，门禁等于失效 —— 所以放行面必须一起锁住。
   *
   * 【注意 if %errorlevel%==0 echo ok 不在这张表里】
   * 它含未展开的 %变量%，而门禁对「解不出内容的变量」一律 fail-closed
   * （hasUnknownVar，见 power-gate.js 的说明）。这条行为**在本次修复前
   * 就已如此**（已用 HEAD 版本对照实测确认），是刻意的保守取舍：
   * 宁可多问一次，也不能让 `%FOO% shutdown /s` 换成变量名就绕过。
   * 所以测试里不把它当"日常命令应放行"，否则等于要求实现变成不可靠的宽松。 */
  const mustAllow = [
    'if 1==1 echo hi',
    'if exist C:\\Windows echo found',
    'if not exist C:\\x echo missing',
    'powershell -c "if ($true) { Write-Output hi }"',
    'powershell -c "foreach ($i in 1..3) { Write-Output $i }"',
    'echo if 1==1 shutdown /s',
    'type if.txt',
    /* 纯取消关机在 if 里同样要放行 —— 它是无害的恢复操作 */
    'if 1==1 shutdown /a',
  ];
  for (const c of mustAllow) {
    assert.strictEqual(PG.isPowerCommand(c), false, '日常命令被误拦：' + c);
  }
});

t('32 花括号块与括号组要能嵌套配平', () => {
  /* 锁的是：extractBraces 只取第一层就停 —— `{ if (x) { Stop-Computer } }`
   * 这种嵌套块漏判。判据要覆盖嵌套，否则一层壳就绕过。 */
  assert.strictEqual(PG.isPowerCommand('powershell -c "& { & { Stop-Computer } }"'), true,
    '嵌套花括号块里的关机必须拦截');
  /* 锁的是：引号内的花括号被当成语句块 ——
   * `Write-Output "{ Stop-Computer }"` 只是打印一段字面量，不该拦。 */
  assert.strictEqual(PG.isPowerCommand('powershell -c "Write-Output \'{Stop-Computer}\'"'), false,
    '引号内的花括号是字面量，不该拦');
});

t('33 if 条件剥离不能把整个命令吃掉', () => {
  /* 锁的是：stripIfCondition 跳过头 —— 把命令名也当条件剥掉后
   * body 为空，于是 `if … shutdown /s` 变成"无可判定"而被放行。
   * 这条与 31 互补：31 锁结果，这条锁"剥离后仍有东西可判"。 */
  const src = read('lib/power-gate.js');
  /* 锁的是：stripIfCondition 被简化成「按空白切掉前两个词」—— 那样
   * `if exist C:\Windows shutdown /s` 会剩 "shutdown /s"（碰巧对），
   * 而 `if 1==1 shutdown /s` 会剩 "shutdown /s"（也对），
   * 但 `if not exist X shutdown /s` 会剩 "X shutdown /s"（首词是 X，漏拦）。 */
  /* 锁的是：剥离实现被删 —— 条件之后的内容没人看，F1 回归。 */
  assert.ok(/function stripIfCondition/.test(src), '缺少 stripIfCondition 实现');
  /* 锁的是：条件关键字表被删 —— not/exist/errorlevel 不再被跳过。 */
  const i = src.indexOf('function stripIfCondition');
  const seg = src.slice(i, i + 2600);
  assert.ok(/exist\|defined\|errorlevel/.test(seg),
    'stripIfCondition 必须识别 exist/defined/errorlevel 这类条件关键字');
});

t('29 长命令判定不再近似 O(n^2)（40000 字符必须快速返回）', () => {
  /* 锁的是：三条壳正则的可选路径前缀在大输入上反复回溯。
   * 实测修复前 40000 字符约 2014ms —— 同步阻塞主进程两秒，
   * 而这条路径来自渲染层 IPC / 命令收藏 / 导入，属公开通道。
   * 修复后走「超长直接 fail-closed」，实测 0.01ms 量级。 */
  const big = 'a'.repeat(40000);
  const t0 = process.hrtime.bigint();
  const r = PG.isPowerCommand(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(r, true, '超长命令必须 fail-closed（判不出来就不放行）');
  assert.ok(ms < 200, '40000 字符判定耗时 ' + ms.toFixed(1) + 'ms，超过 200ms 阈值');
});

t('30 超长命令 fail-closed 但不误伤正常长度', () => {
  /* 锁的是：长度上限设得太小，把真实的命令行也变成"需要门禁"。
   * 正常电源命令行连同参数不到 200 字符，上限是它的几十倍。 */
  assert.strictEqual(PG.isPowerCommand('a'.repeat(8000)), false, '8000 字符仍在分析范围内');
  assert.strictEqual(PG.isPowerCommand('a'.repeat(9000)), true, '超过上限应 fail-closed');
});

/* ==================== PG-ENC：-EncodedCommand 的缩写形态 ====================
/* 锁的是哪几个回归（v0.6.7）：
 *
 * 【漏洞本身】旧实现的编码参数判据是
 *     /^(?:powershell|pwsh)\b[^\n]*\s(-e|-[a-z]*e)\b/i
 * 它只覆盖 -e / -encodedcommand 两个极端，中间的缩写全部放行。
 * 而 PowerShell 的参数是无歧义前缀匹配，这些缩写**真的会执行 base64 载荷**。
 * 真机实测（spawnSync 直起 powershell.exe，载荷 Write-Output PWNED，
 * 换第二段载荷 ZZZ-DISTINCT 复验结论一致）：
 *   -e -ec -en -enc -enco -encoded -encodedc ... -encodedcommand  → 全部执行
 *   -ea -ep -ex -eb -ed -ecc -ecm -ence -nco ...                 → 不执行
 * 也就是说 -ec 会执行、但**它不是 "encodedcommand" 的前缀** ——
 * 单靠前缀规则会漏掉它。所以判据是「ec 或 encodedcommand 的前缀」。
 *
 * 【连带修的假阳性】旧正则里的 `-[a-z]*e` 中 `*` 允许零长度，
 * 于是任何以 e 结尾的开关都命中：
 *   powershell -File a.ps1            → 被误判为需要门禁
 *   powershell -ExecutionPolicy Bypass -File a.ps1 → 同样误判
 * 这两条是日常写法，用户会看到「高危功能已关闭」而无从下手。
 * 改成按开关名判定后自然消失（-file / -executionpolicy 都不是 ec 也不是前缀）。
 *
 * 下面的断言分两组：EN1-EN4 钉「必须拦」，EN5-EN7 钉「不能误拦」。
 * 只钉其中一组都会退化 —— 只钉拦截会导致正则越写越宽，
 * 只钉不误拦会导致门禁被悄悄放空。 */

const ENC_B64 = Buffer.from('Write-Output PWNED', 'utf16le').toString('base64');

t('PG-ENC-1 全部实测会执行的缩写必须拦下', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 逐个来自真机实测，不是拍脑袋列的 */
  const must = ['-e', '-ec', '-en', '-enc', '-enco', '-encoded', '-encodedc',
    '-encodedcomma', '-encodedcommand', '-E', '-EC', '-Enco', '-EncodedCommand'];
  for (const abbr of must) {
    const c = 'powershell ' + abbr + ' ' + ENC_B64;
    assert.strictEqual(PG.isPowerCommand(c), true, '未拦下编码参数缩写：' + abbr);
  }
});

t('PG-ENC-2 缩写不能只在外壳是第一段时生效', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 锁的是：判据写成「行首是 powershell 才检查」的话，
   * 前面挂一个无害前缀（cmd /c、echo &）就能把缩写藏到后面去。 */
  const must = [
    'cmd /c powershell -ec ' + ENC_B64,
    'echo hi & powershell -enc ' + ENC_B64,
    'powershell.exe -ec ' + ENC_B64,
  ];
  for (const c of must) assert.strictEqual(PG.isPowerCommand(c), true, '未拦下：' + c);
});

t('PG-ENC-3 实测不执行的近似写法不能拦（否则是误伤）', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 这些在真机上都报 not recognized 或走帮助，不会执行载荷。
   * 拦它们属于纯误伤，用户会莫名其妙看到「高危功能已关闭」。 */
  const allow = ['-ea', '-ep', '-ex', '-eb', '-ed', '-ef', '-ez',
    '-ecc', '-ecm', '-ecx', '-ecn', '-ence', '-nco', '-n', '-coded'];
  for (const abbr of allow) {
    const c = 'powershell ' + abbr + ' x';
    assert.strictEqual(PG.isPowerCommand(c), false, '误拦了不执行的写法：' + abbr);
  }
});

t('PG-ENC-4 以 e 结尾的普通开关不能被当成编码参数', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 锁的是旧正则 `-[a-z]*e\b` 的假阳性：`*` 允许零长度，
   * 任何以 e 结尾的开关都会命中。下面这些全是正常用法。 */
  const allow = [
    'powershell -File a.ps1',
    'powershell -ExecutionPolicy Bypass -File a.ps1',
    'powershell -NoExit -Command Get-Date',
    'powershell -WindowStyle Hidden -Command Get-Date',
    'powershell -NonInteractive -Command Get-Process',
  ];
  for (const c of allow) assert.strictEqual(PG.isPowerCommand(c), false, '误拦了正常命令行：' + c);
});

t('PG-ENC-5 非 powershell 场景里的单字符 -e 不能误拦', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 锁的是：把单字符 -e 也当成编码参数来判，`node -e` 这种日常写法会被误拦。
   * 单字符 -e 只在 powershell/pwsh 系命令行里才算编码参数。
   *
   * 【为什么这几个样本必须是「非文本命令」】
   * `findstr -e foo *.txt` 也能通过，但它是从 allTextSegments 的文本豁免出去的，
   * 还没走到本函数 —— 用它当断言等于守着空气（实测：去掉外壳判定后它照样 PASS）。
   * node / perl 不是文本命令，会真的走到 hasEncodedFlag，才锁得住。 */
  assert.strictEqual(PG.isPowerCommand('node -e "console.log(1)"'), false, 'node -e 被误拦');
  assert.strictEqual(PG.isPowerCommand('perl -e print'), false, 'perl -e 被误拦');
  /* 对照：-ec 在多字符前缀规则里，与解释器无关，必须拦。
   * 这两条并排，才能证明「外壳限定只对单字符 -e 生效」。 */
  assert.strictEqual(PG.isPowerCommand('node -ec x'), true, '多字符 -ec 应当按编码参数拦下');
  assert.strictEqual(PG.isPowerCommand('cmd /e:on /c dir'), false, 'cmd 的 /e 扩展开关被误拦');
});

t('PG-ENC-6 判据本身要能被读出（防被改回只认字面量）', () => {
  const code = stripComments(read('lib/power-gate.js'));
  /* 锁的是：有人把 hasEncodedFlag 改回只匹配 -EncodedCommand 字面量。
   * 这里不检查具体正则写法，只要求「有按名字判前缀的函数」这件事存在。 */
  assert.ok(/function isEncodedFlagName/.test(code),
    '缺少 isEncodedFlagName —— 缩写判定被删掉了');
  /* 锁的是：前缀判定被换成别的判据（比如只认 === 'ec'），
   * 那样 -en/-enc/-encoded 又会被放行 —— 它们是真机会执行的那一批。 */
  assert.ok(/ENCODED_CMD_NAME\.startsWith|encodedcommand/i.test(code),
    '没有按 encodedcommand 前缀判定');
  /* 锁的是：`-[a-z]*e` 这个假阳性写法被写回来。它的 `*` 允许零长度匹配，
   * 任何以 e 结尾的开关都会命中，powershell -File a.ps1 直接被误拦。 */
  assert.ok(!/-\[a-z\]\*e\\b/.test(code),
    '又出现了 -[a-z]*e 这个会误伤 -File/-NoExit 的写法');
});

t('PG-ENC-7 这次修的两种形态都要在源码注释里留下实测依据', () => {
  const code = read('lib/power-gate.js');
  /* 锁的是：以后有人「顺手清理注释」，把实测数据删了，
   * 下一个改这段的人就只能靠猜 PowerShell 的缩写规则。 */
  assert.ok(/不是 "encodedcommand" 的前缀|不是 .encodedcommand. 的前缀/.test(code),
    '缺少「-ec 不是前缀但会执行」这条实测结论');
  /* 锁的是：注释里那批「实测不执行」的名单被删。没有它，下一个改这段的人
   * 会以为所有 -e 开头的都该拦，于是把 -ea/-ep/-ex 一起误拦。 */
  assert.ok(/not recognized|不走|不执行/.test(code),
    '缺少「哪些近似写法不执行」的记录');
});

t('34 结构套结构不许绕过（第二轮审查：递归可执行位判定）', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 锁的是：v0.8.4 的平铺判定只剥一层 —— if 里套 if、for 体里套 if、
   * 括号组里套 if、花括号嵌套（switch）、if 的 /i 开关与带空格引号比较，
   * 每多一层嵌套就绕一次。以下全部经真机执行验证（无害标记命令），
   * 在 cmd / PowerShell 里**真的会执行**条件后的命令。 */
  const mustDeny = [
    'if 1==1 if 2==2 shutdown /s',
    'for %i in (x) do if 1==1 shutdown /s',
    '(if 1==1 shutdown /s)',
    'powershell -c "switch (1) { 1 { Stop-Computer } }"',
    'if /i "a"=="a" shutdown /s',
    'if "a b"=="a b" shutdown /s',
    'if exist "C:\\Program Files" shutdown /s',
    /* iex 的内容可以拼出来 / 从文件读 —— 段内看不到词根也必须拦 */
    "powershell -c \"iex ('Stop-' + 'Computer')\"",
    'powershell -c "iex (Get-Content c:\\x.ps1)"',
  ];
  for (const c of mustDeny) {
    assert.strictEqual(PG.isPowerCommand(c), true, '嵌套结构里的关机必须拦截：' + c);
  }
  /* 放行面一起锁住：嵌套结构里的日常命令不能误伤 */
  const mustAllow = [
    'if 1==1 if 2==2 echo hi',
    'for %i in (x) do if 1==1 echo hi',
    '(if 1==1 echo hi)',
    'powershell -c "switch (1) { 1 { Write-Output hi } }"',
    'if /i "a"=="a" echo hi',
    'if "a b"=="a b" echo hi',
    'if 1==1 if 2==2 shutdown /a',
  ];
  for (const c of mustAllow) {
    assert.strictEqual(PG.isPowerCommand(c), false, '嵌套结构里的日常命令被误拦：' + c);
  }
});

t('35 iex 出现即拦（字符串即代码，与 -EncodedCommand 同取舍）', () => {
  const PG = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 锁的是：iex 判定被改回「段内必须可见危险词根」——
   * `iex (Get-Content x.ps1)` 与拼接串里没有词根，但内容不可静态判定，
   * 必须与 -EncodedCommand 一样 fail-closed。 */
  assert.strictEqual(PG.isPowerCommand('powershell -c "iex $script"'), true,
    'iex 变量内容不可判定，必须拦');
  assert.strictEqual(PG.isPowerCommand('powershell -c "Invoke-Expression (Get-Content a.ps1)"'), true,
    'Invoke-Expression 读文件内容不可判定，必须拦');
  /* 文本里提到 iex 不算（allTextSegments 先放行） */
  assert.strictEqual(PG.isPowerCommand('echo iex something'), false, 'echo iex 被误拦');
});

/* ==================== 36. 变量/转义绕过（第四轮审查） ====================
 * 三条共同的成因：门禁只看「字面上的首词」。首词被变量或 caret 顶替后，
 * DANGER_TOKENS 一个都对不上，`checkPowerGate(cmd,false)` 直接返回 null。
 * 以下每一条都在 cmd.exe 里会真的执行（纯判定复现；实机验证用 `shutdown /a`
 * 这种无害载荷做过，见 docs 里的审查记录）。 */
t('36a for /f 间接取程序名必须拦（%i 不在 DANGER_TOKENS 里）', () => {
  const cmd = "cmd /c for /f %i in ('echo shutdown') do %i /s";
  /* 锁的是：for 体里的可执行位是 `%i`，危险词只出现在收集部分的引号里。
   * 只递归 for 体、不把「首词是变量」判成 fail-closed 的话，这条会放行。 */
  assert.strictEqual(PG.isPowerCommand(cmd), true, 'for /f %i 间接关机必须拦截');
  assert.ok(PG.checkPowerGate(cmd, false), '未开启高危能力时该命令必须被门禁拒绝');
});

t('36b cmd 延迟展开 !VAR! 必须拦（与 %VAR% 同一取舍）', () => {
  const cmd = 'cmd.exe /v:on /c set x=shutdown& !x! /s';
  /* 锁的是：hasUnknownVar 只认 %VAR% 时，`!x!` 原样留下 ——
   * 首词是 `!x!`，与危险词对不上；而 /v:on 下 cmd 会在执行时把它展开成 shutdown。 */
  assert.strictEqual(PG.isPowerCommand(cmd), true, '延迟展开的关机必须拦截');
  assert.ok(PG.checkPowerGate(cmd, false), '未开启高危能力时该命令必须被门禁拒绝');
});

t('36c cmd 的 ^ 转义必须剥掉再判首词', () => {
  /* 锁的是：normalizeCommand 若不剥 caret，首词会是 shut^down / s^hutdown，
   * 与 DANGER_TOKENS 全不匹配 —— 而 cmd 会吃掉 ^ 后照常执行 shutdown。 */
  for (const cmd of ['cmd /c shut^down /s', 'cmd /c s^hutdown /s', 'shutdown^ /s']) {
    assert.strictEqual(PG.isPowerCommand(cmd), true, 'caret 转义的关机必须拦截：' + cmd);
  }
});

t('36d 三类绕过修好后，日常命令与 /a 不能被误伤', () => {
  /* 锁的是：这次加固的回归面 —— 文本命令、参数里含 shutdown 字样、
   * 取消关机（/a）都必须继续放行，否则用户日常操作会一直弹高危确认。 */
  const mustAllow = [
    'cmd /c echo hello',
    'cmd /c echo shutdown',
    'cmd /c echo !x!',
    'cmd /c del D:\\logs\\shutdown.log',
    'cmd /c shutdown /a',
    'for %i in (x) do echo hi',
  ];
  for (const c of mustAllow) {
    assert.strictEqual(PG.isPowerCommand(c), false, '日常命令被误拦：' + c);
  }
  /* 锁的是：源码里必须留下「变量当首词 = fail-closed」与「剥 caret」两处实现，
   * 否则下一个人删掉注释/分支时测试仍可能绿。 */
  const code = read('lib/power-gate.js');
  assert.ok(/\^\(\[\\s\\S\]\)/.test(code), 'normalizeCommand 里找不到剥 caret 的实现');
  /* 锁的是：textHasDanger 里「首词是变量」的判定被删（for /f %i 那条会复发）。 */
  assert.ok(/isVariableHead\(head\)/.test(code), 'textHasDanger 里找不到「首词是变量」的判定');
  /* 锁的是：变量首词的判据本身 —— for 变量 %i/%%i 必须被认成变量，
   * 而普通程序名（哪怕长得像）不能被误认，否则门禁会大面积误拦。 */
  for (const v of ['%i', '%%i', '%FOO%', '!x!', '%~dp0setup']) {
    assert.strictEqual(PG.isVariableHead(v), true, '该形态是变量，必须 fail-closed：' + v);
  }
  for (const v of ['shutdown', 'cmd', 'echo', 'del', 'not shutdown']) {
    assert.strictEqual(PG.isVariableHead(v), false, '普通首词被误判成变量：' + v);
  }
});

/* ==================== 27. expr-eval 取余 vs 百分比 ==================== */

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
