'use strict';
/* 批量操作「失败明细」文本的拼装（供渲染层与测试共用）。
 *
 * 【为什么单独抽成文件】
 * 这段逻辑原来内联在 js/tools/file-tools.js 的两次 alertBox 调用里，于是
 * 测试只能去匹配源码形态（/alertBox\({[\s\S]{0,200}部分文件未能重命名/）。
 * 更糟的是那条断言锁住的**恰好是缺陷本身**：alertBox 的签名是
 * alertBox(message, title)，传配置对象进去会被 h() 当普通对象丢掉，
 * 弹出来是标题「提示」+ 正文全空白。修好功能之后断言反而红了 ——
 * 典型的「测试比代码更坚持错误」。
 *
 * 抽到这里之后：主代码调用它、测试也调用它，逻辑只有一份（不会出现
 * 测试测副本造成的假绿）；测试断言的是**返回值内容**（含文件名、含原因、
 * 含截断提示），不再依赖任何源码版面。
 *
 * 【为什么用这种 UMD 写法】
 * 渲染层在 contextIsolation 下不能 require()，主进程测试却能 require()。
 * 若像 lib/channels.js 那样再手写一份 js/ 副本，就得靠同步测试守着两份
 * 逐字一致——这段逻辑只有二十行，直接一份双向可用更省事。
 * 加载方式：index.html 里 <script src="lib/fail-text.js">（须在 js/tools/ 之前），
 * 挂到 window.FailText；node 侧 require 拿到的就是同一个函数。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  /* 浏览器侧：挂到 window 上。
   * root 的推断类型是 globalThis 与工厂返回值的联合，直接赋值会被判成
   * 「FailText 属性不存在」；这里用局部变量把它收窄成可写对象，
   * 运行时与 `root.FailText = api` 完全等价。 */
  else {
    const g = /** @type {Record<string, unknown>} */ (root);
    g.FailText = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * 把批量操作的失败明细拼成一段可直接喂给 alertBox 的文本。
   * @param {number} ok 成功数
   * @param {Array<{from:string,to:string,err:string}>} failures 失败项
   * @param {number} [limit] 最多列出几条（默认 15）
   *   —— 为什么要有上限：批量改名动辄几百个文件，全列出来弹窗要滚很久，
   *   用户反而看不到「还有多少没处理」。列 15 条 + 一句剩余数量最实用。
   * @returns {string}
   */
  function buildFailText(ok, failures, limit = 15) {
    const list = Array.isArray(failures) ? failures : [];
    const shown = Math.max(0, Number(limit) || 0) || 15;
    const head = `成功 ${ok} 个，失败 ${list.length} 个：\n\n`;
    const body = list.slice(0, shown)
      .map(f => `${f.from}\n  → ${f.to}\n  原因：${f.err}`).join('\n\n');
    const more = list.length > shown ? `\n\n…还有 ${list.length - shown} 个未列出` : '';
    return head + body + more;
  }
  return { buildFailText };
});
