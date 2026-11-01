'use strict';
/* 校验「渲染层通道表」与「主进程通道表」是否一致（任务 6）。
 *
 * 【为什么必须校验，而且比 job 前缀那套更严】
 * 通道名拼错的表现是运行时「调用失败：No handler registered」——
 * 而现有的 test-ipc-channels 是**扫源码文本**做差集的：
 * 如果主进程和渲染层错成同一个字符串，它就查不出来（两边"一致"地错）。
 *
 * 所以这里：
 *   1) 比**键集合**（少一个键说明某个通道没登记）；
 *   2) 比**每个键对应的值**（值不同 = 渲染层调用的不是主进程注册的那个名字）；
 *   3) 比表里的每个通道名**确实在主进程里注册了**（防"登记了但没人实现"）。
 *
 * 做法参照 test-job-prefix-sync.js：两边都是 IIFE/CommonJS，不便互相 require，
 * 所以直接读源码解析。lib 那份用 require（它是纯 CommonJS），
 * 渲染层那份用 Function 求值（它是 IIFE，挂在 window 上）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done } = require('./lib/harness');
const ROOT = path.resolve(__dirname, '..');

/* 主进程表：直接 require（lib/channels.js 是纯 CommonJS，无 DOM 依赖） */
function libChannels() {
  return require('../lib/channels');
}

/* 渲染层表：在最小 window 桩里求值 IIFE */
function rendererChannels() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'channels.js'), 'utf8');
  const fakeWindow = {};
  const fn = new Function('window', src + '\nreturn window.Channels;');
  return fn(fakeWindow);
}

t('6a 两份通道表的键集合完全一致', () => {
  const lib = libChannels().flatten();
  const rd = rendererChannels().flatten();
  assert.deepStrictEqual(Object.keys(rd).sort(), Object.keys(lib).sort(),
    '键集合不一致\n渲染层: ' + Object.keys(rd).sort().join(',') +
    '\n主进程: ' + Object.keys(lib).sort().join(','));
});

t('6b 每个键对应的通道名逐字相同（值不同 = 调的不是同一个通道）', () => {
  const lib = libChannels().flatten();
  const rd = rendererChannels().flatten();
  const diff = [];
  for (const k of Object.keys(lib)) {
    if (rd[k] !== lib[k]) diff.push(k + ': 主进程=' + lib[k] + ' 渲染层=' + rd[k]);
  }
  assert.deepStrictEqual(diff, [],
    '同一个语义键在两份表里指向不同通道名：\n  ' + diff.join('\n  '));
});

t('6c 表里的每个通道都真的在 main.js 里注册了', () => {
  /* 【这条比"两份表一致"更硬】
   * 两份表可能"一致地错"——都登记了一个并不存在的通道名，
   * 那时 6a/6b 都过，但运行时一定「No handler registered」。
   * 所以必须拿真实的注册清单做交叉验证。
   *
   * 【注意注册形态有两种】迁移到常量之后，main.js 里写的是
   *   handle(dirMoveCh.DIR_MOVE.MOVE, ...)
   * 而不是 handle('dir:move', ...) —— 所以不能只扫字面量。
   * 这里解析所有 `handle(<表达式>`，把两种形态都还原成通道名：
   *   · 字面量 'xxx' → 直接取值
   *   · dirMoveCh.<组>.<键> → 用 lib/channels.js 的同一份表查出来 */
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const lib = libChannels().flatten();

  const registered = new Set();
  /* 1) 字面量注册 */
  for (const m of mainSrc.matchAll(/handle\('([^']+)'/g)) registered.add(m[1]);
  /* 2) 常量注册：dirMoveCh.<组>.<键>（后面跟逗号，不能把逗号写进正则的 ')'） */
  for (const m of mainSrc.matchAll(/handle\(dirMoveCh\.([A-Z_]+)\.([A-Z_]+)\s*,/g)) {
    const key = m[1] + '.' + m[2];
    if (lib[key]) registered.add(lib[key]);
    else registered.add('(未登记常量: ' + key + ')');
  }

  const missing = Object.entries(lib).filter(([, ch]) => !registered.has(ch))
    .map(([k, ch]) => k + ' → ' + ch);
  assert.deepStrictEqual(missing, [],
    '这些通道登记在 channels.js 里，但 main.js 没有对应注册：\n  ' + missing.join('\n  '));

  /* 顺带：不许出现"常量名对不上表"的写法（那种会被当成注册成功但实际无意义） */
  const bogus = [...registered].filter((x) => x.startsWith('(未登记常量'));
  assert.deepStrictEqual(bogus, [], 'main.js 用了表里不存在的常量键：' + bogus.join(', '));
});

t('6d 表里的通道名格式合法（域:动作，且不含空格/大写）', () => {
  const lib = libChannels().flatten();
  const bad = [];
  for (const [k, ch] of Object.entries(lib)) {
    if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*[a-z0-9]$/.test(ch)) bad.push(k + ' → ' + ch);
  }
  assert.deepStrictEqual(bad, [], '通道名格式异常（应为 域:动作，全小写）：\n  ' + bad.join('\n  '));
});

t('6e index.html 在 ui.js 之前引入了 channels.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('js/channels.js'), 'index.html 未引入 js/channels.js');
  const iCh = html.indexOf('js/channels.js');
  const iUi = html.indexOf('js/ui.js');
  assert.ok(iCh < iUi, 'channels.js 应在 ui.js 之前加载（工具文件定义时就要用）');
});

done();
