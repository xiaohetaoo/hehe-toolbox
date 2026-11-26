'use strict';
/* R21：路径 dirname/basename 的公共实现。
 *
 * 渲染层 10 个页面原来各写一份 `replace(/[\\\\/][^\\\\/]*$/, '')`，
 * 在 C:\\foo 上得到 C:（盘符相对路径）。这里锁住公共实现的边界：
 * 顶层文件、盘符根、尾斜杠目录、正斜杠、UNC、无目录。
 */

const { t, done, assert } = require('./lib/harness');
const P = require('../lib/path-text');

t('dirname：顶层文件与盘符根要补回反斜杠', () => {
  assert.strictEqual(P.dirname('C:\\foo'), 'C:\\');
  assert.strictEqual(P.dirname('C:/foo'), 'C:\\');
  assert.strictEqual(P.dirname('C:\\'), 'C:\\');
  assert.strictEqual(P.dirname('C:'), 'C:\\');
});

t('dirname：普通文件/目录/尾斜杠', () => {
  assert.strictEqual(P.dirname('C:\\foo\\bar.txt'), 'C:\\foo');
  assert.strictEqual(P.dirname('C:\\foo\\bar\\'), 'C:\\foo');
  assert.strictEqual(P.dirname('/home/user/file.txt'), '/home/user');
  assert.strictEqual(P.dirname('/file'), '/');
  assert.strictEqual(P.dirname('foo.txt'), '');
});

t('dirname：根与 UNC', () => {
  assert.strictEqual(P.dirname('/'), '/');
  assert.strictEqual(P.dirname('\\'), '\\');
  assert.strictEqual(P.dirname('\\\\server\\share\\file.txt'), '\\\\server\\share');
});

t('dirname：UNC 共享根本身没有父目录', () => {
  /* 锁的是：共享根 \\server\share 再往上不是 \\server（主机名不是目录）。
   * 旧实现走通用「最后一个分隔符」分支，返回 \\server，拼路径会拼到主机名。 */
  assert.strictEqual(P.dirname('\\\\server\\share'), '\\\\server\\share');
  assert.strictEqual(P.dirname('\\\\server\\share\\'), '\\\\server\\share\\');
  assert.strictEqual(P.dirname('\\\\?\\UNC\\server\\share'), '\\\\?\\UNC\\server\\share');
  assert.strictEqual(P.dirname('\\\\?\\UNC\\server\\share\\'), '\\\\?\\UNC\\server\\share\\');
});

t('basename：尾斜杠、盘符、普通路径', () => {
  assert.strictEqual(P.basename('C:\\foo\\bar.txt'), 'bar.txt');
  assert.strictEqual(P.basename('C:\\foo\\'), 'foo');
  assert.strictEqual(P.basename('/home/user/'), 'user');
  assert.strictEqual(P.basename('foo.txt'), 'foo.txt');
  assert.strictEqual(P.basename('C:\\'), 'C:');
  assert.strictEqual(P.basename('/'), '');
});

t('dirname：扩展长度前缀 \\\\?\\C:\\ 也要按盘符根处理', () => {
  /* 锁的是：DRIVE_ROOT 只认普通 C: 时，dirname('\\\\?\\C:\\foo')
   * 返回 '\\\\?\\C:'（相对盘符），dirname('\\\\?\\C:\\') 甚至返回 '\\\\?\\'；
   * 长路径前缀在 260 字符限制下很常见，拼输出目录会拼错。 */
  assert.strictEqual(P.dirname('\\\\?\\C:\\foo'), '\\\\?\\C:\\');
  assert.strictEqual(P.dirname('\\\\?\\C:\\'), '\\\\?\\C:\\');
  assert.strictEqual(P.basename('\\\\?\\C:\\foo'), 'foo');
  assert.strictEqual(P.basename('\\\\?\\C:\\'), '\\\\?\\C:');
});

done();
