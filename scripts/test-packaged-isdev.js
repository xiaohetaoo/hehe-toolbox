'use strict';
/* 验证打包态 preload 的 isDev 判定（报告二的核心）。
 *
 * 这里的判定是**纯逻辑**：读 process.argv 里的 --hehe-packaged=0/1，
 * 再看 HEHE_TEST_HOOKS。不需要 DOM、不需要 IPC。
 * 早期写法试图建 BrowserWindow 加载页面再读 window.hehe.isDev，
 * 在无头/受限环境里页面加载会失败、探针拿不到结果 —— 既脆弱又测不准。
 *
 * 所以直接解包 zip 里的 asar，把**打包后的那份 preload.js** 的判定逻辑
 * 抽出来，配不同 argv 跑一遍。测的就是包里那份真实代码。
 */
const AdmZip = require('adm-zip');
const asarLib = require('@electron/asar');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ZIP = process.argv[2] || null;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

/* ---------- 1. 取待测源码：优先打包产物 ---------- */
let preloadSrc, mainSrc, sourceLabel;
if (ZIP && fs.existsSync(ZIP)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isd-'));
  const z = new AdmZip(ZIP);
  const ent = z.getEntries().find((e) => e.entryName.indexOf('app.asar') !== -1
    && e.entryName.indexOf('unpacked') === -1);
  if (ent) {
    const asarPath = path.join(tmp, 'app.asar');
    fs.writeFileSync(asarPath, ent.getData());
    const BS = String.fromCharCode(92);
    const read = (rel) => {
      for (const c of [rel, BS + rel, rel.split('/').join(BS), BS + rel.split('/').join(BS)]) {
        try { return asarLib.extractFile(asarPath, c).toString('utf8'); } catch (e) {}
      }
      return null;
    };
    preloadSrc = read('preload.js');
    mainSrc = read('main.js');
    sourceLabel = '打包产物 ' + path.basename(ZIP);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (!preloadSrc) {
  preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  sourceLabel = '工作区源码';
}
console.log('测试对象:', sourceLabel);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/* ---------- 2. 静态 ---------- */
t('preload 不再解构 app，也不再直接读 app.isPackaged', () => {
  const code = stripComments(preloadSrc);
  if (/const\s*\{[^}]*\bapp\b[^}]*\}\s*=\s*require\('electron'\)/.test(code)) {
    throw new Error('preload 仍从 electron 解构 app —— 实际拿到的是 undefined');
  }
  if (/\bapp\.isPackaged\b/.test(code)) {
    throw new Error('代码里仍直接读 app.isPackaged（preload 拿不到 app，会抛 TypeError）');
  }
  if (!/--hehe-packaged=/.test(preloadSrc)) {
    throw new Error('没有读取 additionalArguments 注入的打包标记');
  }
});

t('主进程给所有 preload 窗口注入打包标记', () => {
  const n = (mainSrc.match(/--hehe-packaged=/g) || []).length;
  if (n < 4) throw new Error('注入点只有 ' + n + ' 处，应至少 4（主窗口 + 3 个辅助窗口）');
  if (!/app\.isPackaged/.test(mainSrc)) throw new Error('主进程没有读取 app.isPackaged');
});

/* ---------- 3. 抽出判定逻辑并跑 ---------- */
function extractIsDev(src) {
  const start = src.indexOf('let isDev = false;');
  if (start === -1) throw new Error('找不到 isDev 初始化');
  let i = src.indexOf('try {', start);
  if (i === -1) throw new Error('找不到 try 块');
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const afterTry = i + 1;
  const rest = src.slice(afterTry);
  const catchM = /^\s*catch\s*\([^)]*\)\s*\{/.exec(rest);
  let end = afterTry;
  if (catchM) {
    let j = afterTry + catchM[0].length - 1;
    depth = 0;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) break; }
    }
    end = j + 1;
  }
  return src.slice(start, end);
}

const isDevLogic = extractIsDev(preloadSrc);

function evalIsDev(packagedFlag, hooksEnv) {
  const args = [];
  if (packagedFlag !== null) args.push('--hehe-packaged=' + (packagedFlag ? '1' : '0'));
  const processStub = { argv: ['electron', 'app', ...args], env: {} };
  if (hooksEnv) processStub.env.HEHE_TEST_HOOKS = '1';
  const fn = new Function('process', isDevLogic + '\nreturn isDev;');
  return fn(processStub);
}

t('打包版（packaged=1）isDev 为 false —— 测试钩子不常驻', () => {
  const v = evalIsDev(true, false);
  if (v !== false) throw new Error('期望 false，实际 ' + v + '（打包版仍带测试钩子）');
});

t('开发版（packaged=0）isDev 为 true —— 开发时钩子可用', () => {
  const v = evalIsDev(false, false);
  if (v !== true) throw new Error('期望 true，实际 ' + v);
});

t('打包版 + HEHE_TEST_HOOKS=1 可临时开钩子（打包态 E2E 的逃生口）', () => {
  const v = evalIsDev(true, true);
  if (v !== true) throw new Error('期望 true，实际 ' + v);
});

t('没拿到注入参数时保守判为开发态（不误伤测试桩）', () => {
  const v = evalIsDev(null, false);
  if (v !== true) throw new Error('期望 true，实际 ' + v);
});

t('判定逻辑完全不引用 app（注入没有 app 的 electron 也不会抛）', () => {
  if (/\bapp\.\w+/.test(stripComments(isDevLogic))) {
    throw new Error('isDev 判定逻辑里仍引用 app');
  }
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
