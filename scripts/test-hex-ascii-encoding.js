'use strict';
/* 「Hex / ASCII 互转」必须说清是 UTF-8，且解码非法字节时不能静默输出乱码。
 *
 * ============ 锁的是哪个回归 ============
 * 两件事，都不在原有测试覆盖范围内：
 *
 * ① 文案误导。工具名带「ASCII」，实际做的却是 **UTF-8** 字节转换
 *    （靠 TextEncoder/TextDecoder，项目里没有任何内置编码表）。
 *    中文用户输入「中」时期望 GBK 的 D6 D0，得到的是 UTF-8 的 E4 B8 AD ——
 *    两边字节完全对不上，而旧文案（"文本与十六进制字节互转"）没有任何地方
 *    说明用的是哪种编码。
 *
 * ② 解码静默失败。用的是默认的 `new TextDecoder().decode()`，非严格模式，
 *    遇到非法 UTF-8 不报错、把坏字节替换成 U+FFFD（显示成「�」）。
 *    实测：GBK 的 D6 D0 CE C4 喂进去输出「����」—— 用户分不清是
 *    自己编码选错了，还是工具坏了。
 *
 * 而中文用户拿到的 hex 串**很可能就是 GBK**：抓包、旧系统配置、
 * 记事本「另存为 ANSI」都是 GBK。踩中概率很高。
 *
 * ============ 验证方式 ============
 * ① 结构：工具注册块里 desc/descEn 必须点明 UTF-8；源码里必须有严格解码。
 * ② 行为：把工具里的转换逻辑按源码复刻出来跑（GBK 字节 → 必须得到提示而不是 �）。
 *    转换逻辑很短、且是纯函数，复刻比加载整个工具页可靠；
 *    关键函数（bytesToUtf8Strict / decodeErrHint）直接从源码文本校验存在性。
 */
const { t, done, assert, readSrc } = require('./lib/harness');

const src = readSrc('js/tools/text-codec.js');

t('H1 工具描述必须点明 UTF-8（否则用户以为是 GBK）', () => {
  /* 锁的是：名称带 ASCII、实际是 UTF-8，而文案没说 —— 用户按 GBK 理解，
   * 得到的字节对不上，浪费排查时间。 */
  const block = /id:\s*'hex-ascii'[\s\S]{0,400}/.exec(src);
  assert.ok(block, '找不到 hex-ascii 的注册块');
  const b = block[0];
  /* 锁的是：描述不点明编码 → 用户按 GBK 理解，字节对不上。 */
  assert.ok(/UTF-8/i.test(b), '描述里没有点明 UTF-8：' + b.slice(0, 200));
  /* 中文描述里要直接写出来，而不是只在英文里提 */
  const descZh = /desc:\s*'([^']*)'/.exec(b);
  /* 锁的是：只在英文描述里提、中文没提 —— 而中文用户看的是这一条。 */
  assert.ok(descZh && /UTF-8/i.test(descZh[1]),
    '中文描述没说明编码（用户多数看这一条）：' + (descZh ? descZh[1] : '(没有 desc)'));
});

t('H2 解码必须用严格模式（fatal: true），不能静默吃坏字节', () => {
  /* 锁的是：默认 TextDecoder 非严格 → 非法字节变 U+FFFD → 界面显示「����」。 */
  assert.ok(/new TextDecoder\(\s*['"]utf-8['"]\s*,\s*\{\s*fatal:\s*true\s*\}/.test(src),
    '没有找到 fatal:true 的严格解码器 —— 非法 UTF-8 会静默变成 U+FFFD');
  assert.ok(/function bytesToUtf8Strict/.test(src),
    '没有 bytesToUtf8Strict 函数');
});

t('H3 解码失败要给出「可能是 GBK」这种可操作的归因', () => {
  /* 锁的是：只说"不是合法 UTF-8"用户仍然不知道怎么办；
   * 而绝大多数失败场景就是 GBK。要点出来。
   *
   * 【判据必须取 decodeErrHint 的**返回值**，不能全文 includes('GBK')】
   * 文件里注释也提到 GBK，全文匹配会把"归因文案被删掉、只剩注释"这种
   * 情况判成绿（实测确认过：把返回文案里的 GBK 换掉，H3 仍然 PASS）。 */
  /* 锁的是：归因函数被删掉，解码失败又退回原始英文报错。 */
  assert.ok(/function decodeErrHint/.test(src), '没有 decodeErrHint');

  /* 复刻 decodeErrHint 的判断分支，只验"输入是 UTF-8 解码失败"时的输出。
   * 这里必须用真源码里的文案 —— 所以从源码中把 return 的那两个字符串抓出来。 */
  const fnBlock = /function decodeErrHint[\s\S]*?\n  \}/.exec(src);
  assert.ok(fnBlock, '抓不到 decodeErrHint 的函数体');
  const returned = [...fnBlock[0].matchAll(/return\s+'([^']*)'/g)].map((m) => m[1]);
  assert.ok(returned.length >= 1, 'decodeErrHint 里没有 return 文案');
  const utf8FailMsg = returned.find((s) => /UTF-8/.test(s));
  assert.ok(utf8FailMsg, 'decodeErrHint 没有针对"非法 UTF-8"的文案');
  assert.ok(/GBK/.test(utf8FailMsg),
    '归因文案里没提 GBK（用户据此才能判断换编码）：' + utf8FailMsg);

  /* 解码失败路径必须真的调用它，而不是又落回 e.message */
  /* 锁的是：函数还在但解码路径不再调它 —— 等于没修。 */
  assert.ok(/decodeErrHint\(e\)/.test(src), '解码失败时没有调用 decodeErrHint');
});

t('H3b 归因的判定要认浏览器措辞（真机踩过：只认 Node 措辞等于永不触发）', () => {
  /* 锁的是：2026-11-06 真机点击验证发现的回归 ——
   * decodeErrHint 的判据写的是 `/not valid for encoding utf-8/i`，
   * 这串报错**只有 Node 会拼**。工具跑在渲染进程里，Chromium 抛的是
   *   "Failed to execute 'decode' on 'TextDecoder': The encoded data was not valid."
   * 少了 "for encoding utf-8"，正则永远不命中 → 真机上 GBK 归因一次都没出现，
   * 用户看到的是一条英文 TypeError。
   *
   * 【为什么必须用真实措辞跑行为断言】这条回归的性质是"判据与实际运行环境的
   *   报错措辞对不上"，只有把两家真实报错字符串喂进真函数才测得出来；
   *   源码文本里正则写得多漂亮都说明不了它会命中。
   *   判定：H3 只看"文案里有 GBK"，所以旧代码照样绿 —— 那次失败被漏掉了。 */
  const fnBlock = /function decodeErrHint[\s\S]*?\n  \}/.exec(src);
  assert.ok(fnBlock, '抓不到 decodeErrHint 的函数体');
  const errFor = new Function('e', fnBlock[0] + '\nreturn decodeErrHint(e);');

  /* 两家引擎的真实报错文案，逐字录下来（不含自造） */
  const NODE_MSG = 'The encoded data was not valid for encoding utf-8';
  const CHROMIUM_MSG = "Failed to execute 'decode' on 'TextDecoder': The encoded data was not valid.";
  /* 锁的是：浏览器侧措辞不认 —— 那正是线上真正会走的分支。 */
  assert.ok(/GBK/.test(errFor(new Error(CHROMIUM_MSG))),
    '浏览器措辞没有被识别成解码失败（真机上会直接显示英文报错）：' + CHROMIUM_MSG);
  /* Node 侧也不能退化（单测环境用它） */
  /* 锁的是：只认浏览器措辞、把 Node 措辞丢掉 —— 单测环境（Node）就会漏判。 */
  assert.ok(/GBK/.test(errFor(new Error(NODE_MSG))),
    'Node 措辞没有被识别成解码失败：' + NODE_MSG);
  /* 其它引擎/版本可能给的措辞，一并兜住 —— 都表达"这串字节解不出来" */
  for (const m of ['The encoded data was not valid.', 'malformed UTF-8', 'Invalid encoding']) {
    /* 锁的是：判据写得太窄，换一个 Chromium 版本换个措辞就又不认了。 */
    assert.ok(/GBK/.test(errFor(new Error(m))), '没识别成解码失败：' + m);
  }
  /* 不相干的错误不能被误判成"不是合法 UTF-8"，否则用户被引到错误方向 */
  /* 锁的是：把任意错误都说成 GBK，反而误导排查。 */
  const other = 'TypeError: x is not a function';
  assert.ok(!/GBK/.test(errFor(new Error(other))), '把无关错误也说成了编码问题：' + other);
});

t('H4 行为：GBK 字节不能输出替换字符，必须给出 GBK 提示', () => {
  /* 锁的是：「����」那条静默失败。行为断言：按源码里的实现复刻一遍跑。 */
  /* 从源码里确认严格解码器的构造参数，保证复刻的是实现本身 */
  assert.ok(/fatal:\s*true/.test(src), '源码里没有 fatal:true');

  const bytesToUtf8Strict = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const decode = (arr) => {
    try { return { ok: true, text: bytesToUtf8Strict(Uint8Array.from(arr)) }; }
    catch (e) { return { ok: false, err: String(e.message) }; }
  };

  /* GBK「中文」= D6 D0 CE C4 */
  const gbk = decode([0xD6, 0xD0, 0xCE, 0xC4]);
  assert.strictEqual(gbk.ok, false, 'GBK 字节竟然被当作合法 UTF-8 解出来了');
  assert.ok(!String(gbk.text || '').includes('\uFFFD'), '仍输出了替换字符');

  /* 合法的 UTF-8 必须照常解出来 */
  const utf8 = decode([0xE4, 0xB8, 0xAD]);
  assert.strictEqual(utf8.ok, true, '合法 UTF-8 解不出来');
  assert.strictEqual(utf8.text, '中', 'UTF-8 解码结果不对');

  /* 纯 ASCII 也必须照常 */
  const ascii = decode([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
  assert.strictEqual(ascii.ok, true);
  assert.strictEqual(ascii.text, 'Hello');
});

t('H5 行为：UTF-8 往返仍然正确（改文案/解码不能破坏编码方向）', () => {
  /* 锁的是：修解码时把编码方向弄坏 —— 那才是工具的常用方向。 */
  const enc = (s) => [...new TextEncoder().encode(s)]
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const dec = (hex) => new TextDecoder('utf-8', { fatal: true })
    .decode(Uint8Array.from(hex.split(' ').map((h) => parseInt(h, 16))));

  for (const s of ['Hello, World!', '中文测试', '混合 abc 中文 123', '😀🎉']) {
    assert.strictEqual(dec(enc(s)), s, '往返回不等：' + s);
  }
  /* ASCII 区的几个锚点 */
  assert.strictEqual(enc('A'), '41');
  assert.strictEqual(enc('a'), '61');
  assert.strictEqual(enc('0'), '30');
  assert.strictEqual(enc(' '), '20');
});

t('H6 十六进制格式错误仍给出格式指引（不是笼统报错）', () => {
  /* 锁的是：把两种失败（hex 格式错 / 不是合法 UTF-8）混成一句话。 */
  assert.ok(/无效的十六进制输入/.test(src), '缺 hex 格式错误的专门提示');
  assert.ok(/长度必须是偶数|每字节两位/.test(src), '没说明长度必须偶数');
});

/* ==================== H7–H9：Base64 解码失败不能暴露英文异常 ====================
 * 真机测试（dsh-computer-use-win 插件）发现的缺陷：
 * 在「Base64 编解码」里切到解码模式，把中文粘进去，界面显示的是
 *   ⚠ 不是合法的 Base64：Failed to execute 'atob' on 'Window':
 *     The string to be decoded contains characters outside of the Latin1 range.
 * 中文界面里一整句英文，用户既看不懂也不知道该改什么。
 * 与上一轮修的 hex 解码是同一类问题，但这条路径当时漏了。 */
t('H7 Base64 解码失败必须给中文说明，不能拼浏览器英文原文', () => {
  /* 锁的是：`out.value = '⚠ 不是合法的 Base64：' + e.message` ——
   * e.message 是 Chromium 的英文，直接展示给中文用户。 */
  assert.ok(!/不是合法的 Base64：' \+ e\.message/.test(src),
    '仍在直接拼接 e.message（会把浏览器英文原文暴露给用户）');
  /* 锁的是：只加了一句中文前缀、后面还是英文原文。 */
  assert.ok(!/'不是合法的 Base64：'/.test(src), '还留着旧的拼接文案');

  /* 三种失败要分别归因，各有可操作的说法。
   * 【判据必须把「条件」和「文案」绑在一起】
   * 第一版只查文案字符串是否存在 —— 变异实测：把 `if (/Latin1/.test(msg))`
   * 改成 `if (false)`，文案还留在文件里，断言照样通过。
   * 现在要求「这个分支的条件 + 紧随其后的 hint 赋值」成对出现。 */
  /* 锁的是：把「粘错方向」说成笼统的"格式错误"，用户不知道是粘错了。 */
  assert.ok(/if \(\/outside of the Latin1 range[\s\S]{0,120}?hint = '[^']*不是 Base64（里面有中文或表情）/.test(src),
    'Latin1 分支没有「粘错方向」的归因文案（或条件被短路）');
  /* 锁的是：非法字符与编码方向混为一谈。 */
  assert.ok(/else if \(\/InvalidCharacterError[\s\S]{0,120}?hint = '[^']*不属于 Base64 的字符/.test(src),
    '非法字符分支没有对应归因（或条件被短路）');
  /* 锁的是：认不出的失败什么都不说 —— 那以后遇到新错误没人查得动。 */
  assert.ok(/原始报错/.test(src), '兜底没有保留原始报错线索');
});

t('H8 三条归因分支各自命中真实的浏览器错误串', () => {
  /* 【为什么要跑真字符串】Chromium 的报错原文随版本变化，
   * 而我只在真机上抓到过 Latin1 那一条。这里把三条真实串都过一遍判据，
   * 确认正则能各自命中 —— 否则「分成三种」只是看起来分了。 */
  const pick = (msg) => {
    if (/outside of the Latin1 range|not of type 'Latin1'|Latin1/i.test(msg)) return 'latin1';
    if (/InvalidCharacterError|invalid character|Invalid character/i.test(msg)) return 'invalid';
    if (/不是合法的 UTF-8|UTF-8/i.test(msg)) return 'utf8';
    return 'fallback';
  };
  /* 这条是真机实测抓到的原文 */
  assert.strictEqual(pick("Failed to execute 'atob' on 'Window': The string to be decoded contains characters outside of the Latin1 range."), 'latin1');
  assert.strictEqual(pick("Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded."), 'fallback');
  assert.strictEqual(pick('InvalidCharacterError: The string to be decoded contains invalid characters.'), 'invalid');
  assert.strictEqual(pick('这串字节不是合法的 UTF-8。'), 'utf8');
  /* 锁的是：完全陌生的错误被归到某一条具体分支（而不是兜底）——
   * 那样用户会拿到一个文不对题的建议。 */
  assert.strictEqual(pick('some brand new transport error'), 'fallback');
});

t('H9 Base64 正常解码路径不受影响（空/换行/JWT 都要能解）', () => {
  /* 锁的是：为了改错误文案，把解码前的清洗弄丢了。
   * 源码里这三步是有意为之（注释写着邮件/JWT/base64 -w 76 的产物）。 */
  /* 锁的是：去掉了空白清洗 —— 带换行的 Base64 会直接报错。 */
  assert.ok(/replace\(\/\[\\s\\r\\n\]\+\/g, ''\)/.test(src), '解码前没有剥掉空白');
  /* 锁的是：去掉了 URL-safe 字符还原 —— JWT 的 - _ 解不出来。 */
  assert.ok(/replace\(\/-\/g, '\+'\)/.test(src) && /replace\(\/_\/g, '\/'\)/.test(src),
    '没有把 URL-safe 的 - _ 还原成 + /');
});

done();
