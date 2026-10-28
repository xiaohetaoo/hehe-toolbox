'use strict';
/* 验证 hosts:write 的兜底分支顺序（先补回 hosts，再删临时文件）。
 * 原实现顺序反了：先 rm(tmp) 再 copyFile(tmp) -> hosts 原文件已删、唯一副本也没了，
 * 系统 hosts 彻底消失，全机 DNS 断掉。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
};
const assert = require('assert');

/* 复刻 main.js hosts:write 的退化路径 */
async function hostsWriteFallback(hosts, content, opts = {}) {
  const tmp = hosts + '.hehe.tmp';
  await fs.promises.writeFile(tmp, content, 'utf8');
  try {
    if (opts.failRename1) throw new Error('EPERM');
    await fs.promises.rename(tmp, hosts);
    return 'direct';
  } catch (err) {
    await fs.promises.rm(hosts, { force: true }).catch(() => {});
    try {
      if (opts.failRename2) throw new Error('EPERM(2)');
      await fs.promises.rename(tmp, hosts);
      return 'retry';
    } catch (err2) {
      // 正确顺序：先补回 hosts，再删 tmp
      let restored = false;
      try {
        await fs.promises.copyFile(tmp, hosts);
        restored = true;
      } catch (e3) {
        throw new Error('无法恢复，tmp 保留在 ' + tmp);
      }
      if (restored) await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw new Error('替换失败但已恢复');
    }
  }
}

(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-'));
  const hosts = path.join(d, 'hosts');
  const ORIGINAL = '127.0.0.1 localhost\nORIGINAL CONTENT\n';

  /* 1) 正常路径 */
  fs.writeFileSync(hosts, ORIGINAL);
  await hostsWriteFallback(hosts, 'NEW CONTENT\n');
  await t('正常替换：内容更新，无残留', async () => {
    assert.strictEqual(fs.readFileSync(hosts, 'utf8'), 'NEW CONTENT\n');
    assert.deepStrictEqual(fs.readdirSync(d).filter(n => n.includes('.hehe.tmp')), []);
  });

  /* 2) 两次 rename 都失败 -> hosts 必须存在且是新内容（不是消失） */
  fs.writeFileSync(hosts, ORIGINAL);
  let threw = false;
  try { await hostsWriteFallback(hosts, 'RECOVERED CONTENT\n', { failRename1: true, failRename2: true }); }
  catch (e) { threw = true; }
  await t('两次 rename 失败：抛错', async () => assert.ok(threw));
  await t('两次 rename 失败：hosts 文件仍然存在（关键）', async () => {
    assert.ok(fs.existsSync(hosts), 'hosts 文件消失了！全机 DNS 会断');
  });
  await t('两次 rename 失败：hosts 内容被恢复（而不是空的）', async () => {
    const c = fs.readFileSync(hosts, 'utf8');
    assert.strictEqual(c, 'RECOVERED CONTENT\n', '得到: ' + JSON.stringify(c));
  });
  await t('两次 rename 失败：临时文件已清理', async () => {
    assert.deepStrictEqual(fs.readdirSync(d).filter(n => n.includes('.hehe.tmp')), []);
  });

  /* 3) 对照：旧的错误顺序会怎样 */
  await t('对照实验：旧顺序（先删 tmp 再复制）确实会丢掉 hosts', async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts2-'));
    const h2 = path.join(d2, 'hosts');
    const t2 = h2 + '.hehe.tmp';
    fs.writeFileSync(h2, ORIGINAL);
    await fs.promises.writeFile(t2, 'NEW\n');
    // 模拟旧实现：rm(hosts) -> rename 失败 -> rm(tmp) -> copyFile(tmp) 必然 ENOENT
    await fs.promises.rm(h2, { force: true }).catch(() => {});
    await fs.promises.rm(t2, { force: true }).catch(() => {});
    let copyErr = null;
    await fs.promises.copyFile(t2, h2).catch(e => { copyErr = e.code; });
    assert.strictEqual(copyErr, 'ENOENT', '应当 ENOENT');
    assert.ok(!fs.existsSync(h2), '旧顺序下 hosts 确实消失了（这就是 bug）');
    fs.rmSync(d2, { recursive: true, force: true });
  });

  fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
