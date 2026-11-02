const fs = require('fs');
const CLOSE = '*' + '/';
const p = 'scripts/test-dir-move-impl.js';
const L = fs.readFileSync(p, 'utf8').split('\n');

/* 把「锁的是」注释与多余的说明合并成一段紧贴断言的注释（≤3 行）。 */
const i = L.findIndex((l) => l.includes('assert.ok(/isInsideTree\\(linkTargetAbs\\(l\\), srcAbs\\)'));
if (i < 0) { console.error('找不到断言行'); process.exit(1); }

/* 删掉断言上方连续的注释行（最多 12 行），换成一段紧凑的 */
let k = i - 1;
const removed = [];
while (k >= 0 && i - k <= 12 && /^( *(\/\*|\*|说明：|不能放在))/.test(L[k])) {
  removed.push(L[k]);
  k--;
}
if (!removed.length) { console.error('断言上方没有注释'); process.exit(1); }
L.splice(k + 1, removed.length);

const NOTE = [
  '  /* 锁的是：预检自己算一遍「内部链接数」、搬家时再按另一套判据改写，',
  '   * 两套判据一旦分叉，界面说「3 条内链会被改写」而实际改写 2 条。',
  '   * 注释必须紧贴断言 —— 守门员只认上方 3 行。 */',
];
L.splice(i - removed.length, 0, ...NOTE);
/* 上面的 splice 位置：原断言现在在 i - removed.length，插入到它前面 */
fs.writeFileSync(p, L.join('\n'), 'utf8');
console.log('已精简注释（删除 ' + removed.length + ' 行，插入 3 行）');
