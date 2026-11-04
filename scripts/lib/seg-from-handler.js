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
 * ============ 为什么还要认常量形式 ============
 * v0.4.2 把 160 个通道从字面量换成了常量引用，写法由
 *   handle('zip:compress', async (e, ...) => { ... })
 * 变成
 *   handle(CH.ZIP.COMPRESS, async (e, ...) => { ... })
 * 以前各测试自己写 `src.indexOf("handle('zip:compress'")`，一迁移就全部
 * 「找不到 handler」。这不是断言失效，而是**定位方式耦合了书写形式**。
 * 所以定位这件事收在这里：按通道名查常量路径，两种写法都认。
 * 断言本身仍然原样保留 —— 当初坚持不批量改写源码断言，是因为那些断言
 * 各有各的语义；但「怎么找到那段代码」不是语义，是可以统一的基础设施。
 */

/** 反查：通道名 → 常量路径（如 'zip:compress' → 'ZIP.COMPRESS'）。找不到返回 null。 */
function constantKeyOf(channel) {
  const { CHANNELS, flatten } = require('../../lib/channels');
  const flat = flatten(CHANNELS);
  for (const [k, v] of Object.entries(flat)) {
    if (v === channel) return k;
  }
  return null;
}

/**
 * 按通道名找到 `handle(..., ...)` 在源码里的起始下标。
 * 字面量形式与常量形式都认；找不到返回 -1。
 * @param {string} mainSrc 已剥离注释的源码
 * @param {string} channel IPC 通道名
 * @returns {number}
 */
function handlerIndex(mainSrc, channel) {
  const literal = mainSrc.indexOf("handle('" + channel + "'");
  if (literal > 0) return literal;
  const key = constantKeyOf(channel);
  if (!key) return -1;
  /* 别名可能是 CH / dirMoveCh / 任何标识符，都能匹配。
   * 通道名里的冒号在常量路径里已经变成点，正则只需转义点。 */
  const re = new RegExp('handle\\(\\s*[A-Za-z_$][\\w$]*\\.' + key.split('.').join('\\.') + '\\s*,');
  const m = re.exec(mainSrc);
  return m ? m.index : -1;
}

/**
 * 按通道名找到渲染层 `invoke(..., ...)` 在源码里的起始下标。
 * 字面量 `invoke('fs:stat'` 与常量 `invoke(Channels.CHANNELS.FS.STAT` 都认。
 * @param {string} src 渲染层源码（或任何含 invoke 调用的片段）
 * @param {string} channel IPC 通道名
 * @param {string} [argNeedle] 可选：同一个通道被调用多次时，用首个参数的特征串
 *   选出正确的那一处（例如 store:get 有十几个调用点，要看的是 'settings.lang' 那个）
 * @returns {number} 找不到返回 -1
 */
function invokeIndex(src, channel, argNeedle) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [esc("invoke('" + channel + "'")];
  const key = constantKeyOf(channel);
  if (key) patterns.push('invoke\\(\\s*(?:[A-Za-z_$][\\w$]*\\.)*' + esc(key));

  for (const p of patterns) {
    const re = new RegExp(p, 'g');
    let m;
    while ((m = re.exec(src))) {
      if (!argNeedle) return m.index;
      if (src.slice(m.index, m.index + 200).includes(argNeedle)) return m.index;
    }
  }
  return -1;
}

/**
 * 取从 `handle(<通道>,` 起到函数体闭合花括号为止的源码片段。
 * @param {string} mainSrc 已剥离注释的 main.js 源码
 * @param {string} channel IPC 通道名
 * @returns {string} 该 handler 的源码片段
 */
function segFromHandler(mainSrc, channel) {
  const assert = require('assert');
  const { scanBrace } = require('../../lib/src-scan');
  const start = handlerIndex(mainSrc, channel);
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

module.exports = { segFromHandler, handlerIndex, invokeIndex, constantKeyOf };
