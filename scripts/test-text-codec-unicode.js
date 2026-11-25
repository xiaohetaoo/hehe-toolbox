'use strict';
/* 回归：Unicode 转义解码（js/tools/text-codec.js 的 decodeUnicode）
 *
 * 【锁的是哪个历史回归】v0.9.x 的「Unicode 转换」只有编码方向能用。
 * 解码方向的正则写成 /\\\\u(...)/ —— 正则字面量里那是「两个反斜杠 + u」，
 * 而编码器输出的是「一个反斜杠 + u」，于是粘贴 \u4e2d 点「解码」原样返回。
 * 代理对那条正则同样多写了反斜杠，emoji 永远合并不回来。
 * 这个工具从加入起就是半个坏的，而且没有任何测试覆盖它。
 *
 * 【为什么是行为断言】decodeUnicode 是纯函数，直接从源码里取出真实现来跑，
 * 不问源码长什么样，只问输入输出对不对。 */
const { t, done, readSrc, extractFn } = require('./lib/harness');

const src = readSrc('js/tools/text-codec.js', { raw: true });
const fnSrc = extractFn(src, 'function decodeUnicode');
// 函数声明形态：包一层 return 就能取到它本身
const decodeUnicode = new Function('return ' + fnSrc)();

/* 与页面里 escOne 相同的编码规则（用于往返断言） */
function escOne(c) {
  const cp = c.codePointAt(0);
  if (cp > 0xffff) {
    const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
    const lo = ((cp - 0x10000) % 0x400) + 0xdc00;
    return '\\u' + hi.toString(16) + '\\u' + lo.toString(16);
  }
  return '\\u' + cp.toString(16).padStart(4, '0');
}
const encode = (text) => [...text]
  .map((c) => (c.codePointAt(0) > 127 || /[\u0000-\u001f]/.test(c)) ? escOne(c) : c)
  .join('');

t('U1 单反斜杠 \\u0041 解码为 A', () => {
  if (decodeUnicode('\\u0041') !== 'A') throw new Error('\\u0041 没有被解码');
});

t('U2 中文 \\u4e2d 解码为「中」', () => {
  if (decodeUnicode('\\u4e2d') !== '中') throw new Error('\\u4e2d 没有被解码');
});

t('U3 大小写混合的十六进制同样生效', () => {
  if (decodeUnicode('\\u4E2D') !== '中') throw new Error('大写十六进制没被解码');
});

t('U4 代理对能合回一个 emoji', () => {
  const got = decodeUnicode('\\ud83d\\ude00');
  if (got !== '\u{1F600}') throw new Error('代理对没有合并：' + JSON.stringify(got));
});

t('U5 编码→解码往返一致（含控制字符与 emoji）', () => {
  for (const sample of ['A', '中', 'a\tb', '\u{1F600}', '混合 mixed 123']) {
    const enc = encode(sample);
    const dec = decodeUnicode(enc);
    if (dec !== sample) throw new Error('往返不一致：' + JSON.stringify(sample) + ' → ' + JSON.stringify(enc) + ' → ' + JSON.stringify(dec));
  }
});

t('U6 不碰普通文本', () => {
  if (decodeUnicode('hello 世界') !== 'hello 世界') throw new Error('普通文本被改动了');
});

t('U7 不完整的转义保持原样', () => {
  // \u12 只有两位十六进制，不该被当成转义
  if (decodeUnicode('\\u12') !== '\\u12') throw new Error('不完整的转义被误处理');
});

done();
