'use strict';
/* 本机已有开发环境的解析（纯函数）。
 *
 * 为什么抽出来：这些命令的输出**随语言变**（`py -0p` 的中英文排版相同但提示行不同，
 * java 的版本在 stderr、格式随版本变），而解析错了的表现是"明明装了却说没有"，
 * 或者把别的版本当成自己的。真实命令在 IPC 层跑，这里只解析文本，可逐条喂样本。
 */

/** `py -0p`：` -V:3.12 *        C:\...\python.exe` / ` -3.12-64 *   ...` */
function parsePyLauncher(text) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    /* 两种写法：-V:3.12 与 -3.12-64；星号表示默认 */
    const m = /^-V:(\d+(?:\.\d+)*)\s*(\*)?\s+(.+)$/.exec(line)
      || /^-(\d+(?:\.\d+)*)(?:-\d+)?\s*(\*)?\s+(.+)$/.exec(line);
    if (!m) continue;
    const exe = m[3].trim().replace(/^"(.*)"$/, '$1');
    if (!/python\.exe$/i.test(exe)) continue;
    out.push({ version: m[1], path: exe, isDefault: !!m[2] });
  }
  return out;
}

/** `where python` / `where java`：一行一个绝对路径，过滤空行 */
function parseWherePaths(text) {
  return String(text == null ? '' : text)
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter((s) => s && /^[A-Za-z]:[\\/]/.test(s));
}

/** `node -v`：v22.23.5 → 22.23.5 */
function parseNodeVersion(text) {
  const m = /v?(\d+\.\d+\.\d+)/.exec(String(text == null ? '' : text));
  return m ? m[1] : '';
}

/** `java -version`（输出在 stderr）：openjdk version "21.0.13" / java version "1.8.0_401" */
function parseJavaVersion(text) {
  const s = String(text == null ? '' : text);
  const m = /(?:openjdk|java)\s+version\s+"([^"]+)"/i.exec(s)
    || /version\s+"([^"]+)"/i.exec(s);
  return m ? m[1].trim() : '';
}

/** `gcc --version` / `g++ --version`：`g++.exe (GCC) 16.2.0` */
function parseGccVersion(text) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(text == null ? '' : text));
  return m ? m[1] : '';
}

/**
 * 把「where 找到的路径 + 版本探测结果」合成界面用的检测条目。
 * @param {string} id
 * @param {{paths?:string[], version?:string, source?:string}} facts
 */
function summarize(id, facts) {
  const paths = (facts && facts.paths) || [];
  const version = String((facts && facts.version) || '').trim();
  const found = !!(paths.length || version);
  return {
    id,
    found,
    version,
    path: paths[0] || '',
    paths,
    source: String((facts && facts.source) || ''),
  };
}

module.exports = {
  parsePyLauncher,
  parseWherePaths,
  parseNodeVersion,
  parseJavaVersion,
  parseGccVersion,
  summarize,
};