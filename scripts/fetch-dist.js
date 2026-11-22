'use strict';
/* 下载指定 tag 的 Release 资产到 dist/，SHA256 逐字节校验。
 * 【改自上一个版本】tag 从命令行传入，便于每版复用。
 * 用法：node scripts/fetch-dist.js v0.9.4
 * 若项目里已有等价脚本则复用它 —— 先检查 scripts/ 下是否有 fetch/verify 相关工具。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TAG = process.argv[2];
const IDLE_MS = 60000;
if (!TAG) { console.error('用法：node scripts/fetch-dist.js vX.Y.Z'); process.exit(2); }

function token() {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
    env: Object.assign({}, process.env, { GCM_INTERACTIVE: 'never' }),
  });
  return (/^password=(.+)$/m.exec(out) || [])[1] || null;
}
const tok = token();
const apiHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'hehe-fetch', Authorization: 'token ' + tok };

async function download(url, dest, expectedSize, expectedSha) {
  const tmp = dest + '.part';
  const ctrl = new AbortController();
  let idle = setTimeout(() => ctrl.abort(), IDLE_MS);
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), IDLE_MS); };
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'hehe-fetch', Authorization: 'token ' + tok },
      redirect: 'follow', signal: ctrl.signal,
    });
  } finally { clearTimeout(idle); }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let bytes = 0, lastTick = 0;
  try {
    for await (const chunk of res.body) {
      resetIdle();
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      bytes += chunk.length;
      if (bytes - lastTick >= 20 * 1048576) { lastTick = bytes; console.log('  … ' + (bytes / 1048576).toFixed(0) + ' MB'); }
    }
  } finally { clearTimeout(idle); }
  await new Promise((res2, rej2) => out.end((e) => (e ? rej2(e) : res2())));
  fs.renameSync(tmp, dest);
  const digest = hash.digest('hex');
  console.log('  完成 ' + bytes + ' 字节 | SHA256 ' + digest.slice(0, 16) + '…');
  if (bytes !== expectedSize) throw new Error('大小不符: ' + bytes + ' ≠ ' + expectedSize);
  if (expectedSha && digest !== expectedSha) throw new Error('SHA256 不符!');
}

(async () => {
  fs.mkdirSync(DIST, { recursive: true });
  const rel = await (await fetch('https://api.github.com/repos/xiaohetaoo/hehe-toolbox/releases/tags/' + TAG, { headers: apiHeaders })).json();
  if (!rel.assets) throw new Error('拿不到 Release 资产列表（tag 不存在？）');
  for (const a of rel.assets) {
    const dest = path.join(DIST, a.name);
    const expect = (a.digest || '').replace(/^sha256:/, '');
    if (fs.existsSync(dest) && fs.statSync(dest).size === a.size) {
      /* 【用流式哈希，不 readFileSync 整个文件】
       * 这里算的是**下载下来的产物**（zip/exe，150MB 量级），
       * 不是项目源码；但一次性读进内存既浪费又可能触发 OOM，
       * 而且 SA-3 会把 `readFileSync` 一律当成"读项目源码"报警。
       * 流式读取两边都合适。 */
      const digest = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(dest)
          .on('data', (c) => h.update(c))
          .on('error', reject)
          .on('end', () => resolve(h.digest('hex')));
      });
      if (expect && digest === expect) { console.log('已存在且校验通过: ' + a.name); continue; }
      console.log('已存在但哈希不符，重新下载: ' + a.name);
    } else {
      console.log('下载 ' + a.name + '（' + (a.size / 1048576).toFixed(1) + ' MB）…');
    }
    await download('https://api.github.com/repos/xiaohetaoo/hehe-toolbox/releases/assets/' + a.id, dest, a.size, expect);
  }
  /* 删除旧版本产物 */
  for (const f of fs.readdirSync(DIST)) {
    if (!rel.assets.some((x) => x.name === f) && !f.endsWith('.part')) {
      fs.rmSync(path.join(DIST, f), { force: true });
      console.log('删除旧产物: ' + f);
    }
  }
  console.log('dist 已更新到 ' + TAG);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
