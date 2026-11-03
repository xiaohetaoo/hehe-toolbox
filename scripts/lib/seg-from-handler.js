'use strict';
/* 测试公用的「按通道名取 handler 源码片段」。
 *
 * ============ 为什么要抽出来 ============
 * 实测这段 8 行函数在 5 个测试文件里**逐字相同**（归一化后长度都是 458），
 * 只有注释措辞不同。它必须靠花括号配平来截取函数体 —— 而「怎么配平」这件事
 * 已经有正确答案了（lib/src-scan.js 的 scanBrace，它跳过注释/字符串/正则）。
 * 五份副本各自演化，迟早会有一份被改成朴素计数，然后在含 `}` 的字符串上
 * 悄悄截歪，表现为「找不到某段代码」这种极难定位的假红。
 *
 * ============ 为什么函数接收 mainSrc 而不是自己读 ============
 * 各测试读 main.js 的方式不同：多数用 harness 的 readMain()，个别用
 * readSrc/raw。由调用方把已读到的源码传进来，这里只管「怎么切」，
 * 不掺和「怎么读」—— 后者各脚本的既有行为不要动。
 *
 * @param {string} mainSrc 已剥离注释的 main.js 源码
 * @param {string} channel IPC 通道名
 * @returns {string} 从 handle('<channel>' 起到函数体闭合花括号为止的源码片段
 */
function segFromHandler(mainSrc, channel) {
  const assert = require('assert');
  const { scanBrace } = require('../../lib/src-scan');
  const start = mainSrc.indexOf("handle('" + channel + "'");
  assert.ok(start > 0, '找不到 handler: ' + channel);
  /* handler 签名里可能有默认参数对象 `opts = {}`，不能取 start 之后的第一个 '{'，
   * 要跳到 `=> {` 之后的那个函数体开括号。 */
  const arrow = mainSrc.indexOf('=>', start);
  const from = arrow > 0 ? arrow : start;
  const open = mainSrc.indexOf('{', from);
  assert.ok(open > 0, 'handler ' + channel + ' 没有函数体');
  const end = scanBrace(mainSrc, open);
  assert.ok(end > open, 'handler ' + channel + ' 括号不配平');
  return mainSrc.slice(start, end);
}

module.exports = { segFromHandler };
