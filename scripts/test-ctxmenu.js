/* 真机验证 Win11 经典右键菜单的实现逻辑（独立于 Electron，直接复刻 main.js 的调用）。
 * 会临时改注册表，结束时恢复原状态。
 */
const { execFile } = require('child_process');

const KEY = 'HKEY_CURRENT_USER\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}';
const HANDLER = KEY + '\\InprocServer32';

function run(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout, stderr });
    });
  });
}
function decode(buf) {
  // reg.exe 按系统 ANSI 输出；中文 Windows 下按 GBK 解
  try { return new TextDecoder('gbk').decode(buf || Buffer.alloc(0)); }
  catch (e) { return (buf || Buffer.alloc(0)).toString('latin1'); }
}
async function state() {
  const r = await run(['query', HANDLER, '/ve']);
  if (r.code !== 0) return { on: false, why: '子键不存在（' + decode(r.stderr).trim() + '）' };
  const line = decode(r.stdout).split(/\r?\n/).find(l => /REG_SZ/i.test(l));
  if (!line) return { on: false, why: '没有默认值' };
  const val = line.replace(/.*REG_SZ\s*/i, '').trim();
  return { on: val === '', val, why: '默认值=' + JSON.stringify(val) };
}

(async () => {
  let fail = 0;
  const chk = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

  const before = await state();
  console.log('初始状态:', JSON.stringify(before));

  // ---- 开启（经典菜单）----
  const add = await run(['add', HANDLER, '/ve', '/t', 'REG_SZ', '/d', '', '/f']);
  chk(add.code === 0, 'reg add 建 InprocServer32 且默认值置空（code=' + add.code + '）');
  const afterOn = await state();
  chk(afterOn.on === true, '开启后状态检测判为经典菜单 —— ' + afterOn.why);

  // ---- 关闭（恢复 Win11）----
  const del = await run(['delete', HANDLER, '/f']);
  chk(del.code === 0, 'reg delete 删除处理器子键（code=' + del.code + '）');
  const afterOff = await state();
  chk(afterOff.on === false, '关闭后状态检测判为 Win11 菜单 —— ' + afterOff.why);

  // 父键（系统自带的 CLSID）必须还在：不能把系统的 CLSID 一起删了
  const parent = await run(['query', KEY]);
  chk(parent.code === 0, '系统原始 CLSID 父键未被删除');

  // ---- 还原到初始状态 ----
  if (before.on) await run(['add', HANDLER, '/ve', '/t', 'REG_SZ', '/d', '', '/f']);
  else await run(['delete', HANDLER, '/f']);
  const restored = await state();
  chk(restored.on === before.on, `已还原初始状态（${before.on} -> ${restored.on}）`);

  console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  process.exit(fail === 0 ? 0 : 1);
})();
