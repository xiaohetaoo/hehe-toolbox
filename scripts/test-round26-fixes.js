'use strict';
/* 第 26 轮（连续深查）回归。
 *
 * 本轮仍是纯静态审查：不启动 Electron、不跑实机交互。能拿真实实现跑
 * 行为断言的尽量跑；需要真实 Office/COM、hosts 注册表、窗口渲染的，
 * 锁源码形态并写清「锁的是哪个回归、为什么不能行为断言」。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

/* 从某个 handler 起点截到下一个 handle(，避免用整份 main.js 的宽泛匹配。 */
function handlerSlice(src, name) {
  const start = src.indexOf('handle(CH.' + name);
  assert.notStrictEqual(start, -1, '找不到 handler：' + name);
  const next = src.indexOf('handle(CH.', start + 10);
  return src.slice(start, next === -1 ? src.length : next);
}

t('R26-01 Office COM 转换失败（含 ps 抛异常）不留下半截同名产物', () => {
  const h = handlerSlice(readSrc('main.js'), 'OFFICE.CONVERT');
  /* 锁的是：COM 分支在「ps 返回但没产出」和「ps 直接抛异常」两条失败路径
   * 都必须删掉 uniqueTarget 新建的目标。只修前者时，COM 卡死/超时抛错
   * 仍会在输出目录留下一个打不开的半截文件。行为断言需要真实 Office，
   * 本机不保证存在，故锁调用点。 */
  /* 锁的是：清理由两条失败路径都必须有；缺一条就会留半截文件。 */
  const rmCount = (h.match(/fsp\.rm\(out, \{ force: true \}\)/g) || []).length;
  assert.ok(rmCount >= 2, 'COM 失败清理只接了一条路径，实际 ' + rmCount + ' 处');
});

t('R26-02 搜索 limit 非法值不会退化成无上限扫描', () => {
  const main = readSrc('main.js');
  const query = handlerSlice(main, 'SEARCH.QUERY');
  const content = handlerSlice(main, 'CONTENT.SEARCH');
  const quick = handlerSlice(main, 'SEARCH.QUICK');
  const es = handlerSlice(main, 'SEARCH.ES');
  /* 锁的是：limit 直接参与循环上限比较。旧写法 `Math.min(2000, limitRaw)`
   * 对 "abc" 得到 NaN，`i < NaN` 恒 false —— 看似没上限，实际是无限扫盘；
   * 负值也会让上限变成负数。四条搜索入口必须统一先判有限正数。 */
  for (const [name, h] of [['SEARCH.QUERY', query], ['CONTENT.SEARCH', content], ['SEARCH.QUICK', quick]]) {
    assert.ok(/Number\.isFinite\(limitRaw\)/.test(h), name + ' 未归一 limit');
    /* 锁的是：非正 limit 必须先被拒绝，不能拿负数当循环上限。 */
    assert.ok(/limitRaw > 0/.test(h), name + ' 未拒绝非正 limit');
  }
  /* 锁的是：es.exe 的 -n 也不能收到 NaN/负数。 */
  assert.ok(/Number\.isFinite\(nRaw\)|Number\.isFinite\(limitRaw\)/.test(es), 'SEARCH.ES 未归一 -n');
});

t('R26-03 空内容搜索直接拒绝，不拿空正则扫全盘', () => {
  const h = handlerSlice(readSrc('main.js'), 'CONTENT.SEARCH');
  /* 锁的是：空查询会编译成匹配一切的正则，等于把整盘每个文本文件都读一遍。
   * 行为断言需要真实目录树与 IPC，这里锁入口校验存在。 */
  assert.ok(/trim\(\)/.test(h) && /请输入搜索内容/.test(h), '内容搜索缺少空查询拦截');
});

t('R26-04 LAN 扫描并发：旧一趟收尾不能拆掉新一趟的订阅/进度条', () => {
  const src = readSrc('js/tools/lan-scan.js');
  /* 锁的是：run1 未返回时用户再点 run2，旧 finally 原来对共享 unsub
   * 执行 unsub()/置 null，会拆掉 run2 刚挂的监听，run2 全程无进度；
   * 同时 prog.hide() 会把 run2 正在显示的进度条藏掉。 */
  assert.ok(/let myUnsub = null;/.test(src), '没有按趟保存订阅句柄');
  /* 锁的是：外层当前订阅必须指向本趟句柄，页面 cleanup 才能退掉它。 */
  assert.ok(/unsub = myUnsub;/.test(src), '外层当前订阅没有指向本趟句柄');
  /* 锁的是：进度条只在仍是本趟时才隐藏，旧一趟不得遮住新一趟。 */
  assert.ok(/if \(runToken === scanRunSeq\) prog\.hide\(\);/.test(src), '旧一趟仍会隐藏新一趟的进度条');
});

t('R26-05 HOSTS.BACKUP 与 WRITE/RESTORE 共用同一把串行锁', () => {
  const h = handlerSlice(readSrc('main.js'), 'HOSTS.BACKUP');
  /* 锁的是：备份与写入/还原都读写同一个 hosts 文件与备份目录。
   * 不串行时，备份可能取到写到一半的 hosts；还原时把半截内容写回去。
   * hosts 需要管理员权限与真实系统文件，行为断言在本机不可靠。 */
  assert.ok(/withHostsLock/.test(h), 'HOSTS.BACKUP 没有并入 hosts 串行锁');
});

t('R26-06 辅助窗首次打开就带主窗语言，英文界面不再先闪中文提示', () => {
  const main = readSrc('main.js');
  const aux = readSrc('js/auxwin/pin-1.js') + readSrc('js/auxwin/snip-1.js') + readSrc('js/auxwin/ruler-1.js');
  /* 锁的是：三个 loadFile 只传 accent 时，辅助窗不知道当前语言；
   * UI_PREFS_CHANGED 只在用户再次切语言时才推，首次打开必是中文。
   * 窗口渲染无法在纯静态测试里启动，故锁 query 与初始解析两处接线。 */
  assert.strictEqual((main.match(/lang: uiLang/g) || []).length >= 3, true, '辅助窗 loadFile 未全部带 lang');
  /* 锁的是：三个初始脚本都要解析 query 里的 lang。 */
  assert.strictEqual((aux.match(/q\.get\('lang'\)/g) || []).length >= 3, true, '辅助窗初始脚本未解析 lang');
  /* 锁的是：贴图窗提示文本要按语言替换。 */
  assert.ok(/Drag to move/.test(readSrc('js/auxwin/pin-2.js')), '贴图窗提示未按语言替换');
  /* 锁的是：截图工具栏按钮文案要按语言替换。 */
  assert.ok(/\['rect', 'rect', '矩形', 'Rectangle'\]/.test(readSrc('js/auxwin/snip-2.js')), '截图工具栏未按语言替换');
});

t('R26-09 视频裁剪在编码器探测后、spawn 前再次检查取消', () => {
  const h = handlerSlice(readSrc('ipc/media-ffmpeg.js'), 'FFMPEG.TRIM');
  /* 锁的是：jobs.set 后隔着一个异步 videoEncodeArgs（硬件探测可能数秒），
   * 用户在这段窗口点取消，原实现仍会 spawn 完整跑一遍再删成品。 */
  assert.ok(/if \(state\.cancel\) \{ jobs\.delete\(id\); throw new Error\('已取消'\); \}/.test(h), 'spawn 前没有取消检查');
  assert.ok(/videoEncodeArgs[\s\S]*\n\s*\.catch\(\(err\) => \{ jobs\.delete\(id\); throw err; \}\)/.test(h), '编码器探测失败会漏掉任务');
});

t('R26-08 内容搜索根目录读取失败时也会发 done 并清掉任务', () => {
  const h = handlerSlice(readSrc('main.js'), 'CONTENT.SEARCH');
  /* 锁的是：walkDir 在根目录不存在/无权读取时会抛。原实现没有 catch/finally，
   * 任务永远留在 jobs 表、界面收不到 done，只能一直显示「正在搜索」。
   * 搜索根由用户选择，盘符拔出/网络盘断线/权限变化都能触发。 */
  assert.ok(/catch \(err\)[\s\S]*done: true[\s\S]*error:/.test(h), '缺少失败收尾 done');
  /* 锁的是：无论成功还是失败，任务都要从 jobs 表里删除。 */
  assert.ok(/finally \{\s*jobs\.delete\(id\)/.test(h), '失败/成功后都没有统一清任务');
});

t('R26-10 实时坐标页离开时把开关复位，避免留下“开着但不刷新”', () => {
  const src = readSrc('js/tools/dev.js');
  /* 锁的是：定时器在 cleanup 里被清掉，但开关视觉仍停在 on；保活复用回来
   * 用户看到“开始”亮着、坐标不动，会以为实时坐标坏了。开关必须一起复位。 */
  assert.ok(/onCleanup[\s\S]*sw\.set\(false\)/.test(src), '清理时没有复位实时坐标开关');
});

t('R26-07 i18n 源码断言守卫已递归到 scripts 子目录', () => {
  const src = readSrc('scripts/test-i18n-assertions.js');
  /* 锁的是：守卫原来只读 scripts/ 顶层，子目录里的测试整片漏检。
   * 这条锁的是遍历实现本身，递归后的实际覆盖由该守卫自己跑。 */
  assert.ok(/function collectTests/.test(src), 'i18n 守卫仍是顶层扫描');
  assert.ok(/ent\.isDirectory\(\)/.test(src), 'i18n 守卫没有进入子目录');
});

done();
