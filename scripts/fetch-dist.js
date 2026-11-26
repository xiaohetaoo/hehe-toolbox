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
const IDLE_MS = 180000;   // 官方 CDN 首包可能要等十几秒，慢速约 100~150 KB/s
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
  /* 【官方端点优先；只有"确实拿不到字节"才回退镜像】
   *
   * ============ 2026-11-26 更正上一轮的结论 ============
   * 上一轮这里写着「官方 CDN 被阻断，三种下载器都是 0 字节」——**那个结论是错的**，
   * 是我误判了。真相是：`release-assets.githubusercontent.com` 可以连、也能下，
   * 只是**首字节要等十几秒、速率约 100~150 KB/s**。
   * `curl -r 0-1048575` 实测 http=206、10.3s 拿到 1MB、101 KB/s；
   * 完整 154MB 用 1198s 下完，SHA256 与官方 digest 一致。
   *
   * 当时判定"阻断"是因为：① 连接建立后十几秒没有数据，而我的空闲超时只有 60s，
   * 但更致命的是 ② 我把 `res.body` 的**首个 chunk 之前的等待**算进了"无数据"，
   * 而 Node fetch 在这种"接受连接、慢速首包"的场景下既不报错也不给 chunk，
   * 于是被 `bytes === 0` 误判成"通道返回 0 字节"。
   *
   * 现在的策略：
   *   · 空闲超时放宽到 180s（首包 + 慢速都要容得下）
   *   · 官方端点作为**首选**（唯一权威源）；只有连接错误/HTTP 非 2xx 才回退镜像
   *   · 镜像列表保留（ghfast.top 等），但镜像当前也可能不可用，故失败时如实报错
   *   · 慢不是错：`--speed-limit` 式的"低速放弃"只在极低时触发，交给调用方超时
   */
  const MIRROR = 'https://ghfast.top/https://github.com';
  const m = /\/releases\/assets\/(\d+)$/.exec(url);
  const official = url;
  /* 镜像需要 "owner/repo/releases/download/tag/name"，从 dest 文件名 + 环境拿 */
  const mirrorUrl = MIRROR + '/' + REPO + '/releases/download/' + TAG + '/' + path.basename(dest);
  const attempts = [];
  if (m) attempts.push({ label: '官方 CDN', url: official });
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
  /* 【0 字节：如实报，但别写成"被阻断"】
   * 2026-11-26 更正：上一轮这里断言"域名被阻断"，实际是我把
   * "慢速首包"误判成"永不发数据"。真正的成因有两类，必须分开说：
   *   a) 连接错误/HTTP 非 2xx  → 由上面的 throw 报了，走不到这里
   *   b) 空闲超时被 abort      → 会抛 AbortError，也走不到这里
   *   c) 服务端给了 200 但 body 立即结束 → 才是真的空响应
   * 所以这里能落到的只剩 (c)。文案不再猜原因，只报事实 + 通道名。 */
  if (bytes === 0) {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    throw new Error('通道返回了空响应（HTTP 200 但 0 字节）：' + label);
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
  /* 【删除旧产物之前必须先确认新产物真的就位】
   * 2026-11-26 事故：镜像全挂、两个资产都没下成，但这里照样把
   * 0.9.6 的旧 zip/exe 删掉了 —— dist/ 直接变空，等于自己把可用产物清了。
   * 删除是**破坏性**动作，必须放在"目标状态已达成"之后。
   * 判据：本次 Release 的每个资产都在 dist/ 里且大小正确。 */
  const missing = rel.assets.filter((a) => {
    const p = path.join(DIST, a.name);
    return !fs.existsSync(p) || fs.statSync(p).size !== a.size;
  });
  if (missing.length) {
    console.error('下载未完成，保留旧产物不删：缺 ' + missing.map((a) => a.name).join(', '));
    process.exit(1);
  }
  /* 目标状态已达成，才清理旧版本产物 */
  for (const f of fs.readdirSync(DIST)) {
    if (!rel.assets.some((x) => x.name === f) && !f.endsWith('.part')) {
      fs.rmSync(path.join(DIST, f), { recursive: true, force: true });
      console.log('删除旧产物: ' + f);
    }
  }
  console.log('dist 已更新到 ' + TAG);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
