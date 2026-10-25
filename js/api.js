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

  function browserFallback(ch, args) {
    switch (ch) {
      case 'store:get': return lsGet(args[0], args[1]);
      case 'store:set': lsSet(args[0], args[1]); return true;
      case 'store:remove': lsSet(args[0], undefined); return true;
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
    if (!r || r.ok !== true) throw new Error((r && r.error) || '调用失败：' + ch);
    return r.data;
  }

  function on(ev, cb) {
    if (isDesktop) return native.on(ev, cb);
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(cb);
    if (ev === 'sys:stats' && !listeners.has('_fakeStats')) {
      listeners.set('_fakeStats', true);
      setInterval(() => {
        const set = listeners.get('sys:stats');
        if (set) set.forEach(fn => fn({ cpu: 8 + Math.random() * 30, memUsed: 8e9, memTotal: 16e9, memPct: 50 + Math.random() * 10 }));
      }, 1500);
    }
    return () => listeners.get(ev)?.delete(cb);
  }

  function getPathForFile(file) {
    if (isDesktop && native.getPathForFile) return native.getPathForFile(file);
    return file.name; // 浏览器模式只有文件名
  }

  window.api = { invoke, on, isDesktop, getPathForFile };
})();
