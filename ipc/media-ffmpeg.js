'use strict';
/* 媒体与 FFmpeg 的两个 IPC 域：
 *   · ffmpeg:* / target:*  —— FFmpeg 环境检测与下载、音视频转码压缩
 *   · rec:*                —— 屏幕录制（gdigrab，区域/声音/暂停分段/GIF）
 *
 * ============ 为什么这两个域放在同一个文件里 ============
 * 录制域**直接用 ffmpeg**：listDshowDevices / recSpawnSeg / recStartSeg 都调
 * findFfmpeg()，录完转 GIF 走同一套 runCmd 与参数拼装。
 * 拆成 ipc/ffmpeg.js + ipc/rec.js 的话，每一次录制调用都要跨模块取 ffmpeg
 * 路径查找，把「录制依赖 ffmpeg」这条本来很清楚的依赖变成两处维护。
 * 所以按**真实依赖**组织，与 ipc/dir-acl-links.js 的处理方式一致。
 *
 * ============ 搬迁原则：逐字搬，只改依赖表达方式 ============
 * 函数体与 handler 体原样来自 main.js（任务 6，947 行），**没有改任何语义**。
 * 只做了三类机械替换 + 注入：
 *   · `++jobSeq`            → `ctx.nextJobSeq()`
 *     （原来靠闭包自增 main.js 的计数器；ctx 的那一项委托回同一个变量，
 *      所以序号序列与搬走前完全一致）
 *   · `latestCancelable = X` → `setLatestCancelable(X)`
 *     （该变量只写不读，main.js 保留它并在注释里说明将来可能加「一键取消全部」）
 *   · `app.getPath('temp' | 'userData')` → `tempDir()` / `userDataDir()`
 *     （app 只能在 Electron 主进程里取，由 main.js 注入）
 * 其余一律靠 deps 注入，见下方形参说明。
 *
 * 【为什么 deps 有这么多项，而不是让模块自己 require】
 * handle 带着统一的高危门禁与结构化错误包装（CAP_GATED_CHANNELS 在 main.js
 * 的包装层里执行）。搬出去后必须仍走同一个包装 —— 否则渲染层可以直接
 * invoke 绕过门禁，而那正是这个项目最不能破的一条。
 * runCmd 的「非零不抛」语义被几十处依赖，pathExists 的容错分支也一样，
 * 都不能复制第二份。
 *
 * ============ 搬完之后 main.js 里留下了什么 ============
 * 只留下 register(ctx, deps) 这一次调用（与 dir-acl-links 同一形态）。
 * scripts/test-ipc-split.js 守着「搬出去的代码不直接引用 win / send / jobSeq」
 * 这条不变量；scripts/test-ipc-channels.js 守着通道总数。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
/* dialog 只在 ffmpeg:pick 里用（选 ffmpeg.exe / ffprobe.exe）。
 * 它是 Electron 主进程 API，必须在主进程侧 require。 */
const { dialog } = require('electron');
const CH = require('../lib/channels').CHANNELS;   // IPC 通道名唯一来源

/**
 * @param {object} ctx  见 ipc/ctx.js（win / jobs / isWin / send / nextJobSeq）
 * @param {object} deps 由 main.js 注入
 * @param {Function} deps.handle         带门禁与错误包装的 ipcMain.handle 包装
 * @param {Function} deps.runCmd         跑命令（非零不抛）
 * @param {Function} deps.pathExists
 * @param {Function} deps.fmtErr
 * @param {Function} deps.storeGet
 * @param {Function} deps.storeSet
 * @param {Function} deps.moveFile
 * @param {Function} deps.uniqueTarget
 * @param {Function} deps.setLatestCancelable  等价于搬走前的 `latestCancelable = X`
 * @param {Function} deps.tempDir        等价于 app.getPath('temp')
 * @param {Function} deps.userDataDir    等价于 app.getPath('userData')
 * @param {object}   deps.pathGuard      lib/path-guard
 * @param {object}   deps.tempNames      lib/temp-names
 * @param {object}   deps.targetSize     lib/target-size
 * @param {new (p?: string) => {getEntries: Function, extractEntryTo: Function}} deps.AdmZip
 *                                      adm-zip 的构造函数（用 new 调用）
 * @param {Function} deps.downloadToFile  通用断点续传下载器（定义在 main.js，
 *                                       net:download 与 ffmpeg:download 共用）
 * @returns {void} 全部 IPC 都在这里就地注册，没有返回值
 */
module.exports = function register(ctx, deps) {
  const {
    handle, runCmd, pathExists, fmtErr,
    storeGet, storeSet, moveFile, uniqueTarget, setLatestCancelable,
    tempDir, userDataDir, pathGuard, tempNames, targetSize, AdmZip, downloadToFile,
  } = deps;

  const { win, jobs, isWin, send } = ctx;


  /* ======================= 以下为逐字搬来的实现 ======================= */

/* ================= IPC: ffmpeg 环境与音视频处理 ================= */
function binDir() { return path.join(userDataDir(), 'bin'); }
function findFfmpeg() {
  const custom = storeGet('settings.ffmpegPath', null);
  if (custom && fs.existsSync(custom)) return custom;
  if (fs.existsSync(path.join(binDir(), 'ffmpeg.exe'))) return path.join(binDir(), 'ffmpeg.exe');
  try {
    const r = spawnSync('where', ['ffmpeg'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const p = (r.stdout || '').split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('ffmpeg.exe'));
    if (p) return p.trim();
  } catch (e) {}
  return null;
}
function findFfprobe() {
  const custom = storeGet('settings.ffprobePath', null);
  if (custom && fs.existsSync(custom)) return custom;
  const ff = findFfmpeg(); // 只探测一次，避免 PATH-only 环境下重复 where
  const sameDir = ff && path.join(path.dirname(ff), 'ffprobe.exe');
  if (sameDir && fs.existsSync(sameDir)) return sameDir;
  if (fs.existsSync(path.join(binDir(), 'ffprobe.exe'))) return path.join(binDir(), 'ffprobe.exe');
  try {
    const r = spawnSync('where', ['ffprobe'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const p = (r.stdout || '').split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('ffprobe.exe'));
    if (p) return p.trim();
  } catch (e) {}
  return null;
}
handle(CH.FFMPEG.STATUS, async () => {
  const ffmpeg = findFfmpeg(), ffprobe = findFfprobe();
  let version = null;
  if (ffmpeg) {
    try { version = ((await runCmd(ffmpeg, ['-version'], { timeout: 8000 })).stdout || '').split(/\r?\n/)[0]; } catch (e) {}
  }
  return { ffmpeg, ffprobe, binDir: binDir(), version };
});
handle(CH.FFMPEG.PICK, async (e) => {
  const picked = await dialog.showOpenDialog(win, {
    title: '选择 ffmpeg.exe（可多选，同时选上 ffprobe.exe）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '可执行文件', extensions: ['exe'] }]
  });
  if (picked.canceled || !picked.filePaths.length) return { picked: [] };
  await fsp.mkdir(binDir(), { recursive: true });
  const copied = [];
  for (const src of picked.filePaths) {
    const name = path.basename(src).toLowerCase();
    if (name === 'ffmpeg.exe' || name === 'ffprobe.exe') {
      await fsp.copyFile(src, path.join(binDir(), name));
      copied.push(name);
    }
  }
  if (!copied.includes('ffmpeg.exe')) {
    /* 用户可能把 ffmpeg 存成了别的名字（如 ffmpeg-6.1.exe）。
     * 【判据必须是「输出里真的有 ffmpeg version」，不能只看进程能不能跑】
     * 原实现是 `await runCmd(first, ['-version'])` —— runCmd 默认对非零退出码
     * 不抛异常，而且任何程序响应 -version 都能"成功"，于是用户在同一个对话框里
     * 先选了 ffprobe.exe（或随便一个会打印版本号的 exe）且没有任何一项 basename
     * 恰好是 ffmpeg.exe 时，那个文件会被复制成 bin/ffmpeg.exe，
     * **覆盖掉原本可用的 ffmpeg**。之后所有转码全部失败，且用户不知道是这一步造成的。
     * 现在：① 要求退出码为 0；② 要求 stdout/stderr 里出现 'ffmpeg version'；
     * ③ 已经在 bin 里有可用 ffmpeg 时不覆盖，只提示。 */
    const first = picked.filePaths[0];
    try {
      const r = await runCmd(first, ['-version'], { timeout: 8000, throwOnNonZero: true });
      const ver = String(r.stdout || '') + String(r.stderr || '');
      if (!/ffmpeg version/i.test(ver)) throw new Error('输出里没有 ffmpeg version，不是 ffmpeg');
      const dest = path.join(binDir(), 'ffmpeg.exe');
      if (fs.existsSync(dest)) {
        const old = await runCmd(dest, ['-version'], { timeout: 8000 }).catch(() => null);
        if (old && /ffmpeg version/i.test(String(old.stdout || ''))) {
          // 已有可用的 ffmpeg，不覆盖：静默替换是破坏性的，且用户没要求
          return { picked: copied, binDir: binDir(), skipped: '已有可用的 ffmpeg，未覆盖' };
        }
      }
      await fsp.copyFile(first, dest);
      copied.push('ffmpeg.exe');
    } catch (err) { /* 不是 ffmpeg：保持原状，不复制 */ }
  }
  return { picked: copied, binDir: binDir() };
});
const FFMPEG_SOURCES = {
  npmmirror: { name: 'npmmirror 国内镜像（推荐，约 59MB，含 ffprobe）', type: 'gz-pair', base: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1' },
  gyan: { name: 'gyan.dev 官方整合包（约 114MB，含 ffprobe）', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', type: 'zip' },
  btbn: { name: 'BtbN GitHub 构建（约 90MB，含 ffprobe）', url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', type: 'zip' }
};

handle(CH.FFMPEG.DOWNLOAD, async (e, sourceId) => {
  const src = FFMPEG_SOURCES[sourceId] || FFMPEG_SOURCES.npmmirror;
  const id = 'dl' + (ctx.nextJobSeq());
  const ctrl = new AbortController();
  jobs.set(id, { cancel: () => ctrl.abort() });
  setLatestCancelable(() => ctrl.abort());
  await fsp.mkdir(binDir(), { recursive: true });
  try {
    if (src.type === 'gz-pair') {
      const files = [['ffmpeg-win32-x64.gz', 'ffmpeg.exe'], ['ffprobe-win32-x64.gz', 'ffprobe.exe']];
      let idx = 0;
      for (const [gzName, exeName] of files) {
        idx++;
        const tmp = path.join(tempDir(), 'hehe-' + gzName);
        const emitLabel = () => send('job:stream', { id, data: JSON.stringify({ stage: 'label', label: `文件 ${idx}/2：${exeName}` }) });
        emitLabel();
        await downloadToFile(src.base + '/' + gzName, tmp, id, ctrl, `文件 ${idx}/2：${exeName}`);
        send('job:stream', { id, data: JSON.stringify({ stage: 'extract', label: `解压 ${exeName}` }) });
        const gz = fs.readFileSync(tmp);
        const out = zlib.gunzipSync(gz);
        fs.writeFileSync(path.join(binDir(), exeName), out);
        fs.rmSync(tmp, { force: true });
      }
      const ffmpeg = findFfmpeg();
      send('job:stream', { id, data: JSON.stringify({ stage: 'done' }) });
      return { ok: true, ffmpeg, ffprobe: findFfprobe(), found: 2 };
    }
    // zip 整合包
    const zipPath = tempNames.ffmpegZip({ tempDir: tempDir() });
    try {
      await downloadToFile(src.url, zipPath, id, ctrl, '整合包');
      send('job:stream', { id, data: JSON.stringify({ stage: 'extract' }) });
      const zip = new AdmZip(zipPath);
      let found = 0;
      for (const entry of zip.getEntries()) {
        const n = entry.entryName.replace(/\\/g, '/');
        if (n.endsWith('/ffmpeg.exe') || n.endsWith('/ffprobe.exe')) {
          zip.extractEntryTo(entry, binDir(), false, true);
          found++;
        }
      }
      if (!found) throw new Error('压缩包中未找到 ffmpeg.exe / ffprobe.exe');
      const ffmpeg = findFfmpeg();
      send('job:stream', { id, data: JSON.stringify({ stage: 'done' }) });
      return { ok: true, ffmpeg, ffprobe: findFfprobe(), found };
    } finally { await fsp.rm(zipPath, { force: true }).catch(() => {}); }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('下载已取消');
    throw err;
  } finally { jobs.delete(id); }
});
handle(CH.FFMPEG.REMOVE, async () => {
  await fsp.rm(binDir(), { recursive: true, force: true });
  storeSet('settings.ffmpegPath', undefined);
  storeSet('settings.ffprobePath', undefined);
  return true;
});
handle(CH.FFMPEG.PROBE, async (e, p) => {
  const ffprobe = findFfprobe();
  if (!ffprobe) throw new Error('未找到 ffprobe，请先在「FFmpeg 环境」中安装');
  const r = await runCmd(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p], { timeout: 30000 });
  return JSON.parse(r.stdout);
});

/* ================= IPC: 目标体积压缩（音视频） =================
 * 借鉴 YourCatFileAssistant 的核心设计：不是"压一次看运气"，而是
 * 最多 8 轮候选输出，每轮按实际结果调整码率，达标才提交。
 * 关键约束（与对方一致）：
 *   - 绝不截断时长、绝不删音轨来凑体积
 *   - 每轮输出先写到任务专属临时文件，体积检查通过后才改名
 *   - 源文件本来就达标时直接另存并标注「已符合上限」
 *   - 进度最多 99%，提交成功才 100%
 */
handle(CH.TARGET.COMPRESS_AV, async (e, { items, outDir, targetBytes, mode, ratio }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  const ffprobe = findFfprobe();
  const id = 'tgt' + (ctx.nextJobSeq());
  const state = { cancel: false, proc: null };
  const killProc = () => {
    try { state.proc && state.proc.kill && state.proc.kill(); } catch (err) {}
    if (isWin && state.proc && state.proc.pid) spawn('taskkill', ['/pid', String(state.proc.pid), '/t', '/f'], { windowsHide: true });
  };
  jobs.set(id, { cancel: () => { state.cancel = true; killProc(); } });
  setLatestCancelable(() => { state.cancel = true; killProc(); });

  await fsp.mkdir(outDir, { recursive: true });
  const results = [];

  /* 读时长与音轨信息。时长拿不到就无法按体积反推码率，直接给出可读失败。 */
  async function probeMedia(p) {
    if (!ffprobe) return { duration: 0, hasAudio: false, width: 0, height: 0 };
    try {
      const r = await runCmd(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p], { timeout: 30000 });
      const j = JSON.parse(r.stdout);
      const v = (j.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
      const a = (j.streams || []).find(s => s.codec_type === 'audio');
      return {
        duration: parseFloat((j.format || {}).duration) || (v && parseFloat(v.duration)) || 0,
        hasAudio: !!a,
        width: v ? v.width : 0,
        height: v ? v.height : 0
      };
    } catch (err) { return { duration: 0, hasAudio: false, width: 0, height: 0 }; }
  }

  try {
    for (let i = 0; i < items.length; i++) {
      if (state.cancel) break;
      const input = items[i];
      /* 【单个文件读不到不能中断整批】
       * 批量压缩时用户很可能在资源管理器里删/改队列里的文件。原实现直接
       * `await fsp.stat(input)`，ENOENT 一路冒到外层 finally —— 整批中断，
       * 而函数是「抛异常」而不是「返回 results」，前面已经压好的若干条记录
       * 随返回值一起消失，用户既拿不到成果清单，也不知道哪几个已完成。
       * 这里降级成「这一条失败，记下来，继续下一个」。 */
      let srcSize = 0;
      try {
        srcSize = (await fsp.stat(input)).size;
      } catch (err) {
        results.push({ input, out: null, ok: false, srcSize: 0, target: 0, err: '无法读取源文件：' + fmtErr(err) });
        send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(String(input || '')), pct: 100, done: true, ok: false, error: '无法读取源文件' }) });
        continue;
      }
      const want = mode === 'ratio'
        ? targetSize.tierTargetBytes(srcSize, ratio)
        : Math.floor(targetBytes);
      const base = path.basename(input).replace(/\.[^.]+$/, '');

      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), stage: 'probe', pct: 1 }) });

      /* 源文件本来就达标：直接另存一份，标「已符合上限」。
         这是对方明确处理的场景 —— 用户的文件本来就够小，不该被重编码白白降低画质。 */
      if (srcSize <= want) {
        const dst = await uniqueTarget(outDir, base + path.extname(input));
        await fsp.copyFile(input, dst);
        results.push({ input, out: dst, ok: true, srcSize, outSize: srcSize, target: want, alreadyFits: true, rounds: 0 });
        send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok: true, alreadyFits: true }) });
        continue;
      }

      const media = await probeMedia(input);
      if (!(media.duration > 0)) {
        results.push({ input, out: null, ok: false, srcSize, target: want, err: '无法获取媒体时长，无法按体积反推码率' });
        send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok: false }) });
        continue;
      }

      const tmpDir = tempNames.tgtTmpDir({ tempDir: tempDir() });
      await fsp.mkdir(tmpDir, { recursive: true });
      let finalOut = null;
      let lastErr = '';
      let usedRounds = 0;
      /* 两遍法的 stats 文件：**每个输入文件只分析一次**，8 轮逼近全部复用。
       * passlog 记录的是帧复杂度，与 -b:v 目标值无关，换码率无需重新分析。
       * 路径统一成正斜杠：ffmpeg 在 Windows 上对 -passlogfile 的反斜杠转义处理
       * 不一致，曾出现 stats 写到奇怪位置、pass 2 读不到而静默降级。 */
      const passlogFile = path.join(tmpDir, 'x264pass').replace(/\\/g, '/');
      let pass1Done = false;

      try {
        /* ---- 两遍法：分析趟只做一次，8 轮逼近全部复用同一份 stats ----
         * 单遍 ABR 实际输出常偏离目标 10%~30%；两遍法按帧复杂度精确分配码率，
         * 实测把「3.09MB → 15% 目标」从 5 轮降到 2 轮。
         * 分析失败（老版本 ffmpeg、异常退出）时自动回退单遍，不影响功能。 */
        const progressOf = (round, inRound) => Math.min(99, ((i + (round + inRound) / targetSize.MAX_ROUNDS) / items.length) * 100);
        const runFfmpeg = (args, round) => new Promise((resolve) => {
          const proc = spawn(ffmpeg, args, { windowsHide: true });
          state.proc = proc;
          let buf = '', errOut = '';
          proc.stdout.on('data', (d) => {
            buf += String(d);
            const lines = buf.split('\n'); buf = lines.pop() || '';
            for (const line of lines) {
              const m = line.match(/out_time_us=(\d+)/);
              if (m && media.duration > 0) {
                const inRound = Math.min(1, parseInt(m[1]) / 1e6 / media.duration);
                send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: progressOf(round, inRound), round: round + 1 }) });
              }
            }
          });
          proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 20000) errOut = errOut.slice(-8000); });
          proc.on('exit', (code) => resolve({ code, errOut }));
          proc.on('error', (err) => resolve({ code: -1, errOut: err.message }));
        });

        const plan0 = targetSize.planBitrates({
          targetBytes: want, durationSec: media.duration,
          hasAudio: media.hasAudio, round: 0
        });
        if (plan0.ok) {
          send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), stage: 'analyze', pct: 0 }) });
          const p1 = await runFfmpeg(targetSize.buildPass1Args({
            input, videoKbps: plan0.videoKbps, passlogFile
          }), 0);
          if (p1.code === 0 && fs.existsSync(passlogFile + '-0.log')) pass1Done = true;
        }
        if (state.cancel) lastErr = '已取消';

        for (let round = 0; round < targetSize.MAX_ROUNDS; round++) {
          usedRounds = round + 1;
          if (state.cancel) break;

          const plan = targetSize.planBitrates({
            targetBytes: want, durationSec: media.duration,
            hasAudio: media.hasAudio, round
          });
          if (!plan.ok) { lastErr = plan.reason; break; }

          const cand = path.join(tmpDir, `r${round}.mp4`);
          // 两遍法：读 pass 1 的 stats 精确分配码率；分析没成功就退回单遍
          const args = pass1Done
            ? targetSize.buildPass2Args({
                input, output: cand, videoKbps: plan.videoKbps,
                audioKbps: plan.audioKbps, hasAudio: media.hasAudio, passlogFile
              })
            : targetSize.buildSinglePassArgs({
                input, output: cand, videoKbps: plan.videoKbps,
                audioKbps: plan.audioKbps, hasAudio: media.hasAudio
              });

          const r = await runFfmpeg(args, round);

          if (state.cancel) { lastErr = '已取消'; break; }
          if (r.code !== 0) {
            lastErr = r.errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ') || ('退出码 ' + r.code);
            break;
          }
          let outBytes = 0;
          try { outBytes = (await fsp.stat(cand)).size; } catch (err) {}
          const verdict = targetSize.evaluateRound({ outBytes, targetBytes: want, round });
          if (verdict.ok) { finalOut = { file: cand, size: outBytes }; break; }
          if (verdict.done) { lastErr = verdict.reason; break; }
          try { await fsp.unlink(cand); } catch (err) {} // 未达标候选立刻删掉，省磁盘
        }

        if (finalOut) {
          /* 校验通过才提交：改成最终名（同名自动编号，不覆盖已有文件）。
           * 【跨卷必须退回「复制 + 删除」】临时目录在 %TEMP%（通常 C:），
           * 而输出目录完全可能被用户选到 D:/E:。Windows 上 rename 跨卷
           * 抛 EXDEV —— 八轮编码全部达标、成果就在 finalOut，却在最后一步
           * 失败，异常冒泡让 results 里连一条记录都没有，而 finally 还会把
           * tmpDir 整个删掉（成果一起没了）。项目在 7z 解压那边已经为同一个
           * EXDEV 坑写过注释，这里是同一类问题。 */
          const dst = await uniqueTarget(outDir, base + '.mp4');
          await moveFile(finalOut.file, dst);
          results.push({ input, out: dst, ok: true, srcSize, outSize: finalOut.size, target: want, rounds: usedRounds });
          send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok: true }) });
        } else {
          results.push({ input, out: null, ok: false, srcSize, target: want, rounds: usedRounds, err: lastErr || '未能压到目标体积' });
          send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok: false }) });
        }
      } finally {
        // 只清理自己的临时目录；已提交的最终文件不在其中
        try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (err) {}
      }
    }
  } finally { jobs.delete(id); }
  return { id, results, canceled: state.cancel };
});

/* 图片的目标体积压缩：按质量与尺寸双维度多轮逼近。
 * 与音视频不同，图片编码在渲染进程用 canvas 完成（已有链路），
 * 主进程只负责规划每轮参数与判定体积，实际重编码由渲染层完成。 */
handle(CH.TARGET.PLAN_IMAGE, (e, { round }) => {
  const q = targetSize.planImageQuality(round);
  return { quality: q.quality, scale: q.scale, round, maxRounds: targetSize.MAX_ROUNDS };
});
handle(CH.TARGET.EVAL_IMAGE, (e, { outBytes, targetBytes, round }) => {
  return targetSize.evaluateRound({ outBytes, targetBytes, round });
});

handle(CH.FFMPEG.CONVERT, async (e, { items, outDir, opts }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  const id = 'avc' + (ctx.nextJobSeq());
  const state = { cancel: false, proc: null };
  jobs.set(id, { cancel: () => { state.cancel = true; try { state.proc && state.proc.kill && state.proc.kill(); } catch (err) {} if (isWin && state.proc && state.proc.pid) spawn('taskkill', ['/pid', String(state.proc.pid), '/t', '/f'], { windowsHide: true }); } });
  setLatestCancelable(() => { state.cancel = true; try { if (isWin && state.proc && state.proc.pid) spawn('taskkill', ['/pid', String(state.proc.pid), '/t', '/f'], { windowsHide: true }); } catch (err) {} });
  const extMap = { mp4: 'mp4', webm: 'webm', mkv: 'mkv', mp3: 'mp3', wav: 'wav', flac: 'flac', gif: 'gif', m4a: 'm4a' };
  await fsp.mkdir(outDir, { recursive: true });
  const results = [];
  try {
    for (let i = 0; i < items.length; i++) {
      if (state.cancel) break;
      const input = items[i];
      const base = path.basename(input).replace(/\.[^.]+$/, '');
      const ext = extMap[opts.format] || 'mp4';
      let out = path.join(outDir, `${base}.${ext}`);
      for (let k = 1; await pathExists(out); k++) out = path.join(outDir, `${base}(${k}).${ext}`);
      let dur = 0;
      try {
        const ffprobe = findFfprobe();
        if (ffprobe) {
          const r = await runCmd(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input], { timeout: 15000 });
          dur = parseFloat((JSON.parse(r.stdout).format || {}).duration) || 0;
        }
      } catch (err) {}
      const args = ['-hide_banner', '-y', '-nostats'];
      if (opts.ss) args.push('-ss', String(opts.ss));
      args.push('-i', input);
      if (opts.to) args.push('-t', String(opts.to));
      /* 【纯音频容器必须先算出来，不能只列 mp3/m4a】
       * 下面 3180 行用 isAudioOut 判断「不加 -c:v」，包含 wav/flac；
       * 而这一行的 -vn 列表只有 mp3/m4a/mute —— 于是选 WAV/FLAC 且没勾静音时，
       * 既不 -vn（视频流还在）也不 -c:v（没有视频编码器），ffmpeg 试图把
       * 源视频流塞进 wav 容器 → 直接失败；失败分支还会 rm(out) 删掉半成品，
       * 用户只看到「转换失败」，看不到真正原因。
       * 统一用同一个判据，避免两份列表各写各的。 */
      const isAudioOut = ['mp3', 'm4a', 'wav', 'flac'].includes(opts.format);
      if (isAudioOut || opts.mute) args.push('-vn');
      if (opts.mute) { args.push('-an'); }
      else {
        // 音频编码按容器选择：wav→PCM、flac→无损 flac（aac 进这两个容器会被拒绝/非标）
        const ac = opts.acodec || (opts.format === 'webm' ? 'libopus' : opts.format === 'mp3' ? 'libmp3lame' : opts.format === 'wav' ? 'pcm_s16le' : opts.format === 'flac' ? 'flac' : 'aac');
        args.push('-c:a', ac);
        if (ac === 'aac') args.push('-b:a', '160k');
        if (ac === 'libmp3lame') args.push('-q:a', '2');
        if (ac === 'libopus') args.push('-b:a', '128k');
      }
      if (!isAudioOut) {
        if (opts.vcodec === 'copy') args.push('-c:v', 'copy');
        else if (opts.format === 'webm') { args.push('-c:v', 'libvpx-vp9', '-crf', String(opts.crf || 34), '-b:v', '0', '-row-mt', '1'); }
        else if (opts.format === 'gif') { args.push('-an', '-vf', `fps=${opts.fps || 12},scale=${opts.gifWidth || 480}:-2:flags=lanczos`); }
        else { args.push('-c:v', opts.vcodec === 'libx265' ? 'libx265' : 'libx264', '-crf', String(opts.crf || 23), '-preset', 'veryfast'); if (opts.scale) args.push('-vf', `scale=${opts.scale}:-2`); if (opts.fps) args.push('-r', String(opts.fps)); if (opts.format === 'mp4') args.push('-movflags', '+faststart'); }
      }
      args.push('-progress', 'pipe:1', out);
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), stage: 'start' }) });
      const r = await new Promise((resolve) => {
        const proc = spawn(ffmpeg, args, { windowsHide: true });
        state.proc = proc;
        let lastPct = 0, errOut = '', progBuf = '';
        proc.stdout.on('data', (d) => {
          progBuf += String(d);
          const lines = progBuf.split('\n');
          progBuf = lines.pop() || ''; // 保留末行未完结部分，数字跨块分裂时不丢进度
          for (const line of lines) {
            const m = line.match(/out_time_us=(\d+)/);
            if (m && dur > 0) {
              lastPct = Math.min(99, parseInt(m[1]) / 1e6 / dur * 100);
              send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: lastPct }) });
            }
          }
        });
        proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 20000) errOut = errOut.slice(-8000); });
        proc.on('exit', (code) => resolve({ code, errOut }));
        proc.on('error', (err) => resolve({ code: -1, errOut: err.message }));
      });
      if (state.cancel) { try { await fsp.rm(out, { force: true }); } catch (err) {} results.push({ input, out: null, ok: false, err: '已取消' }); break; }
      const ok = r.code === 0 && await pathExists(out);
      if (!ok) { try { await fsp.rm(out, { force: true }); } catch (err) {} } // 清理半成品
      results.push({ input, out: ok ? out : null, ok, err: ok ? '' : (r.errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ') || ('退出码 ' + r.code)) });
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok }) });
    }
  } finally { jobs.delete(id); }
  return { id, results, canceled: state.cancel };
});

/* 视频压制：重编码瘦身（预设/CRF/编码速度/分辨率/音频码率/去元数据） */
handle(CH.FFMPEG.PRESS, async (e, { items, outDir, opts }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  const id = 'prs' + (ctx.nextJobSeq());
  const state = { cancel: false, proc: null };
  const killProc = () => { try { state.proc && state.proc.kill && state.proc.kill(); } catch (err) {} if (isWin && state.proc && state.proc.pid) spawn('taskkill', ['/pid', String(state.proc.pid), '/t', '/f'], { windowsHide: true }); };
  jobs.set(id, { cancel: () => { state.cancel = true; killProc(); } });
  setLatestCancelable(() => { state.cancel = true; killProc(); });
  await fsp.mkdir(outDir, { recursive: true });
  const results = [];
  try {
    for (let i = 0; i < items.length; i++) {
      if (state.cancel) break;
      const input = items[i];
      const base = path.basename(input).replace(/\.[^.]+$/, '');
      let out = path.join(outDir, `${base}_pressed.mp4`);
      for (let k = 1; await pathExists(out); k++) out = path.join(outDir, `${base}_pressed(${k}).mp4`);
      let dur = 0;
      try {
        const ffprobe = findFfprobe();
        if (ffprobe) {
          const r = await runCmd(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input], { timeout: 15000 });
          dur = parseFloat((JSON.parse(r.stdout).format || {}).duration) || 0;
        }
      } catch (err) {}
      const args = ['-hide_banner', '-y', '-nostats', '-i', input,
        '-c:v', opts.vcodec === 'libx265' ? 'libx265' : 'libx264',
        '-crf', String(opts.crf || 23),
        '-preset', String(opts.preset || 'veryfast'),
        '-pix_fmt', 'yuv420p'];
      if (opts.vcodec === 'libx265') args.push('-tag:v', 'hvc1');
      if (opts.scale) args.push('-vf', `scale=${opts.scale}:-2`);
      if (opts.fps) args.push('-r', String(opts.fps));
      if (opts.stripMeta !== false) args.push('-map_metadata', '-1');
      if (opts.audio === 'mute') args.push('-an');
      else if (opts.audio === 'copy') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', opts.audio === '96k' ? '96k' : '128k');
      args.push('-movflags', '+faststart', '-progress', 'pipe:1', out);
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), stage: 'start' }) });
      const r = await new Promise((resolve) => {
        const proc = spawn(ffmpeg, args, { windowsHide: true });
        state.proc = proc;
        let lastPct = 0, errOut = '', progBuf = '';
        proc.stdout.on('data', (d) => {
          progBuf += String(d);
          const lines = progBuf.split('\n');
          progBuf = lines.pop() || '';
          for (const line of lines) {
            const m = line.match(/out_time_us=(\d+)/);
            if (m && dur > 0) {
              lastPct = Math.min(99, parseInt(m[1]) / 1e6 / dur * 100);
              send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: lastPct }) });
            }
          }
        });
        proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 20000) errOut = errOut.slice(-8000); });
        proc.on('exit', (code) => resolve({ code, errOut }));
        proc.on('error', (err) => resolve({ code: -1, errOut: err.message }));
      });
      if (state.cancel) { try { await fsp.rm(out, { force: true }); } catch (err) {} results.push({ input, out: null, ok: false, err: '已取消' }); break; }
      const ok = r.code === 0 && await pathExists(out);
      if (!ok) { try { await fsp.rm(out, { force: true }); } catch (err) {} } // 清理半成品
      let inSize = 0, outSize = 0;
      try { inSize = (await fsp.stat(input)).size; if (ok) outSize = (await fsp.stat(out)).size; } catch (err) {}
      results.push({ input, out: ok ? out : null, ok, inSize, outSize, err: ok ? '' : (r.errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' ') || ('退出码 ' + r.code)) });
      send('job:stream', { id, data: JSON.stringify({ i, name: path.basename(input), pct: 100, done: true, ok }) });
    }
  } finally { jobs.delete(id); }
  return { id, results, canceled: state.cancel };
});

/* 视频截帧：单帧或帧序列 */
handle(CH.FFMPEG.FRAMES, async (e, { input, outDir, mode, ss, every, count, width }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  await fsp.mkdir(outDir, { recursive: true });
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  const args = ['-hide_banner', '-y'];
  let out;
  if (mode === 'single') {
    if (ss) args.push('-ss', String(ss));
    args.push('-i', input, '-frames:v', '1', '-q:v', '2');
    if (width) args.push('-vf', `scale=${width}:-2`);
    out = path.join(outDir, `${base}_frame.jpg`);
    args.push(out);
  } else {
    const fps = Math.max(0.05, 1 / Math.max(1, every || 1));
    args.push('-i', input, '-vf', `fps=${fps}${width ? `,scale=${width}:-2` : ''}`, '-frames:v', String(Math.min(500, count || 20)), '-q:v', '3');
    out = path.join(outDir, `${base}_%03d.jpg`);
    args.push(out);
  }
  /* 【先记下已有的帧文件，截完只数「本次新增的」】
   * 原实现是截完之后 readdir 统计所有 `base_*.jpg`。对同一个视频重复截帧
   * （上次 20 张，这次 5 张）时，统计会得到 20+，界面显示的帧数与实际不符；
   * 而且 ffmpeg 带 -y 会把 base_001.jpg … 覆盖掉，用户上次的帧就没了 ——
   * 这一条靠「只统计新增」看不出来，所以要单独确认覆盖行为。
   * 这里用「截帧前后的文件集合差」统计，并把被覆盖的旧文件数如实报出来。 */
  let before = new Set();
  try { before = new Set(await fsp.readdir(outDir)); } catch (e) { before = new Set(); }
  const r = await runCmd(ffmpeg, args, { timeout: 300000 });
  if (r.code !== 0) throw new Error('截帧失败：' + (r.stderr || r.stdout).split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
  let n = 0, overwritten = 0;
  try {
    const after = await fsp.readdir(outDir);
    const mine = after.filter((f) => f.startsWith(base + '_') && f.endsWith('.jpg'));
    n = mine.filter((f) => !before.has(f)).length;
    overwritten = mine.length - n;
  } catch (e) { /* 目录读不到就报 0，不编数字 */ }
  return {
    outDir, count: n, overwritten,
    first: path.join(outDir, mode === 'single' ? `${base}_frame.jpg` : `${base}_001.jpg`),
  };
});

/* 音频剪辑：截取 + 淡入淡出 + 增益 */
handle(CH.FFMPEG.AUDIO_CUT, async (e, { input, out, ss, dur, fadeIn, fadeOut, gain, format }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  // 输出路径不允许等于输入路径（否则会把源文件覆盖成剪辑结果）
  try {
    if (path.resolve(String(out)) === path.resolve(String(input))) throw new Error('输出文件不能与源文件相同');
    const bad = pathGuard.checkOverwritable(out);
    if (bad) throw pathGuard.err(bad.code, bad.reason);
  } catch (err) { throw err; }
  const ac = format === 'mp3' ? 'libmp3lame' : format === 'wav' ? 'pcm_s16le' : format === 'flac' ? 'flac' : 'aac';
  const args = ['-hide_banner', '-y'];
  if (ss) args.push('-ss', String(ss));
  args.push('-i', input);
  if (dur > 0) args.push('-t', String(dur));
  const filters = [];
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) {
    // 淡出起点取「截取时长」或源时长减淡出长度
    let total = dur > 0 ? dur : 0;
    if (total <= 0) {
      try {
        const ffprobe = findFfprobe();
        if (ffprobe) {
          const rp = await runCmd(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input], { timeout: 15000 });
          total = parseFloat((JSON.parse(rp.stdout).format || {}).duration) || 0;
        }
      } catch (err) {}
    }
    const st = Math.max(0, total - fadeOut);
    filters.push(`afade=t=out:st=${st.toFixed(2)}:d=${fadeOut}`);
  }
  if (gain) filters.push(`volume=${gain}dB`);
  args.push('-vn', '-c:a', ac);
  if (ac === 'aac') args.push('-b:a', '192k');
  if (filters.length) args.push('-af', filters.join(','));
  args.push(out);
  const r = await runCmd(ffmpeg, args, { timeout: 300000 });
  if (r.code !== 0 || !(await pathExists(out))) throw new Error('剪辑失败：' + (r.stderr || r.stdout).split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
  return { out, size: (await fsp.stat(out)).size };
});
/* ================= IPC: 屏幕录制（ffmpeg gdigrab，区域/声音/暂停分段/GIF） ================= */
let recProc = null, recOut = null, recSegs = [], recSegDir = null, recOpts = null;
// 分段数量（拼接降级提示用）
function fmtDur(segs) { return (segs || []).length + ' 段'; }
// 解析 ffmpeg -list_devices 输出。兼容三种格式：
//   4.x : "名称" (audio)  /  [dshow] "名称" (audio) 后的旧式行 "名称" [Audio]
//   6.x+: 不再输出 "DirectShow audio devices" 小节标题，逐行 "名称" (video)/(audio)
function parseDshowDevices(text) {
  const audio = [], video = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/"([^"]+)"\s*(?:\[(Audio|Video)\]|\((audio|video)\))\s*$/i);
    if (!m) continue;
    const name = m[1];
    const kind = (m[2] || m[3]).toLowerCase();
    if (kind === 'audio') { if (!audio.includes(name)) audio.push(name); }
    else if (!video.includes(name)) video.push(name);
  }
  return { audio, video };
}
async function listDshowDevices() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { audio: [], video: [] };
  const r = await new Promise((resolve) => {
    let out = '';
    const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
    p.stderr.on('data', d => { out += String(d); });
    p.on('exit', () => resolve(out));
    p.on('error', () => resolve(''));
  });
  return parseDshowDevices(r);
}
handle(CH.REC.AUDIO_DEVICES, async () => {
  const d = await listDshowDevices();
  return { devices: d.audio, audio: d.audio, video: d.video };
});
/* rec:video-devices 已移除：录音页的下拉框由 rec:audio-devices 一次拿全
 * （它同时返回 audio 与 video），不必再开一条只取摄像头的通道。 */
// 画中画位置 → overlay 表达式（摄像头尺寸自适应，边距 16px）
function pipPosition(pos) {
  const pad = 16;
  switch (pos) {
    case 'lt': return '16:16';
    case 'rt': return `W-w-${pad}:16`;
    case 'lb': return `16:H-h-${pad}`;
    default: return `W-w-${pad}:H-h-${pad}`; // rb 默认
  }
}
function recSpawnSeg(segPath) {
  const ffmpeg = findFfmpeg();
  const o = recOpts;
  const args = ['-y', '-hide_banner', '-f', 'gdigrab', '-framerate', String(o.fps || 30)];
  if (o.rect) args.push('-offset_x', String(o.rect.x), '-offset_y', String(o.rect.y), '-video_size', `${o.rect.w}x${o.rect.h}`);
  args.push('-i', 'desktop');
  // 输入序号：0=桌面，1=摄像头（可选），其后为音频
  let nextIdx = 1;
  let camIdx = -1;
  if (o.camera) { args.push('-f', 'dshow', '-rtbufsize', '64M', '-i', `video=${o.camera}`); camIdx = nextIdx++; }
  if (o.audio) args.push('-f', 'dshow', '-rtbufsize', '64M', '-i', `audio=${o.audio}`);
  const fps = o.fps || 30;
  if (camIdx >= 0) {
    // 摄像头缩放到画面宽度的 25%（且为偶数），叠加到指定角落
    const scale = Math.min(Math.max(o.camScale || 0.25, 0.1), 0.5);
    const pos = pipPosition(o.camPos || 'rb');
    args.push('-filter_complex',
      `[${camIdx}:v]fps=${fps}[camf];[camf][0:v]scale2ref=w=trunc(main_w*${scale}/2)*2:h=-2[cams][basem];[basem][cams]overlay=${pos}:format=auto[vout]`,
      '-map', '[vout]');
    if (o.audio) args.push('-map', `${camIdx + 1}:a`);
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  if (o.audio) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart', segPath);
  return { proc: spawn(ffmpeg, args, { windowsHide: true }), args };
}
handle(CH.REC.START, async (e, { outPath, fps, rect, audio, camera, camPos, camScale, overwrite }) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先在「FFmpeg 环境」中安装');
  if (recProc && recProc.exitCode === null) throw new Error('已有录制进行中');
  /* 录制曾经是唯一没走覆盖闸门的写盘通道：recOut 直接等于渲染层给的 outPath，
   * 目标已存在就被 copyFile / ffmpeg -y 静默盖掉，界面上还只显示「录制完成」。
   *
   * 但「一律拒绝」也过头了：输出路径是走 dialog:save 选的，Windows 原生保存框
   * 在用户选中已存在文件时会**自己弹**「文件已存在，要替换它吗？」，
   * 用户点过「是」之后再被这里二次否决，就只能手动改文件名 ——
   * 等于把系统对话框的确认当空气，这是 v0.2.7 引入的回归。
   *
   * 所以分两种情况：
   *   overwrite=true  用户在系统对话框里已明确确认要替换，放行；
   *   overwrite 缺省  非交互调用（将来若有），保守起见仍然拒绝。
   * 无论哪种情况，系统关键目录的闸门都照旧执行 —— 不能因为「用户确认过」
   * 就去覆盖 System32 里的文件。 */
  if (typeof outPath !== 'string' || !outPath.trim()) throw new Error('录制输出路径无效');
  const recBad = pathGuard.checkOverwritable(outPath);
  if (recBad) throw pathGuard.err(recBad.code, recBad.reason);
  if (fs.existsSync(outPath) && !overwrite) {
    throw new Error('目标文件已存在，为避免覆盖已拒绝：' + outPath);
  }
  recOut = outPath;
  // yuv420p 要求偶数尺寸/偏移，框选结果向下取偶
  if (rect && typeof rect === 'object') {
    rect = { x: Math.max(0, Math.round(rect.x)) & ~1, y: Math.max(0, Math.round(rect.y)) & ~1,
      w: Math.max(64, Math.round(rect.w)) & ~1, h: Math.max(64, Math.round(rect.h)) & ~1 };
  } else rect = null;
  recOpts = { fps: fps || 30, rect, audio: audio || null, camera: camera || null, camPos: camPos || 'rb', camScale: camScale || 0.25 };
  recSegs = [];
  recSegDir = tempNames.recSegDir({ tempDir: tempDir() });
  await fsp.mkdir(recSegDir, { recursive: true });
  try {
    return await recStartSeg();
  } catch (err) {
    // 启动失败必须回滚状态：否则临时目录泄漏，且下次 resume 会误判会话仍在
    const dir = recSegDir;
    recOpts = null; recSegs = []; recSegDir = null; recProc = null;
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
});
async function recStartSeg() {
  const seg = path.join(recSegDir, `seg-${recSegs.length + 1}.mp4`);
  const { proc } = recSpawnSeg(seg);
  recProc = proc;
  let errOut = '';
  proc.stderr.on('data', (d) => { errOut += String(d); if (errOut.length > 12000) errOut = errOut.slice(-6000); });
  await new Promise(r => setTimeout(r, 1200));
  if (proc.exitCode !== null) {
    recProc = null;
    throw new Error('录制启动失败：' + errOut.split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
  }
  recSegs.push(seg);
  return { ok: true, paused: false };
}
async function recStopSeg() {
  const proc = recProc;
  recProc = null;
  if (!proc || proc.exitCode !== null) return;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    try { proc.stdin.write('q'); } catch (e) {}
    setTimeout(() => { try { spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true }); } catch (err) {} }, 5000);
  });
  await new Promise(r => setTimeout(r, 300));
}
handle(CH.REC.PAUSE, async () => { await recStopSeg(); return { ok: true, paused: true }; });
handle(CH.REC.RESUME, async () => {
  // rec:stop 的 finally 会把 recOpts/recSegDir 置空；只检查 recOpts 会漏掉 recSegDir 已失效的情况
  if (!recOpts || !recSegDir) throw new Error('没有进行中的录制会话');
  return await recStartSeg();
});
handle(CH.REC.STOP, async (e, makeGif) => {
  await recStopSeg();
  if (!recSegs.length) return { ok: true, size: 0, outPath: recOut };
  // 拼接失败时的降级标记：必须如实告诉用户只拿到了第一段，
  // 否则“暂停过的录制”会静默丢掉后半段，用户还以为完整。
  let degraded = null;
  // 用 try/finally 保证临时分段目录一定被清理（原先清理写在末尾，中途抛错就泄漏）
  try {
    try {
      if (recSegs.length === 1 && recSegs[0]) {
        await fsp.copyFile(recSegs[0], recOut);
      } else {
        // 分段无损拼接（相同编码参数）
        const listFile = path.join(recSegDir, 'list.txt');
        await fsp.writeFile(listFile, recSegs.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
        const ffmpeg = findFfmpeg();
        const r = await runCmd(ffmpeg, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', recOut], { timeout: 120000 });
        if (r.code !== 0) throw new Error('分段拼接失败：' + (r.stderr || '').split(/\r?\n/).filter(l => l.trim()).slice(-2).join(' '));
      }
    } catch (err) {
      // 兜底只能保住第一段，必须把这件事说出来
      try {
        if (recSegs[0]) await fsp.copyFile(recSegs[0], recOut);
        degraded = `分段合并失败（${err.message}），已保存第一段共 ${fmtDur(recSegs)}；其余 ${recSegs.length - 1} 段未能合并`;
        console.warn('[rec] ' + degraded);
      } catch (e2) {
        degraded = `分段合并失败且无法保存任何分段：${err.message}`;
        throw err;
      }
      // 分段目录会被保留（finally 里降级时不删），把路径告诉用户以便手工合并
      degraded += `；剩余分段保留在 ${recSegDir}`;
    }
    let gifOut = null;
    if (makeGif) {
      /* 【GIF 目标名的两个坑】
       * 1) 用户走 dialog:save，文件名可以是任意东西。原来用
       *    `/\.mp4$/i` 只认 mp4 —— 存成 .mkv/.avi 时替换不生效，
       *    gifTarget === recOut，ffmpeg 一边读一边 `-y` 写同一个文件。
       * 2) 改成「剥掉最后一个扩展名再加 .gif」仍有坑：
       *    录成 `D:\rec\v1.2`（无扩展名但含点）→ 得到 `D:\rec\v1.gif`；
       *    录成 `D:\rec\.hidden` → 整个文件名被当成扩展名，结果跑到
       *    **父目录** `D:\rec.gif`。
       * 两种情况下，失败分支里的 `rm(gifTarget)` 删掉的是与本次录制
       * 毫不相干的用户既有文件。
       * 现在：只在确实是已知视频扩展名时才剥离，否则直接拼 `.gif`；
       * 并且**只在文件是我们这次新建时才删**（先记下它原本是否存在）。 */
      const REC_VIDEO_EXT = /^\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|ts)$/i;
      const recExt = path.extname(recOut);
      let gifTarget = REC_VIDEO_EXT.test(recExt)
        ? recOut.slice(0, -recExt.length) + '.gif'
        : recOut + '.gif';
      if (path.resolve(gifTarget).toLowerCase() === path.resolve(recOut).toLowerCase()) {
        gifTarget = recOut + '.gif';   // 兜底：绝不能与录像同路径
      }
      /* 目标已存在 → 不覆盖、不改名去猜，直接换一个不冲突的名字，
       * 这样失败清理绝不会误删用户原有的 gif。 */
      const gifPreexisted = await pathExists(gifTarget);
      if (gifPreexisted) {
        const stem = gifTarget.slice(0, -'.gif'.length);
        for (let i = 1; i < 1000 && await pathExists(gifTarget); i++) gifTarget = `${stem}(${i}).gif`;
      }
      try {
        const ffmpeg = findFfmpeg();
        const r = await runCmd(ffmpeg, ['-y', '-hide_banner', '-i', recOut, '-vf', 'fps=10,scale=480:-2:flags=lanczos', gifTarget], { timeout: 300000 });
        if (r.code !== 0) throw new Error('GIF 转码失败');
        gifOut = gifTarget;
      } catch (err) {
        // 失败时 ffmpeg 会留下体积不足的残缺 .gif，必须删掉，
        // 否则用户看到「录制完成」却发现目录里多了一个打不开的文件。
        // 但**只删我们自己新建的**：万一目标名撞上了用户既有文件，删了就是毁数据。
        if (!gifPreexisted) await fsp.rm(gifTarget, { force: true }).catch(() => {});
        gifOut = null;
      }
    }
    let size = 0;
    try { size = (await fsp.stat(recOut)).size; } catch (e) {}
    return { ok: true, size, outPath: recOut, gif: gifOut, degraded };
  } finally {
    // 降级（拼接失败、只保住第一段）时**不删**分段目录：
    // 用户可能想手工合并剩下的分段，无条件删掉等于把后半段录像永久销毁。
    // 只有完整成功才清理。
    if (!degraded) {
      await fsp.rm(recSegDir, { recursive: true, force: true }).catch(() => {});
    } else {
      console.warn('[rec] 保留分段目录以便手工恢复：' + recSegDir);
    }
    recOpts = null; recSegs = []; recSegDir = null;
  }
});
};
