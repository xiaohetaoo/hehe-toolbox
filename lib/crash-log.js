'use strict';
/* 崩溃日志：把主进程/渲染进程的非正常退出与未捕获异常落到磁盘。
 *
 * ============ 为什么需要这个模块 ============
 * 打包后的 exe 是**没有控制台**的：main.js 原来的
 *
 *     process.on('uncaughtException', (err) => console.error('uncaught', err));
 *
 * 等于把异常写进一个不存在的终端。用户遇到「点了没反应 / 窗口突然没了」时，
 * 现场只有一条 console.error，而那条输出没有任何人能读到 ——
 * 既没有文件、也没有界面入口，出问题了完全没法查。
 *
 * 这里把三类事件落盘：
 *   1) 主进程 uncaughtException / unhandledRejection
 *   2) 渲染进程崩溃（render-process-gone：OOM、非法指令、被杀）
 *   3) 上次会话**异常退出**（没走正常的 before-quit）
 *
 * ============ 为什么第 3 条要单独做 ============
 * 前两条只在"错误发生的那一刻"有用。但最常见的用户报告是
 * **「它自己关了」**——进程直接被系统杀掉（OOM killer、断电、任务管理器），
 * 那种情况下异常处理器根本来不及跑，日志里什么都没有。
 * 所以还要有一个「我活着」的标记：启动时写、正常退出时删。
 * 下次启动发现标记还在 = 上次没走完退出流程，据此在界面上提醒一次。
 *
 * ============ 隐私 ============
 * 日志会写到用户可能发给别人看的文件里，所以路径做脱敏
 * （see redact()）——用户名换成 <user>。不做这一步的话，
 * 一份崩溃日志就等于泄漏了「这台电脑的用户名 + 目录结构」。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_LOG_BYTES = 256 * 1024; // 单个日志上限，超出就轮转（避免无限增长）
const MAX_KEEP = 5;               // 最多保留几个历史日志

/* 把日志正文里的敏感/易变内容替换掉。
 * - 用户名：Windows 路径 C:\Users\xxx\... 与 /home/xxx、/Users/xxx
 * - 临时目录：每次启动都不同，留着只会让同类问题看起来"每次都不同"
 */
function redact(text, opts) {
  const o = opts || {};
  let s = String(text == null ? '' : text);
  const user = o.user || (() => { try { return os.userInfo().username; } catch (e) { return ''; } })();
  if (user) {
    // 只替换「作为独立路径段出现」的用户名，避免把正文里恰好同名的单词也替换掉
    const esc = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp('([\\\\/])' + esc + '(?=[\\\\/]|$)', 'g'), '$1<user>');
  }
  if (o.tempDir) {
    const t = String(o.tempDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(t, 'g'), '<tmp>');
  }
  return s;
}

/* 从 Error / 任意抛出物里取出「够用又不至于失控」的信息。
 * 堆栈只留前 N 行：完整堆栈动辄几百行，对定位问题没帮助，
 * 反而把真正重要的第一条错误淹掉。（与 lib/errors.js 的 toPayload 同一取舍。）
 */
function describe(err, opts) {
  const o = opts || {};
  const maxStack = o.maxStack || 20;
  if (err == null) return { message: '(null)', stack: '', code: '' };

  // 不是 Error 的抛出物（字符串、对象）也要能记下来
  if (!(err instanceof Error)) {
    let text;
    try { text = typeof err === 'object' ? JSON.stringify(err) : String(err); }
    catch (e) { text = Object.prototype.toString.call(err); }
    return { message: text, stack: '', code: '' };
  }

  const stack = String(err.stack || '')
    .split('\n')
    .slice(0, maxStack)
    .join('\n');
  return {
    message: String(err.message || err.name || 'Error'),
    stack: stack,
    /* Node 的 Error 在 checkJs 下没有 code/errno 字段（它们是运行时附加上去的），
     * 但我们要么读它们、要么丢掉唯一的机器可判错误码。
     * 用 @type 断言说明"这里按 Node 惯例访问可选字段"，
     * 比 as any 更窄：只放宽这两个字段，其余仍受检查。 */
    code: String(/** @type {{code?: string, errno?: number|string}} */ (err).code
      || /** @type {{code?: string, errno?: number|string}} */ (err).errno || '')
  };
}

/* 拼接一条日志。kind 决定语义，其余是上下文。 */
function formatEntry(kind, payload, opts) {
  const o = opts || {};
  const d = describe(payload && payload.err, o);
  const lines = [];
  lines.push('===== ' + new Date().toISOString() + '  ' + kind + ' =====');
  if (payload && payload.where) lines.push('where: ' + payload.where);
  if (d.code) lines.push('code: ' + d.code);
  lines.push('message: ' + d.message);
  if (payload && payload.detail) lines.push('detail: ' + payload.detail);
  if (d.stack) {
    lines.push('stack:');
    lines.push(d.stack);
  }
  return redact(lines.join('\n'), o) + '\n';
}

/* 渲染进程崩溃事件的说明。reason 是 Electron 给的枚举
 * （crashed / oom / killed / launch-failed / integrity-failure …）。 */
function describeGone(reason, exitCode) {
  const map = {
    'crashed': '渲染进程崩溃（通常是内存不足或图形驱动问题）',
    'oom': '渲染进程因内存不足被终止',
    'killed': '渲染进程被外部终止（任务管理器 / 安全软件）',
    'launch-failed': '渲染进程启动失败',
    'integrity-failure': '渲染进程代码完整性校验失败（asar 可能被改动）'
  };
  const base = map[reason] || ('渲染进程异常结束：' + reason);
  return base + (exitCode != null && exitCode !== 0 ? '（exitCode=' + exitCode + '）' : '');
}

/* 「我还活着」标记的读写。
 * 存在 = 上次启动后没走完正常退出。
 * 这里刻意用独立的文件名而不是往日志里追加：
 * 标记必须每次都**覆盖写**，而日志是追加写，语义不同。 */
function markerPath(dir) { return path.join(dir, 'session.lock'); }
function logPath(dir) { return path.join(dir, 'crash.log'); }

function readMarker(dir) {
  try {
    const raw = fs.readFileSync(markerPath(dir), 'utf8');
    const info = JSON.parse(raw);
    return (info && typeof info === 'object') ? info : null;
  } catch (e) { return null; }
}

function writeMarker(dir, info) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(markerPath(dir), JSON.stringify(info || {}), 'utf8');
    return true;
  } catch (e) { return false; }
}

function clearMarker(dir) {
  try { fs.rmSync(markerPath(dir), { force: true }); return true; }
  catch (e) { return false; }
}

/* 追加一条日志。返回是否真的写成功 —— 调用方据此决定要不要退回 console。 */
function append(dir, text) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = logPath(dir);
    // 超过上限就轮转：crash.log → crash.1.log …（只留 MAX_KEEP 份）
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_LOG_BYTES) rotate(dir);
    } catch (e) { /* 文件还不存在，正常 */ }
    fs.appendFileSync(file, text, 'utf8');
    return true;
  } catch (e) { return false; }
}

function rotate(dir) {
  try {
    for (let i = MAX_KEEP; i >= 1; i--) {
      const from = path.join(dir, i === 1 ? 'crash.log' : 'crash.' + (i - 1) + '.log');
      const to = path.join(dir, 'crash.' + i + '.log');
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch (e) { /* 单个失败不影响其余 */ }
    }
  } catch (e) {}
}

/* 列出已有日志文件（日志查看入口用）。最新的在前。 */
function listLogs(dir) {
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^crash(\.\d+)?\.log$/.test(name)) continue;
      const full = path.join(dir, name);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) { continue; }
      out.push({ name: name, path: full, size: size, mtime: mtime });
    }
  } catch (e) { return []; }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/* 读最近一条日志的尾部（界面上「查看最近崩溃」用）。
 * 只取尾部：用户不需要看三天前的记录，而我们也不想把 256KB 全塞进渲染层。 */
function tail(dir, maxBytes) {
  const limit = maxBytes || 16 * 1024;
  const logs = listLogs(dir);
  if (!logs.length) return { text: '', file: null };
  const newest = logs[0];
  try {
    const st = fs.statSync(newest.path);
    const start = Math.max(0, st.size - limit);
    const fd = fs.openSync(newest.path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(limit, st.size));
      fs.readSync(fd, buf, 0, buf.length, start);
      return { text: buf.toString('utf8'), file: newest.path, truncated: start > 0 };
    } finally { fs.closeSync(fd); }
  } catch (e) {
    return { text: '', file: newest.path, error: String(e && e.message || e) };
  }
}

module.exports = {
  redact: redact,
  describe: describe,
  formatEntry: formatEntry,
  describeGone: describeGone,
  markerPath: markerPath,
  logPath: logPath,
  readMarker: readMarker,
  writeMarker: writeMarker,
  clearMarker: clearMarker,
  append: append,
  rotate: rotate,
  listLogs: listLogs,
  tail: tail,
  MAX_LOG_BYTES: MAX_LOG_BYTES,
  MAX_KEEP: MAX_KEEP
};
