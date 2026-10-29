const { contextBridge, ipcRenderer, webUtils, app } = require('electron');

/* 是否为开发态（未打包）。渲染层用它决定要不要挂测试钩子。
 * process.env.HEHE_TEST_HOOKS=1 可在打包版里临时开启（供打包态 E2E 使用），
 * 默认关闭 —— 生产包里不留调试后门。 */
let isDev = false;
try {
  isDev = !app.isPackaged || process.env.HEHE_TEST_HOOKS === '1';
} catch (e) {
  isDev = true; // 拿不到就按开发态处理（宁可多挂钩子，不影响功能）
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
