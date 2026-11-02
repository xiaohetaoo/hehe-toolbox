const fs = require('fs');
const path = require('path');
const p = 'scripts/test-dir-move.js';
let s = fs.readFileSync(p, 'utf8');

/* 补 read / stripComments（新迁移的用例读 js/tools/dir-move.js 的源码）。 */
if (!s.includes('function read(')) {
  const anchor = "const D = require('../lib/dir-move');";
  if (!s.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
  s = s.replace(anchor, anchor + '\n'
    + '/* 读渲染层源码（新迁移的用例要看 js/tools/dir-move.js 的状态管理）。 */\n'
    + 'const fs = require(\'fs\');\n'
    + 'const nodePath = require(\'path\');\n'
    + 'const ROOT = nodePath.join(__dirname, \'..\');\n'
    + 'function read(rel) { return fs.readFileSync(nodePath.join(ROOT, rel), \'utf8\'); }\n'
    + 'const stripComments = require(\'../lib/src-scan\').stripComments;');
  fs.writeFileSync(p, s, 'utf8');
  console.log('已补 read / stripComments');
} else {
  console.log('已存在 read');
}
