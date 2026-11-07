'use strict';
/* CSV ⇄ JSON：表头里出现 `__proto__` / `constructor` 这类原型键时不能静默丢列。
 *
 * ============ 锁的是哪个回归 ============
 * CSV → JSON 的组装是 `const o = {}; header.forEach((hd,i)=> o[hd] = r[i])`。
 * 表头里只要有一列叫 `__proto__`，那一句就变成**改原型**而不是加属性：
 *   实测 `__proto__,name` + `Alice,1` 得到 {"name":"1"} —— 「Alice」整列消失，
 *   界面上没有任何提示，用户只会觉得"这个工具吃了我一列数据"。
 * `constructor` / `toString` 同理（赋值会命中原型链上的既有属性）。
 *
 * 这不是"恶意输入才触发的边角"：把 JSON 导出成 CSV 再导回、或者从别处
 * 拿到一份带 `__proto__` 列的表格，都会踩到。而当前行为是**静默**丢数据。
 *
 * ============ 为什么用 defineProperty 而不是 Object.create(null) ============
 * 三种写法都实测过：
 *   · 普通赋值            → 丢列（就是缺陷本身）
 *   · Object.create(null) → 不丢，但输出对象的原型是 null，
 *                           JSON.stringify 结果一样，可下游 `o.hasOwnProperty`
 *                           之类会炸；而且改的是"对象是什么"，超出这次修复范围
 *   · defineProperty      → 不丢，原型仍是 Object.prototype，普通表头结果逐字不变
 * 所以选第三种，把改动面压到最小。
 *
 * ============ 做法 ============
 * 组装逻辑抽到 lib/csv-table.js（UMD，渲染层 <script> 与 node 测试共用一份），
 * 渲染层改为调用它。测试直接 require 这个模块跑真实现，不是复刻副本。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const csvTable = require('../lib/csv-table');

/* ============ 行为面 ============ */
t('CV1 表头含 __proto__ 时该列必须保留', () => {
  /* 锁的是：`o[hd] = v` 命中 Object.prototype 的 setter —— 整列消失。 */
  const rows = csvTable.rowsToObjects([['__proto__', 'name'], ['Alice', '1'], ['Bob', '2']]);
  assert.strictEqual(rows.length, 2);
  /* 锁的是：__proto__ 列被吃掉，只剩 name。 */
  assert.deepStrictEqual(Object.keys(rows[0]), ['__proto__', 'name'],
    '列丢了，实际只剩：' + JSON.stringify(Object.keys(rows[0])));
  /* 值也要对。注意不能写 rows[0].__proto__（那读的是原型），
   * 所以用 getOwnPropertyDescriptor / JSON 两种独立方式各验一次。 */
  const d = Object.getOwnPropertyDescriptor(rows[0], '__proto__');
  assert.ok(d, '没有 __proto__ 的自有属性');
  assert.strictEqual(d.value, 'Alice');
  assert.strictEqual(JSON.stringify(rows[0]), '{"__proto__":"Alice","name":"1"}');
});

t('CV2 原型没有被污染（不能为了保列把对象原型改掉）', () => {
  /* 锁的是：用 `o.__proto__ = {...}` 之类"绕过去"的写法 ——
   * 列是留住了，但那个对象的原型被换成了数据内容。 */
  const rows = csvTable.rowsToObjects([['__proto__', 'name'], ['Alice', '1']]);
  assert.strictEqual(Object.getPrototypeOf(rows[0]), Object.prototype,
    '对象的原型被改掉了 —— 会连带影响 hasOwnProperty / instanceof');
  /* 全局原型也不许被污染 */
  assert.strictEqual({}.polluted, undefined, 'Object.prototype 被污染了');
});

t('CV3 constructor / toString / hasOwnProperty 这几个键同样保留', () => {
  /* 【这条锁的不是丢数据，而是"阴影属性"这个既有行为别被改坏】
   * 实测：`o.constructor = 'a'` 这类赋值**会**正常建出自有可枚举属性
   * （只是遮住继承来的那个），数据本来就不丢 —— 真正丢数据的只有 `__proto__`。
   * 所以这里验的是：改造成 defineProperty 之后，
   * 这几个键仍然建在对象**自己**身上、仍然可枚举、顺序不变。
   * 若哪天有人把实现改成"跳过原型链上已有的键"，这条会先红。 */
  const header = ['constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const rows = csvTable.rowsToObjects([header, ['a', 'b', 'c', 'd']]);
  assert.deepStrictEqual(Object.keys(rows[0]), header, '列丢了：' + JSON.stringify(Object.keys(rows[0])));
  header.forEach((k, i) => {
    const d = Object.getOwnPropertyDescriptor(rows[0], k);
    assert.ok(d && d.enumerable, k + ' 不是可枚举的自有属性');
    assert.strictEqual(d.value, ['a', 'b', 'c', 'd'][i]);
  });
});

t('CV4 普通表头的结果逐字不变（这是回归面最大的地方）', () => {
  /* 锁的是：为了修边角把主路径改坏了 —— 比如顺序变了、值变成了包装对象。 */
  const rows = csvTable.rowsToObjects([['a', 'b'], ['1', '2'], ['3', '']]);
  assert.deepStrictEqual(rows, [{ a: '1', b: '2' }, { a: '3', b: '' }]);
  /* 键的顺序也要保持表头顺序（JSON 输出会照这个顺序） */
  assert.strictEqual(JSON.stringify(rows[0]), '{"a":"1","b":"2"}');
});

t('CV5 空表头列仍按「列N」补齐，且短行用空串填', () => {
  /* 锁的是：重写组装时把既有的兜底规则弄丢 ——
   * 「空表头 → 列N」与「缺值 → 空串」是原实现的既有行为。 */
  const rows = csvTable.rowsToObjects([['', 'name'], ['x']]);
  assert.deepStrictEqual(Object.keys(rows[0]), ['列1', 'name']);
  assert.strictEqual(rows[0]['列1'], 'x');
  assert.strictEqual(rows[0].name, '', '缺失的单元格应为空串');
});

t('CV6 只有表头没有数据行时返回空数组（不是 [{}]）', () => {
  /* 锁的是：边界处理写成"总是产出 rows.length 个对象"，凭空多一条空记录。
   * 【说明】这一条在"只判长度"这个修法下也会绿（那种写法同样返回 []），
   * 它守的是**输出形状**不被将来的重写改坏，不是本轮的缺陷本身。 */
  assert.deepStrictEqual(csvTable.rowsToObjects([['a', 'b']]), []);
  assert.deepStrictEqual(csvTable.rowsToObjects([]), []);
});

/* ============ 接线面 ============ */
t('CV7 渲染层确实调用了这份实现（不是各写一份）', () => {
  const src = readSrc('js/tools/text-tools.js');
  /* 锁的是：工具页里又内联了一份自己的组装逻辑 —— 那样修这里等于没修。 */
  assert.ok(/CsvTable\.rowsToObjects\(/.test(src),
    'csv-json 工具没有调用 lib/csv-table 的实现');
  /* 锁的是：内联的 `o[hd…] = …` 又回来了（原型键陷阱的原形态）。 */
  assert.ok(!/header\.forEach\(\s*\(\s*hd\s*,\s*i\s*\)\s*=>\s*o\[/.test(src),
    '工具页里还留着内联的 o[表头]=值 组装');
});

t('CV8 index.html 引入了 lib/csv-table.js（且排在工具脚本之前）', () => {
  const html = readSrc('index.html', { raw: true });
  const iLib = html.indexOf('lib/csv-table.js');
  /* 锁的是：忘了在 index.html 里挂 —— 渲染层 CsvTable 未定义，整个工具报错。 */
  assert.ok(iLib > 0, 'index.html 没有引入 lib/csv-table.js');
  const iTool = html.indexOf('js/tools/text-tools.js');
  /* 锁的是：引入顺序反了 —— 工具脚本先执行，此时 CsvTable 还不存在。 */
  assert.ok(iTool > iLib, 'lib/csv-table.js 必须排在 js/tools/text-tools.js 之前');
});

done();
