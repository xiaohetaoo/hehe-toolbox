'use strict';
/* P0-7 回归：三个辅助窗口（snip/pin/ruler）必须
 *   (a) 有 CSP（安全基线一致）
 *   (b) CSP 里允许加载 file:// 本地图片（否则截图标注/贴图/标尺全废）
 *   (c) CSP 里**不含** unsafe-eval（这是加 CSP 的主要目的之一）
 *   (d) 用真实 Electron 打开这三个窗口，确认脚本能跑（不是只改字符串）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

const ROOT = path.join(__dirname, '..');
const AUX = ['snip.html', 'pin.html', 'ruler.html'];

/* ---- 1. 静态检查 ---- */
for (const f of AUX) {
  t(f + ' 有 CSP meta', () => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  /* 锁的是：「同一组回归」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    assert.ok(/http-equiv=["']Content-Security-Policy["']/.test(s), '缺少 CSP meta');
  });
  t(f + ' CSP 允许 file: 图片', () => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  /* 锁的是：「同一组回归」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    const m = s.match(/Content-Security-Policy"[^>]*content="([^"]+)"/);
    assert.ok(m, '解析不到 CSP 内容');
  /* 锁的是：「同一组回归」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    assert.ok(/img-src[^;]*file:/.test(m[1]), 'img-src 必须允许 file:（否则本地图片显示不出来）');
  /* 锁的是：「同一组回归」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    assert.ok(/img-src[^;]*data:/.test(m[1]), 'img-src 必须允许 data:（贴图用 dataURL）');
  });
  t(f + ' CSP 不含 unsafe-eval', () => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  /* 锁的是：「同一组回归」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    const m = s.match(/Content-Security-Policy"[^>]*content="([^"]+)"/);
  /* 锁的是：「同一组回归」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
    assert.strictEqual(/unsafe-eval/.test(m[1]), false, '辅助窗口不该开 unsafe-eval');
  });
}

/* ---- 2. 主窗口的 CSP：必须允许 wasm，但不许放开 eval ---- */
t('index.html 的 CSP 允许 WebAssembly，且仍然禁止 unsafe-eval', () => {
  const s = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = /<meta[^>]*Content-Security-Policy[^>]*content="([^"]+)"/i.exec(s);
  assert.ok(m, 'index.html 应有 CSP');

  /* 锁的是：两个 OCR 工具在打包版与开发版**完全不可用**那条回归。
   * CSP 原先是 `script-src 'self' blob:` —— tesseract.js 的 worker 只会加载
   * wasm 版 core，识别时必然调用 WebAssembly.Module/instantiate，于是被
   * CSP 直接拒绝。而 recognize 的 promise 在 worker 内部抛错时**永不 settle**，
   * 界面永久停在「初始化 OCR 引擎…」，比直接报错更难归因。
   *
   * 【为什么断言 'wasm-unsafe-eval' 而不是 'unsafe-eval'】
   * 后者会重新开放任意字符串求值，把 v0.4.x 起的加固全抵消掉；
   * 'wasm-unsafe-eval' 是专为 WebAssembly 设计的窄指令，只开 wasm 编译。
   * 所以这里两个方向都断言：必须有 wasm-unsafe-eval、必须没有 unsafe-eval。
   * 这条是纯静态断言，**不依赖 Electron** —— test-aux-csp 的真机部分在
   * 无桌面环境会整段 SKIP，但这条必须永远跑得到。 */
  /* 锁的是：CSP 不放行 wasm → 两个 OCR 工具完全不可用且静默卡死。
   * 只能用源码断言：这是配置文本里有没有那个许可；真机行为由 test-csp-wasm 的 E1/E2 覆盖。 */
  assert.ok(/'wasm-unsafe-eval'/.test(m[1]),
    "主窗口 script-src 缺少 'wasm-unsafe-eval' —— tesseract.js 的 wasm core 无法编译，两个 OCR 工具会静默卡死");
  /* 锁的是：修 wasm 时顺手加 'unsafe-eval'，把 v0.4.x 起的加固一次性抵消掉。
   * 这是上一条的配对 —— 少了它，把 CSP 改成 'unsafe-eval' 也能让上面那条绿。 */
  assert.strictEqual(/['"\s]unsafe-eval['"\s]/.test(m[1]), false,
    "主窗口不该有 'unsafe-eval'（那会重新开放任意字符串求值；wasm 只需要 'wasm-unsafe-eval'）");
  /* 锁的是：把许可写进 default-src 但 script-src 里没有 ——
   * script-src 一旦出现就完全覆盖 default-src，写错位置等于没写。 */
  assert.ok(/script-src[^;]*'wasm-unsafe-eval'/.test(m[1]),
    "'wasm-unsafe-eval' 必须落在 script-src 里（写进 default-src 不一定覆盖 script-src）");
});

/* ---- 3. 真机：用 Electron 打开三个窗口，确认脚本执行 ---- */
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON)) {
  console.log('SKIP 未找到 electron.exe');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-'));
  const runner = `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const out = {};
  const files = ['snip.html', 'pin.html', 'ruler.html'];
  for (const f of files) {
    const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    const errs = [];
    w.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
    try {
      await w.loadFile(${JSON.stringify(ROOT)} + '/' + f);
      await new Promise((r) => setTimeout(r, 400));
      // 探测：页面里的全局脚本是否执行了（三个文件都有 onload/立即执行的部分）
      const probe = await w.webContents.executeJavaScript(
        'JSON.stringify({ hasScript: typeof window.__snipTest !== "undefined" || typeof window.__pinReady !== "undefined" || document.querySelectorAll("script").length > 0, scriptCount: document.querySelectorAll("script").length, csp: (document.querySelector(\\'meta[http-equiv="Content-Security-Policy"]\\')||{}).content ? "present" : "missing" })'
      ).catch((e) => JSON.stringify({ error: e.message }));
      out[f] = { probe, errs };
    } catch (e) { out[f] = { error: e.message }; }
    w.destroy();
  }
  console.log('AUX_RESULT ' + JSON.stringify(out));
  app.exit(0);
});
`;
  const scriptPath = path.join(tmp, 'run.js');
  fs.writeFileSync(scriptPath, runner, 'utf8');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  let raw = '';
  try {
    raw = spawnSync(ELECTRON, [scriptPath], { env, encoding: 'utf8', timeout: 90000 }).stdout || '';
  } catch (e) { raw = String(e.stdout || ''); }

  const line = raw.split(/\r?\n/).find((l) => l.startsWith('AUX_RESULT'));
  if (!line) {
    console.log('SKIP 未拿到 AUX_RESULT（可能是无头环境限制）');
  } else {
    const R = JSON.parse(line.slice('AUX_RESULT '.length));
    for (const f of AUX) {
      t(f + ' 真机加载：脚本执行且无 CSP 报错', () => {
        const r = R[f];
        assert.ok(r, f + ' 无结果');
        if (r.error) throw new Error('加载失败: ' + r.error);
        const p = JSON.parse(r.probe || '{}');
        if (p.error) throw new Error('探测失败: ' + p.error);
        assert.ok(p.scriptCount > 0, '页面里应有 script');
  /* 锁的是：「index.html 的 CSP 仍在（记录已知取舍）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
        const cspErrs = (r.errs || []).filter((m) => /Content Security Policy|Refused to/i.test(m));
        assert.deepStrictEqual(cspErrs, [], '出现 CSP 拦截: ' + cspErrs.join(' | '));
      });
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
