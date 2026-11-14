'use strict';
/* 开机自启的「其他来源」归一化（纯函数，主进程与测试共用）。
 *
 * 背景：原来的 autostart 只读注册表 Run 键。用户问「为什么开机慢」时，
 * 只看 Run 键只能答一半 —— 启动文件夹、计划任务、自动启动的服务同样是自启来源。
 * 这里只做**只读汇总**：把 PowerShell / readdir 拿到的原始形状归一成
 * 界面能直接渲染的数组，过滤掉系统自带的噪音（\Microsoft\ 下的计划任务）。
 *
 * 【为什么抽成 lib】
 * 归一化规则（哪些算噪音、按什么排序、字段怎么映射）是唯一会漂移的部分，
 * 留在 main.js 里就只能靠读源码断言；抽出来之后测试能直接喂样本断言输出。
 * 副作用为 0：这些函数不碰 IO、不碰 Electron。
 */

/* PowerShell 的 ConvertTo-Json：单条结果返回对象，多条返回数组。
 * 统一成数组，避免调用方每处都写一遍 Array.isArray。 */
function asArray(v) {
  if (Array.isArray(v)) return v;
  return v == null || v === '' ? [] : [v];
}

/**
 * 计划任务归一化。过滤 `\Microsoft\` 下的系统任务（几百条噪音，
 * 而且用户不该在第三方工具的列表里看到它们）。
 * @param {any} rows PowerShell 结果（对象或数组）
 * @returns {{name:string,path:string,state:string}[]}
 */
function normalizeTasks(rows) {
  return asArray(rows)
    .filter((t) => t && (t.TaskName || t.taskName))
    .map((t) => ({
      name: String(t.TaskName || t.taskName || ''),
      path: String(t.TaskPath || t.taskPath || '\\'),
      state: String(t.State || t.state || ''),
    }))
    /* 系统自带任务：TaskPath 形如 '\\Microsoft\\Windows\\...'。
     * 只看路径前缀，不看名字 —— 第三方也可能把任务命名为 "Microsoft xxx"。 */
    .filter((t) => !/^\\\\?Microsoft(\\|$)/i.test(t.path))
    .filter((t) => t.name)
    .sort((a, b) => (a.path + a.name).localeCompare(b.path + b.name));
}

/**
 * 自启服务归一化（只保留 StartMode=Auto 的；调用方 SQL 已经过滤，
 * 这里再兜一次，防止换了查询写法就把手动服务混进来）。
 * @param {any} rows
 * @returns {{name:string,displayName:string,state:string}[]}
 */
function normalizeServices(rows) {
  return asArray(rows)
    .filter((s) => s && (s.Name || s.name))
    .map((s) => ({
      name: String(s.Name || s.name || ''),
      displayName: String(s.DisplayName || s.displayName || s.Name || s.name || ''),
      state: String(s.State || s.state || ''),
    }))
    .filter((s) => s.name)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/* 启动文件夹里值得列出来的东西。desktop.ini 这种是系统元数据，列出来只会让人困惑。 */
const STARTUP_FILE_RE = /\.(lnk|exe|bat|cmd|vbs|js|url)$/i;

/**
 * 启动文件夹条目归一化。
 * @param {import('fs').Dirent[]|{name:string,isDirectory?:()=>boolean,isFile?:()=>boolean}[]} entries
 * @param {string} dir
 * @returns {{name:string,path:string}[]}
 */
function normalizeStartupFolder(entries, dir) {
  const path = require('path');
  return asArray(entries)
    .filter((e) => e && e.name && String(e.name).toLowerCase() !== 'desktop.ini')
    .filter((e) => {
      if (typeof e.isDirectory === 'function' && e.isDirectory()) return false;
      if (typeof e.isFile === 'function' && !e.isFile()) return false;
      return STARTUP_FILE_RE.test(e.name);
    })
    .map((e) => ({ name: String(e.name), path: path.join(String(dir || ''), e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { asArray, normalizeTasks, normalizeServices, normalizeStartupFolder, STARTUP_FILE_RE };