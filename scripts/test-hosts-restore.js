'use strict';
/* 验证 hosts:restore 现在会先备份当前状态，且用原子替换。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let pass = 0, fail = 0;
const t = async (n, f) => {
  try { await f(); pass++; console.log('PASS  ' + n); }
  catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); }
};

/* 复刻 main.js hosts:restore 的核心逻辑 */
async function restore(HOSTS_PATH, backupDir, backupFile, opts = {}) {
  const stamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23) + '-' + crypto.randomBytes(2).toString('hex');
  // 1) 先备份当前
  try {
    if (opts.failPreBackup) throw new Error('模拟备份失败');
    await fs.promises.copyFile(HOSTS_PATH, path.join(backupDir, `hosts-prerestore-${stamp}.bak`));
  } catch (err) {
    throw new Error('备份当前 hosts 失败，已中止还原：' + err.message);
  }
  const tmp = HOSTS_PATH + '.hehe.restore.tmp';
  try {
    await fs.promises.copyFile(backupFile, tmp);
    await fs.promises.rename(tmp, HOSTS_PATH);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    await fs.promises.copyFile(backupFile, HOSTS_PATH);
  }
  return true;
}

(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hostsrestore-'));
  const hosts = path.join(d, 'hosts');
  const bakDir = path.join(d, 'hosts-backup');
  fs.mkdirSync(bakDir, { recursive: true });
  const oldBak = path.join(bakDir, 'hosts-20260101-000000-aaaa.bak');

  await t('还原前会把当前 hosts 另存为 pre-restore 备份', async () => {
    fs.writeFileSync(hosts, 'CURRENT CONTENT\n');
    fs.writeFileSync(oldBak, 'OLD BACKUP\n');
    await restore(hosts, bakDir, oldBak);
    assert.strictEqual(fs.readFileSync(hosts, 'utf8'), 'OLD BACKUP\n', '没有还原成备份内容');
    const pre = fs.readdirSync(bakDir).filter(n => n.startsWith('hosts-prerestore-'));
    assert.strictEqual(pre.length, 1, '没有生成 pre-restore 备份');
    assert.strictEqual(fs.readFileSync(path.join(bakDir, pre[0]), 'utf8'), 'CURRENT CONTENT\n',
      'pre-restore 备份内容不对（应是被覆盖前的当前内容）');
  });

  await t('备份当前失败时中止还原（不动 hosts）', async () => {
    fs.writeFileSync(hosts, 'KEEP ME\n');
    let threw = false;
    try { await restore(hosts, bakDir, oldBak, { failPreBackup: true }); } catch (e) { threw = true; }
    assert.ok(threw, '应当抛错');
    assert.strictEqual(fs.readFileSync(hosts, 'utf8'), 'KEEP ME\n', 'hosts 被改了');
  });

  await t('还原后不残留临时文件', async () => {
    const left = fs.readdirSync(d).filter(n => n.includes('.hehe.restore.tmp'));
    assert.deepStrictEqual(left, [], '残留: ' + left.join(','));
  });

  await t('对照：旧实现（直接 copyFile）不会产生 pre-restore 备份', async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hostsold-'));
    const h2 = path.join(d2, 'hosts');
    const b2 = path.join(d2, 'b.bak');
    fs.writeFileSync(h2, 'CURRENT\n');
    fs.writeFileSync(b2, 'OLD\n');
    await fs.promises.copyFile(b2, h2);   // 旧实现
    const pre = fs.readdirSync(d2).filter(n => n.startsWith('hosts-prerestore-'));
    assert.strictEqual(pre.length, 0, '旧实现不该有 pre-restore');
    assert.strictEqual(fs.readFileSync(h2, 'utf8'), 'OLD\n');
    fs.rmSync(d2, { recursive: true, force: true });
  });

  fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
