'use strict';
/* harness 自身的测试：输出格式与退出码是 CI 依赖的契约，必须锁住。 */
const assert = require('assert');
const path = require('path');
const cp = require('child_process');
const H = require('./lib/harness');

let pass = 0, fail = 0;
const chk = (c, m) => { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m + '  -> 断言失败'); } };

/* ---- 1. createSuite 的默认分隔符是双空格（与原项目绝大多数脚本一致） ---- */
{
  const s = H.createSuite();
  assert.ok(s.t, 'createSuite 应返回 t');
  assert.ok(s.done, 'createSuite 应返回 done');
  chk(typeof s.t === 'function' && typeof s.done === 'function', 'createSuite 返回 { t, done }');
}
{
  /* 用一个子进程跑，避免 done() 里的 process.exit 把我自己杀掉 */
  const script = `
const H = require(${JSON.stringify(path.join(__dirname, 'lib', 'harness'))});
const { t, done } = H;
t('同步通过', () => {});
t('同步失败', () => { throw new Error('boom'); });
t('异步通过', async () => {});
done();
`;
  const r = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const out = r.stdout;
  chk(/PASS  同步通过/.test(out), '同步用例打印 PASS（双空格）');
  chk(/PASS  异步通过/.test(out), '异步用例也会打印 PASS（不能被 exit 提前截断）');
  chk(/FAIL  同步失败  -> boom/.test(out), '失败行格式：FAIL  名字  -> message');
  chk(/结果: 2 通过 \/ 1 失败/.test(out), '结果行格式不变');
  chk(r.status === 1, '有失败时退出码为 1，实际 ' + r.status);
}

/* ---- 2. 单空格分隔符（少数脚本原本是 ' -> '） ---- */
{
  const script = `
const H = require(${JSON.stringify(path.join(__dirname, 'lib', 'harness'))});
const s = H.createSuite({ failSep: ' -> ' });
s.t('失败', () => { throw new Error('boom'); });
s.done();
`;
  const r = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  chk(/FAIL  失败 -> boom/.test(r.stdout), "failSep 可指定为 ' -> '（保留个别脚本的原格式）");
  chk(!/FAIL  失败  ->/.test(r.stdout), '指定单空格时不应再输出双空格');
}

/* ---- 3. 异步用例必须真的被等待（否则会静默少条数） ---- */
{
  const script = `
const H = require(${JSON.stringify(path.join(__dirname, 'lib', 'harness'))});
const { t, done } = H;
t('慢用例', async () => { await new Promise(r => setTimeout(r, 120)); });
done();
`;
  const r = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  chk(/PASS  慢用例/.test(r.stdout), 'done() 会等待异步用例完成（不能漏打 PASS）');
  chk(/结果: 1 通过 \/ 0 失败/.test(r.stdout), '异步用例也被计入通过数');
  chk(r.status === 0, '全通过时退出码为 0');
}

/* ---- 4. 多行错误消息要折成一行（CI 靠行首 grep 抓 FAIL） ---- */
{
  const script = `
const H = require(${JSON.stringify(path.join(__dirname, 'lib', 'harness'))});
const { t, done } = H;
t('多行失败', () => { throw new Error('第一行\\n第二行'); });
done();
`;
  const r = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const failLines = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('FAIL'));
  const extra = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('第二行'));
  chk(failLines.length === 1, 'FAIL 只占一行（否则 CI 的 annotation 会被截断）');
  chk(extra.length === 0, '错误消息里的换行被折掉了，没有独立成行');
}

/* ---- 5. readSrc 默认剥注释，raw 可选 ---- */
{
  const code = H.readSrc('lib/expr-eval.js');
  chk(typeof code === 'string' && code.length > 100, 'readSrc 能读到源码');
  /* 锁的是：「多行失败」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  chk(!code.includes('/*'), 'readSrc 默认剥掉块注释');
  const raw = H.readSrc('lib/expr-eval.js', { raw: true });
  chk(raw.includes('/*'), 'raw:true 保留注释');
  chk(raw.length > code.length, '剥注释后应更短');
}

/* ---- 6. 导出的 assert 与 stripComments/extractFn 可直接用 ---- */
{
  /* node 的 assert 是个**函数**（有 .ok/.strictEqual 等方法挂上面），
   * 不是纯对象 —— 这里只要求"能拿到且方法可用"，别把类型写死。 */
  chk(typeof H.assert === 'function' && typeof H.assert.ok === 'function',
    '导出 assert（node 的 assert 是函数，带 .ok 等方法）');
  chk(typeof H.stripComments === 'function', '导出 stripComments');
  chk(typeof H.extractFn === 'function', '导出 extractFn');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
