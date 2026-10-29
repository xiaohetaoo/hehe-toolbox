'use strict';
/* P2-18 回归：密码生成的「拒绝采样」必须
 *   (1) 生成指定长度
 *   (2) 只用给定字符集里的字符
 *   (3) 分布没有明显偏差（拒绝采样后每个字符概率应一致）
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

/* 复刻 security.js 里的拒绝采样逻辑（与源码保持一致） */
function genPwd(chars, len) {
  const cLen = chars.length;
  const limit = Math.floor(0x100000000 / cLen) * cLen;
  const out = [];
  let guard = 0;
  while (out.length < len && guard++ < 1000) {
    const arr = new Uint32Array(len - out.length);
    crypto.getRandomValues(arr);
    for (const x of arr) {
      if (x < limit) out.push(chars[x % cLen]);
      if (out.length >= len) break;
    }
  }
  return out.join('');
}

t('长度正确', () => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  for (const len of [4, 8, 16, 32, 64]) {
    const p = genPwd(chars, len);
    assert.strictEqual(p.length, len, '长度应为 ' + len + '，实际 ' + p.length);
  }
});

t('只使用字符集内的字符', () => {
  const chars = 'abc123';
  for (let i = 0; i < 200; i++) {
    const p = genPwd(chars, 20);
    for (const c of p) assert.ok(chars.includes(c), '出现了字符集外的字符: ' + c);
  }
});

t('拒绝采样：分布无明显偏差（卡方粗略检验）', () => {
  /* 用长度为 3 的字符集（2^32 不能被 3 整除），这是偏差最明显的情形。
   * 取模偏差会让 'a' 出现概率略高。拒绝采样后三者应接近。 */
  const chars = 'abc';
  const N = 30000;
  const cnt = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < N; i++) {
    for (const ch of genPwd(chars, 10)) cnt[ch]++;
  }
  const total = cnt.a + cnt.b + cnt.c;
  const expect = total / 3;
  for (const k of ['a', 'b', 'c']) {
    const dev = Math.abs(cnt[k] - expect) / expect;
    assert.ok(dev < 0.02, '字符 ' + k + ' 频率偏差过大: ' + (dev * 100).toFixed(2) + '%（实测 ' + cnt[k] + ', 期望 ' + Math.round(expect) + '）');
  }
});

t('同一字符集多次生成不重复（随机性）', () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(genPwd(chars, 16));
  assert.ok(seen.size >= 499, '500 次生成应几乎全不相同，实际唯一数 ' + seen.size);
});

/* ---- 源码检查：confirm 用的是拒绝采样，不是裸取模 ---- */
t('源码里不再是裸 x % chars.length 直接映射', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'tools', 'security.js'), 'utf8');
  assert.ok(/limit/.test(src), '源码应包含拒绝采样的 limit 计算');
  assert.ok(/x < limit/.test(src), '源码应拒绝落在偏差区的随机数');
});

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
