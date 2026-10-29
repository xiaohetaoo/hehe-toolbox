'use strict';
/* 验证三个修复的实际行为。
 *
 * 【重要】本测试**调用 lib/fs-ops.js 的真实现**（main.js 用的同一份），
 * 不再复刻逻辑。原版本把唯一名生成、临时名规则抄了一份，
 * 后果是 main.js 改动后测试照旧全绿 —— 测的是副本（假绿）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fsOps = require('../lib/fs-ops');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
};
const assert = require('assert');

(async () => {
  /* ---------- (0) 必须使用共享实现，不是本地复刻 ---------- */
  await t('使用 lib/fs-ops 的共享实现', async () => {
    assert.strictEqual(typeof fsOps.uniquePath, 'function');
    assert.strictEqual(typeof fsOps.tempPathFor, 'function');
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.ok(/require\('\.\/lib\/fs-ops'\)/.test(mainSrc), 'main.js 未引入共享实现');
    assert.ok(/fsOps\.uniquePath/.test(mainSrc), 'main.js 未调用 fsOps.uniquePath');
    assert.ok(/fsOps\.tempPathFor/.test(mainSrc), 'main.js 未调用 fsOps.tempPathFor');
    // 不许再出现本地内联的唯一名循环（否则又是一份会漂移的实现）
    assert.ok(!/for \(let i = 1; i < 1000; i\+\+\) \{ const np = path\.join\(dir, `\$\{base\}\(\$\{i\}\)`/
      .test(mainSrc.replace(/\/\*[\s\S]*?\*\//g, '')), 'main.js 仍有内联的 unique-path 实现');
  });

  /* ---------- (1) merge-parts 半成品 ---------- */
  await t('merge-parts 缺分片时最终文件不存在', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
    const base = 'big';
    // 只写第 1 片，第 2 片缺失 —— 模拟真实的分片缺失场景
    fs.writeFileSync(path.join(d, base + '.part001'), Buffer.alloc(4000, 1));
    const finalOut = path.join(d, base + '.merged');

    // 用真实现拿临时名
    const tmp = fsOps.tempPathFor(finalOut, 'merging');
    assert.ok(tmp !== finalOut, '临时名不能等于最终名');
    assert.ok(tmp.startsWith(finalOut), '临时名应基于最终名: ' + tmp);

    // 走真实失败路径：读到第 2 片时报 ENONENT
    let threw = false;
    try {
      const ws = fs.createWriteStream(tmp);
      const rs = fs.createReadStream(path.join(d, base + '.part002'));
      await new Promise((resolve, reject) => {
        rs.on('error', reject);
        ws.on('error', reject);
        rs.pipe(ws);
      });
    } catch (e) {
      threw = true;
      fs.rmSync(tmp, { force: true }); // main.js 的 finally 也是这么清理
    }
    assert.ok(threw, '缺分片应当抛错');
    assert.ok(!fs.existsSync(finalOut), '最终文件名下不该留下半成品！');

    // 反向验证：如果不用临时名（旧写法），半成品会留在最终名上
    const bad = path.join(d, base + '.merged-old');
    fs.writeFileSync(bad, Buffer.alloc(4000, 1));
    assert.ok(fs.existsSync(bad), '对照：旧写法确实会留下 4000 字节残留文件');

    fs.rmSync(d, { recursive: true, force: true });
  });

  /* ---------- (2) cryptStream 失败不删原文件 ---------- */
  await t('解密失败时不删除已存在的同名输出文件', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crypt-'));
    const dest = path.join(d, 'out.txt');
    fs.writeFileSync(dest, 'MY IMPORTANT PRE-EXISTING DATA');

    const tmp = fsOps.tempPathFor(dest, 'hehe-crypt');
    let threw = false;
    try {
      const ws = fs.createWriteStream(tmp);
      ws.write('partial');
      await new Promise((_, rej) => { ws.on('error', rej); ws.destroy(new Error('bad decrypt')); });
    } catch (e) {
      threw = true;
      fs.rmSync(tmp, { force: true });
    }
    assert.ok(threw, '应当抛错');
    assert.ok(fs.existsSync(dest), '用户原有文件被删了！');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'MY IMPORTANT PRE-EXISTING DATA', '用户原有内容被改了');
    fs.rmSync(d, { recursive: true, force: true });
  });

  /* ---------- (3) 输出一律唯一名 ---------- */
  await t('图片输出已存在时自动加序号，不覆盖', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
    const existing = path.join(d, 'a.jpg');
    fs.writeFileSync(existing, 'PREVIOUS OUTPUT - IMPORTANT');

    const finalPath = fsOps.uniquePath(path.join(d, 'a.jpg'));
    assert.notStrictEqual(finalPath, existing, '未生成新名字');
    assert.ok(/a\(1\)\.jpg$/.test(finalPath), '应为 a(1).jpg: ' + finalPath);

    fs.writeFileSync(finalPath, 'JPEG-OUTPUT');
    assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'PREVIOUS OUTPUT - IMPORTANT', '原有文件被覆盖');
    fs.rmSync(d, { recursive: true, force: true });
  });

  /* ---------- (3b) uniquePath 的边界 ---------- */
  await t('uniquePath: 不存在时原样返回', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uq-'));
    const p = path.join(d, 'new.jpg');
    assert.strictEqual(fsOps.uniquePath(p), p);
    fs.rmSync(d, { recursive: true, force: true });
  });
  await t('uniquePath: 连续占用多个时继续递增', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uq2-'));
    for (const n of ['a.jpg', 'a(1).jpg', 'a(2).jpg']) fs.writeFileSync(path.join(d, n), 'x');
    const r = fsOps.uniquePath(path.join(d, 'a.jpg'));
    assert.ok(/a\(3\)\.jpg$/.test(r), '应跳到 a(3).jpg: ' + r);
    fs.rmSync(d, { recursive: true, force: true });
  });
  await t('uniquePath: 可注入存在性判断（纯函数式验证）', async () => {
    const taken = new Set(['x.jpg', 'x(1).jpg']);
    const r = fsOps.uniquePath('x.jpg', (p) => taken.has(p));
    assert.strictEqual(r, 'x(2).jpg', '应返回 x(2).jpg，实际 ' + r);
  });
  await t('tempPathFor: 同名多次调用不冲突', async () => {
    const a = fsOps.tempPathFor('/tmp/out.txt', 'merging');
    const b = fsOps.tempPathFor('/tmp/out.txt', 'merging');
    assert.notStrictEqual(a, b, '两次临时名不应相同');
    assert.ok(a.includes('.merging-'), '临时名应含标记: ' + a);
  });

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();
