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
const stripComments = require('../lib/src-scan').stripComments;
/* 【为什么引 harness】迁移来的用例要 readMain({raw:true}) —— 主进程源码
 * 拼 main.js + ipc/，语义是"主进程里有这个实现"。本文件其余部分用自建
 * 计数器，不参与 harness 的套件，这里只借它的读取工具。 */
const { readMain } = require('./lib/harness');
/* 读项目内文件（迁移来的配平断言要读 test-packaged-isdev.js 的源码）。 */
function read(rel) { return fs.readFileSync(require('path').join(__dirname, '..', rel), 'utf8'); }
const mainSrc = readMain({ raw: true });
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* 找待检产物：优先用 dist/ 里的 zip，其次用参数给的目录。
 *
 * 【必须只认当前版本的产物】
 * 原来这里找的是"任意一个 hehe-toolbox-*-win-x64.zip"。问题在于：
 * 改了源码、还没重新打包时，dist/ 里躺着的是上一版的 zip —— 拿它去跑
 * "index.html 引用的脚本是否都在包里"，会报"新增的 js 文件缺失"。
 * 那条报错**看起来像代码 bug**，实际是"产物过期"，
 * 每次加新文件都要重新构建才能让测试变绿 —— 而这个测试本该只在
 * "有对应版本的产物"时才有意义。
 *
 * 现在的规则：zip 文件名里的版本必须等于 package.json 的 version。
 * 不相等 = 产物过期 → SKIP 并说清哪一版过期了（而不是假装失败）。 */
function locate() {
  const arg = process.argv[2];
  if (arg) return { kind: 'dir', dir: arg };
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) return null;
  /* 读版本号用 require：package.json 是 CommonJS 可直接载入，
   * 不必为此多一处裸 readFileSync（那会被 SA-3 记账）。 */
  const pkgVer = require(path.join(ROOT, 'package.json')).version;
  const zips = fs.readdirSync(distDir).filter((n) => /^hehe-toolbox-.*-win-x64\.zip$/.test(n));
  if (!zips.length) return null;
  const exact = zips.find((n) => n.indexOf('-' + pkgVer + '-') !== -1);
  if (exact) return { kind: 'zip', zip: path.join(distDir, exact) };
  /* 没有同版本产物：明确 SKIP，并指出最接近的是哪一版 */
  return { kind: 'stale', have: zips[0], want: pkgVer };
}

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const target = locate();
if (!target) {
  console.log('SKIP 没有打包产物可检（先构建，或传入解包目录）');
  process.exit(0);
}
if (target.kind === 'stale') {
  /* 产物版本与源码不符：这是"还没重新打包"，不是代码缺陷。
   * 明说哪一版过期，比抛一堆"文件缺失"更有用。 */
  console.log('SKIP dist 里只有 ' + target.have + '，而 package.json 是 '
    + target.want + ' —— 产物已过期，先重新构建再跑这项');
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

/* @electron/asar 原来是 electron-builder 的传递依赖，在干净环境里不一定能解析到
   （CI 上就因为这一点挂过）。已显式加进 devDependencies；
   这里再加一层兜底：解析不到就明确 SKIP，而不是抛一个看起来像代码错误的异常。 */
let asar;
try {
  asar = require('@electron/asar');
} catch (e) {
  console.log('SKIP 缺少 @electron/asar（' + (e.code || e.message) + '），跳过产物内容校验');
  console.log('     修复：npm i -D @electron/asar');
  process.exit(0);
}

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

 /* ============ splash 的打包标记（原 test-round9 问题6） ============
  * 锁的是：splash 窗口的 webPreferences 漏掉 additionalArguments 注入，
  * 于是 preload 里的 isDev 判定把打包版当开发态 —— 表现是启动窗
  * 走了开发分支（例如显示调试信息、或加载非打包资源）。
  * 为什么只能断言形态：要观察 isDev 的真实取值得启动打包后的应用。
  * 下面第二条是它的"配平"版本：不数总数，而是要求
  * 「带 preload 的窗口数 == 带注入的窗口数」，这样新增窗口漏注入就会红。 */
const codeMain = stripComments(mainSrc);
const spIdx = codeMain.indexOf('function createSplash()');
chk(spIdx > 0, '能找到 createSplash()');
if (spIdx > 0) {
  const seg = codeMain.slice(spIdx, spIdx + 2200);
  chk(/--hehe-packaged=/.test(seg),
    'splash 的 webPreferences 注入了打包标记');
}

/* 配平断言：测试脚本自己对「带 preload 的窗口」与「带注入的窗口」做等量比对，
 * 而不是只检查注入点 >= 4（后者对"新增一个窗口但忘了注入"完全无感）。 */
const isdevSrc = read('scripts/test-packaged-isdev.js');
const isdevCode = stripComments(isdevSrc);
chk(!/if \(n < 4\)/.test(isdevCode), '不再用「注入点 >= 4」的弱断言');
chk(
  /withPreload\.length !== withInject\.length/.test(isdevCode)
  || /withInject\.length !== withPreload\.length/.test(isdevCode),
  '测试脚本用配平断言（带 preload 的窗口数 == 带注入的窗口数）');

/* ============ 收尾：失败必须以非零退出 ============
 * 【这里原来什么都没有】chk() 只累加 fail，但从不读它 —— 于是任何一条
 * 断言失败都只打印一行 FAIL，进程仍然 exit 0。CI 的判定依赖退出码，
 * 所以这个文件实际上是「永远绿」的：打包缺资源也能过。
 * 这不是本轮引入的（迁移前就这样），是迁移时把用例挪过来才发现的。 */
console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
