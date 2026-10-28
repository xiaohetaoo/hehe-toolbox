'use strict';
/* 验证电源门禁逻辑：未开启 system-power 时，关机/重启命令必须被拒绝。
 * 只测判定函数，不真的执行命令。
 */
const assert = require('assert');
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

/* 复刻 main.js 的电源命令识别 */
const POWER_CMD_RE = /^\s*(shutdown(\s|$)|rundll32\.exe\s+powrprof|powershell.*SetSuspendState|Stop-Computer|Restart-Computer)/i;
const POWER_CANCEL_RE = /^\s*shutdown\s+\/a(\s|$)/i;
const isPowerCommand = (cmd) => {
  const s = String(cmd || '');
  if (POWER_CANCEL_RE.test(s)) return false;
  return POWER_CMD_RE.test(s);
};

t('shutdown /s 被识别', () => assert.ok(isPowerCommand('shutdown /s /t 60')));
t('shutdown /r 被识别', () => assert.ok(isPowerCommand('shutdown /r /t 0')));
t('shutdown /a（取消关机）必须放行', () => assert.ok(!isPowerCommand('shutdown /a'), '取消关机是无害恢复操作，不该拦'));
t('SetSuspendState 休眠被识别', () => assert.ok(isPowerCommand('rundll32.exe powrprof.dll,SetSuspendState 0,1,0')));
t('Stop-Computer 被识别', () => assert.ok(isPowerCommand('Stop-Computer -Force')));
t('Restart-Computer 被识别', () => assert.ok(isPowerCommand('Restart-Computer')));
t('前导空格也能识别', () => assert.ok(isPowerCommand('   shutdown /s')));

t('普通命令不误判', () => {
  for (const c of ['ipconfig /flushdns', 'netstat -ano', 'ping 127.0.0.1',
                   'tasklist', 'dir C:\\', 'echo shutdown']) {
    assert.ok(!isPowerCommand(c), '误判: ' + c);
  }
});
t('shutdownxxx 不误判（边界）', () => {
  // shutdown 后面必须是空白或结尾，避免误伤 shutdownx 这类名字
  assert.ok(!isPowerCommand('shutdownx /s'), '误判了 shutdownx');
});

/* 门禁整体逻辑 */
function assertPowerAllowed(cmd, enabled) {
  if (isPowerCommand(cmd) && !enabled) {
    const e = new Error('「系统电源操作」属于高危功能，已默认关闭。');
    e.code = 'CAP_DENIED';
    throw e;
  }
}
t('未开启开关时拒绝关机命令', () => {
  let threw = false;
  try { assertPowerAllowed('shutdown /s /t 60', false); } catch (e) { threw = true; assert.strictEqual(e.code, 'CAP_DENIED'); }
  assert.ok(threw, '应当拒绝');
});
t('已开启开关时放行关机命令', () => {
  assert.doesNotThrow(() => assertPowerAllowed('shutdown /s /t 60', true));
});
t('未开启开关时普通命令照常放行', () => {
  assert.doesNotThrow(() => assertPowerAllowed('ipconfig /flushdns', false));
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
