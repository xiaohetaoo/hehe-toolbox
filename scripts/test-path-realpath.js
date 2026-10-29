'use strict';
/* P0-2 回归：junction / symlink 不能绕过关键目录判定。
 *
 * 旧实现只做字符串比较：在普通目录下建一个指向 C:\Windows 的 junction，
 * 路径字符串看起来无害，判定通过 → 递归删除能顺着链接删进系统目录。
 * 现在 canonical() 会先 realpath 再把判定建立在真实路径上。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pg = require('../lib/path-guard');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

const B = String.fromCharCode(92);
const p = (s) => s.split('/').join(B);

/* ---- 1. resolveReal 对普通路径的行为 ---- */
t('resolveReal 对不存在的路径用「父目录 realpath + 名字」', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  const target = path.join(dir, 'not-yet-created.txt');
  const r = pg.resolveReal(target);
  assert.ok(r.toLowerCase().endsWith('not-yet-created.txt'), '应保留文件名: ' + r);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('resolveReal 对已有路径返回真实路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr2-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'x');
  const r = pg.resolveReal(f);
  assert.ok(path.isAbsolute(r), '应返回绝对路径');
  assert.ok(r.toLowerCase().includes('a.txt'), '应包含文件名: ' + r);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---- 2. junction 真机测试（仅 Windows） ---- */
if (process.platform === 'win32') {
  t('junction 指向系统目录时，isCriticalPath 必须能识别（真机）', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'junc-'));
    const linkDir = path.join(tmpRoot, 'harmless');
    const sysDir = process.env.SystemRoot || 'C:' + B + 'Windows';

    // 用 mklink /J 建目录 junction（不需要管理员权限）
    let created = false;
    try {
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', linkDir, sysDir], { stdio: 'ignore' });
      created = fs.existsSync(linkDir);
    } catch (e) { created = false; }

    try {
      if (!created) {
        console.log('SKIP 无法创建 junction（可能权限不足），跳过真机部分');
        return;
      }
      // 链接本身指向系统目录 → 必须被判为关键路径
      assert.ok(pg.isCriticalPath(linkDir), 'junction 指向 Windows 却未被识别为关键目录');
      assert.ok(pg.checkDeletable(linkDir), '对 junction 的删除应被拒绝');
      // 更深一层同样要拦住
      assert.ok(pg.checkDeletable(path.join(linkDir, 'System32')), 'System32 子路径应被拒绝');
    } finally {
      try { fs.rmSync(linkDir, { recursive: true, force: true }); } catch (e) {}
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
    }
  });

  t('指向普通目录的 junction 不被误拦', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'junc2-'));
    const realDir = path.join(tmpRoot, 'real');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'a.txt'), 'x');
    const linkDir = path.join(tmpRoot, 'link');
    let created = false;
    try {
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', linkDir, realDir], { stdio: 'ignore' });
      created = fs.existsSync(linkDir);
    } catch (e) { created = false; }

    try {
      if (!created) { console.log('SKIP 无法创建 junction'); return; }
      assert.ok(!pg.checkDeletable(linkDir), '普通目录的 junction 不该被拦');
    } finally {
      try { fs.rmSync(linkDir, { recursive: true, force: true }); } catch (e) {}
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
    }
  });
}

/* ---- 3. 参数传反 / 闸门绕过（报告担心的「守卫本身写错」） ---- */
t('checkDeletable 对系统目录返回非空拒绝原因', () => {
  const sys = process.env.SystemRoot || 'C:' + B + 'Windows';
  const r = pg.checkDeletable(sys);
  assert.ok(r && r.code && r.reason, '应返回 {code, reason}');
  assert.strictEqual(r.code, 'CRITICAL', 'code 应为 CRITICAL');
});

t('checkDeletable 对普通文件返回 null（不误拦）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'x');
  assert.strictEqual(pg.checkDeletable(f), null, '普通文件不该被拦');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('checkOverwritable: 系统目录深层被拒，用户桌面可写', () => {
  const sys = process.env.SystemRoot || 'C:' + B + 'Windows';
  assert.ok(pg.checkOverwritable(path.join(sys, 'System32', 'drivers', 'etc', 'hosts')), '系统深层应拒绝覆盖');
  const desk = path.join(os.homedir(), 'Desktop', 'a.txt');
  assert.strictEqual(pg.checkOverwritable(desk), null, '用户桌面应可写');
});

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
