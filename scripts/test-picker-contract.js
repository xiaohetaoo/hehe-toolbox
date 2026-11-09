'use strict';
/* 文件选择器的「调用契约」测试（纯源码断言，不需要 Electron）。
 *
 * ============ 为什么要有这个文件 ============
 * js/ui.js 的 filePicker / dropzone 是 20 多个工具的公共入口，它们的 opts
 * 字段是**跨进程、跨文件**的隐式契约：调用方写一个字段，组件内部必须真的
 * 读它、真的用它。而这层契约没有任何类型检查 —— 写错、或组件忘了透传，
 * 表现都是「点一下没反应」或「某个选项静默失效」，冒烟测试（只看页面不抛
 * 异常）完全抓不到。
 *
 * 本轮实测抓到两个同源的真缺陷，都属于"组件静默丢弃调用方的字段"：
 *   ① filePicker 解构 opts 时**没有 pickProps**，也没把它传给 dropzone。
 *      于是 zip-tool / archive-7z 想传
 *        pickProps: ['openFile','openDirectory','multiSelections']
 *      让它能选文件夹，实际拿到的却是默认的 ['openFile','multiSelections'] ——
 *      点「选择」选不到文件夹。而两者的文案都写着「选择要压缩的文件/文件夹」，
 *      拖拽（走 drop 事件、自己展开目录）又能用，于是呈现为
 *      「拖能用、点不能用」这种最难归因的半坏状态。
 *   ② img-scramble 的 run() 调了 picker.files() —— filePicker 上没有这个方法，
 *      第一行就抛 TypeError，整个工具 100% 不可用（已在 test-img-scramble 里
 *      单独锁住，这里再按"全项目不出现"扫一遍）。
 *
 * ============ 为什么是源码断言而不是行为断言 ============
 * 这些组件都挂在 IIFE 里、没有导出，要真的点一下需要 Electron + 真对话框
 * （交互式模态，自动化点不了）。而缺陷的本质是**源码形态**：字段有没有被
 * 解构、有没有被继续传下去 —— 这是静态可判定的，用源码断言反而更直接。
 * 行为层面的兜底由 test-picker-func / test-picker-sweep 这两个 e2e 负责。
 */
const assert = require('assert');
const { t, done, readSrc, readTree } = require('./lib/harness');

const UI = () => readSrc('js/ui.js');

/* 取某函数的函数体文本（从 function 名( 起，到下一个顶层注释块之前）。
 * 【为什么要有它】filePicker 与 dropzone 都在同一个文件里，直接对全文做
 * /pickProps/ 匹配没有意义 —— 只要有一处提到就算过，等于没锁住
 * 「filePicker 自己有没有透传」这件事。所以先切出函数体再断言。
 * 边界取「下一个以 /* 开头的行」是可靠的：本项目的函数之间都用注释块分隔。 */
function funcBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '找不到函数 ' + name);
  const rest = src.slice(start);
  const end = rest.search(/\n\/\*/);
  return end < 0 ? rest : rest.slice(0, end);
}

/* ---------------- ① pickProps 必须被 filePicker 透传到 dropzone ---------------- */

t('filePicker 解构出了 pickProps', () => {
  const body = funcBody(UI(), 'filePicker');
  /* 锁的是：filePicker 的 opts 解构里必须有 pickProps。
   * 曾经漏了它 —— 调用方写的 pickProps 被静默丢弃，zip-tool / archive-7z
   * 因此选不到文件夹（详见文件头 ①）。 */
  assert.ok(/(^|[\s,{])pickProps(\s*[,}=]|$)/m.test(body),
    'filePicker 的解构里没有 pickProps —— 调用方传的它会被静默丢弃');
});

t('filePicker 把 pickProps 传给了 dropzone', () => {
  const body = funcBody(UI(), 'filePicker');
  const dzCall = body.slice(body.indexOf('dropzone({'));
  assert.ok(dzCall.length > 0, 'filePicker 里找不到 dropzone({ 调用');
  /* 锁的是：dropzone({...}) 的实参里必须出现 pickProps。
   * 只解构不传下去等于什么也没做 —— 这是同一个缺陷的另一半。 */
  assert.ok(/[\s,{]pickProps[\s,}]/.test(dzCall.slice(0, 400)),
    'filePicker 没有把 pickProps 传给 dropzone —— 调用方的设置仍然无效');
});

t('dropzone 仍然按 pickProps 优先决定对话框属性', () => {
  const body = funcBody(UI(), 'dropzone');
  /* 锁的是：dropzone 里 props 的取值必须以 pickProps 优先。
   * 若哪天 dropzone 改成忽略它，前面的透传就全部白做。 */
  assert.ok(/pickProps\s*\|\|/.test(body),
    'dropzone 的 props 取值不再以 pickProps 优先 —— 文件夹选择会再次失效');
});

/* ---------------- ② 不许调用 picker 上不存在的方法 ---------------- */

t('filePicker 暴露的成员与工具里的用法一致（picker.files 不存在）', () => {
  const ui = UI();
  const body = funcBody(ui, 'filePicker');
  /* 锁的是：filePicker 返回的 api 里没有 files()。
   * 明确写出来，是因为 img-scramble 曾经调用它并因此整个工具不可用；
   * 这条断言把"它确实不存在"变成可核对的证据，而不是靠人去读返回对象。 */
  assert.ok(!/\bfiles\s*:/.test(body), 'filePicker 的返回值里出现了 files 成员（与原契约不符）');
  /* 锁的是：paths / count / add / clear / setLocked 这些真实成员必须还在 ——
   * 88 处调用依赖它们，删任何一个都是大面积失效。 */
  for (const k of ['paths', 'count', 'add', 'clear', 'setLocked', 'move', 'sortBy']) {
    assert.ok(new RegExp('\\b' + k + '\\b').test(body), 'filePicker 的 api 少了成员：' + k);
  }
});

t('js/tools 下没有任何 picker.files() 调用', () => {
  const top = readTree('js/tools');
  const media = readTree('js/tools/media');
  /* 锁的是：全项目不再出现 picker.files()（同款笔误的横向扫描）。
   * readTree 只读一层，所以顶层与 media 子目录分别读。 */
  assert.ok(!/picker\.files\s*\(/.test(top), 'js/tools/*.js 里出现了 picker.files()');
  /* 锁的是：media 子目录同样不能出现（img-scramble 就在这一层）。 */
  assert.ok(!/picker\.files\s*\(/.test(media), 'js/tools/media/*.js 里出现了 picker.files()');
});

/* ---------------- ③ 传了 pickProps 的工具必须真的能选文件夹 ---------------- */

t('zip-tool 与 archive-7z 的 pickProps 里包含 openDirectory', () => {
  const src = readSrc('js/tools/file-tools.js');
  /* 锁的是：这两个"要压缩文件夹"的工具必须显式要求 openDirectory。 */
  const hits = src.match(/pickProps:\s*\[([^\]]+)\]/g) || [];
  assert.ok(hits.length >= 2, 'zip-tool / archive-7z 的 pickProps 少了（应有两处）');
  for (const h of hits) {
    // 锁的是：pickProps 必须同时含 openDirectory（选文件夹）与 openFile（选单个文件）。
    assert.ok(/openDirectory/.test(h), 'pickProps 里缺少 openDirectory：' + h);
    assert.ok(/openFile/.test(h), 'pickProps 里缺少 openFile（还得能选单个文件）：' + h);
  }
});

done();
