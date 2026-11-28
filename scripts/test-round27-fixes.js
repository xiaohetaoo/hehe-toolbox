'use strict';
/* 第 27 轮（连续深查续）回归：辅助窗口在**已打开**状态下实时切换语言，
 * 以及局域网扫描的旧进度不能污染新一趟。
 *
 * R26 只保证「首次打开带对语言」；窗口开着时主窗切语言，pin 的提示、
 * ruler 的四个 title、snip 的工具条/调色板/线宽提示仍是旧语言。
 * 这里锁住 1→1 的事件接线和 2 侧的即时重画，避免以后又把二次渲染删掉。
 */
const assert = require('assert');
const { t, readSrc } = require('./lib/harness');

t('R27-01 三个辅助窗的偏好广播都派发 hehe-lang 事件', () => {
  for (const f of ['js/auxwin/pin-1.js', 'js/auxwin/ruler-1.js', 'js/auxwin/snip-1.js']) {
    const src = readSrc(f);
    /* 锁的是：UI_PREFS_CHANGED 里只改 document.lang 时，DOM 逻辑收不到
     * 「语言变了」的信号，已打开的窗口会一直停在旧文案。 */
    assert.ok(/window\.dispatchEvent\(new Event\('hehe-lang'\)\)/.test(src), f + ' 未派发 hehe-lang');
  }
});

t('R27-02 贴图窗提示文字随语言事件即时更新', () => {
  const src = readSrc('js/auxwin/pin-2.js');
  /* 锁的是：英文提示原来只在加载时判断一次；窗口开着时切回中文不会更新。 */
  assert.ok(/function applyHintLang\(\)/.test(src), 'pin-2 缺少提示语言函数');
  assert.ok(/addEventListener\('hehe-lang', applyHintLang\)/.test(src), 'pin-2 未监听 hehe-lang');
  assert.ok(/拖动移动 · 滚轮缩放 · 双击 \/ Esc 关闭/.test(src), 'pin-2 缺少中文提示回填');
  /* 锁的是：英文提示必须仍在源码里，否则切到英文时提示不会变。 */
  assert.ok(/Drag to move · Scroll to zoom/.test(src), 'pin-2 缺少英文提示');
});

t('R27-03 标尺四个 title 随语言事件即时更新', () => {
  const src = readSrc('js/auxwin/ruler-2.js');
  /* 锁的是：四个 title 原来只在加载时按 EN 写一次，切语言后不重建。 */
  assert.ok(/function applyLang\(\)/.test(src), 'ruler-2 缺少 applyLang');
  assert.ok(/addEventListener\('hehe-lang', applyLang\)/.test(src), 'ruler-2 未监听 hehe-lang');
  assert.ok(/拖动可缩短标尺/.test(src) && /Drag to shorten/.test(src), 'ruler-2 未同时保留中英 title');
  /* 锁的是：关闭提示的中英两份都要保留，事件重画才有内容可写。 */
  assert.ok(/关闭\(或双击标尺 \/ Esc\)/.test(src) && /Close \(or double-click ruler \/ Esc\)/.test(src), 'ruler-2 未同时保留关闭提示');
});

t('R27-04 截图工具条在语言事件后重建，且保留工具/颜色/线宽状态', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  /* 锁的是：EN 若是 const，事件后重画仍会取旧值；工具条已建好时必须
   * 调 showBar + syncBar 才会换掉 tooltip/aria/调色板/线宽提示。
   * tool/color/size 在闭包里，showBar 只重建 DOM，所以状态不会丢。 */
  assert.ok(/let EN = document\.documentElement\.lang === 'en';/.test(src), 'snip-2 的 EN 仍是 const');
  /* 锁的是：TOOLS 若在模块加载时就把 label 算成固定字符串，语言事件后
   * showBar 重建仍会拿旧 label —— 真机复现正是前五个工具名不跟着变。 */
  assert.ok(/\['rect', 'rect', '矩形', 'Rectangle'\]/.test(src), 'TOOLS 没有同时保存中英 label');
  assert.ok(/const label = EN \? en : zh;/.test(src), 'showBar 没有按当前语言取 label');
  /* 锁的是：语言事件必须有一个可调用的重画入口。 */
  assert.ok(/function syncLang\(\)/.test(src), 'snip-2 缺少 syncLang');
  /* 锁的是：没有监听就收不到主窗的二次语言变更。 */
  assert.ok(/addEventListener\('hehe-lang', syncLang\)/.test(src), 'snip-2 未监听 hehe-lang');
  /* 锁的是：只改 EN 不重建 DOM，旧 tooltip/aria 仍留在界面上。 */
  assert.ok(/if \(bar\.firstChild\) \{ showBar\(\); syncBar\(\); \}/.test(src), 'snip-2 语言事件后没有重建工具条');
});

t('R27-05 上行测速响应也必须流式截断，不能整包读进主进程', () => {
  const src = readSrc('ipc/net-lan.js');
  const start = src.indexOf('handle(CH.NET.SPEEDTEST');
  assert.notStrictEqual(start, -1, '找不到 NET.SPEEDTEST');
  const next = src.indexOf('handle(CH.', start + 10);
  const h = src.slice(start, next === -1 ? src.length : next);
  /* 锁的是：下行早有 HTTP_MAX_BYTES 上限，上行原来 `await r.arrayBuffer()`
   * 会先把服务端响应整包读进内存；用户可以把测速地址指向任意 HTTP 端点。 */
  assert.ok(/readHttpCapped\(r, HTTP_MAX_BYTES\)/.test(h), '上行测速没有流式截断');
  assert.ok(/if \(!r\.ok\)/.test(h), '上行测速没有检查响应状态');
});

t('R27-06 分片/合并/7z/ZIP 长操作按钮双击不会并发两趟', () => {
  const src = readSrc('js/tools/file-tools.js');
  /* 锁的是：分割/合并原来直接 async 处理，双击会起两趟；分割写的是同一组
   * .part 文件，合并也会抢同一个 finalOut，结果可能互相覆盖。 */
  assert.ok(/btn\('开始分割'[\s\S]{0,160}window\.ui\.guard\(async/.test(src), '分割按钮缺少防重入 guard');
  /* 锁的是：合并与分割同一类并发写，必须共用同一套 guard。 */
  assert.ok(/btn\('开始合并'[\s\S]{0,160}window\.ui\.guard\(async/.test(src), '合并按钮缺少防重入 guard');
  /* 锁的是：7z 的 `a` 对已存在归档是追加，双击两趟会把两批内容并进同一个包。 */
  assert.ok(/const cBtn = btn\('压缩'[\s\S]{0,160}window\.ui\.guard\(async/.test(src), '7z 压缩按钮缺少防重入 guard');
  /* 锁的是：7z 解压两趟会争同一目标目录，必须防重入。 */
  assert.ok(/const exBtn = btn\('解压'[\s\S]{0,160}window\.ui\.guard\(async/.test(src), '7z 解压按钮缺少防重入 guard');
  /* 锁的是：ZIP 压缩两次会并发跑两套压缩，第二趟只会拿到重名错误。 */
  assert.ok(/const cBtn = btn\('压缩'[\s\S]{0,160}window\.ui\.guard\(async/.test(src), 'ZIP 压缩按钮缺少防重入 guard');
});

t('R27-07 局域网扫描进度按本轮 token 过滤，旧一趟不能覆盖新一趟', () => {
  const ui = readSrc('js/tools/lan-scan.js');
  /* 锁的是：离开页面不会取消主进程 LAN.SCAN，旧扫描仍会发 job:progress；
   * 新页面只按 kind 过滤时，旧进度会覆盖新进度条和状态文字。 */
  assert.ok(/const myToken = 'lan' \+ runToken/.test(ui), 'lan-scan 没有为本轮生成 token');
  /* 锁的是：没有 token 判断，旧事件的 done/total 会直接写进新一趟的进度条。 */
  assert.ok(/if \(d\.token && d\.token !== myToken\) return;/.test(ui), 'lan-scan 未按 token 丢弃旧进度');
  /* 锁的是：token 必须随 invoke 传给主进程，否则主进程无法把本轮进度标出来。 */
  assert.ok(/token: myToken/.test(ui), 'lan-scan 没有把 token 传给 LAN.SCAN');
  const ipc = readSrc('ipc/net-lan.js');
  /* 锁的是：主进程要先接住 token，才能原样带进进度事件；坏输入回落空串。 */
  assert.ok(/const token = String\(o\.token \|\| ''\)/.test(ipc), 'net-lan 没有读取渲染层 token');
  /* 锁的是：扫描/反查两个阶段都要带回 token，少一个阶段仍会被旧事件污染。 */
  assert.strictEqual((ipc.match(/kind: 'lan', token/g) || []).length, 2, 'LAN 两个阶段的进度没有都带 token');
});
