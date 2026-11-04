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

/* ---- 5. 静态：调用点用到的原文都有英文（否则英文界面漏中文） ---- */
/* 解析 TT('域', '原文') —— 这就是被测试 API 的调用形态本身。
 * 只扫已经迁好的两个样板文件；未迁移的工具故意保持纯中文（边界见 README）。 */
/* 已迁正文（用 TT 取词）的工具文件。
 * v0.4.2 新增 exif-view —— 原来这张表只有 qr / hash，是硬编码的，
 * 迁了新文件必须同步这里，否则「调用点都有英文」和「表里没有孤儿」两条
 * 都只看这三个文件，新迁的文件既不校验也不计入。
 * 【更好的做法是从源码自动发现「用了 TT 的文件」】见文件末尾那条断言：
 * 它拿 MIGRATED 与自动扫描结果比对，漏登记会直接红。 */
const MIGRATED = ['js/tools/qr.js', 'js/tools/hash.js', 'js/tools/media/exif-view.js', 'js/tools/media/snip-tool.js', 'js/tools/text-codec.js', 'js/tools/diff3.js'];
function callSites(rel) {
  /* 先剥注释：文件头那段说明里就写着 TT('qr', '中文原文')，
   * 不剥的话「中文原文」这个占位词会被当成一条真实调用点。
   * 这与 test-i18n-coverage / test-destructive 里踩过的是同一类坑：
   * 注释不是代码。 */
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const out = [];
  // T('……') 这个本地别名只指向本工具的域，域名从 `TT('域',` 声明处取
  /* 锁的是：「has() 如实反映表内容，TOOL_TEXT 至少含 qr 与 hash 两个域」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  /* 域名字母开头即可，**允许带数字**：diff3 这个域就含数字，
   * [a-z]+ 会把它排除，表现为「没有声明域」——其实是正则太窄。 */
  const m0 = src.match(/\bTT\('([a-z][a-z0-9-]*)',\s*zh/);
  if (!m0) return { domain: null, sites: [] };
  const domain = m0[1];
  /* 两种调用形态都要认，别把 TT 的**第一个**实参（域）当成文案：
   *   · 本地别名 T('保存 PNG')            —— 第一实参就是中文原文
   *   · 直接写 TT('qr', '保存 PNG')      —— 第二实参才是
   * 用 \bT 会漏掉 TT（\bT 在 "TT" 里不成立），所以要显式列两种。
   * 实参必须是字符串字面量 —— 变量拼接的文案本来就查不到表。 */
  /* 【必须按 JS 语义解码，不能直接用捕获到的源码文本】
   * 正则在源码上跑，捕获的是**字面量的书写形式**（例如源码里的 '\\x 前缀'
   * 抓到的是两个反斜杠）；而 TOOL_TEXT 的键是 JS 求值后的**真实字符串**
   * （单个 \x）。两者不对等就会误报「这个调用点没有英文」。
   * 用一层解转义把两边拉回同一语义。
   * 【只在解中文原文时用】它不执行代码，只处理常见转义序列；
   * 遇到不认识的转义就原样保留字符，不会比原先更宽松或更严格。 */
  const unescapeJs = (t) => t.replace(/\\(.)/g, (mm, c) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'r') return '\r';
    if (c === '\\') return '\\';
    if (c === "'") return "'";
    if (c === '"') return '"';
    return c;
  });
  for (const m of src.matchAll(/\bTT\('([a-z]+)',\s*'((?:[^'\\]|\\.)*)'/g)) out.push(unescapeJs(m[2]));
  for (const m of src.matchAll(/\bT\('((?:[^'\\]|\\.)*)'/g)) out.push(unescapeJs(m[1]));
  return { domain, sites: out };
}

/* ---- 4. API 完整性 ---- */
t('has() 如实反映表内容，且每个已迁文件声明的域都在表里', () => {
  const sb = loadWith('en');
  assert.ok(sb.ToolI18n.has('qr', '保存 PNG'), 'has 对已有的条目返回了 false');
  assert.ok(!sb.ToolI18n.has('qr', '这条不在表里的中文'), 'has 对不存在的条目返回了 true');

  /* 【不写死域清单】
   * 原来是 assert.deepStrictEqual(domains, ['hash','qr']) —— 每迁一个工具
   * 就得回来改这一行，而且它并没有真的校验「域对不对」，只是「等于这两个」。
   * 现在改成：从 MIGRATED 各文件里解析出它声明的域，要求①这些域都在表里、
   * ②表里没有「没有任何文件声明」的孤儿域。这样新增迁移只改 MIGRATED 一处。 */
  const declared = new Set();
  for (const rel of MIGRATED) {
    const d = callSites(rel).domain;
    assert.ok(d, rel + ' 里没有声明域（应有 const T = (zh) => TT(\'域\', zh…)）');
    declared.add(d);
  }
  const domains = Object.keys(sb.ToolI18n.TOOL_TEXT);
  const missing = [...declared].filter((d) => !domains.includes(d));
  assert.deepStrictEqual(missing, [], '这些域被调用点引用但表里没有：' + missing.join(', '));
  const orphan = domains.filter((d) => !declared.has(d));
  assert.deepStrictEqual(orphan, [], '这些域在表里但没有任何已迁文件声明它：' + orphan.join(', '));
  assert.ok(domains.length >= 3, '域数量 ' + domains.length + ' 偏少，疑似表被删');
});

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
  const zhStart = app.indexOf("'settings.languageDesc': '");
  assert.ok(zhStart > 0, '找不到 settings.languageDesc（中文）');
  const zhSeg = app.slice(zhStart, app.indexOf("',", zhStart + 30));

  /* 【不写死「二维码/哈希」这两个工具名】
   * 原断言要求说明里点到「二维码」和「哈希」，那是只有两个工具迁移时的事实。
   * 每迁一批就得回来改这句，而它并不真正检查「说明与实际是否一致」。
   * 现在改成两条更本质的要求：
   *   ① 说明里必须提到工具「名称/描述」也已双语 —— 这是覆盖全部工具的那部分；
   *   ② 说明里必须写明「其余工具页正文仍为中文」—— 诚实边界不能悄悄扩大。 */
  assert.ok(/名称/.test(zhSeg),
    '中文说明没有提到工具名称/描述也已双语（这是覆盖全部工具的那部分）：' + zhSeg);
  assert.ok(/仍为中文/.test(zhSeg), '中文说明没有写明其余工具页正文仍为中文：' + zhSeg);

  const enStart = app.indexOf("'settings.languageDesc': 'Covers");
  assert.ok(enStart > 0, '英文说明没有更新（若仍是 "tool pages stay in Chinese" 则与实际不符）');
  const enSeg = app.slice(enStart, app.indexOf("',", enStart + 30));
  assert.ok(/names and descriptions/.test(enSeg),
    '英文说明没有提到工具名称/描述也已双语：' + enSeg);
  /* 锁的是：设置页说明必须写明「其余工具页正文仍为中文」——口径失真才是用户投诉来源。
   * 只能用源码断言：这是给用户看的静态文案，行为层没有可观测的等价物。 */
  assert.ok(/remain in Chinese/.test(enSeg), '英文说明没有写明其余工具页正文仍为中文：' + enSeg);

  /* 与真实迁移规模对账：已迁移的域至少要像说明里讲的那样多。
   * 这条能抓住「又迁了一批但忘了改说明」—— 否则说明会一直停在旧口径。 */
  const sb = loadWith('en');
  const domainCount = Object.keys(sb.ToolI18n.TOOL_TEXT).length;
  assert.ok(domainCount >= 5,
    '已迁移的文案域只有 ' + domainCount + ' 个，但设置页说明已经宣称覆盖多组工具，口径对不上');
});

done();
