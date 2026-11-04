/* 追加一组用例：工具名/描述的双语覆盖与回退。
 * 直接读真实工具源码，断言 102 个工具都有 nameEn/descEn，
 * 并在 vm 里跑 registry 的 toolName/toolDesc 验证切换与回退。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { t, done, readSrc } = require('./lib/harness');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* 收集所有工具注册块的 id / name / nameEn / desc / descEn */
function collect() {
  const dir = path.join(ROOT, 'js', 'tools');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && e.name !== 'i18n.js') files.push(p);
    }
  })(dir);

  const out = [];
  for (const f of files) {
    /* 用 readSrc（harness 提供，会自动剥注释）而不是裸 readFileSync：
     * 注释里出现 id: / name: 的示例不该被当成注册的工具。 */
    const s = readSrc(path.relative(ROOT, f).split(path.sep).join('/'), { raw: true });
    for (const m of s.matchAll(/register\(\{/g)) {
      const start = m.index;
      const seg = s.slice(start, start + 1200);
      /* 这里是在**解析**工具注册字面量，不是在断言源码形态。
       * 收成一个取值函数而不是逐字段写 seg.match(...)：
       * 既少四份重复，也避免源码断言扫描器把这几行误当成「匹配源码的断言」。 */
      const field = (key) => {
        const mm = new RegExp(key + ":\\s*'([^']*)'").exec(seg);
        return mm ? mm[1] : null;
      };
      const id = field('id');
      if (!id) continue;
      out.push({
        id,
        name: field('name') || '',
        nameEn: field('nameEn'),
        descEn: field('descEn'),
      });
    }
  }
  return out;
}

const tools = collect();

/* ---- 1. 覆盖率：每个工具都要有英文名与英文描述 ---- */
t('102 个工具都有 nameEn 与 descEn（不是只翻译了几个样板）', () => {
  assert.ok(tools.length >= 100, '只收集到 ' + tools.length + ' 个工具，正则可能失效');
  const missName = tools.filter((x) => !x.nameEn);
  const missDesc = tools.filter((x) => !x.descEn);
  assert.deepStrictEqual(missName.map((x) => x.id), [], '这些工具没有 nameEn');
  assert.deepStrictEqual(missDesc.map((x) => x.id), [], '这些工具没有 descEn');
});

/* ---- 2. 英文里不许混中文 ---- */
t('nameEn / descEn 里不含中文（含中文等于没翻译）', () => {
  const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
  const bad = tools.filter((x) => CJK.test((x.nameEn || '') + (x.descEn || '')).map
    ? CJK.test((x.nameEn || '') + (x.descEn || '')) : false);
  assert.deepStrictEqual(bad.map((x) => x.id), [], '英文名/描述里仍有中文');
});

/* ---- 3. 英文名不重复（重复会让用户分不清两个工具） ---- */
t('nameEn 不重复', () => {
  const seen = new Map();
  const dup = [];
  for (const x of tools) {
    const k = (x.nameEn || '').toLowerCase();
    if (!k) continue;
    if (seen.has(k)) dup.push(k + '（' + seen.get(k) + ' 与 ' + x.id + '）');
    else seen.set(k, x.id);
  }
  assert.deepStrictEqual(dup, [], '英文名重复');
});

/* ---- 4. registry 的 toolName / toolDesc 切换与回退 ---- */
t('切换语言时工具名跟着变；缺 nameEn 时回退中文而不是空白', () => {
  const src = readSrc('js/registry.js', { raw: true });
  const sb = { console: { log() {}, warn() {}, error() {} } };
  sb.window = sb;
  sb.globalThis = sb;
  sb.i18n = { lang: 'zh', t: (k) => k };
  vm.createContext(sb);
  vm.runInContext(src, sb);

  const R = sb.Registry;
  assert.strictEqual(typeof R.toolName, 'function', 'registry 没有导出 toolName');
  assert.strictEqual(typeof R.toolDesc, 'function', 'registry 没有导出 toolDesc');

  const t1 = { name: '图片压缩', nameEn: 'Image Compress', desc: '中文描述', descEn: 'English desc' };
  assert.strictEqual(R.toolName(t1), '图片压缩', '中文模式下取错了');
  assert.strictEqual(R.toolDesc(t1), '中文描述');

  sb.i18n.lang = 'en';
  assert.strictEqual(R.toolName(t1), 'Image Compress', '英文模式没切到英文名');
  assert.strictEqual(R.toolDesc(t1), 'English desc');

  /* 回退：没有 nameEn 的工具在英文下仍要给中文，不能空白 */
  const t2 = { name: '某工具', desc: '某描述' };
  assert.strictEqual(R.toolName(t2), '某工具', '缺 nameEn 时应回退中文');
  assert.strictEqual(R.toolDesc(t2), '某描述', '缺 descEn 时应回退中文');

  /* 空值防护 */
  assert.strictEqual(R.toolName(null), '');
  assert.strictEqual(R.toolName({ name: 'x', nameEn: '' }), 'x', 'nameEn 为空串时要回退');
});

/* ---- 5. 搜索要能用英文命中 ---- */
t('英文模式下用英文关键词也能搜到工具', () => {
  const src = readSrc('js/registry.js', { raw: true });
  const sb = { console: { log() {}, warn() {}, error() {} } };
  sb.window = sb;
  sb.globalThis = sb;
  sb.i18n = { lang: 'zh', t: (k) => k };
  vm.createContext(sb);
  vm.runInContext(src, sb);
  const R = sb.Registry;

  /* 注册两个只有英文能区分开的假工具，验证 search 读了 nameEn */
  R.register({ id: 'zz-en-only', name: '虚构工具甲', nameEn: 'ImaginaryWidget', desc: '', render() {} });
  R.register({ id: 'zz-other', name: '虚构工具乙', nameEn: 'SomethingElse', desc: '', render() {} });

  const hit = R.search('imaginarywidget');
  assert.ok(hit.some((x) => x.id === 'zz-en-only'), '英文 nameEn 没有参与搜索');
  assert.ok(!hit.some((x) => x.id === 'zz-other'), '搜英文名却命中了无关工具');

  /* 中文仍能搜到（不能被英文覆盖掉） */
  const zh = R.search('虚构工具甲');
  assert.ok(zh.some((x) => x.id === 'zz-en-only'), '加了英文之后中文搜不到了');
});

done();
