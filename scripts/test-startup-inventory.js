'use strict';
/* 自启来源归一化的行为测试（第四轮新增：启动文件夹 / 计划任务 / 自启服务）。
 *
 * 为什么值得有：这三类数据来自 PowerShell 与 readdir，形状不稳定
 *（单条时 ConvertTo-Json 返回对象而不是数组；计划任务里 System 自带的有几百条），
 * 而归一化规则一旦漂移，界面就会开始显示「Microsoft\Windows\...」这种噪音，
 * 或者直接空白。这些规则是纯函数，可以逐条断言。
 */
const { t, done, readSrc } = require('./lib/harness');
const assert = require('assert');
const inv = require('../lib/startup-inventory');

t('SI1 计划任务：过滤 \Microsoft\ 系统任务并补齐字段', () => {
  const rows = [
    { TaskName: 'WindowsUpdate', TaskPath: '\\Microsoft\\Windows\\UpdateOrchestrator\\', State: 'Ready' },
    { TaskName: 'MyBackup', TaskPath: '\\MyTools\\', State: 'Ready' },
    { TaskName: 'Microsoft Edge Update', TaskPath: '\\', State: 'Disabled' },
    null,
  ];
  const out = inv.normalizeTasks(rows);
  /* 锁的是：系统自带任务没被过滤 —— 界面会被几百条 Microsoft\… 淹没。 */
  assert.strictEqual(out.length, 2, '应过滤掉 \\Microsoft\\ 下的任务，实际：' + JSON.stringify(out));
  assert.deepStrictEqual(out.map((x) => x.name).sort(), ['Microsoft Edge Update', 'MyBackup']);
  /* 锁的是：字段名映射错 —— 界面拿到 undefined，显示成空白行。 */
  assert.strictEqual(out.find((x) => x.name === 'MyBackup').path, '\\MyTools\\');
  assert.strictEqual(out.find((x) => x.name === 'MyBackup').state, 'Ready');
});

t('SI2 计划任务：PowerShell 单条结果（对象而非数组）也要能处理', () => {
  /* 锁的是：只处理数组 —— 电脑上恰好只有一个第三方任务时列表是空的。 */
  const out = inv.normalizeTasks({ TaskName: 'OnlyOne', TaskPath: '\\', State: 'Ready' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'OnlyOne');
});

t('SI3 服务：按显示名排序，丢弃没有名字的行', () => {
  const out = inv.normalizeServices([
    { Name: 'BService', DisplayName: 'B 服务', State: 'Running' },
    { Name: 'AService', DisplayName: 'A 服务', State: 'Stopped' },
    {},
  ]);
  /* 锁的是：排序没了 —— 用户找一个服务要在乱序列表里扫。 */
  assert.deepStrictEqual(out.map((x) => x.displayName), ['A 服务', 'B 服务']);
  /* 锁的是：缺 DisplayName 时退回 Name —— 不然那一格是空白。 */
  const noDisplay = inv.normalizeServices([{ Name: 'OnlyName', State: 'Running' }]);
  assert.strictEqual(noDisplay[0].displayName, 'OnlyName');
});

t('SI4 启动文件夹：只列真实可执行的快捷方式，排除 desktop.ini 与目录', () => {
  const entries = [
    { name: 'WeChat.lnk', isFile: () => true, isDirectory: () => false },
    { name: 'sync.bat', isFile: () => true, isDirectory: () => false },
    { name: 'desktop.ini', isFile: () => true, isDirectory: () => false },
    { name: 'notes.txt', isFile: () => true, isDirectory: () => false },
    { name: 'subdir', isFile: () => false, isDirectory: () => true },
  ];
  const out = inv.normalizeStartupFolder(entries, 'C:\\Users\\x\\Startup');
  /* 锁的是：把 desktop.ini / 普通文本 / 目录当成自启项 —— 用户以为那里有东西。 */
  assert.deepStrictEqual(out.map((x) => x.name), ['sync.bat', 'WeChat.lnk']);
  assert.strictEqual(out[1].path, 'C:\\Users\\x\\Startup\\WeChat.lnk');
});

t('SI5 主进程必须复用这份实现（不是各写一套）', () => {
  const main = readSrc('main.js');
  /* 锁的是：INVENTORY 自己复刻一份过滤/排序 —— 两份规则必然漂移。 */
  assert.ok(/startupInventory\.normalizeTasks\(/.test(main), 'autostart:inventory 没有用 normalizeTasks');
  assert.ok(/startupInventory\.normalizeServices\(/.test(main), 'autostart:inventory 没有用 normalizeServices');
  assert.ok(/startupInventory\.normalizeStartupFolder\(/.test(main), 'autostart:inventory 没有用 normalizeStartupFolder');
});

done();