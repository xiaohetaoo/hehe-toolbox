'use strict';
/* 第十三轮用户报的 9 组缺陷的回归测试（P1 保活生命周期在 test-keepalive.js KA-10~16）。
 *
 * ============ 每条锁的是哪个回归 ============
 * D1 视频压制「限 N p」会放大源视频 —— 1280×720 选「限 1080p」输出 1920×1080。
 * D2 图片压缩 target/smart 把小图压大 —— 100KB 源 + 200KB 目标输出 150~190KB。
 * D3 批量重命名「还原也失败」仍标 done —— 文件永久留在 .hehe-ren-*。
 * D4 清理安装包把删除失败计成功，并可能删掉进行中的下载/校验包。
 * D5 下载页 job:stream 订阅泄漏（每次 start 都 subscribe，旧的不退）。
 * D6 静态服务器 index.html 符号链接未二次 realpath（可读 root 外文件）。
 * D7 removeEntries 全删且原值以分号结尾时返回 ";"（空 PATH 项 = 当前目录）。
 * D8 video-trim 实际更短时仍说「长了」。
 */

const assert = require('assert');
const { t, done, readSrc, readMain } = require('./lib/harness');
const envPath = require('../lib/env-path');
const imgPick = require('../lib/img-pick');

/* ---------------- D1 视频压制只降不升 ---------------- */

/* 锁的是 D1：限分辨率不得放大、不得拉宽竖屏、宽高必须偶数。
 * 【本项的行为验证在 test-round14-fixes.js 的 S1-1】
 * 那里用真 ffmpeg 编码五组验收尺寸并读实际宽高（1080×1920 / 720×1280 /
 * 3840×2160 / 1280×720 / 1919×1080），是行为断言，不再锁参数串。
 * 这里只保留一条"实现没退回旧写法"的守卫 —— 旧写法 `scale=N:-2` 会
 * 放大竖屏（实测输出 1920×3414），是这条回归的原始形态。 */
t('D1-1 视频压制不得退回会放大的旧 scale 写法', () => {
  const s = readSrc('ipc/media-ffmpeg.js');
  /* 锁的是：退回 `scale=${opts.scale}:-2`（竖屏被拉宽、小源被放大）。 */
  assert.ok(!/scale=\$\{opts\.scale\}:-2/.test(s),
    '仍存在会放大的旧写法 scale=${opts.scale}:-2');
  /* 锁的是：缺少方框缩放三要素中的任何一个（放大/奇数编码失败会复发）。 */
  assert.ok(/force_original_aspect_ratio=decrease/.test(s), '缺少 decrease（会放大）');
  assert.ok(/force_divisible_by=2/.test(s), '缺少 force_divisible_by=2（奇数宽高编码失败）');
});

/* 锁的是 D1 的 UI 文案与语义一致（悬停说明"只缩小不放大"）。
 * 【文案缩短过】原来在下拉项里写「限 1080p（长边≤1920）」，窄窗会把这一行挤爆、
 * 出现控件孤行；细则移到了 title。这条锁的是"解释仍然存在"。 */
t('D1-2 视频压制分辨率控件必须说明「只缩小不放大」', () => {
  const s = readSrc('js/tools/media/video-press.js');
  /* 锁的是：说明文字被整体删掉（用户不知道小源会不会被放大）。 */
  assert.ok(/只缩小不放大/.test(s), '缺少「只缩小不放大」的说明');
  /* 锁的是：说明仍塞在下拉项正文里（窄窗挤行）。 */
  assert.ok(!/限 1080p（/.test(s), '下拉项正文仍带长括号说明（窄窗会挤行）');
});

/* ---------------- D2 图片压缩不输出更大的文件 ---------------- */

/* 锁的是 D2 的纯逻辑：原图已达标时直接保留。 */
t('D2-1 target 模式原图已达标应保留原图（shouldKeepOriginal）', () => {
  /* 锁的是：去掉「原图 ≤ 目标」这条判断 —— 100KB 源 + 200KB 目标会被
   * encodeTarget 找到 150~190KB 的候选写盘，文件反而变大。 */
  assert.strictEqual(imgPick.shouldKeepOriginal(100 * 1024, 200 * 1024), true);
  assert.strictEqual(imgPick.shouldKeepOriginal(300 * 1024, 200 * 1024), false);
  assert.strictEqual(imgPick.shouldKeepOriginal(200 * 1024, 200 * 1024), true, '正好相等也算达标');
  /* 非法输入一律不判达标（避免除零/NaN 造成"已达标"误判） */
  assert.strictEqual(imgPick.shouldKeepOriginal(0, 200), false);
  assert.strictEqual(imgPick.shouldKeepOriginal(NaN, 200), false);
  assert.strictEqual(imgPick.shouldKeepOriginal(100, NaN), false);
});

/* 锁的是 D2：候选必须真的比原图小才采用。 */
t('D2-2 候选不比原图小时必须保留原图（decideOutcome）', () => {
  const orig = 100 * 1024;
  /* 锁的是：候选更大仍然写盘（"压缩"把文件变大）。 */
  assert.strictEqual(imgPick.decideOutcome({ origBytes: orig, candidate: { bytes: 150 * 1024 } }).useOriginal, true);
  /* 相等：也不该采用（换了编码却没变小，白丢画质） */
  assert.strictEqual(imgPick.decideOutcome({ origBytes: orig, candidate: { bytes: orig } }).useOriginal, true);
  /* 候选确实更小：采用 */
  assert.strictEqual(imgPick.decideOutcome({ origBytes: orig, candidate: { bytes: 80 * 1024 } }).useOriginal, false);
  /* target 模式且原图已达标：标 alreadyFits */
  const r = imgPick.decideOutcome({ origBytes: orig, mode: 'target', targetBytes: 200 * 1024, candidate: { bytes: 150 * 1024 } });
  assert.strictEqual(r.useOriginal, true);
  assert.strictEqual(r.alreadyFits, true, '原图已达标时要标 alreadyFits（界面显示「已达标」）');
});

/* 锁的是 D2：smart 模式在多个候选里挑「最小且比原图小」的。 */
t('D2-3 chooseCandidate 只返回比原图小的候选，否则 null', () => {
  const orig = 100 * 1024;
  /* 锁的是：两个候选都比原图大时返回了候选（会写更大的文件）。 */
  assert.strictEqual(imgPick.chooseCandidate([{ bytes: 120 * 1024 }, { bytes: 110 * 1024 }], orig), null);
  /* 只挑最小的那个 */
  const best = imgPick.chooseCandidate([{ bytes: 90 * 1024 }, { bytes: 70 * 1024 }], orig);
  assert.ok(best && best.bytes === 70 * 1024, '应挑最小的候选');
  /* 混着选：只在小候选里挑 */
  const mix = imgPick.chooseCandidate([{ bytes: 150 * 1024 }, { bytes: 80 * 1024 }], orig);
  assert.ok(mix && mix.bytes === 80 * 1024);
});

/* 锁的是 D2：渲染层确实调用了判据（不是只写了 lib 不接线）。 */
t('D2-4 图片压缩页必须接入 ImgPick 判据并做写盘后兜底', () => {
  const s = readSrc('js/tools/media/img-compress.js');
  /* 锁的是：判据写了但没接线 —— 缺陷照旧。 */
  assert.ok(/ImgPick/.test(s), '图片压缩页没有接入 window.ImgPick');
  /* 锁的是：写盘后不再用实测 newSize 兜底（可能是判据漏了某种情况）。 */
  assert.ok(/newSize > orig/.test(s), '缺少写盘后 newSize > orig 的兜底校验');
  /* 锁的是：原图达标时标签仍显示 0% 而不是「已达标」。 */
  assert.ok(/已达标/.test(s), '缺少「已达标」标签');
});

/* ---------------- D3 重命名还原失败不能丢登记 ---------------- */

/* 锁的是 D3：还原失败时必须保留登记（done 不置真）。 */
t('D3-1 重命名失败且还原也失败时，登记必须保留 done=false', () => {
  const s = readSrc('js/tools/file-tools.js');
  /* 锁的是：catch 里无条件 reg.done = true ——
   * 文件永久留在 .hehe-ren-*，恢复页（只筛 !x.done）再也看不到它。 */
  assert.ok(/if \(reg && restored\) reg\.done = true/.test(s),
    '必须只有还原成功才标 done —— 无条件置真会让文件永久失联');
  /* 锁的是：第二个错误被空 catch 吞掉（用户不知道文件卡在临时名上）。 */
  assert.ok(/无法还原原名/.test(s), '还原失败的错误必须合并进失败提示，不能吞');
  /* 锁的是：提示里没有给出恢复入口（用户不知道去哪救）。 */
  assert.ok(/重命名恢复/.test(s), '失败提示必须告诉用户可在重命名恢复里处理');
});

/* 锁的是 D3：恢复页的筛选条件仍是「有 tmp 且未完成」。 */
t('D3-2 恢复页筛选条件必须能列出「还原失败的」条目', () => {
  const s = readSrc('js/tools/file-tools.js');
  /* 锁的是：筛选条件改成只看 done 或加了额外限制 ——
   * 还原失败的条目（tmp 存在、done=false）会被漏掉。 */
  assert.ok(/x\.tmp && !x\.done/.test(s), '恢复页筛选条件必须包含 x.tmp && !x.done');
});

/* ---------------- D4 清理安装包 ---------------- */

/* 锁的是 D4：rm 失败不能计入成功。 */
t('D4-1 清理时只有真删掉才计 removed/freed，失败进 errors', () => {
  const s = readSrc('ipc/env-manager.js');
  /* 锁的是：退回 `rm(...).catch(() => {})` + 无条件 removed++ ——
   * 文件被占用时报告「已清理 N 个」，实际一个没删。 */
  assert.ok(/errors\.push/.test(s), '删除失败必须收集到 errors 并在界面提示');
  /* 锁的是：没有 try 包裹 rm（失败会直接冒泡成整个清理失败）。 */
  assert.ok(/await fsp\.rm\(full, \{ force: true \}\)/.test(s), 'rm 调用形态变化，需重新确认失败处理');
});

/* 锁的是 D4：清理必须跳过活动中的下载分片与安装包。 */
t('D4-2 清理必须跳过活动中的包与分片（不依赖渲染层 busy）', () => {
  const s = readSrc('ipc/env-manager.js');
  /* 锁的是：没有活动文件集合 —— 另一个窗口点清理会删掉正在解压的包。 */
  assert.ok(/activeEnvFiles/.test(s), '没有 activeEnvFiles 集合，无法判断哪些包正在用');
  /* 锁的是：清理循环里没有跳过判断。 */
  assert.ok(/isActiveEnvFile\(ent\.name\)/.test(s), 'CLEAN 循环没有跳过活动文件');
  /* 锁的是：分片前缀判据被删（<archive>.part-* 会被当成普通缓存删掉）。 */
  assert.ok(/\.part-/.test(s), '缺少分片前缀判据 —— 活动下载的分片会被删');
  /* 锁的是：安装结束时忘记注销（缓存永远不许清）。 */
  assert.ok(/activeEnvFiles\.delete/.test(s), '安装结束必须注销活动登记');
});

/* 锁的是 D4 的下载侧：分片被外部删掉时不能覆盖真实死因。 */
t('D4-3 下载重试时 stat 失败不得掩盖原始错误', () => {
  const s = readSrc('lib/download.js');
  /* 锁的是：退回裸 `got = (await stat(tmp)).size` ——
   * 分片被删时抛 ENOENT，把真正的下载失败原因盖掉。 */
  assert.ok(/catch \(statErr\)/.test(s), 'stat 失败必须单独捕获，不能覆盖原错误');
  /* 锁的是：捕获后没有把偏移归零（下一轮会从错误的偏移续传）。 */
  assert.ok(/got = 0/.test(s), '分片丢失时必须把偏移归零');
});

/* ---------------- D5 下载页订阅泄漏 ---------------- */

/* 锁的是 D5：一个页面同时最多一个 job:stream 订阅。 */
t('D5-1 下载页的订阅必须可退订，且 start 开头先退旧的', () => {
  const s = readSrc('js/tools/net-tools.js');
  /* 锁的是：没有统一的 unsub 槽位（用局部变量，退订时拿不到引用）。 */
  assert.ok(/let jobId = null, unsub = null;/.test(s), '缺少 unsub 槽位');
  /* 【必须锚到下载页的 start】net-tools.js 里有多个 "async function start()"
   * （ping 页也有一个，且它排在前面）。下载页的状态声明位置是锚点，
   * 从它向后找**第一个** start 就是下载页的。 */
  const anchor = s.indexOf('let jobId = null, unsub = null;');
  assert.ok(anchor > 0, '找不到下载页的状态声明');
  const i = s.indexOf('async function start()', anchor);
  assert.ok(i > anchor, '从下载页状态声明向后找不到它的 start');
  const seg = s.slice(i, i + 900);
  /* 锁的是：start 开头没有退旧订阅 —— 同一页面会有两个监听器同时认领事件。
   * 实现用的是内联 `if (unsub) { ... unsub = null; }`（不用 dropSub，
   * 因为 start 会被测试单独抠出来求值，必须自包含）。 */
  assert.ok(/if \(unsub\) \{ try \{ unsub\(\); \} catch \(e\) \{\} unsub = null; \}/.test(seg),
    'start 开头必须先退旧订阅，否则订阅叠加');
  /* 锁的是：done 分支不退订（任务结束后监听器一直挂着）。 */
  assert.ok(/if \(j\.done\)/.test(s), '找不到 j.done 分支');
  const doneIdx = s.indexOf('if (j.done)');
  const doneSeg = s.slice(doneIdx, doneIdx + 700);
  /* 锁的是：j.done 里忘记退订（每次下载留一个监听器）。 */
  assert.ok(/unsub = null/.test(doneSeg), 'j.done 分支必须退订并置空');
});

/* 锁的是 D5 的复用侧。
 * 【已从 pageDead 改为 per-run token】布尔复位的方案被用户明确否决：
 * 「开始下载后立刻切走」时 invoke 还没返回、jobId 仍是 null，cleanup 杀不到；
 * 返回时 pageDead 已被 onEnter 复位，那个 job 就漏杀了。
 * token 方案下旧请求返回时序号必然不等 → 无条件 kill 自己拿到的 id。
 * 行为层的完整验证在 test-round14-fixes.js 的 S7-1。 */
t('D5-2 下载页必须用 per-run token 而不是布尔 pageDead', () => {
  const s = readSrc('js/tools/net-tools.js');
  /* 锁的是：退回布尔 pageDead 方案（存在"切走后 invoke 才返回"的漏杀窗口）。 */
  assert.ok(!/pageDead = false/.test(s), '仍用布尔 pageDead 复位（会漏杀孤儿下载）');
  /* 锁的是：没有 per-run 序号，旧请求无法判断自己是否过期。 */
  assert.ok(/downloadRunSeq/.test(s), '缺少 downloadRunSeq');
  assert.ok(/runToken !== downloadRunSeq/.test(s), '缺少"这份结果是否过期"的判定');
});

/* 锁的是 D6：目录追加 index.html 后必须再走一次包含检查。 */
t('D6-1 静态服务器必须用 resolveInsideRoot 统一做包含检查', () => {
  const s = readMain({ raw: true });
  /* 锁的是：退回「目录分支只 stat 不 realpath」——
   * root 里放一个指向外部的 index.html 链接就能读外部文件。 */
  assert.ok(/resolveInsideRoot/.test(s), '没有抽 resolveInsideRoot 辅助函数');
  /* 锁的是：目录分支没有二次调用包含检查。 */
  assert.ok(/realFp = resolveInsideRoot\(idx\)/.test(s), '目录追加 index.html 后没有二次 realpath 检查');
  /* 锁的是：缺少 isFile 判据（目录/设备会被当文件吐出去）。 */
  assert.ok(/!st\.isFile\(\)/.test(s), '最终目标必须是普通文件（isFile）');
});

/* ---------------- D7 removeEntries 空结果 ---------------- */

/* 锁的是 D7：全删空时不能返回 ";"。 */
t('D7-1 removeEntries 全删空必须返回空字符串', () => {
  /* 锁的是：`kept.join(';') + (trailing ? ';' : '')` 在 kept 为空时
   * 返回 ";"。Windows 把空 PATH 项当**当前目录**，等于把当前目录
   * 塞进搜索路径（安全与正确性问题）。 */
  const r1 = envPath.removeEntries('C:\\tools\\node;', ['C:\\tools\\node']);
  assert.strictEqual(r1.value, '', '全删 + 尾分号时应返回空字符串，实际 ' + JSON.stringify(r1.value));
  const r2 = envPath.removeEntries('C:\\tools\\node', ['C:\\tools\\node']);
  assert.strictEqual(r2.value, '', '全删 + 无尾分号时应返回空字符串');
});

/* 锁的是 D7：部分删除时其余项与尾分号行为不变。 */
t('D7-2 removeEntries 部分删除不得影响其他项', () => {
  /* 锁的是：修全删分支时误伤了正常路径。 */
  const r = envPath.removeEntries('C:\\a;C:\\tools\\node;', ['C:\\tools\\node']);
  assert.strictEqual(r.value, 'C:\\a;', '部分删除应保留尾分号');
  const r2 = envPath.removeEntries('C:\\a;C:\\tools\\node', ['C:\\tools\\node']);
  assert.strictEqual(r2.value, 'C:\\a', '无尾分号时不该凭空加');
  /* 大小写不敏感匹配（Windows 路径语义） */
  const r3 = envPath.removeEntries('C:\\A;C:\\Tools\\Node;', ['c:\\tools\\node']);
  assert.strictEqual(r3.value, 'C:\\A;', '删除必须大小写不敏感');
});

/* ---------------- D8 video-trim 方向文案 ---------------- */

/* 锁的是 D8：文案方向必须与带符号差值一致。 */
t('D8-1 video-trim 必须按带符号差值说「长了/短了」', () => {
  const s = readSrc('js/tools/media/video-trim.js');
  /* 锁的是：退回 Math.abs + 固定「长了」——
   * 快速模式吸附关键帧后实际常更短，界面却说长了。 */
  assert.ok(/const drift = r\.duration \? \(r\.duration - du\) : 0/.test(s),
    'drift 必须是带符号差值（r.duration - du），不能用 Math.abs');
  /* 锁的是：缺少「短了」分支。 */
  assert.ok(/短了/.test(s), '缺少「短了」文案');
  /* 锁的是：缺少「长了」分支。 */
  assert.ok(/长了/.test(s), '缺少「长了」文案');
  /* 锁的是：阈值判断被删（差 0.01 秒也提示，噪声很大）。 */
  assert.ok(/Math\.abs\(drift\) > 0\.15/.test(s), '阈值判断必须保留（0.15 秒内不提示）');
});

done();
