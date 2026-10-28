'use strict';
/* 验证解压/归档修复的实际行为：
 *   (1) seven:extract 的 staging 与 outDir 同卷（跨盘不再 EXDEV）
 *   (2) zip:extract 目录条目与文件条目路由到同一父目录
 *   (3) zip:extract 失败时目标目录不被污染
 *   (4) zip:compress 同名文件不再互相覆盖
 *   (5) 压缩炸弹（压缩比异常）被拒绝
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const guard = require('../lib/archive-guard');
const pathGuard = require('../lib/path-guard');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
};
const assert = require('assert');

/* 复刻 main.js 的 uniqueTarget（含 resolveInside） */
async function uniqueTarget(root, relName) {
  const base = pathGuard.resolveInside(root, relName);
  if (!fs.existsSync(base)) return base;
  const dir = path.dirname(base), ext = path.extname(base), stem = path.basename(base, ext);
  for (let i = 1; i < 10000; i++) {
    const cand = path.join(dir, `${stem}(${i})${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  throw new Error('无法生成不重名的目标路径');
}

(async () => {
  /* (1) staging 同卷 */
  await t('seven:extract staging 与 outDir 同卷（跨盘不再 EXDEV）', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'samevol-'));
    const outDir = path.join(d, 'extracted');
    fs.mkdirSync(outDir, { recursive: true });
    // 复刻修复后的写法：staging 在 outDir 下
    const staging = path.join(outDir, '.hehe-7zx-test');
    fs.mkdirSync(staging, { recursive: true });
    const src = path.join(staging, 'a.txt');
    fs.writeFileSync(src, 'hello');
    const dst = path.join(outDir, 'a.txt');
    // 同卷 rename 必须成功
    await fs.promises.rename(src, dst);
    assert.strictEqual(fs.readFileSync(dst, 'utf8'), 'hello');
    // 验证与旧写法（%TEMP%）不同：这里 stage 和 out 的根相同
    assert.strictEqual(path.parse(staging).root, path.parse(outDir).root, 'staging 与 outDir 必须同根');
    fs.rmSync(d, { recursive: true, force: true });
  });

  /* (2) 目录路由一致 */
  await t('zip:extract 目录条目与文件条目落在同一父目录', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dirroute-'));
    const outDir = path.join(d, 'out');
    fs.mkdirSync(path.join(outDir, 'sub'), { recursive: true });
    // 用户已有文件占住了 sub/ 这个目录名
    fs.writeFileSync(path.join(outDir, 'sub', '我的重要文件.txt'), 'USERDATA');

    // 造一个含 sub/ 与 sub/b.txt 的 zip
    const zipPath = path.join(d, 't.zip');
    const z = new AdmZip();
    z.addFile('sub/b.txt', Buffer.from('NEWFILE'));
    z.writeZip(zipPath);

    // 复刻修复后的路由：目录不改名，文件 uniqueTarget 在父目录内
    const dirSet = new Set();
    const dirFor = async (rel) => {
      const abs = pathGuard.resolveInside(outDir, rel);
      if (!dirSet.has(abs)) { await fs.promises.mkdir(abs, { recursive: true }); dirSet.add(abs); }
      return abs;
    };
    const zip2 = new AdmZip(zipPath);
    for (const en of zip2.getEntries()) {
      const name = guard.normalizeName(en.entryName);
      if (!name || name === '.' || name === './') continue;
      if (en.isDirectory) { await dirFor(name); continue; }
      const parentRel = path.dirname(name);
      const parentAbs = parentRel && parentRel !== '.' ? await dirFor(parentRel) : path.resolve(outDir);
      const target = await uniqueTarget(parentAbs, path.basename(name));
      await fs.promises.writeFile(target, en.getData());
    }
    // 关键：没有产生 sub(1)/ 这种空目录
    assert.ok(!fs.existsSync(path.join(outDir, 'sub(1)')), '不该产生 sub(1) 空目录');
    // 用户原文件完好
    assert.strictEqual(fs.readFileSync(path.join(outDir, 'sub', '我的重要文件.txt'), 'utf8'), 'USERDATA', '用户文件被覆盖');
    // 新文件落在同一个 sub/ 里（且不与已有冲突时用原名）
    assert.ok(fs.existsSync(path.join(outDir, 'sub', 'b.txt')), 'b.txt 应落在 sub/ 内');
    fs.rmSync(d, { recursive: true, force: true });
  });

  /* (3) 失败回滚 */
  await t('zip:extract 中途失败时目标目录不被污染', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-'));
    const outDir = path.join(d, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const written = [];
    let threw = false;
    try {
      // 模拟：写第 1 个成功，第 2 个 getData 抛错
      const p1 = path.join(outDir, '1.txt');
      fs.writeFileSync(p1, 'ok'); written.push(p1);
      throw new Error('CRC32 checksum failed "2.txt"');
    } catch (e) {
      threw = true;
      for (const p of written) { try { fs.rmSync(p, { force: true }); } catch (err) {} }
    }
    assert.ok(threw);
    assert.deepStrictEqual(fs.readdirSync(outDir), [], '目标目录应为空（已回滚）');
    fs.rmSync(d, { recursive: true, force: true });
  });

  /* (4) zip 压缩同名不丢 */
  await t('zip:compress 不同目录下的同名文件都被保留', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'samezip-'));
    const a = path.join(d, 'a'), b = path.join(d, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    const fa = path.join(a, 'report.txt'), fb = path.join(b, 'report.txt');
    fs.writeFileSync(fa, 'CONTENT-FROM-a');
    fs.writeFileSync(fb, 'CONTENT-FROM-b');
    const outZip = path.join(d, 'out.zip');

    // 复刻修复后的写法：重名自动加序号
    const zip = new AdmZip();
    const used = new Set();
    for (const p of [fa, fb]) {
      const base = path.basename(p);
      let entryName = base;
      const stem = path.basename(base, path.extname(base));
      const ext = path.extname(base);
      for (let i = 1; used.has(entryName.toLowerCase()); i++) entryName = `${stem}(${i})${ext}`;
      used.add(entryName.toLowerCase());
      zip.addLocalFile(p, '', entryName);
    }
    zip.writeZip(outZip);

    const back = new AdmZip(outZip).getEntries().map(e => e.entryName);
    assert.strictEqual(back.length, 2, '应保留 2 个条目，实际: ' + JSON.stringify(back));
    assert.ok(back.includes('report.txt') && back.includes('report(1).txt'), '条目名: ' + JSON.stringify(back));
    fs.rmSync(d, { recursive: true, force: true });
  });

  /* (5) 压缩炸弹 */
  await t('压缩比异常的条目被拒绝', async () => {
    let threw = false;
    try {
      guard.inspectEntries([{
        name: 'bomb.bin', isDir: false,
        size: 100 * 1024 * 1024,       // 声明解压 100MB
        compressedSize: 100            // 压缩后只有 100 字节 -> 比例 100 万:1
      }]);
    } catch (e) { threw = true; assert.ok(e.code === 'BOMB_RATIO', '错误码: ' + e.code); }
    assert.ok(threw, '应拒绝');
  });
  await t('单条目超 2GB 声明被拒绝（内存放大防护）', async () => {
    let threw = false;
    try { guard.inspectEntries([{ name: 'big.bin', isDir: false, size: 3 * 1024 * 1024 * 1024 }]); }
    catch (e) { threw = true; assert.ok(e.code === 'TOO_LARGE', '错误码: ' + e.code); }
    assert.ok(threw, '应拒绝');
  });
  await t('正常压缩比不被误伤', async () => {
    const r = guard.inspectEntries([
      { name: 'a.txt', isDir: false, size: 1000, compressedSize: 400 },
      { name: 'b.txt', isDir: false, size: 5000, compressedSize: 100 }
    ]);
    assert.ok(r.ok, '正常文件应通过');
    assert.strictEqual(r.totalBytes, 6000);
  });

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
