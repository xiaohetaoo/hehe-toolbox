// 对比打包产物与源码的 css/app.css 是否一致
const asar = require('@electron/asar');
const fs = require('fs');
const crypto = require('crypto');
const BS = String.fromCharCode(92);
const asarPath = process.argv[2] || 'dist/win-unpacked/resources/app.asar';

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }

let packed = null;
for (const c of ['css' + BS + 'app.css', 'css/app.css']) {
  try { packed = asar.extractFile(asarPath, c); break; } catch (e) {}
}
if (!packed) { console.log('❌ 产物里找不到 css/app.css'); process.exit(1); }
const src = fs.readFileSync('css/app.css');

const ps = packed.toString('utf8');
const ss = src.toString('utf8');
console.log('源码  : ' + src.length + ' 字节, sha=' + sha(ss) + ', 行数=' + ss.split('\n').length);
console.log('产物  : ' + packed.length + ' 字节, sha=' + sha(ps) + ', 行数=' + ps.split('\n').length);
console.log(ps === ss ? '✅ 完全一致（差异只是换行符与否）' : '⚠ 内容不同');

// 若不同，找出第一处差异
if (ps !== ss) {
  const n = Math.min(ps.length, ss.length);
  let i = 0;
  while (i < n && ps[i] === ss[i]) i++;
  console.log('首个差异位置: ' + i);
  console.log('源码: ' + JSON.stringify(ss.slice(Math.max(0, i - 60), i + 60)));
  console.log('产物: ' + JSON.stringify(ps.slice(Math.max(0, i - 60), i + 60)));
}

// 检查关键布局规则是否都在
const need = ['.tool-card {', '.tc-name', '.tc-desc', '.settings-nav {', '.set-label', '.set-desc', '.home-hero', '.home-search', '.tool-grid'];
const miss = need.filter(r => !ps.includes(r));
console.log(miss.length ? '❌ 产物缺规则: ' + miss.join(', ') : '✅ 关键布局规则齐全 (' + need.length + ' 项)');
