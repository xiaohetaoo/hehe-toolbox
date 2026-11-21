'use strict';
/* 行为验证：安全文件名推导（防 %2F..%2F 路径穿越）+ 笔记名净化。
 *
 * 【v0.9.2 起直接 require 真实实现】
 * 原来这里手抄一份 safeNameFromUrl；后来又改成「从 net-tools.js 源码切出
 * 函数体再 new Function 求值」——后者在 CI 上因换行/剥注释差异直接红了
 * （ReferenceError: safeNameFromUrl is not defined）。
 * 实现已抽到 lib/safe-name.js（纯函数，渲染层与 Node 共用），
 * 这里 require 的就是线上跑的那份，既不是副本也不需要切源码。 */

/* 【骨架用共享 harness】项目约定所有测试脚本共用 scripts/lib/harness.js，
 * 不再各自手写 t()（输出格式逐字一致：PASS 双空格 / FAIL '  -> ' / 结果行）。 */
const { t, done, assert } = require('./lib/harness');
const { fromUrl: safeNameFromUrl, fromTitle: safeNoteNameRaw } = require('../lib/safe-name');

const safeNoteName = (s) => safeNoteNameRaw(s, '.md');

/* ---------- URL 文件名 ---------- */
t('普通 URL 取出文件名', () => {
  assert.strictEqual(safeNameFromUrl('https://x.com/a/setup.exe'), 'setup.exe');
});
t('带 query 的 URL 忽略参数', () => {
  assert.strictEqual(safeNameFromUrl('https://x.com/a/file.zip?v=1'), 'file.zip');
});
t('带 hash 的 URL 忽略锚点', () => {
  assert.strictEqual(safeNameFromUrl('https://x.com/a/file.zip#sec'), 'file.zip');
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
  assert.strictEqual(safeNameFromUrl('https://x.com/COM1.log'), '_COM1.log');
});
t('尾随点被去掉', () => {
  const got = safeNameFromUrl('https://x.com/file.');
  assert.ok(!got.endsWith('.'), '仍以点结尾: ' + got);
});
t('空末段回退默认名', () => {
  assert.strictEqual(safeNameFromUrl('https://x.com/'), 'download.bin');
});
t('超长名被截断且保留扩展名', () => {
  const got = safeNameFromUrl('https://x.com/' + 'a'.repeat(300) + '.zip');
  assert.ok(got.length <= 180, '长度 ' + got.length);
  assert.ok(got.endsWith('.zip'), '扩展名丢了: ' + got);
});
/* 【锁的是】扩展名本身超预算时 keep 为负，slice(0, 负数) 从尾部数，
 * 拼回 ext 反而更长（修复前实测 482 > 180）——长度契约必须无条件成立。 */
t('扩展名超长时仍不超长度上限（负 keep 边界）', () => {
  const got = safeNameFromUrl('https://x.com/x.' + 'b'.repeat(300));
  assert.ok(got.length <= 180, '长度 ' + got.length);
  const got2 = safeNameFromUrl('https://x.com/' + 'c'.repeat(179) + '.' + 'd'.repeat(50));
  assert.ok(got2.length <= 180, '长度 ' + got2.length);
});
t('非法百分号编码不抛异常', () => {
  const got = safeNameFromUrl('https://x.com/%zz.bin');
  assert.ok(typeof got === 'string' && got.length > 0, '得到: ' + got);
  assert.ok(!got.includes('/'), '仍含斜杠: ' + got);
});

/* ---------- v0.9.2 修复：点开头的隐藏文件名 ----------
 * 原实现无条件 `.replace(/^\.+/, '')` 把 .bashrc 剥成 bashrc；
 * 下载下来的隐藏配置文件当场改名，用户拿到的名字与线上不一致。 */
t('点开头的隐藏文件名保留前导点', () => {
  assert.strictEqual(safeNameFromUrl('https://x.com/.bashrc'), '.bashrc');
  assert.strictEqual(safeNameFromUrl('https://x.com/.gitignore'), '.gitignore');
  assert.strictEqual(safeNameFromUrl('https://x.com/.env'), '.env');
  assert.strictEqual(safeNameFromUrl('https://x.com/.env.local'), '.env.local');
});
t('纯点名仍回退默认名（不能变成空名或穿越）', () => {
  for (const u of ['https://x.com/.', 'https://x.com/..', 'https://x.com/...', 'https://x.com/']) {
    assert.strictEqual(safeNameFromUrl(u), 'download.bin', u + ' 应回退');
  }
});

/* ---------- 笔记名 ---------- */
t('普通标题生成 .md', () => {
  assert.strictEqual(safeNoteName('我的笔记'), '我的笔记.md');
});
t('路径分隔符被替换', () => {
  assert.strictEqual(safeNoteName('a/b\\c'), 'a_b_c.md');
});
t('.. 标题不会变成路径', () => {
  assert.strictEqual(safeNoteName('..'), '未命名.md');
});
t('Windows 设备名被加前缀', () => {
  assert.strictEqual(safeNoteName('CON'), '_CON.md');
  assert.strictEqual(safeNoteName('NUL'), '_NUL.md');
  assert.strictEqual(safeNoteName('COM1'), '_COM1.md');
});
t('尾随点/空格被去掉', () => {
  assert.strictEqual(safeNoteName('note.'), 'note.md');
  assert.strictEqual(safeNoteName('note..'), 'note.md');
  assert.strictEqual(safeNoteName('note '), 'note.md');
});
t('空标题回退未命名', () => {
  assert.strictEqual(safeNoteName(''), '未命名.md');
  assert.strictEqual(safeNoteName('   '), '未命名.md');
  assert.strictEqual(safeNoteName(null), '未命名.md');
  assert.strictEqual(safeNoteName(undefined), '未命名.md');
});
t('超长标题被截断且保留 .md', () => {
  const got = safeNoteName('x'.repeat(300));
  assert.ok(got.length <= 123, '长度 ' + got.length);
  assert.ok(got.endsWith('.md'));
});
/* 【锁的是】fromTitle 的负 max 边界：suffix 超预算时 slice(0, 负数)
 * 从尾部数反而更长（修复前实测 320 > 120）。长度契约无条件成立。 */
t('超长自定义扩展名仍不超长度上限（负 max 边界）', () => {
  const got = safeNoteNameRaw('t'.repeat(200), '.' + 'e'.repeat(150));
  assert.ok(got.length <= 120, '长度 ' + got.length);
});
t('笔记名不含任何 Windows 非法字符', () => {
  for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    const got = safeNoteName('a' + ch + 'b');
    assert.ok(!got.includes(ch), ch + ' 未被替换: ' + got);
  }
});
t('自定义扩展名生效', () => {
  assert.strictEqual(safeNoteNameRaw('笔记', '.txt'), '笔记.txt');
  assert.strictEqual(safeNoteNameRaw('笔记', ''), '笔记');
});

done();