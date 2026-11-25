'use strict';
/* R19：大 IPC 文件逐行通读后的回归（fs-ops / media-ffmpeg / dir-move / 电源门禁 / 测速）。
 *
 * 这批修复的共同点：**旧写法在正常路径上看起来是对的**，只有慢盘、相对路径、
 * 超限条目、进程异常交错、无人响应这些边角才暴露，而且大多没有界面提示。
 * 行为用例（真实调用 handler）尽量放在对应的 test-*.js 里；
 * 这里只锁「源码契约」——那些没法在单测里造出来的条件（20 万条目、
 * 慢盘写入滞后、解压中断、进程被杀）。
 */

const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

/** 断言文件里存在 pattern。
 * 锁的是：每条 msg 已写明它防的是哪一次回归；统一加「锁的是」前缀，
 * 满足 test-source-assertions 的 SA-4 登记规矩。 */
function has(src, pattern, msg) { assert.ok(pattern.test(src), '锁的是：' + msg); }
/** 断言文件里不存在 pattern。
 * 锁的是：反向断言同样要说明它防止哪个坏写法复活。 */
function hasNot(src, pattern, msg) { assert.ok(!pattern.test(src), '锁的是：' + msg); }

/** 取两段文本之间的片段（限定"只在这个分支里"成立）。 */
function seg(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, '找不到片段起点：' + from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, '找不到片段终点：' + to);
  return src.slice(a, b);
}

/* ==================================================================
 * S1 fs-ops：扫描必须用归一后的根遍历
 * ================================================================== */

t('S1 fs-ops：scan-tree 的遍历参数必须是 scanRoot（不是原始 root）', () => {
  const src = readSrc('ipc/fs-ops.js');
  const blk = seg(src, 'CH.FS.SCAN_TREE', 'CH.FS.SCAN_EMPTY_DIRS');
  /* 锁的是：相对根聚合失效 —— 遍历用 root 得到相对 item.path，
   * 聚合键是绝对 scanRoot，逐目录体积全部为 0（行为用例在 test-scan-tree 17d）。 */
  has(blk, /walkDir\(scanRoot, \{ maxDepth/, 'scan-tree 又改用原始 root 遍历（相对根下目录体积会归零）');
  hasNot(blk, /walkDir\(root, \{ maxDepth/, 'scan-tree 遍历用回了未归一的 root');
});

t('S2 fs-ops：空目录扫描与查重也必须用归一后的根', () => {
  const src = readSrc('ipc/fs-ops.js');
  const empty = seg(src, 'CH.FS.SCAN_EMPTY_DIRS', 'CH.FS.SPLIT_FILE');
  /* 锁的是：相对路径清单被渲染层原样送回 delete-empty / delete，
   * 主进程按 cwd 解析 → 一个也删不掉。行为用例见 test-scan-tree 17e。 */
  has(empty, /rec\(scanRoot, 0\)/, '空目录扫描丢了归一（清单会全是相对路径）');
  const ded = seg(src, 'CH.FS.DEDUPE', 'CH.ZIP.COMPRESS');
  has(ded, /walkDir\(scanRoot, \{ _cancelRef/, '查重丢了归一（结果路径会相对 cwd 解析）');
});

/* ==================================================================
 * S3 fs-ops：分片边界按"已排入写流"的字节数
 * ================================================================== */

t('S3 fs-ops：分片换片判据必须是 partBytes，不能是 ws.bytesWritten', () => {
  const src = readSrc('ipc/fs-ops.js');
  const blk = seg(src, 'CH.FS.SPLIT_FILE', 'CH.FS.MERGE_PARTS');
  /* 锁的是：ws.bytesWritten 只统计已落盘字节（Node 文档明确不含写队列），
   * 慢盘上滞后 → 同一片多塞 chunk，用户选 1MB 拿到 2MB 的片。
   * 行为用例：test-split-stream 13c（2.5MB → 1MB/1MB/0.5MB）。 */
  has(blk, /if \(partBytes >= chunkSize\)/, '换片判据不再用自记的 partBytes');
  has(blk, /chunkSize - partBytes/, '每片剩余额度不再按 partBytes 计算');
  hasNot(blk, /ws\.bytesWritten >= chunkSize/, '换片又读回 ws.bytesWritten（慢盘会越界）');
});

/* ==================================================================
 * S4 media-ffmpeg：录屏无分段早退必须复位会话
 * ================================================================== */

t('S4 media-ffmpeg：REC.STOP 无分段时复位 recOpts 并清理空目录', () => {
  const src = readSrc('ipc/media-ffmpeg.js');
  const blk = seg(src, 'if (!recSegs.length)', 'let degraded = null;');
  /* 锁的是：早退分支直接 return，recOpts 留着 → 下次开始录制被
   * 「已有录制会话进行中」挡住，只能重启应用。 */
  has(blk, /recOpts = null; recSegs = \[\]; recSegDir = null; recOwner = null; recDeath = null;/, '早退分支没有复位录制会话状态');
  has(blk, /fsp\.rm\(emptyDir/, '早退分支留下了空的录屏分段目录');
});

t('S5 media-ffmpeg：下载/挑选的 ffmpeg 必须"先临时名再改名"', () => {
  const src = readSrc('ipc/media-ffmpeg.js');
  /* 锁的是：直接 writeFileSync/copyFile 到 bin/ffmpeg.exe，写到一半失败
   * 会留下半截 exe，而检测只看"文件存在"→ 之后所有转码都失败。 */
  has(src, /tempNames\.writeTmp\(dest, 'ffdl'/, 'gz 解压产物又直接覆盖 bin/ffmpeg.exe');
  has(src, /tempNames\.writeTmp\(dest, 'ffpick'/, '手动挑选的 ffmpeg.exe 复制又没走原子改名');
  has(src, /tempNames\.writeTmp\(dest, 'ffpick2/, '备用名分支的 ffmpeg.exe 复制又没走原子改名');
  has(src, /finally \{\s*fs\.rmSync\(tmp, \{ force: true \}\);\s*\}/, '解压失败的临时 gz 不再清理（%TEMP% 会留几十 MB）');
});

/* ==================================================================
 * S6 dir-move：超限链接必须从复制阶段补回来
 * ================================================================== */

t('S6 dir-acl-links：预检链接超限时，用复制阶段实际遇到的链接补齐', () => {
  const src = readSrc('ipc/dir-acl-links.js');
  /* 锁的是：collectLinks 的 20 万条上限截断后，复制阶段照样跳过链接，
   * 但恢复清单只来自预检 → 目标侧静默少掉一批链接，全流程不报错。
   * 现在 copyTreeExcludingLinks 把遇到但不在 skip 集合里的链接记进 stats.links，
   * dirMoveRun 再与预检结果按小写路径去重合并。 */
  has(src, /stats\.links\.push\(srcChild\)/, '复制阶段不再记录漏出预检清单的链接');
  has(src, /for \(const l of treeLinks\.links\.concat\(cpStats\.links \|\| \[\]\)\)/, '恢复清单不再合并复制阶段的链接');
  has(src, /linkNatures\(mergedLinks\)/, '链接性质判定没有用合并后的完整清单');
  has(src, /restoreLinksIntoTarget\(srcAbs, dstAbs, mergedLinks/, '链接重建没有用合并后的完整清单');
});

/* ==================================================================
 * S7 path-guard：另一个用户的家目录深处
 * ================================================================== */

t('S7 path-guard：删除与覆盖都拦"另一个用户 home 深处"', () => {
  const src = readSrc('lib/path-guard.js');
  /* 锁的是：Users 的「本身 + 一层」豁免被套到别人的 Documents 上，
   * 共享电脑/管理员场景可以递归删掉另一个用户的文档。
   * 行为用例：test-path-guard 25e。 */
  has(src, /function inOtherUserHome\(lower, b\)/, 'inOtherUserHome 判定丢失');
  const del = seg(src, 'function checkDeletable', 'function checkOverwritable');
  has(del, /inOtherUserHome\(normalizeForCompare\(abs\), ub\)/, '删除侧没有拦另一个用户的家目录深处');
  const ow = seg(src, 'function checkOverwritable', 'module.exports');
  has(ow, /inOtherUserHome\(normalizeForCompare\(abs\), usersBoundary\(\)\)/, '覆盖侧没有拦另一个用户的家目录深处');
});

/* ==================================================================
 * S8 power-gate：计划任务 / WMI 关机入口
 * ================================================================== */

t('S8 power-gate：schtasks/at/WMI 三种"参数里关机"的形态必须命中', () => {
  const src = readSrc('lib/power-gate.js');
  /* 锁的是：主判据只看可执行位首词，而关机动作可以藏在参数里：
   *   schtasks /create ... /tr "shutdown /s"
   *   at 23:59 shutdown /s
   *   Invoke-CimMethod -MethodName Shutdown / .Win32Shutdown(2)
   * 这些首词都无害，旧实现整条放行。行为用例：test-powergate 的 mustBlock。 */
  has(src, /const SCHEDULER_HEADS = new Set\(/, '计划任务入口判定丢失');
  has(src, /const WMI_METHOD_HEADS = new Set\(/, 'WMI 入口判定丢失');
  has(src, /if \(head === 'at'\) \{\s*if \(POWER_VERB_RE\.test\(seg\)\) return true;/, 'at + 关机动词的判定丢失');
  has(src, /new-scheduledtaskaction\/i\.test\(seg\) \|\| head === 'new-scheduledtaskaction'/, 'schtasks /tr + 关机动词的判定丢失');
  has(src, /\.win32shutdown\\s\*\\\(/, 'PowerShell 直接调 Win32Shutdown 的判定丢失');
  has(src, /'psshutdown'/, 'psshutdown 未登记为危险工具');
});

/* ==================================================================
 * S9 net-lan：测速硬超时
 * ================================================================== */

t('S9 net-lan：测速必须有独立于"收到数据"的硬超时', () => {
  const src = readSrc('ipc/net-lan.js');
  /* 锁的是：下行只在收到数据时检查 seconds，服务器挂住连接就不结束；
   * 上行 fetch 无超时。硬超时必须夹住 seconds（Infinity → setTimeout 立刻触发）。
   * 这里不切片段：hardStop 与 clearTimeout 只出现在测速的 finally 里。 */
  has(src, /const sec = Math\.min\(120, Math\.max\(1, Number\(seconds\) \|\| 10\)\);/, 'seconds 没有夹到 1..120（Infinity 会让超时立刻触发）');
  has(src, /const hardStop = setTimeout\(\(\) => \{ timedOut = true; ctrl\.abort\(\); \}/, '没有测速硬超时');
  has(src, /clearTimeout\(hardStop\)/, '硬超时定时器没有在所有出口清理');
});

/* ==================================================================
 * S10 expr-eval：常量后的百分号
 * ================================================================== */

t('S10 expr-eval：百分号判定的「左侧操作数结尾」必须包含常量', () => {
  const src = readSrc('lib/expr-eval.js');
  /* 锁的是：prev 只认 num / ) / %，`pi%`、`e%` 被当取余 → parser 报
   * 「表达式不完整」。行为用例：test-expr-eval 30。 */
  has(src, /prev\.t === 'num' \|\| prev\.t === 'const'/, '常量不再被当成操作数结尾（pi% 会报错）');
});

/* ==================================================================
 * S11 冒烟布局断言：像素比较必须容忍亚像素
 * ================================================================== */

t('S11 冒烟布局：getComputedStyle 的 px 值不能用字符串全等', () => {
  const src = readSrc('main.js');
  /* 锁的是：Windows 125% 缩放下 Chromium 会报 37.9921px / 179.995px，
   * 字符串全等把正确布局判成 LAYOUT 失败（本机冒烟实测命中）。
   * pxNear 必须同时被 expect 和卡片图标检查使用。 */
  has(src, /const pxNear = \(got, want\) => \{/, '冒烟没有 pxNear 容差助手');
  has(src, /got !== want && !pxNear\(got, want\)/, 'expect 又退回字符串全等');
  has(src, /!pxNear\(getComputedStyle\(icon\)\.width, '38px'\)/, '卡片图标检查又退回字符串全等');
});

/* ==================================================================
 * S12/S13 剪贴板面板：弹窗复位 + 图片必须先落盘再入队
 * ================================================================== */

t('S12 剪贴板面板：空态与路径属性弹窗关闭后必须清掉 modalEl', () => {
  const src = readSrc('js/clip-actions.js');
  /* 锁的是：没有 onClose 时，Esc/点遮罩关掉后 modalEl 仍指向已销毁实例，
   * 下一次 Ctrl+Shift+V 会走「再按一次就收起」分支，面板永远打不开。
   * 空剪贴板与路径属性两屏都必须清。 */
  const hits = (src.match(/onClose: \(\) => \{ modalEl = null; \}/g) || []).length;
  assert.ok(hits >= 2, '锁的是：两处弹窗都要 onClose 清空 modalEl（实际 ' + hits + ' 处）');
});

t('S13 剪贴板图片：先 SAVE_IMAGE 落盘，不能把 dataUrl 塞进 paths:[] 队列', () => {
  const src = readSrc('js/app.js');
  /* 锁的是：DropOpen.takePending 只返回 paths/exts，旧写法
   * { paths: [], dataUrl } 会让图片内容在交接时静默丢失。 */
  has(src, /Ch\.CLIP\.SAVE_IMAGE/, '没有调用 clip:save-image 落盘');
  has(src, /paths: \[r\.path\]/, '落盘后没有把返回路径放进 paths');
  /* 锁的是：又退回「空 paths + dataUrl」这种会被 takePending 丢掉的交接。 */
  assert.ok(!/paths: \[\], exts: \[\], dataUrl/.test(src),
    '锁的是：又退回「空 paths + dataUrl」的无效交接');
});

done();
