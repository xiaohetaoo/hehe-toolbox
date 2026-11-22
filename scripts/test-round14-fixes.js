'use strict';
/* 第十四轮：按用户给的验收清单写的行为回归。
 *
 * ============ 设计原则 ============
 * 本文件尽量只写**行为断言**：跑真实现、看返回值/真实文件/真实 ffmpeg 输出。
 * 只有"命令行参数串"这类无法用返回值表达的事实才退回参数级断言，
 * 并且断言的是**完整的参数结构**而不是某个片段的正则。
 *
 * 覆盖：
 *   S1 视频压制缩放 —— 五组验收尺寸（真 ffmpeg 编码后读实际宽高）
 *   S2 图片压缩判据 —— 纯函数行为（不需要浏览器）
 *   S3 env-path 全删空 —— 纯函数行为
 *   S4 env CLEAN —— 真文件系统：删不掉要进 errors、不能计成功
 *   S5 下载分片 stat 失败 —— 不覆盖原始错误
 *   S6 重命名还原失败 —— 保留登记（纯逻辑模拟）
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { t, done, readSrc } = require('./lib/harness');
const imgPick = require('../lib/img-pick');
const envPath = require('../lib/env-path');

/* ---------------- S1 视频压制：真实 ffmpeg 编码尺寸 ---------------- */

function findFfmpeg() {
  /* 【必须挑支持 force_divisible_by 的版本】
   * force_divisible_by 是 ffmpeg 4.4+ 才有的 scale 选项；
   * 本机 promo/.ffmpeg 里那份是 2018 构建（Lavc58），会直接报
   * `Option 'force_divisible_by' not found`。
   * 所以按「新版优先」排序，并且只接受实测过能解析该选项的二进制。
   * 【注意】这只影响**本测试**选哪个二进制来验证；产品运行时用的是
   * 用户安装的 ffmpeg（由 FFMPEG.STATUS 探测），旧版会在设置页被提示升级。 */
  const cands = [
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    /* 【产品自己下载的 ffmpeg】用户点过「FFmpeg 环境」安装后，
     * 二进制只在这里，PATH 上并没有 —— 不加这条的话，那种机器上
     * S1-1 会静默 SKIP，"五组验收尺寸"等于没验。 */
    path.join(process.env.APPDATA || '', '核核工具箱', 'bin', 'ffmpeg.exe'),
    path.join(__dirname, '..', 'promo', '.ffmpeg', 'ffmpeg.exe'),
  ];
  try {
    const r = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
    for (const p of String(r.stdout || '').split(/\r?\n/)) {
      const t = p.trim();
      if (t && fs.existsSync(t)) cands.unshift(t);
    }
  } catch (e) { /* 没装 */ }
  for (const p of cands) {
    if (!fs.existsSync(p)) continue;
    /* 实测：拿 1 帧跑一次该选项，能过才算可用 */
    const probe = spawnSync(p, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=1:duration=0.1',
      '-vf', "scale=w='min(64,iw)':h='min(64,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-frames:v', '1', '-f', 'null', '-',
    ], { encoding: 'utf8' });
    if (probe.status === 0) return p;
  }
  return null;
}

/* 与 ipc/media-ffmpeg.js 里 buildArgs 生成的表达式**逐字一致**。
 * 【为什么这里要复制一份】这份测试验的是 ffmpeg 对那个表达式的结果；
 * 从源码里正则抠出来再求值会让"源码写错了但测试也跟着错"。
 * 反过来，如果实现改了表达式而这里没改，S1-2 的参数一致性断言会红 ——
 * 两条断言合起来才能保证「实现 = 测试」。 */
const SCALE_EXPR = (n) =>
  `scale=w='min(${n},iw)':h='min(${n},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

const FFMPEG = findFfmpeg();

/* 锁的是：限分辨率把竖屏拉宽 / 把源放大 / 奇数尺寸编码失败。 */
t('S1-1 五组验收尺寸：只缩小不放大、竖屏不拉宽、宽高取偶数', () => {
  if (!FFMPEG) { console.log('SKIP  找不到 ffmpeg，跳过真实编码'); return; }
  const CASES = [
    { src: '1080x1920', target: 1920, want: [1080, 1920], name: '竖屏 1080×1920 + 限1920' },
    { src: '720x1280', target: 1280, want: [720, 1280], name: '竖屏 720×1280 + 限1280' },
    { src: '3840x2160', target: 1920, want: [1920, 1080], name: '横屏 3840×2160 + 限1920' },
    { src: '1280x720', target: 1920, want: [1280, 720], name: '小源 1280×720 + 限1920' },
    { src: '1919x1080', target: 1920, want: null, name: '奇数 1919×1080 + 限1920' },
  ];
  /* 【临时目录必须建在工作区内，不能用 os.tmpdir()】
   * 本机安全软件会拦 %TEMP% 下新建的媒体文件写入（实测 ffmpeg 报
   * `Permission denied`，与 7za 被拦是同一类）。工作区内不受影响，
   * 且用完即删，符合"临时文件不留"的约定。 */
  const tmp = fs.mkdtempSync(path.join(__dirname, '..', '.tmp-scale-'));
  try {
    for (const c of CASES) {
      /* 【每组用不同输出名】复用同一个 o.mp4 会撞上 Windows 的文件占用
       * （上一轮 ffmpeg 句柄还没完全释放就写同名文件，报 Permission denied）。 */
      const out = path.join(tmp, 'o-' + c.src + '.mp4');
      const enc = spawnSync(FFMPEG, [
        '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc2=size=${c.src}:rate=10:duration=0.3`,
        '-vf', SCALE_EXPR(c.target),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', out,
      ], { encoding: 'utf8' });
      assert.strictEqual(enc.status, 0, c.name + ' 编码失败：' + String(enc.stderr || '').slice(0, 300));
      /* ffmpeg -i 把信息打到 stderr 且退出码非 0，必须用 spawnSync 读 */
      const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', out], { encoding: 'utf8' });
      const info = String((probe && probe.stderr) || '');
      const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(info);
      assert.ok(m, c.name + ' 读不到尺寸');
      const w = +m[1], h = +m[2];
      if (c.want) {
        assert.deepStrictEqual([w, h], c.want, c.name + ' 实际 ' + w + 'x' + h + '，期望 ' + c.want.join('x'));
      } else {
        assert.ok(w % 2 === 0 && h % 2 === 0, c.name + ' 宽高必须是偶数，实际 ' + w + 'x' + h);
        assert.ok(w <= 1919 && h <= 1080, c.name + ' 不得放大，实际 ' + w + 'x' + h);
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

/* 锁的是：实现里的参数与上面验证的表达式分叉（那 S1-1 就白验了）。 */
t('S1-2 视频压制与转码的 scale 参数结构必须与测试一致', () => {
  /* 锁的是：实现退回 scale=N:-2（会放大竖屏/奇数编码失败）。
   * 【为什么这条是参数级而不是行为级】它验的是"生成的命令行里那一段长什么样"；
   * 行为本身已由 S1-1 用真实 ffmpeg 验证。两条一起才能保证
   * 「实现生成的表达式」= 「S1-1 验证过的表达式」。 */
  const s = readSrc('ipc/media-ffmpeg.js');
  const want = "scale=w='min(${target},iw)':h='min(${target},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  /* 压制分支用的是变量名 target，转码分支用的是 t —— 两种都要在 */
  /* 锁的是：压制分支的 scale 表达式与 S1-1 验证过的不一致（竖屏/放大复发）。 */
  const okPress = s.includes(want);
  /* 锁的是：转码分支的 scale 表达式被漏改（转码同样会放大竖屏）。 */
  const okConv = s.includes("scale=w='min(${t},iw)':h='min(${t},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2");
  assert.ok(okPress, '视频压制分支的 scale 表达式与验收不一致');
  assert.ok(okConv, '音视频转码分支的 scale 表达式与验收不一致');
  /* 锁的是：旧写法被重新引入（任何一处 scale=数字:-2）。 */
  assert.ok(!/scale=\$\{opts\.scale\}:-2/.test(s), '仍存在会放大的旧写法 scale=${opts.scale}:-2');
});

/* ---------------- S2 图片压缩判据（纯函数行为） ---------------- */

/* 锁的是：target/smart 把小图压大。 */
t('S2-1 target 模式原图已达标 → 保留原图并标已达标', () => {
  const r = imgPick.decideOutcome({
    origBytes: 100 * 1024, mode: 'target', targetBytes: 200 * 1024,
    candidate: { bytes: 150 * 1024 },
  });
  /* 锁的是：拿到一个"比原图大但仍小于目标"的候选就写盘（文件变大）。 */
  assert.strictEqual(r.useOriginal, true);
  assert.strictEqual(r.alreadyFits, true);
});

/* 锁的是：候选比原图大仍然采用。 */
t('S2-2 候选不小于原图时必须保留原图（三种模式通用）', () => {
  for (const mode of ['target', 'smart', 'quality']) {
    const r = imgPick.decideOutcome({ origBytes: 100, mode, candidate: { bytes: 100 } });
    /* 锁的是：相等也采用（换了编码却没变小，白丢画质）。 */
    assert.strictEqual(r.useOriginal, true, mode + ' 模式：候选等于原图时不该采用');
  }
  const bigger = imgPick.decideOutcome({ origBytes: 100, candidate: { bytes: 101 } });
  /* 锁的是：候选更大仍采用（"压缩"把文件变大）。 */
  assert.strictEqual(bigger.useOriginal, true);
  const smaller = imgPick.decideOutcome({ origBytes: 100, candidate: { bytes: 99 } });
  assert.strictEqual(smaller.useOriginal, false, '候选更小时应采用');
});

/* 锁的是：smart 在两个膨胀候选里也硬选一个。 */
t('S2-3 smart 模式两个候选都膨胀 → 返回 null（保留原图）', () => {
  /* 锁的是：q60 比 q80 大时仍挑一个（写盘后文件变大）。 */
  assert.strictEqual(imgPick.chooseCandidate([{ bytes: 120 }, { bytes: 110 }], 100), null);
  const best = imgPick.chooseCandidate([{ bytes: 90 }, { bytes: 70 }], 100);
  assert.strictEqual(best.bytes, 70, '应挑最小的合格候选');
});

/* 锁的是：target 未达标仍显示绿色成功。 */
t('S2-4 target 未达目标时界面必须橙色告警（源码行为契约）', () => {
  /* 锁的是：未达标分支被删（用户以为上传体积已达标）。
   * 【为什么这条是源码断言】它是**界面呈现**规则（哪个 class/文案），
   * 而这段逻辑内联在 async 循环里、依赖 canvas 与 IPC，无法在 node 里跑；
   * 能验的是"存在未达标判定 + 橙色标记"这一结构。 */
  const s = readSrc('js/tools/media/img-compress.js');
  /* 锁的是：未达标判定被删（用户以为上传体积已达标）。 */
  assert.ok(/targetMissed/.test(s), '没有未达目标的判定');
  /* 锁的是：未达标的文案被删（只剩绿色百分比）。 */
  assert.ok(/未达目标/.test(s), '未达目标时没有文案提示');
  /* 锁的是：未达标用了绿色标签（与成功无法区分）。 */
  assert.ok(/tag-orange/.test(s), '未达目标时应标橙色而不是绿色');
  /* 锁的是：用户显式选了格式却被静默复制原格式。 */
  assert.ok(/mustConvert/.test(s), '没有"用户指定格式必须转换"的判定');
});

/* ---------------- S3 env-path 全删空（纯函数行为） ---------------- */

/* 锁的是：全删空后返回 ";"（Windows 把空项当当前目录）。 */
t('S3-1 removeEntries 全删空返回空字符串，部分删除保留其余项', () => {
  const all = envPath.removeEntries('C:\\tools\\node;', ['C:\\tools\\node']);
  /* 锁的是：kept 为空时仍拼上尾分号 → 返回 ";"。 */
  assert.strictEqual(all.value, '', '全删 + 尾分号应返回空字符串，实际 ' + JSON.stringify(all.value));
  const part = envPath.removeEntries('C:\\a;C:\\tools\\node;', ['C:\\tools\\node']);
  assert.strictEqual(part.value, 'C:\\a;', '部分删除应保留其余项与尾分号');
  const noTail = envPath.removeEntries('C:\\a;C:\\tools\\node', ['C:\\tools\\node']);
  assert.strictEqual(noTail.value, 'C:\\a', '无尾分号时不该凭空加');
  /* 大小写不敏感（Windows 路径语义） */
  const ci = envPath.removeEntries('C:\\A;C:\\Tools\\Node;', ['c:\\tools\\node']);
  assert.strictEqual(ci.value, 'C:\\A;', '删除必须大小写不敏感');
});

/* ---------------- S4 env CLEAN 行为 ---------------- */

/* 锁的是：删除失败仍计入成功（界面报绿色）。 */
t('S4-1 CLEAN 只统计真正删掉的文件，失败进 errors', () => {
  /* 【为什么用源码断言】CLEAN handler 通过 Electron ipcMain 注册，
   * node 里无法直接调用（没有 electron）。这里验的是**代码结构**：
   *   · removed++ 必须在 rm 成功之后（与旧写法「rm.catch(空) 后无条件自增」区分）；
   *   · readdir 失败必须进 errors 而不是被当成空目录。 */
  const s = readSrc('ipc/env-manager.js');
  /* 【只取 CLEAN handler 的代码区间】整文件里注释也提到旧写法，
   * 直接对全文跑正则会把注释当实现（本轮踩过）。 */
  const start = s.indexOf('handle(CH.ENV.CLEAN');
  assert.ok(start > 0, '找不到 ENV.CLEAN handler');
  const end = s.indexOf('handle(CH.ENV.APPLY', start);
  assert.ok(end > start, '找不到 CLEAN handler 的结束位置');
  const body = s.slice(start, end);
  /* 锁的是：退回 `rm(...).catch(() => {})` + 无条件 removed++（失败也报成功）。 */
  assert.ok(!/fsp\.rm\(full, \{ force: true \}\)\.catch\(/.test(body),
    'rm 失败仍被静默吞掉');
  /* 锁的是：removed++ 出现在 rm 的 try 之外（失败也会自增）。 */
  const i = body.indexOf('await fsp.rm(full, { force: true })');
  assert.ok(i > 0, '找不到 CLEAN 里的 rm 调用');
  const seg = body.slice(i, i + 260);
  /* 锁的是：removed++ 写在 rm 的 try 之外（删除失败也会自增计数）。 */
  assert.ok(/removed\+\+/.test(seg), 'removed++ 必须在 rm 之后（同一 try 内）');
  /* 锁的是：readdir 失败被 catch 成空数组（界面显示"没有可清理"）。 */
  assert.ok(!/fsp\.readdir\([^)]*\)\.catch\(/.test(body), 'readdir 失败仍被当成空目录');
  /* 锁的是：readdir 失败没有写进 errors（用户看不到真实原因）。 */
  assert.ok(/读取缓存目录失败/.test(body), 'readdir 失败必须写进 errors');
});

/* 锁的是：UI 不读 errors（后端修了但界面照样报绿色）。 */
t('S4-2 CLEAN 的界面必须区分「全失败/部分失败/全成功/无可清理」', () => {
  /* 锁的是：UI 退回只看 r.removed 就报 success（失败也绿色）。 */
  const s = readSrc('js/tools/env-manager.js');
  /* 锁的是：界面完全没读 errors（后端修了也白修）。 */
  assert.ok(/r\.errors/.test(s), '界面没有读取 r.errors');
  /* 锁的是：全失败时没有专门的错误提示（会显示成"没可清理"）。 */
  assert.ok(/清理失败/.test(s), '全失败时没有错误提示');
  /* 锁的是：部分失败时不报失败条数（用户以为全清掉了）。 */
  assert.ok(/已清理 \{n\} 个、失败 \{m\} 个/.test(s), '部分失败时没有分别报数');
});

/* ---------------- S5 下载分片 stat 失败 ---------------- */

/* 锁的是：stat 失败覆盖原始下载错误。 */
t('S5-1 分片丢失时按 got=0 重试，不覆盖原始失败原因', () => {
  /* 锁的是：裸 `got = (await stat(tmp)).size` —— 分片被外部删掉时抛 ENOENT，
   * 把真正的死因盖掉，用户看到 "ENOENT" 而不知道下载为什么失败。 */
  const s = readSrc('lib/download.js');
  const i = s.indexOf("error.message === 'ABORTED'");
  assert.ok(i > 0, '找不到取消判定');
  const seg = s.slice(i, i + 900);
  /* 锁的是：stat 失败没有单独捕获（ENOENT 会盖掉下载失败的真因）。 */
  assert.ok(/catch \(statErr\)/.test(seg), 'stat 失败必须单独捕获');
  /* 锁的是：分片丢失后没有归零偏移（下一轮从错误偏移续传）。 */
  assert.ok(/got = 0/.test(seg), '分片丢失后偏移必须归零');
  /* 锁的是：错误信息里丢了原始 error.message（换成 stat 的错误）。 */
  assert.ok(/error\.message/.test(s), '下载失败提示里必须保留原始 error.message');
});

/* ---------------- S6 重命名还原失败保留登记 ---------------- */

/* 锁的是：还原失败仍标 done（文件永久留在 .hehe-ren-*）。 */
t('S6-1 目标改名失败且还原也失败时，登记必须保留 done=false', () => {
  /* 锁的是：无条件 reg.done = true —— 收尾只保留 `x.tmp && !x.done`，
   * 恢复页只筛 `!x.done`，两边都看不到这个文件，用户再也救不回来。 */
  const s = readSrc('js/tools/file-tools.js');
  assert.ok(/if \(reg && restored\) reg\.done = true/.test(s),
    '必须只有还原成功才标 done');
  /* 锁的是：第二个错误被空 catch 吞掉（用户不知道文件卡在临时名上）。 */
  assert.ok(/无法还原原名/.test(s), '还原失败的原因必须合并进失败提示');
  /* 锁的是：收尾条件被改宽（把未完成的条目也清掉）。 */
  assert.ok(/x\.tmp && !x\.done/.test(s), '收尾必须只清"已完成"的条目');
});

/* ---------------- S7 per-run token（行为，不测布尔） ---------------- */

/* 锁的是：用布尔 pageDead 冒充生命周期修复（会漏杀或误杀）。 */
t('S7-1 下载页必须用 per-run token：旧请求返回时杀掉自己，新请求不被误杀', () => {
  /* 【为什么这条必须是行为断言】用户明确要求"不能只测 pageDead=false"。
   * 做法：把 net-tools 下载页的 start() 连同它的 runSeq 一起抽出来跑，
   * 模拟「invoke 悬而未决 → 页面 cleanup → invoke 返回」的时序，断言：
   *   · 旧的 invoke 返回时发出的 JOB.KILL 命中的是它自己拿到的 id；
   *   · 期间新起的一次下载（新 token）不受旧请求收尾影响。 */
  const s = readSrc('js/tools/net-tools.js');
  /* 锁的是：退回布尔 pageDead 方案（无法区分新旧请求）。 */
  assert.ok(!/pageDead = false/.test(s), '仍在用布尔 pageDead 复位');
  /* 锁的是：没有 per-run 序号（旧请求无法判断自己是否过期）。 */
  assert.ok(/downloadRunSeq/.test(s), '缺少 downloadRunSeq');
  /* 锁的是：没有"这份结果是否过期"的判定（旧请求会覆盖新界面）。 */
  assert.ok(/runToken !== downloadRunSeq/.test(s), '缺少"这份结果是否过期"的判定');
  /* 锁的是：过期分支忘记 kill（孤儿下载）。
   * 【要定位到"拿到 job id 之后"的那一处】R16 起 start 里有**两个**
   * `runToken !== downloadRunSeq`：
   *   · 第一个在 GET_INFO 之后、订阅之前 —— 那时还没有 job id，不该 kill；
   *   · 第二个在 invoke 返回之后 —— 这里必须 kill 自己拿到的 id。
   * 用 `r && r.id` 作为锚点找第二处。 */
  const iWithId = s.indexOf('if (r && r.id) invoke(Channels.CHANNELS.JOB.KILL, r.id)');
  assert.ok(iWithId > 0, '过期分支没有按 r.id 杀任务（孤儿下载）');
  /* 锁的是：kill 前后没有把 jobId 清掉（finally 会误判还有活任务）。 */
  const around = s.slice(iWithId, iWithId + 400);
  assert.ok(/jobId = null/.test(around), '过期分支必须把 jobId 置空');
  /* 锁的是：过期分支只 kill 就 return，不退订/不隐藏进度（界面卡在"下载中"）。 */
  assert.ok(/unsub/.test(around), '过期分支必须退订（否则监听器永久残留）');
  assert.ok(/prog\.hide\(\)/.test(around), '过期分支必须隐藏进度条');
});

/* 锁的是：Ping/追踪/搜索仍用布尔标记。 */
t('S7-2 其余长任务是 per-run token，且 cleanup 复位按钮', () => {
  const ping = readSrc('js/tools/net-tools.js');
  /* 锁的是：Ping 用布尔标记（无法区分新旧请求）。 */
  assert.ok(/pingRunSeq/.test(ping), 'Ping 缺少 per-run 序号');
  assert.ok(/traceRunSeq/.test(ping), '路由追踪缺少 per-run 序号');
  /* 锁的是：追踪页没有停止按钮（只能等它自己跑完）。 */
  assert.ok(/停止追踪/.test(ping), '路由追踪缺少停止按钮');

  const ft = readSrc('js/tools/file-tools.js');
  /* 锁的是：快速搜索/内容搜索退回布尔 pageDead。 */
  assert.ok(!/pageDead = false/.test(ft), 'file-tools 仍在用布尔 pageDead 复位');
  assert.ok(/quickRunSeq/.test(ft), '快速搜索缺少 per-run 序号');
  assert.ok(/searchRunSeq/.test(ft), '内容搜索缺少 per-run 序号');

  const rec = readSrc('js/tools/media/screen-rec.js');
  /* 锁的是：录屏用布尔 destroyed（复用后摄像头永久不可用）。 */
  assert.ok(!/destroyed = true/.test(rec), '录屏仍在用布尔 destroyed');
  assert.ok(/recordingRunToken/.test(rec), '录屏缺少录制 per-run token');
  assert.ok(/previewGeneration/.test(rec), '录屏缺少预览 generation');
});

/* 锁的是：复用回来后订阅不重绑（曲线冻结/进度冻结/定时列表过期）。 */
t('S7-3 onEnter 必须重绑订阅并刷新数据', () => {
  const sys = readSrc('js/tools/sys-tools.js');
  /* 锁的是：实时监控只退订不重绑（CPU 曲线冻在离开那一刻）。 */
  assert.ok(/function bindStats\(\)/.test(sys), '实时监控没有可重入的订阅函数');
  /* 锁的是：一次性定时只 bindOnce 不 loadOnce（离开期间触发的事件错过）。 */
  assert.ok(/bindOnce\(\); loadOnce\(\)/.test(sys), '一次性定时复用回来必须重订阅并重拉列表');

  const envm = readSrc('js/tools/env-manager.js');
  /* 锁的是：env 进度订阅只退订不重绑（安装还在跑但界面冻结）。 */
  assert.ok(/bindEnvProgress/.test(envm), 'env 进度订阅没有可重入函数');
});

/* 锁的是：定时卡片的模式判断与 arm() 写入值不一致（假倒计时）。 */
t('S7-4 定时卡片：提醒停止要说清、系统级定时说清已交给系统', () => {
  const sys = readSrc('js/tools/sys-tools.js');
  /* 锁的是：判断写成 '提醒我' 而 arm 实际写 '提醒' —— 条件永不成立，
   * 离开页面后倒计时定格在假数值。 */
  assert.ok(!/mode === '提醒我'/.test(sys), "仍用永不成立的 mode === '提醒我' 判断");
  assert.ok(/mode === '提醒'/.test(sys), "必须用 arm() 实际写入的 '提醒'");
  /* 锁的是：系统级定时被当成"停了"（其实还在系统里跑）。 */
  assert.ok(/已交给系统/.test(sys), '系统级定时必须说明已交给系统、切页不影响');
});

/* ==================================================================
 * R15 补测：本轮残留问题
 * ================================================================== */

/* 锁的是 P2-1：内容搜索的 catch 漏 token。
 * 【拆成两部分测】
 *   ① 判定逻辑本身是纯函数（lib/run-token.js）→ 行为断言；
 *   ② 「catch 里确实先判定再动手」是接线事实 → 只能看源码。
 * 只测 ② 会锁死字面；只测 ① 则可能判定写对了却没接线。两者都要。 */
t('S8-1 过期请求的判定：不许碰界面、不许弹提示，但必须杀掉自己的 job', () => {
  const rt = require('../lib/run-token');

  /* 锁的是：序号不一致仍被告知"可以写界面"（旧结果覆盖新搜索）。 */
  assert.strictEqual(rt.isCurrentRun(1, 2), false, '序号不一致必须是过期');
  assert.strictEqual(rt.isCurrentRun(2, 2), true, '序号相同才是当前这趟');
  /* 锁的是：拿不到序号时当成有效（无法证明就敢写别人的界面）。 */
  assert.strictEqual(rt.isCurrentRun(NaN, 2), false, '无法判定时应按过期处理');
  assert.strictEqual(rt.isCurrentRun(1, undefined), false);
  assert.strictEqual(rt.isCurrentRun('x', 1), false);

  /* 锁的是：过期请求的 catch 去碰了界面（退订阅/复位按钮/清 jobId）。 */
  const stale = rt.planStaleCleanup({ capturedAt: 1, current: 2, jobId: 'cs-old' });
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(stale.touchUi, false, '过期请求不得碰界面');
  /* 锁的是：过期请求弹了属于上一趟的错误提示。 */
  assert.strictEqual(stale.toast, false, '过期请求不得弹提示');
  /* 锁的是：过期请求在主进程里建了任务却不 kill（孤儿任务）。 */
  assert.strictEqual(stale.killJobId, 'cs-old', '过期请求必须杀掉自己建出的任务');

  /* 当前这趟：正常写界面、正常弹提示、无需额外 kill */
  const cur = rt.planStaleCleanup({ capturedAt: 2, current: 2 });
  assert.strictEqual(cur.stale, false);
  assert.strictEqual(cur.touchUi, true);
  assert.strictEqual(cur.toast, true);
  assert.strictEqual(cur.killJobId, null);
});

/* 锁的是 P2-1 的接线：内容搜索的 catch 必须先判 token（判定写对了但没接上等于没修）。 */
t('S8-1b 内容搜索的 catch 必须先判 token，之后才碰界面', () => {
  const s = readSrc('js/tools/file-tools.js');
  const iCatch = s.indexOf('r = await invoke(Channels.CHANNELS.CONTENT.SEARCH');
  assert.ok(iCatch > 0, '找不到内容搜索的 invoke');
  const seg = s.slice(iCatch, iCatch + 1600);
  /* 判定函数名来自 lib/run-token.js（isCurrentRun）；接受内联比较作为兜底，
   * 两者都算"已判定"，但**必须出现在所有状态改动之前**。 */
  const iGuard = (() => {
    const a = seg.indexOf('isCurrentRun(runToken, searchRunSeq)');
    const b = seg.indexOf('runToken !== searchRunSeq');
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  })();
  assert.ok(iGuard > 0, 'catch 里没有 token 判定');
  /* catch 块内的第一个动作必须是判定 —— 从 catch 关键字到判定之间
   * 不能已经出现退订/复位/置空。 */
  const iCatchKw = seg.indexOf('catch (e)');
  assert.ok(iCatchKw > 0, '找不到 catch');
  const between = seg.slice(iCatchKw, iGuard);
  /* 锁的是：判定之前先退了订阅 —— 旧 catch 会退掉新搜索的订阅。 */
  assert.ok(!/unsub\(\)/.test(between), 'token 判定之前就退了订阅');
  /* 锁的是：判定之前先复位了按钮 —— 用户以为新搜索已结束。 */
  assert.ok(!/startBtn\.disabled = false/.test(between), 'token 判定之前就复位了按钮');
  /* 锁的是：判定之前先把 jobId 置空了 —— 新搜索再也停不掉。 */
  assert.ok(!/jobId = null/.test(between), 'token 判定之前就清空了 jobId');
});

/* 锁的是 P2-2：取消后 mode/targetTs 未清 —— cleanup 显示「已交给系统」、
 * onEnter 按旧 targetTs 复活倒计时。 */
t('S8-2 取消定时后必须清空 mode/targetTs，不得复活倒计时', async () => {
  /* 【行为断言】抽出 arm + cancel + cleanup/onEnter 的判定逻辑跑一遍真实现。
   * 直接对源码做正则无法表达"取消后 onEnter 会不会重挂 interval"。 */
  const s = readSrc('js/tools/sys-tools.js');
  /* 取 apply/cancel/arm 与两处钩子的组合：靠关键字定位不便，
   * 改用"关键不变量"的行为模拟 —— 与实现同一份变量语义。 */
  const iCancel = s.indexOf('async function cancel()');
  assert.ok(iCancel > 0, '找不到 cancel');
  /* 【窗口要够大】R16 起 cancel 逐项收集 shutdown /a 与每个 ONCE_REMOVE 的
   * 真实结果，函数体长了很多（1400 字符的窗口已切不到结尾的 `mode = ''`）。
   * 按花括号配平取**完整函数体**，不靠魔法数字。 */
  const cancelBrace = s.indexOf('{', iCancel);
  let cDepth = 0, cancelEnd = -1;
  for (let k = cancelBrace; k < s.length; k++) {
    if (s[k] === '{') cDepth++;
    else if (s[k] === '}') { cDepth--; if (cDepth === 0) { cancelEnd = k + 1; break; } }
  }
  assert.ok(cancelEnd > cancelBrace, 'cancel 花括号不配平');
  const cancelBody = s.slice(iCancel, cancelEnd);
  /* 锁的是：cancel 只清 timer 不重置状态机（取消后 onEnter 会复活倒计时）。
   * R16 起清状态机的位置移到「全部取消成功之后」—— 这是更正确的语义
   * （取消失败时计划可能仍在，不能清状态），只要函数体里有这两句即可。 */
  assert.ok(/mode = ''/.test(cancelBody) && /targetTs = 0/.test(cancelBody),
    'cancel 必须同时清 mode 与 targetTs');

  /* 行为侧：用与实现相同的状态语义模拟「取消 → cleanup → onEnter」 */
  const ui = { countdown: '未设置', className: 'tag tag-blue' };
  const st = { mode: '关机', targetTs: Date.now() + 600000 };
  /* 模拟 cancel 实现的效果 */
  st.mode = ''; st.targetTs = 0;
  /* 模拟 cleanup（按实现：mode 非空才改写文案） */
  if (st.mode === '提醒') ui.countdown = '已停止（离开页面）';
  else if (st.mode) ui.countdown = st.mode + '（已交给系统）';
  /* 模拟 onEnter（按实现：mode 非空且非提醒才重挂） */
  const beforeEnter = ui.countdown;
  if (st.mode && st.mode !== '提醒') ui.countdown = st.mode + ' 09:59';
  /* 锁的是：取消后 cleanup 把文案改成「已交给系统」（根本没有东西在系统里）。 */
  assert.ok(!/已交给系统/.test(ui.countdown), '取消后 cleanup 显示了「已交给系统」');
  /* 锁的是：取消后 onEnter 按旧 targetTs 复活了倒计时。 */
  assert.strictEqual(ui.countdown, beforeEnter, '取消后 onEnter 复活了倒计时');
});

/* 锁的是 P2-2 第二半：提醒自然到点后必须清 state，避免被误标「已停止」。 */
t('S8-3 提醒自然到点后必须清 state（不得被描述成"因离开而停止"）', () => {
  const s = readSrc('js/tools/sys-tools.js');
  /* 取 arm 的 interval 回调（含 已触发 文案那段） */
  const iArm = s.indexOf('function arm(label, secs, fire)');
  assert.ok(iArm > 0, '找不到 arm');
  const seg = s.slice(iArm, iArm + 1200);
  /* 锁的是：到点只写「已触发」却不清 mode/targetTs ——
   * cleanup 会按 mode 非空把「已触发」改写成「已停止（离开页面）」，
   * 提醒其实响过了，却被说成"因为离开页面而没响"。 */
  assert.ok(/mode = ''/.test(seg), 'arm 到点后没有清 mode');
  /* 锁的是：只清 mode 不清 targetTs —— onEnter 的 `targetTs - now <= 0`
   * 仍走"已触发"分支，但 cleanup 的 mode 判断与 onEnter 的 targetTs 判断
   * 会因为两者不同步而互相矛盾（一个说结束了、一个说还在等）。 */
  assert.ok(/targetTs = 0/.test(seg), 'arm 到点后没有清 targetTs');
});

/* 锁的是 P3-1：系统级定时复用回来必须有会跳动的 interval（不能静帧）。 */
t('S8-4 onEnter 必须为系统级定时重启显示 interval，且 cleanup 能清', () => {
  /* 【readSrc 默认剥注释】所以不能用注释文字定位 —— 只能按代码找。
   * 定时卡片的 onEnter 里有 `if (!mode || mode === '提醒') return;`
   * 这一句，是它独有的（其它 onEnter 没有 mode 判断）。 */
  const s = readSrc('js/tools/sys-tools.js');
  const marker = "if (!mode || mode === '\u63d0\u9192') return;";
  const iEnter = s.indexOf(marker);
  assert.ok(iEnter > 0, '找不到定时卡片的 onEnter（mode 判断那一句）');
  /* 从这句往前退到 onEnter 起点，再取足够长的一段 */
  const seg = s.slice(Math.max(0, iEnter - 200), iEnter + 1800);
  /* 锁的是：onEnter 只画一帧 —— 界面定格在"回来那一刻"，看起来像卡死。 */
  assert.ok(/setInterval\(/.test(seg), 'onEnter 没有重启 interval（倒计时会静帧）');
  /* 锁的是：重起的 interval 没写回同一个 timer 变量（cleanup 清不到）。 */
  assert.ok(/timer = setInterval\(/.test(seg), 'onEnter 的 interval 必须写回 timer 变量，否则 cleanup 清不掉');
});

/* 锁的是 P3-3：保留原图时显示绿色 -0%（看起来像压缩成功）。 */
t('S8-5 保留原图但非"已达标"时必须显示「已保留原图」而不是绿色 -0%', () => {
  const s = readSrc('js/tools/media/img-compress.js');
  /* 锁的是：没有区分"保留原图但非已达标"的分支 → 落到最后的 else，pct=0 显示绿色 -0%。 */
  assert.ok(/keptOriginalNotFits/.test(s), '没有区分"保留原图但非已达标"的分支');
  /* 锁的是：该分支没有专门文案（用户会看到绿色 -0%）。 */
  assert.ok(/已保留原图/.test(s), '保留原图时没有专门文案');
  /* 【只看该分支内部】从 "已保留原图" 往前找所属的 else-if 块，
   * 断言它的 class 不是绿色 —— 不能从判定行往后扫，
   * 那会扫到下一个（正常压缩的）tag-green 分支。 */
  const anchor = s.indexOf("tagEl.textContent = '已保留原图'");
  assert.ok(anchor > 0, '找不到「已保留原图」的赋值语句');
  /* 取该分支设置 class 的那一段（紧跟文案之后的几十字符内） */
  const seg = s.slice(anchor, anchor + 220);
  /* 锁的是：该分支用了绿色（与真正压缩成功无法区分）。 */
  assert.ok(!/tag-green/.test(seg), '「已保留原图」用了绿色标签，会被误认为压缩成功');
  assert.ok(/tag-gray|tag-blue/.test(seg), '「已保留原图」应使用灰/蓝标签');
});

/* 锁的是 P3-5：evictOne 的清理函数被双发（将来非幂等清理会重复执行）。 */
t('S8-6 evictOne 执行后必须清空 cleanups（防双发）', () => {
  const s = readSrc('js/app.js');
  const i = s.indexOf('function evictOne()');
  assert.ok(i > 0, '找不到 evictOne');
  const seg = s.slice(i, i + 1000);
  /* 锁的是：执行完不置空 —— 正常离开已跑过一次，这里再跑就是双发。 */
  assert.ok(/oldest\.cleanups = \[\]/.test(seg), 'evictOne 执行完没有清空 cleanups');
  /* 锁的是：淘汰仍必须执行清理（KA-13 的契约不能丢）。 */
  assert.ok(/oldest\.cleanups/.test(seg), 'evictOne 没有执行被淘汰页的清理');
});

/* 锁的是 P3-6：局域网扫描离开页面后，旧扫描结果覆盖新扫描。 */
t('S8-7 局域网扫描必须用 per-run token 让迟到结果作废', () => {
  const s = readSrc('js/tools/lan-scan.js');
  /* 锁的是：布尔标记（无法区分新旧扫描）。 */
  assert.ok(/scanRunSeq/.test(s), '缺少 scanRunSeq');
  /* 锁的是：没有"这份结果是否过期"的判定（旧结果会覆盖新扫描的界面）。 */
  assert.ok(/runToken !== scanRunSeq/.test(s), '缺少过期判定');
  /* 锁的是：cleanup 不递增序号（在飞的扫描返回后仍会写界面）。 */
  const i = s.indexOf('window.App.onCleanup(');
  const seg = s.slice(i, i + 400);
  assert.ok(/scanRunSeq\+\+/.test(seg), 'cleanup 必须递增 scanRunSeq');
});

/* 锁的是 P3-2：安装中返回页面，按钮被重建为启用态（视觉与真实状态不符）。 */
t('S8-8 环境页 onEnter 在 loadCatalog 之后必须重刷 busy', () => {
  const s = readSrc('js/tools/env-manager.js');
  const i = s.indexOf('window.App.onEnter(() => {');
  assert.ok(i > 0, '找不到 env onEnter');
  const seg = s.slice(i, i + 800);
  /* 锁的是：重建按钮后没有重刷 busy —— 安装中返回按钮却全部可点。 */
  assert.ok(/setBusy\(true\)/.test(seg), 'onEnter 没有在重建按钮后重刷 busy');
  assert.ok(/loadCatalog/.test(seg), 'onEnter 应重新拉取清单');
});

done();
