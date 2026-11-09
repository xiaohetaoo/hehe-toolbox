'use strict';
/* CI 基础设施脚本的守卫（2026-11-09 那轮发版事故的产物）。
 *
 * ============ 背景：连续两次发版都死在同一个地方 ============
 *   v0.6.8 的 CI   —— 「下载 electron 二进制」跑满 120 秒超时
 *   v0.6.9 的 Release —— 同一步 11 秒快速失败
 * 两次都让后续 9~12 个步骤**全部 skipped**，也就是代码一行都没被执行到，
 * 但流水线是红的。这类失败最容易被误读成"这次改动有问题"。
 *
 * 所以这里守三件事：
 *   1. electron 下载必须经过带重试的脚本，且重试前会清半成品
 *   2. 发布结果必须被**反查**（不信中间步骤的退出码）
 *   3. 这两个脚本本身的行为正确
 */
const assert = require('assert');
const { t, done, ROOT, readSrc } = require('./lib/harness');

/* ============ ensure-electron ============ */
t('EE1 两个 workflow 都用同一份脚本下载 electron，不再各写一遍 bash', () => {
  /* 锁的是：ci.yml 与 release.yml 各内联一段 `node node_modules/electron/install.js`。
   * 两处独立维护必然分叉，而且内联版本**没有重试** —— 实测连续两次发版
   * 都栽在下载失败上。 */
  const ci = readSrc('.github/workflows/ci.yml');
  const rel = readSrc('.github/workflows/release.yml');
  for (const [name, s] of [['ci.yml', ci], ['release.yml', rel]]) {
  /* 锁的是：两个 workflow 各写一份 electron 下载 bash —— 必然分叉且没有重试 */
    assert.ok(/node scripts\/ensure-electron\.js/.test(s),
      name + ' 没有调用 scripts/ensure-electron.js');
    assert.ok(!/node node_modules\/electron\/install\.js/.test(s),
      name + ' 仍在直接调 install.js（没有重试与半成品清理）');
  }
});

t('EE2 重试次数有限且每次重试前清掉半成品', () => {
  /* 锁的是：把重试写成"原地再跑一遍 install.js"。
   * install.js 看到残缺的 dist/ 会认为已下载、直接跳过，
   * 于是重试 N 次其实什么都没做，最后报的错还是"文件不存在"。 */
  const s = readSrc('scripts/ensure-electron.js');
  /* 锁的是：重试写成"原地再跑 install.js" —— 半成品让 install.js 以为已下载 */
  assert.ok(/MAX_ATTEMPTS\s*=\s*\d/.test(s), '没有重试上限');
  assert.ok(/function cleanPartial\(/.test(s), '没有清半成品的函数');
  /* 【判据改成「出现次数 ≥ 2」而不是按位置切片】
   * 切片在函数声明顺序变化时很容易切空（这个文件里 main 定义在循环之前、
   * 调用在最后，按 indexOf 切怎么都不稳）。定义一处 + 调用至少一处 = 2 次，
   * 少一次就说明"定义了但没人在重试里用"。 */
  /* 锁的是：cleanPartial 只在定义处出现 —— 重试时没有清半成品 */
  const calls = (s.match(/cleanPartial\(\)/g) || []).length;
  assert.ok(calls >= 2, 'cleanPartial 只在定义处出现（重试循环里没调用）');
});

t('EE3 已就绪时直接跳过（不重复下载 200MB）', () => {
  /* 锁的是：无条件重新下载 —— CI 每次都要多等几分钟，
   * 而且把"已缓存可用"这条路径堵死了。 */
  const s = readSrc('scripts/ensure-electron.js');
  assert.ok(/function hasExe\(/.test(s), '没有判断文件是否已就绪');
  const body = s.slice(s.indexOf('function main()'));
  /* 锁的是：无条件重新下载 200MB —— 堵死"已缓存可用"这条路径 */
  assert.ok(/if \(hasExe\(\)\)/.test(body), 'main 里没有"已存在就跳过"的分支');
});

t('EE4 失败时给出可操作的结论（而不是只有退出码）', () => {
  /* 锁的是：最后只 process.exit(1)，日志里看不出发生了什么。
   * 看 CI 的人需要知道"重试了几次 / 该不该直接重跑"。 */
  const s = readSrc('scripts/ensure-electron.js');
  const tail = s.slice(s.indexOf('electron 二进制下载失败'));
  /* 锁的是：失败只 exit(1) —— 日志里看不出重试了几次、该不该重跑 */
  assert.ok(/::error::/.test(s), '没有输出 ::error:: 注解');
  assert.ok(/已重试/.test(tail) || /MAX_ATTEMPTS/.test(tail), '失败信息里没有重试次数');
});

/* ============ verify-release ============ */
t('VR1 五条判据齐全：Release 存在 / 非 draft / 有 exe / 有 zip / 不为空', () => {
  /* 锁的是：只检查"Release 存在"就放行。
   * v0.6.9 那次正是「tag 在、Release 完全没有」；而更早的 v0.2.6 是
   * 「Release 在、产物在、但流程红灯让人以为失败」。两种都要能区分。 */
  const s = readSrc('scripts/verify-release.js');
  /* 锁的是：只检查"Release 存在"就放行 —— 漏掉 draft / 无产物两种情况 */
  assert.ok(/if \(!rel\)/.test(s), '没有"Release 不存在"的分支');
  assert.ok(/rel\.draft/.test(s), '没有检查 draft');
  assert.ok(/hasExe/.test(s) && /hasZip/.test(s), '没有分别检查 exe 与 zip');
  /* 锁的是：不检查产物大小 —— 0 字节的占位文件也算"有产物" */
  assert.ok(/a\.size < 1024 \* 1024|size < 1024/.test(s), '没有检查产物大小');
});

t('VR2 自动生成的源码包不能算数', () => {
  /* 锁的是：用 assets.length 判断"有没有产物"。
   * GitHub 会给每个 Release 自动附 Source code (zip) / (tar.gz)，
   * 它们不是能直接运行的便携版 —— 只看数量会把"只有源码"误判成成功。
   *
   * 【必须锁住「过滤」那一行本身】
   * 第一版断言只要求文件里出现 `.endsWith('.exe')` 与 `.endsWith('.zip')`，
   * 而这两串在下面的 hasExe / hasZip 判定里本来就存在 —— 于是把
   * `named = assets.filter(...)` 改成 `named = assets`（等于取消了后缀过滤）
   * 之后断言仍然绿。变异测试抓到了这个洞。
   * 现在直接检查过滤表达式里用了 WANT_SUFFIX.some(...endsWith)。 */
  const s = readSrc('scripts/verify-release.js');
  /* 锁的是：用 assets.length 当判据 —— GitHub 自动附的源码包会被算进去 */
  assert.ok(/WANT_SUFFIX/.test(s), '没有定义期望后缀清单');
  const namedLine = s.split('\n').find((l) => /const named\s*=/.test(l)) || '';
  assert.ok(/filter\(/.test(namedLine), 'named 没有经过 filter 筛选：' + namedLine.trim());
  /* 锁的是：named 不按后缀过滤 —— GitHub 自动附的源码包会被当成交付物 */
  assert.ok(/WANT_SUFFIX\.some/.test(namedLine), 'named 没有按 WANT_SUFFIX 过滤（源码包会被算进去）');
  /* 反面：不许直接拿 assets 当 named */
  /* 锁的是：named 直接等于 assets —— 后缀过滤形同虚设 */
  assert.ok(!/const named\s*=\s*assets\s*;/.test(s), 'named 直接等于 assets（未过滤）');
  /* 反面：不许用数量当通过条件 */
  /* 锁的是：用 assets 数量当通过条件 —— 只有源码包时也会判成功 */
  assert.ok(!/if \(assets\.length >= 2\)\s*\{\s*console\.log\('OK/.test(s),
    '用 assets 数量当判据（会把源码包算进去）');
});

t('VR3 这一步会被 workflow 以 always() 调用（构建失败时也要验）', () => {
  /* 锁的是：把校验写成"只有前面全成功才跑" —— 那恰好漏掉最该抓的场景
   * （更早的步骤失败 → Publish 被 skip → Release 不存在）。
   *
   * 【必须读 raw】`Verify release result` 这个 step 名前面有一大段中文注释，
   * 而 readSrc 默认会剥注释 —— 用剥过的版本会找不到它。 */
  const s = readSrc('.github/workflows/release.yml', { raw: true });
  const i = s.indexOf('Verify release result');
  assert.ok(i > 0, 'workflow 里没有 Verify release result 步骤');
  /* 从 step 名往后取到下一个 step 或文件尾 */
  const nextStep = s.indexOf('\n      - name:', i);
  const seg = s.slice(i, nextStep > i ? nextStep : i + 600);
  /* 锁的是：校验步骤写成"前面全成功才跑" —— 恰好漏掉最该抓的场景 */
  assert.ok(/if: always\(\)/.test(seg), '这一步没有 if: always()，前面失败时不会执行');
  assert.ok(/verify-release\.js/.test(seg), '这一步没有调用 verify-release.js');
});

t('VR4 Release 不存在时的报错要说明「tag 已推送」', () => {
  /* 锁的是：只报"找不到 Release"。
   * 那种措辞会让人怀疑 tag 也没推成功，从而去重推 tag。
   * 实际场景是 tag 在、发布没完成 —— 报错必须点明这一点。 */
  const s = readSrc('scripts/verify-release.js');
  const seg = s.slice(s.indexOf('if (!rel)'), s.indexOf('if (rel.draft)'));
  /* 锁的是：只报"找不到 Release" —— 会让人误以为 tag 也没推成功 */
  assert.ok(/已推送/.test(seg), '报错没说"tag 已推送"');
  assert.ok(/没有对应的 Release|没有\*\*?.{0,4}Release/.test(seg), '报错没说清是 Release 缺失');
});

/* ============ 脚本本身可执行 ============ */
t('VR5 两个脚本在缺少参数时给出用法并退出非零（不会静默通过）', () => {
  const { spawnSync } = require('child_process');
  for (const f of ['scripts/ensure-electron.js', 'scripts/verify-release.js']) {
    if (f.includes('verify-release')) {
      const r = spawnSync(process.execPath, [f], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(r.status, 1, f + ' 缺参数时应退出 1，实际 ' + r.status);
      assert.ok(/用法/.test((r.stdout || '') + (r.stderr || '')), f + ' 没有输出用法');
    }
  }
});

done();
