'use strict';
/* 屏幕标尺必须能伸长 / 缩短。
 *
 * ============ 锁的是哪个回归 ============
 * 用户反馈：「屏幕标尺不能伸长或缩短吗」。
 *
 * 工具页的说明从很早就写着「拖动边缘可调整长度」，但实现里：
 *   · main.js 创建标尺窗口用的是 `resizable: false`；
 *   · lib/channels.js 只有 RULER / RULER_CLOSE / RULER_MOVE，没有 resize 通道；
 *   · ruler.html 里没有任何可抓的边缘元素。
 * 也就是说「拖动边缘可调整长度」是**承诺了却没实现**——
 * 用户拖边缘什么都不会发生（2026-11-06 真机实测确认：
 * 标尺窗口固定 602×58，拖右边缘无效）。
 *
 * ============ 为什么不能只靠「改成 resizable: true」 ============
 * 标尺是 frame: false 的无边框窗口，Windows 上根本没有系统边框可抓。
 * resizable: true 只是让程序自己能 setSize，用户依然拖不动。
 * 所以必须要有一套自己的把手 + IPC。这条断言把四个必要条件都钉住，
 * 少任何一个功能就又是坏的：
 *   ① 窗口 resizable（否则 setBounds 改不动尺寸）
 *   ② 有专用的 resize 通道（且两份通道表都有）
 *   ③ 主进程真的处理它，并按 anchor 锚定固定边
 *   ④ 页面里真的有可抓的边缘，且拖动时优先于「移动窗口」
 */
const { t, done, assert, readSrc } = require('./lib/harness');

const main = readSrc('main.js');
const rulerJs = readSrc('js/auxwin/ruler-2.js');
const rulerHtml = readSrc('ruler.html');

t('RS1 标尺窗口可调整大小（resizable: true）', () => {
  /* 锁的是：resizable: false —— setBounds 改不动尺寸，拉伸必然无效。 */
  const block = /let rulerWin = null;[\s\S]{0,1500}?webPreferences/.exec(main);
  assert.ok(block, '抓不到标尺窗口的创建块');
  assert.ok(/resizable:\s*true/.test(block[0]),
    '标尺窗口仍是 resizable: false —— 程序自己也改不了尺寸');
});

t('RS2 有专用的标尺 resize 通道，且两份通道表都在', () => {
  /* 锁的是：想拉伸却没有通道可走 —— 只能在渲染层干瞪眼。 */
  const lib = readSrc('lib/channels.js');
  const js = readSrc('js/channels.js');
  assert.ok(/RULER_RESIZE:\s*'win:ruler-resize'/.test(lib), 'lib/channels.js 没有 RULER_RESIZE');
  /* 锁的是：只改一份表 —— 渲染层拿到的常量名与主进程注册的不是同一条。 */
  assert.ok(/RULER_RESIZE:\s*'win:ruler-resize'/.test(js), 'js/channels.js 没有 RULER_RESIZE');
});

t('RS3 主进程处理 resize，并支持 start/end 两种锚点', () => {
  /* 锁的是：只有一端能拉。
   * 只锚定左上角的话，用户拖左边缘会看到整个标尺跟着跑（窗口 x 不变、
   * 宽度变小 = 右边缩进来），与直觉相反。 */
  const h = /handle\(CH\.WIN\.RULER_RESIZE[\s\S]{0,1800}?\n\}\);/.exec(main);
  assert.ok(h, '主进程没有处理 RULER_RESIZE');
  const body = h[0];
  /* 锁的是：没有锚点分支 —— 拖左边会整体位移。 */
  assert.ok(/anchor === 'start'/.test(body), '没有 start 锚点分支（拖左/上边缘会整体跑）');
  /* 锁的是：没有下限 —— 能拖成一条线，读数彻底看不见。 */
  assert.ok(/RULER_MIN/.test(body), '没有最小长度限制（可拖成一条线）');
  /* 锁的是：没有上限 —— 拉出屏幕后抓不回来。 */
  assert.ok(/wa\.width|wa\.height|maxLen/.test(body), '没有最大长度限制（可拉出屏幕）');
  /* 锁的是：厚度跟着一起变 —— 横标尺被拉高会变成一大块浮层。 */
  assert.ok(/RULER_THICK/.test(body),
    '横向标尺的厚度没有固定常量（厚度会跟着变）');
  /* 锁的是：纵向标尺取错维度（2026-11-06 真机实测）。
   * 长度那一维必须是「横向取 w、纵向取 h」。写反/写死成 w 的话，
   * 纵向拿到的永远是厚度（57），被下限夹成 160 —— 表现是纵向完全拉不动。 */
  assert.ok(/horizontal\s*\n?\s*\?\s*\(Number\(w\)[\s\S]{0,80}?:\s*\(Number\(h\)/.test(body),
    '长度没有按方向取 w/h（纵向会永远拿到厚度那一维，拉不动）');
});

t('RS4 页面里有可抓的边缘，且拖动时优先于移动窗口', () => {
  /* 锁的是：窗口 resizable 了但页面没有把手 —— 用户依然无处可拖。 */
  assert.ok(/class="rz rz-start"/.test(rulerHtml), 'ruler.html 没有起始边把手');
  assert.ok(/class="rz rz-end"/.test(rulerHtml), 'ruler.html 没有结束边把手');
  /* 锁的是：把手被 mousedown 的「拖动窗口」抢走 —— 拖边缘变成整体平移，
   * 用户看到的就是「不能伸缩」（这次反馈的观感来源）。 */
  const down = /addEventListener\('mousedown'[\s\S]{0,900}?\}\);/.exec(rulerJs);
  assert.ok(down, '抓不到 mousedown 处理');
  /* 锁的是：把手判断被删掉 —— 拖边缘会退回"整体平移"，功能等于没做。 */
  assert.ok(/closest\('\.rz'\)/.test(down[0]), 'mousedown 没有优先判断 .rz 把手');
  /* 顺序：把手判断必须在 dragging = true 之前 */
  /* 锁的是：两个判断写反 —— 先置 dragging 的话两者会同时生效，
   * 拖边缘时窗口一边缩放一边平移，完全失控。 */
  const iRz = down[0].indexOf("closest('.rz')");
  const iDrag = down[0].indexOf('dragging = true');
  assert.ok(iRz >= 0 && iDrag > iRz, '把手判断必须排在 dragging = true 之前');
});

t('RS5 拉伸增量按「相对按下时」计算，不会自我加速', () => {
  /* 锁的是：每帧拿当前 screenX 当增量。
   * 窗口被 setBounds 改变后指针的屏幕坐标基准会跳，于是同一段拖拽
   * 会被反复计入，表现为「越拖越快、一下拉到底」。 */
  assert.ok(/sx0: e\.screenX/.test(rulerJs), '没有记录按下时的指针 x');
  /* 锁的是：增量改成拿当前 screenX 相减 —— 就是那个"越拖越快"的回归。 */
  assert.ok(/e\.screenX - resizing\.sx0/.test(rulerJs),
    '增量不是相对按下时的指针位置计算的（会自我加速）');
});

t('RS6 几何用主进程缓存，不用 getBounds() 回读（防 DPI 取整漂移）', () => {
  /* 锁的是：2026-11-06 真机实测到的两个漂移（dpr=1.875）——
   *   · 厚度每拉一次 +1px：58 → 59 → 60 → 61
   *   · start 锚点每拉一次偏 2px：右边缘 1285 → 1283
   * 根因都是 getBounds() 往返一次被 DPI 取整，误差逐次累积。
   * 改成主进程独占维护一份几何缓存后两个漂移都消失（真机复测：
   * 900→401→161，右边缘 1283 稳定、高度恒为 58）。
   *
   * 【为什么这条不能用行为断言】要在 dpr=1.875 下连续拉伸并比对像素，
   * 需要在无头环境里起真实窗口 —— 本机 runner 起不来（见
   * test-ui-dpi-fixes 的 SKIP 说明）。所以退回源码断言，钉住"不回读"这一点。 */
  /* 窗口上限取到下一个 handle 之前即可 —— 用非贪婪到 `\n});` 会因为
   * 函数体里本身就有嵌套的 `});` 而截断/过冲，导致匹配到创建块。 */
  const hStart = main.indexOf('handle(CH.WIN.RULER_RESIZE');
  assert.ok(hStart > 0, '主进程没有处理 RULER_RESIZE');
  const hEnd = main.indexOf('\n});', hStart);
  const body = main.slice(hStart, hEnd > 0 ? hEnd : hStart + 2400);
  /* 锁的是：用回读值当基准 —— 那正是漂移的来源。
   * 允许 `rulerGeom || getBounds()` 这一种写法：它是缓存缺失时的**一次性兜底**，
   * 正常路径上不会发生（创建时就填好了）。禁止的是拿 getBounds() 当基准去算 next。 */
  const usesFallbackOnly = /rulerGeom\s*\|\|\s*rulerWin\.getBounds\(\)/.test(body);
  /* 锁的是：把兜底写法换成裸回读 —— 那正是 DPI 取整漂移的入口。 */
  assert.ok(!/(?:const|let|var)\s+\w+\s*=\s*rulerWin\.getBounds\(\)/.test(body),
    '拉伸时直接拿 getBounds() 当基准（DPI 取整会让尺寸/位置逐次漂移）');
  /* 锁的是：几何来源既不是缓存也不是那条兜底 —— 说明读了别的东西。 */
  assert.ok(usesFallbackOnly || !/rulerWin\.getBounds\(\)/.test(body),
    '拉伸时的几何来源不是缓存（回读会漂移）');
  /* 锁的是：缓存变量被删 —— 那就只能回读，漂移必然回来。 */
  assert.ok(/rulerGeom/.test(body), '没有使用主进程维护的几何缓存');
  /* 锁的是：厚度跟着当前几何走 —— 它是漂移最明显的那一项。 */
  assert.ok(/RULER_THICK/.test(body), '厚度没有固定常量（会随回读逐次变形）');
  /* 锁的是：拖动后没同步缓存 —— 下次拉伸会跳回旧位置。 */
  const mvStart = main.indexOf('handle(CH.WIN.RULER_MOVE');
  const mvEnd = mvStart > 0 ? main.indexOf('\n});', mvStart) : -1;
  const mvBody = mvStart > 0 ? main.slice(mvStart, mvEnd > 0 ? mvEnd : mvStart + 1200) : '';
  /* 锁的是：拖动改了位置却没写回缓存 —— 下次拉伸会按旧坐标算，锚点整体跳一下。 */
  assert.ok(/rulerGeom\.x = cx/.test(mvBody), '拖动后没有同步几何缓存');
});

done();
