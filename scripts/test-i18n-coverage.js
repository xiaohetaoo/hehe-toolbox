'use strict';
const { t, done, readMain } = require('./lib/harness');
const mainSrc = readMain({ raw: true });
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
/* 读项目内文件（原 test-round10 的 local 助手，迁移后并入这里）。 */
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'js', 'app.js');
const I18N = path.join(__dirname, '..', 'js', 'i18n.js');

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/* 逐字符扫描：跳过注释与字符串，只在代码区做括号配平。
 * 直接对全文数 {} 会被字符串里的 '{' 带偏（本文件里就有 h('div', {…})）。 */
function scan(src, from) {  let i = from;
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

/* 判断当前位置的 `/` 是否应当按正则字面量处理。
 * 看 out（已经输出、即剥过注释的代码前缀）里最近一个有效 token： */
/* 【剥注释与正则识别统一到 lib/src-scan.js】
 * 这里有三个测试脚本都要「剥掉注释再断言」，早期各自实现了一份：
 * 一个地方修了正则识别，另一处的旧实现还在朴素扫描，行为不一致。
 * 更要命的是「抽取函数」这个动作本身也要跳正则字面量
 * （regexAllowed 内部就有 /[a-zA-Z0-9_$])}]/，朴素配平会被那个 } 带偏）。
 * 集中到 lib/src-scan.js 后谁 require 谁一致。 */
const { stripComments, regexAllowed } = require(path.join(ROOT, 'lib', 'src-scan'));

/* 收集字符串字面量；带上它们在源码中的位置，便于按上下文排除
 *
 * 入参一律先剥注释：注释里用引号提到的界面文案不是硬编码文案。
 * （剥完位置会与原文偏移，但调用方只用它配合 body 做 console.* 判断，
 *   而这个 body 现在也是剥过注释的，两边一致。） */
function stringLiterals(rawBody) {
  const body = stripComments(rawBody);
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
    /* 剥注释一次，两处共用同一份文本：
     * stringLiterals() 内部会剥注释，它返回的 index 是**剥注释后文本**的偏移。
     * 若把原始 body 传给 isLogArgument，偏移就对不上，console.* 判断会判错。
     * （原来两边都用原始 body，所以注释里的引号能被当成字面量 —— 那正是要修的 bug。） */
    const body = stripComments(functionBody(raw, fn));
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

/* ---- 5. 配色主题：9 套的 name/desc 都必须双语 ---- */
t('九套配色主题的 name/desc 都有中英键', () => {
  const isrc = fs.readFileSync(I18N, 'utf8');
  const zh = isrc.slice(isrc.indexOf('zh: {'), isrc.indexOf('en: {'));
  const known = new Set([...zh.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
  const IDS = ['polar', 'mist', 'jade', 'violet', 'rose', 'gold', 'teal', 'sand', 'mono'];
  const missing = [];
  for (const id of IDS) {
    for (const f of ['name', 'desc']) {
      const k = 'accent.' + id + '.' + f;
      if (!known.has(k)) missing.push(k);
    }
  }
  assert.deepStrictEqual(missing, [], '缺配色词条：' + missing.join(', '));
  // app.js 里不能再有写死的配色名
  const offenders = [];
  for (const name of ['极地白', '雾霭蓝', '苔原绿', '紫罗兰', '樱花粉', '鎏金', '青碧', '暖砂', '纯黑白']) {
  /* 锁的是：「九套配色主题的 name/desc 都有中英键」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    if (new RegExp("name: '" + name + "'").test(fs.readFileSync(APP, 'utf8'))) {
      offenders.push(name);
    }
  }
  assert.deepStrictEqual(offenders, [], '配色名仍写死在 app.js：' + offenders.join(', '));
});

/* ---- 6. 模块描述必须双语（descEn 齐全） ---- */
t('10 个模块都有 descEn', () => {
  const rsrc = fs.readFileSync(path.join(ROOT, 'js', 'registry.js'), 'utf8');
  const mods = [...rsrc.matchAll(/\{ id: '(\w+)'[^}]*?desc: '[^']*'(?:, descEn: '([^']*)')?/g)];
  const missing = [];
  for (const m of mods) {
    if (!m[2]) missing.push(m[1]);
  }
  // intro 之类的非模块行会被正则带上，只关心已知的 10 个 id
  const IDS = ['system', 'file', 'text', 'net', 'dev', 'media', 'office', 'security', 'launch', 'life'];
  const realMissing = missing.filter((id) => IDS.indexOf(id) !== -1);
  assert.deepStrictEqual(realMissing, [], '这些模块缺 descEn：' + realMissing.join(', '));
  assert.ok(/function modDesc/.test(rsrc), '没有 modDesc 取值函数');
  assert.ok(/modDesc/.test(rsrc.slice(rsrc.indexOf('window.Registry'))), 'modDesc 没有导出');
});

/* ---- 7. ui.js 的公共默认文案要能跟随语言 ---- */
t('ui.js 的默认文案走 i18n 而不是写死中文', () => {
  const usrc = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
  const offenders = [];
  /* 这几个以前是**参数默认值**里的中文字面量：参数默认值在函数定义时
   * 就求值了，切语言后不会跟着变，所以必须挪到函数体里用 TT() 取。 */
  for (const pat of ["title = '确认操作'", "okText = '确定'", "cancelText = '取消'", "empty = '暂无数据'"]) {
    if (usrc.indexOf(pat) !== -1) offenders.push(pat);
  }
  assert.deepStrictEqual(offenders, [], '仍有写死的默认文案：' + offenders.join(', '));
  // 必须通过 TT() 取词
  for (const [k, label] of [['dialog.ok', 'confirmBox'], ['dialog.cancel', 'confirmBox'],
                            ['table.empty', 'renderTable'], ['unit.sec', 'fmtTime']]) {
    assert.ok(new RegExp("TT\\('" + k + "'").test(usrc), label + ' 没走 TT(' + k + ')');
  }
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

/* ---- 5. stripComments 自身的行为（用合成输入，不依赖仓库现状） ----
 *
 * 【为什么要单独测这个函数】
 * 上一节（设置区硬编码中文）现在能过，但**不能反过来证明 stripComments 有效**：
 * app.js 里那两个触发点已经顺手改成中文引号了，就算把 stripComments 整个
 * 退回 rawBody，那一节照样全绿 —— 我实测过，确实是绿的。
 * 也就是说那条断言在当前代码下没有能力变红，它只是"恰好没坏"。
 * 所以这里用**人造输入**直接测这个函数：注释里的引号必须被剥掉，
 * 字符串里的 // 必须保留。这两条任一失效都会翻红，不受仓库现状影响。
 */
t('stripComments：注释里用引号提到的文案不算字符串字面量', () => {
  const src = [
    'function drawAbout() {',
    "  // 这里注释写着\"变量为空\"这种说法",
    "  /* 块注释里的\"失败路径也要退订\"同样是注释 */",
    "  const real = '真正的文案';",
    '  return real;',
    '}',
  ].join('\n');
  const stripped = stripComments(src);
  // 注释内容必须消失
  assert.ok(!stripped.includes('变量为空'), '行注释没被剥掉');
  assert.ok(!stripped.includes('失败路径也要退订'), '块注释没被剥掉');
  // 真字符串必须保留
  assert.ok(stripped.includes('真正的文案'), '把真字符串也剥掉了');
  // 剥完再做字面量提取，注释里的引号不该被识别出来
  const lits = stringLiterals(stripped).map((x) => x.text);
  assert.deepStrictEqual(lits, ['真正的文案'],
    '注释里的引号被当成了字面量：' + JSON.stringify(lits));
});

t('stripComments：字符串里的 // 与 /* 不能被当成注释起点', () => {
  const src = "const u = 'http://a/b'; const v = 'x/*not-a-comment*/y';";
  const stripped = stripComments(src);
  assert.ok(stripped.includes('http://a/b'), "字符串里的 // 被截断了：" + stripped);
  assert.ok(stripped.includes('x/*not-a-comment*/y'), "字符串里的 /* 被截断了：" + stripped);
  const lits = stringLiterals(stripped).map((x) => x.text);
  assert.deepStrictEqual(lits, ['http://a/b', 'x/*not-a-comment*/y'],
    '剥注释破坏了字符串内容：' + JSON.stringify(lits));
});

t('stripComments：块注释不会把前后两段代码粘连', () => {
  const stripped = stripComments('return a/*c*/b;');
  assert.ok(/return a[ \t]b;/.test(stripped) || /return a b;/.test(stripped),
    '块注释处没有分隔，a 和 b 被粘成了一个标识符：' + JSON.stringify(stripped));
  assert.ok(!/return ab;/.test(stripped), 'a/*c*/b 被粘成了 ab');
});

/* 【2026-11 补：剥完的文本必须与原文本**行号一一对应**】
 *
 * 现象：stripComments 原先把整段块注释替换成**一个空格**（`out += ' '`），
 * 块注释内部的换行全部丢失。一个 40 行的文件头注释就能让后续每一行
 * 上移 39 行。实测 main.js 剥完少 400+ 行，scripts 里 28 个脚本的行号
 * 全部对不上 —— 而剥注释的**唯一目的**就是在同一份文本上做断言，
 * 一旦行号错位，所有以行号定位的能力（基线压制、白名单按行号索引、
 * CI annotation 指到出错行）都静默失效，且不会报任何错。
 *
 * 为什么用逐行比对而不是只比行数：要保证的是「第 N 行在两份文本里说的
 * 是同一件事」。只比总数能抓到这个缺陷，但抓不到「行数凑巧相等、内容却
 * 错位」的情形。
 *
 * 锁的是：stripComments 吞掉块注释内换行导致的行号漂移（2026-11 修复）。 */
t('stripComments：保留块注释内部的换行（行号必须与原文一一对应）', () => {
  const src = [
    'const a = 1;',
    '/* 第一行说明',
    ' * 第二行说明',
    ' * 第三行说明',
    ' */',
    'const b = 2; // 尾注释',
    'const c = 3;',
  ].join('\n');
  const stripped = stripComments(src);
  const srcLines = src.split('\n');
  const outLines = stripped.split('\n');
  assert.strictEqual(outLines.length, srcLines.length,
    '剥注释后行数变了：原 ' + srcLines.length + ' 行 → ' + outLines.length + ' 行。'
    + '块注释里的换行必须保留，否则行号全部错位。实际输出：' + JSON.stringify(outLines));
  assert.strictEqual(outLines[0].trim(), 'const a = 1;', '第 1 行对不上：' + JSON.stringify(outLines[0]));
  assert.strictEqual(outLines[5].trim(), 'const b = 2;',
    '第 6 行对不上（尾注释应被剥掉但本行必须还在）：' + JSON.stringify(outLines[5]));
  assert.strictEqual(outLines[6].trim(), 'const c = 3;', '第 7 行对不上：' + JSON.stringify(outLines[6]));
  /* 不能为了保行号就把注释内容留下来 */
  assert.ok(!stripped.includes('第二行说明'), '块注释内容没被剥掉');
  assert.ok(!stripped.includes('尾注释'), '行注释内容没被剥掉');
});

/* 【这一条来自实战踩坑，必须留下】
 * 真实缺陷（是我自己写的测试代码里的缺陷）：
 * stripComments 不识别正则字面量，于是 js/tools/net-tools.js 里
 *   raw.replace(/[\x00-\x1f<>:"|?*]/g, '_')
 * 正则内部的这个双引号被当成字符串开头，一路吃到后面第 2907 个字符的
 * 另一个双引号上 —— 此后所有注释/字符串判断全部错位。
 * 表现是：明明存在块注释，剥完却还在；进而 i18n 的硬编码断言变成假绿
 * （它没报错，只是因为恰好没有触发点）。
 *
 * 这里用**真实文件**做输入，因为编造的简化样例不一定能复现这种状态错位。
 */
t('stripComments：正则字面量里的引号不能被当成字符串开头', () => {
  const netSrc = fs.readFileSync(path.join(ROOT, 'js', 'tools', 'net-tools.js'), 'utf8');
  const stripped = stripComments(netSrc);
  // 1) 该剥的注释必须真的被剥掉（这条在修复前是红的）
  assert.ok(!stripped.includes('必须按前缀认领'),
    '正则字面量里的引号把扫描状态带偏了：后续块注释没被剥掉');
  // 2) 正则字面量本身要原样保留（不能被当成注释或字符串删掉）
  assert.ok(stripped.includes('x00-'),
    '正则字面量被剥掉了（剥注释不能动代码）');
  // 3) 剥完还能正确提取字符串字面量（状态没乱）
  const lits = stringLiterals(stripped).map((x) => x.text);
  assert.ok(lits.includes('网速测试') || lits.includes('测速'),
    '剥注释后字面量提取异常，状态位错乱：前 10 个 = ' + JSON.stringify(lits.slice(0, 10)));
});

t('regexAllowed：除号与正则要能分开', () => {
  assert.strictEqual(regexAllowed('const x = '), true, '= 之后应当是正则');
  assert.strictEqual(regexAllowed('a '), false, '标识符之后应当是除号');
  assert.strictEqual(regexAllowed('return '), true, 'return 之后应当是正则');
  assert.strictEqual(regexAllowed('1 '), false, '数字之后应当是除号');
  assert.strictEqual(regexAllowed('fn() '), false, '右括号之后应当是除号');
  assert.strictEqual(regexAllowed('typeof '), true, 'typeof 之后应当是正则');
  assert.strictEqual(regexAllowed('a[0] '), false, '右方括号之后应当是除号');
  assert.strictEqual(regexAllowed('typeof x '), false, 'typeof 后跟标识符，再之后是除号');
});

t('DANGEROUS_CAPS 的名称/描述中英双语，且随语言切换', () => {
  const a = mainSrc.indexOf('const CAP_TEXT = {');
  const b = mainSrc.indexOf("handle('dangerous:list'");
  assert.ok(a > 0 && b > a, '找不到 CAP_TEXT 区块');
  const body = mainSrc.slice(a, b);
  const mk = new Function('let uiLang = "zh"; ' + body +
    ' return { caps: DANGEROUS_CAPS, ids: DANGEROUS_CAP_IDS, capText, setLang(l){ uiLang = l; } };');
  const m = mk();
  const IDS = ['file-delete', 'junk-clean', 'recycle-empty', 'process-kill', 'service-stop',
    'system-power', 'hosts-edit', 'registry-edit', 'dir-move', 'acl-repair'];
  assert.deepStrictEqual(m.ids, IDS, '能力清单的项或顺序变了（设置页顺序由它决定）');
  assert.strictEqual(m.caps['acl-repair'].name, '取得所有权 / 修复权限', 'zh 名称不对');
  m.setLang('en');
  const zhLeft = [];
  for (const id of IDS) {
    const c = m.caps[id];
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(c.name + c.desc)) zhLeft.push(id);
  }
  assert.deepStrictEqual(zhLeft, [], '英文界面下这些能力名/描述仍是中文：' + zhLeft.join(','));
  assert.strictEqual(m.caps['file-delete'].name, 'Delete files');
  m.setLang('zh');
  assert.strictEqual(m.caps['file-delete'].name, '删除文件', '切回中文要能复原');
});

t('门禁拒绝文案也是双语的', () => {
  const code = stripComments(mainSrc);
  assert.ok(/const GATE_TEXT = \{/.test(code), '没有 GATE_TEXT');
  assert.ok(/GATE_TEXT\[uiLang\]/.test(code), 'dangerousDenied 没有按语言取文案');
  assert.ok(/dangerousDenied\('system-power'\)/.test(code), '电源门禁也应走双语文案');
});

/* ================= ⑩ P4 批次 ================= */

t('用户可见文案里不再有 Markdown 星号', () => {
  const FILES = ['js/tools/lan-scan.js', 'js/tools/mojibake-fix.js', 'js/tools/disk-health.js',
    'js/tools/link-doctor.js', 'js/tools/dir-move.js', 'js/tools/acl-repair.js', 'lib/lan-scan.js'];
  const offenders = [];
  for (const rel of FILES) {
    /* 只看字符串字面量里的 **：注释里的 ** 是排版习惯，用户看不到 */
    const src = read(rel);
    const re = /'([^'\\]|\\.)*'/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[0].includes('**')) offenders.push(rel + ': ' + m[0].slice(0, 60));
    }
  }
  assert.deepStrictEqual(offenders, [], '这些文案会被原样显示星号：\n  ' + offenders.join('\n  '));
});

t('danger.text 的 {name} 真的被传进去了', () => {
  const app = read('js/app.js');
  assert.ok(/T\('danger\.text', \{ name: T\('danger\.category'\) \}\)/.test(app),
    'danger.text 仍未插值（界面上会显示「{name}」）');
  /* i18n.js 是浏览器脚本（引用 window），这里按源码检查两套字典都有键 */
  const i18n = read('js/i18n.js');
  const cats = i18n.match(/'danger\.category':/g) || [];
  assert.strictEqual(cats.length, 2, 'danger.category 必须在 zh / en 两套字典里都有，实际 ' + cats.length + ' 处');
  const texts = i18n.match(/'danger\.text':[^\n]*/g) || [];
  assert.strictEqual(texts.length, 2, 'danger.text 应有两条（zh/en）');
  for (const line of texts) {
    assert.ok(/\{name\}/.test(line), 'danger.text 应保留 {name} 占位符：' + line);
  }
});

done();
