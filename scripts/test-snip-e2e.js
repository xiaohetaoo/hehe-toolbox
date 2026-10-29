'use strict';
/* E2E：截图标注渲染（P0 回归）。
 *
 * 旧的断言只检查“剪贴板拿到了非空 PNG”，但一张全透明的 PNG 也是非空的，
 * 所以 accentPrimary 未定义导致 render() 抛 ReferenceError、所有标注被跳过时，
 * 测试依然全绿。这里改成直接检查画布像素。
 *
 * 实现要点：executeJavaScript 的返回值必须可结构化克隆（不能回传函数），
 * 所以整段探测写成一段独立脚本文本，一次执行、只回传纯数字对象。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snipe2e-'));
const imgPath = path.join(tmp, 'bg.png');

/* 造一张纯白背景图 —— 用 e2e-helpers 的纯 Node PNG 生成，
 * 原来这里硬编码了 python 路径（换机器即挂），且依赖 PIL。 */
const { makeWhiteImage } = require('./e2e-helpers');
const genResult = makeWhiteImage(imgPath, 400, 300);
if (!genResult.ok) {
  console.log('SKIP 无法生成测试图片（' + genResult.method + '）');
  process.exit(0);
}

/* 页内探测脚本：一整段，最后返回纯数据对象 */
const PROBE = `
(() => {
  const PTS = [['edge', 122, 145], ['outside', 20, 20], ['inside', 190, 145]];
  const c = document.getElementById('c');
  const dpr = window.devicePixelRatio || 1;
  const ctx = c.getContext('2d');
  const sample = () => {
    const pts = {};
    for (const p of PTS) {
      const d = ctx.getImageData(Math.round(p[1] * dpr), Math.round(p[2] * dpr), 1, 1).data;
      pts[p[0]] = [d[0], d[1], d[2], d[3]];
    }
    return pts;
  };
  const out = {};
  const T = window.__snipTest;
  if (!T) return { fatal: 'window.__snipTest 不存在' };
  // 1) 初始：无选区，全屏压暗分支
  try { out.init = { ok: true, pts: sample() }; }
  catch (e) { out.init = { ok: false, err: e.message }; }
  // 2) 框选：走“已有选区”分支（旧代码在这里抛 ReferenceError）
  try { T.select(100, 80, 200, 140); out.sel = { ok: true, pts: sample() }; }
  catch (e) { out.sel = { ok: false, err: e.message }; }
  // 3) 画红色矩形，要求真的出现红色像素
  try {
    T.setTool('rect');
    T.addShape({ type: 'rect', color: '#FF0000', size: 6, x1: 120, y1: 100, x2: 260, y2: 190 });
    out.rect = { ok: true, pts: sample() };
  } catch (e) { out.rect = { ok: false, err: e.message }; }
  // 4) 清空标注后不应再有红色
  try {
    T.getShapes().length = 0;
    T.select(100, 80, 200, 140);
    out.undo = { ok: true, pts: sample() };
  } catch (e) { out.undo = { ok: false, err: e.message }; }
  return out;
})()
`;

const runner = [
  "const { app, BrowserWindow } = require('electron');",
  "const path = require('path');",
  "const ROOT = " + JSON.stringify(ROOT) + ";",
  "const IMG = " + JSON.stringify(imgPath) + ";",
  "const PROBE = " + JSON.stringify(PROBE) + ";",
  'app.whenReady().then(async () => {',
  '  const w = new BrowserWindow({ width: 420, height: 320, show: false,',
  "    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });",
  "  const q = { src: IMG, mode: 'annotate', dx: '0', dy: '0', scale: '1', w: '420', h: '320', accent: 'polar' };",
  "  await w.loadFile(path.join(ROOT, 'snip.html'), { query: q });",
  '  await new Promise(r => setTimeout(r, 700));',
  '  let res;',
  '  try { res = await w.webContents.executeJavaScript(PROBE); }',
  '  catch (e) { res = { fatal: String(e && e.message || e) }; }',
  "  console.log('SNIP_RESULT ' + JSON.stringify(res));",
  '  app.exit(0);',
  '});'
].join('\n');

const scriptPath = path.join(tmp, 'run.js');
fs.writeFileSync(scriptPath, runner, 'utf8');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');

/* 没有 Electron 二进制就 SKIP（不是失败）—— 这样能安全接入 npm test。
 * 之前这个测试没进 npm test，正是因为它必须能在缺依赖时优雅退出。 */
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON_EXE)) {
  console.log('SKIP 未找到 electron.exe（先 npm install + install.js）');
  process.exit(0);
}

let raw = '';
try {
  raw = execFileSync(ELECTRON_EXE,
    [scriptPath], { env, encoding: 'utf8', timeout: 120000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const line = String(raw || '').split(/\r?\n/).find(l => l.startsWith('SNIP_RESULT'));
if (!line) { console.log('未拿到 SNIP_RESULT'); console.log(raw.slice(-2000)); process.exit(1); }
const R = JSON.parse(line.slice('SNIP_RESULT '.length));

let fail = 0;
const chk = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) fail++; };

if (R.fatal) { console.log('FAIL  ' + R.fatal); fail++; }
else {
  chk(R.init && R.init.ok, '初始全屏压暗渲染不报错' + (R.init && R.init.err ? ' -> ' + R.init.err : ''));
  chk(R.sel && R.sel.ok, '框选后 render 不抛异常' + (R.sel && R.sel.err ? ' -> ' + R.sel.err : ''));
  chk(R.rect && R.rect.ok, '绘制矩形不抛异常' + (R.rect && R.rect.err ? ' -> ' + R.rect.err : ''));
  if (R.rect && R.rect.ok) {
    const [r, g, b] = R.rect.pts.edge;
    chk(r > 180 && g < 90 && b < 90, `矩形边缘出现红色像素 rgb(${r},${g},${b})`);
    const [ro, go, bo] = R.rect.pts.outside;
    chk(ro < 230 && go < 230 && bo < 240, `选区外被压暗 rgb(${ro},${go},${bo})`);
    const [ri, gi, bi] = R.rect.pts.inside;
    chk(ri > 200 && gi > 200 && bi > 200, `选区内部保持明亮 rgb(${ri},${gi},${bi})`);
  }
  if (R.undo && R.undo.ok) {
    const [r, g, b] = R.undo.pts.edge;
    chk(!(r > 180 && g < 90 && b < 90), `清空标注后红色消失 rgb(${r},${g},${b})`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail === 0 ? 0 : 1);
