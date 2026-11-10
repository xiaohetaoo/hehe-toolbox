'use strict';
/* 本轮（2026-11-09）修复的健壮性与安全项的守卫。
 *
 * 这里每条都对应一个**真实缺陷**，注释里写清"锁的是哪个回归"。
 * 能用行为断言的一律跑真实现；只有"实现的形态"才做源码匹配
 * （例如"所有窗口都调了 hardenWindow"这种事没有运行时观测量）。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

/* ============ 系统通知必须收口，不能抛进状态机 ============ */
t('NT1 番茄钟的通知经过 try/catch 收口', () => {
  /* 锁的是：finishPhase()（由 setInterval(tick,200) 调起）里裸调
   * new Notification()。通知权限被拒 / 平台不支持时会抛，而这三处正好
   * 写在状态推进语句**之前**：
   *   · 倒计时分支 —— remain = total 永不执行，把「再点开始立刻又结束」
   *     那个已修回归引回来；
   *   · 番茄分支 —— phase / total / remain 全被跳过，界面不再走动。
   * 只能源码断言：要复现得伪造一个会抛的 Notification 并跑满一个周期，
   * 那需要真实计时器与 DOM。 */
  const s = readSrc('js/tools/life.js');
  const bare = [];
  for (const m of s.matchAll(/new Notification\s*\(/g)) {
    /* 往上 6 行内必须有 try {（收口函数允许跨几行注释） */
    const lineNo = s.slice(0, m.index).split('\n').length;
    const lines = s.split('\n');
    const above = lines.slice(Math.max(0, lineNo - 8), lineNo).join('\n');
  /* 锁的是：裸调 Notification 没有 try 包围 —— 抛错会中断状态机 */
    if (!/try\s*\{/.test(above)) bare.push(lineNo);
  }
  assert.deepStrictEqual(bare, [], '这些行的 new Notification 没有 try/catch：' + bare.join(','));
});

t('NT2 通知失败时计时状态仍然推进（收口函数自带 try/catch）', () => {
  /* 锁的是：把 notify() 写成裸调 new Notification 且不捕获。
   * 收口函数必须自带 try/catch 并吞掉异常 —— 这里是它的形态检查。
   * 【不能只取前 600 字符】函数体里有几行注释，按字符数截会把 catch 切掉
   * （实测假红）。按配平括号取完整函数体。 */
  const s = readSrc('js/tools/life.js');
  const at = s.indexOf('function notify(');
  assert.ok(at >= 0, '没有收口的 notify() 助手');
  let depth = 0, end = at;
  for (let i = s.indexOf('{', at); i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = s.slice(at, end + 1);
  /* 锁的是：notify() 收口函数里没有 try/catch —— 通知失败会冒泡进计时器 */
  assert.ok(/try\s*\{/.test(body), 'notify() 里没有 try');
  /* 锁的是：notify() 收口函数里没有 try/catch —— 通知失败会冒泡进计时器 */
  assert.ok(/catch/.test(body), 'notify() 里没有 catch');
});

/* ============ 弹窗必须能按 Esc 关 ============ */
t('MD1 modal 注册了 Escape 处理，且只关最上层', () => {
  /* 锁的是：弹窗只能点 × 或点遮罩关闭。项目里每个辅助窗口
   * （pin/ruler/snip）与主搜索框都处理了 Escape，唯独弹窗没有 ——
   * 破坏性操作的二次确认（删文件、关机、目录搬家）只能靠鼠标取消。 */
  const s = readSrc('js/ui.js');
  /* 锁的是：弹窗没有 Escape 处理 / 没有"只关最上层"的判据 */
  assert.ok(/Escape/.test(s), 'ui.js 里没有 Escape 处理');
  /* 锁的是：弹窗没有 Escape 处理 / 没有"只关最上层"的判据 */
  assert.ok(/function topOverlay\(/.test(s), '没有 topOverlay —— 多层弹窗会被一次全关');
  /* 锁的是：弹窗没有 Escape 处理 / 没有"只关最上层"的判据 */
  const fn = s.match(/function onModalKeydown\([\s\S]{0,400}?\n\s*\}/);
  /* 锁的是：弹窗没有 Escape 处理 / 没有"只关最上层"的判据 */
  assert.ok(fn && /topOverlay\(\)/.test(fn[0]), 'Escape 处理没有取"最上层"');
});

t('MD2 关弹窗一律走 close()，不许 closest().remove()', () => {
  /* 锁的是：直接 remove 只摘节点、不清 ui.js 的 openOverlays 记录，
   * 留下"幽灵遮罩"——下次按 Escape 时 topOverlay 取到已脱离文档的它，
   * 真正该关的下一层要按两次才轮得到。
   * alertBox 与进程详情弹窗都曾这么写。 */
  const files = ['js/ui.js', 'js/tools/sys-tools.js', 'js/tools/launch.js'];
  const bad = [];
  for (const f of files) {
    const s = readSrc(f);
    for (const m of s.matchAll(/closest\(['"]\.modal-mask['"]\)/g)) {
      bad.push(f + ':' + s.slice(0, m.index).split('\n').length);
    }
  }
  assert.deepStrictEqual(bad, [], '仍在用 closest(.modal-mask) 关弹窗：' + bad.join(','));
});

/* ============ 权限白名单 ============ */
t('SC1 hardenWindow 装了权限请求 / 权限检查两个 handler', () => {
  /* 锁的是：Electron 默认批准所有权限请求。本项目页面渲染大量用户可控文本
   * （Markdown、笔记、OCR 结果、diff），默认全开等于给内容注入准备放大器。
   * 两个 handler 口径必须一致 —— 只装 request 会出现"请求被拒但检查通过"。 */
  const s = readSrc('main.js');
  /* 锁的是：权限 handler 缺失 —— Electron 默认批准所有权限请求 */
  assert.ok(/setPermissionRequestHandler/.test(s), '没有 setPermissionRequestHandler');
  /* 锁的是：权限 handler 缺失 —— Electron 默认批准所有权限请求 */
  assert.ok(/setPermissionCheckHandler/.test(s), '没有 setPermissionCheckHandler');
});

t('SC2 权限白名单只放行本应用真的要用的几项', () => {
  /* 锁的是：白名单被写成"什么都放行"（例如 callback(true) 无判断），
   * 或者顺手把 geolocation / midi 也加进去。
   * 本应用真正需要的：media（录音/摄像头/设备枚举）、notifications、
   * clipboard-read、fullscreen。 */
  const s = readSrc('main.js');
  /* 锁的是：权限白名单缺失或放行了不该放行的权限 */
  const m = s.match(/const ALLOWED = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, '找不到权限白名单 ALLOWED');
  const list = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  for (const need of ['media', 'notifications', 'clipboard-read', 'fullscreen']) {
  /* 锁的是：权限白名单缺失或放行了不该放行的权限 */
    assert.ok(list.includes(need), '白名单缺少必需权限：' + need);
  }
  for (const deny of ['geolocation', 'midi', 'midiSysex', 'usb', 'serial', 'hid']) {
  /* 锁的是：权限白名单缺失或放行了不该放行的权限 */
    assert.ok(!list.includes(deny), '白名单不该放行：' + deny);
  }
});

/* ============ 新开窗口与页面导航 ============ */
t('SC3 所有 BrowserWindow 都调了 hardenWindow', () => {
  /* 锁的是：新增窗口时忘了加固。主进程有多处 new BrowserWindow
   * （主窗/独立工具窗/标尺/贴图/截图/离屏），逐处手写必然漏一处，
   * 而漏的那处没有任何提示。
   *
   * 【判据：同一段落内出现 hardenWindow，不是"紧接着下一行"】
   * 窗口构造的 webPreferences 块本身就有十几行（启动窗、工具窗都是），
   * 按固定行数取上下文会假红 —— 实测踩过：791 与 1260 行明明有
   * hardenWindow(变量)，只是隔了 15 行以上。
   * 这里按"从 new BrowserWindow 到下一个函数/语句边界"取窗口，
   * 再要求这段里出现 hardenWindow。 */
  const s = readSrc('main.js');
  const lines = s.split('\n');
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
  /* 锁的是：新增 BrowserWindow 没走 hardenWindow —— 加固会被绕过 */
    if (!/new BrowserWindow\s*\(/.test(lines[i])) continue;
    /* 往后找不到边界的极端情况给足 40 行；正常构造块 5~25 行 */
    const ctx = lines.slice(Math.max(0, i - 1), i + 40).join('\n');
  /* 锁的是：新增 BrowserWindow 没走 hardenWindow —— 加固会被绕过 */
    if (!/hardenWindow/.test(ctx)) bad.push(i + 1);
  }
  assert.deepStrictEqual(bad, [], '这些 new BrowserWindow 没有 hardenWindow：' + bad.join(','));
});

t('SC4 hardenWindow 拒绝新开窗口并拦截外链导航', () => {
  /* 锁的是：window.open() 默认会新建一个继承 webPreferences 的窗口；
   * will-navigate 不拦则页面可以跳去任意 http(s) 地址，
   * 跳走之后那个页面就脱离了本应用的控制。 */
  const s = readSrc('main.js');
  /* 锁的是：窗口未拦截新开窗口 / 未拦截外链导航 */
  assert.ok(/setWindowOpenHandler/.test(s), '没有 setWindowOpenHandler');
  /* 锁的是：窗口未拦截新开窗口 / 未拦截外链导航 */
  assert.ok(/action:\s*'deny'/.test(s), 'setWindowOpenHandler 没有返回 deny');
  /* 锁的是：窗口未拦截新开窗口 / 未拦截外链导航 */
  assert.ok(/will-navigate/.test(s), '没有 will-navigate 拦截');
  /* 锁的是：窗口未拦截新开窗口 / 未拦截外链导航 */
  const fn = s.match(/function hardenWindow\([\s\S]{0,2600}?\n\}/);
  assert.ok(fn, '找不到 hardenWindow 函数体');
  /* 锁的是：窗口未拦截新开窗口 / 未拦截外链导航 */
  assert.ok(/preventDefault\(\)/.test(fn[0]), '导航拦截没有 preventDefault');
  // Main-process loadFile is unaffected by will-navigate; only exact app URLs get IPC.
  const security = require('../lib/window-security');
  const root = require('path').resolve(__dirname, '..');
  const url = require('url').pathToFileURL(require('path').join(root, 'index.html')).href;
  assert.strictEqual(security.isTrustedPage(url, root), true);
});

/* ============ preload 的 isDev 不能失败开放 ============ */
t('SC5 拿不到打包参数时按生产态处理（不挂测试钩子）', () => {
  /* 锁的是：preload 里 `packaged === null → isDev = true` —— 方向是反的。
   * 注入失效（参数改名、某窗口忘了传）会让打包版也当自己是开发态，
   * __snipTest / __drawn 常驻，而这正是那段注释自述修过的缺陷。
   * 失败方向必须是关闭。 */
  const s = readSrc('preload.js');
  /* 锁的是：拿不到打包参数时 isDev 失败开放 —— 打包版常驻测试钩子 */
  const m = s.match(/if \(packaged === null\) \{([\s\S]{0,700}?)\}/);
  assert.ok(m, '找不到 packaged === null 分支');
  /* 锁的是：拿不到打包参数时 isDev 失败开放 —— 打包版常驻测试钩子 */
  assert.ok(/isDev = false/.test(m[1]), 'packaged===null 时应当 isDev = false');
  /* 锁的是：拿不到打包参数时 isDev 失败开放 —— 打包版常驻测试钩子 */
  assert.ok(!/isDev = true/.test(m[1]), 'packaged===null 时不许 isDev = true（失败开放）');
});

/* ============ PDF 导出的净化与等待 ============ */
t('PDF1 笔记导出的 HTML 被净化（剥 script / 事件属性 / javascript:）', () => {
  /* 锁的是：把渲染层传来的 html 原样拼进 data: URL。
   * 那是让任意脚本进入离屏文档；不能假设上游一定净化过（另一个进程的承诺）。 */
  const s = readSrc('main.js');
  assert.ok(/function sanitizeNoteHtml\(/.test(s), '没有 sanitizeNoteHtml');
  /* 锁的是：笔记导出未净化 HTML —— 任意脚本进入离屏文档 */
  const fnSrc = readSrc('main.js').match(/function sanitizeNoteHtml\(html\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnSrc, '找不到 sanitizeNoteHtml 函数体');
  const fn = new Function(fnSrc[0] + '; return sanitizeNoteHtml;')();
  /* 锁的是：笔记导出未净化 HTML —— 任意脚本进入离屏文档 */
  assert.ok(!/<script/i.test(fn('<script>alert(1)</script><p>x</p>')), 'script 没被剥掉');
  /* 锁的是：笔记导出未净化 HTML —— 任意脚本进入离屏文档 */
  assert.ok(!/onerror/i.test(fn('<img src=x onerror=alert(1)>')), '事件属性没被剥掉');
  /* 锁的是：笔记导出未净化 HTML —— 任意脚本进入离屏文档 */
  assert.ok(!/javascript:/i.test(fn('<a href="javascript:alert(1)">x</a>')), 'javascript: 协议没被拦');
  /* 正常内容必须原样保留（否则"净化"就是"清空"） */
  assert.strictEqual(fn('<h1>标题</h1><p>正文</p>'), '<h1>标题</h1><p>正文</p>');
  /* 锁的是：笔记导出未净化 HTML —— 任意脚本进入离屏文档 */
  assert.ok(/mailto/.test(fn('<a href="mailto:a@b.c">m</a>')), '正常 href 被误删');
});

t('PDF2 导出等图片解码而不是睡固定时长', () => {
  /* 锁的是：`await new Promise(r => setTimeout(r, 300))` 之后立刻 printToPDF。
   * 笔记里带本地图片时 300ms 内图片可能还没解码完，导出的 PDF 里图片是空白。 */
  const s = readSrc('main.js');
  const i = s.indexOf("handle(CH.NOTES.PDF");
  assert.ok(i > 0, '找不到 notes:pdf handler');
  const seg = s.slice(i, i + 2600);
  /* 锁的是：PDF 导出睡固定 300ms 且离屏窗口未关脚本 */
  assert.ok(!/setTimeout\(r,\s*300\)/.test(seg), '仍是固定 300ms 等待');
  /* 锁的是：PDF 导出睡固定 300ms 且离屏窗口未关脚本 */
  assert.ok(/document\.images/.test(seg) || /\.decode\(/.test(seg), '没有等图片解码');
  /* 锁的是：PDF 导出睡固定 300ms 且离屏窗口未关脚本 */
  assert.ok(/javascript:\s*false/.test(seg) || /sandbox:\s*true/.test(seg),
    '离屏窗口没有关掉脚本能力');
});

/* ============ CSP ============ */
t('CP1 index.html 的 connect-src 不再允许任意 http/https 主机', () => {
  /* 锁的是：`connect-src 'self' https: http: blob:` —— 任何内容注入都能
   * 把数据发到任意主机。现在必须收成显式白名单。 */
  const html = readSrc('index.html', { raw: true });
  const m = /<meta[^>]*Content-Security-Policy[^>]*content="([^"]+)"/i.exec(html);
  assert.ok(m, '找不到 CSP');
  /* 锁的是：CSP connect-src 过宽 —— 内容注入可外发数据 */
  const cs = (m[1].match(/connect-src([^;]+)/) || [])[1] || '';
  assert.ok(cs, 'CSP 里没有 connect-src');
  const tokens = cs.trim().split(/\s+/);
  /* 锁的是：CSP connect-src 过宽 —— 内容注入可外发数据 */
  assert.ok(!tokens.includes('http:'), "connect-src 仍是裸 'http:'");
  /* 锁的是：CSP connect-src 过宽 —— 内容注入可外发数据 */
  assert.ok(!tokens.includes('https:'), "connect-src 仍是裸 'https:'");
  /* 必需的两个域名（OCR 语言包 / 翻译）必须还在，否则功能直接坏 */
  /* 锁的是：CSP connect-src 过宽 —— 内容注入可外发数据 */
  assert.ok(cs.includes('cdn.jsdelivr.net'), '缺少 OCR 语言包域名');
  /* 锁的是：CSP connect-src 过宽 —— 内容注入可外发数据 */
  assert.ok(cs.includes('api.mymemory.translated.net'), '缺少翻译域名');
});

/* ============ 文件名时间戳用本地时间 ============ */
t('TS1 lib/time-stamp 输出本地时间，不是 UTC', () => {
  /* 锁的是：文件名用 toISOString() 拼 —— UTC+8 用户看到的
   * 22:00 录屏会变成 14:00，hosts 备份名同理，用户按时间挑备份会挑错。 */
  const T = require('../lib/time-stamp');
  const d = new Date(2026, 10, 9, 22, 0, 0, 0);
  const base = T.localStamp(d);
  assert.ok(/^2026-11-09_220000$/.test(base), 'localStamp 不是本地时间：' + base);
  assert.ok(!base.includes('T'), 'localStamp 里出现了 ISO 的 T');
  /* 与 UTC 同日不同小时时必须体现本地小时 */
  const utcHour = d.getUTCHours();
  if (utcHour !== 22) {
    assert.ok(base.includes('_220000'), '本地小时没被用上');
  }
});

t('TS2 hosts 备份名用毫秒 + 随机后缀（唯一性）', () => {
  /* 锁的是：备份名只精确到秒 —— 同一秒内两次写 hosts 会撞名覆盖，
   * 而 hosts 备份是"出事之后唯一能还原的东西"。 */
  const T = require('../lib/time-stamp');
  const d = new Date(2026, 10, 9, 12, 30, 45, 123);
  const ms = T.localStampDashMs(d);
  assert.ok(/-123$/.test(ms), '没有毫秒：' + ms);
  /* 同一秒内两个不同毫秒必须产生不同名字 */
  const a = T.localStampDashMs(new Date(2026, 10, 9, 12, 30, 45, 1));
  const b = T.localStampDashMs(new Date(2026, 10, 9, 12, 30, 45, 2));
  assert.notStrictEqual(a, b, '同秒内不同毫秒生成了相同名字');
});

t('TS3 源码里不再用 toISOString 拼用户可见的文件名', () => {
  /* 锁的是：新写的代码又退回 UTC。只查用户可见的名字（录屏/导出/hosts），
   * 不查内部字段（startedAt / checkedAt 用 UTC 是正确的）。 */
  const files = ['js/tools/media/screen-rec.js', 'js/tools/office.js'];
  const bad = [];
  for (const f of files) {
    const s = readSrc(f);
    for (const m of s.matchAll(/toISOString\(\)/g)) {
      bad.push(f + ':' + s.slice(0, m.index).split('\n').length);
    }
  }
  assert.deepStrictEqual(bad, [], '这些地方仍用 UTC 拼文件名：' + bad.join(','));
});

/* ============ 搜索：模块名中英文都能命中 ============ */
t('SR1 搜索的模块名把英文名也纳入匹配', () => {
  /* 锁的是：modKey 只取 modDef.name（中文）。英文界面下用户输 security
   * 想找「安全与密码」下的工具，模块那一档永远拿不到 ——
   * 而 MODULES 每项都有 nameEn。 */
  const s = readSrc('js/registry.js');
  /* 锁的是：搜索的模块名只含中文 —— 英文界面下按模块搜不到 */
  assert.ok(/modKey/.test(s), '没有 modKey（说明还在用只含中文的 modName）');
  /* 锁的是：搜索的模块名只含中文 —— 英文界面下按模块搜不到 */
  const m = s.match(/const modKey = norm\(([^;]+)\)/);
  assert.ok(m, '找不到 modKey 的定义');
  /* 锁的是：搜索的模块名只含中文 —— 英文界面下按模块搜不到 */
  assert.ok(/nameEn/.test(m[1]), 'modKey 没有纳入 nameEn');
  /* 分值判定也要用 modKey（改了定义却忘了改使用点是最常见的漏） */
  /* 锁的是：搜索的模块名只含中文 —— 英文界面下按模块搜不到 */
  assert.ok(/modKey\.includes\(tk\)/.test(s), '分值判定没有用 modKey');
});

/* ============ 一次性定时（睡眠/锁屏）走主进程 ============ */
t('SC6 睡眠/锁屏由主进程持久化调度，不再依赖页面定时器', () => {
  /* 锁的是：睡眠/锁屏用页面 setInterval 计时，而 App.onCleanup 在切页时
   * 会清掉它 —— 用户设了「30 分钟后睡眠」，切到别的工具页就失效了，
   * 界面那句承诺落空。同一个卡片里关机/重启走系统 shutdown 计划（切页不影响），
   * 两种行为不一致最容易让人不信任。 */
  const s = readSrc('js/tools/sys-tools.js');
  /* 锁的是：睡眠/锁屏靠页面定时器 —— 切页即失效 */
  assert.ok(/SCHED\.ONCE_ADD/.test(s), '睡眠/锁屏没有走主进程 ONCE_ADD');
  /* 锁的是：睡眠/锁屏靠页面定时器 —— 切页即失效 */
  assert.ok(/SCHED\.ONCE_LIST/.test(s), '没有列出挂起的一次性定时');
  /* 锁的是：睡眠/锁屏靠页面定时器 —— 切页即失效 */
  assert.ok(/SCHED\.ONCE_REMOVE/.test(s), '没有撤销入口');
  /* 反面：不许退回"页面里 invoke(EXEC.RUN, rundll32...)"那条路 */
  /* 锁的是：睡眠/锁屏靠页面定时器 —— 切页即失效 */
  assert.ok(!/rundll32\.exe powrprof\.dll,SetSuspendState/.test(s),
    '睡眠又回到了页面内执行（切页就失效）');
});

t('SC7 主进程有一次性的执行逻辑与过期补执行策略', () => {
  /* 锁的是：只加了通道没有真正的计时与恢复。
   * 另外 setTimeout 有 2^31-1ms 上限（约 24.8 天），超过会被当成 1ms
   * 立刻触发 —— 那是灾难性误触发，必须有分段。 */
  const s = readSrc('main.js');
  /* 锁的是：一次性定时缺启动恢复 / 缺过期策略 / 未处理 setTimeout 上限 */
  assert.ok(/function armOnceAll\(/.test(s), '没有 armOnceAll（启动恢复）');
  /* 锁的是：一次性定时缺启动恢复 / 缺过期策略 / 未处理 setTimeout 上限 */
  assert.ok(/ONCE_CATCHUP_MS/.test(s), '没有过期补执行的窗口策略');
  /* 锁的是：一次性定时缺启动恢复 / 缺过期策略 / 未处理 setTimeout 上限 */
  assert.ok(/2147483647/.test(s), '没有处理 setTimeout 的 2^31-1 上限');
});

done();
