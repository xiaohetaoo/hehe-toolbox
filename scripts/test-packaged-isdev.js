'use strict';
const { t, done } = require('./lib/harness');
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

t('主进程给所有带 preload 的窗口注入打包标记（配平断言）', () => {
  const code = stripComments(mainSrc);

  /* 【为什么不能只数注入点总数】
   * 早期断言是「--hehe-packaged= 出现次数 >= 4 就通过」。
   * 那种数法抓不到「某个窗口漏了」—— splash 就是这样漏掉的：
   * 总数仍然够，但 splash 的 webPreferences 里没有注入，
   * 它的 preload 拿不到参数就按开发态处理。
   * 现在改成配平：每个带 preload 的 BrowserWindow 都必须有注入。
   *
   * 注意主窗口用的是变量 packagedArg（定义在 createWindow 里），
   * 所以「已注入」有两种形态：字面量 --hehe-packaged=... 或 packagedArg。 */
  const hasInject = (block) => /--hehe-packaged=/.test(block) || /\bpackagedArg\b/.test(block);

  /* 1) 找出所有 BrowserWindow 调用，按是否带 preload 分组 */
  const calls = [];
  const re = /new\s+BrowserWindow\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    /* 从 '(' 起做括号配平，截出这次调用的参数 */
    let i = m.index + m[0].length - 1;
    let depth = 0;
    const start = i;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    calls.push(code.slice(start, i));
  }
  if (!calls.length) throw new Error('没找到任何 new BrowserWindow 调用 —— 解析失效？');

  const withPreload = calls.filter((c) => /\bpreload\s*:/.test(c));
  const withInject = withPreload.filter(hasInject);

  if (withPreload.length < 5) {
    throw new Error('带 preload 的窗口只有 ' + withPreload.length + ' 个，' +
      '预期至少 5（主窗口 + 标尺 + 贴图 + 截图 + splash）；' +
      '若确实增减了窗口，请同步更新这条断言');
  }
  if (withInject.length !== withPreload.length) {
    /* 找出漏掉的那个，给出可定位的提示 */
    const missing = withPreload.filter((c) => !hasInject(c));
    const hint = missing.map((c) => {
      const pm = /\bpreload\s*:\s*(.+?)[,}\n]/.exec(c);
      return pm ? pm[1].trim() : '(未知 preload)';
    }).join(' | ');
    throw new Error('有 ' + withPreload.length + ' 个窗口带 preload，' +
      '但只有 ' + withInject.length + ' 个注入了打包标记。漏掉的：' + hint);
  }
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

t('没拿到注入参数时按生产态处理（失败关闭，不在包里留后门）', () => {
  /* 【这条断言在 2026-11-09 反转了方向】
   * 它原来叫「没拿到注入参数时保守判为开发态」，断言 evalIsDev(null,…) === true。
   * 那个方向是**反的**：isDev=true 会让 __snipTest / __drawn 这些测试钩子
   * 在打包版里常驻，而这正是本文件上一半用例在防的事（"打包版也认为
   * 自己是开发态"）。触发条件是主进程的 additionalArguments 注入失效
   * （参数改名、某个窗口忘了传）—— 那是一个回归，失败方向必须是关闭。
   * 与 preload.js 里 catch 分支的注释「宁可少挂钩子，也不在包里留后门」一致。
   *
   * 开发体验不受影响：npm start 时主进程注入的是 --hehe-packaged=0，
   * packaged 值是 '0' 而不是 null，走的是另一条分支（见上面的用例）。 */
  const v = evalIsDev(null, false);
  if (v !== false) throw new Error('期望 false（生产态），实际 ' + v);
});

t('没拿到注入参数时，即使设了 HEHE_TEST_HOOKS 也不开（不认环境变量逃生口）', () => {
  /* 锁的是：把"拿不到参数"这条路径也接到 HEHE_TEST_HOOKS 上 ——
   * 那等于给打包版留一个环境变量后门，谁设了谁就能开调试钩子。
   * 逃生口只在**明确知道自己是打包版**（packaged==='1'）时才生效。 */
  const v = evalIsDev(null, true);
  if (v !== false) throw new Error('期望 false（生产态），实际 ' + v);
});

t('判定逻辑完全不引用 app（注入没有 app 的 electron 也不会抛）', () => {
  if (/\bapp\.\w+/.test(stripComments(isDevLogic))) {
    throw new Error('isDev 判定逻辑里仍引用 app');
  }
});

done();
