'use strict';
/* 断言总数护栏：把「整套测试到底跑了多少条断言」钉住，只允许往上走。
 *
 * ============ 这个文件解决什么问题 ============
 * 仓库里已经有两层防护：
 *   · test-test-map.js —— 每个 lib 模块都要有测试文件（防止「没有测试」）
 *   · harness 的 0 用例保护 —— 一条用例都没注册时判 FAIL（防止「测试消失」）
 * 但这两层都挡不住最常见的一种：
 *   **某个测试文件里删掉几十条用例，文件还在、也还通过，只是覆盖变少了。**
 * 实测就踩过：test-store-health.js 被自动清理脚本从 81 行删到 25 行，
 * 86 条断言变成十几条，而 `npm test` 依然全绿 —— 因为剩下的那些确实都通过。
 *
 * 本守卫的做法：跑一遍完整的 unit + ui 测试，数出 `PASS ` 行总数，
 * 与 scripts/assertions-baseline.json 比对。
 *   · 少了 → FAIL，并列出每个文件少了多少条
 *   · 多了 → PASS，并提示把基线改大（让这条基线跟着项目一起长）
 *
 * 【为什么数 PASS 行而不是数 t() 调用】
 * t() 只是注册；注册了不执行（比如写在 done() 之后）恰恰是本轮真踩到的坑。
 * PASS 行是「真的执行并通过」的证据，与 CI 的 grep 口径完全一致。
 *
 * 【为什么允许往上走、不许往下走】
 * 这条基线的作用是防止「悄悄变少」。新增测试随时可以，把基线调大即可；
 * 删除测试必须显式改基线，那一步会出现在 diff 里，评审时看得见。
 *
 * 用法：
 *   node scripts/check-assertion-count.js            # 跑测试并比对（慢，CI 用）
 *   node scripts/check-assertion-count.js --write    # 重拍基线
 *   node scripts/check-assertion-count.js --no-run   # 用现有报告比对（见下）
 *
 * 【CI 里的用法】
 * 它需要一次完整测试运行。为了不把测试跑两遍，CI 里让前一步把输出存成
 * reports/test-output.log，这一步用 --no-run 读那份日志比对。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'scripts', 'assertions-baseline.json');
const REPORT = path.join(ROOT, 'reports', 'test-output.log');

/** 把一段测试输出解析成「文件 → PASS 条数」。 */
function parseByFile(text) {
  /* 测试脚本是一条条 node 命令串起来的，输出里没有文件名。
   * 所以改用「标记行」：每个脚本跑之前由 runAll() 自己打一行
   * `@@FILE <相对路径>`，然后数这行之后到下一条标记之间的 PASS。 */
  const lines = text.split('\n');
  const out = {};
  let cur = null;
  for (const ln of lines) {
    const m = /^@@FILE (.+)$/.exec(ln);
    if (m) { cur = m[1].trim(); if (!(cur in out)) out[cur] = 0; continue; }
    if (cur && /^PASS /.test(ln)) out[cur]++;
  }
  return out;
}

/* 【少数脚本不打印 PASS 行 —— 它们自己 chk() 直接输出结果】
 * 例如 test-target-e2e.js 全程只打「第N轮 q=… / 压缩幅度 / 源图未被修改」，
 * 结尾 process.exit(ok?0:1)。这类脚本的「断言数」恒为 0，于是在基线里
 * 看起来像「一个测试都没跑」，而它其实做了 3 条实质判定。
 *
 * 对它们改用「退出码」当刻度：跑成功记 1（代表「这一整套判定通过了」），
 * 跑失败记 0。这样删掉整个文件的判定逻辑仍会掉到 0，护栏照样有效。 */
const EXIT_ONLY_FILES = new Set(['scripts/test-target-e2e.js']);

/**
 * 找出本次运行里「因为本机环境不满足而主动跳过」的脚本。
 *
 * 判据是输出里的 `SKIP ` 行（与 CI 的 grep 口径一致）。这些脚本跑不了
 * 是**环境**的问题，不是「有人删了测试」，所以只能打印、不能判红。
 * @param {string} text 带 @@FILE 标记的完整输出
 * @returns {Array<{file:string, reason:string}>}
 */
function detectSkipped(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  for (const ln of lines) {
    const m = /^@@FILE (.+)$/.exec(ln);
    if (m) { cur = m[1].trim(); continue; }
    if (cur && /^SKIP /.test(ln)) {
      /* 一个文件可能有多条 SKIP，只记第一条的原因（挑有内容的） */
      if (!out.some((x) => x.file === cur)) {
        out.push({ file: cur, reason: ln.replace(/^SKIP\s*/, '').slice(0, 80) });
      }
    }
  }
  return out;
}

/** 逐个跑 test:unit / test:ui 里的脚本，边跑边打 @@FILE 标记。 */
function runAll() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cmds = [];
  /* 【按分组展开，不能对每条命令都问一次全量清单】
   * test:unit 与 test:ui 都调用 run-tests.js，若每条都取 --list（两组都列），
   * 同一批脚本会被统计两次 —— 基线数字直接翻倍，而它看着"更高了"更安全，
   * 实际上守卫从此对新增测试完全失效（分母虚高，少跑一整个分组也发现不了）。
   * 所以按 key 传对应的分组参数。 */
  for (const key of ['test:unit', 'test:ui']) {
    const groupFlag = key === 'test:ui' ? ' --ui' : ' --unit';
    for (const part of String(pkg.scripts[key] || '').split('&&')) {
      const s = part.trim();
      if (s) cmds.push({ cmd: s, groupFlag: groupFlag });
    }
  }
  /* 【run-tests.js 会把一批脚本藏在内部】
   * 它按内容自动分组（见 scripts/run-tests.js），package.json 里只留一条命令，
   * 所以从 scripts 里展开不到具体文件。这里问它要一份清单。
   * 不硬编码：清单会随新增测试变，写死必然过期 —— 过期表现为
   * 「新加的测试不算进断言基线」，也就是守卫对它失效。 */
  const expanded = [];
  for (const item of cmds) {
    const cmd = item.cmd;
    if (/scripts[\/]run-tests\.js/.test(cmd)) {
      try {
        const listOut = cp.execSync('node scripts/run-tests.js --list' + item.groupFlag, { cwd: ROOT, encoding: 'utf8' });
        for (const line of listOut.split(String.fromCharCode(10))) {
          const m = line.trim().match(/^(test-[\w-]+\.js)$/);
          if (m) expanded.push('node scripts/' + m[1]);
        }
        continue;
      } catch (e) { /* 拿不到就退回原命令，至少不会完全没跑 */ }
    }
    expanded.push(cmd);
  }
  cmds.length = 0;
  cmds.push(...expanded);
  const chunks = [];
  let failed = 0;
  for (const cmd of cmds) {
    const m = /^node\s+(\S+)/.exec(cmd);
    if (!m) continue;
    const rel = m[1];
    chunks.push('@@FILE ' + rel);
    let out = '';
    let ok = true;
    try {
      out = cp.execSync(cmd, { cwd: ROOT, encoding: 'utf8', shell: 'cmd.exe', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      failed++;
      ok = false;
      out = String((e.stdout || '')) + String((e.stderr || ''));
    }
    chunks.push(out);
    /* 对「不打印 PASS 行」的脚本补一条合成刻度，见 EXIT_ONLY_FILES 的说明 */
    if (EXIT_ONLY_FILES.has(rel) && ok) chunks.push('PASS  （退出码 0 合成刻度：该脚本用 exit code 判定）');
  }
  return { text: chunks.join('\n'), failed, total: cmds.length };
}

function main() {
  const write = process.argv.includes('--write');
  const noRun = process.argv.includes('--no-run');

  let text;
  if (noRun) {
    if (!fs.existsSync(REPORT)) {
      console.error('找不到 ' + REPORT + '（--no-run 需要前一步先把带 @@FILE 标记的输出存到那里）');
      process.exit(1);
    }
    text = fs.readFileSync(REPORT, 'utf8');
  } else {
    console.log('正在跑完整测试并统计断言数…');
    const r = runAll();
    text = r.text;
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, text);
    if (r.failed) console.log('注意：' + r.failed + ' / ' + r.total + ' 个脚本失败（仍在统计已通过的条数）');
  }

  const counts = parseByFile(text);
  const files = Object.keys(counts).sort();
  const total = files.reduce((n, f) => n + counts[f], 0);
  console.log('统计到 ' + files.length + ' 个脚本，PASS 共 ' + total + ' 条');

  /* 【本机环境跑不起来的脚本：只能「少跑」，不能判红】
   * 有一部分测试依赖本机条件：需要第二块硬盘、需要交互式桌面会话、
   * 需要 electron.exe 能起来。条件不满足时它们会打印 `SKIP …` 并自行 exit 0。
   * 这时该文件的 PASS 数当然是 0 或偏少 —— 那是**环境**的问题，不是「有人删了测试」。
   *
   * 实测踩到过：本地基线 1270 条，CI（无交互桌面会话）上 12 个 e2e 走 SKIP 分支，
   * 少掉约 95 条，这道守卫在 CI 上直接红 —— 而它本该保护的是「别悄悄变少」，
   * 不是「每台机器必须跑出一模一样的数字」。
   *
   * 判据：该文件的输出里有 `SKIP ` 行 → 记进 skipped，只打印不判红。
   * 但**不能就此当成全绿**：SKIP 行会逐条列出来，并且在末尾汇总「本次有多少个
   * 脚本因环境跳过」——静默地少测 95 条和明确地说「这台机器少测了 95 条」，
   * 是两件完全不同的事。 */
  const skipped = detectSkipped(text);
  const written = Object.keys(counts);
  const baselineFiles = write ? written : Object.keys(JSON.parse(fs.readFileSync(OUT, 'utf8')).files);
  const notRunAtAll = baselineFiles.filter((f) => !(f in counts));

  if (write) {
    const payload = {
      _comment: '断言总数基线。由 scripts/check-assertion-count.js --write 生成，不要手改。',
      _why: '防止「某个测试文件里悄悄删掉一堆用例，剩下的仍然全绿」。只允许往上走。\n'
        + '注意：本基线是在**这台机器**上拍的。换一台机器（缺第二块盘、无交互桌面）时，'
        + '依赖环境的脚本会走 SKIP 分支、PASS 数偏少 —— 那种情况由 skipped 判定放行并打印，不判红。',
      generatedAt: new Date().toISOString(),
      total,
      files: counts,
    };
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
    console.log('已写入 ' + OUT);
    if (skipped.length) {
      console.log('注意：本次有 ' + skipped.length + ' 个脚本因环境跳过（基线条数会偏低）：');
      for (const s of skipped) console.log('  ~ ' + s.file + '：' + s.reason);
    }
    return;
  }

  if (!fs.existsSync(OUT)) {
    console.error('没有基线文件 ' + OUT + '，先跑一次 --write');
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const skippedMap = new Map(skipped.map((s) => [s.file, s.reason]));
  const dropped = [];
  const skippedShort = [];
  for (const [f, n] of Object.entries(base.files)) {
    const now = counts[f] || 0;
    if (now >= n) continue;
    if (skippedMap.has(f)) {
      skippedShort.push(f + '：基线 ' + n + ' → 现在 ' + now + '（环境跳过：' + skippedMap.get(f) + '）');
    } else {
      dropped.push(f + '：基线 ' + n + ' → 现在 ' + now + '（少 ' + (n - now) + ' 条）');
    }
  }
  const grown = [];
  let grew = 0;
  for (const [f, n] of Object.entries(counts)) {
    const b = base.files[f] || 0;
    if (n > b) { grown.push(f + '：' + b + ' → ' + n + '（+' + (n - b) + '）'); grew += n - b; }
  }

  if (dropped.length) {
    console.log('\nFAIL  有测试文件的断言数比基线少：');
    for (const d of dropped) console.log('  · ' + d);
    console.log('\n如果这是有意删除，请跑 `node scripts/check-assertion-count.js --write` 重拍基线');
    console.log('（那一步会出现在 diff 里，评审时能看见「这次真的少测了 N 条」）。');
    if (skippedShort.length) {
      console.log('\n另外这些是因环境跳过（不算违规，仅列出）：');
      for (const s of skippedShort) console.log('  ~ ' + s);
    }
    process.exit(1);
  }
  console.log('PASS  没有文件比基线少');
  /* 【环境跳过必须打印出来，不能默默放过】
   * 它们不判红（那是本机条件不足），但「这次少测了 N 条」这个事实要看得见。
   * 否则这道守卫会给出一种虚假的安心：全绿，而实际有一批断言根本没跑。 */
  if (skippedShort.length) {
    const shortN = skippedShort.reduce((n, s) => {
      const m = /基线 (\d+) → 现在 (\d+)/.exec(s);
      return n + (m ? (+m[1] - +m[2]) : 0);
    }, 0);
    console.log('\n注意：' + skippedShort.length + ' 个脚本因本机环境跳过，合计少跑约 ' + shortN + ' 条断言：');
    for (const s of skippedShort) console.log('  ~ ' + s);
    console.log('（这些不判红 —— 依赖第二块盘 / 交互式桌面 / electron 起得来，'
      + '换台机器就会正常跑。但它们确实没跑，别把这里的「PASS」当成「全测过了」。）');
  }
  if (notRunAtAll.length) {
    console.log('\n注意：基线里有 ' + notRunAtAll.length + ' 个脚本本次根本没出现在输出里：');
    for (const f of notRunAtAll.slice(0, 10)) console.log('  ? ' + f);
    if (notRunAtAll.length > 10) console.log('  …还有 ' + (notRunAtAll.length - 10) + ' 个');
  }
  if (grown.length) {
    console.log('\n断言数增加了 ' + grew + ' 条（基线可以调大）：');
    for (const g of grown.slice(0, 20)) console.log('  + ' + g);
    if (grown.length > 20) console.log('  …还有 ' + (grown.length - 20) + ' 个文件');
  }
}

if (require.main === module) main();
module.exports = { parseByFile, runAll };