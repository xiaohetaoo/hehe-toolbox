'use strict';
/* 回归验证 ②：秒表暂停后必须从暂停点续计，且「重置/切模式」要清零。
 * 直接读取 life.js 的真实源码片段做静态确认 + 用同构逻辑跑时间线。 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'tools', 'life.js'), 'utf8');
let pass = 0, fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; else pass++; };

/* ---- 静态：关键实现就位 ---- */
chk(/let swElapsed = 0/.test(src), '声明了 swElapsed 累计变量');
chk(/startTs = Date\.now\(\) - swElapsed \* 1000/.test(src), 'start() 里秒表用 swElapsed 扣回锚点');
chk(!/startTs = Date\.now\(\) - \(mode === 'stopwatch' \? 0 :/.test(src),
    '旧的「startTs = now - (stopwatch ? 0 : ...)」锚点写法已移除');
chk(/if \(mode === 'stopwatch' && running\) swElapsed = \(Date\.now\(\) - startTs\) \/ 1000/.test(src),
    'stop() 里暂停时冻结秒表已计时间');
chk(/swElapsed = 0;/.test(src), 'setMode() 里清零累计（重置/切模式都走这里）');

/* ---- 行为：同构时间线 ---- */
function simulate(mode, { runMs, pauseMs, afterSetMode }) {
  let startTs = 0, running = false, swElapsed = 0;
  let total = 60, remain = 60;
  let shown = 0;
  const clock = { now: 1000000 };

  function start() {
    if (running) return;
    running = true;
    if (mode === 'stopwatch') startTs = clock.now - swElapsed * 1000;
    else startTs = clock.now - (total - remain) * 1000;
  }
  function stop() {
    if (mode === 'stopwatch' && running) swElapsed = (clock.now - startTs) / 1000;
    running = false;
  }
  function setMode() { stop(); swElapsed = 0; remain = total; shown = 0; }
  function tick() {
    if (!running) return;
    const el = (clock.now - startTs) / 1000;
    if (mode === 'stopwatch') { shown = el; return; }
    remain = total - el; if (remain > 0) shown = remain;
  }
  const adv = (ms) => { clock.now += ms; tick(); };

  start(); adv(runMs);
  const atPause = shown;
  stop(); adv(pauseMs);
  if (afterSetMode) setMode();
  else { start(); adv(100); }

  return { atPause, after: shown, resumed: Math.abs(shown - atPause) < 1 };
}

const r1 = simulate('stopwatch', { runMs: 5000, pauseMs: 2000 });
chk(r1.resumed, `秒表暂停后从 ${r1.atPause}s 续计（实际 ${r1.after.toFixed(1)}s）`);

const r2 = simulate('stopwatch', { runMs: 5000, pauseMs: 0, afterSetMode: true });
chk(r2.after === 0, `秒表重置后归零（实际 ${r2.after}）`);

const r3 = simulate('pomodoro', { runMs: 5000, pauseMs: 2000 });
chk(r3.resumed, `番茄钟仍然正确续计（${r3.atPause}s -> ${r3.after.toFixed(1)}s）`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
