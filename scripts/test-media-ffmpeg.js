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

const { t, done, readMain, readTree } = require('./lib/harness');

const mainSrc = readMain({ raw: true });

t('rec:start 只在未显式确认时才拒绝已存在的目标', () => {
  /* 锁的是：系统对话框确认过覆盖之后，handler 仍二次否决（见文件头）。
   * 为什么只能用源码断言：rec:start 要真的开录（需要 ffmpeg + 桌面捕获），
   * 单测环境跑不起来；能验的只有「这个判断受不受 overwrite 控制」。
   * 补充：这条的**行为**面由 test-destructive 的「rec:stop 降级」等覆盖，
   * 但覆盖语义本身只能在这里看形态。 */
  const body = (() => {
    const s = mainSrc.indexOf("handle('rec:start'");
    assert.ok(s > 0, '找不到 rec:start（它可能又被搬走了）');
    const e = mainSrc.indexOf('\n});', s);
    return mainSrc.slice(s, e);
  })();
  assert.ok(/overwrite/.test(body), 'rec:start 没有 overwrite 参数');
  assert.ok(/fs\.existsSync\(outPath\) && !overwrite/.test(body),
    '存在性检查没有受 overwrite 控制（会二次否决系统对话框的确认）');
  // 系统关键目录闸门必须无条件执行（不能因 overwrite 而豁免）
  /* 锁的是：把 checkOverwritable 一起塞进 !overwrite 条件里。
   * 那样"用户确认覆盖"就会连带豁免系统关键目录的闸门 —— 用户点了个
   * 普通的「是」，结果能往 Program Files 里写。这两件事必须分开：
   * overwrite 是"用户同意覆盖同名文件"，闸门是"这个位置本来就不许写"。
   * 为什么只能用源码断言：闸门是否被执行，只有当 outPath 真是系统路径时
   * 才能观察到，而那需要真的开录。 */
  assert.ok(!/if\s*\(\s*!overwrite\s*\)\s*\{?\s*const\s+recBad/.test(body),
    '不能把 checkOverwritable 放进 overwrite 条件里');
  assert.ok(/pathGuard\.checkOverwritable\(outPath\)/.test(body), '缺少关键目录闸门');
});

t('录屏 UI 在系统对话框确认后传 overwrite: true', () => {
  /* 锁的是：渲染层没把"用户已确认"传下去。主进程改好了，但界面不传
   * overwrite，等于白改 —— 这条与上面那条必须成对，否则半边修好也是坏的。 */
  const media = readTree('js/tools/media');
  const s = media.indexOf("invoke('rec:start'");
  assert.ok(s > 0, '找不到 rec:start 调用');
  const chunk = media.slice(s, s + 400);
  /* 锁的是：主进程改好了、界面却不传 overwrite，等于白改 ——
   * 用户确认过的覆盖仍会被二次否决。这条与上面那条必须成对。
   * 为什么只能用源码断言：要验证"传了什么参数"得真的点一次录制。 */
  assert.ok(/overwrite:\s*true/.test(chunk), '没有传 overwrite: true，用户确认过的覆盖仍会被否决');
});

done();
