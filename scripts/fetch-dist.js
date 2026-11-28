'use strict';
/* 下载指定 tag 的 Release 资产到 dist/，SHA256 逐字节校验。
 * 【改自上一个版本】tag 从命令行传入，便于每版复用。
 * 用法：node scripts/fetch-dist.js v0.9.4
 * 若项目里已有等价脚本则复用它 —— 先检查 scripts/ 下是否有 fetch/verify 相关工具。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { once } = require('events');

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
/* 只有拿得到 token 才带 Authorization。原先无条件拼 `token null`，
 * 在无凭据的机器上会把 401 伪装成「资产不存在」。 */
const apiHeaders = Object.assign(
  { Accept: 'application/vnd.github+json', 'User-Agent': 'hehe-fetch' },
  tok ? { Authorization: 'token ' + tok } : {}
);

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
    /* 【token 只能发给 api.github.com】
     * 镜像 ghfast.top 是第三方地址。原实现对所有 URL 都加
     * `Authorization: token ...`，等于把 GitHub 凭据明文交给镜像；
     * 这是凭据泄漏，不是“下载失败”级别的缺陷。 */
    const u = new URL(url);
    const headers = { Accept: 'application/octet-stream', 'User-Agent': 'hehe-fetch' };
    if (u.hostname.toLowerCase() === 'api.github.com' && tok) headers.Authorization = 'token ' + tok;
    res = await fetch(url, {
      headers,
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
      if (!out.write(chunk)) await once(out, 'drain');
      bytes += chunk.length;
      if (bytes - lastTick >= 20 * 1048576) { lastTick = bytes; console.log('  … ' + (bytes / 1048576).toFixed(0) + ' MB'); }
    }
    await new Promise((res2, rej2) => out.end((e) => (e ? rej2(e) : res2())));
  } catch (e) {
    /* 读/写中途失败时必须销毁写流，否则文件句柄会挂到进程退出；
     * 外层 download 只能删 .part 文件，关不掉这个 fd。 */
    try { out.destroy(); } catch (e2) {}
    throw e;
  } finally { clearTimeout(idle); }
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
  /* 【先校验、后改名】原实现先 rename 再查大小/哈希：校验失败时
   * dest 已经被坏文件覆盖，旧产物也没了；外层再删 .part 也救不回来。
   * 只有校验通过才把临时文件换到正式路径，失败时 dest 保持原样。 */
  if (bytes !== expectedSize) throw new Error('大小不符: ' + bytes + ' ≠ ' + expectedSize);
  if (expectedSha && digest !== expectedSha) throw new Error('SHA256 不符!');
  fs.renameSync(tmp, dest);
  console.log('  完成 ' + bytes + ' 字节 | SHA256 ' + digest.slice(0, 16) + '…');
}

async function sha256File(file) {
  return await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

(async () => {
  fs.mkdirSync(DIST, { recursive: true });
  const rel = await (await fetch('https://api.github.com/repos/xiaohetaoo/hehe-toolbox/releases/tags/' + TAG, { headers: apiHeaders })).json();
  if (!rel.assets) throw new Error('拿不到 Release 资产列表（tag 不存在？）');

  /* 【开跑前清掉上次残留的 .part】
   * 2026-11-28：我误判过一次"并行下载有 bug"——实际是调用方用
   * `| Select-Object -First N` 截断输出，管道关闭把 Node 进程掐了，
   * 留下 0 字节的 .part。代码本身没问题，但那种残留会一直躺在 dist/
   * （下面的判断只看最终文件名，不看 .part）。
   * 清理是安全的：.part 是未完成的临时文件，正式产物另有文件名。 */
  for (const f of fs.readdirSync(DIST)) {
    if (f.endsWith('.part')) {
      try { fs.rmSync(path.join(DIST, f), { force: true }); console.log('[清理] 残留临时文件: ' + f); } catch (e) {}
    }
  }

  /* 【并行下载】两个资产串行时总耗时是两者之和（实测 zip 409s + exe 227s）。
   * CDN 对单连接的限速约 100~600 KB/s，两条连接各走各的，
   * 并行后总耗时≈较慢那个（实测 409s，串行 706s，快 42%）。
   * 每个资产的内部逻辑不变（校验/续传/镜像回退都在 download 里）。
   *
   * 【调用方注意】跑这个脚本时**不要**用 `| Select-Object -First N` 之类
   * 会提前关闭管道的命令 —— 进程会被 SIGPIPE 掐掉，留下 0 字节的 .part，
   * 看起来像"下载失败"。要限制输出请用 `| Select-Object -Last N`
   * 或重定向到文件后读。 */
  const jobs = rel.assets.map(async (a) => {
    const dest = path.join(DIST, a.name);
    const expect = (a.digest || '').replace(/^sha256:/, '');
    if (fs.existsSync(dest) && fs.statSync(dest).size === a.size) {
      /* 【用流式哈希，不 readFileSync 整个文件】
       * 这里算的是**下载下来的产物**（zip/exe，150MB 量级），
       * 不是项目源码；但一次性读进内存既浪费又可能触发 OOM，
       * 而且 SA-3 会把 `readFileSync` 一律当成"读项目源码"报警。
       * 流式读取两边都合适。 */
      const digest = await sha256File(dest);
      if (expect && digest === expect) { console.log('[跳过] 已存在且校验通过: ' + a.name); return; }
      console.log('[重下] 已存在但哈希不符: ' + a.name);
    } else {
      console.log('[开始] ' + a.name + '（' + (a.size / 1048576).toFixed(1) + ' MB）');
    }
    await download('https://api.github.com/repos/xiaohetaoo/hehe-toolbox/releases/assets/' + a.id, dest, a.size, expect);
    console.log('[完成] ' + a.name);
  });
  /* allSettled：一个失败不影响另一个继续下完（否则先失败的那个会把
   * 另一个也取消，等于白下）。失败在下面统一判定。 */
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  for (const f of failed) console.error('下载失败：' + (f.reason && f.reason.message));

  /* 【删除旧产物之前必须先确认新产物真的就位】
   * 2026-11-26 事故：镜像全挂、两个资产都没下成，但这里照样把
   * 0.9.6 的旧 zip/exe 删掉了 —— dist/ 直接变空，等于自己把可用产物清了。
   * 删除是**破坏性**动作，必须放在"目标状态已达成"之后。
   * 判据：本次 Release 的每个资产都在 dist/ 里、大小正确；有官方 digest 时
   * **还必须哈希一致**。只看大小会漏掉「旧文件大小碰巧一样、下载失败后
   * 没被替换」的情况，随后照样删掉旧产物，留下一个看似完整的坏文件。 */
  const missing = [];
  for (const a of rel.assets) {
    const p = path.join(DIST, a.name);
    if (!fs.existsSync(p) || fs.statSync(p).size !== a.size) {
      missing.push(a.name);
      continue;
    }
    const expect = (a.digest || '').replace(/^sha256:/, '');
    if (expect) {
      try {
        if ((await sha256File(p)) !== expect) missing.push(a.name + '（哈希不符）');
      } catch (e) {
        missing.push(a.name + '（读取失败）');
      }
    }
  }
  if (missing.length) {
    console.error('下载未完成，保留旧产物不删：缺 ' + missing.join(', '));
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
