'use strict';
/* 剪贴板内容分析（lib/clip-analyze.js）。
 *
 * ============ 锁的是哪次事故 / 哪个决策 ============
 * 用户明确要求做「全局剪贴板动作面板」。这个面板的全部价值取决于
 * **类型判定对不对** —— 判错类型，给出的动作全都不适用，比没有面板更差。
 *
 * 特别注意两类错：
 *   ① **漏判**（该认出 URL 却当成普通文本）→ 用户看不到有用的动作；
 *   ② **误判**（把普通文本当成 Base64 图片）→ 用户点了得到一坨乱码/报错。
 * 两类都要覆盖，其中误判的用例更多 —— 因为误判更难察觉、后果更烦。
 */
const assert = require('assert');

const { t, done } = require('./lib/harness');
const C = require('../lib/clip-analyze.js');

t('CA1 各类内容都能正确识别', () => {
  const cases = [
    ['https://example.com/a?b=1', 'url', '网址'],
    ['http://a.b/c', 'url', 'http 网址'],
    ['ftp://x/y', 'url', 'ftp'],
    ['C:\\Windows\\notepad.exe', 'path', 'Windows 反斜杠路径'],
    ['D:/work/a.txt', 'path', '盘符正斜杠'],
    ['\\\\server\\share\\f', 'path', 'UNC 路径'],
    ['/usr/local/bin/x', 'path', 'POSIX 路径'],
    ['{"a":1}', 'json', 'JSON 对象'],
    ['[1,2,3]', 'json', 'JSON 数组'],
    ['d41d8cd98f00b204e9800998ecf8427e', 'hash', 'MD5'],
    ['#FF4D4F', 'color', 'hex 颜色'],
    ['rgb(255,77,79)', 'color', 'rgb'],
    ['1700000000', 'timestamp', '10 位秒'],
    ['1700000000000', 'timestamp', '13 位毫秒'],
    ['普通的一段中文文字', 'text', '中文文本'],
  ];
  for (const [text, want, why] of cases) {
    const r = C.analyze({ text });
    /* 锁的是：某一类内容的判定退化（比如 URL 被当文本、JSON 被当哈希）。 */
    assert.strictEqual(r.kind, want, why + ' 应判为 ' + want + '，实际 ' + r.kind);
    assert.ok(r.actions.length > 0, why + ' 不该没有动作');
  }
});

t('CA2 不该误判的情形（误判比漏判更烦）', () => {
  const nega = [
    ['123', '纯数字不该当 JSON 或时间戳'],
    ['a.b.c', '普通点分不该当 JWT'],
    ['hello', '短词不该当 Base64 图片'],
    ['/a', '单段斜杠不该当路径'],
    ['这是一段很长的中文说明，讲的是怎么用工具。', '中文正文'],
    ['ORDER-2024-0001', '订单号'],
    ['version 1.2.3', '版本号串'],
    ['100%', '百分比'],
  ];
  for (const [text, why] of nega) {
    const r = C.analyze({ text });
    /* 锁的是：短词/普通文本被误判成某种数据形态 —— 用户会看到一堆不适用动作。 */
    assert.strictEqual(r.kind, 'text', why + ' 应判为 text，实际 ' + r.kind);
  }
});

t('CA3 空剪贴板与图片走不同分支', () => {
  /* 锁的是：空内容也给出动作列表（点哪个都会失败）。 */
  const empty = C.analyze({ text: '' });
  assert.strictEqual(empty.kind, 'empty');
  assert.strictEqual(empty.actions.length, 0, '空内容不该有动作');

  /* 锁的是：图片没走图片分支（会被当成文本去统计字符数）。 */
  const img = C.analyze({ isImage: true, imageSize: { w: 100, h: 50 } });
  assert.strictEqual(img.kind, 'image');
  assert.ok(img.label.indexOf('100') >= 0, '标签里应带尺寸：' + img.label);
  assert.ok(img.actions.indexOf('imgAnnotate') >= 0, '图片应给「标注」动作');
  assert.ok(img.actions.indexOf('imgOcr') >= 0, '图片应给「OCR」动作');
});

t('CA4 乱码能被认出（含替换字符或 Latin-1 成片出现）', () => {
  /* 锁的是：UTF-8 被按 Latin-1 解码的典型乱码被判成普通文本 ——
   * 用户就看不到「乱码修复」这个动作。 */
  const bad = C.analyze({ text: 'ä½\u00a0å¥½ä¸–ç•Œ' });
  assert.strictEqual(bad.kind, 'mojibake', '典型乱码应被认出，实际 ' + bad.kind);
  assert.ok(bad.actions.indexOf('txtMojibake') >= 0, '乱码应给「乱码修复」动作');

  /* 反向：正常中英混排绝不能被判乱码 */
  const ok = C.analyze({ text: 'Hello 世界 123' });
  assert.strictEqual(ok.kind, 'text', '正常文本不该判乱码');
});

t('CA5 每个动作 id 都在 ACTIONS 表里（面板不会渲染出空按钮）', () => {
  const samples = ['https://a.b', 'C:\\a\\b.txt', '{"a":1}', '#fff',
    '1700000000', 'plain text', 'ä½\u00a0å¥½'];
  for (const s of samples) {
    const r = C.analyze({ text: s });
    for (const a of r.actions) {
      /* 锁的是：analyze 引用了 ACTIONS 里不存在的 id ——
       * 面板会渲染出一个"标签 undefined"的空按钮。 */
      assert.ok(C.ACTIONS[a], '动作 id ' + a + ' 未在 ACTIONS 里定义（来自 ' + r.kind + '）');
      assert.ok(C.ACTIONS[a].label, '动作 ' + a + ' 缺少 label');
      assert.ok(C.ACTIONS[a].icon, '动作 ' + a + ' 缺少 icon');
    }
  }
});

t('CA6 Base64 图片必须看魔数，不能只看"能解开"', () => {
  /* 锁的是：把任意合法 base64 字符串当成图片 —— 用户点「保存图片」
   * 会得到一个损坏的文件。判据必须是解码后的文件头魔数。 */
  const realPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = C.analyze({ text: realPng });
  assert.strictEqual(r.kind, 'base64image', '真实 PNG 的 base64 应被认出，实际 ' + r.kind);

  /* 'aGVsbG8gd29ybGQ=' 是 "hello world" 的 base64 —— 合法但不是图片 */
  const notImg = C.analyze({ text: 'aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYW4gaW1hZ2UgYXQgYWxsIGp1c3QgdGV4dA==' });
  assert.strictEqual(notImg.kind, 'text', '普通文本的 base64 不该判成图片，实际 ' + notImg.kind);
});

t('CA7 data URL 形式的图片也能认', () => {
  const r = C.analyze({ text: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.strictEqual(r.kind, 'base64image');
  assert.strictEqual(r.raw.mime, 'png');
});

t('CA8 JWT 必须能解出 header 才算（防止 a.b.c 误判）', () => {
  /* 真实结构的 JWT：header 是 base64url 的 {"alg":"HS256","typ":"JWT"} */
  const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
  const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0';
  const sig = 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const r = C.analyze({ text: header + '.' + payload + '.' + sig });
  assert.strictEqual(r.kind, 'jwt', '合法 JWT 应被认出，实际 ' + r.kind);

  /* 三段但 header 解不出 JSON 的，不能被当成 JWT */
  const fake = C.analyze({ text: 'aaaa.bbbb.cccc' });
  assert.strictEqual(fake.kind, 'text', '解不出 header 的三段串不该判 JWT');
});

done();
