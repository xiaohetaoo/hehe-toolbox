'use strict';
const { createSuite, assert, readSrc, extractFn } = require('./lib/harness');
const { t, done } = createSuite({ order: 'sequential' });
const fs = require('fs'), path = require('path'), os = require('os');
const { EventEmitter } = require('events');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const AdmZip = require('adm-zip');
const guard = require('../lib/archive-guard');
const archiveProcess = require('../lib/archive-process');
const pathGuard = require('../lib/path-guard');
const CH = require('../lib/channels').CHANNELS;
const { segFromHandler } = require('./lib/seg-from-handler');
const { rmDir } = require('./lib/test-fs');
const { scanBrace } = require('../lib/src-scan');
const source = readSrc('main.js', { raw: true });
async function temporary(run) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hehe-archive-limits-'));
  try { await run(root); } finally { rmDir(root); }
}
function listing(name, size, packed = 0) {
  return `Path = ${name}\nSize = ${size}\nPacked Size = ${packed}\nAttributes = A\n`;
}
function extractor(runSeven) {
  let extract;
  const uniqueTarget = new Function('path', 'pathGuard', 'pathExists',
    extractFn(source, 'async function uniqueTarget(') + ';return uniqueTarget;')(
    path, pathGuard, async p => fs.existsSync(p));
  new Function('handle', 'CH', 'findSevenFull', 'sevenZa', 'fsp', 'tempNames', 'runSeven',
    'archiveGuard', 'pathGuard', 'path', 'uniqueTarget',
    extractFn(source, 'async function scanDirForGuard(') + '\n' + segFromHandler(source, 'seven:extract') + ');')(
    (ch, fn) => { extract = fn; }, CH, () => require('7zip-bin').path7za, null, fs.promises,
    require('../lib/temp-names'), runSeven, guard, pathGuard, path, uniqueTarget);
  return extract;
}
function zipExtractor() {
  const handlers = {};
  require('../ipc/fs-ops')({}, { handle: (ch, fn) => { handlers[ch] = fn; }, send: () => {},
    jobs: new Map(), fmtErr: String, setLatestCancelable: () => {}, fs, fsp: fs.promises, path, os,
    crypto: require('crypto'), shell: {}, AdmZip, pathGuard, tempNames: require('../lib/temp-names'),
    fsOps: require('../lib/fs-ops'), archiveGuard: guard,
    uniqueTarget: async (parent, name) => path.join(parent, name), isOwnTempName: () => false });
  return handlers[CH.ZIP.EXTRACT];
}
t('7z 清单支持中文和目录，缺少大小、重复字段、链接均拒绝', () => {
  const result = guard.inspectSevenListing('Path = 子目录\nSize = 0\nAttributes = D\n\n' + listing('子目录/文件.txt', 4, 4), 100);
  assert.strictEqual(result.totalBytes, 4);
  for (const text of ['Path = file\nAttributes = A\n', listing('file', 4) + 'Size = 5\n',
    listing('file', 4) + 'Symbolic Link = outside\n', listing('file', 4) + 'Hard Link = outside\n']) {
    assert.throws(() => guard.inspectSevenListing(text, 100));
  }
});
t('7z 清单检查单条和固实压缩累计压缩比', () => {
  assert.throws(() => guard.inspectSevenListing(listing('bomb', 20000, 1), 100), { code: 'BOMB_RATIO' });
  assert.throws(() => guard.inspectSevenListing(listing('a', 60000) + '\n' + listing('b', 60000), 100), { code: 'BOMB_RATIO' });
});
t('实际输出检查大小、数量、目录层级及目录联接', () => temporary(async root => {
  await fs.promises.writeFile(path.join(root, 'file'), Buffer.alloc(32));
  assert.deepStrictEqual(await archiveProcess.checkOutput(root), { bytes: 32, entries: 1 });
  await assert.rejects(() => archiveProcess.checkOutput(root, { maxEntryBytes: 16 }), { code: 'TOO_LARGE' });
  await assert.rejects(() => archiveProcess.checkOutput(root, { maxTotalBytes: 16 }), { code: 'TOO_LARGE' });
  await assert.rejects(() => archiveProcess.checkOutput(root, { maxEntries: 0 }), { code: 'TOO_MANY_ENTRIES' });
  await fs.promises.mkdir(path.join(root, 'sub'));
  await assert.rejects(() => archiveProcess.checkOutput(root, { maxDepth: 0 }), { code: 'TOO_DEEP' });
  await fs.promises.symlink(path.join(root, 'sub'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => archiveProcess.checkOutput(root), { code: 'SYMLINK' });
}));
function fakeChild(onSpawn) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let kills = 0;
  child.kill = () => { kills++; setImmediate(() => child.emit('close', 1)); return true; };
  return { spawnImpl: () => { if (onSpawn) onSpawn(child); return child; }, kills: () => kills };
}
t('解压看门狗在输出超限时终止模拟子进程', () => temporary(async root => {
  await fs.promises.writeFile(path.join(root, 'file'), Buffer.alloc(32));
  const fake = fakeChild();
  await assert.rejects(() => archiveProcess.extractLimited('mock', [], {
    root, pollMs: 5, timeout: 1000, limits: { maxEntryBytes: 16 }, spawnImpl: fake.spawnImpl,
  }), { code: 'TOO_LARGE' });
  assert.strictEqual(fake.kills(), 1);
}));
t('解压超时终止模拟子进程，成功退出仍复查最终输出', () => temporary(async root => {
  const timeout = fakeChild();
  await assert.rejects(() => archiveProcess.extractLimited('mock', [], {
    root, timeout: 10, spawnImpl: timeout.spawnImpl,
  }), { code: 'TIMEOUT' });
  const success = fakeChild(child => setImmediate(() => child.emit('close', 0)));
  assert.strictEqual((await archiveProcess.extractLimited('mock', [], { root, spawnImpl: success.spawnImpl })).code, 0);
  await fs.promises.writeFile(path.join(root, 'file'), Buffer.alloc(32));
  const fast = fakeChild(child => setImmediate(() => child.emit('close', 0)));
  await assert.rejects(() => archiveProcess.extractLimited('mock', [], {
    root, limits: { maxEntryBytes: 16 }, spawnImpl: fast.spawnImpl,
  }), { code: 'TOO_LARGE' });
}));
t('7z 炸弹在启动解压和创建输出目录之前拒绝', () => temporary(async root => {
  const archive = path.join(root, 'fixture.7z'), outDir = path.join(root, 'out');
  await fs.promises.writeFile(archive, 'fixture');
  const calls = [];
  const extract = extractor(async (bin, args) => { calls.push(args[0]); return { code: 0, stdout: listing('bomb', 10000000, 1) }; });
  await assert.rejects(() => extract({}, { archive, outDir }), { code: 'BOMB_RATIO' });
  assert.deepStrictEqual(calls, ['l']); assert.strictEqual(fs.existsSync(outDir), false);
}));
t('真实 7za 清单与受监测解压能够正常提交中文文件和空目录', () => temporary(async root => {
  const bin = require('7zip-bin').path7za;
  const input = path.join(root, 'input'); await fs.promises.mkdir(input);
  await fs.promises.mkdir(path.join(input, '空目录'));
  await fs.promises.writeFile(path.join(input, '中文.txt'), 'archive contents');
  const start = source.indexOf('async function runSeven('), open = source.indexOf(') {', start) + 2;
  const runSeven = new Function('sevenPwdArg', 'archiveProcess', 'runCmd',
    source.slice(start, scanBrace(source, open)) + ';return runSeven;')(
    new Function(extractFn(source, 'function sevenPwdArg(') + ';return sevenPwdArg;')(), archiveProcess,
    async (executable, args) => ({ code: 0, ...(await execFile(executable, args, { windowsHide: true, encoding: 'utf8' })) }));
  const extract = extractor(runSeven);
  for (const password of [null, 'test secret']) {
    const archive = path.join(root, password ? 'encrypted.7z' : 'plain.7z');
    const outDir = path.join(root, password ? 'encrypted-out' : 'plain-out');
    await execFile(bin, ['a', '-y', ...(password ? ['-p' + password, '-mhe=on'] : []), archive, '.'], { cwd: input, windowsHide: true });
    const result = await extract({}, { archive, outDir, password });
    assert.strictEqual(result.entries, 1);
    assert.strictEqual(await fs.promises.readFile(path.join(outDir, '中文.txt'), 'utf8'), 'archive contents');
    assert.strictEqual((await fs.promises.stat(path.join(outDir, '空目录'))).isDirectory(), true);
  }
}));
t('ZIP 声明零大小但包含大量压缩数据时拒绝，真实空文件仍可解压', () => temporary(async root => {
  const zip = new AdmZip(); zip.addFile('bomb', Buffer.alloc(4 * 1024 * 1024));
  const bytes = zip.toBuffer();
  // Forge both local and central CRC/size fields, preserving the compressed data.
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(0, 14); bytes.writeUInt32LE(0, 22);
  bytes.writeUInt32LE(0, central + 16); bytes.writeUInt32LE(0, central + 24);
  const archive = path.join(root, 'forged.zip'), out = path.join(root, 'out');
  await fs.promises.writeFile(archive, bytes);
  await assert.rejects(() => zipExtractor()({}, archive, out));
  assert.strictEqual(fs.existsSync(path.join(out, 'bomb')), false);
  const empty = new AdmZip(); empty.addFile('empty.txt', Buffer.alloc(0));
  empty.writeZip(archive); await zipExtractor()({}, archive, out);
  assert.strictEqual((await fs.promises.stat(path.join(out, 'empty.txt'))).size, 0);
}));
done();
