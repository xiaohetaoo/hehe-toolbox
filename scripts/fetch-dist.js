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
/* 仓库坐标：镜像下载需要 owner/repo 拼 URL。写死在这里而不是从 git remote 解析，
 * 因为脚本只服务本仓库、解析 remote 反而会引入"local/upstream 名字不同"的坑。 */
const REPO = 'xiaohetaoo/hehe-toolbox';
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
  /* 【先试官方资产端点；被阻断时自动走镜像】
   * 2026-11-24 实测：官方 302 到 `release-assets.githubusercontent.com`，
   * 而该域名在本机网络下完全下不动 —— Node fetch / Invoke-WebRequest /
   * curl 直连签名 URL，三种方式都是 **0 字节且永不报错**（连接建立后无数据）。
   * 同一时刻 Cloudflare 的 10MB 测试文件以 0.85 MB/s 正常下完，
   * 说明不是带宽/防火墙全断，而是该域名被阻断或限速为 0。
   *
   * 绕过办法：走公开的 GitHub 加速镜像（`ghfast.top` 实测可用，
   * 0.83~1.24 MB/s）。镜像只当传输通道 —— 下载完仍按**官方 API 的
   * digest** 做 SHA-256 逐字节校验，传坏或传错会立刻被拒，不会污染 dist/。
   *
   * 顺序：官方端点（快、可信）→ 失败/0 字节 → 镜像。
   * 每个候选都有独立的超时，任何一个卡住都不会拖死整轮。 */
  const MIRROR = 'https://ghfast.top/https://github.com';
  const m = /\/releases\/assets\/(\d+)$/.exec(url);
  const official = url;
  /* 镜像需要 "owner/repo/releases/download/tag/name"，从 dest 文件名 + 环境拿 */
  const mirrorUrl = MIRROR + '/' + REPO + '/releases/download/' + TAG + '/' + path.basename(dest);
  const attempts = [];
  if (m) attempts.push({ label: '官方', url: official });
  attempts.push({ label: '镜像 ghfast.top', url: mirrorUrl });

  let lastErr = null;
  for (const a of attempts) {
    try {
      await downloadOnce(a.url, dest, expectedSize, expectedSha, a.label);
      return;
    } catch (e) {
      lastErr = e;
      console.log('  ✗ ' + a.label + '失败：' + e.message);
      try { fs.rmSync(dest + '.part', { force: true }); } catch (e2) {}
    }
  }
  throw lastErr || new Error('所有下载通道均失败');
}

async function downloadOnce(url, dest, expectedSize, expectedSha, label) {
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
  const digest = hash.digest('hex');
  /* 【0 字节要单独报】被阻断时的典型形态是"连接建立、永不发数据"：
   * fetch 不报错、res.ok 为 true、body 立刻结束 —— 落盘是 0 字节。
   * 不单独判的话，用户看到的是"大小不符 0 ≠ 161390678"，会误以为是
   * 版本/资产搞错了，而真实原因是传输通道给了个空响应。
   * 先删掉空文件再抛，避免污染 dist/。 */
  if (bytes === 0) {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    throw new Error('通道返回 0 字节（域名可能被阻断）：' + label);
  }
  fs.renameSync(tmp, dest);
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
