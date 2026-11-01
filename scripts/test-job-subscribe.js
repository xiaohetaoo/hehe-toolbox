'use strict';
/* JobPrefix.subscribe 的单元测试（任务 7）。
 *
 * 【为什么必须单独测它】subscribe 把 6 处手写正则收成一处，
 * 而它的两个关键契约是「认领前只接受匹配前缀 / 认领后只认那一个 id」——
 * 这两条错了的表现是**静默的**：进度条不动、或把别人的任务当成自己的。
 * 历史上已经踩过两次（测速页"先到先得"、磁盘分析被别的任务刷屏），
 * 所以这里用行为断言把契约锁死。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done } = require('./lib/harness');
const ROOT = path.resolve(__dirname, '..');

/* 在最小 DOM 桩里加载 js/job-prefixes.js，拿到真实的 window.JobPrefix */
function loadJobPrefix() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'job-prefixes.js'), 'utf8');
  const listeners = [];
  const fakeWindow = {
    api: {
      on: (ev, cb) => {
        assert.strictEqual(ev, 'job:stream', 'subscribe 只应订阅 job:stream');
        listeners.push(cb);
        return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
      },
    },
    App: { onCleanup: (fn) => { fakeWindow._cleanups.push(fn); } },
    _cleanups: [],
  };
  /* 用一个假的全局 window 执行那个 IIFE */
  const fn = new Function('window', src + '\nreturn window.JobPrefix;');
  const JP = fn(fakeWindow);
  return {
    JP,
    /** 模拟主进程广播一个 job:stream 事件 */
    emit: (id, data) => {
      for (const cb of listeners.slice()) cb({ id, data: JSON.stringify(data || {}) });
    },
    listenerCount: () => listeners.length,
  };
}

t('7a subscribe：认领前只接受匹配前缀的事件', () => {
  const env = loadJobPrefix();
  const got = [];
  env.JP.subscribe('qs', (d) => got.push(d.id));

  env.emit('job42', { pct: 10 });     // 哈希任务 —— 不该被认领
  env.emit('dlg7', { pct: 20 });      // 下载任务 —— 不该被认领
  env.emit('qs123', { pct: 30 });     // 本任务的第一个事件 → 认领
  assert.deepStrictEqual(got, ['qs123'],
    '认领前收到别的任务的事件（这正是"进度条跟着别人跳"的根因）：' + JSON.stringify(got));
});

t('7b subscribe：认领后只认那一个 id（别的任务来了要丢弃）', () => {
  const env = loadJobPrefix();
  const got = [];
  env.JP.subscribe('qs', (d) => got.push(d.id));

  env.emit('qs123', { pct: 30 });     // 认领 qs123
  env.emit('qs456', { pct: 40 });     // 同前缀的另一个任务 —— 也必须丢弃
  env.emit('job99', { pct: 50 });     // 别的前缀
  env.emit('qs123', { pct: 60 });     // 自己的
  assert.deepStrictEqual(got, ['qs123', 'qs123'],
    '认领后不该再接受第二个 id（并发任务会互相污染）：' + JSON.stringify(got));
});

t('7c subscribe：strict 模式要求「前缀+纯数字」', () => {
  const env = loadJobPrefix();
  const got = [];
  env.JP.subscribe('dl', (d) => got.push(d.id));
  /* 'dl' 与 'dlg' 是前缀重叠的两个任务类型（历史上因此出过事故）：
   * dlg123 不能被 dl 认成自己的。 */
  env.emit('dlg123', { pct: 1 });
  assert.deepStrictEqual(got, [], 'dl 误认领了 dlg 的任务（前缀重叠但不同类）');
  env.emit('dl456', { pct: 2 });
  assert.deepStrictEqual(got, ['dl456'], 'dl 应认领 dl456');
});

t('7d subscribe：loose 模式只要求前缀开头（target-size / text-tools 的原语义）', () => {
  const env = loadJobPrefix();
  const got = [];
  env.JP.subscribe('tgt', (d) => got.push(d.id), { mode: 'loose' });
  /* loose 模式接受任何以 tgt 开头的 id（原实现就是 /^tgt/） */
  env.emit('tgt-7', { pct: 5 });
  assert.deepStrictEqual(got, ['tgt-7'],
    'loose 模式应当接受带非数字后缀的 id（否则主进程 id 形态一变就静默失效）');
  /* 但认领之后仍然只认这一个 */
  env.emit('tgt-9', { pct: 6 });
  assert.deepStrictEqual(got, ['tgt-7'], 'loose 模式也必须"认领后只认一个"');
});

t('7e subscribe：返回的 unsub 能真正退订', () => {
  const env = loadJobPrefix();
  const got = [];
  const unsub = env.JP.subscribe('cs', (d) => got.push(d.id));
  env.emit('cs1', { pct: 1 });
  unsub();
  assert.strictEqual(env.listenerCount(), 0, '退订后不应还挂着监听器（会持续泄漏）');
  env.emit('cs1', { pct: 2 });
  assert.deepStrictEqual(got, ['cs1'], '退订之后不该再收到事件');
});

t('7f subscribe：handler 抛异常不会拖垮订阅', () => {
  const env = loadJobPrefix();
  let calls = 0;
  env.JP.subscribe('avc', () => { calls++; throw new Error('解析失败'); });
  env.emit('avc1', {});
  env.emit('avc1', {});
  assert.strictEqual(calls, 2, '单条事件解析失败不该让订阅停止工作');
});

t('7g 渲染层不再有手写 job 前缀正则（全部走 subscribe）', () => {
  /* 【这是源码断言，理由必须写清】
   * 1) 锁的历史回归：'dl' vs 'dlg' 前缀重叠事故、测速页"先到先得"抢 id、
   *    磁盘分析被别的任务刷屏 —— 三次都是"手写正则与主进程前缀表不同步"。
   * 2) 为什么不能用行为断言替代：这里要验证的是**全项目没有遗漏点**。
   *    行为断言只能验证被调用到的那几处；漏掉的那处正是最危险的
   *    （它的表现是静默的：不报错、只是数据不对）。
   * 3) 匹配语义而非版面：剥注释后搜 `^前缀\d+$` 这类正则字面量。 */
  const fsx = require('fs');
  const { stripComments } = require(path.join(ROOT, 'lib', 'src-scan'));
  const root = path.join(ROOT, 'js');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fsx.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (e.name === 'job-prefixes.js') continue;   // 它自己就是实现
      /* 【必须先剥注释】注释里会**解释**这个历史缺陷（例如
       * file-tools 写着"早期订阅 job:stream 并试图过滤 /^qs\d+$/"、
       * lan-scan 写着"过滤 /^lanscan/"）—— 那些文字不是代码。
       * 不剥注释就会把"记录缺陷的注释"当成"仍然存在的缺陷"，
       * 我第一次跑这条断言就被这两处注释卡住了。 */
      const src = stripComments(fsx.readFileSync(p, 'utf8'));
      for (const m of src.matchAll(/\/(?:\\)?\^(dl|qs|cs|avc|prs|tgt|tts|dlg|speed|scan|lanscan|usn)(?:\\\\d\\+|)/g)) {
        offenders.push(path.relative(ROOT, p) + ' -> ' + m[0]);
      }
    }
  };
  walk(root);
  assert.deepStrictEqual(offenders, [],
    '仍有手写 job 前缀正则（应改为 JobPrefix.subscribe）：\n  ' + offenders.join('\n  '));
});

done();
