'use strict';
/* 安装版（NSIS）产物命名守卫。
 *
 * 【为什么需要这个脚本】
 *   electron-builder 默认给 NSIS 产物用 `productName`（这里是中文「核核工具箱」），
 *   但生成的 `latest.yml` 里写的却是 ASCII 名：
 *
 *     实际文件：核核工具箱 Setup 0.1.5.exe
 *     latest.yml：url: hehe-toolbox-setup-0.1.5.exe   ← 对不上
 *
 *   electron-updater 是照 latest.yml 去下载的，于是会去拉一个不存在的文件；
 *   而 GitHub Release 对中文资产名还会做剥离，链接直接 404。
 *   两个坑叠在一起，安装版的自动更新**从来没有真正能用过**。
 *
 * 本脚本做两件事：
 *   1. 校验 package.json 里 nsis.artifactName 明确是 ASCII（不依赖 productName）；
 *   2. 构建后（如果产物已存在）校验磁盘上的文件名与 latest.yml 中的 url 完全一致。
 *
 * 用法：
 *   node scripts/check-installer-name.js            # 只做静态校验
 *   node scripts/check-installer-name.js <输出目录>  # 静态 + 产物一致性校验
 */
const fs = require('fs');
const path = require('path');

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

/* ---- 1. artifactName 必须是 ASCII 且带版本占位符 ---- */
const nsisName = pkg.build && pkg.build.nsis && pkg.build.nsis.artifactName;
chk(!!nsisName, 'package.json 配置了 build.nsis.artifactName');
if (nsisName) {
  chk(/^[\x20-\x7E]+$/.test(nsisName), 'artifactName 全为 ASCII：' + nsisName);
  chk(nsisName.includes('${version}'), 'artifactName 含 ${version}（避免多版本互相覆盖）');
  const expanded = nsisName.replace('${version}', pkg.version);
  chk(/^[\x20-\x7E]+$/.test(expanded), '展开后仍为 ASCII：' + expanded);
  chk(/\.exe$/.test(expanded), '展开后是 .exe');
}

/* ---- 2. portable 也要是 ASCII（既有的红线规矩） ---- */
const portableName = pkg.build && pkg.build.portable && pkg.build.portable.artifactName;
chk(!!portableName && /^[\x20-\x7E]+$/.test(portableName.replace('${version}', pkg.version)),
  'portable artifactName 为 ASCII：' + portableName);

/* ---- 3. 产物存在时，核对 latest.yml 里的 url 与磁盘文件名一致 ---- */
const outDir = process.argv[2];
if (outDir) {
  const latest = path.join(outDir, 'latest.yml');
  if (fs.existsSync(latest)) {
    const yml = fs.readFileSync(latest, 'utf8');
    const m = yml.match(/^\s*-\s*url:\s*(.+)$/m) || yml.match(/^path:\s*(.+)$/m);
    const urlName = m ? m[1].trim() : null;
    chk(!!urlName, 'latest.yml 里能解析出文件名');
    if (urlName) {
      const actual = fs.readdirSync(outDir).filter(n => /\.exe$/i.test(n) && !/blockmap/i.test(n));
      chk(actual.includes(urlName),
        'latest.yml 记录的文件名与磁盘一致（记录=' + urlName + '，实际=' + actual.join(',') + '）');
      chk(/^[\x20-\x7E]+$/.test(urlName), 'latest.yml 里的文件名是 ASCII（GitHub 才不会剥离）');
    }
  } else {
    console.log('SKIP  未找到 latest.yml（可能还没构建安装版）');
  }
}

console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
