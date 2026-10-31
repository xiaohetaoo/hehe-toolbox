/* P1-5 回归：验证「链接可读性检查」不会把整个文件读进内存。
 *
 * 【这条测试为什么必须存在】
 * verifyLinkReadable 发生在「源已改名、链接已建」之后 —— 全流程最危险的
 * 中间态。早期它用 fsp.readFile 整份读入，目录里有几个 GB 的镜像时
 * 主进程直接 OOM 崩掉，连回退都跑不到。
 *
 * 这里用真实文件验证行为而不是 grep 源码：
 *   1) 建一个 200MB 的稀疏文件（足够暴露整份读入的企图）；
 *   2) 挂在 junction 上，跑一次检查；
 *   3) 断言 RSS 增长远小于文件大小。
 * 20MB 的阈值给 Node 留足 GC 波动空间，而 200MB 的整份读入必然超。
 *
 * 【为什么要从 main.js 里抽源码求值】
 * 直接 require main.js 会创建窗口。而复刻一份等价实现在测试里是"假绿"：
 * 源码改动后复刻版照样全绿。所以这里把真函数的源码抽出来，用真依赖
 * （fsp/path/fs/Buffer）在沙箱里求值，测的是当前 main.js 里的那份实现。
 */
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* t() 必须能等 async：这几条用例全是异步真 IO，
 * 用同步包装会「先打印 PASS 再让断言失败」，等于把所有失败都吞掉。
 * 这里改成 async 顺序执行，最后统一统计。 */
let pass = 0, fail = 0;
const cases = [];
function t(name, fn) { cases.push([name, fn]); }

const ROOT = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

function extract(name) {
  const start = mainSrc.indexOf('async function ' + name + '(');
  assert.ok(start > 0, '找不到函数 ' + name + ' —— 函数被改名了？测试需要同步更新');
  let i = mainSrc.indexOf('{', start);
  let depth = 0;
  for (; i < mainSrc.length; i++) {
    const c = mainSrc[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return mainSrc.slice(start, i);
}

const fsp = fs.promises;
const srcVerify = extract('verifyLinkReadable');
const srcRead = extract('readHeadBytes');
const factory = new Function('fsp', 'path', 'fs', 'Buffer',
  srcRead + '\n' + srcVerify + '\nreturn { verifyLinkReadable, readHeadBytes };');
const mod = factory(fsp, path, fs, Buffer);

/* 造一个 200MB 的稀疏文件：只写头 4 字节与尾 4 字节，
 * 不真的占 200MB 磁盘，但 size 就是 200MB（正是触发整份读入的条件）。 */
function makeSparse(file, sizeMB) {
  const SIZE = sizeMB * 1024 * 1024;
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, Buffer.from('HEAD'), 0, 4, 0);
  fs.writeSync(fd, Buffer.from('TAIL'), 0, 4, SIZE - 4);
  fs.closeSync(fd);
  return SIZE;
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) {
    try { cp.execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true }); } catch (e2) {}
  }
}

const BIG_MB = 200;
const RSS_LIMIT_MB = 20;

t('readHeadBytes 只读前 n 字节（不是整份）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhb-'));
  const big = path.join(dir, 'big.bin');
  makeSparse(big, BIG_MB);
  try {
    /* 先触发一次 GC 抖动，让基线稳定 */
    if (global.gc) global.gc();
    const before = process.memoryUsage().rss;
    const got = await mod.readHeadBytes(big, 4096);
    const after = process.memoryUsage().rss;
    const grewMB = (after - before) / (1024 * 1024);
    assert.strictEqual(got, 4096, '应只读到 4KB，实际 ' + got);
    assert.ok(grewMB < RSS_LIMIT_MB,
      'RSS 增长了 ' + grewMB.toFixed(1) + 'MB —— 疑似把整个文件读进内存了（文件 ' + BIG_MB + 'MB）');
  } finally { rmDir(dir); }
});

t('空文件也能通过检查（0 字节不等于失败）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhb0-'));
  const empty = path.join(dir, 'empty.txt');
  fs.writeFileSync(empty, '');
  try {
    const got = await mod.readHeadBytes(empty, 4096);
    assert.strictEqual(got, 0, '空文件应返回 0 字节');
  } finally { rmDir(dir); }
});

t('文件不存在时抛错（而不是静默返回 0）', async () => {
  let threw = false;
  try { await mod.readHeadBytes(path.join(os.tmpdir(), 'no-such-hehe-file-xyz'), 4096); }
  catch (e) { threw = true; }
  assert.strictEqual(threw, true, '不存在应抛错 —— 静默返回 0 会被误判成「读到了」');
});

t('通过 junction 验证链接可读，且大文件不撑爆内存', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlr-'));
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  makeSparse(path.join(real, 'big.bin'), BIG_MB);
  const link = path.join(root, 'link');
  try {
    cp.execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, real], { windowsHide: true });
    if (global.gc) global.gc();
    const before = process.memoryUsage().rss;
    const r = await mod.verifyLinkReadable(link, real);
    const after = process.memoryUsage().rss;
    assert.strictEqual(r.ok, true, '链接应可读，实际：' + r.reason);
    assert.strictEqual(r.sampled, 1, '应抽样 1 个文件，实际 ' + r.sampled);
    const grewMB = (after - before) / (1024 * 1024);
    assert.ok(grewMB < RSS_LIMIT_MB,
      'RSS 增长了 ' + grewMB.toFixed(1) + 'MB —— 链接校验把大文件整份读进内存了');
  } finally { rmDir(root); }
});

t('空文件目录也能通过链接校验', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlr0-'));
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'empty.txt'), '');
  const link = path.join(root, 'link');
  try {
    cp.execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, real], { windowsHide: true });
    const r = await mod.verifyLinkReadable(link, real);
    assert.strictEqual(r.ok, true, '空文件应算通过（链接能打开就能读），实际：' + r.reason);
    assert.strictEqual(r.sampled, 1, '空文件也算抽样成功，实际 ' + r.sampled);
  } finally { rmDir(root); }
});

t('链接指向错地方时判失败（不是只看链接存不存在）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlr2-'));
  const real = path.join(root, 'real');
  const other = path.join(root, 'other');
  fs.mkdirSync(real); fs.mkdirSync(other);
  fs.writeFileSync(path.join(real, 'a.txt'), 'hi');
  const link = path.join(root, 'link');
  try {
    cp.execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, real], { windowsHide: true });
    const r = await mod.verifyLinkReadable(link, other);
    assert.strictEqual(r.ok, false, '指向非预期位置应判失败');
    assert.ok(/非预期位置/.test(r.reason), '原因要说清指向了别处：' + r.reason);
  } finally { rmDir(root); }
});

t('原路径不是链接时判失败', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vlr3-'));
  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain);
  try {
    const r = await mod.verifyLinkReadable(plain, plain);
    assert.strictEqual(r.ok, false, '普通目录不该被当成链接');
    assert.ok(/不是链接/.test(r.reason), '原因要说清不是链接：' + r.reason);
  } finally { rmDir(dir); }
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); pass++; console.log('PASS  ' + name); }
    catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
  }
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
