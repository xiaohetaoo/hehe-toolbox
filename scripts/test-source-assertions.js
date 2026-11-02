'use strict';
/* 源码断言的守门员（元测试）。
 *
 * ============ 为什么需要这个文件 ============
 * scripts/lib/harness.js 顶部写了三条源码断言的规矩（锁的是哪个历史回归 /
 * 为什么不能用行为断言 / 匹配串锚定语义），但一直是**写在注释里给人看的**：
 *   · scripts/ 下 61 个脚本直接 readFileSync 读项目源码，只有 1 个用 readSrc
 *     （readSrc 会剥注释，而剥注释是源码断言的前提）
 *   · 「锁的是」三个字在全部 scripts 里只出现 5 次，而源码匹配断言有两百多条
 * 规矩没有否决权，就等于没有规矩——新写的断言可以随手复制隔壁的
 * `assert.ok(/xxx/.test(src))`，没人会拦。
 *
 * 所以这里把三条规矩里**能机械判定**的两条变成红灯：
 *   A. 裸 readFileSync 读项目源码（绕过 readSrc，注释可能被当成代码）
 *   B. 对源码文本做 .test/.includes/.match 的断言，上方必须有「锁的是」
 * 第三条（锚定语义而非版面）无法机械判定，继续靠人。
 *
 * ============ 为什么是「按文件的棘轮」而不是「逐行白名单」 ============
 * 存量 350 处（A 106 + B 244）。任务书原本设想「文件::行号」逐条登记，
 * 实测这个做法在这份代码上会**反向激励**：
 *   · 行号会漂——任何断言上方加一行注释，下面全错位，于是每次无关改动都要
 *     重生成基线；重生成一次就等于对三百多处集体点了一次"我知道了"。
 *   · 逐行登记等于把 244 条断言原文抄进白名单。它们本来就是要被淘汰的东西，
 *     抄一份反而成了第二份需要同步维护的源码。
 * 所以改成**每个文件记一对计数**（A 几条、B 几条）：
 *   · 超出基线 → 红，并报出「文件:行号 + 原文」（只报新增的，存量的不吵）
 *   · 低于基线 → 绿，但打印可直接粘贴的更新提示（让基线只能往下走）
 *   · 不在基线里 = 新文件 → 必须 A=0 且 B=0
 *
 * 【已知且接受的漏洞，写在这里以免被当成"已经全覆盖"】
 * 在同一文件里「删掉一条存量、再加一条新的」，计数不变，不会红。
 * 堵住它必须逐行登记原文，会带来上面说的反向激励。权衡后保留这个洞：
 * 真实的回归形态是把已有写法复制到新地方（计数 +1），而不是精确一比一替换。
 *
 * ============ 相关文件 ============
 *   scripts/lib/source-assert-scan.js              扫描内核（本文件与生成器共用）
 *   scripts/source-assertions-baseline.txt         存量基线（人工可编辑类别）
 *   scripts/gen-source-assertions-baseline.js      基线生成器（--write 才落盘）
 */

const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');
const scan = require('./lib/source-assert-scan');

const BASELINE_PATH = path.join(ROOT, 'scripts', 'source-assertions-baseline.txt');

/* ============================================================
 * 类别 → 理由。基线里的每一行都必须引用这里的一个类别（或 exact:具体理由），
 * 这样「为什么这个文件可以有违规」永远有答案。
 * ============================================================ */
const CATEGORIES = {
  'meta-self': '本元测试自身：它读别的脚本源码来做扫描，除了 readFileSync 没有第二条路；'
    + '它自己不写任何源码断言，只做文本统计。',
  'build-meta': '读的是构建元数据或发布产物（package.json / latest.yml / dist 下的文件 / '
    + 'docs/release-notes 的正文），不是应用源码逻辑；不参与行为断言，也没有剥注释的必要。',
  'e2e-fixture': 'e2e 夹具读取器：读的是测试自己在 %TEMP% 里写出来的临时文件'
    + '（结果 JSON、hosts 副本、解压产物、截图），不是项目源码。这类路径无法走 readSrc'
    + '（readSrc 只按项目根解析相对路径）。',
  'legacy-source-assertion': '存量源码断言：写于 harness 的规矩之前，锁的是真实发生过的回归，'
    + '但说明写在测试文件头部而不是每条断言上方。本轮只止住增量，不逐条回填——'
    + '回填会改动两百多条断言的上下文，风险大于收益。后续迁到模块测试时一并处理。',
  'legacy-read': '存量裸 readFileSync：读取的确实是项目源码，但脚本整体形态较老'
    + '（自带 read() 助手、或需要 raw 文本做长度/行号统计）。改成 readSrc 会改变其既有行为'
    + '（readSrc 默认剥注释），属于语义变更，本轮不动。新写的读取一律走 readSrc/readTree/readMain。',
};

/* ============================================================
 * 基线读取
 * ============================================================ */
function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    return { rows: new Map(), problems: ['基线文件不存在：scripts/source-assertions-baseline.txt'] };
  }
  const text = fs.readFileSync(BASELINE_PATH, 'utf8');
  const rows = new Map();
  const problems = [];
  text.split(/\r?\n/).forEach((ln, i) => {
    const s = ln.trim();
    if (!s || s.startsWith('#')) return;
    const parts = s.split('|').map((x) => x.trim());
    if (parts.length !== 4) {
      problems.push('第 ' + (i + 1) + ' 行应为「路径 | A=n | B=n | 类别」，实际：' + s.slice(0, 80));
      return;
    }
    const [file, aPart, bPart, cat] = parts;
    const a = /^A=(\d+)$/.exec(aPart);
    const b = /^B=(\d+)$/.exec(bPart);
    if (!a || !b) { problems.push('第 ' + (i + 1) + ' 行计数格式不对：' + aPart + ' / ' + bPart); return; }
    if (cat.startsWith('exact:')) {
      const why = cat.slice(6).trim();
      if (why.length < 8) { problems.push('第 ' + (i + 1) + ' 行 exact: 后面的理由太短或仍是占位符：' + why); return; }
      if (why.startsWith('待填')) { problems.push('第 ' + (i + 1) + ' 行类别还是占位符，请写明理由：' + file); return; }
    } else if (!CATEGORIES[cat]) {
      problems.push('第 ' + (i + 1) + ' 行引用了未登记的类别：' + cat);
      return;
    }
    if (rows.has(file)) { problems.push('第 ' + (i + 1) + ' 行重复登记：' + file); return; }
    rows.set(file, { A: Number(a[1]), B: Number(b[1]), cat });
  });
  return { rows, problems };
}

const base = loadBaseline();

/* ============================================================
 * 扫描 + 比对
 * ============================================================ */
const scanned = scan.scanAll();
const perFile = new Map(scanned.map((r) => [r.file, r]));

let aAll = 0, bAll = 0, bAnnotated = 0;
for (const r of scanned) {
  aAll += r.reads.length;
  bAll += r.asserts.length;
  for (const x of r.asserts) if (x.ok) bAnnotated++;
}

const overA = [];
const overB = [];
const unknownA = [];
const unknownB = [];
const slack = [];

for (const r of scanned) {
  const row = base.rows.get(r.file);
  const a = r.reads.length;
  const unannotated = r.asserts.filter((x) => !x.ok);
  const b = unannotated.length;
  if (!row) {
    if (a) unknownA.push({ file: r.file, items: r.reads });
    if (b) unknownB.push({ file: r.file, items: unannotated });
    continue;
  }
  if (a > row.A) overA.push({ file: r.file, items: r.reads.slice(row.A) });
  if (b > row.B) overB.push({ file: r.file, items: unannotated.slice(row.B) });
  if (a < row.A || b < row.B) slack.push({ file: r.file, A: a, B: b, wasA: row.A, wasB: row.B, cat: row.cat });
}

/** 把违规渲染成「文件:行号 -> 原文」，方便 CI annotation 直接定位。 */
function fmt(groups) {
  return groups.flatMap((g) => g.items.map(
    (x) => '  ' + g.file + ':' + x.line + '  ->  ' + x.text.slice(0, 100))).join('\n');
}
const countOf = (groups) => groups.reduce((n, g) => n + g.items.length, 0);

/* ============================================================
 * 用例
 * ============================================================ */
t('SA-1 基线文件格式合法（每行都引用了已登记的理由类别）', () => {
  if (base.problems.length) throw new Error(base.problems.join('\n  '));
  if (!base.rows.size) throw new Error('基线是空的——至少应该登记存量');
});

t('SA-2 基线里没有已不存在的脚本（防止改名后悄悄脱管）', () => {
  const gone = [...base.rows.keys()].filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (gone.length) {
    throw new Error('基线登记的这些文件已不存在（改名/删除后要同步基线，否则新文件会绕过检查）：\n  '
      + gone.join('\n  '));
  }
});

t('SA-3 没有新增的裸 readFileSync 读项目源码', () => {
  const total = countOf(unknownA) + countOf(overA);
  if (total) {
    throw new Error('新增了 ' + total + ' 处裸 readFileSync 读源码。'
      + '改用 readSrc/readTree/readMain（会自动剥注释）；确实不能改的，同步基线文件并写明理由：\n'
      + fmt([...unknownA, ...overA]));
  }
});

t('SA-4 没有新增的「没写锁的是」源码断言', () => {
  const total = countOf(unknownB) + countOf(overB);
  if (!total) return;
  throw new Error('新增了 ' + total + ' 条「没写锁的是」的源码匹配断言。'
    + '每条这样的断言上方三行内必须写清「锁的是……」'
    + '（锁的是哪个历史回归 + 为什么不能用行为断言替代）；能改写成行为断言的优先改写：\n'
    + fmt([...unknownB, ...overB]));
});

t('SA-5 基线只能收紧：低于基线的文件会打印提示（不判红）', () => {
  if (slack.length) {
    console.log('\n  以下文件的违规数已低于基线，请把基线数字改小（让这张表保持诚实）：');
    for (const s of slack) {
      console.log('    ' + s.file + ' | A=' + s.A + ' | B=' + s.B + ' | ' + s.cat
        + (s.wasA !== s.A || s.wasB !== s.B ? '     （原 A=' + s.wasA + ' B=' + s.wasB + '）' : ''));
    }
    console.log('');
  }
  /* 刻意不判红：判红会让「顺手修好一处」也变成一次构建失败，
   * 于是人们会关掉这个检查。改成每次打印，让落后可见。 */
});

t('SA-6 统计：当前源码断言的规模（只打印，不做断言）', () => {
  const baseA = [...base.rows.values()].reduce((n, r) => n + r.A, 0);
  const baseB = [...base.rows.values()].reduce((n, r) => n + r.B, 0);
  const withAssert = scanned.filter((r) => r.asserts.length).length;
  console.log('\n  ── 源码断言基线 ──────────────────────────────');
  console.log('  scripts 脚本数          : ' + scanned.length);
  console.log('  裸 readFileSync 总行数  : ' + aAll + '（基线 ' + baseA + '）');
  console.log('  源码匹配断言总数        : ' + bAll + '（基线登记的未注释数 ' + baseB + '）');
  console.log('  其中已写「锁的是」      : ' + bAnnotated
    + '（' + (bAll ? (bAnnotated / bAll * 100).toFixed(1) : '0') + '%）');
  console.log('  分布在                  : ' + withAssert + ' 个脚本');
  console.log('  基线登记的脚本          : ' + base.rows.size + ' 个');
  console.log('  ────────────────────────────────────────────\n');
  /* 这条用例真正的价值是让数字每次跑测试都出现在 CI 日志里，
   * 有人想"顺手加一条断言"时能看见分母。 */
  if (bAll === 0) throw new Error('一条源码断言都没扫到——扫描逻辑坏了');
  if (aAll === 0) throw new Error('一处 readFileSync 都没扫到——扫描逻辑坏了');
});

done();
