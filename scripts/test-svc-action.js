'use strict';
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const mainSrc = readMain({ raw: true });

/* 服务操作错误信息的行为测试（原 test-round13 的 23）。
 *
 * 锁的是：sc.exe 的失败信息写在 **stdout** 里，只看 stderr 会得到空错误，
 * 用户看到的是一个没有任何说明的失败。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

t('23 svc:action：sc.exe 的失败信息在 stdout 里，不能只看 stderr', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('svc:action'"), mainSrc.indexOf("handle('power:list'"));
  /* 只看可执行代码，避开注释里提到旧写法导致的假阳性 */
  const code = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\(r\.stderr \|\| r\.stdout\)/.test(code),
    '仍用 (stderr || stdout)：stderr 非空时 stdout 里的真正原因被丢掉');
  assert.ok(/String\(r\.stdout[^)]*\)[\s\S]{0,160}String\(r\.stderr/.test(code),
    '应把两路输出合并再取尾部');
  assert.ok(/失败\\s\*\\d\+|FAILED/.test(code), '退出码 0 但输出含「失败 N」时也要判失败');
});

/* ==================== 24. 周期任务延后武装 ==================== */

done();
