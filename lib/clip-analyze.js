/* 剪贴板内容分析 + 动作建议。
 *
 * ============ 这个文件解决什么 ============
 * 用户复制了东西之后想「对它做点什么」，但 103 个工具里没有入口告诉他
 * 「你复制的是个 base64 图片，可以用这个工具解码」。他得先想清楚
 * 「这算哪一类」，再去翻工具列表。
 *
 * 这里把「内容 → 类型 → 建议动作」这条推理抽成纯函数：
 *   · 输入是一段文本（或标记为图片），输出是类型判定 + 动作列表；
 *   · 不含任何 UI，可以在 Node 里直接单测；
 *   · 面板层（js/clip-actions.js）只负责把结果画出来。
 *
 * ============ 判定的优先级为什么这么排 ============
 * 同一段文本可能同时"像"好几种东西，比如
 *   "2024-01-01T00:00:00Z"   既是时间戳，也像普通文本
 *   "{\"a\":1}"               既是 JSON，也可能是任意代码片段
 *   "aGVsbG8="                既是 base64，也可能是普通单词
 * 所以按**特异性从高到低**判，一旦命中就停：
 *   1. 图片（调用方已标明）
 *   2. 文件路径 / 文件 URL（出现就是明确的、用户意图最具体）
 *   3. 网址
 *   4. JSON（能被 JSON.parse 且以 { 或 [ 开头 —— 首字符判据能挡掉
 *      纯数字 "123" 这种被 JSON.parse 吃掉的误判）
 *   5. Base64 图片（必须以 data:image 或能解码出 PNG/JPEG 魔数）
 *   6. 哈希值（固定长度 + 全十六进制）
 *   7. JWT（三段用点分隔，前两段是 base64url）
 *   8. 颜色值
 *   9. 时间戳（10 位秒 / 13 位毫秒，且落在合理年份区间）
 *  10. 乱码（含大量替换字符或非常见编码特征）
 *  11. 纯文本（兜底）
 *
 * 【为什么不用正则堆一个巨型判断】
 * 巨型正则既读不懂也改不动，而且各类型的「边界条件」完全不同
 * （JSON 要看能不能 parse、Base64 要看解码后的魔数）。
 * 拆成小函数，每个只管一件事，坏了好定位。
 */
(function (root, api) {
  'use strict';
  'use strict';

  /* ---- 小工具 ---- */

  /* 【base64 解码必须双环境兼容】
   * 这个文件在**两处**运行：
   *   · 渲染层（浏览器环境）—— 有 atob，没有 Buffer；
   *   · Node（单测）—— 有 Buffer，没有 atob。
   * 直接写 atob(...) 在 Node 里会 ReferenceError，写 Buffer.from 在渲染层
   * 会 undefined（该项目不开 nodeIntegration）。所以统一走这个包装。
   * 这也是 lib/ 下模块的通用约定：不许假设自己跑在哪一侧。 */
  function b64Decode(s, enc) {
    const str = String(s == null ? '' : s);
    /* 【必须通过 globalThis 取 atob，不能裸写】
     * 这个文件被 eslint 归到 lib/** 那一组（node + 浏览器共用），
     * 那组的 globals 里没有 atob —— 裸写会判 no-undef。
     * 但运行时在渲染层确实有 atob，所以走 globalThis 间接取：
     * 既让 lint 通过，又不假设自己只跑在 Node 里。 */
    const g = (typeof globalThis !== 'undefined') ? globalThis : {};
    if (typeof g.atob === 'function') {
      const bin = g.atob(str);
      /* 渲染层要的是"二进制字符串"（charCodeAt 检查魔数）或 UTF-8 文本
       * （解析 JWT header）。两种都要支持，靠 enc 区分。 */
      if (!enc) return bin;
      try {
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder(enc).decode(bytes);
      } catch (e) { return bin; }
    }
    if (typeof Buffer !== 'undefined') return Buffer.from(str, 'base64').toString(enc || 'binary');
    return '';
  }

  /** 是否全为十六进制字符（大小写均可）。 */
  function isHex(s) { return /^[0-9a-fA-F]+$/.test(s); }

  /** 去掉首尾空白后是否像是"单行参数"（不是一大段正文）。 */
  function isSingleLine(s, maxLen) {
    if (s.length > (maxLen || 4096)) return false;
    return s.indexOf('\n') < 0 && s.indexOf('\r') < 0;
  }

  /* 常见哈希长度 → 算法名。长度是唯一的判据（十六进制内容本身没有特征）。 */
  const HASH_LEN = { 32: 'MD5', 40: 'SHA-1', 56: 'SHA-224', 64: 'SHA-256', 96: 'SHA-384', 128: 'SHA-512' };

  /** 找出文本里"整段就是一个哈希"的情况。 */
  function detectHash(s) {
    const t = s.trim();
    if (!HASH_LEN[t.length]) return null;
    if (!isHex(t)) return null;
    return { algo: HASH_LEN[t.length], value: t.toLowerCase() };
  }

  /** 判断 Windows 或 POSIX 绝对路径。 */
  function detectPath(s) {
    const t = s.trim();
    if (!isSingleLine(t, 512)) return null;
    // Windows 盘符绝对路径：C:\... 或 C:/...
    if (/^[A-Za-z]:[\\/][^\0]*$/.test(t)) return t;
    // UNC：\\server\share
    if (/^\\\\[^\\]+\\[^\\]+/.test(t)) return t;
    // POSIX 绝对路径（含 mac）。要求至少两段，避免把 "/" "/a" 当路径。
    if (/^\/[^\0]*\/[^\0]+$/.test(t)) return t;
    return null;
  }

  /** 网址（http/https/ftp）。刻意不含 file://，那是路径不是网址。 */
  function detectUrl(s) {
    const t = s.trim();
    if (!isSingleLine(t, 2048)) return null;
    if (/^(https?|ftp):\/\/[^\s]+$/i.test(t)) return t;
    return null;
  }

  /** JSON：必须能被解析，且首字符是 { 或 [。 */
  function detectJson(s) {
    const t = s.trim();
    if (!t) return null;
    const c = t[0];
    if (c !== '{' && c !== '[') return null;
    /* 【长度上限：超大 JSON 会让面板卡】解析是同步的，
     * 几 MB 的 JSON.parse 会阻塞渲染进程。超过 2MB 就不做 JSON 判定，
     * 退回"文本"类型（格式化工具本身还能处理，只是不在面板里推荐）。 */
    if (t.length > 2 * 1024 * 1024) return null;
    try {
      const v = JSON.parse(t);
      return { kind: Array.isArray(v) ? 'array' : 'object', len: Array.isArray(v) ? v.length : Object.keys(v).length };
    } catch (e) { return null; }
  }

  /** Base64 图片：data URL，或纯 base64 且解码后是 PNG/JPEG/GIF/BMP/WEBP。 */
  function detectBase64Image(s) {
    const t = s.trim();
    if (/^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,/i.test(t)) {
      return { form: 'dataurl', mime: (t.match(/^data:image\/([a-z]+)/i) || [])[1] || 'png' };
    }
    /* 纯 base64：先做粗略合法性 + 长度检查，再解码看魔数。
     * 【必须看魔数，不能只看"能解开"】"hello" 这类短词也能是合法 base64，
     * 但它解出来是乱码，不是图片 —— 那种误判会让面板推荐「转成图片」。 */
    if (t.length < 20 || t.length > 40 * 1024 * 1024) return null;
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(t)) return null;
    try {
      const bin = b64Decode(t.replace(/\s/g, ''));
      const b0 = bin.charCodeAt(0), b1 = bin.charCodeAt(1), b2 = bin.charCodeAt(2), b3 = bin.charCodeAt(3);
      // PNG: 89 50 4E 47
      if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return { form: 'raw', mime: 'png' };
      // JPEG: FF D8 FF
      if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return { form: 'raw', mime: 'jpeg' };
      // GIF: GIF8
      if (bin.slice(0, 4) === 'GIF8') return { form: 'raw', mime: 'gif' };
      // BMP: BM
      if (b0 === 0x42 && b1 === 0x4d) return { form: 'raw', mime: 'bmp' };
      // WEBP: RIFF....WEBP
      if (bin.slice(0, 4) === 'RIFF' && bin.slice(8, 12) === 'WEBP') return { form: 'raw', mime: 'webp' };
      return null;
    } catch (e) { return null; }
  }

  /** JWT：三段，前两段 base64url。 */
  function detectJwt(s) {
    const t = s.trim();
    if (!isSingleLine(t, 8192)) return null;
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/.exec(t);
    if (!m) return null;
    /* 还要验证头是不是 JSON —— 否则 "a.b.c" 这种普通文本会被误判。
     * 解不出 header 就不认。 */
    try {
      const pad = m[1] + '='.repeat((4 - m[1].length % 4) % 4);
      const json = JSON.parse(b64Decode(pad.replace(/-/g, '+').replace(/_/g, '/'), 'utf8'));
      if (!json || typeof json !== 'object' || !json.alg) return null;
      return { header: json };
    } catch (e) { return null; }
  }

  /** 颜色：#RGB / #RRGGBB / #RRGGBBAA / rgb(...) / rgba(...)。 */
  function detectColor(s) {
    const t = s.trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)) return { form: 'hex', value: t };
    const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(t);
    if (m) return { form: 'rgb', r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    return null;
  }

  /** 时间戳：10 位（秒）或 13 位（毫秒），且落在 2000-01-01 ~ 2100-01-01。 */
  function detectTimestamp(s) {
    const t = s.trim();
    if (!/^\d{10}$/.test(t) && !/^\d{13}$/.test(t)) return null;
    const n = Number(t);
    const ms = t.length === 10 ? n * 1000 : n;
    const MIN = 946684800000;    // 2000-01-01
    const MAX = 4102444800000;   // 2100-01-01
    if (ms < MIN || ms > MAX) return null;
    return { unit: t.length === 10 ? 's' : 'ms', ms };
  }

  /** 乱码特征：替换字符 U+FFFD，或大量高位 Latin-1 与常见 CJK 混排。 */
  function detectMojibake(s) {
    if (!s) return null;
    const t = s.slice(0, 4000);
    let bad = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c === 0xFFFD) bad++;
      // Latin-1 补充区（0x80-0xFF）在中文文本里几乎不该成片出现
      else if (c >= 0x80 && c <= 0xFF) bad++;
    }
    const ratio = bad / Math.max(1, t.length);
    /* 【阈值 0.25 的来由】正常中英混排的"坏字符"比例接近 0；
     * 典型乱码（UTF-8 被按 Latin-1 解）这个比例在 0.5 以上。
     * 0.25 留足余量，既能抓到，又不会把正常的多语言文本判进去。 */
    return ratio > 0.25 ? { ratio: Math.round(ratio * 100) } : null;
  }

  /* ---- 动作表 ----
   * 每个动作：{ id, label, icon, tool }（tool 为空表示面板自己处理）。
   * 【为什么动作和类型分开定义】同一类内容可能给多个动作，
   * 而多个类型可能共用同一个动作（比如"作为文本打开"对谁都适用）。 */
  const ACTIONS = {
    // 图片
    imgAnnotate: { id: 'imgAnnotate', label: '截图标注', icon: 'pencil', tool: 'snip-tool', needImage: true },
    imgPin:      { id: 'imgPin', label: '贴图置顶', icon: 'pin', tool: null, needImage: true },
    imgOcr:      { id: 'imgOcr', label: '识别文字', icon: 'type', tool: 'screenshot-ocr', needImage: true },
    imgSave:     { id: 'imgSave', label: '保存为文件', icon: 'save', tool: null, needImage: true },
    imgCompress: { id: 'imgCompress', label: '图片压缩', icon: 'image', tool: 'img-compress', needImage: true },
    // 网址
    urlOpen:     { id: 'urlOpen', label: '在浏览器打开', icon: 'external', tool: null },
    urlPing:     { id: 'urlPing', label: 'Ping 测试', icon: 'activity', tool: 'ping-test' },
    urlDownload: { id: 'urlDownload', label: '下载文件', icon: 'download', tool: 'downloader' },
    // 路径
    pathReveal:  { id: 'pathReveal', label: '在资源管理器打开', icon: 'folder', tool: null },
    pathHash:    { id: 'pathHash', label: '计算哈希', icon: 'hash', tool: 'hash-tool' },
    pathUnlock:  { id: 'pathUnlock', label: '占用解锁', icon: 'unlock', tool: 'file-unlock' },
    pathProps:   { id: 'pathProps', label: '查看属性', icon: 'info', tool: null },
    // 文本 / 数据
    txtJson:     { id: 'txtJson', label: 'JSON 格式化', icon: 'code', tool: 'json-format' },
    txtBase64:   { id: 'txtBase64', label: 'Base64 解码', icon: 'code', tool: 'base64' },
    txtMojibake: { id: 'txtMojibake', label: '乱码修复', icon: 'wand', tool: 'mojibake-fix' },
    txtStats:    { id: 'txtStats', label: '文本统计', icon: 'list', tool: 'text-stats' },
    txtRegex:    { id: 'txtRegex', label: '正则测试', icon: 'regex', tool: 'regex-test' },
    txtDiff:     { id: 'txtDiff', label: '文档对比', icon: 'branch', tool: 'diff-tool' },
    txtDiff3:    { id: 'txtDiff3', label: '三栏对比', icon: 'table', tool: 'diff3' },
    txtTranslate:{ id: 'txtTranslate', label: '翻译', icon: 'languages', tool: 'translate' },
    hashNone:    { id: 'hashNone', label: '哈希校验', icon: 'hash', tool: 'hash-tool' },
    tsConvert:   { id: 'tsConvert', label: '时间戳转换', icon: 'clock', tool: 'timestamp' },
    colorConvert:{ id: 'colorConvert', label: '颜色转换', icon: 'droplet', tool: 'color-convert' },
    jwtDecode:   { id: 'jwtDecode', label: 'Base64 解码（看载荷）', icon: 'key', tool: 'base64' },
  };

  /* ---- 主判定 ---- */
  /**
   * 分析一段剪贴板内容。
   *
   * @param {{text?: string, isImage?: boolean, imageSize?: {w:number,h:number}}} input
   * @returns {{kind: string, label: string, detail: string, actions: string[], raw?: any}}
   *   kind  —— image / path / url / json / base64image / hash / jwt / color / timestamp / mojibake / text
   *   actions —— ACTIONS 的 id 列表，第一个是最推荐的
   */
  function analyze(input) {
    const inp = input || {};

    /* ① 图片：调用方已确认剪贴板里有图 */
    if (inp.isImage) {
      const sz = inp.imageSize ? ('（' + inp.imageSize.w + ' × ' + inp.imageSize.h + '）') : '';
      return {
        kind: 'image', label: '图片' + sz, detail: '剪贴板里的图片',
        actions: ['imgAnnotate', 'imgPin', 'imgOcr', 'imgSave', 'imgCompress'],
      };
    }

    const text = String(inp.text == null ? '' : inp.text);
    if (!text.trim()) {
      return { kind: 'empty', label: '空', detail: '剪贴板里没有可识别的内容', actions: [] };
    }

    /* ② 路径 —— 最具体，先判 */
    const path = detectPath(text);
    if (path) {
      return {
        kind: 'path', label: '文件路径', detail: path.slice(0, 120),
        actions: ['pathReveal', 'pathHash', 'pathUnlock', 'pathProps'],
        raw: { path },
      };
    }

    /* ③ 网址 */
    const url = detectUrl(text);
    if (url) {
      return {
        kind: 'url', label: '网址', detail: url.slice(0, 120),
        actions: ['urlOpen', 'urlPing', 'urlDownload'],
        raw: { url },
      };
    }

    /* ④ JSON */
    const json = detectJson(text);
    if (json) {
      return {
        kind: 'json',
        label: json.kind === 'array' ? ('JSON 数组（' + json.len + ' 项）') : ('JSON 对象（' + json.len + ' 个键）'),
        detail: text.trim().slice(0, 100).replace(/\s+/g, ' '),
        actions: ['txtJson', 'txtDiff', 'txtStats'],
        raw: json,
      };
    }

    /* ⑤ Base64 图片 */
    const b64 = detectBase64Image(text);
    if (b64) {
      return {
        kind: 'base64image', label: 'Base64 图片（' + b64.mime + '）', detail: text.trim().slice(0, 80) + '…',
        actions: ['imgSave', 'imgAnnotate', 'imgOcr', 'imgCompress'],
        raw: b64,
      };
    }

    /* ⑥ 哈希 */
    const hash = detectHash(text);
    if (hash) {
      return {
        kind: 'hash', label: hash.algo + ' 哈希', detail: hash.value,
        actions: ['hashNone'],
        raw: hash,
      };
    }

    /* ⑦ JWT */
    const jwt = detectJwt(text);
    if (jwt) {
      return {
        kind: 'jwt', label: 'JWT 令牌', detail: '算法 ' + (jwt.header.alg || '?'),
        actions: ['jwtDecode'],
        raw: jwt,
      };
    }

    /* ⑧ 颜色 */
    const color = detectColor(text);
    if (color) {
      return {
        kind: 'color', label: '颜色值', detail: text.trim(),
        actions: ['colorConvert'],
        raw: color,
      };
    }

    /* ⑨ 时间戳 */
    const ts = detectTimestamp(text);
    if (ts) {
      let when = '';
      try { when = new Date(ts.ms).toLocaleString(); } catch (e) {}
      return {
        kind: 'timestamp', label: '时间戳（' + ts.unit + '）', detail: when,
        actions: ['tsConvert'],
        raw: ts,
      };
    }

    /* ⑩ 乱码 */
    const bad = detectMojibake(text);
    if (bad) {
      return {
        kind: 'mojibake', label: '疑似乱码（' + bad.ratio + '% 异常字符）', detail: text.slice(0, 100),
        actions: ['txtMojibake', 'txtStats'],
        raw: bad,
      };
    }

    /* ⑪ 纯文本兜底 */
    const lines = text.split(/\r?\n/).length;
    return {
      kind: 'text',
      label: '文本（' + text.length + ' 字符 · ' + lines + ' 行）',
      detail: text.slice(0, 120).replace(/\s+/g, ' '),
      actions: ['txtStats', 'txtRegex', 'txtDiff', 'txtDiff3', 'txtTranslate'],
      raw: { len: text.length, lines },
    };
  }

  /* UMD 形态照 lib/exif.js：把 root 作为**参数**传进来，而不是直接写
   * window.X —— 后者会让 tsc 报 Property 'X' does not exist on type 'Window'，
   * 这是项目里已定好的写法（见 lib/exif.js 末尾那段说明）。 */
  const API = { analyze, detectHash, detectPath, detectUrl, detectJson, detectBase64Image, detectJwt, detectColor, detectTimestamp, detectMojibake, ACTIONS };
  /* UMD 形态照 lib/exif.js：root 作为**参数**传进来，不直接写 window.X。
   * 直接写会让 tsc 报 Property 'X' does not exist on type 'Window'。 */
  if (typeof module === 'object' && module.exports) module.exports = API;
  if (root) root.ClipAnalyze = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
