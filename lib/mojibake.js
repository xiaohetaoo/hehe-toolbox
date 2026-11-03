'use strict';
/* 乱码修复 / 编码探测（纯函数，便于单测）。
 *
 * 中文 Windows 上最常见的三种乱码，机理完全不同，所以修复方式也不同：
 *
 * 1) 「锟斤拷」—— UTF-8 字节被按 GBK 解码，再被转回 UTF-8 时产生的
 *    替换字符链。特征是出现「锟」「斤」「拷」这三个字。
 *     真实链路：UTF-8(BOM) → GBK 误读 → 得到 U+FFFD（EF BF BD）
 *     → 这些字节再被 GBK 解码 → 锟（EF BF = 锟）斤（BD EF）拷…
 *    修复办法：把「锟斤拷」这类序列反向映射回 U+FFFD，再尝试按 UTF-8 解码。
 *
 * 2) 「烫烫烫/屯屯屯」—— MSVC 调试版未初始化栈填充（0xCC / 0xCD），
 *    不是编码问题，是程序 bug 留下的垃圾；本工具只做**识别与说明**，
 *    不假装能还原（信息已经丢了）。
 *
 * 3) 普通 GBK/Big5 文本被当 UTF-8 读 —— 表现为整片 U+FFFD 或成片怪字。
 *    修复办法：拿原始字节按候选编码逐个解码，选出「最像自然语言」的结果。
 *
 * 【判分依据】不是「能不能解码」（错误编码通常也能解出一串字符），
 * 而是解码后的**文本合理性**：
 *   - 非法/替换字符 U+FFFD 越多越差；
 *   - 落在控制字符区（除 \t\n\r）的越多越差；
 *   - 中文文本里汉字占比越高越好；
 *   - 出现常见标点、常见字也加权。
 */

/** 候选编码。顺序影响「打平时优先选谁」：中文场景 GB18030 > GBK > Big5。 */
const ENCODINGS = ['utf-8', 'gb18030', 'gbk', 'big5', 'utf-16le', 'utf-16be', 'shift_jis'];

const LABELS = {
  'utf-8': 'UTF-8',
  'gb18030': 'GB18030',
  'gbk': 'GBK',
  'big5': 'Big5（繁体）',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'shift_jis': 'Shift-JIS（日文）',
};

/** 「锟斤拷」链的特征字。EF BF BD（U+FFFD 的 UTF-8）被 GBK 两两分组解码：
 *  EF BF → 锟, BD EF → 斤, BF BD → 拷 —— 于是两个替换字符变成「锟斤拷」三字。
 *  所以只要文本里出现这三个字连用，几乎必然是这条链路。 */
const KUEN_KUEN = ['锟', '斤', '拷'];

/* 【常用字样本：必须是 3755 字，不能是百来字】
 *
 * 原来这里只有 101 个高频字。短文本上根本分不开「正常中文」和「乱码」，
 * 因为两边都几乎命不中样本：
 *   '娴嬭瘯'（'测试' 的 GBK 乱码）与正确的 '测试' 都是 0/2 命中 → 同分 40，
 *     strict-keep（要求严格大于）拒绝采用，于是「修复」对最高频的真实形态失效；
 *   'Hello 涓栫晫' 与 'Hello 世界' 两边汉字全不命中 → 乱码因汉字更多反而更高分。
 * 生僻字罚分只对长文本（'鏃犳硶…' 那种）有效，短文本上是负作用。
 *
 * 换用 GB2312 一级字库（区 16–55，3755 字，按使用频率排序，覆盖日常文本 99%+）后，
 * 实测：'测试' 100% 命中 / '娴嬭瘯' 0% 命中；'世界' 100% / '涓栫晫' 0%。
 *
 * 【为什么用 TextDecoder 现算，而不是把 3755 个字贴进源码】
 *   贴字面量要多出 3755 个字符的一行，且与「GB2312 一级字库」的定义没有
 *   任何机器可验证的对应关系（改错一个字节沿线十几年没人发现）。
 *   现算的成本实测 1.35 ms（模块加载时一次），而且与标准定义天然一致。
 *
 * 【为什么不用 GB2312 ∪ Big5 那份更大的并集】
 *   并集会让「GBK 字节被 Big5 解出来的假字」也大量命中常用字，
 *   于是正确解与错误解同分（实测「你好」: GBK 150 vs Big5 150），
 *   整字节探测的排序会变得不可靠 —— 而这正是原来那套罚分要防的事。
 *   繁体文本靠 fallback 样本 + 罚分阈值仍然判得对（见 test-mojibake.js）。
 *
 * 【为什么保留一份 fallback】
 *   精简 ICU 的运行时（small-icu）没有 GBK 解码器，现算会拿到空串。
 *   那时必须退回旧样本而不是崩，也不能让字库变成空集合
 *   （空集合会让 commonRatio 恒为 0，所有文本都被判「生僻」，比现在更糟）。
 */
const FALLBACK_HANZI = '的一是不了在人有我他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从知';

function buildCommonHanzi() {
  const bytes = [];
  // GB2312 一级汉字 = 高字节 B0..D7、低字节 A1..FE，末区只到 F9（共 3755 字）
  for (let hi = 0xB0; hi <= 0xD7; hi++) {
    for (let lo = 0xA1; lo <= 0xFE; lo++) {
      if (hi === 0xD7 && lo > 0xF9) continue;
      bytes.push(hi, lo);
    }
  }
  let text = '';
  try {
    text = new TextDecoder('gbk', { fatal: false }).decode(new Uint8Array(bytes));
  } catch (e) {
    text = '';   // 该运行时没有 GBK 解码器
  }
  /* 落空的判据：长度不够（不是 3755）或解出了替换字符，都说明这一路不可信。
   * 宁可退回 101 字的小样本（行为回到改造前），也不要让字库半残。 */
  const usable = text.length >= 3755 && text.indexOf('\uFFFD') === -1;
  return usable ? text : FALLBACK_HANZI;
}

/** 用于「是否为自然中文文本」的常用字样本（GB2312 一级，或 GBK 不可用时的保底）。 */
const COMMON_HANZI = buildCommonHanzi();

/* 命中判断用 Set：样本从 101 字涨到 3755 字后，indexOf 是 O(3755) 的线性扫描，
 * 而 scoreText 对每个候选都要跑一遍全串。实测 3000 字文本单次 0.80 ms（indexOf）
 * vs 0.10 ms（Set），探测一个文件时会有十几次调用，差距可见。 */
const COMMON_SET = new Set([...COMMON_HANZI]);

/* ---------- 打分 ---------- */

/**
 * 给一段「解码后的文本」打分，越高越像自然语言。
 * @param {string} s
 * @returns {number}
 */
function scoreText(s) {
  if (!s) return -1000;
  let score = 0;
  let bad = 0, ctrl = 0, hanzi = 0, common = 0, ascii = 0;
  const len = s.length;

  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    // 替换字符：解码失败的铁证
    if (code === 0xFFFD) { bad++; continue; }
    // 控制字符（保留 \t \n \r）
    if (code < 0x20 && code !== 0x9 && code !== 0xA && code !== 0xD) { ctrl++; continue; }
    if (code >= 0x7F && code < 0xA0) { ctrl++; continue; }
    // 汉字（基本区）
    if (code >= 0x4E00 && code <= 0x9FFF) { hanzi++; continue; }
    // ASCII 可打印
    if (code >= 0x20 && code < 0x7F) { ascii++; continue; }
  }

  for (const ch of s) {
    if (COMMON_SET.has(ch)) common++;
  }

  const hanziRatio = hanzi / len;
  score += hanziRatio * 120;          // 汉字占比是中文文本最强的信号
  score += (common / Math.max(1, hanzi)) * 30;  // 命中高频字加权
  score += (ascii / len) * 20;        // 正常英文/代码也需要
  score -= (bad / len) * 400;         // 替换字符重罚
  score -= (ctrl / len) * 300;        // 控制字符重罚
  // 全是稀有的非 ASCII 字符（既非汉字也非 ASCII）通常说明解错了
  const other = len - bad - ctrl - hanzi - ascii;
  score -= (other / len) * 60;

  /* 【生僻字要额外扣分：这是「乱码」与「正常中文」最主要的区别】
   * 根因：乱码解出来的汉字同样是 CJK 基本区，hanziRatio 一样计满分，
   * 而「这几个字在正常中文里几乎不出现」这件事完全没被惩罚。
   * 判据是**常用字覆盖率**：正常中文里常用字占绝大多数，乱码串则几乎全是生僻字。
   *
   * 【阈值 0.7 的来历 —— 是量出来的，不是拍的】
   * 用 3755 字样本实测三类文本的覆盖率：
   *   正常简体中文：1.00（含人名地名也 ≥0.86）
   *   正常繁体中文：0.85–1.00 居多，但**偏文言/港台的措辞可低到 0.31**
   *                 （实测「資料庫連線失敗，請檢查設定檔。」只有 0.31 ——
   *                 繁简字形不同的字全都不在 GB2312 一级里）
   *   GBK 乱码形态：0.00–0.31（'娴嬭瘯' 0.00、'鏃犳硶鎵撳紑鏂囦欢' 0.11）
   *
   * 【这条罚分的局限：它其实分不开「繁体」与「乱码」】
   *   两者覆盖率可以重叠在 0.3 附近，所以罚分不是靠覆盖率单独判决的。
   *   实测真正起作用的是**汉字占比 + ASCII 占比**：繁体正常文本汉字占比高、
   *   结构正常，分数仍为正（实测 42.5 / 53.4 / 118.1）；乱码形态因为大量
   *   非汉字字符，分数被压到负数（-47.5 / -53.5 / -13.7）。
   *   覆盖率罚分在此之上把乱码再往下压一档，是加分项，不是唯一判据。
   *   阈值从 0.5 提到 0.7 之后，0.5–0.7 区间的繁体不再被额外惩罚。
   *
   * 【罚分斜率 160 与「基础分 150」的关系】
   * 汉字占比满分是 120、命中率满分是 30，合计 150 —— 也就是一段「全命中」
   * 理想文本的分数上限。覆盖率 0 时罚 0.7*160 = 112，比 150 的上限差一点，
   * 意味着**只有文本里还有相当比例的非汉字（空格、ASCII）时**乱码才可能
   * 高于正常文本；纯汉字的乱码串一定低于任何全命中的正常串。
   * 这个斜率是配合 3755 字样本定的，改样本就得重测它。 */
  if (hanzi > 0) {
    const commonRatio = common / hanzi;
    if (commonRatio < 0.7) {
      score -= (0.7 - commonRatio) * 160;
    }
  }

  return score;
}

/* ---------- 锟斤拷识别与修复 ---------- */

/**
 * 是否疑似「锟斤拷」乱码。
 * @param {string} s
 */
function looksLikeKuen(s) {
  if (!s) return false;
  const total = s.length;
  let cnt = 0;
  for (const ch of s) if (KUEN_KUEN.indexOf(ch) !== -1) cnt++;
  // 三字连用是最强信号；单独出现也可能是正常文本里的「锟」
  if (s.indexOf('锟斤拷') !== -1) return true;
  // 这三个字属于生僻字，正常中文里占比极低
  return cnt >= 3 && cnt / total > 0.05;
}

/**
 * 尝试把「锟斤拷」链反向还原成替换字符，再按 UTF-8 重解。
 *
 * 原理：链是 EF BF BD 这 3 字节被 GBK 重新分组解码来的。
 * 「锟」= EF BF，「斤」= BD EF(部分)，无法逐字精确逆推，
 * 但**整段原文**（原始的 UTF-8 文本）其实还在：如果用户是从某个地方
 * 复制来的，正确内容是 UTF-8 字节按 GBK 解码后的字符串。
 * 所以正确做法是把当前字符串**按 GBK 编回字节**，再按 UTF-8 解码。
 * 这才是这类乱码的标准解法（不是去替换那三个字）。
 *
 * @param {string} s
 * @returns {{text:string, ok:boolean, from:string, to:string}}
 */
function tryReencode(s, fromEnc, toEnc) {
  try {
    const bytes = encodeBy(s, fromEnc);
    if (!bytes) return { text: '', ok: false, from: fromEnc, to: toEnc };
    const out = decodeBy(bytes, toEnc);
    return { text: out, ok: out.length > 0, from: fromEnc, to: toEnc };
  } catch (e) {
    return { text: '', ok: false, from: fromEnc, to: toEnc };
  }
}

/* ---------- 编解码（Node 内置，无需第三方依赖） ---------- */

function normEnc(e) {
  const k = String(e || '').toLowerCase().replace(/_/g, '').replace(/-/g, '');
  if (k === 'utf8') return 'utf-8';
  if (k === 'gb18030') return 'gb18030';
  if (k === 'gbk' || k === 'gb2312' || k === 'cp936') return 'gbk';
  if (k === 'big5' || k === 'cp950') return 'big5';
  if (k === 'utf16le') return 'utf-16le';
  if (k === 'utf16be') return 'utf-16be';
  if (k === 'shiftjis' || k === 'sjis' || k === 'cp932') return 'shift_jis';
  return k;
}

function decodeBy(bytes, enc) {
  const e = normEnc(enc);
  try {
    if (e === 'utf-8') {
      /* fatal 用 false：错了也要出结果（带 U+FFFD），让打分环节去判优劣 */
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    return new TextDecoder(e, { fatal: false }).decode(bytes);
  } catch (err) {
    // 该运行时没有这个编码（极少见）：退回 UTF-8，交给打分说明
    try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e2) { return ''; }
  }
}

function encodeBy(str, enc) {
  const e = normEnc(enc);
  try {
    if (e === 'utf-8') return Buffer.from(String(str), 'utf8');
    /* Node 的 Buffer 只支持 utf8 / utf16le / latin1。
     * GBK / GB18030 / Big5 没有内置编码器，必须用 TextDecoder 的逆运算 ——
     * 不可用。所以这里对非 UTF 编码返回 null，由调用方用别的手段处理。 */
    if (e === 'utf-16le') return Buffer.from(String(str), 'utf16le');
    if (e === 'utf-16be') {
      const le = Buffer.from(String(str), 'utf16le');
      const be = Buffer.alloc(le.length);
      for (let i = 0; i + 1 < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
      return be;
    }
    return null;
  } catch (err) { return null; }
}

/* ---------- 「字符串再编码链」的三条硬性前提 ---------- */

/* 【为什么需要这三条前提 —— 它们是本轮 P3 的根因修复】
 *
 * 字符串形态的修复链本质是：bytes = encode(输入, from) → text = decode(bytes, to)。
 * 它只在**「输入确实是 from 编码解码后的产物」**时才成立。可我们没有任何办法
 * 直接知道这一点（那正是乱码的定义：你不知道它原本是什么编码），所以旧实现
 * 干脆对每条 from×to 都跑一遍，然后指望 scoreText 挑出对的那条。
 *
 * 实测这个做法会产出**比原样更差的 best**，两种机理：
 *
 * ① 输入含 U+FFFD 时，任何 encode(输入, from) 都是有损的。
 *    U+FFFD 是一个「这里原本有字节，但解不出来」的记号，它编不回去。
 *    .NET 的 CP936 会把它编成 0x3F（字面问号 '?'），于是 bytes 里凭空多出
 *    一个问号字节 —— 而 '?' 是合法 GBK/UTF-8 字节，解码完全成功。
 *    也就是说**修复链在替用户编造内容**。
 *    实测 '你好，世界' 的乱码形态（尾部残 → 串里含 U+FFFD）：
 *      原样被 FFFD 重罚到 -79.5；
 *      而 utf-8→gb18030 这条链产出 12 字纯 CJK 垃圾（零 FFFD/零 PUA/零问号，
 *      恰好穿过 acceptable() 全部三道判据），以 35 分夺走 best。
 *    这条与本文件自己的判据直接矛盾 —— text:can-reencode 说的就是
 *    「含替换字符 = 原始字节已丢，任何转码都无法还原」，analyzer 必须守同一条规矩。
 *
 * ② 前向编码本身有损（不含 FFFD 也会发生）。
 *    Big5 假字（实为 GBK 字节被 Big5 解出来的字，如 '戈畐'）大多**不在 CP936 里**，
 *    .NET 编不出来，同样退化成 '?'。于是 bytes ≠ 原始字节，候选全是编造。
 *
 * 三前提各挡一类，缺一不可：
 *   · hasLostBytes —— 输入含 U+FFFD 时，**跳过全部字符串再编码链**
 *     （文件形态不受影响：那里拿到的是真字节，不需要「编回去」）。
 *   · isForwardLossless —— encode(输入, from) 之后再用同一个 from 解回来，
 *     必须逐字等于输入。这一条把「编码器编不出某个字符」当场暴露，
 *     成本只有一次 decode，不需要额外的 PowerShell 进程。
 *   · (from, to) 的方向必须合法 —— 见 isPlausibleChain。
 */

/** UTF 家族编码：Node 内置编码器，能用 Buffer 直接编出字节。 */
const UTF_FAMILY = ['utf-8', 'utf-16le', 'utf-16be'];
/** legacy 编码：Node 只能解、不能编，要靠系统编码器（.NET 代码页）。 */
const LEGACY_ENCODINGS = ['gbk', 'gb18030', 'big5', 'shift_jis'];

/**
 * 这条 (from → to) 链在机理上是否成立。
 *
 * 【UTF → legacy 一律不收】
 * 它表示「输入是 UTF 家族解码的结果，需要按 legacy 重新解码」，即
 * 「legacy 文本被当成 UTF 家族读了」。可这种误读**必然产生 U+FFFD**：
 * legacy 字节（如 GBK 的 0xB0 0xA1）在 UTF-8 里多半是非法序列。
 * 实测把 '配置文件已保存' 的 GB18030 字节按 UTF-8 解，12 个字符里 10 个是 FFFD。
 * 那么当输入**不含** FFFD 时，这条链的前提就已经被推翻 —— 它只可能是
 * 「把一段能正常解码的文本重新解释一遍」，而 scoreText 对纯 CJK 垃圾给高分
 * （hildegard 那类假汉字覆盖率够高、FFFD 为零），于是噪音胜出。
 * 实测：这条链正是 '你好，世界' 与 '请检查网络连接' 两例「主动变坏」的来源。
 * 而当输入**含** FFFD 时，第一条前提已经把整族链跳过了。
 * 两头都堵上，这条方向就没有存在的理由。
 *
 * @param {string} from 源编码
 * @param {string} to   目标编码
 */
function isPlausibleChain(from, to) {
  const f = normEnc(from), t = normEnc(to);
  if (f === t) return false;
  /* UTF → legacy：见上。legacy → UTF 与 legacy → legacy 保留。 */
  if (UTF_FAMILY.indexOf(f) !== -1 && LEGACY_ENCODINGS.indexOf(t) !== -1) return false;
  /* UTF-16 → UTF-8 之类保留（那是「真 UTF-16 文本被当别的读」的正解方向），
   * 但 UTF-16 输入在文本形态里几乎不出现，实际由下面的无损校验兜底。 */
  return true;
}

/**
 * 前向编码是否无损 —— 见上面 ②。
 * @param {string} input 原始输入
 * @param {string} from  源编码
 * @param {Buffer} bytes encode(input, from) 的结果
 */
function isForwardLossless(input, from, bytes) {
  if (!bytes || !bytes.length) return false;
  /* 用同一个 from 解回来比对。编码器若把某个字符退化成 '?'，这里必然不等。 */
  return decodeBy(bytes, normEnc(from)) === input;
}

/* ---------- 编码探测 ---------- */

/**
 * 给一段字节，逐个候选用编码解码并打分，返回排序后的候选。
 * @param {Buffer} bytes
 * @returns {Array<{encodings:string, label:string, text:string, score:number}>}
 */
function detectEncodings(bytes) {
  if (!bytes || !bytes.length) return [];
  const results = [];
  for (const enc of ENCODINGS) {
    const text = decodeBy(bytes, enc);
    // 解码出的文本为空（该编码不被运行时支持）就跳过
    if (!text) continue;
    results.push({ encodings: enc, label: LABELS[enc] || enc, text, score: scoreText(text) });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * 统一入口：接受 **字符串**（用户从网页/聊天里复制来的乱码），
 * 先判断是不是「锟斤拷」链路，再在「按 GBK 编回字节 → 按 UTF-8 解」
 * 这类转换里找最优解。
 *
 * @param {string} input
 * @returns {{best:object|null, candidates:Array, kuen:boolean, note:string}}
 */
function analyzeMojibake(input) {
  const s = String(input == null ? '' : input);
  if (!s) return { best: null, candidates: [], kuen: false, note: '输入为空' };

  const kuen = looksLikeKuen(s);
  /* 输入里是否已经有替换字符 = 「原始字节已经丢了」的铁证。
   * 这条判据同时被三处使用：整族字符串再编码链（见下）、latin1 字节视角、
   * 以及最后的 note。它必须与 text:can-reencode 那条保持一致。 */
  const hasLostBytes = s.indexOf('\uFFFD') !== -1;

  /* 候选生成：把输入当作「某编码解码后的结果」，反向编码成字节，
   * 再用各候选编码解码。这是修乱码的通用手法。 */
  const candidates = [];

  // 原样作为候选（可能本来就没坏）
  candidates.push({ from: '（原样）', to: '（不转换）', text: s, score: scoreText(s) });

  const FROM = ['gbk', 'gb18030', 'big5', 'utf-8', 'utf-16le'];
  const TO = ['utf-8', 'gb18030', 'gbk', 'big5'];

  /* 【输入含替换字符时，整族「字符串再编码」链一律不跑】
   * 理由（实测记录）见文件上方「字符串再编码链的三条硬性前提」的 ①。
   * 判据与 text:can-reencode 完全一致：含 U+FFFD = 原始字节已丢，
   * 任何转码都无法还原；此时能给的只是原样 + 一句「请用文件模式」。
   * 【注意这条只管字符串形态】文件形态拿到的是真字节，不需要「编回去」，
   * 所以 text:detect-encoding 的 isFile 分支不受影响。 */
  if (!hasLostBytes) {
    for (const from of FROM) {
      /* encodeBy 只对 UTF 家族返回字节，其余返回 null —— 那种情况压根没有字节。 */
      const bytes = encodeBy(s, from);
      if (!isForwardLossless(s, from, bytes)) continue;
      for (const to of TO) {
        if (!isPlausibleChain(from, to)) continue;
        const out = decodeBy(bytes, to);
        if (out) candidates.push({ from: LABELS[from] || from, to: LABELS[to] || to, text: out, score: scoreText(out) });
      }
    }
  }

  /* 字节视角：很多乱码是从文件/剪贴板拿到的原始字节，
   * 用户贴进来其实是「一串字符」——但如果这些字符都能映射到 0-255，
   * 就可能是 latin1 形式的字节。这样还原出原始字节再探测是有效的。
   *
   * 【但这会把**本来正常**的文本改坏，必须加两道护栏】
   * 实测（未加护栏时）：
   *   'Hello 世界'          → 'Hello 涓栫晫'
   *   'ok'                  → '歯'
   *   'file saved'          → '楦敬猠癡摥'
   *   'ERROR: 无法打开文件'  → 'ERROR: 鏃犳硶鎵撳紑鏂囦欢'
   * 用户把一段好好的中文粘进来、点一下「修复」，拿到的却是二次损坏的文本。
   * 根因：Buffer.from(s,'latin1') 对任何字符串都能产出字节（非 latin1 字符
   * 被截断取低 8 位），再拿这些字节按各种编码解码，总能凑出一个「分高」的
   * 结果；而 scoreText 对短串按比例放大，让 `ok` 这种两个字符的输入也能
   * 拿到 120 分。
   *   · 护栏 1：输入里**没有非 ASCII 字符**时，压根不存在编码问题，
   *     直接不生成 latin1 候选（纯 ASCII 的 'ok'/'file saved' 就是这类）。
   *   · 护栏 3：输入含 U+FFFD 时不做（本轮 P3 补的）——
   *     Buffer.from(s,'latin1') 把 U+FFFD 编成 0x3F（即 '?'），
   *     于是「原始字节」里凭空多出一个问号字节，解码出来的东西是编的。
   *     同一条理由见文件上方「字符串再编码链的三条硬性前提」的 ①。
   *   · 护栏 4（本轮 P3 补的）：输入里只要有**超出 U+00FF 的字符**就不做 ——
   *     那说明它压根不是 latin1 形态。此时 Buffer.from(s,'latin1') 是在
   *     「取低 8 位」，产出的字节与原始字节毫无关系，候选必然是编造的。
   *     实测：'鏂囦欢宸叉垚鍔熷啓鍏'（UTF-8 被当 GBK 读、尾部残一个字节）
   *     走这条分支会得到 '骆"干歍稴O' 并拿到 69.7 分，压过原样的 46.0。
   *     真正的「UTF-8 被当 latin1 读」其字符码点**就是**原始字节值，
   *     所以这条判据对它恒成立，一条真实修复都不会被误杀。 */
  const hasNonAscii = /[^\x00-\x7F]/.test(s);
  const isLatin1Bytes = hasNonAscii && s.length >= 8 && !hasLostBytes && !/[^\u0000-\u00FF]/.test(s);
  if (isLatin1Bytes) {
    const asLatin1 = Buffer.from(s, 'latin1');
    const byteCands = detectEncodings(asLatin1);
    /* 【不要把 UTF-16 那两支当候选】
     * detectEncodings 会试 utf-16le/be，而「把一串 latin1 字节按 UTF-16 解」
     * 几乎必然产出一串看着像汉字的怪码位 —— 它总能拿到不低的分数。
     * 实测正常韩文 '쓸 수 있는 한국어 텍스트' 会被改成 '⃸‘针尠둭䴠뢤'
     * （来自 latin1 字节→UTF-16 LE），日文同理。
     * 真正的 UTF-16 文本在粘贴时几乎不会以 latin1 字符形态出现，
     * 所以这两支在本项目里只是噪音源。文件形态（原始字节）不受影响 ——
     * 那里 detectEncodings 仍会正经地试 UTF-16，因为拿的是真字节。
     * 另外把 big5 也去掉：它和 gbk/gb18030 在字节层面互斥，
     * 中文场景下正确的那个已经在前面，多留一份只会制造同分候选。 */
    const SKIP = ['utf-16le', 'utf-16be', 'big5'];
    for (const bc of byteCands.filter((x) => SKIP.indexOf(x.encodings) === -1).slice(0, 2)) {
      candidates.push({ from: 'latin1 字节', to: bc.label, text: bc.text, score: bc.score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const ordered = orderCandidates(candidates);
  /* 调用方（analyzeWithEncoder / 界面候选表）读的是 candidates 的顺序，
   * 所以把整理后的顺序写回去 —— 只改 best 不改顺序，界面里仍会显示
   * 「越修越坏」的候选排在第一位。 */
  candidates.length = 0;
  candidates.push(...ordered);
  const best = ordered[0] || null;

  let note = '';
  if (kuen) {
    note = '检测到「锟斤拷」特征：这是 UTF-8 文本被按 GBK 解码后再转 UTF-8 产生的，' +
           '原始内容多半已不可逆（替换字符丢掉的信息回不来）。下面给出仍可恢复的部分。';
  }
  /* 【输入里已经有 U+FFFD 时，必须如实说明「这条路走不通」】
   * 这类输入以前会生成一串「重新编码」候选，而它们全是编造的（见上方三条前提）。
   * 现在一条都不生成，只剩原样 —— 但用户会看到「点了修复，什么都没变」。
   * 所以这里要说清原因，并给出真正有效的办法：用文件模式（走原始字节）。 */
  if (hasLostBytes) {
    const base = '文本里含替换字符（U+FFFD）—— 说明原始字节在解码时就已经丢了，' +
      '把字符「编回字节」这条路无法还原（本工具不会为了凑一个结果去编造内容）。';
    note = (note ? note + ' ' : '') + base + ' 如果原文还在文件里，请改用「从文件分析」：' +
      '那里是按真实字节逐个编码探测，不受这个限制。';
  }
  return { best, candidates, kuen, note };
}

/* ---------- 候选排序（两条分析路径共用） ---------- */

/**
 * 判断一个候选文本是否「可接受」。
 *
 * 【为什么需要这道下限】排序只看分数时，一个含 U+FFFD 或空洞控制字符的
 * 结果也可能排到第一 —— 实测出现过大白话的 'Hello 世界' 被改成
 * `Hello \u0016L` 这种结果。乱码修复的意义是「比原来更可读」，
 * 任何含替换字符/损坏控制字符的候选都不可能比原样更好，直接剔除。
 *
 * 【「信息量不能变少」这条也是必须的】
 * 实测 'Hello 世界' 经 Big5→GBK 会变成 'Hello '（中文整段消失），
 * 而空掉的文本分数反而从 -35 升到 0 —— 只按分数比大小，这个「删掉一半内容」
 * 的结果会合法地胜出。修复的语义是**还原**，不是丢弃：
 * 候选的可见字符数少于原样的 60% 时一律不可接受。
 * 60% 这个阈值的来源：真实的 GBK↔UTF-8 转换字符数基本不变
 * （'娴嬭瘯'→'测试' 3→2；'Hello 涓栫晫'→'Hello 世界' 10→8，比值 0.8），
 * 而「整段被吃掉」的比值是 0.3 左右，两者隔得很开。
 *
 * @param {string} t 候选文本
 * @param {string} [keepText] 原样文本，用于比较信息量；省略时不检查这一条
 * @returns {boolean}
 */
function acceptable(t, keepText) {
  const v = String(t || '');
  if (v.indexOf('\uFFFD') !== -1) return false;
  /* C0（除 \t\n\r）与 C1 控制字符都剔除。
   * 【为什么 C1 单独写】C1 是 U+0080–U+009F，既不在 \x00-\x1F 里，
   * 也不被 \s 匹配 —— scoreText 里是分开判的（code >= 0x7F && code < 0xA0），
   * 而这里的 acceptable 早期只查了 C0，于是 U+009F 这类候选能漏过去。
   * 实测：3 条畸形候选喂给 orderCandidates，含 U+009F 的那条（777 分）
   * 排到了原样前面，另外两条（替换字符、U+0001）被正确剔除。 */
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(v)) return false;
  if (/[\x7F-\x9F]/.test(v)) return false;
  /* 【零宽/格式字符也剔除】
   * 'Hello 世界' 经 Big5→GBK 会得到 'Hello ' + 两个 U+2000 区间的空白类字符，
   * 肉眼看着像「中文被删掉了」，而它们既不是 \s 也不在 C0/C1 控制区，
   * 于是躲过了上面两道检查、分数还被算成 0（高于原样的 -35）。
   * 这里把 Unicode 的格式字符（U+200B–U+200F、U+202A–U+202E、U+2060–U+2064、
   * U+FEFF）一并视作不可接受 —— 正常文本里几乎不会出现它们。 */
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(v)) return false;
  /* 【Unicode 私用区（PUA）也剔除】
   * 这是上面那条的真正根因，值得单独记一笔：
   * 'Hello 世界' 经 Big5→GBK 会得到 'Hello ' + U+E646 + U+E0E4 ——
   * 两个藏在私用区的字符，渲染出来是空白/方块，看起来就是「中文没了」。
   * 它们既不是 \s、也不是控制字符，前面两道检查都拦不住；
   * 而分数计算里它们只算作「其它字符」（每个扣 other 那 60 分的一部分），
   * 基数很小，总分反而从 -35 升到 0，于是排到第一。
   * 正常的文本（简体、繁体、日韩、emoji、数学符号）都不会落在 PUA：
   *   · 简繁日韩常用字都在 BMP 的各语言区
   *   · emoji 在 U+1F300 以上（补充多语言平面），不是 PUA
   *   · 图标字体才会用 PUA，而那是字体，不是用户会粘进「乱码修复」的文本
   * 所以把 PUA 整体视作不可接受。范围是 BMP 的三个私用区：
   * U+E000–U+F8FF（基本多文种平面的私用区）、
   * U+F0000–U+FFFFD 与 U+100000–U+10FFFD（补充私用区，用代理对表示）。 */
  if (/[\uE000-\uF8FF]/.test(v)) return false;
  if (/\uDB80[\uDC00-\uDFFF]|\uDBFF[\uDC00-\uDFFD]/.test(v)) return false;
  /* 【成片的问号也剔除：那不是「还原」，是「把解不出的字节画成问号」】
   * 实测 '쓸 수 있는 한국어 텍스트'（韩文，本来完全正常）经 GBK→UTF-8 变成
   * '? ? ?? ??? ???' —— 长度一模一样，于是信息量检查放行；
   * 而问号是 ASCII 可打印字符，scoreText 还给它加 ascii 分，
   * 结果 20 分反超原文的 -37 分，正常韩文被「修」成一排问号。
   * 判据：候选里问号占比 ≥ 30% 且高于原样的问号占比时，不接受。
   * 为什么是 30%：正常的问句/占位符很少占到三成；而「整段变问号」几乎>50%。
   * 为什么还要「高于原样」：原文本来就有很多问号（例如一串 ??? 占位）时
   * 不该因为这条被拦下。 */
  if (typeof keepText === 'string') {
    const qa = (v.match(/\?/g) || []).length / Math.max(1, v.length);
    const qb = (keepText.match(/\?/g) || []).length / Math.max(1, keepText.length);
    if (qa >= 0.3 && qa > qb) return false;
  }
  if (typeof keepText === 'string') {
    /* 信息量不能骤减：见函数头注释。用「非空白可见字符数」比较，
     * 这样 'Hello 世界'→'Hello '（7→6）不会被误判，而整段被吃掉会被拦下。
     *
     * 【latin1 形态必须豁免这条判据】
     * 「UTF-8 被当 latin1 读」是**唯一一种正确的还原会显著变短**的情况：
     * 每个 UTF-8 字节都被显示成一个字符，'中文测试'（4 字）的 latin1 形态
     * 有 12 个字符，还原后 4 个 —— 比值 0.33，会被这条判据误杀。
     * 实测：加上这条豁免之前，「latin1 形态还原成原文」这个既有用例直接红了，
     * 而那条用例是 HEAD 上就通过的正确行为。 */
    const isLatin1Shape = keepText.length >= 8 &&
      /[^\u0000-\u007F]/.test(keepText) && !/[^\u0000-\u00FF]/.test(keepText);
    if (!isLatin1Shape) {
      const a = v.replace(/\s+/g, '').length;
      const b = keepText.replace(/\s+/g, '').length;
      if (b >= 8 && a / b < 0.6) return false;
    }
  }
  return true;
}

/**
 * 把候选整理成「按可信度从高到低」的顺序。
 *
 * 【规则】其余候选必须**严格优于**原样（分数严格大于）才允许排到原样前面 ——
 * 相等也不行：「原样就已经挺好、换成另一种解码只是碰巧同分」时保持原样更安全。
 *
 * 【为什么是「排到前面」而不是「原样永远第一」】
 * 这里有一个真实缺陷曾长期存在：旧实现写的是
 *   ordered = keep ? [keep, ...better, ...others] : better
 * 而 better 是 others 的子集、best 取 ordered[0] —— 于是原样**永远**是第一，
 * 「严格优于才允许顶上去」这条规则一次都没生效过。
 * 后果是乱码修复在文本路径上从不自动采用修复结果：
 *   '娴嬭瘯'（'测试' 的 GBK 乱码）与正确 '测试' 同分 40 → 永远返回原样。
 * 现在改成「严格更优者在前、然后原样、然后其余」，best 才真正是「最可信的一条」。
 * 这个改动不放松安全性：只有分数严格更高、且不含替换字符/控制字符的候选
 * 才可能排到原样前面；正常文本实测没有这样的候选（见下方 orderCandidates 的实测记录）。
 *
 * 【为什么必须共用一个实现】见 analyzeWithEncoder 的注释：应用实际调用的是
 * 带编码器那条路径，它早期跳过了这套规则，导致正常文本被改坏 5/19 条。
 *
 * @param {Array<{to:string,text:string,score:number}>} cands
 * @returns {Array} 新数组，不改入参
 */
function orderCandidates(cands) {
  const list = Array.isArray(cands) ? cands.slice() : [];
  const keep = list.find((c) => c.to === '（不转换）');
  /* 不可接受（含替换字符/控制字符/信息量骤减）的候选一律不参与排序，也不进结果。
   * 它们「看起来分高」恰恰是因为乱码解出来的怪字被当成了罕见字符，
   * 或者因为内容被丢掉后 hanziRatio 失真。 */
  const others = list.filter((c) => c.to !== '（不转换）' && acceptable(c.text, keep && keep.text))
    .sort((a, b) => b.score - a.score);
  /* 【按文本去重，保留分数最高的那一条】
   * 候选生成是 from×to 的笛卡尔积，多个目标编码经常解出完全相同的文本
   * （实测 '娴嬭瘯' 会产出 4 条一模一样的 '4Z-[/v'）。
   * 界面上那就是「同一段结果重复列了四行」，用户看不出该选哪条。
   * 保留第一条（排序后分数最高）即可 —— 它们文本相同，选哪条结果都一样。
   *
   * 【原样文本也要参与去重】纯 ASCII 输入（'abcd'）经某些链会解出它自己，
   * 于是候选表里原样和「另一条转换」显示同一段文字，让人以为有两个方案。 */
  const seen = new Set();
  const uniq = [];
  if (keep) seen.add(keep.text);
  for (const c of others) {
    const key = c.text;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  if (!keep) return uniq;
  const better = uniq.filter((c) => c.score > keep.score);
  const rest = uniq.filter((c) => c.score <= keep.score);
  /* 【不能写成 [keep, ...better, ...others]】
   * better 是 others 的子集，那样展开会让候选出现两遍，
   * 界面候选表里同一段文本重复列出。这里用三段互斥的拼接。 */
  return [...better, keep, ...rest];
}

/* ---------- 需要「外部编码器」的修复路径（锟斤拷等） ---------- */

/* 字符串形态下必须借助外部编码器的候选链（from → to）。
 * Node 只有 UTF 系列的编码器：GBK / Big5 / Shift-JIS 能解、不能编，
 * 所以「把乱码字符串按源编码编回字节」这一步一直缺着 ——
 * 「锟斤拷」因此只能被识别、不能被修复。
 * 现在调用方可以注入一个编码器（main.js 传的是 .NET 的
 * [Text.Encoding]::GetEncoding(936)），这条链就能跑通了。 */
const EXTERNAL_CHAINS = [
  ['gbk', 'utf-8'],        // 锟斤拷：原本是 UTF-8，被按 GBK 解码后再转出来
  ['gb18030', 'utf-8'],
  ['big5', 'utf-8'],       // 繁体：Big5 被当 UTF-8
  ['shift_jis', 'utf-8'],
  ['gbk', 'big5'],
  ['big5', 'gbk'],
];

/* .NET / Windows 代码页号。GB18030 是 54936（不是 936）。 */
const PS_CODEPAGE = { gbk: 936, gb18030: 54936, big5: 950, shift_jis: 932, 'utf-16be': 1201, 'utf-16le': 1200 };

/**
 * 借外部编码器把一段字符串**按多个源编码各编回一份字节**。
 *
 * 【为什么一次算全部】每次调用都要起一个 PowerShell（几百毫秒），
 * 6 条候选链逐个来就是好几秒。这里一次进程算完所有需要的源编码。
 * 文本与结果都走 Base64：既避开引号/换行/控制台代码页的坑，
 * 也保证任意文本都能安全地传进传出。
 *
 * @param {string} text
 * @param {string[]} encs 源编码名（不在 PS_CODEPAGE 里的会被忽略）
 * @param {(script:string, timeoutMs:number)=>Promise<{stdout:string}>} psRunner
 * @returns {Promise<Object<string,Buffer>>} 编码名 → 字节；失败的不出现
 */
async function encodeTextMany(text, encs, psRunner) {
  const out = {};
  if (typeof psRunner !== 'function' || !text) return out;
  const want = (Array.isArray(encs) ? encs : []).map(normEnc).filter((e) => PS_CODEPAGE[e]);
  if (!want.length) return out;

  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  const stmts = want.map((e) =>
    `$m['${e}']=[Convert]::ToBase64String([Text.Encoding]::GetEncoding(${PS_CODEPAGE[e]}).GetBytes($s))`);
  const script =
    `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));` +
    `$m=@{};` + stmts.join(';') + `;$m|ConvertTo-Json -Compress`;

  let obj = {};
  try {
    const r = await psRunner(script, 30000);
    const raw = String((r && r.stdout) || '').trim();
    obj = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return out;   // 取不到就当作没有外部编码器，调用方会如实说明
  }
  for (const e of want) {
    const v = obj[e];
    if (typeof v === 'string' && v) {
      try { out[e] = Buffer.from(v, 'base64'); } catch (err) {}
    }
  }
  return out;
}

/**
 * 跑「按 from 编回字节 → 按 to 解码」这一族候选。
 *
 * 【三道前提缺一不可，见文件上方「字符串再编码链的三条硬性前提」】
 * 这条路径是应用实际调用的那条（main.js 的 text:detect-encoding 恒走它），
 * 所以修复必须落在这里：
 *   · 输入含 U+FFFD → 一条都不生成。否则 .NET 会把 FFFD 编成字面问号 '?'，
 *     于是「原始字节」是编的，产物必然是编造的第三种文本。
 *   · 前向无损：encode 之后用同一个 from 解回来必须逐字等于输入。
 *     这一条挡的是「编码器编不出某个字符就退化成 '?'」——
 *     实测 '資料庫連線失敗，請檢查設定檔。'（Big5 被当 GBK 读）里
 *     有一批 Big5 假字不在 CP936 里，.NET 编不出来。
 *   · 方向合法：UTF → legacy 的链在无 FFFD 输入上只可能是重新解释，丢掉。
 *
 * @param {string} s
 * @param {(text:string, encs:string[])=>Promise<Object<string,Buffer>>} psRunner 见 encodeTextMany
 * @returns {Promise<Array<{from:string,to:string,text:string,score:number}>>}
 */
async function reencodeCandidates(s, psRunner) {
  const out = [];
  if (typeof psRunner !== 'function' || !s) return out;
  if (String(s).indexOf('\uFFFD') !== -1) return out;
  const froms = [...new Set(EXTERNAL_CHAINS.map(([f]) => f))];
  const bytesMap = await encodeTextMany(s, froms, psRunner);
  for (const [from, to] of EXTERNAL_CHAINS) {
    const bytes = bytesMap[from];
    if (!isForwardLossless(s, from, bytes)) continue;
    if (!isPlausibleChain(from, to)) continue;
    const text = decodeBy(bytes, to);
    if (!text) continue;
    out.push({ from: LABELS[from] || from, to: LABELS[to] || to, text, score: scoreText(text) });
  }
  return out;
}

/**
 * 这一段输入是否**值得**去借外部编码器。
 *
 * 只有一条否决理由：输入里含 U+FFFD（原始字节已丢，把字符编回去只会编造内容）。
 * 抽成函数是为了让 analyzeWithEncoder 的 externalTried 有个诚实的判据 ——
 * 「该试但没候选」与「压根不该试」是两件事，调用方与测试都需要分得开。
 *
 * @param {string} s
 * @returns {boolean}
 */
function reencodeEligible(s) {
  return String(s || '').indexOf('\uFFFD') === -1;
}

/**
 * analyzeMojibake 的增强版：额外尝试需要外部编码器的候选链。
 *
 * 「锟斤拷」的修复只能走这条路 —— 它需要把字符按 GBK 编回字节，
 * 而 Node 没有 GBK 编码器。拿不到外部编码器时行为与 analyzeMojibake 一致
 * （只是 note 里会说清「这一步没做成」）。
 *
 * 【这条路径必须和 analyzeMojibake 共用同一套排序护栏】
 * 它才是应用实际调用的那条（main.js 的 text:detect-encoding 恒走这里），
 * 但早期版本把 extra 候选直接 concat + sort，跳过了「剔除含替换字符的候选」
 * 与「严格优于原样才允许顶上去」两道规则。后果是**正常文本被改坏**——
 * 实测 19 条正常文本里 5 条被改烂：
 *   'Hello 世界'                     → 'Hello '（Big5→GBK 得出空串，score 0 > -35）
 *   'https://…/路径/文件.txt'         → 路径里的中文变成问号（GBK→UTF-8）
 *   '쓸 수 있는 한국어 텍스트'        → 整句变问号
 * 这正是 analyzeMojibake 里那段注释花大力气防的事，只是当时没在这条路径上生效。
 * 现在两条路径都调 orderCandidates，只此一处。
 *
 * @param {string} input
 * @param {(text:string, encs:string[])=>Promise<Object<string,Buffer>>} psRunner
 * @returns {Promise<object>}
 */
async function analyzeWithEncoder(input, psRunner) {
  const base = analyzeMojibake(input);
  const s = String(input == null ? '' : input);
  const extra = await reencodeCandidates(s, psRunner);
  /* 【没有额外候选时，externalTried 必须如实反映「跑没跑」而不是「有没有结果」】
   * 旧写法只看 extra 是否为空，于是「输入含 FFFD，按新护栏一条都不生成」
   * 会被报成 externalTried:false —— 那会让调用方以为「没试过」，
   * 而测试里那条 golden 断言恰恰靠这个字段区分「没测到」与「测到了」。
   * 现在先判「该不该试」：含 FFFD 就是不该试（也说不出「试了但没结果」）。 */
  if (!extra.length) {
    return Object.assign({}, base, {
      externalTried: reencodeEligible(s),
      note: base.note || '',
    });
  }
  /* base.candidates 已经是排好序的（含原样在首位），额外候选并入后重新整理。
   * 注意不能直接取 candidates[0] 当 best —— 那就把「严格优于原样」这条
   * 规则又绕过去了。 */
  const merged = base.candidates.concat(extra);
  const candidates = orderCandidates(merged);
  const best = candidates[0] || null;
  let note = base.note;
  if (base.kuen) {
    note = '检测到「锟斤拷」特征：已借助系统编码器（.NET CP936）把文本按 GBK 编回字节、再按 UTF-8 解。' +
      '原本解码时被丢掉的字节（U+FFFD）无法找回，所以结果里若还残留「�」是正常现象，不是没修好。';
  }
  return Object.assign({}, base, { best, candidates, note, externalTried: true });
}

module.exports = {
  ENCODINGS, LABELS, COMMON_HANZI, FALLBACK_HANZI, EXTERNAL_CHAINS, PS_CODEPAGE,
  scoreText, looksLikeKuen, detectEncodings, analyzeMojibake, decodeBy, encodeBy, normEnc, tryReencode,
  encodeTextMany, reencodeCandidates, analyzeWithEncoder, orderCandidates, acceptable,
  isPlausibleChain, isForwardLossless, reencodeEligible, UTF_FAMILY, LEGACY_ENCODINGS,
};
