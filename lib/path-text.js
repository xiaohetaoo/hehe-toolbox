'use strict';
/* Windows/POSIX 路径的 dirname / basename（渲染层与 Node 测试共用）。
 *
 * ============ 为什么需要这个 lib ============
 * 渲染层没有 Node 的 path，工具页里长期手写：
 *     p.replace(/[\\/][^\\/]*$/, '')
 * 这条正则在 `C:\foo` 上返回 `C:` —— 盘符相对路径，语义不是根目录 `C:\`。
 * 顶层文件/顶层目录（以及 `C:\` 本身）都会算错；同样的写法在 10 个页面里
 * 各抄了一遍（Office 默认输出目录、批量图片输出目录、系统工具“上一级”…），
 * 修一处漏九处。这里收成一份可单测的实现。
 *
 * 规则：
 *  - 尾部分隔符先剥掉，再取最后一个分隔符之前的部分；
 *  - `C:` 这种只剩盘符的结果补回 `C:\`；
 *  - `C:\`、`/`、UNC 根等没有父目录时原样返回；
 *  - 反斜杠与正斜杠都接受（WSL/Git Bash 路径也会进这里）。
 */
(function () {
  function isSep(ch) { return ch === '\\' || ch === '/'; }
  function stripTrailing(s) { return s.replace(/[\\/]+$/, ''); }
  /* 盘符根：普通 C: 与扩展长度 \\?\C: 都要认。后者是长路径前缀
   * （Windows 260 字符限制下常见），不认的话 dirname('\\?\C:\foo')
   * 会返回 \\?\C:（相对盘符），basename('\\?\C:\') 更会切出垃圾。 */
  const DRIVE_ROOT = /^(?:\\\\\?\\)?[A-Za-z]:$/;
  function isDriveRoot(s) { return DRIVE_ROOT.test(s); }
  function withRootSep(s) { return isDriveRoot(s) ? s + '\\' : s; }

  /* UNC 共享根：\\server\share 与 \\?\UNC\server\share。
   * 共享根本身没有父目录（\\server 只是主机名，不是可进入的目录），
   * 但通用「最后一个分隔符之前」的规则会把 dirname 算成 \\server。
   * 普通 UNC 子路径（\\server\share\a）不受影响，仍走通用分支。 */
  const UNC_ROOT = /^(?:[\\/]{2}[^\\/]+[\\/][^\\/]+|\\\\\?\\UNC\\[^\\/]+[\\/][^\\/]+)$/i;
  function isUncRoot(s) { return UNC_ROOT.test(s); }

  function dirname(p) {
    const s = String(p == null ? '' : p);
    if (!s) return '';
    if (isDriveRoot(s)) return s + '\\';
    const trimmed = stripTrailing(s);
    if (!trimmed) return s;                    // '/' / '\\'：根就是根
    if (isDriveRoot(trimmed)) return trimmed + '\\';
    /* 共享根没有父目录。输入带尾斜杠时输出也保留尾斜杠，
     * 与 Windows 路径的根语义一致（拼接时不会变成主机名）。 */
    if (isUncRoot(trimmed)) {
      const sep = s.slice(-1);
      return (sep === '\\' || sep === '/') ? trimmed + sep : trimmed;
    }
    let i = -1;
    for (let k = trimmed.length - 1; k >= 0; k--) {
      if (isSep(trimmed[k])) { i = k; break; }
    }
    if (i < 0) return '';                      // 'foo' 没有目录部分
    let out = trimmed.slice(0, i);
    if (!out) return trimmed[0];               // '/foo' -> '/'
    return withRootSep(out);
  }

  function basename(p) {
    const s = String(p == null ? '' : p);
    if (!s) return '';
    if (isDriveRoot(s)) return s;
    const trimmed = stripTrailing(s);
    if (!trimmed) return '';
    if (isDriveRoot(trimmed)) return trimmed;
    let i = -1;
    for (let k = trimmed.length - 1; k >= 0; k--) {
      if (isSep(trimmed[k])) { i = k; break; }
    }
    return i < 0 ? trimmed : trimmed.slice(i + 1);
  }

  const api = { dirname, basename };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  /* 用局部变量间接挂 window：直接 `window.PathText = api` 会被 tsc 报
   * Property 'PathText' does not exist（jsconfig 没扩展 Window 接口）。 */
  /** @type {any} */
  const pathTextRoot = typeof window !== 'undefined' ? window : null;
  if (pathTextRoot) pathTextRoot.PathText = api;
})();
