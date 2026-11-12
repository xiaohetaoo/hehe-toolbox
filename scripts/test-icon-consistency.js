'use strict';
/* 图标一致性守卫：新增的 emoji 不许再混进界面文案。
 *
 * ============ 这条守的是什么 ============
 * 项目有一套统一的 89 个线性 SVG 图标（24×24、stroke 2、颜色继承 currentColor），
 * 由 js/icons.js 提供。afa0bdc 那一轮把全项目 122 处当图标用的 emoji
 * 换成了它们，理由是 emoji 的三个属性都不受控：
 *   · 字重 —— 系统 emoji 字体没有"2px 描边"这种概念，和旁边的文字对不齐；
 *   · 基线 —— emoji 的字面高度与中文字面不同，混排时整行会被顶歪；
 *   · 颜色 —— 深色主题下会被系统替换成彩色字形（截图实证），
 *     而项目的其它图标都是跟着 currentColor 变色的单色线条。
 *
 * 之后新写的功能又陆续退回了 ⚠：diff3 的冲突标签、img-scramble 的警示横幅、
 * 设置页的「上次异常退出」提示。三处都不是"忘了规范"，而是写的时候
 * 手边就有个现成的字符可用 —— 所以光靠约定挡不住，得有红灯。
 *
 * ============ 为什么用基线而不是一刀切禁止 ============
 * 存量还有 35 行。它们分两类：
 *   · 真的该换的（⚠ 打头的错误提示，二十来处）
 *   · 换了反而变差的（`★ 收藏` 是文案里的符号，不是图标；
 *     `✏️` 在截图工具的工具条上，那里没有图标系统的位置）
 * 一刀切会让这批全部变红，而"改不动就调基线"是这类断言的死法。
 * 所以记一个**只能往下走**的总数：新增一条 → 红；改掉几条 → 提示把基线改小。
 * 这样"这次新增的"一定被拦住，存量的清理可以分多次做。
 *
 * ============ 判据为什么排除 ✓ ✗ ★ ============
 * 它们不是 Emoji_Presentation 字符：✓(U+2713) ✗(U+2717) ★(U+2605)
 * 在绝大多数系统里按普通字形渲染、跟随 currentColor，
 * 与 .tag 里的文字混排没有问题（项目里几十处对比表都用它们表示成败）。
 * 真正的问题是 U+1F300 以上、U+2600~U+27BF 里带 emoji 呈现的那些，
 * 以及任何后面跟 U+FE0F（变体选择符，强制彩色）的字符。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT, readSrc } = require('./lib/harness');

/* 会渲染成彩色 emoji 的区段。故意不含 U+2713/U+2717（✓ ✗）与
 * U+25A0~U+25FF（▭ ▦ 这类几何形状，是正常文字符号）。 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

/* 存量基线：2026-11-05 实测 35 行；2026-11-07 把「文件占用解锁」里新增的
 * 两处 ⚠ 换成了 SVG 图标（js/icons.js 的 alert），顺手降一条到 34。
 * 只允许往下走。 */
const BASELINE = 33;

/* 收集全部界面源码（相对路径，供 readSrc 用）。 */
function collectSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith('.js') || e.name.endsWith('.html')) {
        out.push(path.relative(ROOT, p).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(ROOT, 'js'));
  for (const f of ['index.html', 'pin.html', 'ruler.html', 'snip.html']) {
    if (fs.existsSync(path.join(ROOT, f))) out.push(f);
  }
  return out;
}

/* 数「含 emoji 的行」。两条用例共用 —— 各写一份迟早分叉，
 * 而"基线虚高"那条只会打印提示不会红，分叉了也没人发现。 */
function scanEmoji() {
  const hits = [];
  for (const rel of collectSources()) {
    /* readSrc 会先剥注释：注释里写 emoji 当例子是正常的事，
     * 本项目到处在注释里解释"这里为什么不用 emoji"。 */
    readSrc(rel).split('\n').forEach((ln, i) => {
      if (EMOJI.test(ln)) hits.push(rel + ':' + (i + 1) + '  ' + ln.trim().slice(0, 90));
    });
  }
  return hits;
}

t('界面源码里当图标用的 emoji 数量不超过基线（新增的必须改回 SVG 图标）', () => {
  const hits = scanEmoji();
  /* 锁的是：afa0bdc 之后又新增的三处 ⚠（diff3 冲突标签 / img-scramble 警示横幅 /
   * 设置页"上次异常退出"），以及"后来者再抄一处"这个可预期的复发。
   * 只能用源码断言：这是对**源码文本**的约束（界面里不许出现彩色 emoji），
   * 而不是某个函数的行为 —— 真去渲染截图需要 9 配色 × 2 明暗 × 全页面的巡检。 */
  assert.ok(hits.length <= BASELINE,
    '界面源码里新增了 ' + (hits.length - BASELINE) + ' 行 emoji（基线 ' + BASELINE + '，现在 ' + hits.length + '）。\n'
    + '请改用 window.ui.icon(\'alert\') 这类 SVG 图标（见 js/icons.js）。\n'
    + '当前全部命中：\n  ' + hits.join('\n  '));
});

t('基线没有虚高（实际数量比基线少时提示改小，否则这条会失去意义）', () => {
  const n = scanEmoji().length;
  /* 不判红：清理掉一些之后不该被迫当场改基线。
   * 但要"说出来"，否则基线会永远停在最大那个数字上，
   * 新增一条挤进空出来的额度里也没人发现 —— 那正是这类棘轮的死法。 */
  if (n < BASELINE) {
    console.log('  [提示] emoji 行数已降到 ' + n + '（基线 ' + BASELINE + '）。'
      + '可以把这个文件里的 BASELINE 改成 ' + n + '。');
  }
  assert.ok(n <= BASELINE, '实际 ' + n + ' > 基线 ' + BASELINE);
});

done();
