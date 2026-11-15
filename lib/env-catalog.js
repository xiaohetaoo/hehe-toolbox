'use strict';
/* 开发环境目录（纯数据 + 纯函数）。
 *
 * 设计取舍：
 *   · 只收录**可便携**的官方构建（zip / 7z / tar.gz），不调用厂商安装器；
 *     需要"系统级安装 / 注册表登记"的场景走 official 里的官方入口。
 *   · 版本、URL、SHA256 **入库固定**：离线也能装、可复现、可审计；
 *     "检查更新"是另一件事（联网），不在这里做。
 *   · 所有运行时都解压到 `<userData>/envs/<id>/<version>`，删目录即净。
 *
 * 数据来源（2026-11-14 采集）：
 *   node   npmmirror 镜像（nodejs.org 在本机 DNS 不可达）+ SHASUMS256.txt
 *   jdk    api.adoptium.net（assets/latest 21 hotspot，checksum 来自 API）
 *   mingw  winlibs_mingw GitHub Release 资产 digest（sha256）
 *   python astral-sh/python-build-standalone GitHub Release 资产 digest（sha256）
 */

const SUPPORTED_ARCHIVE = new Set(['zip', '7z', 'tar.gz']);

const RUNTIMES = [
  {
    id: 'node',
    name: 'Node.js',
    version: '22.23.5',
    url: 'https://npmmirror.com/mirrors/node/v22.23.5/node-v22.23.5-win-x64.zip',
    sha256: '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3',
    archive: 'zip',
    stripTop: 1,
    binDirs: [''],
    env: {},
    note: 'npm 随包自带',
    homepage: 'https://nodejs.org/zh-cn/download',
    official: { label: 'Node.js 官方下载页（含 MSI 安装器）', url: 'https://nodejs.org/zh-cn/download' },
    license: 'MIT',
  },
  {
    id: 'jdk',
    name: 'Java (Temurin JDK)',
    version: '21.0.13+9',
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip',
    sha256: 'a4dbaa05fca4bd89d84584e58c459bd732efebb1722af80ab13c6516832004f9',
    archive: 'zip',
    stripTop: 1,
    binDirs: ['bin'],
    env: { JAVA_HOME: '.' },
    note: '设置 JAVA_HOME，Maven / Gradle / IDEA 可直接识别',
    homepage: 'https://adoptium.net/temurin/releases/',
    official: { label: 'Temurin 官方安装器（MSI，写注册表）', url: 'https://adoptium.net/temurin/releases/?os=windows&arch=x64&package=jdk' },
    license: 'GPL-2.0 with Classpath Exception',
  },
  {
    id: 'mingw',
    name: 'MinGW-w64 (GCC)',
    version: '16.2.0',
    url: 'https://github.com/brechtsanders/winlibs_mingw/releases/download/16.2.0posix-23.1.3-14.0.0-ucrt-r3/winlibs-x86_64-posix-seh-gcc-16.2.0-mingw-w64ucrt-14.0.0-r3.7z',
    sha256: 'db014a73b71907c6c778fd1c938056cddcae9023f89f8dfff7783d9e45baf975',
    archive: '7z',
    stripTop: 1,
    binDirs: ['bin'],
    env: {},
    note: 'g++ / gcc / gdb（MSVCRT 之外的 UCRT 版本），不是 MSVC',
    homepage: 'https://winlibs.com/',
    official: { label: 'MSVC 官方入口（Visual Studio Build Tools）', url: 'https://visualstudio.microsoft.com/visual-cpp-build-tools/' },
    license: 'GPL-3.0 with GCC Runtime Library Exception',
  },
  {
    id: 'python',
    name: 'Python',
    version: '3.12.16',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-x86_64-pc-windows-msvc-install_only.tar.gz',
    sha256: 'e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b',
    archive: 'tar.gz',
    stripTop: 1,
    binDirs: ['', 'Scripts'],
    env: {},
    note: '便携完整版（含 pip 与标准库）；官方安装器才能被 py 启动器 / PEP 514 识别',
    homepage: 'https://www.python.org/downloads/windows/',
    official: { label: 'Python 官方安装器（勾 Add to PATH / py 启动器）', url: 'https://www.python.org/downloads/windows/' },
    license: 'PSF-2.0',
  },
];

/** 版本号 → 安全的目录名（`21.0.13+9` → `21.0.13_9`） */
function safeVersion(version) {
  return String(version == null ? '' : version)
    .trim()
    .replace(/[\\/:*?"<>|+]/g, '_')
    .replace(/\s+/g, '_');
}

/** 深拷贝一份运行时清单（避免调用方改到模块内数据） */
function getRuntimes() {
  return RUNTIMES.map((r) => JSON.parse(JSON.stringify(r)));
}

function findRuntime(id) {
  return RUNTIMES.find((r) => r.id === String(id || '')) || null;
}

/** `<userData>/envs/<id>/<version>`（版本段已净化） */
function installLayout(userDataDir, runtime) {
  if (!runtime || !runtime.id) throw new Error('未知的运行时');
  const versionDir = safeVersion(runtime.version) || 'unknown';
  const dir = require('path').join(String(userDataDir || ''), 'envs', runtime.id, versionDir);
  return { dir, versionDir };
}

/** 需要加入 PATH 的绝对目录（空串表示安装根目录） */
function binPaths(installDir, runtime) {
  const path = require('path');
  const dirs = (runtime && runtime.binDirs) || [''];
  return dirs.map((rel) => (rel ? path.join(installDir, rel) : String(installDir)));
}

/** 需要写入的环境变量；值为 '.' 表示安装根目录 */
function envPairs(installDir, runtime) {
  const out = {};
  for (const [k, v] of Object.entries((runtime && runtime.env) || {})) {
    out[k] = v === '.' ? String(installDir) : String(v);
  }
  return out;
}

/** 清单自检（测试与"目录被改坏"时的早失败） */
function validateCatalog(list) {
  const problems = [];
  const seen = new Set();
  for (const r of list || []) {
    if (!r || !r.id) { problems.push('条目缺少 id'); continue; }
    if (seen.has(r.id)) problems.push('重复的 id：' + r.id);
    seen.add(r.id);
    if (!/^[a-z][a-z0-9-]*$/.test(r.id)) problems.push(r.id + '：id 形态不合法');
    if (!r.name) problems.push(r.id + '：缺少 name');
    if (!r.version) problems.push(r.id + '：缺少 version');
    if (!/^https:\/\//.test(String(r.url || ''))) problems.push(r.id + '：下载地址必须是 https');
    if (!/^[a-f0-9]{64}$/.test(String(r.sha256 || ''))) problems.push(r.id + '：sha256 必须是 64 位小写 hex');
    if (!SUPPORTED_ARCHIVE.has(r.archive)) problems.push(r.id + '：不支持的压缩格式 ' + r.archive);
    if (!Array.isArray(r.binDirs) || !r.binDirs.length) problems.push(r.id + '：binDirs 不能为空');
    for (const b of r.binDirs || []) {
      if (b !== '' && /^[\\/]|\.\./.test(b)) problems.push(r.id + '：binDirs 里有可疑路径 ' + b);
    }
  }
  return problems;
}

module.exports = {
  SUPPORTED_ARCHIVE,
  RUNTIMES,
  getRuntimes,
  findRuntime,
  safeVersion,
  installLayout,
  binPaths,
  envPairs,
  validateCatalog,
};