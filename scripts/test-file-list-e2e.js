/* 端到端验证「待处理文件列表」这个新组件的行为。
 *
 * 【为什么必须用真 Electron】
 * 这个组件几乎全是 DOM 操作：行渲染、删除按钮、去重、锁定、调序。
 * 只做静态断言（"文件里有没有 fileList 这个词"）测不出
 * 「点了 × 后那一行还在不在」「同一文件拖两次会不会出现两行」这类问题，
 * 而这些恰恰是用户唯一能感知的部分。
 *
 * 做法：在隐藏的 BrowserWindow 里加载真实 index.html，拿到真实的
 * fileList / filePicker 实例，用脚本驱动，再把可结构化克隆的结果回传。
 * 该窗口不启动主进程业务，所以要在 runner 里补一个 fs:stat 的 IPC 桩，
 * 让体积列能真的拿到字节数（否则测不出「体积是否回填」）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filelist-e2e-'));

const { makeWhiteImage } = require('./e2e-helpers');
const files = {
  a: path.join(tmp, 'a.jpg'),
  b: path.join(tmp, 'b.png'),
  c: path.join(tmp, 'c.txt')
};
makeWhiteImage(files.a, 120, 80);
makeWhiteImage(files.b, 90, 60);
fs.writeFileSync(files.c, 'hello world', 'utf8');

const PROBE = `
(async () => {
  const out = { steps: [] };
  const log = (name, data) => out.steps.push(Object.assign({ name }, data));
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const rows = (root) => [...root.querySelectorAll('.fl-row')];
  const paths = (root) => rows(root).map((r) => r.dataset.path);

  const FL = window.ui && window.ui.fileList;
  const PICK = window.ui && window.ui.filePicker;
  if (typeof FL !== 'function') return { fatal: 'window.ui.fileList 不存在' };
  if (typeof PICK !== 'function') return { fatal: 'window.ui.filePicker 不存在' };

  const host = document.createElement('div');
  document.body.appendChild(host);
  const F = window.__FILES;

  /* ---------- 1. 加入 / 体积回填 / 计数 ---------- */
  let changes = 0;
  const fl = FL({ onChange: () => changes++ });
  host.appendChild(fl.el);
  const r1 = fl.add([F.a, F.b, F.c]);
  await tick(80);
  log('add3', { added: r1.added, dup: r1.dup, count: fl.count, rowCount: rows(fl.el).length });
  const sizeTexts = [...fl.el.querySelectorAll('.fl-size')].map((e) => e.textContent.trim());
  log('sizes', { texts: sizeTexts, allFilled: sizeTexts.every((t) => t && t !== '…') });
  log('head', { text: (fl.el.querySelector('.fl-count') || {}).textContent || '' });

  /* ---------- 2. 去重 ---------- */
  const r2 = fl.add([F.a, F.a]);
  await tick(20);
  log('dedupe', { added: r2.added, dup: r2.dup, count: fl.count, rowCount: rows(fl.el).length });
  const r2b = fl.add([F.a.replace(/a\\.jpg$/, 'A.JPG')]);
  log('dedupe-case', { added: r2b.added, dup: r2b.dup, count: fl.count });

  /* ---------- 3. 点 × 删掉对应那一行 ---------- */
  const beforePaths = paths(fl.el);
  const idx = beforePaths.indexOf(F.b);
  // 按索引取按钮：列表顺序 = beforePaths 顺序
  const btns = [...fl.el.querySelectorAll('.fl-del')];
  if (idx < 0) return { fatal: 'b.png 不在列表里，无法定位删除按钮' };
  btns[idx].click();
  await tick(50);
  log('remove', {
    before: beforePaths.length, after: fl.count,
    removedB: beforePaths.includes(F.b) && !paths(fl.el).includes(F.b),
    indexUsed: idx
  });

  /* ---------- 4. 清空 ---------- */
  const clr = fl.el.querySelector('.fl-head button');
  if (clr) clr.click();
  await tick(30);
  log('clear', { count: fl.count, rowCount: rows(fl.el).length, emptyShown: fl.el.querySelector('.fl-empty').style.display === '' });

  log('onchange', { changes });

  /* ---------- 5. 锁定 ---------- */
  fl.add([F.a, F.b]);
  fl.setLocked(true);
  await tick(50);
  const lb = fl.el.querySelectorAll('.fl-del')[0];
  log('locked', { disabled: !!lb.disabled, count: fl.count });
  lb.click();
  await tick(50);
  log('locked-click', { count: fl.count, stillTwo: fl.count === 2 });
  fl.setLocked(false);

  /* ---------- 6. move（顺序类工具刚需） ---------- */
  const flPaths = () => fl.items.map((x) => x.path);
  const orderBefore = flPaths();
  fl.move(0, 1);
  log('move', { swapped: flPaths()[0] === orderBefore[1] && flPaths()[1] === orderBefore[0], count: flPaths().length });
  fl.move(0, -1);
  log('move-oob', { ok: flPaths().length === 2 });

  /* ---------- 7. beforeRemove 拦截 ---------- */
  fl.clear();
  let blocked = 0;
  const fl2 = FL({ beforeRemove: () => { blocked++; return false; } });
  host.appendChild(fl2.el);
  fl2.add([F.a]);
  await tick(50);
  fl2.el.querySelector('.fl-del').click();
  await tick(50);
  log('beforeRemove', { count: fl2.count, blocked, kept: fl2.count === 1 });

  /* ---------- 8. beforeRemove 异步拦截 ---------- */
  const fl3 = FL({ beforeRemove: async () => { await tick(10); return false; } });
  host.appendChild(fl3.el);
  fl3.add([F.a]);
  await tick(50);
  fl3.el.querySelector('.fl-del').click();
  await tick(80);
  log('beforeRemove-async', { count: fl3.count });

  /* ---------- 9. move 后行号与内容一致（防止渲染与数据错位） ---------- */
  const fl4 = FL({});
  host.appendChild(fl4.el);
  fl4.add([F.a, F.b, F.c]);
  await tick(60);
  fl4.move(2, -1); // c 上移到第二位
  await tick(20);
  const idxTexts = rows(fl4.el).map((r) => (r.querySelector('.fl-idx') || {}).textContent);
  const nameTexts = rows(fl4.el).map((r) => (r.querySelector('.fl-name') || {}).textContent);
  log('renumber', { idxTexts, nameTexts, cIsSecond: nameTexts[1] === 'c.txt' });

  /* ---------- 10. picker：空/满两种形态 ---------- */
  const picker = PICK({ text: '空列表提示', textMore: '继续添加' });
  host.appendChild(picker.el);
  log('picker-empty', { compact: picker.dz.classList.contains('compact'), main: picker.dz.querySelector('.dz-main').textContent });
  picker.add([F.a, F.b]);
  await tick(60);
  log('picker-filled', {
    compact: picker.dz.classList.contains('compact'),
    main: picker.dz.querySelector('.dz-main').textContent,
    count: picker.count
  });

  /* ---------- 10b. rowStart/rowEnd 插槽不能吃掉默认文件名 ---------- */
  const slot = FL({
    rowStart: (it, i, row) => { row.appendChild(h('span', { class: 'slot-start' }, 'S')); },
    rowEnd: (it, i, row) => { row.appendChild(h('span', { class: 'slot-end' }, 'E')); }
  });
  host.appendChild(slot.el);
  slot.add([F.a]);
  await tick(50);
  log('slots', {
    hasName: !!slot.el.querySelector('.fl-name'),
    nameText: (slot.el.querySelector('.fl-name') || {}).textContent,
    hasSize: !!slot.el.querySelector('.fl-size'),
    hasStart: !!slot.el.querySelector('.slot-start'),
    hasEnd: !!slot.el.querySelector('.slot-end'),
    hasDel: !!slot.el.querySelector('.fl-del')
  });
  slot.el.remove();

  /* ---------- 10c. 长路径只显示末尾两级（完整路径在 title 里） ---------- */
  const deep = FL({});
  host.appendChild(deep.el);
  deep.add(['C:/Users/someone/AppData/Local/Temp/sub/verylong/deep/file.txt']);
  await tick(40);
  const pathEl = deep.el.querySelector('.fl-path');
  log('shortpath', {
    text: pathEl ? pathEl.textContent : '(无)',
    title: pathEl ? pathEl.getAttribute('title') : '(无)',
    shortened: !!pathEl && pathEl.textContent.startsWith('…'),
    titleIsFull: !!pathEl && pathEl.getAttribute('title').includes('verylong')
  });
  deep.el.remove();

  /* ---------- 11. single 模式：新文件顶替旧的 ---------- */
  const single = FL({ single: true });
  host.appendChild(single.el);
  single.add([F.a]);
  await tick(40);
  single.add([F.b]);
  await tick(40);
  log('single', { count: single.count, pathIsB: single.items.length === 1 && single.items[0].path === F.b });

  /* ---------- 12. 虚拟条目（剪贴板）不 stat、显示「剪贴板」 ---------- */
  const virt = FL({});
  host.appendChild(virt.el);
  virt.add([{ path: '剪贴板图片', name: '剪贴板图片', virtual: true }]);
  await tick(40);
  log('virtual', { count: virt.count, sizeText: (virt.el.querySelector('.fl-size') || {}).textContent });

  host.remove();
  return out;
})()
`;

const runner = [
  "const { app, BrowserWindow, ipcMain } = require('electron');",
  "const path = require('path');",
  "const fs = require('fs');",
  'const ROOT = ' + JSON.stringify(ROOT) + ';',
  'const FILES = ' + JSON.stringify(files) + ';',
  'const PROBE = ' + JSON.stringify(PROBE) + ';',
  'app.whenReady().then(async () => {',
  "  // 这个窗口不跑主进程业务，只补 fileList 需要的 IPC（体积回填）",
  "  ipcMain.handle('store:get', (e, k, d) => ({ ok: true, data: d }));",
  "  ipcMain.handle('fs:stat', async (e, p) => {",
  '    const st = fs.statSync(p);',
  '    return { ok: true, data: { size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() } };',
  '  });',
  "  const w = new BrowserWindow({ width: 900, height: 700, show: false,",
  "    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });",
  "  await w.loadFile(path.join(ROOT, 'index.html'));",
  '  await new Promise(r => setTimeout(r, 1500));',
  '  await w.webContents.executeJavaScript("window.__FILES = " + JSON.stringify(FILES) + "; true").catch(() => {});',
  '  let res;',
  '  try { res = await w.webContents.executeJavaScript(PROBE, true); }',
  "  catch (e) { res = { fatal: String(e && e.message || e) }; }",
  "  console.log('FL_RESULT ' + JSON.stringify(res));",
  '  app.exit(0);',
  '});'
].join('\n');

const scriptPath = path.join(tmp, 'run.js');
fs.writeFileSync(scriptPath, runner, 'utf8');

const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON_EXE)) {
  console.log('SKIP 未找到 electron.exe（先 npm install + install.js）');
  process.exit(0);
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.HEHE_TEST_DATA = path.join(tmp, 'ud');
env.HEHE_NOSPLASH = '1';

let raw = '';
try {
  raw = execFileSync(ELECTRON_EXE, [scriptPath], { env, encoding: 'utf8', timeout: 180000 });
} catch (e) { raw = String(e.stdout || '') + String(e.stderr || ''); }

const line = String(raw || '').split(/\r?\n/).find((l) => l.startsWith('FL_RESULT'));
if (!line) { console.log('未拿到 FL_RESULT'); console.log(raw.slice(-3000)); process.exit(1); }

const R = JSON.parse(line.slice('FL_RESULT '.length));
let fail = 0;
const chk = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) fail++; };

if (R.fatal) { console.log('FAIL  ' + R.fatal); fail++; }
else if (!R.steps) { console.log('FAIL 无 steps, raw: ' + JSON.stringify(R).slice(0,500)); fail++; }
else {
  const by = {};
  for (const s of R.steps) by[s.name] = s;

  chk(by.add3 && by.add3.added === 3 && by.add3.count === 3 && by.add3.rowCount === 3,
      '三个文件渲染成三行');
  chk(by.sizes && by.sizes.allFilled,
      '每行都回填了真实体积: ' + JSON.stringify(by.sizes && by.sizes.texts));
  chk(by.head && /共 3 项/.test(by.head.text), '计数行显示「共 N 项」: ' + (by.head && by.head.text));
  chk(by.dedupe && by.dedupe.added === 0 && by.dedupe.dup === 2 && by.dedupe.rowCount === 3,
      '同一路径重复加入被去重，行数不变');
  chk(by['dedupe-case'] && by['dedupe-case'].added === 0 && by['dedupe-case'].dup === 1,
      '大小写不同但指向同一文件也判重');
  chk(by.remove && by.remove.removedB && by.remove.after === 2,
      '点 × 删掉的是对应那一行，其余保留');
  chk(by.clear && by.clear.count === 0 && by.clear.rowCount === 0 && by.clear.emptyShown,
      '清空后无行且显示空状态');
  // 去重不算变化（没有条目增减），所以：add3(1) + remove(1) + clear(1) + 后面 add(1) = 4
  // 加 3 个(1) + 删 1 个(1) + 清空(1) = 3；两次重复加入都被去重，不触发变化（正确行为）
  chk(by.onchange && by.onchange.changes === 3, 'onChange 在三类变化上各触发一次（实际 ' + (by.onchange && by.onchange.changes) + ' 次）');
  chk(by.locked && by.locked.disabled, '锁定后 × 按钮 disabled');
  chk(by['locked-click'] && by['locked-click'].stillTwo, '锁定下点 × 不会误删');
  chk(by.move && by.move.swapped, 'move(0,1) 交换前两项');
  chk(by['move-oob'] && by['move-oob'].ok, '越界 move 不崩不丢项');
  chk(by.beforeRemove && by.beforeRemove.blocked === 1 && by.beforeRemove.kept,
      'beforeRemove 返回 false → 删除被拦');
  chk(by['beforeRemove-async'] && by['beforeRemove-async'].count === 1, 'beforeRemove 异步返回 false 也拦得住');
  chk(by.renumber && by.renumber.cIsSecond && by.renumber.idxTexts.join(',') === '1,2,3',
      '调序后行号重排且与内容一致: ' + JSON.stringify(by.renumber));
  chk(by['picker-empty'] && !by['picker-empty'].compact && by['picker-empty'].main.includes('空列表提示'),
      '空列表时拖拽区完整、文案为初始文案');
  chk(by['picker-filled'] && by['picker-filled'].compact && by['picker-filled'].main.includes('继续添加'),
      '有内容后拖拽区收窄并改文案');
  chk(by.slots && by.slots.hasName && by.slots.nameText === 'a.jpg' && by.slots.hasSize,
      'rowStart/rowEnd 插槽下文件名与体积仍然渲染（不会被自定义行内容吃掉）: ' + JSON.stringify(by.slots));
  chk(by.slots && by.slots.hasStart && by.slots.hasEnd && by.slots.hasDel,
      '两个插槽内容 + 删除按钮都在同一行');
  chk(by.shortpath && by.shortpath.shortened && by.shortpath.titleIsFull,
      '深层路径被缩短且 title 保留完整路径: ' + JSON.stringify(by.shortpath));
  chk(by.single && by.single.count === 1 && by.single.pathIsB, 'single 模式下新文件顶替旧文件');
  chk(by.virtual && by.virtual.count === 1 && by.virtual.sizeText === '剪贴板',
      '虚拟条目（剪贴板）不 stat 且显示来源: ' + (by.virtual && by.virtual.sizeText));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail === 0 ? 0 : 1);
