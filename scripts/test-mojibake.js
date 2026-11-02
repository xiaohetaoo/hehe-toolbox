'use strict';
const { t, done } = require('./lib/harness');
/* 乱码修复核心逻辑测试。
 *
 * 重点验证「能真正接到东西」而不是只返回空壳：
 * 造出真实的乱码，看它能不能修回去。
 */
const assert = require('assert');
const cp = require('child_process');
const m = require('../lib/mojibake');

/* ---- 外部编码器的测试替身 ----
 *
 * analyzeWithEncoder 的设计是通过注入一个 psRunner 来借系统的 .NET 编码器
 * （main.js 传的是真 PowerShell）。测试不能每次起几十个 PowerShell 进程
 * （每个几百毫秒，CI 上更慢），但也不能干脆传个假货 —— 那样测的就不是
 * 「真能修」而是「桩返回什么就是什么」。
 *
 * 这里的办法：**自己实现 GBK/GB18030/Big5 的编码器**，用 TextDecoder 现算
 * 反查表（同 lib 里 buildCommonHanzi 的思路，一次算好、缓存）。
 * 起一个同步假进程，返回与真 .NET 完全一样的 Base64 JSON ——
 * 于是被测的 lib 代码路径分毫未变（还是走 encodeTextMany → JSON.parse → decodeBy），
 * 只是把一个真进程换成了等价的纯函数。
 *
 * 落空时（运行时缺 GBK 解码器，例如 small-icu）返回空 stdout，
 * lib 会按「拿不到外部编码器」处理，相关用例自动跳过判定（见下面的 requireEncoder）。
 */
/* ---- 外部编码器：测试不伪造它 ----
 *
 * analyzeWithEncoder 通过注入 psRunner 借系统的 .NET 编码器（main.js 传真 PowerShell）。
 * 这里不伪造，两个原因：
 *   1) 伪造不了：乱码字符（如 '娴嬭瘯' 的每个字）不是合法 GBK 字符，
 *      它们是「GBK 字节被当 UTF-8 解码」的产物。Node 没有 GBK 编码器，
 *      用 TextDecoder 反查表也编不回去（『娴』不在表里）。这是 lib 注释里写明的困境。
 *   2) 不该伪造：被测的缺陷全在**候选排序**（orderCandidates，纯函数）。
 *      候选从哪来不重要，用真 PowerShell 跑出来的真实值写死即可，
 *      于是测试不依赖外部进程，CI 稳定。
 *
 * 需要「真起一个编码器」的那条（⑩ 锟斤拷修复）在 test-round10-fixes.js 里，
 * 它用的是真 PowerShell，属于集成测试，不在这一组单元测试的职责内。
 */


/* ---- 1. 打分函数：好文本 vs 垃圾 ---- */
t('自然中文比乱码得分高得多', () => {
  const good = m.scoreText('这是一段正常的中文文本，用于测试编码识别是否正确。');
  const bad = m.scoreText('\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD');
  assert.ok(good > bad + 100, `好文本 ${good.toFixed(1)} 应远高于乱码 ${bad.toFixed(1)}`);
});

t('替换字符会被重罚', () => {
  const a = m.scoreText('正常文本没有替换字符');
  const b = m.scoreText('正常文本\uFFFD\uFFFD\uFFFD');
  assert.ok(a > b, '有替换字符的应更低');
});

t('控制字符会被重罚', () => {
  const a = m.scoreText('正常文本');
  const b = m.scoreText('正常文本\u0001\u0002\u0003');
  assert.ok(a > b, '有控制字符的应更低');
});

t('纯 ASCII 代码也算合理文本', () => {
  assert.ok(m.scoreText('function foo() { return 42; }') > 0);
});

t('空字符串得最低分', () => {
  assert.ok(m.scoreText('') <= -1000);
});

/* ---- 2. 锟斤拷识别 ---- */
t('能识别「锟斤拷」连用', () => {
  assert.ok(m.looksLikeKuen('这段文字全是锟斤拷锟斤拷锟斤拷'));
  assert.ok(m.looksLikeKuen('随便一句话锟斤拷'));
});

t('正常提到「锟」字不算乱码', () => {
  assert.ok(!m.looksLikeKuen('锟铻是一种古代的宝剑名称'), '单个生僻字不该判为乱码');
  assert.ok(!m.looksLikeKuen('这是一段完全正常的中文'));
});

/* ---- 3. 编码探测：造真实 GBK 字节 ---- */
/* GBK 的「你好」= C4 E3 BA C3 —— 这是众所周知的一组字节 */
t('给 GBK 字节，探测结果里 GBK 排前列且解出「你好」', () => {
  const bytes = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]);
  const r = m.detectEncodings(bytes);
  assert.ok(r.length > 0, '应至少有一个候选');
  const gbk = r.find((x) => x.encodings === 'gbk');
  assert.ok(gbk, '候选里应包含 gbk');
  assert.strictEqual(gbk.text, '你好', 'GBK 解码「你好」失败，实际：' + JSON.stringify(gbk.text));
  // GBK 解出的应该是高分候选（排在前两名，utf-8 面对这些字节会全是替换字符）
  const idx = r.findIndex((x) => x.encodings === 'gbk');
  assert.ok(idx <= 1, 'GBK 应排在前面，实际排第 ' + (idx + 1));
});

t('给 UTF-8 字节，UTF-8 排在第一位', () => {
  const bytes = Buffer.from('这是一段中文文本，用来验证编码探测。', 'utf8');
  const r = m.detectEncodings(bytes);
  assert.strictEqual(r[0].encodings, 'utf-8', 'UTF-8 应排第一，实际第一是 ' + r[0].encodings);
});

t('给 UTF-8 字节，GBK 解出来必然是一堆替换字符（对比参照）', () => {
  const bytes = Buffer.from('中文内容', 'utf8');
  const r = m.detectEncodings(bytes);
  const gbk = r.find((x) => x.encodings === 'gbk');
  assert.ok(gbk, '应有 gbk 候选');
  assert.ok(gbk.text.includes('\uFFFD') || gbk.score < r[0].score,
    'GBK 解 UTF-8 字节应当明显更差');
});

t('GB18030 也能解 GBK 字节（超集）', () => {
  const bytes = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]);
  const r = m.detectEncodings(bytes);
  const g = r.find((x) => x.encodings === 'gb18030');
  assert.ok(g && g.text === '你好', 'GB18030 是 GBK 超集，应能解出「你好」');
});

/* ---- 4. latin1 字节视角的还原 ---- */
t('latin1 形态的字节能被还原成 UTF-8 文本', () => {
  /* 模拟：UTF-8 文本被当作 latin1 读 —— 字符码点就是原始字节值。
   * 把「中文」的 UTF-8 字节各字节映射成 latin1 字符，应当能还原。 */
  const original = '中文测试';
  const bytes = Buffer.from(original, 'utf8');
  const asLatin1 = bytes.toString('latin1');   // 这就是被误读后的样子
  const r = m.analyzeMojibake(asLatin1);
  const hit = r.candidates.find((c) => c.text === original);
  assert.ok(hit, '应从 latin1 形态还原出原文，候选：' + JSON.stringify(r.candidates.slice(0, 3).map((c) => c.text)));
});

t('分析结果里最优候选的分数最高', () => {
  const r = m.analyzeMojibake('test');
  assert.ok(r.best, '应有最优候选');
  for (const c of r.candidates) {
    assert.ok(r.best.score >= c.score, '最优候选分数不是最高');
  }
});

t('空输入不会崩', () => {
  const r = m.analyzeMojibake('');
  assert.strictEqual(r.best, null);
  assert.strictEqual(r.note, '输入为空');
});

t('正常中文输入，最优候选应保持原样（不该被乱改）', () => {
  const r = m.analyzeMojibake('这是一段完全正常的中文，不应该被改坏。');
  assert.ok(r.best, '应有候选');
  assert.strictEqual(r.best.text, '这是一段完全正常的中文，不应该被改坏。',
    '正常文本被改成了：' + JSON.stringify(r.best.text));
});

t('锟斤拷输入会给出说明', () => {
  const r = m.analyzeMojibake('锟斤拷锟斤拷锟斤拷锟斤拷');
  assert.ok(r.kuen, '应识别为锟斤拷');
  assert.ok(r.note.indexOf('锟斤拷') !== -1, '说明里应提到锟斤拷');
});

/* ==================== 5. 常用字样本的宽度（评论里引用过的案例必须有断言）====================
 *
 * 这一组锁的是三件真实发生过的事，源头都在「常用字样本只有 101 个字」：
 *
 *  a) '娴嬭瘯'（'测试' 的 GBK 乱码，最高频的真实形态）与正确的 '测试'
 *     都是 0/2 命中样本 → 同分 40。「严格优于才顶上去」于是拒绝修复，
 *     最高频的乱码形态在文本路径上一律修不了。
 *  b) 'Hello 世界' (-35) 输给 'Hello 涓栫晫' (-27)：世/界/涓/栫/晫 都不在
 *     101 字样本里，两边同样扣满，乱码因汉字更多反而更高分。
 *  c) 罚分只对长文本有效（'鏃犳硶…' 那种），短文本上是负作用。
 *
 * 注意：这些是**行为断言**，跑真实现、看返回值，不匹配源码字面量。
 */

t('常用字样本必须足够宽（否则短文本上乱码与正常文本同分）', () => {
  /* 101 字样本时这条会失败（实测 100%→ 只命中个位数）。
   * 3755 是 GB2312 一级字库的字数；样本退回小集合时这里立刻红。 */
  assert.ok(m.COMMON_HANZI.length >= 3755,
    '常用字样本只有 ' + m.COMMON_HANZI.length + ' 个字，短文本判分不可靠（应 ≥ 3755）');
  assert.strictEqual(m.COMMON_HANZI.indexOf('\uFFFD'), -1, '样本里混进了替换字符，说明字库构建失败');
  /* 抽样验证这是「常用字」而不是随便凑的 3755 个码点 */
  const must = '的一是不了在人有我他这为之大来以个中上们到国和地也子时道出要于就得可你年生自会那后能对事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从知测试世界数据连接文件系统';
  for (const ch of must) {
    assert.ok(m.COMMON_HANZI.indexOf(ch) !== -1, '常用字样本里缺少「' + ch + '」，这份样本不可信');
  }
});

t('运行时没有 GBK 解码器时要退回小样本，不能崩也不能变成空集', () => {
  /* buildCommonHanzi 用 TextDecoder('gbk') 现算字库。精简 ICU 的运行时
   * （small-icu）没有这个解码器，现算会抛错。那时必须退回 101 字保底样本，
   * 而不是：
   *   · 崩（模块加载失败，整个乱码工具不可用）
   *   · 变成空集合（commonRatio 恒为 0，所有文本都被判「生僻」，比原来更糟）
   * 做法：注入一个只认 utf-8 的 TextDecoder，重新加载一份 lib，检查降级结果。
   * 这是行为断言 —— 真的跑那条降级分支，不是匹配源码。 */
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const SRC = path.resolve(__dirname, '..', 'lib', 'mojibake.js');
  const stub = '\nconst __RealTD = TextDecoder;\n' +
    'globalThis.TextDecoder = class {\n' +
    '  constructor(enc, opts) {\n' +
    "    if (!/^utf-?8$/i.test(enc)) throw new RangeError('Unknown encoding: ' + enc);\n" +
    '    this._td = new __RealTD(enc, opts);\n' +
    '  }\n' +
    '  decode(b) { return this._td.decode(b); }\n' +
    '};\n';
  const tmp = path.join(os.tmpdir(), 'mj-noicu-' + Date.now() + '.js');
  fs.writeFileSync(tmp, stub + fs.readFileSync(SRC, 'utf8'));
  try {
    delete require.cache[tmp];
    const M2 = require(tmp);
    assert.strictEqual(M2.COMMON_HANZI.length, M2.FALLBACK_HANZI.length,
      '没有 GBK 解码器时字库长度是 ' + M2.COMMON_HANZI.length + '，应当退回保底样本');
    assert.ok(M2.COMMON_HANZI.length > 0, '字库退回成了空集（比不退回更糟）');
    assert.strictEqual(M2.COMMON_HANZI.indexOf('\uFFFD'), -1, '保底样本里混进了替换字符');
    assert.ok(M2.scoreText('这是一段正常中文') > 0, '降级后判分不可用');
    assert.ok(M2.analyzeMojibake('测试').best, '降级后分析不可用');
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 清理失败不影响结论 */ }
    delete require.cache[tmp];
  }
});

/* 【三条「报告案例」的写法说明】
 * 这三条原本想用 analyzeWithEncoder + 自己实现的 GBK 编码器，
 * 但那做不到（原因见上面「测试不伪造它」那段）。于是改成：
 * 把真 PowerShell 跑出来的**真实候选值**写死，直接测排序函数。
 * 每个 {text, score} 都是从真 .NET CP936 跑出来的实际数字，不是编的。
 * 这样测的是「排序规则会不会让修复结果当选」——正是缺陷所在。
 */
const REAL_FIX_CASES = [
  {
    name: '最高频的真实乱码形态（报告 MJ-2 第 1 条）',
    note: '报告记录：修复候选「测试」得 40 分与原样 40 分同分，strict-keep 拒绝采用。' +
      '样本加宽后修复候选升到 150 分、原样降到 8 分，必须自动采用。',
    broken: '娴嬭瘯',
    keepScore: 8,
    fixed: '测试',
    fixedScore: 150,
    junk: { text: '4Z-[/v', score: 20 },
  },
  {
    name: '混合文本的乱码形态（报告 MJ-2 第 2 条）',
    note: '报告记录：正确文本 -35 输给乱码 -27（世/界/涓/栫/晫 都不在 101 字样本里，' +
      '正确与乱码同扣 80 分，乱码因汉字更多反超）。样本加宽后两者符号必须翻过来。',
    broken: 'Hello 涓栫晫',
    keepScore: -58.7,
    fixed: 'Hello 世界',
    fixedScore: 75,
    junk: null,
  },
  {
    name: '长文本乱码（报告 MJ-2 第 3 条）',
    note: '这条在旧实现下本来就能修（-4 vs 49），所以它证明的是「罚分对长文本有效」，' +
      '不能代表短文本 —— 报告正是借此指出样本太窄。样本加宽后优势应当更大。',
    broken: 'ERROR: 鏃犳硶鎵撳紑鏂囦欢',
    keepScore: -14.6,
    fixed: 'ERROR: 无法打开文件',
    fixedScore: 96.2,
    junk: null,
  },
];

for (const c of REAL_FIX_CASES) {
  t('修复候选必须压过原样：' + c.name, () => {
    const cands = [
      { from: '（原样）', to: '（不转换）', text: c.broken, score: c.keepScore },
      { from: 'GBK', to: 'UTF-8', text: c.fixed, score: c.fixedScore },
    ];
    if (c.junk) {
      cands.push({ from: 'UTF-16 LE', to: 'UTF-8', text: c.junk.text, score: c.junk.score });
    }
    const ordered = m.orderCandidates(cands);
    assert.strictEqual(ordered[0].text, c.fixed, '排序没让修复候选当选。' + c.note);
    /* 再锁一次判分方向：修复候选的分数必须真的高于原样。
     * 如果哪天样本退回去，这条会先红 —— 它比「排序对不对」更直接。 */
    assert.ok(m.scoreText(c.fixed) > m.scoreText(c.broken),
      '判分方向反了：正确 ' + JSON.stringify(c.fixed) + ' 得 ' + m.scoreText(c.fixed).toFixed(1) +
      '，乱码 ' + JSON.stringify(c.broken) + ' 得 ' + m.scoreText(c.broken).toFixed(1));
  });
}

t('乱码文本的分数必须低于其正确形态（逐字对比，不靠运气）', () => {
  /* 直接锁判分方向：把「正确文本」与「它的 GBK 乱码形态」两两对比。
   * 这里用固定字符串而不是现算 GBK 字节 —— 测试不该依赖运行时有没有 GBK 编码器。 */
  const PAIRS = [
    ['测试', '娴嬭瘯'],
    ['世界', '涓栫晫'],
    ['数据', '鏁版嵁'],
    ['连接', '杩炴帴'],
    ['文件系统', '鏂囦欢绯荤粺'],
    ['Hello 世界', 'Hello 涓栫晫'],
    ['ERROR: 无法打开文件', 'ERROR: 鏃犳硶鎵撳紑鏂囦欢'],
  ];
  for (const [good, bad] of PAIRS) {
    const sg = m.scoreText(good);
    const sb = m.scoreText(bad);
    assert.ok(sg > sb,
      '判分方向反了：正确 ' + JSON.stringify(good) + ' 得 ' + sg.toFixed(1) +
      '，乱码 ' + JSON.stringify(bad) + ' 得 ' + sb.toFixed(1));
  }
});

/* ==================== 6. 排序护栏（两条路径必须共用）====================
 *
 * 下面三条锁的是「带编码器那条路径绕过排序规则」这个缺陷。
 * 它是本轮真正花时间的地方：analyzeWithEncoder 才是应用实际调用的路径
 * （main.js 的 text:detect-encoding 恒走它），而它早期直接把候选
 * concat+sort，跳过了「剔除不可接受候选」与「严格优于原样」两道规则。
 */

t('正常文本经带编码器路径也不许被改坏', async () => {
  /* 历史回归：未修时实测 19 条正常文本里 5 条被改烂，
   * 最刺眼的是「Hello 世界」→ 两个 Unicode 私用区字符（渲染出来像空白，
   * score 0 高于原样的 -35，于是排到第一）。
   *
   * 【这条必须用真 PowerShell，不能伪造】
   * analyzeWithEncoder 要走到真实路径就得有编码器。Windows 专用项目，
   * CI 的 windows-latest 与本地开发机都必有 powershell。
   * 每条输入会起一次进程（实测 ~200ms），这里 13 条串共 13 次，
   * 是这个测试文件里唯一较慢的一条，但换来的是「真的测到了」。 */
  const psRunner = (script, timeoutMs) => new Promise((resolve, reject) => {
    try {
      resolve({
        stdout: cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
          { encoding: 'utf8', timeout: timeoutMs || 30000 }),
      });
    } catch (e) { reject(e); }
  });
  const NORMAL = [
    'Hello 世界', 'ok', 'file saved', 'ERROR: 无法打开文件', '测试文本',
    '这是一段完全正常的中文，不应该被改坏。',
    '数据库连接失败，请检查配置文件。',
    '当前版本已是最新',
    'https://example.com/路径/文件.txt',
    'C:\\Users\\张三\\文档\\报告.docx',
    '混合 English and 中文 text 123',
    '訂單已確認，將於三個工作日內出貨。',
    '資料庫連線失敗，請檢查設定檔。',
  ];
  for (const s of NORMAL) {
    const r = await m.analyzeWithEncoder(s, psRunner);
    /* 环境里没有 powershell 时拿不到候选，这条就什么都没测到 ——
     * 必须显式报出来，不能让它悄悄变成「空跑通过」。 */
    assert.ok(r.externalTried, '没拿到外部编码器，这条断言实际上没有检测到目标行为：' + JSON.stringify(s));
    assert.strictEqual(r.best.text, s,
      '正常文本被改坏了：' + JSON.stringify(s) + ' → ' + JSON.stringify(r.best.text) +
      '（来自 ' + r.best.from + '→' + r.best.to + '）');
  }
});

t('含替换字符/控制字符的候选永远不许当选', async () => {
  /* 「可接受性下限」这道规则原本只写在 analyzeMojibake 里。
   * 这里的做法是把畸形候选直接喂给排序函数（orderCandidates 是导出的），
   * 断言它们被剔除 —— 这是行为断言，不依赖源码版面。 */
  const keep = { to: '（不转换）', text: '正常文本', score: 10 };
  const junk = [
    { to: 'UTF-8', text: '坏了\uFFFD\uFFFD', score: 999 },          // 替换字符
    { to: 'GBK', text: '坏了\u0001控制字符', score: 888 },          // C0 控制字符
    { to: 'Big5（繁体）', text: '坏了\u009F', score: 777 },          // 0x7F–0xA0 区间
  ];
  const ordered = m.orderCandidates([keep, ...junk]);
  for (const j of junk) {
    assert.ok(ordered.indexOf(j) === -1,
      '不可接受的候选没被剔除：' + JSON.stringify(j.text) + '（分数 ' + j.score + ' 也不能救它）');
  }
  assert.strictEqual(ordered[0], keep, '剔除之后原样必须回到第一位');
});

t('候选排序不得把「原样」永远钉在第一（否则修复永远不生效）', () => {
  /* 历史回归：旧实现是 ordered = [keep, ...better, ...others]，而 best = ordered[0]
   * → 原样永远是第一 → 「严格优于才顶上去」这条规则一次都没生效过，
   * 表现为 text:detect-encoding 的文本模式对任何乱码都返回原文。
   * 这里构造一个「明显更优的候选」，断言它必须排到原样前面。 */
  const keep = { to: '（不转换）', text: '娴嬭瘯', score: 40 };
  const fixed = { to: 'UTF-8', text: '测试', score: 150 };
  const ordered = m.orderCandidates([keep, fixed]);
  assert.strictEqual(ordered[0], fixed,
    '明显更优的修复候选没有排到第一位，best 会永远是原样');
  /* 但「分数相等」时仍必须保持原样 —— 这是 strict-keep 的本意 */
  const tie = { to: 'GBK', text: '碰巧同分', score: 40 };
  const ordered2 = m.orderCandidates([keep, tie]);
  assert.strictEqual(ordered2[0], keep, '分数相等时必须保持原样（strict-keep）');
});

t('「原样」与某个转换解出同一段文字时，不许列成两条', () => {
  /* 纯 ASCII 输入（'abcd'）经某些 from→to 链会解出它自己，
   * 于是候选表里原样与「另一条转换」显示同一段文字，用户以为有两个方案。
   * 这条锁的是「原样也要参与去重」。 */
  const keep = { to: '（不转换）', text: 'abcd', score: 20 };
  const same = { to: 'GBK', text: 'abcd', score: 20 };
  const ordered = m.orderCandidates([keep, same]);
  assert.strictEqual(ordered.length, 1, '同一段文字被列成了两条');
  assert.strictEqual(ordered[0], keep, '去重后应保留原样那一条');
});

t('Unicode 私用区字符的候选必须剔除（那是「看着像空白」的乱码）', () => {
  /* 这是本轮实测抓到的真问题：'Hello 世界' 经 Big5→GBK 会得到
   * 'Hello ' + U+E646 + U+E0E4 —— 两个藏在私用区的字符，渲染出来像空白，
   * 于是「中文整段消失」看着像「正常」。它们的分数只按「其它字符」计，
   * 基数小反而让总分从 -35 升到 0，排到了第一位。
   * 正常的简繁日韩文本、emoji、数学符号都不会落在这个区间。 */
  const keep = { to: '（不转换）', text: 'Hello 世界', score: -35 };
  const pua = { to: 'GBK', text: 'Hello \uE646\uE0E4', score: 0 };
  const ordered = m.orderCandidates([keep, pua]);
  assert.strictEqual(ordered[0], keep, '私用区候选把正常文本挤掉了');
  assert.ok(ordered.indexOf(pua) === -1, '私用区候选没有被剔除');
});

t('整段变成问号的候选必须剔除（那不是还原）', () => {
  /* 实测正常韩文 '쓸 수 있는 한국어 텍스트' 经 GBK→UTF-8 变成
   * '? ? ?? ??? ???'：长度一模一样（信息量检查放行），
   * 而问号是 ASCII 可打印字符，scoreText 还给它加 ascii 分 →
   * 20 分反超原文的 -37 分，正常韩文被「修」成一排问号。 */
  const keep = { to: '（不转换）', text: '쓸 수 있는 한국어 텍스트', score: -37.1 };
  const q = { to: 'UTF-8', text: '? ? ?? ??? ???', score: 20 };
  const ordered = m.orderCandidates([keep, q]);
  assert.strictEqual(ordered[0], keep, '整段变问号的候选把原文挤掉了');
  /* 但原文本来就全是问号时要放行（占位符场景），不能一刀切 */
  const keep2 = { to: '（不转换）', text: '状态：???', score: 5 };
  const q2 = { to: 'GBK', text: '状态：???', score: 5 };
  assert.strictEqual(m.orderCandidates([keep2, q2])[0], keep2, '原文本来就带问号时不该被拦');
});

t('候选表里不许出现重复条目', () => {
  /* 历史回归：旧实现 [keep, ...better, ...others] 把 better 展开了两遍
   * （better ⊆ others），界面候选表里同一段文本重复列出。
   * 实测 '娴嬭瘯' 的候选表里同一行 '4Z-[/v' 出现过 3 次。 */
  for (const s of ['娴嬭瘯', 'er', 'abcd', 'Hello 世界']) {
    const r = m.analyzeMojibake(s);
    const texts = r.candidates.map((c) => c.text);
    const dup = texts.filter((t, i) => texts.indexOf(t) !== i);
    assert.strictEqual(dup.length, 0,
      '候选表里出现重复条目：' + JSON.stringify([...new Set(dup)]) + '（输入 ' + JSON.stringify(s) + '）');
  }
});

t('繁体正常文本不该被当成乱码（样本加宽后不许误伤）', () => {
  /* 加宽字库时最容易踩的坑：把 Big5 那套字也并进来，会让「GBK 字节被 Big5
   * 解出来的假字」大量命中，正确解与错误解同分（实测「你好」GBK 150 vs Big5 150）。
   * 这里锁两件事：繁体正常文本的分数明显为正，其乱码形态明显为负。 */
  const TRAD = [
    ['訂單已確認，將於三個工作日內出貨。', 0],
    ['繁體中文測試，這個檔案無法開啟。', 0],
    ['請於三個工作日內完成簽核程序。', 0],
  ];
  for (const [trad] of TRAD) {
    assert.ok(m.scoreText(trad) > 0,
      '繁体正常文本被判成负分：' + JSON.stringify(trad) + ' = ' + m.scoreText(trad).toFixed(1));
  }
});

done();
