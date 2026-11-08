'use strict';
/* 标签页保活（keep-alive）的契约测试。
 *
 * ============ 锁的是哪个回归 ============
 * 用户原话：「切换标签页再回到原标签页东西怎么全没了」。
 * 根因：renderContent() 每次切页都 `contentEl.innerHTML = ''` 然后整页重建。
 * 于是「文本统计」里粘好的几千字、JSON 格式化后的结果、已选好的文件列表，
 * 切走再切回来**全部回到刚打开的样子**。
 *
 * 这一轮改成：工具页的整个 .page 节点被保活，切回来原样贴回去。
 *
 * 【为什么这些用源码断言】
 * 行为验证需要真实 Electron 渲染进程（已用 CDP 真机验过三种场景：
 * 单标签保活 / 多标签互不干扰 / 关闭重开无幽灵）。
 * 但 CI 上跑不了真机交互，所以把**不变量**用源码钉住 ——
 * 每一条对应的都是本轮真踩过的坑，不是假设出来的风险。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const SRC = readSrc('js/app.js');

/* 锁的是回归「切页把整页清空，用户内容全丢」。 */
t('KA-1 工具页必须走保活复用路径（不是每次都重建）', () => {
  /* 锁的是：有人把保活逻辑删掉/绕过，退回"每次 innerHTML=''"。
   * 判据是 renderContent 里同时存在"复用判断"和"贴回旧节点"两个动作。 */
  const i = SRC.indexOf('function renderContent()');
  assert.ok(i > 0, '找不到 renderContent');
  const seg = SRC.slice(i, i + 2600);
  /* 锁的是：复用判断被删掉（切回来会整页重建，用户内容全丢）。 */
  assert.ok(/pageKey && keepAlive\.has\(pageKey\)/.test(seg),
    'renderContent 里没有保活复用判断 —— 切回来会重建，用户输入与结果全丢');
  /* 锁的是：判断还在、但贴回旧节点那一步没了（保活等于没做）。 */
  assert.ok(/contentEl\.appendChild\(rec\.el\)/.test(seg),
    '复用路径没有把旧 page 节点贴回去 —— 保活等于没做');
});

/* 锁的是「关了标签，内容还在内存里，重新打开变成幽灵」。
 * 这是保活最典型的副作用，实测踩过：关掉「文本统计」再打开，
 * 里面还留着上次输入的字。 */
t('KA-2 关闭标签时必须同步丢弃它的保活页', () => {
  /* 锁的是：closeTab 只从 state.tabs 里删，忘了 keepAlive.delete ——
   * 后果是重新打开同一工具会看到上次的残留内容。 */
  const i = SRC.indexOf('function closeTab(');
  assert.ok(i > 0, '找不到 closeTab');
  const seg = SRC.slice(i, i + 900);
  /* 锁的是：关标签只删 state.tabs、忘了删保活页（重开变成幽灵）。 */
  assert.ok(/keepAlive\.delete\('tool:' \+ toolId\)/.test(seg),
    'closeTab 没有删保活页 —— 重开同一工具会看到幽灵内容');
});

/* 锁的是本轮最隐蔽的一个 bug：快照存错了对象。
 * renderContent 执行时 state.view 已经是**新**页面了，
 * 若用 state.view 判断"要存哪一页"，会把旧 DOM 存进新工具的槽位，
 * 于是切回该工具时贴出来的是上一个页面的内容（实测：工具页显示成首页）。 */
t('KA-3 快照必须用「上一个视图」，不能用 state.view', () => {
  /* 锁的是：把 prevView 改回 state.view。这一条对应的坑已经真实发生过一次，
   * 表现是"切回来看到的是别的页面的内容"，比不保活更难查。 */
  assert.ok(/snapshotCurrentPage\(prevView && prevView\.type, prevView && prevView\.toolId\)/.test(SRC),
    'snapshotCurrentPage 没有用 prevView —— 会把旧页面的 DOM 存进新工具的槽位');
  /* showView 必须在改 state.view 之前留一份 prevView */
  const i = SRC.indexOf('function showView(');
  const seg = SRC.slice(i, i + 500);
  const prevPos = seg.indexOf('prevView = state.view');
  const setPos = seg.indexOf('state.view = view');
  assert.ok(prevPos >= 0, 'showView 没有记录 prevView');
  assert.ok(prevPos < setPos, 'prevView 必须在 state.view 赋值之前记录，否则拿到的是新值');
});

/* 锁的是「保活把切页清理也一起废掉」。
 * 本项目刻意修过「长任务切页不停」（v0.6.6 问题 11），
 * 保活不能把它退回去：切走就该停后台任务。 */
t('KA-4 保活不得取消切页清理（长任务该停还得停）', () => {
  /* 锁的是：为了让"保活更彻底"而注释掉 runPageCleanup ——
   * 那会让所有页面的定时器在后台一直跑，是已修过的回归。 */
  const i = SRC.indexOf('function renderContent()');
  const seg = SRC.slice(i, i + 2600);
  /* 锁的是：为了让保活更彻底而注释掉 runPageCleanup（定时器全在后台跑）。 */
  assert.ok(/runPageCleanup\(\)/.test(seg),
    'renderContent 里没有 runPageCleanup —— 切页不再停后台任务（v0.6.6 修过的回归）');
});

/* 锁的是「保活表无上限增长」。
 * 每个保活页都带着完整 DOM，截图/OCR 这类工具一页可能几十 MB。 */
t('KA-5 保活必须有上限并做 LRU 淘汰', () => {
  /* 锁的是：把 KEEPALIVE_MAX 去掉或把淘汰逻辑删了 ——
   * 开 20 个标签后内存持续上涨。 */
  /* 锁的是：KEEPALIVE_MAX 常量与淘汰逻辑被整体删掉。
   * 【注意】它现在是 let（可按设置调整），所以这里只要求"有声明"，
   * 具体区间与可调性由 KA-8 单独锁。 */
  assert.ok(/let KEEPALIVE_MAX = \d+;/.test(SRC), '没有 KEEPALIVE_MAX 上限变量');
  /* 锁的是：淘汰逻辑被删（保活表无限增长，内存一路涨）。 */
  assert.ok(/while \(keepAlive\.size > KEEPALIVE_MAX\) evictOne\(\)/.test(SRC),
    '超出上限时没有淘汰 —— 保活表会无限增长');
  /* 锁的是：evictOne 实现被删掉（上面的 while 会抛 ReferenceError）。 */
  assert.ok(/function evictOne\(\)/.test(SRC), '没有 evictOne 实现');
  /* 淘汰的确不能留下被丢页面的后台任务 —— 但那件事由切页时的
   * runPageCleanup 保证（见 KA-4），不在淘汰这一侧重复做。 */
  const i = SRC.indexOf('function evictOne()');
  const seg = SRC.slice(i, i + 900);
  /* 【这条断言曾经把缺陷锁反了】
   * 第一版写的是「淘汰前必须 runPageCleanup()」，理由是"不留后台任务"。
   * 但页面在用户切走的那一刻就已经清过了；pageCleanupFns 是全局队列，
   * 装的是**当前页**的清理函数。淘汰时再调一次，拆掉的是当前页的定时器 ——
   * 开第 7 个标签时，第 7 个工具刚起来的轮询会立刻消失。
   * 只能用源码断言：验的是"有没有调用某个函数"这一实现形态；
   * 行为上验要开 7 个标签再观察轮询被掐，噪声大于信号。
   * 锁的是：evictOne 里调 runPageCleanup —— 它清的是当前页而非被淘汰页。 */
  assert.ok(!/runPageCleanup\(\)/.test(seg),
    'evictOne 里调了 runPageCleanup —— 它清的是当前页，不是被淘汰页（会掐掉当前页的定时器）');
});

/* 锁的是回归「只保活了输入框，结果区还是丢」。
 * 第一版就是"重建 + 回填表单值"，实测不够：JSON 格式化后的结果、
 * 正则匹配列表、已选文件列表都是运行时生成的 DOM，回填值恢复不了。 */
t('KA-6 保活的必须是整个 page 节点（不能只存表单值）', () => {
  /* 锁的是：把保活退化成"存 values 数组再回填" ——
   * 那会丢掉运行结果，而用户要的正是"东西还在"。 */
  assert.ok(/el: page,/.test(SRC), '保活记录里没有保存 page 节点');
  const i = SRC.indexOf('function keepAlivePage(');
  const seg = SRC.slice(i, i + 700);
  /* 锁的是：keepAlivePage 改成只存值、不存节点。 */
  assert.ok(/el: page/.test(seg), 'keepAlivePage 没有把 page 节点存进去');
});

/* 锁的是本轮真踩到的第二个坑：切语言后保活页冒出旧语言。
 *
 * 根因：applyLangLabels 里 `document.body.innerHTML = ''` 重建整壳，
 * 但保活表还引用着**已经渲染好的旧节点**（文案在渲染那一刻就定死了）。
 * 切回工具页原样贴回去，于是英文界面里出现中文页面。
 * 实测 test-tool-i18n-e2e 的「二维码」「哈希」两条直接红：
 *   二维码页英文模式下仍有中文：["内容","二维码","保存 PNG",…]
 *
 * 【为什么用源码断言】触发它需要"先开工具页 → 切英文 → 切回工具页"，
 * 而这条链路在 CI 上跑不了真机交互（test-tool-i18n-e2e 是 e2e，
 * 本机 9 个环境跳过里就包含同类）。源码顺序断言是稳定的那道门。 */
t('KA-7 切语言重建外壳时必须清空保活表（否则冒出旧语言页面）', () => {
  /* 锁的是：applyLangLabels 里 body.innerHTML='' 之前没有 keepAlive.clear() */
  const i = SRC.indexOf('function applyLangLabels()');
  assert.ok(i > 0, '找不到 applyLangLabels');
  const seg = SRC.slice(i, i + 2200);
  const clearPos = seg.indexOf('keepAlive.clear()');
  const wipePos = seg.indexOf("document.body.innerHTML = ''");
  /* 锁的是：clear 被删掉（回归会立刻重现）。 */
  assert.ok(clearPos >= 0,
    'applyLangLabels 没有清空保活表 —— 切语言后保活页会显示旧语言');
  /* 锁的是：clear 写在 body 清空之后 —— 那时节点已经游离，清了也晚了
   * （实际上 clear 必须在重建之前，否则重建过程中贴回去的仍是旧节点）。 */
  assert.ok(wipePos < 0 || clearPos < wipePos,
    'keepAlive.clear() 必须在 document.body.innerHTML 清空之前');
});

/* 锁的是「上限写死，用户改不了」。
 * 用户明确要求：上限可在设置里调，1~10。
 * 这是纯偏好（保状态 vs 省内存），没有唯一正确值，所以必须可调。
 *
 * 【为什么用源码断言而不是行为断言】
 * 行为验证要开真机设置页、改下拉框、再数保活表大小 ——
 * CI 上跑不了（同类 e2e 在本机有 9 个环境跳过）。
 * 这里锁的是三件事：区间常量、夹取逻辑、以及"改小后立刻生效"。 */
t('KA-8 保活上限必须可在 1~10 之间调整，且能立刻生效', () => {
  /* 锁的是：区间常量被改掉（用户要求的是 1 最少、10 最多）。 */
  assert.ok(/const KEEPALIVE_MIN = 1;/.test(SRC), '下限必须是 1');
  assert.ok(/const KEEPALIVE_MAX_LIMIT = 10;/.test(SRC), '上限必须是 10');
  /* 锁的是：KEEPALIVE_MAX 退回 const（设置页就再也改不动它了）。 */
  assert.ok(/let KEEPALIVE_MAX = \d+;/.test(SRC),
    'KEEPALIVE_MAX 必须是 let —— 写成 const 后设置页改了也不生效');
  /* 锁的是：没有夹取函数（用户手工把配置改成 999 会一次性吃掉全部内存）。 */
  assert.ok(/function applyKeepAliveLimit\(/.test(SRC), '缺少 applyKeepAliveLimit');
  const i = SRC.indexOf('function applyKeepAliveLimit(');
  const seg = SRC.slice(i, i + 900);
  /* 锁的是：夹取只做一半（只限上限不限下限，0 或负数会直接清空保活）。 */
  assert.ok(/if \(n < KEEPALIVE_MIN\) n = KEEPALIVE_MIN;/.test(seg), '没有夹下限');
  assert.ok(/if \(n > KEEPALIVE_MAX_LIMIT\) n = KEEPALIVE_MAX_LIMIT;/.test(seg), '没有夹上限');
  /* 锁的是：改小后不立刻淘汰 —— 用户会以为设置没生效。 */
  assert.ok(/while \(keepAlive\.size > KEEPALIVE_MAX\) evictOne\(\)/.test(seg),
    'applyKeepAliveLimit 里没有立刻淘汰，调小上限要等下次切页才生效');
});

/* 锁的是「设置项只写不读」：存进去了，但启动时没读，等于永远用默认值。 */
t('KA-9 启动时必须读取并应用保活上限设置', () => {
  /* 锁的是：只在设置页写、启动时不读（改完重启又回 6）。
   * 【为什么遍历所有出现点】'settings.keepAlive' 在源码里有**两处**读取：
   *   ① 设置页（把当前值填进下拉框）
   *   ② 启动流程（应用上限）
   * 只查第一处会误判为"已经有读取了"。所以要把每处都看一遍，
   * 要求**存在一处**后面紧跟着 applyKeepAliveLimit(kaLimit)。 */
  const needle = "STORE.GET, 'settings.keepAlive', 6";
  let from = 0, found = false, count = 0;
  for (;;) {
    const i = SRC.indexOf(needle, from);
    if (i < 0) break;
    count++;
    const seg = SRC.slice(i, i + 400);
    /* 锁的是：读到了值却没有应用它（等于没用）。 */
    if (/applyKeepAliveLimit\(kaLimit\)/.test(seg)) found = true;
    from = i + needle.length;
  }
  assert.ok(count >= 2, 'settings.keepAlive 至少应在设置页与启动流程各读一次，实际 ' + count + ' 处');
  assert.ok(found,
    '没有任何一处读取后调用了 applyKeepAliveLimit —— 启动时不会应用该设置，改了重启就丢');
});

done();
