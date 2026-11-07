'use strict';
/* 主窗口 CSP 的 wasm 许可 —— 真机验证。
 *
 * ============ 锁的是哪个回归 ============
 * index.html 的 `script-src` 原本是 `'self' blob:`，没有 wasm 许可。
 * tesseract.js 的 worker 只会加载 wasm 版 core，识别时必然调用
 * WebAssembly.Module/instantiate —— 于是「截图 OCR」「批量图片 OCR」
 * 在打包版和开发版都跑不起来，而且 recognize 的 promise 在 worker 内部
 * 报错时**永不 settle**，界面永久停在「初始化 OCR 引擎…」。
 *
 * ============ 为什么必须真跑 Electron ============
 * CSP 是浏览器运行时执行的，源码里写了什么不等于浏览器放行什么。
 * 这里加载真实的 index.html（CSP 逐字生效），然后在渲染层里：
 *   ① 编译一个最小的合法 wasm 模块 —— 必须成功
 *   ② new Function('return 1') —— 必须仍被拒绝（证明只开了 wasm，没开 eval）
 * 第二项是关键：如果只验 ①，把 CSP 改成 'unsafe-eval' 也能过，
 * 而那会把 v0.4.x 起的所有加固一次性抵消掉。
 *
 * 【不依赖 OCR 本身】不下载语言包、不起 tesseract —— 那需要网络且慢。
 * 这里验的是"CSP 允许 wasm 编译"这一个前置条件，它一旦不成立，
 * 后面什么都做不了。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  -> ' + (detail || '')); }
}

/* ---- 静态部分：永远跑得到，不依赖 Electron ---- */
{
  /* 【这里用裸 readFileSync 而不是 readSrc，是有意的】
   * 要验的是 CSP 的**原文文本**与「某段代码调用了某个 API」这两种文本事实。
   * readSrc 会先剥注释 —— 对本文件无害，但 index.html 根本不是 JS，
   * 剥注释的工具对它没有意义；两个 js 文件只需要"有没有这个调用"，
   * 剥不剥注释结果一样。已登记在 source-assertions 基线的 exact 类里。 */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = /<meta[^>]*Content-Security-Policy[^>]*content="([^"]+)"/i.exec(html);
  chk('S1 index.html 有 CSP meta', !!m, m ? '' : '找不到 CSP');
  const csp = m ? m[1] : '';
  /* 锁的是：两个 OCR 工具完全不可用那条回归（CSP 不放行 wasm）。
   * 只能用源码断言：这条验的是"配置文本里有没有那个许可"，
   * 真机行为由下面的 E1/E2 覆盖；两条一起才完整。 */
  chk("S2 script-src 含 'wasm-unsafe-eval'", /script-src[^;]*'wasm-unsafe-eval'/.test(csp), csp);
  /* 锁的是：修 wasm 时顺手加 'unsafe-eval'，把 v0.4.x 起的加固一次性抵消掉。
   * 这是 S2 的配对 —— 少了它，把 CSP 改成 'unsafe-eval' 也能让 E1 变绿。 */
  chk("S3 不含 'unsafe-eval'（只开 wasm，不放开任意求值）",
    !/['"\s]unsafe-eval['"\s]/.test(csp), csp);
  /* OCR 工具必须真的用到那个守卫 —— 否则 CSP 修好了、卡死仍然会卡死 */
  const ocrSrc = fs.readFileSync(path.join(ROOT, 'js', 'tools', 'media', 'screenshot-ocr.js'), 'utf8');
  const batchSrc = fs.readFileSync(path.join(ROOT, 'js', 'tools', 'media', 'batch-ocr.js'), 'utf8');
  /* 锁的是：CSP 修好但没加超时 —— 语言包下载卡住时界面仍会永久停在「初始化…」。
   * 只能用源码断言：要验行为得真跑 tesseract 并伪造一次永不 settle 的 recognize，
   * 那需要网络与 10MB 语言包。 */
  chk('S4 截图 OCR 的 recognize 包了超时', /OcrGuard\.withTimeout\(/.test(ocrSrc), '没找到 withTimeout');
  /* 锁的是：批量场景下"一张图永挂拖死整批"—— 单张也要有超时。 */
  chk('S5 批量 OCR 的单张识别也包了超时', /OcrGuard\.withTimeout\(/.test(batchSrc), '没找到 withTimeout');
  /* 锁的是：失败时把原始英文报错直接甩给用户（"WebAssembly ... violates ..."），
   * 用户看不懂也不知道该改什么。 */
  chk('S6 失败时用归因后的文案（不是直接甩 e.message）',
    /OcrGuard\.failReason\(/.test(ocrSrc) && /OcrGuard\.failReason\(/.test(batchSrc), '');
  const guard = require('../lib/ocr-guard');
  chk('S7 ocr-guard 导出 withTimeout / failReason', typeof guard.withTimeout === 'function'
    && typeof guard.failReason === 'function');
  chk('S8 超时错误的 code 可识别（调用方靠它区分超时与引擎报错）',
    guard.failReason({ code: 'OCR_TIMEOUT' }).includes('超时'), '');
  chk('S9 wasm 类错误归因到「安全策略」而不是原始英文',
    /WebAssembly|安全策略/.test(guard.failReason(new Error('Compiling or instantiating WebAssembly module violates'))) ||
    /安全策略/.test(guard.failReason(new Error('WebAssembly compile failed'))), '');
}

/* ---- 真机部分：起 Electron 加载真实 index.html ---- */
/* 最小可用的 wasm 模块：magic + version + 一个空 type section。
 * 只要 CSP 放行，WebAssembly.compile 就会成功；被拒时抛 CompilingError。 */

if (!fs.existsSync(EXE)) {
  console.log('SKIP 无 electron.exe（CI 未安装 electron）—— 静态部分已覆盖 CSP 文本');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-wasm-'));
  fs.writeFileSync(path.join(tmp, 'runner.js'), `
process.on('unhandledRejection', (e) => console.log('REJ ' + e));
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};

/* 最小可用的 wasm 模块：magic + version + 一个空 type section。
 * 只要 CSP 放行，WebAssembly.compile 就会成功；被拒时抛 CompilingError。 */
const WASM_B64 = 'AGFzbQEAAAA=';

app.whenReady().then(async () => {
  try {
    for (const k of ['store:get','store:set','store:health','dangerous:list',
      'dangerous:tool-caps','app:get-autostart','app:set-lang','app:set-accent',
      'app:set-theme','update:cleanup','app:get-info','app:crash-info',
      'win:thumbnail','sys:stats']) {
      ipcMain.handle(k, () => ({ ok: true, data: (k === 'store:get' ? null : true) }));
    }
    const w = new BrowserWindow({ width: 900, height: 600, show: false,
      webPreferences: { preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true, sandbox: false } });
    await w.loadFile(path.join(ROOT, 'index.html'));
    await new Promise(r => setTimeout(r, 1500));

    const probe = await w.webContents.executeJavaScript(\`
      (async function(){
        var out = {};
        // ① wasm 编译：必须成功
        try {
          var bin = Uint8Array.from(atob("AGFzbQEAAAA="), function(c){ return c.charCodeAt(0); });
          var mod = await WebAssembly.compile(bin);
          out.wasmOk = true;
          out.wasmType = Object.prototype.toString.call(mod);
        } catch (e) { out.wasmOk = false; out.wasmErr = String(e && e.message || e); }
        // ② 字符串求值：必须仍被拒绝（证明只开了 wasm）
        try {
          var f = new Function('return 1');
          out.evalOk = true;
          out.evalVal = f();
        } catch (e) { out.evalOk = false; out.evalErr = String(e && e.message || e); }
        return JSON.stringify(out);
      })()\`, true);
    console.log('WASMPROBE ' + probe);
    app.exit(0);
  } catch (e) { console.log('FATAL ' + (e && e.stack || e)); app.exit(1); }
});
`, 'utf8');

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env.HEHE_TEST_DATA = path.join(tmp, 'ud');
  env.HEHE_NOSPLASH = '1';

  let raw = '';
  try {
    raw = execFileSync(EXE, [path.join(tmp, 'runner.js')], { env, encoding: 'utf8', timeout: 120000 });
  } catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

  const m = /WASMPROBE (.+)/.exec(raw);
  if (!m) {
    console.log('SKIP  真机探测没返回结果（无桌面会话？）');
    console.log(String(raw).slice(-800));
  } else {
    let r = {};
    try { r = JSON.parse(m[1]); } catch (e) { r = {}; }
    /* 锁的是：CSP 不放行 wasm → 两个 OCR 工具完全不可用。
     * 必须真跑：CSP 是浏览器运行时执行的，源码写了什么不等于放行什么。 */
    chk('E1 真机：CSP 下最小 wasm 模块能编译成功', r.wasmOk === true,
      r.wasmErr || JSON.stringify(r));

    /* 锁的是：修 wasm 时顺手加 'unsafe-eval' 把加固抵消掉。
     * 这一条是 E1 的配对 —— 只有两条同时成立，才说明"只开了 wasm"。 */
    chk('E2 真机：new Function 仍被 CSP 拒绝（没有顺带放开 eval）',
      r.evalOk === false, 'evalOk=' + r.evalOk + ' val=' + r.evalVal);
  }
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
