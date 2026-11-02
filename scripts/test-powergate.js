'use strict';
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
const assert = require('assert');
const path = require('path');
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
  assert.ok(src.includes("require('./lib/power-gate')"), '未引用共享实现');
  assert.ok(!/const POWER_CMD_RE\s*=/.test(src), 'main.js 仍有本地 POWER_CMD_RE');
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

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
