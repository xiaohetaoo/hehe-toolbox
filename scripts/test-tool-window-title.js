'use strict';
/* 独立工具窗口的标题必须带工具名（不能都叫「核核工具箱」）。
 *
 * ============ 锁的是哪个回归 ============
 * openToolWindow 里的 BrowserWindow 选项把 title 写死成「核核工具箱」，
 * loadFile 之后也没有任何地方设 document.title（全项目零处赋值）。
 * 于是开三个工具窗口后，任务栏与 Alt+Tab 里是三个同名条目，
 * 只能靠缩略图辨认哪个是哪个 —— 而缩略图在 Alt+Tab 里是小尺寸的，
 * 根本看不清。
 *
 * 更隐蔽的一层：即使主进程设了 title，页面加载完成后 Electron 会把
 * document.title（index.html 里写死的「核核工具箱」）同步回窗口标题，
 * 把主进程那次覆盖掉。所以**两边都得设**，各管一个阶段。
 *
 * ============ 验证方式 ============
 * ① lib/tool-names.js 是纯数据 + 纯函数：直接 require、直接断言返回值（行为）。
 * ② 它与真实注册表是否一致：扫 js/tools 下每个 register({...}) 块做对账。
 *    这条只能是源码断言（注册表是浏览器脚本，Node 里 require 会立刻 TypeError），
 *    而它要防的正是「新增工具忘了补这张表」—— 那是个文本事实。
 * ③ 主进程不再写死标题、渲染层补了 document.title：读源码。
 */
const fs = require('fs');
const path = require('path');
const { t, done, assert, readSrc } = require('./lib/harness');
const srcScan = require('../lib/src-scan');

const ROOT = path.join(__dirname, '..');
const { TOOL_NAMES, toolTitle, DEFAULT_TITLE } = require('../lib/tool-names');

/* ---------- ① 纯函数行为 ---------- */

t('N1 中文模式返回工具中文名', () => {
  assert.strictEqual(toolTitle('video-trim'), '视频裁剪');
  assert.strictEqual(toolTitle('hash-tool'), '哈希校验');
  assert.strictEqual(toolTitle('base64', 'zh'), 'Base64 编解码');
});

t('N2 英文模式返回工具英文名（跟随界面语言）', () => {
  assert.strictEqual(toolTitle('video-trim', 'en'), 'Video Trim');
  assert.strictEqual(toolTitle('hash-tool', 'en'), 'Hash Check');
});

t('N3 未知 id 返回兜底标题，绝不返回空串', () => {
  /* title 为空串时 Electron 会显示可执行文件名（hehe-toolbox.exe），
   * 比兜底更莫名其妙。 */
  assert.strictEqual(toolTitle('不存在的工具'), DEFAULT_TITLE);
  assert.strictEqual(toolTitle(''), DEFAULT_TITLE);
  assert.strictEqual(toolTitle(null), DEFAULT_TITLE);
  assert.ok(DEFAULT_TITLE.length > 0);
});

t('N4 每个工具的标题都不是「核核工具箱」（那等于没改）', () => {
  /* 锁的是回归本身：所有窗口同名。 */
  const same = Object.keys(TOOL_NAMES).filter((id) => toolTitle(id) === DEFAULT_TITLE);
  assert.deepStrictEqual(same, [], '这些工具的标题仍是兜底名：' + same.join(', '));
});

/* ---------- ② 与注册表对账 ---------- */

/** 扫 js/tools 下所有 register({...})，取出 id / name / nameEn。 */
function registryTools() {
  const dir = path.join(ROOT, 'js', 'tools');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && e.name !== 'i18n.js') files.push(p);
    }
  })(dir);

  const out = [];
  for (const f of files) {
    /* readSrc 会剥注释 —— 注释里出现的 id: 'xxx' 示例不该被当成真注册。 */
    const rel = String(path.relative(ROOT, f)).split(path.sep).join('/');
    const src = readSrc(rel);
    for (const m of src.matchAll(/register\(\{/g)) {
      const open = src.indexOf('{', m.index);
      const end = srcScan.scanBrace(src, open);
      if (end < 0) continue;
      const obj = src.slice(open, end);
      const idm = /\bid:\s*'([^']+)'/.exec(obj);
      if (!idm) continue;
      const nm = /\bname:\s*'([^']*)'/.exec(obj);
      const en = /\bnameEn:\s*'([^']*)'/.exec(obj);
      out.push({ id: idm[1], zh: nm ? nm[1] : '', en: en ? en[1] : '' });
    }
  }
  return out;
}

const tools = registryTools();

t('N5 每个注册的工具都在标题表里（新增工具忘了补表会红）', () => {
  /* 锁的是：这张表是渲染层注册表在主进程侧的手工镜像，必然有漂移风险。
   * 只能用源码断言：要拿到"有哪些工具"只能扫注册块 ——
   * js/tools/*.js 是浏览器脚本，在 Node 里 require 会立刻 TypeError。 */
  assert.ok(tools.length >= 100, '只扫到 ' + tools.length + ' 个工具，正则疑似失效（这条会空转）');
  const missing = tools.filter((x) => !TOOL_NAMES[x.id]).map((x) => x.id);
  assert.deepStrictEqual(missing, [],
    '这些工具没有登记进 lib/tool-names.js（独立窗口标题会退化成兜底名）：\n  ' + missing.join('\n  '));
});

t('N6 标题表里没有多余的条目（工具删了，表里还留着）', () => {
  const ids = new Set(tools.map((x) => x.id));
  const extra = Object.keys(TOOL_NAMES).filter((id) => !ids.has(id));
  assert.deepStrictEqual(extra, [],
    '这些 id 在 lib/tool-names.js 里但注册表里没有（工具已删除或改名）：\n  ' + extra.join('\n  '));
});

t('N7 中英文名字与注册表逐字一致（不是抄错/过期的快照）', () => {
  const diff = [];
  for (const x of tools) {
    const e = TOOL_NAMES[x.id];
    if (!e) continue;                       // N5 已经报过
    if (e.zh !== x.zh) diff.push(x.id + ' 中文：表=' + e.zh + ' 注册表=' + x.zh);
    if (e.en !== x.en) diff.push(x.id + ' 英文：表=' + e.en + ' 注册表=' + x.en);
  }
  assert.deepStrictEqual(diff, [],
    'lib/tool-names.js 与工具注册表不一致（改名后忘了同步）：\n  ' + diff.join('\n  '));
});

/* ---------- ③ 两侧接线 ---------- */

t('N8 主进程不再写死窗口标题', () => {
  /* 锁的是：title: '核核工具箱' 硬编码 —— 所有独立窗口同名。 */
  const mainSrc = readSrc('main.js');
  const i = mainSrc.indexOf('function openToolWindow(');
  assert.ok(i > 0, '找不到 openToolWindow');
  const block = mainSrc.slice(i, mainSrc.indexOf('\nhandle(', i));
  /* 锁的是：title 写死成「核核工具箱」—— 所有独立窗口同名。 */
  assert.ok(!/title:\s*'核核工具箱'/.test(block),
    'openToolWindow 仍然把 title 写死成「核核工具箱」');
  /* 锁的是：根本没设 title（Electron 会用可执行文件名，比写死更糟）。 */
  assert.ok(/toolNames\.toolTitle\(/.test(block),
    'openToolWindow 没有用工具名做标题');
});

t('N9 渲染层在独立窗里补设 document.title', () => {
  /* 锁的是第二层：主进程设了也会被页面加载后的 document.title 覆盖。
   * 两处都设才有效。 */
  const appSrc = readSrc('js/app.js');
  assert.ok(/document\.title\s*=\s*name/.test(appSrc) || /document\.title\s*=/.test(appSrc),
    '渲染层从来没有设过 document.title —— 主进程那次会被页面标题覆盖');
  const i = appSrc.indexOf('function setDocTitle(');
  assert.ok(i > 0, '没有 setDocTitle');
  const fn = srcScan.extractFn(appSrc, 'function setDocTitle(', 'setDocTitle');
  /* 锁的是：主窗口的标题也被改成工具名 —— 主窗标题应保持应用名。
   * 只能用源码断言：要验证得开两个窗口分别读标题。 */
  assert.ok(/IS_STANDALONE/.test(fn), 'setDocTitle 没有限定只在独立窗生效（主窗标题应保持应用名）');
  /* 锁的是：标题不跟随语言 —— 切到英文后任务栏里仍是中文名。 */
  assert.ok(/TN\(/.test(fn), 'setDocTitle 没走 TN（不会跟随语言变英文名）');
});

t('N10 语言变化后窗口标题跟着重设', () => {
  /* 锁的是：切到英文后窗口标题还停在中文 —— 界面全英文、任务栏里却是中文名。 */
  const appSrc = readSrc('js/app.js');
  const fn = srcScan.extractFn(appSrc, 'function applyLangLabels(', 'applyLangLabels');
  assert.ok(/setDocTitle\(\)/.test(fn),
    'applyLangLabels（整壳重建）里没有重设标题 —— 英文界面下窗口标题仍是中文');
});

t('N11 启动时独立窗也会设一次标题', () => {
  const appSrc = readSrc('js/app.js');
  const i = appSrc.indexOf("document.addEventListener('DOMContentLoaded'");
  assert.ok(i > 0, '找不到启动分支');
  const block = appSrc.slice(i, i + 4000);
  /* 锁的是：启动分支里没调 setDocTitle —— 独立窗口第一次打开时标题
   * 仍是「核核工具箱」（主进程那次会被页面加载的 document.title 覆盖）。
   * 只能用源码断言：要验证得真开独立窗并读窗口标题。 */
  assert.ok(/setDocTitle\(\)/.test(block),
    '启动分支里没调 setDocTitle —— 独立窗口第一次打开时标题仍是「核核工具箱」');
});

done();
