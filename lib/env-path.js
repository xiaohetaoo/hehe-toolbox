'use strict';
/* 用户级 PATH 的纯字符串操作（主进程与测试共用）。
 *
 * 为什么单独成模块：
 *   · 这是「加入用户环境」里唯一真正有风险的部分（改的是全机共享的 PATH），
 *     必须能脱离注册表、脱离 Electron 用样本反复测；
 *   · 规则要写死在一处：只前置、只删自己加的、大小写不敏感、去重、长度预警。
 *   · 绝不碰系统 PATH（HKLM），也不用 setx（1024 字符截断事故）。
 */

/** 按 `;` 拆开、去空白、丢空项（Windows 允许尾随分号，不能当成一项） */
function splitPath(value) {
  return String(value == null ? '' : value)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 大小写不敏感去重（Windows 语义），保留第一次出现的顺序 */
function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const k = String(e).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(String(e));
  }
  return out;
}

/** 比较用的归一：去尾部分隔符 + 小写（`C:\a\` 与 `c:\a` 视为同一项） */
function normalizeForCompare(p) {
  return String(p == null ? '' : p).replace(/[\\/]+$/, '').toLowerCase();
}

/** 写入 PATH 前去掉尾分隔符，但盘符根必须保留成 `C:\`。
 *  只写成 `C:` 在 PATH 里是「C 盘当前目录」，语义不是 C 盘根目录；
 *  用户在环境管理里选中驱动器根时会走到这条。 */
function stripTrailingSep(p) {
  const s = String(p == null ? '' : p).trim();
  if (/^[A-Za-z]:[\\/]?$/.test(s)) return s.slice(0, 2) + '\\';
  if (/^[\\/]+$/.test(s)) return s[0];
  return s.replace(/[\\/]+$/, '');
}

function hasEntry(current, entry) {
  const key = normalizeForCompare(entry);
  return splitPath(current).some((e) => normalizeForCompare(e) === key);
}

/**
 * 把若干目录前置到 PATH：
 *   · 只添加**尚不存在**的项（已在 PATH 里的保持原位置，免得"加入环境"再"撤销"时
 *     把用户原来的路径删掉）；
 *   · **不重排、不去重用户已有项** —— Windows PATH 里允许重复（很多安装器会加重复项），
 *     去重会改变用户 PATH 的内容，撤销时也恢复不回来（v0.8.8 收尾时真机踩到）。
 * @returns {{value:string, added:string[]}} added 仅包含真正新增的项
 */
function prependEntries(current, entries) {
  const raw = String(current == null ? '' : current);
  const trailing = /;\s*$/.test(raw);   // 用户 PATH 可能以分号结尾，撤销时要原样还回去
  const currentList = splitPath(raw);
  const existing = new Set(currentList.map(normalizeForCompare));
  const wanted = dedupe((entries || []).map((s) => String(s).trim()).filter(Boolean))
    .map((s) => stripTrailingSep(s));
  const added = [];
  for (const e of wanted) {
    const k = normalizeForCompare(e);
    if (existing.has(k)) continue;
    existing.add(k);
    added.push(e);
  }
  if (!added.length) return { value: raw, added: [] };
  const tail = currentList.join(';');
  return { value: added.join(';') + (tail ? ';' + tail : '') + (trailing ? ';' : ''), added };
}

/**
 * 只从 PATH 里摘掉我们加的项（大小写不敏感、精确匹配整项，不做模糊删）。
 * @returns {{value:string, removed:string[]}}
 */
function removeEntries(current, entries) {
  const raw = String(current == null ? '' : current);
  const trailing = /;\s*$/.test(raw);
  const keys = new Set((entries || []).map(normalizeForCompare));
  const before = splitPath(raw);
  const kept = before.filter((e) => !keys.has(normalizeForCompare(e)));
  const removed = before.filter((e) => keys.has(normalizeForCompare(e)));
  /* 【全删空时不能返回 ";"】
   * 原写法 `kept.join(';') + (trailing ? ';' : '')`：
   * PATH 只有我们加的项、且原值以分号结尾时，kept 为空、trailing 为真
   * → 返回单个 ";"。而 Windows 把空 PATH 项解释成**当前目录**，
   * 等于把一个空白项塞进搜索路径（安全与正确性问题）。
   * 全删空就返回空字符串；非空时保留原有的尾分号习惯。 */
  if (!kept.length) return { value: '', removed };
  return { value: kept.join(';') + (trailing ? ';' : ''), removed };
}

/** 软预警：Windows 用户 PATH 没有硬上限，但太长会被部分程序截断/变慢 */
function pathTooLong(value, limit) {
  return String(value == null ? '' : value).length > (Number(limit) || 2000);
}

module.exports = {
  splitPath,
  dedupe,
  normalizeForCompare,
  hasEntry,
  prependEntries,
  removeEntries,
  pathTooLong,
};