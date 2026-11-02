const fs = require('fs');
const p = 'scripts/test-test-map.js';
const L = fs.readFileSync(p, 'utf8').split('\n');

const start = L.findIndex((l) => l.includes("t('TM-3 白名单每条都写了理由"));
if (start < 0) throw new Error('找不到 TM-3');
const end = L.findIndex((l, i) => i > start && l.trim() === '});');
if (end < 0) throw new Error('找不到 TM-3 结尾');

const NEW = [
  "t('TM-3 白名单每条都写了理由，且确实没有测试引用它', () => {",
  '  /* 【为什么不能只查「理由够不够长」】',
  '   * 白名单现在是空的（19/19 全覆盖），一条 `Object.keys(EXEMPT).filter(...)`',
  '   * 在这种状态下永远通过 —— 那是**永真断言**，等于没有。',
  '   * 所以补上真正的约束：**白名单里的模块必须真的没有测试引用它**。',
  '   * 一旦某个模块已经有了测试却还挂在豁免里，这条会红（与 TM-2 互为印证：',
  '   * TM-2 查「过期」，这条查「豁免是否名副其实」）。',
  '   * 理由长度检查保留 —— 将来重新挂条目时它仍然起作用。 */',
  '  const bad = [];',
  '  for (const m of Object.keys(EXEMPT)) {',
  '    const reason = EXEMPT[m];',
  "    if (!reason || reason.length < 20) { bad.push(m + '：理由太短'); continue; }",
  '    const files = map.get(m);',
  '    if (files && files.size > 0) {',
  "      bad.push(m + '：已经有测试引用它了（' + [...files].join(', ') + '），不该再挂白名单');",
  '    }',
  '  }',
  '  if (bad.length) throw new Error(bad.join(String.fromCharCode(10) + "  "));',
  '});',
  '',
  "t('TM-3b 覆盖率本身有下限（防止靠「多挂白名单」把 TM-1 刷绿）', () => {",
  '  /* TM-1 允许白名单，所以「把所有没测试的模块都挂上去」也能让它绿。',
  '   * 这条给覆盖率设下限：至少 90% 的 lib 模块必须有直接测试。',
  '   * 提高覆盖率只能靠写测试，不能靠加豁免。 */',
  '  const covered = [...map.values()].filter((s) => s.size > 0).length;',
  '  const ratio = covered / map.size;',
  '  if (ratio < 0.9) {',
  "    throw new Error('lib 模块直接测试覆盖率只有 ' + covered + '/' + map.size",
  "      + '（' + (ratio * 100).toFixed(0) + '%），低于 90% 的下限。'",
  "      + '提高覆盖率要靠补测试，不是靠往 EXEMPT 里加条目。');",
  '  }',
  '});',
];

L.splice(start, end - start + 1, ...NEW);
fs.writeFileSync(p, L.join('\n'), 'utf8');
console.log('TM-3 已改写并新增 TM-3b（' + NEW.length + ' 行）');
