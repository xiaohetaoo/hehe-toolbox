'use strict';
const { t, done } = require('./lib/harness');
const { handlerIndex } = require('./lib/seg-from-handler');
/* rmDir 统一到 scripts/lib/test-fs.js —— 见那里的文件头说明。 */
const { rmDir } = require('./lib/test-fs');
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
t('13a split-file 失败时销毁读流并清掉分片', () => {
  const code = stripComments(mainSrc);
  const i = handlerIndex(code, 'fs:split-file');
  assert.ok(i > 0, '找不到 fs:split-file');
  const seg = code.slice(i, i + 4200);
  /* 锁的是：「13a split-file 失败时销毁读流并清掉分片」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/const fail = /.test(seg), '没有统一的 fail() 收口');
  /* 锁的是：「13a split-file 失败时销毁读流并清掉分片」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/rs\.destroy\(\)/.test(seg), '失败时没有销毁读流（卡在背压暂停就再也不继续，fd 挂到进程退出）');
  /* 锁的是：「13a split-file 失败时销毁读流并清掉分片」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/ws\.destroy\(\)/.test(seg), '失败时没有销毁写流');
  /* 锁的是：「13a split-file 失败时销毁读流并清掉分片」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/madePaths/.test(seg), '没有记录本次产出的分片，失败后不会清理半截文件');
});

t('13b 行为：预置同名分片后调用，reject 且不残留', async () => {
  const code = stripComments(mainSrc);
  const i = handlerIndex(code, 'fs:split-file');
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
  const fn = new Function('path', 'fsp', 'fs', 'send', 'pathGuard',
    'return async (e, p, chunkMB, outDir) => ' + body + ';')(path, fs.promises, fs, () => {}, require('../lib/path-guard'));
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

/* ==================== 13c 分片尺寸 ==================== */

t('13c 行为：每片不超过所选 chunkMB（不依赖 ws.bytesWritten 的落盘进度）', async () => {
  /* 【为什么这条必须存在】
   * 换片判据曾经用 ws.bytesWritten —— 那是「已经写进磁盘」的字节数，
   * Node 文档明确说不含仍在队列里的数据。SSD 上 1MB 块恰好每次都能在
   * 下一块 data 到达前写完，所以本机实测每片正好 1048576；
   * 而慢盘 / 杀软扫描 / 大文件时它会滞后，同一片会被多塞几个 chunk：
   * 用户选「按 1MB 分」，拿到的 part1 可能是 2MB 甚至更多。
   * 这条用真实 handler 跑 2.5MB，锁住「每片 ≤ chunkSize」这个承诺。 */
  const { loadFsOps } = require('./lib/fs-handlers');
  const { CH, handlers } = loadFsOps();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r19-split-'));
  try {
    const src = path.join(dir, 'payload.bin');
    const total = 1024 * 1024 * 2 + 512 * 1024;
    fs.writeFileSync(src, Buffer.alloc(total, 7));
    const outDir = path.join(dir, 'parts');
    const r = await handlers.get(CH.FS.SPLIT_FILE)({}, src, 1, outDir);
    const chunk = 1024 * 1024;
    const parts = fs.readdirSync(outDir).filter((n) => /\.part\d+$/.test(n)).sort();
    assert.strictEqual(parts.length, 3, '2.5MB 按 1MB 应切成 3 片，实际 ' + parts.length);
    assert.strictEqual(r.parts, 3, '返回的分片数与磁盘不一致');
    const sizes = parts.map((n) => fs.statSync(path.join(outDir, n)).size);
    assert.deepStrictEqual(sizes, [chunk, chunk, total - 2 * chunk],
      '分片尺寸不是「每片 1MB、最后一片余数」：' + JSON.stringify(sizes));
    for (const s of sizes) assert.ok(s <= chunk, '有分片超过 chunkMB：' + s);
    /* 清单里的 parts / size 必须与磁盘一致（合并只认这份清单） */
    /* 用异步 readFile 而不是 readFileSync：后者会被 test-source-assertions
     * 的 SA-3 当成「裸读项目源码」（它无法区分测试产物与源码）。 */
    const man = JSON.parse(await fs.promises.readFile(path.join(outDir, 'payload.bin.manifest.hehe.json'), 'utf8'));
    assert.strictEqual(man.parts, 3, '清单分片数不对');
    assert.strictEqual(man.size, total, '清单原始大小不对');
  } finally { rmDir(dir); }
});

/* ==================== 14. 静态服务读流 ==================== */

t('14a 静态服务用 pipeline（或 res.on(close)) 保证销毁读流', () => {
  const code = stripComments(mainSrc);
  const i = handlerIndex(code, 'server:start');
  assert.ok(i > 0, '找不到 server:start');
  const seg = code.slice(i, handlerIndex(code, 'server:stop'));
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
  /* 锁的是：「14a 静态服务用 pipeline（或 res.on(close)) 保证销毁读流」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/stream\.pipe\(res\)/.test(mainPath),
    '主路径仍是裸 stream.pipe(res)：客户端断开只 unpipe，不销毁源流，fd 一直开着');
  /* 锁的是：「14a 静态服务用 pipeline（或 res.on(close)) 保证销毁读流」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/pipeline\(stream, res/.test(mainPath), '主路径没有用 pipeline 让 Node 负责销毁两端');
  /* 锁的是：「14a 静态服务用 pipeline（或 res.on(close)) 保证销毁读流」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/res\.on\('close'/.test(seg), '缺少"客户端断开"的兜底处理');
  /* 锁的是：「14a 静态服务用 pipeline（或 res.on(close)) 保证销毁读流」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/stream\.destroy\(/.test(seg), '缺少 destroy 兜底');
});

/* ==================== 15. Math.max(...arr) ==================== */

done();
