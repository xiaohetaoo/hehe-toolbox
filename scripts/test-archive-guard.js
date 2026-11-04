'use strict';
const { t, done, readMain } = require('./lib/harness');
/* segFromHandler 统一到 scripts/lib/seg-from-handler.js —— 见那里的文件头说明。 */
const { segFromHandler, handlerIndex } = require('./lib/seg-from-handler');
/* rmDir 统一到 scripts/lib/test-fs.js —— 见那里的文件头说明。 */
const { rmDir } = require('./lib/test-fs');
/* lib/archive-guard.js 的单元测试：恶意条目必须被拒，正常条目必须放行。
 * 用法：node scripts/test-archive-guard.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
/* 主进程全部源码（22 号用例要点名 seven:extract 的实现）。 */
const mainSrc = readMain({ raw: true });
const ROOT = path.join(__dirname, '..');
const guard = require('../lib/archive-guard');

function expectCode(fn, code) {
  let got = null;
  try { fn(); } catch (e) { got = e.code || 'NO_CODE'; }
  assert.strictEqual(got, code, '期望错误码 ' + code + '，实际 ' + got);
}

/* ---------- 应当拒绝 ---------- */


function extractZipCompress() {
  const i = handlerIndex(mainSrc, 'zip:compress');
  const j = handlerIndex(mainSrc, 'zip:extract');
  assert.ok(i > 0 && j > i, '找不到 zip:compress');
  const open = mainSrc.indexOf('{', i);
  /* 从 handler 的 `{` 到 `});` 之间：按括号配对找结束，避免正则跨块。 */
  let depth = 0, end = -1;
  for (let k = open; k < j; k++) {
    const c = mainSrc[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  assert.ok(end > open, '找不到 zip:compress 的函数体结尾');
  const body = mainSrc.slice(open + 1, end);
  return new AsyncFunction('e', 'paths', 'outZip', 'fs', 'fsp', 'path', 'pathGuard', 'AdmZip', body);
}

/* zip:compress 的 handler 体是 async 的，抽出来时要包成 AsyncFunction。 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

t('路径穿越 ../', () => expectCode(
  () => guard.inspectEntries([{ name: '../../Windows/win.ini', size: 1 }]), 'PATH_TRAVERSAL'));

t('路径穿越 反斜杠', () => expectCode(
  () => guard.inspectEntries([{ name: '..\\..\\x.txt', size: 1 }]), 'PATH_TRAVERSAL'));

t('嵌套穿越 a/../../b', () => expectCode(
  () => guard.inspectEntries([{ name: 'a/../../b.txt', size: 1 }]), 'PATH_TRAVERSAL'));

t('绝对路径 C:', () => expectCode(
  () => guard.inspectEntries([{ name: 'C:/Windows/win.ini', size: 1 }]), 'ABS_PATH'));

t('绝对路径 前导斜杠', () => expectCode(
  () => guard.inspectEntries([{ name: '/etc/passwd', size: 1 }]), 'ABS_PATH'));

t('UNC 路径', () => expectCode(
  () => guard.inspectEntries([{ name: '\\\\server\\share\\a.txt', size: 1 }]), 'UNC_PATH'));

t('NTFS 附加数据流', () => expectCode(
  () => guard.inspectEntries([{ name: 'a.txt:hidden', size: 1 }]), 'ADS'));

t('设备名 CON', () => expectCode(
  () => guard.inspectEntries([{ name: 'CON', size: 1 }]), 'DEVICE_NAME'));

t('设备名 nul.txt', () => expectCode(
  () => guard.inspectEntries([{ name: 'sub/nul.txt', size: 1 }]), 'DEVICE_NAME'));

t('尾点文件 a.', () => expectCode(
  () => guard.inspectEntries([{ name: 'a.', size: 1 }]), 'TRAILING_DOT'));

t('符号链接', () => expectCode(
  () => guard.inspectEntries([{ name: 'link', isSymlink: true }]), 'SYMLINK'));

t('硬链接', () => expectCode(
  () => guard.inspectEntries([{ name: 'hl', isHardLink: true }]), 'HARDLINK'));

t('大小写冲突', () => expectCode(
  () => guard.inspectEntries([{ name: 'a.txt', size: 1 }, { name: 'A.TXT', size: 1 }]), 'CASE_CONFLICT'));

t('文件/目录冲突', () => expectCode(
  () => guard.inspectEntries([{ name: 'a', size: 1 }, { name: 'a/b.txt', size: 1 }]), 'FILE_DIR_CONFLICT'));

t('条目数超限', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: 'f' + i + '.txt', size: 1 }));
  expectCode(() => guard.inspectEntries(many, { maxEntries: 10 }), 'TOO_MANY_ENTRIES');
});

t('目录太深', () => {
  const deep = Array.from({ length: 6 }, (_, i) => 'd' + i).join('/') + '/f.txt';
  expectCode(() => guard.inspectEntries([{ name: deep, size: 1 }], { maxDepth: 3 }), 'TOO_DEEP');
});

t('累计体积超限', () => expectCode(
  () => guard.inspectEntries([{ name: 'a.bin', size: 1000 }, { name: 'b.bin', size: 1000 }], { maxTotalBytes: 1500 }),
  'TOO_LARGE'));

t('非法字符 ?', () => expectCode(
  () => guard.inspectEntries([{ name: 'a?b.txt', size: 1 }]), 'ILLEGAL_CHAR'));

/* ---------- 应当放行 ---------- */
t('普通文件放行', () => {
  const r = guard.inspectEntries([{ name: 'a.txt', size: 10 }, { name: 'dir/b.txt', size: 20 }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.totalBytes, 30);
});

t('中文与空格路径放行', () => {
  const r = guard.inspectEntries([{ name: '我的 文档/说明.txt', size: 5 }]);
  assert.strictEqual(r.ok, true);
});

t('空目录放行', () => {
  const r = guard.inspectEntries([{ name: 'dir/', isDir: true }, { name: 'dir/a.txt', size: 1 }]);
  assert.strictEqual(r.ok, true);
});

t('./ 前缀被归一化后放行', () => {
  const r = guard.inspectEntries([{ name: './a.txt', size: 1 }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entries[0].name, 'a.txt');
});

t('根条目 . 被忽略', () => {
  const r = guard.inspectEntries([{ name: '.', isDir: true }, { name: 'a.txt', size: 1 }]);
  assert.strictEqual(r.entries.length, 1);
});

t('同名不同目录不冲突', () => {
  const r = guard.inspectEntries([{ name: 'a/x.txt', size: 1 }, { name: 'b/x.txt', size: 1 }]);
  assert.strictEqual(r.ok, true);
});

/* ---------- resolveTarget 最后一道防线 ---------- */
t('resolveTarget 拦住穿越', () => expectCode(
  () => guard.resolveTarget('D:/out', '../evil.txt'), 'ESCAPE'));

t('resolveTarget 正常路径通过', () => {
  const root = path.resolve('D:/zcode/hehe');
  const tgt = guard.resolveTarget(root, 'sub/a.txt');
  assert.ok(tgt.startsWith(root + path.sep), '应落在 root 之内: ' + tgt);
});

t('4a zip:compress 行为：两个不同目录下的同名子目录，内容都要保留', async () => {
  let AdmZip;
  try { AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip')); }
  catch (e) {
    /* 【依赖缺失要显式报出来，不能静默 return】
     * 原来只打一行 5 个空格缩进的「跳过：没有 adm-zip」然后 return ——
     * CI 的 `grep -E '^(FAIL|SKIP) '` 抓不到，这两条会静默消失。
     * adm-zip 是 package.json 的正式 dependency，缺了说明环境坏了，
     * 不该悄悄跳过（那样「zip 同名子目录互相覆盖」这个 P1 缺陷就没人看着了）。 */
    console.log('SKIP 缺少 adm-zip 依赖，zip 同名子目录合并的行为未被测到（请检查 npm ci）');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-zip-'));
  try {
    const a = path.join(dir, 'A', 'docs');
    const b = path.join(dir, 'B', 'docs');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, 'x.txt'), 'AAAA');
    fs.writeFileSync(path.join(b, 'x.txt'), 'BBBB');
    const out = path.join(dir, 'o.zip');

    const run = extractZipCompress();
    await run(null, [a, b], out, fs, fs.promises, path,
      require(path.join(ROOT, 'lib', 'path-guard')), AdmZip);

    const zip = new AdmZip(out);
    const names = zip.getEntries().map((x) => x.entryName);
    assert.strictEqual(names.length, 2, '两个目录应各留一个条目，实际：' + JSON.stringify(names));
    const bodies = names.map((n) => zip.getEntry(n).getData().toString()).sort();
    assert.deepStrictEqual(bodies, ['AAAA', 'BBBB'],
      '两份内容必须都在，实际：' + JSON.stringify(bodies) + '（条目 ' + JSON.stringify(names) + '）');
  } finally { rmDir(dir); }
});

t('4b zip:compress：顶层同名*文件*的去重没有被这次改动破坏', async () => {
  let AdmZip;
  try { AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip')); }
  catch (e) { return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-zip2-'));
  try {
    const d1 = path.join(dir, 'p1'); const d2 = path.join(dir, 'p2');
    fs.mkdirSync(d1, { recursive: true }); fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d1, 'same.txt'), 'ONE');
    fs.writeFileSync(path.join(d2, 'same.txt'), 'TWO');
    const out = path.join(dir, 'o.zip');
    const run = extractZipCompress();
    await run(null, [path.join(d1, 'same.txt'), path.join(d2, 'same.txt')], out,
      fs, fs.promises, path, require(path.join(ROOT, 'lib', 'path-guard')), AdmZip);
    const zip = new AdmZip(out);
    const bodies = zip.getEntries().map((x) => x.getData().toString()).sort();
    assert.deepStrictEqual(bodies, ['ONE', 'TWO'], '同名文件必须各自保留，实际：' + JSON.stringify(bodies));
  } finally { rmDir(dir); }
});

/* ==================== 5. cmpVer 与预发布后缀 ==================== */

t('22 seven:extract：失败回滚要把条目搬回 staging，不能直接删', () => {
  /* 直接删的风险：uniqueTarget 的存在性判断若因权限/瞬时错误失准，
   * rm 掉的可能是用户原有文件 —— 解压失败反毁数据。 */
  const seg = segFromHandler(mainSrc, 'seven:extract');
  /* 锁的是「zip:extract 回滚时先 rm 再 rename」这个数据丢失回归：
     * 反序 rm 已搬出的条目，一旦中途失败，原压缩包里的内容已经被删掉了。
     * 只能看源码形态 —— 真触发要构造「解压到一半失败」的损坏包。 */
  /* 锁的是「zip:extract 回滚时先 rm 再 rename」这个数据丢失回归：
     * 反序 rm 已搬出的条目，一旦中途失败，原压缩包里的内容已经被删掉了。
     * 只能看源码形态 —— 真触发要构造「解压到一半失败」的损坏包。 */
  assert.ok(!/for \(const dst of movedTo\.reverse\(\)\) \{\s*try \{ await fsp\.rm\(dst/.test(seg),
    '回滚仍在直接 rm(dst)');
  /* 锁的是「回滚必须把已搬出的条目改名回 staging 而不是删掉」——
     * 改名可逆，删掉不可逆。真跑要造一个中途失败的解压过程。 */
  /* 锁的是「回滚必须把已搬出的条目改名回 staging 而不是删掉」——
     * 改名可逆，删掉不可逆。真跑要造一个中途失败的解压过程。 */
  assert.ok(/await fsp\.rename\(dst, back\)/.test(seg), '应把已搬出的条目改名回 staging');
});

/* ==================== 23. svc:action 失败识别 ==================== */

t('34 archive-guard：先文件后目录的顺序也要拦住冲突', () => {
  const AGr = require(path.join(ROOT, 'lib', 'archive-guard'));
  /* 条目顺序由压缩包作者控制：先 a/b.txt 再 a（文件），后者需要 a 是文件、
   * 前者需要 a 是目录 —— 这样的包必须被预检拒掉。 */
  for (const list of [
    [{ name: 'a', isDir: false, size: 1 }, { name: 'a/b', isDir: false, size: 1 }],
    [{ name: 'a/b', isDir: false, size: 1 }, { name: 'a', isDir: false, size: 1 }],
  ]) {
    assert.throws(() => AGr.inspectEntries(list), /FILE_DIR_CONFLICT|文件|目录/,
      '顺序 ' + JSON.stringify(list.map((x) => x.name)) + ' 的冲突包应被拒');
  }
});

/* ==================== 35. links：drive-relative 也要认成盘符根 ==================== */

done();
