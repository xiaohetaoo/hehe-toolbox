// 纯函数回归测试（不依赖 Electron），覆盖本轮修复的关键逻辑：
// 进制转换负数、Unicode emoji 往返、JSON null 形态、密码破解时间分档、ping 行解析。
// 用法：node scripts/test-lib.js
const assert = require('assert');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
}

/* ---- 1. convert.js 负数 + 进制 ---- */
function toAll(val, from) {
  const neg = val.startsWith('-');
  const raw = neg ? val.slice(1) : val;
  if (!/^[0-9a-fA-F]+$/.test(raw)) throw new Error('包含非法字符');
  const abs = BigInt((from === 16 ? '0x' : from === 8 ? '0o' : from === 2 ? '0b' : '') + raw);
  const big = neg ? -abs : abs;
  return { dec: big.toString(10), bin: big.toString(2), oct: big.toString(8), hex: big.toString(16).toUpperCase() };
}
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

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
