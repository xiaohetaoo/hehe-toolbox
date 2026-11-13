'use strict';
/* 功能域解析：把「改了哪些文件」映射到「该跑哪些测试」。
 *
 * ============ 为什么是反向映射 ============
 * 最初想给每个测试加 @feature 标签，但分析后发现不可行：
 *   · 190 个测试里 50 个不读任何源码（纯 e2e，直接起 Electron），
 *     它们的归属无法从源码推断；
 *   · 其余 140 个里有 56 个读 3 个以上源文件，本身跨多个功能域；
 *   · 手工给 190 个文件加注释，改功能时忘了同步标签，漏测是**静默的**
 *     —— 这比没有标签更危险。
 *
 * 所以改成：维护一张 20 行的「功能域 → 源文件」表（scripts/features.json），
 * 改了什么文件就反查出涉及哪些域，再取这些域下的测试。表小、改功能时
 * 一眼能看出该更新哪一行，比 190 个注释可靠。
 *
 * ============ 保守优先 ============
 * 这个模块的每个"猜不准"都往**多跑测试**的方向倒：
 *   · 命中了 core 域的源文件（main.js / channels / scripts）→ 全量；
 *   · 改动文件不在任何域的 src 里 → 回退全量并提示；
 *   · 一个测试命中多个域 → 取并集。
 * 跑多了只是慢，跑少了是漏。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SPEC_PATH = path.join(__dirname, '..', 'features.json');

/* 把 glob 转成正则。只支持 * （匹配任意字符，含 /），
 * 因为这里的模式都是「前缀/后缀」形态，不需要 ** 的精确语义。 */
function globToRe(pat) {
  const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

function loadSpec() {
  const raw = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const out = new Map();
  for (const [id, def] of Object.entries(raw)) {
    if (id.startsWith('_')) continue;   // _说明 之类的注释键
    out.set(id, {
      id,
      label: def.label || id,
      srcRes: (def.src || []).map(globToRe),
      testRes: (def.tests || []).map(globToRe),
    });
  }
  return out;
}

/* 把 git 路径统一成正斜杠（Windows 的 git 输出可能是反斜杠） */
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.?\//, '');

/* 这个文件属于哪些功能域 */
function featuresOfFile(spec, file) {
  const f = norm(file);
  const hits = [];
  for (const def of spec.values()) {
    if (def.srcRes.some((re) => re.test(f))) hits.push(def.id);
  }
  return hits;
}

/* 列出所有测试文件名 */
function allTests() {
  return fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^test-.*\.js$/.test(f));
}

/* 这个测试属于哪些功能域（按文件名匹配 + 按它读取的源码反查） */
function featuresOfTest(spec, testFile, allTestsList) {
  const hits = new Set();
  for (const def of spec.values()) {
    if (def.testRes.some((re) => re.test(testFile))) hits.add(def.id);
  }
  /* 文件名没命中时，看它读了哪些源码 —— 读 pdf-plus 的测试就属于 pdf 域。
   * 【为什么这条重要】很多测试的名字与功能域并不同名
   * （test-round2-fixes.js 其实测的是 path-guard），只靠文件名会漏。 */
  if (!hits.size) {
    try {
      const src = fs.readFileSync(path.join(ROOT, 'scripts', testFile), 'utf8');
      const refs = [
        ...src.matchAll(/path\.join\(ROOT,\s*'([^']+)'(?:,\s*'([^']+)')?/g),
      ].map((m) => (m[2] ? m[1] + '/' + m[2] : m[1]));
      for (const m of src.matchAll(/readSrc\(\s*'([^']+)'/g)) refs.push(m[1]);
      if (/readMain\(\s*\)/.test(src)) refs.push('main.js');
      for (const r of refs) for (const id of featuresOfFile(spec, r)) hits.add(id);
    } catch (e) { /* 读不到就让调用方按"无归属"处理 */ }
  }
  return [...hits];
}

/**
 * 按改动的文件算出该跑哪些测试。
 * @param {string[]} changedFiles git diff 出来的路径
 * @returns {{tests:string[], features:string[], reason:string, full:boolean}}
 */
function testsForChanged(changedFiles) {
  const spec = loadSpec();
  const tests = allTests();
  const testSet = new Set(tests);

  /* 只改了测试脚本本身：直接跑那些脚本，不必全量。
   * 【为什么要单独处理】测试脚本的改动是"我改了断言"，影响面就是它自己
   * （顶多加上共享的 harness）。早先把它当"不属于任何域"处理 → 全量，
   * 于是每次改一个测试都要等 5 分钟，--changed 的价值就没了。 */
  const changedTests = [];
  const sourceChanged = [];
  for (const f of changedFiles) {
    const base = norm(f).replace(/^scripts\//, '');
    if (/^scripts\//.test(norm(f)) && testSet.has(base)) changedTests.push(base);
    else sourceChanged.push(f);
  }
  if (changedTests.length && !sourceChanged.length) {
    /* 共享 harness 变了就另说 —— 它影响所有测试 */
    return {
      tests: changedTests, features: [], full: false,
      reason: '只改了 ' + changedTests.length + ' 个测试脚本 → 只跑它们',
    };
  }

  /* core 域（main.js / channels / scripts / package.json）一改就是全局影响，
   * 直接全量 —— 试着"精确算"反而容易漏掉间接受影响的测试。 */
  const featureSet = new Set();
  const unknown = [];
  for (const f of sourceChanged) {
    const fs2 = featuresOfFile(spec, f);
    if (!fs2.length) { unknown.push(norm(f)); continue; }
    fs2.forEach((x) => featureSet.add(x));
  }

  if (featureSet.has('core')) {
    return {
      tests: tests.slice(), features: [...featureSet],
      reason: '改动涉及 core 域（main/channels/scripts 等全局文件）→ 全量',
      full: true,
    };
  }
  if (!featureSet.size) {
    return {
      tests: tests.slice(), features: [],
      reason: '改动文件不属于任何已登记功能域（' + unknown.slice(0, 3).join(', ')
        + (unknown.length > 3 ? ' 等' : '') + '）→ 保守起见跑全量',
      full: true,
    };
  }

  /* 目标域里的测试 + 那些"跨域"的测试（读多个域的源码）。
   * 【为什么要带上跨域测试】test-media-ffmpeg.js 可能同时读 ffmpeg 与
   * expr-eval —— 它属于 media，但改 expr-eval 也可能影响它。
   * 判据：只要这个测试的归属域与目标域**有交集**，就纳入。 */
  const chosen = [];
  for (const tf of tests) {
    const tfs = featuresOfTest(spec, tf, tests);
    if (!tfs.length) continue;
    if (tfs.some((x) => featureSet.has(x))) chosen.push(tf);
  }

  return {
    tests: chosen,
    features: [...featureSet],
    reason: '改动命中 ' + [...featureSet].join(', ') + ' 域',
    full: false,
  };
}

/** 某个功能域下的全部测试 */
function testsForFeature(featureId) {
  const spec = loadSpec();
  if (!spec.has(featureId)) {
    throw new Error('未知功能域：' + featureId + '（可选：' + [...spec.keys()].join(', ') + '）');
  }
  return allTests().filter((tf) => featuresOfTest(spec, tf).includes(featureId));
}

/** 所有功能域（给 --list-features 用） */
function listFeatures() {
  const spec = loadSpec();
  return [...spec.values()].map((d) => ({
    id: d.id,
    label: d.label,
    tests: allTests().filter((tf) => featuresOfTest(spec, tf, []).includes(d.id)).length,
  }));
}

module.exports = {
  ROOT, loadSpec, featuresOfFile, featuresOfTest, allTests,
  testsForChanged, testsForFeature, listFeatures, norm,
};
