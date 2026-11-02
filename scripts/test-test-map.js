'use strict';
/* 测试覆盖地图（元测试）：每个 lib 模块被哪些测试文件直接引用。
 *
 * ============ 为什么需要它 ============
 * 测试文件是按**轮次**命名的（test-round8-fixes.js … test-round15-fixes.js，
 * 10 个文件 4665 行，占测试代码 25%）。想知道「搬家失败回滚有没有测」，
 * 得挨个 grep 七个文件。文件名不告诉你测的是什么，只有打开才知道。
 *
 * 但搬迁断言是下一轮的事。这一轮先解决一个更基础的问题：
 * **根本不知道哪些模块没被测过**。没有地图，就分不清"这个模块很稳"和
 * "这个模块没人管"——两者在 `npm test` 全绿时长得一模一样。
 *
 * 所以这里生成「模块 → 测试文件」的映射，并断言每个 lib 模块至少被引用一次。
 *
 * ============ 判定口径 ============
 * 只认**直接引用**，两种形态：
 *   · require('<路径>/lib/xxx')            —— 真跑这个模块
 *   · readSrc('lib/xxx.js') / read('lib/xxx.js') —— 读它的源码做断言
 * 不认"间接覆盖"（A require B，测试 require A）。间接覆盖是真实的，
 * 但它不能告诉我们「这个模块的行为有没有被单独验证过」——而那正是本表要回答的。
 *
 * 白名单里的模块要逐条写明「为什么只被间接引用是可接受的」。
 */

const fs = require('fs');
const path = require('path');

const { t, done, ROOT, readSrc } = require('./lib/harness');
const { stripComments } = require(path.join(ROOT, 'lib', 'src-scan'));

/* ============================================================
 * 白名单：确实没有独立测试、且理由成立的模块。
 * ============================================================ */
const EXEMPT = {
  'lib/errors.js': '纯常量表（错误码 → 中文文案）。本身无逻辑，'
    + '文案的正确性由各调用方断言（例如 test-fail-text 断言的失败文案拼装）。'
    + '为它单独写测试只会断言"常量等于常量"。'
    + '（它被 ipc/ 与 main.js 广泛 require，但那些调用点都在主进程里，'
    + '单个测试文件不会直接 require 它——所以本表里它是 0。）',
};

/* 【已撤掉的一条白名单】
 * lib/fs-ops.js 原先挂在这里，理由是"只被间接覆盖"。实测不成立：
 * scripts/test-round2-fixes.js 直接 require 了它（那是按轮次命名的文件，
 * 一开始没注意到）。TM-2 就是为这种情况设的——白名单只该收敛，
 * 一旦某模块已经有人测了，条目必须删掉，否则豁免表会越挂越长，
 * 最后变成"反正挂上去就绿了"。 */

/* 【已知局限，写在这里以免本表被当成"全覆盖"】
 * 按轮次命名的测试文件同样会 require lib 模块，本表一视同仁地统计它们
 * （不然覆盖率会假性偏低）。真正统计不到的是：测试通过 new Function 把
 * 源码**抽出来跑**的模块——那种情况下 require 语句不存在，只有 readSrc。
 * 好在 readSrc 这条路径也被算进"引用"了，所以漏得很少。
 * 另有极少数模块只被 main.js / ipc/ 使用，测试用 readMain() 整体读走，
 * 也不会出现在本表里；这类在 EXEMPT 中逐条说明。 */

/* ============================================================
 * 扫描
 * ============================================================ */
function listTests() {
  return fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((n) => /^test-.*\.js$/.test(n))
    .sort()
    .map((n) => 'scripts/' + n);
}

function listLibModules() {
  return fs.readdirSync(path.join(ROOT, 'lib'))
    .filter((n) => n.endsWith('.js'))
    .sort()
    .map((n) => 'lib/' + n);
}

/** 从一段（已剥注释的）源码里抽出它引用了哪些 lib 模块。 */
function libRefsIn(code) {
  const refs = new Set();
  /* 形态 1：require('../lib/xxx') / require('./lib/xxx') / require(path.join(ROOT,'lib','xxx')) */
  const reqRe = /require\s*\(\s*(?:path\s*\.\s*join\s*\(\s*[^,)]+,\s*)?(['"])((?:\.\.?\/)*lib\/[A-Za-z0-9_-]+)(?:\.js)?\1/g;
  for (const m of code.matchAll(reqRe)) refs.add('lib/' + path.basename(m[2]) + '.js');
  /* 形态 2：path.join(__dirname, '..', 'lib', 'xxx') 出现在 require 或 readFileSync 里 */
  const joinRe = /path\s*\.\s*join\s*\(([^)]*)\)/g;
  for (const m of code.matchAll(joinRe)) {
    const args = m[1];
    if (!/['"`]lib['"`]/.test(args)) continue;
    const fileM = /['"`]([A-Za-z0-9_-]+)(?:\.js)?['"`]\s*\)?\s*$/.exec(args)
      || /['"`]lib['"`]\s*,\s*['"`]([A-Za-z0-9_-]+)(?:\.js)?['"`]/.exec(args);
    if (fileM) refs.add('lib/' + fileM[1] + '.js');
  }
  /* 形态 3：readSrc('lib/xxx.js') / read('lib/xxx.js') / readTree 之类 */
  const srcRe = /(['"`])lib\/([A-Za-z0-9_-]+)(?:\.js)?\1/g;
  for (const m of code.matchAll(srcRe)) refs.add('lib/' + m[2] + '.js');
  return refs;
}

/* 建立映射：模块 → Set(测试文件) */
const modules = listLibModules();
const tests = listTests();
const map = new Map(modules.map((m) => [m, new Set()]));

for (const tf of tests) {
  /* 用 readSrc 而不是裸 readFileSync：它会剥注释，而注释里写着的
   * 'lib/xxx.js' 示例文字会把覆盖地图污染成假阳性。 */
  const code = readSrc(tf);
  /* 【排除自指】本文件的白名单里写着 'lib/errors.js' 这类字符串，
   * 扫描会把它当成"本文件引用了 errors.js"，于是 TM-2 判定白名单过期。
   * 元测试的字符串常量不是引用。 */
  if (tf === 'scripts/test-test-map.js') continue;
  for (const ref of libRefsIn(code)) {
    if (map.has(ref)) map.get(ref).add(tf);
  }
}

/* ============================================================
 * 用例
 * ============================================================ */
t('TM-1 每个 lib 模块都至少被一个测试文件直接引用（或已白名单说明）', () => {
  const orphans = [];
  for (const [mod, files] of map) {
    if (files.size === 0 && !EXEMPT[mod]) orphans.push(mod);
  }
  if (orphans.length) {
    throw new Error('这些模块没有任何测试直接引用它（lib 里的代码是最容易被"改坏了没人知道"的一层）：\n  '
      + orphans.join('\n  ')
      + '\n\n要么补测试，要么在 EXEMPT 里写明为什么只被间接覆盖是可接受的。');
  }
});

t('TM-2 白名单没有过期条目（模块已存在且有测试，却还挂在豁免里）', () => {
  const stale = [];
  for (const mod of Object.keys(EXEMPT)) {
    if (!fs.existsSync(path.join(ROOT, mod))) { stale.push(mod + '：文件不存在'); continue; }
    const files = map.get(mod);
    if (files && files.size > 0) stale.push(mod + '：已有测试引用（' + [...files].join(', ') + '）');
  }
  if (stale.length) throw new Error('白名单里的这些条目已经不需要了，请删掉：\n  ' + stale.join('\n  '));
});

t('TM-3 白名单每条都写了理由（不是"先挂上去再说"）', () => {
  const bad = Object.keys(EXEMPT).filter((m) => !EXEMPT[m] || EXEMPT[m].length < 20);
  if (bad.length) throw new Error('这些白名单条目没写清理由：' + bad.join(', '));
});

t('TM-4 扫描逻辑自身没有静默失效（至少认出了大部分模块和测试）', () => {
  /* 【为什么要断言这个】
   * 这个脚本的价值全在"能认出来"。如果哪天 lib 目录改名、或测试文件的
   * require 写法变了，扫描结果可能是"全都没引用"——那时 TM-1 会红一大片，
   * 人第一反应是"补测试"而不是"扫描坏了"。
   * 反过来如果扫描写宽了（把任意字符串都当引用），TM-1 会永远绿。
   * 所以这里两头都设闸：既要有足够的模块被认出，也要有足够的测试参与。 */
  const covered = [...map.values()].filter((s) => s.size > 0).length;
  if (modules.length < 15) throw new Error('lib 模块数只有 ' + modules.length + '，扫描范围可能错了');
  if (tests.length < 50) throw new Error('测试文件数只有 ' + tests.length + '，扫描范围可能错了');
  if (covered < modules.length * 0.8) {
    throw new Error('只有 ' + covered + '/' + modules.length + ' 个模块被认出，'
      + '低于 80% —— 更像是扫描逻辑失效而不是真的都没测');
  }
});

t('TM-5 打印覆盖地图（只打印，不做断言）', () => {
  const rows = [...map.entries()]
    .map(([mod, files]) => ({ mod, files: [...files].sort() }))
    .sort((a, b) => a.files.length - b.files.length || a.mod.localeCompare(b.mod));

  console.log('\n  ── lib 模块 → 测试文件 ────────────────────────');
  for (const r of rows) {
    const tag = r.files.length === 0 ? (EXEMPT[r.mod] ? '（白名单）' : '  ⚠ 无测试') : '';
    console.log('  ' + r.mod.padEnd(24) + String(r.files.length).padStart(2) + ' 个  '
      + (r.files.length ? r.files.map((f) => f.replace('scripts/', '')).join(', ') : '—') + tag);
  }
  const covered = rows.filter((r) => r.files.length > 0).length;
  console.log('  ──────────────────────────────────────────────');
  console.log('  合计 ' + covered + '/' + rows.length + ' 个模块有直接测试引用，'
    + Object.keys(EXEMPT).length + ' 个白名单');
  console.log('  ──────────────────────────────────────────────\n');
  if (!rows.length) throw new Error('映射是空的——扫描坏了');
});

done();
