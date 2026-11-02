'use strict';
const { t, done } = require('./lib/harness');
/* 分片与流式响应的行为测试（原 test-round15 的 13a / 13b / 14a）。
 *
 * 锁的是两类"半截文件"：
 *   13   split-file 失败时不销毁读流、也不删已产出的分片 →
 *        用户拿到一堆残缺分片，还以为切完了。
 *   14a  静态服务直接 stream.pipe(res)，客户端断开时读流不销毁 →
 *        fd 挂到进程退出（大文件反复下载会把句柄耗尽）。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stripComments = require('../lib/src-scan').stripComments;
const mainSrc = require('./lib/harness').readMain({ raw: true });
/* 递归删临时目录。Windows 上刚关的句柄要等几百毫秒，一次性 rmSync 会 EPERM。 */
function rmDir(p) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) {} }

t('13a split-file 失败时销毁读流并清掉分片', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('fs:split-file'");
  assert.ok(i > 0, '找不到 fs:split-file');
  const seg = code.slice(i, i + 4200);
  assert.ok(/const fail = /.test(seg), '没有统一的 fail() 收口');
  assert.ok(/rs\.destroy\(\)/.test(seg), '失败时没有销毁读流（卡在背压暂停就再也不继续，fd 挂到进程退出）');
  assert.ok(/ws\.destroy\(\)/.test(seg), '失败时没有销毁写流');
  assert.ok(/madePaths/.test(seg), '没有记录本次产出的分片，失败后不会清理半截文件');
});

t('13b 行为：预置同名分片后调用，reject 且不残留', async () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('fs:split-file'");
  const open = code.indexOf('{', i);
  let depth = 0, j = open, inS = null;
  while (j < code.length) {
    const c = code[j];
    if (inS) { if (c === '\\') j++; else if (c === inS) inS = null; j++; continue; }
    if (c === '/' && code[j + 1] === '/') { const nl = code.indexOf('\n', j); j = nl === -1 ? code.length : nl; continue; }
    if (c === '/' && code[j + 1] === '*') { const e = code.indexOf('*/', j + 2); j = e === -1 ? code.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
    j++;
  }
  const body = code.slice(open, j);
  /* 形参名是 (e, p, chunkMB, outDir)，包装层必须同名地把参数传进去，
   * 否则 body 里引用 p 会得到 "p is not defined"（第一次跑就撞上了）。 */
  const fn = new Function('path', 'fsp', 'fs', 'send',
    'return async (e, p, chunkMB, outDir) => ' + body + ';')(path, fs.promises, fs, () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r15-split-'));
  try {
    const src = path.join(dir, 'big.bin');
    fs.writeFileSync(src, Buffer.alloc(64 * 1024));
    const outDir = path.join(dir, 'parts');
    fs.mkdirSync(outDir);
    // 预置一个同名 part1 → flags:'wx' 必然 EEXIST
    fs.writeFileSync(path.join(outDir, 'big.bin.part1'), 'x');
    await assert.rejects(() => fn({}, src, 1, outDir), /同名分片/,
      '预置同名分片后应当明确拒绝（而不是静默覆盖）');
    // 目录里只应剩那个我们预置的文件
    const left = fs.readdirSync(outDir);
    assert.deepStrictEqual(left, ['big.bin.part1'],
      '失败后留下了本次产出的分片：' + JSON.stringify(left));
  } finally { rmDir(dir); }
});

/* ==================== 14. 静态服务读流 ==================== */

t('14a 静态服务用 pipeline（或 res.on(close)) 保证销毁读流', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('server:start'");
  assert.ok(i > 0, '找不到 server:start');
  const seg = code.slice(i, code.indexOf("handle('server:stop'"));
  /* 【不能只看"文件里出现过 pipeline("】
   * 兜底的 catch 分支里也有一句 pipeline 相关代码，把主路径退回成裸
   * `stream.pipe(res)` 后，`pipeline(` 这个词仍然存在 → 断言照样绿
   * （反向验证 MISSED 证实了）。必须断言**主路径**走的是 pipeline，
   * 且不存在"裸 pipe"。
   */
  /* 【只看主路径（try 块内），不看 catch 兜底】
   * pipeline 不可用时的兜底分支里本来就该有 stream.pipe(res) —— 那条分支
   * 同时还挂了 res.on('close')，资源是会被释放的。
   * 第一次的写法用整段匹配 `^\s*stream\.pipe\(res\);$`，把兜底也算进去了，
   * 于是当前（正确）的代码也会红。 */
  const tryAt = seg.indexOf('try {', seg.indexOf('createReadStream'));
  const tryEnd = seg.indexOf('} catch (e) {', tryAt);
  const mainPath = (tryAt >= 0 && tryEnd > tryAt) ? seg.slice(tryAt, tryEnd) : seg;
  assert.ok(!/stream\.pipe\(res\)/.test(mainPath),
    '主路径仍是裸 stream.pipe(res)：客户端断开只 unpipe，不销毁源流，fd 一直开着');
  assert.ok(/pipeline\(stream, res/.test(mainPath), '主路径没有用 pipeline 让 Node 负责销毁两端');
  assert.ok(/res\.on\('close'/.test(seg), '缺少"客户端断开"的兜底处理');
  assert.ok(/stream\.destroy\(/.test(seg), '缺少 destroy 兜底');
});

/* ==================== 15. Math.max(...arr) ==================== */

done();
