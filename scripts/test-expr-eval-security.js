// expr-eval 边界与安全测试（文件版，避免 PowerShell 引号问题）
const { evaluate } = require('../lib/expr-eval');
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } }

const cases = [
  ['2^10', 1024],
  ['sin(pi/4)', Math.sin(Math.PI / 4)],
  ['1e-3*2', 0.002],
  ['50%', 0.5],
  ['1_000+1', 1001],
];
for (const [expr, want] of cases) {
  try {
    const got = evaluate(expr);
    ok(Math.abs(got - want) < 1e-9, '计算 ' + expr + ' = ' + got);
  } catch (e) { ok(false, '计算 ' + expr + ' 抛错：' + e.message); }
}
// 必须拒绝的（注入面）
for (const bad of ['constructor', 'process', 'globalThis', 'Math', '__proto__', 'eval', '1;2', 'a=1', 'Function("return 1")()']) {
  let leaked = false;
  try { const v = evaluate(bad); if (v !== undefined) leaked = true; } catch (e) { /* 拒绝是预期 */ }
  ok(!leaked, '拒绝 ' + JSON.stringify(bad));
}
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
