'use strict';
const assert = require('assert');
const { t, done, readMain } = require('./lib/harness');
const { scanBrace } = require('../lib/src-scan');
const mainSrc = readMain({ raw: true });

/* 网络工具解析的行为测试（原 test-round13 的 18）。
 *
 * 锁的是：wifi:key 从多行 netsh 输出里取密码与身份验证。
 * netsh 的输出是多段落、字段名随语言变化，按行解析很容易只取到第一段。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * 都从主进程/渲染层源码里抽出**真实现**来跑，不是手写副本
 * （副本会与实现分叉，那样测试就假绿了）。 */

function segFromHandler(channel, label) {
  const start = mainSrc.indexOf("handle('" + channel + "'");
  assert.ok(start > 0, '找不到 handler: ' + channel);
  /* handler 签名里可能有默认参数对象 `opts = {}`，不能取 start 之后的第一个 '{'，
   * 要跳到 `=> {` 之后的那个函数体开括号。 */
  const arrow = mainSrc.indexOf('=>', start);
  const from = arrow > 0 ? arrow : start;
  const open = mainSrc.indexOf('{', from);
  assert.ok(open > 0, 'handler ' + channel + ' 没有函数体');
  const end = scanBrace(mainSrc, open);
  assert.ok(end > open, 'handler ' + channel + ' 括号不配平');
  return mainSrc.slice(start, end);
}

t('18 wifi:key：多行 netsh 输出里能取到密码与身份验证', () => {
  /* 真实 netsh 输出是分节的，`关键内容 : xxx` 只是其中一行。
   * 原实现直接在整段上跑 /...$/（无 /m），$ 只匹配整串末尾，
   * 于是 key/auth 恒为 undefined → 界面把所有加密 WiFi 显示成「开放网络无密码」。 */
  const seg = segFromHandler('wifi:key');
  assert.ok(!/out\.match\(\/\(\?:关键内容/.test(seg),
    '仍在整段字符串上匹配（无 /m 时 $ 只匹配串尾，永远匹配不到）');
  assert.ok(/split\(\/\\r\?\\n\/\)/.test(seg),
    '应按行拆分后逐行匹配（与 wifi:profiles 的写法保持一致）');

  /* 用真实格式的输出跑一遍抽出来的取值逻辑 */
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
