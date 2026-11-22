'use strict';
/* 统一的 Electron 启动参数 + 启动器。
 *
 * ============ 为什么需要这个模块 ============
 * 本仓库有 30+ 个测试脚本要真启 Electron 才能验渲染层（CDP 取值、
 * 拖拽、标签栏、i18n、拼音搜索……）。这些脚本各自拼 `execFileSync(exe, [脚本])`，
 * 于是在**特定环境**下全部同一个死法：Electron 进程起来就崩，退出码
 * `2147483651`（0x80000003），stdout/stderr 都是空的 —— 测试只能报一句
 * 「没拿到渲染层结果」，看不出是环境问题还是产品问题。
 *
 * ============ 根因（2026-11-22 实测） ============
 * 不是"没有桌面会话"，也不是"Electron 坏了"：
 *   · `electron.exe --version`            → 0x80000003 崩
 *   · `electron.exe --no-sandbox --version` → v43.8.4 正常
 * 也就是说 **Chromium 的进程级沙箱在本机起不来**（缺容器/受限令牌，
 * 常见于容器、受策略管控的机器、以及某些安全软件环境）。
 * 产品自身的 webPreferences 本来就是 `sandbox: false`（渲染层沙箱已关），
 * 但那是**渲染进程**的开关，管不到浏览器主进程的 `--no-sandbox`。
 *
 * ============ 这个模块做什么 ============
 * 把"启动 Electron"收成一个入口：自动带上必需的安全/兼容参数，
 * 并把"起不来"这件事与"测试真的失败"区分开（前者按环境跳过处理，
 * 不能算产品回归）。
 *
 * 【只在测试里用】产品打包后的启动参数不受这里影响 —— 用户机器上的
 * 沙箱通常正常，不该默认关掉它。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

/**
 * 启动 Electron 时**必须**附加的参数。
 *
 * `--no-sandbox`
 *   : Chromium 进程级沙箱。本机不加它 Electron 直接崩溃（见文件头实测）。
 *     测试环境用不到沙箱的隔离能力（跑的是我们自己写的页面），
 *     关掉是安全且必要的。
 * `--disable-gpu`
 *   : 无显示/远程会话下 GPU 进程常起不来，会让窗口创建挂住几十秒。
 *     渲染仍走软件光栅，断言用的 DOM/文本完全不受影响。
 * `--disable-dev-shm-usage`
 *   : 某些受限环境的 /dev/shm 太小，不加会随机 OOM 崩溃。
 *
 * 不传 `--headless`：本项目的探针要用真实窗口尺寸做布局断言，
 * headless 下 getBoundingClientRect 的行为与有头模式不同。
 */
const REQUIRED_FLAGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

/* ============ 第二个必须处理的坑：%TEMP% 写不进去 ============
 * 2026-11-22 实测：Electron 起来之后，渲染进程往 `os.tmpdir()` 写文件报
 *   `EPERM: operation not permitted`
 * 同一个进程写工作区内目录完全正常，而 Node 主进程在 %TEMP% 下读写也没问题。
 * 也就是说这是 **Chromium 子进程**被安全软件拦了 TEMP 写入。
 * 探针脚本都要把结果落盘再读（stdout 在 Windows GUI 程序里不可靠），
 * 于是全部卡在"写不了结果文件"。
 *
 * 解法：把子进程的 TEMP/TMP 与 `--user-data-dir` 一起指到**工作区内**的
 * 临时目录（调用方传入或这里自建）。工作区不在拦截名单里，且用完即删，
 * 符合"临时文件不放工作区外"的约定。 */
let scratchSeq = 0;
/** 建一个工作区内的临时目录（调用方负责删）。 */
function makeScratchDir(tag) {
  const base = path.join(ROOT, '.tmp-e2e-' + (tag || 'run') + '-' + (++scratchSeq) + '-' + Date.now().toString(36));
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/** 清理掉会让 Electron 以 Node 模式运行的变量（会导致 app 模块不可用），
 *  并把 TEMP/TMP 指到工作区内的目录（见文件头第二个坑）。 */
function cleanEnv(extra) {
  const env = Object.assign({}, process.env, extra || {});
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** 把子进程的 TEMP/TMP 与 --user-data-dir 统一切到工作区临时目录。
 *  @param {{env?:object, scratchDir?:string, tag?:string, extraFlags?:string[]}} [o] */
function prepareScratch(o) {
  const opts = o || {};
  const dir = opts.scratchDir || makeScratchDir(opts.tag);
  const env = cleanEnv(opts.env);
  env.TEMP = dir;
  env.TMP = dir;
  env.USERPROFILE = env.USERPROFILE;   // 不覆盖用户目录（有些探针要读 realpath）
  const flags = ['--user-data-dir=' + path.join(dir, 'udd'), ...REQUIRED_FLAGS, ...(opts.extraFlags || [])];
  return { dir, env, flags };
}

/** electron.exe 是否就位（没装依赖时让调用方走 SKIP 而不是报失败）。 */
function hasElectron() {
  return fs.existsSync(ELECTRON_EXE);
}

/**
 * 探测"这台机器上 Electron 能不能起来"。
 *
 * 返回 {ok, reason}。探测本身很便宜（一个 --version），结果缓存到模块级，
 * 一次测试进程只付一次代价。
 *
 * 【为什么要探测而不是直接跑】环境起不来时 Electron 的 stdout/stderr 是空的，
 * 测试拿不到任何线索，只能报"没拿到结果"。先探测就能把它明确成
 * 「环境跳过：Electron 无法启动」，与产品回归分开。
 */
let probeCache = null;
function probe() {
  if (probeCache) return probeCache;
  if (!hasElectron()) { probeCache = { ok: false, reason: '未安装 electron 依赖' }; return probeCache; }
  const r = spawnSync(ELECTRON_EXE, [...REQUIRED_FLAGS, '--version'], {
    env: cleanEnv(), encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  if (r.status === 0) { probeCache = { ok: true, reason: '' }; return probeCache; }
  /* 不带参数再试一次：用来区分"Electron 整体坏了"与"只缺沙箱开关" */
  const r2 = spawnSync(ELECTRON_EXE, ['--no-sandbox', '--version'], {
    env: cleanEnv(), encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  probeCache = r2.status === 0
    ? { ok: false, reason: 'Electron 仅在不带兼容参数时可启动（本模块已带 --no-sandbox）' }
    : { ok: false, reason: 'Electron 无法启动（status=' + r.status + '）' };
  return probeCache;
}

/**
 * 同步启动一个 Electron 探针脚本并返回它的 stdout。
 *
 * @param {string} scriptPath 要交给 Electron 执行的 .js 文件
 * @param {object} [opts]
 * @param {object} [opts.env] 额外环境变量
 * @param {number} [opts.timeout] 毫秒，默认 180000
 * @param {string[]} [opts.extraFlags] 额外 Chromium 参数
 * @returns {string} stdout
 * @throws 启动失败时抛出带明确原因的错误（调用方应据此判"环境跳过"）
 */
function runElectronSync(scriptPath, opts) {
  /** @type {{env?:object, scratchDir?:string, tag?:string, extraFlags?:string[], timeout?:number}} */
  const o = opts || {};
  if (!hasElectron()) throw new Error('未安装 electron 依赖（node_modules/electron/dist/electron.exe 不存在）');
  const { env, flags, dir } = prepareScratch(o);
  try {
    return execFileSync(ELECTRON_EXE, [...flags, scriptPath],
      { env, encoding: 'utf8', timeout: o.timeout || 180000, windowsHide: true });
  } finally {
    /* 只在自建目录时清理；调用方传了 scratchDir 就由它自己管 */
    if (!o.scratchDir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  }
}

/** 异步版：返回 {status, stdout, stderr}，不抛（调用方自己判）。 */
function runElectron(scriptPath, opts) {
  /** @type {{env?:object, scratchDir?:string, tag?:string, extraFlags?:string[], timeout?:number}} */
  const o = opts || {};
  const { env, flags, dir } = prepareScratch(o);
  return new Promise((resolve) => {
    const r = spawnSync(ELECTRON_EXE, [...flags, scriptPath],
      { env, encoding: 'utf8', timeout: o.timeout || 180000, windowsHide: true });
    if (!o.scratchDir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
    resolve({ status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') });
  });
}

module.exports = {
  ELECTRON_EXE, REQUIRED_FLAGS, hasElectron, probe, makeScratchDir,
  runElectronSync, runElectron, cleanEnv, prepareScratch,
};
