/* 拖拽路由表：扩展名 → 能处理它的工具。
 *
 * ============ 这个文件解决什么 ============
 * 103 个工具里只有 1 个支持拖拽（file-unlock）。其余工具都要
 * 「点开工具 → 点选择文件 → 翻目录 → 确认」四步。而拖拽是用户最自然的动作。
 *
 * 这个表是纯数据 + 纯函数，不含任何 UI 逻辑，因此：
 *   · 可以在 Node 里单测（不需要 Electron）；
 *   · 拖拽层、剪贴板动作层可以共用同一份判定，不会两处漂移。
 *
 * ============ 【歧义必须交给用户，不许猜】 ============
 * 同一个扩展名往往对应多个工具，而且用户意图不同：
 *   .json  → JSON 格式化？CSV/JSON 互转？三栏对比？
 *   .zip   → 解压？7z 压缩包预览？压缩？
 *   .png   → 图片压缩？水印？转 PDF？OCR？EXIF？
 * 猜错的代价是「打开了错误的工具页，还得退回来重来」，比让用户点一下更差。
 * 所以规则是：
 *   · 只有 **1 个**候选工具时才直接打开；
 *   · **≥2 个**一律弹选择面板（用户已确认这个策略）。
 *
 * ============ 为什么候选要带「默认高亮」 ============
 * 即使弹面板，也该把最可能的那个排第一并预选中 —— 多数量场景下用户
 * 直接回车就能走，不用看完整列表。排序依据：
 *   ① 该工具在 registry 里的 ORDER（人工排过的优先级）；
 *   ② 同名工具优先（.md 更常是"预览"而不是"转 PDF"）。
 * 这里只给「候选顺序」，高亮由调用方按顺序取第一个。
 */
(function (root, api) {
  'use strict';
  'use strict';

  /* 【扩展名 → 工具 id 列表】
   * 顺序有意义：**第一个是默认候选**（面板里预选中、回车直达）。
   * 排序依据是"用户拿这类文件来最可能想做什么"，不是字母序。
   *
   * 只登记**真的能处理该扩展名**的工具。宁缺勿滥：
   * 列一个其实不认这个格式的工具，比不列更糟（用户拖进去发现不认，
   * 下次就不信任这个功能了）。 */
  const MAP = {
    /* ---- 图片 ---- */
    png:  ['img-compress', 'img-watermark', 'img-stitch', 'img-scramble', 'screenshot-ocr', 'exif-view', 'img2pdf', 'img-batch', 'img-dedup'],
    jpg:  ['img-compress', 'img-watermark', 'img-stitch', 'img-scramble', 'screenshot-ocr', 'exif-view', 'img2pdf', 'img-batch', 'img-dedup'],
    jpeg: ['img-compress', 'img-watermark', 'img-stitch', 'img-scramble', 'screenshot-ocr', 'exif-view', 'img2pdf', 'img-batch', 'img-dedup'],
    webp: ['img-compress', 'img-watermark', 'img2pdf', 'img-batch', 'img-dedup'],
    bmp:  ['img-compress', 'img-watermark', 'img2pdf', 'img-batch'],
    gif:  ['img-compress', 'img-stitch', 'img2pdf', 'img-batch'],
    tif:  ['img-compress', 'img2pdf'],
    tiff: ['img-compress', 'img2pdf'],
    ico:  ['img-compress', 'img2pdf'],
    svg:  ['img2pdf'],

    /* ---- 音视频 ---- */
    mp4:  ['target-size', 'av-convert', 'av-info', 'video-press', 'video-trim', 'video-frames', 'audio-cut'],
    mkv:  ['av-convert', 'av-info', 'video-press', 'video-trim', 'video-frames'],
    avi:  ['av-convert', 'av-info', 'video-press', 'video-trim', 'video-frames'],
    mov:  ['av-convert', 'av-info', 'video-press', 'video-trim', 'video-frames'],
    wmv:  ['av-convert', 'av-info', 'video-press'],
    flv:  ['av-convert', 'av-info'],
    webm: ['av-convert', 'av-info', 'video-press'],
    m4v:  ['av-convert', 'av-info', 'video-press'],
    ts:   ['av-convert', 'av-info'],
    mp3:  ['audio-cut', 'av-convert', 'av-info'],
    wav:  ['audio-cut', 'av-convert', 'av-info'],
    flac: ['audio-cut', 'av-convert', 'av-info'],
    aac:  ['audio-cut', 'av-convert', 'av-info'],
    m4a:  ['audio-cut', 'av-convert', 'av-info'],
    ogg:  ['audio-cut', 'av-convert', 'av-info'],
    wma:  ['av-convert', 'av-info'],

    /* ---- 文档 ---- */
    pdf:  ['pdf-tools', 'pdf2img', 'pdf-office-convert'],
    doc:  ['doc-preview', 'pdf-office-convert'],
    docx: ['doc-preview', 'pdf-office-convert'],
    xls:  ['doc-preview', 'pdf-office-convert'],
    xlsx: ['doc-preview', 'pdf-office-convert'],
    ppt:  ['doc-preview', 'pdf-office-convert'],
    pptx: ['doc-preview', 'pdf-office-convert'],
    odt:  ['doc-preview', 'pdf-office-convert'],
    rtf:  ['doc-preview', 'pdf-office-convert'],
    md:   ['markdown-preview', 'local-notes', 'diff-tool'],

    /* ---- 压缩包 ---- */
    zip:  ['zip-tool', 'archive-7z'],
    '7z': ['archive-7z', 'zip-tool'],
    rar:  ['archive-7z'],
    tar:  ['archive-7z'],
    gz:   ['archive-7z'],
    bz2:  ['archive-7z'],
    xz:   ['archive-7z'],

    /* ---- 文本 / 数据 ---- */
    txt:  ['text-stats', 'text-batch', 'case-convert', 'diff-tool', 'regex-test'],
    log:  ['text-stats', 'regex-test', 'diff-tool'],
    json: ['json-format', 'csv-json', 'diff3'],
    csv:  ['csv-json', 'text-stats'],
    xml:  ['json-format', 'text-stats'],
    yaml: ['json-format', 'diff-tool'],
    yml:  ['json-format', 'diff-tool'],
    html: ['text-stats', 'unicode-convert', 'html-entity'],
    htm:  ['text-stats', 'unicode-convert', 'html-entity'],
    css:  ['text-stats', 'regex-test', 'diff-tool'],
    js:   ['text-stats', 'regex-test', 'diff-tool'],
    srt:  ['text-stats', 'text-batch'],

    /* ---- 可执行 / 其他 ---- */
    exe:  ['hash-tool', 'file-unlock', 'file-crypt'],
    dll:  ['hash-tool', 'file-unlock'],
    iso:  ['hash-tool', 'file-unlock'],
    bin:  ['hash-tool', 'file-crypt'],
  };

  /* 【反向查表：工具 id → 它能接的扩展名】
   * 拖拽面板要显示「这个工具能不能处理我拖的这批文件」，
   * 剪贴板动作层也要判断「这个工具认不认这个路径」。
   * 一次性预计算，避免每次拖拽都遍历 MAP。 */
  const BY_TOOL = {};
  for (const ext of Object.keys(MAP)) {
    for (const id of MAP[ext]) {
      (BY_TOOL[id] = BY_TOOL[id] || new Set()).add(ext);
    }
  }

  /* 取扩展名。统一小写、去掉点、兼容无扩展名。
   * 【不能用 path.extname】这是渲染层，没有 node 的 path；
   * 而且 Windows 路径分隔符两种都可能出现。 */
  function extOf(p) {
    const s = String(p == null ? '' : p);
    const base = s.replace(/\\/g, '/').split('/').pop() || '';
    const i = base.lastIndexOf('.');
    if (i <= 0 || i === base.length - 1) return '';
    return base.slice(i + 1).toLowerCase();
  }

  /* 一组文件 → 候选工具。
   *
   * @param {string[]} paths 文件/目录路径（目录不参与扩展名判定）
   * @param {{isDir?: (p:string)=>boolean}} [opts]
   * @returns {{exts:string[], byExt:Record<string,string[]>, candidates:string[], ambiguous:boolean, unknown:string[]}}
   *   · candidates —— 所有可能处理这批文件的工具，按「覆盖的文件数」降序
   *   · ambiguous  —— 是否该弹选择面板（候选 > 1）
   *   · unknown    —— 没有任何工具认领的扩展名
   */
  function route(paths, opts) {
    const isDir = (opts && opts.isDir) || (() => false);
    const list = Array.isArray(paths) ? paths : [];
    /** @type {Record<string, string[]>} */
    const byExt = {};
    /** @type {string[]} */
    const unknown = [];
    const covered = new Map();   // toolId -> 覆盖的文件数
    const exts = [];

    for (const p of list) {
      if (isDir(p)) continue;
      const e = extOf(p);
      if (!e) { continue; }
      if (exts.indexOf(e) === -1) exts.push(e);
      const cands = MAP[e];
      if (!cands) { if (unknown.indexOf(e) === -1) unknown.push(e); continue; }
      byExt[e] = cands.slice();
      /* 每个文件只给每个工具计一次，避免同一工具被同批文件重复加权 */
      for (const id of cands) covered.set(id, (covered.get(id) || 0) + 1);
    }

    /* 候选排序：先按覆盖文件数降序，再按「是否是该扩展名的第一候选」降序。
     * 第二条很关键：拖一个 .png 进来时，img-compress 覆盖 1 个文件、
     * img-watermark 也覆盖 1 个 —— 光看数量分不出先后，
     * 而 MAP 里 png 的第一候选是 img-compress，它才该排第一。 */
    const firstCount = new Map();
    for (const e of exts) {
      const first = MAP[e] && MAP[e][0];
      if (first) firstCount.set(first, (firstCount.get(first) || 0) + 1);
    }
    const candidates = [...covered.keys()].sort((a, b) => {
      const d = covered.get(b) - covered.get(a);
      if (d) return d;
      const f = (firstCount.get(b) || 0) - (firstCount.get(a) || 0);
      if (f) return f;
      return String(a).localeCompare(String(b));
    });

    return {
      exts,
      byExt,
      candidates,
      ambiguous: candidates.length > 1,
      unknown,
    };
  }

  /* 某个工具能不能处理这个扩展名（剪贴板动作层用）。 */
  function canHandle(toolId, p) {
    const set = BY_TOOL[toolId];
    if (!set) return false;
    const e = extOf(p);
    return !!e && set.has(e);
  }

  /* 该工具认领的全部扩展名（设置页/文档用）。 */
  function extsOf(toolId) {
    const set = BY_TOOL[toolId];
    return set ? [...set].sort() : [];
  }

  /* 全部已登记的扩展名（启动自检/测试用）。 */
  function allExts() { return Object.keys(MAP).sort(); }

  const API = { MAP, route, extOf, canHandle, extsOf, allExts, BY_TOOL };
  /* UMD 形态照 lib/exif.js：root 作为**参数**传进来，不直接写 window.X。
   * 直接写会让 tsc 报 Property 'X' does not exist on type 'Window'。 */
  if (typeof module === 'object' && module.exports) module.exports = API;
  if (root) root.DropRoute = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
