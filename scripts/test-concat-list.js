'use strict';
/* concat 清单行转义（lib/fs-ops.js concatFileLine）的行为测试。
 *
 * ============ 锁的是哪个历史回归 ============
 * 录制分段目录在 %TEMP% 下，路径含 Windows 用户名。用户名带单引号
 * （O'Brien 这类）时，旧实现 `file '<路径>'` 不转义单引号，清单在引号处
 * 提前闭合 → ffmpeg concat 失败 → 暂停过的录制降级成「只保住第一段」。
 * 第二轮审查真跑 ffmpeg 复现（未转义 FAIL / 闭合引号式 OK）。
 *
 * ============ 为什么这样测 ============
 * 纯函数部分直接断言转义结果（行为断言，不读源码）。
 * 转义形态对不对，最终由真 ffmpeg 说了算 —— 所以装了 ffmpeg 的机器上
 * 再造一个含单引号的目录真跑一遍 concat；没装就 SKIP 这一段（与
 * test-video-trim 一致），纯函数断言仍然跑。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { t, done } = require('./lib/harness');
const { concatFileLine } = require('../lib/fs-ops');
const { detectFfmpeg } = require('./lib/load-media-ffmpeg');

t('CL-1 普通路径：正斜杠 + 单引号包裹', () => {
  assert.strictEqual(concatFileLine('C:\\rec\\seg-1.mp4'), "file 'C:/rec/seg-1.mp4'");
  assert.strictEqual(concatFileLine('/tmp/seg 2.mp4'), "file '/tmp/seg 2.mp4'");
});

t('CL-2 单引号路径：闭合引号式转义（实测唯一可用的引号形态）', () => {
  /* 锁的是：改回「引号内 \'」—— 单引号内反斜杠是字面量，concat 不认，
   * 真跑 ffmpeg 已证 FAIL。正确形态是 '…'\''…'（闭合+转义引号+重开）。 */
  assert.strictEqual(concatFileLine("C:\\Users\\O'Brien\\seg.mp4"),
    "file 'C:/Users/O'\\''Brien/seg.mp4'");
  /* 多个单引号都要转 */
  assert.strictEqual(concatFileLine("a'b'c.mp4"), "file 'a'\\''b'\\''c.mp4'");
});

t('CL-3 空值不抛错', () => {
  assert.strictEqual(concatFileLine(null), "file ''");
  assert.strictEqual(concatFileLine(undefined), "file ''");
});

/* ---- 真 ffmpeg 往返：含单引号目录里两段拼接必须成功 ---- */
const FFMPEG = detectFfmpeg();
if (!FFMPEG) {
  console.log('SKIP  本机没有 ffmpeg（无法真跑 concat 验证转义形态）');
} else {
  t('CL-4 真跑 ffmpeg：单引号目录的分段清单能拼接成功', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it's-concat-"));
    try {
      const segs = [];
      for (let n = 1; n <= 2; n++) {
        const seg = path.join(dir, `seg-${n}.mp4`);
        const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-f', 'lavfi',
          '-i', 'testsrc2=duration=1:size=128x96:rate=10',
          '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', seg],
          { encoding: 'utf8', timeout: 60000, windowsHide: true });
        assert.strictEqual(r.status, 0, '造分段失败：' + (r.stderr || '').slice(-200));
        segs.push(seg);
      }
      const list = path.join(dir, 'list.txt');
      fs.writeFileSync(list, segs.map(concatFileLine).join('\n'), 'utf8');
      const out = path.join(dir, 'out.mp4');
      const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0',
        '-i', list, '-c', 'copy', out], { encoding: 'utf8', timeout: 60000, windowsHide: true });
      assert.strictEqual(r.status, 0, '单引号目录 concat 失败：' + (r.stderr || '').slice(-300));
      assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0, '拼接产物为空');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  });
}

done();