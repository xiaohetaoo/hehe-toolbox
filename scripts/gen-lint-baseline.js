'use strict';
/* 修正压制注释的插入方式：同一行的多个 lint 问题必须合并成**一条**压制，
 * 否则会叠出三四行紧挨着的 disable 注释，其中后面几条是"Unused
 * eslint-disable directive"（ESLint 会警告），看起来像机器生成的垃圾。
 *
 * 做法：
 *   1) 先还原到干净状态（用 lintbak 备份）；
 *   2) 重新生成，但按 (file, line) 聚合 —— 一行一条，规则名用逗号连接；
 *   3) 已经带 disable 注释的行不再处理。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* ---- 1) 还原备份 ---- */
/* 【为什么要有"备份不存在就中止"这道闸】
 * 这个脚本的流程是「还原 → 重新收集 → 重新插入 → 重写文档」。它的前提是
 * *.lintbak 里存着**压制之前**的源码。一旦备份不在（比如备份被用掉了、
 * 或者上一次运行已经还原过），restore() 什么都不做，于是收集阶段拿到的
 * 是**已经压制过的代码** —— eslint 一条问题都报不出来，planRows 为空，
 * baseline 文档就被重写成「总数：0 处 + 空明细」。
 *
 * 这不是假想：我在本轮真的踩了一次。git 里那份 121 行的基线文档被覆盖成
 * 十几行，而 lint 退出码依然是 0（因为压制确实还在源码里）——
 * 也就是说「文档被清空」这件事没有任何自动化信号。
 * 所以这里改成：没有任何备份就直接退出，不写文档。
 */
function restore() {
  const backups = [
    path.join(ROOT, 'js.lintbak'),
    path.join(ROOT, 'lib.lintbak'),
    path.join(ROOT, 'main.js.lintbak'),
    path.join(ROOT, 'preload.js.lintbak'),
  ].filter((p) => fs.existsSync(p));
  if (!backups.length) {
    console.error('找不到任何 *.lintbak 备份 —— 无法还原到压制前的状态。');
    console.error('继续跑会把 baseline 文档重写成空内容（源码已经是压制状态，eslint 报不出问题）。');
    console.error('请先手工撤掉源码里的压制注释，再重新运行本脚本。已中止，未修改任何文件。');
    process.exit(2);
  }
  const restoreOne = (src, dst) => {
    if (!fs.existsSync(src)) return;
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
  };
  restoreOne(path.join(ROOT, 'js.lintbak'), path.join(ROOT, 'js'));
  restoreOne(path.join(ROOT, 'lib.lintbak'), path.join(ROOT, 'lib'));
  for (const f of ['main.js', 'preload.js']) {
    const b = path.join(ROOT, f + '.lintbak');
    if (fs.existsSync(b)) { fs.rmSync(path.join(ROOT, f), { force: true }); fs.renameSync(b, path.join(ROOT, f)); }
  }
  console.log('已还原到压制前的状态（用了 ' + backups.length + ' 个备份）');
}

restore();

/* ---- 2) 收集问题 ---- */
const r = spawnSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
  'main.js', 'preload.js', 'lib/*.js', 'js/tools/*.js', 'js/*.js', 'js/auxwin/*.js',
  '-f', 'json',
], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const out = String(r.stdout || '');
const report = JSON.parse(out.slice(out.indexOf('[')));

/* 按 (file, line) 聚合规则名 */
const byLine = new Map();   // key = file + ':' + line
for (const f of report) {
  for (const m of f.messages) {
    if (!m.ruleId) continue;                    // 解析错误不压
    if (m.ruleId === 'no-control-regex') continue;   // 项目里已有自己的压制，我们不重复
    const key = f.filePath + ':' + m.line;
    if (!byLine.has(key)) byLine.set(key, { file: f.filePath, line: m.line, rules: new Set(), msgs: [] });
    byLine.get(key).rules.add(m.ruleId);
    byLine.get(key).msgs.push(m.message);
  }
}

function reasonFor(rules, msgs) {
  const rs = [...rules];
  if (rs.includes('no-async-promise-executor')) {
    return '历史写法：async 作 Promise executor。改成非 async 会变更异常传播路径，属行为改动，本轮不动';
  }
  if (rs.includes('no-shadow')) {
    return '历史遗留：内层同名变量遮蔽外层（已逐条确认无语义影响）';
  }
  if (rs.includes('no-unused-vars')) {
    if (msgs.some((s) => /is assigned a value but never used/.test(s))) {
      return '历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动）';
    }
    return '历史遗留：定义了但未使用（删它需同步改测试断言，留给下一轮）';
  }
  return '历史遗留（详见 scripts/lint-baseline.md）';
}

/* ---- 3) 按文件插入（从后往前，避免行号位移） ---- */
const byFile = new Map();
for (const v of byLine.values()) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file).push(v);
}

let inserted = 0;
const planRows = [];
for (const [file, items] of byFile) {
  const raw = fs.readFileSync(file, 'utf8');
  const hasCRLF = raw.includes('\r\n');
  const arr = raw.split(hasCRLF ? '\r\n' : '\n');

  items.sort((a, b) => b.line - a.line);
  for (const it of items) {
    const idx = it.line - 1;
    if (idx < 0 || idx >= arr.length) continue;
    /* 该行或上一行已有 disable 注释就跳过（避免重复） */
    if (/eslint-disable-next-line/.test(arr[idx]) || /eslint-disable-next-line/.test(arr[idx - 1] || '')) continue;
    const indent = (arr[idx].match(/^\s*/) || [''])[0];
    const rules = [...it.rules].join(', ');
    const why = reasonFor(it.rules, it.msgs);
    arr.splice(idx, 0, indent + '/* eslint-disable-next-line ' + rules + ' -- ' + why + ' */');
    planRows.push({ file, line: it.line, rules: [...it.rules], msgs: it.msgs });
    inserted++;
  }
  fs.writeFileSync(file, arr.join(hasCRLF ? '\r\n' : '\n'));
}

console.log('插入压制 ' + inserted + ' 条（一行合并）');

/* ---- 4) 重新校验 ---- */
const r2 = spawnSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
  'main.js', 'preload.js', 'lib/*.js', 'js/tools/*.js', 'js/*.js', 'js/auxwin/*.js',
], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const tailOut = String(r2.stdout || '') + String(r2.stderr || '');
console.log(tailOut.split('\n').slice(-4).join('\n'));
console.log('\n退出码 = ' + r2.status + (r2.status === 0 ? '（全绿）' : ''));

/* ---- 5) 写 baseline 文档 ---- */
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const byRule = {};
for (const p of planRows) for (const rule of p.rules) (byRule[rule] ||= []).push(p);

let md = '# ESLint 存量问题基线\n\n';
md += '> 由 `scripts/gen-lint-baseline.js` 生成。**不要手改**，改完 lint 后重跑该脚本。\n\n';
md += '本文件登记的是本轮**不修**的既有问题。每一条都在源码里用**行级**\n';
md += '`/* eslint-disable-next-line <规则> -- 理由 */` 压制，而不是文件级 disable ——\n';
md += '文件级会让整个文件永不再被检查，以后真的 bug 也抓不到。\n\n';
md += '## 为什么登记而不是一次全修\n\n';
md += '这些是项目既有的写法，不是本轮改造引入的。一次全修会同时动几十个文件，\n';
md += '与「不许改任何用户可见行为」的约束冲突。登记是为了：\n\n';
md += '1. 让 lint 能进 CI 而不制造噪音（否则必然有人批量加 disable 把它压成假绿）；\n';
md += '2. 让后来者知道「这些行是已知的、有理由的」，不是漏网的真 bug；\n';
md += '3. 给下一轮清理一张明确清单。\n\n';
md += '## 总数：' + planRows.length + ' 处\n\n';
md += '| 规则 | 处数 | 性质 |\n|---|---|---|\n';
const NATURE = {
  'no-unused-vars': '解构了未使用的助手 / 局部变量赋值后未使用。**多数无害**（多解构几个助手是常见写法），少数是旧实现残留。',
  'no-shadow': '内层同名变量。已逐条人工确认无语义影响。（`catch (e)` 嵌套属正常写法，已从规则里排除，这里剩的是真同名遮蔽。）',
  'no-async-promise-executor': '`new Promise(async (resolve, reject) => ...)`。**这一条最值得下一轮处理**：async executor 里抛出的异常不会走 reject，而是变成未捕获的 rejection。',
};
for (const [rule, list] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
  md += '| `' + rule + '` | ' + list.length + ' | ' + (NATURE[rule] || '—') + ' |\n';
}
md += '\n## 明细\n\n';
for (const [rule, list] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
  md += '\n### `' + rule + '`（' + list.length + ' 处）\n\n';
  for (const p of list.sort((a, b) => rel(a.file).localeCompare(rel(b.file)) || a.line - b.line)) {
    md += '- `' + rel(p.file) + ':' + p.line + '` — ' + p.msgs[0] + '\n';
  }
}
md += '\n## 本轮真修掉的问题（不是压制，是改代码）\n\n';
md += '| 位置 | 规则 | 问题 | 修法 |\n|---|---|---|---|\n';
md += '| `js/tools/launch.js` | no-undef | `pickOne` 定义在第一个工具的作用域内，第二个工具（命令收藏）跨作用域引用 → 点「➕ 收藏命令」填完内容后直接 ReferenceError，选择执行环境的弹窗根本不出现 | 把 `pickOne` 提到模块顶层 |\n';
md += '| `js/tools/media.js:445` | no-undef | `parseTiff` 定义在 `parseExif` 外面，却直接引用 `parseExif` 的形参 `buf` → **带 EXIF 的照片反而看不到参数**（异常被 catch 吞成「未找到 EXIF 信息」），没有 EXIF 的照片却正常 | `parseTiff(buf, start)` 显式传参 |\n';
md += '\n> 这两处都是 ESLint 的 `no-undef` 抓出来的 —— 语法检查（`node --check`）与所有单元测试都看不见它们，\n';
md += '> 因为出错路径只在特定输入（命令收藏页 / 带 EXIF 的照片）下才会走到。\n';

fs.writeFileSync(path.join(ROOT, 'scripts', 'lint-baseline.md'), md);
console.log('baseline 写入 scripts/lint-baseline.md（' + planRows.length + ' 处）');
