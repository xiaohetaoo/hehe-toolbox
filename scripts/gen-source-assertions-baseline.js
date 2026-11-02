'use strict';
/* 生成 / 刷新 scripts/source-assertions-baseline.txt。
 *
 * 【它只做一件事：把「当前存量」拍成快照】
 * 它不判断某处违规该不该存在——那是 scripts/test-source-assertions.js 的事。
 * 分开的理由：如果让元测试自己写基线，它就会在发现违规时顺手"把违规登记成
 * 合法"，守门员就变成了盖章机器。生成必须是**显式的、需要人跑一次**的动作。
 *
 * 用法：
 *   node scripts/gen-source-assertions-baseline.js           # 只打印，不落盘
 *   node scripts/gen-source-assertions-baseline.js --write   # 真的写进去
 *
 * 【写进去时要保留人工维护的部分】每条记录末尾的类别（见元测试的 CATEGORIES）
 * 是人工判断的结果，不能被脚本覆盖成默认值。所以已有的类别原样保留，
 * 只有新出现的文件用 `exact:` + 待填提示，逼人写理由。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'scripts', 'source-assertions-baseline.txt');

/* 【为什么要 require 扫描内核而不是重写一份】
 * 重写一份的话，两边判定标准迟早分叉：元测试改了「什么算源码断言」，
 * 生成器还在用旧标准，于是基线永远对不上、永远在红，
 * 而人对「永远红」的检查只会做一件事：关掉它。 */
const scan = require('./lib/source-assert-scan');

const HEADER = `# 源码断言的存量基线（由 scripts/gen-source-assertions-baseline.js 生成）
#
# 每一行 = 一个脚本的存量违规计数。格式：
#   <相对路径> | A=<裸 readFileSync 处数> | B=<无「锁的是」的源码断言数> | <类别>
#
# 规则（由 scripts/test-source-assertions.js 执行）：
#   · 某文件实际数 > 基线数 → 红，报出新增处的「文件:行号 + 原文」
#   · 某文件实际数 < 基线数 → 绿，但会打印提示让你把基线改小
#   · 某文件不在本文件里     → 必须 A=0 且 B=0，否则红
# 也就是说：这张表只能往下走，不能往上走。
#
# 类别必须是元测试 CATEGORIES 里登记过的键，或者 \`exact:<具体理由>\`。
`;

const rows = scan.snapshot();

/* 读旧基线，保留人工写的类别。 */
const oldCats = new Map();
if (fs.existsSync(OUT)) {
  for (const ln of fs.readFileSync(OUT, 'utf8').split(/\r?\n/)) {
    const s = ln.trim();
    if (!s || s.startsWith('#')) continue;
    const p = s.split('|').map((x) => x.trim());
    if (p.length === 4) oldCats.set(p[0], p[3]);
  }
}

const lines = [HEADER];
let changed = 0;
for (const r of rows) {
  const cat = oldCats.get(r.file) || 'exact:待填：这个文件为什么可以有源码断言违规';
  if (!oldCats.has(r.file)) changed++;
  lines.push(r.file + ' | A=' + r.A + ' | B=' + r.B + ' | ' + cat);
}

const text = lines.join('\n') + '\n';

if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT, text, 'utf8');
  console.log('已写入 ' + path.relative(ROOT, OUT) + '：' + rows.length + ' 行'
    + (changed ? '，其中 ' + changed + ' 行的类别需要人工填写（现在是 "exact:待填"）' : ''));
} else {
  console.log(text);
  console.log('（这是预览。加 --write 才会落盘。）');
}
