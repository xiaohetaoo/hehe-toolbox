/* 锁的是：标签溢出后「活跃标签滚入可视区」这条交互。
 *
 * 回归场景：103 个标签（极限回归可达）时新开/切到的工具停在滚动区外，
 * 用户从搜索打开工具后看不到它的标签，只有右缘渐隐。
 * 浏览器（Chrome/Edge）的标准行为是把活跃标签滚进来。
 *
 * 为什么不能用行为断言：scrollIntoView 的实际滚动要真实布局；
 * jsdom 无 layout（scrollLeft 恒 0），行为测试恒空转。
 * 所以锁两条源码事实：
 *   1) renderTabs 收尾必须对 .tab.active 调 scrollIntoView（inline:nearest，
 *      已可见时是 no-op，不会每次重绘都跳动）；
 *   2) 调用必须排在 updateTabOverflowHint 之前 —— 渐隐方向类依据的是
 *      滚动之后的 scrollLeft，顺序反了会把方向类算在旧位置上。 */
const { readSrc } = require('./lib/harness');

const js = readSrc('js/app.js');

let pass = 0, fail = 0;
function chk(cond, name) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

/* 锁的是：active 标签滚入可视区这一行为的存在性。 */
chk(/const activeTab = tabbarEl\.querySelector\('\.tab\.active'\);/.test(js),
  'JS renderTabs 收尾查找 .tab.active');
chk(/activeTab\.scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/.test(js),
  'JS 用 inline:nearest 滚动（可见时 no-op，不跳动）');
/* 锁的是：滚动必须发生在方向类计算之前。scrollIntoView 改变 scrollLeft，
 * updateTabOverflowHint 读的就是它；顺序反了渐隐方向会停在旧状态。 */
const scrollPos = js.indexOf('activeTab.scrollIntoView(');
const hintPos = js.indexOf('updateTabOverflowHint();');
chk(scrollPos >= 0 && hintPos >= 0 && scrollPos < hintPos,
  'JS scrollIntoView 排在 updateTabOverflowHint 之前（方向类依据滚动后的位置）');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
