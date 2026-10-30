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
  (B === '\\' ? 'C:' + B + 'Windows' + B + 'System32' + B + 'shutdown.exe /s' : '')
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

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
