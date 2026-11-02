'use strict';
const { t, done, readTree, ROOT } = require('./lib/harness');
/* 任务 9 拆分守卫：js/tools/media.js 拆成 js/tools/media/*.js 之后，
 * 下面这几件事原来都是「默认单文件」的写法，拆完会静默失效 ——
 * 每一条都对应一个会在 CI 里表现成「莫名其妙变红」的断裂点。
 *
 * 这个测试不是重复 test-tool-order / test-click-sweep，而是专门锁
 * **拆分本身的完整性**：工具一个没少、index.html 顺序对、没有孤儿文件。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const srcScan = require('../lib/src-scan');
const stripComments = srcScan.stripComments;

const MEDIA_DIR = path.join(ROOT, 'js', 'tools', 'media');
const OLD_FILE = path.join(ROOT, 'js', 'tools', 'media.js');

/* 拆分前 media.js 里注册的 16 个工具 id（逐一核对过原文件） */
const EXPECTED = [
  'img-batch', 'img-watermark', 'img-stitch', 'exif-view',
  'ffmpeg-setup', 'av-info', 'av-convert', 'screenshot-ocr',
  'img-compress', 'video-press', 'snip-tool', 'screen-rec',
  'video-frames', 'batch-ocr', 'audio-cut', 'img-dedup',
];

function mediaFiles() {
  return fs.readdirSync(MEDIA_DIR).filter((n) => n.endsWith('.js')).sort();
}

/* ---- 1. 拆分后没有残留的旧单文件 ---- */
t('旧的 js/tools/media.js 已删除（否则会有两份注册，工具 id 重复）', () => {
  assert.ok(!fs.existsSync(OLD_FILE),
    'js/tools/media.js 还在 —— 它与 js/tools/media/*.js 会同时注册同一批 id，' +
    'Registry 对重复 id 只 console.warn 并丢弃后者，表现为一半工具静默消失');
});

/* ---- 2. 工具一个没少 ---- */
t('16 个媒体工具 id 一个没少', () => {
  /* 【不要用 `\n  id: '…'` 这种锚点】
   * 仓库里这些文件是 CRLF（git 检出时 LF → CRLF），`\n  id:` 在 `\r\n  id:`
   * 上匹配不到，结果是 ids 为空、这条断言报「集合变了」而工具其实一个没少。
   *
   * 【也不要要求 id/name/module 三个字段写在同一行且顺序固定】
   * 原实现是 /id: '([^']+)', name: [^\n]*?module: MOD/g —— 用 [^\n]*?
   * 强制三个字段同行相邻。实测确认：把注册对象改成分行写
   *   id: 'x',
   *   name: 'X',
   *   module: MOD
   * 这是零语义的纯格式化改动，ids 立刻变成空数组、断言误报「集合变了」，
   * 而 16 个工具一个没少。
   * 反过来，注释里出现同形态的假注册也会被算进去（这条用了 raw:true，
   * 不剥注释）。
   *
   * 现在改成：先剥注释，再按 register({ … }) 括号配平取出每个注册对象，
   * 然后只在该对象内抓 id 字段。与字段顺序、换行、注释都无关。 */
  const src = stripComments(readTree('js/tools/media', { raw: true }));
  const ids = [];
  const re = /register\(\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    const end = srcScan.scanBrace(src, open);
    if (end < 0) continue;
    const obj = src.slice(open, end);
    const idm = obj.match(/id:\s*'([^']+)'/);
    if (idm) ids.push(idm[1]);
  }
  ids.sort();
  assert.deepStrictEqual(ids, EXPECTED.slice().sort(),
    '媒体工具集合变了。多了会静默新增页面，少了会让用户找不到功能。\n实际：' + ids.join(', '));
});

/* ---- 3. 每个文件恰好注册一个工具 ---- */
t('每个文件恰好一个 register 块（避免拆出「一个大文件 + 一堆小碎片」）', () => {
  const bad = [];
  for (const n of mediaFiles()) {
    const s = fs.readFileSync(path.join(MEDIA_DIR, n), 'utf8');
    const count = (s.match(/register\(\{/g) || []).length;
    const want = n === 'shared.js' ? 0 : 1;
    if (count !== want) bad.push(n + ' 有 ' + count + ' 个 register 块（应 ' + want + '）');
  }
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

/* ---- 4. shared.js 一旦被加载就必须导出助手 ---- */
t('shared.js 导出 MediaShared，且每个用到它的文件都真的解构了', () => {
  const shared = fs.readFileSync(path.join(MEDIA_DIR, 'shared.js'), 'utf8');
  for (const k of ['IMG_EXT', 'isImgPath', 'IMG_FILTER', 'loadImg']) {
    assert.ok(new RegExp('window\\.MediaShared\\s*=\\s*\\{[^}]*' + k).test(shared),
      'shared.js 没有导出 ' + k);
  }
  /* 用到某个助手的文件必须同时解构它 —— 少了这行，运行时是 ReferenceError，
   * 而 node --check 完全发现不了。 */
  const missing = [];
  for (const n of mediaFiles()) {
    if (n === 'shared.js') continue;
    const s = fs.readFileSync(path.join(MEDIA_DIR, n), 'utf8');
    for (const k of ['IMG_EXT', 'isImgPath', 'IMG_FILTER', 'loadImg']) {
      const uses = new RegExp('\\b' + k + '\\b').test(s);
      const destructures = new RegExp('const \\{[^}]*\\b' + k + '\\b[^}]*\\} = window\\.MediaShared').test(s);
      if (uses && !destructures) missing.push(n + ' 用了 ' + k + ' 但没有从 MediaShared 解构');
    }
  }
  assert.deepStrictEqual(missing, [], missing.join('\n'));
});

/* ---- 5. index.html 顺序：shared 必须最先，且 16 个全在 ---- */
t('index.html：shared.js 在其余媒体文件之前，且 16 个工具文件都在', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const at = html.indexOf('js/tools/media/shared.js');
  assert.ok(at > 0, 'index.html 没有引入媒体 shared.js');
  const missing = [];
  let laterCount = 0;
  for (const n of mediaFiles()) {
    if (n === 'shared.js') continue;
    const i = html.indexOf('js/tools/media/' + n);
    if (i < 0) { missing.push(n); continue; }
    if (i < at) missing.push(n + '（排在 shared.js 之前，会解构到 undefined）');
    laterCount++;
  }
  assert.deepStrictEqual(missing, [], '这些问题会让工具页一打开就报错：\n  ' + missing.join('\n  '));
  assert.strictEqual(laterCount, 16, '媒体工具文件数应为 16，实际 ' + laterCount);
});

/* ---- 6. 不再有指向旧路径的**真实读取**（测试/CI/脚本都得跟着改） ---- */
t('全库没有按旧路径读取 js/tools/media.js 的代码', () => {
  const offenders = [];
  /* 只找「真的会去读这个文件」的形态：read('…') / readFileSync('…') /
   * -Path js/tools/media.js。**文档与说明里的历史提及不算** ——
   * lint-baseline.md 记的是拆分前的问题位置、harness 注释在解释为什么加
   * readTree，把它们也算进去，这条断言就会变成「谁写注释谁违规」。 */
  const PATTERNS = [
    /read\(\s*'js\/tools\/media\.js'\s*\)/,
    /readSrc\(\s*'js\/tools\/media\.js'\s*\)/,
    /readFileSync\([^\n]*js[,\/]\s*'tools'[^\n]*'/,
    /readFileSync\([^\n]*js\/tools\/media\.js/,
    /Select-String -Path js\/tools\/media\.js/,
  ];
  const scan = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) scan(rel + '/' + e.name);
      return;
    }
    if (!rel.endsWith('.js') && !rel.endsWith('.yml')) return;
    if (rel === 'scripts/test-media-split.js') return; // 本文件自己定义了这些形态
    const s = fs.readFileSync(abs, 'utf8');
    for (const line of s.split('\n')) {
      if (PATTERNS.some((re) => re.test(line))) offenders.push(rel + ' :: ' + line.trim().slice(0, 90));
    }
  };
  for (const rel of ['scripts', 'js', '.github', 'lib']) scan(rel);
  for (const rel of ['main.js', 'preload.js']) scan(rel);
  assert.deepStrictEqual(offenders, [],
    '这些地方还在按旧路径读 media.js（拆完后会 ENOENT 或断言落空）：\n  ' + offenders.join('\n  '));
});

/* ---- 7. CI 的工具数统计必须递归 ---- */
t('CI 的工具数统计是递归的（否则子目录里的 16 个工具会被漏掉）', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(/Get-ChildItem[^\n]*-Recurse/.test(yml),
    'CI 的工具数统计没有递归子目录 —— media 拆分后它只会数到 84 个，' +
    '低于 90 的阈值会直接 throw，报「tool count regressed」而实际一个工具都没少');
  assert.ok(!/Select-String -Path js\/tools\/\*\.js/.test(yml),
    'CI 仍在用 Select-String -Path js/tools/*.js（不展开子目录）');
});

done();
