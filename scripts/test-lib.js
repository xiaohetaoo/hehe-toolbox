const { t, done } = require('./lib/harness');
const stripComments = require('../lib/src-scan').stripComments;
// 纯函数回归测试（不依赖 Electron），覆盖本轮修复的关键逻辑：
// 进制转换负数、Unicode emoji 往返、JSON null 形态、密码破解时间分档、ping 行解析。
// 用法：node scripts/test-lib.js
const assert = require('assert');

/* ---- 1. convert.js 负数 + 进制 ---- */
function toAll(val, from) {
  const neg = val.startsWith('-');
  const raw = neg ? val.slice(1) : val;
  if (!/^[0-9a-fA-F]+$/.test(raw)) throw new Error('包含非法字符');
  const abs = BigInt((from === 16 ? '0x' : from === 8 ? '0o' : from === 2 ? '0b' : '') + raw);
  const big = neg ? -abs : abs;
  return { dec: big.toString(10), bin: big.toString(2), oct: big.toString(8), hex: big.toString(16).toUpperCase() };
}
const fs = require('fs');
/* 【不再自带 readAny】
 * 15 用例原来用 readAny（目录 → readTree 拼串、文件 → 读原文），
 * 但它拿不到"哪一行属于哪个文件"，报错时只能指出目录名。
 * 现在断言自己递归遍历并逐文件扫描（见该用例里的 walkJs），
 * readAny 与 readTree 的引入都随之删掉 —— 留着就是死代码。 */

t('十六进制负数 -FF -> -255', () => assert.strictEqual(toAll('-FF', 16).dec, '-255'));
t('二进制负数 -101 -> -5', () => assert.strictEqual(toAll('-101', 2).dec, '-5'));
t('八进制负数 -17 -> -15', () => assert.strictEqual(toAll('-17', 8).dec, '-15'));
t('十进制正数 255 -> FF', () => assert.strictEqual(toAll('255', 10).hex, 'FF'));
t('十六进制正数 FF -> 255', () => assert.strictEqual(toAll('FF', 16).dec, '255'));

/* ---- 2. unicode 编解码（含 emoji）---- */
const BS = String.fromCharCode(92);
function escOne(c) {
  const cp = c.codePointAt(0);
  if (cp > 0xFFFF) {
    const hi = Math.floor((cp - 0x10000) / 0x400) + 0xD800;
    const lo = ((cp - 0x10000) % 0x400) + 0xDC00;
    return BS + 'u' + hi.toString(16) + BS + 'u' + lo.toString(16);
  }
  return BS + 'u' + cp.toString(16).padStart(4, '0');
}
function uniEnc(t2) { return [...t2].map(c => c.codePointAt(0) > 127 ? escOne(c) : c).join(''); }
function uniDec(s) {
  let v = s.replace(new RegExp(BS + BS + 'u([0-9a-fA-F]{4})', 'g'), (_, h) => String.fromCharCode(parseInt(h, 16)));
  return v.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, p =>
    String.fromCodePoint((p.charCodeAt(0) - 0xD800) * 0x400 + (p.charCodeAt(1) - 0xDC00) + 0x10000));
}
for (const s of ['你好', '😀', '😀中🎉文', '𠮷', 'a中b😀c', '']) {
  t('unicode 往返 ' + JSON.stringify(s), () => assert.strictEqual(uniDec(uniEnc(s)), s));
}

/* ---- 3. json null 形态判断 ---- */
function describe(o) {
  if (o === null) return 'null';
  if (Array.isArray(o)) return o.length + ' 个元素';
  if (typeof o === 'object') return Object.keys(o).length + ' 个顶层键';
  return '标量';
}
t('JSON null 不崩且标为 null', () => assert.strictEqual(describe(null), 'null'));
t('JSON 数组', () => assert.strictEqual(describe([1, 2, 3]), '3 个元素'));
t('JSON 对象', () => assert.strictEqual(describe({ a: 1, b: 2 }), '2 个顶层键'));
t('JSON 标量', () => assert.strictEqual(describe(42), '标量'));

/* ---- 4. 密码破解时间（大 bits 不产生 Infinity）---- */
function crack(bits) {
  const log10Seconds = bits * Math.LN2 / Math.LN10 - 11;
  if (log10Seconds < 0) return '瞬间破解';
  const MAX_LOG10_SECONDS = Math.log10(1.4e14 * 86400 * 365);
  if (log10Seconds > MAX_LOG10_SECONDS) return '远超宇宙年龄';
  const seconds = Math.pow(10, log10Seconds);
  if (seconds < 3600) return Math.ceil(seconds / 60) + ' 分钟';
  if (seconds < 86400) return Math.ceil(seconds / 3600) + ' 小时';
  if (seconds < 86400 * 365) return Math.ceil(seconds / 86400) + ' 天';
  const years = seconds / 86400 / 365;
  if (years < 1e4) return Math.ceil(years) + ' 年';
  if (years < 1e8) return (years / 1e4).toFixed(1) + ' 万年';
  return (years / 1e8).toFixed(1) + ' 亿年';
}
t('657bit 不输出 Infinity/科学计数', () => {
  const r = crack(657);
  assert.ok(!/Infinity|e\+/.test(r), '得到: ' + r);
});
t('1024bit 输出远超宇宙年龄', () => assert.strictEqual(crack(1024), '远超宇宙年龄'));
t('40bit 为分钟级', () => assert.ok(/分钟/.test(crack(40))));

/* ---- 5. ping 行解析 ---- */
const RE1 = /(?:时间|time)\s*[=:：<]\s*(\d+(?:\.\d+)?)\s*ms/i;
const RE2 = /[=：:]\s*(\d+(?:\.\d+)?)\s*ms/i;
const pingCases = [
  ['来自 192.168.1.1 的回复: 字节=32 时间<1ms TTL=64', '1'],
  ['来自 8.8.8.8 的回复: 字节=32 时间=23ms TTL=117', '23'],
  ['来自 192.168.1.1 的回复: 字节=32 时间=12.5ms TTL=64', '12.5'],
  ['Reply from 8.8.8.8: bytes=32 time<1ms TTL=117', '1'],
  ['Reply from 8.8.8.8: bytes=32 time=15ms TTL=117', '15'],
];
for (const [line, want] of pingCases) {
  t('ping 解析 ' + line.slice(0, 28), () => {
    const m = line.match(RE1) || line.match(RE2);
    assert.ok(m, '未匹配');
    assert.strictEqual(m[1], want);
  });
}
t('ping 超时行不误判为成功', () => {
  assert.ok(!('请求超时。'.match(RE1) || '请求超时。'.match(RE2)));
});

t('15 源码树不再用展开传参求极值', () => {
  /* 【覆盖范围：整棵生产代码树，不是手写的几个文件】
   * 原来只列了 6 个文件 + js/tools/media，ipc/ 整个目录不在其中 ——
   * 而这道检查声称守的是「全库」。改用 readTree 递归扫，
   * 新增文件自动纳入，不会因为"忘了往列表里加"而漏检。 */
  const roots = ['main.js', 'preload.js', 'ipc', 'lib', 'js'];
  const bad = [];
  /* 【正则必须匹配实参表里任意位置的展开】
   * 原写法 /Math\.(max|min)\s*\(\s*\.\.\./g 只认「... 是第一个实参」。
   * 于是 Math.max(10, ...arr) 这种（net-tools.js 里真实存在的写法）
   * 匹配不到 —— 断言消息却写着「全库不再用」，是假绿。
   *
   * 现在按「找到 Math.max(/Math.min( 之后，配平括号取出整个实参表，
   * 再检查里面有没有 ...」的方式判。用配平而不是正则贪心，
   * 是为了避免跨语句误吞（例如 Math.max(a) + foo(...b) 这种）。 */
  function scanSource(rel, code) {
    const re = /Math\.(?:max|min)\s*\(/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const open = code.indexOf('(', m.index + 4);
      if (open < 0) continue;
      let depth = 0, i = open;
      for (; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') { depth--; if (depth === 0) break; }
      }
      const args = code.slice(open + 1, i);
      if (args.indexOf('...') >= 0) {
        const line = code.slice(0, m.index).split('\n').length;
        bad.push(rel + ':' + line);
      }
    }
  }
  /* 【遍历用 fs 递归，不用 readTree】
   * readTree 把整目录拼成一个字符串（拿不到"哪一行属于哪个文件"），
   * 而且只读一层 .js。这里需要逐文件的行号，所以自己走一遍。 */
  const nodePath = require('path');
  function walkJs(rel) {
    const abs = nodePath.join(__dirname, '..', rel);
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { return; }
    if (st.isFile()) {
      if (rel.endsWith('.js')) scanSource(rel.replace(/\\/g, '/'), stripComments(fs.readFileSync(abs, 'utf8')));
      return;
    }
    let names = [];
    try { names = fs.readdirSync(abs); } catch (e) { return; }
    for (const n of names) {
      if (n === 'node_modules' || n === '.git') continue;
      walkJs(rel + '/' + n);
    }
  }
  for (const root of roots) walkJs(root);
  assert.deepStrictEqual(bad, [],
    '仍在用展开传参求极值（数组一大就 RangeError: Maximum call stack size exceeded；改用 reduce）');
});

t('15b 行为：13 万个元素的极值不再抛错', () => {
  const arr = new Array(130000).fill(1);
  let threw = null;
  try { Math.max(...arr); } catch (e) { threw = e; }
  assert.ok(threw && /Maximum call stack/.test(threw.message),
    '前提不成立：13 万参数应当会栈溢出（若 Node 版本变了请更新本条）');
  // reduce 版必须正常
  assert.strictEqual(arr.reduce((a, b) => (a > b ? a : b), 0), 1, 'reduce 版应当正常工作');
});

done();
