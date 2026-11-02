const fs = require('fs');
const p = 'scripts/test-dir-move.js';
let s = fs.readFileSync(p, 'utf8');

if (s.includes('搬完之后作废预检')) {
  console.log('已存在，跳过');
  process.exit(0);
}

const ADD = `
/* ================= 搬家成功后作废预检（原 test-round12-fixes.js ④）====================
 * 锁的是：搬家成功后界面没把预检结论作废。用户看到的是「可以搬」，
 * 再点一次却报 SRC_IS_LINK（源目录此刻已经是链接了）—— 说法与行为对不上。
 * 修法要在成功分支同时做两件事：作废预检 + 标记已搬完。
 */

t('搬完之后作废预检、按钮保持禁用，改路径才恢复', () => {
  const src = read('js/tools/dir-move.js');
  const code = stripComments(src);
  /* 注意 state.precheck = null 出现两次：
   *   · invalidate() 里（那是「路径改了」，后面是 moved = false）
   *   · 搬家成功分支（后面才是 moved = true）
   * 所以要找「后面紧跟 moved = true」的那一处，即成功分支。 */
  const re = /state\\.precheck = null;(?:[^;]*?;){0,6}?\\s*state\\.moved = true/s;
  assert.ok(re.test(code),
    '成功分支必须同时标记「已搬完」（invalidate 里那句是 moved=false，不是它）');
  assert.ok(/goBtn\\.disabled = done \\? true : false/.test(code),
    '成功后不能无条件恢复按钮（失败才恢复）');
  assert.ok(/if \\(!state\\.precheck && !state\\.moved\\) return/.test(code),
    'invalidate 必须同时处理「已搬完」状态，否则改路径后那张卡永远不消失');
  assert.ok(/已搬完/.test(src), '应换成「已搬完」的说明卡');
});
`;

const idx = s.lastIndexOf('done();');
if (idx < 0) { console.error('找不到 done()'); process.exit(1); }

const sep = s.includes('\r\n') ? '\r\n' : '\n';
const head = s.slice(0, idx).replace(/\s*$/, '');
const add = ADD.trim().split('\n').join(sep);
s = head + sep + sep + add + sep + sep + 'done();' + sep;
fs.writeFileSync(p, s, 'utf8');
console.log('已追加 1 条用例');
