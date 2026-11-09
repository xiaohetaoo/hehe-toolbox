'use strict';
/* 压缩工具「自动命名」的路径推导测试（纯逻辑断言 + 源码断言）。
 *
 * ============ 锁的是哪个历史回归 ============
 * zip-tool 与 archive-7z 在「输出名留空」时会自动把压缩包放在源文件旁边，
 * 原实现是：
 *   const dir = first.includes('/') ? first.slice(0, first.lastIndexOf('/'))
 *                                   : first.slice(0, first.lastIndexOf('\\'));
 * 这句有三处会算出错误目录：
 *   ① 混用分隔符（D:/foo\bar.txt）：includes('/') 为真，但 lastIndexOf('/')
 *      停在中间，切出来的 dir 丢了后半段；
 *   ② 完全没有分隔符（用户在 D 盘根下拖入单个文件名、或路径被上游规整过）：
 *      lastIndexOf 返回 -1，而 `slice(0, -1)` **不是空串**，是"去掉最后一个
 *      字符" —— 于是 a.txt 得到 "a.t" 当目录；
 *   ③ 目录为空串时拼出的 '/archive.zip' 是相对路径，会落到主进程 cwd
 *      （很可能是安装目录），用户找不到产物。
 * 现在的实现取 '/' 与 '\\' 里更靠后的那个，找不到就回落到 '.'。
 *
 * ============ 为什么既有逻辑断言又有源码断言 ============
 * 这段推导没有抽成函数（它在两个工具各自的 render() 里各一份），所以
 * 行为断言只能复刻一份等价实现来验证「正确的算法是什么」；
 * 而"工具有没有真的用这个算法"必须靠源码断言锁住 ——
 * 否则改了算法、测试还在测旧副本，就是典型的假绿。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

/* 参考实现：取两种分隔符里更靠后的那个；找不到回落到 '.'。
 * 【与工具里的实现必须逐字等价】改动这里等于改标准，要同步改工具。 */
function dirOf(p) {
  const s = String(p == null ? '' : p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : '.';
}

t('自动命名：普通反斜杠路径取到正确目录', () => {
  assert.strictEqual(dirOf('D:\\zcode\\hehe\\a.txt'), 'D:\\zcode\\hehe');
});

t('自动命名：正斜杠路径取到正确目录', () => {
  assert.strictEqual(dirOf('D:/zcode/hehe/a.txt'), 'D:/zcode/hehe');
});

t('自动命名：混用分隔符时取更靠后的那个（原实现会切错）', () => {
  /* 原实现在这里得到 'D:/foo'，丢掉 bar 这一段。 */
  assert.strictEqual(dirOf('D:/foo\\bar.txt'), 'D:/foo');
  assert.strictEqual(dirOf('D:\\foo/bar.txt'), 'D:\\foo');
});

t('自动命名：没有分隔符时回落成 "."，而不是"掐掉最后一个字符"', () => {
  /* 原实现这里是 slice(0, -1) === 'a.t' —— 一个看起来像路径、实际不存在的目录。 */
  assert.notStrictEqual(dirOf('a.txt'), 'a.t');
  assert.strictEqual(dirOf('a.txt'), '.');
});

t('自动命名：盘符根下的文件不会把盘符当文件名切掉', () => {
  /* 'D:\\a.txt' → 索引 2 是分隔符，i>0 成立 → 'D:'（相对 D 盘当前目录）。
   * 这是 Windows 的固有语义，工具侧再拼 '/archive.zip' 后由主进程 resolve。 */
  assert.strictEqual(dirOf('D:\\a.txt'), 'D:');
});

t('两个压缩工具的自动命名都用了「两种分隔符取靠后者」的写法', () => {
  const src = readSrc('js/tools/file-tools.js');
  /* 锁的是：zip-tool 与 archive-7z 都不再出现「includes('/') ? ... : ...」那套
   * 会切错目录的旧写法。两处都要改成 max(lastIndexOf('/'), lastIndexOf('\\'))。 */
  assert.ok(!/includes\('\/'\)\s*\?/.test(src),
    'file-tools.js 里仍有 includes(\'/\') ? ... 的旧路径推导（会切错目录）');
  /* 锁的是：两处自动命名都必须用 Math.max 取更靠后的分隔符。 */
  const hits = src.match(/Math\.max\(first\.lastIndexOf\('\/'\), first\.lastIndexOf\('\\\\'\)\)/g) || [];
  assert.strictEqual(hits.length, 2, '自动命名的路径推导应有两处，实际 ' + hits.length + ' 处');
});

done();
