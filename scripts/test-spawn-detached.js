'use strict';
/* 火后不理的子进程：helper 语义 + 整棵主进程树的裸 spawn 审计。
 *
 * ============ 锁的是哪两个回归 ============
 * ① 【v0.1.9 只修了一半】上一轮把 main.js 里 7 处 `spawn('taskkill'/'shutdown')`
 *    换成 spawnDetached，但 ipc/media-ffmpeg.js 里还有 6 处同款没动 ——
 *    而那个模块拿不到 main.js 的局部函数。
 *    后果与已修的一模一样：spawn 失败（可执行文件被删、被杀软隔离）时
 *    Node 会 emit 'error'，没监听就升级成 uncaughtException →
 *    写进 crash-log、下次启动标「上次异常退出」。
 *    更糟的是**测试看起来是绿的**：JO7 只扫 main.js，扫不到媒体域。
 *
 * ② 【录制启动失败被当成"正在进行中"】recStartSeg 用
 *    `if (proc.exitCode !== null)` 判断启动是否失败。但 spawn 失败时进程
 *    根本没起来，exitCode 恒为 null（实测：ENOENT 时 pid 是 undefined、
 *    exitCode 是 null）→ 判据永远为假 → 界面开始计时、磁盘上什么都没写。
 *
 * ============ 为什么断言要扫「整棵主进程树」而不是只看 main.js ============
 * 这正是回归①的成因。只盯一个文件时，改动搬到别处就等于脱离了护栏。
 * 判据用注释剥掉的源码（stripComments），避免把注释里的示例代码当成漏改点
 * ——上一个版本就踩过这个坑（spawnDetached 的说明里写着 `spawn('taskkill', …)`）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t, done, readSrc, readMain } = require('./lib/harness');
const srcScan = require('../lib/src-scan');

const ROOT = path.join(__dirname, '..');

/* ============ 行为面：helper 本身 ============ */
const { spawnDetached } = require('../lib/spawn-detached');

t('SD1 同步失败（参数非法 / 文件不是可执行）返回 null，不向外抛', () => {
  /* 锁的是：helper 只挂 error 监听、没包 try/catch。
   * 实测 Windows 上「文件存在但不是可执行」走的是 **spawn() 同步抛**
   * （Error: spawn UNKNOWN），而「文件不存在」走的是异步 emit 'error'。
   * 两种形态都存在，所以 try/catch 与 error 监听缺一不可 ——
   * 少任何一个，就有一类失败会升级成 uncaughtException。 */
  const fake = path.join(require('os').tmpdir(), 'hehe-fake-spawn-probe.exe');
  fs.writeFileSync(fake, 'this is not a PE file\n');
  try {
    /* 这条在 Windows 上是同步抛；helper 必须把它变成 null */
    /* 锁的是：helper 没包 try/catch —— 同步抛直接冒到调用方。 */
    assert.strictEqual(spawnDetached(fake, ['-version']), null, '同步失败没有返回 null');
    /* 参数非法同样是同步抛（spawn 会对非数组 args 报 TypeError） */
    /* 锁的是：helper 没兜住参数非法这种调用方错误。 */
    assert.strictEqual(spawnDetached('cmd', 'not-an-array'), null, '参数非法没有返回 null');
  } finally {
    try { fs.unlinkSync(fake); } catch (e) { /* 已被占用则留到系统清理 */ }
  }
});

t('SD2 异步 spawn 失败（ENOENT）不升级成 uncaughtException', async () => {
  /* 锁的是：没挂 error 监听。这条必须真的等一个 tick —— 同步用例看不到它。 */
  let crashed = null;
  const onUncaught = (e) => { crashed = e; };
  process.on('uncaughtException', onUncaught);
  try {
    const child = spawnDetached('hehe-no-such-exe-xyz', []);
    /* 拿到 child 就说明没有同步失败；异步失败要靠监听吞掉 */
    if (child) await new Promise((res) => setTimeout(res, 120));
  } finally {
    process.removeListener('uncaughtException', onUncaught);
  }
  assert.strictEqual(crashed, null, 'ENOENT 被升级成了 uncaughtException：' + (crashed && crashed.message));
});

t('SD3 helper 会 unref（不拖住主进程退出）', () => {
  /* 锁的是：只挂监听忘了 unref —— 一次取消动作留下一个句柄，
   * 关窗后进程挂着不退，用户要从任务管理器结束它。 */
  const src = readSrc('lib/spawn-detached.js');
  /* 锁的是：helper 里没有 unref 调用。 */
  assert.ok(/\.unref\(\)/.test(src), 'spawnDetached 没有 unref');
  /* 锁的是：helper 里没有 error 监听。 */
  assert.ok(/\.on\('error'/.test(src), 'spawnDetached 没有挂 error 监听');
});

/* ============ 结构面：整棵主进程树 ============ */
/* 【判据窗口：以「下一个 handle( / register( / module.exports」为界】
 * 按固定行数取窗口会两头出错：窗口太短→后面才挂的监听算漏（假红），
 * 窗口太长→下一段 handler 的监听把这一段的裸 spawn 盖住（假绿）。
 * 用 handle() 边界天然对齐「一个 handler 一段」这个真实结构。 */
function bareSpawnsInMainTree() {
  const files = ['main.js'];
  const ipcDir = path.join(ROOT, 'ipc');
  for (const n of fs.readdirSync(ipcDir).filter((x) => x.endsWith('.js')).sort()) files.push(path.join('ipc', n));

  const bare = [];
  for (const rel of files) {
    const clean = srcScan.stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const re = /\bspawn\(/g;
    let m;
    while ((m = re.exec(clean))) {
      /* 走 helper 的不算裸。判据取「左括号前面紧邻的是不是 spawnDetached」，
       * 用一个字符类而不是再写一个源码匹配断言 —— 它只是扫描里的过滤条件，
       * 本身不是断言，写成断言反而会把"扫描器实现"当成被测对象。 */
      const head = clean.slice(Math.max(0, m.index - 30), m.index);
      if (head.endsWith('spawnDetached(')) continue;
      const rest = clean.slice(m.index);
      const boundary = /\nhandle\(|\nregister\(|\nmodule\.exports/.exec(rest);
      const seg = boundary ? rest.slice(0, boundary.index) : rest;
      /* 同一个过滤条件：这一段里有没有 error / once(error) 监听 */
      const hasErr = seg.indexOf(".on('error'") >= 0 || seg.indexOf(".once('error'") >= 0;
      if (!hasErr) {
        bare.push(rel + ': …' + clean.slice(m.index, m.index + 70).replace(/\s+/g, ' ') + '…');
      }
    }
  }
  return bare;
}

t('SD4 主进程树里没有裸 spawn（含 ipc/ 全部模块）', () => {
  const bare = bareSpawnsInMainTree();
  /* 锁的是：漏改一处 —— 那一处仍然会把"命令没执行成"变成"程序崩了"。 */
  assert.deepStrictEqual(bare, [], '这些地方还在裸 spawn：\n  ' + bare.join('\n  '));
});

t('SD5 media-ffmpeg 的 taskkill 全部走 spawnDetached', () => {
  /* 锁的是：媒体域退回裸 spawn('taskkill') —— 取消压缩/取消录制时崩。
   * 这条单独留着：SD4 是通用护栏，这条指名道姓钉在出过问题的那个文件上，
   * 万一将来有人给 SD4 放宽边界，这里还能拦住。 */
  const clean = readSrc('ipc/media-ffmpeg.js');
  /* 锁的是：媒体域仍有裸 spawn('taskkill')。 */
  assert.ok(!/spawn\('taskkill'/.test(clean), 'ipc/media-ffmpeg.js 里还有裸 spawn(taskkill)');
  /* 锁的是：taskkill 被整个删掉 —— 取消就不再真正杀进程树。 */
  assert.ok(/spawnDetached\('taskkill'/.test(clean), 'media-ffmpeg 没有用 spawnDetached 发 taskkill');
});

t('SD6 录制启动失败要能报出来（不能死等 exitCode）', () => {
  /* 锁的是：recStartSeg 只用 `proc.exitCode !== null` 判启动失败。
   * spawn 失败时进程没起来，exitCode 恒为 null（实测），于是
   * 「ffmpeg 起不来」被判成「录制正常进行中」——界面开始计时、
   * 磁盘上什么都不写，用户录完才发现是空文件。 */
  const clean = readSrc('ipc/media-ffmpeg.js');
  const i = clean.indexOf('async function recStartSeg(');
  assert.ok(i > 0, '找不到 recStartSeg');
  const seg = clean.slice(i, i + 2200);
  /* 锁的是：只挂 stderr，没挂 error —— 启动失败时拿不到原因。 */
  assert.ok(/proc\.on\('error'/.test(seg), 'recStartSeg 没有挂 error 监听');
  /* 锁的是：判据退回只看 exitCode —— spawn 失败会被当成录制中。 */
  assert.ok(/spawnErr\s*\|\|\s*proc\.exitCode/.test(seg), '启动失败判据没有覆盖 spawn 错误');
});

t('SD7 TTS / 更新替换 / explorer 重启这三处都不再裸 spawn', () => {
  /* 锁的是：这三处退回裸 spawn。它们的共同点是「都不关心结果」，
   * 所以最容易被当成"不用处理" —— 而正是它们会把崩溃日志写脏：
   *   · TTS：用户点朗读 → powershell 起不来 → 崩
   *   · 更新替换：即将退出时崩 → 下一次启动报「上次异常退出」，
   *     而用户明明刚刚正常更新完
   *   · explorer 重启：恢复右键菜单的收尾动作把主进程带崩 */
  const src = readMain({ raw: true });
  /* 锁的是：TTS 的 spawn 又没有 error 监听了。 */
  const tts = src.indexOf('handle(CH.TTS.SPEAK');
  assert.ok(tts > 0, '找不到 TTS.SPEAK');
  const ttsSeg = src.slice(tts, tts + 1600);
  /* 锁的是：TTS 的 spawn 又没有 error 监听了 —— powershell 起不来时点「朗读」会崩。
   * SD4 的通用扫描也会覆盖它，但那条靠"下一个 handle 为界"的窗口；
   * 这里指名道姓钉一次，防止将来有人放宽窗口把这条漏过去。 */
  assert.ok(/proc\.on\('error'/.test(ttsSeg), 'TTS.SPEAK 的 spawn 没有 error 监听');
  /* 锁的是：更新替换脚本退回 spawn().unref()。
   * 第四轮起改成用绝对路径调 powershell（psExe），但**必须仍然走 spawnDetached** ——
   * 裸 spawn 在「即将退出」的时刻把 error 升级成 uncaughtException，
   * 崩溃日志会写脏，用户下次看到「上次异常退出」却找不到现象。
   * 锁的是：替换脚本的启动没有走统一收口。 */
  assert.ok(/spawnDetached\((?:'powershell\.exe'|psExe), spawnArgs/.test(src), '更新替换脚本没有走 spawnDetached');
  /* 锁的是：explorer 重启退回裸 spawn —— 外面的 try/catch 接不到异步 error。 */
  assert.ok(/spawnDetached\('explorer\.exe'/.test(src), 'explorer 重启没有走 spawnDetached');
});

done();
