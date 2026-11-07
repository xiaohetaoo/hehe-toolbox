'use strict';
/* P3-b 电源门禁：路径前缀 + 无空格 /c，以及**相邻的真实可执行绕过**。
 *
 * ============ 锁的是哪几个回归 ============
 * ① 【审查意见里的那一条：`C:\...\cmd/c shutdown /s` 判 false】
 *    我按用户给的 8 种形态逐条实测（cmd 层 + PowerShell 层），结论与用户一致：
 *    **OS 层都不会执行内层命令**，所以它不是可利用的绕过，只是语义缺口。
 *    这类"判不出来但其实也无害"的形态不该靠放宽识别去"修" ——
 *    放宽会让识别面变大、误拦变多，而安全收益是 0。
 *    所以这一条**只记录、不改判定**，并在下面用测试把"确实不执行"这个前提
 *    钉住：将来若谁要改这里的判据，得先证明前提变了。
 *
 * ② 【核对 ① 时发现的真实漏拦：PowerShell 的调用运算符形态】
 *    同一族「外壳 + 带路径的 cmd.exe」写法里，下面这些**在 ps 里真会执行**
 *    （exec:run 的 shellType='ps' 直接喂给 powershell -Command，
 *     命令收藏页的 PowerShell 类型也是同一条路径）：
 *        & "C:\Windows\System32\cmd.exe" /c shutdown /s
 *        . "C:\Windows\System32\cmd.exe" /c shutdown /s
 *        & "cmd" /c shutdown /s
 *        & $env:ComSpec /c shutdown /s
 *        $x="C:\...\cmd.exe"; & $x /c shutdown /s
 *    实测 isPowerCommand 对这五条全部返回 false —— 门禁被真绕过。
 *    成因：normalizeCommand 的壳正则要求 cmd 出现在**段首**，
 *    而这些写法的段首是 `&` / `.` / 变量赋值，cmd 藏在引号或变量里。
 *
 *    修法**不是**加一条正则去猜，而是：判不出来的一律 fail-closed。
 *    具体两种情形（两种都能执行任意命令，故出现即按电源操作处理）：
 *      (a) 段首是 PowerShell 的调用运算符（& / .）—— 它后面接什么就是执行什么；
 *      (b) 段里出现 `$变量` 形式的可执行位 —— 变量可能装的是 cmd.exe / shutdown。
 *    这不会误伤日常命令：`&` 在 cmd 里是串接符（已由 splitSegments 切开），
 *    只有**段首**的 `&` 才是 PowerShell 调用运算符。
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const { t, done } = require('./lib/harness');

const gate = require('../lib/power-gate');
const B = String.fromCharCode(92);   // 反斜杠：避免在源码里堆 8 个转义

/* ============ ① 前提钉死：这 8 种形态 OS 层确实不执行 ============ */
/* 【为什么要真的起进程，而不是只断言 isPowerCommand 返回 false】
 * 断言"判 false"等于把缺陷本身写进测试（历史上已经有过一次：
 * fail-text 的断言锁住的恰好是 bug）。这里要钉的是**前提** ——
 * 「它不执行，所以判 false 无害」。前提若变，这条测试必须先红。 */
function cmdWouldRun(line) {
  /* 【必须用 buffer 再手动解码】spawnSync 的 encoding:'gbk' 在 Node 22+ 上
   * 已经不认（实测抛 Unknown encoding: gbk），而 cmd 的输出是 GBK。
   * 这里只要判"标记串在不在"，标记本身是纯 ASCII，其实不解码也能查，
   * 但显式解码能保证以后加中文断言时不会踩同一个坑。 */
  const r = spawnSync('cmd', ['/c', line], { windowsHide: true, timeout: 15000 });
  let out = String(r.stdout || '');
  if (Buffer.isBuffer(r.stdout)) {
    try { out = new TextDecoder('gbk').decode(r.stdout); } catch (e) { out = r.stdout.toString('latin1'); }
  }
  /* 【为什么不用 echo 的返回值当判据】
   * cmd 收到无法识别的路径时返回 1 并打印「系统找不到指定的路径」，
   * 但那也可能来自内层命令本身失败。用**唯一标记**做判据：
   * 只有内层命令真的跑了，标记才会出现在输出里。 */
  return /HEHE_P3B_MARK/.test(out);
}

t('PB1 路径前缀+无空格 /c 在 cmd 层确实不执行（记录在案，不据此放宽判定）', () => {
  const forms = [
    'C:' + B + 'Windows' + B + 'System32' + B + 'cmd/c echo HEHE_P3B_MARK',
    'C:' + B + 'Windows' + B + 'System32' + B + 'cmd.exe/c echo HEHE_P3B_MARK',
    '"C:' + B + 'Windows' + B + 'System32' + B + 'cmd.exe"/c echo HEHE_P3B_MARK',
    '.' + B + 'cmd/c echo HEHE_P3B_MARK',
  ];
  const ran = forms.filter(cmdWouldRun);
  /* 锁的是：有人凭"看起来像路径"就断定它可执行，进而把判定放宽或写死成 true。 */
  assert.deepStrictEqual(ran, [],
    '这些形态在本机 cmd 层居然执行了 —— 前提变了，PB2 的结论要重做：\n  ' + ran.join('\n  '));
});

t('PB2 对照：同样内容去掉路径后确实会执行（证明探针真的能看见执行）', () => {
  /* 【必须有这条对照】否则 PB1 通过可能只是因为探针本身失灵
   * （比如 gbk 解码没对上、标记串写错）。这条锁的是"探针有效"这个前提。 */
  assert.strictEqual(cmdWouldRun('cmd/c echo HEHE_P3B_MARK'), true,
    '探针看不到执行 —— PB1 的"未执行"结论不成立，先修探针');
});

/* ============ ② 真绕过：PowerShell 调用运算符 + 变量可执行位 ============ */
const CALL_OPERATOR_FORMS = [
  '& "C:' + B + 'Windows' + B + 'System32' + B + 'cmd.exe" /c shutdown /s',
  '. "C:' + B + 'Windows' + B + 'System32' + B + 'cmd.exe" /c shutdown /s',
  '& "cmd" /c shutdown /s',
  "& 'cmd' '/c' shutdown /s",
  '& $env:ComSpec /c shutdown /s',
  '$x="C:' + B + 'Windows' + B + 'System32' + B + 'cmd.exe"; & $x /c shutdown /s',
  '& $env:ComSpec /c shutdown /s /t 0',
  '& "C:' + B + 'Windows' + B + 'System32' + B + 'shutdown.exe" /s /t 0',
];

t('PB3 调用运算符形态全部拦截（实测能执行，原实现全部漏拦）', () => {
  const missed = CALL_OPERATOR_FORMS.filter((c) => !gate.isPowerCommand(c));
  /* 锁的是：`& "带路径的 cmd.exe" /c shutdown /s` 被判成无害 ——
   * 实测这条在 ps 里会真的执行，而门禁放行。 */
  assert.deepStrictEqual(missed, [], '漏拦: ' + missed.join('\n  '));
});

t('PB4 但调用运算符不能误伤普通命令', () => {
  /* 【这条和 PB3 是一对】fail-closed 最怕做过头：把「用户正常会写的」
   * 也拦下来，用户就会去关掉高危开关，等于门禁自己失效。
   * 下面这些都不该被当成电源操作。 */
  const ok = [
    'ipconfig /all',
    'ping -n 2 127.0.0.1',
    'dir C:' + B,
    'tasklist | findstr chrome',
    'echo a & echo b',              // cmd 的串接（不是 ps 的调用运算符）
    'netstat -ano',                 // 段首不是 & / .
    'powershell -c "Get-Date"',     // 有外壳但没危险词根、没有调用运算符
    'cmd /c shutdown /a',           // 取消关机仍要放行
    'shutdown /?',                  // 查看帮助仍要放行
  ];
  const wrong = ok.filter((c) => gate.isPowerCommand(c));
  /* 锁的是：fail-closed 做过头，把日常命令一起拦了。 */
  assert.deepStrictEqual(wrong, [], '误拦: ' + wrong.join('\n  '));
});

t('PB5 判定依据是「段首调用运算符 / 变量可执行位」，不是整串里有没有 &', () => {
  /* 锁的是：用"整条命令包含 & 就拦"这种粗暴判据 ——
   * `echo a & echo b` 是 cmd 的串接，会被误拦成一堆。 */
  /* 中段的 & 不算调用运算符（已被 splitSegments 切成两段） */
  assert.strictEqual(gate.isPowerCommand('echo a & echo b'), false, '中段 & 被当成调用运算符');
  /* 段首的 & 才算 */
  assert.strictEqual(gate.isPowerCommand('& shutdown /s'), true, '段首 & 没被识别');
  /* 顿号句（. 开头）也是调用运算符 */
  assert.strictEqual(gate.isPowerCommand('. ' + '"C:' + B + 'Windows' + B + 'System32' + B + 'cmd.exe" /c shutdown /s'), true);
});

t('PB6 PowerShell 的 $env: 变量与 cmd 的 %VAR% 一视同仁地展开', () => {
  /* 锁的是：expandKnownEnv 只认 cmd 的 %ComSpec%，不认 $env:ComSpec ——
   * 于是 `& $env:ComSpec /c shutdown /s` 的首词留在 "$env:comspec"，
   * 剥壳剥不动、词根判定也失效（实测漏拦）。
   *
   * 【为什么这条要单独存在】PB3 里那条样本同时被"调用运算符 + 变量"的
   * fail-closed 兜住了（变异实测：撤掉 $env: 展开，PB3 仍然 PASS）。
   * 兜底和精确展开是两条独立的路，各需各自的断言 —— 否则撤掉精确展开
   * 也没人知道：它退化成了"整个 shell 形态都判不出来"的粗放状态。 */
  const viaDollar = gate.normalizeCommand('& $env:ComSpec /c shutdown /s');
  const viaPercent = gate.normalizeCommand('& %ComSpec% /c shutdown /s');
  /* 锁的是：$env: 形式没被展开（首词仍是变量名）。 */
  assert.strictEqual(viaDollar, viaPercent,
    '$env:ComSpec 与 %ComSpec% 展开结果不一致：\n  $env:  → ' + viaDollar + '\n  %VAR% → ' + viaPercent);
  /* 锁的是：展开后首词仍是 "$env:..."，说明根本没展开。 */
  assert.ok(!/\$env:/.test(viaDollar), '展开后仍残留 $env: 字面量：' + viaDollar);
});

done();
