const fs = require('fs');
const CLOSE = '*' + '/';
const p = 'scripts/test-dir-move-impl.js';
const L = fs.readFileSync(p, 'utf8').split('\n');

const i = L.findIndex((l) => l.includes('assert.ok(/isInsideTree\\(linkTargetAbs\\(l\\), srcAbs\\)'));
if (i < 0) { console.error('找不到断言行'); process.exit(1); }

const commentStart = L.findIndex((l, k) => k < i && l.trim().startsWith('/* 锁的是：预检'));
if (commentStart < 0) { console.error('找不到注释起始'); process.exit(1); }

let commentEnd = commentStart;
while (commentEnd < L.length && !L[commentEnd].trim().endsWith(CLOSE)) commentEnd++;

const commentBlock = L.slice(commentStart, commentEnd + 1);
L.splice(commentStart, commentEnd - commentStart + 1);

const j = L.findIndex((l) => l.includes('assert.ok(/isInsideTree\\(linkTargetAbs\\(l\\), srcAbs\\)'));
if (j < 0) { console.error('删除后找不到断言'); process.exit(1); }

L.splice(j, 0,
  ...commentBlock,
  '  /* 说明：守门员只认断言上方 3 行，所以这条注释必须紧贴断言，',
  '   * 不能放在 const code = ... 上面（中间隔一行就失效）。 */');

fs.writeFileSync(p, L.join('\n'), 'utf8');
console.log('注释已移到断言正上方');
