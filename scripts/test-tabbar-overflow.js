/* 标签栏溢出提示的不变量测试（CSS/JS 跨文件契约）。
 * jsdom 无 layout：clamp() 实际值、min-width、mask-image、scrollWidth 都取不到，
 * 这些契约只能用源码断言锁；每条断言上方三行内写明「锁的是」。 */
const { readSrc } = require('./lib/harness');

let pass = 0, fail = 0;
function chk(cond, name) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

/* 锁的是：CSS 是样式表不是 JS，lib/src-scan 的 stripComments 面向 JS 语法，
 * 对块注释交织的 CSS 会错位；这里的断言锚定完整规则行，raw 文本即可稳定匹配。 */
const css = readSrc('css/app.css', { raw: true });
const js = readSrc('js/app.js');

/* 锁的是：min-width:44px 是「压缩到可读下限后转滚动」策略的载体；
 * 旧值 0（无限压缩）实测 13 标签时 tab-label 只剩 0~6px，全部退化为死图标。
 * 行为测试取不到计算样式，只能锁规则文本。 */
chk(/\.tab\s*\{[^}]*min-width:\s*44px/.test(css) || css.includes('.tab { min-width: 44px; }'),
  'CSS 标签可读下限 min-width: 44px');
/* 锁的是：无限压缩的旧规则必须彻底移除；残留时新旧两条按源码顺序后者生效、
 * 行为难以预测，锁文本是唯一能证明「旧策略已退场」的手段。 */
chk(!css.includes('.tab { min-width: 0; }'),
  'CSS 无限压缩（min-width: 0）已撤销');
/* 锁的是：关闭按钮 visibility:hidden 不参与绘制但参与布局，实测每个标签
 * 白占 14px + 4px gap，13 个标签吃掉 ~230px 文字空间；display:none 才真正摘除。 */
chk(/\.tab \.tab-close\s*\{[^}]*display:\s*none/.test(css),
  'CSS 关闭按钮收起用 display:none（visibility:hidden 仍占布局）');
/* 锁的是：display:none 摘除后键盘用户必须仍有入口，:focus-within 是唯一的
 * 键盘显示路径；漏掉它则「标签多时可读」以牺牲键盘可达性为代价。 */
chk(/\.tab:hover \.tab-close, \.tab:focus-within \.tab-close\s*\{\s*display:\s*flex;\s*\}/.test(css),
  'CSS 悬停与键盘聚焦（focus-within）时关闭按钮显示');
/* 锁的是：旧的 visibility:hidden 方案必须整体移除；只要旧声明还在（哪怕
 * 被新规则覆盖），任何后续重构把选择器顺序调换就会静默回到占布局状态。 */
chk(!css.includes('.tab .tab-close { width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; border-radius: 3px; color: var(--text-3); visibility: hidden; }'),
  'CSS 旧的 visibility:hidden 方案已移除');
/* 锁的是：挤压段 padding 收紧（clamp 3~10px）在 13 标签时多让出 ~100px 文字
 * 空间；数值是实测调整过的，退回旧值等于把这条优化静默撤掉。 */
chk(css.includes('.tab { padding-left: clamp(3px, 0.9vw, 10px); padding-right: clamp(3px, 0.9vw, 10px); }'),
  'CSS 标签挤压段 padding 收紧到 clamp(3px, 0.9vw, 10px)');
/* 锁的是：旧 padding 值必须替换干净；残留时两条规则按源码顺序后者生效，
 * 与「新值生效」表面行为一致但意图丢失，后续改动极易误改回。 */
chk(!css.includes('clamp(4px, 1.2vw, 12px)'),
  'CSS 旧 padding 规则已被替换（不再有 clamp(4px, 1.2vw, 12px)）');

/* 锁的是：渐隐 mask 是「滚动条全局隐藏」下唯一的左向溢出提示载体；
 * jsdom 取不到 mask-image，规则丢失时用户对「左边还有标签」零感知。 */
chk(/\.tabbar\.overflow-left\s*\{[^}]*mask-image:\s*linear-gradient\(to right, transparent 0, #000 18px\)/.test(css),
  'CSS overflow-left 渐隐 mask 存在');
/* 锁的是：同上，右向溢出提示；13 标签未溢出时看似无用，窄窗口下是唯一线索。 */
chk(/\.tabbar\.overflow-right\s*\{[^}]*mask-image:\s*linear-gradient\(to left, transparent 0, #000 18px\)/.test(css),
  'CSS overflow-right 渐隐 mask 存在');
/* 锁的是：滚动到中间时两侧同时渐隐的组合规则；缺失则中间态退化为单侧提示，
 * 另一侧标签被静默裁掉。 */
chk(/\.tabbar\.overflow-left\.overflow-right\s*\{/.test(css),
  'CSS 双向溢出 mask 规则存在');

/* 锁的是：updateTabOverflowHint 必须由 renderTabs 收尾调用；漏调时方向类
 * 停在上一次的值，滚动后渐隐方向错、误导用户往错误方向滚动找标签。 */
chk(js.includes('updateTabOverflowHint();'),
  'JS renderTabs 收尾调用 updateTabOverflowHint');
/* 锁的是：JS 挂的类名必须与 CSS 期待的类名逐字相同 —— 这是跨文件契约，
 * 任何一侧改名（哪怕只差大小写）都静默失效，界面无报错。 */
chk(js.includes("el.classList.toggle('overflow-left', left)"),
  'JS 按滚动位置挂 overflow-left 类');
/* 锁的是：同上，右侧方向类的契约另一半。 */
chk(js.includes("el.classList.toggle('overflow-right', right)"),
  'JS 按滚动位置挂 overflow-right 类');
/* 锁的是：右溢出判据必须是 scrollLeft+clientWidth 与 scrollWidth 的几何比较
 * 且容忍 1px 舍入；判据错（比如用 offsetWidth 或漏掉 -1）会导致溢出提示
 * 在恰好铺满时抖动或永不出现。jsdom 无布局，只能锁判据文本。 */
chk(js.includes('el.scrollLeft + el.clientWidth < el.scrollWidth - 1'),
  'JS 右溢出判据是 scrollLeft+clientWidth 与 scrollWidth 比较');
/* 锁的是：监听挂载用 __heheOverflowBound 幂等 —— 壳重建（切语言）后 tabbarEl
 * 是新元素、必须重挂；同一元素重复走到 renderTabs 不能叠加监听，
 * 否则一次滚动触发 N 次 apply，切 N 次语言后监听器泄漏 N 倍。 */
chk(js.includes('el.__heheOverflowBound'),
  'JS 监听挂载有幂等标记（壳重建后重挂、同壳不重复）');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
