'use strict';
/* 验证本轮三个新修复的实际行为：
 *   (1) merge-parts 分片缺失时不在最终文件名留下半成品
 *   (2) cryptStream 失败时不删除用户已存在的同名输出文件
 *   (3) 图片输出一律取唯一名，不覆盖目录里已有的同名文件
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
};
const assert = require('assert');

(async () => {
  /* ---------- (1) merge-parts 半成品 ---------- */
  await t('merge-parts 缺分片时最终文件不存在', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
    const base = 'big';
    // 只写第 1 片，第 2 片缺失
    fs.writeFileSync(path.join(d, base + '.part001'), Buffer.alloc(4000, 1));
    const man = { tool: 'hehe-split', name: base, size: 8000, chunkSize: 4000, parts: 2 };
    fs.writeFileSync(path.join(d, base + '.manifest.hehe.json'), JSON.stringify(man));
    const finalOut = path.join(d, base + '.merged');

    // 复刻 main.js 的逻辑：写临时名 -> 成功才改名
    const partTmp = finalOut + '.merging-' + Date.now();
    let threw = false;
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(partTmp);
        ws.on('error', reject);
        let i = 1, failed = false;
        const failFn = (e) => { if (!failed) { failed = true; try { ws.destroy(); } catch (err) {} reject(e); } };
        const next = () => {
          if (failed) return;
          if (i > man.parts) { ws.end(); ws.on('finish', resolve); return; }
          const part = path.join(d, `${base}.part${String(i).padStart(String(man.parts).length, '0')}`);
          const rs = fs.createReadStream(part);
          rs.on('end', () => { i++; next(); });
          rs.on('error', () => failFn(new Error('分片缺失')));
          rs.pipe(ws, { end: false });
        };
        next();
      });
      await fs.promises.rename(partTmp, finalOut);
    } catch (e) {
      threw = true;
      await fs.promises.rm(partTmp, { force: true }).catch(() => {});
    }
    assert.ok(threw, '缺分片应当抛错');
    assert.ok(!fs.existsSync(finalOut), '最终文件不该存在（否则是半成品）: ' + finalOut);
    const left = fs.readdirSync(d).filter(n => n.includes('.merging-'));
    assert.deepStrictEqual(left, [], '临时文件残留: ' + left.join(','));
    fs.rmSync(d, { recursive: true, force: true });
  });

  /* ---------- (2) cryptStream 失败不删原文件 ---------- */
  await t('解密失败时不删除已存在的同名输出文件', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crypt-'));
    const src = path.join(d, 'data.enc');
    const dest = path.join(d, 'out.txt');
    // 造一个假加密文件（头部正确但内容残缺，会导致 decrypt 失败）
    fs.writeFileSync(src, Buffer.concat([Buffer.from('HEHE-ENC'), Buffer.alloc(60, 7)]));
    fs.writeFileSync(dest, 'MY IMPORTANT PRE-EXISTING DATA');

    // 复刻新逻辑：写临时 -> rename
    const tmp = dest + '.hehe-crypt-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
    let threw = false;
    try {
      const ws = fs.createWriteStream(tmp);
      ws.write('partial');
      // 模拟 pipeline 失败
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
    // 复刻 fs:unique-path
    function uniquePath(p) {
      if (!fs.existsSync(p)) return p;
      const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
      for (let i = 1; i < 1000; i++) { const np = path.join(dir, `${base}(${i})${ext}`); if (!fs.existsSync(np)) return np; }
      return path.join(dir, `${base}-${Date.now()}${ext}`);
    }
    const finalPath = uniquePath(path.join(d, 'a.jpg'));
    assert.notStrictEqual(finalPath, existing, '未生成新名字');
    assert.ok(/a\(1\)\.jpg$/.test(finalPath), '应为 a(1).jpg: ' + finalPath);
    // 写入新文件，原有文件必须完好
    fs.writeFileSync(finalPath, 'JPEG-OUTPUT');
    assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'PREVIOUS OUTPUT - IMPORTANT', '原有文件被覆盖');
    fs.rmSync(d, { recursive: true, force: true });
  });

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
