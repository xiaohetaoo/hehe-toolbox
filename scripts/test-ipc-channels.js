'use strict';
const { t, done } = require('./lib/harness');
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
/* 扫源码前一律先剥注释（见 registered() 里的说明） */
const strip = (s) => require(path.join(ROOT, 'lib', 'src-scan')).stripComments(s);

/* 主进程注册的通道。
 *
 * 【任务 5 之后必须扫**整个主进程**，不能只读 main.js】
 * 任务 5 把「目录搬家 + 权限/链接」两个域搬到了 ipc/dir-acl-links.js ——
 * 那 8 个 handle(dirMoveCh.X.Y, ...) 现在不在 main.js 里了。
 * 只读 main.js 的话，注册总数会从 164 掉到 156，而渲染层仍在用这 8 个通道，
 * 于是「渲染层引用了没注册的通道」会误报 8 条 —— 看起来像功能被删了。
 * （这个数字 164→156 在本轮真的出现过一次，就是搬迁刚完成时。）
 *
 * 所以这里扫「main.js 加上 ipc/ 目录下的所有 js」，把被搬走的注册也算回来。 */
function mainProcSources() {
  const files = [MAIN];
  const ipcDir = path.join(ROOT, 'ipc');
  if (fs.existsSync(ipcDir)) {
    for (const e of fs.readdirSync(ipcDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.js')) files.push(path.join(ipcDir, e.name));
    }
  }
  return files.map((f) => fs.readFileSync(f, 'utf8'));
}

function registered() {
  const set = new Set();
  const chTable = require('../lib/channels').flatten();
  /* 【必须先剥注释再扫】
   * 不剥的话，注释里出现的示例会被当成真实注册。
   * main.js 第 43 行附近就写着：
   *   * handle(dirMoveCh.X.Y, ...) 一起搬过去了
   * 它会被下面第二条正则匹配成 key = 'X.Y'，chTable 查不到所以当前侥幸无害。
   * 但只要有人在注释里举个**真实**的通道做例子（这是很自然的写法），
   * 那个并不存在的注册就会被算进 reg，
   * 进而让「没有无人调用的通道」和「注册通道总数」两条失真。
   * test-channels-sync.js 早就这么做了（它也是剥注释后扫），这里跟上。 */
  for (const s of mainProcSources().map(strip)) {
    for (const m of s.matchAll(/handle\('([^']+)'/g)) set.add(m[1]);
    /* 【常量化的通道也要算进来】任务 6 把两个域的通道名换成了
     * handle(dirMoveCh.<组>.<键>, ...)。只扫字面量的话这 8 个通道会从
     * "已注册"清单里消失，而渲染层仍在用它们，于是断言误报。
     * 这里用 lib/channels.js 的同一份表把常量还原回通道名。 */
    for (const m of s.matchAll(/handle\(dirMoveCh\.([A-Z_]+)\.([A-Z_]+)\s*,/g)) {
      const key = m[1] + '.' + m[2];
      if (chTable[key]) set.add(chTable[key]);
    }
    /* 搬出去的模块把 CHANNELS 做成了本地别名 CH：handle(CH.DIR_MOVE.MOVE, ...) */
    for (const m of s.matchAll(/handle\(CH\.([A-Z_]+)\.([A-Z_]+)\s*,/g)) {
      const key = m[1] + '.' + m[2];
      if (chTable[key]) set.add(chTable[key]);
    }
  }
  return set;
}

/* 主进程**主动推送**到渲染层的事件通道（用 send()/webContents.send 发，
 * 渲染层用 api.on() 订阅）。它们本来就不出现在 handle() 里，不算未注册。 */
function pushedChannels() {
  const set = new Set();
  // send('x:y', …) / .send('x:y', …) / splashSend('x:y', …) 等任意 *Send( 调用
  for (const s of mainProcSources()) {
    for (const m of s.matchAll(/(?:\bsend|\w*Send)\(\s*'([^']+)'/g)) set.add(m[1]);
  }
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

  /* 【必须排除常量表文件自己】
   * js/channels.js 里就是一张「语义名 → 通道字面量」的表：
   *   WHO_LOCKS_DIR: 'file:who-locks-dir'
   *   DIR_MOVE: { MOVE: 'dir:move' }
   * 把它扫进来的后果是：**表里有哪个通道，就等于「渲染层调用了哪个通道」**。
   * 于是本文件后面那条「常量表里的通道：主进程注册 + 渲染层调用 双向都在」
   * 变成了自我满足 —— 表本身就是它要找的调用点。
   * 实测确认过：把 js/tools/file-unlock.js 里真实的
   *   invoke(Channels.CHANNELS.ACL_LINKS.WHO_LOCKS_DIR, it.path)
   * 换成别的通道，referenced() 仍然返回 true，断言照样 PASS。
   *
   * 而「渲染层引用了没注册的通道」「注册了没人用的通道」正是本文件存在的
   * 唯一目的，被这一条掏空就等于整份审计失效。
   * 常量表自身的正确性由 scripts/test-channels-sync.js 单独校验
   * （它比对 lib/channels.js 与 js/channels.js 的键与值），不在这里重复。 */
  const CONST_TABLE_FILES = new Set([path.join(ROOT, 'js', 'channels.js')]);

  const set = new Set();
  /* 通道字面量形如 'a:b' 或 'a:b:c'（带冒号、无空格）。
   * 注意要允许**多级冒号**：辅助窗口用的就是 win:ruler:move 这种写法，
   * 只匹配单冒号会把它们误判成「无人调用」。 */
  const RE = /['"`]([a-z][a-z0-9]*(?:[-:][a-z0-9]+)*)['"`]/gi;
  for (const f of files) {
    if (CONST_TABLE_FILES.has(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(RE)) {
      if (m[1].includes(':')) set.add(m[1]);
    }
  }
  return set;
}

/* 【按「常量引用」统计已迁移域的调用点】
 *
 * 通道名常量化之后，渲染层的调用长这样：
 *   invoke(Channels.CHANNELS.ACL_LINKS.WHO_LOCKS_DIR, it.path)
 * 通道名不再以字面量出现，所以上面的 referenced()（只认字面量）
 * 看不见它们 —— 这会同时破坏下面两条断言的语义：
 *   · 「注册了没人用」会把这 8 个全报出来（其实都在用）
 *   · 反过来，如果只把常量表排除掉却不补这条，「常量表里的通道双向都在」
 *     就永远验不到真实调用点
 *
 * 做法：扫 `Channels.CHANNELS.<组>.<键>` 的**引用形态**，
 * 把 <组>.<键> 映射回 lib/channels.js 里的真实通道名。
 * 这里不直接 require lib/channels.js —— 那个模块是主进程侧的，
 * 测试要验的恰恰是「渲染层这份表与主进程那份是否一致」，
 * 自己引用同一份来源会让比对失去意义。所以从 js/channels.js 的
 * 字面量里解析（那份表的键值正确性由 test-channels-sync.js 单独保证）。
 */
function referencedByConst() {
  const tablePath = path.join(ROOT, 'js', 'channels.js');
  if (!fs.existsSync(tablePath)) return new Set();
  const tableSrc = fs.readFileSync(tablePath, 'utf8');
  /* 解析出 "组.键" → 通道名。表的结构是 CHANNELS = { GROUP: { KEY: 'value' } }，
   * 这里用「找 GROUP 开括号，再在块内找 KEY: 'value'」的两级扫描，
   * 不去完整解析 JS（那是过度工程，而且表的结构是人工维护的常量）。 */
  const map = new Map();          // "GROUP.KEY" → channel
  const groupRe = /([A-Z][A-Z0-9_]*)\s*:\s*\{/g;
  let gm;
  while ((gm = groupRe.exec(tableSrc))) {
    const group = gm[1];
    const blockStart = gm.index + gm[0].length;
    /* 花括号配平取出这一组的内容 */
    let depth = 1, i = blockStart;
    while (i < tableSrc.length && depth > 0) {
      const ch = tableSrc[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const block = tableSrc.slice(blockStart, i - 1);
    const keyRe = /([A-Z][A-Z0-9_]*)\s*:\s*'([^']+)'/g;
    let km;
    while ((km = keyRe.exec(block))) map.set(group + '.' + km[1], km[2]);
  }

  /* 扫渲染层对 Channels.CHANNELS.<组>.<键> 的引用 */
  const set = new Set();
  const files = [];
  const push = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { push(p); continue; }
      if (e.name.endsWith('.js') || e.name.endsWith('.html')) files.push(p);
    }
  };
  push(path.join(ROOT, 'js'));
  const useRe = /Channels\.CHANNELS\.([A-Z][A-Z0-9_]*)\.([A-Z][A-Z0-9_]*)/g;
  for (const f of files) {
    if (f === path.join(ROOT, 'js', 'channels.js')) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(useRe)) {
      const ch = map.get(m[1] + '.' + m[2]);
      if (ch) set.add(ch);
    }
  }
  return set;
}

const reg = registered();
const ref = referenced();
const refConst = referencedByConst();
/* 【两路引用的并集才是「渲染层真的在用哪些通道」】
 *   referenced()          —— 通道名以字面量出现（未迁移的绝大多数域）
 *   referencedByConst()   —— 通道名以 Channels.CHANNELS.X.Y 常量引用（已迁移的 2 个域）
 * 只算字面量会把已迁移域的 8 个通道误判成「无人调用」，
 * 只算常量引用则漏掉另外 152 个。两者必须合并。 */
const allRef = new Set([...ref, ...refConst]);
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
  const unused = [...reg].filter((c) => !allRef.has(c) && !INTENTIONALLY_KEPT[c]);
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

/* ---- 6. 常量表里的通道必须"双向都在"（任务 6 的升级）----
 *
 * 【这条比原来的文本差集硬得多】
 * 上面几条是靠**扫源码文本**做差集的：如果主进程与渲染层错成同一个字符串，
 * 差集为空、测试全绿，但运行时一定「No handler registered」。
 * 这里改成"比对表"：
 *   · lib/channels.js 里登记的每个通道，必须①在主进程注册了、
 *     ②在渲染层有调用点；
 *   · 并且渲染层用的常量表（js/channels.js）必须与主进程那份逐字一致
 *     （那条在 scripts/test-channels-sync.js 里做得更细，这里只做一个交叉确认，
 *      因为两份文件都可能被改坏，多一道闸不吃亏）。
 */
t('常量表里的通道：主进程注册 + 渲染层调用 双向都在', () => {
  const chTable = require('../lib/channels').flatten();
  const entries = Object.entries(chTable);
  assert.ok(entries.length > 0, '通道常量表是空的 —— 迁移未生效？');
  const noReg = entries.filter(([, ch]) => !reg.has(ch)).map(([k, ch]) => k + '→' + ch);
  assert.deepStrictEqual(noReg, [],
    '这些通道登记在常量表里但主进程没注册：' + noReg.join(', '));
  const noCall = entries.filter(([, ch]) => !allRef.has(ch)).map(([k, ch]) => k + '→' + ch);
  assert.deepStrictEqual(noCall, [],
    '这些通道登记在常量表里但渲染层没有调用点（登记了却没人用 = 未来误删风险）：' + noCall.join(', '));
});

console.log(`\n注册 ${reg.size} 个通道，渲染层引用 ${allRef.size} 个，无人调用 ${[...reg].filter((c) => !allRef.has(c)).length} 个`);
done();
