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
  /* 锁的是：「CRITICAL_DIRS 不再包含写死的 C 盘字符串（改为动态）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
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

/* ============ 第四轮审查：两类归一化缺口 ============ */
t('盘符相对写法 D: 必须被拒绝（resolve 后会变成 cwd）', () => {
  /* 锁的是：`D:` 被当成「D 盘当前目录」= 应用自己的工作目录。
   * 用户手输 D: 本意是 D 盘根，结果会删/搬应用目录。判据只认 D:\。 */
  const del = pg.checkDeletable('D:');
  assert.ok(del && del.code === 'DRIVE_RELATIVE', 'checkDeletable 必须拒绝 D:');
  const ow = pg.checkOverwritable('D:');
  assert.ok(ow && ow.code === 'DRIVE_RELATIVE', 'checkOverwritable 必须拒绝 D:');
  const mod = pg.isProtectedForModify('D:');
  assert.strictEqual(mod.protected, true, 'isProtectedForModify 必须拦 D:');
  /* 对照：显式盘符根与普通路径的结论不变 */
  assert.strictEqual(pg.checkDeletable(p('D:/')).code, 'ROOT', 'D:\\ 仍应判盘符根');
  assert.strictEqual(pg.checkDeletable(p('D:/normal/file.txt')), null, '普通文件路径不该被误伤');
});

t('\\\\?\\ 扩展长度前缀不能绕过关键目录闸门（realpath 失败时）', () => {
  /* 背景（实测）：普通用户对 System32\\config 没有读权限，realpath 抛 EPERM，
   * resolveReal 退回原路径；归一化若不剥 `\\?\` 前缀，就得到
   * `\\?\c:\windows\...` 与 `c:\windows\...` 对不上 → 闸门放行。
   * 判据不能依赖「realpath 恰好会成功」。路径按本机 SystemRoot 拼，
   * 免得测试机器系统盘不是 C:。 */
  const sys = process.env.SystemRoot || process.env.windir || p('C:/Windows');
  const prefixed = p('//?/' + sys.replace(/[\\/]+/g, '/') + '/System32/config/SAM');
  const del = pg.checkDeletable(prefixed);
  assert.ok(del && del.code === 'CRITICAL_DEEP', '带 \\\\?\\ 前缀的系统文件也必须拦，实际：' + JSON.stringify(del));
  const ow = pg.checkOverwritable(prefixed.replace(/config[\\/]SAM$/, p('drivers/etc/hosts')));
  assert.ok(ow && ow.code === 'CRITICAL', '带前缀的 hosts 覆盖也必须拦');
  /* 对照：前缀不改变「关键目录本身」的判定 */
  assert.strictEqual(pg.checkDeletable(p('//?/' + sys.replace(/[\\/]+/g, '/'))).code, 'CRITICAL');
});

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
