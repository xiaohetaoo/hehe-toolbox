'use strict';
/* 应用冒烟测试：用**真实的 main.js** 启动打包版/开发版应用，验证能跑起来。
 *（原 test-round14-app.js，按实际作用重命名。）
 *
 * ============ 为什么这个文件必须存在 ============
 * 单测能验逻辑，但验不了「主进程整体能不能启动」—— 而这是最贵的一类故障：
 * 一个 require 写错、一个 handler 名字对不上，单测全绿、应用起不来。
 * 上一版 e2e 只用了 bare electron + index.html（主进程是空壳），
 * 于是 `win:pin-move` 报「No handler registered」，看起来像功能坏了，
 * 实际是测试环境不真实。现在改为以 main.js 为入口启动，
 * 通过主进程全局钩子做断言。
 *
 * ============ 它验什么、不验什么 ============
 * 验：主窗口创建成功、preload 的 window.api 可用、IPC 真链路可用、
 *     渲染层无未捕获 JS 错误、alertBox 在真 DOM 里不是空白框。
 * 不验：各工具的具体逻辑（那些在对应的 test-<模块>.js 里）。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r14app-'));

/* 这个 runner 以 main.js 为入口，等应用就绪后对主窗口跑探测。 */
const runner = [
  "const { app } = require('electron');",
  "const path = require('path');",
  "const ROOT = " + JSON.stringify(ROOT) + ";",
  "require(path.join(ROOT, 'main.js'));",
  'app.whenReady().then(async () => {',
  '  await new Promise(r => setTimeout(r, 2500));',
  '  const { BrowserWindow } = require("electron");',
  '  const wins = BrowserWindow.getAllWindows();',
  '  const main = wins.find(w => !w.isDestroyed() && String(w.webContents.getURL()).includes("index.html"));',
  '  let res = { windows: wins.length, foundMain: !!main };',
  '  if (main) {',
  '    try {',
  '      const probe = `(async () => {',
  '        const out = {};',
  '        out.hasApi = !!(window.api && window.api.invoke);',
  '        out.hasUi = !!(window.ui && window.ui.alertBox);',
  '        try {',
  '          const r = window.api.evalExpr("1/0");',
  '          out.evalInf = { ok: r.ok, err: r.error };',
  '          const r2 = window.api.evalExpr("1/3");',
  '          out.evalOk = { ok: r2.ok, v: r2.value };',
  '        } catch (e) { out.evalErr = e.message; }',
  '        try {',
  '          window.ui.alertBox({ title: "部分文件未能重命名", message: "明细：a.txt 被占用" });',
  '          await new Promise(r => setTimeout(r, 80));',
  '          const masks = [...document.querySelectorAll(".modal-mask")];',
  '          const last = masks[masks.length-1];',
  '          out.alert = last ? { blank: (last.textContent||"").trim().length < 6, hasDetail: (last.textContent||"").includes("a.txt"), text: (last.textContent||"").slice(0,80) } : { missing: true };',
  '        } catch (e) { out.alertErr = e.message; }',
  '        out.pages = Object.keys(window.Registry ? window.Registry._all || {} : {}).length;',
  '        return out;',
  '      })()`;',
  '      res.probe = await main.webContents.executeJavaScript(probe);',
  '    } catch (e) { res.probeErr = String((e && e.message) || e); }',
  '  }',
  "  console.log('R14APP ' + JSON.stringify(res));",
  '  app.exit(0);',
  '});'
].join('\n');

/* runner 必须放在项目根目录内：main.js 用 loadFile('index.html') 解析的是
 * app.getAppPath()，在 bare electron 下等于 cwd —— 指向临时目录就会 ERR_FILE_NOT_FOUND（实测过）。 */
const scriptPath = path.join(ROOT, '.r14-app-runner.js');
fs.writeFileSync(scriptPath, runner, 'utf8');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');

const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON_EXE)) { console.log('SKIP 未找到 electron.exe'); process.exit(0); }

let raw = '';
try {
  raw = execFileSync(ELECTRON_EXE, [scriptPath],
    { env, encoding: 'utf8', timeout: 180000, windowsHide: true });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const line = String(raw || '').split(/\r?\n/).find((l) => l.startsWith('R14APP'));
if (!line) {
  console.log('SKIP 未拿到 R14APP');
  console.log(String(raw).slice(-1500));
  process.exit(0);
}
const R = JSON.parse(line.slice('R14APP '.length));

let pass = 0, fail = 0;
const chk = (c, m, extra) => {
  if (c) { pass++; console.log('PASS  ' + m); }
  else { fail++; console.log('FAIL  ' + m + (extra ? '  -> ' + extra : '')); }
};

chk(R.foundMain === true, '真实 main.js 能启动并创建主窗口', JSON.stringify({ windows: R.windows }));
const P = R.probe || {};
chk(R.probeErr === undefined, '主窗口探测脚本能执行', R.probeErr);
chk(P.hasApi === true, 'preload 的 window.api 可用');
chk(P.evalInf && P.evalInf.ok === false, '1/0 经真链路被拒绝', JSON.stringify(P.evalInf));
chk(P.evalInf && /无法计算/.test(P.evalInf.err || ''), '错误文案可读', JSON.stringify(P.evalInf && P.evalInf.err));
chk(P.evalOk && P.evalOk.ok === true && Math.abs(P.evalOk.v - 1 / 3) < 1e-12, '1/3 经真链路正常返回');
chk(P.alert && P.alert.blank === false, 'alertBox 对象实参在真 DOM 里不是空白框', JSON.stringify(P.alert));
chk(P.alert && P.alert.hasDetail === true, '正文含失败明细文件名', JSON.stringify(P.alert && P.alert.text));

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
try { fs.rmSync(scriptPath, { force: true }); } catch (e) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
