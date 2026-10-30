/* 打包资源完整性守卫：OCR / PDF / 简繁转换 需要的外部文件必须真的进包。
 *
 * 【为什么必须单独测】
 * 这些依赖不是被 import 的模块，而是运行时按路径拼出来的资源文件：
 *   - tesseract.js 会按 CPU 能力动态选 tesseract-core.<variant>.wasm.js
 *   - pdf.js 通过 workerSrc 加载 pdf.worker.min.js
 *   - opencc 通过 <script src> 加载 umd/full.js
 * 它们不在任何 import 图里，所以「源码跑得通」不代表「打包后还在」。
 *
 * 【真实事故】v0.2.4 的排除规则写成 `!node_modules/tesseract.js-core/tesseract-core.wasm*`，
 * 这个 * 同时吃掉了 tesseract-core.wasm.js —— 而它才是默认路径真正加载的那个。
 * 结果 OCR 在所有不支持 SIMD 的 CPU 上直接失败，但打包、冒烟、单元测试全都通过
 * （因为没人真的去 OCR 一张图）。这类问题只有检查产物内容才能发现。
 *
 * 用法：node scripts/test-packaged-assets.js [zipGuid 或 构建目录]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* 找待检产物：优先用 dist/ 里的 zip，其次用参数给的目录 */
function locate() {
  const arg = process.argv[2];
  if (arg) return { kind: 'dir', dir: arg };
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) return null;
  const zip = fs.readdirSync(distDir).find((n) => /^hehe-toolbox-.*-win-x64\.zip$/.test(n));
  if (!zip) return null;
  return { kind: 'zip', zip: path.join(distDir, zip) };
}

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const target = locate();
if (!target) {
  console.log('SKIP 没有打包产物可检（先构建，或传入解包目录）');
  process.exit(0);
}

/* 解包到临时目录（zip 只解一次，供多项检查复用） */
let appRoot;
let tmpDir = null;
if (target.kind === 'dir') {
  appRoot = target.dir;
} else {
  const AdmZip = require('adm-zip');
  const os = require('os');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-assets-'));
  new AdmZip(target.zip).extractAllTo(tmpDir, true);
  appRoot = tmpDir;
  console.log('校验对象: ' + path.basename(target.zip));
}

const asarPath = path.join(appRoot, 'resources', 'app.asar');
if (!fs.existsSync(asarPath)) {
  chk(false, '找不到 resources/app.asar');
  process.exit(1);
}

const asar = require('@electron/asar');
let entries;
try {
  entries = asar.listPackage(asarPath).map((f) => f.replace(/\\/g, '/'));
} catch (e) {
  chk(false, '读取 app.asar 失败: ' + e.message);
  process.exit(1);
}
const has = (suffix) => entries.some((f) => f.endsWith(suffix));
const countUnder = (dir) => entries.filter((f) => f.includes(dir)).length;

console.log('asar 条目数: ' + entries.length);

/* ---- 1. tesseract：四个变体都要在 ---- */
/* tesseract.js 的 worker 按能力选文件：
 *   支持 relaxedsimd → tesseract-core-relaxedsimd.wasm.js
 *   支持 simd       → tesseract-core-simd.wasm.js
 *   都不支持        → tesseract-core.wasm.js
 *   LSTM 模式       → 对应 *-lstm.wasm.js
 * 少任何一个，特定 CPU 上的 OCR 就废。 */
const OCR_VARIANTS = [
  '/node_modules/tesseract.js-core/tesseract-core.wasm.js',
  '/node_modules/tesseract.js-core/tesseract-core-simd.wasm.js',
  '/node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm.js',
  '/node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  '/node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  '/node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js'
];
const missingOcr = OCR_VARIANTS.filter((p) => !has(p));
chk(missingOcr.length === 0,
    'OCR 引擎全部变体都在包里' + (missingOcr.length ? ' -> 缺失：' + missingOcr.map((s) => path.basename(s)).join(', ') : ''));
chk(has('/node_modules/tesseract.js/dist/worker.min.js'), 'tesseract worker.min.js 在包里');

/* ---- 2. pdf.js：入口与 worker 都要在 ---- */
chk(has('/node_modules/pdfjs-dist/build/pdf.min.js'), 'pdf.js 主文件在包里');
chk(has('/node_modules/pdfjs-dist/build/pdf.worker.min.js'), 'pdf.js worker 在包里（渲染必需）');

/* ---- 3. opencc / pdf-lib：实际被 <script> 引用的那份 ---- */
chk(has('/node_modules/opencc-js/dist/umd/full.js'), 'opencc umd/full.js 在包里（简繁转换必需）');
chk(has('/node_modules/pdf-lib/dist/pdf-lib.min.js'), 'pdf-lib dist 版在包里（PDF 合并必需）');

/* ---- 4. QR / 其它 <script> 依赖 ---- */
const htmlSrcs = [...fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const missingScript = [];
for (const src of htmlSrcs) {
  if (src.startsWith('js/') || src.startsWith('node_modules/')) {
    if (!entries.some((f) => f.endsWith('/' + src))) missingScript.push(src);
  }
}
chk(missingScript.length === 0,
    'index.html 引用的脚本全部在包里' + (missingScript.length ? ' -> 缺失：' + missingScript.join(', ') : ''));

/* ---- 5. 应用自身文件与辅助窗口 ---- */
['/index.html', '/main.js', '/preload.js', '/splash.html', '/snip.html', '/pin.html', '/ruler.html', '/css/app.css', '/js/app.js', '/js/i18n.js']
  .forEach((p) => chk(has(p), '包内含 ' + p));

/* ---- 6. 开发文件不该进包（避免白白撑大解压量） ---- */
const devLeft = [
  ['tesseract.js/docs', '/node_modules/tesseract.js/docs/'],
  ['tesseract.js/src', '/node_modules/tesseract.js/src/'],
  ['tesseract.js/scripts', '/node_modules/tesseract.js/scripts/'],
  ['pdfjs-dist/legacy', '/node_modules/pdfjs-dist/legacy/'],
  ['pdf-lib/cjs', '/node_modules/pdf-lib/cjs/']
];
for (const [name, dir] of devLeft) {
  const n = countUnder(dir);
  chk(n === 0, '开发文件未进包：' + name + (n ? '（仍有 ' + n + ' 个）' : ''));
}

/* ---- 7. .map 源码映射不该进包（体积大且无用途） ---- */
const maps = entries.filter((f) => f.endsWith('.map'));
chk(maps.length === 0, '没有 .map 文件进包' + (maps.length ? '（仍有 ' + maps.length + ' 个）' : ''));

/* 清理临时解包目录 */
if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }

console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
