'use strict';
/* 行为验证：从 URL 提取安全文件名（防 %2F..%2F 路径穿越）与笔记名净化。 */

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
};
const assert = require('assert');
const { readSrc } = require('./lib/harness');

/* 【从源码抽真实实现，不再复刻】
 * 原来这里手抄了一份 safeNameFromUrl —— 副本与实现必然分叉：
 * 实现修了「无条件剥前导点导致 .bashrc 变成 bashrc」之后，副本仍是旧逻辑，
 * 于是测试照样绿、真实行为仍是错的（这就是「测副本造成的假绿」）。
 * 现在用 readSrc（剥注释后不影响求值）把函数体原样切出来求值，
 * 测的就是线上跑的那份代码。
 * 锁的是：net-tools.js 里 safeNameFromUrl 的实现（函数名与形态变了要同步改本断言）。 */
const netSrc = readSrc('js/tools/net-tools.js');
const fnStart = netSrc.indexOf('function safeNameFromUrl(');
assert.ok(fnStart >= 0, 'net-tools.js 里找不到 safeNameFromUrl');
const fnEnd = netSrc.indexOf('\n  }\n', fnStart) + 4;
const fnBody = netSrc.slice(fnStart, fnEnd);
const badNameBase = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const safeNameFromUrl = new Function('BAD_NAME_BASE', fnBody + '\nreturn safeNameFromUrl;')(badNameBase);

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
  /* 锁的是：%2F 解码后的路径穿越必须被「只留最后一段」挡掉（历史回归：
   * 早期实现拼 userData 就能写到 userData 之外）。行为断言直接对真实函数。 */
  assert.ok(!got.includes('/'), '仍含斜杠: ' + got);
  assert.ok(!got.includes('\\'), '仍含反斜杠: ' + got);
  assert.strictEqual(got, 'win.ini');
});
t('%5C 反斜杠穿越被挡', () => {
  const got = safeNameFromUrl('https://x.com/a%5C..%5C..%5Cevil.bat');
  /* 锁的是：%5C（反斜杠）解码后同样可能穿越，必须与 %2F 同等对待。 */
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
/* 【点开头的隐藏文件名必须保留】原实现无条件 .replace(/^\.+/, '')，
 * 把 .bashrc / .gitignore / .env 剥成 bashrc / gitignore / env ——
 * 下载下来的隐藏配置文件当场改名，用户拿到的名字与线上不一致。 */
t('点开头的隐藏文件名保留前导点', () => {
  /* 锁的是：历史回归——实现曾用 `.replace(/^\.+/, '')` 无条件剥前导点，
   * 把 .bashrc 剥成 bashrc。剥「纯点」与剥「正常点开头名」必须区分开。 */
  assert.strictEqual(safeNameFromUrl('https://x.com/.bashrc'), '.bashrc');
  assert.strictEqual(safeNameFromUrl('https://x.com/.gitignore'), '.gitignore');
  assert.strictEqual(safeNameFromUrl('https://x.com/.env'), '.env');
  assert.strictEqual(safeNameFromUrl('https://x.com/.env.local'), '.env.local');
});
t('纯点名仍回退默认名（不能变成空名或穿越）', () => {
  /* 锁的是：剥前导点的放宽不能把 `..` / `...` 也放行 —— 纯点形态无意义，必须回退默认名。 */
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
    /* 锁的是：笔记名会拼进 userData 路径写盘，9 个 Windows 非法字符一个都不能漏
     * （历史回归形态：新增字符替换规则时漏了某个字符，写盘在含该字符的标题下失败）。 */
    assert.ok(!got.includes(ch), ch + ' 未被替换: ' + got);
  }
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
