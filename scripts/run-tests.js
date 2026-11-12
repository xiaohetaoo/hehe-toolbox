'use strict';
/* 自动收集并串行运行 tests/*.js，替代 package.json 里那两行 4000 字符的 && 链。
 *
 * ============ 为什么需要它 ============
 * 原来的 test:unit / test:ui 是手写的 `node a.js && node b.js && …` 长串：
 *   · 加一个测试要改 package.json 里一行超长文本，容易漏、容易冲突
 *   · 手工分成 unit / ui 两组，放错组不会有任何提示
 *   · 已经出现过两次「测试文件写好了但没登记，等于没跑」
 *     （test-ctxmenu.js、test-harness.js 都是这样被漏掉的）
 *
 * ============ 分组判据 ============
 * 不按文件名硬编码，而是看两件事：
 *   1) 文件里有没有 require('electron') / execFileSync(electron.exe)
 *      → 需要 Electron 二进制（慢，属 UI 段）
 *   2) 是否登记在 SKIP / NEEDS_ENV 表里
 *      → 需要真实改注册表、真实剪贴板等，默认不跑
 *
 * ============ 为什么串行 ============
 * 这些测试有共享副作用（临时目录、系统剪贴板、注册表）。并行会引入
 * 偶发失败，而偶发失败比跑得慢糟糕得多 —— 人一旦习惯"重跑一次就好"，
 * 真正的回归也会被重跑掩盖。
 *
 * 用法：
 *   node scripts/run-tests.js            # 全部
 *   node scripts/run-tests.js --unit     # 只跑不需要 Electron 的
 *   node scripts/run-tests.js --ui       # 只跑需要 Electron 的
 *   node scripts/run-tests.js --list     # 只列出分组，不执行
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

/* 【必须单独列出的文件】
 * 不是"懒得自动判断"，而是这些文件的运行条件确实特殊，
 * 自动判断看不出来（它们语法上就是普通 Node 脚本）。 */
const NEEDS_ENV = {
  'test-ctxmenu.js': '会临时改 HKCU 注册表测 Win11 右键菜单，必须在真人机器上跑',
};

/* 【只靠退出码判定的脚本：成功记 1 条】
 * 这类脚本全程只打自己的可读输出（轮次明细之类）、不打印 PASS 行，
 * 结尾 process.exit(ok?0:1)。它们做的是实质性判定，若按「数 PASS 行」
 * 记 0 条，在基线里看起来像"一个测试都没跑"，删掉整个文件也不会报警。
 *
 * 【这张表必须与 check-assertion-count.js 的 EXIT_ONLY_FILES 保持一致】
 * 两处口径不同会让同一仓库报出两个总数（曾出现 run-tests 2118 / 基线 2119，
 * 差值恰好是这里的 1 条）。数字对不上时容易被误判成"有人删了测试"，
 * 反过来也可能掩盖真的少了一条。由 test-assertion-guard 对着两边做校验。 */
const EXIT_ONLY_TESTS = new Set(['test-target-e2e.js']);

/* 判断一个测试脚本要不要起 Electron。
 * 【为什么这里可以扫源码】这是**构建工具**，不是测试断言：
 * 它的工作就是读测试脚本、按内容分组，不读源码没有第二条路。
 * 与"测试去匹配源码形态"是两件事 —— 后者会因为实现改动而假红，
 * 这里只关心"有没有 require electron"这个语法事实。
 * 锁的是：三种起 Electron 的写法都要认出来（漏一种就把慢测试分进 unit 段）。
 */
function electronNeeded(src) {
  // 锁的是：直接 require electron（最常见）。
  const byRequire = /require\(['"]electron['"]\)/.test(src);
  // 锁的是：通过 electron.exe 路径起的（本项目多数 E2E 是这种）。
  const byExe = /electron\.exe/.test(src);
  // 锁的是：execFileSync('electron', [...]) 这种字符串首参形式。
  const byArgs = /electron['"],\s*\[/.test(src);
  return byRequire || byExe || byArgs;
}

/* 收集所有 scripts/test-*.js */
function collect() {
  const out = { unit: [], ui: [], skipped: [] };
  for (const f of fs.readdirSync(SCRIPTS).sort()) {
    if (!/^test-.*\.js$/.test(f)) continue;
    const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    if (NEEDS_ENV[f]) { out.skipped.push({ file: f, why: NEEDS_ENV[f] }); continue; }
    if (electronNeeded(src)) out.ui.push(f);
    else out.unit.push(f);
  }
  return out;
}

function runOne(file) {
  const t0 = Date.now();
  let ok = true;
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(SCRIPTS, file)], {
      encoding: 'utf8', timeout: 300000, stdio: 'pipe', cwd: ROOT,
    });
  } catch (e) {
    ok = false;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  return { file, ok, ms: Date.now() - t0, out };
}

function main() {
  const args = process.argv.slice(2);
  const groups = collect();

  if (args.includes('--list')) {
    /* 支持 --list --unit / --list --ui：调用方（check-assertion-count）要按分组
     * 分别取清单，否则两组都列出来会被统计两次。 */
    if (args.includes('--unit')) {
      groups.unit.forEach((f) => console.log('  ' + f));
      return 0;
    }
    if (args.includes('--ui')) {
      groups.ui.forEach((f) => console.log('  ' + f));
      return 0;
    }
    console.log('=== unit（不需要 Electron，' + groups.unit.length + ' 个）===');
    groups.unit.forEach((f) => console.log('  ' + f));
    console.log('\n=== ui（需要 Electron，' + groups.ui.length + ' 个）===');
    groups.ui.forEach((f) => console.log('  ' + f));
    console.log('\n=== skipped（需特殊环境，' + groups.skipped.length + ' 个）===');
    groups.skipped.forEach((s) => console.log('  ' + s.file + '  —  ' + s.why));
    const total = groups.unit.length + groups.ui.length;
    console.log('\n合计会跑 ' + total + ' 个，跳过 ' + groups.skipped.length + ' 个');
    return 0;
  }

  let list;
  if (args.includes('--unit')) list = groups.unit;
  else if (args.includes('--ui')) list = groups.ui;
  else list = groups.unit.concat(groups.ui);

  if (!list.length) { console.log('没有要跑的测试（分组为空）'); return 1; }

  /* 【不跳过 Electron 就直说】
   * CI 上没装 electron 二进制时，ui 段的脚本会各自 SKIP（它们内部有判断）。
   * 这里不预判、也不静默剔除 —— 让每个脚本自己决定，输出更诚实。 */
  const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const hasElectron = fs.existsSync(ELECTRON);
  if (!hasElectron && list.some((f) => groups.ui.includes(f))) {
    console.log('提示：未找到 electron.exe，依赖它的脚本会自行 SKIP');
  }

  const failed = [];
  const skipped = [];
  let passCount = 0;
  const t0 = Date.now();

  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const r = runOne(f);
    /* 【先打一行 @@FILE 标记，再透传脚本输出】
     * check-assertion-count.js 的 --no-run 靠「标记行 + 数其后的 PASS」来
     * 归集「每个文件多少条断言」。原来这里**从来不打这个标记**，
     * 于是 --no-run 读任何日志都解析成「0 个脚本 / 0 条」，
     * 它会把每个文件都报成「基线 N → 现在 0（少 N 条）」而全红。
     * 也就是说问题 16(c) 里指出的「CI 会跑两遍测试」这个绕法根本走不通 ——
     * 不是慢，是完全不可用。这里补上标记之后，CI 才能真正复用同一份日志。 */
    process.stdout.write('@@FILE ' + 'scripts/' + f + '\n');
    // 把每个脚本的输出原样透传（CI 日志要靠这些 PASS/FAIL 行）
    if (r.out) process.stdout.write(r.out);
    if (!r.ok) {
      failed.push({ file: f, out: r.out });
    } else if (/^SKIP /m.test(r.out)) {
      skipped.push(f);
    }
    const n = (r.out.match(/^PASS /gm) || []).length;
    passCount += n;
    /* 【进度行与汇总的条数要包含「只靠退出码判定的脚本」】
     * check-assertion-count.js 里有一张 EXIT_ONLY_FILES 表
     * （目前是 test-target-e2e.js）：这类脚本全程只打自己的可读输出、
     * 不打印 PASS 行，结尾 process.exit(ok?0:1)。守卫对它们按
     * 「成功记 1、失败记 0」来算，否则它们在基线里永远是 0，
     * 看起来像「一个测试都没跑」。
     *
     * 【为什么这里也要跟着算】原来 run-tests 只数 ^PASS 行，于是同一个
     * 仓库两处报出不同总数（run-tests 2118 / 基线 2119），差值恰好是
     * 这类脚本的 1 条。两个数字对不上时，最容易被当成"有人改了测试"，
     * 实际只是口径不同 —— 反过来也可能掩盖真的少了一条。
     * 现在两边用同一张表、同一套规则。 */
    const exitOnly = EXIT_ONLY_TESTS.has(f);
    if (exitOnly && r.ok && n === 0) passCount += 1;
    const shown = (exitOnly && r.ok && n === 0) ? 1 : n;
    // 进度行：脚本多的时候能看出跑到哪了
    process.stdout.write('[' + (i + 1) + '/' + list.length + '] ' + f + '  ' +
      (r.ok ? 'ok' : 'FAIL') + '  ' + (r.ms / 1000).toFixed(1) + 's  ' + shown + ' 条\n');
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n================================');
  console.log('脚本 ' + list.length + ' 个，PASS ' + passCount + ' 条，耗时 ' + total + 's');
  if (skipped.length) console.log('环境跳过 ' + skipped.length + ' 个：' + skipped.join(', '));
  if (failed.length) {
    console.log('\n失败 ' + failed.length + ' 个：');
    failed.forEach((f) => console.log('  ' + f.file));
    return 1;
  }
  console.log('全部通过');
  return 0;
}

process.exit(main());
