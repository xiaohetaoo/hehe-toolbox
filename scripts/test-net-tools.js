'use strict';
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
/* segFromHandler 统一到 scripts/lib/seg-from-handler.js —— 见那里的文件头说明。 */
const { segFromHandler } = require('./lib/seg-from-handler');
const mainSrc = readMain({ raw: true });

/* 网络工具解析的行为测试（原 test-round13 的 18）。
 *
 * 锁的是：wifi:key 从多行 netsh 输出里取密码与身份验证。
 * netsh 的输出是多段落、字段名随语言变化，按行解析很容易只取到第一段。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * 都从主进程/渲染层源码里抽出**真实现**来跑，不是手写副本
 * （副本会与实现分叉，那样测试就假绿了）。 */


t('18 wifi:key：多行 netsh 输出里能取到密码与身份验证', () => {
  /* 真实 netsh 输出是分节的，`关键内容 : xxx` 只是其中一行。
   * 原实现直接在整段上跑 /...$/（无 /m），$ 只匹配整串末尾，
   * 于是 key/auth 恒为 undefined → 界面把所有加密 WiFi 显示成「开放网络无密码」。 */
  const seg = segFromHandler(mainSrc, 'wifi:key');
  /* 锁的是「WiFi 密码解析依赖中文提示文本」这个脆弱实现 ——
     * 非中文系统上 netsh 的输出没有那些字样，密码会被整段丢掉。
     * 只能看源码形态：真跑要目标机器连着特定加密方式的 Wi-Fi。 */
  /* 锁的是「WiFi 密码解析依赖中文提示文本」这个脆弱实现 ——
     * 非中文系统上 netsh 的输出没有那些字样，密码会被整段丢掉。
     * 只能看源码形态：真跑要目标机器连着特定加密方式的 Wi-Fi。 */
  assert.ok(!/out\.match\(\/\(\?:关键内容/.test(seg),
    '仍在整段字符串上匹配（无 /m 时 $ 只匹配串尾，永远匹配不到）');
  /* 锁的是「必须按行拆分后逐行匹配」—— netsh 的列宽随系统语言变化，
   * 整段匹配在无 /m 时 $ 只认串尾，永远命中不了。真跑需要真实无线网卡。 */
  assert.ok(/split\(\/\\r\?\\n\/\)/.test(seg),
    '应按行拆分后逐行匹配（与 wifi:profiles 的写法保持一致）');

  /* 用真实格式的输出跑一遍抽出来的取值逻辑 */
  /* 锁的是「键值扫描器必须存在且按行工作」：这是上面两条的实现基础。
   * 拿到它的源码是为了在下一行断言它内部的分支。 */
  const kvSrc = seg.match(/const kvOf = \(re\) => \{[\s\S]*?\n  \};/);
  assert.ok(kvSrc, '找不到 kvOf');
  const out = [
    '接口 WLAN 的配置文件 X:',
    '安全设置',
    '-------------------',
    '    身份验证            : WPA2-个人',
    '    密码                : CCMP',
    '安全密钥',
    '-------------------',
    '    关键内容            : P@ssw0rd123',
    '    关键索引            : 1',
    '',
  ].join('\r\n');
  const kv = new Function('out', kvSrc[0] + '\nreturn kvOf;');
  const f = kv(out);
  assert.strictEqual(f(/关键内容|Key Content/i), 'P@ssw0rd123', '密码没取到');
  assert.strictEqual(f(/身份验证|Authentication/i), 'WPA2-个人', '身份验证没取到');
});

/* ==================== 19. isRunningAsAdmin 三态 ==================== */

done();
