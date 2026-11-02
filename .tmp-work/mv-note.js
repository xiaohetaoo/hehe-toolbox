const fs = require('fs');
const p = 'scripts/test-dir-move-impl.js';
const L = fs.readFileSync(p, 'utf8').split('\n');

/* 断言行的索引 */
const i = L.findIndex((l) => l.includes("assert.ok(/isInsideTree\\(linkTargetAbs\\(l\\), srcAbs\\)"));
if (i < 0) { console.error('找不到断言行'); process.exit(1); }

/* 断言与注释之间隔了一行 `const code = ...`。把那段注释整体移到断言正上方。 */
const commentStart = L.findIndex((l, k) => k < i && l.trim().startsWith('/* 锁的是：预检'));
if (commentStart < 0) { console.error('找不到注释起始'); process.exit(1); }

/* 注释块的行数：从 commentStart 到以 */ 结尾那行 */
let commentEnd = commentStart;
while (commentEnd < L.length && !L[commentEnd].trim().endsWith('*/')) commentEnd++;

const commentBlock = L.slice(commentStart, commentEnd + 1);
/* 删掉原注释（保留 const code 那行） */
L.splice(commentStart, commentEnd - commentStart + 1);

/* 重新找到断言位置（删除后索引变了） */
const j = L.findIndex((l) => l.includes("assert.ok(/isInsideTree\\(linkTargetAbs\\(l\\), srcAbs\\)"));
if (j < 0) { console.error('删除后找不到断言'); process.exit(1); }

/* 在断言正上方插入注释块 + 一句说明为什么必须紧贴 */
L.splice(j, 0, ...commentBlock, '  /* 说明：守门员只认断言上方 3 行，所以注释必须紧贴这里，',
  '   * 不能放在 const code = ... 上面（中间隔一行就失效）。 */');

fs.writeFileSync(p, L.join('\n'), 'utf8');
console.log('注释已移到断言正上方');
