'use strict';
/* 敏感内容识别 + 过期挑选（lib/sensitive.js）。
 *
 * ============ 锁的是哪次事故 / 哪个决策 ============
 * 剪贴板历史把用户复制的密码、密钥、身份证号一并存进**明文 JSON**，
 * 且默认永不清理。加「敏感内容自动清理」来缓解。
 *
 * 但这个功能的风险不对称：
 *   · 漏判 → 一条敏感内容多留一会儿（用户自己也可能已经清掉）；
 *   · **错判 → 用户的正常内容被自动删了**，不可恢复。
 * 所以本文件的用例刻意让"不该判敏感"的数量多于"该判敏感"，
 * 且每一条不该判的都对应一种真实会出现的正常内容。
 */
const assert = require('assert');

const { t, done } = require('./lib/harness');
const S = require('../lib/sensitive.js');

t('SE1 明确的凭据形态应被判为敏感', () => {
  const yes = [
    ['-----BEGIN RSA PRIVATE KEY-----', 'PEM 私钥'],
    ['ghp_' + 'a'.repeat(36), 'GitHub 令牌'],
    /* 【github_pat_ 是 GitHub 2022 年后的 fine-grained token】
     * v0.8.4 收尾的走查里发现这种新形态整条放过 —— 它同样是完整的
     * 仓库访问凭据。长度下限 30（github_pat_ 后）防误伤普通文本，
     * github_pat_short 这类短串不能命中。 */
    ['github_pat_' + 'aB3xY9kL2mNpQrStUvWx'.repeat(2), 'GitHub 令牌（fine-grained）'],
    ['sk-' + 'a'.repeat(32), 'API 密钥'],
    ['AKIA' + 'A'.repeat(16), 'AWS 访问密钥'],
    ['110101199001011234', '身份证号'],
    ['4111111111111111', '银行卡号'],
    ['Abc123!@#defG', '强密码形态'],
    ['a'.repeat(44), '长 base64 密钥串'],
  ];
  for (const [text, why] of yes) {
    const r = S.inspect(text);
    /* 锁的是：某一类凭据的判据被削弱/删掉 —— 那条敏感内容会一直留在明文里。 */
    assert.strictEqual(r.sensitive, true, why + ' 应判为敏感（实际 false）');
    assert.ok(r.why, why + ' 应给出判定理由');
  }
});

t('SE2 正常内容绝不能被判敏感（错判会删掉用户数据）', () => {
  const no = [
    ['请重置你的 password', '含 password 字样的说明文字'],
    ['ORDER-2024-001', '订单号'],
    ['hello world', '普通英文'],
    ['A'.repeat(10), '短串'],
    ['123456', '验证码'],
    ['张三 13800138000', '联系方式'],
    ['这是一段很长的中文说明文字，讲的是如何使用这个工具。', '中文正文'],
    ['version 1.2.3', '版本号'],
    ['https://example.com/a', '网址'],
    ['2024-01-01 12:00:00', '日期时间'],
    ['', '空串'],
  ];
  for (const [text, why] of no) {
    const r = S.inspect(text);
    /* 锁的是：误判 —— 这条是数据丢失的来源，比漏判严重得多。 */
    assert.strictEqual(r.sensitive, false, why + ' 不该判敏感（实际被判了，理由 ' + r.why + '）');
  }
});

t('SE3 银行卡规则要求整段就是 16 位（不能从长数字串里切）', () => {
  /* 锁的是：正则没加首尾锚点 —— 20 位订单号中间 16 位会被切成"银行卡号"，
   * 用户的正常数据被清掉。 */
  assert.strictEqual(S.isSensitive('4111111111111111'), true, '纯 16 位应判敏感');
  assert.strictEqual(S.isSensitive('41111111111111119999'), false, '20 位数字不该被切出 16 位');
  assert.strictEqual(S.isSensitive('订单 4111111111111111 号'), false, '嵌在文字里的 16 位不该判');
});

t('SE4 超长文本不当凭据（那是正文）', () => {
  /* 锁的是：把一长段 markdown 文档判成敏感而删掉 —— 它可能只是
   * 恰好含一个 sk- 前缀的实现示例。 */
  const long = ('说明文字 '.repeat(1200)) + ' sk-' + 'a'.repeat(32);
  assert.ok(long.length > 4096, '用例本身要超过 4096 字符，实际 ' + long.length);
  assert.strictEqual(S.isSensitive(long), false, '超过 4096 字符的正文不该判敏感');
});

t('SE5 pickExpired：只删过期的、非置顶的敏感条目', () => {
  const now = 1700000000000;
  const old = now - 20 * 60 * 1000;    // 20 分钟前
  const recent = now - 2 * 60 * 1000;   // 2 分钟前
  const list = [
    { type: 'text', content: 'ghp_' + 'a'.repeat(36), time: old },          // 该删
    { type: 'text', content: 'ghp_' + 'b'.repeat(36), time: recent },       // 没过期
    { type: 'text', content: 'ghp_' + 'c'.repeat(36), time: old, pinned: true }, // 置顶不删
    { type: 'text', content: '普通文本', time: old },                        // 不敏感
    { type: 'image', file: 'a.png', time: old },                             // 图片不参与
  ];
  const r = S.pickExpired(list, { ttlMinutes: 10, now });
  /* 锁的是：置顶条目被自动删掉 —— 用户的"我要留着"被无视，置顶按钮失去意义。 */
  assert.strictEqual(r.drop.length, 1, '应只删 1 条，实际 ' + r.drop.length);
  assert.ok(r.drop[0].content.startsWith('ghp_aaaa'), '删的应是过期未置顶那条');
  assert.strictEqual(r.keep.length, 4, '其余 4 条都应保留');

  /* 置顶那条必须还在 keep 里 */
  const pinned = r.keep.find((x) => x.pinned);
  assert.ok(pinned, '置顶条目必须保留');
});

t('SE6 pickExpired：ttl 为 0 时什么都不删', () => {
  const now = 1700000000000;
  const list = [{ type: 'text', content: 'ghp_' + 'a'.repeat(36), time: now - 999999999 }];
  const r = S.pickExpired(list, { ttlMinutes: 0, now });
  /* 锁的是：功能关闭后仍删东西 —— 那是明确的越权。 */
  assert.strictEqual(r.drop.length, 0, 'ttl=0（关闭）不该删任何东西');
  assert.strictEqual(r.keep.length, 1);
});

t('SE7 pickExpired：缺时间的条目不删（宁可留也不误删）', () => {
  const now = 1700000000000;
  const list = [{ type: 'text', content: 'ghp_' + 'a'.repeat(36) }];  // 没有 time
  const r = S.pickExpired(list, { ttlMinutes: 10, now });
  /* 锁的是：时间字段缺失时被当成"很久以前"而删掉 ——
   * 老数据（该字段加入之前存的）会被一次性清空。 */
  assert.strictEqual(r.drop.length, 0, '缺时间的条目不该被删');
});

t('SE8 inspect 对 null/undefined 不抛', () => {
  assert.strictEqual(S.isSensitive(null), false);
  assert.strictEqual(S.isSensitive(undefined), false);
  assert.strictEqual(S.isSensitive(123), false);
});

done();
