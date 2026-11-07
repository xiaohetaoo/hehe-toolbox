'use strict';
/* 文件加密/解密的输出路径闸门。
 *
 * ============ 锁的是哪个回归 ============
 * ipc/fs-ops.js 的 cryptStream 是同一批写盘实现里**唯一**没有调
 * pathGuard.checkOverwritable / checkFileName 的：
 * 对照 writeFileAtomic、FS.RENAME、MERGE_PARTS、ZIP.COMPRESS 都调了。
 *
 * 后果分三层（第三层是真正的安全问题）：
 *   ① 输出可以选到系统关键目录而无人拦；
 *   ② 能生成带尾点 / 尾空格的非法文件名 —— checkFileName 会拒，但没被调用，
 *      这类名字在资源管理器里存不住，用户以为加密成功、文件其实不见了；
 *   ③ 绕过渲染层直接构造 IPC 时可覆盖任意路径上的已有文件。
 *
 * ============ 关于 ③ 的实测结论（很重要，别再按错误假设改代码）============
 * 常见说法是「Windows 的 rename 不能覆盖已有文件」。**本机实测是能覆盖的**：
 *   fs.writeFileSync(a,'A'); fs.writeFileSync(b,'B'); fs.renameSync(a,b);
 *   → 成功返回，b 的内容变成 'A'（原内容被静默替换，不抛错）。
 * 所以「靠 rename 自身撞车来保护目标」是不成立的，必须在上游拦。
 * 这条断言把该结论钉在这里，避免以后有人按错假设把闸门删掉。
 *
 * ============ 为什么用源码断言 ============
 * cryptStream 不是导出的纯函数，它挂在两个 IPC handler 后面，
 * 跑起来要整套 fs + 加密流 + job:progress 推送。单测环境只能读结构，
 * 所以这里锁「两道闸门在位」＋「同一文件判定改用 canonical」，
 * 行为部分（闸门本身的行为）由 test-path-guard 覆盖。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const src = readSrc('ipc/fs-ops.js');

t('CS1 cryptStream 调用 checkOverwritable（与其它写盘实现一致）', () => {
  const i = src.indexOf('async function cryptStream');
  assert.ok(i > 0, '找不到 cryptStream');
  const body = src.slice(i, i + 3000);
  /* 锁的是：加密输出能落在系统关键目录里而无人拦。 */
  assert.ok(/pathGuard\.checkOverwritable\(outPath\)/.test(body),
    'cryptStream 没有调 checkOverwritable(outPath)');
});

t('CS2 cryptStream 调用 checkFileName（拒绝尾点 / 尾空格）', () => {
  const i = src.indexOf('async function cryptStream');
  const body = src.slice(i, i + 3000);
  /* 锁的是：能生成 a.b. / 'a.b ' 这类在资源管理器里存不住的非法名。 */
  assert.ok(/pathGuard\.checkFileName\(\s*path\.basename\(/.test(body),
    'cryptStream 没有调 checkFileName');
});

t('CS3 同源判定用 pathGuard.canonical 归一（不各自拼字符串）', () => {
  const i = src.indexOf('async function cryptStream');
  const body = src.slice(i, i + 3000);
  /* 锁的是：realpath(p) 与「realpath(dir)+sep+basename」直接比 ——
   * 长度前缀、尾点、8.3 短名在这两条路径上展开不一致时会漏判同源。 */
  assert.ok(/pathGuard\.canonical\(p\)\s*===\s*pathGuard\.canonical\(outPath\)/.test(body),
    '同源判定没有用 canonical 归一');
});

t('CS4 闸门放在读取源文件之前（不先白读一遍再拒）', () => {
  const i = src.indexOf('async function cryptStream');
  const body = src.slice(i, i + 3000);
  /* 锁的是：把闸门挪到 pipeline 之后 —— 那时已经把整份文件加密写进临时文件了，
   * 拒绝得越晚浪费越大，而且临时文件清理路径也更复杂。 */
  const iGuard = body.indexOf('checkOverwritable(outPath)');
  const iPipe = body.indexOf("require('stream').pipeline");
  assert.ok(iGuard > 0 && iPipe > iGuard, '闸门必须排在真正的读写流程之前');
});

t('CS5 行为前置：Windows 上 rename 确实会静默覆盖已有目标', () => {
  /* 锁的是：这条回归的**前提**被误解。
   * 若哪天这里抛错（不同平台/不同 Node 行为变了），上面那段注释就过期了，
   * 而「必须在上游拦」这个理由也随之变化 —— 所以把前提本身也测起来。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-over-'));
  const a = path.join(dir, 'a.txt'), b = path.join(dir, 'b.txt');
  try {
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(b, 'B');
    let threw = null;
    try { fs.renameSync(a, b); } catch (e) { threw = e; }
    assert.strictEqual(threw, null,
      'rename 在本平台不覆盖（抛了 ' + (threw && threw.code) + '）—— 本文档注释的前提需要更新');
    assert.strictEqual(fs.readFileSync(b, 'utf8'), 'A',
      'rename 后目标内容不是源内容 —— 覆盖语义与预期不同');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('CS6 闸门用的正是 pathGuard 那份实现（不是自己又写一套）', () => {
  /* 锁的是：为了"顺手"在 fs-ops 里内联一份黑名单 ——
   * 那样 path-guard 更新（新增关键目录 / 新的非法名规则）时这里不会跟着变。 */
  const i = src.indexOf('async function cryptStream');
  const body = src.slice(i, i + 3000);
  /* 锁的是：为了"顺手"在 fs-ops 里直接 throw new Error(...) —— 那样错误码
   * 退化成 UNKNOWN，与 lib/errors.js 的码分支脱节（正是问题 2 修掉的退化）。 */
  assert.ok(/pathGuard\.err\(/.test(body), '闸门拒绝时没有走 pathGuard.err（错误码会丢失）');
});

done();
