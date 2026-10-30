'use strict';
/* IPC 通道审计（P2-5 的回归测试）。
 *
 * 作用：对比「主进程注册的通道」与「渲染层实际调用的通道」，
 * 把差集打印出来，并断言差集只包含**明确批准保留**的那几个。
 *
 * 为什么需要这个测试：注册了却没人调的通道是真实的风险面——
 * 它们照样能被渲染层（或将来任何注入脚本）直接调用，等于多开一个入口。
 * 历史上 qr:save 就是这样一条没走覆盖闸门的任意路径写文件入口。
 * 反过来，渲染层调用了却没注册的通道会在运行时才炸（"调用失败"），
 * 也必须挡在 CI 里。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'main.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

/* 主进程注册的通道 */
function registered() {
  const s = fs.readFileSync(MAIN, 'utf8');
  return new Set([...s.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]));
}

/* 主进程**主动推送**到渲染层的事件通道（用 send()/webContents.send 发，
 * 渲染层用 api.on() 订阅）。它们本来就不出现在 handle() 里，不算未注册。 */
function pushedChannels() {
  const s = fs.readFileSync(MAIN, 'utf8');
  const set = new Set();
  // send('x:y', …) / .send('x:y', …) / splashSend('x:y', …) 等任意 *Send( 调用
  for (const m of s.matchAll(/(?:\bsend|\w*Send)\(\s*'([^']+)'/g)) set.add(m[1]);
  return set;
}

/* 渲染层与辅助窗口里被「按字面量」引用的通道 */
function referenced() {
  const files = [];
  const push = (dir, recursive) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (recursive) push(p, true); continue; }
      if (e.name.endsWith('.js') || e.name.endsWith('.html')) files.push(p);
    }
  };
  push(path.join(ROOT, 'js'), true);
  for (const f of ['index.html', 'pin.html', 'ruler.html', 'snip.html', 'preload.js']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) files.push(p);
  }

  const set = new Set();
  /* 通道字面量形如 'a:b' 或 'a:b:c'（带冒号、无空格）。
   * 注意要允许**多级冒号**：辅助窗口用的就是 win:ruler:move 这种写法，
   * 只匹配单冒号会把它们误判成「无人调用」。 */
  const RE = /['"`]([a-z][a-z0-9]*(?:[-:][a-z0-9]+)*)['"`]/gi;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(RE)) {
      if (m[1].includes(':')) set.add(m[1]);
    }
  }
  return set;
}

const reg = registered();
const ref = referenced();
const pushed = pushedChannels();

/* 明确决定「保留」的通道 → 理由。
 * 保留的前提：要么仍在使用、要么是刻意留的兼容入口。 */
const INTENTIONALLY_KEPT = {
  // 资源类通道仍在外部或测试里使用
  'fs:stat': '文件列表与多个工具都要单独取体积/类型',
};

/* ---- 1. 渲染层 invoke 的通道必须都已注册（推送事件与 CSS 值不计） ---- */
t('渲染层引用的通道都有主进程注册或属于推送事件', () => {
  /* 这些不是 IPC 通道，是被正则误抓的 CSS 属性值 / DOM 类名 */
  const NOT_A_CHANNEL = new Set(['user-select:text', 'td:last-child']);
  const missing = [...ref].filter((c) => !reg.has(c) && !pushed.has(c) && !NOT_A_CHANNEL.has(c));
  assert.deepStrictEqual(missing, [], '这些通道渲染层在用但主进程既没注册也不推送：' + missing.join(', '));
});

/* ---- 2. 差集（注册了没人用）必须是空的，或只在白名单里 ---- */
t('没有无人调用的 IPC 通道（白名单除外）', () => {
  const unused = [...reg].filter((c) => !ref.has(c) && !INTENTIONALLY_KEPT[c]);
  assert.deepStrictEqual(unused, [],
    '这些通道注册了但全项目无调用方，应删除或补上保护后再白名单：\n  ' + unused.join('\n  '));
});

/* ---- 3. 已知的高危旧通道必须已消失 ---- */
t('无覆盖保护的旧写盘通道已移除', () => {
  for (const ch of ['qr:save', 'dialog:message', 'app:get-accent', 'rec:video-devices',
                    'win:is-maximized', 'fs:hash-file']) {
    assert.ok(!reg.has(ch), ch + ' 仍被注册（该通道已确认无调用方，应删除）');
  }
});

/* ---- 4. 辅助窗口用的通道不能被误删 ---- */
t('三个辅助窗口依赖的通道仍在注册', () => {
  const must = ['win:pin-close', 'win:pin-move', 'win:pin-resize',
                'win:ruler:close', 'win:ruler:move', 'snip:finish'];
  const missing = must.filter((c) => !reg.has(c));
  assert.deepStrictEqual(missing, [], '被误删：' + missing.join(', '));
});

/* ---- 5. 通道总数落在合理区间（防止批量误删） ---- */
t('注册通道总数仍在其量级（防止误删）', () => {
  assert.ok(reg.size >= 140, '注册通道只剩 ' + reg.size + ' 个，疑似批量误删');
  assert.ok(reg.size <= 200, '注册通道涨到 ' + reg.size + ' 个，疑似重复注册');
});

console.log(`\n注册 ${reg.size} 个通道，渲染层引用 ${ref.size} 个，无人调用 ${[...reg].filter((c) => !ref.has(c)).length} 个`);
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
