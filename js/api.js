/* API 封装：桌面端走 IPC，浏览器演示模式自动降级 */
(function () {
  const native = window.hehe || null;
  const isDesktop = !!native;
  const listeners = new Map();

  function lsGet(key, def) {
    try {
      const raw = localStorage.getItem('hehe-store:' + key);
      return raw == null ? def : JSON.parse(raw);
    } catch (e) { return def; }
  }
  function lsSet(key, val) { try { localStorage.setItem('hehe-store:' + key, JSON.stringify(val)); } catch (e) {} }
  // 不能写成 lsSet(key, undefined)：localStorage 会把 undefined 存成字符串 "undefined"，
  // 键依然存在，之后每次 lsGet 都 JSON.parse 抛错再走 catch —— 键永久泄漏且有日志噪音。
  function lsRemove(key) { try { localStorage.removeItem('hehe-store:' + key); } catch (e) {} }

  function browserFallback(ch, args) {
    switch (ch) {
      case 'store:get': return lsGet(args[0], args[1]);
      case 'store:set': lsSet(args[0], args[1]); return true;
      case 'store:remove': lsRemove(args[0]); return true;
      case 'app:get-info':
        return { appVersion: '1.0.0', electron: '-', node: '-', chrome: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || '-', platform: 'browser', userData: '(浏览器演示模式)', exePath: '-', hostname: 'demo', username: 'demo' };
      case 'app:get-autostart': return false;
      case 'app:set-hotkey': return true;
      case 'win:is-maximized': return false;
      case 'server:status': return false;
      default:
        throw new Error('浏览器演示模式不支持该功能，请运行桌面版（npm start）');
    }
  }

  async function invoke(ch, ...args) {
    if (!isDesktop) return browserFallback(ch, args);
    const r = await native.invoke(ch, ...args);
    if (!r || r.ok !== true) {
      // 主进程现在会附带稳定错误码与建议操作。把它们挂到 Error 上，
      // 现有代码 catch(e){ toast(e.message) } 完全不用改；
      // 需要更友好提示的地方可以读 e.code / e.advice。
      const err = new Error((r && r.error) || '调用失败：' + ch);
      if (r && r.code) err.code = r.code;
      if (r && r.advice) err.advice = r.advice;
      throw err;
    }
    return r.data;
  }

  // 把错误渲染成「原文 + 建议」的文本，供各工具统一使用
  function errText(e) {
    if (!e) return '操作失败';
    const msg = e.message || String(e);
    return e.advice ? (msg + '\n建议：' + e.advice) : msg;
  }

  // 浏览器模式下的假 sys:stats 心跳。原来把定时器 id 丢掉、还把布尔值塞进
  // 全是 Set 的 listeners Map（键空间污染），既停不掉空转的 interval，
  // 又可能让同名的真实事件触发 set.forEach is not a function。
  let fakeStatsTimer = null;
  function startFakeStats() {
    if (fakeStatsTimer) return;
    fakeStatsTimer = setInterval(() => {
      const set = listeners.get('sys:stats');
      if (!set || set.size === 0) return; // 没人监听就空转，不做事
      set.forEach(fn => { try { fn({ cpu: 8 + Math.random() * 30, memUsed: 8e9, memTotal: 16e9, memPct: 50 + Math.random() * 10 }); } catch (e) {} });
    }, 1500);
  }
  function stopFakeStatsIfIdle() {
    const set = listeners.get('sys:stats');
    if (fakeStatsTimer && (!set || set.size === 0)) { clearInterval(fakeStatsTimer); fakeStatsTimer = null; }
  }

  function on(ev, cb) {
    if (isDesktop) return native.on(ev, cb);
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(cb);
    if (ev === 'sys:stats') startFakeStats();
    return () => {
      listeners.get(ev)?.delete(cb);
      if (ev === 'sys:stats') stopFakeStatsIfIdle();
    };
  }

  function getPathForFile(file) {
    if (isDesktop && native.getPathForFile) return native.getPathForFile(file);
    return file.name; // 浏览器模式只有文件名
  }

  /* isDev：开发态为 true（打包版默认 false），供「只在开发态挂测试钩子」使用。
   * 浏览器演示模式也算 dev（方便本地调试）。 */
  const isDev = native ? !!native.isDev : true;
  /* evalExpr：安全表达式求值（同步调用 preload 桥，不经 IPC）。
   * 浏览器演示模式返回 null，由调用方给出降级提示。 */
  const evalExpr = native && native.evalExpr ? native.evalExpr : null;
  window.api = { invoke, on, isDesktop, isDev, getPathForFile, errText, evalExpr };
})();
