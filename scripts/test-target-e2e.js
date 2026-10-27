/* 端到端验证目标体积压缩的图片多轮逼近：
 * 造一张噪声大图，用 Electron 真实渲染进程跑 8 轮质量/尺寸递降，
 * 确认最终输出体积确实能压到目标以内。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-'));
const srcImg = path.join(tmp, 'big.png');

/* 生成噪声大图（噪声最不易压缩，便于观察多轮效果） */
const pyPath = path.join(tmp, 'gen.py');
fs.writeFileSync(pyPath, [
  'from PIL import Image',
  'import random',
  'random.seed(42)',
  'W,H = 1200, 900',
  'img = Image.new("RGB",(W,H))',
  'px = img.load()',
  'for y in range(H):',
  '    for x in range(W):',
  '        px[x,y] = (random.randint(0,255), random.randint(0,255), random.randint(0,255))',
  'img.save(r"' + srcImg + '")',
  'print("ok")'
].join('\n'), 'utf8');
execFileSync('C:/Users/67153/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
  [pyPath], { stdio: 'ignore' });

const srcSize = fs.statSync(srcImg).size;
console.log('源图:', (srcSize / 1048576).toFixed(2) + 'MB');

/* 渲染进程脚本：占位符 __B64__ / __TARGET__ 运行时替换 */
const inline = [
  '(async () => {',
  '  const img = new Image();',
  '  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + window.__B64; });',
  '  const results = [];',
  '  for (let round = 0; round < 8; round++) {',
  '    const q = Math.max(0.45, 0.9 - round * 0.08);',
  '    let scale = 1;',
  '    if (round >= 6) scale = 0.6; else if (round >= 5) scale = 0.75; else if (round >= 4) scale = 0.85;',
  '    const cw = Math.max(1, Math.round(img.naturalWidth * scale));',
  '    const ch = Math.max(1, Math.round(img.naturalHeight * scale));',
  '    const c = document.createElement("canvas");',
  '    c.width = cw; c.height = ch;',
  '    const ctx = c.getContext("2d");',
  '    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);',
  '    ctx.drawImage(img, 0, 0, cw, ch);',
  '    const du = c.toDataURL("image/jpeg", q);',
  '    const bytes = Math.floor(du.split(",")[1].length * 3 / 4);',
  '    results.push({ round: round + 1, q: q, scale: scale, w: cw, h: ch, approxBytes: bytes });',
  '    if (bytes <= window.__TARGET) break;',
  '  }',
  '  return { results, naturalW: img.naturalWidth, naturalH: img.naturalHeight };',
  '})()'
].join('\n');

const runner = [
  "const { app, BrowserWindow } = require('electron');",
  "const fs = require('fs');",
  "const VM = " + JSON.stringify({ src: srcImg, b64: fs.readFileSync(srcImg).toString('base64') }) + ";",
  'app.whenReady().then(async () => {',
  '  const w = new BrowserWindow({ width: 400, height: 300, show: false });',
  '  await w.loadURL("data:text/html,<html><body></body></html>");',
  '  const srcSize = fs.statSync(VM.src).size;',
  '  const target = Math.floor(srcSize * 0.15);',
  '  await w.webContents.executeJavaScript("window.__B64=" + JSON.stringify(VM.b64) + ";window.__TARGET=" + target + ";");',
  '  const out = await w.webContents.executeJavaScript(' + JSON.stringify(inline) + ', true);',
  "  console.log('TGT_RESULT ' + JSON.stringify({ srcSize, target, out }));",
  '  app.exit(0);',
  '});'
].join('\n');

const scriptPath = path.join(tmp, 'run.js');
fs.writeFileSync(scriptPath, runner, 'utf8');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
const r = execFileSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  [scriptPath], { env, encoding: 'utf8', timeout: 180000 });

const line = String(r || '').split(/\r?\n/).find(l => l.startsWith('TGT_RESULT'));
if (!line) { console.log('未拿到结果'); process.exit(1); }
const R = JSON.parse(line.slice('TGT_RESULT '.length));

console.log('目标:', (R.target / 1048576).toFixed(2) + 'MB（源图的 15%）');
console.log('轮次明细:');
for (const x of R.out.results) {
  console.log('  第' + x.round + '轮  q=' + x.q.toFixed(2) + '  scale=' + x.scale +
    '  ' + x.w + 'x' + x.h + '  ≈' + (x.approxBytes / 1024).toFixed(0) + 'KB');
}
const last = R.out.results[R.out.results.length - 1];
const hit = last.approxBytes <= R.target;
console.log('是否达标:', hit ? 'YES' : 'NO');
console.log('源图未被修改:', fs.statSync(srcImg).size === srcSize ? 'YES' : 'NO');

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(hit ? 0 : 2);
