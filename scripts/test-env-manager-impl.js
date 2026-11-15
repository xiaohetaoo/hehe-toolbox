'use strict';
/* 开发环境 IPC/UI 的接线检查（ipc/env-manager.js + js/tools/env-manager.js）。
 *
 * 为什么是源码断言：真实安装要下载几十到几百 MB、还要写 HKCU，CI 里不能跑。
 * 这里锁的是"一旦改错就会造成真实伤害"的形态：写系统环境、用 setx、
 * 先解压后校验、接受渲染层给的路径、默认模式被改掉、检测不警告。
 */
const { t, done, readSrc } = require('./lib/harness');
const assert = require('assert');

t('EM1 七个 env 通道都在主进程注册', () => {
  const src = readSrc('ipc/env-manager.js');
  for (const k of ['CATALOG', 'DETECT', 'INSTALL', 'REMOVE', 'APPLY', 'UNAPPLY', 'OPEN_TERMINAL']) {
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
  /* 锁的是：忘记用 'User' 作用域 —— 写了个空作用域等于写进程环境。 */
  assert.ok(/['"]User['"]/.test(src), '必须显式写 User 作用域');
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
  assert.ok(/digest !== rt\.sha256/.test(src) && /请重试/.test(src), '校验失败必须中止并删除下载包');
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
  assert.ok(ui.indexOf("value: 'user' }, '安装后加入当前用户环境（推荐）'") !== -1, '默认必须是加入用户环境');
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
  /* 锁的是：用裸 rename 把解压结果搬进安装目录 —— 解压目录与 userData 恰好跨卷时
   * （HEHE_TEST_DATA 指到别的盘、或将来改了 staging 位置）会直接 EXDEV 失败；
   * 回滚那一步同样要能跨卷搬回去。 */
  assert.ok(!/fsp\.rename\(/.test(src), '安装流程不许用裸 fsp.rename');
  /* 锁的是：落盘用裸 rename —— 解压目录与 userData 跨卷时 EXDEV 直接失败。 */
  assert.ok(/await moveFile\(root, layout\.dir\)/.test(src), '落盘必须走 moveFile');
  /* 锁的是：失败回滚用裸 rename —— 回滚本身失败，旧版本留在 .old-* 里找不回。 */
  assert.ok(/await moveFile\(trash, layout\.dir\)/.test(src), '回滚必须走 moveFile');
});

done();