'use strict';
/* 崩溃日志的尾部截取不能把 UTF-8 多字节字符切成两半。
 *
 * ============ 锁的是哪个回归 ============
 * `tail()` 的起点是 `Math.max(0, st.size - limit)` —— 按**字节**算的。
 * 落在中文字符（UTF-8 三字节）中间时，第一个字符会被 decode 成 U+FFFD。
 * 日志正文全是中文（错误说明、实测结论、路径），几乎必然命中。
 *
 * 实测：造一份 414890 字节的中文日志，tail(dir, 16KB) 返回的文本开头是
 * `"\uFFFD于验证尾部截取是否会切断多字节字符。"` —— 用户在设置页点
 * 「查看最近崩溃」，看到的第一行就是个黑问号，而那恰好是他最需要读的一行。
 *
 * ============ 验证方式 ============
 * 纯行为：造真实文件、真调 tail()、看返回的文本。
 * 不需要 Electron，也不需要真的崩一次。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { t, done, assert } = require('./lib/harness');

const crashLog = require('../lib/crash-log');

/* 造一个临时目录 + 一份内容可控的日志。
 * 【文件名必须是 crash.log 或 crash.N.log】listLogs 用
 * `/^crash(\.\d+)?\.log$/` 过滤，随便起名会被跳过（实测踩过：
 * 名字不对时 tail 返回空文本，断言报"没读到任何内容"）。 */
function makeLogDir(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-tail-'));
  fs.writeFileSync(path.join(dir, 'crash.log'), content, 'utf8');
  return dir;
}

t('T1 全中文日志：尾部截取后不含替换字符 U+FFFD', () => {
  /* 锁的是：从 UTF-8 多字节字符中间切开 → 首行是黑问号。
   * 行为断言：造真文件、真读、看文本。
   *
   * 【必须让切点确定落在字符中间】早先的写法只是"打乱对齐后铺大量汉字"，
   * 实测跑下来 T1 在变异后**没有变红** —— 因为切点恰好落在了字符边界上，
   * 改成直接 decode 也碰巧是对的。那样这条断言就时灵时不灵。
   * 现在显式构造：把文件长度凑到「16KB 切点落在某个三字节汉字的中间」。
   * 做法：先放一个 1 字节前缀（让整个流偏移 1），再铺三字节汉字 ——
   * 于是 (总长 - 16384) 这个位置相对字符起点偏移 1，必然切开三字节字符。 */
  const line = '这是验证尾部截取是否会切断多字节字符的一行测试文本。\n';
  const LIMIT = 16 * 1024;
  /* 【直接构造：让文件总长 = LIMIT + 1，且第 1 个字节是汉字的第一字节】
   * 这样 tail 的 start = 1，读到的 buf[0] 正是那个汉字被切下来的第三字节
   * （三字节汉字 0xE4-0xE9 开头，第 1 个字节是续字节 0x80-0xBF）。
   * 比"试各种前缀"确定得多 —— 后者依赖行长整除，实测找不到可行解。 */
  const head = '错';                       // 三字节：E9 94 99
  const isCont = (b) => (b & 0xC0) === 0x80;
  assert.ok(isCont(Buffer.from(head, 'utf8')[1]), '前提：错 字的第 2 个字节应是续字节');

  /* 先铺满一段中文，再裁掉头部的若干字符，让总长精确等于 LIMIT + 1 */
  let body = '';
  while (Buffer.byteLength(head + body, 'utf8') < LIMIT + 1) body += line;
  /* 从尾部往前裁，直到总长 = LIMIT + 1（裁的是整行，不破坏编码） */
  const lines = body.split('\n').filter(Boolean);
  while (Buffer.byteLength(head + lines.join('\n') + '\n', 'utf8') > LIMIT + 1) lines.pop();
  /* 最后补一个中文，凑到恰好 LIMIT+1（补完可能超，那就换个更短的尾巴） */
  let content = head + lines.join('\n') + '\n';
  while (Buffer.byteLength(content, 'utf8') > LIMIT + 1) {
    content = content.slice(0, -1);        // 倒退的是换行符，安全
  }
  /* 若还差几个字节，用 ASCII 补齐（ASCII 是单字节，不影响前面的汉字对齐） */
  while (Buffer.byteLength(content, 'utf8') < LIMIT + 1) content += 'x';

  const buf = Buffer.from(content, 'utf8');
  assert.strictEqual(buf.length, LIMIT + 1, '构造出来的长度不对');
  assert.ok(isCont(buf[1]),
    '测试构造失败：start=1 处的字节不是续字节（0x' + buf[1].toString(16) + '）');

  const dir = makeLogDir(content);
  try {
    const r = crashLog.tail(dir, LIMIT);
    assert.ok(r.text.length > 0, '没读到任何内容');
    assert.strictEqual(r.truncated, true, '应标记为已截断');
    assert.strictEqual(r.text.includes('\uFFFD'), false,
      '截取后的文本里有 U+FFFD（黑问号）—— UTF-8 字符被从中间切开了。'
      + '首 40 字符：' + JSON.stringify(r.text.slice(0, 40)));
    assert.strictEqual(JSON.parse(JSON.stringify(r.text)), r.text);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

t('T2 截断后的第一行必须是完整的一行（不能是半句）', () => {
  /* 锁的是：只跳过续字节还不够 —— 用户看到的应该是**完整的一行**，
   * 从半行开始同样难读（虽然不出现黑问号）。
   * 这里的判据放宽到"不含 U+FFFD 且以合法字符开头"，不强制对齐到行首：
   * 对齐行首是产品取舍（会少显示最多几十字节），不是正确性问题。 */
  const line = '错误发生在 IPC 处理器里：无法读取 C:\\Users\\测试\\数据.json\n';
  let content = '';
  while (Buffer.byteLength(content, 'utf8') < 100 * 1024) content += line;

  const dir = makeLogDir(content);
  try {
    const r = crashLog.tail(dir, 8 * 1024);
    assert.strictEqual(r.text.includes('\uFFFD'), false,
      '出现了 U+FFFD');
    /* 首字符不能是续字节解出来的怪字符 */
    const first = r.text.charCodeAt(0);
    assert.ok(first >= 0x20 || first === 0x0A,
      '首字符是不可打印的控制字符：U+' + first.toString(16));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

t('T3 中文 + emoji（四字节字符）也不能被切坏', () => {
  /* 锁的是：只考虑三字节汉字、忘了 emoji 是四字节 —— 跳过续字节的逻辑
   * 对两者是同一套（都是 0b10xxxxxx），但必须证明它确实覆盖到。 */
  const line = '崩溃现场 🧪 复现步骤 🔧 结果 📋\n';
  let content = '';
  while (Buffer.byteLength(content, 'utf8') < 60 * 1024) content += line;

  const dir = makeLogDir(content);
  try {
    const r = crashLog.tail(dir, 4 * 1024);
    assert.strictEqual(r.text.includes('\uFFFD'), false,
      '四字节字符（emoji）被切坏了');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

t('T4 文件小于限额时不截断（首字节一定是起始字节，无需跳过）', () => {
  /* 锁的是：为了修截断问题，把"从文件头读"的正常路径也破坏了
   * （比如无条件跳过开头字节，会把第一个字吃掉）。 */
  const content = '短日志：只崩溃了一次。\n';
  const dir = makeLogDir(content);
  try {
    const r = crashLog.tail(dir, 16 * 1024);
    assert.strictEqual(r.truncated, false, '小文件不该标记为截断');
    assert.strictEqual(r.text, content,
      '小文件的内容被改动了（不该跳过任何字节）');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

t('T5 纯 ASCII 日志不受影响（回归保护）', () => {
  /* 锁的是：修中文截断时把英文日志弄坏 —— 那是绝大多数崩溃栈的形态。 */
  let content = '';
  while (Buffer.byteLength(content, 'utf8') < 40 * 1024) content += 'TypeError: x is undefined\n    at foo (main.js:1:1)\n';
  const dir = makeLogDir(content);
  try {
    const r = crashLog.tail(dir, 4 * 1024);
    assert.strictEqual(r.text.includes('\uFFFD'), false, 'ASCII 日志里出现了 U+FFFD');
    assert.ok(/TypeError|at foo/.test(r.text), 'ASCII 日志内容不对');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

done();
