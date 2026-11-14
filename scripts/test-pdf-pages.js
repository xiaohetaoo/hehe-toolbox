'use strict';
/* PDF 页面管理：页码范围解析 + 工具接线。
 *
 * ============ 锁的是哪次事故 ============
 * 这是新工具，锁的是两件"错了会静默产出坏文件"的事：
 *   1. 页码范围解析（"1,3,5-8" 解析错了，用户会删掉/保留错的页，
 *      而文件看起来是"成功生成"的）；
 *   2. 旋转要**累加**在已有角度上 —— 扫描件本身常带 /Rotate 90，
 *      直接 setRotation(90) 等于把它归零，用户看到"没转"。
 *
 * 【为什么范围解析可以用行为断言】parseRange 是挂到 window 上的纯函数，
 * Node 侧能直接调 —— 那部分是真行为测试，不是源码匹配。
 * 旋转累加那部分要 pdf-lib 文档对象，Node 侧造 doc 太重，
 * 改成源码结构断言 + 注明理由。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { t, done, ROOT } = require('./lib/harness');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* 在沙箱里跑 pdf-pages.js 的前半段（IIFE 里挂了 window.PdfPages）。
 * 只造它需要的最小窗口对象：PDFLib 给假的，Registry 给假的。 */
function loadParseRange() {
  const src = read('js/tools/pdf-pages.js');
  const sandbox = {
    window: {
      PdfPages: null,
      Registry: { register() {} },
      ui: { div() {}, btn() {}, toast() {}, h() {}, icon() {} },
      Channels: { CHANNELS: {} },
      api: { invoke() {} },
      PDFLib: null,
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    console,
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { timeout: 5000 });
  /* 包一层把结果复制成本地数组。
   * 【为什么必须复制】vm 沙箱里造出来的数组，其原型来自**另一个 realm** ——
   * Array.isArray 为真、打印也一样，但 assert.deepStrictEqual 会比原型
   * 且判不相等，报"Values have same structure but are not reference-equal"。
   * 这种失败看起来像"解析结果错了"，实际只是跨 realm 的比较规则。 */
  const inner = sandbox.window.PdfPages.parseRange;
  return (text, max) => Array.from(inner(text, max));
}

t('PP1 页码范围：单个数字', () => {
  const parseRange = loadParseRange();
  assert.deepStrictEqual(parseRange('3', 10), [3]);
  assert.deepStrictEqual(parseRange('1,5,9', 10), [1, 5, 9]);
});

t('PP2 页码范围：区间与混合写法', () => {
  const parseRange = loadParseRange();
  assert.deepStrictEqual(parseRange('2-5', 10), [2, 3, 4, 5]);
  assert.deepStrictEqual(parseRange('1,3,5-8', 10), [1, 3, 5, 6, 7, 8]);
  /* 倒着写的区间也要认（用户很常写 8-5） */
  assert.deepStrictEqual(parseRange('5-3', 10), [3, 4, 5]);
});

t('PP3 页码范围：去重与排序', () => {
  const parseRange = loadParseRange();
  assert.deepStrictEqual(parseRange('5,1,3,1,5', 10), [1, 3, 5]);
  assert.deepStrictEqual(parseRange('3-5,4-6', 10), [3, 4, 5, 6]);
});

t('PP4 页码范围：越界与垃圾输入被安全忽略', () => {
  const parseRange = loadParseRange();
  /* 锁的是：越界页号。不裁剪的话 removePage(99) 会抛异常，
   * 或者更糟 —— 在别的实现里可能静默删错页。 */
  assert.deepStrictEqual(parseRange('0,1,99', 10), [1]);
  assert.deepStrictEqual(parseRange('abc,1,', 10), [1]);
  assert.deepStrictEqual(parseRange('', 10), []);
  /* 全角逗号：中文输入法下很容易打出来 */
  assert.deepStrictEqual(parseRange('1，3', 10), [1, 3]);
});

t('PP5 旋转累加在已有角度上', () => {
  const s = read('js/tools/pdf-pages.js');
  /* 锁的是：扫描件本身带 /Rotate 90 时，直接 setRotation(90) 会把它
   * "归零"——用户点旋转却看不到变化，以为工具坏了。
   * 必须先读当前角度再累加。 */
  assert.ok(/getRotation\(\)\.angle/.test(s), '应先读当前旋转角度');
  /* 锁的是：累加这一行。只读当前角度但不加，等于旋转没生效。 */
  assert.ok(/cur \+ deg/.test(s), '应在当前角度上累加');
  /* 锁的是：结果要对 360 取模（否则显示成"旋转 450°"） */
  assert.ok(/% 360/.test(s), '旋转角度应对 360 取模');
});

t('PP6 每次操作从源文件重新 load', () => {
  const s = read('js/tools/pdf-pages.js');
  /* 锁的是：在同一个 pdf-lib 对象上连续 removePage 会拿错页（索引重排），
   * 所以 build() 必须从 srcB64 重新 load 一份新文档。 */
  assert.ok(/PDFDocument\.load\(srcB64/.test(s), 'build 应从 srcB64 重新 load');
  assert.ok(/PDFDocument\.create\(\)/.test(s), '应新建输出文档');
});

t('PP7 删光所有页时要回滚', () => {
  const s = read('js/tools/pdf-pages.js');
  /* 锁的是：把页全删了再保存会生成一个 0 页的坏 PDF。
   * 必须检测并回滚，而不是让用户点保存拿到一个打不开的文件。 */
  assert.ok(/不能删掉所有页/.test(s), '应有"不能删光"的拦截');
  assert.ok(/pageOrder\.length\s*\)\s*\{[\s\S]{0,300}?pageOrder = /.test(s),
    '删空后应恢复原顺序');
});

t('PP8 三张登记表都有 pdf-pages', () => {
  /* 锁的是：加工具时漏登记。ORDER 漏了它不进分类网格；
   * tool-names 漏了独立窗口标题退化成 id；features 漏了 --changed 选不到。 */
  assert.ok(/'pdf-pages'/.test(read('js/registry.js')), 'ORDER 表应有 pdf-pages');
  assert.ok(/'pdf-pages'/.test(read('lib/tool-names.js')), 'tool-names 应有 pdf-pages');
  const feat = JSON.parse(read('scripts/features.json'));
  assert.ok(feat.pdf.src.includes('js/tools/pdf-pages.js'), 'features.pdf.src 应含它');
  assert.ok(feat.pdf.tests.includes('test-pdf-pages.js'), 'features.pdf.tests 应含本测试');
});

t('PP9 index.html 引入了 pdf-pages.js', () => {
  const html = read('index.html');
  /* 锁的是：脚本没被加载 → 工具注册不上去、页面空白。 */
  assert.ok(html.indexOf('js/tools/pdf-pages.js') > 0, 'index.html 需引入 pdf-pages.js');
});

t('PP10 读取失败必须把 doc/srcB64/页序一起清空（第四轮审查）', () => {
  const s = read('js/tools/pdf-pages.js');
  const at = s.indexOf('async function loadDoc');
  assert.ok(at >= 0, '找不到 loadDoc');
  const seg = s.slice(at, at + 1800);
  /* 背景：先把 srcB64 赋上再 load，load 抛错只弹 toast → srcB64 非空、
   * doc 为 null，点「删除这些页」直接 TypeError 且界面毫无反应；
   * 若此前加载过别的 PDF，页序还是旧文档的，用户会按错的页数操作。 */
  /* 锁的是：catch 里只弹 toast 不重置状态 —— 半更新现场复发。 */
  assert.ok(/doc = null; srcB64 = null; pageOrder = \[\]; rotations = \{\};/.test(seg),
    'loadDoc 失败时必须把四个状态一起清空');
  /* 锁的是：pdf-lib 未加载的退化路径留着旧文档 —— 操作会作用在旧 PDF 上。 */
  assert.ok(/if \(!PDFLib\) \{[\s\S]{0,220}?srcB64 = null/.test(seg),
    'PDFLib 缺失的退化路径也要清状态');
  /* 锁的是：操作入口只判 srcB64 —— doc 为 null 时仍会抛 TypeError。 */
  assert.ok(/if \(!srcB64 \|\| !doc\)/.test(s),
    '删除/保留页的入口必须同时判 srcB64 与 doc');
});

done();
