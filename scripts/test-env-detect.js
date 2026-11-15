'use strict';
/* 本机环境探测的文本解析（lib/env-detect.js）。
 *
 * 这些命令的输出随系统语言、版本、安装方式变化，而解析错的表现是
 * "明明装了却说没有"（或者把系统版本错报成工具箱版本）。
 * 真实命令由 IPC 层执行，这里只喂样本。
 */
const { t, done } = require('./lib/harness');
const assert = require('assert');
const det = require('../lib/env-detect');

t('ED1 py 启动器：中英文排版与星号默认项都要认', () => {
  const sample = [
    ' -V:3.12 *        C:\\Users\\x\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
    ' -V:3.10          C:\\Python310\\python.exe',
    ' -3.11-64         D:\\tools\\python311\\python.exe',
    'Installed Pythons found by C:\\Windows\\py.exe Launcher for Windows',
    '',
  ].join('\r\n');
  const out = det.parsePyLauncher(sample);
  /* 锁的是：只认一种写法 —— 另一种版本在界面上凭空消失。 */
  assert.deepStrictEqual(out.map((x) => x.version), ['3.12', '3.10', '3.11']);
  assert.strictEqual(out[0].isDefault, true);
  assert.strictEqual(out[1].isDefault, false);
  /* 锁的是：把提示行当版本（"Installed Pythons..."）—— 版本列表出现乱码项。 */
  assert.ok(out.every((x) => /^3\./.test(x.version)));
});

t('ED2 where 输出：引号与空行不会污染路径', () => {
  /* 锁的是：把提示行/空行当路径 —— 后续 stat 全部失败，误判"未安装"。 */
  assert.deepStrictEqual(det.parseWherePaths('C:\\Python312\\python.exe\r\n\r\n"D:\\Tools\\python.exe"\r\n'),
    ['C:\\Python312\\python.exe', 'D:\\Tools\\python.exe']);
  assert.deepStrictEqual(det.parseWherePaths(''), []);
});

t('ED3 Java 版本：openjdk 与 1.8 老格式都要认（输出在 stderr）', () => {
  /* 锁的是：只从 stdout 取版本 —— java -version 的输出在 stderr，永远读不到。 */
  const s1 = 'openjdk version "21.0.13" 2026-10-20\r\nOpenJDK Runtime Environment Temurin-21.0.13+9';
  assert.strictEqual(det.parseJavaVersion(s1), '21.0.13');
  const s2 = 'java version "1.8.0_401"\r\nJava(TM) SE Runtime Environment';
  assert.strictEqual(det.parseJavaVersion(s2), '1.8.0_401');
  assert.strictEqual(det.parseJavaVersion('not java'), '');
});

t('ED4 Node / GCC 版本提取', () => {
  /* 锁的是：node 前面带 v 时把 v 也存进版本号 —— 比较版本时对不上清单。 */
  assert.strictEqual(det.parseNodeVersion('v22.23.5\r\n'), '22.23.5');
  assert.strictEqual(det.parseNodeVersion('garbage'), '');
  assert.strictEqual(det.parseGccVersion('g++.exe (x86_64-win32-seh-ucrt) 16.2.0\r\nCopyright (C)'), '16.2.0');
});

t('ED5 summarize：有路径或有版本即视为已安装，字段形状稳定', () => {
  const a = det.summarize('node', { paths: ['C:\\node\\node.exe'], version: '22.1.0' });
  /* 锁的是：只有版本没有路径时判成未安装（PATH 里没有但装在别处的情况）。 */
  assert.strictEqual(a.found, true);
  assert.strictEqual(a.path, 'C:\\node\\node.exe');
  const b = det.summarize('python', { paths: [], version: '' });
  assert.strictEqual(b.found, false);
  /* 锁的是：字段缺失变成 undefined —— 界面渲染出 "undefined"。 */
  assert.deepStrictEqual(Object.keys(b).sort(), ['found', 'id', 'path', 'paths', 'source', 'version']);
});

done();