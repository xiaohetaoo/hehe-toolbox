const fs = require('fs');

/* 清掉迁移后残留的未使用变量。 */
const JOBS = [
  { file: 'scripts/test-dir-move-impl.js', needle: "const ROOT = path.join(__dirname, '..');" },
  { file: 'scripts/test-file-unlock.js', needle: "const fs = require('fs');" },
  { file: 'scripts/test-file-unlock.js', needle: "const path = require('path');" },
];

for (const J of JOBS) {
  const L = fs.readFileSync(J.file, 'utf8').split('\n');
  const i = L.findIndex((l) => l.trim() === J.needle);
  if (i < 0) { console.log('SKIP ' + J.file + '  ' + J.needle); continue; }
  L.splice(i, 1);
  fs.writeFileSync(J.file, L.join('\n'), 'utf8');
  console.log('OK   ' + J.file + '  删除 ' + J.needle);
}
