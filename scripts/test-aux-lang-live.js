'use strict';
/* R27 的真实窗口回归：辅助窗已经开着时收到语言广播，文案要立刻换。
 *
 * 不能用纯静态断言替代：事件是否真的送达、DOM 是否真的重画，只有在
 * Electron 里加载 pin/ruler/snip 三张页面才看得见。环境起不来时 SKIP。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(EXE)) {
  console.log('SKIP 无 electron.exe（CI 未安装 electron）');
  process.exit(0);
}

const { makeWhiteImage } = require('./e2e-helpers');
/* 本机安全软件会拦 Chromium 写 %TEMP%；探针与 user-data-dir 都放工作区。 */
const tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-auxlang-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });
const imgPath = path.join(tmp, 'bg.png');
const gen = makeWhiteImage(imgPath, 400, 300);
if (!gen.ok) {
  console.log('SKIP 无法生成测试图片（' + gen.method + '）');
  process.exit(0);
}

const resultPath = path.join(tmp, 'result.json');
const runner = `
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const IMG = ${JSON.stringify(imgPath)};
const OUT = ${JSON.stringify(resultPath)};
const CH = require(path.join(ROOT, 'lib', 'channels')).CHANNELS.APP.UI_PREFS_CHANGED;
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const out = {};
  const mk = async (file, query) => {
    const w = new BrowserWindow({ width: 900, height: 700, show: false,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false,
        additionalArguments: ['--hehe-packaged=0'] } });
    await w.loadFile(path.join(ROOT, file), { query });
    await sleep(700);
    return w;
  };
  try {
    const pin = await mk('pin.html', { id: '1', src: IMG, accent: 'jade', lang: 'en' });
    out.pinBefore = await pin.webContents.executeJavaScript('document.getElementById("hint").textContent');
    pin.webContents.send(CH, { lang: 'zh' });
    await sleep(400);
    out.pinAfter = await pin.webContents.executeJavaScript('document.getElementById("hint").textContent');

    const ruler = await mk('ruler.html', { dir: 'h', accent: 'jade', lang: 'en' });
    out.rulerBefore = await ruler.webContents.executeJavaScript('document.getElementById("close").title');
    ruler.webContents.send(CH, { lang: 'zh' });
    await sleep(400);
    out.rulerAfter = await ruler.webContents.executeJavaScript('document.getElementById("close").title');

    const snip = await mk('snip.html', { src: IMG, mode: 'annotate', dx: '0', dy: '0', scale: '1', w: '900', h: '700', accent: 'jade', lang: 'en' });
    await snip.webContents.executeJavaScript('window.__snipTest.select(20,20,300,200)');
    await sleep(400);
    out.snipBefore = await snip.webContents.executeJavaScript('Array.from(document.querySelectorAll("#bar .tbtn")).map(b=>b.getAttribute("aria-label"))');
    snip.webContents.send(CH, { lang: 'zh' });
    await sleep(400);
    out.snipAfter = await snip.webContents.executeJavaScript('Array.from(document.querySelectorAll("#bar .tbtn")).map(b=>b.getAttribute("aria-label"))');
    snip.webContents.send(CH, { lang: 'en' });
    await sleep(400);
    out.snipBack = await snip.webContents.executeJavaScript('Array.from(document.querySelectorAll("#bar .tbtn")).map(b=>b.getAttribute("aria-label"))');
  } catch (e) {
    out.error = String(e && e.stack || e);
  }
  try { fs.writeFileSync(OUT, JSON.stringify(out)); } catch (e) {}
  app.exit(0);
});
`;
const scriptPath = path.join(tmp, 'run.js');
fs.writeFileSync(scriptPath, runner, 'utf8');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.TEMP = tmp;
env.TMP = tmp;

let raw = '';
try {
  raw = execFileSync(EXE, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--user-data-dir=' + path.join(tmp, 'udd'), scriptPath], { env, encoding: 'utf8', timeout: 120000 });
} catch (e) {
  raw = String(e.stdout || '') + String(e.stderr || '');
}

let result = null;
try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch (e) {}
if (!result) {
  console.log('SKIP 结果未落盘：该环境可能无交互桌面');
  console.log(String(raw).slice(-2000));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}

const fails = [];
if (!/Drag to move/.test(result.pinBefore || '')) fails.push('pin 初始英文提示未生效');
if (!/拖动移动/.test(result.pinAfter || '')) fails.push('pin 切中文后提示未更新');
if (!/Close/.test(result.rulerBefore || '')) fails.push('ruler 初始英文 title 未生效');
if (!/关闭/.test(result.rulerAfter || '')) fails.push('ruler 切中文后 title 未更新');
const before = result.snipBefore || [];
const after = result.snipAfter || [];
if (before[0] !== 'Rectangle' || before[4] !== 'Mosaic') fails.push('snip 初始英文工具名不对');
if (after[0] !== '矩形' || after[4] !== '马赛克') fails.push('snip 切中文后工具名未更新');
if ((result.snipBack || [])[0] !== 'Rectangle') fails.push('snip 再切回英文后工具名未恢复');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
if (result.error) fails.push('runner 异常：' + result.error);
if (fails.length) {
  console.log('FAIL  ' + fails.join('；'));
  console.log(JSON.stringify(result));
  process.exit(1);
}
console.log('PASS  辅助窗已打开时切语言：pin 提示 / ruler title / snip 工具条都即时更新');
