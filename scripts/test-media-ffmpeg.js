'use strict';
const path = require('path');
const fs = require('fs');
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

const { t, done, readMain, readTree } = require('./lib/harness');
/* segFromHandler 统一到 scripts/lib/seg-from-handler.js —— 见那里的文件头说明。 */
const { segFromHandler, handlerIndex, invokeIndex } = require('./lib/seg-from-handler');
const ROOT = path.join(__dirname, '..');
const stripComments = require('../lib/src-scan').stripComments;

const mainSrc = readMain({ raw: true });

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * extractGifTarget：从 rec:stop 的实现里抽出 GIF 目标名计算那一段，
 * 用来验证「任何扩展名都不能与录像输出同名」这条不变量。
 * segFromHandler：按花括号配平取 handler 体。 */









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

/* ---------------- 以下助手随 round14 的用例一起迁来 ---------------- */
const { extractFn } = require('../lib/src-scan');
function loadPinKeyBlock() {
  const block = extractFn(
    mainSrc,
    'function pinWinOf(',
    'pinWinOf');
  // 还需要 pinKey 与 pinWins 的声明
  const kStart = mainSrc.indexOf('const pinKey =');
  const kEnd = mainSrc.indexOf('const pinWins = new Map();', kStart);
  assert.ok(kStart > 0 && kEnd > kStart, '找不到 pinKey 声明');
  const decls = mainSrc.slice(kStart, kEnd + 'const pinWins = new Map();'.length);
  return new Function(decls + '\n' + block + '\nreturn { pinKey, pinWins, pinWinOf };')();
}
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

t('9c target:compress-av 与 office:convert 都不再用裸 fsp.rename 提交结果', () => {
  const seg = segFromHandler(mainSrc, 'target:compress-av');
  /* 锁的是：「9c target:compress-av 与 office:convert 都不再用裸 fsp.rename 提交结果」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/fsp\.rename\(finalOut\.file, dst\)/.test(seg),
    'target:compress-av 仍在用裸 rename 提交（跨盘 EXDEV 会丢成果）');
  /* 锁的是：「9c target:compress-av 与 office:convert 都不再用裸 fsp.rename 提交结果」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/moveFile\(finalOut\.file, dst\)/.test(seg), '应改用 moveFile');

  const off = segFromHandler(mainSrc, 'office:convert');
  assert.ok(!/fsp\.rename\(produced, out\)/.test(off),
    'office:convert 仍在用裸 rename 提交（stage 在 %TEMP%，outDir 可能在别的盘）');
});

/* ==================== 10. WAV / FLAC 不能再把视频流塞进去 ==================== */

t('10 音视频转换：所有纯音频容器都必须加 -vn（判据只能有一份）', () => {
  const seg = mainSrc.slice(handlerIndex(mainSrc, 'ffmpeg:convert'), handlerIndex(mainSrc, 'ffmpeg:frames'));
  /* 取值：把 -vn 的判定条件与 isAudioOut 的定义都抓出来比对 */
  /* 锁的是：「10 音视频转换：所有纯音频容器都必须加 -vn（判据只能有一份）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const mAudio = seg.match(/const isAudioOut = \[([^\]]+)\]\.includes\(opts\.format\)/);
  assert.ok(mAudio, '找不到 isAudioOut 定义');
  const audioFormats = mAudio[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  /* 锁的是：「10 音视频转换：所有纯音频容器都必须加 -vn（判据只能有一份）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(audioFormats.includes('wav') && audioFormats.includes('flac'),
    '前置：wav/flac 属于纯音频容器');

  /* -vn 的判定必须在 isAudioOut 算出之后、且用到它 */
  /* 锁的是：「10 音视频转换：所有纯音频容器都必须加 -vn（判据只能有一份）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const vnLine = seg.match(/if \((isAudioOut \|\| opts\.mute|opts\.format === 'mp3'[^\n]*)\) args\.push\('-vn'\)/);
  assert.ok(vnLine, '找不到 -vn 的判定行');
  const cond = vnLine[1];
  /* 锁的是：「10 音视频转换：所有纯音频容器都必须加 -vn（判据只能有一份）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  if (!/isAudioOut/.test(cond)) {
    /* 还写死列表：那 wav/flac 必须在列表里 */
    for (const f of ['wav', 'flac']) {
  /* 锁的是：「10 音视频转换：所有纯音频容器都必须加 -vn（判据只能有一份）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
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
  const seg = mainSrc.slice(handlerIndex(mainSrc, 'ffmpeg:pick'), mainSrc.indexOf('const FFMPEG_SOURCES'));
  /* 光「出现过 ffmpeg version 这个字符串」不够 —— 注释里也可能有。
   * 要求它真的出现在一个 if/threw 的判断里，也就是「不匹配就不复制」。
   * （反向验证时发现过：只测 /ffmpeg version/ 的话，把校验整段删掉测试仍然是绿的。） */
  const guard = seg.match(/if\s*\(\s*!\s*\/[^/\n]*ffmpeg version[^/\n]*\/[a-z]*\s*\.test\([^)]*\)\s*\)\s*throw/);
  assert.ok(guard,
    'ffmpeg:pick 没有「输出里不含 ffmpeg version 就拒绝」的判断 —— 任意 exe 都会被当成 ffmpeg 覆盖 bin/ffmpeg.exe');
  /* 锁的是：「11c ffmpeg:pick 判 ffmpeg 必须看输出的 "ffmpeg version"，且不覆盖已有可用 ffmp」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/throwOnNonZero/.test(seg), 'ffmpeg:pick 应先确认退出码为 0');
  /* 锁的是：「11c ffmpeg:pick 判 ffmpeg 必须看输出的 "ffmpeg version"，且不覆盖已有可用 ffmp」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/已有可用的 ffmpeg，未覆盖|skipped/.test(seg), '已有可用 ffmpeg 时不应静默覆盖');
  /* 覆盖前必须真的检查过 dest 是否存在 */
  /* 锁的是：「11c ffmpeg:pick 判 ffmpeg 必须看输出的 "ffmpeg version"，且不覆盖已有可用 ffmp」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/fs\.existsSync\(dest\)/.test(seg), '覆盖前应检查目标是否已存在');
});

/* ==================== 12. 批量处理单条失败不拖垮整批 ==================== */

t('12 target:compress-av：单个源文件读不到时要记录失败并继续', () => {
  const seg = segFromHandler(mainSrc, 'target:compress-av');
  /* 原来裸的 `const srcSize = (await fsp.stat(input)).size;` 必须消失 */
  /* 锁的是：「12 target:compress-av：单个源文件读不到时要记录失败并继续」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/const srcSize = \(await fsp\.stat\(input\)\)\.size;/.test(seg),
    '仍在裸调 fsp.stat(input)：单个文件消失会中断整批，已完成的 results 也会丢');
  /* 锁的是：「12 target:compress-av：单个源文件读不到时要记录失败并继续」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const guarded = /try \{\s*srcSize = \(await fsp\.stat\(input\)\)\.size;\s*\} catch/.test(seg);
  assert.ok(guarded, 'fsp.stat(input) 应被 try/catch 包住');
  /* 锁的是：「12 target:compress-av：单个源文件读不到时要记录失败并继续」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/continue;/.test(seg.slice(seg.indexOf('无法读取源文件'), seg.indexOf('无法读取源文件') + 400)),
    '读不到源文件后应 continue 到下一个，而不是让异常冒出去');
});

/* ==================== 13. proc:kill 不能把「查询失败」当「进程已退出」 ==================== */

t('15 截帧：只统计本次新增的帧，并如实报出被覆盖的旧帧数', () => {
  const seg = segFromHandler(mainSrc, 'ffmpeg:frames');
  /* 锁的是：「15 截帧：只统计本次新增的帧，并如实报出被覆盖的旧帧数」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/n = \(await fsp\.readdir\(outDir\)\)\.filter\(f => f\.startsWith\(base \+ '_'\)/.test(seg),
    '仍在统计目录里所有同名帧 —— 重复截帧时 count 会虚高（上次 20 张 + 这次 5 张报 25）');
  /* 锁的是：「15 截帧：只统计本次新增的帧，并如实报出被覆盖的旧帧数」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/before/.test(seg) && /!before\.has/.test(seg),
    '应记录截帧前已有的文件集合，只数新增的');
  /* 锁的是：「15 截帧：只统计本次新增的帧，并如实报出被覆盖的旧帧数」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/overwritten/.test(seg), '被覆盖的旧帧数要如实回报');
  /* 渲染层也得把它显示出来，否则主进程报了没人看 */
  /* 锁的是：「15 截帧：只统计本次新增的帧，并如实报出被覆盖的旧帧数」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
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
  /* 锁的是：「36 rec:stop：GIF 目标名不能因为文件名含点而跑偏」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/REC_VIDEO_EXT/.test(seg),
    '仍在无条件剥掉「最后一个扩展名」：D:\\rec\\v1.2 → D:\\rec\\v1.gif、D:\\rec\\.hidden → D:\\rec.gif（跑到父目录）');
  /* 失败清理前必须确认「这个 gif 是不是我们建的」 */
  /* 锁的是：「36 rec:stop：GIF 目标名不能因为文件名含点而跑偏」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/gifPreexisted/.test(seg),
    '失败清理没检查「文件是不是我们建的」—— 撞上用户既有 gif 时会删掉它');
  /* 锁的是：「36 rec:stop：GIF 目标名不能因为文件名含点而跑偏」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/if \(!gifPreexisted\)/.test(seg), '删除必须被 gifPreexisted 守卫');
});

t('1a pinKey：数字、字符串、带空格的值都归一成同一个键', () => {
  const { pinKey } = loadPinKeyBlock();
  assert.strictEqual(pinKey(12), '12', '数字 12 应归一成字符串 "12"');
  assert.strictEqual(pinKey('12'), '12', '字符串 "12" 应保持原样');
  assert.strictEqual(pinKey(12), pinKey('12'), '同一次窗口的两个来源必须得到同一个键');
  assert.strictEqual(pinKey(null), '', 'null 不能变成 "null"');
  assert.strictEqual(pinKey(undefined), '', 'undefined 不能变成 "undefined"');
  assert.strictEqual(pinKey(0), '0', '0 是合法的窗口 id，不能被当成空');
});

t('1b pinWinOf：登记时用数字、查询时用字符串（渲染层的真实路径）也找得到', () => {
  const { pinKey, pinWins, pinWinOf } = loadPinKeyBlock();
  const fakeWin = { id: 12, isDestroyed: () => false, _pos: null, setPosition(x, y) { this._pos = [x, y]; } };
  // 模拟 createPinWindow 的登记：必须用 pinKey 包一层（旧写法直接 set(bw.id))
  pinWins.set(pinKey(fakeWin.id), fakeWin);
  // 模拟渲染层：URLSearchParams.get('id') 拿回来的是字符串，原样 IPC 发回来
  const found = pinWinOf('12');
  assert.ok(found, "Map 里存 12、查 '12' 必须找到窗口（这正是拖动/缩放/关闭全失效的根因）");
  assert.strictEqual(found, fakeWin);
  // 反向：真的不存在的 id 依然找不到
  assert.strictEqual(pinWinOf('99'), null, '不存在的 id 应返回 null');
  // 已销毁的窗口也当找不到
  const dead = { id: 7, isDestroyed: () => true };
  pinWins.set(pinKey(dead.id), dead);
  assert.strictEqual(pinWinOf('7'), null, '已销毁的窗口应返回 null');
});

t('1c 三个贴图 handler 取不到窗口时必须返回 false，不能假装成功', () => {
  const code = stripComments(mainSrc);
  for (const ch of ['win:pin-move', 'win:pin-resize', 'win:pin-close']) {
    const i = handlerIndex(code, ch);
    assert.ok(i > 0, '找不到 handler ' + ch);
    const seg = code.slice(i, code.indexOf('\n});', i));
    /* 旧写法：const bw = pinWins.get(id); if (bw && ...) ...; return true;
     * —— 取不到也 return true。新写法必须显式 return false。 */
    assert.ok(/if\s*\(\s*!bw\s*\)\s*return false/.test(seg),
      ch + ' 取不到窗口时没有 return false（会静默假装成功）');
  /* 锁的是：「1c 三个贴图 handler 取不到窗口时必须返回 false，不能假装成功」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    assert.ok(!/pinWins\.get\(id\)/.test(seg),
      ch + ' 仍在直接用 pinWins.get(id)（没有做键类型归一）');
  /* 锁的是：「1c 三个贴图 handler 取不到窗口时必须返回 false，不能假装成功」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    assert.ok(/pinWinOf\(/.test(seg), ch + ' 没有走 pinWinOf 的归一查找');
  }
});

t('1d createPinWindow 登记与删除都用同一个归一键', () => {
  const code = stripComments(mainSrc);
  /* 锁的是：「1d createPinWindow 登记与删除都用同一个归一键」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/pinWins\.set\(\s*pinKey\(bw\.id\)\s*,\s*bw\s*\)/.test(code),
    '登记时没用 pinKey（数字键与字符串键会分家）');
  /* 锁的是「关闭时按归一键删除登记」这个内存泄漏回归：早期用裸 bw.id 删，
   * 登记用的却是 pinKey(bw.id)，键不同就一直删不掉。真跑需要 Electron。 */
  assert.ok(/pinWins\.delete\(\s*pinKey\(bw\.id\)\s*\)/.test(code),
    'closed 里没用 pinKey 删除，会留下一个查不到的僵尸条目');
  /* 锁的是：「1d createPinWindow 登记与删除都用同一个归一键」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/String\(bw\.id\)/.test(code), 'URL 里传的仍然应是 String(bw.id)');
});

/* ==================== 2. finally 不能引用 try 内的 let ==================== */

t('4a 截图导出：源矩形必须乘 dpr，目标尺寸用逻辑像素', () => {
  const raw = read('js/auxwin/snip-2.js');
  const code = stripComments(raw);
  const i = code.indexOf('const dpr = devicePixelRatio');
  assert.ok(i > 0, '找不到导出裁剪那段');
  /* 取到 payload.dataUrl 之前，即整段「算坐标 → 建 canvas → drawImage」 */
  const seg = code.slice(i, code.indexOf('payload.dataUrl', i));
  assert.ok(seg.indexOf('drawImage') > 0, '取到的片段里没有 drawImage，抽取边界已失效');

  /* 【必须真的执行源码里那一段，不能另写一份同构代码】
   * 本用例最初的写法是：先 new Function 建了 `fn`（包住真实 seg），
   * 但**从未调用它**；真正跑的是紧跟着另写的 `run` —— 里面是手抄的算式。
   * 于是这条测试测的是测试自己写的代码，与 snip-2.js 无关。
   * 实测确认：把源码里 `sw = sel.w * dpr` 改成 `sw = sel.w`
   * （非 100% 缩放下截图横向错位），6 个 drawImage 断言仍然全绿。
   *
   * 现在改成：把 seg 里真实那段塞进函数执行，只注入它需要的外部量
   * （devicePixelRatio / canvas / document / sel / payload）。
   * document.createElement 返回一个会记录调用的假 canvas。 */
  const calls = [];
  const fakeOctx = {
    scale: (x, y) => calls.push({ op: 'scale', x, y }),
    drawImage: (cv, sx, sy, sw, sh, dx, dy, dw, dh) =>
      calls.push({ op: 'drawImage', sx, sy, sw, sh, dx, dy, dw, dh }),
  };
  const makeFakeCanvas = () => ({
    width: 0,
    height: 0,
    getContext: () => fakeOctx,
    toDataURL: () => 'data:image/png;base64,STUB',
  });

  const dpr = 1.5;
  const sel = { x: 100, y: 50, w: 200, h: 120 };
  const payload = {};
  /* 真实源码片段里引用的外部量全部由形参注入，片段本身不改一字 */
  const run = new Function('devicePixelRatio', 'canvas', 'document', 'sel', 'payload',
    `return (function () {
       ${seg}
       return { out: out, octx: octx, sx: sx, sy: sy, sw: sw, sh: sh };
     })();`);
  const got = run(dpr, {}, { createElement: makeFakeCanvas }, sel, payload);

  const draw = calls.find((c) => c.op === 'drawImage');
  assert.ok(draw, '源码片段没有调用 drawImage（抽取的代码段可能已不完整）');
  assert.strictEqual(draw.sx, sel.x * dpr, '源矩形 x 没乘 dpr（只截到左上角 1/dpr 那块再拉满，内容会错位）');
  assert.strictEqual(draw.sy, sel.y * dpr, '源矩形 y 没乘 dpr');
  assert.strictEqual(draw.sw, sel.w * dpr, '源矩形宽没乘 dpr');
  assert.strictEqual(draw.sh, sel.h * dpr, '源矩形高没乘 dpr');
  // 目标矩形保持逻辑尺寸（由 octx.scale 放大）
  assert.strictEqual(draw.dw, sel.w, '目标宽应当保持逻辑尺寸（缩放交给 octx.scale）');
  assert.strictEqual(draw.dh, sel.h, '目标高应当保持逻辑尺寸');
  const sc = calls.find((c) => c.op === 'scale');
  assert.ok(sc && sc.x === dpr, 'octx.scale 没有按 dpr 缩放');
  /* 输出画布也必须是位图尺寸（逻辑 × dpr），否则高清屏导出会糊 */
  assert.strictEqual(got.out.width, sel.w * dpr, '输出画布宽没用位图尺寸');
  assert.strictEqual(got.out.height, sel.h * dpr, '输出画布高没用位图尺寸');
});

/* 【4b 已删除 —— 它是 4a 的源码断言副本，且覆盖更窄】
 *
 * 原来的 4b 做两件事：
 *   ① 正则查源码里有 sel.x * dpr（源矩形起点乘了 dpr）
 *   ② 查源码没有 drawImage(canvas, sel.x, …)（没把逻辑坐标直接当源起点）
 * 但它**完全不查 sw / sh**（源矩形的宽和高）。实测确认：
 * 把源码里 sw = sel.w * dpr 改成 sw = sel.w（非 100% 缩放下截图横向
 * 错位、内容被拉伸），4b 仍然 PASS。
 *
 * 而 4a 现在是真的把那段源码抽出来执行、断言 drawImage 收到的四个源参数
 * 全部等于「逻辑值 × dpr」—— 4b 那两条正则能覆盖的、以及覆盖不了的维度，
 * 4a 的行为断言都覆盖了，而且不会因为「等价写法 / 换行 / 改注释」误报。
 *
 * 留一份窄口径的源码断言只会制造虚假的安全感：它绿着，但真正会出错的那
 * 两个维度（sw/sh）它看不见。按 harness 头部定的规矩
 * ——「能写成行为断言的，一律写成行为断言」—— 删掉是对的。
 */

/* ==================== 5. 清目标侧同名项 ==================== */

t('10a 除零与溢出必须抛错，不能返回 Infinity', () => {
  const ev = require(path.join(ROOT, 'lib', 'expr-eval'));
  const evaluate = (s) => ev.evaluate(s);
  for (const s of ['1/0', '-1/0', '1e308*10', '2^1024']) {
    assert.throws(() => evaluate(s), /无法计算/,
      s + ' 应当抛错（原来会原样返回 Infinity，下游算出"∞"这种无意义结果）');
  }
  // 0/0 与取余 0 原本就抛，保持
  assert.throws(() => evaluate('0/0'), /无法计算/);
  assert.throws(() => evaluate('1%0'), /无法计算/);
  // 正常计算不受影响
  assert.strictEqual(evaluate('1/3'), 1 / 3);
  assert.strictEqual(evaluate('2+3'), 5);
  assert.strictEqual(evaluate('100-10%'), 99.9, '百分比语义不能被误伤');
  assert.strictEqual(evaluate('50%+10%'), 0.6);
});

t('10b 错误文案要说明原因（不能只说「无法计算」）', () => {
  const ev = require(path.join(ROOT, 'lib', 'expr-eval'));
  try { ev.evaluate('1/0'); assert.fail('应当抛错'); }
  catch (e) {
    assert.ok(/除数|溢出|有限/.test(e.message),
      '错误文案没说明是除零还是溢出，用户无从判断：' + e.message);
  }
});

/* ==================== 11. 摄像头清理注册位置 ==================== */

t('11a 清理回调的注册不在 rec:audio-devices 的 then 里', () => {
  const code = stripComments(readTree('js/tools/media'));
  /* 定位 invoke('rec:audio-devices') 到它配对的 .catch(() => {}) 之间的那段，
   * 断言 onCleanup 不在其中 —— 枚举失败时也要注册清理。 */
  const i = invokeIndex(code, 'rec:audio-devices');
  assert.ok(i > 0, "找不到 invoke('rec:audio-devices')");
  /* 取这段 then 链的结束：从上往下找第一个 "}).catch(() => {});" */
  const endMark = '}).catch(() => {});';
  const end = code.indexOf(endMark, i);
  assert.ok(end > i, '找不到 rec:audio-devices 的 catch 结尾');
  const chain = code.slice(i, end);
  /* 锁的是：「11a 清理回调的注册不在 rec:audio-devices 的 then 里」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/onCleanup/.test(chain),
    'onCleanup 仍写在 rec:audio-devices 的 then 里：枚举失败时清理不会注册，摄像头灯会一直亮');
  // 但必须仍然注册了（从全文件层面确认它没被删掉）
  const after = code.slice(end);
  /* 锁的是：「11a 清理回调的注册不在 rec:audio-devices 的 then 里」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/onCleanup[\s\S]{0,200}stopPreview/.test(after) || /onCleanup[\s\S]{0,200}stopPreview/.test(code),
    '停止预览的清理回调整体丢了');
});

t('11b 行为验证：rec:audio-devices reject 时清理回调仍被注册', async () => {
  /* 用桩模拟页面：invoke 对 rec:audio-devices 直接 reject，
   * 断言 onCleanup 仍然被调用了注册（旧写法会因为 .catch 吞掉而不执行）。 */
  const cleanups = [];
  const App = { onCleanup: (fn) => { cleanups.push(fn); } };
  let registered = false;
  const invoke = async (ch) => {
    if (ch === 'rec:audio-devices') throw new Error('ffmpeg 不可用');
    return {};
  };
  /* 旧写法（把注册放在 then 里）： */
  invoke('rec:audio-devices').then(() => { App.onCleanup(() => {}); registered = true; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(registered, false, '旧写法（then 内注册）在 reject 时确实没注册（前提成立）');
  assert.strictEqual(cleanups.length, 0, '旧写法确实一条清理都没注册');

  /* 新写法（注册在 then 之外）： */
  const cleanups2 = [];
  const App2 = { onCleanup: (fn) => cleanups2.push(fn) };
  invoke('rec:audio-devices').catch(() => {});          // 枚举自己失败，不影响下面
  App2.onCleanup(() => {});                              // 无条件注册
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(cleanups2.length, 1, '新写法应当在枚举失败时也注册清理');
});

t('11c 页面销毁后不再启动摄像头预览（避免迟到的 getUserMedia 亮灯不灭）', () => {
  const code = stripComments(readTree('js/tools/media'));
  const fn = extractFn(code, 'async function startPreview(');
  /* 锁的是：「11c 页面销毁后不再启动摄像头预览（避免迟到的 getUserMedia 亮灯不灭）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/destroyed/.test(fn), 'startPreview 里没有 destroyed 判断');
  /* 锁的是：「11c 页面销毁后不再启动摄像头预览（避免迟到的 getUserMedia 亮灯不灭）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const n = (fn.match(/destroyed/g) || []).length;
  assert.ok(n >= 3, 'destroyed 判断太少（至少要在入口、await 之后、拿到 stream 之后各查一次），实际 ' + n + ' 处');
  /* 锁的是：「11c 页面销毁后不再启动摄像头预览（避免迟到的 getUserMedia 亮灯不灭）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/getTracks\(\)[\s\S]{0,80}stop/.test(fn),
    '拿到 stream 后发现页面已销毁，必须把 track 停掉，否则摄像头一直亮着');
  /* 锁的是：「11c 页面销毁后不再启动摄像头预览（避免迟到的 getUserMedia 亮灯不灭）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/destroyed\s*=\s*true/.test(code), '清理回调里没有置 destroyed 标志');
});
t('7a rec:stop 的 GIF 目标：任何扩展名都不能与录像输出同名', () => {
  const f = extractGifTarget();
  const RE = /^\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|ts)$/i;
  for (const recOut of ['C:/r/rec.mp4', 'C:/r/rec.mkv', 'C:/r/rec.avi', 'C:/r/rec',
    'C:/r/rec.MP4', 'C:/a/b.c/rec', 'C:/r/rec.tar.gz', 'C:/r/v1.2', 'C:/r/.hidden']) {
    const gif = f(recOut, path, RE);
    assert.ok(path.resolve(gif).toLowerCase() !== path.resolve(recOut).toLowerCase(),
      recOut + ' 的 GIF 目标与录像同名（' + gif + '）—— ffmpeg 会读写同一文件，失败时还会把录像删掉');
  /* 锁的是：「7a rec:stop 的 GIF 目标：任何扩展名都不能与录像输出同名」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
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



/* ==================== 执行 ====================
 * done() 必须放在**最后**。
 * 【故障现场】这份文件原来把 done() 写在第 489 行，而 7a / 7b 两条用例
 * 定义在它后面 —— harness 在 done() 时就已经汇总退出，那两条压根没跑过。
 * 结果是「18 通过 / 0 失败」里少了 2 条，而报告上看不出任何异常。
 * 这与仓库里另一个已知坑同源：默认 deferred 模式下用例在 `t()` 注册时就
 * 立即执行，所以顺序是有语义的，不能随意摆放。 */
done();
