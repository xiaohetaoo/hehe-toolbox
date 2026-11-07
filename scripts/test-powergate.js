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
  assert.ok(!/allTextSegments\(norm\)/.test(code),
    '仍保留了 allTextSegments(norm) —— 那是一条没有真实语义的放行路径');
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

/* ==================== 27. expr-eval 取余 vs 百分比 ==================== */

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
