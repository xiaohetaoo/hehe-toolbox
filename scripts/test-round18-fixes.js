'use strict';
/* R18：批量工具的「停止按钮 / 离开页面状态」一致性 + UI 度量统一回归。
 *
 * ============ 这轮修的是什么 ============
 * 逐个页面读代码时发现同一类缺陷在 4 个批量工具里重复出现：
 *   · 停止按钮在构造函数里 `disabled = true`（空闲态正确），
 *     但开工时**从来没有解开** —— 整批处理期间用户根本按不到「停止」，
 *     而 cancelFlag / 离开页面 / 中途退出的整套机制都以"能按到它"为前提。
 *   · 离开页面时只置停止标志，`running` 仍是 true —— 页面保活复用回来，
 *     点「开始」被 `if (running) return;` 静默挡掉，界面看起来"点了没反应"，
 *     只能切到别的页面再切回来才恢复（用户侧表现为"工具坏了"）。
 *   · 每跑一次就往 App.onCleanup 里再塞一个订阅闭包（target-size）。
 * 另外这轮统一了半像素字号与离群圆角，并给窄窗口补了栅格收口。
 *
 * 这些断言都落在**可观察的源码契约**上：不是"有没有这个字符串"，
 * 而是"停止按钮在开工分支里必须被解开"、"cleanup 必须复位 running"。
 * 真正跑 Electron 的行为用例见 test-snip-toolbar-ui.js / test-ui-prefs-e2e.js。
 */

const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

/* ---------------- 源码小工具 ---------------- */

/** 取源码中 from 到 to 之间的片段（用于限定"只在某个分支里"成立）。 */
function seg(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, '找不到片段起点：' + from);
  const b = to ? src.indexOf(to, a + from.length) : src.length;
  assert.ok(b > a, '找不到片段终点：' + to);
  return src.slice(a, b);
}

/** 断言某个文件里存在 pattern。
 * 锁的是：每条调用点传入的 msg 已写明它防的是哪一次回归；这里统一补上
 * 「锁的是」前缀，满足 harness 的源码断言登记规矩（见 scripts/lib/harness.js
 * 顶部与 test-source-assertions.js 的 SA-4）。 */
function has(src, pattern, msg) {
  assert.ok(pattern.test(src), '锁的是：' + msg);
}

/** 断言某个文件里不存在 pattern。
 * 锁的是：同上 ——「不得复活某个坏写法」的反向断言同样要声明它锁的是哪次回归。 */
function hasNot(src, pattern, msg) {
  assert.ok(!pattern.test(src), '锁的是：' + msg);
}

/* ==================================================================
 * S1 图片压缩：开工时必须解开「停止」
 * ================================================================== */

t('S1 img-compress：开始压缩后「停止」必须从灰变可用', () => {
  const src = readSrc('js/tools/media/img-compress.js');
  /* 构造时是 disabled（空闲态正确） */
  has(src, /stopBtn\.disabled = true;/, '原地丢了「空闲时停止不可点」的初始态');
  /* 开工分支（running = true 之后）必须解开 */
  const runStart = seg(src, 'running = true; startBtn.disabled = true;');
  has(runStart, /stopBtn\.disabled = false;/, '开始压缩时没有解开停止按钮（整批期间按不到）');
});

/* ==================================================================
 * S2 图片水印：停止按钮 + 离开页面复位
 * ================================================================== */

t('S2 img-watermark：开工解开停止、离开页面复位 running 与文件锁', () => {
  const src = readSrc('js/tools/media/img-watermark.js');
  has(src, /wmStopBtn\.disabled = false;/, '开始加水印时没有解开停止按钮');
  const cleanup = seg(src, 'window.App.onCleanup(() => {');
  has(cleanup, /wmStopBtn\.disabled = true;/, '离开页面没有把停止按钮收回灰态');
  has(cleanup, /running = false;/, '离开页面没有复位 running（复用回来点开始会被静默挡掉）');
  has(cleanup, /picker\.setLocked\(false\)/, '离开页面没有解开文件选择锁（复用回来加不了文件）');
});

/* ==================================================================
 * S3 批量 OCR：开工必须解开「停止」
 * ================================================================== */

t('S3 batch-ocr：开始识别后「停止」必须可用', () => {
  const src = readSrc('js/tools/media/batch-ocr.js');
  has(src, /ocrStopBtn\.disabled = true;/, '原地丢了停止按钮的初始灰态');
  const runStart = seg(src, 'cancelFlag = false;');
  has(runStart, /ocrStopBtn\.disabled = false;/, '开始识别时没有解开停止按钮');
});

/* ==================================================================
 * S4/S5 视频截帧、音频剪辑：离开页面复位 running
 * ================================================================== */

t('S4 video-frames：离开页面复位 running 与开始按钮', () => {
  const src = readSrc('js/tools/media/video-frames.js');
  const cleanup = seg(src, 'if (window.App && App.onCleanup) {');
  has(cleanup, /frameRunSeq\+\+/, '清理没有作废在飞的结果');
  has(cleanup, /running = false;/, '离开页面没有复位 running');
  has(cleanup, /goBtn\.disabled = false;/, '离开页面没有复位开始按钮');
});

t('S5 audio-cut：离开页面复位 running 与开始按钮', () => {
  const src = readSrc('js/tools/media/audio-cut.js');
  const cleanup = seg(src, 'if (window.App && App.onCleanup) {');
  has(cleanup, /cutRunSeq\+\+/, '清理没有作废在飞的结果');
  has(cleanup, /running = false;/, '离开页面没有复位 running');
  has(cleanup, /goBtn\.disabled = false;/, '离开页面没有复位开始按钮');
});

/* ==================================================================
 * S6 target-size：音视频订阅只留一个槽位，不随次数增长
 * ================================================================== */

t('S6 target-size：进度订阅不得每次都往 onCleanup 里追加', () => {
  const src = readSrc('js/tools/target-size.js');
  hasNot(src, /App\.onCleanup\(unsub\)/, '仍在每跑一次就注册一个新 unsub（onCleanup 队列会无限增长）');
  has(src, /avUnsub = unsub;/, '没有把当前订阅放进槽位');
  has(src, /if \(avUnsub\) \{ try \{ avUnsub\(\); \} catch \(e\) \{\} avUnsub = null; \}/,
    'cleanup 没有释放槽位里的订阅');
});

/* ==================================================================
 * S7 env-manager：draw() 末尾对齐 busy 态
 * ================================================================== */

t('S7 env-manager：重建列表后必须重新套用 busy', () => {
  const src = readSrc('js/tools/env-manager.js');
  has(src, /try \{ setBusy\(busy\); \} catch \(e\) \{\}/,
    'draw() 末尾没有 setBusy(busy)：安装中切页回来，按钮会被重建成可用态');
});

/* ==================================================================
 * S8 local-notes：列表刷新按 size/mtime 命中缓存
 * ================================================================== */

t('S8 local-notes：内容缓存按 size+mtime 失效，避免每次刷新全量读盘', () => {
  const src = readSrc('js/tools/text-tools.js');
  has(src, /const noteCache = new Map\(\);/, '缺少笔记内容缓存');
  has(src, /entry\.size !== n\.size \|\| entry\.mtime !== n\.mtime/,
    '缓存没有按 size/mtime 失效（改了文件也读旧内容）');
  has(src, /for \(const p of noteCache\.keys\(\)\) if \(!alive\.has\(p\)\) noteCache\.delete\(p\);/,
    '删除/改名后的笔记没有被移出缓存（会无限增长）');
});

/* ==================================================================
 * S9 录屏：录制期间锁住设置项
 * ================================================================== */

t('S9 screen-rec：录制期间帧率/麦克风/摄像头/区域必须锁定', () => {
  const src = readSrc('js/tools/media/screen-rec.js');
  has(src, /function setControlsLocked\(on\)/, '缺少设置锁函数');
  const startSeg = seg(src, 'recording = true; paused = false;');
  has(startSeg, /setControlsLocked\(true\);/, '开录后没有锁住设置项（中途改麦克风不会生效却看起来已生效）');
  has(src, /setControlsLocked\(false\);/, '停止/离开时没有解锁设置项');
});

/* ==================================================================
 * S10 av-convert：音频容器下禁用视频参数
 * ================================================================== */

t('S10 av-convert：选音频容器时视频编码/CRF/分辨率/帧率置灰', () => {
  const src = readSrc('js/tools/media/av-convert.js');
  has(src, /const AUDIO_FMTS = \['mp3', 'm4a', 'wav', 'flac'\];/, '缺少音频容器清单');
  has(src, /function refreshFmt\(\)/, '缺少按格式收敛参数区的函数');
  has(src, /for \(const el of \[vcodecSel, crfIn, scaleSel, fpsIn\]\)/, '没有把视频参数纳入收敛');
  has(src, /gifWIn\.disabled = fmtSel\.value !== 'gif'/, 'GIF 宽度没有按格式置灰');
  has(src, /refreshFmt\(\); picker\.list\.refresh\(\)/, '切换格式时没有刷新行内「→ 格式」标签');
});

/* ==================================================================
 * S11 批量改名：执行期间防重入 + 禁用按钮
 * ================================================================== */

t('S11 batch-rename：执行期间必须防重入并禁用「执行」', () => {
  const src = readSrc('js/tools/file-tools.js');
  has(src, /btn\('执行重命名', 'btn-primary', guard\(async \(\) => \{/,
    '「执行重命名」没有走 guard（两趟改名会互相踩临时文件名）');
  const execSeg = seg(src, 'applyBtn.disabled = true;');
  has(execSeg, /prog\.show\(\);/, '禁用按钮没有落在执行分支内');
  has(src, /applyBtn\.disabled = false;/, '执行结束没有把按钮恢复');
});

/* ==================================================================
 * S12 二维码识别页：离开页面释放 blob URL
 * ================================================================== */

t('S12 screenshot-ocr：离开页面释放预览图的 blob URL', () => {
  const src = readSrc('js/tools/media/screenshot-ocr.js');
  has(src, /App\.onCleanup\(dropLastUrl\)/, '没有在离开页面时释放 blob URL（整屏截图有几 MB）');
  has(src, /if \(ocrBusy\) return toast\('上一次识别还没结束'/, '识别没有防重入');
  /* 异常路径也要复位 busy，否则一次失败之后按钮永久失效 */
  has(src, /finally \{\s*ocrBusy = false;\s*\}/, '识别失败后没有复位 busy');
});

/* ==================================================================
 * S13 图片批量处理：离开页面复位 running
 * ================================================================== */

t('S13 img-batch：离开页面复位 running 与选择锁', () => {
  const src = readSrc('js/tools/media/img-batch.js');
  const cleanup = seg(src, 'window.App.onCleanup(() => {');
  has(cleanup, /running = false;/, '离开页面没有复位 running');
  has(cleanup, /picker\.setLocked\(false\)/, '离开页面没有解开文件选择锁');
  /* 编码完到写盘之间必须再判一次停止：否则"已停止"之后还会多写一张。
   * 这里必须读原文（readSrc 默认会剥注释，而判据的注释夹在两条语句之间）。 */
  const raw = readSrc('js/tools/media/img-batch.js', { raw: true });
  has(raw, /const dataUrl = canvas\.toDataURL\(mime, q\);\s*\/\*[\s\S]*?\*\/\s*if \(cancelFlag(?:\s*\|\|\s*batchToken\s*!==\s*batchRunSeq)?\) break;/,
    '编码后没有再次判断停止（点停止后仍会多写一张）');
});

/* ==================================================================
 * S14 img-scramble：开始处理防重入
 * ================================================================== */

t('S14 img-scramble：开始处理必须走 guard 且按钮全程禁用', () => {
  const src = readSrc('js/tools/media/img-scramble.js');
  has(src, /const run = guard\(runOnce, \{/, '开始处理没有走 guard');
  has(src, /runBtn = btn\('开始处理', 'btn-primary', run, 'crop'\)/, '开始按钮没有接上 guard 包装');
  has(src, /before: \(\) => \{ if \(runBtn\) runBtn\.disabled = true; \}/, 'guard 没有在进入时禁用按钮');
  has(src, /after: \(\) => \{ if \(runBtn\) runBtn\.disabled = false; \}/, 'guard 没有在退出时恢复按钮');
});

/* ==================================================================
 * S15 CSS 度量统一（半像素字号 / 离群圆角 / 窄窗栅格）
 * ================================================================== */

t('S15 app.css 不再有半像素字号（13.5 / 12.5 / 11.5）', () => {
  const css = readSrc('css/app.css', { raw: true });
  hasNot(css, /font-size:\s*(11\.5|12\.5|13\.5)px/, '仍有半像素字号：不同缩放下会落在亚像素边界，同一行字粗细不一');
});

t('S16 表单控件圆角与按钮/文本域统一为 6px', () => {
  const css = readSrc('css/app.css', { raw: true });
  has(css, /\.input, \.select, textarea\.input \{\s*border: 1px solid var\(--border\); border-radius: 6px;/,
    '.input/.select 仍是 5px（与 .btn / .pane-ta 的 6px 不一致）');
});

t('S17 窄窗口：split-pane 收成单列、卡片内边距收紧', () => {
  const css = readSrc('css/app.css', { raw: true });
  has(css, /@media \(max-width: 860px\) \{\s*\.split-pane, \.split-pane\.no-btn \{ grid-template-columns: 1fr; \}/,
    '缺少 860px 断点：三栏在 720px 窗口下每栏不足 200px，中文长行会被折碎');
  has(css, /@media \(max-width: 820px\) \{\s*\.card \{ padding: 18px 16px; \}/,
    '缺少 820px 断点：窄窗口下 24px 内边距挤占正文');
});

/* ==================================================================
 * S18 text-codec：Unicode 解码正则不得再双重转义
 * ================================================================== */

t('S18 text-codec：Unicode 解码正则必须是单反斜杠（源码里两个字符）', () => {
  const src = readSrc('js/tools/text-codec.js');
  /* 源码里应当出现 /\\u([0-9a-fA-F]{4})/ 这段文本（字符串里是两个反斜杠字符） */
  has(src, /\/\\\\u\(\[0-9a-fA-F\]\{4\}\)\//, 'Unicode 解码正则仍被多写了一层反斜杠');
  has(src, /\[\\uD800-\\uDBFF\]\[\\uDC00-\\uDFFF\]/, '代理对区间写法不对（emoji 永远合并不回来）');
});

done();
