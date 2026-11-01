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

/** 用于「是否为自然中文文本」的常见字样本。取高频字，命中越多越像中文。 */
const COMMON_HANZI = '的一是不了在人有我他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从知';

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
    if (COMMON_HANZI.indexOf(ch) !== -1) common++;
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
   * 上面的 common 只做了 +30 的正向加权，权重太轻：
   * 实测 UTF-8 被当 GBK 读出来的乱码
   *   'Hello 涓栫晫'        得 53.3 分，比正确的 'Hello 世界'（45.0）**更高**
   *   'ERROR: 鏃犳硶鎵撳紑鏂囦欢' 76.3 分，高于正确的 76.2
   * 于是「修复」会把一段好好的文本改成乱码。
   * 根因是乱码解出来的汉字同样是 CJK 基本区，hanziRatio 一样计满分，
   * 而「这几个字在正常中文里几乎不出现」这件事完全没被惩罚。
   * 真正的判据是**常用字覆盖率**：正常中文里常用字占绝大多数，
   * 乱码串则几乎全是生僻字。这里对覆盖率低于一半的情况按比例扣分，
   * 幅度足以压过 hanziRatio 带来的加分。 */
  if (hanzi > 0) {
    const commonRatio = common / hanzi;
    if (commonRatio < 0.5) {
      score -= (0.5 - commonRatio) * 160;
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

  /* 候选生成：把输入当作「某编码解码后的结果」，反向编码成字节，
   * 再用各候选编码解码。这是修乱码的通用手法。 */
  const candidates = [];

  // 原样作为候选（可能本来就没坏）
  candidates.push({ from: '（原样）', to: '（不转换）', text: s, score: scoreText(s) });

  const FROM = ['gbk', 'gb18030', 'big5', 'utf-8', 'utf-16le'];
  const TO = ['utf-8', 'gb18030', 'gbk', 'big5'];

  for (const from of FROM) {
    for (const to of TO) {
      if (from === to) continue;
      /* 关键限制：只有 UTf 系列能用 Buffer 编码，GBK/Big5 编不回去。
       * 所以真正的「GBK 误读 UTF-8」修复是：把字符串按 **UTF-8** 编字节
       * 那条已经不对了 —— 我们手上是「GBK 解码后的字符」，
       * 需要用 GBK 编码器编回字节。Node 没有。
       *
       * 变通：Node 的 TextDecoder 只解不编，但**如果字符串里包含 U+FFFD**，
       * 说明信息已经在解码时丢了，无法还原。
       * 因此对「完整保留的乱码」（含锟斤拷这类能用 GBK 表示的字符），
       * 我们走另一个路径：把字符按 Unicode 码点查 GBK 映射 —— 
       * 也不现实（要维护映射表）。
       *
       * 结论：字符串形态下，能可靠修的是「UTF-8 被当 latin1/utf-16 读」，
       * 以及原始的字节形态。所以这里把输入也当作**字节**再探一次（见下）。 */
      const r = tryReencode(s, from, to);
      if (r.ok) candidates.push({ from: LABELS[from] || from, to: LABELS[to] || to, text: r.text, score: scoreText(r.text) });
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
   *   · 护栏 2：短文本（< 8 字符）不做 latin1 反推 —— 样本太短，
   *     任何解码都可能"看起来合理"，判分没有意义。 */
  const hasNonAscii = /[^\x00-\x7F]/.test(s);
  if (hasNonAscii && s.length >= 8) {
    const asLatin1 = Buffer.from(s, 'latin1');
    const byteCands = detectEncodings(asLatin1);
    for (const c of byteCands.slice(0, 4)) {
      candidates.push({ from: 'latin1 字节', to: c.label, text: c.text, score: c.score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  /* 【候选必须有「可接受性」下限，否则越修越坏】
   * 排序只看分数时，一个含 U+FFFD 或空洞控制字符的结果也可能排到第一 ——
   * 实测出现过大白话的 'Hello 世界' 被改成 `Hello \u0016L` 这种结果。
   * 乱码修复的意义是「比原来更可读」，任何含替换字符/损坏控制字符的候选
   * 都不可能比原样更好，直接剔除。 */
  const acceptable = (t) => {
    const v = String(t || '');
    if (v.includes('\uFFFD')) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(v)) return false;
    return true;
  };
  /* 原样候选永远排在最前（它不可能是「修坏」的结果）。
   * 其余候选必须**严格优于**原样才允许顶上去 —— 相等也不行：
   * 「原样就已经挺好、换成另一种解码只是碰巧同分」时，保持原样更安全。 */
  const keep = candidates.find((c) => c.to === '（不转换）');
  const others = candidates.filter((c) => c.to !== '（不转换）' && acceptable(c.text));
  const better = others.filter((c) => keep ? c.score > keep.score : true)
    .sort((a, b) => b.score - a.score);
  const ordered = keep ? [keep, ...better, ...others] : better;
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
  return { best, candidates, kuen, note };
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
 * @param {string} s
 * @param {(text:string, encs:string[])=>Promise<Object<string,Buffer>>} psRunner 见 encodeTextMany
 * @returns {Promise<Array<{from:string,to:string,text:string,score:number}>>}
 */
async function reencodeCandidates(s, psRunner) {
  const out = [];
  if (typeof psRunner !== 'function' || !s) return out;
  const froms = [...new Set(EXTERNAL_CHAINS.map(([f]) => f))];
  const bytesMap = await encodeTextMany(s, froms, psRunner);
  for (const [from, to] of EXTERNAL_CHAINS) {
    const bytes = bytesMap[from];
    if (!bytes || !bytes.length) continue;
    const text = decodeBy(bytes, to);
    if (!text) continue;
    out.push({ from: LABELS[from] || from, to: LABELS[to] || to, text, score: scoreText(text) });
  }
  return out;
}

/**
 * analyzeMojibake 的增强版：额外尝试需要外部编码器的候选链。
 *
 * 「锟斤拷」的修复只能走这条路 —— 它需要把字符按 GBK 编回字节，
 * 而 Node 没有 GBK 编码器。拿不到外部编码器时行为与 analyzeMojibake 一致
 * （只是 note 里会说清「这一步没做成」）。
 *
 * @param {string} input
 * @param {(text:string, encs:string[])=>Promise<Object<string,Buffer>>} psRunner
 * @returns {Promise<object>}
 */
async function analyzeWithEncoder(input, psRunner) {
  const base = analyzeMojibake(input);
  const s = String(input == null ? '' : input);
  const extra = await reencodeCandidates(s, psRunner);
  if (!extra.length) {
    return Object.assign({}, base, {
      externalTried: false,
      note: base.note || '',
    });
  }
  const candidates = base.candidates.concat(extra).sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;
  let note = base.note;
  if (base.kuen) {
    note = '检测到「锟斤拷」特征：已借助系统编码器（.NET CP936）把文本按 GBK 编回字节、再按 UTF-8 解。' +
      '原本解码时被丢掉的字节（U+FFFD）无法找回，所以结果里若还残留「�」是正常现象，不是没修好。';
  }
  return Object.assign({}, base, { best, candidates, note, externalTried: true });
}

module.exports = {
  ENCODINGS, LABELS, COMMON_HANZI, EXTERNAL_CHAINS, PS_CODEPAGE,
  scoreText, looksLikeKuen, detectEncodings, analyzeMojibake, decodeBy, encodeBy, normEnc, tryReencode,
  encodeTextMany, reencodeCandidates, analyzeWithEncoder,
};
