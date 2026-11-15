'use strict';
/* 开发环境 IPC/UI 的接线检查（ipc/env-manager.js + js/tools/env-manager.js）。
 *
 * 为什么是源码断言：真实安装要下载几十到几百 MB、还要写 HKCU，CI 里不能跑。
 * 这里锁的是"一旦改错就会造成真实伤害"的形态：写系统环境、用 setx、
 * 先解压后校验、接受渲染层给的路径、默认模式被改掉、检测不警告；
 * 以及第五轮审查修掉的编码 / 注册表类型 / 串行锁 / 缓存校验。
 */
const { t, done, readSrc } = require('./lib/harness');
const assert = require('assert');

t('EM1 八个 env 通道都在主进程注册', () => {
  const src = readSrc('ipc/env-manager.js');
  for (const k of ['CATALOG', 'DETECT', 'INSTALL', 'REMOVE', 'CLEAN', 'APPLY', 'UNAPPLY', 'OPEN_TERMINAL']) {
    /* 锁的是：某个通道漏注册 —— 界面点了报 No handler registered，功能整块消失。 */
    assert.ok(src.indexOf('CH.ENV.' + k) !== -1, '缺少通道 ENV.' + k);
  }
});

t('EM2 只写当前用户环境：不碰系统 PATH、不用 setx、不碰 HKLM', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：写了 'Machine' 作用域 —— 影响所有用户且需要管理员，超出产品承诺。 */
  assert.ok(!/SetEnvironmentVariable\([^)]*['"]Machine['"]/.test(src), '不许写系统级环境变量');
  /* 锁的是：用 setx 改 PATH —— setx 在 1024 字符处截断，会毁掉用户 PATH。 */
  assert.ok(!/\bsetx\b/i.test(src), '不许用 setx');
  /* 锁的是：直接写 HKLM 注册表 —— 与"只改当前用户"的承诺冲突。 */
  assert.ok(!/HKLM|HKEY_LOCAL_MACHINE/i.test(src), '不许碰 HKLM');
  /* 锁的是：写入时作用域写错（Process/Machine）—— 只会改当前进程或全机。 */
  assert.ok(/HKCU:\\\\Environment/.test(src) || src.indexOf('HKCU:\\Environment') !== -1, '必须写 HKCU');
});

t('EM3 改完必须广播，否则新终端仍读到旧 PATH', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：写完注册表不广播 —— 用户从任务栏新开的 cmd 还是旧 PATH，
   * 表现为"装了但用不了"（经典的"要重启电脑才行"）。 */
  assert.ok(/WM_SETTINGCHANGE|0x1A|SendMessageTimeout/.test(src), '必须有 WM_SETTINGCHANGE 广播');
});

t('EM4 生成的 PowerShell 脚本必须带 BOM（PS 5.1 解码）', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：无 BOM 写 ps1 —— 中文路径变乱码，写错 PATH 或直接失败（v0.8.8 P1 同款）。 */
  assert.ok(/psScript\.withBom/.test(src), '写 .ps1 必须经过 psScript.withBom');
});

t('EM5 必须先校验 SHA-256 再解压', () => {
  const src = readSrc('ipc/env-manager.js');
  const check = src.indexOf('sha256File(archive)');
  const extract = src.indexOf('await extractArchive(archive, staging, rt)');
  /* 锁的是：顺序反了 —— 没校验的包先解压，等于把任意压缩包写进用户目录。 */
  assert.ok(check !== -1 && extract !== -1 && check < extract, '校验必须排在解压之前');
  /* 锁的是：校验失败仍继续安装。 */
  assert.ok(/digest !== rt\.sha256/.test(src) && /请稍后重试或反馈/.test(src), '校验失败必须中止并给出可读错误');
});

t('EM6 zip 解压要挡路径穿越（7z/tar 用入库 SHA 兜底）', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：AdmZip 直接解压 —— 带 ../ 或绝对路径的条目会写到 envs 目录之外。 */
  assert.ok(/assertSafeZipEntries/.test(src), 'zip 必须先检查条目');
  assert.ok(src.indexOf("n.split('/').includes('..')") !== -1, '必须拒绝 .. 段');
  assert.ok(/startsWith\('\/'\)/.test(src) || src.indexOf("n.startsWith('/')") !== -1, '必须拒绝绝对路径');
});

t('EM7 安装只接受运行时 id，路径与 URL 都由清单决定', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：install 接受渲染层传 url/path —— 任意下载 + 任意写盘。 */
  assert.ok(/async \(e, id, opts = \{\}\)/.test(src), 'INSTALL 只应接受 id + 选项');
  assert.ok(/envCatalog\.findRuntime\(id\)/.test(src), '必须用入库清单解析运行时');
  assert.ok(/ENV_ROOT = \(\) => path\.join\(userDataDir\(\), 'envs'\)/.test(src), '必须落在 userData/envs');
});

t('EM8 界面：默认加入用户环境、检测警告、保留仅本工具与官方入口', () => {
  const ui = readSrc('js/tools/env-manager.js');
  /* 锁的是：默认模式被改成"仅本工具" —— 与用户确认的产品默认相反。 */
  assert.ok(ui.indexOf("value: 'user' }, T('安装后加入当前用户环境（推荐）')") !== -1, '默认必须是加入用户环境');
  /* 锁的是：检测到已有版本却不提示 —— 用户不知道新终端会换用其它版本。 */
  assert.ok(/检测到已有版本/.test(ui), '必须有"检测到已有版本"的警告');
  /* 锁的是：把"仅本工具箱使用"选项删了 —— 用户没有安全的退出路径。 */
  assert.ok(/仅本工具箱使用/.test(ui), '必须保留仅本工具选项');
  /* 锁的是：官方安装器入口丢了 —— 需要系统级/注册表登记的用户无路可走。 */
  assert.ok(/官方安装器/.test(ui) && /SHELL\.OPEN_URL/.test(ui), '必须保留官方安装器入口');
  /* 锁的是：文案里出现 Markdown 星号 —— 项目明令禁止（会原样显示）。 */
  assert.ok(!/\*\*/.test(ui), '用户可见文案不许出现 ** 星号');
});

t('EM9 env 任务前缀在两张前缀表里都登记（守卫会对账）', () => {
  const lib = readSrc('lib/job-id.js');
  const pre = readSrc('js/job-prefixes.js');
  /* 锁的是：只登记一边 —— test-job-prefix-sync 会红，进度被别的任务认领。 */
  assert.ok(/env: '开发环境下载'/.test(lib), 'lib/job-id.js 缺少 env 前缀');
  assert.ok(/env: '开发环境下载'/.test(pre), 'js/job-prefixes.js 缺少 env 前缀');
});

t('EM10 合并/回滚用 moveFile（跨卷安全），不用裸 fsp.rename', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：用裸 rename 把解压结果搬进安装目录 —— 跨卷会直接 EXDEV 失败；回滚同样要跨卷。 */
  assert.ok(!/fsp\.rename\(/.test(src), '安装流程不许用裸 fsp.rename');
  /* 锁的是：落盘用裸 rename —— 解压目录与 userData 跨卷时 EXDEV 直接失败。 */
  assert.ok(/await moveFile\(root, layout\.dir\)/.test(src), '落盘必须走 moveFile');
  /* 锁的是：失败回滚用裸 rename —— 回滚本身失败，旧版本留在 .old-* 里找不回。 */
  assert.ok(/await moveFile\(trash, layout\.dir\)/.test(src), '回滚必须走 moveFile');
});

t('EM11 读用户环境必须强制 UTF-8，否则中文 PATH 读回即乱码', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：PowerShell 默认 OEM 代码页输出 + Node 按 utf8 解码 ——
   * 含中文的 PATH 读成乱码，随后写回把用户 PATH 写坏（第五轮实测复现）。 */
  assert.ok(/\[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8/.test(src), '读写脚本必须强制 UTF-8 输出');
});

t('EM12 写 PATH 必须按注册表原类型（REG_EXPAND_SZ），不能用 .NET API 降级', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：用 .NET SetEnvironmentVariable 写 PATH —— 它恒写 REG_SZ，
   * 用户 PATH 里的 %VAR% 引用会变成字面量（第五轮实测）。 */
  assert.ok(!/\[Environment\]::SetEnvironmentVariable\(/.test(src), '不许用 SetEnvironmentVariable 写用户变量');
  /* 锁的是：写 ExpandString 时没指定类型 —— 引用会被当普通字符串。 */
  assert.ok(/-Type ExpandString/.test(src), 'ExpandString 必须按类型写回');
  /* 锁的是：读的时候让 PowerShell 展开 %VAR% —— 写回的就是展开后的字面量。 */
  assert.ok(/DoNotExpandEnvironmentNames/.test(src), '必须读取未展开原值');
});

t('EM13 用户环境写必须串行，且同一运行时不能并行安装', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：两个 apply/unapply 同时读-改-写 —— 后写覆盖先写，丢更新。 */
  assert.ok(/withEnvLock/.test(src) && /envLockChain/.test(src), '必须有串行锁');
  /* 锁的是：两次安装同一运行时 —— 解压/落盘互相覆盖，manifest 指向半残目录。 */
  assert.ok(/installing\.has\(id\)/.test(src), '同一运行时安装必须互斥');
  /* 锁的是：manifest 写入在锁外 —— 与撤销/删除交错时状态不一致。 */
  assert.ok(/const a = await withEnvLock\(async \(\) => \{/.test(src), 'manifest 与 apply 必须在同一把锁里');
});

t('EM14 下载缓存必须校验，不能"非空即信"', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：缓存文件非空就跳过下载 —— 截断/被替换的包会直接进入解压。 */
  assert.ok(/let useCache =/.test(src) && /useCache && \(await sha256File\(archive\)\) !== rt\.sha256/.test(src), '缓存必须校验 SHA');
  /* 锁的是：缓存哈希不符后仍继续用 —— 必须删掉重下。 */
  assert.ok(/useCache = false;/.test(src), '缓存不符必须重下');
});

t('EM15 探测必须并行且带缓存，避免页面长时间"检测中"', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：四组探测串行 —— 最坏要等 4×6s 超时。 */
  assert.ok(/Promise\.all\(\[detectPython\(\), detectNode\(\), detectJava\(\), detectGcc\(\)\]\)/.test(src), '探测必须并行');
  /* 锁的是：每次进页面都跑 ~10 个子进程 —— 首屏与刷新都慢。 */
  assert.ok(/detectCache && Date\.now\(\) - detectCache\.at < 60000/.test(src), '探测结果必须缓存');
});

t('EM16 残留产物有清扫，安装包可清理，终端不再拼命令行', () => {
  const src = readSrc('ipc/env-manager.js');
  /* 锁的是：失败/取消后 .staging-* /.old-* 永久残留 —— 磁盘只增不减。 */
  assert.ok(/sweepEnvRoot/.test(src) && /\.staging-/.test(src) && /\.old-\\d\+\$/.test(src), '启动必须清扫 staging/old');
  /* 锁的是：安装包缓存无出口 —— Node/JDK/MinGW 加起来几百 MB 永久占盘。 */
  assert.ok(/handle\(CH\.ENV\.CLEAN/.test(src), '必须提供安装包清理');
  /* 锁的是：把版本/路径拼进 cmd /k 命令行 —— & | ^ 有命令拼接面。 */
  assert.ok(/\.term-/.test(src) && /spawn\('cmd\.exe', \['\/k', scriptPath\]/.test(src), '终端必须走临时 .cmd 脚本');
});

done();