'use strict';
/* 拼音首字母搜索的行为测试。
 *
 * ============ 为什么必须真跑 ============
 * 这套实现依赖 Intl.Collator('zh-CN') 的拼音排序 —— 那是 **ICU 数据**，
 * Node 与 Electron 的版本可能不同。只在 Node 里测过就上线的话，
 * 可能出现「本地全绿、打包后拼音搜索全乱」的情况。
 * 所以核心用例都在真 Electron 渲染进程里跑。
 *
 * ============ 这一组锁的是什么 ============
 * 1) 汉字 → 首字母的映射正确（锚点表选错一个字，整个字母段就错位）
 * 2) 搜索能通过拼音命中工具（yssc → 压缩）
 * 3) **拼音是补充通道，不能压过精确匹配**（打 "zip" 时 JSON 格式化
 *    不该排在 7z 压缩 前面 —— 这个排序问题很难靠肉眼发现）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const py = require('../lib/pinyin');

/* ---------------- 纯函数部分（Node 内即可） ---------------- */
let fail = 0;
const chk = (ok, msg, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + msg + (ok || detail == null ? '' : '  -> ' + detail));
  if (!ok) fail++;
};

chk(typeof py.toInitialKey === 'function', '模块导出 toInitialKey');

/* 锚点正确性：每个字母的锚点必须真的落在该字母段。
 * 用「锚点 ≤ 该段内的字」来验，这是实现本身的判据。 */
const SEGMENT_SAMPLES = {
  a: '阿啊', b: '八巴', c: '擦才', d: '大第', e: '俄额',
  f: '发法', g: '个该', h: '哈还', j: '机几', k: '卡开',
  l: '拉来', m: '妈马', n: '拿那', o: '哦噢', p: '怕拍',
  q: '七起', r: '然让', s: '三色', t: '他特', w: '挖外',
  x: '西下', y: '压一', z: '匝在'
};
for (const [letter, samples] of Object.entries(SEGMENT_SAMPLES)) {
  const wrong = [];
  for (const ch of samples) {
    const got = py.initialOf(ch);
    if (got !== letter) wrong.push(ch + '→' + got);
  }
  // 锁的是：锚点表本身要正确。选错一个字会让整个字母段错位（踩过：昔 vs 夕）。
  chk(wrong.length === 0, '字母段 ' + letter + ' 的判定正确', wrong.join(','));
}

/* 真实工具名 */
const CASES = [
  ['压缩图片', 'ystp'], ['图片压缩', 'tpys'], ['网速测试', 'wscs'],
  ['哈希校验', 'hxxy'], ['屏幕录制', 'pmlz'], ['文本朗读', 'wbld'],
  ['剪贴板历史', 'jtbls'], ['密码生成器', 'mmscq']
];
for (const [cn, want] of CASES) {
  const got = py.toInitialKey(cn);
  // 锁的是：真实工具名的首字母串。这是搜索能否命中的前提。
  chk(got === want, '「' + cn + '」→ ' + want, got);
}

/* 非汉字保留 */
chk(py.toInitialKey('zip 压缩') === 'zipys', '非汉字原样保留（zip 压缩 → zipys）', py.toInitialKey('zip 压缩'));

/* 多音字行为是确定的（写死在文档里，改了要同步） */
chk(py.initialOf('重') === 'z', '多音字「重」按 collation 默认读音走 z', py.initialOf('重'));

/* ---------------- 真 Electron 部分 ---------------- */
if (!fs.existsSync(ELECTRON_EXE)) {
  console.log('SKIP  无 electron.exe，跳过渲染层验证');
  console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  process.exit(fail === 0 ? 0 : 1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinyin-'));

fs.writeFileSync(path.join(tmp, 'probe.js'), `
module.exports = {
  'store:get': (e,k,d) => ({ ok:true, data:d }),
  'store:set': () => ({ ok:true, data:true }),
  'store:health': () => ({ ok:true, data:{ ok:true } }),
  'app:get-autostart': () => ({ ok:true, data:false }),
  'app:set-lang': () => ({ ok:true, data:true }),
  'app:set-accent': () => ({ ok:true, data:true }),
  'dangerous:list': () => ({ ok:true, data:{} }),
  'dangerous:tool-caps': () => ({ ok:true, data:{} }),
  'update:cleanup': () => ({ ok:true, data:0 }),
  'sys:stats': () => ({ ok:true, data:{cpu:0,mem:0} }),
  'app:get-info': () => ({ ok:true, data:{appVersion:'0.4.0',electron:'43',chrome:'140',node:'22',
    v8:'14',username:'u',hostname:'h',userData:'/tmp',platform:'win32',isDev:false} }),
  'app:crash-info': () => ({ ok:true, data:{lastSessionCrashed:false,dir:'/x',count:0,totalBytes:0,latest:null} })
};
`, 'utf8');

fs.writeFileSync(path.join(tmp, 'runner.js'), `
process.on('unhandledRejection', () => {});
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'), fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const PROBE_FILE = ${JSON.stringify(path.join(tmp, 'probe.js'))};
const OUT = ${JSON.stringify(path.join(tmp, 'out.json'))};

app.whenReady().then(async () => {
 try {
  const H = require(PROBE_FILE);
  for (const k of Object.keys(H)) ipcMain.handle(k, H[k]);
  const w = new BrowserWindow({ width: 1200, height: 800, show: false, useContentSize: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await w.loadFile(path.join(ROOT, 'index.html'));
  await new Promise(r => setTimeout(r, 1800));
  const r = await w.webContents.executeJavaScript(\`(function(){
    var out = { checks: [] };
    var chk = function(ok, msg, detail){ out.checks.push({ok:!!ok, msg:msg, detail: detail==null?null:String(detail)}); };
    var R = window.Registry;

    // 1) window.Pinyin 可用（脚本引入成功）
    chk(!!window.Pinyin, 'window.Pinyin 已挂载');
    chk(window.Pinyin && window.Pinyin.toInitialKey('压缩') === 'ys', '渲染层内 压缩→ys',
        window.Pinyin ? window.Pinyin.toInitialKey('压缩') : 'n/a');

    // 2) ICU 拼音排序可用
    chk(new Intl.Collator('zh-CN').compare('阿','八') < 0, 'ICU zh-CN 拼音排序可用');

    // 3) 真实搜索：打拼音能命中
    var cases = [['ys','压缩'],['hash','哈希'],['jt','截图']];
    for (var i=0;i<cases.length;i++){
      var q = cases[i][0], want = cases[i][1];
      var res = R.search(q).map(function(t){return t.name;});
      var hit = res.some(function(n){return n.indexOf(want)>=0;});
      chk(hit, '搜索「'+q+'」能命中「'+want+'」', res.slice(0,4).join(' | '));
    }

    // 4) 【关键】拼音不能压过精确匹配
    //    打 "zip" 时，7z 压缩（关键词含 zip）应排前
    var zip = R.search('zip').map(function(t){return t.id;});
    chk(zip.length > 0, '搜索「zip」有结果');
    chk(zip[0] === 'archive-7z' || zip[0] === 'zip-tool', '「zip」首位是压缩相关工具',
        zip.slice(0,3).join(','));

    /* 5) 【关键】单个字母**不经过拼音通道**。
     * 原先这里断言「单字母命中数 <= 5」，实测 37 ——但那 37 个是
     * **原有逻辑**命中的（22 个工具的 keywords 含字母 a，例如 "aes"、
     * "array"；desc 里也有），与拼音无关。
     * 断言写错方向：真正要锁的不是"命中少"，而是"拼音通道对单字母不生效"。
     * 所以改成：对比「开拼音」与「关拼音」的命中集合，两者必须相同。 */
    var withPy = R.search('a').map(function(t){return t.id;});
    // 临时把 window.Pinyin 摘掉，模拟"没有拼音"的情况
    var savedPy = window.Pinyin;
    window.Pinyin = null;
    var withoutPy = R.search('a').map(function(t){return t.id;});
    window.Pinyin = savedPy;
    chk(JSON.stringify(withPy) === JSON.stringify(withoutPy),
        '单字母不经过拼音通道（开关拼音后结果一致）',
        'on='+withPy.length+' off='+withoutPy.length);

    // 6) 汉字搜索仍然正常（拼音没破坏原逻辑）
    var cn = R.search('压缩').map(function(t){return t.name;});
    chk(cn.length > 0, '中文搜索仍然正常', cn.slice(0,2).join(' | '));

    return JSON.stringify(out);
  })()\`, true);
  fs.writeFileSync(OUT, r, 'utf8');
  console.log('PY_DONE');
 } catch (e) { console.log('FATAL ' + (e && e.stack || e)); }
  setTimeout(() => app.exit(0), 200);
});
`, 'utf8');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.HEHE_NOSPLASH = '1';

let raw = '';
try {
  raw = execFileSync(ELECTRON_EXE, [path.join(tmp, 'runner.js')], { env, encoding: 'utf8', timeout: 180000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

try {
  const out = JSON.parse(fs.readFileSync(path.join(tmp, 'out.json'), 'utf8'));
  for (const c of out.checks) {
    console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.msg + (c.ok || c.detail == null ? '' : '  -> ' + c.detail));
    if (!c.ok) fail++;
  }
} catch (e) {
  console.log('没拿到渲染层结果');
  console.log(raw.split(/\r?\n/).filter((l) => !/ERROR:net|WSALookup/.test(l)).join('\n').slice(-1000));
  fail++;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
