'use strict';
/* UI 一致性守卫：图标引用 / 硬编码颜色 / 解构完整性。
 *
 * ============ 锁的是哪次事故 ============
 * iconSvg 对未知图标名**静默回退成 info**（i 圆圈），不报错。
 * 后果：侧栏折叠按钮写 icon('chev-left') 但库里只有带引号键的
 * 'chev-left'（扫描正则漏了它）、标注工具栏写 svgIcon('palette')
 * 与 svgIcon('line') 而库里没有 —— 三处都显示成 info 圆圈，
 * 用户看到的是"三个按钮长得一样"，没有任何报错。
 * 这类问题只能靠截图发现，必须机器检查。
 *
 * 锁三件事：
 *   UC1 所有 icon/iconLg/svgIcon/iconSvg 引用的名字都在库里
 *       （键名同时覆盖裸键与带引号键 —— chev-left 就是带引号的）
 *   UC2 JS 的 style 对象里不写死 #hex 颜色（换主色/深浅色时那些地方不跟）
 *   UC3 工具文件解构 window.ui 的成员覆盖其真实使用
 *       （v0.8.6 修注入面时往 qr.js 的解构里加 escapeHtml，
 *        一不留神把原有的 h 挤出了重构后的清单 —— no-undef 没报
 *        是因为 window.h 是全局，运行时靠兜底活着，规范上却是漏的）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { t, done, ROOT } = require('./lib/harness');

const iconSrc = fs.readFileSync(path.join(ROOT, 'js', 'icons.js'), 'utf8');
const iconNames = new Set([
  ...[...iconSrc.matchAll(/^    ([a-zA-Z]+):\s*'/gm)].map((m) => m[1]),
  ...[...iconSrc.matchAll(/^    '([a-zA-Z-]+)':\s*'/gm)].map((m) => m[1]),
]);

function walkJs() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'js'));
  return out;
}

t('UC1 所有图标引用都在图标库里', () => {
  /* 锁的是：iconSvg 未知名静默回退 info，三个按钮长一样这种事
   * 不报错、只能截图发现。 */
  const missing = [];
  for (const f of walkJs()) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/\b(?:icon|iconLg|svgIcon)\(\s*'([a-zA-Z-]+)'/g)) {
        if (!iconNames.has(m[1])) missing.push(rel + ':' + (i + 1) + ' icon(\'' + m[1] + '\')');
      }
      for (const m of l.matchAll(/iconSvg\(\s*'([a-zA-Z-]+)'/g)) {
        if (!iconNames.has(m[1])) missing.push(rel + ':' + (i + 1) + ' iconSvg(\'' + m[1] + '\')');
      }
    });
  }
  assert.deepStrictEqual(missing, [],
    '这些图标名不在 js/icons.js 里（iconSvg 会静默显示成 info）：\n  ' + missing.join('\n  '));
});

t('UC2 图标库覆盖已知必需图标（防误删）', () => {
  /* 锁的是：清理图标库时误删仍被引用的名字（清理脚本按"未被引用"
   * 判断时，若引用正则漏了带引号键，就会把 chev-left 这种误判为未引用）。 */
  for (const must of ['home', 'search', 'settings', 'chev-left', 'chev-down',
    'layout', 'layers', 'palette', 'line', 'refresh', 'target']) {
    assert.ok(iconNames.has(must), '图标库缺 ' + must);
  }
});

t('UC3 JS style 对象里不写死 #hex 颜色', () => {
  /* 锁的是：写死的颜色不跟主题（换主色/深浅色时它们原地不动）。
   * svg path 数据里的颜色与注释除外。 */
  const bad = [];
  for (const f of walkJs()) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      /* 锁的是：写死颜色不跟主题（换主色/深浅色时它们原地不动）——
       * v0.8.6 审查确认全项目零处，这里锁住这个状态。 */
      if (/style:\s*\{[^}]*color:\s*'#(?:[0-9a-fA-F]{3,6})'/.test(l) && !/^\s*(\/\/|\*)/.test(l)) {
        bad.push(rel + ':' + (i + 1));
      }
    });
  }
  assert.deepStrictEqual(bad, [], 'style 里写死了颜色：\n  ' + bad.join('\n  '));
});

t('UC4 window.ui 导出面必须覆盖 Object.assign(window) 全部成员', () => {
  /* 锁的是：ui.js 有**两份导出面** ——
   *   L1384 Object.assign(window, { … })  把成员直接挂成全局；
   *   L1385 window.ui = { … }             供工具文件解构。
   * 两份分别维护，往一边加成员、忘了另一边，就会出现：
   *   · 全局能用、解构拿到 undefined（往 Object.assign 加了、window.ui 没加）；
   *   · 解构能用、全局是 undefined（反向）。
   * 43 个工具文件解构 window.ui，这份清单必须完整覆盖全局导出。 */
  const uiSrc = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
  /* 锁的是：两份导出面都要能解析 —— 解析不到说明某一面的形态被改了（重构未同步）。 */
  const assignLine = uiSrc.match(/Object\.assign\(window,\s*\{([^}]*)\}\)/);
  /* 锁的是：window.ui 这一面同样要能解析（43 个工具文件解构它）。 */
  const uiLine = uiSrc.match(/window\.ui = \{([^}]*)\};/);
  assert.ok(assignLine && uiLine, '两份导出面都要能解析到');
  const parse = (txt) => new Set(txt.split(',').map((x) => x.trim()).filter(Boolean));
  const globals = parse(assignLine[1]);
  const uiMembers = parse(uiLine[1]);
  const onlyGlobal = [...globals].filter((x) => !uiMembers.has(x));
  assert.deepStrictEqual(onlyGlobal, [], 'Object.assign(window) 有、window.ui 缺失（解构方会拿到 undefined）：' + onlyGlobal.join(', '));
  /* 【反向不检查】window.ui 里的 makeButtonLike / focusable / resetShellForRebuild
   * 等成员是壳内部组件，不需要挂成全局 —— 全局面是子集关系，不是相等。 */
});

t('UC5 工具文件显式解构 escapeHtml（错误路径用法不再依赖隐式全局）', () => {
  /* 锁的是：上一轮把 12 个文件的 escapeHtml 改成显式解构（原来靠
   * Object.assign(window) 的隐式全局）。这个改动**不是修运行时错误**
   * —— 全局一直可用 —— 而是把"错误消息转义"这一安全敏感操作的依赖
   * 变成显式声明。锁住这个状态，防止哪天"顺手清理解构"时把它删掉。 */
  const files = [
    'js/tools/dev.js', 'js/tools/file-tools.js', 'js/tools/launch.js',
    'js/tools/media/av-convert.js', 'js/tools/media/av-info.js',
    'js/tools/media/exif-view.js', 'js/tools/media/ffmpeg-setup.js',
    'js/tools/media/screen-rec.js', 'js/tools/media/screenshot-ocr.js',
    'js/tools/net-tools.js', 'js/tools/office.js', 'js/tools/text-tools.js',
  ];
  const missing = [];
  for (const rel of files) {
    /* 锁的是：读这个文件是为了核对解构行 —— escapeHtml 的显式声明
     * 不回退（上一轮定的规范），重构成 window.ui.xxx 直调时这里要同步改。 */
    const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    /* 锁的是：解构行必须存在（重构成 window.ui.xxx 直调时这里要同步改）；
     * escapeHtml 的显式声明不回退（上一轮定的规范）。 */
    const d = s.match(/const \{([^}]*)\} = window\.ui;/);
    if (!d || !/escapeHtml/.test(d[1])) missing.push(rel);
  }
  assert.deepStrictEqual(missing, [], '这些文件的解构丢了 escapeHtml：' + missing.join(', '));
});

done();
