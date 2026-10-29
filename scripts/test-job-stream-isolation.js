'use strict';
/* 审查：所有 `job:stream` 订阅者是否都做了 id 归属过滤。
 *
 * 【为什么需要这个检查】
 * `job:stream` 是**全局广播**：任何后台任务（哈希、下载、压缩、搜索、扫描…）
 * 都在同一个通道上发进度。订阅者若不校验 `d.id` 归属，就会：
 *   - 把别人的进度画到自己的进度条上
 *   - 被别人的 `done` 事件提前结束自己的流程
 *   - 取消按钮杀掉别人的任务
 * 这类 bug 在单元测试里看不出来（它只在多标签并发时出现），
 * 所以用一个静态扫描把它钉死。
 *
 * 用法：node scripts/test-job-stream-isolation.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; else pass++; };

const jsDir = path.join(__dirname, '..', 'js');
const files = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.js')) files.push(p);
  }
})(jsDir);

/* 收集所有 on('job:stream', ...) 的订阅块。
 * 注意：必须以 `job:stream` 为锚点扫描，而不是靠 `on(...)` 的前缀匹配 ——
 * 调用方有 `on(`、`window.api.on(`、`const unsub = on(` 等多种写法，
 * 用前缀正则容易漏。这里直接从 "job:stream" 字面量往后取回调体。 */
const subscriptions = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /job:stream['"]\s*,\s*(?:async\s*)?\(?\s*(\w+)\s*\)?\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const param = m[1];
    const body = src.slice(m.index, m.index + 500);
    const line = src.slice(0, m.index).split('\n').length;
    subscriptions.push({ file: path.relative(path.join(__dirname, '..'), f), param, body, line });
  }
}

chk(subscriptions.length > 0, '找到 ' + subscriptions.length + ' 处 job:stream 订阅');

/* 每个订阅必须在开头附近引用 d.id 做过滤 */
let bad = [];
for (const s of subscriptions) {
  // 允许的过滤形态：
  //   /^前缀\d+$/.test(String(d.id...))
  //   d.id !== runJobId / d.id === xxx
  //   if (!d || !d.id) return
  //   acceptsEvent / belongsTo
  const hasFilter =
    /String\(\s*\w+\.id/.test(s.body) ||
    /\w+\.id\s*(!==|===|!|==)/.test(s.body) ||
    /\.test\(\s*String\(\s*\w+\.id/.test(s.body) ||
    /!s*\.test\(\s*String\(\s*\w+\.id/.test(s.body) ||
    /acceptsEvent|belongsTo|claimJobId/.test(s.body);

  const label = s.file + ':' + s.line + ' (param=' + s.param + ')';
  chk(hasFilter, '订阅有 id 归属过滤: ' + label);
  if (!hasFilter) bad.push(label);
}

/* 额外：列出所有已知 job 前缀，确认订阅里用的前缀都已登记 */
const jobId = require('../lib/job-id');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const prefixes = [...libSrc.matchAll(/const id = '([a-z0-9]+)'\s*\+\s*\(\+\+jobSeq\)/g)].map((m) => m[1]);
chk(prefixes.length >= 10, 'main.js 里识别到 ' + prefixes.length + ' 个 job 前缀');

const unregistered = prefixes.filter((p) => !jobId.JOB_PREFIXES[p]);
chk(unregistered.length === 0,
  '所有 job 前缀都已在 lib/job-id.js 登记' + (unregistered.length ? '（缺：' + unregistered.join(',') + '）' : ''));

/* 前缀不重复（避免两任务共用前缀导致认领混乱） */
const dupes = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
chk(dupes.length === 0, 'job 前缀无重复' + (dupes.length ? '（重复：' + dupes.join(',') + '）' : ''));

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
