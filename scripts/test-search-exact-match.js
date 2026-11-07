'use strict';
/* 搜索的「名称精确匹配」必须真的存在，且英文名同样享受精确/前缀分档。
 *
 * ============ 锁的是哪个回归 ============
 * 原来的评分把名称拼成一个串：
 *   `const name = norm(t.name + ' ' + (t.nameEn || ''))`
 * 然后判 `if (name === tk) s = 100`、`name.startsWith(tk) s = 80`，
 * 以及最后那条整串加成 `if (name.includes(raw)) total += 60`。
 *
 * 而全项目 103 个 register 块**全部**都有 nameEn，所以 name 恒为
 * 「科学计算器 calculator」这种两段式。用户输入任何**单个词**都不可能与之全等：
 *   · 精确匹配（100 分）这一档永远是**死代码**，没有任何工具拿得到；
 *   · 英文名排在拼接串后面，startsWith 也永远为假；
 *   · 整串加成 `name.includes(raw)` 同理，跨词查询（"计算器 calc"）永远不成立。
 *
 * ============ 验证方式 ============
 * 纯函数级：vm 里加载真的 registry.js，注册假工具，看 search() 的**返回顺序**。
 * 【判排序而不是分数】search() 只返回工具数组（分数是内部量），
 * 而"精确项排第一"正是用户能感知的契约。
 *
 * ============ 构造用例的关键（踩过一次）============
 * 最初只拿单词查询做用例，结果**旧实现也能排对**：
 * 因为最后那条 `name.includes(raw)` 会给"名称里含该词的任何工具"再加 60 分，
 * 把单 token 的分档差异完全盖住。所以这里必须用**多词查询**，
 * 让整串在两边都命中/都不命中，从而把差异逼到单 token 的分档上。
 */
const vm = require('vm');
const { t, done, assert, readSrc } = require('./lib/harness');

/* 在最小沙箱里加载 registry.js（它是 IIFE，挂到 window.Registry）。 */
function loadRegistry(lang) {
  const src = readSrc('js/registry.js', { raw: true });
  const sb = { console: { log() {}, warn() {}, error() {} } };
  sb.window = sb;
  sb.globalThis = sb;
  sb.i18n = { lang: lang || 'zh', t: (k) => k, normalize: (x) => (x === 'en' || x === 'zh' ? x : null) };
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb.Registry;
}

const ids = (hits) => hits.map((x) => x.id);

t('S1 中文名精确匹配排第一', () => {
  /* 锁的是：拼接串判等让 100 分档成为死代码。 */
  const R = loadRegistry('zh');
  R.register({ id: 'zh-exact', name: '测试工具甲', nameEn: 'Alpha Widget',
    desc: '', descEn: '', keywords: [], render() {} });
  R.register({ id: 'zh-mid', name: '别的东西', nameEn: 'Other',
    desc: '这是测试工具甲的近亲', descEn: '', keywords: [], render() {} });

  const hits = R.search('测试工具甲');
  assert.ok(hits.length > 0, '搜不到');
  assert.strictEqual(hits[0].id, 'zh-exact',
    '中文全名搜索的第一名不是精确匹配项：' + ids(hits));
});

t('S2 英文名精确匹配优先于「仅中文名里含该词」的工具', () => {
  /* 锁的是：英文名在拼接串末尾 → 判等/前缀永远不成立，
   * 只靠 includes 拿 60 分，与"中文名里含该词"的工具同档、靠名字排序决胜负。
   *
   * 构造：两个工具的拼接串**都**包含整串 raw（保证整串加成对二者相同），
   * 于是排序只剩单 token 分档说了算：
   *   A 的 nameEn 精确 → 100 档；B 只是中文名包含 → 60 档。 */
  const R = loadRegistry('zh');
  R.register({ id: 'A', name: '计算器', nameEn: 'calculator',
    desc: '', descEn: '', keywords: [], render() {} });
  R.register({ id: 'B', name: '计算器助手', nameEn: 'helper',
    desc: '', descEn: '', keywords: [], render() {} });

  const hits = R.search('calculator');
  assert.ok(hits.length >= 1, '搜不到');
  /* A 的英文名与查询全等；B 的拼接串「计算器助手 helper」不含 calculator ——
   * 所以 B 根本不该进结果。这条主要确认 A 能被搜到且在前。 */
  assert.strictEqual(hits[0].id, 'A', '英文精确名没有排第一：' + ids(hits));
});

t('S3 英文名精确匹配优先于「中文名以该词开头」的工具（可区分新旧实现）', () => {
  /* 锁的是：拼接串判等让 100 分档成为死代码，而"中文名开头包含"反而
   * 因为排在拼接串最前面而拿到 startsWith 的 80 分 —— 精确英文名输给它。
   *
   * 【这个用例是实测筛出来的】早先写的几个用例（英文精确 vs 关键词命中）
   * 在**新旧实现下结果相同**，因为最后那条 `name.includes(raw)` 整串加成
   * 给两边都加了 60，把分档差异抹平了。变异测试跑不红，等于没测。
   * 这里让干扰项的中文名**以查询词开头**（拼接串 = "calculator 工具 aux"），
   * 旧实现下它 startsWith 命中拿 80，而真正的英文名精确项因为英文名排在
   * 拼接串末尾、判等恒假，只拿 60 —— 顺序被反转。 */
  const R = loadRegistry('zh');
  R.register({ id: 'EN', name: '计算器', nameEn: 'calculator',
    desc: '', descEn: '', keywords: [], render() {} });
  R.register({ id: 'KW', name: 'calculator 工具', nameEn: 'aux',
    desc: '', descEn: '', keywords: [], render() {} });

  const hits = R.search('calculator');
  assert.ok(hits.length >= 2, '应同时命中两个，实际 ' + ids(hits));
  assert.strictEqual(hits[0].id, 'EN',
    '英文名与查询全等的工具没有排第一：' + ids(hits)
    + '（旧实现下会是被中文名开头命中抢走）');
});

t('S3b 英文名前缀匹配优先于关键词整词命中（多词查询）', () => {
  /* 锁的是：startsWith 对英文名恒假 → 英文前缀分档是死代码。
   * 多词查询避开整串加成的影响。 */
  const R = loadRegistry('en');
  R.register({ id: 'prefix', name: '计算器专业版', nameEn: 'calculator pro',
    desc: '', descEn: '', keywords: [], render() {} });
  R.register({ id: 'kw', name: '计算工具', nameEn: 'calc helper',
    desc: '', descEn: '', keywords: ['calculator pro'], render() {} });

  const hits = R.search('calc pro');
  assert.ok(hits.length >= 2, '应同时命中两个，实际 ' + ids(hits));
  assert.strictEqual(hits[0].id, 'prefix',
    '英文名前缀匹配没有排在关键词命中前面：' + ids(hits));
});

t('S4 中文名前缀匹配保持原有优先级', () => {
  /* 锁的是：修英文名分档时把中文名的分档弄丢了 —— 那是原有能力。 */
  const R = loadRegistry('zh');
  R.register({ id: 'zh-prefix', name: '图片压缩高级版', nameEn: 'Img Pro',
    desc: '', descEn: '', keywords: [], render() {} });
  R.register({ id: 'zh-kw', name: '另一个工具', nameEn: 'Other Tool',
    desc: '', descEn: '', keywords: ['图片压缩'], render() {} });

  const hits = R.search('图片压缩');
  assert.ok(hits.length >= 2, '应同时命中');
  assert.strictEqual(hits[0].id, 'zh-prefix',
    '中文前缀没有排在关键词命中前面：' + ids(hits));
});

t('S5 名称精确仍优于名称中段', () => {
  /* 锁的是：把精确判据放宽成 includes —— 那样中段命中也会被算成精确。 */
  const R = loadRegistry('zh');
  R.register({ id: 'exact', name: '哈希', nameEn: 'Hash',
    desc: '', descEn: '', keywords: [], render() {} });
  R.register({ id: 'mid', name: '批量哈希工具', nameEn: 'Batch Hash',
    desc: '', descEn: '', keywords: [], render() {} });

  const hits = R.search('哈希');
  assert.ok(hits.length >= 2, '应同时命中');
  assert.strictEqual(hits[0].id, 'exact',
    '精确名没有排在中段命中前面：' + ids(hits));
});

t('S6 没有 nameEn 的工具仍能精确匹配（回退路径）', () => {
  /* 锁的是：改判据时对 nameEn 空值的处理 —— 空串若参与判等，
   * 输入为空时可能误命中所有工具。 */
  const R = loadRegistry('zh');
  R.register({ id: 'no-en', name: '无英文名工具',
    desc: 'd', keywords: [], render() {} });
  const hits = R.search('无英文名工具');
  assert.ok(hits.length > 0, '搜不到');
  assert.strictEqual(hits[0].id, 'no-en', '没有 nameEn 时精确匹配失效');
});

t('S7 整串加成按单个名称判，拼接串凑出来的不算', () => {
  /* 锁的是：`name.includes(raw)` 判的是拼接串「中文名 英文名」——
   * 于是「工具A alpha」+「widget」这种**跨词边界**拼出来的整串也能拿加成，
   * 而真正英文名就叫 "alpha widget" 的工具反而没优势。
   *
   * 【这条以前在 CI 上假红，根因值得记下来】
   * 原来造的两个工具是「工具甲 / alpha widget」和「工具乙 / alpha widget plus」。
   * 实测两者都是 **200 分**（alpha=80 + widget=60 + 整串 60），完全平局，
   * 排序落到比较函数第二档 `norm(name).localeCompare(...)`。
   * 而 localeCompare 依赖 ICU：本机 Node 24 + ICU 78 认为
   * 「工具甲」<「工具乙」，CI 的 Node 22 给出相反结果 ——
   * 同一 commit 本机绿、CI 红，且与这条用例想验的东西毫无关系。
   *
   * 【修法】改用**分数有明确差值**的夹具（160 vs 200），
   * 结果由分数决定，不再经过 localeCompare，换 Node/ICU 都不会红。 */
  const R = loadRegistry('zh');
  /* span：拼接串是「工具A alpha widget」—— 含整串，但任一个名称单独都不含 */
  R.register({ id: 'span', name: '工具A alpha', nameEn: 'widget',
    desc: '', descEn: '', keywords: [], render() {} });
  /* real：英文名自己就是整串 */
  R.register({ id: 'real', name: '工具B', nameEn: 'alpha widget',
    desc: '', descEn: '', keywords: [], render() {} });

  const hits = R.search('alpha widget');
  assert.ok(hits.length >= 2, '应同时命中，实际 ' + ids(hits));
  /* 锁的是：整串加成还按拼接串算 —— 那样 span 拿到 160+60=220，
   * 会压过真正的整串命中。 */
  assert.strictEqual(hits[0].id, 'real',
    '英文名自身构成整串的工具没有排第一（整串加成可能仍在比拼接串）：' + ids(hits));
});

t('S8 同分时的先后不参与断言（排序稳定性单独验）', () => {
  /* 锁的是：把「同分谁在前」写进断言 —— 那由 localeCompare + ICU 决定，
   * 跨 Node 版本会翻车（S7 的假红就是这么来的）。
   *
   * 这里显式说明：同分顺序**不由本工具保证**，我们只保证
   *   ① 两个都命中 ② 结果集合正确 ③ 同一查询两次结果一致（不会随机抖）。
   * 想验证"某个必须排第一"的用例，必须造出分数差（见 S7）。 */
  const R = loadRegistry('zh');
  R.register({ id: 'tie-a', name: '甲工具', nameEn: 'gamma',
    desc: '', descEn: '', keywords: [], render() {} });
  R.register({ id: 'tie-b', name: '乙工具', nameEn: 'gamma',
    desc: '', descEn: '', keywords: [], render() {} });

  const hits = R.search('gamma');
  assert.strictEqual(hits.length, 2, '两个同分工具都该命中，实际 ' + ids(hits));
  /* 锁的是：同分时丢项 —— 那才是真的坏了（语言环境差异只影响先后）。
   * 【必须用 join 归一，不能直接 deepStrictEqual 数组】
   * 这些 id 来自 vm 沙箱，属于**另一个 realm** 的 String。
   * 深比较会报 "Values have same structure but are not reference-equal"，
   * 看起来像断言失败、其实结构完全一样（实测踩到，排查了很久）。 */
  assert.strictEqual(hits.map((x) => String(x.id)).sort().join(','), 'tie-a,tie-b',
    '同分工具的命中集合不正确：' + ids(hits));
  /* 锁的是：同一查询两次给出不同顺序 —— 说明排序不稳定（依赖 Map 迭代等）。 */
  const again = R.search('gamma').map((x) => String(x.id)).join(',');
  assert.strictEqual(again, hits.map((x) => String(x.id)).join(','), '同一查询两次结果顺序不一致');
});

done();
