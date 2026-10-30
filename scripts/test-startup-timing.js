/* 启动窗时序守卫：主窗必须先 show()，启动窗随后才销毁。
 *
 * 【为什么单独立一个测试】
 * 这个顺序在代码里只有几行的差别，但用户能明确感觉到：
 *   正确：win.show() → splash 淡出 → destroy → 用户看到主界面出现
 *   错误：splash 淡出 → 等 200ms → win.show() → 中间 200ms 是空白桌面
 * 上一版就是后者，用户反馈「启动弹窗消失之后还要一会才会启动」。
 *
 * 这种「两行代码顺序」的回归在界面上一闪而过、极难肉眼发现，
 * 所以直接把顺序写成断言钉死。
 *
 * 同时校验：
 *   - 启动窗在没有显示过时不能被无谓等待（直接销毁，不空等 200ms）
 *   - 兜底超时存在（渲染层崩溃时启动窗不能永远挡着）
 *   - NSIS 静态图文案不再写「几秒」（实测 14 秒，写错会让人以为卡死）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const splashSrc = fs.readFileSync(path.join(ROOT, 'splash.html'), 'utf8');
const genSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-splash.py'), 'utf8');

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

/* ---- 1. 取出 showWindowAfterSplash 的函数体，按顺序校验 ---- */
const fnStart = mainSrc.indexOf('function showWindowAfterSplash');
if (fnStart < 0) { chk(false, '找不到 showWindowAfterSplash'); }
else {
  let depth = 0, end = -1;
  for (let i = mainSrc.indexOf('{', fnStart); i < mainSrc.length; i++) {
    if (mainSrc[i] === '{') depth++;
    else if (mainSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = mainSrc.slice(fnStart, end + 1);

  const iShow = body.indexOf('win.show()');
  const iDone = body.indexOf("splashSend('splash:done'");
  /* destroySplash 第一次出现是在函数开头的空值兜底分支里
     （`if (!win || win.isDestroyed()) { destroySplash(); return; }`），
     那一步在 win.show() 之前是正确的。要比较的是**主路径**上的销毁，
     也就是 splash:done 之后那次，所以从 iDone 之后开始找。 */
  const iDestroy = iDone >= 0 ? body.indexOf('destroySplash', iDone) : -1;

  chk(iShow >= 0, '函数里有 win.show()');
  chk(iDone >= 0, '函数里有 splash:done 通知');
  chk(iShow >= 0 && iDone >= 0 && iDestroy >= 0, '三个关键动作都存在');

  // 核心断言：显示主窗必须发生在通知淡出之前
  chk(iShow < iDone && iDone >= 0 && iDestroy > iDone,
      '主窗 show() 在启动窗淡出/销毁之前（否则中间会有空白桌面）');

  // 没有「显示过」时不该空等
  chk(/if \(!splashVisible[\s\S]{0,120}\{ destroySplash\(\); return; \}/.test(body),
      '启动窗未显示过时直接销毁，不空等动画');

  // 淡出等待要短（用户感觉不到空档），且不能是「先等等再显示」
  const m = body.match(/setTimeout\(destroySplash, (\d+)\)/);
  chk(m && Number(m[1]) <= 260,
      '淡出等待不超过 260ms（实际 ' + (m && m[1]) + 'ms）');

  // 反向：不允许出现「先 setTimeout 显示主窗」的旧写法
  chk(!/setTimeout\([\s\S]{0,40}win\.show\(\)/.test(body),
      '不存在「延迟再显示主窗」的旧写法');
}

/* ---- 2. 兜底超时仍在（渲染层崩溃时启动窗不能永远盖着） ---- */
chk(/setTimeout\(\(\) => \{[\s\S]{0,200}mainShown = true[\s\S]{0,120\}win\.show\(\)/.test(mainSrc)
    || /30000/.test(mainSrc.slice(mainSrc.indexOf('function createSplash'), mainSrc.indexOf('function showWindowAfterSplash'))),
    '启动窗有兜底超时（不会永远盖住主窗）');

/* ---- 3. 启动窗基类：alwaysOnTop 才保证淡出时盖在已显示的主窗上面 ---- */
const cs = mainSrc.slice(mainSrc.indexOf('function createSplash'), mainSrc.indexOf('function showWindowAfterSplash'));
chk(/alwaysOnTop: true/.test(cs), '启动窗创建时 alwaysOnTop: true');
chk(/setAlwaysOnTop\(true, 'screen-saver'\)/.test(cs), '启动窗提升到 screen-saver 层级');

/* ---- 4. NSIS 静态图文案：不能再说「几秒」（实测约 14 秒） ---- */
chk(/10–20 秒|10-20 秒/.test(genSrc),
    '解压阶段文案写出了真实耗时区间（10–20 秒）');
chk(!/解压约需几秒/.test(genSrc),
    '没有残留「解压约需几秒」的误导文案');

/* ---- 5. 应用内启动窗：进度缓动存在（否则数字会长时间不动） ---- */
const splashJs = fs.readFileSync(path.join(ROOT, 'js', 'splash.js'), 'utf8');
chk(/setInterval/.test(splashJs) && /cur\s*<\s*target/.test(splashJs),
    '应用内启动窗有进度缓动，数字不会长时间卡住');
chk(/splash:done/.test(splashJs), '应用内启动窗响应 done 事件');
chk(/classList\.add\('out'\)/.test(splashJs) && /transition/.test(splashSrc),
    '应用内启动窗有淡出过渡（不是硬消失）');

console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
