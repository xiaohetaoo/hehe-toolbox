'use strict';
/* 校验「渲染层的前缀表」与「主进程的前缀表」是否一致。
 *
 * 渲染层有 js/job-prefixes.js，主进程有 lib/job-id.js。两份表必须一模一样，
 * 否则就会出现：主进程改前缀 → 渲染层正则失配 → 进度条不动/取消杀错任务，
 * 而且这种失配不会报错、不会有日志，只能靠人眼发现。
 * 这个测试就是为了让「不同步」在提交前就失败。
 */
const fs = require('fs');
const path = require('path');
/* 读项目内文件（迁移来的 round14 用例要读 main.js 的测速任务实现）。 */
function read(rel) { return require('fs').readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
const assert = require('assert');
/* 只借用 readTree（任务 9 把 media.js 拆成目录后，需要按目录拼源码）。
 * 不接管本文件自己的 t()：它是行内箭头形式，输出格式与 harness 的
 * deferred 版不同，换掉会改变这个脚本的输出形态。 */
const { readTree } = require('./lib/harness');
const stripComments = require('../lib/src-scan').stripComments;

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

const ROOT = path.join(__dirname, '..');
const libJobId = require('../lib/job-id');

/* 从 js/job-prefixes.js 里解析出前缀表（它是 IIFE，不便 require，
 * 这里用正则读源码里的对象字面量，够用且不引入 DOM 依赖）。 */
function readRendererPrefixes() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'job-prefixes.js'), 'utf8');
  const m = src.match(/const JOB_PREFIXES = \{([\s\S]*?)\n  \};/);
  assert.ok(m, '无法从 job-prefixes.js 解析出 JOB_PREFIXES');
  const out = {};
  for (const line of m[1].split('\n')) {
    const km = line.match(/^\s*(\w+):\s*'/);
    if (km) out[km[1]] = true;
  }
  return out;
}

t('渲染层前缀表可解析且非空', () => {
  const r = readRendererPrefixes();
  assert.ok(Object.keys(r).length >= 10, '前缀数量异常: ' + Object.keys(r).length);
});

t('两份前缀表完全相同（键集合一致）', () => {
  const r = Object.keys(readRendererPrefixes()).sort();
  const l = Object.keys(libJobId.JOB_PREFIXES).sort();
  assert.deepStrictEqual(r, l, '前缀键不一致\n渲染层: ' + r.join(',') + '\n主进程: ' + l.join(','));
});

t('main.js 里所有 job id 前缀都在两份表里', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const prefixes = [...main.matchAll(/const id = '([a-z0-9]+)'\s*\+\s*\(\+\+jobSeq\)/g)].map((m) => m[1]);
  const uniq = [...new Set(prefixes)];
  const libKeys = Object.keys(libJobId.JOB_PREFIXES);
  const rendererKeys = Object.keys(readRendererPrefixes());
  for (const p of uniq) {
    assert.ok(libKeys.includes(p), 'lib/job-id.js 缺少前缀: ' + p);
    assert.ok(rendererKeys.includes(p), 'js/job-prefixes.js 缺少前缀: ' + p);
  }
});

t('渲染层用的正则前缀与表一致（抽查）', () => {
  const files = ['js/tools/media', 'js/tools/file-tools.js', 'js/tools/target-size.js'];
  const used = new Set();
  for (const f of files) {
    /* 任务 9 之后 'js/tools/media' 是**目录** —— 直接 readFileSync 会 EISDIR。
     * 这条断言要的是「这些文件里出现的手写正则前缀」，与文件数无关，
     * 所以目录走 readTree 拼起来（拼接顺序不影响正则扫描结果）。 */
    const src = fs.statSync(path.join(ROOT, f)).isDirectory() ? readTree(f) : fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/\/(\^)?([a-z0-9]+)\\d\+/g)) used.add(m[2]);
  }
  const known = Object.keys(readRendererPrefixes());
  const unknown = [...used].filter((p) => !known.includes(p));
  assert.deepStrictEqual(unknown, [], '渲染层用了未登记的前缀: ' + unknown.join(','));
});

t('index.html 引入了 job-prefixes.js 且在 ui.js 之前', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('js/job-prefixes.js'), 'index.html 未引入 job-prefixes.js');
  const iJob = html.indexOf('js/job-prefixes.js');
  const iUi = html.indexOf('js/ui.js');
  assert.ok(iJob < iUi, 'job-prefixes.js 应在 ui.js 之前加载');
});

t('32 job-id：前缀互为前缀不能串号（通用下载器已改名为 dlg）', () => {
  const Jx = require(path.join(ROOT, 'lib', 'job-id'));
  /* 现在的 id 形态：FFmpeg 下载 dl<n>、通用下载器 dlg<n>。
   * 关键不变量：任何一个 id 只归属一个前缀。 */
  const ids = ['dl1', 'dl2', 'dl12', 'dl2123', 'dlg1', 'dlg123', 'scanp12', 'scan12'];
  const prefixes = Object.keys(Jx.JOB_PREFIXES);
  for (const id of ids) {
    const owners = prefixes.filter((p) => Jx.belongsTo(id, p));
    assert.ok(owners.length <= 1,
      'id ' + id + ' 同时归属于多个前缀：' + JSON.stringify(owners) +
      ' —— 渲染层会用它来过滤 job:stream，串号会导致进度条被别的任务驱动');
  }
  /* 具体回归：dlg<n> 不能被 dl 前缀认领（'dl' 是旧名 dl2 的真前缀） */
  assert.strictEqual(Jx.belongsTo('dlg123', 'dl'), false, 'dlg123 不该归属 dl');
  assert.strictEqual(Jx.belongsTo('dlg123', 'dlg'), true);
});

/* ==================== 33. dir-move：freeBytes 未知不能被当成 0 ==================== */

t('9a 测速任务按 speed 前缀认领，不能先到先得', () => {
  const code = stripComments(read('js/tools/net-tools.js'));
  /* 反面：不许再有 `if (!speedId) speedId = d.id` 这种接管任意 id 的写法 */
  assert.ok(!/if\s*\(\s*!speedId\s*\)\s*speedId\s*=\s*d\.id/.test(code),
    '仍在"先到先得"：别的任务先广播就会抢走 id，曲线画的是别人的数据');
  assert.ok(/speed/.test(code), '没有用 speed 前缀判定归属');
  assert.ok(/belongsTo|JobPrefix/.test(code), '没有走统一的 belongsTo 判定');
});

t('9b 行为验证：先到来的其它 id 不会被认领，本前缀的才认领', () => {
  const JP = require(path.join(ROOT, 'lib', 'job-id'));
  /* 复刻页面里的认领顺序：用真实的 belongsTo，验证"先到先得"与"按前缀"的区别 */
  const claimByPrefix = (incoming, current) => {
    if (current) return incoming === current ? current : null;
    return JP.belongsTo(incoming, 'speed') ? incoming : null;
  };
  const claimFirstCome = (incoming, current) => current || incoming || null;

  // 别的任务先来
  assert.strictEqual(claimByPrefix('job42', null), null, '别的任务（job42）不该被当成测速任务');
  assert.strictEqual(claimFirstCome('job42', null), 'job42', '旧写法确实会接管（证明缺陷前提成立）');
  // 本任务来了才认领
  assert.strictEqual(claimByPrefix('speed7', null), 'speed7', '本前缀的 id 应当被认领');
  // 已认领后别的 id 一律忽略
  assert.strictEqual(claimByPrefix('job9', 'speed7'), null, '认领后不该被别的 id 打断');
  assert.strictEqual(claimByPrefix('speed7', 'speed7'), 'speed7', '自己的 id 应当继续接受');
});

/* ==================== 10. 表达式求值的 ±Infinity ==================== */

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
