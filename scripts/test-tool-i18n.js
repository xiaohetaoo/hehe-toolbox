'use strict';
const { t, done } = require('./lib/harness');
/* 任务 4（选 B）：工具页 i18n 机制的行为测试。
 *
 * 【为什么这些必须是行为测试】
 * 这个机制的核心承诺有两条，而且都是"跑起来才知道"的：
 *   1) **中文下零行为改动** —— 中文模式 TT 直接返回调用点字面量、不查表。
 *      如果哪天真变成了"查表再返回"，中文界面就可能因为表里漏写而变样。
 *      这条只能用一个"表里故意没有这条"的输入来验证。
 *   2) **英文漏翻回退中文** —— 宁可看到一条中文，也不要空白/undefined/键名。
 *      同样只能靠"喂一个表里没有的键"来验证。
 * 静态扫源码只能证明"调用了 TT"，证明不了这两条。
 *
 * 【还额外扫了两条静态事实】
 *   a) 调用点用到的每一条中文原文都在英文表里（否则英文界面会漏一条中文）；
 *   b) 英文表里没有用不到的孤儿条目（否则有人删了调用点、表里留垃圾）。
 * 这两条不是"版面匹配"：它们解析的是 TT('域', '原文') 这个**调用形态**，
 * 而这个形态本身就是被测试的 API 契约（改了形态等于改了 API，本就该红）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripComments } = require('../lib/src-scan');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'tools', 'i18n.js'), 'utf8');

/* 在沙箱里跑一遍真实现，注入一个可切换语言的 i18n 桩。
 * 这样测的是**同一份源码**，不是它的副本。 */
function loadWith(lang) {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.i18n = { lang };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}

/* ---- 1. 中文模式必须原样返回字面量（零行为改动） ---- */
t('中文模式：返回调用点字面量本身，不查表', () => {
  const sb = loadWith('zh');
  assert.strictEqual(typeof sb.TT, 'function', '没有挂全局 TT');
  // 表里有的
  assert.strictEqual(sb.TT('qr', '保存 PNG'), '保存 PNG', '中文模式被翻译了');
  // 表里**故意没有**的：若实现是"查表 + 回退"，这里也会返回原文；
  // 但真正的风险是有人把中文也存进表里、再靠表返回 —— 那样表一改中文就变。
  // 所以额外断言：中文返回值不受表内容影响。
  assert.strictEqual(sb.TT('qr', '这条不在表里的中文'), '这条不在表里的中文');
  assert.strictEqual(sb.TT('不存在的域', '随便什么'), '随便什么');
});

/* ---- 2. 英文模式查表，漏翻回退中文 ---- */
t('英文模式：表里有的给英文，表里没有的回退中文（不是空白/键名）', () => {
  const sb = loadWith('en');
  assert.strictEqual(sb.TT('qr', '保存 PNG'), 'Save PNG');
  assert.strictEqual(sb.TT('hash', '文件校验'), 'File');
  const miss = sb.TT('qr', '这条不在表里的中文');
  assert.strictEqual(miss, '这条不在表里的中文', '漏翻没有回退中文，实际得到：' + JSON.stringify(miss));
  assert.ok(miss && miss !== 'undefined', '漏翻回退成了 undefined');
});

/* ---- 3. 插值 ---- */
t('插值：{p} 在两种语言下都被替换，缺失变量时保留占位符', () => {
  const zh = loadWith('zh');
  assert.strictEqual(zh.TT('qr', '已保存：{p}', { p: 'D:/a.png' }), '已保存：D:/a.png');
  const en = loadWith('en');
  assert.strictEqual(en.TT('qr', '已保存：{p}', { p: 'D:/a.png' }), 'Saved: D:/a.png');
  // 变量没传：保留 {p}，不出现 undefined
  assert.strictEqual(en.TT('qr', '已保存：{p}'), 'Saved: {p}');
  assert.strictEqual(en.TT('hash', '计算失败: {e}', { e: 'EACCES' }), 'Failed: EACCES');
});

/* ---- 4. API 完整性 ---- */
t('has() 如实反映表内容，TOOL_TEXT 至少含 qr 与 hash 两个域', () => {
  const sb = loadWith('en');
  assert.ok(sb.ToolI18n.has('qr', '保存 PNG'), 'has 对已有的条目返回了 false');
  assert.ok(!sb.ToolI18n.has('qr', '这条不在表里的中文'), 'has 对不存在的条目返回了 true');
  const domains = Object.keys(sb.ToolI18n.TOOL_TEXT).sort();
  assert.deepStrictEqual(domains, ['hash', 'qr'], '已迁移的域应为 qr 与 hash，实际：' + domains.join(', '));
});

/* ---- 5. 静态：调用点用到的原文都有英文（否则英文界面漏中文） ---- */
/* 解析 TT('域', '原文') —— 这就是被测试 API 的调用形态本身。
 * 只扫已经迁好的两个样板文件；未迁移的工具故意保持纯中文（边界见 README）。 */
const MIGRATED = ['js/tools/qr.js', 'js/tools/hash.js'];
function callSites(rel) {
  /* 先剥注释：文件头那段说明里就写着 TT('qr', '中文原文')，
   * 不剥的话「中文原文」这个占位词会被当成一条真实调用点。
   * 这与 test-i18n-coverage / test-destructive 里踩过的是同一类坑：
   * 注释不是代码。 */
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const out = [];
  // T('……') 这个本地别名只指向本工具的域，域名从 `TT('域',` 声明处取
  const m0 = src.match(/TT\('([a-z]+)',\s*zh/);
  if (!m0) return { domain: null, sites: [] };
  const domain = m0[1];
  /* 两种调用形态都要认，别把 TT 的**第一个**实参（域）当成文案：
   *   · 本地别名 T('保存 PNG')            —— 第一实参就是中文原文
   *   · 直接写 TT('qr', '保存 PNG')      —— 第二实参才是
   * 用 \bT 会漏掉 TT（\bT 在 "TT" 里不成立），所以要显式列两种。
   * 实参必须是字符串字面量 —— 变量拼接的文案本来就查不到表。 */
  for (const m of src.matchAll(/\bTT\('([a-z]+)',\s*'((?:[^'\\]|\\.)*)'/g)) out.push(m[2]);
  for (const m of src.matchAll(/\bT\('((?:[^'\\]|\\.)*)'/g)) out.push(m[1]);
  return { domain, sites: out };
}

t('已迁移的每个调用点原文都在英文表里', () => {
  const sb = loadWith('en');
  const missing = [];
  for (const rel of MIGRATED) {
    const { domain, sites } = callSites(rel);
    assert.ok(domain, rel + ' 里没有找到 TT(\'域\', zh) 声明');
    for (const zh of sites) {
      if (!sb.ToolI18n.has(domain, zh)) missing.push(rel + ' → ' + domain + ' → ' + zh);
    }
  }
  assert.deepStrictEqual(missing, [],
    '这些调用点在英文模式下会漏成中文（补进 js/tools/i18n.js）：\n  ' + missing.join('\n  '));
});

/* ---- 6. 静态：没有孤儿条目 ---- */
t('英文表里没有用不到的孤儿条目', () => {
  const sb = loadWith('en');
  const used = {};
  for (const rel of MIGRATED) {
    const { domain, sites } = callSites(rel);
    if (!domain) continue;
    used[domain] = used[domain] || new Set();
    for (const zh of sites) used[domain].add(zh);
  }
  const orphans = [];
  for (const [domain, dict] of Object.entries(sb.ToolI18n.TOOL_TEXT)) {
    const set = used[domain] || new Set();
    for (const zh of Object.keys(dict)) {
      if (!set.has(zh)) orphans.push(domain + ' → ' + zh);
    }
  }
  assert.deepStrictEqual(orphans, [],
    '这些英文条目没有任何调用点在用（删掉，或把调用点补上）：\n  ' + orphans.join('\n  '));
});

/* ---- 7. 加载顺序：index.html 必须在工具文件之前引入 ---- */
t('index.html 在 js/tools/*.js 之前引入 js/tools/i18n.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const at = html.indexOf('js/tools/i18n.js');
  assert.ok(at > 0, 'index.html 没有引入 js/tools/i18n.js');
  for (const f of ['js/tools/qr.js', 'js/tools/hash.js']) {
    const i = html.indexOf(f);
    assert.ok(i > at, f + ' 在 i18n.js 之前加载 —— 它定义时就引用全局 TT，会直接 ReferenceError');
  }
});

/* ---- 8. 设置页与 README 的说法必须一致（诚实边界） ---- */
t('设置页语言说明与实际已迁移范围一致', () => {
  const app = fs.readFileSync(path.join(ROOT, 'js', 'i18n.js'), 'utf8');
  // 中文说明里必须点到这两个工具，否则用户会以为全站已双语
  const i = app.indexOf("'settings.languageDesc': '");
  assert.ok(i > 0, '找不到 settings.languageDesc');
  const seg = app.slice(i, app.indexOf("',", i + 30));
  assert.ok(/二维码/.test(seg) && /哈希/.test(seg),
    '中文说明没有点到已迁移的二维码/哈希两个工具：' + seg);
  assert.ok(/仍为中文/.test(seg), '中文说明没有写明其余工具页仍为中文：' + seg);
  // 英文说明同理
  const j = app.indexOf("'settings.languageDesc': 'Covers");
  assert.ok(j > 0, '英文说明没有更新（仍是 "tool pages stay in Chinese" 的话与实际不符）');
  const segEn = app.slice(j, app.indexOf("',", j + 30));
  assert.ok(/QR/.test(segEn) && /hash/.test(segEn), '英文说明没有点到已迁移范围：' + segEn);
  assert.ok(/remain in Chinese/.test(segEn), '英文说明没有写明其余工具页仍为中文：' + segEn);
});

done();
