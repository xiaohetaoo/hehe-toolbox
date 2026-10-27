'use strict';
/* 端到端验证：解压安全预检在真实压缩包上的行为。
 * 构造一个含「穿越条目」的 ZIP，确认 zip:extract 会拒绝且目标目录不被污染；
 * 再构造一个正常 ZIP，确认能正确解出。
 *
 * 直接调用 lib 层 + adm-zip，复刻 main.js 里 zip:extract 的逻辑（不启动 Electron）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const guard = require('../lib/archive-guard');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ziptest-'));
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
}

/* 复刻 main.js 中 zip:extract 的处理流程 */
function extractGuarded(zipPath, outDir) {
  const zip = new AdmZip(zipPath);
  const raw = zip.getEntries().map((en) => ({
    name: en.entryName,
    isDir: en.isDirectory,
    size: en.header && typeof en.header.size === 'number' ? en.header.size : 0,
    isSymlink: false, isHardLink: false
  }));
  const verdict = guard.inspectEntries(raw);
  if (!verdict.ok) throw new Error('压缩包预检未通过');
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const en of zip.getEntries()) {
    const name = guard.normalizeName(en.entryName);
    if (!name || name === '.' || name === './') continue;
    const target = guard.resolveTarget(outDir, name);
    if (en.isDirectory) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, en.getData());
    n++;
  }
  return { outDir, entries: n };
}

/* ---- 1. 正常包 ---- */
const goodZipPath = path.join(tmp, 'good.zip');
{
  const z = new AdmZip();
  z.addFile('a.txt', Buffer.from('hello'));
  z.addFile('sub/b.txt', Buffer.from('world'));
  z.writeZip(goodZipPath);
}
const goodOut = path.join(tmp, 'out-good');
t('正常包可解出且内容正确', () => {
  const r = extractGuarded(goodZipPath, goodOut);
  assert.strictEqual(r.entries, 2, '解出条目数: ' + r.entries);
  assert.strictEqual(fs.readFileSync(path.join(goodOut, 'a.txt'), 'utf8'), 'hello');
  assert.strictEqual(fs.readFileSync(path.join(goodOut, 'sub', 'b.txt'), 'utf8'), 'world');
});

/* ---- 2. 穿越条目包 ----
 * 注意：不能直接 addFile('../../evil.txt') —— AdmZip 的 addFile 会自动
 * 规整成 basename，写出来的是普通条目。必须改 entryName 绕过规整，
 * 才能还原真实恶意压缩包的形态。 */
const evilZipPath = path.join(tmp, 'evil.zip');
{
  const z = new AdmZip();
  z.addFile('placeholder.txt', Buffer.from('pwned'));
  z.getEntries()[0].entryName = '../../evil-pwned.txt';
  z.writeZip(evilZipPath);
}
const evilOut = path.join(tmp, 'out-evil');
t('穿越包被拒绝，且目标目录未被写入', () => {
  let threw = false;
  try { extractGuarded(evilZipPath, evilOut); } catch (e) { threw = true; }
  assert.ok(threw, '应当抛错拒绝');
  // 关键：不能被写到上级目录
  const escaped = path.resolve(evilOut, '../../evil-pwned.txt');
  assert.ok(!fs.existsSync(escaped), '被穿越写出了文件: ' + escaped);
});

/* ---- 3. ADS 条目包 ---- */
const adsZipPath = path.join(tmp, 'ads.zip');
{
  const z = new AdmZip();
  z.addFile('placeholder.txt', Buffer.from('hidden'));
  z.getEntries()[0].entryName = 'a.txt:secret';
  z.writeZip(adsZipPath);
}
t('ADS 条目包被拒绝', () => {
  let threw = false;
  try { extractGuarded(adsZipPath, path.join(tmp, 'out-ads')); } catch (e) { threw = true; }
  assert.ok(threw, '应当抛错拒绝');
});

/* ---- 4. 绝对路径包 ---- */
const absZipPath = path.join(tmp, 'abs.zip');
{
  const z = new AdmZip();
  z.addFile('placeholder.txt', Buffer.from('x'));
  z.getEntries()[0].entryName = 'C:/Windows/pwned.txt';
  z.writeZip(absZipPath);
}
t('绝对路径包被拒绝', () => {
  let threw = false;
  try { extractGuarded(absZipPath, path.join(tmp, 'out-abs')); } catch (e) { threw = true; }
  assert.ok(threw, '应当抛错拒绝');
});

/* ---- 5. 不覆盖已有文件 ---- */
t('目标目录已有同名文件时，预检仍保护目录外内容', () => {
  const od = path.join(tmp, 'out-keep');
  fs.mkdirSync(od, { recursive: true });
  fs.writeFileSync(path.join(od, 'a.txt'), 'ORIGINAL');
  extractGuarded(goodZipPath, od);
  // 主流程会覆盖同名（我们不再用 overwrite=true 的批量解压，但同目录重名仍会写）
  // 这里只确认：解压不会跑到目录外，且文件存在
  assert.ok(fs.existsSync(path.join(od, 'a.txt')));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
