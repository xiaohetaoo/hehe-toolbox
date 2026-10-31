const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* 是否为开发态（未打包）。渲染层用它决定要不要挂测试钩子。
 * process.env.HEHE_TEST_HOOKS=1 可在打包版里临时开启（供打包态 E2E 使用），
 * 默认关闭 —— 生产包里不留调试后门。
 *
 * 【为什么不能直接用 app.isPackaged】
 * preload 跑在渲染进程里，`require('electron')` 只给 contextBridge /
 * ipcRenderer / webUtils 这几样，**拿不到 app**。
 * 原来写 `!app.isPackaged` 会抛 TypeError: Cannot read properties of
 * undefined (reading 'isPackaged')，被 catch 兜底成 isDev = true ——
 * 于是打包版也认为自己是开发态，__snipTest / __drawn 等测试钩子照旧常驻，
 * HEHE_TEST_HOOKS 也就彻底失去意义。（已用探针实测确认：preload 里
 * typeof app === 'undefined'。）
 *
 * 正确做法：开发态由**主进程**判断，通过 additionalArguments 注入
 * （见 main.js 的 HEHE_PACKAGED_ARG）。preload 只读这个参数。 */
let isDev = false;
try {
  // process.argv 里会带上主进程注入的 --hehe-packaged=1 / =0
  const arg = process.argv.find((a) => a.startsWith('--hehe-packaged='));
  const packaged = arg ? arg.split('=')[1] === '1' : null;
  if (packaged === null) {
    /* 没拿到注入参数（例如单独跑胶水脚本/测试桩）：保守按开发态，
     * 但**只有**在确实能判断时才这么定，不要无条件放行。 */
    isDev = true;
  } else {
    isDev = !packaged || process.env.HEHE_TEST_HOOKS === '1';
  }
} catch (e) {
  isDev = false; // 出错时按生产态处理：宁可少挂钩子，也不在包里留后门
}

/* 安全表达式求值：预加载时就把实现 require 进来。
 * 放在模块顶层做一次，避免每次调用都重新 require（也便于失败时暴露原因）。 */
let exprEval = null;
let exprEvalError = null;
try {
  exprEval = require('./lib/expr-eval');
} catch (e) {
  exprEvalError = (e && e.message) || String(e);
}

contextBridge.exposeInMainWorld('hehe', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (event, cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
  isDev,
  /* 安全表达式求值（不依赖 eval）。渲染层在 contextIsolation 下拿不到 lib/，
   * 所以在这里桥接。求值是纯函数，无副作用。
   * 加载失败时返回明确的错误，避免"静默不可用"。 */
  evalExpr: (expr) => {
    if (!exprEval) return { ok: false, error: '求值器加载失败: ' + (exprEvalError || '未知原因') };
    try {
      return { ok: true, value: exprEval.evaluate(expr) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  },
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
});
