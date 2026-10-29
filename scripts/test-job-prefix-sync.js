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
const assert = require('assert');

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
  const files = ['js/tools/media.js', 'js/tools/file-tools.js', 'js/tools/target-size.js'];
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
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

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
