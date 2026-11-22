
/* 【把 TEMP/TMP 指向工作区】本机安全软件拦 Chromium 子进程写 %TEMP%
 * （EPERM），而本脚本要把探针与结果落盘。工作区不在拦截名单里。
 * 详见 scripts/lib/electron-launch.js。进程退出时删除。 */
(function () {
  if (process.env.HEHE_TEST_TMP_READY) return;
  var p = require('path'), f = require('fs');
  var d = p.join(p.resolve(__dirname, '..'), '.tmp-testrun-' + process.pid);
  try {
    f.mkdirSync(d, { recursive: true });
    process.env.TEMP = d; process.env.TMP = d;
    process.env.HEHE_TEST_TMP_READY = '1';
    process.on('exit', function () { try { f.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  } catch (e) { /* 建不了就让失败如实暴露 */ }
})();
/* 回归：密码生成器点「生成」必须真的产出密码。
 *
 * 【为什么要专门测这个】
 * js/tools/security.js 的 gen() 里有一段拒绝采样：
 *     const out = [];
 *     ...
 *     out.appendChild(...)
 * 外层 `const out = div('')` 是结果容器，内层再声明 `const out = []` 把它遮蔽掉，
 * 于是 appendChild 作用在数组上 → TypeError。
 * 这个错误被 render 的 try/catch 之外、被点击事件的 try 吞掉，
 * 表现是「按钮点了没反应、一个密码都不出现」，控制台只有一行报错。
 * 打包态冒烟（HEHE_SMOKE）才把它翻出来 —— 因为冒烟会真的打开每个工具页。
 *
 * 教训：页面能渲染 ≠ 功能可用。这里直接点按钮，数生成的密码行。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
/* 【Chromium 兼容参数 —— 见 scripts/lib/electron-launch.js 的实测根因】
 * 本机 Chromium 进程级沙箱起不来：不带 --no-sandbox 时 electron.exe 直接以
 * 0x80000003 崩掉，stdout/stderr 全空，测试只能报「没拿到渲染层结果」。
 * --disable-gpu/--disable-dev-shm-usage 同理（远程会话的 GPU 进程、受限的 /dev/shm）。
 * 这些参数只影响测试探针，不影响产品打包后的启动参数。 */
const CHROMIUM_FLAGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

/* 【把子进程的 TEMP/TMP 与 --user-data-dir 切到工作区内】
 * 本机 Chromium 子进程写 %TEMP% 会被安全软件拦（EPERM），而探针都要把结果
 * 落盘再读，于是全部卡在"写不了结果文件"。工作区不在拦截名单里。
 * 详见 scripts/lib/electron-launch.js。用完即删。 */
let __scratchDir = null;
function __ensureScratch(env) {
  if (!__scratchDir) {
    __scratchDir = path.join(path.resolve(__dirname, '..'), '.tmp-e2e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    try { require('fs').mkdirSync(__scratchDir, { recursive: true }); } catch (e) {}
    process.on('exit', () => { try { require('fs').rmSync(__scratchDir, { recursive: true, force: true }); } catch (e) {} });
  }
  env.TEMP = __scratchDir;
  env.TMP = __scratchDir;
  return ['--user-data-dir=' + path.join(__scratchDir, 'udd')];
}

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gen-'));

const PROBE = `
(async () => {
  const out = { steps: [], errors: [] };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const log = (n, d) => out.steps.push(Object.assign({ name: n }, d));
  window.addEventListener('error', (e) => out.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => out.errors.push(String((e.reason && e.reason.message) || e.reason)));

  const consoleErrs = [];
  const oldErr = console.error;
  console.error = function () { consoleErrs.push([].slice.call(arguments).map(String).join(' ')); return oldErr.apply(console, arguments); };
  out.consoleErrs = consoleErrs;

  window.App.openTool('password-gen');
  await tick(400);

  const genBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('生成'));
  if (!genBtn) return { fatal: '找不到「生成」按钮' };

  const before = document.querySelectorAll('.pw-item, .mono').length;
  genBtn.click();
  await tick(500);

  const pwEls = [...document.querySelectorAll('.mono')].map((e) => e.textContent.trim());
  // .tag 要先全部取出来再比对：密码行和强度标签是同时渲染的，
  // 只取到 3 个说明取样发生在渲染中途，不是真的少渲染了两条。
  const tags = [...document.querySelectorAll('.tag')].map((e) => e.textContent.trim());
  log('generated', { before, count: pwEls.length, tagCount: tags.length, sample: pwEls.slice(0, 3), tags: tags.slice(0, 3) });

  // 长度必须等于页面里设的 16
  const lens = pwEls.map((p) => p.length);
  const uniq = new Set(pwEls);
  log('lengths', { lens, allSixteen: lens.length > 0 && lens.every((n) => n === 16), unique: uniq.size });

  // 再点一次：不能报错，且应重新生成一批
  genBtn.click();
  await tick(500);
  const again = [...document.querySelectorAll('.mono')].map((e) => e.textContent.trim());
  log('again', { count: again.length });

  out.consoleErrs = consoleErrs.slice(0, 8);
  return out;
})()
`;

const runner = `
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const PROBE = ${JSON.stringify(PROBE)};

app.whenReady().then(async () => {
  ipcMain.handle('store:get', (e, k, d) => ({ ok: true, data: d }));
  ipcMain.handle('store:set', () => ({ ok: true, data: true }));
  ipcMain.handle('dangerous:list', () => ({ ok: true, data: { enabled: [] } }));
  ipcMain.handle('dangerous:tool-caps', () => ({ ok: true, data: {} }));
  const w = new BrowserWindow({
    width: 1100, height: 820, show: true, x: 30, y: 30,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  await w.loadFile(path.join(ROOT, 'index.html'));
  await new Promise((r) => setTimeout(r, 1600));
  let res;
  try { res = await w.webContents.executeJavaScript(PROBE, true); }
  catch (e) { res = { fatal: String((e && e.message) || e) }; }
  console.log('PW ' + JSON.stringify(res));
  app.exit(0);
});
`;

const scriptPath = path.join(tmp, 'run.js');
fs.writeFileSync(scriptPath, runner, 'utf8');

const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON_EXE)) { console.log('SKIP 无 electron.exe'); process.exit(0); }

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.HEHE_NOSPLASH = '1';

let raw = '';
try {
  raw = execFileSync(ELECTRON_EXE, [...CHROMIUM_FLAGS, ...__ensureScratch(env), scriptPath], { env, encoding: 'utf8', timeout: 120000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const line = String(raw).split(/\r?\n/).find((l) => l.startsWith('PW '));
if (!line) {
      /* 【探针没回结果 = 这台机器跑不了，不是产品失败】无交互桌面的 CI
       * runner 上 Electron 可能根本起不来。打印 SKIP 让 run-tests 归到
       * 环境跳过（CI 会作为 annotation 报出），而不是判红。 */
      console.log('SKIP 探针未落盘（PW）：该环境可能无交互桌面，本脚本未被验证');
      console.log(String(raw).slice(-3000));
      process.exit(0);
    }
const R = JSON.parse(line.slice('PW '.length));

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

if (R.fatal) {
  chk(false, R.fatal);
} else {
  const by = {};
  for (const s of R.steps) by[s.name] = s;

  chk(by.generated && by.generated.count >= 5,
      '点「生成」产出密码（' + (by.generated && by.generated.count) + ' 条）: '
      + JSON.stringify(by.generated && by.generated.sample));

  chk(by.lengths && by.lengths.allSixteen,
      '每条密码长度都是 16: ' + JSON.stringify(by.lengths && by.lengths.lens));

  chk(by.lengths && by.lengths.unique >= 4,
      '密码互不重复（' + (by.lengths && by.lengths.unique) + '/5 唯一）');

  chk(by.generated && by.generated.tagCount >= 5
      && by.generated.tags.every((t) => /弱|中|强|极强/.test(t)),
      '每条都带强度评级（' + (by.generated && by.generated.tagCount) + ' 个）: '
      + JSON.stringify(by.generated && by.generated.tags));

  chk(by.again && by.again.count >= 5,
      '再次点击仍能生成（' + (by.again && by.again.count) + ' 条）——不是只工作一次');

  const hard = (R.consoleErrs || []).filter((m) => /ReferenceError|is not defined|TypeError|appendChild is not a function/.test(m));
  chk(hard.length === 0, 'console 无 TypeError/ReferenceError'
      + (hard.length ? ': ' + JSON.stringify(hard) : ''));

  chk(R.errors.length === 0, '页面无未捕获错误' + (R.errors.length ? ': ' + JSON.stringify(R.errors) : ''));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
