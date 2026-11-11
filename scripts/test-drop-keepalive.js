'use strict';
/* 保活复用路径必须消费「全局拖拽」待处理文件（真机实测抓到的缺陷）。
 *
 * ============ 锁的是哪次事故 ============
 * v0.8.3 加了全局拖拽后，文件路由到工具页有两条路径：
 *   ① 首次 render → filePicker 建立时 setTimeout(0) 消费 —— 正常；
 *   ② 标签页已开着（keepAlive 命中）→ 复用旧 DOM 直接 return，
 *      **不 render**，setTimeout 永远不再建立 → 文件在 __pendingDrop
 *      里躺 30 秒后静默蒸发。用户看到的是「拖了、提示了、打开了，
 *      但列表里什么都没有」。
 * 修复：复用路径显式调用页内 picker 的 consumePendingDrop()。
 *
 * ============ 为什么不能用行为断言 ============
 * keepAlive 是 app.js 闭包内的 Map，jsdom 里没有完整的渲染循环
 * （renderContent 依赖大量 DOM/IPC），行为测试要么拉起完整 Electron
 * （test-snip-e2e 那种 120s 的真机路径，CI 会 SKIP），要么测不了。
 * 所以锁源码结构 + 真机探针双重验证；本文件是前者。
 */
const { readSrc } = require('./lib/harness');
const assert = require('assert');

const { t, done } = require('./lib/harness');

t('KA1 filePicker 把消费逻辑暴露成 consumePendingDrop 方法', () => {
  const s = readSrc('js/ui.js');
  /* 锁的是：消费逻辑内联回 setTimeout 里（退回修复前形态）——
   * 那样保活复用路径就拿不到它，缺陷复发。 */
  assert.ok(/function consumePendingDrop\(\)/.test(s),
    'filePicker 里缺少具名的 consumePendingDrop 函数');
  /* 锁的是：API 上没挂这个方法 —— app.js 复用路径找不到入口。 */
  assert.ok(/consumePendingDrop\n?\s*\}/.test(s) || /consumePendingDrop\s*,?\s*\n/.test(s),
    'picker API 应暴露 consumePendingDrop');
  /* 锁的是：render 路径的 setTimeout 接线被删（首次打开不消费了）。 */
  assert.ok(/setTimeout\(\(\) => \{ try \{ consumePendingDrop\(\); \} catch/.test(s),
    'render 路径仍应通过 setTimeout 消费（首次打开的场景）');
});

t('KA2 保活复用路径显式调用 consumePendingDrop', () => {
  const s = readSrc('js/app.js');
  /* 锁的是：复用分支的补挂调用被删 —— 缺陷复发（文件静默蒸发）。
   * 用「keepAlive.has 命中分支内出现 consumePendingDrop」的结构特征，
   * 而不是行号 —— 行号会随无关改动漂移。 */
  const at = s.indexOf('keepAlive.has(pageKey)');
  assert.ok(at >= 0, '找不到保活复用分支');
  const seg = s.slice(at, at + 2600);
  /* 锁的是：复用分支的补挂调用被删 —— 缺陷 #1 复发（文件静默蒸发）。 */
  assert.ok(/consumePendingDrop/.test(seg),
    '保活复用分支应调用 consumePendingDrop（否则已打开的工具页接不到拖拽文件）');
  /* 锁的是：调用没有延迟到宏任务 —— rec.el 刚贴回 DOM，fileList 渲染
   * 未就绪时同步 add 会显示不出行（实测过同步 add 的时机问题）。 */
  assert.ok(/setTimeout\(\(\) => \{[\s\S]*?consumePendingDrop/.test(seg),
    '复用路径的调用应延迟到 setTimeout（等页面贴回 DOM）');
});

t('KA3 消费内部必须先 takePending（保证普通切页零副作用）', () => {
  const s = readSrc('js/ui.js');
  const at = s.indexOf('function consumePendingDrop');
  const seg = s.slice(at, at + 1600);
  /* 锁的是：复用路径的补挂调用变成无条件 add —— 普通切页也会把
   * 上次的文件重新塞进列表（串页污染）。 */
  assert.ok(/takePending\(/.test(seg),
    'consumePendingDrop 必须先 takePending（取不到就返回），保证普通切页零副作用');
  /* 锁的是：没有按 __renderingTool 过滤 —— 任何工具都会吃走别的工具的文件。 */
  assert.ok(/window\.__renderingTool/.test(seg),
    '消费应按 __renderingTool 过滤（防止别的工具吃走路由给 A 的文件）');
});

t('KA4 takePending 取完即清空且有过期时间（不串页、不残留）', () => {
  const s = readSrc('js/drop-open.js');
  /* 锁的是：takePending 退化成"只读不清"—— 下次打开同一工具会
   * 冒出上次的文件；或没有过期时间 —— 半小时前的拖拽突然生效。 */
  assert.ok(/window\.__pendingDrop = null/.test(s), 'takePending 取完必须清空');
  assert.ok(/maxAge|30000/.test(s), 'takePending 必须有过期时间（默认 30 秒）');
});

t('KA5 剪贴板面板的内容交接必须与拖拽同构（保活路径也要接）', () => {
  const s = readSrc('js/app.js');
  /* 锁的是：consumePendingClip 被内联回 renderToolPage 的 setTimeout ——
   * 那正是缺陷 #2 的形态：保活复用路径接不到，内容静默蒸发。 */
  assert.ok(/function consumePendingClip\(page, toolId\)/.test(s),
    '剪贴板内容交接应是具名函数 consumePendingClip（供保活路径复用）');
  /* 锁的是：render 路径的接线被删。 */
  assert.ok(/setTimeout\(\(\) => \{ try \{ consumePendingClip\(page, toolId\); \} catch/.test(s),
    'render 路径仍应通过 setTimeout 交接（首次打开的场景）');
  /* 锁的是：保活分支的补挂调用被删 —— 缺陷 #2 复发。 */
  const at = s.indexOf('keepAlive.has(pageKey)');
  const seg = s.slice(at, at + 3400);
  assert.ok(/consumePendingClip\(rec\.el/.test(seg),
    '保活复用分支应调用 consumePendingClip（否则已打开的工具页接不到面板内容）');
});

t('KA6 takePendingClip 同样取完即清空（与拖拽同构）', () => {
  const s = readSrc('js/clip-actions.js');
  /* 锁的是：takePendingClip 退化成只读不清 —— 下次打开工具会
   * 冒出上次的剪贴板内容。 */
  assert.ok(/window\.__pendingClip = null/.test(s), 'takePendingClip 取完必须清空');
  assert.ok(/maxAge|30000/.test(s), 'takePendingClip 必须有过期时间');
});

t('KA7 面板送的图片走 __pendingDrop 通道并立即通知消费', () => {
  const s = readSrc('js/app.js');
  const at = s.indexOf('function consumePendingClip');
  const seg = s.slice(at, at + 1800);
  /* 锁的是：图片内容只放进 __pendingDrop 却没人消费 —— 保活场景下
   * 没有下一次 render，图片会躺到过期。 */
  assert.ok(/__pendingDrop = \{ paths: \[\], exts: \[\], dataUrl/.test(seg),
    '图片内容应走 __pendingDrop 通道');
  /* 锁的是：放入 __pendingDrop 后没有通知消费 —— 保活场景没有下一次
   * render，图片会躺到过期。 */
  assert.ok(/api\.consumePendingDrop\(\)/.test(seg),
    '放入 __pendingDrop 后应立即通知本页 picker 消费');
});

t('KA8 全局监听的 bind 必须幂等（切语言重建外壳不重复挂）', () => {
  /* 锁的是：bind() 去掉幂等标记 —— 切语言整壳重建时 app.js 再次调用它，
   * document 级监听器翻倍：一次拖拽弹 N 个选择面板。
   * 本次审查（v0.8.3 收尾后第二轮）发现的缺陷。 */
  const drop = readSrc('js/drop-open.js');
  assert.ok(/__dropOpenBound/.test(drop), 'DropOpen.bind 缺少幂等标记 __dropOpenBound');
  /* 锁的是：两处 bind 的幂等策略不一致 —— 一处有标记一处没有，
   * 修好一处漏另一处正是要防的。 */
  const clip = readSrc('js/clip-actions.js');
  assert.ok(/__clipActionsBound/.test(clip), 'ClipActions.bind 缺少幂等标记 __clipActionsBound');
});

done();
