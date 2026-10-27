'use strict';
/* lib/archive-guard.js 的单元测试：恶意条目必须被拒，正常条目必须放行。
 * 用法：node scripts/test-archive-guard.js
 */
const assert = require('assert');
const path = require('path');
const guard = require('../lib/archive-guard');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
}
function expectCode(fn, code) {
  let got = null;
  try { fn(); } catch (e) { got = e.code || 'NO_CODE'; }
  assert.strictEqual(got, code, '期望错误码 ' + code + '，实际 ' + got);
}

/* ---------- 应当拒绝 ---------- */
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

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
