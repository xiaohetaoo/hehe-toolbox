'use strict';
/* 乱码修复核心逻辑测试。
 *
 * 重点验证「能真正接到东西」而不是只返回空壳：
 * 造出真实的乱码，看它能不能修回去。
 */
const assert = require('assert');
const m = require('../lib/mojibake');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

/* ---- 1. 打分函数：好文本 vs 垃圾 ---- */
t('自然中文比乱码得分高得多', () => {
  const good = m.scoreText('这是一段正常的中文文本，用于测试编码识别是否正确。');
  const bad = m.scoreText('\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD');
  assert.ok(good > bad + 100, `好文本 ${good.toFixed(1)} 应远高于乱码 ${bad.toFixed(1)}`);
});

t('替换字符会被重罚', () => {
  const a = m.scoreText('正常文本没有替换字符');
  const b = m.scoreText('正常文本\uFFFD\uFFFD\uFFFD');
  assert.ok(a > b, '有替换字符的应更低');
});

t('控制字符会被重罚', () => {
  const a = m.scoreText('正常文本');
  const b = m.scoreText('正常文本\u0001\u0002\u0003');
  assert.ok(a > b, '有控制字符的应更低');
});

t('纯 ASCII 代码也算合理文本', () => {
  assert.ok(m.scoreText('function foo() { return 42; }') > 0);
});

t('空字符串得最低分', () => {
  assert.ok(m.scoreText('') <= -1000);
});

/* ---- 2. 锟斤拷识别 ---- */
t('能识别「锟斤拷」连用', () => {
  assert.ok(m.looksLikeKuen('这段文字全是锟斤拷锟斤拷锟斤拷'));
  assert.ok(m.looksLikeKuen('随便一句话锟斤拷'));
});

t('正常提到「锟」字不算乱码', () => {
  assert.ok(!m.looksLikeKuen('锟铻是一种古代的宝剑名称'), '单个生僻字不该判为乱码');
  assert.ok(!m.looksLikeKuen('这是一段完全正常的中文'));
});

/* ---- 3. 编码探测：造真实 GBK 字节 ---- */
/* GBK 的「你好」= C4 E3 BA C3 —— 这是众所周知的一组字节 */
t('给 GBK 字节，探测结果里 GBK 排前列且解出「你好」', () => {
  const bytes = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]);
  const r = m.detectEncodings(bytes);
  assert.ok(r.length > 0, '应至少有一个候选');
  const gbk = r.find((x) => x.encodings === 'gbk');
  assert.ok(gbk, '候选里应包含 gbk');
  assert.strictEqual(gbk.text, '你好', 'GBK 解码「你好」失败，实际：' + JSON.stringify(gbk.text));
  // GBK 解出的应该是高分候选（排在前两名，utf-8 面对这些字节会全是替换字符）
  const idx = r.findIndex((x) => x.encodings === 'gbk');
  assert.ok(idx <= 1, 'GBK 应排在前面，实际排第 ' + (idx + 1));
});

t('给 UTF-8 字节，UTF-8 排在第一位', () => {
  const bytes = Buffer.from('这是一段中文文本，用来验证编码探测。', 'utf8');
  const r = m.detectEncodings(bytes);
  assert.strictEqual(r[0].encodings, 'utf-8', 'UTF-8 应排第一，实际第一是 ' + r[0].encodings);
});

t('给 UTF-8 字节，GBK 解出来必然是一堆替换字符（对比参照）', () => {
  const bytes = Buffer.from('中文内容', 'utf8');
  const r = m.detectEncodings(bytes);
  const gbk = r.find((x) => x.encodings === 'gbk');
  assert.ok(gbk, '应有 gbk 候选');
  assert.ok(gbk.text.includes('\uFFFD') || gbk.score < r[0].score,
    'GBK 解 UTF-8 字节应当明显更差');
});

t('GB18030 也能解 GBK 字节（超集）', () => {
  const bytes = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]);
  const r = m.detectEncodings(bytes);
  const g = r.find((x) => x.encodings === 'gb18030');
  assert.ok(g && g.text === '你好', 'GB18030 是 GBK 超集，应能解出「你好」');
});

/* ---- 4. latin1 字节视角的还原 ---- */
t('latin1 形态的字节能被还原成 UTF-8 文本', () => {
  /* 模拟：UTF-8 文本被当作 latin1 读 —— 字符码点就是原始字节值。
   * 把「中文」的 UTF-8 字节各字节映射成 latin1 字符，应当能还原。 */
  const original = '中文测试';
  const bytes = Buffer.from(original, 'utf8');
  const asLatin1 = bytes.toString('latin1');   // 这就是被误读后的样子
  const r = m.analyzeMojibake(asLatin1);
  const hit = r.candidates.find((c) => c.text === original);
  assert.ok(hit, '应从 latin1 形态还原出原文，候选：' + JSON.stringify(r.candidates.slice(0, 3).map((c) => c.text)));
});

t('分析结果里最优候选的分数最高', () => {
  const r = m.analyzeMojibake('test');
  assert.ok(r.best, '应有最优候选');
  for (const c of r.candidates) {
    assert.ok(r.best.score >= c.score, '最优候选分数不是最高');
  }
});

t('空输入不会崩', () => {
  const r = m.analyzeMojibake('');
  assert.strictEqual(r.best, null);
  assert.strictEqual(r.note, '输入为空');
});

t('正常中文输入，最优候选应保持原样（不该被乱改）', () => {
  const r = m.analyzeMojibake('这是一段完全正常的中文，不应该被改坏。');
  assert.ok(r.best, '应有候选');
  assert.strictEqual(r.best.text, '这是一段完全正常的中文，不应该被改坏。',
    '正常文本被改成了：' + JSON.stringify(r.best.text));
});

t('锟斤拷输入会给出说明', () => {
  const r = m.analyzeMojibake('锟斤拷锟斤拷锟斤拷锟斤拷');
  assert.ok(r.kuen, '应识别为锟斤拷');
  assert.ok(r.note.indexOf('锟斤拷') !== -1, '说明里应提到锟斤拷');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
