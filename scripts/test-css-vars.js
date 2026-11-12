'use strict';
/* CSS 变量引用完整性：var() 里引用的每个变量都必须有定义。
 *
 * ============ 锁的是哪次事故 ============
 * v0.8.3 写全局拖拽样式时用了 var(--bg-1) —— 这个变量在项目里不存在
 * （真实变量名是 --page-bg / --card-bg）。background 退化为初始值（透明）：
 * 拖拽遮罩的中央卡与选择面板 sticky 分组标题在暗色主题下"消失"。
 * 浏览器对未定义变量的处理是**静默回退**，控制台不报任何错，
 * 视觉上只是"看起来有点不对" —— 这类缺陷只有像这样扫一遍才抓得住。
 *
 * 为什么值必须非空：定义了变量但值为空（写成 `--x: ;`）同样会让
 * 属性失效，所以两处都要查。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');

t('CSS1 css/app.css 里 var() 引用的变量全部有定义且值非空', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8');
  const defined = new Map();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]*);/g)) {
    defined.set(m[1], (m[2] || '').trim());
  }
  assert.ok(defined.size >= 40, '变量定义只有 ' + defined.size + ' 个，扫描可能失效');

  const used = new Set();
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]);
  assert.ok(used.size >= 30, '引用的变量只有 ' + used.size + ' 个，扫描可能失效');

  /* 锁的是：引用了未定义的变量（本次事故）—— 属性静默失效，无任何报错。 */
  const missing = [...used].filter((v) => !defined.has(v));
  assert.deepStrictEqual(missing, [],
    'css/app.css 引用了未定义的变量：' + missing.join(', ')
    + '（浏览器会静默回退，界面"看起来不对"却查不到报错）');

  /* 锁的是：变量定义了但值为空 —— 同样会让属性失效。 */
  const empty = [...defined.entries()].filter(([, v]) => !v).map(([k]) => k);
  assert.deepStrictEqual(empty, [], '这些变量定义为空：' + empty.join(', '));
});

t('CSS2 辅助窗口（snip/pin/ruler）里的 var() 引用也必须有定义', () => {
  /* 辅助窗口有自己的 :root 变量（snip.html 自带 9 套 accent 覆盖），
   * 只查它们**引用了但本文件与 app.css 都没定义**的。 */
  const appCss = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8');
  const appDefined = new Set([...appCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  for (const f of ['snip.html', 'pin.html', 'ruler.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const defined = new Set([...html.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...html.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    const missing = [...used].filter((v) => !defined.has(v) && !appDefined.has(v));
    /* 【放行 var(--x, fallback) 的动态变量】
     * JS 用 setProperty('--fill', …) 逐帧更新滑杆的已填充比例，
     * CSS 侧写 var(--fill, 20%) 带缺省值 —— 这是合法模式，
     * 不能当成"未定义"误报。只拦无 fallback 的引用。 */
    const dynOk = new Set([...html.matchAll(/var\((--[a-z0-9-]+)\s*,/g)].map((m) => m[1]));
    const hard = missing.filter((v) => !dynOk.has(v));
    /* 锁的是：辅助窗口引用了谁都没定义、又没有 fallback 的变量 ——
     * snip 的工具条/输入框依赖 --aux-primary 等变量，缺定义会让
     * 标注工具条失去主题色。 */
    assert.deepStrictEqual(hard, [],
      f + ' 引用了未定义且无 fallback 的变量：' + hard.join(', '));
  }
});

t('CSS3 js/ 内联样式里的 var() 引用也必须有定义', () => {
  /* 【这条补的是原来的测试盲区】
   * CSS1/CSS2 只扫 css/app.css 与三个辅助窗口 html，**不扫 js/ 里的内联样式**。
   * 于是 `style: { background: 'var(--fill-1)' }` 这种写在工具页里的引用
   * 完全测不到 —— 审查报告 F3 就是这类：全项目没有 --fill-1 的定义，
   * 两处背景在计算期失效变透明，控制台一个字都不报。
   *
   * 【只扫 js/ 里的字符串字面量】不做完整 JS 解析：目标是"找出代码里
   * 出现的 var(--x) 文本"。剥掉注释与字符串中的普通文本没有必要 ——
   * 注释里若提到 var(--x) 也是有效的设计说明，误报只会促使人补定义
   * 或改用反引号写法，不会掩盖真问题。 */
  const appCss = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8');
  const defined = new Set([...appCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  /* 辅助窗口 html 也自带一批变量（--aux-*） */
  for (const f of ['snip.html', 'pin.html', 'ruler.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of html.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  }

  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'js'));

  assert.ok(files.length >= 50, 'js 文件只有 ' + files.length + ' 个，扫描可能失效');

  const bad = [];
  for (const p of files) {
    const raw = fs.readFileSync(p, 'utf8');
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    /* 【先剥注释再扫】修复这类缺陷时，注释里常会写「原来用的是
     * var(--fill-1)」作为说明 —— 那段不是代码，扫进来只会逼人
     * 把注释改得含糊。剥掉注释后只看真正会进入 style 的引用。
     * 用逐行剥块注释的方式（避免正则跨行误吞字符串）。 */
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
    for (const m of src.matchAll(/var\((--[a-z0-9-]+)\s*([,)])/g)) {
      const name = m[1];
      const hasFallback = m[2] === ',';
      if (hasFallback) continue;         // var(--x, default) 是合法动态用法
      if (!defined.has(name)) {
        const line = src.slice(0, m.index).split('\n').length;
        bad.push(rel + ':' + line + ' var(' + name + ')');
      }
    }
  }
  /* 锁的是：内联样式引用不存在的 CSS 变量 —— 浏览器静默回退，
   * 属性整条失效、控制台零报错，只能靠视觉发现「背景怎么没了」。
   * F3 就是 --fill-1 在 js 里被引用而未定义。 */
  assert.deepStrictEqual(bad, [],
    'js/ 里引用了未定义的 CSS 变量（背景/边框会静默失效）：\n  ' + bad.join('\n  '));
});

done();
