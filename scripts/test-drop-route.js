'use strict';
/* 拖拽路由表（lib/drop-route.js）：把文件按扩展名路由到能处理它的工具。
 *
 * ============ 锁的是哪次事故 / 哪个决策 ============
 * user 明确要求：「拖拽的扩展名歧义直接给选择面板」。
 * 所以这个文件锁两件事：
 *   ① 真实扩展名到工具 id 的映射是对的（工具 id 必须真实存在，
 *      否则面板里会出现一个点了没反应的选项）；
 *   ② 歧义判定策略：**≥2 个候选一律算歧义**，不许悄悄替用户猜。
 *
 * ============ 为什么工具 id 存在性要在这里查 ============
 * 路由表是手写的 59 个扩展名 × 若干工具。手写表最大的风险不是逻辑错，
 * 而是**拼错或引用了已改名的工具** —— 那种错在界面上表现为
 * 「弹了面板，点进去是空白页」，而不会有任何报错。
 * 扫一遍 js/tools/ 下真实的 register id 就能挡住。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');
const R = require('../lib/drop-route.js');

/** 扫 js/tools 下所有真实注册的工具 id。 */
function realToolIds() {
  const ids = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const s = fs.readFileSync(p, 'utf8');
      const re = /id:\s*'([a-z0-9-]+)'/g;
      let m;
      while ((m = re.exec(s))) ids.add(m[1]);
    }
  };
  walk(path.join(ROOT, 'js', 'tools'));
  return ids;
}

t('DR1 路由表引用的每个工具 id 都真实存在', () => {
  const real = realToolIds();
  assert.ok(real.size >= 100, '只扫到 ' + real.size + ' 个工具，正则可能失效（这条会空转）');
  const used = new Set();
  for (const ext of R.allExts()) for (const id of R.MAP[ext]) used.add(id);
  const missing = [...used].filter((x) => !real.has(x));
  /* 锁的是：路由表引用了不存在的工具 —— 面板里会出现点了没反应的选项。 */
  assert.deepStrictEqual(missing, [],
    '路由表引用了不存在的工具 id：' + missing.join('、') + '（会导致面板里点了没反应）');
  assert.ok(used.size > 20, '路由表只覆盖了 ' + used.size + ' 个工具，可能被误删');
});

t('DR2 extOf 正确处理各种路径形态', () => {
  /* 锁的是：路径解析退化（比如只认 / 不认 \，或把无扩展名当有）。
   * 写错会让 .PNG 匹配不到 png，或把 "noext" 当成扩展名 "noext"。 */
  assert.strictEqual(R.extOf('C:\\a\\b.PNG'), 'png', '反斜杠 + 大写');
  assert.strictEqual(R.extOf('D:/work/x.Jpeg'), 'jpeg', '正斜杠 + 混合大小写');
  assert.strictEqual(R.extOf('/usr/a/b.tar.gz'), 'gz', '多段扩展名取最后一段');
  assert.strictEqual(R.extOf('noext'), '', '无扩展名');
  assert.strictEqual(R.extOf('.hidden'), '', '点开头不算扩展名');
  assert.strictEqual(R.extOf('a.'), '', '尾点是空的');
  assert.strictEqual(R.extOf(''), '', '空串');
  assert.strictEqual(R.extOf(null), '', 'null 不抛');
});

t('DR3 候选工具 ≥2 就算歧义（不替用户猜）', () => {
  /* 锁的是：用户明确要求的决策 —— 「歧义直接给选择面板」。
   * 如果有人为了"少弹一次窗"把多个候选悄悄取第一个，这条会红。 */
  const png = R.route(['a.png']);
  assert.ok(png.ambiguous, 'png 有多个候选，必须算歧义');
  assert.ok(png.candidates.length >= 2, 'png 候选应 ≥2，实际 ' + png.candidates.length);

  /* 唯一候选不该算歧义（那时直接打开，省一次点击） */
  const rar = R.route(['a.rar']);
  assert.strictEqual(rar.candidates.length, 1, 'rar 应只有 1 个候选，实际 ' + JSON.stringify(rar.candidates));
  assert.strictEqual(rar.ambiguous, false, '唯一候选不该标歧义');
});

t('DR4 候选排序：第一候选是扩展名映射里的首个（默认高亮它）', () => {
  /* 锁的是：排序把"较不可能"的工具排到了第一位。
   * 面板里第一个是预选中项、回车直达，排错等于默认动作错。 */
  for (const [ext, want] of [['png', 'img-compress'], ['pdf', 'pdf-tools'], ['zip', 'zip-tool'], ['json', 'json-format']]) {
    const r = R.route(['a.' + ext]);
    assert.strictEqual(r.candidates[0], want,
      '.' + ext + ' 的第一候选应是 ' + want + '，实际 ' + r.candidates[0]);
  }
});

t('DR5 canHandle 只对该工具真能处理的扩展名返回 true', () => {
  /* 锁的是：canHandle 退化成"永远 true" —— 那样每个工具都会声称能处理
   * 任何文件，剪贴板动作层会给出错误的按钮。 */
  assert.strictEqual(R.canHandle('img-compress', 'a.png'), true);
  assert.strictEqual(R.canHandle('img-compress', 'a.pdf'), false, 'img-compress 不该认 pdf');
  assert.strictEqual(R.canHandle('pdf-tools', 'a.pdf'), true);
  assert.strictEqual(R.canHandle('pdf-tools', 'a.png'), false, 'pdf-tools 不该认 png');
  assert.strictEqual(R.canHandle('不存在的工具', 'a.png'), false, '未知工具返回 false');
  assert.strictEqual(R.canHandle('img-compress', ''), false, '空路径返回 false');
});

t('DR6 未知扩展名被单独收集（面板要能告诉用户"没人能处理"）', () => {
  /* 锁的是：未知扩展名被静默丢弃 —— 用户拖了 3 个文件，
   * 其中 1 个没人认，界面却什么都不说。 */
  const r = R.route(['a.png', 'b.qqq']);
  assert.ok(r.unknown.indexOf('qqq') >= 0, '未知扩展名应在 unknown 里：' + JSON.stringify(r.unknown));
  assert.ok(r.candidates.length > 0, '认识的那个仍应给出候选');
});

t('DR7 多文件时按「覆盖文件数」排序，覆盖多的排前面', () => {
  /* 锁的是：拖 5 张图进来，"能处理图片"的工具排在只认某一个扩展名的后面。
   * 用户真正想要的是处理那一批，不是其中一个。 */
  const r = R.route(['a.png', 'b.png', 'c.png', 'd.pdf']);
  const top = r.candidates[0];
  const pngTools = r.byExt.png || [];
  assert.ok(pngTools.indexOf(top) >= 0,
    '拖 3 张 png + 1 个 pdf，第一候选应是 png 工具（实际 ' + top + '）');
});

t('DR8 路由表的每个工具都至少能被一个扩展名触发', () => {
  /* 锁的是：表里登记了工具但没有任何扩展名指向它 —— 那条记录是死数据，
   * 要么漏了扩展名，要么工具 id 写错。 */
  const real = realToolIds();
  const dead = [];
  for (const id of Object.keys(R.BY_TOOL)) {
    if (!R.BY_TOOL[id] || !R.BY_TOOL[id].size) dead.push(id);
    if (!real.has(id)) dead.push(id + '(不存在)');
  }
  assert.deepStrictEqual(dead, [], '死路由：' + dead.join('、'));
});

done();
