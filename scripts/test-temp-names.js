'use strict';
/* 临时名生成器与清理白名单的一致性自检。
 * 【这个测试本身就是防"新增产物忘登记"的护栏】
 * 事故背景：.hehe-7zx-* 带前导点，白名单正则却写成 ^hehe-7zx-（不带点），
 * 于是那个暂存目录永远匹配不上白名单，7z 解压崩溃后永久残留在用户目录里，
 * 而「清理临时文件」扫不到它。
 */
const assert = require('assert');
const path = require('path');
const T = require('../lib/temp-names');

const { t, done } = require('./lib/harness');

const NOW = 1700000000000;
const HEX = 'abc123';

/* ============ 三类临时产物，性质不同 ============
 *
 * A 类「全局清扫型」：产物落在 %TEMP% 或用户目录里，且**没有自己的清理代码兜底**
 *    （进程崩溃后就留在那儿了）。必须能被 OWN_TEMP_PATTERNS 命中。
 *
 * B 类「带本应用标记的中间产物」：名字里带 hehe 标记，且内容一定是"未完成的副本"
 *    （原子写入的 .hehe-w-/.hehe-bak-、加解密的 .hehe-crypt-）。
 *    清掉它们安全（它们不是用户的正式数据），所以**也**在白名单里 ——
 *    这样崩溃后残留能被「清理临时文件」扫到。
 *
 * C 类「绝不能进白名单」：产物紧挨着用户正式数据、且由产生它的代码自己回收：
 *      · 搬家的 .hehe-bak 里装着用户的整个目录 —— 自动删等于毁数据
 *        （main.js 用 BAK_LEFTOVER 拦住"还有残留备份"的操作，交给用户确认）；
 *      · 下载的 .part 在用户指定目录（例如下载文件夹），不属于 %TEMP% 清扫范围，
 *        由 downloadToFile 自己在成功/失败路径上回收。
 */

/* A 类：必须被白名单命中 */
const GLOBAL_SWEEP = [
  ['snipTmp', T.snipTmp({ now: NOW, hex: HEX })],
  ['ffmpegZip', T.ffmpegZip({ now: NOW })],
  ['recSegDir', T.recSegDir({ now: NOW })],
  ['tgtTmpDir', T.tgtTmpDir({ now: NOW, hex: HEX })],
  ['uniqTmpDir', T.uniqTmpDir({ now: NOW, hex: HEX })],
  ['sevenStagingDir', T.sevenStagingDir('D:/out', { now: NOW, hex: HEX })],
  ['updateLogName', T.updateLogName('20260101-010101')],
  ['rollbackLogName', T.rollbackLogName('20260101-010101')],
];

/* B 类：带本应用标记的中间产物 —— 也必须在白名单里（崩溃残留要能被扫到） */
const MARKED_INTERMEDIATE = [
  ['writeTmp', T.writeTmp('D:/a/x.txt', 'tag1')],
  ['writeBak', T.writeBak('D:/a/x.txt', 'tag1')],
  ['cryptTmp', T.cryptTmp('D:/a/out.enc', { now: NOW, hex: HEX })],
];

/* C 类：绝不能进白名单 —— 是用户数据或由 owner 回收 */
const MUST_NOT_SWEEP = [
  ['dirmoveBak', T.dirmoveBak('D:/src')],
  ['downloadPart', T.downloadPart('D:/a/setup.exe', { now: NOW, hex: HEX })],
];

t('10a 全局清扫型产物（A 类）都能被 OWN_TEMP_PATTERNS 命中', () => {
  const miss = [];
  for (const [fn, full] of GLOBAL_SWEEP) {
    const base = path.basename(full);
    if (!T.isOwnTempName(base)) miss.push(fn + ' → ' + base);
  }
  assert.deepStrictEqual(miss, [],
    '这些产物匹配不上清理白名单（崩溃后会永久残留、且自动清理扫不到）：\n  ' + miss.join('\n  '));
});

t('10a2 带本应用标记的中间产物（B 类）也要能被扫到', () => {
  /* 它们的内容一定是"未完成的副本"（不是用户的正式数据），
   * 所以清掉安全；但崩溃后可能残留，也必须能被清理功能扫到。 */
  const miss = [];
  for (const [fn, full] of MARKED_INTERMEDIATE) {
    const base = path.basename(full);
    if (!T.isOwnTempName(base)) miss.push(fn + ' → ' + base);
  }
  assert.deepStrictEqual(miss, [], '这些带标记的中间产物没进白名单：\n  ' + miss.join('\n  '));
});

t('10a3 C 类产物绝不能进白名单 —— 删了就是数据事故', () => {
  /* 【这条是反向断言，比"能命中"更要紧】
   * 搬家的 .hehe-bak 里是用户整个目录，下载的 .part 在用户指定目录。
   * 若有人"顺手"把它们加进白名单，「清理临时文件」就可能删掉用户数据。 */
  const wrong = [];
  for (const [fn, full] of MUST_NOT_SWEEP) {
    const base = path.basename(full);
    if (T.isOwnTempName(base)) wrong.push(fn + ' → ' + base);
  }
  assert.deepStrictEqual(wrong, [],
    '这些名字进了清理白名单，可能被「清理临时文件」删掉用户数据：\n  ' + wrong.join('\n  '));
});

t('10b 带前导点的产物：有前导点、无前导点两种形态都能命中', () => {
  /* 老版本留下的无点文件也必须能清理（正则用 \.? 兼容）。
   * 这条单独列出来，是因为"带点"那次事故的根因就在这里。 */
  const withDot = path.basename(T.sevenStagingDir('', { now: NOW, hex: HEX }));
  const withoutDot = withDot.replace(/^\./, '');
  assert.ok(T.isOwnTempName(withDot), '带点的 7z 暂存目录应当命中：' + withDot);
  assert.ok(T.isOwnTempName(withoutDot), '无点的 7z 暂存目录（老版本残留）也应当命中：' + withoutDot);
});

t('10c 同一毫秒内两次调用不撞名', () => {
  /* 撞名在这里是真事故：两次截图写出同一个 PNG 路径，第一张被覆盖；
   * 两个压缩任务共用同一个暂存目录，第二个会踩到第一个的半成品。 */
  const a = T.snipTmp({ now: NOW, hex: 'aaaaaa' });
  const b = T.snipTmp({ now: NOW, hex: 'bbbbbb' });
  assert.notStrictEqual(a, b, '同一毫秒 + 不同随机后缀应当得到不同文件名');
  /* 不注入 hex 时用真随机源，也应当不撞 */
  const c = T.snipTmp({ now: NOW });
  const d = T.snipTmp({ now: NOW });
  assert.notStrictEqual(c, d, '真随机源下同一毫秒两次调用也不该撞名：' + c + ' vs ' + d);
});

t('10d 不该被误判成我们的临时产物', () => {
  /* 反向：别人的文件不能被白名单命中（否则"清理临时文件"会误删别人的东西）。
   * 这一条比"能命中"更要紧 —— 误删是数据事故。 */
  const strangers = [
    'my-notes.txt',
    'setup.exe',
    'photo.jpg',
    'cache.db',
    'hehe-data.json',          // 本应用的数据文件，不是临时产物
    'hehe-toolbox-Portable.exe', // 打包产物名，不该被清理
    'document.part-1',          // 别人的下载残留（没有 ts-hex 形态）
  ];
  const wrong = strangers.filter((n) => T.isOwnTempName(n));
  assert.deepStrictEqual(wrong, [], '这些普通文件被误判成临时产物（清理会误删）：' + wrong.join(', '));
});

t('10e OWN_TEMP_PATTERNS 非空且每条都是正则', () => {
  assert.ok(T.OWN_TEMP_PATTERNS.length > 0, '白名单不能是空的');
  for (const re of T.OWN_TEMP_PATTERNS) assert.ok(re instanceof RegExp, '白名单里混进了非正则');
});

done();
