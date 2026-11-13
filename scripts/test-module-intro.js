'use strict';
/* 分类介绍（MODULES[].intro / introEn）的完整性与渲染契约。
 *
 * ============ 锁的是哪次事故 ============
 * 原来的分类卡片只有一行关键词（desc："哈希校验、批量重命名、加密分割"），
 * 用户看完知道"有哪些东西"、不知道"这一包能解决什么问题"；
 * 说明只挂在 title 属性里，不悬停就完全看不到。
 * 补 intro 之后要锁三件事：
 *   1. 10 个分类都有中英两份（缺一份英文界面下会露出中文）；
 *   2. intro 是有信息量的句子，不是把 desc 抄一遍；
 *   3. 渲染时确实取的是 intro 而不是 desc，且缺字段时能安全退回。
 *
 * 【为什么不能只用行为断言】"介绍写得对不对"是人看的；
 * 这里锁的是**结构完整性**（字段齐、长度够、不是 desc 的复制）
 * 与**取值链路**（modIntro 的语言选择与回退）。
 * 卡片真的显示了那一句，由 CDP 真机走查覆盖（4 项全过 + 深浅色截图）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* 从 registry.js 里抠出 MODULES 的原文（不 require：那是浏览器 IIFE） */
function modulesSrc() {
  const s = read('js/registry.js');
  const i = s.indexOf('MODULES = [');
  const j = s.indexOf('];', i);
  assert.ok(i > 0 && j > i, '找不到 MODULES 定义');
  return s.slice(i, j);
}

t('MI1 十个分类都有 intro 与 introEn', () => {
  const seg = modulesSrc();
  /* 锁的是：漏写。缺一条就意味着那个分类在首页仍只有关键词、
   * 或者英文界面下露出中文。 */
  const intro = (seg.match(/intro:/g) || []).length;
  const introEn = (seg.match(/introEn:/g) || []).length;
  assert.strictEqual(intro, 10, '中文 intro 应有 10 条，实际 ' + intro);
  assert.strictEqual(introEn, 10, '英文 introEn 应有 10 条，实际 ' + introEn);
});

t('MI2 intro 有信息量（不短于 30 字，不超 200 字）', () => {
  const seg = modulesSrc();
  /* 锁的是：写成占位符或一句话打天下。
   * 30 字下限是"能说清一件事"的经验门槛；200 上限防把整篇文档塞进来。 */
  const zh = [...seg.matchAll(/intro:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(zh.length === 10, '应取到 10 条中文 intro');
  const bad = zh.filter((x) => x.length < 30 || x.length > 200);
  assert.deepStrictEqual(bad, [], '这些 intro 长度不合理：\n  ' + bad.join('\n  '));
});

t('MI3 intro 不是 desc 的复制', () => {
  const seg = modulesSrc();
  /* 锁的是：把 desc 原样填进 intro 交差 —— 那样补了等于没补。 */
  const rows = [...seg.matchAll(/desc:\s*'([^']*)'[\s\S]{0,400}?intro:\s*'([^']*)'/g)];
  assert.ok(rows.length >= 10, '应能配对出 10 组 desc/intro，实际 ' + rows.length);
  const same = rows.filter((r) => r[1].trim() === r[2].trim());
  assert.deepStrictEqual(same, [], '这些分类的 intro 与 desc 完全相同：' + same.length);
});

t('MI4 英文 intro 里没有中文字符', () => {
  const seg = modulesSrc();
  /* 锁的是：英文文案里混进中文（复制粘贴时最容易发生）。 */
  const en = [...seg.matchAll(/introEn:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(en.length === 10, '应取到 10 条英文 intro');
  const hasCJK = en.filter((x) => /[\u4e00-\u9fff]/.test(x));
  assert.deepStrictEqual(hasCJK, [], '英文 intro 里含中文：\n  ' + hasCJK.join('\n  '));
});

t('MI5 modIntro 按语言取值，缺字段时退回 desc', () => {
  const s = read('js/registry.js');
  /* 锁的是：取值链路。三条都必须在：
   *   · 英文取 introEn，缺失退回 descEn；
   *   · 中文取 intro，缺失退回 desc；
   *   · 两者都空时返回空串（不能返回 undefined，否则渲染出 "undefined"）。 */
  /* 锁的是：modIntro 这个函数真的存在（没写 = 渲染层拿不到 intro）。 */
  assert.ok(/function modIntro/.test(s), '应有 modIntro');
  /* 锁的是：先取出函数体再逐项判 —— 直接对全文判会被别处的
   * i18n.lang 判断误命中，那样"函数体内有回退"就成了假绿。 */
  const m = s.match(/function modIntro[\s\S]{0,400}?\n  \}/);
  assert.ok(m, 'modIntro 函数体应能取到');
  const body = m[0];
  /* 锁的是：语言判断确实用了 i18n.lang。 */
  assert.ok(/i18n\.lang === 'en'/.test(body), 'modIntro 应判断当前语言');
  /* 锁的是：中英各有回退（缺 intro 时不能渲染空白）。 */
  assert.ok(/introEn \|\| m\.descEn/.test(body), '英文应回退到 descEn');
  assert.ok(/intro \|\| m\.desc/.test(body), '中文应回退到 desc');
  /* 锁的是：最终兜底空串，避免 undefined 出现在 DOM 里。 */
  assert.ok(/\|\| ''/.test(body), '应有空串兜底');
});

t('MI6 Registry 导出了 modIntro', () => {
  const s = read('js/registry.js');
  /* 锁的是：导出。没导出的话 app.js 拿不到（早期 TN/TD 就这么踩过）。 */
  assert.ok(/window\.Registry\s*=\s*\{[^}]*modIntro/.test(s), 'Registry 应导出 modIntro');
});

t('MI7 首页卡片渲染 .hc-intro，模块页渲染 .th-intro', () => {
  const s = read('js/app.js');
  /* 锁的是：两个渲染位置都真的用了 intro。
   * 只加字段不渲染 = 白改；只渲染一处 = 另一半用户看不到。 */
  assert.ok(/hc-intro/.test(s), '首页卡片应有 .hc-intro');
  assert.ok(/th-intro/.test(s), '模块页应有 .th-intro');
  /* 锁的是：走的是 MI()（modIntro 包装）而不是 MD()（desc 包装）。 */
  assert.ok(/const MI = \(m\)/.test(s), 'app.js 应有 MI 辅助函数');
  assert.ok(/MI\(m\)/.test(s), '渲染时应调用 MI(m)');
});

t('MI8 对应的 CSS 样式存在', () => {
  const css = read('css/app.css');
  /* 锁的是：加了节点却没有样式 —— 介绍会和名称挤在一行，
   * 或每次渲染都撑出滚动条。 */
  assert.ok(/\.home-cat \.hc-intro/.test(css), '需 .hc-intro 样式');
  assert.ok(/\.th-intro/.test(css), '需 .th-intro 样式');
  /* 锁的是：必须有行数上限。不锁具体几行 —— 间距与列数调整时
   * 2 行/3 行都是合理的，写死某个值会让正当的排版改动报红。
   * 关键是不能没有 clamp（没有就会把卡片撑成任意高度）。 */
  assert.ok(/-webkit-line-clamp:\s*[23]/.test(css), 'hc-intro 应有行数上限（2 或 3 行截断）');
  /* 锁的是：卡片等高。介绍长短不一时，不锁 auto-rows 会让网格出现
   * 三四种高度、看着参差不齐。 */
  assert.ok(/grid-auto-rows:\s*1fr/.test(css), '.home-cats 需 grid-auto-rows: 1fr 保证卡片等高');
});

done();
