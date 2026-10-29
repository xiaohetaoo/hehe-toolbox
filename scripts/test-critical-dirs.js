'use strict';
/* P0-1 回归：关键目录保护必须随系统盘符动态变化，不能硬编码 C:\。
 *
 * 旧实现把 C:\Windows、C:\Program Files 等九项写死。Windows 装在 D 盘时，
 * 整张安全网对系统目录完全失效（能直接删 D:\Windows\System32 里的文件）。
 */
const pg = require('../lib/path-guard');
const B = String.fromCharCode(92);
const p = (s) => s.split('/').join(B);

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };
const assert = require('assert');

/* ---- 1. 关键目录取自环境变量，而不是写死 C: ---- */
t('关键目录来自 SystemRoot / ProgramFiles 等环境变量', () => {
  const dirs = pg.criticalDirs();
  assert.ok(dirs.length >= 8, '关键目录数量异常: ' + dirs.length);
  const sysRoot = process.env.SystemRoot || process.env.windir;
  assert.ok(sysRoot, '本机应存在 SystemRoot');
  const norm = (x) => pg.normalizeForCompare(x);
  assert.ok(dirs.some((d) => norm(d) === norm(sysRoot)), '关键目录里缺少 SystemRoot: ' + sysRoot);
});

t('CRITICAL_DIRS 不再包含写死的 C 盘字符串（改为动态）', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'path-guard.js'), 'utf8');
  /* 旧实现的特征：一个数组里连续 9 行 C:\\ 开头的字符串 */
  const hardcodedBlock = /const CRITICAL_DIRS\s*=\s*\[\s*\n\s*'C:\\\\Windows'/;
  assert.ok(!hardcodedBlock.test(src), '仍存在硬编码的 CRITICAL_DIRS 数组');
});

/* ---- 2. 换系统盘后的行为 ---- */
t('模拟系统装在 D 盘：D:\\Windows 必须被拦', () => {
  const old = { ...process.env };
  process.env.SystemRoot = p('D:/Windows');
  process.env.windir = p('D:/Windows');
  process.env.ProgramFiles = p('D:/Program Files');
  pg.resetCriticalDirs();
  try {
    assert.ok(pg.checkDeletable(p('D:/Windows')), 'D:\\Windows 应被拦');
    assert.ok(pg.checkDeletable(p('D:/Windows/System32')), 'D:\\Windows\\System32 应被拦');
    assert.ok(pg.checkOverwritable(p('D:/Windows/System32/drivers/etc/hosts')), 'D 盘 hosts 应拒绝覆盖');
    assert.ok(pg.checkDeletable(p('D:/Program Files')), 'D:\\Program Files 应被拦');
  } finally {
    for (const k of Object.keys(old)) { if (/^(SystemRoot|windir|ProgramFiles)$/.test(k)) process.env[k] = old[k]; }
    pg.resetCriticalDirs();
  }
});

t('用户普通目录不被误伤', () => {
  for (const q of ['D:/myproject', 'D:/myproject/a.txt', 'C:/Users/67153/Desktop/a.txt']) {
    assert.ok(!pg.checkDeletable(p(q)), '误拦: ' + q);
  }
});

t('盘符根一律拒绝', () => {
  for (const d of ['C:', 'D:']) {
    assert.ok(pg.checkDeletable(p(d + '/')), '应拒绝删除盘符根 ' + d);
  }
});

t('用户主目录及其一层仍受保护', () => {
  const os = require('os');
  const home = os.homedir().split('/').join(B);
  assert.ok(pg.checkDeletable(home), '家目录本身应被拦');
});

/* ---- 3. 兼容性：旧名字仍可用 ---- */
t('CRITICAL_DIRS 旧名字仍能访问（Proxy 兼容）', () => {
  assert.ok(Array.isArray([...pg.CRITICAL_DIRS]), '展开应得到数组');
  assert.ok(pg.CRITICAL_DIRS.length > 0, 'length 应可读');
  assert.ok(typeof pg.CRITICAL_DIRS[0] === 'string', '索引访问应可用');
});

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
