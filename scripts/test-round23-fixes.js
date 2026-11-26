'use strict';
/* R23：本轮新增回归的源码契约。
 *
 * 这两条锁的都是渲染层的 DOM 流程：快捷启动的默认名推导和旧/坏 store
 * 过滤。纯 Node 下没有 DOM，无法调用 register 里的 add()/load() 真实现，
 * 所以退回源码断言；匹配串锚定语义分支，不锁版面。 */

const { t, done, assert, readSrc } = require('./lib/harness');

function src(rel) {
  /* readSrc 会自动剥块注释，并受 SA-3 的裸 readFileSync 基线约束。 */
  return readSrc(rel);
}

t('S1 快捷启动默认名：文件要去扩展名，URL 要去查询串', () => {
  const s = src('js/tools/launch.js');
  /* 锁的是：旧写法 `/\.\\w+$/` 是「点 + 反斜杠 + w」，对 `报告.docx`
   * 根本不命中，弹窗里永远显示带扩展名的全名；URL 还会把 `?x=1` 带进默认名。
   * 现在按最后一个点切、只切 dot>0 的（保留 .gitignore），URL 先剥 ?/#。 */
  assert.ok(s.includes("replace(/[?#].*$/, '')"), 'URL 没有剥查询串/锚点');
  assert.ok(s.includes("const dot = suggested.lastIndexOf('.')"), '没有按最后一个点取扩展名');
  assert.ok(s.includes('if (dot > 0) suggested = suggested.slice(0, dot)'), '没有保留点开头文件');
  assert.ok(!s.includes("replace(/\\.\\w+$/, '')"),
    '仍残留旧的「点+反斜杠+w」错误正则');
});

t('S2 快捷启动/命令收藏：坏 store 不能中断渲染，也不能误执行', () => {
  const s = src('js/tools/launch.js');
  /* 锁的是：旧版/手改 store 里可能出现 null 或缺少 cmd 的项。
   * 快捷启动旧实现第一张卡就抛；命令收藏 renderTable 在 r.name 上抛，
   * 或者把缺 cmd 的项交给 exec:stream 执行 `cmd /c undefined`。 */
  assert.ok(/\.filter\(\(it\) => it && typeof it === 'object'\)/.test(s),
    '快捷项没有过滤 null/非对象');
  assert.ok(/if \(!valid\.length\)/.test(s), '全是坏项时没有空状态提示');
  assert.ok(/const items = Array\.isArray\(rawItems\) \? rawItems : \[\]/.test(s),
    '添加快捷项没有兜住非数组 store');
  assert.ok(/x && typeof x === 'object' && \(it\.id/.test(s),
    '快捷项删除没有跳过 null 项');
  assert.ok(/typeof x\.cmd === 'string' && x\.cmd/.test(s),
    '命令收藏没有过滤缺 cmd 的坏项');
  assert.ok(/x && typeof x === 'object' && x\.id === r\.id/.test(s),
    '命令删除没有跳过 null 项');
});

done();
