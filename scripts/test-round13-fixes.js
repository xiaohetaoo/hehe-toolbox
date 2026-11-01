'use strict';
/* 原脚本用 cases 收集 + 串行 for 循环，输出严格按注册顺序。
 * 这里显式指定 order:'sequential' 以保持迁移前的输出顺序不变。 */
const { createSuite, readTree } = require('./lib/harness');
const { t, done } = createSuite({ order: 'sequential' });
/* 本轮（第 13 轮全量审查）修复项的回归测试。
 *
 * 每一项都对应一个**已经复现出来的真实缺陷**，所以测试的重点不是「代码长什么样」，
 * 而是「那个具体输入现在得到正确结果了吗」。凡是能跑真实现的，都从 main.js
 * 里抽出真函数跑；只有纯结构约束才退回源码断言。
 *
 * 覆盖：
 *   1. 解密长度下限（56 而非 64）：加密 0~15 字节的文件能解回来
 *   2. sanitizeCmdError：密码含空格时不泄漏（message 与 stack 都要查）
 *   3. normSchedule：clean 类型保留 hhmm（否则静默改成 09:00 + 界面显示 undefined）
 *   4. zip:compress：不同目录的同名子目录不再互相覆盖
 *   5. cmpVer：带预发布后缀的版本号不再被判成「更旧」
 *   6. loadStore：数据文件损坏时先另存副本，不让默认值覆盖原文件
 *   7. rec:stop：GIF 目标名不再与录像输出同名（否则 ffmpeg 读写同一文件）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* 【这个脚本必须只读 main.js，不能改 readMain】
 * 任务 5 把搬家/权限域搬去了 ipc/acl-links.js，但这个脚本的 extract() 与
 * match() 依赖**单文件内的连续性**：函数体从 indexOf(pat) 开始配平花括号。
 * 拼成「main.js + ipc/」之后，跨文件边界会让配平跑进下一个文件，
 * 于是 11 条断言一起报「找不到 xxx」—— 本轮真的踩了。
 * 这里要验的（runCmd / moveFile / normSchedule / sanitizeCmdError …）本来就
 * 都留在 main.js 里，所以继续只读 main.js 是正确的边界。 */
const mainSrc = read('main.js');

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { try { cp.execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true }); } catch (e2) {} }
}

/* 从 main.js 里抽出 cryptStream 那一整块（含 ENC_MAGIC / deriveKey），
 * 用真实实现跑加解密往返 —— 复刻逻辑的测试在源码改动后照样全绿，等于没测。 */
function extractCryptStream() {
  const i = mainSrc.indexOf('const ENC_MAGIC');
  const j = mainSrc.indexOf("handle('fs:encrypt-file'");
  assert.ok(i > 0 && j > i, '找不到 cryptStream 代码块');
  const block = mainSrc.slice(i, j);
  const requireShim = (m) => (m === 'stream' ? require('stream') : require(m));
  /* 【必须注入 tempNames】cryptStream 里生成临时文件名走的是
   * tempNames.cryptTmp(outPath)（任务 10 把临时名前缀收进了 lib/temp-names.js）。
   * 抽取这段代码求值时若不给它 tempNames，会直接 'tempNames is not defined'。
   * 注入的是**真实现**（require 真实模块），不是复刻，所以行为与生产一致。 */
  return new Function('fs', 'fsp', 'path', 'crypto', 'send', 'require', 'tempNames',
    block + '\nreturn { cryptStream };')(
    fs, fs.promises, path, require('crypto'), () => {}, requireShim,
    require('../lib/temp-names'));
}

/* ==================== 1. 解密长度下限 ==================== */
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
    // 阈值必须 <= 56，否则这个文件永远解不开
    assert.ok(/MIN_ENC_SIZE|st\.size < 56/.test(mainSrc)
      || !/st\.size < 64/.test(mainSrc),
      'main.js 里仍在用 64 作为下限（会把 56 字节的合法密文判成「文件不完整」）');
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
function loadSanitize() {
  const i = mainSrc.indexOf('function sanitizeCmdError');
  const j = mainSrc.indexOf('// Windows PowerShell 输出默认是 OEM');
  assert.ok(i > 0 && j > i, '找不到 sanitizeCmdError');
  return new Function(mainSrc.slice(i, j) + '\nreturn sanitizeCmdError;')();
}

function realExecError(args) {
  return new Promise((resolve) => {
    cp.execFile(process.execPath, ['-e', 'process.exit(9)', ...args], () => {});
    cp.execFile(process.execPath, ['-e', 'process.exit(9)', ...args], (err) => resolve(err));
  });
}

t('2a 脱敏：密码含空格时 message 里不能残留密码片段', async () => {
  const sanitize = loadSanitize();
  for (const pw of ['has space', 'p@ss word!', 'ab cd', 'a b c d e f']) {
    const args = ['a', '-y', '-bd', '-p' + pw, '-mhe=on', 'out.7z', 'in.txt'];
    const err = await realExecError(args);
    assert.ok(err && err.message.includes(pw), '前置条件：原始错误里应含密码，实际 ' + (err && err.message));
    const clean = sanitize(err, args);
    assert.ok(!clean.message.includes(pw), '密码泄漏在 message 里：' + clean.message);
    /* 逐词检查：密码被空格切开后，任何一个词都不该单独留在输出里 */
    for (const word of pw.split(/\s+/)) {
      if (word.length < 3) continue;   // 太短的词会与命令本身巧合，跳过
      assert.ok(!clean.message.includes(word), '密码片段「' + word + '」仍泄漏：' + clean.message);
    }
  }
});

t('2b 脱敏：stack 里也不能残留密码（execFile 的 stack 首行就是整条命令行）', async () => {
  const sanitize = loadSanitize();
  const pw = 'my secret pass';
  const args = ['a', '-y', '-bd', '-p' + pw, '-mhe=on', 'out.7z'];
  const err = await realExecError(args);
  assert.ok(String(err.stack).includes(pw), '前置条件：原始 stack 里应含密码');
  const clean = sanitize(err, args);
  assert.ok(!String(clean.stack).includes(pw), '密码泄漏在 stack 里：' + String(clean.stack).split('\n')[0]);
});

t('2c 脱敏：原有规则未被破坏（-p 无空格、--password=、裸长串）', () => {
  const sanitize = loadSanitize();
  const r1 = sanitize(new Error('Command failed: 7z a -psecret123 out.7z'), ['a', '-psecret123', 'out.7z']);
  assert.ok(!r1.message.includes('secret123'), '普通密码未遮住：' + r1.message);
  const r2 = sanitize(new Error('bad --password=hunter2 in arg'), ['--password=hunter2']);
  assert.ok(!r2.message.includes('hunter2'), '--password= 未遮住：' + r2.message);
  const r3 = sanitize(new Error('token abcdefghij failed'), ['abcdefghij']);
  assert.ok(!r3.message.includes('abcdefghij'), '裸长串未遮住：' + r3.message);
});

/* ==================== 3. clean 周期任务保留 hhmm ==================== */
function loadNormSchedule() {
  const i = mainSrc.indexOf('const SCHED_TYPES');
  const j = mainSrc.indexOf('/* 生成不重复的本地 id');
  assert.ok(i > 0 && j > i, '找不到 normSchedule');
  return new Function(mainSrc.slice(i, j) + '\nreturn { normSchedule, SCHED_TYPES };')();
}

t('3a normSchedule：clean 类型必须保留用户选的 hhmm', () => {
  const { normSchedule } = loadNormSchedule();
  const out = normSchedule({ type: 'clean', hhmm: '03:00', message: '' });
  assert.strictEqual(out.hhmm, '03:00',
    'clean 任务的 hhmm 被丢掉了 —— armSchedule 会退回默认 09:00，界面也会显示 undefined。实际 ' + JSON.stringify(out));
});

t('3b normSchedule：daily 行为不变，非法时间仍然拒绝', () => {
  const { normSchedule } = loadNormSchedule();
  assert.strictEqual(normSchedule({ type: 'daily', hhmm: '9:05', message: 'x' }).hhmm, '09:05',
    'daily 的补零行为不该变');
  assert.throws(() => normSchedule({ type: 'daily', hhmm: '25:00', message: 'x' }), /超出范围/);
  assert.throws(() => normSchedule({ type: 'clean', hhmm: 'abc' }), /HH:MM/);
});

t('3c normSchedule：loop 仍只需要 everyMin，且不接受 NaN', () => {
  const { normSchedule } = loadNormSchedule();
  const r = normSchedule({ type: 'loop', everyMin: 15, message: 'hi' });
  assert.strictEqual(r.everyMin, 15);
  assert.ok(!('hhmm' in r), 'loop 不该带 hhmm');
  assert.throws(() => normSchedule({ type: 'loop', everyMin: 'abc' }), /数字/);
});

/* ==================== 4. zip 同名子目录不互相覆盖 ==================== */
/* zip:compress 的 handler 体是 async 的，抽出来时要包成 AsyncFunction。 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function extractZipCompress() {
  const i = mainSrc.indexOf("handle('zip:compress'");
  const j = mainSrc.indexOf("handle('zip:extract'");
  assert.ok(i > 0 && j > i, '找不到 zip:compress');
  const open = mainSrc.indexOf('{', i);
  /* 从 handler 的 `{` 到 `});` 之间：按括号配对找结束，避免正则跨块。 */
  let depth = 0, end = -1;
  for (let k = open; k < j; k++) {
    const c = mainSrc[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  assert.ok(end > open, '找不到 zip:compress 的函数体结尾');
  const body = mainSrc.slice(open + 1, end);
  return new AsyncFunction('e', 'paths', 'outZip', 'fs', 'fsp', 'path', 'pathGuard', 'AdmZip', body);
}

t('4a zip:compress 行为：两个不同目录下的同名子目录，内容都要保留', async () => {
  let AdmZip;
  try { AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip')); }
  catch (e) { console.log('     （跳过：没有 adm-zip）'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-zip-'));
  try {
    const a = path.join(dir, 'A', 'docs');
    const b = path.join(dir, 'B', 'docs');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, 'x.txt'), 'AAAA');
    fs.writeFileSync(path.join(b, 'x.txt'), 'BBBB');
    const out = path.join(dir, 'o.zip');

    const run = extractZipCompress();
    await run(null, [a, b], out, fs, fs.promises, path,
      require(path.join(ROOT, 'lib', 'path-guard')), AdmZip);

    const zip = new AdmZip(out);
    const names = zip.getEntries().map((x) => x.entryName);
    assert.strictEqual(names.length, 2, '两个目录应各留一个条目，实际：' + JSON.stringify(names));
    const bodies = names.map((n) => zip.getEntry(n).getData().toString()).sort();
    assert.deepStrictEqual(bodies, ['AAAA', 'BBBB'],
      '两份内容必须都在，实际：' + JSON.stringify(bodies) + '（条目 ' + JSON.stringify(names) + '）');
  } finally { rmDir(dir); }
});

t('4b zip:compress：顶层同名*文件*的去重没有被这次改动破坏', async () => {
  let AdmZip;
  try { AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip')); }
  catch (e) { return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-zip2-'));
  try {
    const d1 = path.join(dir, 'p1'); const d2 = path.join(dir, 'p2');
    fs.mkdirSync(d1, { recursive: true }); fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d1, 'same.txt'), 'ONE');
    fs.writeFileSync(path.join(d2, 'same.txt'), 'TWO');
    const out = path.join(dir, 'o.zip');
    const run = extractZipCompress();
    await run(null, [path.join(d1, 'same.txt'), path.join(d2, 'same.txt')], out,
      fs, fs.promises, path, require(path.join(ROOT, 'lib', 'path-guard')), AdmZip);
    const zip = new AdmZip(out);
    const bodies = zip.getEntries().map((x) => x.getData().toString()).sort();
    assert.deepStrictEqual(bodies, ['ONE', 'TWO'], '同名文件必须各自保留，实际：' + JSON.stringify(bodies));
  } finally { rmDir(dir); }
});

/* ==================== 5. cmpVer 与预发布后缀 ==================== */
function loadCmpVer() {
  const i = mainSrc.indexOf('function cmpVer');
  const j = mainSrc.indexOf('\n}', i) + 2;
  return new Function(mainSrc.slice(i, j) + '\nreturn cmpVer;')();
}

t('5a cmpVer：带 -beta / -rc1 后缀的版本号不能被判成「更旧」', () => {
  const cmpVer = loadCmpVer();
  assert.strictEqual(cmpVer('0.3.5-beta', '0.3.4'), 1,
    '预发布版仍比上一版新；原实现返回 -4（NaN 参与运算）');
  assert.strictEqual(cmpVer('0.4.0-rc1', '0.3.9'), 1);
  assert.strictEqual(cmpVer('0.3.5-beta', '0.3.5'), 0, '同一版本号的不同标记应视为相等');
});

t('5b cmpVer：三态语义（只返回 -1/0/1），且常规比较不变', () => {
  const cmpVer = loadCmpVer();
  const table = [
    ['0.3.5', '0.3.4', 1], ['0.3.4', '0.3.5', -1], ['0.3.5', '0.3.5', 0],
    ['0.3.10', '0.3.9', 1], ['0.0.9', '0.0.10', -1], ['1.0.0', '0.9.9', 1],
    ['v0.3.5', '0.3.4', 1],
  ];
  for (const [a, b, want] of table) {
    assert.strictEqual(cmpVer(a, b), want, 'cmpVer(' + a + ', ' + b + ') 应为 ' + want);
  }
});

t('5c cmpVer：无法解析的输入不抛异常，按 0 处理', () => {
  const cmpVer = loadCmpVer();
  assert.doesNotThrow(() => cmpVer('', '0.3.5'));
  assert.doesNotThrow(() => cmpVer('abc', undefined));
  assert.strictEqual(cmpVer('abc', '0.0.0'), 0, '解析不出来时按 0 比较，不能是 NaN');
});

/* ==================== 6. 数据文件损坏时不能静默覆盖 ==================== */
t('6a loadStore 行为：损坏的数据文件要先另存副本，再回退默认值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-store-'));
  try {
    const fake = path.join(dir, 'hehe-data.json');
    const good = {
      settings: { theme: 'dark' }, favorites: ['a', 'b'],
      notes: Array.from({ length: 50 }, (_, i) => ({ id: 'n' + i, text: '笔记' + i })),
    };
    const raw = JSON.stringify(good, null, 2);
    fs.writeFileSync(fake, raw.slice(0, raw.length - 40));   // 模拟断电截断

    /* 抽出 loadStore 的真实现，注入假的 storeFile / storeData。
     * 用 ctx 对象回传：new Function 里的局部变量改完要能带出来。 */
    const i = mainSrc.indexOf('function loadStore');
    const j = mainSrc.indexOf('function saveStore');
    assert.ok(i > 0 && j > i, '找不到 loadStore');
    const body = mainSrc.slice(i, j);
    const ctx = { data: { settings: {}, favorites: [], notes: [] }, failed: false, copy: null };
    const run2 = new Function('fs', 'storeFile', 'ctx', 'console',
      'let storeData = ctx.data, storeLoadFailed = ctx.failed, storeCorruptCopy = ctx.copy;' +
      body +
      '\nloadStore();\nctx.data = storeData; ctx.failed = storeLoadFailed; ctx.copy = storeCorruptCopy;');
    run2(fs, () => fake, ctx, { error: () => {}, warn: () => {} });

    assert.strictEqual(ctx.failed, true, '解析失败必须标记 storeLoadFailed');
    assert.ok(ctx.copy, '必须另存一份损坏文件的副本，否则 200ms 后就被默认值覆盖了');
    assert.ok(fs.existsSync(ctx.copy), '副本文件应真实存在：' + ctx.copy);
    assert.strictEqual(fs.readFileSync(ctx.copy, 'utf8'), fs.readFileSync(fake, 'utf8'),
      '副本内容必须与损坏的原文件逐字节相同');

    /* 关键后置条件：即使用户随后改了设置、原文件被覆盖，副本仍在 */
    const after = { settings: { closeToTray: false }, favorites: [], notes: [] };
    fs.writeFileSync(fake, JSON.stringify(after, null, 2));
    assert.ok(fs.existsSync(ctx.copy), '原文件被覆盖后，副本必须仍然存在');
    assert.ok(/笔记/.test(fs.readFileSync(ctx.copy, 'utf8')), '副本里应还留有可抢救的原始内容');
  } finally { rmDir(dir); }
});

t('6b main.js 暴露了 store:health，且渲染层真的会用它提示用户', () => {
  assert.ok(/handle\('store:health'/.test(mainSrc), '缺少 store:health 通道');
  assert.ok(/corruptCopy/.test(mainSrc), 'store:health 应带上副本路径');
  /* 光「调用了通道」不够 —— 必须真的把结果用于提示，且用户的可见反馈要带上
   * 副本文件名（否则用户不知道去哪找原数据）。这里查的是行为链，不是某个变量名。 */
  const app = read('js/app.js');
  const m = app.match(/store:health[\s\S]{0,900}?\n    \}/);
  assert.ok(m, '渲染层没有读取 store:health，用户不会知道数据文件坏了');
  const block = m[0];
  assert.ok(/health\.ok === false|!health\.ok/.test(block),
    '必须显式判断 health.ok === false 才提示（否则每次启动都会弹）');
  assert.ok(/toast\(/.test(block), '发现损坏后必须 toast 告知用户');
  assert.ok(/corruptCopy/.test(block), '提示里要带副本文件名，否则用户不知道去哪找原数据');
});

/* ==================== 7. GIF 目标名不能与录像同名 ==================== */
/* 从 main.js 抽取「GIF 目标名」那段真实现。
 * 现在这段用到了 REC_VIDEO_EXT / pathExists / PATH 等，所以整块抽出来再注入依赖，
 * 而不是只抽两行 —— 只抽两行会在新增常量后立刻报 REC_VIDEO_EXT is not defined。 */
function extractGifTarget() {
  const start = mainSrc.indexOf('const REC_VIDEO_EXT =');
  assert.ok(start > 0, '找不到 REC_VIDEO_EXT 定义');
  const endMarker = "gifTarget = recOut + '.gif';";
  const endAt = mainSrc.indexOf(endMarker, start);
  assert.ok(endAt > start, '找不到 gifTarget 兜底块');
  const after = mainSrc.indexOf('}', endAt);
  assert.ok(after > endAt, '兜底块的 } 没找到');
  const body = mainSrc.slice(start, after + 1);
  return new Function('recOut', 'path', body + '\nreturn gifTarget;');
}

t('7a rec:stop 的 GIF 目标：任何扩展名都不能与录像输出同名', () => {
  const f = extractGifTarget();
  const RE = /^\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|ts)$/i;
  for (const recOut of ['C:/r/rec.mp4', 'C:/r/rec.mkv', 'C:/r/rec.avi', 'C:/r/rec',
    'C:/r/rec.MP4', 'C:/a/b.c/rec', 'C:/r/rec.tar.gz', 'C:/r/v1.2', 'C:/r/.hidden']) {
    const gif = f(recOut, path, RE);
    assert.ok(path.resolve(gif).toLowerCase() !== path.resolve(recOut).toLowerCase(),
      recOut + ' 的 GIF 目标与录像同名（' + gif + '）—— ffmpeg 会读写同一文件，失败时还会把录像删掉');
    assert.ok(/\.gif$/i.test(gif), recOut + ' 的 GIF 目标扩展名不对：' + gif);
  }
});

t('7b 录像输出为 .mp4 时，GIF 与录像同目录同基名（不改变既有行为）', () => {
  const f = extractGifTarget();
  const RE = /^\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|ts)$/i;
  assert.strictEqual(f('C:/r/rec.mp4', path, RE), 'C:/r/rec.gif');
  /* 含点但无扩展名的要拼在其后，不能吃掉已有名字 */
  assert.strictEqual(f('C:/r/v1.2', path, RE), 'C:/r/v1.2.gif',
    'v1.2 不是扩展名，GIF 应叫 v1.2.gif 而不是 v1.gif');
  /* .hidden 是纯点开头，不能被当成扩展名导致跑到父目录 */
  assert.strictEqual(f('C:/r/.hidden', path, RE), 'C:/r/.hidden.gif',
    '.hidden 应得到 .hidden.gif，而不是父目录下的 .gif');
});

/* ==================== 8. 电源门禁不能被「分开传参」绕过 ==================== */
const PG = require(path.join(ROOT, 'lib', 'power-gate'));

/* 从 main.js 抽出 exec:run / exec:stream 的门禁调用，看它到底拿什么去判。
 * 直接跑 handler 会真的启动进程（危险），所以这里只验「判定输入」这一层：
 * 抽出那几行 assertPowerAllowed 的表达式并求值。 */
/* 抽出「传给 assertPowerAllowed 的那个表达式」并判断它是不是整条命令。
 * 用括号配对取实参，比正则可靠（实参里本身就有方括号与嵌套调用）。 */
function assertPowerArgIsWholeCommand(body, label) {
  const marker = 'assertPowerAllowed(';
  const at = body.indexOf(marker);
  assert.ok(at >= 0, label + ' 里找不到 assertPowerAllowed');
  const start = at + marker.length;
  let depth = 1, end = -1;
  for (let k = start; k < body.length; k++) {
    const c = body[k];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  assert.ok(end > start, label + ' 里 assertPowerAllowed 的实参不完整');
  const arg = body.slice(start, end).trim();
  assert.ok(/\.join\(\s*' '\s*\)/.test(arg),
    label + ' 没有把 cmd 与 args 拼成整条命令再判 —— 分开判会漏掉 ' +
    '`cmd.exe` + `/c shutdown /s /t 0` 这类组合。实际实参：' + arg);
  /* 必须同时用了命令行主体与 args，而不是只用其中一个。
   * 注意用 /i：实现里变量叫 flatArgs（首字母大写），区分大小写会误判。 */
  assert.ok(/(cmd|command)/i.test(arg) && /args/i.test(arg),
    label + ' 的判定实参应同时包含命令与参数：' + arg);
  return arg;
}

t('8a 电源门禁：cmd 与 args 必须拼成整条再判（分开判会漏掉 cmd.exe /c shutdown）', () => {
  const i = mainSrc.indexOf("handle('exec:run'");
  const j = mainSrc.indexOf("handle('exec:stream'");
  assertPowerArgIsWholeCommand(mainSrc.slice(i, j), 'exec:run');

  /* 行为验证：证明「分开判」确实会让这些命令通过（否则这条测试守的是空气） */
  const c1 = PG.isPowerCommand('cmd.exe');
  const a1 = PG.isPowerCommand('/c shutdown /s /t 0');
  const whole1 = PG.isPowerCommand('cmd.exe /c shutdown /s /t 0');
  assert.strictEqual(c1, false, '前置：cmd.exe 单独不是危险命令');
  assert.strictEqual(a1, false, '前置：参数串单独被剥壳后也不命中');
  assert.strictEqual(whole1, true, '前置：拼起来必须被识别为电源命令');
  /* 结论：只要实现是分开判的，c1/a1 都为 false，就放行了 whole1 —— 正是缺陷形态 */
});

t('8b 电源门禁：powershell -Command Stop-Computer 同样要被整条判住', () => {
  const body = mainSrc.slice(mainSrc.indexOf("handle('exec:stream'"), mainSrc.indexOf("handle('job:kill'"));
  assertPowerArgIsWholeCommand(body, 'exec:stream');
  assert.strictEqual(PG.isPowerCommand('powershell.exe'), false);
  assert.strictEqual(PG.isPowerCommand('-NoProfile -Command Stop-Computer'), false);
  assert.strictEqual(PG.isPowerCommand('powershell.exe -NoProfile -Command Stop-Computer'), true,
    '前置：整条拼接必须命中');
});

t('8c 电源门禁：无害命令与 shutdown /a 仍要放行（别矫枉过正）', () => {
  assert.strictEqual(PG.isPowerCommand('cmd.exe /c dir'), false);
  assert.strictEqual(PG.isPowerCommand('cmd.exe /c shutdown /a'), false, '取消关机必须放行');
  assert.strictEqual(PG.isPowerCommand('powershell.exe -Command Get-Date'), false);
  assert.strictEqual(PG.isPowerCommand('notepad.exe shutdown.log'), false, '文件名里带 shutdown 不算');
});

/* ==================== 9. 跨盘提交不能裸 rename ==================== */
t('9a moveFile：同卷时走 rename；跨卷（EXDEV）退回复制+删源', async () => {
  const i = mainSrc.indexOf('async function moveFile');
  const j = mainSrc.indexOf('/* 本应用在系统临时目录里创建的临时产物');
  assert.ok(i > 0 && j > i, '找不到 moveFile');
  const fn = new Function('fsp', 'path', mainSrc.slice(i, j) + '\nreturn moveFile;')(fs.promises, path);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-move-'));
  try {
    // 同卷：正常改名
    const a = path.join(dir, 'a.txt'); fs.writeFileSync(a, 'hello');
    const b = path.join(dir, 'b.txt');
    const r1 = await fn(a, b);
    assert.strictEqual(fs.readFileSync(b, 'utf8'), 'hello');
    assert.ok(!fs.existsSync(a), '同卷改名后源应消失');
    assert.strictEqual(r1.copied, false, '同卷不该走复制');

    // 模拟 EXDEV：包一层 fsp，rename 到特定目标时抛 EXDEV
    const c = path.join(dir, 'c.txt'); fs.writeFileSync(c, 'world');
    const d = path.join(dir, 'd.txt');
    const fakeFsp = Object.assign({}, fs.promises, {
      rename: async (s, t) => {
        if (t === d) { const e = new Error('EXDEV: cross-device link not permitted'); e.code = 'EXDEV'; throw e; }
        return fs.promises.rename(s, t);
      },
    });
    const fn2 = new Function('fsp', 'path', mainSrc.slice(i, j) + '\nreturn moveFile;')(fakeFsp, path);
    const r2 = await fn2(c, d);
    assert.strictEqual(fs.readFileSync(d, 'utf8'), 'world', '跨卷后目标内容必须正确');
    assert.ok(!fs.existsSync(c), '跨卷复制成功后源应被删掉');
    assert.strictEqual(r2.copied, true, '应走复制分支');
  } finally { rmDir(dir); }
});

t('9b moveFile：非 EXDEV 的错误要原样抛出，不能悄悄改成复制', async () => {
  const i = mainSrc.indexOf('async function moveFile');
  const j = mainSrc.indexOf('/* 本应用在系统临时目录里创建的临时产物');
  const fakeFsp = Object.assign({}, fs.promises, {
    rename: async () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; },
    copyFile: async () => { throw new Error('不该走到复制'); },
  });
  const fn = new Function('fsp', 'path', mainSrc.slice(i, j) + '\nreturn moveFile;')(fakeFsp, path);
  await assert.rejects(() => fn('x', 'y'), /EPERM/, '非 EXDEV 必须原样抛出');
});

t('9c target:compress-av 与 office:convert 都不再用裸 fsp.rename 提交结果', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('target:compress-av'"), mainSrc.indexOf('/* 图片的目标体积压缩'));
  assert.ok(!/fsp\.rename\(finalOut\.file, dst\)/.test(seg),
    'target:compress-av 仍在用裸 rename 提交（跨盘 EXDEV 会丢成果）');
  assert.ok(/moveFile\(finalOut\.file, dst\)/.test(seg), '应改用 moveFile');

  const off = mainSrc.slice(mainSrc.indexOf("handle('office:convert'"), mainSrc.indexOf('/* ================= IPC: 右键菜单管理'));
  assert.ok(!/fsp\.rename\(produced, out\)/.test(off),
    'office:convert 仍在用裸 rename 提交（stage 在 %TEMP%，outDir 可能在别的盘）');
});

/* ==================== 10. WAV / FLAC 不能再把视频流塞进去 ==================== */
t('10 音视频转换：所有纯音频容器都必须加 -vn（判据只能有一份）', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('ffmpeg:convert'"), mainSrc.indexOf("handle('ffmpeg:frames'"));
  /* 取值：把 -vn 的判定条件与 isAudioOut 的定义都抓出来比对 */
  const mAudio = seg.match(/const isAudioOut = \[([^\]]+)\]\.includes\(opts\.format\)/);
  assert.ok(mAudio, '找不到 isAudioOut 定义');
  const audioFormats = mAudio[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.ok(audioFormats.includes('wav') && audioFormats.includes('flac'),
    '前置：wav/flac 属于纯音频容器');

  /* -vn 的判定必须在 isAudioOut 算出之后、且用到它 */
  const vnLine = seg.match(/if \((isAudioOut \|\| opts\.mute|opts\.format === 'mp3'[^\n]*)\) args\.push\('-vn'\)/);
  assert.ok(vnLine, '找不到 -vn 的判定行');
  const cond = vnLine[1];
  if (!/isAudioOut/.test(cond)) {
    /* 还写死列表：那 wav/flac 必须在列表里 */
    for (const f of ['wav', 'flac']) {
      assert.ok(new RegExp("'" + f + "'").test(cond),
        'WAV/FLAC 不加 -vn 会把视频流塞进音频容器：' + cond);
    }
  }
  /* -vn 必须出现在 -c:v 之前：否则视频编码器已经被指定了 */
  const idxVn = seg.indexOf("args.push('-vn')");
  const idxCv = seg.indexOf("args.push('-c:v'");
  assert.ok(idxVn > 0 && idxCv > idxVn, '-vn 必须在 -c:v 之前');
});

/* ==================== 11. runCmd 的 throwOnNonZero ==================== */
t('11a runCmd：默认「非零不抛」，打开 throwOnNonZero 后必须抛', async () => {
  const i = mainSrc.indexOf('function runCmd(');
  const j = mainSrc.indexOf('/* 命令行脱敏');
  assert.ok(i > 0 && j > i, '找不到 runCmd');
  const build = () => {
    const sanitize = loadSanitize();
    return new Function('execFile', 'sanitizeCmdError', 'TextDecoder', 'Buffer',
      mainSrc.slice(i, j) + '\nreturn runCmd;')(
      require('child_process').execFile, sanitize, TextDecoder, Buffer);
  };
  const runCmd = build();

  /* 用 node -e 'process.exit(3)' 造一个「有输出 + 非零退出码」的真实进程 */
  const r = await runCmd(process.execPath, ['-e', 'console.log("out"); process.exit(3)'], { timeout: 10000 });
  assert.strictEqual(r.code, 3, '默认路径应把退出码如实返回而不是抛');
  assert.ok(String(r.stdout).includes('out'), '默认路径应带回输出');

  await assert.rejects(
    () => runCmd(process.execPath, ['-e', 'console.log("out"); process.exit(3)'], { timeout: 10000, throwOnNonZero: true }),
    /Command failed|process\.exit/,
    'throwOnNonZero 打开后，非零退出码必须变成异常');
});

t('11b office:status 必须用 throwOnNonZero，否则恒返回 office:true', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('office:status'"), mainSrc.indexOf("handle('office:convert'"));
  assert.ok(/throwOnNonZero:\s*true/.test(seg),
    'office:status 没打开 throwOnNonZero —— PowerShell 里 catch{exit 1} 完全不起作用，没装 Office 也报「可用」');
});

t('11c ffmpeg:pick 判 ffmpeg 必须看输出的 "ffmpeg version"，且不覆盖已有可用 ffmpeg', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('ffmpeg:pick'"), mainSrc.indexOf('const FFMPEG_SOURCES'));
  /* 光「出现过 ffmpeg version 这个字符串」不够 —— 注释里也可能有。
   * 要求它真的出现在一个 if/threw 的判断里，也就是「不匹配就不复制」。
   * （反向验证时发现过：只测 /ffmpeg version/ 的话，把校验整段删掉测试仍然是绿的。） */
  const guard = seg.match(/if\s*\(\s*!\s*\/[^/\n]*ffmpeg version[^/\n]*\/[a-z]*\s*\.test\([^)]*\)\s*\)\s*throw/);
  assert.ok(guard,
    'ffmpeg:pick 没有「输出里不含 ffmpeg version 就拒绝」的判断 —— 任意 exe 都会被当成 ffmpeg 覆盖 bin/ffmpeg.exe');
  assert.ok(/throwOnNonZero/.test(seg), 'ffmpeg:pick 应先确认退出码为 0');
  assert.ok(/已有可用的 ffmpeg，未覆盖|skipped/.test(seg), '已有可用 ffmpeg 时不应静默覆盖');
  /* 覆盖前必须真的检查过 dest 是否存在 */
  assert.ok(/fs\.existsSync\(dest\)/.test(seg), '覆盖前应检查目标是否已存在');
});

/* ==================== 12. 批量处理单条失败不拖垮整批 ==================== */
t('12 target:compress-av：单个源文件读不到时要记录失败并继续', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('target:compress-av'"), mainSrc.indexOf('/* 图片的目标体积压缩'));
  /* 原来裸的 `const srcSize = (await fsp.stat(input)).size;` 必须消失 */
  assert.ok(!/const srcSize = \(await fsp\.stat\(input\)\)\.size;/.test(seg),
    '仍在裸调 fsp.stat(input)：单个文件消失会中断整批，已完成的 results 也会丢');
  const guarded = /try \{\s*srcSize = \(await fsp\.stat\(input\)\)\.size;\s*\} catch/.test(seg);
  assert.ok(guarded, 'fsp.stat(input) 应被 try/catch 包住');
  assert.ok(/continue;/.test(seg.slice(seg.indexOf('无法读取源文件'), seg.indexOf('无法读取源文件') + 400)),
    '读不到源文件后应 continue 到下一个，而不是让异常冒出去');
});

/* ==================== 13. proc:kill 不能把「查询失败」当「进程已退出」 ==================== */
t('13 proc:kill：进程查询失败必须拒绝，而不是跳过保护检查直接 taskkill', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('proc:kill'"), mainSrc.indexOf('/* ================= IPC: network'));
  /* 缺陷形态：一个 try 包住保护判定，catch 里靠中文文本匹配决定是否重抛 */
  assert.ok(!/if \(\/拒绝结束\/\.test\(String\(err\.message\)\)\) throw err;/.test(seg),
    '仍在用中文文本匹配决定是否重抛 —— 查询机制坏掉时保护检查被整体跳过');
  assert.ok(/无法确认 PID|进程查询失败/.test(seg),
    '查询失败时应明确拒绝并说明原因');
});

/* ==================== 14. 下载：取消清理与 416 断点 ==================== */
t('14a 下载取消：临时文件删除失败要重试，不能一次 rmSync 了事', () => {
  const seg = mainSrc.slice(mainSrc.indexOf('function downloadToFile'), mainSrc.indexOf("handle('ffmpeg:download'"));
  assert.ok(!/const cleanup = \(\) => \{ try \{ fs\.rmSync\(tmp, \{ force: true \}\); \} catch \(e\) \{\} \};/.test(seg),
    'cleanup 仍是一次性 rmSync：Windows 上写流句柄未释放会 EPERM，.part 文件残留且不在白名单里');
  assert.ok(/tryLater|setTimeout/.test(seg.slice(seg.indexOf('const cleanup'), seg.indexOf('const cleanup') + 900)),
    'cleanup 应有延迟重试');
});

t('14b 下载：416 必须重置断点，否则重试永远 416', () => {
  const seg = mainSrc.slice(mainSrc.indexOf('function downloadToFile'), mainSrc.indexOf("handle('ffmpeg:download'"));
  assert.ok(!/if \(r\.status === 416\) \{ res\(\); return; \}/.test(seg),
    '416 仍在被当成「已下载完整」—— 本地文件偏短时每一轮都 416，6 次重试后必定失败');
  const m = seg.match(/if \(r\.status === 416\) \{[\s\S]{0,200}?\}/);
  assert.ok(m, '找不到 416 分支');
  assert.ok(/got = 0/.test(m[0]), '416 分支必须把断点清零（下一轮从头下）');
});

/* ==================== 15. 截帧计数 ==================== */
t('15 截帧：只统计本次新增的帧，并如实报出被覆盖的旧帧数', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('ffmpeg:frames'"), mainSrc.indexOf('/* 音频剪辑'));
  assert.ok(!/n = \(await fsp\.readdir\(outDir\)\)\.filter\(f => f\.startsWith\(base \+ '_'\)/.test(seg),
    '仍在统计目录里所有同名帧 —— 重复截帧时 count 会虚高（上次 20 张 + 这次 5 张报 25）');
  assert.ok(/before/.test(seg) && /!before\.has/.test(seg),
    '应记录截帧前已有的文件集合，只数新增的');
  assert.ok(/overwritten/.test(seg), '被覆盖的旧帧数要如实回报');
  /* 渲染层也得把它显示出来，否则主进程报了没人看 */
  assert.ok(/overwritten/.test(readTree('js/tools/media')), '渲染层没有显示 overwritten');
});

/* ==================== 16. 数值/展示边界（lib/target-size） ==================== */
const TS = require(path.join(ROOT, 'lib', 'target-size'));

t('16a fmtBytes：null/undefined 不能变成 "null B"', () => {
  /* 原实现 `if (!(n >= 0)) return '-'`，而 null >= 0 为 true，
   * 于是 fmtBytes(null) 一路走到 `n < 1024` 返回字符串 "null B"。 */
  for (const v of [null, undefined, NaN, Infinity, -Infinity, -1]) {
    const s = TS.fmtBytes(v);
    assert.strictEqual(s, '-', 'fmtBytes(' + String(v) + ') 应为 "-"，实际 "' + s + '"');
  }
  /* 0 是合法值（空文件），不能被当成"没有" */
  assert.strictEqual(TS.fmtBytes(0), '0 B', '0 字节应显示 "0 B"');
  assert.strictEqual(TS.fmtBytes(1023), '1023 B');
  assert.strictEqual(TS.fmtBytes(1024), '1.0 KB');
});

t('16b tierTargetBytes：非法 ratio 不能返回 NaN', () => {
  for (const r of [NaN, undefined, null, -1, Infinity]) {
    const v = TS.tierTargetBytes(100, r);
    assert.ok(Number.isFinite(v) && v >= 1,
      'tierTargetBytes(100, ' + String(r) + ') 应是有限正整数，实际 ' + String(v));
  }
  assert.strictEqual(TS.tierTargetBytes(100, 0.15), 15, '正常比例不能被改坏');
  assert.strictEqual(TS.tierTargetBytes(0, 0.15), 1, '0 字节源也要给出至少 1');
  assert.strictEqual(TS.tierTargetBytes(Infinity, 0.5), 1, '非法源体积给确定值而非 Infinity');
});

/* ==================== 17. GIF / 通配收尾：确认没有漏掉其它裸 rename ==================== */
t('17 全项目：凡是从 %TEMP% 提交到用户输出目录的地方，都不该用裸 rename', () => {
  /* 扫所有 handler 里出现的 fsp.rename(，逐一人工分类过一次：
   * 允许的只有「同目录内的原子改名」——即源和目标都由我们自己造、
   * 且一定同卷的场合（写临时文件后改名、源改名为 .bak、.bak 改回原名）。
   * 这里用「源头是不是 temp」作为粗略判据做回归锚点。 */
  const allowed = [
    'fsp.rename(tmp, dest)',            // writeFileAtomic：同目录临时文件
    'fsp.rename(dest, bak)',            // writeFileAtomic：同目录备份
    'fsp.rename(bak, dest)',            // writeFileAtomic：回滚
    'fsp.rename(from, to)',             // fs:rename 通道本身
    'fsp.rename(cryptTmp, outPath)',    // 临时名与目标是同一个父目录（outPath + 后缀）
    'fsp.rename(partTmp, finalOut)',    // fsOps.tempPathFor(finalOut)：同目录
    'fsp.rename(tmp, HOSTS_PATH)',      // hosts 临时文件在同目录
    'fsp.rename(tmp, dest)',            // downloadToFile：dest + '.part-...' 同目录
    'fsp.rename(srcAbs, bakPath)',      // 搬家：源改名为同级 .bak
    'fsp.rename(bakPath, srcPath)',     // 搬家回滚
    'fsp.rename(src, dst)',             // moveFile 内部（EXDEV 已兜底）
    'fsp.rename(dst, back)',            // 7z 解压失败回滚：把条目搬回 staging（同卷）
  ];
  const hits = [...mainSrc.matchAll(/fsp\.rename\(([^)]*)\)/g)].map((m) => 'fsp.rename(' + m[1] + ')');
  const unknown = [...new Set(hits)].filter((h) => !allowed.includes(h));
  assert.deepStrictEqual(unknown, [],
    '出现了未分类的 fsp.rename：' + unknown.join(' | ') +
    '。如果它跨卷（源在 %TEMP%、目标在用户盘），必须改用 moveFile。');
});

/* ==================== 18. wifi:key 必须逐行取值 ==================== */
t('18 wifi:key：多行 netsh 输出里能取到密码与身份验证', () => {
  /* 真实 netsh 输出是分节的，`关键内容 : xxx` 只是其中一行。
   * 原实现直接在整段上跑 /...$/（无 /m），$ 只匹配整串末尾，
   * 于是 key/auth 恒为 undefined → 界面把所有加密 WiFi 显示成「开放网络无密码」。 */
  const seg = mainSrc.slice(mainSrc.indexOf("handle('wifi:key'"), mainSrc.indexOf('/* ================= IPC: 文本朗读'));
  assert.ok(!/out\.match\(\/\(\?:关键内容/.test(seg),
    '仍在整段字符串上匹配（无 /m 时 $ 只匹配串尾，永远匹配不到）');
  assert.ok(/split\(\/\\r\?\\n\/\)/.test(seg),
    '应按行拆分后逐行匹配（与 wifi:profiles 的写法保持一致）');

  /* 用真实格式的输出跑一遍抽出来的取值逻辑 */
  const kvSrc = seg.match(/const kvOf = \(re\) => \{[\s\S]*?\n  \};/);
  assert.ok(kvSrc, '找不到 kvOf');
  const kvOf = new Function('out', kvSrc[0] + '\nreturn kvOf;')(null);
  const out = [
    '接口 WLAN 的配置文件 X:',
    '安全设置',
    '-------------------',
    '    身份验证            : WPA2-个人',
    '    密码                : CCMP',
    '安全密钥',
    '-------------------',
    '    关键内容            : P@ssw0rd123',
    '    关键索引            : 1',
    '',
  ].join('\r\n');
  const kv = new Function('out', kvSrc[0] + '\nreturn kvOf;');
  const f = kv(out);
  assert.strictEqual(f(/关键内容|Key Content/i), 'P@ssw0rd123', '密码没取到');
  assert.strictEqual(f(/身份验证|Authentication/i), 'WPA2-个人', '身份验证没取到');
});

/* ==================== 19. isRunningAsAdmin 三态 ==================== */
t('19 isRunningAsAdmin：查询失败不能永久缓存成 false', () => {
  /* 【任务 5 之后这个函数在 ipc/acl-links.js】这里显式读那个文件，
   * 而不是复用 mainSrc —— mainSrc 固定是 main.js（见文件头的说明），
   * 拿它切片会报「找不到 isRunningAsAdmin」。 */
  const movedSrc = fs.readFileSync(path.join(ROOT, 'ipc', 'acl-links.js'), 'utf8');
  const i = movedSrc.indexOf('async function isRunningAsAdmin');
  /* 【右边界用「下一个函数定义」而不是某段注释】
   * 原来取的是 `/* 读当前所有者与 ACL 摘要` 那段说明注释 —— 搬文件时
   * 那段长注释没有被一起带过去（它写在 main.js 里的位置被一并删掉了），
   * 于是 indexOf 返回 -1、断言报「找不到 isRunningAsAdmin」。
   * 改成配平花括号取整个函数体：与注释排布无关。 */
  assert.ok(i > 0, '找不到 isRunningAsAdmin（应在 ipc/acl-links.js 里）');
  let body = '';
  {
    const open = movedSrc.indexOf('{', i);
    let depth = 0, k = open;
    for (; k < movedSrc.length; k++) {
      if (movedSrc[k] === '{') depth++;
      else if (movedSrc[k] === '}') { depth--; if (depth === 0) { k++; break; } }
    }
    assert.ok(depth === 0, 'isRunningAsAdmin 括号不配平');
    body = movedSrc.slice(i, k);
  }
  assert.ok(!/catch \(err\) \{ _isAdminCache = false; \}/.test(body),
    'catch 里写死 false 并永久缓存 —— 一次瞬时失败会让这个进程余生都自认不是管理员');
  assert.ok(/return null/.test(body), '查询失败应返回 null（未知），由调用方区分处理');
  /* 只有确定拿到 0/1 才缓存 */
  assert.ok(/if \(v === '1' \|\| v === '0'\)/.test(body), '应只在拿到明确 0/1 时缓存');
});

t('19b acl:repair：把「未知」和「确定不是管理员」分开提示', () => {
  /* 【任务 5 之后这个 handler 在 ipc/acl-links.js，常量别名是 CH】
   * 所以必须显式读那个文件 —— mainSrc 是 main.js。
   * 三种形态都认：字面量 / dirMoveCh.<键> / CH.<键>。
   * （只写字面量的话 indexOf 拿到 -1，slice(-1, …) 会把几乎整段吃进来，
   *  断言退化成"扫全文件"—— 恰好还能过，但切片失去意义。） */
  const movedSrc = fs.readFileSync(path.join(ROOT, 'ipc', 'acl-links.js'), 'utf8');
  const lit = movedSrc.indexOf("handle('acl:repair'");
  const from = lit >= 0 ? lit
    : movedSrc.indexOf('handle(dirMoveCh.ACL_LINKS.ACL_REPAIR,');
  assert.ok(from > 0, '找不到 acl:repair 的注册（应在 ipc/acl-links.js 里）');
  /* 这个 handler 的右边界不取「下一个 handler」—— 那对排版太敏感。
   * 用定长窗口即可：断言只在这个 handler 里找 admin === false / null 两处，
   * 而它本身约 3.5k 字符。 */
  const seg = movedSrc.slice(from, from + 4000);
  assert.ok(/admin === false/.test(seg), '应显式区分 admin === false');
  assert.ok(/admin === null/.test(seg), '应显式处理 admin === null（查询失败）');
});

/* ==================== 20. update:apply 单飞 ==================== */
t('20 update:apply：并发调用要被挡住（连点两次会跑两份替换脚本）', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('update:apply'"), mainSrc.indexOf('// 清理 update 下载目录'));
  assert.ok(/updateApplying/.test(seg), '缺少升级单飞标志');
  assert.ok(/if \(updateApplying\) throw/.test(seg), '第二次调用应直接拒绝');
  /* 校验失败要能重试：commit 之前的错误必须放开标志 */
  assert.ok(/updateApplyingCommitted/.test(seg), '需要区分「已启动替换脚本」与「还没开始」');
  assert.ok(/if \(!updateApplyingCommitted\) updateApplying = false;/.test(seg),
    '校验失败等前置错误应放开标志，让用户能重试');
});

/* ==================== 21. 截图临时文件 ==================== */
t('21a 截图：文件名带随机后缀（同一毫秒两次不撞名）且仍在临时白名单内', () => {
  /* 【改成行为断言】原来是在 main.js 里截 `const snipTmp =` 后面 300 字符，
   * 看里面有没有 randomBytes —— 那是在断言「实现里出现了某个 API 名」。
   * 任务 10 把临时名生成搬进 lib/temp-names.js（随机后缀由那里的 stamp() 提供）
   * 之后 main.js 只剩一行委托，断言自然失配（而行为完全正确）。
   * 真正要守的是两个语义：
   *   1) 同一毫秒两次调用**不撞名**（撞名会让后一张截图覆盖前一张）；
   *   2) 生成出来的名字**仍在清理白名单里**（否则崩溃残留永远清不掉）。 */
  const T = require('../lib/temp-names');
  const pathMod = require('path');
  const NOW = 1700000000000;
  const a = T.snipTmp({ now: NOW });
  const b = T.snipTmp({ now: NOW });
  assert.notStrictEqual(a, b, '同一毫秒两次调用撞名了（后一张截图会覆盖前一张）');
  assert.ok(T.isOwnTempName(pathMod.basename(a)), '生成的截图临时名不在白名单里：' + a);

  /* 白名单形态断言保留，但直接跑真实现（不再从 main.js 抠源码求值） */
  const isOwn = (n) => T.isOwnTempName(n);
  assert.ok(isOwn('hehe-snip-1700000000000.png'), '老格式必须在白名单里');
  assert.ok(isOwn('hehe-snip-1700000000000-abc123.png'), '带随机后缀的新格式必须在白名单里');
  assert.ok(isOwn('hehe-toolbox-Portable-0.3.5.exe.part-1700000000-abcdef'), '下载残留的 .part 也要能被清理');
  assert.ok(!isOwn('照片.png'), '白名单不能误伤别人的文件');
  assert.ok(!isOwn('random.part-123-abc'), '白名单不能误伤别人的 .part');
});

t('21b 截图：窗口关闭 / 取消 / 保存后都要清掉临时 PNG', () => {
  const seg = mainSrc.slice(mainSrc.indexOf('let snipSrcFile = null'), mainSrc.indexOf('// 贴剪贴板图片（托盘/工具用）'));
  assert.ok(/dropSnipSrc/.test(seg), '缺少统一的临时文件清理函数');
  assert.ok(/snipWin\.on\('closed', \(\) => \{ snipWin = null; dropSnipSrc\(\); \}\)/.test(seg),
    '窗口关闭时必须清理（Esc 取消 / 直接关窗都走这条路）');
  assert.ok(/finally \{[\s\S]{0,400}fs\.rmSync\(file, \{ force: true \}\)/.test(seg),
    '"另存为"分支必须自己收尾，否则每保存一次就多留一张');
});

/* ==================== 22. seven:extract 回滚改成搬回 ==================== */
t('22 seven:extract：失败回滚要把条目搬回 staging，不能直接删', () => {
  /* 直接删的风险：uniqueTarget 的存在性判断若因权限/瞬时错误失准，
   * rm 掉的可能是用户原有文件 —— 解压失败反毁数据。 */
  const seg = mainSrc.slice(mainSrc.indexOf("handle('seven:extract'"), mainSrc.indexOf('/* ================= IPC: WiFi 密码查看'));
  const catchBlk = seg.slice(seg.lastIndexOf('} catch (err) {'));
  assert.ok(!/for \(const dst of movedTo\.reverse\(\)\) \{\s*try \{ await fsp\.rm\(dst/.test(seg),
    '回滚仍在直接 rm(dst)');
  assert.ok(/await fsp\.rename\(dst, back\)/.test(seg), '应把已搬出的条目改名回 staging');
});

/* ==================== 23. svc:action 失败识别 ==================== */
t('23 svc:action：sc.exe 的失败信息在 stdout 里，不能只看 stderr', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('svc:action'"), mainSrc.indexOf("handle('power:list'"));
  /* 只看可执行代码，避开注释里提到旧写法导致的假阳性 */
  const code = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\(r\.stderr \|\| r\.stdout\)/.test(code),
    '仍用 (stderr || stdout)：stderr 非空时 stdout 里的真正原因被丢掉');
  assert.ok(/String\(r\.stdout[^)]*\)[\s\S]{0,160}String\(r\.stderr/.test(code),
    '应把两路输出合并再取尾部');
  assert.ok(/失败\\s\*\\d\+|FAILED/.test(code), '退出码 0 但输出含「失败 N」时也要判失败');
});

/* ==================== 24. 周期任务延后武装 ==================== */
t('24 armAllSchedules：不能在建窗后立刻对未加载完的页面发确认提示', () => {
  /* 定位到 applyHotkey 之后、冒烟测试之前的那一小段（周期任务武装处），
   * 只在这一段里查，避免命中文件别处（createWindow 里也有 did-finish-load）造成的假绿。 */
  const from = mainSrc.indexOf('applyHotkey(storeGet');
  const to = mainSrc.indexOf('// 冒烟测试：遍历全部工具页');
  assert.ok(from > 0 && to > from, '定位不到周期任务武装那一段');
  const seg = mainSrc.slice(from, to);
  /* 允许的形态只有两种：包在 isLoading() 判断里，或包在 did-finish-load 回调里。
   * 裸的 `armAllSchedules();`（上一行不是 if / 回调）才算缺陷 —— 用「前一行」判断。 */
  const lines = seg.split('\n');
  const bare = lines.findIndex((l, i) => {
    if (!/^\s*armAllSchedules\(\);/.test(l)) return false;
    const prev = (lines[i - 1] || '').trim();
    return !(/^if\s*\(/.test(prev) || /did-finish-load/.test(prev));
  });
  assert.strictEqual(bare, -1,
    '仍在建窗后同步 armAllSchedules：loop 任务的「已生效」确认提示会发给还没订阅的渲染层');
  assert.ok(/did-finish-load/.test(seg), '应等页面加载完再武装');
  assert.ok(/isLoading\(\)/.test(seg), '已加载完的情况要直接武装，不能一直等');
});

/* ==================== 25. path-guard：递归删除必须更严 ==================== */
t('25a checkDeletable：recursive 参数不能被忽略（系统目录深层要拦住）', () => {
  const PGx = require(path.join(ROOT, 'lib', 'path-guard'));
  const B = String.fromCharCode(92);
  const sys = (x) => path.join('C:', 'Windows', x);
  /* 关键：这些都是「关键目录的第二层以后」，isCriticalPath 判不出来 */
  for (const p of [sys('System32' + B + 'drivers'), sys('System32' + B + 'config' + B + 'SAM'),
    path.join('C:', 'Program Files', 'nodejs', 'node.exe')]) {
    assert.ok(PGx.checkDeletable(p, true), p + ' 递归删除必须被拒（删掉会让系统起不来/无法登录）');
  }
  /* 用户自己的目录照常可删，不能矫枉过正 */
  const mine = path.join(require('os').homedir(), 'Documents', 'a.txt');
  assert.strictEqual(PGx.checkDeletable(mine, true), null, '自己文档目录下的文件应可删');
  /* 源码级：recursive 形参必须真的被读 */
  const src = read(path.join('lib', 'path-guard.js'));
  const fn = src.slice(src.indexOf('function checkDeletable'), src.indexOf('function checkOverwritable'));
  assert.ok(/recursive/.test(fn.slice(fn.indexOf('{'))) || /recursive && /i.test(fn),
    'checkDeletable 的 recursive 形参仍未被使用');
});

t('25b isCriticalForOverwrite：第二套 Windows（D:\\Windows）也要挡', () => {
  const PGx = require(path.join(ROOT, 'lib', 'path-guard'));
  const B = String.fromCharCode(92);
  const hosts = path.join('D:', 'Windows', 'System32', 'drivers', 'etc', 'hosts');
  assert.ok(PGx.checkOverwritable(hosts),
    'D:\\Windows 下的 hosts 必须拒写 —— 覆盖它会毁掉全机 DNS。' +
    '原实现只查环境变量那套系统目录，注释却写「任意盘符」');
  /* 普通路径不受影响 */
  assert.strictEqual(PGx.checkOverwritable(path.join('D:', 'data', 'a.txt')), null);
});

t('25c resolveInside / resolveTarget：盘符根不能误判为越界', () => {
  const PGx = require(path.join(ROOT, 'lib', 'path-guard'));
  const AGx = require(path.join(ROOT, 'lib', 'archive-guard'));
  const B = String.fromCharCode(92);
  const root = 'D:' + B;
  assert.strictEqual(PGx.resolveInside(root, 'a.txt'), 'D:' + B + 'a.txt',
    '「解压到 D:\\」是常见操作，不能因为 root 以分隔符结尾就判越界');
  assert.strictEqual(AGx.resolveTarget(root, 'a.txt'), 'D:' + B + 'a.txt');
  /* 安全边界不能被放宽：绝对路径 / UNC / 设备名照旧拒绝 */
  assert.throws(() => PGx.resolveInside(root, 'C:' + B + 'x'), /绝对路径|ABS_PATH/);
  assert.throws(() => PGx.resolveInside(root, '//srv/share'), /UNC/);
  /* 盘符根下的 `..` 解析后仍落在本卷（path.resolve('D:\', '../x') === 'D:\x'），
   * 这不是逃逸，不该被拦 —— 但**跨到别的卷**必须拦。 */
  assert.throws(() => PGx.resolveInside(root, 'D:' + B + '..' + B + '..' + B + 'C:' + B + 'x'),
    /绝对路径|ESCAPE/);
});

/* ==================== 26. power-gate 包装剥离 ==================== */
t('26 power-gate：cmd 开关形（/d /c）与解释器包装不能绕过', () => {
  const PGg = require(path.join(ROOT, 'lib', 'power-gate'));
  /* 这些都是「没开系统电源操作」时也必须被认出来的写法 */
  const mustBlock = [
    'shutdown /s /t 0',
    'cmd /c shutdown /s',
    'cmd /d /c shutdown /s',
    'cmd /e:on /c shutdown /s',
    'powershell -Command Stop-Computer',
    'powershell -NoProfile -Command Restart-Computer',
  ];
  for (const c of mustBlock) {
    assert.ok(PGg.isPowerCommand(c), '应被识别为电源命令：' + c);
  }
  /* 而无害的必须放行 */
  for (const c of ['cmd /c dir', 'cmd /d /c ver', 'powershell -Command Get-Date',
    'shutdown /a', 'cmd /c shutdown /a', 'notepad shutdown.log']) {
    assert.ok(!PGg.isPowerCommand(c), '不该被当成电源命令：' + c);
  }
});

/* ==================== 27. expr-eval 取余 vs 百分比 ==================== */
t('27 expr-eval：% 取余不能被当成百分比（10 % -3 应为 1）', () => {
  const EEx = require(path.join(ROOT, 'lib', 'expr-eval'));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const cases = [
    ['10 % -3', 1], ['7 % +2', 1], ['10 % - 3', 1],
    ['10%3', 1], ['5%2', 1], ['8%3*2', 4],
    ['50%', 0.5], ['100-10%', 99.9], ['50%+10%', 0.6], ['50%-10%', 0.4],
  ];
  for (const [e, want] of cases) {
    const got = EEx.evaluate(e);
    assert.ok(near(got, want),
      'evaluate(' + JSON.stringify(e) + ') 应为 ' + want + '，实际 ' + got +
      '（早期实现把 `% -3` 当百分比，算出 -2.9）');
  }
});

/* ==================== 28. acl-repair：写权限 ≠ 完全控制 ==================== */
t('28 acl-repair：(M)/(W) 算有写权限，不能报「缺少写入/删除权限」', () => {
  const Ax = require(path.join(ROOT, 'lib', 'acl-repair'));
  const B = String.fromCharCode(92);
  const me = 'HOME' + B + 'u';
  const parse = (perm) => Ax.parseIcacls('C:' + B + 'x' + B + 'a.txt ' + me + ':(' + perm + ')', me);
  assert.strictEqual(parse('F').hasWrite, true, '(F) 应算有写权限');
  assert.strictEqual(parse('M').hasWrite, true,
    '(M) 修改权限能读能写能删，判成「没有写权限」会让用户白跑一趟提权流程');
  assert.strictEqual(parse('W').hasWrite, true, '(W) 写权限至少能写');
  assert.strictEqual(parse('RX').hasWrite, false, '只读不应算有写权限');
  assert.strictEqual(parse('F').hasFull, true, 'hasFull 的语义（真正的完全控制）不能被放宽');
  assert.strictEqual(parse('M').hasFull, false, '(M) 不是完全控制，hasFull 不应为 true');

  /* 【关键：要验 diagnose 的最终结论，不能只验解析结果】
   * 反向验证时发现过：只断言 hasWrite 的话，把 diagnose 里的判据改回 hasFull
   * 测试仍然是绿的 —— 而用户看到的是界面上的那句「你缺少写入/删除权限」。 */
  const dx = (perm) => Ax.diagnose({ exists: true, isDir: false, acl: parse(perm), ownerIsMe: true, isAdmin: false });
  const m = dx('M');
  assert.ok(!m.codes.includes('NO_WRITE'),
    '有 (M) 权限时不该报 NO_WRITE（实际 codes=' + JSON.stringify(m.codes) + '）');
  const w = dx('W');
  assert.ok(!w.codes.includes('NO_WRITE'), '有 (W) 权限时不该报 NO_WRITE');
  const rx = dx('RX');
  assert.ok(rx.codes.includes('NO_WRITE'), '只有 (RX) 时应报 NO_WRITE（否则真问题被掩盖）');
});

/* ==================== 29. mojibake：不能把正常文本改坏 ==================== */
t('29 mojibake：正常文本必须原样返回（不能「修」成乱码）', () => {
  const MBx = require(path.join(ROOT, 'lib', 'mojibake'));
  const normal = [
    'Hello 世界',
    'ok',
    'file saved',
    'ERROR: 无法打开文件',
    '这是正常的中文文本，不应该被改动。',
    '测试文本',
  ];
  for (const s of normal) {
    const r = MBx.analyzeMojibake(s);
    assert.strictEqual(r.best.text, s,
      '正常文本被改坏了：' + JSON.stringify(s) + ' → ' + JSON.stringify(r.best.text) +
      '（用户点一下「修复」就会拿到二次损坏的内容）');
  }
  /* 候选里也不许出现替换字符（那是「越修越坏」的产物） */
  const r2 = MBx.analyzeMojibake('Hello 世界');
  assert.ok(!r2.candidates.some((c) => (c.text || '').includes('\uFFFD')),
    '候选里仍有 U+FFFD');
});

/* ==================== 30. disk-health：wear=0 是有效读数 ==================== */
t('30 disk-health：wear=0 是「全新」，不能说成「厂商没给数据」', () => {
  const DHx = require(path.join(ROOT, 'lib', 'disk-health'));
  const r = DHx.estimateRemaining(0);
  /* shape() 把 wear=0 当作有效 SMART 读数（hasSmart=true、verdict 说「已用寿命 0%」），
   * estimateRemaining 却说「厂商未给出磨损数据」—— 同一块盘两个相反结论。 */
  assert.ok(r, 'wear=0 应给出结论而不是 null');
  assert.ok(!/未给出/.test(r.text),
    'wear=0 是有效值（全新盘），不应报「厂商未给出磨损数据」：' + r.text);
});

/* ==================== 31. target-size：负数码率不能出现在文案里 ==================== */
t('31 target-size：目标太小时不该算出负码率', () => {
  const TSx = require(path.join(ROOT, 'lib', 'target-size'));
  const p = TSx.planBitrates({ targetBytes: 10240, durationSec: 60, hasAudio: true });
  assert.strictEqual(p.ok, false, '这么小的目标确实压不了');
  assert.ok(!/-\d+kbps/.test(p.reason),
    '提示里出现了负码率（「视频码率仅剩 -31kbps」这种不存在的值）：' + p.reason);
});

/* ==================== 32. job-id：前缀互为前缀不能串号 ==================== */
t('32 job-id：前缀互为前缀不能串号（通用下载器已改名为 dlg）', () => {
  const Jx = require(path.join(ROOT, 'lib', 'job-id'));
  /* 现在的 id 形态：FFmpeg 下载 dl<n>、通用下载器 dlg<n>。
   * 关键不变量：任何一个 id 只归属一个前缀。 */
  const ids = ['dl1', 'dl2', 'dl12', 'dl2123', 'dlg1', 'dlg123', 'scanp12', 'scan12'];
  const prefixes = Object.keys(Jx.JOB_PREFIXES);
  for (const id of ids) {
    const owners = prefixes.filter((p) => Jx.belongsTo(id, p));
    assert.ok(owners.length <= 1,
      'id ' + id + ' 同时归属于多个前缀：' + JSON.stringify(owners) +
      ' —— 渲染层会用它来过滤 job:stream，串号会导致进度条被别的任务驱动');
  }
  /* 具体回归：dlg<n> 不能被 dl 前缀认领（'dl' 是旧名 dl2 的真前缀） */
  assert.strictEqual(Jx.belongsTo('dlg123', 'dl'), false, 'dlg123 不该归属 dl');
  assert.strictEqual(Jx.belongsTo('dlg123', 'dlg'), true);
});

/* ==================== 33. dir-move：freeBytes 未知不能被当成 0 ==================== */
t('33 dir-move：剩余空间未知（null）不该报「空间不足」', () => {
  const DMx = require(path.join(ROOT, 'lib', 'dir-move'));
  const r = DMx.validateMove({
    src: 'C:\\a', dst: 'D:\\a', srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false,
    srcIsCritical: false, dstExists: false, dstProtected: false,
    needBytes: 100 * 1024 * 1024, freeBytes: null, lockedPaths: [],
  });
  assert.strictEqual(r.ok, true,
    'freeBytes=null 表示「读不到剩余空间」，Number(null)===0 会让它变成「剩余 0 GB」而永久拒绝搬家：' + r.reason);
});

/* ==================== 34. archive-guard：文件/目录冲突要双向查 ==================== */
t('34 archive-guard：先文件后目录的顺序也要拦住冲突', () => {
  const AGr = require(path.join(ROOT, 'lib', 'archive-guard'));
  /* 条目顺序由压缩包作者控制：先 a/b.txt 再 a（文件），后者需要 a 是文件、
   * 前者需要 a 是目录 —— 这样的包必须被预检拒掉。 */
  for (const list of [
    [{ name: 'a', isDir: false, size: 1 }, { name: 'a/b', isDir: false, size: 1 }],
    [{ name: 'a/b', isDir: false, size: 1 }, { name: 'a', isDir: false, size: 1 }],
  ]) {
    assert.throws(() => AGr.inspectEntries(list), /FILE_DIR_CONFLICT|文件|目录/,
      '顺序 ' + JSON.stringify(list.map((x) => x.name)) + ' 的冲突包应被拒');
  }
});

/* ==================== 35. links：drive-relative 也要认成盘符根 ==================== */
t('35 links：isVolumeRootOnly 要认 D: 这种 drive-relative 写法', () => {
  const Lx = require(path.join(ROOT, 'lib', 'links'));
  const B = String.fromCharCode(92);
  assert.strictEqual(Lx.isVolumeRootOnly('D:'), true, '"D:" 在 Windows 上是「D 盘当前目录」，同样是盘符根');
  assert.strictEqual(Lx.isVolumeRootOnly('D:' + B), true);
  assert.strictEqual(Lx.isVolumeRootOnly('D:' + B + 'data'), false);
});

/* ==================== 36. 录像 GIF 目标名 ==================== */
t('36 rec:stop：GIF 目标名不能因为文件名含点而跑偏', () => {
  const mk = mainSrc.indexOf('if (makeGif) {');
  assert.ok(mk > 0, '找不到 if (makeGif) 块');
  const end = mainSrc.indexOf('let size = 0;', mk);
  assert.ok(end > mk, '找不到 GIF 块结尾');
  const seg = mainSrc.slice(mk, end);
  /* 必须按「已知视频扩展名」白名单剥壳，不能无条件剥最后一个扩展名 */
  assert.ok(/REC_VIDEO_EXT/.test(seg),
    '仍在无条件剥掉「最后一个扩展名」：D:\\rec\\v1.2 → D:\\rec\\v1.gif、D:\\rec\\.hidden → D:\\rec.gif（跑到父目录）');
  /* 失败清理前必须确认「这个 gif 是不是我们建的」 */
  assert.ok(/gifPreexisted/.test(seg),
    '失败清理没检查「文件是不是我们建的」—— 撞上用户既有 gif 时会删掉它');
  assert.ok(/if \(!gifPreexisted\)/.test(seg), '删除必须被 gifPreexisted 守卫');
});

done();
