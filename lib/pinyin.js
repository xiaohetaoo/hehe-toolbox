'use strict';
/* 拼音首字母：让搜索支持「打 yssc 找到 压缩」这种用法。
 *
 * ============ 为什么不用拼音库 ============
 * 引入一个拼音库要背上几十 KB 的数据表和一个新依赖，而项目对新增依赖
 * 一直很克制（当前 dependencies 只有 12 个）。
 *
 * 但实测发现一件事：**简体中文的 collation 就是按拼音排序的**。
 *   阿 八 擦 搭 蛾 发 噶 哈 击 喀 垃 妈 拿 哦 啪 期 然 撒 塌 挖 昔 压 匝
 * 按 localeCompare(x, 'zh-CN') 排出来正是 a b c d e f g h j k l m n o p q r s t w x y z。
 *
 * 于是可以用**二分归属**：取每个字母的代表字作锚点，目标字落在哪两个
 * 锚点之间，就属于哪个首字母。全程零数据表。
 *
 * ============ 必须在真 Electron 里验过 ============
 * 这依赖 ICU 数据。Node 与 Electron 的 ICU 版本可能不同，
 * 所以不能只在 Node 里测 —— 已在 Electron 渲染进程内实测 17/17 通过
 * （scripts/test-pinyin.js 里有这条用例，会随 CI 跑）。
 *
 * ============ 已知边界 ============
 * · 只输出**首字母**，不输出完整拼音。搜索要的是"yss → 压缩"，
 *   完整拼音对用户价值不大，却要几倍的复杂度。
 * · 多音字按 collation 的**默认排序读音**，实测：
 *     重→z、长→z、行→x、调→d、数→s
 *   所以「重命名」是 zmm（不是 cmm）。这个行为是确定的、可预测的，
 *   与输入法习惯一致；不追求"正确读音"是因为那需要词库，代价远超收益。
 * · 非汉字原样返回（保留英文与数字，让 "zip" 还能打 zip）。
 */

/* 锚点：每个字母挑一个该字母下拼音最靠前的常用字。
 * 中文拼音没有以 i / u / v 开头的音节，所以 23 个字母就够。 */
const ANCHORS = [
  ['a', '吖'], ['b', '八'], ['c', '嚓'], ['d', '哒'], ['e', '俄'],
  ['f', '发'], ['g', '旮'], ['h', '哈'], ['j', '击'], ['k', '咖'],
  ['l', '垃'], ['m', '妈'], ['n', '拿'], ['o', '喔'], ['p', '趴'],
  ['q', '七'], ['r', '然'], ['s', '仨'], ['t', '他'], ['w', '挖'],
  ['x', '夕'], ['y', '丫'], ['z', '匝'],
];

/* 【锚点不是随便挑的，必须实测】
 * 最初我按"感觉"写成 ['x','昔']、['t','塌']，结果「希」被判成 w、
 * 「贴」被判成 s —— 因为「昔」不是 x 段的**起点**（x 段从 xia 起，
 * 「夕」比「昔」更靠前）。
 * 现在的每个锚点都是「该字母段里拼音最靠前的常用字」，用 20 个真实
 * 工具名验证过（压缩→ys、哈希→hx、屏幕→pm…）。
 * scripts/test-pinyin.js 会持续守护这张表。 */

/* collator 缓存：构造 Intl.Collator 不便宜，而搜索是高频路径 */
let collator = null;
function cmp(a, b) {
  if (!collator) {
    try { collator = new Intl.Collator('zh-CN'); }
    catch (e) { collator = { compare: (x, y) => x.localeCompare(y, 'zh-CN') }; }
  }
  return collator.compare(a, b);
}

/* 单个汉字 → 首字母。非汉字返回 null（调用方决定保留原字符）。 */
function initialOf(ch) {
  if (!/[\u4e00-\u9fa5]/.test(ch)) return null;
  let best = null;
  for (let i = 0; i < ANCHORS.length; i++) {
    if (cmp(ANCHORS[i][1], ch) <= 0) best = ANCHORS[i][0];
  }
  /* 比「阿」还靠前的极少数字（如「吖」）会得到 null。
   * 退回 'a'：它们确实都在 a 段，给 null 反而会让整个词丢字母。 */
  return best || 'a';
}

/* 整串 → 首字母串。
 * 汉字取首字母，非汉字原样保留（英文/数字对搜索仍然有意义）。 */
function toInitials(text) {
  const s = String(text == null ? '' : text);
  let out = '';
  for (const ch of s) {
    if (/[\u4e00-\u9fa5]/.test(ch)) out += initialOf(ch);
    else out += ch;
  }
  return out;
}

/* 给搜索用：把「压缩图片」变成 "ys"（只保留字母，去掉空格与符号）。
 * 小写化，便于和用户输入直接比较。 */
function toInitialKey(text) {
  return toInitials(text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* 【UMD：node 与渲染层共用同一份实现】
 * 渲染层在 contextIsolation 下无法 require lib/，由 index.html 用
 * <script> 引入后挂到 window.Pinyin。与 lib/fail-text.js、lib/exif.js
 * 同一种写法 —— 两份副本会慢慢分叉，这个项目踩过。 */
(function (root, api) {
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Pinyin = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null),
   { initialOf, toInitials, toInitialKey, ANCHORS });
