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
  raw = execFileSync(ELECTRON_EXE, [scriptPath], { env, encoding: 'utf8', timeout: 120000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const line = String(raw).split(/\r?\n/).find((l) => l.startsWith('PW '));
if (!line) { console.log('未拿到 PW'); console.log(raw.slice(-2500)); process.exit(1); }
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
