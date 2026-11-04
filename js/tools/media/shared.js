/* 多媒体工具的共享助手（原 media.js 顶部那一段，逐字搬来）。
 *
 * 【为什么必须最先加载】这些助手被多个 media 工具文件同时使用，而它们都是
 * 普通 <script>（共享全局作用域，不是 ES module）。index.html 里必须把
 * js/tools/media/shared.js 排在所有 js/tools/media/*.js **之前**，
 * 否则工具文件在定义 IIFE 那一刻解构 window.MediaShared 会拿到 undefined，
 * 表现为「打开工具页就报 loadImg is not a function」。
 * 这条顺序由 scripts/test-media-split.js 守着。
 */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  'use strict';
  const { invoke } = window.api;

  /* 图片类工具的通用筛选：拖进来的非图片直接挡掉，而不是收下后处理时报错 */
  const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'];
  const isImgPath = (p) => IMG_EXT.includes(String(p).split('.').pop().toLowerCase());
  const IMG_FILTER = { name: '图片', extensions: IMG_EXT };

  function loadImg(path, blob) {
    /* eslint-disable-next-line no-async-promise-executor -- 历史写法：async 作 Promise executor。改成非 async 会变更异常传播路径，属行为改动，本轮不动 */
    return new Promise(async (resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      if (blob) img.src = URL.createObjectURL(blob);
      else {
        try { const r = await invoke(Channels.CHANNELS.FS.READ_FILE_B64, path); img.src = 'data:image;base64,' + r.b64; }
        catch (e) { reject(e); }
      }
    });
  }
  /* 判断两个路径是否指向同一个文件。
   * 不能只做字符串归一化：用户会把输出目录填成 "D:\pics\sub\.." 这种形式，
   * 字符串层面和 "D:\pics\a.jpg" 不同，但解析后是同一个文件，
   * 于是自我覆盖保护不触发、原图被压缩结果盖掉。
   * 渲染进程没有 path 模块，这里自己实现一段 resolve：
   *   统一分隔符 -> 折叠 . 与 .. -> 盘符归一 -> 小写比较（Windows 不区分大小写）。 */
  function normAbs(p) {
    let s = String(p || '').replace(/[\\/]+/g, '/');
    const drive = (s.match(/^([a-zA-Z]:)/) || [])[1] || '';
    let rest = drive ? s.slice(drive.length) : s;
    const abs = rest.startsWith('/');
    const out = [];
    for (const seg of rest.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (out.length) out.pop(); continue; }
      out.push(seg);
    }
    const joined = (drive || (abs ? '' : '')) + '/' + out.join('/');
    return joined.replace(/\/+$/, '').toLowerCase();
  }
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：定义了但未使用（删它需同步改测试断言，留给下一轮） */
  function samePath(a, b) {
    try { return normAbs(a) === normAbs(b); } catch (e) { return false; }
  }
  /* eslint-disable-next-line no-unused-vars -- 历史遗留：定义了但未使用（删它需同步改测试断言，留给下一轮） */
  function pickPaths(multi = true) {
    return invoke(Channels.CHANNELS.DIALOG.OPEN, { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }] });
  }

  /* normAbs / samePath / pickPaths 目前没有调用方（它们挂在 lint baseline 的
   * no-unused-vars 里）。按任务 9 的口径这一轮只搬代码、不改语义，所以保留；
   * 但**不导出** —— 导出会让别的文件解构出一个 undefined 函数，
   * 看起来能用、调用时才炸，比留在原地更糟。 */
  window.MediaShared = { IMG_EXT, isImgPath, IMG_FILTER, loadImg };
})();
