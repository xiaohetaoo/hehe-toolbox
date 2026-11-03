'use strict';
/* 断言总数守卫自身的测试。
 *
 * 【为什么守卫也需要测试】
 * 它是一道「防止测试悄悄变少」的元检查。如果它自己判断错了方向 ——
 * 比如把「有人删了 5 条用例」当成正常，或者把「本机缺第二块盘」当成违规 ——
 * 那么它会比没有它更糟：给出一种虚假的安心。
 *
 * 【为什么用合成输入而不是真跑一遍测试】
 * 真跑要 4 分钟，而且无法稳定构造「某文件少 3 条」这种场景
 * （那正是它要防的事）。所以把「解析 + 判定」两层分开：
 * 解析用合成输出验，判定用临时基线文件验。真跑那一步由 CI 自己覆盖。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { t, done } = require('./lib/harness');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'check-assertion-count.js');

/** 造一份「带 @@FILE 标记」的假测试输出。 */
function mkOutput(sections) {
  const parts = [];
  for (const [file, spec] of Object.entries(sections)) {
    parts.push('@@FILE ' + file);
    for (let i = 0; i < (spec.pass || 0); i++) parts.push('PASS  用例 ' + (i + 1));
    for (const s of (spec.skip || [])) parts.push('SKIP ' + s);
    for (const f of (spec.fail || [])) parts.push('FAIL  ' + f);
  }
  return parts.join('\n');
}

t('解析层：PASS 按 @@FILE 归属，SKIP 行被识别成「环境跳过」', () => {
  /* 这是守卫的两个基本能力，缺一个就会误判：
   *   · 不按 @@FILE 归属 → 全部算到一个文件上，增减都对不上；
   *   · 不识别 SKIP     → 环境不足被当成「测试被删了」。 */
  const out = mkOutput({
    'scripts/a.js': { pass: 3 },
    'scripts/b.js': { pass: 0, skip: ['没有第二块磁盘'] },
    'scripts/c.js': { pass: 1, fail: ['某条失败'] },
  });
  /* 直接跑一次 CLI 的 --no-run 太重（要写文件），这里复用它的解析函数 */
  const mod = require('./check-assertion-count');
  const counts = mod.parseByFile(out);
  if (counts['scripts/a.js'] !== 3) throw new Error('a.js 应解析出 3 条，实际 ' + counts['scripts/a.js']);
  if (counts['scripts/b.js'] !== 0) throw new Error('b.js 应解析出 0 条，实际 ' + counts['scripts/b.js']);
  if (counts['scripts/c.js'] !== 1) throw new Error('c.js 应解析出 1 条，实际 ' + counts['scripts/c.js']);
});

t('判定层：环境跳过（有 SKIP 行）不判红，真删除判红', () => {
  /* 【这条是整个守卫的核心语义】
   * 同一个「比基线少」的事实，要分两种情况：
   *   · 输出里有 SKIP 行 → 本机条件不足，只能打印，不能判红；
   *   · 没有任何 SKIP   → 有人删了用例，必须判红。
   * 实测踩到过反面：第一版不区分这两者，CI（没有 dist 产物、没有 ffmpeg）
   * 上它直接红，而它本该保护的是「别悄悄变少」。 */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-'));
  const reportsDir = path.join(tmp, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  /* 守卫把报告写在 <repo>/reports/ 下，这里不能改它 —— 改用环境无关的做法：
   * 直接对着真实的 reports/test-output.log 做「改写 → 判定 → 还原」太脏。
   * 改为在临时目录里造一份最小仓库结构，让守卫跑在副本上。 */
  const scriptCopy = path.join(tmp, 'check.js');
  fs.copyFileSync(GUARD, scriptCopy);
  /* 守卫用 __dirname 上溯一级当作仓库根，所以把它放在 tmp/scripts/ 下 */
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.copyFileSync(GUARD, path.join(tmp, 'scripts', 'check.js'));
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true });
  const basePath = path.join(tmp, 'scripts', 'assertions-baseline.json');
  const reportPath = path.join(tmp, 'reports');
  fs.mkdirSync(reportPath, { recursive: true });

  const runGuard = (output, baseline) => {
    fs.writeFileSync(path.join(reportPath, 'test-output.log'), output);
    fs.writeFileSync(basePath, JSON.stringify(baseline, null, 2));
    try {
      const r = execFileSync(process.execPath,
        [path.join(tmp, 'scripts', 'check.js'), '--no-run'],
        { encoding: 'utf8', cwd: tmp, stdio: 'pipe' });
      return { code: 0, out: r };
    } catch (e) {
      return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  };

  const baseline = { total: 3, files: { 'scripts/a.js': 3 } };

  /* 情形 1：真删除（没有 SKIP）→ 必须 exit 1 */
  const del = runGuard(mkOutput({ 'scripts/a.js': { pass: 0 } }), baseline);
  if (del.code !== 1) throw new Error('真删除时守卫没有判红（exit ' + del.code + '）');
  if (!/比基线少/.test(del.out)) throw new Error('真删除时没有报出「比基线少」：' + del.out.slice(0, 200));

  /* 情形 2：环境跳过（有 SKIP）→ 必须 exit 0，但要打印出来 */
  const skip = runGuard(mkOutput({ 'scripts/a.js': { pass: 0, skip: ['没有第二块磁盘'] } }), baseline);
  if (skip.code !== 0) throw new Error('环境跳过时守卫误判为红（exit ' + skip.code + '）：' + skip.out.slice(0, 300));
  if (!/环境跳过/.test(skip.out)) throw new Error('环境跳过时没有打印原因：' + skip.out.slice(0, 300));

  /* 情形 3：数量正常 → exit 0 */
  const ok = runGuard(mkOutput({ 'scripts/a.js': { pass: 3 } }), baseline);
  if (ok.code !== 0) throw new Error('数量正常时守卫误判为红（exit ' + ok.code + '）');

  fs.rmSync(tmp, { recursive: true, force: true });
});

done();
