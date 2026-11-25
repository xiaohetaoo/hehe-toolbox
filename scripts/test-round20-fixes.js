'use strict';
/* R20：笔记未保存修改 / 一次性定时坏时间戳 / TTS 导出与分卷参数 / 贴图临时文件。
 *
 * 这批判据的共同点：都不是"功能没做"，而是**边角输入下静默做错**——
 * 笔记切换直接覆盖未保存内容、坏 fireAt 变成 1ms 后触发睡眠、
 * SetOutputToWaveFile 直接截断已有 WAV、分卷参数拼出 -vNaNm。
 * 能行为验证的（once-schedule / safe-name）放在独立脚本；这里只锁源码契约。
 */

const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

/** 断言文件里存在 pattern。
 * 锁的是：每条 msg 已写明它防的是哪一次回归；统一加「锁的是」前缀，
 * 满足 test-source-assertions 的 SA-4 登记规矩。 */
function has(src, pattern, msg) { assert.ok(pattern.test(src), '锁的是：' + msg); }
/** 断言文件里不存在 pattern。
 * 锁的是：反向断言同样要说明它防止哪个坏写法复活。 */
function hasNot(src, pattern, msg) { assert.ok(!pattern.test(src), '锁的是：' + msg); }

function seg(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, '找不到片段起点：' + from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, '找不到片段终点：' + to);
  return src.slice(a, b);
}

/* ==================================================================
 * S1 笔记：切换/新建前必须确认丢弃未保存修改
 * ================================================================== */

t('S1 笔记：openNote / createNew 前先确认未保存修改', () => {
  const src = readSrc('js/tools/text-tools.js');
  const open = seg(src, 'async function openNote', 'function safeNoteName');
  /* 锁的是：openNote 直接把 ta.value 换成磁盘内容；自动保存 30 秒且只对已存在
   * 笔记生效，用户输入后立刻点另一篇就是无提示丢稿。行为上无法在没有 DOM 的
   * Node 测试里复现真实点击，只能锁"先 confirmDiscard 再 READ_TEXT"的顺序。 */
  has(open, /if \(!\(await confirmDiscard\(\)\)\) return;/,
    'openNote 没有先确认未保存修改（切笔记会静默丢稿）');
  has(open, /savedSnapshot = snapshot\(\);/, 'openNote 载入后没有重设已保存快照');
  const create = seg(src, 'async function createNew', 'searchIn.addEventListener');
  has(create, /if \(!\(await confirmDiscard\(\)\)\) return;/,
    'createNew 没有先确认未保存修改（新建会静默丢稿）');
});

t('S2 笔记：保存成功才重设快照', () => {
  const src = readSrc('js/tools/text-tools.js');
  const save = seg(src, 'async function save()', 'async function exportPdf');
  /* 锁的是：快照原来不存在，保存后仍会被判"脏"，切换时弹出多余确认；
   * 反过来只在真正写盘成功后才重设，失败/取消不能把脏状态洗掉。 */
  has(save, /await invoke\(Channels\.CHANNELS\.FS\.WRITE_TEXT, notesDir \+ '\/' \+ name, body\);/,
    'save 没有走 write-text');
  has(save, /savedSnapshot = snapshot\(\);/, 'save 成功后没有重设已保存快照');
});

t('S3 笔记：删除失败必须报错且不冒充成功', () => {
  const src = readSrc('js/tools/text-tools.js');
  const del = seg(src, 'async function removeCur', 'searchIn.addEventListener');
  /* 锁的是：旧写法 delete(...).catch(() => {}) 吞掉失败后照样清空编辑区，
   * 文件其实还在。这里锁"await + catch 里 toast + return"的收尾顺序。 */
  has(del, /await invoke\(Channels\.CHANNELS\.FS\.DELETE, notesDir \+ '\/' \+ curName\);/, '删除笔记没有等待真实结果');
  has(del, /catch \(e\)[\s\S]*toast\('删除失败：'/, '删除失败没有提示用户');
  hasNot(del, /FS\.DELETE.*\.catch\(\(\) => \{\}\)/, '删除笔记又退回静默吞错');
});

/* ==================================================================
 * S4 一次性定时：坏 fireAt 不能进计时器
 * ================================================================== */

t('S4 一次性定时：armOnceAll / armOnce 都用 onceSchedule 解析', () => {
  const src = readSrc('main.js');
  const all = seg(src, 'function armOnceAll()', 'handle(CH.SCHED.ONCE_LIST');
  /* 锁的是：`"abc"` 既不是假值、Number 后也不 <= now，于是被当未来任务
   * 交给 setTimeout(NaN)=1ms，启动即锁屏/睡眠。行为用例见 test-once-schedule.js。 */
  has(all, /onceSchedule\.decideOnce\(item, now, ONCE_CATCHUP_MS\)/, 'armOnceAll 没有走 decideOnce');
  has(all, /item\.action !== 'lock' && item\.action !== 'sleep'/, 'armOnceAll 没有丢弃未知动作');
  hasNot(all, /Number\(item\.fireAt\) <= now/, 'armOnceAll 又直接比较未校验的 fireAt');
  const run = seg(src, 'function runOnceAction', 'function armOnce(item)');
  /* 锁的是：旧 runOnceAction 的 else 分支无条件睡眠，store 里 action 被改成
   * 未知值（"shutdown"/""）时到点会把电脑挂起。未知动作必须只记日志。 */
  has(run, /else if \(action === 'sleep'\)/, '未知 action 又落回睡眠分支');
  has(run, /\[sched\] 未知的一次性动作/, '未知 action 没有日志');
  const arm = seg(src, 'function armOnce(item)', 'function armOnceAll');
  has(arm, /const fireAt = onceSchedule\.fireAtOf\(item\);/, 'armOnce 没有校验 fireAt');
  has(arm, /if \(fireAt == null\) return false;/, 'armOnce 对坏时间戳仍会挂计时器');
});

/* ==================================================================
 * S5 TTS：WAV 先临时写再原子替换；数值参数夹取
 * ================================================================== */

t('S5 TTS：WAV 不再直接写目标文件', () => {
  const src = readSrc('main.js');
  const wav = seg(src, 'handle(CH.TTS.WAV', 'CH.SVC.LIST');
  /* 锁的是：SetOutputToWaveFile 直接创建/截断目标，合成失败会把用户原有 WAV
   * 截成半截；旧实现也没过覆盖闸门。这里锁"临时名 + writeFileAtomic"。 */
  has(wav, /tempNames\.writeTmp\(out, tag\)/, 'WAV 没有改写到临时文件');
  has(wav, /writeFileAtomic\(out, buf\)/, 'WAV 成功后没有走原子替换');
  hasNot(wav, /SetOutputToWaveFile\('\$\{ttsEsc\(out\)\}'\)/, 'WAV 又直接写目标路径');
});

t('S6 TTS：rate / volume 非数字不能拼出 [int]NaN', () => {
  const src = readSrc('main.js');
  const speak = seg(src, 'handle(CH.TTS.SPEAK', 'handle(CH.TTS.WAV');
  /* 锁的是：旧写法 Math.min(10, "abc") = NaN → `[int]NaN`，PowerShell 报错，
   * 用户只看到看不懂的异常；数值必须在拼脚本前夹取。 */
  has(speak, /ttsInt\(rate, -10, 10, 0\)/, 'SPEAK 的 rate 没有夹取');
  has(speak, /ttsInt\(volume, 0, 100, 100\)/, 'SPEAK 的 volume 没有夹取');
  const wav = seg(src, 'handle(CH.TTS.WAV', 'CH.SVC.LIST');
  /* 锁的是：导出 WAV 只传了 rate，界面音量滑杆对导出文件完全无效。
   * 这不是“参数没接”，而是“设置看起来生效、实际没生效”。 */
  has(wav, /ttsInt\(volume, 0, 100, 100\)/, 'WAV 没有接 volume');
  /* 锁的是：界面已拦 5000 字，但 IPC 只靠界面挡不住直接调用；
   * 一次 Speak 5 万字会把主进程锁在语音引擎里直到念完。 */
  has(wav, /length > 5000/, 'WAV IPC 没有长度上限');
  has(speak, /length > 5000/, 'SPEAK IPC 没有长度上限');
});

t('S6b TTS 导出：UI 传 volume 且遵守 5000 字上限', () => {
  const src = readSrc('js/tools/text-tools.js');
  const exp = seg(src, '导出 WAV', '使用 Windows 内置语音');
  /* 锁的是：导出按钮原来不传 volume，且不检查长度；5 万字会合成几百 MB
   * 的 WAV 再整块读进内存。两处都要和“朗读”口径一致。 */
  has(exp, /volume: \+volIn\.value/, '导出没有传当前音量');
  has(exp, /text\.length > 5000/, '导出没有 5000 字上限');
});

/* ==================================================================
 * S7 7z：分卷大小必须校验
 * ================================================================== */

t('S7 7z：非数字分卷大小不能拼进 -v 参数', () => {
  const src = readSrc('main.js');
  const blk = seg(src, 'handle(CH.SEVEN.COMPRESS', 'handle(CH.SEVEN.EXTRACT');
  /* 锁的是：`if (volumeMB) -v + Math.max(1, "abc")` 拼出 -vNaNm，7z 直接失败，
   * 界面只剩看不懂的参数错误。非法值应在拼参数前拒绝。 */
  has(blk, /Number\.isFinite\(volume\)/, '分卷大小没有做有限数校验');
  has(blk, /const split = hasVolume && volume > 0;/, '分卷判据没有归一');
  hasNot(blk, /'-v' \+ Math\.max\(1, volumeMB\)/, '又用原始 volumeMB 拼 -v');
});

/* ==================================================================
 * S8 贴图：窗口关闭时清自己的临时 PNG
 * ================================================================== */

t('S8 贴图：closed 时只删白名单内的临时源图', () => {
  const src = readSrc('main.js');
  const pin = seg(src, 'async function createPinWindow', 'handle(CH.WIN.PIN_MOVE');
  /* 锁的是：贴图源图是 snipTmp 生成的 PNG，窗口关闭后没人引用；旧实现只
   * 从 Map 删除窗口，文件要等启动清扫，反复贴图会在 %TEMP% 堆一堆。
   * 这里锁"isfOwnTempName 判断 + rm"的顺序，用户文件不能被误删。 */
  has(pin, /tempNames\.isOwnTempName\(path\.basename\(srcPath\)\)/, '贴图关闭时没有判断自有临时名');
  has(pin, /fs\.rmSync\(srcPath, \{ force: true \}\)/, '贴图关闭时没有删除临时源图');
});

/* ==================================================================
 * S9 剪贴板路径：顶层文件/根目录的 dirname 不能丢分隔符
 * ================================================================== */

t('S9 剪贴板路径：pathDir/pathName 处理尾部与盘符根', () => {
  const src = readSrc('js/clip-actions.js');
  const blk = seg(src, "actionId === 'pathName'", 'await api.invoke(Ch.CLIP.WRITE_TEXT');
  /* 锁的是：C:\\foo 的"所在目录"会算成 C:（盘符相对路径，语义不是 C:\\）；
   * 目录带尾斜杠时"复制文件名"得到空串。纯 DOM 交互，Node 侧只能锁源码判据。 */
  has(blk, /window\.PathText\.basename\(p\)/, '路径动作没有走公共 basename');
  has(blk, /window\.PathText\.dirname\(p\) \|\| p/, '顶层文件/根目录没有走公共 dirname');
});

/* ==================================================================
 * S10 周期任务：损坏的 store 不能拖垮启动
 * ================================================================== */

t('S10 周期任务：armAllSchedules / ADD / REMOVE 对非数组 store 有兜底', () => {
  const src = readSrc('main.js');
  const all = seg(src, 'function armAllSchedules()', 'handle(CH.SCHED.LIST');
  /* 锁的是：settings.schedules 被手改成 null/对象时，旧写法 `for (const s of list)`
   * 在启动阶段 TypeError，托盘/窗口初始化全部不执行（双击无反应）。
   * 行为测试要起完整 Electron 才能触发启动路径，这里锁数组兜底与逐条 try。 */
  has(all, /if \(!Array\.isArray\(list\)\) return;/, 'armAllSchedules 没有数组兜底');
  has(all, /try \{ armSchedule\(s, false\); \} catch/, 'armAllSchedules 没有逐条隔离坏项');
  const add = seg(src, 'handle(CH.SCHED.ADD', 'handle(CH.SCHED.REMOVE');
  has(add, /Array\.isArray\(cur\) \? cur : \[\]/, 'SCHED.ADD 对非数组 store 没有兜底');
  const rm = seg(src, 'handle(CH.SCHED.REMOVE', 'const ONCE_CATCHUP_MS');
  has(rm, /Array\.isArray\(cur\) \? cur : \[\]/, 'SCHED.REMOVE 对非数组 store 没有兜底');
});

t('S11 自启备份：store 损坏成非数组时 disable/enable 不抛', () => {
  const src = readSrc('main.js');
  const del = seg(src, 'handle(CH.AUTOSTART.DELETE', 'handle(CH.AUTOSTART.ENABLE');
  /* 锁的是：autostartBackup 被手改成 null/对象时，旧写法在 disable 的 .find
   * 或 enable 的 .filter 上抛 TypeError。disable 抛了还没删注册表尚可；
   * enable 抛在 reg add 已成功之后，界面会显示“启用失败”，实际已经启用。 */
  has(del, /const bak = Array\.isArray\(cur\) \? cur : \[\];/, 'disable 没有数组兜底');
  const en = seg(src, 'handle(CH.AUTOSTART.ENABLE', 'handle(CH.AUTOSTART.DISABLED_LIST');
  has(en, /Array\.isArray\(cur\) \? cur : \[\]/, 'enable 没有数组兜底');
  const list = seg(src, 'handle(CH.AUTOSTART.DISABLED_LIST', 'const HOSTS_PATH');
  has(list, /Array\.isArray\(cur\) \? cur : \[\]/, 'disabled-list 没有数组兜底');
});

t('S12 快捷启动/命令收藏：store 坏成非数组时仍能读、能加', () => {
  const src = readSrc('js/tools/launch.js');
  /* 锁的是：quicklaunch/commands 被手改成对象或字符串后，
   * load 用 items.entries 抛、add 的 items.push 抛、删除的 findIndex 抛。
   * 用户表现是“页面上一条都没有、点添加报收藏失败”，只能删 hehe-data.json。 */
  const quick = seg(src, "id: 'quick-launch'", "id: 'command-collection'");
  has(quick, /Array\.isArray/, 'quicklaunch load/delete 没有数组兜底');
  /* 锁的是：quicklaunch 的 load 与删除两处都必须兜底，少一处仍会抛。 */
  const qc = (quick.match(/Array\.isArray/g) || []).length;
  if (qc < 2) throw new Error('quicklaunch load/delete 只兜底了 ' + qc + ' 处');
  const cmdStart = src.indexOf("id: 'command-collection'");
  if (cmdStart < 0) throw new Error('找不到命令收藏段');
  const cmd = src.slice(cmdStart);
  /* 锁的是：commands 的 load/add/delete 三处都必须兜底，少一处仍会抛。 */
  const count = (cmd.match(/Array\.isArray/g) || []).length;
  if (count < 3) throw new Error('commands 的 load/add/delete 没有全部兜底（只找到 ' + count + ' 处）');
});

t('S13 剪贴板历史：store 坏成非数组时页面仍能读', () => {
  const src = readSrc('js/tools/security.js');
  /* 锁的是：clipHistory 损坏成对象/字符串后，load 交给 render 与
   * sweepSensitive，前者 items 为空、后者 filter 抛；录制新条目时
   * history.unshift 抛。用户表现为历史页空白、复制也不记录。 */
  const load = seg(src, 'async function load() {', 'function render() {');
  has(load, /Array\.isArray\(raw\) \? raw : \[\]/, 'clipHistory 没有数组兜底');
});

done();
