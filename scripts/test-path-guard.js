'use strict';
/* 破坏性操作安全网测试（lib/path-guard.js）。
 *
 * 这些断言守护的是「用户数据被毁掉」的场景，比功能 bug 更严重。
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const guard = require('../lib/path-guard');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
}

/* ---------- 文件名检查 ---------- */
t('正常文件名通过', () => {
  for (const n of ['a.txt', 'IMG_0001.jpg', '中文名.png', 'file-1_2.tar.gz', '.gitignore']) {
    assert.strictEqual(guard.checkFileName(n), null, n + ' 应通过');
  }
});
t('路径分隔符被拒', () => {
  for (const n of ['a/b.txt', 'a\\b.txt', '../x.txt']) {
    assert.ok(guard.checkFileName(n), n + ' 应被拒');
  }
});
t('NTFS ADS 被拒', () => {
  assert.strictEqual(guard.checkFileName('a.txt:stream').code, 'ADS');
});
t('设备名被拒（含带扩展名形式）', () => {
  assert.strictEqual(guard.checkFileName('CON').code, 'DEVICE_NAME');
  assert.strictEqual(guard.checkFileName('con.txt').code, 'DEVICE_NAME');
  assert.strictEqual(guard.checkFileName('LPT1.log').code, 'DEVICE_NAME');
});
t('尾随点/空格被拒', () => {
  assert.strictEqual(guard.checkFileName('file.').code, 'TRAILING_DOT');
  assert.strictEqual(guard.checkFileName('file ').code, 'TRAILING_DOT');
});
t('Windows 非法字符被拒', () => {
  for (const n of ['a<b', 'a>b', 'a|b', 'a?b', 'a*b']) {
    assert.ok(guard.checkFileName(n), n + ' 应被拒');
  }
});
t('. 与 .. 被拒', () => {
  assert.ok(guard.checkFileName('.'));
  assert.ok(guard.checkFileName('..'));
});
t('空名被拒', () => {
  assert.strictEqual(guard.checkFileName('').code, 'EMPTY_NAME');
});

/* ---------- resolveInside ---------- */
t('resolveInside 允许正常的相对路径', () => {
  const root = path.resolve('C:/data');
  assert.strictEqual(guard.resolveInside(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.strictEqual(guard.resolveInside(root, './a.txt'), path.join(root, 'a.txt'));
});
t('resolveInside 拒绝 .. 穿越', () => {
  const root = path.resolve('C:/data');
  assert.throws(() => guard.resolveInside(root, '../evil.txt'), /超出|穿越/);
  assert.throws(() => guard.resolveInside(root, 'a/../../evil.txt'), /超出|穿越/);
});
t('resolveInside 拒绝绝对路径', () => {
  const root = path.resolve('C:/data');
  assert.throws(() => guard.resolveInside(root, 'C:/Windows/evil.txt'), /绝对路径/);
  assert.throws(() => guard.resolveInside(root, '/etc/passwd'), /绝对路径/);
});
t('resolveInside 拒绝 UNC', () => {
  const root = path.resolve('C:/data');
  assert.throws(() => guard.resolveInside(root, '//server/share/x'), /UNC/);
});
t('resolveInside 拒绝内含设备名的段', () => {
  const root = path.resolve('C:/data');
  assert.throws(() => guard.resolveInside(root, 'CON.txt'), /设备名/);
});
t('resolveInside 不会逃出根目录', () => {
  const root = path.resolve('C:/data');
  const r = guard.resolveInside(root, 'a/b/../c.txt');
  assert.ok(r.startsWith(root + path.sep), r + ' 应在 root 内');
});

/* ---------- 删除闸门 ---------- */
t('拒绝删除磁盘根目录', () => {
  for (const p of ['C:\\', 'D:/', 'C:/']) {
    const r = guard.checkDeletable(p, true);
    assert.ok(r, p + ' 应被拒绝');
  }
});
t('拒绝删除系统关键目录', () => {
  for (const p of ['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files',
                   'C:\\Users', 'C:\\ProgramData', 'C:\\$Recycle.Bin']) {
    const r = guard.checkDeletable(p, true);
    assert.ok(r, p + ' 应被拒绝');
  }
});
t('拒绝删除用户主目录本身', () => {
  const home = path.resolve(os.homedir());
  assert.ok(guard.checkDeletable(home, true), '主目录应被拒绝');
});
t('允许删除主目录下的普通子目录', () => {
  const sub = path.join(path.resolve(os.homedir()), 'Desktop', '某个文件夹');
  assert.strictEqual(guard.checkDeletable(sub, true), null, '普通子目录应放行');
});
t('允许删除临时目录', () => {
  assert.strictEqual(guard.checkDeletable(path.join(os.tmpdir(), 'hehe-x'), true), null);
});
t('空路径被拒', () => {
  assert.ok(guard.checkDeletable('', true));
  assert.ok(guard.checkDeletable(null, true));
});

/* ---------- 覆盖闸门 ---------- */
t('拒绝覆盖系统关键目录内的文件', () => {
  for (const p of ['C:\\Windows\\System32\\drivers\\etc\\hosts',
                   'C:\\Program Files\\app\\config.ini']) {
    assert.ok(guard.checkOverwritable(p), p + ' 应被拒绝');
  }
});
t('允许覆盖普通文件', () => {
  assert.strictEqual(guard.checkOverwritable('C:/Users/x/Desktop/notes.txt'), null);
});

/* ---------- 交叉验证：不能通过组合绕过 ---------- */
t('大写/混合大小写也逃不掉', () => {
  for (const p of ['c:\\windows', 'C:\\WINDOWS\\System32', 'C:\\pROGRAM fILES']) {
    assert.ok(guard.checkDeletable(p, true), p + ' 应被拒绝');
  }
});
t('带尾随分隔符也逃不掉', () => {
  assert.ok(guard.checkDeletable('C:\\Windows\\', true));
  assert.ok(guard.checkDeletable('C:\\Users\\', true));
});
t('UNC 形式的系统目录不被当作关键目录误伤普通路径', () => {
  // \\server\share 不在关键目录列表里，不应被 critical 规则拦
  assert.strictEqual(guard.isCriticalPath('\\\\server\\share\\folder'), false);
});

/* ---------- 尾随点/空格绕过（Windows 会静默去掉，必须归一化后再比较） ---------- */
t('尾随点不能绕过关键目录闸门', () => {
  for (const p of ['C:\\Windows.', 'C:\\Program Files.', 'C:\\$Recycle.Bin.',
                   'C:\\Users\\', 'C:\\ProgramData.']) {
    assert.ok(guard.checkDeletable(p, true), p + ' 应被拒绝');
  }
});
t('尾随空格不能绕过闸门', () => {
  for (const p of ['C:\\Windows ', 'C:\\Program Files ', 'C:\\ProgramData ']) {
    assert.ok(guard.checkDeletable(p, true), p + ' 应被拒绝');
  }
});
t('尾随点不能绕过覆盖闸门', () => {
  for (const p of ['C:\\Windows.\\System32\\x.ini', 'C:\\Program Files.\\a\\b.ini']) {
    assert.ok(guard.checkOverwritable(p), p + ' 应被拒绝');
  }
});
t('家目录加尾点也逃不掉', () => {
  const home = path.resolve(os.homedir());
  assert.ok(guard.checkDeletable(home + '.', true), '主目录尾点应被拒绝');
  assert.ok(guard.checkDeletable(home + ' ', true), '主目录尾空格应被拒绝');
});
t('normalizeForCompare 归一化正确', () => {
  assert.strictEqual(guard.normalizeForCompare('C:\\Windows.'), 'c:\\windows');
  assert.strictEqual(guard.normalizeForCompare('C:\\Windows '), 'c:\\windows');
  assert.strictEqual(guard.normalizeForCompare('C:\\Windows\\'), 'c:\\windows');
  assert.strictEqual(guard.normalizeForCompare('C:\\A.\\B.'), 'c:\\a\\b');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
