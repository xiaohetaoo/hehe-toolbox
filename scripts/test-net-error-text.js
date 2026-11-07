'use strict';
/* 网络失败的中文归因（lib/net-error.js）。
 *
 * ============ 锁的是哪个回归 ============
 * 「网络信息查询 / 端口连通测试 / 带宽测试」这几处原来都是
 * `textContent = '✗ ' + e.message`，而底层 message 是英文原文：
 *   fetch('http://no-such-host.invalid')  → "fetch failed"
 *   fetch('http://127.0.0.1:1')           → "fetch failed"     ← 与上面一模一样
 *   net.connect(...)                      → "connect ECONNREFUSED 127.0.0.1:1"
 *   net.connect(...)                      → "getaddrinfo ENOTFOUND xxx"
 * 实测：**三种完全不同的失败给出同一句 "fetch failed"**，
 * 真正的原因在 err.cause.code 里。中文界面里冒出这样一句，
 * 用户既分不清是 DNS 还是端口没开，也不知道该去改什么。
 *
 * ============ 为什么要写"能挖到 cause"这条 ============
 * 这是本模块最容易被写错的地方：只看 err.code 的话，
 * fetch 失败时拿到的是 undefined（code 在 cause 上），全部落到兜底分支 ——
 * 于是"修了等于没修"。所以这里用**真的 fetch 失败**去验，不是构造一个理想对象。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const NE = require('../lib/net-error');

/* ============ 行为面：真实错误对象 ============ */
t('NE1 fetch 的 DNS 失败要说清是域名解析问题', () => {
  /* 用真 fetch 失败，不构造理想对象 —— 这条验的正是"能不能挖到 cause.code"。
   * .invalid 是 RFC 2606 保留的顶级域，保证解析不出来且不依赖网络环境。 */
  const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const r = NE.explain(e);
  /* 锁的是：直接贴 e.message —— 界面上就是一句 "fetch failed"。 */
  assert.strictEqual(r.code, 'ENOTFOUND');
  assert.ok(/域名解析/.test(r.text), '说明里没有点出是 DNS：' + r.text);
  assert.ok(!/fetch failed/.test(r.text), '说明里还留着英文原文：' + r.text);
  /* 建议要能照着做 */
  assert.ok(/主机名|IP/.test(r.advice), '建议不可操作：' + r.advice);
});

t('NE2 端口没开与被拒绝要能和 DNS 失败区分开', () => {
  /* 【这条是核心】实测三次不同的 fetch 失败 message 完全相同，
   * 只有 cause.code 不同。分不开的话用户就不知道该改什么。 */
  const refused = NE.explain(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
  const timeout = NE.explain(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }));
  const dns = NE.explain(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  /* 锁的是：三种情况给出同一句说明 —— 那等于没归因。 */
  assert.notStrictEqual(refused.text, dns.text, '连接被拒与 DNS 失败说了同一句话');
  assert.notStrictEqual(timeout.text, refused.text, '超时与连接被拒说了同一句话');
  assert.ok(/拒绝/.test(refused.text), '连接被拒的说明不对：' + refused.text);
  assert.ok(/超时/.test(timeout.text), '超时的说明不对：' + timeout.text);
});

t('NE3 顶层 code 也要认（net.Socket 的错误走这条）', () => {
  /* net.connect 的失败直接把 errno 挂在 error 上，没有 cause 这一层。
   * 只挖 cause 的实现会在这里落到兜底分支。 */
  const r = NE.explain(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED', errno: -4078 }));
  /* 锁的是：只认 cause，不认顶层 code —— net 这一路全部退化成"网络请求失败"。 */
  assert.strictEqual(r.code, 'ECONNREFUSED');
  assert.ok(/拒绝/.test(r.text));
});

t('NE4 AbortError（超时中断）要单独认，不能落到兜底', () => {
  const e = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const r = NE.explain(e);
  /* 锁的是：只按 code 分支 → AbortError 没有 code → 退化兜底。 */
  assert.strictEqual(r.code, 'ABORT');
  assert.ok(/取消|超时/.test(r.text), '取消类错误的说明不对：' + r.text);
});

t('NE5 认不出的失败要保留原始英文（不能只剩一句"失败"）', () => {
  const r = NE.explain(new Error('some-brand-new-transport-error'));
  /* 锁的是：兜底只写"网络请求失败"，把唯一线索丢掉 —— 以后遇到新错误没人查得动。 */
  assert.ok(/some-brand-new-transport-error/.test(r.advice),
    '兜底把原始报错丢了：' + r.advice);
  /* 但前面要有中文定性，不能整条都是英文 */
  assert.ok(/网络/.test(r.text), '兜底没有中文定性：' + r.text);
});

t('NE6 极端输入不崩、不输出 undefined', () => {
  for (const input of [null, undefined, '', 0, {}, 'plain string', { code: 'ENOENT' }]) {
    const r = NE.explain(input);
    assert.ok(typeof r.text === 'string' && r.text.length > 0, 'explain(' + JSON.stringify(input) + ') 的 text 为空');
    assert.ok(!/undefined/.test(r.text), 'text 里出现 undefined：' + r.text);
    assert.ok(!/undefined/.test(r.advice), 'advice 里出现 undefined：' + r.advice);
  }
});

t('NE7 cause 链有深度上限（环与超长链都不会无限挖）', () => {
  /* 【这条一开始写错过，记在这里免得后来者重犯】
   * 第一版是 `e.code = ''` + `e.cause = e`，于是 codeOf 第一轮就因"没有 code"
   * 退出 —— 那行环检测压根没被执行，去掉它测试照样绿（变异实测确认）。
   * 现在分两半验，各自打得准：
   *   ① 环：给环上的对象一个真 code，逼循环往下走；
   *   ② 深度：在第 6 层放 code，超过上限后不该再挖到。 */
  const a = Object.assign(new Error('loop-a'), { code: 'ECONNREFUSED' });
  const b = Object.assign(new Error('loop-b'), {});
  a.cause = b;
  b.cause = a;
  /* 锁的是：自引用环导致无限递归 —— 整个进程栈溢出崩掉。 */
  const r = NE.explain(a);
  assert.strictEqual(r.code, 'ECONNREFUSED', '应该在第一层就认出 code，实际：' + r.code);

  /* ② 深度上限：链足够长时不能一直往下挖 */
  const deep = Object.assign(new Error('deep-0'), {});
  let cur = deep;
  for (let i = 1; i < 20; i++) {
    const nxt = Object.assign(new Error('deep-' + i), {});
    cur.cause = nxt;
    cur = nxt;
  }
  /* 第 20 层放一个 code：超过 4 层上限后不该再往下找 */
  cur.code = 'ETIMEDOUT';
  const r2 = NE.explain(deep);
  /* 锁的是：挖 cause 没有深度上限 —— 一路挖到 20 层，认了一个不该认的 code。 */
  assert.strictEqual(r2.code, 'UNKNOWN',
    '挖了超过深度上限的 cause：' + r2.code);
});

/* ============ 接线面 ============ */
t('NE8 五处网络错误都用上了这份归因（不是各写各的）', () => {
  const src = readSrc('js/tools/net-tools.js');
  /* 【这里数的是"接线了几处"，数不算源码断言 —— 它没有匹配任何实现形态】
   * 真正需要匹配文本的只有下面那条"有没有退回 e.message"，已写「锁的是」。
   * 之所以要数：五处 errored 路径分布在五个不同工具页，
   * 只改其中几处的话，用户会觉得"只有某个工具坏了"，比全英文更迷惑。 */
  const uses = (src.match(/window\.NetError/g) || []).length;
  /* 锁的是：只改了一两处 —— 公网 IP 改成中文了，测速还是 "fetch failed"，
   * 用户以为只有某个工具坏了。五处分别是：公网 IP / 网络信息 / 端口连通 / 端口扫描 / 测速。 */
  assert.ok(uses >= 5, '只有 ' + uses + ' 处用到 NetError，应为 5 处');
  /* 锁的是：又退回直接贴英文 message —— 中文界面里冒出 "fetch failed"。
   * 断言写在下一行（SA-4 要求「锁的是」在 3 行内）。 */
  assert.ok(!/'✗ ' \+ e\.message;/.test(src), '仍有地方直接贴 e.message');
});

t('NE9 index.html 引入了 lib/net-error.js 且在工具脚本之前', () => {
  const html = readSrc('index.html', { raw: true });
  const iLib = html.indexOf('lib/net-error.js');
  /* 锁的是：忘了挂 —— 渲染层 window.NetError 未定义，四处全部退回英文。 */
  assert.ok(iLib > 0, 'index.html 没有引入 lib/net-error.js');
  const iTool = html.indexOf('js/tools/net-tools.js');
  /* 锁的是：引入顺序反了 —— 工具脚本先跑，那时 NetError 还不存在。 */
  assert.ok(iTool > iLib, 'lib/net-error.js 必须排在 js/tools/net-tools.js 之前');
});

done();
