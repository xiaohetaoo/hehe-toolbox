'use strict';
const { t, done, readSrc } = require('./lib/harness');
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
    for (const m of s.matchAll(/handle\(dirMoveCh\.([A-Z0-9_]+)\.([A-Z0-9_]+)\s*,/g)) {
      const key = m[1] + '.' + m[2];
      if (chTable[key]) set.add(chTable[key]);
    }
    /* 搬出去的模块把 CHANNELS 做成了本地别名 CH：handle(CH.DIR_MOVE.MOVE, ...) */
    for (const m of s.matchAll(/handle\(CH\.([A-Z0-9_]+)\.([A-Z0-9_]+)\s*,/g)) {
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
      /* 锁的是：渲染层引用但主进程没注册的通道（历史缺陷 qr:save 那类任意写盘入口）。
       * 只能用源码断言：要收集的是「全项目源码里出现过哪些通道名」这一文本事实，
       * 不起 Electron 就没有别的入口能拿到渲染层的调用清单。 */
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

/* ---- 4. 辅助窗口用的通道不能被误删 ----
 *
 * 【为什么不写死通道名】原来这里是一张硬编码清单：
 *   ['win:pin-close', 'win:ruler:close', 'snip:finish', ...]
 * v0.4.2 把 win:ruler:close 改名成 win:ruler-close（双冒号不合「域:动作」约定），
 * 这张清单立刻变红 —— 但真正要守的是「辅助窗口用到的通道都在主进程注册了」，
 * 不是「通道叫这个名字」。所以改成**从辅助窗口源码里解析**：
 * 它引用什么，就要求什么注册。通道改名不再影响这条断言，
 * 而「辅助窗口新引用了某个没注册的通道」依然会被抓住。
 *
 * 空转防护：解析结果为空时直接失败 —— 否则正则一失效，
 * 这条断言就会变成永远通过的空断言（本项目最忌讳的假绿）。 */
t('三个辅助窗口依赖的通道仍在注册', () => {
  const chTable = require('../lib/channels').flatten();
  const dir = path.join(ROOT, 'js', 'auxwin');
  const need = new Set();
  /* 用 readSrc（会自动剥注释）而不是裸 readFileSync：
   * 注释里出现的通道名不该被当成「辅助窗口真的调用了它」。 */
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const s = readSrc(path.relative(ROOT, path.join(dir, f)).split(path.sep).join('/'));
    /* 常量形式：Channels.CHANNELS.WIN.PIN_CLOSE / window.Channels.CHANNELS.... */
    for (const m of s.matchAll(/Channels\.CHANNELS\.([A-Z0-9_]+)\.([A-Z0-9_]+)/g)) {
      const key = m[1] + '.' + m[2];
      if (chTable[key]) need.add(chTable[key]);
    }
    /* 字面量形式（迁移前遗留写法，仍要认） */
    for (const m of s.matchAll(/['"`]([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)['"`]/g)) {
      const known = Object.keys(chTable).find((k) => chTable[k] === m[1]);
      /* 锁的是：辅助窗口引用但主进程没注册的通道（win:ruler:close 改名那次靠它兜住）。
       * 只能用源码断言：三个辅助窗口是各自独立的 BrowserWindow，
       * 要拿到"它引用了哪些通道"只能读它们的源码文本，没有运行时入口。 */
      if (known || /^(win|snip|lan):/.test(m[1])) need.add(m[1]);
    }
  }
  assert.ok(need.size >= 5, '只从辅助窗口源码里解析出 ' + need.size + ' 个通道，正则疑似失效（这条断言会空转）');
  const missing = [...need].filter((c) => !reg.has(c)).sort();
  assert.deepStrictEqual(missing, [], '辅助窗口用到但主进程没注册：' + missing.join(', '));
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

/* ---- 7. 高危门禁表必须与真实通道对账 ----
 *
 * 【这条要抓的是「表里留着已经删掉的通道」】
 * CAP_GATED_CHANNELS 是「通道名 → 高危能力」的映射，按名字查表。
 * 条目指向一个**并不存在**的通道时不会有任何报错：那个键永远查不到，
 * 等于一条沉默的死配置。
 *
 * 实测就有一条：'clip:gc-images' 在通道被删之后仍留在表里。
 * 它不构成安全漏洞（没有 handler，调不到），但会让「表里几条、真有通道几条」
 * 的核对永远差一条，也让后来者以为还有这么个入口。
 * 更麻烦的是它掩盖了同类的真问题：如果谁**写了门禁却拼错通道名**，
 * 表现完全一样 —— 高危通道实际没被保护，而表里看着"有"。
 * 那是安全问题，必须能被抓住，所以两个方向都查：
 *   ① 表里每一条都必须真在主进程注册过；
 *   ② 门禁点到的高危通道渲染层要真还在用（防条目与调用点脱节）。
 * 反方向（某个高危通道漏进表）无法靠名字自动判定，
 * 继续由 test-destructive2 的逐条断言守着。 */
t('高危门禁表里没有指向已删除通道的孤儿条目', () => {
  const src = strip(mainProcSources()[0]);
  const m = /const CAP_GATED_CHANNELS = \{[\s\S]*?\n\};/.exec(src);
  assert.ok(m, '找不到 CAP_GATED_CHANNELS（正则失配？）—— 这条断言会空转');
  const gate = new Map();
  for (const e of m[0].matchAll(/'([^']+)':\s*'([^']+)'/g)) gate.set(e[1], e[2]);
  assert.ok(gate.size >= 10, '只解析出 ' + gate.size + ' 条门禁，正则疑似失效（这条断言会空转）');

  /* 锁的是：'clip:gc-images' 这条孤儿门禁 —— 通道删了、条目留着，长期无人发现。
   * 只能用源码断言：CAP_GATED_CHANNELS 是 main.js 里的字面量对象，
   * 不起 Electron 就没有 require 路径拿到它；这里要验的正是
   * 「表里的键与主进程注册的通道名对不对得上」这层文本关系。 */
  const orphans = [...gate.keys()].filter((ch) => !reg.has(ch));
  assert.deepStrictEqual(orphans, [],
    '这些门禁条目指向的通道在主进程并不存在（通道删了，条目忘了删）：\n  ' + orphans.join('\n  '));

  const unused = [...gate.keys()].filter((ch) => !allRef.has(ch) && !pushed.has(ch));
  assert.deepStrictEqual(unused, [],
    '这些门禁通道渲染层已经不调用（门禁护着一个没人用的入口，应一并删除）：\n  ' + unused.join('\n  '));
});

/* ---- 8. 主进程推送的事件必须有渲染层订阅 ----
 *
 * 【这条抓的是「死推送」：发了没人收，且两边都不报错】
 * 主进程 `send('x:y', …)` 与渲染层 `on('x:y', …)` 是两个进程各写一半的约定。
 * 任一边写错、或者一边改了另一边没跟上，运行时都**完全静默**：
 *   · 发一个没人监听的事件 → 消息被丢弃，不抛异常
 *   · 监听一个从不发的事件 → 回调永远不进，也不抛异常
 * 所以没有任何一条行为测试会因为它们失效而变红。
 *
 * 实测就有一条：app:crash-logged 推了两个版本，渲染层 0 个订阅。
 * 更麻烦的是它让崩溃兜底看起来"已经通知了用户"，掩盖了真实情况
 * （用户只能在设置页里看到上次异常退出的提示，走的是落盘标记，不是这条推送）。
 *
 * 【判据为什么是"渲染层源码里出现过该事件名"】
 * 这里不要求它必须是 on()：辅助窗口用 .on，主界面用 sub()（内部就是 on），
 * 有些事件还会被写进常量或用于比较。要求"名字被引用过"足够挡住"完全没人要"，
 * 又不会因为订阅写法变化而假红。
 *
 * 空转防护：解析出的推送事件少于 10 个直接失败 —— 正则一失效，
 * 这条断言就会变成永远通过的空断言。 */
t('主进程推送的每个事件都有渲染层订阅（无死推送）', () => {
  const sent = new Set();
  for (const s of mainProcSources().map(strip)) {
    for (const m of s.matchAll(/(?:\bsend|\w*Send)\(\s*'([^']+)'/g)) sent.add(m[1]);
  }
  assert.ok(sent.size >= 10,
    '只解析出 ' + sent.size + ' 个推送事件，正则疑似失效（这条断言会空转）');

  /* 渲染层全部源码：js/ 下递归 + 三个辅助窗口页面 + preload */
  const files = [];
  const push = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) { push(q); continue; }
      if (q.endsWith('.js') || q.endsWith('.html')) files.push(q);
    }
  };
  push(path.join(ROOT, 'js'));
  for (const f of ['index.html', 'pin.html', 'ruler.html', 'snip.html', 'preload.js']) {
    const q = path.join(ROOT, f);
    if (fs.existsSync(q)) files.push(q);
  }
  const hay = [];
  for (const q of files) {
    /* 用 readSrc 而不是裸读：它会先剥注释。
     * 这一点很关键 —— 本项目到处在注释里举事件名当例子，
     * 不剥注释的话这条断言几乎永远不会红。 */
    hay.push(readSrc(path.relative(ROOT, q).split(path.sep).join('/')));
  }
  const joined = hay.join(String.fromCharCode(10));

  /* 锁的是：app:crash-logged 这条死了两个版本的推送 —— 主进程发、渲染层 0 订阅。
   * 只能用源码断言：要验的是「一条消息的两个端点是否都存在」这种跨文件事实，
   * 行为断言需要真造一次崩溃并观察渲染层有没有反应 ——
   * 而"没反应"恰恰是缺陷本身，无法与"正常"区分开。 */
  const dead = [...sent].filter((ev) => !joined.includes("'" + ev + "'") && !joined.includes('"' + ev + '"'));
  assert.deepStrictEqual(dead, [],
    '这些事件主进程在推，但渲染层全项目无订阅（死推送，应删除或补上订阅）：\n  ' + dead.join('\n  '));
});

console.log(`\n注册 ${reg.size} 个通道，渲染层引用 ${allRef.size} 个，无人调用 ${[...reg].filter((c) => !allRef.has(c)).length} 个`);
done();
