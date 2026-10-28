'use strict';
/* 验证 media.js 的 samePath 能否识别「含 .. 的不同写法」指向同一文件。 */
const fs = require('fs'), path = require('path'), os = require('os');

/* 新实现（与 js/tools/media.js 一致） */
function normAbs(p) {
  let s = String(p || '').replace(/[\\/]+/g, '/');
  const drive = (s.match(/^([a-zA-Z]:)/) || [])[1] || '';
  let rest = drive ? s.slice(drive.length) : s;
  const abs = rest.startsWith('/');
  const out = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  const joined = (drive || (abs ? '' : '')) + '/' + out.join('/');
  return joined.replace(/\/+$/, '').toLowerCase();
}
const samePath = (a, b) => { try { return normAbs(a) === normAbs(b); } catch (e) { return false; } };

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
};
const assert = require('assert');

const d = 'C:\\Users\\x\\pics';
const src = d + '\\a.jpg';

t('输出目录含 sub\\.. 仍能识别为同一文件（关键修复）', () => {
  const outPath = (d + '\\sub\\..').replace(/[\\/]$/, '') + '/a.jpg';
  assert.ok(samePath(outPath, src), '未识别为同一文件: ' + outPath);
});
t('输出目录含 . 仍能识别', () => {
  assert.ok(samePath(d + '\\a.jpg', src));
  assert.ok(samePath(d + '\\.\\a.jpg', src));
});
t('大小写不同识别为同一文件', () => {
  assert.ok(samePath('C:\\USERS\\X\\PICS\\A.JPG', src));
});
t('分隔符混用识别为同一文件', () => {
  assert.ok(samePath('C:/Users/x/pics/a.jpg', src));
  assert.ok(samePath('C:\\Users\\x\\pics/a.jpg', src));
});
t('尾随分隔符会被归一化掉', () => {
  // 当前实现把尾随 / 去掉，所以 "a.jpg/" 与 "a.jpg" 视为同一路径（对自我覆盖保护更保守，是好事）
  assert.ok(samePath(d + '\\a.jpg\\', src), '尾斜杠应被归一化');
});
t('不同文件不被误判为相同', () => {
  assert.ok(!samePath(d + '\\b.jpg', src));
  assert.ok(!samePath(d + '\\sub\\a.jpg', src));
  assert.ok(!samePath('D:\\xxx\\a.jpg', src));
});
t('多层 .. 正确折叠', () => {
  // c\..\..\x\.. 折叠掉了 c、b、x 三段 -> 落在 C:\a\a.jpg
  assert.ok(samePath('C:\\a\\b\\c\\..\\..\\x\\..\\a.jpg', 'C:\\a\\a.jpg'), '折叠结果不对');
  assert.ok(samePath('C:\\a\\b\\..\\a.jpg', 'C:\\a\\a.jpg'));
  // 折叠到不同位置必须不等
  assert.ok(!samePath('C:\\a\\b\\c\\..\\..\\x\\..\\a.jpg', 'C:\\a\\b\\a.jpg'));
});
t('真实文件验证：.. 写法指向同一 inode', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const f = path.join(tmp, 'a.jpg');
  fs.writeFileSync(f, 'ORIGINAL');
  const d1 = path.join(tmp, 'sub', '..');
  const outPath = d1.replace(/[\\/]$/, '') + '/a.jpg';
  // 两者 resolve 后必须相同
  assert.strictEqual(path.resolve(outPath), path.resolve(f));
  assert.ok(samePath(outPath, f), 'samePath 未识别: ' + outPath);
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
