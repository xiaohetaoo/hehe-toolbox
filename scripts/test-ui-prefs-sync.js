'use strict';
/* 全局 UI 偏好（语言 / 配色 / 深浅）要广播到所有窗口，各窗口收到后自己应用。
 *
 * ============ 锁的是哪个回归 ============
 * 三个不同实例，同一个共因 —— 这几项状态的所有权在渲染层，主进程只被动
 * 接收渲染层的 SET_*，从来没有反向通道：
 *   · 语言：SET_LANG 只更新主进程 uiLang + 重建托盘；渲染层 i18n.setLang
 *     只作用当前窗口 → 主窗切成英文后，已打开的独立工具窗仍是中文。
 *   · 配色：broadcastAccent 只遍历 auxWindows()（标尺/贴图/截图标注），
 *     不含 toolWindows → 独立工具窗保持旧主色。
 *   · 主题：setThemeAttr 写的是本窗口的 data-theme，SET_THEME 只改
 *     nativeTheme.themeSource → 其它窗口的 CSS 不跟着变。
 *
 * ============ 验证方式：把真源码装进桩里跑 ============
 * 这些函数全是「读若干模块级变量 → 调若干函数」。与其读源码断言"有没有调"，
 * 不如把函数体从 main.js / js/app.js 里取出来、用桩补齐它依赖的东西、
 * 真的调用一次，然后看桩上留下了什么痕迹。
 * 跑的是**将来真会跑的那段代码**，不是副本 —— 实现改了测试会跟着变。
 *
 * 这不是洁癖：本项目历史上多次因为「测试测副本」而假绿（见 harness 头部）。
 */
const path = require('path');
const fs = require('fs');
const { t, done, assert, readSrc } = require('./lib/harness');
const srcScan = require('../lib/src-scan');

const ROOT = path.join(__dirname, '..');
const mainSrc = readSrc('main.js');
const appSrc = readSrc('js/app.js');

/* ============================================================
 * 从源码里取出一个函数/箭头函数，装进受控作用域执行
 * ============================================================ */

/** 取 `handle(CH.X.Y, (e, …) => { … })` 里那个**完整**箭头函数的源码。
 * 【必须从实参起点开始截】只取 `=>` 之后的话是 `{ … }` —— 一个块语句，
 * 拼进 `const handler = ` 后面就成了对象字面量语法错误（实测踩过：
 * "Unexpected identifier 'next'"）。 */
function arrowOfHandler(key) {
  const at = mainSrc.indexOf('handle(CH.' + key + ',');
  assert.ok(at > 0, '找不到 handler ' + key);
  /* 实参起点：通道名之后那个逗号的下一个非空白字符。 */
  const comma = mainSrc.indexOf(',', at);
  assert.ok(comma > 0, key + ' 的注册没有逗号');
  const argStart = mainSrc.slice(comma + 1).search(/\S/) + comma + 1;
  const arrow = mainSrc.indexOf('=>', argStart);
  assert.ok(arrow > 0, key + ' 不是箭头函数');
  const open = mainSrc.indexOf('{', arrow);
  /* scanBrace 返回的是配平的 `}` 之后一位（不含），拿它当切片右端刚好。 */
  const end = srcScan.scanBrace(mainSrc, open);
  assert.ok(end > open, key + ' 的函数体括号不配平');
  /* 【切到 end 为止，不要 end+1】scanBrace 的返回值已经是 `}` 之后的位置；
   * 再 +1 会把 `handle(...)` 的收尾 `)` 也吞进来，
   * 拼成 `const handler = (e,x) => {…})` —— 语法错误「Unexpected token ')'」。 */
  return { src: mainSrc.slice(argStart, end), text: mainSrc.slice(at, end) };
}

/**
 * 编译一段「模块级变量声明 + 函数体 + 观察窗」，返回观察结果。
 * @param {string} prelude 模块级变量声明（模拟闭包）
 * @param {string} body    要执行的语句（通常是调用那个函数）
 * @param {string[]} params 由桩注入的名字
 * @param {any[]} args     对应的桩
 */
function runScoped(prelude, body, params, args) {
  const f = new Function(...params, prelude + '\n' + body);
  return f(...args);
}

/* ============================================================
 * ① 通道表两侧同步（行为）
 * ============================================================ */

t('U1 新通道在两侧常量表里都存在且值相同', () => {
  /* 锁的是：两份通道表不一致 —— 运行时是「No handler registered」或收不到事件。
   * 行为断言：把渲染层那份 IIFE 在最小 window 桩里真的求值。
   *
   * 【这里用 readFileSync 而不是 readSrc，是有意的】要求值的是一段要
   * **原样执行**的浏览器脚本，readSrc 会先剥注释 —— 而剥注释会改变
   * 被求值文本的内容（虽然对本文件无害，但让"求值的是项目里那份"这个
   * 前提变得不直观）。求值前不需要剥注释：注释不参与语义。
   * 已登记在 scripts/source-assertions-baseline.txt 的 exact 类别里。 */
  const lib = require('../lib/channels').flatten();
  assert.strictEqual(lib['APP.UI_PREFS_CHANGED'], 'app:ui-prefs-changed',
    '主进程侧没有登记 APP.UI_PREFS_CHANGED');

  const src = fs.readFileSync(path.join(ROOT, 'js', 'channels.js'), 'utf8');
  const fakeWindow = {};
  const get = new Function('window', src + '\nreturn window.Channels;');
  const rd = get(fakeWindow).flatten();
  assert.strictEqual(rd['APP.UI_PREFS_CHANGED'], lib['APP.UI_PREFS_CHANGED'],
    '渲染层那份表的键或值不一致');
});

t('U2 它被声明成「纯推送」通道（不是漏了 handle）', () => {
  /* 锁的是：给一条纯推送通道开了 handle，变成无人调用的死入口；
   * 或反过来忘了登记 PUSH_ONLY，导致 6c 把它当成"漏注册"。
   * 行为断言：直接 require 声明并检查内容。 */
  const { PUSH_ONLY } = require('../lib/channels');
  assert.ok(Array.isArray(PUSH_ONLY), 'lib/channels.js 应导出 PUSH_ONLY 数组');
  assert.ok(PUSH_ONLY.indexOf('APP.UI_PREFS_CHANGED') >= 0,
    'APP.UI_PREFS_CHANGED 是纯推送通道，必须登记进 PUSH_ONLY');
});

/* ============================================================
 * ② broadcastUiPrefs：发给谁、带什么、目标死了怎么办
 * ============================================================ */

/** 造一个能观察「收到了什么」的假 BrowserWindow。 */
function fakeWin(tag, opts) {
  const o = opts || {};
  const got = [];
  return {
    tag,
    got,
    isDestroyed: () => !!o.destroyed,
    webContents: {
      send(ch, payload) {
        if (o.throws) throw new Error('Object has been destroyed');
        got.push({ ch, payload });
      },
    },
  };
}

/** 把 broadcastUiPrefs 装进桩里，返回可直接调用的函数。
 *
 * 【这是"装进桩里跑"，不是源码断言】extractFn 只是取源码的手段；
 * 下面每个用例都真的执行这段代码，然后看桩上留下了什么痕迹。
 * 判据是运行结果（谁收到了、收到了什么），不是文本形态。 */
function makeBroadcastSandbox(wins) {
  const fnSrc = srcScan.extractFn(mainSrc, 'function broadcastUiPrefs()', 'broadcastUiPrefs');
  const ctx = {
    uiLang: 'en',
    currentAccent: 'jade',
    nativeTheme: { shouldUseDarkColors: true },
    win: wins.main || null,
    toolWindows: wins.tools || [],
    auxWindows: () => wins.aux || [],
    CH: { APP: { UI_PREFS_CHANGED: 'app:ui-prefs-changed' } },
  };
  const f = new Function(
    'uiLang', 'currentAccent', 'nativeTheme', 'win', 'toolWindows', 'auxWindows', 'CH',
    fnSrc + '\nreturn broadcastUiPrefs;');
  return f(ctx.uiLang, ctx.currentAccent, ctx.nativeTheme, ctx.win,
    ctx.toolWindows, ctx.auxWindows, ctx.CH);
}

t('U6 广播的目标列表包含独立工具窗口（不只是主窗与辅助窗）', () => {
  /* 锁的是问题 1 的共因：broadcastAccent 只遍历 auxWindows()，不含
   * toolWindows —— 独立工具窗永远收不到偏好变更，停在旧语言/旧主色/旧明暗。 */
  const main = fakeWin('main');
  const tool1 = fakeWin('tool1');
  const tool2 = fakeWin('tool2');
  const aux = fakeWin('aux');
  const broadcast = makeBroadcastSandbox({ main, tools: [tool1, tool2], aux: [aux] });
  broadcast();

  const gotAll = [main, tool1, tool2, aux].filter((w) => w.got.length === 1);
  assert.strictEqual(gotAll.length, 4,
    '应有 4 个窗口各收到 1 条，实际 ' + gotAll.map((w) => w.tag).join(','));
  assert.strictEqual(tool1.got[0].ch, 'app:ui-prefs-changed', '发给独立工具窗的不是新通道');
});

t('U7 广播带上语言 / 配色 / 解析后的明暗（system 由主进程解析一次）', () => {
  /* 锁的是：各窗口自己按 matchMedia 解析 'system' —— 时机会不一致，
   * 同一个主题在不同窗口上可能是明/暗两样。主进程解析一次，发出去的是确定值。 */
  const main = fakeWin('main');
  const broadcast = makeBroadcastSandbox({ main });
  broadcast();
  assert.strictEqual(main.got.length, 1, '主窗口没收到广播');
  const p = main.got[0].payload;
  assert.strictEqual(p.lang, 'en', '广播里的语言不是主进程的当前语言');
  assert.strictEqual(p.accent, 'jade', '广播里的配色不对');
  assert.strictEqual(p.theme, 'dark', "system 没有被解析成 dark/light");
});

t('U8 某个目标已销毁/发送抛异常时，其余窗口照样收到', () => {
  /* 锁的是：用户正在关窗口时广播抛异常，导致排在后面的窗口都收不到 ——
   * 表现是"有时生效有时不生效"，最难归因的那一类。 */
  const main = fakeWin('main');
  const dead = fakeWin('tool-dead', { destroyed: true });
  const thrower = fakeWin('tool-throw', { throws: true });
  const alive = fakeWin('tool-alive');
  const broadcast = makeBroadcastSandbox({ main, tools: [dead, thrower, alive] });
  broadcast();

  assert.strictEqual(dead.got.length, 0, '已销毁的窗口不该收到');
  assert.strictEqual(main.got.length, 1, '销毁的窗口把主窗口的广播也中断了');
  assert.strictEqual(alive.got.length, 1,
    '排在抛异常窗口之后的窗口没收到 —— 说明 send 没有各自包 try');
});

/* ============================================================
 * ③ 三个 handler：改完之后必须广播
 * ============================================================ */

/** 把 SET_LANG 的箭头函数装进桩里执行，返回观察结果。 */
function runSetLang(lang, opts) {
  const o = opts || {};
  const { src } = arrowOfHandler('APP.SET_LANG');
  const calls = { createTray: 0, broadcast: 0, trayDestroyed: 0 };
  const prelude = "let uiLang = " + JSON.stringify(o.uiLang || 'zh') + ";\n"
    + "let tray = " + (o.hasTray === false ? 'null' : "makeTrayObj()") + ";";
  const body = "const handler = " + src + ";\n"
    + "const ret = handler({}, " + JSON.stringify(lang) + ");\n"
    + "return { ret, uiLang, trayIsNull: tray === null, calls };";
  return runScoped(prelude, body,
    ['makeTrayObj', 'createTray', 'broadcastUiPrefs', 'calls'],
    [() => ({ destroy() { calls.trayDestroyed++; } }),
      () => { calls.createTray++; },
      () => { calls.broadcast++; },
      calls]);
}

t('U3 语言变更后广播，且广播的是新语言', () => {
  /* 锁的是：SET_LANG 只重建托盘、不通知其它窗口 —— 主窗切英文，
   * 独立窗仍是中文（用户刚从那里拖出去，两秒内看到两种语言）。 */
  const r = runSetLang('en', { uiLang: 'zh' });
  assert.strictEqual(r.uiLang, 'en', '主进程的语言没更新');
  assert.strictEqual(r.calls.createTray, 1, '托盘没重建');
  assert.strictEqual(r.calls.broadcast, 1, 'SET_LANG 没有广播 —— 独立窗会停在旧语言');
});

t('U3b 语言没变时不重复广播（避免无谓重建别的窗口）', () => {
  /* 锁的是：无条件广播 —— 三个窗口里两个已经是 en，切一次语言让它们
   * 白重建一次，用户正打开的弹窗会被按取消结束。 */
  const r = runSetLang('zh', { uiLang: 'zh' });
  assert.strictEqual(r.calls.broadcast, 0, '语言没变却广播了');
});

t('U4 配色变更后既通知辅助窗口、又广播给独立工具窗口', () => {
  /* 锁的是：broadcastAccent 只遍历 auxWindows()，不含 toolWindows ——
   * 用户换了主色，独立工具窗仍是旧蓝。 */
  const { src } = arrowOfHandler('APP.SET_ACCENT');
  const calls = { aux: [], prefs: 0 };
  const prelude = "const ACCENT_IDS = ['polar','mist','jade','violet','rose','gold','teal','sand','mono'];\n"
    + "let currentAccent = 'polar';";
  const body = "const handler = " + src + ";\n"
    + "const ret = handler({}, 'jade');\n"
    + "return { ret, currentAccent, calls };";
  const r = runScoped(prelude, body,
    ['broadcastAccent', 'broadcastUiPrefs', 'calls'],
    [(id) => { calls.aux.push(id); }, () => { calls.prefs++; }, calls]);

  assert.strictEqual(r.ret, 'jade');
  assert.deepStrictEqual(calls.aux, ['jade'], '辅助窗口没收到 aux:accent');
  assert.strictEqual(calls.prefs, 1,
    'SET_ACCENT 没有广播界面偏好 —— 独立工具窗口会停在旧主色');
});

t('U4b 不认识的配色 id 退回默认色（且广播出去的是解析后的值）', () => {
  /* 锁的是：把用户传进来的任意字符串直接写进 currentAccent，
   * 之后广播出去的就是一个 CSS 里不存在的 data-accent。 */
  const { src } = arrowOfHandler('APP.SET_ACCENT');
  const calls = { aux: [] };
  const prelude = "const ACCENT_IDS = ['polar','mist'];\nlet currentAccent = 'mist';";
  const body = "const handler = " + src + ";\n"
    + "const ret = handler({}, 'not-a-color');\n"
    + "return { ret, currentAccent, calls };";
  const r = runScoped(prelude, body,
    ['broadcastAccent', 'broadcastUiPrefs', 'calls'],
    [(id) => { calls.aux.push(id); }, () => {}, calls]);
  assert.strictEqual(r.ret, 'polar', '未知配色没有退回 polar');
  assert.deepStrictEqual(calls.aux, ['polar'], '广播出去的是未解析的原始值');
});

t('U5 主题变更后广播，且带上解析后的 dark/light', () => {
  /* 锁的是：SET_THEME 只改 nativeTheme.themeSource，而 CSS 走的是
   * data-theme 属性 —— 其它窗口的 DOM 完全没变，看起来"主题没生效"。 */
  const { src } = arrowOfHandler('APP.SET_THEME');
  const calls = { prefs: 0 };
  const prelude = "const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false };";
  const body = "const handler = " + src + ";\n"
    + "const ret = handler({}, 'dark');\n"
    + "return { ret, themeSource: nativeTheme.themeSource, calls };";
  const r = runScoped(prelude, body, ['broadcastUiPrefs', 'calls'],
    [() => { calls.prefs++; }, calls]);
  assert.strictEqual(r.themeSource, 'dark', '主题源没被设置');
  assert.strictEqual(r.calls.prefs, 1, 'SET_THEME 没有广播界面偏好');
});

/* ============================================================
 * ④ 渲染层：订阅、应用、退订
 * ============================================================ */

/** 把 bindUiPrefs 装进桩里，返回 { handlers, calls } */
function makeBindSandbox(opts) {
  const o = opts || {};
  const fnSrc = srcScan.extractFn(appSrc, 'function bindUiPrefs()', 'bindUiPrefs');
  const calls = { applied: [], appliedLabels: 0, on: [], unsubs: 0 };
  const handlers = [];
  const on = (ch, cb) => {
    calls.on.push(ch);
    handlers.push(cb);
    return () => { calls.unsubs++; };
  };
  /* 【handlers / calls 要一起传进去】函数体里出现的每个自由标识符
   * 都必须是形参，否则 new Function 里是 ReferenceError。
   * 这里显式列全，比把桩挂到 globalThis 好：不会污染别的测试。 */
  const params = ['isDesktop', 'on', 'Channels', 'window', 'applyAccent', 'setThemeAttr',
    'applyLang', 'applyLangLabels', 'calls', 'handlers'];
  const prelude = "let uiPrefsUnsub = null;\nlet lang = " + JSON.stringify(o.lang || 'zh') + ";\n"
    + "const prefsFromBroadcast = { accent: false, theme: false };";
  const body = fnSrc + "\nbindUiPrefs();\nreturn { getActive: () => uiPrefsUnsub };";
  const f = new Function(...params, prelude + '\n' + body);
  const res = f(
    o.isDesktop === false ? false : true,
    on,
    { CHANNELS: { APP: { UI_PREFS_CHANGED: 'app:ui-prefs-changed' } } },
    { i18n: { normalize: (x) => (x === 'en' || x === 'zh' ? x : null) } },
    (a) => { calls.applied.push(['accent', a]); },
    (th) => { calls.applied.push(['theme', th]); },
    (l) => { calls.applied.push(['lang', l]); },
    () => { calls.appliedLabels++; },
    calls, handlers);
  return { handlers, calls, getActive: res.getActive };
}

t('U9 渲染层订阅了这条通道（否则广播发了没人收）', () => {
  /* 锁的是：主进程发、渲染层不收 —— 运行时完全静默，既无异常也无日志，
   * 只是"独立窗不跟随"，用户无法归因。 */
  const sb = makeBindSandbox();
  assert.strictEqual(sb.calls.on.length, 1, '没有订阅');
  assert.strictEqual(sb.calls.on[0], 'app:ui-prefs-changed', '订阅的不是新通道');
});

t('U10 收到广播后三项都应用了（语言/配色/明暗）', () => {
  /* 锁的是：只应用了其中一两项 —— 比如只切了语言，主色仍是旧的。 */
  const sb = makeBindSandbox({ lang: 'zh' });
  sb.handlers[0]({ lang: 'en', accent: 'rose', theme: 'dark' });
  const kinds = sb.calls.applied.map((x) => x[0]).sort();
  assert.deepStrictEqual(kinds, ['accent', 'lang', 'theme'],
    '收到广播后应用的项目不全：' + JSON.stringify(sb.calls.applied));
  assert.strictEqual(sb.calls.appliedLabels, 1, '语言变了却没有触发整壳重建');
});

t('U11 语言没变时不重建（避免把用户正开着的弹窗按取消结束）', () => {
  /* 锁的是：两个窗口里已经是 en 的那个收到广播后也重建一次 ——
   * resetShellForRebuild 会把用户正打开的弹窗按"取消"结束掉。 */
  const sb = makeBindSandbox({ lang: 'en' });
  sb.handlers[0]({ lang: 'en', accent: 'rose', theme: 'dark' });
  assert.strictEqual(sb.calls.appliedLabels, 0, '语言没变却重建了整壳');
  /* 但外观还是要应用 —— 它们与语言无关。 */
  const kinds = sb.calls.applied.map((x) => x[0]).sort();
  assert.deepStrictEqual(kinds, ['accent', 'theme'], '语言没变就不应用外观了？');
});

t('U11b 非法载荷被忽略（不能让一条坏消息炸掉订阅）', () => {
  /* 锁的是：广播载荷可能是 null / 字符串（老版本主进程、或通道被别的东西复用）。
   * 不判就会在回调里抛 TypeError —— 而它在事件分发里，异常会被吞掉或拖垮后续。 */
  const sb = makeBindSandbox();
  for (const bad of [null, undefined, 'x', 42]) {
    sb.handlers[0](bad);
  }
  assert.strictEqual(sb.calls.applied.length, 0, '非法载荷被当成偏好应用了');
});

t('U12 重复绑定前会退订上一份（否则切 N 次语言就有 N 份订阅）', () => {
  /* 锁的是：收到广播 → applyLangLabels 整壳重建 → 又订阅一次，
   * 切 N 次语言之后一次广播触发 N 次重建（界面越来越卡、toast 连弹）。 */
  const sb = makeBindSandbox();
  /* 再绑一次（模拟启动流程里第二次进入） */
  const before = sb.calls.unsubs;
  assert.strictEqual(before, 0, '第一次绑定不该退订任何东西');

  /* 直接调第二次：把 bindUiPrefs 再跑一遍需要重新编译（它读的是模块级
   * uiPrefsUnsub），用同一份沙箱内的函数重入更贴近真实 —— 这里改为
   * 断言"第二次绑定会调用第一次返回的 unsub"由 U12b 覆盖。 */
  assert.ok(typeof sb.getActive() === 'function', '没有把退订函数存到模块级变量');
});

t('U12b 连续绑定两次 → 第一份被退订，最终只剩一份订阅生效', () => {
  /* 锁的是同一条回归的另一面：只存不退。切 N 次语言就有 N 份订阅，
   * 一次广播触发 N 次重建（界面越来越卡、toast 连弹）。 */
  const fnSrc = srcScan.extractFn(appSrc, 'function bindUiPrefs()', 'bindUiPrefs');
  const calls = { on: 0, unsub: 0 };
  const on = (ch, cb) => { calls.on++; void cb; return () => { calls.unsub++; }; };
  const params = ['isDesktop', 'on', 'Channels', 'window', 'applyAccent', 'setThemeAttr',
    'applyLang', 'applyLangLabels', 'calls'];
  const prelude = 'let uiPrefsUnsub = null;\nlet lang = "zh";';
  const body = fnSrc + '\nbindUiPrefs();\nbindUiPrefs();\nreturn { onCount: calls.on };';
  const f = new Function(...params, prelude + '\n' + body);
  const res = f(true, on,
    { CHANNELS: { APP: { UI_PREFS_CHANGED: 'app:ui-prefs-changed' } } },
    { i18n: { normalize: (x) => (x === 'en' || x === 'zh' ? x : null) } },
    () => {}, () => {}, () => {}, () => {}, calls);
  assert.strictEqual(res.onCount, 2, '应订阅两次');
  assert.strictEqual(calls.unsub, 1,
    '第二次绑定没有退订第一份 —— 切 N 次语言就有 N 份订阅同时生效');
});

t('U13 应用配色时不回头通知主进程（否则形成广播回环）', () => {
  /* 锁的是一个很容易写出来的回环：收到广播 → 调 setAccent →
   * setAccent 末尾 invoke(app:set-accent) → 主进程再广播 → …
   * 两个窗口就够让它一直转下去。 */
  const fnSrc = srcScan.extractFn(appSrc, 'function applyAccent(', 'applyAccent');
  let invoked = 0;
  const prelude = "const ACCENTS = [{id:'polar'},{id:'jade'}];\nlet currentAccent = 'polar';\n"
    + "const document = { documentElement: { dataset: {} } };";
  const body = fnSrc + "\napplyAccent('jade');\n"
    + "return { currentAccent, accent: document.documentElement.dataset.accent };";
  const f = new Function('invoke', 'isDesktop', 'Channels', prelude + '\n' + body);
  const r = f(() => { invoked++; }, true, { CHANNELS: { APP: { SET_ACCENT: 'app:set-accent' } } });

  assert.strictEqual(r.accent, 'jade', 'applyAccent 没有改本窗口的 data-accent');
  assert.strictEqual(invoked, 0,
    'applyAccent 里调了 invoke —— 收到广播后会再通知主进程，形成 A→主进程→A 的回环');
});

t('U14 用户点击色卡（setAccent）仍要通知主进程', () => {
  /* 锁的是：为了防回环把"用户点了色卡"这条路也掐了 ——
   * 那样其它窗口谁都收不到，主色只在当前窗口生效。 */
  const fnSrc = srcScan.extractFn(appSrc, 'function setAccent(', 'setAccent');
  const sent = [];
  const prelude = "const ACCENTS = [{id:'polar'},{id:'jade'}];\nlet currentAccent = 'polar';\n"
    + "const document = { documentElement: { dataset: {} } };\n"
    + "const prefsFromBroadcast = { accent: false, theme: false };";
  const body = fnSrc + "\nsetAccent('jade');\nreturn { currentAccent };";
  const f = new Function('invoke', 'isDesktop', 'Channels', prelude + '\n' + body);
  f((ch, id) => { sent.push([ch, id]); return { catch() {} }; }, true,
    { CHANNELS: { APP: { SET_ACCENT: 'app:set-accent' } } });

  assert.deepStrictEqual(sent, [['app:set-accent', 'jade']],
    '用户点击色卡后没有通知主进程，其它窗口不会跟着换色');
});

/* ---------- ⑤ 广播与本地读取的竞争（e2e 才暴露出来的真缺陷） ---------- */

t('U15 广播应用过的配色/明暗，不会被更慢的 store:get 盖回旧值', async () => {
  /* 锁的是一个只在 e2e 里显形的竞态：
   * applyTheme() 里的 store:get 要两次 IPC 往返，所以 UI 偏好广播完全可能
   * 在它返回**之前**到达。那时广播先把 accent 改对，随后那次（早于广播
   * 发出的）读取才返回旧值，把它盖回去 —— 用户刚在另一个窗口换的配色，
   * 在这个窗口上闪一下就退回旧色。
   *
   * 【怎么把它变成确定性的单测】把 applyTheme 的回调**单独**取出来跑：
   * 它是纯的「读到一个值 → 决定要不要应用」。先在 prefsFromBroadcast
   * 里置位（等于"广播已经应用过"），再调那个回调，看它有没有动手。
   * 这比伪造两条 promise 的先后顺序稳得多，也直接对准了修复的那一行。 */
  const fnSrc = srcScan.extractFn(appSrc, 'function applyTheme()', 'applyTheme');

  /* 用一个可观察的 invoke：把两个 .then 回调抓出来，手动喂旧值。
   * 【抓取用的数组由外层持有】不能在 new Function 的体内声明 ——
   * 那样返回的是一份新数组，外面的断言看不到任何东西（实测开始时
   * 就在这里得到 callbacks.length === 0）。 */
  const callbacks = [];
  const invoked = [];
  const invoke = (ch, key) => {
    invoked.push(key);
    return {
      then(cb) { callbacks.push({ key, cb }); return { catch() {} }; },
      catch() {},
    };
  };
  const applied = [];
  const prelude = "let schemeListenerBound = true;\n"
    + "const themeListeners = [];\n"
    + "const prefsFromBroadcast = { accent: false, theme: false };";
  const body = fnSrc + "\napplyTheme();\nreturn { n: callbacks.length };";
  const f = new Function('invoke', 'isDesktop', 'Channels', 'window', 'on',
    'setThemeAttr', 'setAccent', 'callbacks', prelude + '\n' + body);
  f(invoke, true,
    { CHANNELS: { STORE: { GET: 'store:get' } } },
    { matchMedia: () => ({ addEventListener() {} }) },
    () => () => {},
    () => { applied.push('theme'); },
    () => { applied.push('accent'); },
    callbacks);

  assert.strictEqual(callbacks.length, 2,
    'applyTheme 应发起两次读取（theme 与 accent），实际 ' + callbacks.length);

  /* ① 没有广播时：本地读取照常生效（不能为了修竞态把正常路径也堵了）。 */
  for (const c of callbacks.slice()) c.cb('polar');
  assert.deepStrictEqual(applied.sort(), ['accent', 'theme'],
    '没有广播的情况下本地读取被忽略了 —— 正常启动时主题/配色不会生效');

  /* ② 广播已应用过：本地读取必须让路，不能盖回旧值。 */
  applied.length = 0;
  const cb2 = [];
  const invoke2 = (ch) => ({ then(cb) { cb2.push(cb); return { catch() {} }; }, catch() {} });
  const sandbox2 = new Function('invoke', 'isDesktop', 'Channels', 'window', 'on',
    'setThemeAttr', 'setAccent', 'callbacks',
    "let schemeListenerBound = true;\nconst themeListeners = [];\n"
    + "const prefsFromBroadcast = { accent: true, theme: true };"
    + fnSrc + "\napplyTheme();\nreturn { n: callbacks.length };");
  sandbox2(invoke2, true,
    { CHANNELS: { STORE: { GET: 'store:get' } } },
    { matchMedia: () => ({ addEventListener() {} }) },
    () => () => {},
    () => { applied.push('theme'); },
    () => { applied.push('accent'); },
    cb2);
  for (const c of cb2.slice()) c('polar');   // 带回的是旧值
  assert.deepStrictEqual(applied, [],
    '广播已经应用过，本地读取还是把值盖了回去 —— 用户刚换的主色会闪一下退回旧色');
});

t('U16 用户在本窗口主动改主题/配色后，本地读取恢复生效', () => {
  /* 锁的是 U15 修复的副作用：覆盖标记一旦置上就再也不解除 ——
   * 用户改了配色、重启应用，看到的还是上次广播来的值。 */
  const setAccentSrc = srcScan.extractFn(appSrc, 'function setAccent(', 'setAccent');
  const prelude = "const ACCENTS = [{id:'polar'},{id:'jade'}];\n"
    + "let currentAccent = 'polar';\n"
    + "const document = { documentElement: { dataset: {} } };\n"
    + "const prefsFromBroadcast = { accent: true, theme: true };";
  const body = setAccentSrc + "\nsetAccent('jade');\nreturn { accent: prefsFromBroadcast.accent };";
  const f = new Function('invoke', 'isDesktop', 'Channels', prelude + '\n' + body);
  const r = f(() => ({ catch() {} }), true,
    { CHANNELS: { APP: { SET_ACCENT: 'app:set-accent' } } });
  assert.strictEqual(r.accent, false,
    '用户主动换色后没有解除广播覆盖标记 —— 之后本地读取会被永久忽略');
});

done();
