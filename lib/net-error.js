'use strict';
/* 网络类失败的中文归因。
 *
 * ============ 锁的是哪个回归 ============
 * 「网络信息查询」「端口连通测试」「带宽测试」「HTTP 请求」这几处的错误
 * 都是把 err.message 原样贴到界面上，而这些 message 来自 Node 的底层：
 *   fetch('http://no-such-host.invalid')  → "fetch failed"        ← 整句英文
 *   fetch('http://127.0.0.1:1')           → "fetch failed"        ← 而且看不出是"连接被拒"
 *   net.connect(...)                      → "connect ECONNREFUSED 127.0.0.1:1"
 *   net.connect(...)                      → "getaddrinfo ENOTFOUND xxx"
 * 实测三条 fetch 失败的 message 全是同一句 "fetch failed"，
 * 真正的原因在 err.cause.code 里（ENOTFOUND / ECONNREFUSED / …）。
 * 用户看到一个中文界面里冒出 "fetch failed"，既不知道是 DNS 还是端口，
 * 也不知道下一步该做什么。
 *
 * ============ 做法 ============
 * 抽一个纯函数：拿任意错误对象，返回一句中文 + 一句可操作建议。
 * 判据优先看 errno/code（跨平台稳定），文案匹配只作兜底 ——
 * 与 lib/errors.js 的 classify 同一套原则。
 *
 * 【为什么不直接复用 lib/errors.js】
 * 那个模块的职责是「把文件类失败映射成稳定错误码」（DISK_FULL / PERMISSION…），
 * 网络这几类在它那里全部归 UNKNOWN。硬塞进去会让它的分类表变成大杂烩，
 * 而它已经被 main.js 的每个失败通道依赖。网络归因只有界面用，范围小得多。
 *
 * 加载方式：index.html 里 <script src="lib/net-error.js">（排在 js/tools/ 之前），
 * 挂到 window.NetError；node 侧 require 拿到同一个对象。
 */
(function (root, factory) {
  const api = factory();
  /* 【两条独立 if，不用 else】与 lib/exif.js / lib/fail-text.js 一致 */
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    /** @type {Record<string, unknown>} */ (root).NetError = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /* 每种原因的「说明 + 建议」。说明里不重复错误码 —— 用户不认识码，
   * 认识的是"域名解析不了"和"对方没开这个端口"的区别。 */
  const REASONS = {
    ENOTFOUND: {
      text: '域名解析失败（DNS 查不到这个主机名）',
      advice: '检查主机名有没有拼错；能上网的话试试换成 IP 直连',
    },
    EAI_AGAIN: {
      text: 'DNS 暂时不可用（解析服务超时或繁忙）',
      advice: '稍等几秒重试；持续失败请检查本机 DNS 设置或 VPN',
    },
    ECONNREFUSED: {
      text: '连接被拒绝（对方端口没有服务在监听）',
      advice: '确认目标端口已开放、服务已启动；本机端口要确认程序真的在跑',
    },
    ETIMEDOUT: {
      text: '连接超时（对方没有在限定时间内响应）',
      advice: '可能是防火墙拦了或对方离线，先确认网络可达再重试',
    },
    ENETUNREACH: {
      text: '网络不可达（本机没有到该地址的路由）',
      advice: '检查是否连着网络、VPN 或代理是否正常',
    },
    EHOSTUNREACH: {
      text: '主机不可达（找不到通往该主机的路径）',
      advice: '确认目标主机在线、IP 正确，以及中间是否被防火墙阻断',
    },
    ECONNRESET: {
      text: '连接被对方重置（对端提前断开了）',
      advice: '重试一次；反复出现说明对端服务不稳定或有设备在中间干扰',
    },
    EPROTO: {
      text: '协议不匹配（常见于该用 https 却连了 http）',
      advice: '确认地址前缀与端口是否配套（443 一般是 https，80 是 http）',
    },
    CERT_HAS_EXPIRED: {
      text: '对方证书已过期',
      advice: '对方的站点证书过期了，换个地址或联系对方管理员',
    },
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: {
      text: '无法验证对方证书（自签名或证书链不全）',
      advice: '如果是内网自签证书，这类工具默认会拒绝 —— 换个可信地址试',
    },
    ERR_INVALID_URL: {
      text: '地址格式不对',
      advice: '地址要以 http:// 或 https:// 开头',
    },
    ABORT: {
      text: '请求已取消或超时',
      advice: '重试一次；如果一直超时，检查网络与目标服务',
    },
  };

  /**
   * 从任意错误里挖出最具体的 "code"。
   * 【为什么要往下挖 err.cause】fetch 失败时 message 恒为 "fetch failed"，
   * 真正的原因在 cause.code 里（实测 ENOTFOUND / ECONNREFUSED 都在这一层）。
   *
   * 【为什么不需要环检测】深度上限就是 4，`err.cause = err` 这种自环
   * 最多走 4 步就退出，不会无限递归。曾经加过一个 `seen` 集合做环检测，
   * 但变异测试证明它**永远执行不到**（把 seen 去掉，所有断言仍然通过）——
   * 一条测不到也跑不到的分支只会让人误以为"这里有防护"。
   * 真正起作用的是下面的 depth 上限，scripts/test-net-error-text.js 的 NE7
   * 把上限钉住了（把它改成 99 会立刻红）。
   * @param {any} err
   * @returns {string}
   */
  function codeOf(err) {
    if (!err) return '';
    let cur = err;
    for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
      const c = cur.code || cur.errno || '';
      if (c && typeof c === 'string' && /^[A-Z]/.test(c)) return c;
      cur = cur.cause;
    }
    return '';
  }

  /**
   * 把网络错误转成中文说明 + 建议。
   * @param {any} err 原始错误（可能是 Error / 字符串 / AbortError）
   * @returns {{ text: string, advice: string, code: string }}
   */
  function explain(err) {
    const code = codeOf(err);
    /* AbortError 的 name 不是 code，单独认一下（fetch 超时走这条） */
    if (!code && err && err.name === 'AbortError') {
      return Object.assign({ code: 'ABORT' }, REASONS.ABORT);
    }
    const hit = REASONS[code];
    if (hit) return Object.assign({ code }, hit);

    /* 【兜底不能把英文原文丢掉】认不出的失败可能是我们没列到的新情况，
     * 原文是唯一线索。但也不能整条界面都是英文 ——
     * 所以前面加一句中文定性，原文附在后面（与 lib/errors.js 的
     * "说明 + 技术详情" 分层一致）。 */
    const raw = (err && (err.message || String(err))) || '未知网络错误';
    return {
      code: code || 'UNKNOWN',
      text: '网络请求失败',
      advice: '下面这行是原始报错，可据此判断原因：' + raw,
    };
  }

  /**
   * 直接给界面用的一行文本（说明 + 建议）。
   * @param {any} err
   * @returns {string}
   */
  function text(err) {
    const r = explain(err);
    return r.text + '\n建议：' + r.advice;
  }

  return { explain, text, codeOf, REASONS };
});
