'use strict';
/* 媒体与 FFmpeg 域（ipc/media-ffmpeg.js）的测试。
 *
 * ============ 这个文件为什么存在 ============
 * 任务 6 把 ffmpeg:* / target:* / rec:* 三个域从 main.js 搬到了
 * ipc/media-ffmpeg.js（947 行）。搬出去的文件最容易"没人查"——
 * 而它的行为断言此前散在 test-round8 / test-round13 / test-round15 里，
 * 想知道「录制覆盖有没有测」得挨个 grep。现在按模块名就能找到。
 *
 * 这组（原 test-round8-fixes.js ②）锁的是**录制覆盖的二次否决**：
 * 系统保存对话框已经问过用户「要覆盖吗」，用户点了是；如果 handler 里
 * 再无条件地 `if (fs.existsSync(outPath)) throw`，就等于把用户刚才的
 * 确认又问了一次，而且这一次无法回答 —— 表现是「选了覆盖仍然报文件已存在」。
 * 修法是让存在性检查受 overwrite 参数控制，而**系统关键目录闸门要无条件执行**
 * （那个闸门跟"用户确认"无关，是防止往 Windows/Program Files 里写）。
 */

const assert = require('assert');
const { scanBrace } = require('../lib/src-scan');

const { t, done, readMain, readTree } = require('./lib/harness');
const path = require('path');

const mainSrc = readMain({ raw: true });

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * extractGifTarget：从 rec:stop 的实现里抽出 GIF 目标名计算那一段，
 * 用来验证「任何扩展名都不能与录像输出同名」这条不变量。
 * segFromHandler：按花括号配平取 handler 体。 */








function segFromHandler(channel, label) {
  const start = mainSrc.indexOf("handle('" + channel + "'");
  assert.ok(start > 0, '找不到 handler: ' + channel);
  /* handler 签名里可能有默认参数对象 `opts = {}`，不能取 start 之后的第一个 '{'，
   * 要跳到 `=> {` 之后的那个函数体开括号。 */
  const arrow = mainSrc.indexOf('=>', start);
  const from = arrow > 0 ? arrow : start;
  const open = mainSrc.indexOf('{', from);
  assert.ok(open > 0, 'handler ' + channel + ' 没有函数体');
  const end = scanBrace(mainSrc, open);
  assert.ok(end > open, 'handler ' + channel + ' 括号不配平');
  return mainSrc.slice(start, end);
}

function extractGifTarget() {
  const start = mainSrc.indexOf('const REC_VIDEO_EXT =');
  assert.ok(start > 0, '找不到 REC_VIDEO_EXT 定义');
  const endMarker = "gifTarget = recOut + '.gif';";
  const endAt = mainSrc.indexOf(endMarker, start);
  assert.ok(endAt > start, '找不到 gifTarget 兜底块');
  const after = mainSrc.indexOf('}', endAt);
  assert.ok(after > endAt, '兜底块的 } 没找到');
  const body = mainSrc.slice(start, after + 1);
  return new Function('recOut', 'path', body + '\nreturn gifTarget;');
}

t('9c target:compress-av 与 office:convert 都不再用裸 fsp.rename 提交结果', () => {
  const seg = segFromHandler('target:compress-av');
  assert.ok(!/fsp\.rename\(finalOut\.file, dst\)/.test(seg),
    'target:compress-av 仍在用裸 rename 提交（跨盘 EXDEV 会丢成果）');
  assert.ok(/moveFile\(finalOut\.file, dst\)/.test(seg), '应改用 moveFile');

  const off = segFromHandler('office:convert');
  assert.ok(!/fsp\.rename\(produced, out\)/.test(off),
    'office:convert 仍在用裸 rename 提交（stage 在 %TEMP%，outDir 可能在别的盘）');
});

/* ==================== 10. WAV / FLAC 不能再把视频流塞进去 ==================== */

t('10 音视频转换：所有纯音频容器都必须加 -vn（判据只能有一份）', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('ffmpeg:convert'"), mainSrc.indexOf("handle('ffmpeg:frames'"));
  /* 取值：把 -vn 的判定条件与 isAudioOut 的定义都抓出来比对 */
  const mAudio = seg.match(/const isAudioOut = \[([^\]]+)\]\.includes\(opts\.format\)/);
  assert.ok(mAudio, '找不到 isAudioOut 定义');
  const audioFormats = mAudio[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.ok(audioFormats.includes('wav') && audioFormats.includes('flac'),
    '前置：wav/flac 属于纯音频容器');

  /* -vn 的判定必须在 isAudioOut 算出之后、且用到它 */
  const vnLine = seg.match(/if \((isAudioOut \|\| opts\.mute|opts\.format === 'mp3'[^\n]*)\) args\.push\('-vn'\)/);
  assert.ok(vnLine, '找不到 -vn 的判定行');
  const cond = vnLine[1];
  if (!/isAudioOut/.test(cond)) {
    /* 还写死列表：那 wav/flac 必须在列表里 */
    for (const f of ['wav', 'flac']) {
      assert.ok(new RegExp("'" + f + "'").test(cond),
        'WAV/FLAC 不加 -vn 会把视频流塞进音频容器：' + cond);
    }
  }
  /* -vn 必须出现在 -c:v 之前：否则视频编码器已经被指定了 */
  const idxVn = seg.indexOf("args.push('-vn')");
  const idxCv = seg.indexOf("args.push('-c:v'");
  assert.ok(idxVn > 0 && idxCv > idxVn, '-vn 必须在 -c:v 之前');
});

/* ==================== 11. runCmd 的 throwOnNonZero ==================== */

t('11c ffmpeg:pick 判 ffmpeg 必须看输出的 "ffmpeg version"，且不覆盖已有可用 ffmpeg', () => {
  const seg = mainSrc.slice(mainSrc.indexOf("handle('ffmpeg:pick'"), mainSrc.indexOf('const FFMPEG_SOURCES'));
  /* 光「出现过 ffmpeg version 这个字符串」不够 —— 注释里也可能有。
   * 要求它真的出现在一个 if/threw 的判断里，也就是「不匹配就不复制」。
   * （反向验证时发现过：只测 /ffmpeg version/ 的话，把校验整段删掉测试仍然是绿的。） */
  const guard = seg.match(/if\s*\(\s*!\s*\/[^/\n]*ffmpeg version[^/\n]*\/[a-z]*\s*\.test\([^)]*\)\s*\)\s*throw/);
  assert.ok(guard,
    'ffmpeg:pick 没有「输出里不含 ffmpeg version 就拒绝」的判断 —— 任意 exe 都会被当成 ffmpeg 覆盖 bin/ffmpeg.exe');
  assert.ok(/throwOnNonZero/.test(seg), 'ffmpeg:pick 应先确认退出码为 0');
  assert.ok(/已有可用的 ffmpeg，未覆盖|skipped/.test(seg), '已有可用 ffmpeg 时不应静默覆盖');
  /* 覆盖前必须真的检查过 dest 是否存在 */
  assert.ok(/fs\.existsSync\(dest\)/.test(seg), '覆盖前应检查目标是否已存在');
});

/* ==================== 12. 批量处理单条失败不拖垮整批 ==================== */

t('12 target:compress-av：单个源文件读不到时要记录失败并继续', () => {
  const seg = segFromHandler('target:compress-av');
  /* 原来裸的 `const srcSize = (await fsp.stat(input)).size;` 必须消失 */
  assert.ok(!/const srcSize = \(await fsp\.stat\(input\)\)\.size;/.test(seg),
    '仍在裸调 fsp.stat(input)：单个文件消失会中断整批，已完成的 results 也会丢');
  const guarded = /try \{\s*srcSize = \(await fsp\.stat\(input\)\)\.size;\s*\} catch/.test(seg);
  assert.ok(guarded, 'fsp.stat(input) 应被 try/catch 包住');
  assert.ok(/continue;/.test(seg.slice(seg.indexOf('无法读取源文件'), seg.indexOf('无法读取源文件') + 400)),
    '读不到源文件后应 continue 到下一个，而不是让异常冒出去');
});

/* ==================== 13. proc:kill 不能把「查询失败」当「进程已退出」 ==================== */

t('15 截帧：只统计本次新增的帧，并如实报出被覆盖的旧帧数', () => {
  const seg = segFromHandler('ffmpeg:frames');
  assert.ok(!/n = \(await fsp\.readdir\(outDir\)\)\.filter\(f => f\.startsWith\(base \+ '_'\)/.test(seg),
    '仍在统计目录里所有同名帧 —— 重复截帧时 count 会虚高（上次 20 张 + 这次 5 张报 25）');
  assert.ok(/before/.test(seg) && /!before\.has/.test(seg),
    '应记录截帧前已有的文件集合，只数新增的');
  assert.ok(/overwritten/.test(seg), '被覆盖的旧帧数要如实回报');
  /* 渲染层也得把它显示出来，否则主进程报了没人看 */
  assert.ok(/overwritten/.test(readTree('js/tools/media')), '渲染层没有显示 overwritten');
});

/* ==================== 16. 数值/展示边界（lib/target-size） ==================== */

t('36 rec:stop：GIF 目标名不能因为文件名含点而跑偏', () => {
  const mk = mainSrc.indexOf('if (makeGif) {');
  assert.ok(mk > 0, '找不到 if (makeGif) 块');
  const end = mainSrc.indexOf('let size = 0;', mk);
  assert.ok(end > mk, '找不到 GIF 块结尾');
  const seg = mainSrc.slice(mk, end);
  /* 必须按「已知视频扩展名」白名单剥壳，不能无条件剥最后一个扩展名 */
  assert.ok(/REC_VIDEO_EXT/.test(seg),
    '仍在无条件剥掉「最后一个扩展名」：D:\\rec\\v1.2 → D:\\rec\\v1.gif、D:\\rec\\.hidden → D:\\rec.gif（跑到父目录）');
  /* 失败清理前必须确认「这个 gif 是不是我们建的」 */
  assert.ok(/gifPreexisted/.test(seg),
    '失败清理没检查「文件是不是我们建的」—— 撞上用户既有 gif 时会删掉它');
  assert.ok(/if \(!gifPreexisted\)/.test(seg), '删除必须被 gifPreexisted 守卫');
});

done();

t('7a rec:stop 的 GIF 目标：任何扩展名都不能与录像输出同名', () => {
  const f = extractGifTarget();
  const RE = /^\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|ts)$/i;
  for (const recOut of ['C:/r/rec.mp4', 'C:/r/rec.mkv', 'C:/r/rec.avi', 'C:/r/rec',
    'C:/r/rec.MP4', 'C:/a/b.c/rec', 'C:/r/rec.tar.gz', 'C:/r/v1.2', 'C:/r/.hidden']) {
    const gif = f(recOut, path, RE);
    assert.ok(path.resolve(gif).toLowerCase() !== path.resolve(recOut).toLowerCase(),
      recOut + ' 的 GIF 目标与录像同名（' + gif + '）—— ffmpeg 会读写同一文件，失败时还会把录像删掉');
    assert.ok(/\.gif$/i.test(gif), recOut + ' 的 GIF 目标扩展名不对：' + gif);
  }
});

t('7b 录像输出为 .mp4 时，GIF 与录像同目录同基名（不改变既有行为）', () => {
  const f = extractGifTarget();
  const RE = /^\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|ts)$/i;
  assert.strictEqual(f('C:/r/rec.mp4', path, RE), 'C:/r/rec.gif');
  /* 含点但无扩展名的要拼在其后，不能吃掉已有名字 */
  assert.strictEqual(f('C:/r/v1.2', path, RE), 'C:/r/v1.2.gif',
    'v1.2 不是扩展名，GIF 应叫 v1.2.gif 而不是 v1.gif');
  /* .hidden 是纯点开头，不能被当成扩展名导致跑到父目录 */
  assert.strictEqual(f('C:/r/.hidden', path, RE), 'C:/r/.hidden.gif',
    '.hidden 应得到 .hidden.gif，而不是父目录下的 .gif');
});


