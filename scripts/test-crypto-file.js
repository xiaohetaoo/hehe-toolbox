'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const { handlerIndex } = require('./lib/seg-from-handler');
/* rmDir 统一到 scripts/lib/test-fs.js —— 见那里的文件头说明。 */
const { rmDir } = require('./lib/test-fs');
const mainSrc = readMain({ raw: true });

/* 文件加密格式的行为测试（原 test-round13 的 1a / 1b / 1c）。
 *
 * 锁的是三件事：
 *   1a  0~16 字节的小文件也要能原样解回来（早期实现按 64 字节块对齐，
 *        小文件加密后解不回）。
 *   1b  56 字节（40 头 + 一个 16 字节块）是目前可能的最小合法密文 ——
 *        把它当"不完整"拒掉，会让合法的最小文件永远解不开。
 *   1c  真正被截断的文件仍要报「文件不完整」（不能为了迁就 1b 就全放行）。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * 都从主进程/渲染层源码里抽出**真实现**来跑，不是手写副本
 * （副本会与实现分叉，那样测试就假绿了）。 */
function extractCryptStream() {
  const i = mainSrc.indexOf('const ENC_MAGIC');
  const j = handlerIndex(mainSrc, 'fs:encrypt-file');
  assert.ok(i > 0 && j > i, '找不到 cryptStream 代码块');
  const block = mainSrc.slice(i, j);
  const requireShim = (m) => (m === 'stream' ? require('stream') : require(m));
  /* 【必须注入 tempNames】cryptStream 里生成临时文件名走的是
   * tempNames.cryptTmp(outPath)（任务 10 把临时名前缀收进了 lib/temp-names.js）。
   * 抽取这段代码求值时若不给它 tempNames，会直接 'tempNames is not defined'。
   * 注入的是**真实现**（require 真实模块），不是复刻，所以行为与生产一致。 */
  /* 【必须注入 pathGuard】cryptStream 现在会先过 checkOverwritable / checkFileName
   * （输出路径闸门，见 test-crypt-guard.js 的说明），不再只有 tempNames 一个外部依赖。
   * 注入的同样是**真实现**：拒绝理由、错误码、canonical 归一都与生产一致。 */
  return new Function('fs', 'fsp', 'path', 'crypto', 'send', 'require', 'tempNames', 'pathGuard',
    block + '\nreturn { cryptStream };')(
    fs, fs.promises, path, require('crypto'), () => {}, requireShim,
    require('../lib/temp-names'), require('../lib/path-guard'));
}

t('1a crypto：加密 0~16 字节的文件，全部能原样解回来', async () => {
  const { cryptStream } = extractCryptStream();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-crypt-'));
  try {
    const samples = [
      ['empty', ''],
      ['one', 'A'],
      ['eight', '12345678'],
      ['fifteen', '123456789012345'],
      ['sixteen', '1234567890123456'],   // 恰好一个完整分组，密文 72 字节
    ];
    for (const [label, content] of samples) {
      const src = path.join(dir, label + '.txt');
      fs.writeFileSync(src, content);
      const enc = path.join(dir, label + '.hehe');
      await cryptStream(src, enc, 'pw', false);
      const out = path.join(dir, label + '.out');
      await cryptStream(enc, out, 'pw', true);
      assert.strictEqual(fs.readFileSync(out, 'utf8'), content,
        label + '（原文 ' + Buffer.byteLength(content) + ' 字节）往返后内容不一致');
    }
  } finally { rmDir(dir); }
});

t('1b crypto：56 字节（40 头 + 一个 16 字节块）是目前可能的最小合法密文', async () => {
  const { cryptStream } = extractCryptStream();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-min-'));
  try {
    const src = path.join(dir, 'e.txt');
    fs.writeFileSync(src, '');
    const enc = path.join(dir, 'e.hehe');
    await cryptStream(src, enc, 'pw', false);
    const size = fs.statSync(enc).size;
    assert.strictEqual(size, 56, '空文件密文应为 56 字节，实际 ' + size);

    /* 【下限必须是行为断言的靶子，不能只查源码里出现过某个标识符】
     * 原实现是：
     *   assert.ok(/MIN_ENC_SIZE|st\.size < 56/.test(mainSrc)
     *     || !/st\.size < 64/.test(mainSrc), '…')
     * 这是个恒真式 —— 左半边只要源码任何位置出现过 `MIN_ENC_SIZE` 就为真
     * （main.js 里正是 `const MIN_ENC_SIZE = 40 + 16;`），
     * 右半边在 main.js 不再用字面量 64 时也恒真。
     * 实测确认：把 `40 + 16` 改成 `40 + 32`（=72），断言仍然为真 ——
     * 而 56 字节的合法密文会被判成「文件不完整」，1a 也照样绿
     * （1a 用的最短是 0 字节源 → 72 字节密文）。
     *
     * 现在改成真跑一遍：56 字节必须解得开，差 1 字节必须报「不完整」。
     * 这样 56 这个数字是被行为锁住的，改成任何 ≥57 的值都会立刻红。 */
    const out = path.join(dir, 'e.out');
    await cryptStream(enc, out, 'pw', true);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), '', '56 字节的最小合法密文没能解开');

    /* 截掉最后 1 字节 → 55 字节，必须报「文件不完整」而不是静默产出空文件 */
    const truncated = path.join(dir, 'e55.hehe');
    fs.writeFileSync(truncated, fs.readFileSync(enc).subarray(0, 55));
    let threw = null;
    try {
      await cryptStream(truncated, path.join(dir, 'e55.out'), 'pw', true);
    } catch (e) { threw = e; }
    assert.ok(threw, '55 字节的密文没有被拒绝（下限形同虚设）');
    assert.ok(/不完整|至少应有/.test(String(threw.message)),
      '55 字节密文的报错文案不是「文件不完整」：' + threw.message);
  } finally { rmDir(dir); }
});

t('1c crypto：真正被截断的文件仍然要报「文件不完整」', async () => {
  const { cryptStream } = extractCryptStream();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-trunc-'));
  try {
    const src = path.join(dir, 'a.txt');
    fs.writeFileSync(src, 'hello world');
    const enc = path.join(dir, 'a.hehe');
    await cryptStream(src, enc, 'pw', false);
    const buf = fs.readFileSync(enc);
    const truncated = path.join(dir, 't.hehe');
    fs.writeFileSync(truncated, buf.subarray(0, 30));   // 连文件头都不够
    await assert.rejects(
      () => cryptStream(truncated, path.join(dir, 't.out'), 'pw', true),
      /文件不完整/,
      '截断到 30 字节时必须报文件不完整');
  } finally { rmDir(dir); }
});

/* ==================== 2. 密码脱敏（含空格） ==================== */


done();
