'use strict';
/* 行为验证：从 URL 提取安全文件名（防 %2F..%2F 路径穿越）与笔记名净化。 */

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
};
const assert = require('assert');

/* 复刻 net-tools.js 的 safeNameFromUrl */
const BAD_NAME_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function safeNameFromUrl(url) {
  let raw = '';
  try { raw = decodeURIComponent(String(url).split('?')[0].split('#')[0].split('/').pop() || ''); } catch (e) { raw = ''; }
  raw = raw.split(/[\\/]/).pop() || '';
  raw = raw.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!raw || raw === '.' || raw === '..') return 'download.bin';
  const base = raw.split('.')[0];
  if (BAD_NAME_BASE.test(base)) raw = '_' + raw;
  if (raw.length > 180) {
    const dot = raw.lastIndexOf('.');
    const ext = dot > 0 ? raw.slice(dot) : '';
    raw = raw.slice(0, 180 - ext.length) + ext;
  }
  return raw;
}

/* 复刻 text-tools.js 的 safeNoteName */
const DEVICE_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function safeNoteName(raw) {
  let s = String(raw || '').trim() || '未命名';
  s = s.replace(/[\x00-\x1f\\/:*?"<>|]/g, '_');
  s = s.replace(/^\.+/, '');
  s = s.replace(/[. ]+$/, '');
  if (!s) s = '未命名';
  if (DEVICE_BASE.test(s.split('.')[0])) s = '_' + s;
  if (s.length > 120) s = s.slice(0, 120);
  return s + '.md';
}

/* ---------- URL 文件名 ---------- */
t('普通 URL 取出文件名', () => {
  assert.strictEqual(safeNameFromUrl('https://x.com/a/setup.exe'), 'setup.exe');
});
t('带 query 的 URL 忽略参数', () => {
  assert.strictEqual(safeNameFromUrl('https://x.com/a/file.zip?v=1'), 'file.zip');
});
t('%2F..%2F 穿越被挡成单层文件名', () => {
  const evil = 'https://x.com/a%2F..%2F..%2F..%2FWindows%2Fwin.ini';
  const got = safeNameFromUrl(evil);
  assert.ok(!got.includes('/'), '仍含斜杠: ' + got);
  assert.ok(!got.includes('\\'), '仍含反斜杠: ' + got);
  assert.strictEqual(got, 'win.ini');
});
t('%5C 反斜杠穿越被挡', () => {
  const got = safeNameFromUrl('https://x.com/a%5C..%5C..%5Cevil.bat');
  assert.ok(!got.includes('\\'), '仍含反斜杠: ' + got);
});
t('Windows 设备名被改写', () => {
  assert.strictEqual(safeNameFromUrl('https://x.com/CON'), '_CON');
  assert.strictEqual(safeNameFromUrl('https://x.com/nul.txt'), '_nul.txt');
});
t('尾随点被去掉', () => {
  const got = safeNameFromUrl('https://x.com/file.');
  assert.ok(!got.endsWith('.'), '仍以点结尾: ' + got);
});
t('空末段回退默认名', () => {
  assert.strictEqual(safeNameFromUrl('https://x.com/'), 'download.bin');
  assert.strictEqual(safeNameFromUrl('https://x.com/..'), 'download.bin');
});
t('超长名被截断且保留扩展名', () => {
  const got = safeNameFromUrl('https://x.com/' + 'a'.repeat(300) + '.zip');
  assert.ok(got.length <= 180, '长度 ' + got.length);
  assert.ok(got.endsWith('.zip'), '扩展名丢了: ' + got);
});

/* ---------- 笔记名 ---------- */
t('普通标题生成 .md', () => {
  assert.strictEqual(safeNoteName('我的笔记'), '我的笔记.md');
});
t('路径分隔符被替换', () => {
  assert.strictEqual(safeNoteName('a/b\\c'), 'a_b_c.md');
});
t('.. 标题不会变成路径', () => {
  const got = safeNoteName('..');
  assert.strictEqual(got, '未命名.md', '得到: ' + got);
});
t('Windows 设备名被加前缀', () => {
  assert.strictEqual(safeNoteName('CON'), '_CON.md');
  assert.strictEqual(safeNoteName('NUL'), '_NUL.md');
  assert.strictEqual(safeNoteName('COM1'), '_COM1.md');
});
t('尾随点被去掉（避免同名冲突）', () => {
  assert.strictEqual(safeNoteName('note.'), 'note.md');
  assert.strictEqual(safeNoteName('note..'), 'note.md');
  assert.strictEqual(safeNoteName('note '), 'note.md');
});
t('空标题回退未命名', () => {
  assert.strictEqual(safeNoteName(''), '未命名.md');
  assert.strictEqual(safeNoteName('   '), '未命名.md');
});
t('超长标题被截断', () => {
  const got = safeNoteName('x'.repeat(300));
  assert.ok(got.length <= 123, '长度 ' + got.length);
  assert.ok(got.endsWith('.md'));
});
t('笔记名不含任何 Windows 非法字符', () => {
  for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    const got = safeNoteName('a' + ch + 'b');
    assert.ok(!got.includes(ch), ch + ' 未被替换: ' + got);
  }
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
