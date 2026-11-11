'use strict';
/* i18n 字典完整性：zh/en 键集合、空值、插值占位符对齐。
 *
 * ============ 锁的是哪次事故 / 哪类回归 ============
 * 切英文时界面出现键名或残留中文，几乎都是这三类之一：
 *   ① zh 有键、en 漏了 —— t() 回退中文，用户看到「半英半中」；
 *   ② 值为空串 —— 界面直接空白；
 *   ③ 占位符不一致 —— zh 写「已保存：{p}」、en 写 "Saved: {path}"，
 *      插值后 en 那份留着字面 {p}。
 * 本文件用真实 DICT（new Function 加载 js/i18n.js）逐键比对，
 * 三个不变量一起锁 —— 任何一类回归都会红。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');

function loadDict() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'i18n.js'), 'utf8');
  /* 【为什么用 new Function 而不是 vm/require】
   * js/i18n.js 是浏览器 IIFE，引用 document.documentElement（setLang 里写 lang）。
   * require 会因没有 window/document 直接挂；vm 也要先造整个环境。
   * new Function 传入最小的 window/document 假体即可加载 DICT ——
   * 我们只取数据，不调 setLang。 */
  const fakeWindow = { document: { documentElement: { lang: '', dataset: {} } } };
  const fn = new Function('window', 'document', src + '\nreturn window.i18n;');
  const i18n = fn(fakeWindow, fakeWindow.document);
  const DICT = i18n.DICT;
  assert.ok(DICT && DICT.zh && DICT.en, 'DICT 结构异常（加载方式失效，这条测试会空转）');
  return DICT;
}

t('I18N1 zh/en 键集合完全对齐', () => {
  const { zh, en } = loadDict();
  /* 锁的是：新增外壳文案只补了 zh 没补 en（或反过来）——
   * 那一侧界面出现键名或残留中文。 */
  const onlyZh = Object.keys(zh).filter((k) => !(k in en));
  const onlyEn = Object.keys(en).filter((k) => !(k in zh));
  assert.deepStrictEqual(onlyZh, [], 'zh 有而 en 无的键: ' + onlyZh.join(', '));
  assert.deepStrictEqual(onlyEn, [], 'en 有而 zh 无的键: ' + onlyEn.join(', '));
  /* 锁的是：字典被清空/加载方式坏掉导致扫描空转。 */
  assert.ok(Object.keys(zh).length > 100, 'zh 只有 ' + Object.keys(zh).length + ' 键，扫描疑似失效');
});

t('I18N2 两侧值都非空', () => {
  const { zh, en } = loadDict();
  for (const side of ['zh', 'en']) {
    const d = side === 'zh' ? zh : en;
    const empty = Object.keys(d).filter((k) => !String(d[k] || '').trim());
    /* 锁的是：值是空串 —— 界面那一块直接空白，比键名更难排查。 */
    assert.deepStrictEqual(empty, [], side + ' 里的空值键: ' + empty.join(', '));
  }
});

t('I18N3 插值占位符两侧一致', () => {
  const { zh, en } = loadDict();
  const PLACE = /\{(\w+)\}/g;
  const mism = [];
  for (const k of Object.keys(zh)) {
    if (!(k in en)) continue;
    const z = new Set([...String(zh[k]).matchAll(PLACE)].map((m) => m[1]));
    const e = new Set([...String(en[k]).matchAll(PLACE)].map((m) => m[1]));
    const diff = [...z].filter((x) => !e.has(x)).concat([...e].filter((x) => !z.has(x)));
    if (diff.length) mism.push(k + '（' + diff.join(',') + '）');
  }
  /* 锁的是：占位符名字两侧不同 —— 插值后一侧留着字面 {p}，
   * 或把调用方的 vars 值漏掉。 */
  assert.deepStrictEqual(mism, [], '占位符不一致的键: ' + mism.join(', '));
});

done();
