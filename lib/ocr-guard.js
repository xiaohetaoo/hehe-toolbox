'use strict';
/* OCR 的「别让用户永远等」守卫：超时 + 失败原因归因。
 *
 * ============ 为什么需要这个文件 ============
 * tesseract.js 的 `recognize()` 返回的 promise 在某些失败路径上**永不 settle**：
 *   · WebAssembly 编译被 CSP 拒绝时，错误发生在 blob worker 内部，
 *     不一定回传到主线程那个 promise 上；
 *   · 语言包（~10MB）下载被网络或安全软件拦在半路时同理。
 *
 * 实测过的现象：CSP 里没有 wasm 许可时，`Tesseract.recognize(...)` 在 20 秒
 * 内既不 resolve 也不 reject。界面于是永久停在
 * 「初始化 OCR 引擎（首次识别需下载语言包，请耐心等待）…」——
 * 进度条不动、没有任何错误提示。
 *
 * 这比直接报错更糟：用户看到的是"很慢"，不是"坏了"，于是会一直等下去。
 *
 * ============ 为什么单独成文件（而不是各工具各写一份）============
 * 「截图 OCR」和「批量图片 OCR」用的是同一套引擎、同样的失败模式、
 * 同样的三种归因。写两份必然分叉：一边加了超时、另一边没加；一边把
 * "引擎起不来"说成"网络问题"、另一边说对了。抽成 UMD 后主进程测试也能
 * 直接 require 来验归因逻辑（纯函数部分）。
 *
 * 加载方式：index.html 里 <script src="lib/ocr-guard.js">（排在 tools 之前），
 * 挂到 window.OcrGuard；node 侧 require 拿到同一个对象。
 *
 * ============ 关于「超时真的能取消吗」============
 * 不能。tesseract.js 没有提供中止 worker 的接口，超时只是**把控制权还给用户**：
 * 让他看到明确的失败原因、可以重试或换张图，而不是对着一个不动的进度条干等。
 * 后台那个 worker 会自己耗完或随页面卸载一起消失。这一点必须写在注释里，
 * 否则后来者会以为加了超时就把资源也回收了。
 */
(function (root, factory) {
  const api = factory();
  /* 【两条独立的 if，不要写成 if/else】
   * 与 lib/exif.js / lib/pinyin.js 保持一致：那两个是两条独立 if，
   * 所以"同时有 module 且有 root"时**两边都会挂**。
   * 这里原来是 if/else —— 有 module 就不挂全局。后果：
   *   · node 下 globalThis.OcrGuard 是 undefined（ExifLib / Pinyin 却是 object）；
   *   · 用 vm 模拟"同时有 module 且 window === globalThis"的环境时，
   *     前两者一个全局都不挂。
   * 当前窗口都是 nodeIntegration:false，线上触发不到；但这种分叉会让人
   * 以为"UMD 都是同一套"，下次照着某一个改就会踩空。统一成两条独立 if。 */
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    const g = /** @type {Record<string, unknown>} */ (root);
    g.OcrGuard = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /* 60 秒的依据：首次识别要下载约 10MB 语言包，慢网也要几十秒；
   * 超过一分钟基本可以判定不是"慢"，而是"卡住了"。 */
  const DEFAULT_TIMEOUT_MS = 60000;

  /**
   * 给一个 promise 套超时。超时会以带 code='OCR_TIMEOUT' 的 Error reject，
   * 调用方据此区分「超时」与「引擎报错」。
   *
   * @param {Promise<any>} p
   * @param {number} [ms]
   * @param {string} [timeoutMsg]
   * @returns {Promise<any>}
   */
  function withTimeout(p, ms, timeoutMsg) {
    /* 【Number(ms) > 0 放过了 Infinity】
     * 实测 withTimeout(never, Infinity) 会在 2ms 后 reject，并打印
     * TimeoutOverflowWarning: Infinity does not fit into a 32-bit signed integer.
     * 因为 setTimeout 把 Infinity 当成 1ms 处理 —— 用户传"永不超时"，
     * 得到的是"几乎立刻超时"，而且只 warning 不报错，很难查。
     * 只接受"有限且落在 setTimeout 合法区间内"的值，其余一律回退默认。 */
    const n = Number(ms);
    const limit = (Number.isFinite(n) && n > 0 && n <= 0x7fffffff) ? n : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error(timeoutMsg || '识别超时');
        /* 【code 要让调用方能分辨"超时"与"引擎报错"】
         * 用 Object.assign 而不是直接 `err.code = ...`：tsc 的 checkJs 会把
         * Error 的实例类型收得很死，赋一个自定义属性会报 TS2339。
         * 这样写既保留运行期行为，也过得了类型检查。 */
        Object.assign(err, { code: 'OCR_TIMEOUT' });
        reject(err);
      }, limit);
      /* 【两条分支都要判 settled 并 clearTimeout】
       * 不 clearTimeout 的话，正常成功的那次也会在 60 秒后触发定时器回调
       * （虽然 settled 为 true 所以不会误 reject，但定时器本身会拖住
       * 事件循环、也让测试的进程晚退）。 */
      Promise.resolve(p).then(
        (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
        (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); }
      );
    });
  }

  /**
   * 把原始错误归因成一句用户能看懂、且**能据此行动**的话。
   *
   * @param {any} e
   * @returns {string}
   */
  function failReason(e) {
    if (!e) return '识别失败（原因未知）';
    if (e.code === 'OCR_TIMEOUT') {
      /* 超时最常见的两种成因，都给出可操作的下一步。
       * 不写"请重试"—— 重试多半还是一样；要让他知道该改什么。 */
      return '识别超时，引擎没有响应。可能是语言包下载被拦截，或程序文件缺失；'
        + '请检查网络（首次识别需联网下载约 10MB 语言包），或重启应用后再试';
    }
    const msg = String(e.message || e);
    /* WebAssembly 被 CSP 拒：这是配置问题，不是用户的问题，
     * 说清楚"哪个开关没开"比甩一句英文报错有用。 */
    if (/WebAssembly|wasm|Compiling or instantiating/i.test(msg)) {
      return 'OCR 引擎初始化失败：WebAssembly 被安全策略阻止。'
        + '这是程序配置问题，请更新到最新版本';
    }
    /* 语言包相关：网络/安全软件是最常见的两种。 */
    if (/lang|traineddata|download|fetch|network|Failed to fetch/i.test(msg)) {
      return '语言包下载失败。首次识别需联网下载约 10MB 语言包，'
        + '请检查网络或安全软件是否拦截；下载成功后之后可离线使用';
    }
    if (/worker/i.test(msg)) {
      return 'OCR 后台线程启动失败（' + msg + '）。可能被安全软件拦截，请重启应用';
    }
    return msg;
  }

  return { withTimeout, failReason, DEFAULT_TIMEOUT_MS };
});
