'use strict';
/* 从 zip 里抽出 app.asar，用 asar 包读源码，验证「修复真的进了产物」。
 *
 * 【为什么需要这个脚本】
 * 发布最容易犯的错误不是代码写错，而是**发了旧包**：源码改了、测试全绿，
 * 但 dist 是上一次构建的产物。只看文件时间戳不够（时钟、拷贝都可能骗人），
 * 唯一可靠的验证是拆开包看里面的代码。
 *
 * 【用法】node scripts/verify-fixes-in-package.js [版本号]
 * 版本号缺省取 package.json 的 version，据此定位 dist 里的 zip。
 *
 * 【历史】
 * v0.8.3 首次写这个脚本（当时硬编码版本号与 6 个修复）。
 * v0.8.4 起改成按版本自动定位，并把两代的检查项都保留在表里 ——
 * 旧版本的包仍可用 `node scripts/verify-fixes-in-package.js 0.8.3` 校验。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
/* 【7z 的选择顺序：系统 7-Zip 优先】
 * 7zip-bin 的 7za.exe 会被 360 等安全软件拦（解压时报「拒绝访问」，
 * 2026-11-21 实测，与打包拦截是同一类；见交接文档坑 11），系统自装的
 * 7z.exe 不在拦截名单里。两个都试，谁在用谁。 */
function findSevenZip() {
  const cands = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 7z：请安装 7-Zip 或 npm install 7zip-bin');
}
const Z7 = findSevenZip();

const version = process.argv[2] || require(path.join(ROOT, 'package.json')).version;
const ZIP = path.join(ROOT, 'dist', 'hehe-toolbox-' + version + '-win-x64.zip');
if (!fs.existsSync(ZIP)) {
  console.log('找不到产物：' + ZIP);
  process.exit(1);
}

/* 每个版本的检查项：[文件, 说明, 判据]。
 * 判据一律是「某段代码形态是否存在」—— 这是唯一能从产物里验证的东西。 */
const CHECKS_BY_VERSION = {
  '0.8.3': [
    ['lib/power-gate.js', '横杠写法（shutdown -a / -s 对称）',
      (s) => /const SAFE_ARGS_RE = \/\\s\[\/-\]\(a\|\\\?\)/.test(s)
        && /UNSAFE_SWITCH_RE = \/\(\^\|\\s\)\[\/\|\-\]/.test(s)],
    ['js/drop-open.js', 'bind 幂等标记',
      (s) => /__dropOpenBound/.test(s)],
    ['css/app.css', '拖拽遮罩用 --card-bg（无 --bg-1 引用）',
      (s) => {
        /* 剥注释再判：修复说明里会写「没有 --bg-1 这个变量」，直接搜会假阳性 */
        const decl = s.replace(/\/\*[\s\S]*?\*\//g, '');
        return !/var\(--bg-1\)/.test(decl)
          && /\.drop-overlay-inner\s*\{[^}]*background:\s*var\(--card-bg\)/.test(decl);
      }],
    ['js/tools/pdf-plus.js', '页码扣除跳过页',
      (s) => /const n = i \+ 1 - skip;/.test(s)],
    ['js/app.js', 'consumePendingClip 具名函数',
      (s) => /function consumePendingClip\(page, toolId\)/.test(s)],
    ['js/app.js', '保活分支调用 consumePendingClip',
      (s) => /consumePendingClip\(rec\.el/.test(s)],
  ],
  '0.8.4': [
    ['lib/power-gate.js', 'F1 if 条件剥离（stripIfCondition）',
      (s) => /function stripIfCondition/.test(s)],
    ['lib/power-gate.js', 'F1 PS 花括号块（extractBraces）',
      (s) => /function extractBraces/.test(s)],
    ['lib/power-gate.js', 'F1 iex / Invoke-Expression fail-closed',
      (s) => /invoke-expression/.test(s) && /iex/.test(s)],
    ['lib/path-guard.js', 'F2 深层保护不再受 recursive 限定',
      (s) => {
        /* 剥注释后不应再有 `recursive && isCriticalDeep` 这种限定 */
        const decl = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return !/recursive\s*&&\s*isCriticalDeep/.test(decl)
          && /if \(isCriticalDeep\(abs\)\)/.test(decl);
      }],
    ['lib/path-guard.js', 'F5 共用 stringPathOrError 助手',
      (s) => /function stringPathOrError/.test(s)],
    ['js/ui.js', 'F4 expandNotice 缺省自取上限',
      (s) => /maxFiles\s*>\s*0\s*\)\s*\?\s*maxFiles\s*:\s*expandMaxFiles\(\)/.test(s)],
    ['js/tools/mojibake-fix.js', 'F3 不再引用 --fill-1',
      (s) => !/var\(--fill-1\)/.test(s.replace(/\/\*[\s\S]*?\*\//g, ''))],
    ['js/tools/disk-health.js', 'F3 不再引用 --fill-1',
      (s) => !/var\(--fill-1\)/.test(s.replace(/\/\*[\s\S]*?\*\//g, ''))],
    ['js/drop-open.js', 'F6 takePending 按 toolId 过滤',
      (s) => /p\.toolId\s*&&\s*toolId\s*&&\s*p\.toolId\s*!==\s*toolId/.test(s)],
    ['js/clip-actions.js', 'F6 takePendingClip 按 toolId 过滤',
      (s) => /p\.toolId\s*&&\s*toolId\s*&&\s*p\.toolId\s*!==\s*toolId/.test(s)],
  ],
  '0.8.5': [
    ['lib/power-gate.js', 'R1 递归可执行位判定（textHasDanger）',
      (s) => /function textHasDanger/.test(s) && /textHasDanger\(/.test(s)],
    ['lib/power-gate.js', 'R1 iex 出现即拦',
      (s) => /invoke-expression/.test(s) && /iex/.test(s)],
    ['lib/power-gate.js', 'R1 引号感知的条件剥离',
      (s) => /function stripIfCondition/.test(s)],
    ['lib/fs-ops.js', 'R2 单引号路径转义（concatFileLine）',
      (s) => {
        if (!/function concatFileLine/.test(s)) return false;
        /* 判据：函数体里必须有 `'\\''` 这段转义序列。
         * 【不用正则写这个判据】转义在正则字面量里要套四层反斜杠，
         * 写错一次就会变成永远匹配不上（假红）或永远匹配（假绿）。
         * 直接数源码里的字符码：两个反斜杠 + 两个单引号。 */
        const fn = s.slice(s.indexOf('function concatFileLine'), s.indexOf('module.exports'));
        const need = '\\'.repeat(2) + "''";
        return fn.indexOf(need) !== -1;
      }],
    ['ipc/media-ffmpeg.js', 'R2 concat 清单改用 concatFileLine',
      (s) => /concatFileLine/.test(s)],
    ['lib/sensitive.js', 'R3 GitHub fine-grained token 判据',
      (s) => /github_pat_/.test(s)],
    ['css/app.css', 'R4 首页分类网格响应式断点',
      (s) => /@media\s*\(max-width:\s*1023px\)[\s\S]{0,120}\.home-cats/.test(s)],
    ['css/app.css', 'R6 拖拽区 busy 状态样式',
      (s) => /\.dropzone\.busy/.test(s)],
    ['main.js', 'R5 preview-tmp 清扫',
      (s) => /function sweepPreviewTmp/.test(s) && /sweepPreviewTmp\(\)/.test(s)],
    ['js/auxwin/snip-2.js', '死代码 W/H 已清理',
      (s) => !/const W = \+params\.get/.test(s)],
    ['js/channels.js', '陈旧迁移注释已修正',
      (s) => !/只迁移了两个域/.test(s)],
  ],
  '0.8.6': [
    ['js/cmdk.js', 'N1 命令面板存在且接了五个动作',
      (s2) => /@home/.test(s2) && /@settings/.test(s2) && /@theme/.test(s2) && /@lang/.test(s2)],
    ['js/cmdk.js', 'N1 复用 Registry.search（排序只有一份）',
      (s2) => /window\.Registry\.search\(/.test(s2)],
    ['js/tools/chain.js', 'N2 工具链：六个操作都在',
      (s2) => /compress-image/.test(s2) && /rename-seq/.test(s2) && /to-pdf/.test(s2)],
    ['js/tools/chain.js', 'N2 图片转 PDF 用 pdf-lib 本地（不依赖 Office）',
      /* 【必须剥掉注释再判】源码里有一大段解释「为什么不能走
       * OFFICE.CONVERT」，不剥注释的话那段解释会被当成"还在用它"，
       * 检查永远红、而且红的原因看起来像没修好。 */
      (s2) => {
        const code = s2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return /embedJpg|embedPng/.test(code) && !/OFFICE\.CONVERT/.test(code);
      }],
    ['js/tools/chain.js', 'N2 哈希取 r.hex.sha256',
      (s2) => /r\.hex\.sha256/.test(s2)],
    ['js/tools/pdf-pages.js', 'N3 PDF 页面管理存在',
      (s2) => /function parseRange/.test(s2) && /removePage|copyPages/.test(s2)],
    ['js/tools/win-layout.js', 'N4 窗口布局：六种布局 + 示意图',
      (s2) => /v-split/.test(s2) && /grid-4/.test(s2) && /function layoutPreviewSvg/.test(s2)],
    ['js/tools/win-layout.js', 'N4 Place 用 SW_RESTORE + NOACTIVATE',
      (s2) => /ShowWindow\(p,\s*9\)/.test(s2) && /0x4\s*\|\s*0x10/.test(s2)],
    ['js/registry.js', 'N5 三个新工具都登记进 ORDER',
      (s2) => /'tool-chain'/.test(s2) && /'pdf-pages'/.test(s2) && /'win-layout'/.test(s2)],
    ['lib/channels.js', 'N4 winmgr:place 通道存在',
      (s2) => /WINMGR\.PLACE|winmgr:place/.test(s2)],
    ['main.js', 'N4 Handlers 已注册 place + workArea',
      (s2) => /WINMGR\.PLACE/.test(s2) && /workArea:/.test(s2)],
    ['js/tools/dev.js', 'N6 取色器：历史色板 + 多格式',
      (s2) => /color-history/.test(s2) && /colorRefOf/.test(s2) && /paintFormats/.test(s2)],
    ['js/registry.js', 'N7 分类有 intro/introEn',
      (s2) => /introEn:/.test(s2)],
    ['css/app.css', 'N7 卡片等高等宽',
      (s2) => /grid-auto-rows:\s*1fr/.test(s2) && /hc-intro/.test(s2)],
    ['js/icons.js', 'N8 refresh 图标已修（弧与箭头同源）',
      (s2) => /M21 12a9 9 0 1 1-2\.64-6\.36/.test(s2)],
  ],
  '0.8.7': [
    ['lib/power-gate.js', 'S1 wmic 词根已加',
      (s2) => /'wmic'/.test(s2)],
    ['lib/power-gate.js', 'S1 POWER_CMD_RE 覆盖 wmic 形态',
      (s2) => /wmic\\b/.test(s2)],
    ['js/tools/office.js', 'S2 office 无 sanitizer 退化为纯文本',
      (s2) => /box\.textContent = r\.content/.test(s2)],
    ['js/tools/dev.js', 'S2 dev 无 sanitizer 退化为纯文本',
      (s2) => /view\.textContent = ta\.value/.test(s2)],
    ['js/tools/qr.js', 'S3 错误消息已转义',
      (s2) => /escapeHtml\(e && e\.message/.test(s2)],
    ['js/tools/sys-tools.js', 'S3 sys 错误消息已转义 x2',
      (s2) => (s2.match(/escapeHtml\(e\.message\)/g) || []).length >= 2],
    ['js/tools/media/shared.js', 'S4 loadImg revoke objectURL',
      (s2) => /URL\.revokeObjectURL\(url\)/.test(s2)],
    ['js/tools/qr.js', 'S4 qr revoke objectURL',
      (s2) => /dropLastUrl/.test(s2) && /lastObjUrl = URL\.createObjectURL/.test(s2)],
    ['js/tools/media/screenshot-ocr.js', 'S4 ocr revoke objectURL',
      (s2) => /dropLastUrl/.test(s2)],
    ['js/tools/media/img-compress.js', 'S6 批量停止：cancelFlag + break',
      (s2) => /let cancelFlag/.test(s2) && /if \(cancelFlag\) break/.test(s2)],
    ['js/tools/media/img-watermark.js', 'S6 批量停止：cancelFlag + break',
      (s2) => /let cancelFlag/.test(s2) && /if \(cancelFlag\) break/.test(s2)],
    ['js/tools/media/batch-ocr.js', 'S6 批量停止：cancelFlag + break',
      (s2) => /let cancelFlag/.test(s2) && /if \(cancelFlag\) break/.test(s2)],
    ['js/tools/text-codec.js', 'S7 URL 解码错误提示',
      (s2) => /decodeErrHint\(String\(\(e && e\.message\)/.test(s2)],
    ['js/icons.js', 'S8 palette/line 图标已补',
      (s2) => /palette:/.test(s2) && /line:/.test(s2)],
    ['js/icons.js', 'S8 refresh 图标已修',
      (s2) => /M21 12a9 9 0 1 1-2\.64-6\.36/.test(s2)],
  ],
  /* v0.8.8：第四轮审查 18 处修复 + 四项新功能。
   * 每组都挑「产物里能读到、且改回去就会重现 bug」的那一行 —— 不锁文案。 */
  '0.8.8': [
    ['lib/ps-script.js', 'P1 更新脚本 BOM 约定（独立模块）',
      (s2) => /withBom/.test(s2) && /\\uFEFF/.test(s2)],
    ['main.js', 'P1 两处脚本写盘都走 withBom',
      (s2) => /psScript\.withBom\(ps\)/.test(s2) && /psScript\.withBom\(rb\)/.test(s2)],
    ['main.js', 'P1 更新脚本起不来不再假装升级（psStarted）',
      (s2) => /if \(!psStarted\)/.test(s2) && /WindowsPowerShell/.test(s2)],
    ['lib/power-gate.js', 'P2 电源门禁：caret 转义 + 变量首词',
      (s2) => /function isVariableHead/.test(s2) && /\\\^\(\[\\s\\S\]\)/.test(s2.replace(/\\\\/g, '\\'))],
    ['lib/power-gate.js', 'P2 延迟展开只在 /v:on 下 fail-closed',
      (s2) => /\\\/v:on/.test(s2) && /!\[\^!\\s\]\+!/.test(s2)],
    ['js/ui.js', 'P3 消费拖拽支持显式 toolId',
      (s2) => /function consumePendingDrop\(explicitToolId\)/.test(s2)],
    ['js/app.js', 'P3 保活复用传 v.toolId',
      (s2) => /consumePendingDrop\(v\.toolId\)/.test(s2)],
    ['js/tools/pdf-plus.js', 'P4 字体无条件 embed（只加页码不崩）',
      (s2) => /const font = await doc\.embedFont/.test(s2) && !/if \(wantWm\) font =/.test(s2)],
    /* 【P5（工具链哈希结果进报告）不在 0.8.8 的产物里】
   * 这是本版的已知偏差：代码修复在 v0.8.8 发布之后才真正落地（原先只有
   * 方案没有实现），因此对 0.8.8 的产物校验不能把它列为必过项；
   * 等下一版构建后再把这条加进对应的版本块。 */
    ['js/tools/win-layout.js', 'P6 首屏枚举并裁剪失效选择',
      (s2) => /chosen = chosen\.filter/.test(s2)],
    ['ipc/media-ffmpeg.js', 'P7 录制中途死亡记 recDeath',
      (s2) => /recDeath/.test(s2) && /recExpectedStop/.test(s2)],
    ['main.js', 'P8 更新包死锁：认领自己的旧包',
      (s2) => /isOwnUpdateArtifact/.test(s2)],
    ['js/cmdk.js', 'P9 键盘监听挂 document 并可摘除',
      (s2) => /document\.addEventListener\('keydown', onKey\)/.test(s2)
        && /document\.removeEventListener\('keydown', onKey\)/.test(s2)],
    ['js/tools/dev.js', 'P10 取色器不再累积 onCleanup 闭包',
      (s2) => {
        /* 剥注释再判：说明文字里会引用旧写法 App.onCleanup(cleanup)，
         * 直接搜全文会假阳性（同 0.8.3/0.8.4 那几条的处理）。 */
        const code = s2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return /pickCleanup/.test(code) && !/App\.onCleanup\(cleanup\)/.test(code);
      }],
    ['js/tools/pdf-pages.js', 'P11 读取失败清空四个状态',
      (s2) => /doc = null; srcB64 = null; pageOrder = \[\]; rotations/.test(s2)],
    ['js/ui.js', 'P12 dropzone 点击防重入',
      (s2) => /if \(picking\) return/.test(s2) && /finally \{ picking = false; \}/.test(s2)],
    ['main.js', 'P13 update:apply 目标不再由渲染层指定',
      (s2) => {
        /* 剥注释：注释里保留了「原来的写法是 opts.target」这段历史，
         * 直接否定会被自己的说明文字误判成失败。 */
        const code = s2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return /PORTABLE_EXECUTABLE_FILE \|\| app\.getPath\('exe'\)/.test(code) && !/opts\.target/.test(code);
      }],
    ['lib/fs-ops.js', 'P15 排他占位改名（placeUnique）',
      (s2) => /async function placeUnique/.test(s2) && /open\(cand, 'wx'\)/.test(s2)],
    ['ipc/fs-ops.js', 'P16 原子写拒绝目录目标',
      (s2) => /DEST_IS_DIR/.test(s2)],
    ['lib/path-guard.js', 'P17/P18 盘符相对 + \\\\?\\ 前缀',
      (s2) => /DRIVE_RELATIVE/.test(s2) && s2.indexOf('{2}[?.]') >= 0],
    ['lib/restore-point.js', 'N4 还原点解析独立模块',
      (s2) => /parseVssStorage/.test(s2) && /parseDmtfTime/.test(s2)],
    ['lib/startup-inventory.js', 'N3 启动项归一化独立模块',
      (s2) => /normalizeTasks/.test(s2) && /normalizeStartupFolder/.test(s2)],
    ['main.js', 'N3/N4 新通道与高危能力接线',
      (s2) => /CH\.AUTOSTART\.INVENTORY/.test(s2) && /'restore-point-delete'/.test(s2)
        && /'sys:restore-delete': 'restore-point-delete'/.test(s2)],
    ['js/tools/sys-tools.js', 'N1 空间分析器下钻（面包屑）',
      (s2) => /function breadcrumb/.test(s2) && /DIR_CHILDREN/.test(s2)],
    ['js/tools/sys-tools.js', 'N2 清理类别带 defaultOff / needsAdmin',
      (s2) => /checked: !it\.defaultOff/.test(s2) && /it\.needsAdmin/.test(s2)],
    ['lib/channels.js', 'N4 通道常量全量迁移 188/188',
      (s2) => /TOTAL: 188/.test(s2) && /MIGRATED: 188/.test(s2)],
  ],
  /* v0.8.9：新增「开发环境」（便携运行时 + 用户环境管理）。 */
  '0.8.9': [
    ['js/tools/env-manager.js', 'E1 工具页进了包，且默认加入用户环境',
      (s2) => /安装后加入当前用户环境（推荐）/.test(s2) && /ENV\.INSTALL/.test(s2)],
    ['js/tools/env-manager.js', 'E2 保留仅本工具与官方安装器入口',
      (s2) => /仅本工具箱使用/.test(s2) && /官方安装器/.test(s2)],
    ['ipc/env-manager.js', 'E3 IPC 域在包里，七个通道齐全',
      (s2) => ['APPLY', 'CATALOG', 'DETECT', 'INSTALL', 'REMOVE', 'UNAPPLY', 'OPEN_TERMINAL']
        .every((k) => s2.indexOf('CH.ENV.' + k) !== -1)],
    ['ipc/env-manager.js', 'E4 只写 User 作用域且不碰系统 PATH',
      (s2) => {
        /* 剥注释再判：说明文字里写了「不用 setx」「不碰系统 PATH」，
         * 直接对全文搜会被自己的注释误伤。 */
        const code = s2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return /['"]User['"]/.test(code) && !/\bsetx\b/i.test(code) && !/HKLM|HKEY_LOCAL_MACHINE/i.test(code);
      }],
    ['ipc/env-manager.js', 'E5 先校验 SHA-256 再解压',
      (s2) => s2.indexOf('sha256File(archive)') !== -1
        && s2.indexOf('sha256File(archive)') < s2.indexOf('await extractArchive(archive, staging, rt)')],
    ['lib/env-catalog.js', 'E6 四个运行时与固定 SHA 都在包里',
      (s2) => /22\.23\.5/.test(s2) && /21\.0\.13/.test(s2) && /3\.12\.16/.test(s2) && /16\.2\.0/.test(s2)
        && (s2.match(/[a-f0-9]{64}/g) || []).length >= 4],
    ['lib/env-path.js', 'E7 不重排用户 PATH、保留尾分号',
      (s2) => /prependEntries/.test(s2) && /trailing \? ';' : ''/.test(s2)],
    ['lib/env-detect.js', 'E8 检测解析在包里',
      (s2) => /parsePyLauncher/.test(s2) && /parseJavaVersion/.test(s2)],
    ['lib/channels.js', 'E9 通道常量 195',
      (s2) => /TOTAL: 195/.test(s2) && /MIGRATED: 195/.test(s2) && /APPLY: 'env:apply'/.test(s2)],
    ['index.html', 'E10 页面引入 env-manager.js',
      (s2) => /js\/tools\/env-manager\.js/.test(s2)],
  ],
  /* v0.9.0：第五轮审查后的开发环境修复与加固。 */
  '0.9.0': [
    ['ipc/env-manager.js', 'F1 读用户环境强制 UTF-8 + 未展开原值',
      (s2) => /\[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8/.test(s2)
        && /DoNotExpandEnvironmentNames/.test(s2)],
    ['ipc/env-manager.js', 'F2 按注册表原类型写回（不再用 .NET API）',
      (s2) => /-Type ExpandString/.test(s2) && !/\[Environment\]::SetEnvironmentVariable\(/.test(s2)],
    ['ipc/env-manager.js', 'F3 串行锁 + 同运行时安装互斥',
      (s2) => /withEnvLock/.test(s2) && /installing\.has\(id\)/.test(s2)],
    ['ipc/env-manager.js', 'F4 缓存先校验 SHA，不符重下',
      (s2) => /useCache && \(await sha256File\(archive\)\) !== rt\.sha256/.test(s2)],
    ['ipc/env-manager.js', 'F5 残留清扫 + 安装包清理通道',
      (s2) => /sweepEnvRoot/.test(s2) && /CH\.ENV\.CLEAN/.test(s2)],
    ['ipc/env-manager.js', 'F6 探测并行 + 终端走临时 .cmd',
      (s2) => /Promise\.all\(\[detectPython\(\), detectNode\(\), detectJava\(\), detectGcc\(\)\]\)/.test(s2)
        && /\.term-/.test(s2)],
    ['lib/channels.js', 'F7 通道常量 196',
      (s2) => /TOTAL: 196/.test(s2) && /MIGRATED: 196/.test(s2) && /CLEAN: 'env:clean'/.test(s2)],
    ['js/tools/i18n.js', 'F8 开发环境正文已双语（env 域）',
      (s2) => /env: \{/.test(s2) && /安装后加入当前用户环境（推荐）/.test(s2)],
    ['js/tools/env-manager.js', 'F9 工具页标记 i18n 且走 T()',
      (s2) => /i18n: true/.test(s2) && /TT\('env', zh, vars\)/.test(s2)],
    ['main.js', 'F10 跨卷目录搬运走递归复制',
      (s2) => /st\.isDirectory\(\)/.test(s2) && /fsp\.cp\(src, dst, \{ recursive: true, force: true \}\)/.test(s2)],
  ],
  /* v0.9.1：第六～十一轮审查修复。 */
  '0.9.1': [
    ['lib/power-gate.js', 'G1 Get-Command 间接执行判据',
      (s2) => /get-command\|gcm/.test(s2) && s2.indexOf('[&.]') !== -1],
    ['main.js', 'G2 restore-delete 模式白名单（无 fail-open）',
      (s2) => /mode === 'all' \? '\/all' : null/.test(s2)
        && !/mode === 'oldest' \? '\/oldest' : '\/all'/.test(s2)],
    ['lib/temp-names.js', 'G3 重命名暂存名进白名单',
      (s2) => /RENAME_TMP/.test(s2) && /\\\.hehe-ren-\\d\{10,\}/.test(s2)],
    ['js/tools/file-tools.js', 'G4 崩溃恢复登记 + 一键恢复',
      (s2) => /renameStaged/.test(s2) && /上次重命名未完成/.test(s2)],
    ['lib/path-guard.js', 'G5 新建目录记录（EEXIST 不算）',
      (s2) => /ensureDirectoryInsideTracked/.test(s2) && /freshlyMade/.test(s2)],
    ['ipc/fs-ops.js', 'G6 ZIP 回滚由深到浅 rmdir',
      (s2) => /createdDirs\.length - 1/.test(s2) && /rmdir\(createdDirs\[i\]\)/.test(s2)],
    ['css/app.css', 'G7 btn-danger hover 跟随主题',
      (s2) => /\.btn-danger:hover:not\(:disabled\) \{ background: var\(--danger\);/.test(s2)],
    ['js/app.js', 'G8 设置页开发环境门禁说明',
      (s2) => /danger\.envNote/.test(s2)],
  ],
  /* v0.9.2 + v0.9.3：safe-name 抽离与第十二轮审查修复。 */
  '0.9.2': [
    ['lib/safe-name.js', 'H1 safe-name 纯函数模块存在',
      (s2) => /fromUrl/.test(s2) && /fromTitle/.test(s2)],
    ['js/tools/net-tools.js', 'H2 渲染层接 window.SafeName',
      (s2) => /SafeName && window\.SafeName\.fromUrl/.test(s2)],
    ['lib/safe-name.js', 'H3 隐藏文件名保留前导点（只剥纯点）',
      (s2) => /\^\\\.\+\$/.test(s2) && !/replace\(\^\\\.\+\(/.test(s2)],
  ],
  '0.9.3': [
    ['js/tools/dev.js', 'J1 http-client send 接 ui.guard',
      (s2) => /const send = window\.ui\.guard\(async/.test(s2)],
    ['js/tools/office.js', 'J2 七处长任务接防重入',
      (s2) => (s2.match(/guard\(async|window\.ui\.guard\(/g) || []).length >= 7],
    ['lib/hw-encode.js', 'J3 cqFor 回退对齐界面默认 crf23',
      (s2) => /CQ_FALLBACK_CRF = 23/.test(s2)],
    ['lib/lan-scan.js', 'J4 mergeDevices 始终列出本机',
      (s2) => /source: 'self'/.test(s2) && /isSelf: true/.test(s2)],
    ['js/tools/lan-scan.js', 'J5 渲染层「本机」标签',
      (s2) => /'self': '本机'/.test(s2)],
    ['js/tools/env-manager.js', 'J6 环境检测失败如实报错（不再伪装成没有已装环境）',
      (s2) => /检测本机环境失败/.test(s2)],
  ],
};

const CHECKS = CHECKS_BY_VERSION[version];
if (!CHECKS) {
  console.log('没有为版本 ' + version + ' 定义检查项。已定义：' + Object.keys(CHECKS_BY_VERSION).join(', '));
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hehe-verify-'));
try {
  execFileSync(Z7, ['e', ZIP, '-o' + tmp, '-r', 'app.asar', '-y'], { stdio: 'pipe' });
  const asarPath = path.join(tmp, 'app.asar');
  if (!fs.existsSync(asarPath)) {
    console.log('zip 里没找到 app.asar');
    process.exit(1);
  }
  console.log('产物：hehe-toolbox-' + version + '-win-x64.zip');
  console.log('已解出 app.asar: ' + (fs.statSync(asarPath).size / 1048576).toFixed(1) + ' MB\n');

  const asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));

  /* asar 内路径是「反斜杠分隔、无前导分隔符」形式（js\tools\x.js）。
   * 三种拼法都试，避免因分隔符差异误报"读不到"。 */
  function readFromAsar(rel) {
    for (const p of [rel, rel.split('/').join('\\'), rel.replace(/^[\\/]+/, '').split('/').join('\\')]) {
      try { return asar.extractFile(asarPath, p).toString('utf8'); } catch (e) { /* 换下一种 */ }
    }
    return null;
  }

  let pass = 0, fail = 0, skip = 0;
  for (const [rel, label, test] of CHECKS) {
    const src = readFromAsar(rel);
    if (src == null) { console.log('SKIP  ' + rel + '  ' + label + '（产物里读不到该文件）'); skip++; continue; }
    const ok = test(src);
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + rel.padEnd(26) + label);
  }
  console.log('\n产物校验: ' + pass + ' 通过 / ' + fail + ' 失败' + (skip ? ' / ' + skip + ' 跳过' : ''));
  process.exit(fail ? 1 : 0);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响判定 */ }
}
