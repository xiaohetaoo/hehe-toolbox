'use strict';
/* 全局命令面板（js/cmdk.js）的接线与契约。
 *
 * ============ 设计说明 ============
 * 面板是新功能，它锁的是**几件一旦做错就会悄悄坏掉、而真机走查也未必
 * 发现的事**：自己另写一套排序（与 Registry.search 漂移）、
 * 依赖 app.js 里未导出的闭包（运行时崩）、Ctrl+K 被改回"只聚焦搜索框"
 * （面板成了摆设）、加载顺序错（window.App 还不存在）、
 * 结果行不可键盘到达（Tab 走不到、读屏不播报）。
 *
 * 【为什么不能只用行为断言】唤起/搜索/↑↓/回车都依赖真实 DOM、焦点与
 * 键盘事件，Node 侧构造不出来。那部分由 CDP 真机走查覆盖（14 项全过）。
 * 这里锁结构与接线 —— 它们是行为的地基。
 *
 * 每条源码匹配断言上方都写明「锁的是」——那是 SA-4 的硬要求。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

t('CM1 面板复用 Registry.search，不自写排序', () => {
  const s = read('js/cmdk.js');
  /* 锁的是：排序规则只有一份。面板自己再写一套必然与首页漂移，
   * 用户会发现"同一个词在两处搜出来的顺序不一样"。 */
  assert.ok(/window\.Registry\.search\(/.test(s), '必须调用 Registry.search');
  /* 锁的是：不存在第二套评分/排序实现（有的话就是上面那条被绕过了）。 */
  assert.ok(!/function\s+score|\.sort\(\s*\(a,\s*b\)\s*=>\s*b\.score/.test(s),
    '不应出现第二套评分/排序实现');
});

t('CM2 本地化走 Registry 底层函数，不依赖未导出闭包', () => {
  const s = read('js/cmdk.js');
  /* 锁的是：用 Registry.toolName/toolDesc/modName 这三个**导出**的函数。
   * app.js 里的 TN/TD/MN 是闭包，面板拿不到（早期一版就是这么写的，运行时炸）。 */
  assert.ok(/Registry\.toolName/.test(s), '需用 Registry.toolName');
  assert.ok(/Registry\.toolDesc/.test(s), '需用 Registry.toolDesc');
  /* 锁的是：模块名也要走导出的函数（否则英文界面下模块名不翻译）。 */
  assert.ok(/Registry\.modName/.test(s), '需用 Registry.modName');
  /* 锁的是：不能直接调 app.js 的闭包 TN/TD/MN（它们不导出，调了就是 ReferenceError）。 */
  assert.ok(!/\bTN\(|\bTD\(|\bMN\(/.test(s), '不应直接调用 app.js 内部的 TN/TD/MN');
});

t('CM3 五个动作命令齐全', () => {
  const s = read('js/cmdk.js');
  /* 锁的是：面板能直达「工具之外」的全局动作。少一个就意味着
   * 用户在面板里搜不到那个动作 —— 而它正是快捷键最该覆盖的场景。 */
  for (const a of ['@home', '@settings', '@fav', '@theme', '@lang']) {
    assert.ok(s.indexOf("'" + a + "'") !== -1, '缺少动作命令 ' + a);
  }
  /* 锁的是：每个动作都有 keywords（否则只能按中文名搜到，
   * 英文界面用户 / 想按"偏好"找设置的人都搜不到）。 */
  const kwCount = (s.match(/keywords:\s*\[/g) || []).length;
  assert.ok(kwCount >= 5, '五个动作都应有 keywords，实际 ' + kwCount + ' 个');
});

t('CM4 Ctrl+K 优先开面板、保留 focusSearch 降级', () => {
  const s = read('js/app.js');
  /* 锁的是：快捷键的实际去向。改回只 focusSearch 就等于删了面板。 */
  assert.ok(/CmdPalette[\s\S]{0,200}toggle/.test(s), 'Ctrl+K 应调用 CmdPalette.toggle');
  /* 锁的是：降级路径真的存在 —— 面板模块缺失时不能"按了没反应"。 */
  assert.ok(/focusSearch\(\)/.test(s), '必须保留 focusSearch 作为降级路径');
  /* 锁的是：降级写在 else 分支里（而不是无条件调用，那样面板就白开了）。 */
  assert.ok(/else\s*\{[\s\S]{0,40}focusSearch\(\)/.test(s), '降级应在 else 分支里');
});

t('CM5 index.html 里 cmdk.js 排在 app.js 之后', () => {
  const html = read('index.html');
  const iApp = html.indexOf('js/app.js');
  const iCmdk = html.indexOf('js/cmdk.js');
  /* 锁的是：加载顺序。cmdk 在定义时就调 window.Registry，
   * 运行时用 window.App.toggleTheme —— 两者都必须先就绪。 */
  assert.ok(iApp > 0, 'index.html 必须引入 app.js');
  /* 锁的是：cmdk 必须在 app 之后（提前加载会拿到 undefined 的 window.App）。 */
  assert.ok(iCmdk > iApp, 'cmdk.js 必须排在 app.js 之后（app@' + iApp + ', cmdk@' + iCmdk + '）');
});

t('CM6 结果行键盘可达', () => {
  const s = read('js/cmdk.js');
  /* 锁的是：行是 div，必须 makeButtonLike 才 Tab 得到、读屏会播报。
   * 与首页搜索结果行同一约定（那里也踩过同样的坑）。 */
  assert.ok(/makeButtonLike/.test(s), '结果行需 makeButtonLike');
});

t('CM7 Esc / ↑↓ / Enter 三键都有处理', () => {
  const s = read('js/cmdk.js');
  /* 锁的是：键盘导航的完整性。少一个键用户就得动鼠标。 */
  assert.ok(/['"]Escape['"]/.test(s), '需处理 Esc');
  /* 锁的是：↑↓ 必须都有（只做 ↓ 的话没法回退到上一项）。 */
  assert.ok(/ArrowDown/.test(s) && /ArrowUp/.test(s), '需处理 ↑↓');
  /* 锁的是：回车要能执行（否则键盘选完还得去点一下）。 */
  assert.ok(/['"]Enter['"]/.test(s), '需处理 Enter');
});

t('CM8 面板是单例，不重复创建', () => {
  const s = read('js/cmdk.js');
  /* 锁的是：mask 已存在时只 focus，不再 append。
   * 否则每次 Ctrl+K 都在 DOM 里堆一个面板，关一个还剩一个。 */
  assert.ok(/if \(mask\)\s*\{[^}]{0,110}inputEl\.focus\(\)/.test(s),
    'open() 在 mask 存在时应只聚焦');
});

t('CM9 App 导出 toggleTheme / toggleLang', () => {
  const s = read('js/app.js');
  /* 锁的是：面板调的两个开关确实存在。
   * 面板不自己实现主题/语言切换 —— 那两件事要联动主进程与整壳重建。 */
  assert.ok(/toggleTheme\s*:/.test(s), 'App 需导出 toggleTheme');
  /* 锁的是：语言开关同样要导出（它触发整壳重建，不能在面板里另写）。 */
  assert.ok(/toggleLang\s*:/.test(s), 'App 需导出 toggleLang');
});

t('CM10 命令失败先关面板再报错', () => {
  const s = read('js/cmdk.js');
  /* 锁的是：run() 先 close() 再执行/捕错。
   * 顺序反了的话，命令抛错时面板还盖在界面上，用户以为卡死。 */
  const m = s.match(/function run\(cmd\)\s*\{[\s\S]{0,260}?\n  \}/);
  assert.ok(m, '应存在 run(cmd)');
  const body = m[0];
  const iClose = body.indexOf('close()');
  const iTry = body.indexOf('try {');
  /* 锁的是：close() 必须在 try 之前调用。 */
  assert.ok(iClose >= 0, 'run 必须调 close()');
  /* 锁的是：顺序 —— 先关面板，再执行命令（执行失败也不会留下遮挡层）。 */
  assert.ok(iClose < iTry, 'close() 应在 try 之前（先关面板再执行）');
});

t('CM12 标题栏搜索占位符与实际快捷键一致', () => {
  const s = read('js/i18n.js');
  /* 锁的是：文案别撒谎。Ctrl+K 已经改成开命令面板，
   * 占位符还写"快速聚焦"会让用户以为按了只是聚焦搜索框。 */
  const zh = s.match(/'search\.titlebar':\s*'([^']+)'/);
  assert.ok(zh, '需有 search.titlebar 文案');
  /* 锁的是：中文占位符必须提到"命令面板"（与 Ctrl+K 的实际行为对齐）。 */
  assert.ok(/命令面板/.test(zh[1]), '中文占位符应说明是命令面板，实际: ' + (zh && zh[1]));
  /* 锁的是：中英两份都要有（英文界面不能缺失这条文案）。 */
  const en = s.match(/'search\.titlebar':\s*'([^']+)'/g);
  assert.ok(en && en.length >= 2, '中英两份占位符都要有');
});

t('CM13 按键监听挂在 document 上并在关闭时摘掉（第四轮审查）', () => {
  const s = read('js/cmdk.js');
  /* 背景：结果行是带 tabindex 的 div，Tab 一次焦点就离开输入框。
   * 监听只挂在 inputEl 上时，Esc 关不掉、↑↓ 不动（鼠标点列表空白区、
   * 焦点回到 body 时同样死），而面板层级 2000 会盖住看得见的界面。 */
  /* 锁的是：监听又挂回输入框 —— Tab 之后键盘导航整段失效。 */
  assert.ok(/document\.addEventListener\(['"]keydown['"], onKey\)/.test(s),
    '键盘监听必须挂在 document 上（否则 Tab 到结果行后 Esc/↑↓ 失效）');
  /* 锁的是：关闭时不摘监听 —— 面板关了还在全局劫持 Esc / 方向键。 */
  assert.ok(/document\.removeEventListener\(['"]keydown['"], onKey\)/.test(s),
    '关闭面板必须摘掉 document 上的 keydown 监听');
  /* 锁的是：又给输入框单独挂一份 —— 事件会冒泡，一次 Enter 会执行两次。 */
  assert.ok(!/inputEl\.addEventListener\(['"]keydown['"]/.test(s),
    '不能再给输入框单独挂 keydown（会和 document 监听重复触发）');
});

done();
