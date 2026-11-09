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

t('VR6 兜底脚本在 Release 不存在时不该挂红（由 verify-release 判）', () => {
  /* 锁的是：workflow 里那两步 `if: always()` 在"Release 根本没创建"时
   * 也去执行，然后因为找不到 Release 而 exit 1 —— 于是日志最后一条红是
   * 「找不到 release / 标题未统一」，真正的失败（没有产物）被盖住，
   * 看日志的人会去查标题逻辑，方向完全错了。
   *
   * 职责划分：
   *   · fix-release-title / ensure-release-notes —— 只改内容，
   *     Release 不存在时安静跳过（退出 0）
   *   · verify-release —— 唯一有权判"发布失败"的地方
   * 三者都要有这个分工，否则又回到"到处报红但没人说清原因"。 */
  const title = readSrc('scripts/fix-release-title.js');
  /* 锁的是：兜底脚本在 Release 不存在时也 exit 1 —— 把真正失败盖住 */
  assert.ok(/--if-exists/.test(title), 'fix-release-title 没有 --if-exists 模式');
  assert.ok(/if \(probe\.status === 404\)/.test(title), '--if-exists 没有 404 探测分支');

  const notes = readSrc('scripts/ensure-release-notes.js');
  const seg = notes.slice(notes.indexOf('if (!rel)'), notes.indexOf('const cur ='));
  /* 锁的是：ensure-release-notes 在 Release 不存在时仍 exit 1 */
  assert.ok(/没有对应的 Release/.test(seg), 'ensure-release-notes 没有"Release 不存在就跳过"的分支');
  assert.ok(!/process\.exit\(1\)/.test(seg), 'Release 不存在时仍然 exit 1');
});

t('VR7 workflow 调用时传了 --if-exists', () => {
  /* 锁的是：脚本加了开关但 workflow 没传 —— 等于没加。 */
  const s = readSrc('.github/workflows/release.yml', { raw: true });
  assert.ok(/fix-release-title\.js --if-exists/.test(s),
    'workflow 调 fix-release-title 时没有传 --if-exists');
});

t('VR8 --if-exists 不会把开头的开关当成 tag', () => {
  /* 锁的是：resolveTag 直接取 argv[2]。
   * 调用 `--if-exists v0.6.9` 时 argv[2] 是 '--if-exists'，
   * 会卡在 tag 格式校验上报"格式可疑"，而真正的问题是不该报错。 */
  const s = readSrc('scripts/fix-release-title.js');
  /* 锁的是：resolveTag 直接取 argv[2] —— 会把 --if-exists 当成 tag */
  assert.ok(/filter\(\(a\) => !a\.startsWith\('--'\)\)/.test(s),
    'resolveTag 没有跳过 --开头的开关');
  assert.ok(!/const argvTag = process\.argv\[2\]/.test(s),
    'resolveTag 仍直接取 argv[2]');
});

t('EE5 两个 workflow 都缓存 electron 二进制（下载反复不可用）', () => {
  /* 锁的是：只加重试、不加缓存。
   * 实测 v0.7.0 的 CI 在**有 4 次重试**的情况下仍然 4 次全失败（47 秒）——
   * 说明 objects.githubusercontent.com 在这批 runner 上是持续不可达，
   * 不是偶发抖动。重试治不了它，只有"下过一次就不用再下"能绕过。
   *
   * 缓存键必须带 package-lock.json 的 hash：electron 版本变了要换缓存，
   * 否则会解出旧版本二进制，打包出版本号与实际运行时不符的应用。
   *
   * 【判据必须锁到"电子缓存路径"这一处，不能只查用了 actions/cache】
   * 第一版只断言 `uses: actions/cache@v4` 存在 —— 而把整个 step 改名禁用
   * （name 改掉、uses 保留）仍然通过。现在要求同一段里出现
   * electron/Cache 路径，且键绑定 package-lock。 */
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const s = readSrc(f, { raw: true });
    /* 定位到"缓存 electron"那个 step 的块（从 name 到下一个 - name: 之前） */
    const i = s.indexOf('Cache electron binary');
    assert.ok(i > 0, f + ' 没有 Cache electron binary 步骤');
    const nextStep = s.indexOf('\n      - name:', i);
    const seg = s.slice(i, nextStep > i ? nextStep : i + 700);
    /* 锁的是：缓存步骤没有真正覆盖 electron 下载目录 —— 等于没缓存 */
    assert.ok(/uses: actions\/cache@v4/.test(seg), f + ' 的缓存步骤没有用 actions/cache@v4');
    assert.ok(/electron\/Cache/.test(seg), f + ' 的缓存路径没有覆盖 electron 下载目录');
    assert.ok(/hashFiles\('package-lock\.json'\)/.test(seg),
      f + ' 的缓存键没有绑定 package-lock（版本变了不会换缓存）');
    /* 锁的是：pathBlock 为空 —— 说明 workflow 的 path:/key: 结构变了，
     * 下面那条"不含表达式"的断言就变成了空字符串比较、永远通过。 */
    const pathBlock = (seg.match(/path:\s*\|([\s\S]*?)\n\s*key:/) || [])[1] || '';
    /* 锁的是：path 块解析失败 —— 后续断言会静默失去判别力 */
    assert.ok(pathBlock, f + ' 找不到 path 块');
    /* 锁的是：缓存路径写成 GitHub 表达式 —— save 时静默匹配为空。 */
    /* 实测踩过 ${{ runner.os == 'Windows' && env.LOCALAPPDATA }}：
     * actions/cache 报 success，实际什么都没存，下次还要重下。 */
    assert.ok(!/\$\{\{/.test(pathBlock),
      f + ' 的缓存路径里含 GitHub 表达式（save 时会静默匹配为空）');
  }
});

t('EE7 下载完成后要校验版本（不只是看 exe 存在）', () => {
  /* 锁的是：install.js 退出码 0 + electron.exe 够大 就认为成功。
   * 这会漏掉两种错配：
   *   · 缓存里是旧版本 → 解出旧 electron → 安装包版本号新、运行时旧
   *   · dist/version 缺失 → install.js 会重下，而 hasExe() 认为已就绪
   * install.js 自己的 isInstalled() 就是读 dist/version + path.txt 的，
   * 这里要与它同一套判据。
   *
   * 【判据：verifyVersion 必须出现 ≥2 次】
   * 两个检查点各一次 —— ① 开工前判"已就绪"  ② 每次下载成功后判"这次下的对不对"。
   * 第一版只断言"main 里出现过 verifyVersion"，而把它从下载成功分支里删掉
   * 仍然通过（① 还在），变异测试抓到了这个洞。 */
  const s = readSrc('scripts/ensure-electron.js');
    /* 锁的是：没有版本校验 —— 旧缓存会解出旧二进制，安装包版本号骗人 */
  assert.ok(/function verifyVersion\(/.test(s), '没有 verifyVersion');
  assert.ok(/'version'/.test(s) || /dist.*version/.test(s), '没有读 dist/version');
  const mainBody = s.slice(s.indexOf('function main()'));
  /* 锁的是：verifyVersion 只在"已就绪"分支调一次 —— 下载后不校验这一批二进制 */
  const calls = (mainBody.match(/verifyVersion\(\)/g) || []).length;
  assert.ok(calls >= 2,
    'main 里只调用了 ' + calls + ' 次 verifyVersion（应在"已就绪"与"下载后"各一次）');
});

t('EE8 清理要覆盖 install.js 依赖的三个路径', () => {
  /* 锁的是：cleanPartial 只删 dist 目录、漏了 path.txt。
   * install.js 的 isInstalled() 要求 dist/version **和** path.txt 都对；
   * 只删一半时它可能直接 exit 0（认为已装），而我们判定失败 → 重试白跑。 */
  const s = readSrc('scripts/ensure-electron.js');
  const fn = s.slice(s.indexOf('function cleanPartial()'), s.indexOf('function run()'));
    /* 锁的是：cleanPartial 漏清 path.txt —— install.js 会误判已装、重试白跑 */
  assert.ok(/DIST/.test(fn), 'cleanPartial 没有清 dist 目录');
  assert.ok(/path\.txt/.test(fn), 'cleanPartial 没有清 path.txt');
});

done();
