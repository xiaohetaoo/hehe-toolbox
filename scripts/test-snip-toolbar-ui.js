'use strict';
/* 截图标注工具条：图标风格统一 + 马赛克真的生效 + 文字输入法可用。
 *
 * ============ 这三条各自抓的是哪次事故 ============
 * ① 图标风格不统一（用户截图反馈）
 *    工具条五个形状按钮混用三种形态：▭ ➚（几何字符）、✏️（彩色 emoji）、
 *    T ▦（字母与网格字符）。⾃形宽度、字重、基线、颜⾊全都不受控，
 *    深⾊浮层上 emoji 还会被系统染⾊ —— 一排按钮看起来像拼凑的。
 * ② 马赛克不能用（用户反馈）
 *    drawImage 的源矩形和目标矩形被设成同一尺寸，经 ctx.scale(DPR,DPR)
 *    后完全相等 = 1:1 原样复制，涂抹前后像素不变。
 * ③ 文字输入不能用（用户反馈）
 *    中文输入法选候选词那一次回车被当成「提交」，拼音被直接写进标注，
 *    汉字进不了输入框。
 *
 * ============ 为什么同时用「源码断言」和「真机断言」 ============
 * ② 和 ③ 都能在真实 Electron 里跑出来（本文件的 E2E 段），那是最有说服力的；
 * 但 E2E 在 CI 无 electron.exe 时会 SKIP，于是源码断言作为**永久的低层护栏**：
 * 即使哪天 E2E 被跳过，把 drawImage 改回同尺寸、把 isComposing 判断删掉，
 * 源码断言仍会红。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { t, done, ROOT, readSrc } = require('./lib/harness');

/* ================= 一、源码断言（不依赖 Electron） ================= */

t('工具条不再用 emoji / 几何字符当图标，改为 SVG', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  /* 锁的是：TOOLS 退回字符图标 —— ▭ ➚ 依赖字体（缺字变豆腐块），
   * ✏️ 是彩色 emoji（深色浮层上被系统染色，字重/基线/颜色都不受控）。
   * 这正是用户截图里「风格不统一」的直接来源。 */
  if (/const TOOLS = \[\[/.test(src)) {
    const seg = src.slice(src.indexOf('const TOOLS'), src.indexOf('];', src.indexOf('const TOOLS')) + 2);
    /* 锁的是：五个形状按钮里又混进字符图标（▭ ▦ ✏ ➚ 之一）。 */
    if (/✏|▭|▦|➚/.test(seg)) {
      throw new Error('TOOLS 里仍有字符图标：' + seg.trim());
    }
  }
  /* 锁的是：没有 svgIcon() 这个统一的图标生成入口 —— 各按钮自己拼 HTML 迟早分叉。 */
  if (!/function svgIcon\(/.test(src)) throw new Error('缺少 svgIcon()');
  /* 锁的是：形状按钮没用 svgIcon() 渲染 —— 图标形态又回到不受控状态。 */
  if (!/b\.innerHTML = svgIcon\(/.test(src)) throw new Error('形状按钮没有用 svgIcon() 渲染');
});

t('工具条按钮都有 aria-label（图标按钮没有可见文字）', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  /* 锁的是：图标按钮只设置 title 不设置 aria-label —— 读屏器只能念「按钮」。
   * title 只管鼠标悬停，与可访问性无关。 */
  if (!/b\.setAttribute\('aria-label', label\)/.test(src)) {
    throw new Error('形状按钮没有 aria-label');
  }
  /* 锁的是：文字按钮（撤销/重选/复制…）漏了 aria-label。 */
  if (!/b\.setAttribute\('aria-label', t\)/.test(src)) {
    throw new Error('文字按钮没有 aria-label');
  }
});

t('马赛克的源/目标尺寸不得相等（否则是 1:1 复制）', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  /* 锁的是：马赛克退回「src 与 dst 同尺寸」的写法。
   * 原来那一行是
   *   ctx.drawImage(img, sx, sy, px*DPR, px*DPR, p.x-px/2, p.y-px/2, px, px)
   * 在 ctx.scale(DPR,DPR) 之下 dst 也被放大 DPR 倍 → 与 src 完全相等 →
   * 原样复制，涂抹前后像素不变（用户看到「点了没反应」）。
   * 现在必须走「取平均色 + fillRect」，那才是真马赛克（硬边色块）。 */
  /* 锁的是：同尺寸 drawImage 复活 —— 那就是原样复制，涂抹前后像素不变。 */
  if (/drawImage\(img,\s*sx,\s*sy,\s*sw,\s*sh,\s*p\.x\s*-\s*px\s*\/\s*2/.test(src)) {
    throw new Error('马赛克仍在用同尺寸 drawImage（1:1 复制，无效果）');
  }
  /* 锁的是：删掉取源图平均色的 getSourceData() —— 没有它就取不到格子颜色，
   * 只能退回「原样复制」或「填死色」，两种都不是马赛克。 */
  if (!/getSourceData\(/.test(src)) throw new Error('缺少取源图平均色的 getSourceData()');
  /* 锁的是：马赛克不按整格铺纯色 —— 用 drawImage 缩放只会得到模糊（等于高斯模糊），
   * 不是用户要的硬边马赛克。 */
  if (!/ctx\.fillRect\(gx \* block, gy \* block, block, block\)/.test(src)) {
    throw new Error('马赛克没有按整格 fillRect 铺纯色');
  }
  /* 锁的是：没有「同格去重」——沿路径拖拽每个像素点都画一格，
   * 反复重采样同一格会让边缘抖动、且白耗性能。 */
  if (!/painted\.has\(key\)/.test(src)) throw new Error('马赛克缺少同格去重');
});

t('文字输入必须判断输入法组词状态（isComposing）', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  /* 锁的是：删掉 isComposing 判断 —— 中文用户选候选词时按的回车
   * 会被当成「提交」，拼音被写进标注、汉字进不了输入框。
   * 这是用户说的「文字输入不能用」的直接原因。 */
  if (!/ev\.isComposing/.test(src)) {
    throw new Error('textInput 的 keydown 没有判断 ev.isComposing');
  }
  /* 锁的是：删掉 keyCode 229 兜底 —— 部分输入法（尤其旧版搜狗/QQ 拼音）
   * 组词时只给 keyCode 229，不给 isComposing，只判后者等于没判。 */
  if (!/keyCode === 229/.test(src)) {
    throw new Error('没有兜底判断 keyCode 229（部分输入法只给这个）');
  }
});

t('颜色选择 = 常用色 + 调色板，粗细 = 滑杆（用户明确要求）', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  /* 锁的是：调色板入口被删 —— 只剩 6 个固定色，用户想用截图里的品牌色就没法选。
   * 用原生 input[type=color]（系统取色器带滴管/十六进制/色域切换），
   * 自己画取色面板在全屏透明窗里还要额外处理浮层与点击穿透。 */
  if (!/type = 'color'/.test(src)) {
    throw new Error('没有 input[type=color] 调色板');
  }
  /* 锁的是：粗细退回「细/中/粗」三档按钮 —— 三档只有 2/3/5，
   * 覆盖不了画细箭头（1px）和涂粗马赛克（10px+）的需求。 */
  if (!/slider\.type = 'range'/.test(src)) {
    throw new Error('线宽不是 range 滑杆');
  }
  /* 锁的是：三档按钮与滑杆并存 —— 两套粗细入口会互相覆盖状态。 */
  if (/mkBtn\('细'/.test(src) || /mkBtn\('中'/.test(src) || /mkBtn\('粗'/.test(src)) {
    throw new Error('仍存在「细/中/粗」三档按钮');
  }
});

t('工具条状态变化不重建 DOM（否则滑杆拖拽中断）', () => {
  const src = readSrc('js/auxwin/snip-2.js');
  /* 锁的是：点颜色/拖滑杆时又调 showBar() 整条重建。
   * 后果：① 滑杆拖到一半被换掉，手指一松值跳回去；
   *      ② 悬停中的按钮闪一下；③ 每次都重算布局，颜色多时卡顿。
   * 正确做法是 syncBar() 只改 class/属性，DOM 保持同一批对象。 */
  /* 锁的是：syncBar() 被删 —— 没有它就只剩「整条重建」这一条路。 */
  if (!/function syncBar\(/.test(src)) throw new Error('缺少 syncBar()');
  /* 锁的是：切工具时仍调 showBar() 重建（应为 syncBar 只改 class）。 */
  if (!/tool = id; syncBar\(\)/.test(src)) {
    throw new Error('切换工具时仍在重建工具条（应为 syncBar）');
  }
  /* 锁的是：滑杆的 input 处理器里调了 showBar() —— 那是拖拽中断的直接原因。 */
  const oninputSeg = src.slice(src.indexOf('slider.oninput'), src.indexOf('placeBar();', src.indexOf('slider.oninput')));
  if (/showBar\(\)/.test(oninputSeg)) {
    throw new Error('滑杆 oninput 里仍在重建工具条');
  }
});

/* ================= 二、真机 E2E（有 electron.exe 才跑） ================= */

const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON_EXE)) {
  console.log('SKIP 未找到 electron.exe（真机部分跳过，源码断言已覆盖同样的事实）');
  done();
  return;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snipui-'));
const imgPath = path.join(tmp, 'checker.png');

/* 纯 Node 生成 2px 细棋盘 PNG（不引依赖）。
 * 用棋盘而不是纯白：纯白图上任何马赛克都看不出变化，那种探针等于空转。 */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
(function makeChecker(file, w, h, cell) {
  const zlib = require('zlib');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const v = on ? 0 : 255;
      raw[o++] = v; raw[o++] = v; raw[o++] = v;
    }
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
})(imgPath, 420, 320, 2);

const PROBE = `
(async () => {
  const out = {};
  const c = document.getElementById('c');
  const ctx = c.getContext('2d');
  const DPR = window.devicePixelRatio || 1;
  const stage = document.getElementById('stage');
  const ti = document.getElementById('textInput');
  const bar = document.getElementById('bar');
  const T = window.__snipTest;
  if (!T) return { fatal: '__snipTest 缺失' };
  const mouse = (ty, x, y) => stage.dispatchEvent(new MouseEvent(ty, {
    clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));

  // ---- 工具条图标构成 ----
  T.select(30, 30, 340, 240);
  await new Promise(r => setTimeout(r, 80));
  /* 只取前 5 个「形状工具」按钮（矩形/箭头/画笔/文字/马赛克）。
   * 后面的「细/中/粗」是纯文字按钮、「撤销…OCR」是图标+文字按钮，
   * 它们本来就该有文字，混进来会让「无字符残留」这条判据失真。 */
  const shapeBtns = [...bar.querySelectorAll('.tbtn')].slice(0, 5);
  const shapeLabels = shapeBtns.map(b => b.getAttribute('aria-label'));
  out.toolbar = {
    count: shapeBtns.length,
    allSvg: shapeBtns.every(b => !!b.querySelector('svg')),
    labels: shapeLabels,
    // 关键：五个形状按钮里不许残留字符图标
    textContent: shapeBtns.map(b => b.textContent).join(''),
    svgHasStroke: shapeBtns.every(b => {
      const s = b.querySelector('svg');
      return s && s.querySelector('rect,path,polyline,circle');
    }),
    // 五个图标必须各不相同（复制粘贴同一个路径会「看着统一」但功能不可辨）
    distinctPaths: new Set(shapeBtns.map(b => {
      const s = b.querySelector('svg');
      return s ? s.innerHTML : '';
    })).size
  };

  // ---- 马赛克真的改变像素 ----
  T.setTool('mosaic');
  T.getShapes().length = 0;
  const art = (x, y, w, h) => {
    const W = Math.round(w*DPR), H = Math.round(h*DPR);
    const d = ctx.getImageData(Math.round(x*DPR), Math.round(y*DPR), W, H).data;
    let dark = 0, light = 0, mid = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 70) dark++; else if (d[i] > 185) light++; else mid++;
    }
    return { dark, light, mid };
  };
  out.mosaicBefore = art(100, 100, 90, 60);
  mouse('mousedown', 100, 100);
  for (let i = 0; i <= 16; i++) mouse('mousemove', 100 + i*5, 100 + i*3);
  mouse('mouseup', 180, 148);
  await new Promise(r => setTimeout(r, 80));
  out.mosaicAfter = art(100, 100, 90, 60);
  out.mosaicShapes = T.getShapes().map(s => ({ t: s.type, n: (s.pts||[]).length }));

  // ---- 文字：英文 + Enter ----
  function key(k, opts) {
    const ev = new KeyboardEvent('keydown', Object.assign(
      { key: k, bubbles: true, cancelable: true }, opts || {}));
    let stopped = false;
    const orig = ev.stopPropagation.bind(ev);
    ev.stopPropagation = () => { stopped = true; orig(); };
    if (ti.style.display !== 'none' && typeof ti.onkeydown === 'function') ti.onkeydown(ev);
    if (!stopped) window.dispatchEvent(ev);
    return { stopped };
  }
  T.getShapes().length = 0;
  T.setTool('text');
  T.select(30, 30, 340, 240);
  await new Promise(r => setTimeout(r, 40));
  mouse('mousedown', 90, 160); mouse('mouseup', 90, 160);
  await new Promise(r => setTimeout(r, 60));
  out.textOpened = getComputedStyle(ti).display;
  ti.value = 'hello';
  key('Enter');
  await new Promise(r => setTimeout(r, 60));
  out.textEn = T.getShapes().filter(s => s.type === 'text').map(s => s.text);

  // ---- 文字：中文输入法。选词回车（isComposing）不得提交 ----
  T.getShapes().length = 0;
  mouse('mousedown', 90, 110); mouse('mouseup', 90, 110);
  await new Promise(r => setTimeout(r, 60));
  ti.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  ti.value = 'nihao';
  key('Enter', { isComposing: true });
  await new Promise(r => setTimeout(r, 50));
  out.imeDuringCompose = {
    stillOpen: getComputedStyle(ti).display,
    committed: T.getShapes().filter(s => s.type === 'text').map(s => s.text)
  };
  ti.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
  ti.value = '你好';
  key('Enter');
  await new Promise(r => setTimeout(r, 60));
  out.imeFinal = T.getShapes().filter(s => s.type === 'text').map(s => s.text);

  // ---- Esc 在输入框里只取消输入，不关整个截图窗 ----
  T.getShapes().length = 0;
  T.select(30, 30, 340, 240);
  await new Promise(r => setTimeout(r, 40));
  mouse('mousedown', 90, 200); mouse('mouseup', 90, 200);
  await new Promise(r => setTimeout(r, 60));
  ti.value = 'x';
  key('Escape');
  await new Promise(r => setTimeout(r, 60));
  out.esc = {
    inputHidden: getComputedStyle(ti).display,
    committed: T.getShapes().filter(s => s.type === 'text').map(s => s.text),
    pageAlive: !!document.getElementById('c')
  };

  // ---- 常用色 + 调色板 ----
  T.select(30, 30, 340, 240);
  await new Promise(r => setTimeout(r, 100));
  const sws = [...bar.querySelectorAll('.sw')].filter(s => !s.classList.contains('sw-custom'));
  const firstBtn = bar.querySelector('.tbtn');
  out.swatches = { count: sws.length };
  const green = sws.find(s => s.dataset.color === '#00B42A');
  if (green) {
    green.click();
    await new Promise(r => setTimeout(r, 50));
    out.swatches.picked = {
      greenOn: green.classList.contains('on'),
      othersOff: sws.filter(s => s !== green).every(s => !s.classList.contains('on')),
      /* 锁的是：点颜色时整条工具条被重建（DOM 对象被换掉）——
       * 那会让正在悬停的按钮闪一下，也是滑杆拖拽中断的同一个病根。 */
      domPreserved: bar.querySelector('.tbtn') === firstBtn
    };
  }
  const picker = bar.querySelector('#colorPicker');
  out.picker = { exists: !!picker, type: picker ? picker.type : null };
  if (picker) {
    picker.value = '#00ccff';
    picker.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    const custom = bar.querySelector('.sw-custom');
    out.picker.customOn = custom ? custom.classList.contains('on') : null;
    out.picker.commonOnCount = sws.filter(s => s.classList.contains('on')).length;
    if (green) {
      green.click();
      await new Promise(r => setTimeout(r, 50));
      out.picker.backToCommon = {
        customOff: custom ? !custom.classList.contains('on') : null,
        greenOn: green.classList.contains('on')
      };
    }
  }

  // ---- 线宽滑杆 ----
  const slider = bar.querySelector('#sizeSlider');
  out.slider = slider ? { exists: true, type: slider.type, min: slider.min, max: slider.max } : { exists: false };
  if (slider) {
    const ref = slider;
    out.slider.steps = [];
    for (const v of [1, 6, 12]) {
      slider.value = String(v);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      out.slider.steps.push({
        v: Number(slider.value),
        num: (bar.querySelector('#sizeNum') || {}).textContent,
        /* 锁的是：拖动滑杆时元素被替换 —— 那会让拖拽中断、值跳回。 */
        same: bar.querySelector('#sizeSlider') === ref
      });
    }
    /* 线宽真的影响笔画：同一条竖线上红色像素数应随线宽显著增加 */
    function strokePx(sz) {
      T.getShapes().length = 0;
      T.addShape({ type: 'rect', color: '#FF0000', size: sz, x1: 60, y1: 90, x2: 220, y2: 200 });
      const d = ctx.getImageData(Math.round(60*DPR), Math.round(110*DPR), 1, Math.round(70*DPR)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i+1] < 120) n++;
      return n;
    }
    out.slider.thin = strokePx(1);
    out.slider.thick = strokePx(10);
  }
  return out;
})()
`;

const runner = [
  "const { app, BrowserWindow } = require('electron');",
  "const path = require('path');",
  "const ROOT = " + JSON.stringify(ROOT) + ";",
  "const IMG = " + JSON.stringify(imgPath) + ";",
  "const PROBE = " + JSON.stringify(PROBE) + ";",
  'app.whenReady().then(async () => {',
  '  const w = new BrowserWindow({ width: 420, height: 320, show: false,',
  "    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false,",
  "      additionalArguments: ['--hehe-packaged=0'] } });",
  "  const q = { src: IMG, mode:'annotate', dx:'0', dy:'0', scale:'1', w:'420', h:'320', accent:'polar' };",
  "  await w.loadFile(path.join(ROOT, 'snip.html'), { query: q });",
  '  await new Promise(r => setTimeout(r, 800));',
  '  let res;',
  '  try { res = await w.webContents.executeJavaScript(PROBE); }',
  '  catch (e) { res = { fatal: String(e && e.message || e) }; }',
  "  console.log('SNIPUI ' + JSON.stringify(res));",
  '  app.exit(0);',
  '});'
].join('\n');

const scriptPath = path.join(tmp, 'runner.js');
fs.writeFileSync(scriptPath, runner, 'utf8');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');

let raw = '';
try {
  raw = execFileSync(ELECTRON_EXE, [scriptPath], { env, encoding: 'utf8', timeout: 120000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const line = String(raw || '').split(/\r?\n/).find(l => l.startsWith('SNIPUI '));
if (!line) {
  console.log('FAIL 未拿到 SNIPUI 结果（真机部分）');
  console.log(String(raw).slice(-1500));
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
  return;
}
const R = JSON.parse(line.slice('SNIPUI '.length));

t('真机：工具条五个形状按钮都是 SVG 图标、无字符残留', () => {
  if (R.fatal) throw new Error(R.fatal);
  const b = R.toolbar;
  if (!b || b.count < 5) throw new Error('形状按钮不足 5 个：' + JSON.stringify(b));
  if (!b.allSvg) throw new Error('有按钮不是 SVG：' + JSON.stringify(b));
  /* 锁的是：按钮里又混进字符图标 —— 用户看到的「风格不统一」就是它。 */
  if (/[▭▦➚✏T]/.test(b.textContent)) {
    throw new Error('按钮里仍有字符图标：' + JSON.stringify(b.textContent));
  }
  if (!b.svgHasStroke) throw new Error('SVG 里没有图形元素');
  /* 锁的是：五个按钮贴同一个图标 —— 视觉上"统一"了但用户分不清哪个是哪个。
   * 统一的是**风格**，不是形状。 */
  if (b.distinctPaths !== 5) {
    throw new Error('五个形状按钮只有 ' + b.distinctPaths + ' 种图标（应各不相同）：' + JSON.stringify(b.labels));
  }
});

t('真机：马赛克涂抹后该区域出现大块同色（真的生效了）', () => {
  const a = R.mosaicBefore, b = R.mosaicAfter;
  if (!a || !b) throw new Error('没拿到马赛克前后的像素统计');
  /* 棋盘原图每一格只有 2 逻辑像素，明暗像素数接近相等；
   * 马赛克后每格被填成平均色（灰），mid 通道显著上升。 */
  const total = (x) => x.dark + x.light + x.mid;
  const midBefore = a.mid / total(a);
  const midAfter = b.mid / total(b);
  if (!(midAfter > midBefore + 0.05)) {
    throw new Error('马赛克没有产生中间色块：mid 占比 ' + midBefore.toFixed(3) + ' -> ' + midAfter.toFixed(3));
  }
  if (!R.mosaicShapes || !R.mosaicShapes.length) throw new Error('没有记录到马赛克标注');
});

t('真机：文字输入英文可用、Esc 只取消输入', () => {
  if (R.textOpened !== 'block') throw new Error('点 T 后输入框没出现：' + R.textOpened);
  if (JSON.stringify(R.textEn) !== JSON.stringify(['hello'])) {
    throw new Error('英文草稿没提交成功：' + JSON.stringify(R.textEn));
  }
  if (R.esc.inputHidden !== 'none') throw new Error('Esc 后输入框仍显示');
  if (!R.esc.pageAlive) throw new Error('Esc 把整个截图窗关掉了（应只取消输入）');
  if ((R.esc.committed || []).length) throw new Error('Esc 后仍产生了标注');
});

t('真机：中文输入法选词回车不误提交', () => {
  const d = R.imeDuringCompose;
  if (!d) throw new Error('没拿到组词阶段的数据');
  /* 锁的是：组词中的回车被当成提交 —— 拼音被写进标注、汉字进不了输入框。
   * 这正是中文用户「文字输入不能用」的现场。 */
  if (d.stillOpen !== 'block') throw new Error('组词中按回车把输入框关掉了');
  if ((d.committed || []).length) throw new Error('组词中按回车产生了标注：' + JSON.stringify(d.committed));
  if (JSON.stringify(R.imeFinal) !== JSON.stringify(['你好'])) {
    throw new Error('组词结束后没能提交汉字：' + JSON.stringify(R.imeFinal));
  }
});

t('真机：常用色一键选中，且切换颜色不重建 DOM', () => {
  const s = R.swatches;
  if (!s) throw new Error('没拿到色块数据');
  if (s.count < 6) throw new Error('常用色不足 6 个：' + s.count);
  if (!s.picked) throw new Error('没拿到点选后的状态');
  if (!s.picked.greenOn) throw new Error('点了绿色但没标为选中');
  if (!s.picked.othersOff) throw new Error('同时有多个色块显示为选中');
  /* 锁的是：点颜色时整条工具条被重建 —— 悬停中的按钮会闪一下，
   * 且这正是滑杆拖拽中断的同一个病根。 */
  if (!s.picked.domPreserved) throw new Error('点颜色导致工具条被重建（DOM 对象被替换）');
});

t('真机：调色板可用，且与常用色的选中态互斥', () => {
  const p = R.picker;
  if (!p || !p.exists) throw new Error('没有调色板入口');
  if (p.type !== 'color') throw new Error('调色板不是 input[type=color]：' + p.type);
  /* 锁的是：自定义色选完却不显示为选中 —— 用户不知道自己当前用的哪个色。 */
  if (!p.customOn) throw new Error('选了自定义色但调色板未标为选中');
  /* 锁的是：自定义色与常用色同时显示为选中 —— 两个"当前色"，用户无从判断。 */
  if (p.commonOnCount !== 0) throw new Error('选自定义色时仍有 ' + p.commonOnCount + ' 个常用色显示选中');
  if (p.backToCommon) {
    if (!p.backToCommon.customOff) throw new Error('点回常用色后调色板仍显示选中');
    if (!p.backToCommon.greenOn) throw new Error('点回常用色后该色未显示选中');
  }
});

t('真机：线宽滑杆连续可调，且拖动时元素不被替换', () => {
  const s = R.slider;
  if (!s || !s.exists) throw new Error('没有线宽滑杆');
  if (s.type !== 'range') throw new Error('线宽控件不是 range：' + s.type);
  if (Number(s.min) !== 1 || Number(s.max) !== 12) {
    throw new Error('滑杆范围不是 1~12：' + s.min + '~' + s.max);
  }
  for (const st of s.steps || []) {
    if (st.num !== String(st.v)) throw new Error('滑杆值 ' + st.v + ' 与显示 ' + st.num + ' 不一致');
    /* 锁的是：拖动滑杆时元素被替换 —— 拖拽会中断、值跳回。 */
    if (!st.same) throw new Error('拖动滑杆时元素被替换（拖拽会中断）');
  }
  /* 锁的是：线宽滑杆只是装饰 —— 调了但画出来的笔画粗细没变。
   * 1px 与 10px 在同一位置的红色像素数必须显著不同。 */
  if (!(s.thick > s.thin * 2)) {
    throw new Error('线宽没有真正影响笔画：1px=' + s.thin + 'px 10px=' + s.thick + 'px');
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
done();
