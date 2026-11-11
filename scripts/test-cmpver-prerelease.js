/* 锁的是：cmpVer（main.js 版本比较）对预发布后缀的语义。
 * 这是「更新检查是否会误报/漏报」的唯一判据，历史回归：
 * `0.3.5-beta` 被 Number() 变 NaN 再落 0，被判成比 0.3.4 还旧 ——
 * 更新提示的方向整个反过来。
 *
 * 为什么不能用行为断言：cmpVer 在 main.js 内部、不导出，行为测试要么
 * require('main.js')（会拉起 Electron），要么复制一份实现（测副本必然分叉）。
 * 仓库已有 test-version.js 用「源码抽函数 + new Function」的方式测副本，
 * 但那是 mainSrc.indexOf 的脆弱锚点；这里用同一抽函数方式锁三条语义：
 *   1) `0.8.0-1` 与 `0.8.0` 相等（prerelease 后缀被忽略，同 cmpVer 契约）；
 *   2) `0.3.5-beta` > `0.3.4`（后缀不吞第三段数字，回归场景）；
 *   3) 返回值收敛为三态 -1/0/1（调用方用 === 1 判断，差值会漏判）。
 * 抽出来的函数体与 main.js 同源，保证测的不是另一份手写实现。 */
const { readSrc } = require('./lib/harness');
const assert = require('assert');

const src = readSrc('main.js');
const i = src.indexOf('function cmpVer');
assert.ok(i >= 0, 'main.js 里必须存在 cmpVer');
const code = src.slice(i, src.indexOf('\n}', i) + 2);
const cmpVer = new Function('return ' + code.replace(/^function cmpVer/, 'function'))();

let pass = 0, fail = 0;
function chk(cond, name) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } }

/* 锁的是：带数字预发布后缀的版本与主版本对比的关系 —— 相等意味着
 * 用户停在 0.8.0 时不会收到 0.8.0-1 的更新提示（这正是 v0.8.0-1 采用
 * SemVer prerelease 形态后产生的已知边界，v0.8.1 起改回常规形态规避；
 * 这里仍钉住 cmpVer 的这条语义，防止将来悄悄变化）。 */
chk(cmpVer('0.8.0-1', '0.8.0') === 0, 'cmpVer(0.8.0-1, 0.8.0) = 0（prerelease 后缀被忽略）');
/* 锁的是：-beta 后缀不得吞掉第三段数字（历史回归：0.3.5-beta 曾被判成 0.3.0）。 */
chk(cmpVer('0.3.5-beta', '0.3.4') === 1, 'cmpVer(0.3.5-beta, 0.3.4) = 1（后缀不吞数字）');
/* 锁的是：返回值必须是三态；调用方写 `> 0` 与 `=== 1` 都依赖这个收敛。 */
chk([cmpVer('1.0.0', '0.9.9'), cmpVer('0.9.9', '1.0.0'), cmpVer('1.0.0', '1.0.0')]
  .join() === '1,-1,0', 'cmpVer 返回值收敛为 -1/0/1');
/* 锁的是：null/undefined/垃圾输入不得抛异常（更新检查的入参来自网络响应）。 */
chk(cmpVer(null, '1.0.0') === -1 && cmpVer('', '') === 0, 'cmpVer 对空值容错');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
