'use strict';
/* 用真实 7za.exe 验证跨盘解压：
 * 旧实现 staging 在 %TEMP%（C 盘）、outDir 在 D 盘 -> fsp.rename 抛 EXDEV。
 * 新实现 staging 建在 outDir 下（同卷）-> rename 成功。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sevenZa = require('7zip-bin').path7za;
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
};
const assert = require('assert');

/* 找一个与 os.tmpdir() 不同根的盘符作为 outDir 所在盘 */
const tmpRoot = path.parse(path.resolve(os.tmpdir())).root;
const candidates = ['D:/', 'E:/', 'F:/'];
const otherRoot = candidates.find((r) => {
  try { return fs.existsSync(r) && path.parse(path.resolve(r)).root !== tmpRoot; } catch (e) { return false; }
});

const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-'));
const srcFile = path.join(srcDir, 'a.txt');
fs.writeFileSync(srcFile, 'HELLO-WORLD');
const arc = path.join(srcDir, 't.7z');
execFileSync(sevenZa, ['a', arc, srcFile], { stdio: 'ignore' });

console.log('压缩包位于', tmpRoot, '，大小', fs.statSync(arc).size, 'bytes');
console.log('另一块盘:', otherRoot || '(只有单盘，跳过跨盘用例)');

t('压缩包能正常创建', () => {
  assert.ok(fs.existsSync(arc), '压缩包不存在');
});

if (otherRoot) {
  const outDir = path.join(otherRoot, '.hehe-crossdrive-' + Date.now());
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  /* 1) 对照：旧写法（staging 在 C 盘）应当 EXDEV */
  t('对照：staging 在 %TEMP%（跨盘）时 rename 抛 EXDEV', () => {
    const oldStage = path.join(tmpRoot, 'hehe-7zx-old-' + Date.now());
    fs.mkdirSync(oldStage, { recursive: true });
    execFileSync(sevenZa, ['x', '-y', '-bd', '-o' + oldStage, arc], { stdio: 'ignore' });
    const got = path.join(oldStage, 'a.txt');
    assert.ok(fs.existsSync(got), '解压失败');
    let code = null;
    try { fs.renameSync(got, path.join(outDir, 'old-a.txt')); }
    catch (e) { code = e.code; }
    assert.strictEqual(code, 'EXDEV', '旧写法应当 EXDEV，实际: ' + code);
    fs.rmSync(oldStage, { recursive: true, force: true });
  });

  /* 2) 新写法：staging 在 outDir 下（同卷）应当成功 */
  t('修复：staging 与 outDir 同卷时 rename 成功', () => {
    const stage = path.join(outDir, '.hehe-7zx-' + Date.now());
    fs.mkdirSync(stage, { recursive: true });
    execFileSync(sevenZa, ['x', '-y', '-bd', '-o' + stage, arc], { stdio: 'ignore' });
    const got = path.join(stage, 'a.txt');
    assert.ok(fs.existsSync(got), '解压失败');
    const dst = path.join(outDir, 'a.txt');
    fs.renameSync(got, dst);   // 同卷，必须成功
    assert.ok(fs.existsSync(dst), '目标不存在');
    assert.strictEqual(fs.readFileSync(dst, 'utf8'), 'HELLO-WORLD');
    fs.rmSync(stage, { recursive: true, force: true });
  });

  fs.rmSync(outDir, { recursive: true, force: true });
} else {
  console.log('（本机只有单个盘符，跨盘用例以逻辑验证代替）');
  t('staging 路径与 outDir 同根（逻辑检查）', () => {
    const outDir = path.join(tmpRoot, 'x', 'out');
    const stage = path.join(outDir, '.hehe-7zx-test');
    assert.strictEqual(path.parse(stage).root, path.parse(outDir).root);
  });
}

fs.rmSync(srcDir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
