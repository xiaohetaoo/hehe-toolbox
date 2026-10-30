'use strict';
/* 三个辅助窗口的 CSP 收紧后，必须确认它们仍能正常工作（P3-4 的回归测试）。
 *
 * 检查三件事：
 *   1) CSP 里不能再有 script-src 'unsafe-inline'（否则内联脚本没抽干净）；
 *   2) 页面里不能再有内联 <script>…</script>（要么 src，要么没有）；
 *   3) HTML 引用的外部 js 文件确实存在且语法能过（打包时漏掉就白屏）。
 *
 * 为什么不做端到端：三个窗口都是透明/置顶/无边框的特殊窗口，
 * 在 CI 的 headless 环境里连窗口尺寸都取不准；而「CSP 过宽」这件事
 * 本质是文件内容的静态属性，静态检查百分百可靠。
 * 真正的端到端另有 test-aux-csp.js 覆盖（用 CDP 抓控制台违规）。
 *
 * ⚠️ 另一条铁律：任何测试都不要去「真的打开」这三个窗口，尤其是 snip。
 * snipStart 会建一个全屏 alwaysOnTop 的遮罩窗口并 setFullScreen(true)，
 * 在真实机器上跑起来就是屏幕上突然盖一层截图十字、鼠标变成截图样式，
 * 用户必须手动 Esc 才能退出（曾经真的这么坑过一次用户）。
 * 下面第 4 条断言就是防止后人再往里加这种调用。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

/* 每个窗口有两个脚本块，都必须留在原位置（合并会破依赖 DOM 的那部分） */
const WINDOWS = [
  { html: 'pin.html', js: ['js/auxwin/pin-1.js', 'js/auxwin/pin-2.js'] },
  { html: 'ruler.html', js: ['js/auxwin/ruler-1.js', 'js/auxwin/ruler-2.js'] },
  { html: 'snip.html', js: ['js/auxwin/snip-1.js', 'js/auxwin/snip-2.js'] },
];

for (const w of WINDOWS) {
  const html = fs.readFileSync(path.join(ROOT, w.html), 'utf8');

  t(`${w.html}: script-src 不允许 unsafe-inline`, () => {
    const m = /Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(html);
    assert.ok(m, '没找到 CSP meta');
    const csp = m[1];
    const scriptSrc = (csp.match(/script-src ([^;]+)/) || [])[1] || '';
    assert.ok(scriptSrc.includes("'self'"), 'script-src 必须允许 self');
    assert.ok(!scriptSrc.includes('unsafe-inline'), 'script-src 仍有 unsafe-inline：' + scriptSrc);
    assert.ok(!scriptSrc.includes('unsafe-eval'), 'script-src 仍有 unsafe-eval');
    // connect-src 必须保持 none（这些窗口不该联网）
    const connectSrc = (csp.match(/connect-src ([^;]+)/) || [])[1] || '';
    assert.ok(connectSrc.trim() === "'none'", 'connect-src 应为 none，实际：' + connectSrc);
  });

  t(`${w.html}: 没有内联 script 块`, () => {
    const inline = /<script>(?!\s*<\/script>)/.test(html);
    assert.ok(!inline, '仍有内联 <script> 块（应改为 <script src> 外部文件）');
  });

  t(`${w.html}: 引用的外部脚本存在`, () => {
    const refs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, '没有引用任何外部脚本');
    // 每个窗口应引用两个块（配色初始化 + DOM 逻辑），顺序不能合并
    assert.strictEqual(refs.length, w.js.length, `${w.html} 引用了 ${refs.length} 个脚本，预期 ${w.js.length} 个`);
    for (const r of refs) {
      const p = path.join(ROOT, r);
      assert.ok(fs.existsSync(p), '引用的脚本不存在（打包后会白屏）：' + r);
      assert.ok(fs.statSync(p).size > 100, '脚本文件异常小：' + r);
    }
  });

  /* 依赖 DOM 的那个块必须排在 body 元素之后（否则 canvas 还不存在就 getContext） */
  t(`${w.html}: DOM 逻辑脚本排在 body 内容之后`, () => {
    const second = w.js[1];
    const htmlNoComments = html;
    const bodyPos = htmlNoComments.search(/<body/);
    const scriptPos = htmlNoComments.indexOf(second);
    assert.ok(scriptPos > bodyPos, `${second} 出现在 <body> 之前，会在 DOM 就绪前执行`);
    // 且必须排在 <canvas> 或主要容器之后
    const canvasPos = htmlNoComments.search(/<canvas|<div id="/);
    if (canvasPos > 0) {
      assert.ok(scriptPos > canvasPos, `${second} 排在 DOM 元素之前，会撞 null 引用`);
    }
  });
}

/* 抽出的脚本必须是自洽的 JS（语法错误会让窗口白屏，而且控制台只报一条） */
t('抽出的外部脚本语法可解析', () => {
  const vm = require('vm');
  for (const w of WINDOWS) {
    for (const f of w.js) {
      const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // 只做语法检查，不执行（这些脚本依赖 DOM/window）
      new vm.Script(code, { filename: f });
    }
  }
});

/* 脚本里不能残留 <script> 标签（抽取时的常见错误） */
t('外部脚本里没有残留 HTML 标签', () => {
  for (const w of WINDOWS) {
    for (const f of w.js) {
      const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(!/<script|<\/script>/i.test(code), f + ' 里还留着 <script> 标签');
    }
  }
});

/* 安全阀：所有测试脚本都不许调用会弹全屏遮罩的通道。
 * snip:start 会 setFullScreen(true) 建一个 alwaysOnTop 遮罩，
 * 在真实机器上跑就等于占满用户屏幕并劫持鼠标（必须手动 Esc 才能退出）。 */
t('测试脚本不调用会弹可见窗口的通道', () => {
  const dir = __dirname;
  const offenders = [];
  const BANNED = ['snip:start', 'win:ruler', 'win:pin-'];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    if (f === path.basename(__filename)) continue; // 本文件里这些是注释中的警示文字
    let code = fs.readFileSync(path.join(dir, f), 'utf8');
    // 去掉注释，只看真正的代码
    code = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const ch of BANNED) {
      /* 只关心「真的去调」的形态：invoke('snip:start') / executeJavaScript 里 invoke，
       * 或者 ipcRenderer.invoke / api.invoke 这种。纯字符串比对（比如断言通道名存在）
       * 不算调用 —— 那正是 test-ipc-channels.js 在做的事。 */
      const callRe = new RegExp(
        "(?:invoke|send|invokeSync|executeJavaScript)\\s*\\(\\s*['\"`]" + ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      );
      if (callRe.test(code)) offenders.push(f + ' -> ' + ch);
    }
  }
  assert.deepStrictEqual(offenders, [],
    '这些测试会弹出全屏/置顶窗口，必须改掉：\n  ' + offenders.join('\n  '));
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
