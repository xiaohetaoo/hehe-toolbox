/* 工具页文案的双语表 + 取词函数（任务 4 选 B：开始迁移）。
 *
 * ============ 这一轮到底做了什么 ============
 * 之前的状态是「看起来支持英文，其实不支持」：界面外壳（导航、首页、设置、
 * 状态栏）完整双语，但 23 个工具模块里只有 1 个用了 T('...')，
 * 其余约 2468 条中文字面量切到 English 后原样显示。
 * 这不是 bug，是**没做完**，但对外没有任何说明 —— 用户切了英文点进工具，
 * 看到整屏中文只会认为功能坏了。
 *
 * 本轮不假装「100 个工具全翻译」。做法是：把机制建起来、迁两个小工具
 * （二维码、哈希校验）作为样板并配上测试，其余保持中文且**在设置页写清边界**。
 *
 * ============ 取词方向是反的，这是刻意的 ============
 * 调用点写的是**中文原文**：TT('qr', '保存 PNG')
 *
 *   · 中文模式 → 直接返回调用点那个字面量，**一条早退**，不做任何查表。
 *     这样「中文下零行为改动」是结构上保证的，不依赖表里中文写得对不对；
 *     表里也就不用存中文，少一半维护量。
 *   · 英文模式 → 查 TOOL_TEXT[domain][中文原文]，查不到就**回退中文**。
 *     漏翻的表现是「这一条还是中文」，而不是空白、undefined 或键名。
 *
 * 对比传统的 T('qr.save') 键名方案：键名方案要求每个调用点再想一个键名，
 * 而且中文原文和键名一旦对不上就会出现「文案改了、键没改」的静默漂移。
 * 用中文原文做键，改文案时漏改表就会立刻回退成中文（可见），不会静默错。
 *
 * ============ 新增一个工具要做什么 ============
 * 1) 在 TOOL_TEXT 里加一个域（例如 media: {...}），键是中文原文；
 * 2) 调用点写 TT('media', '开始压缩')；
 * 3) scripts/test-tool-i18n.js 会自动校验「调用点用到的每一条原文都有英文」
 *    以及「表里没有用不到的孤儿条目」—— 新增/删除靠测试兜住。
 */
(function (root) {
  'use strict';

  /* 每个域一个扁平表：中文原文 → 英文。
   * 插值用 {n} / {s} 这类占位符，与 js/i18n.js 外壳那套一致。 */
  const TOOL_TEXT = {
    qr: {
      '输入文本、网址、WiFi 信息等…': 'Enter text, a URL, Wi-Fi info, …',
      '640px（高清）': '640px (HD)',
      '容错 L': 'Level L',
      '容错 M': 'Level M',
      '容错 Q': 'Level Q',
      '容错 H': 'Level H',
      '输入内容后自动生成': 'Type something and it generates automatically',
      '保存 PNG': 'Save PNG',
      '请先生成二维码': 'Generate a QR code first',
      '已保存：{p}': 'Saved: {p}',
      '内容': 'Content',
      '尺寸': 'Size',
      '容错': 'Error correction',
      '二维码': 'QR code',
      '拖入或选择二维码图片': 'Drop a QR code image, or click to choose',
      '还没有选择图片': 'No image selected yet',
      '图片': 'Images',
      '识别结果…': 'Decoded result…',
      '识别成功': 'Decoded successfully',
      '未识别到二维码，请确保图片清晰完整':
        'No QR code found — make sure the image is clear and complete',
      '从剪贴板识别': 'Decode from clipboard',
      '剪贴板中没有图片': 'No image in the clipboard',
      '剪贴板图片': 'Clipboard image',
      '选择图片': 'Choose image',
      '识别结果': 'Result',
      '复制': 'Copy',
      '打开链接': 'Open link',
    },
    hash: {
      '文件校验': 'File',
      '文本校验': 'Text',
      '拖入文件进行校验，或点击选择': 'Drop files to hash, or click to choose',
      '还没有添加文件': 'No files added yet',
      '计算失败: {e}': 'Failed: {e}',
      '复制': 'Copy',
      '模式': 'Mode',
      '输入文本…': 'Enter text…',
    },
  };

  /**
   * 取工具页文案。
   * @param {string} domain TOOL_TEXT 里的域
   * @param {string} zh 中文原文（同时也是查表键）
   * @param {Object} [vars] 插值变量，例如 { p: path }
   * @returns {string}
   */
  function tt(domain, zh, vars) {
    const lang = (root.i18n && root.i18n.lang) || 'zh';
    /* 中文模式早退：返回调用点字面量本身。
     * 这不是优化，是「中文下零行为改动」的保证 —— 即使表里哪条中文写错了，
     * 中文界面也完全不受影响。 */
    if (lang !== 'en') return subst(zh, vars);
    const dict = TOOL_TEXT[domain];
    const en = dict && dict[zh];
    /* 漏翻回退中文：宁可看到一条中文，也不要空白/undefined/键名。 */
    return subst(en == null ? zh : en, vars);
  }

  function subst(s, vars) {
    if (!vars) return s;
    return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
  }

  /** 该域是否有这条英文（测试与未来的覆盖率统计用）。 */
  function has(domain, zh) {
    return !!(TOOL_TEXT[domain] && TOOL_TEXT[domain][zh]);
  }

  const api = { t: tt, has, TOOL_TEXT };

  /* 这是**渲染层专用**文件（放在 js/ 下、由 index.html 的 <script> 加载），
   * 所以刻意不写 CommonJS 分支 —— 写了反而会被 ESLint 报 no-undef
   * （js/ 那套环境里没有 module）。测试要跑这份真实现时用 vm 沙箱
   * （见 scripts/test-tool-i18n.js），沙箱里读 root.ToolI18n 就够了。 */
  root.ToolI18n = api;
  /* 同时挂一个全局简写：工具文件里写 TT('qr', '保存 PNG') 比
   * window.ToolI18n.t('qr', …) 短得多，而这在工具里会出现几百次。 */
  if (!root.TT) root.TT = tt;
})(typeof window !== 'undefined' ? window : globalThis);
