'use strict';
/* 第 24 轮修复回归：P1 电源门禁 + P2 数据归一/防重入 + P3 lib 边界与渲染层接线。
 *
 * 【为什么后半段用源码断言】渲染层（js/ui.js、js/tools/**）依赖完整 Electron
 * 壳、DOM 与 IPC，Node 测试里起不来；断言锁的是「回归点是否仍接在正确位置」，
 * 行为细节由 smoke 覆盖。每条源码断言上方都写明锁的是哪条 R24 回归、以及
 * 为什么不能改成行为断言。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

/* JS 剥注释；CSS/HTML/YML 保留原文（stripComments 不是给它们用的）。 */
const js = (rel) => readSrc(rel);
const raw = (rel) => readSrc(rel, { raw: true });

/* ---------- P1 电源门禁 ---------- */
const PG = require('../lib/power-gate');
t('P1 Start-Process + 危险命令仍被拦', () => {
  assert.strictEqual(PG.isPowerCommand('Start-Process powershell -ArgumentList "shutdown /s /t 0"'), true);
});
t('P1 `& $c` 裸变量调用仍被拦', () => {
  assert.strictEqual(PG.isPowerCommand('$c = "shutdown /s"; & $c'), true);
});
t('P1 普通文本不误报', () => {
  assert.strictEqual(PG.isPowerCommand('echo hello world'), false);
});

/* ---------- P3-A lib 边界 ---------- */
const TS = require('../lib/target-size');
t('R24-21 Infinity 目标体积被拒绝', () => {
  const r = TS.planBitrates({ targetBytes: Infinity, durationSec: 60, hasAudio: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.videoKbps, null);
});
t('R24-21 字符串时长不抛 TypeError', () => {
  const r = TS.planBitrates({ targetBytes: 1024, durationSec: '60', hasAudio: true });
  assert.strictEqual(r.ok, false);
  assert.ok(String(r.reason).length > 0);
});
const DM = require('../lib/dir-move');
const baseMove = {
  src: 'D:\\a', dst: 'E:\\b', srcExists: true, srcIsDir: true,
  dstExists: false, freeBytes: 10 * 1024 ** 3, needBytes: 1024 * 1024,
};
t('R24-22 坏 needBytes 被拒绝（不再静默当 0）', () => {
  assert.strictEqual(DM.validateMove({ ...baseMove, needBytes: -1 }).ok, false);
  assert.strictEqual(DM.validateMove({ ...baseMove, needBytes: 'abc' }).ok, false);
});
t('R24-22 未知 needBytes 显式标记', () => {
  const r = DM.validateMove({ ...baseMove, needBytes: null });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.needBytesUnknown, true);
});
t('R24-22 正常体积仍通过', () => {
  assert.strictEqual(DM.validateMove(baseMove).ok, true);
});
const AG = require('../lib/archive-guard');
t('R24-23 条目名控制字符被拒', () => {
  const r = AG.checkEntryName('a\u0001b');
  assert.strictEqual(r && r.code, 'ILLEGAL_CHAR');
});
const RP = require('../lib/restore-point');
t('R24-24 负数体积 token 返回 null', () => {
  assert.strictEqual(RP.parseSizeToken('-1', 'GB'), null);
  assert.strictEqual(RP.parseSizeToken('1.5', 'GB'), Math.round(1.5 * 1024 ** 3));
});
const ERR = require('../lib/errors');
t('R24-25 数字 errno 28 归为磁盘已满', () => {
  assert.strictEqual(ERR.classify({ errno: 28 }).code, 'DISK_FULL');
});
t('R24-25 Windows -4058 归为找不到', () => {
  assert.strictEqual(ERR.classify({ errno: -4058 }).code, 'NOT_FOUND');
});
const ACL = require('../lib/acl-repair');
t('R24-26 裸 SID 不被当成主体名', () => {
  assert.strictEqual(ACL.isPlausiblePrincipal('S-1-5-32-545'), false);
});
const LAN = require('../lib/lan-scan');
t('R24-27 非法八位组 IP 不进设备列表', () => {
  const rows = LAN.parseArp('999.1.1.1  aa-bb-cc-dd-ee-ff  Dynamic');
  assert.strictEqual(rows.length, 0);
});
t('R24-27 合法 ARP 行仍解析', () => {
  const rows = LAN.parseArp('192.168.1.10  aa-bb-cc-dd-ee-ff  Dynamic');
  assert.strictEqual(rows.length, 1);
});
const SEN = require('../lib/sensitive');
t('R24-28 纯小写 40 位串不算 base64 密钥', () => {
  assert.strictEqual(SEN.inspect('a'.repeat(40)).sensitive, false);
});
t('R24-28 含 +/ 的 base64 仍命中', () => {
  assert.strictEqual(SEN.inspect('AbC+/'.repeat(12)).sensitive, true);
});

/* ---------- P3-B 渲染层接线 ---------- */
const office = js('js/tools/office.js');
t('R24-30 四个 PDF 操作共用同一 busy 句柄', () => {
  /* 锁的是：R24-30 四个 guard 各自建 busy、可并发弹两次保存框。行为断言
   * 需要完整渲染层与 pdf-lib，Node 起不来，所以锁「同一 state 被传入」。 */
  assert.ok(/pdfGuardState/.test(office) && /state:\s*pdfGuardState/.test(office));
});
const uiSrc = js('js/ui.js');
t('R24-30 ui.guard 支持共享 state', () => {
  /* 锁的是：R24-30 guard 的 busy 由闭包私有，调用方无法共用。 */
  assert.ok(/o\.state/.test(uiSrc) && /state\.busy/.test(uiSrc));
});
const audioCut = js('js/tools/media/audio-cut.js');
t('R24-36 unique-path 已移入 try（reject 也会复位 running）', () => {
  /* 锁的是：R24-36 unique-path reject 逃出 try，finally 不执行、running 永真。 */
  const tryIdx = audioCut.indexOf('try {');
  const uniqIdx = audioCut.indexOf('UNIQUE_PATH');
  assert.ok(tryIdx >= 0 && uniqIdx > tryIdx, 'UNIQUE_PATH 必须在 try 内');
});
const qr = js('js/tools/qr.js');
t('R24-35 二维码加载有 per-run 序号', () => {
  /* 锁的是：R24-35 两条解码链并发、旧响应覆盖新预览。 */
  assert.ok(/loadSeq/.test(qr) && /my !== loadSeq/.test(qr));
});
const trim = js('js/tools/media/video-trim.js');
t('R24-35 视频探测有 per-run 序号', () => {
  /* 锁的是：R24-35 连选两个视频，旧探测结果写回共享信息区。 */
  assert.ok(/my !== loadSeq/.test(trim));
});
t('R24-29 离页清理会暂停预览视频', () => {
  /* 锁的是：R24-29 离页后 <video> 仍在后台播。cleanup 需要真实页面生命周期。 */
  assert.ok(/video\.pause\(\)/.test(trim));
});
const net = js('js/tools/net-tools.js');
t('R24-29 测速离页会退订并 KILL 任务', () => {
  /* 锁的是：R24-29 测速页无 cleanup，离页后订阅与任务继续。 */
  assert.ok(/JOB\.KILL/.test(net) && /disposed/.test(net));
});
const envm = js('js/tools/env-manager.js');
t('R24-31 确认框返回后二次判 busy', () => {
  /* 锁的是：R24-31 两次安装都在 confirmBox 前通过 busy 检查。 */
  const after = envm.split('confirmBox').slice(1).join('confirmBox');
  assert.ok(after.includes('if (busy) return'));
});
const imgc = js('js/tools/media/img-compress.js');
t('R24-32 MKDIR 失败会中止并提示', () => {
  /* 锁的是：R24-32 建目录失败被空 catch 吞掉、根因稀释成逐图失败。 */
  assert.ok(/输出目录不可写/.test(imgc));
});
const av = js('js/tools/media/av-convert.js');
t('R24-32 部分成功不再报绿色成功', () => {
  /* 锁的是：R24-32 只要 1 个成功，顶层 toast 就报绿色成功。 */
  assert.ok(/okN === r\.results\.length \? 'success' : \(okN \? 'warn' : 'error'\)/.test(av));
});
const appSrc = js('js/app.js');
t('R24-33 外观分区接入 drawToken', () => {
  /* 锁的是：R24-33 慢 IPC 下切走分区，回调仍改已丢弃的卡片与 currentMode。 */
  assert.ok(/function drawAppearance\(body, token\)/.test(appSrc) && /token !== drawToken/.test(appSrc));
});
const life = js('js/tools/life.js');
t('R24-34 notes 写入串行化', () => {
  /* 锁的是：R24-34 连按添加/勾选，两趟读同一旧数组后写覆盖。 */
  assert.ok(/writeChain/.test(life) && /mutate\(/.test(life));
});
const avInfo = js('js/tools/media/av-info.js');
t('R24-35 媒体探测丢弃过期结果', () => {
  /* 锁的是：R24-35 换文件后旧的 ffprobe 结果回写共享结果区。 */
  assert.ok(/my !== probeSeq/.test(avInfo));
});
t('R24-37 数值输入有上下限 clamp', () => {
  /* 锁的是：R24-37 CRF/帧率/GIF 宽越界值直传 ffmpeg。 */
  assert.ok(/Math\.min\(51, Math\.max\(0/.test(av));
});

/* ---------- P3-C 可访问性与样式硬伤 ---------- */
t('R24-38 弹窗具备 dialog 语义与焦点恢复', () => {
  /* 锁的是：R24-38 .modal 无 role/aria-modal，关闭不还焦点。 */
  assert.ok(/role', 'dialog'/.test(uiSrc) && /aria-modal/.test(uiSrc) && /opener.*focus/.test(uiSrc));
});
t('R24-38 可排序表头键盘可达且带 aria-sort', () => {
  /* 锁的是：R24-38 表头仅 click，键盘用户无法排序。 */
  assert.ok(/aria-sort/.test(uiSrc) && /tabindex: c\.sortable/.test(uiSrc));
});
t('R24-39 toast 有 aria-live 与 alert', () => {
  /* 锁的是：R24-39 读屏器不播报错误 toast。 */
  assert.ok(/aria-live/.test(uiSrc) && uiSrc.includes("t.setAttribute('role', type === 'error' ? 'alert' : 'status')"));
});
t('R24-39 fieldRow 的 label 与控件互绑', () => {
  /* 锁的是：R24-39 label 无 for、控件无 id/describedby。 */
  assert.ok(/labelEl\.setAttribute\('for'/.test(uiSrc) && /aria-describedby/.test(uiSrc));
});
const cmdk = js('js/cmdk.js');
t('R24-39 命令面板具备 combobox/listbox 语义', () => {
  /* 锁的是：R24-39 cmdk 列表无 listbox/option 与 activedescendant。 */
  assert.ok(/role', 'combobox'/.test(cmdk) && /role: 'option'/.test(cmdk) && /aria-activedescendant/.test(cmdk));
});
t('R24-39 首页搜索具备展开态与 listbox', () => {
  /* 锁的是：R24-39 首页搜索无 aria-expanded/controls。 */
  assert.ok(/aria-expanded/.test(appSrc) && /titlebar-search-results/.test(appSrc));
});
const css = raw('css/app.css');
t('R24-40 浅色 toast 文字对比度已加深', () => {
  /* 锁的是：R24-40 白字 on 状态色仅 2.57-3.71:1。 */
  assert.ok(/toast-success \{ background: #036B26/.test(css) && /--danger-text: #C62828/.test(css));
});
t('R24-41 toast 长文本可换行且有最大宽度', () => {
  /* 锁的是：R24-41 nowrap + 无 max-width 导致长路径被裁。 */
  assert.ok(/max-width: min\(480px, 80vw\)/.test(css) && /word-break: break-all/.test(css));
});
t('R24-42 死 CSS 与 12.5px 已清理', () => {
  /* 锁的是：R24-42 六条零引用规则与 12.5px 漏网（全仓搜索命中 0）。 */
  assert.ok(!/status-dot/.test(css) && !/spinner-lg/.test(css) && !/chart-box/.test(css) && !/12\.5px/.test(css));
});
t('R24-44 reduced-motion 统一关闭入场与过渡', () => {
  /* 锁的是：R24-44 系统关闭动画后 toast/modal/下拉仍播放。 */
  assert.ok(/prefers-reduced-motion: reduce/.test(css) && /transition-duration: 0\.001ms/.test(css));
});
t('R24-43 辅助窗口声明 lang 并跟随语言广播', () => {
  /* 锁的是：R24-43 贴图窗 html 无 lang、不消费主进程语言广播。 */
  assert.ok(/<html lang="zh-CN">/.test(raw('pin.html')) && /UI_PREFS_CHANGED/.test(js('js/auxwin/pin-1.js')));
});
t('R24-43 启动窗按 lang 参数切换英文', () => {
  /* 锁的是：R24-43 启动窗阶段文案与品牌名硬编码中文。 */
  assert.ok(/q\.get\('lang'\)/.test(js('js/splash.js')) && /lang: uiLang/.test(js('main.js')));
});

/* ---------- P3-D 工程脚本 ---------- */
t('R24-47 --changed 会并入直接改动的测试', () => {
  /* 锁的是：R24-47 源码+测试同改时，直接改的测试可能不进增量集。 */
  assert.ok(/chosen\.concat\(changedTests\)/.test(js('scripts/lib/features.js')));
});
t('R24-49 fetch-dist 清理支持目录', () => {
  /* 锁的是：R24-49 rmSync 非递归，遇目录 EISDIR 中断清理。 */
  assert.ok(/rmSync\(path\.join\(DIST, f\), \{ recursive: true/.test(js('scripts/fetch-dist.js')));
});
t('R24-49 发布标题接受四段版本', () => {
  /* 锁的是：R24-49 标题正则拒绝 v0.8.0-1。 */
  assert.ok(/\(\?:\\\.\\d\+\)\{2,3\}/.test(js('scripts/fix-release-title.js')));
});
t('R24-49 Release 校验产物名含当前版本', () => {
  /* 锁的是：R24-49 发版只查后缀与体积，不比对版本名。 */
  assert.ok(/产物名不含当前版本/.test(js('scripts/verify-release.js')));
});
t('R24-50 打包资源守卫核对五个页面', () => {
  /* 锁的是：R24-50 资源守卫只解析 index.html，漏辅助窗脚本。 */
  assert.ok(/splash\.html'/.test(js('scripts/test-packaged-assets.js')));
});
t('R24-48 CI 语法检查递归到子目录', () => {
  /* 锁的是：R24-48 CI 的 node --check 通配不递归，漏 media/auxwin/scripts/lib。 */
  assert.ok(/find lib ipc js scripts/.test(raw('.github/workflows/ci.yml')));
});

done();
