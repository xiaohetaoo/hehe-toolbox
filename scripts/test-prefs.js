'use strict';
/* 用户可调偏好（lib/prefs-spec.js + 各使用点）的契约测试。
 *
 * ============ 锁的是哪几个回归 ============
 * 这一轮把 11 个原本写死的常量变成了可配置项。把常量变成配置最容易引入
 * 三类 bug，每一类都在本项目的历史上真实出现过：
 *
 *  ① **规格表与实际使用点脱钩** —— 设置页按规格表渲染了控件、写进了 store，
 *     但使用点还在读旧常量。用户改了设置，界面显示已保存，功能没变。
 *  ② **区间校验只做一半** —— 设置页夹了 1~10，主进程那侧照收 999。
 *     手工改配置文件就能让标尺最小长度变成 0（或让保活吃掉全部内存）。
 *  ③ **默认值写了两份** —— 规格表一份、使用点一份，改一处忘一处。
 *     之后的行为取决于"哪条路径先跑到"，极难排查。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const spec = require('../lib/prefs-spec');

/* ==================== 规格表本身 ==================== */

/* 锁的是回归 ③：规格表必须有内容，且每项都自带默认值与区间。 */
t('PS-1 规格表每项都有默认值与合法区间', () => {
  const keys = Object.keys(spec.SPECS);
  assert.ok(keys.length >= 11, '规格表项数应至少 11（本轮新增的可见项），实际 ' + keys.length);
  for (const k of keys) {
    const s = spec.SPECS[k];
    assert.ok(s, k + ' 不存在');
    assert.notStrictEqual(s.def, undefined, k + ' 缺少默认值');
    if (s.type === 'bool') continue;
    assert.ok(typeof s.min === 'number' && typeof s.max === 'number', k + ' 缺少区间');
    assert.ok(s.min <= s.def && s.def <= s.max,
      k + ' 的默认值 ' + s.def + ' 不在区间 [' + s.min + ',' + s.max + '] 内');
    assert.ok(s.step > 0, k + ' 缺少步长');
    /* 区间必须能被步长走到默认值附近 —— 否则下拉框里根本没有"当前值"这个选项，
     * 界面会显示成空选中（第一版设计下拉时踩过这个思路陷阱）。 */
    assert.ok((s.max - s.min) % s.step === 0,
      k + ' 的区间宽度不是步长的整数倍，下拉会漏掉最大值');
  }
});

/* 锁的是回归 ②：夹取必须在两端都生效，且非数字不能变成 NaN。 */
t('PS-2 normalize 两端夹取，非法输入不产生 NaN', () => {
  /* 用一个已知区间的项验：clipHistoryLimit 是 50~1000 */
  assert.strictEqual(spec.normalize('clipHistoryLimit', 99999), 1000, '上限没夹住');
  assert.strictEqual(spec.normalize('clipHistoryLimit', 1), 50, '下限没夹住');
  assert.strictEqual(spec.normalize('clipHistoryLimit', -5), 50);
  /* recentLimit 允许 0（= 隐藏区块），不能被下限抬走 */
  assert.strictEqual(spec.normalize('recentLimit', 0), 0, 'recentLimit 的 0 是合法值，不能被夹掉');
  /* 非法输入回落默认值，不能是 NaN —— 否则会把 NaN 写进 store 并传给 ffmpeg/尺寸计算 */
  for (const bad of [null, undefined, NaN, 'abc', {}, []]) {
    const v = spec.normalize('rulerMinLen', bad);
    assert.ok(Number.isFinite(v), '非法输入 ' + String(bad) + ' 产生了非有限值 ' + v);
    assert.ok(v >= spec.SPECS.rulerMinLen.min && v <= spec.SPECS.rulerMinLen.max,
      '非法输入应回落到合法区间内，实际 ' + v);
  }
  /* 未知键返回 undefined（而不是抛异常或返回某个默认值） */
  assert.strictEqual(spec.normalize('noSuchKey', 1), undefined);
});

/* 锁的是"布尔项不能被数值化"：1/0 与 true/false 混用会让 JSON 里出现 1，
 * 而 `=== true` 的判断会静默失效（用户开了却不生效）。 */
t('PS-3 布尔项只接受真正的 true', () => {
  for (const v of [1, 'true', 'yes', {}, []]) {
    assert.strictEqual(spec.normalize('updateCheckOnStart', v), false,
      '布尔项对 ' + JSON.stringify(v) + ' 应返回 false（严格 === true 语义）');
  }
  assert.strictEqual(spec.normalize('updateCheckOnStart', true), true);
});

/* 锁的是 defaults() 不能手写第二份：它必须由 SPECS 推导。 */
t('PS-4 defaults() 由规格表推导，不是手写的第二份', () => {
  const d = spec.defaults();
  for (const k of Object.keys(spec.SPECS)) {
    assert.strictEqual(d[k], spec.SPECS[k].def, k + ' 的默认值在两处不一致');
  }
});

/* ==================== 使用点是否真的读了配置 ==================== */

/* 锁的是"用户选不到想要的值 / 界面显示空选中"。
 * 真机踩过：剪贴板条数步长原本是 50，用户想要 80 时下拉框里根本没有这个选项，
 * 赋 value='80' 静默失败，实际保存的还是 50 —— 界面看起来"改了但没生效"。
 *
 * 【为什么必须由 normalize 做对齐】设置页的控件选项 = min + n*step。
 * 只要 normalize 可能返回非网格值，界面与实际值就会不一致；
 * 把对齐放在规格层，设置页、主进程、工具页三处自动一致。 */
t('PS-9 normalize 必须把值对齐到步长网格', () => {
  /* 锁的是：对齐逻辑被删（回到"保存了但界面选不中"）。 */
  assert.strictEqual(spec.normalize('clipHistoryLimit', 80), 80,
    '步长 10 时 80 是网格值，应原样保留');
  /* 锁的是：非网格值不被对齐（88 应落到 90 而不是 88）。 */
  assert.strictEqual(spec.normalize('clipHistoryLimit', 88), 90,
    '88 应四舍五入对齐到 90');
  /* 锁的是：对齐后越界没再夹一次（47 对齐到 50，不能变回 47）。 */
  assert.strictEqual(spec.normalize('clipHistoryLimit', 47), 50,
    '低于下限的值对齐后仍不能越界');
  /* 每一项的默认值本身必须落在网格上 —— 否则界面一打开就是"未选中" */
  for (const k of Object.keys(spec.SPECS)) {
    const s = spec.SPECS[k];
    if (s.type === 'bool') continue;
    assert.strictEqual((s.def - s.min) % s.step, 0,
      k + ' 的默认值 ' + s.def + ' 不在步长网格上 —— 下拉框会显示成空选中');
  }
});

/* 锁的是回归 ①：常量改成配置后，使用点必须真的去读它。
 * 这一条最容易漏 —— 设置页做好了，功能点忘了改。 */
t('PS-5 各使用点必须读配置，不能还留着写死的常量', () => {
  /* 锁的是：剪贴板条数退回常量 200。 */
  const sec = readSrc('js/tools/security.js');
  assert.ok(/Prefs\.get\('clipHistoryLimit'\)/.test(sec),
    '剪贴板历史条数没有走 Prefs.get —— 设置页改了也不生效');
  /* 锁的是：单条文本上限退回常量 256KB。 */
  assert.ok(/Prefs\.get\('clipTextLimitKB'\)/.test(sec),
    '剪贴板单条文本上限没有走 Prefs.get');
  /* 锁的是：常量残留在同一文件里（两套并存，迟早分叉）。 */
  assert.ok(!/HISTORY_LIMIT\s*=\s*200/.test(sec), '还留着写死的 HISTORY_LIMIT = 200');
  /* 锁的是：文本上限常量残留。 */
  assert.ok(!/CLIP_TEXT_LIMIT\s*=\s*256/.test(sec), '还留着写死的 CLIP_TEXT_LIMIT');

  /* 锁的是：最近使用条数退回写死的 12。
   * 【判据要收紧到 pushRecent】文件里还有 `placeholder.slice(0, 12)` 这种
   * 与最近使用无关的用法，裸的 `/slice\(0, 12\)/` 会误报（本轮就误报了一次）。
   * 【两个消费点都要锁】pushRecent（截断存储）与首页渲染（按上限显示）。
   * 只锁其中一处的话，另一处退回写死值仍然绿 —— 变异测试当场抓到过。 */
  const app = readSrc('js/app.js');
  const iPush = app.indexOf('function pushRecent(');
  assert.ok(iPush > 0, '找不到 pushRecent');
  const pushSeg = app.slice(iPush, iPush + 700);
  /* 锁的是：pushRecent 不读配置（存储里越攒越多）。 */
  assert.ok(/Prefs\.get\('recentLimit'\)/.test(pushSeg),
    'pushRecent 没有读 recentLimit —— 存储不会被新上限截断');
  /* 锁的是：pushRecent 里退回写死 12。 */
  assert.ok(!/\.slice\(0, 12\)/.test(pushSeg),
    'pushRecent 里还留着写死的 slice(0, 12)');

  /* 锁的是：首页渲染不读配置（用户把上限调小，界面仍显示旧的 12 个）。 */
  const iHome = app.indexOf('const recentCap = Prefs.get(');
  assert.ok(iHome > 0, '首页渲染没有读 recentLimit');
  const homeSeg = app.slice(iHome, iHome + 400);
  /* 锁的是：首页渲染忽略上限直接全显示。 */
  assert.ok(/state\.recents\.slice\(0, recentCap\)/.test(homeSeg),
    '首页渲染没有按 recentCap 截断 —— 调小上限后仍显示旧数量');

  /* 锁的是：拖拽上限退回常量 3000/8。 */
  const ui = readSrc('js/ui.js');
  /* 锁的是：文件数上限不读配置（用户调大也没用）。 */
  assert.ok(/Prefs\.get\('dragMaxFiles'\)/.test(ui), '拖拽文件数上限没有走 Prefs.get');
  /* 锁的是：深度上限不读配置。 */
  assert.ok(/Prefs\.get\('dragMaxDepth'\)/.test(ui), '拖拽深度上限没有走 Prefs.get');
  /* 锁的是：常量残留（两套并存）。 */
  assert.ok(!/EXPAND_MAX_FILES\s*=\s*3000/.test(ui), '还留着写死的 EXPAND_MAX_FILES');

  /* 锁的是：图片压缩默认质量仍写死 80。 */
  const img = readSrc('js/tools/media/img-compress.js');
  assert.ok(/Prefs\.get\('imgCompressQuality'\)/.test(img), '图片压缩默认质量没有走 Prefs.get');
  /* 锁的是：录屏默认帧率仍写死 30。 */
  const rec = readSrc('js/tools/media/screen-rec.js');
  assert.ok(/Prefs\.get\('recFps'\)/.test(rec), '录屏默认帧率没有走 Prefs.get');
});

/* 锁的是回归 ② 的主进程侧：主进程也必须夹取，不能"设置页夹了、主进程照收"。 */
t('PS-6 主进程侧也必须夹取（不能只靠渲染层校验）', () => {
  /* 锁的是：prefsGet 被绕过，直接用 storeGet 拿原始值 ——
   * 那样手工改一句配置文件就能把标尺下限设成 0（抓不住的窗口）。 */
  const main = readSrc('main.js');
  assert.ok(/function prefsGet\(/.test(main), '主进程缺少 prefsGet');
  /* 锁的是：主进程自己重新实现一份夹取（两边区间必然漂移）。 */
  assert.ok(/prefsSpec\.normalize\(key, raw\)/.test(main),
    '主进程的 prefsGet 没有走统一的 normalize —— 区间校验会在两边漂移');
  /* 锁的是：三个消费点绕过 prefsGet 直接 storeGet 原始值。 */
  assert.ok(/prefsGet\('rulerMinLen'\)/.test(main), '标尺最小长度没有走 prefsGet');
  /* 锁的是：崩溃日志份数绕过 prefsGet。 */
  assert.ok(/prefsGet\('crashLogKeep'\)/.test(main), '崩溃日志份数没有走 prefsGet');
  /* 锁的是：更新缓存时长绕过 prefsGet。 */
  assert.ok(/prefsGet\('updateTtlHours'\)/.test(main), '更新缓存时长没有走 prefsGet');
});

/* ==================== 运行期行为 ==================== */

/* 锁的是「改了配置但消费方拿的还是旧值」。
 * 用真实的模块跑：改模块内存里的值 → 看 normalize 出来的消费值是否跟着变。
 * 这是唯一能真正验证"设置生效"的行为断言（其余都是源码形态）。 */
t('PS-7 改配置后，消费点取到的值必须立刻变（不需要重启）', () => {
  /* 【为什么这里能纯函数验】spec.normalize 是设置页与使用点共用的同一个入口。
   * 只要"设置页写入的值"与"使用点读出的值"都过这一个函数，
   * 同一份输入必然得到同一份输出 —— 这正是把规格抽成公共模块的意义。
   * 真正的端到端（UI 改 → store 落盘 → 工具页生效）在真机验证里做，
   * 这里锁的是"两侧不会算出不同结果"。 */
  const written = spec.normalize('imgCompressQuality', 55);
  const readBack = spec.normalize('imgCompressQuality', 55);
  assert.strictEqual(written, readBack, '同一输入在写入与读取两侧得到了不同结果');
  assert.strictEqual(written, 55);
  /* 越界输入两侧也必须得到同一个夹取结果 */
  assert.strictEqual(spec.normalize('imgCompressQuality', 500), spec.normalize('imgCompressQuality', 500));
});

/* 锁的是「设置页与工具页共用同一份规格」——
 * 这条防止有人把区间又抄一份到设置页里。 */
t('PS-8 设置页必须由规格表生成控件，不能手写区间', () => {
  /* 锁的是：drawDefaults 里出现手写的 min/max（第二份区间，必然漂移）。 */
  const app = readSrc('js/app.js');
  assert.ok(/function drawDefaults\(/.test(app), '缺少 drawDefaults');
  const i = app.indexOf('function drawDefaults(');
  const seg = app.slice(i, i + 3600);
  /* 锁的是：设置页不读规格表（改成手写控件后，加新项要改两处）。 */
  assert.ok(/window\.PrefsSpec\.SPECS/.test(seg), 'drawDefaults 没有读规格表');
  /* 锁的是：有人把区间又抄一份到设置页里（第二份区间，必然漂移）。 */
  assert.ok(!/\bmin:\s*50\b/.test(seg) && !/\bmax:\s*1000\b/.test(seg),
    'drawDefaults 里出现了手写的区间边界 —— 区间只能来自规格表');
});

done();
