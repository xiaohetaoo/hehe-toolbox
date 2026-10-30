/* 卡片顺序守卫：每个模块的展示顺序必须与 registry 里的 ORDER 表一致。
 *
 * 【为什么需要】
 * ORDER 表决定「哪个工具出现在第一行」，是纯手写的。手写表最容易出的错是
 * **漏登记**：新加一个工具忘了写进 ORDER，它就会排到列表最末尾 —— 不报错、
 * 不崩溃，只是永远没人看得到。这种问题在界面上完全看不出来，
 * 只有把「注册了什么」和「排在哪里」逐条比对才能发现。
 *
 * 本脚本同时校验两件事：
 *   1. ORDER 里不许有拼错的 id（写错了等于没写，还会让用户以为工具丢了）
 *   2. 每个已注册工具都必须出现在 ORDER 里（不接受「靠 MAX_SAFE_INTEGER 兜底」）
 *   3. ORDER 的排列要体现「相似工具相邻」——对同一组内的工具做前缀/关键词聚类检查
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* 从 registry.js 里抽出 ORDER 表。它是纯字面量，用正则读比在 VM 里跑更直接。 */
function readOrder() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'registry.js'), 'utf8');
  const start = src.indexOf('const ORDER = {');
  if (start < 0) throw new Error('registry.js 里找不到 ORDER 表');
  // 找到与之配对的收尾大括号
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('ORDER 表括号不配对');
  const body = src.slice(src.indexOf('{', start), end + 1);
  // eslint-disable-next-line no-new-func
  return new Function('return ' + body)();
}

/* 从各工具文件里收集注册的 id 与 module。 */
function readTools() {
  const dir = path.join(ROOT, 'js', 'tools');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const tools = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    const cm = s.match(/const MOD = '([^']+)'/);
    const re = /\{\s*\n?\s*id: '([^']+)',\s*name: '([^']+)',\s*module: ([^,]+),/g;
    let m;
    while ((m = re.exec(s))) {
      let mod = m[3].trim();
      if (mod === 'MOD' && cm) mod = cm[1];
      mod = mod.replace(/'/g, '');
      const near = s.slice(m.index, m.index + 500);
      const kw = near.match(/keywords: \[([^\]]*)\]/);
      tools.push({
        id: m[1],
        name: m[2],
        module: mod,
        keywords: kw ? kw[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean) : []
      });
    }
  }
  return tools;
}

const ORDER = readOrder();
const TOOLS = readTools();
const byId = new Map(TOOLS.map((t) => [t.id, t]));

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

/* ---- 1. ORDER 里不能有拼错的 id ---- */
const known = new Set(TOOLS.map((t) => t.id));
const bogus = [];
for (const [mod, ids] of Object.entries(ORDER)) {
  for (const id of ids) if (!known.has(id)) bogus.push(mod + ':' + id);
}
chk(bogus.length === 0, 'ORDER 里没有不存在的 id' + (bogus.length ? ' -> ' + bogus.join(', ') : ''));

/* ---- 2. ORDER 里的 id 必须真的属于该模块（放错模块 = 排序失效）---- */
const misplaced = [];
for (const [mod, ids] of Object.entries(ORDER)) {
  for (const id of ids) {
    const t = byId.get(id);
    if (t && t.module !== mod) misplaced.push(`${id} 登记在 ${mod}，实际属于 ${t.module}`);
  }
}
chk(misplaced.length === 0, 'ORDER 里的工具都登记在正确的模块' + (misplaced.length ? ' -> ' + misplaced.join('; ') : ''));

/* ---- 3. 每个模块的每个工具都必须登记 ---- */
const missing = [];
for (const mod of Object.keys(ORDER)) {
  const listed = new Set(ORDER[mod]);
  for (const t of TOOLS.filter((x) => x.module === mod)) {
    if (!listed.has(t.id)) missing.push(mod + ':' + t.name + '(' + t.id + ')');
  }
}
chk(missing.length === 0,
  '所有工具都在 ORDER 表里登记过' + (missing.length ? ' -> 漏登记：' + missing.join(', ') : ''));

/* ---- 4. 每个注册过的模块都要有 ORDER 条目 ---- */
const mods = new Set(TOOLS.map((t) => t.module));
const noOrder = [...mods].filter((m) => !ORDER[m]);
chk(noOrder.length === 0, '每个模块都有 ORDER 分组' + (noOrder.length ? ' -> ' + noOrder.join(', ') : ''));

/* ---- 5. 常用工具必须排在前面（抽一批业界公认高频的做哨兵）----
 * 这条不是为了「好看」，而是防止以后有人随手把这几个挪到后面去。
 * 阈值取前 4 —— 网格首行 4 个位置，核心工具不该跌出第一行。 */
const HOT = [
  ['file', 'zip-tool'], ['file', 'global-search'],
  ['system', 'process-manager'],
  ['text', 'base64'],
  ['net', 'ping-test'], ['net', 'net-info'],
  ['media', 'snip-tool'], ['media', 'img-compress'],
  ['office', 'pdf-tools'],
  ['dev', 'json-format'], ['dev', 'regex-test'],
  ['security', 'password-gen']
];
const lateHot = [];
for (const [mod, id] of HOT) {
  const idx = ORDER[mod] ? ORDER[mod].indexOf(id) : -1;
  if (idx < 0 || idx > 3) lateHot.push(`${mod}:${byId.get(id) ? byId.get(id).name : id} 位于第 ${idx + 1} 位`);
}
chk(lateHot.length === 0, '常用工具都在各自模块前 4 位（首行）' + (lateHot.length ? ' -> ' + lateHot.join('; ') : ''));

/* ---- 6. 相似工具相邻：用「同组连续」抽查几组已知应该挨着的 ---- */
const ADJACENT = [
  ['file', ['zip-tool', 'archive-7z'], '两种压缩格式'],
  ['file', ['batch-rename', 'batch-ext'], '两种批量改名'],
  ['file', ['global-search', 'content-search'], '两种搜索'],
  ['file', ['dedupe', 'hash-tool'], '查重与校验'],
  ['net', ['port-occupy', 'port-test', 'port-scan'], '端口三件套'],
  ['office', ['pdf-tools', 'pdf2img', 'img2pdf', 'pdf-office-convert'], 'PDF 四连'],
  ['system', ['disk-analyze', 'junk-clean'], '空间与清理'],
  ['system', ['ctxmenu-manage', 'win-classic-menu'], '右键菜单两种'],
  ['security', ['password-gen', 'password-strength'], '密码生成与检测'],
  ['text', ['text-stats', 'text-batch'], '文本处理'],
  ['media', ['img-compress', 'target-size'], '两种压体积'],
  ['media', ['screenshot-ocr', 'batch-ocr'], '单张与批量 OCR'],
  ['media', ['snip-tool', 'screen-rec'], '两种画面抓取'],
  ['dev', ['color-convert', 'color-picker'], '颜色换算与取样']
];
const notAdj = [];
for (const [mod, ids, label] of ADJACENT) {
  const list = ORDER[mod] || [];
  const pos = ids.map((id) => list.indexOf(id));
  if (pos.some((p) => p < 0)) { notAdj.push(`${mod}:${label} 有未登记的项`); continue; }
  const contiguous = pos.every((p, i) => i === 0 || p === pos[i - 1] + 1);
  if (!contiguous) notAdj.push(`${mod}:${label} 不连续（位置 ${pos.map((p) => p + 1).join('/')}）`);
}
chk(notAdj.length === 0, '相似的同类工具都挨在一起' + (notAdj.length ? ' -> ' + notAdj.join('; ') : ''));

/* ---- 7. 顺序必须覆盖全部工具（没有靠兜底排到末尾的）---- */
const totalOrdered = Object.values(ORDER).reduce((n, a) => n + a.length, 0);
chk(totalOrdered === TOOLS.length,
  `ORDER 条目数(${totalOrdered}) 与注册工具数(${TOOLS.length}) 一致`);

/* 打印最终顺序，方便人工核对 */
console.log('\n=== 最终展示顺序 ===');
for (const m of Object.keys(ORDER)) {
  console.log('[' + m + '] ' + ORDER[m].join(' → '));
}

console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
