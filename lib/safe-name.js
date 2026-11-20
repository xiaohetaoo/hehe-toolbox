'use strict';
/* 从 URL / 标题推导**安全文件名**的纯函数（渲染层与 Node 测试共用）。
 *
 * ============ 为什么搬到 lib/ ============
 * 原实现内联在 js/tools/net-tools.js 的 render 作用域里，于是测试只能
 * 「从源码里切出函数体再 new Function 求值」——那种做法极度脆弱：
 * 剥注释后花括号位置变化、CI 与本地换行差异，都会让切出来的代码不完整，
 * 表现为 `ReferenceError: xxx is not defined`（本仓库 v0.9.2 的 CI
 * 就这么红过一次）。判据本身是纯字符串处理，没有任何理由留在渲染层。
 *
 * 搬到 lib/ 之后：渲染层用 <script> 引入拿 window.SafeName，
 * Node 侧 require 拿同一个对象，测试断言的是**真实调用的那份实现**。
 *
 * 写法与 lib/exif.js / lib/pinyin.js / lib/fail-text.js 一致（双独立 if 挂载）。
 */
(function () {
  /* Windows 保留设备名。与 lib/path-guard.js 的 checkFileName 同一套规则。 */
  const BAD_NAME_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const MAX_LEN = 180;

  /**
   * 从 URL 推出安全的保存文件名。
   *
   * 【必须挡住 %2F..%2F】decodeURIComponent 会把 %2F 还原成 /，
   * 直接把结果拼到 userData 后面就逃出目录（历史缺陷：
   * `.../a%2F..%2F..%2FWindows%2Fwin.ini` 能写到 C:\Windows 附近）。
   * 所以解码后只取最后一段。
   *
   * 【点开头的名字要保留】早期实现无条件 `.replace(/^\.+/, '')`，
   * 把 `.bashrc` / `.gitignore` / `.env` 剥成 `bashrc` / `gitignore` / `env`
   * ——下载下来的隐藏配置文件当场改名。现在只剥「纯点」（`.` / `..` / `...`），
   * 正常的点开头名保留；尾部的点与空格仍要剥（Windows 不允许，会被静默吞掉）。
   *
   * @param {string} url
   * @returns {string} 安全的单段文件名，无法推导时回退 'download.bin'
   */
  function fromUrl(url) {
    let raw = '';
    try {
      raw = decodeURIComponent(String(url).split('?')[0].split('#')[0].split('/').pop() || '');
    } catch (e) {
      /* 非法百分号编码（如 %zz）会让 decodeURIComponent 抛，
       * 此时退回「不解码」的原始末段，比直接给 download.bin 更接近用户预期。 */
      raw = String(url).split('?')[0].split('#')[0].split('/').pop() || '';
    }
    // 只保留最后一段（挡掉解码后出现的 / 和 \）
    raw = raw.split(/[\\/]/).pop() || '';
    // 去掉控制字符与 Windows 非法字符，剥尾部点与空格
    raw = raw.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/[. ]+$/, '');
    // 纯点（. / .. / ...）没有实际文件名，回退默认名
    if (!raw || /^\.+$/.test(raw)) return 'download.bin';
    if (BAD_NAME_BASE.test(raw.split('.')[0])) raw = '_' + raw;
    if (raw.length > MAX_LEN) {
      const dot = raw.lastIndexOf('.');
      const ext = dot > 0 ? raw.slice(dot) : '';
      raw = raw.slice(0, MAX_LEN - ext.length) + ext;
    }
    return raw;
  }

  /**
   * 把用户输入的标题净化成可用的笔记文件名（不含扩展名）。
   * 空标题回退「未命名」，保留设备名加前缀。
   * @param {string} raw
   * @param {string} [ext] 扩展名（含点），默认 '.md'
   * @returns {string}
   */
  function fromTitle(raw, ext) {
    const suffix = ext == null ? '.md' : String(ext);
    let s = String(raw == null ? '' : raw).trim() || '未命名';
    s = s.replace(/[\x00-\x1f\\/:*?"<>|]/g, '_');
    s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');
    if (!s) s = '未命名';
    if (BAD_NAME_BASE.test(s.split('.')[0])) s = '_' + s;
    const max = 120 - suffix.length;
    if (s.length > max) s = s.slice(0, max);
    return s + suffix;
  }

  const api = { fromUrl, fromTitle, BAD_NAME_BASE, MAX_LEN };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  const root = typeof window !== 'undefined' ? window
    : (typeof globalThis !== 'undefined' ? globalThis : null);
  if (root) root.SafeName = api;
})();
