'use strict';
/* 验证电源门禁逻辑：未开启 system-power 时，关机/重启命令必须被拒绝。
 *
 * 【重要】本测试**直接 require lib/power-gate.js**（main.js 用的同一份实现），
 * 不再复刻一份正则。原版本把 main.js 的正则抄了一遍，后果是：
 * main.js 的正则改动后本测试照旧全绿 —— 测的是副本，不是真实现（假绿）。
 */
const assert = require('assert');
const gate = require('../lib/power-gate');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

const isPowerCommand = gate.isPowerCommand;

/* ---- 1. 必须是共享实现，而不是本地复刻 ---- */
t('使用 lib/power-gate 的共享实现', () => {
  assert.strictEqual(typeof gate.isPowerCommand, 'function');
  assert.ok(gate.POWER_CMD_RE instanceof RegExp);
});

/* ---- 2. 命令识别 ---- */
t('shutdown /s 被识别', () => assert.ok(isPowerCommand('shutdown /s /t 60')));
t('shutdown /r 被识别', () => assert.ok(isPowerCommand('shutdown /r /t 0')));
t('shutdown 无参数也算（默认关机）', () => assert.ok(isPowerCommand('shutdown')));
t('shutdown /a（取消关机）必须放行', () => assert.ok(!isPowerCommand('shutdown /a'), '取消关机是无害恢复操作，不该拦'));
t('SetSuspendState 休眠被识别', () => assert.ok(isPowerCommand('rundll32.exe powrprof.dll,SetSuspendState 0,1,0')));
t('PowerShell SetSuspendState 被识别', () => assert.ok(isPowerCommand('powershell -c "[Void][System.Windows.Forms.Application]::SetSuspendState(0,1,0)"')));
t('Stop-Computer 被识别', () => assert.ok(isPowerCommand('Stop-Computer -Force')));
t('Restart-Computer 被识别', () => assert.ok(isPowerCommand('Restart-Computer')));
t('前导空格也能识别', () => assert.ok(isPowerCommand('   shutdown /s')));
t('制表符前导也能识别', () => assert.ok(isPowerCommand('\tshutdown /s')));

/* ---- 3. 不误判 ---- */
t('普通命令不误判', () => {
  for (const c of ['ipconfig /flushdns', 'netstat -ano', 'ping 127.0.0.1',
                   'tasklist', 'dir C:\\', 'echo shutdown', 'shutdown /?']) {
    assert.ok(!isPowerCommand(c), '误判: ' + c);
  }
});
t('shutdownxxx 不误判（边界）', () => {
  // shutdown 后面必须是空白或结尾，避免误伤 shutdownx 这类名字
  assert.ok(!isPowerCommand('shutdownx /s'), '误判了 shutdownx');
});
t('空值不崩也不误判', () => {
  assert.strictEqual(isPowerCommand(''), false);
  assert.strictEqual(isPowerCommand(null), false);
  assert.strictEqual(isPowerCommand(undefined), false);
});

/* ---- 4. 门禁整体（checkPowerGate）---- */
t('未开启开关时拒绝关机命令', () => {
  const msg = gate.checkPowerGate('shutdown /s /t 60', false);
  assert.ok(msg, '应当拒绝并给出提示');
  assert.ok(/高危|已默认关闭/.test(msg), '提示文案应说明原因: ' + msg);
});
t('已开启开关时放行关机命令', () => {
  assert.strictEqual(gate.checkPowerGate('shutdown /s /t 60', true), null);
});
t('未开启开关时普通命令照常放行', () => {
  assert.strictEqual(gate.checkPowerGate('ipconfig /flushdns', false), null);
});
t('取消关机即使未开启也放行', () => {
  assert.strictEqual(gate.checkPowerGate('shutdown /a', false), null, '用户必须能取消自己排的关机');
});

/* ---- 5. 一致性：main.js 必须真的用这份实现（防空挂）---- */
const fs = require('fs');
const path = require('path');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
t('main.js 已 require lib/power-gate', () => {
  assert.ok(/require\('\.\/lib\/power-gate'\)/.test(mainSrc), 'main.js 没有引入共享实现');
});
t('main.js 不再自带一份电源正则（避免两处实现漂移）', () => {
  assert.ok(!/const POWER_CMD_RE\s*=/.test(mainSrc), 'main.js 仍有自己的 POWER_CMD_RE，会和 lib 版本漂移');
});
t('main.js 的 assertPowerAllowed 委托给 lib', () => {
  assert.ok(/powerGate\.checkPowerGate/.test(mainSrc), 'assertPowerAllowed 应调用 powerGate.checkPowerGate');
});

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
