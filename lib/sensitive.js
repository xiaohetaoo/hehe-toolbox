/* 敏感内容识别：判断一条剪贴板文本像不像凭据。
 *
 * ============ 这个文件为什么存在 ============
 * 剪贴板历史会把用户复制的密码、密钥、身份证号一并存进一个明文的
 * hehe-data.json，而且默认永不清理。这是真实风险，不是"可能有点不安全"。
 *
 * 但如果把判据写在 js/tools/security.js 里（那是浏览器脚本），
 * 就只能靠真机 E2E 测它 —— 而 E2E 在 CI 无 electron.exe 时会 SKIP，
 * 等于这条判据没有守卫。抽成纯函数后可以在 Node 里直接跑，用例能覆盖
 * 「哪些该判敏感 / 哪些绝不该」两边。
 *
 * ============ 判据的根本取舍：宁可漏判，不可错判 ============
 * 漏判的后果：一条敏感内容多留一会儿，用户自己也可能已经清掉；
 * 错判的后果：**用户正常的内容被自动删了** —— 那是数据丢失，无法挽回。
 * 所以每条规则都要求相当明确的**形态特征**，不靠"含 password 这个词"、
 * "长度像密码"这类弱信号。
 *
 * 具体来说，下面这些**不算**敏感（刻意不判）：
 *   · 含 "password" 字样的说明文字（"请重置你的 password"）
 *   · 8~11 位的普通字母数字串（可能是订单号、文件名）
 *   · 常见的中文姓名 + 手机号（用户自己的工作资料，不是凭据）
 *
 * ============ 为什么强密码规则限定 12~64 位且四类字符齐 ============
 * 短密码（8 位）与订单号、验证码、文件名大量重叠，判进去就是大面积误删。
 * 12 位以上且同时含大小写+数字+符号，才基本可以确定"这是密码"
 * （也可能是随机的 ID，但那种情况用户通常不会从密码框复制）。
 */
(function (root, api) {
  'use strict';
  'use strict';

  /* 【每条都要能说清"它为什么是凭据"】
   * 加规则前先问：正常的用户内容会不会长得像这样？
   * 会 → 不写；只有"几乎只可能是凭据"的形态才进来。 */
  const PATTERNS = [
    /* PEM 私钥块：出现这几个字就是私钥，没有歧义 */
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'PEM 私钥' },
    /* GitHub token：前缀是最强的判据 */
    { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, why: 'GitHub 令牌' },
    /* OpenAI 风格：sk- 后跟 20+ 位 */
    { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, why: 'API 密钥' },
    /* AWS Access Key ID：AKIA + 16 位大写字母数字，形态固定 */
    { re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS 访问密钥' },
    /* JWT：三段 base64url，前两段至少 10 位。比 clip-analyze 的判定宽松些，
     * 因为这里的目标是"宁可多清"，但仍要求三段完整形态。 */
    { re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, why: 'JWT 令牌' },
    /* 18 位身份证（末位可为 X） */
    { re: /(?:^|[^\d])\d{17}[\dXx](?:[^\d]|$)/, why: '身份证号' },
    /* 16 位银行卡。要求**整段就是**这 16 位，不能出现在长数字串里
     * （否则 20 位订单号会被切一段出来命中）。 */
    { re: /^\s*\d{16}\s*$/, why: '银行卡号' },
    /* 强密码形态：12~64 位、单行、四类字符齐。
     * 【为什么是 ^...$ 整段匹配】密码是"整段就是一个值"，
     * 长文档里恰好有一句满足四类字符的英文句子也不该判敏感。 */
    { re: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{12,64}$/, why: '强密码' },
    /* 长 base64 串：40 位以上、整段只有 base64 字符。密钥常见形态。 */
    { re: /^\s*[A-Za-z0-9+/]{40,}={0,2}\s*$/, why: 'base64 密钥串' },
  ];

  /** 超过这个长度就不当凭据：那是正文，不是单值。 */
  const MAX_LEN = 4096;

  /**
   * 判断一段文本是否像凭据。
   *
   * @param {string} text
   * @returns {{sensitive: boolean, why: string|null}}
   *   返回理由而不只是布尔：界面上可以显示"因为像 GitHub 令牌"，
   *   用户看到解释才不会觉得是随机乱删。
   */
  function inspect(text) {
    const s = String(text == null ? '' : text);
    if (!s.trim()) return { sensitive: false, why: null };
    if (s.length > MAX_LEN) return { sensitive: false, why: null };
    for (const p of PATTERNS) {
      try {
        if (p.re.test(s)) return { sensitive: true, why: p.why };
      } catch (e) { /* 单条规则异常不能影响其它规则 */ }
    }
    return { sensitive: false, why: null };
  }

  /** 兼容简写：只要布尔。 */
  function isSensitive(text) { return inspect(text).sensitive; }

  /**
   * 从一段历史里挑出该过期的条目。
   *
   * @param {Array} list 历史条目
   * @param {{ttlMinutes:number, now?:number}} opts
   * @returns {{keep:Array, drop:Array}}
   *
   * 【置顶的永不删】用户主动置顶 = 明确表示"我要留着"，
   * 自动清理必须尊重这个意图，否则那个置顶按钮就失去意义了。
   */
  function pickExpired(list, opts) {
    /* 【显式标注 o 的类型】tsc 的 checkJs 会把 `opts || {}` 推成 {}，
     * 于是 o.ttlMinutes / o.now 全部报「属性不存在」。
     * 加这一行 @type 注释即可，不用把文件改成 TS。 */
    /** @type {{ttlMinutes?: number, now?: number}} */
    const o = opts || {};
    const ttlMin = Number(o.ttlMinutes) || 0;
    const now = o.now || Date.now();
    const keep = [];
    const drop = [];
    const arr = Array.isArray(list) ? list : [];
    if (ttlMin <= 0) return { keep: arr.slice(), drop: [] };
    const ttlMs = ttlMin * 60 * 1000;
    for (const it of arr) {
      if (!it || it.type !== 'text' || it.pinned) { keep.push(it); continue; }
      if (!isSensitive(it.content)) { keep.push(it); continue; }
      /* 时间缺失的条目按"刚复制"处理，不删 —— 宁可留也不误删。 */
      const t = Number(it.time) || now;
      if (now - t > ttlMs) drop.push(it);
      else keep.push(it);
    }
    return { keep, drop };
  }

  const API = { inspect, isSensitive, pickExpired, PATTERNS };
  /* UMD 形态照 lib/exif.js：root 作为**参数**传进来，不直接写 window.X。
   * 直接写会让 tsc 报 Property 'X' does not exist on type 'Window'。 */
  if (typeof module === 'object' && module.exports) module.exports = API;
  if (root) root.Sensitive = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
