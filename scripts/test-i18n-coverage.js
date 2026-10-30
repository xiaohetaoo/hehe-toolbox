'use strict';
/* 英文界面的设置页不能有中文残留（P1-2 的回归测试）。
 *
 * 做法：不启动 Electron，直接分析 js/app.js 的源文本——
 * 在设置区各绘制函数里，找出所有「会被当作界面文案」的中文字面量。
 * 注释与 console 日志不算（用户看不到），所以先剥注释、再排除日志实参。
 *
 * 为什么用静态分析而不是端到端：端到端要起窗口、切语言、读五个分区，
 * 在 CI 的 headless 环境里 getBoundingClientRect 都可能是 0×0；
 * 而这个问题本质是「源码里还有硬编码中文字面量」，静态检查更准也更稳。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'js', 'app.js');
const I18N = path.join(__dirname, '..', 'js', 'i18n.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/* 逐字符扫描：跳过注释与字符串，只在代码区做括号配平。
 * 直接对全文数 {} 会被字符串里的 '{' 带偏（本文件里就有 h('div', {…})）。 */
function scan(src, from) {
  let i = from;
  let depth = 0;
  let started = false;
  while (i < src.length) {
    const c = src[i];
    // 行注释
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    // 字符串 / 模板字符串
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '{') { depth++; started = true; }
    else if (c === '}') {
      depth--;
      if (started && depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/* 取出函数源码段（含函数体）；用词法扫描配平，不会被字符串干扰 */
function functionBody(src, name) {
  // 支持 `function name(` 与 `async function name(`
  let start = src.indexOf('function ' + name + '(');
  if (start === -1) start = src.indexOf('function ' + name + ' (');
  if (start === -1) throw new Error('找不到函数 ' + name);
  const open = src.indexOf('{', start);
  if (open === -1) throw new Error('函数 ' + name + ' 没有函数体');
  const end = scan(src, open);
  if (end === -1) throw new Error('函数 ' + name + ' 括号不配平');
  return src.slice(start, end);
}

/* 收集字符串字面量；带上它们在源码中的位置，便于按上下文排除 */
function stringLiterals(body) {
  const out = [];
  // '...' 与 "..."
  for (const m of body.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
    out.push({ text: m[1] != null ? m[1] : m[2], index: m.index });
  }
  // `...` 模板字符串：去掉 ${…} 之后剩下的静态文本
  for (const m of body.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    out.push({ text: m[1].replace(/\$\{[\s\S]*?\}/g, ''), index: m.index });
  }
  return out;
}

/* 判断一个字面量是否属于 console.* 调用（用户看不到，不该算界面文案） */
function isLogArgument(body, index) {
  const before = body.slice(Math.max(0, index - 400), index);
  const m = before.match(/console\.(log|warn|error|info|debug)[^;]{0,300}$/s);
  return !!m;
}

const raw = fs.readFileSync(APP, 'utf8');

/* ---- 1. 设置区（含高危提示卡）不得有中文界面文案 ---- */
const SETTINGS_FNS = [
  'renderSettings', 'drawGeneral', 'drawAppearance', 'drawDanger', 'drawData', 'drawAbout',
  'dangerLockedCard', 'dangerNoticeCard',
];

/* 这些中文是**故意**保留的：语言下拉里的「简体中文」是原生名称，
 * 任何界面语言下都必须原样显示（否则英文用户根本认不出哪个是中文）。 */
const ALLOWED_LITERALS = new Set(['简体中文']);

t('设置区各绘制函数里没有硬编码中文文案', () => {
  const offenders = [];
  for (const fn of SETTINGS_FNS) {
    const body = functionBody(raw, fn);
    for (const lit of stringLiterals(body)) {
      if (!CJK.test(lit.text)) continue;
      if (ALLOWED_LITERALS.has(lit.text)) continue;
      if (isLogArgument(body, lit.index)) continue;
      offenders.push(fn + ': ' + JSON.stringify(lit.text.slice(0, 60)));
    }
  }
  assert.deepStrictEqual(offenders, [], '仍有中文文案：\n  ' + offenders.join('\n  '));
});

/* ---- 2. 两套字典键集合一致（补英文时不能只补一边） ---- */
t('i18n 中英字典的键集合完全一致', () => {
  const isrc = fs.readFileSync(I18N, 'utf8');
  const zh = isrc.slice(isrc.indexOf('zh: {'), isrc.indexOf('en: {'));
  const en = isrc.slice(isrc.indexOf('en: {'));
  const zk = [...zh.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
  const ek = [...en.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
  assert.deepStrictEqual(zk.filter((k) => ek.indexOf(k) === -1), [], '英文缺这些键');
  assert.deepStrictEqual(ek.filter((k) => zk.indexOf(k) === -1), [], '中文缺这些键');
  assert.deepStrictEqual(zk.filter((k, i) => zk.indexOf(k) !== i), [], '中文有重复键');
});

/* ---- 3. 设置区里用到的每个 T('...') 键都必须存在于字典中 ---- */
t('设置区引用的 i18n 键全部存在', () => {
  const isrc = fs.readFileSync(I18N, 'utf8');
  const zh = isrc.slice(isrc.indexOf('zh: {'), isrc.indexOf('en: {'));
  const known = new Set([...zh.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));

  const used = new Set();
  for (const fn of SETTINGS_FNS) {
    const body = functionBody(raw, fn);
    for (const m of body.matchAll(/T\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  }
  // 形如 T('settings.langSwitched.' + x) 是前缀拼接，单独校验它的展开值
  const missing = [...used].filter((k) => {
    if (known.has(k)) return false;
    if (k.endsWith('.')) {   // 前缀拼接：要求 known 里有以它开头的键
      return ![...known].some((x) => x.startsWith(k));
    }
    return true;
  });
  assert.deepStrictEqual(missing, [], '这些键在字典里不存在：' + missing.join(', '));
  assert.ok(used.size > 20, '设置区应当引用相当数量的键，实际只有 ' + used.size);
});

/* ---- 4. 英文字典里不能有中文（漏翻会直接暴露） ---- */
t('英文字典的值里没有中文字符', () => {
  const isrc = fs.readFileSync(I18N, 'utf8');
  const en = isrc.slice(isrc.indexOf('en: {'));
  const offenders = [];
  for (const m of en.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)'/gm)) {
    if (CJK.test(m[2])) offenders.push(m[1] + ': ' + m[2].slice(0, 50));
  }
  assert.deepStrictEqual(offenders, [], '英文值里还有中文：\n  ' + offenders.join('\n  '));
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
