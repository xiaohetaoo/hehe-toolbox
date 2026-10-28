const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const os = require('os');
const asarLib = require('@electron/asar');

const BS = String.fromCharCode(92);
const distDir = path.join(__dirname, '..', 'dist');
const zips = fs.readdirSync(distDir).filter((n) => /^hehe-toolbox-.*-win-x64\.zip$/.test(n));
if (!zips.length) { console.log('dist 里没有 zip 产物'); process.exit(1); }
if (zips.length > 1) { console.log('dist 里有多个 zip，请先清理：' + zips.join(', ')); process.exit(1); }
const zipPath = path.join(distDir, zips[0]);
console.log('校验对象:', zips[0]);
const z = new AdmZip(zipPath);
const ent = z.getEntries().find((e) => /resources.app\.asar$/.test(e.entryName));
if (!ent) { console.log('asar 未找到'); process.exit(1); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar3-'));
const asarPath = path.join(tmp, 'app.asar');
fs.writeFileSync(asarPath, ent.getData());

const files = asarLib.listPackage(asarPath);
function read(rel) {
  // asar 的 listPackage 返回反斜杠路径，extractFile 需要匹配同样的形态
  const cands = [rel, BS + rel, rel.replace(/\//g, BS), BS + rel.replace(/\//g, BS)];
  for (const c of cands) {
    try { return asarLib.extractFile(asarPath, c).toString('utf8'); } catch (e) {}
  }
  return null;
}

let fail = 0;
const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const snip = read('snip.html');
chk(!!snip, 'snip.html 可读');
if (snip) {
  const blocks = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(snip))) blocks.push([m.index, m.index + m[0].length]);
  const fnPos = snip.indexOf('function accentPrimary(');
  chk(blocks.some(([s, e]) => fnPos >= s && fnPos < e), '打包后 accentPrimary 位于 script 块内');
  chk(!/<\/script>\s*\n\s*(function|const|let|var)/.test(snip), '打包后没有游离 JS');
}

const tst = read('js/tools/target-size.js');
chk(!!tst, 'js/tools/target-size.js 可读');
if (tst) chk(tst.includes('finalPath = cand'), '打包后含 rename 失败回退实际路径的修复');

const main = read('main.js');
chk(!!main, 'main.js 可读');
if (main) {
  chk(main.includes('HKEY_CURRENT_USER'), '打包后注册表用全称键名');
  chk(main.includes('InprocServer32'), '打包后用 InprocServer32');
  chk(!/(^|\n)\s*'[^']*InnoServerSetup/.test(main), '打包后不再写 InnoServerSetup');
  chk(main.includes('storeLoadFailed'), '打包后含 store 损坏保护');
  chk(main.includes('normSchedule'), '打包后含调度参数校验');
  chk(main.includes('Where-Object { $_.Path -eq $target }'), '打包后回滚脚本按路径停进程');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
