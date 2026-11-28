'use strict';

/* 【把 TEMP/TMP 指向工作区】本机安全软件拦 Chromium 子进程写 %TEMP%
 * （EPERM），而本脚本要把探针与结果落盘。工作区不在拦截名单里。
 * 详见 scripts/lib/electron-launch.js。进程退出时删除。 */
(function () {
  if (process.env.HEHE_TEST_TMP_READY) return;
  var p = require('path'), f = require('fs');
  var d = p.join(p.resolve(__dirname, '..'), '.tmp-testrun-' + process.pid);
  try {
    f.mkdirSync(d, { recursive: true });
    process.env.TEMP = d; process.env.TMP = d;
    process.env.HEHE_TEST_TMP_READY = '1';
    process.on('exit', function () { try { f.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  } catch (e) { /* 建不了就让失败如实暴露 */ }
})();
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
  const os = require('os');
  const home = os.homedir();
  /* 【不能硬编码 C:/Users/67153】
   * 这一行原来写死了开发机的用户名。R19 给 path-guard 加了 OTHER_HOME 规则
   * （别人家目录深处要拦），于是 `C:/Users/67153/...` 在**用户名不是 67153**
   * 的机器（如 CI 的 runneradmin）上会被正确判成"别人的家目录"而拦截 ——
   * 测试反而红了。被测的是"自己的普通目录不被误伤"，路径必须跟着当前用户走。 */
  const mine = [
    'D:/myproject',
    'D:/myproject/a.txt',
    home.replace(/\\/g, '/') + '/Desktop/a.txt',   // 自己的桌面：必须放行
  ];
  for (const q of mine) {
    assert.ok(!pg.checkDeletable(p(q)), '误拦（这是当前用户自己的目录）: ' + q);
  }
});

/* 【新增】别人的家目录深处必须拦 —— 与上面那条成对，锁住 R19 的核心判据。
 * 两条合起来才能表达"自己的放行、别人的拦住"，只测一边容易在改规则时误判。 */
t('别人的家目录深处必须拦（OTHER_HOME）', () => {
  const os = require('os');
  const home = os.homedir();
  const drive = home.slice(0, 2);           // 如 C:
  const other = drive + '\\Users\\__hehe_other_user__\\Documents\\deep\\a.txt';
  const r = pg.checkDeletable(other);
  assert.ok(r && r.code === 'OTHER_HOME', '别人家目录深处应判 OTHER_HOME，实际: ' + JSON.stringify(r));
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
  /* `D:foo` / `C:foo` 同样不是「D 盘根」，但原来的 /^[A-Za-z]:$/ 只认裸盘符，
   * 于是它们会 resolve 成「盘符当前目录」并一路放行。 */
  for (const bad of ['C:foo', 'D:foo', ' c:temp ']) {
    const d = pg.checkDeletable(bad);
    assert.ok(d && d.code === 'DRIVE_RELATIVE', 'checkDeletable 必须拒绝 ' + bad);
    const o = pg.checkOverwritable(bad);
    assert.ok(o && o.code === 'DRIVE_RELATIVE', 'checkOverwritable 必须拒绝 ' + bad);
    assert.strictEqual(pg.isProtectedForModify(bad).protected, true,
      'isProtectedForModify 必须拦 ' + bad);
  }
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
