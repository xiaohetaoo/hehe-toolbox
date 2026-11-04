'use strict';
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const { handlerIndex } = require('./lib/seg-from-handler');
const mainSrc = readMain({ raw: true });

/* 断点续传下载的行为测试（原 test-round13 的 14a / 14b）。
 *
 * 锁的是两个会让重试永远失败的问题：
 *   14a  临时文件删不掉时只 rmSync 一次就放弃 → 下次下载撞上残留文件。
 *   14b  收到 416 不重置断点 → 重试永远 416（服务器说"你要的范围不存在"，
 *        因为本地记的进度比文件还长）。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

t('14a 下载取消：临时文件删除失败要重试，不能一次 rmSync 了事', () => {
  const seg = mainSrc.slice(mainSrc.indexOf('function downloadToFile'), handlerIndex(mainSrc, 'ffmpeg:download'));
  assert.ok(!/const cleanup = \(\) => \{ try \{ fs\.rmSync\(tmp, \{ force: true \}\); \} catch \(e\) \{\} \};/.test(seg),
    'cleanup 仍是一次性 rmSync：Windows 上写流句柄未释放会 EPERM，.part 文件残留且不在白名单里');
  assert.ok(/tryLater|setTimeout/.test(seg.slice(seg.indexOf('const cleanup'), seg.indexOf('const cleanup') + 900)),
    'cleanup 应有延迟重试');
});

t('14b 下载：416 必须重置断点，否则重试永远 416', () => {
  const seg = mainSrc.slice(mainSrc.indexOf('function downloadToFile'), handlerIndex(mainSrc, 'ffmpeg:download'));
  assert.ok(!/if \(r\.status === 416\) \{ res\(\); return; \}/.test(seg),
    '416 仍在被当成「已下载完整」—— 本地文件偏短时每一轮都 416，6 次重试后必定失败');
  const m = seg.match(/if \(r\.status === 416\) \{[\s\S]{0,200}?\}/);
  assert.ok(m, '找不到 416 分支');
  assert.ok(/got = 0/.test(m[0]), '416 分支必须把断点清零（下一轮从头下）');
});

/* ==================== 15. 截帧计数 ==================== */

done();
