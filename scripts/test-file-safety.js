'use strict';
const { t, done, assert, readSrc, extractFn } = require('./lib/harness');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const pathGuard = require('../lib/path-guard');
const CH = require('../lib/channels').CHANNELS;
const { rmDir } = require('./lib/test-fs');
const { segFromHandler } = require('./lib/seg-from-handler');

const mainSrc = readSrc('main.js', { raw: true });
const moveSrc = readSrc('ipc/dir-acl-links.js', { raw: true });
const exists = async p => { try { await fs.promises.access(p); return true; } catch (e) { return false; } };
const uniqueTarget = new Function('path', 'pathGuard', 'pathExists',
  extractFn(mainSrc, 'async function uniqueTarget(') + '\nreturn uniqueTarget;')(path, pathGuard, exists);

function handlers(fsp = fs.promises, tempNames = require('../lib/temp-names')) {
  const out = {};
  require('../ipc/fs-ops')({}, {
    handle: (ch, fn) => { out[ch] = fn; }, send: () => {}, jobs: new Map(), fmtErr: String,
    setLatestCancelable: () => {}, fs, fsp, path, os, crypto, shell: {}, AdmZip, pathGuard,
    tempNames, fsOps: require('../lib/fs-ops'),
    archiveGuard: require('../lib/archive-guard'), uniqueTarget, isOwnTempName: () => false,
  });
  return out;
}
async function temporary(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hehe-safety-'));
  try { await fn(root); } finally { rmDir(root); }
}
function zipAt(root, entries) {
  const zip = new AdmZip();
  for (const [name, text] of entries) zip.addFile(name, Buffer.from(text));
  const file = path.join(root, 'input.zip'); zip.writeZip(file); return file;
}
function verifier(fsp = fs.promises) {
  return new Function('fs', 'fsp', 'path', 'crypto',
    extractFn(moveSrc, 'function hashFile(') + '\n' + extractFn(moveSrc, 'async function verifyCopy(')
    + '\nreturn verifyCopy;')(fs, fsp, path, crypto);
}

t('解压拒绝目标内已有的目录联接，外部目录不被写入', () => temporary(async root => {
  const dest = path.join(root, 'out'), outside = path.join(root, 'outside');
  fs.mkdirSync(dest); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dest, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const zip = zipAt(root, [['linked/data.txt', 'PAYLOAD']]);
  await assert.rejects(() => handlers()[CH.ZIP.EXTRACT]({}, zip, dest), /链接|超出/);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
}));

t('解压根目录可显式选为别名，正常子目录与重名文件均保留', () => temporary(async root => {
  const real = path.join(root, 'real'), alias = path.join(root, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(real, 'sub')); fs.writeFileSync(path.join(real, 'sub', 'data.txt'), 'OLD');
  const zip = zipAt(root, [['sub/', ''], ['sub/data.txt', 'NEW']]);
  await handlers()[CH.ZIP.EXTRACT]({}, zip, alias);
  assert.strictEqual(await fs.promises.readFile(path.join(real, 'sub', 'data.txt'), 'utf8'), 'OLD');
  assert.strictEqual(await fs.promises.readFile(path.join(real, 'sub', 'data(1).txt'), 'utf8'), 'NEW');
}));

t('解压磁盘写满时清理当前半截文件，保留用户原有文件', () => temporary(async root => {
  const dest = path.join(root, 'out'); fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, 'data.txt'), 'ORIGINAL');
  const fsp = new Proxy(fs.promises, { get(target, key) {
    if (key !== 'open') return target[key];
    return async (...args) => {
      const file = await target.open(...args);
      return { close: () => file.close(), writeFile: async data => {
        await file.writeFile(data.subarray(0, 3));
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      } };
    };
  } });
  const zip = zipAt(root, [['data.txt', 'COMPLETE']]);
  await assert.rejects(() => handlers(fsp)[CH.ZIP.EXTRACT]({}, zip, dest), { code: 'ENOSPC' });
  assert.deepStrictEqual(fs.readdirSync(dest), ['data.txt']);
  assert.strictEqual(await fs.promises.readFile(path.join(dest, 'data.txt'), 'utf8'), 'ORIGINAL');
}));

t('解压排他创建发生并发重名时重新编号，不覆盖或删除并发文件', () => temporary(async root => {
  let raced = false;
  const dest = path.join(root, 'out');
  const fsp = new Proxy(fs.promises, { get(target, key) {
    if (key !== 'open') return target[key];
    return async (file, flags) => {
      if (!raced) { raced = true; await target.writeFile(file, 'CONCURRENT'); }
      return target.open(file, flags);
    };
  } });
  await handlers(fsp)[CH.ZIP.EXTRACT]({}, zipAt(root, [['data.txt', 'ARCHIVE']]), dest);
  assert.strictEqual(await fs.promises.readFile(path.join(dest, 'data.txt'), 'utf8'), 'CONCURRENT');
  assert.strictEqual(await fs.promises.readFile(path.join(dest, 'data(1).txt'), 'utf8'), 'ARCHIVE');
}));

t('解压存在性检查漏掉冲突时仍能换名完成', () => temporary(async root => {
  let raced = false;
  const dest = path.join(root, 'out');
  const fsp = new Proxy(fs.promises, { get(target, key) {
    if (key !== 'open') return target[key];
    return async (file, flags) => {
      if (!raced) { raced = true; throw Object.assign(new Error('name collision'), { code: 'EEXIST' }); }
      return target.open(file, flags);
    };
  } });
  await handlers(fsp)[CH.ZIP.EXTRACT]({}, zipAt(root, [['data.txt', 'ARCHIVE']]), dest);
  assert.strictEqual(await fs.promises.readFile(path.join(dest, 'data(1).txt'), 'utf8'), 'ARCHIVE');
}));

t('7z 提交阶段拒绝目标内已有的目录联接', () => temporary(async root => {
  const dest = path.join(root, 'out'), outside = path.join(root, 'outside');
  fs.mkdirSync(dest); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dest, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  let extract;
  const runSeven = async (bin, args) => {
    if (args[0] === 'l') return { code: 0, stdout: 'Path = linked/data.txt\nSize = 7\nPacked Size = 7\nAttributes = A\n' };
    const staging = args.find(arg => arg.startsWith('-o')).slice(2);
    await fs.promises.mkdir(path.join(staging, 'linked'));
    await fs.promises.writeFile(path.join(staging, 'linked', 'data.txt'), 'ARCHIVE');
    return { code: 0 };
  };
  const code = extractFn(mainSrc, 'async function scanDirForGuard(') + '\n'
    + segFromHandler(mainSrc, 'seven:extract') + ');';
  new Function('handle', 'CH', 'findSevenFull', 'sevenZa', 'fsp', 'tempNames', 'runSeven',
    'archiveGuard', 'pathGuard', 'path', 'uniqueTarget', code)(
    (ch, fn) => { extract = fn; }, CH, () => 'test-7z', null,
    { ...fs.promises, stat: p => p === 'fixture.7z' ? Promise.resolve({ size: 100 }) : fs.promises.stat(p) },
    require('../lib/temp-names'), runSeven, require('../lib/archive-guard'), pathGuard, path, uniqueTarget);
  await assert.rejects(() => extract({}, { archive: 'fixture.7z', outDir: dest }), /链接|超出/);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
  assert.deepStrictEqual(fs.readdirSync(dest), ['linked'], 'staging 应已清理');
}));

t('GCM 新文件认证往返，拒绝头部、密文、标签篡改和错误密码', () => temporary(async root => {
  const api = handlers(), plain = path.join(root, 'plain'), enc = path.join(root, 'enc'), out = path.join(root, 'out');
  const content = 'role=user;balance=000100; document content';
  fs.writeFileSync(plain, content);
  await api[CH.FS.ENCRYPT_FILE]({}, plain, enc, 'correct-password');
  const bytes = await fs.promises.readFile(enc);
  assert.strictEqual(bytes.subarray(0, 8).toString(), 'HEHEENC2');
  const result = await api[CH.FS.DECRYPT_FILE]({}, enc, out, 'correct-password');
  assert.strictEqual(result.authenticated, true);
  assert.strictEqual(await fs.promises.readFile(out, 'utf8'), content);
  for (const index of [8, 24, 40, bytes.length - 1]) {
    const changed = Buffer.from(bytes); changed[index] ^= 1; fs.writeFileSync(enc, changed);
    await assert.rejects(() => api[CH.FS.DECRYPT_FILE]({}, enc, out, 'correct-password'), /解密失败/);
    assert.strictEqual(await fs.promises.readFile(out, 'utf8'), content, '认证失败不得提交或破坏已有输出');
  }
  fs.writeFileSync(enc, bytes);
  await assert.rejects(() => api[CH.FS.DECRYPT_FILE]({}, enc, out, 'wrong-password'), /解密失败/);
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['enc', 'out', 'plain']);
}));

t('旧版 CBC 文件仍可解密，返回未认证标记', () => temporary(async root => {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(16);
  const key = crypto.scryptSync('legacy-password', salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const text = 'legacy document';
  const legacy = Buffer.concat([Buffer.from('HEHEENC1'), salt, iv, cipher.update(text), cipher.final()]);
  const input = path.join(root, 'legacy'), out = path.join(root, 'plain'); fs.writeFileSync(input, legacy);
  const result = await handlers()[CH.FS.DECRYPT_FILE]({}, input, out, 'legacy-password');
  assert.strictEqual(result.authenticated, false); assert.strictEqual(result.legacy, true);
  assert.strictEqual(await fs.promises.readFile(out, 'utf8'), text);
}));

t('加密临时名已存在时，不覆盖或清理他人的文件', () => temporary(async root => {
  const src = path.join(root, 'plain'), temp = path.join(root, 'existing-temp'), out = path.join(root, 'out');
  fs.writeFileSync(src, 'PLAINTEXT'); fs.writeFileSync(temp, 'KEEP');
  const names = { ...require('../lib/temp-names'), cryptTmp: () => temp };
  await assert.rejects(() => handlers(fs.promises, names)[CH.FS.ENCRYPT_FILE]({}, src, out, 'pw'), { code: 'EEXIST' });
  assert.strictEqual(await fs.promises.readFile(temp, 'utf8'), 'KEEP');
  assert.strictEqual(fs.existsSync(out), false);
}));

t('搬家校验拒绝第五个同尺寸文件的修改', () => temporary(async root => {
  const src = path.join(root, 'src'), dst = path.join(root, 'dst'); fs.mkdirSync(src); fs.mkdirSync(dst);
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(src, `file${i}`), 'A'.repeat(128));
    fs.writeFileSync(path.join(dst, `file${i}`), 'A'.repeat(128));
  }
  const verify = verifier(); const result = await verify(src, dst);
  assert.strictEqual(result.hashed, 5);
  fs.writeFileSync(path.join(src, 'file4'), 'B'.repeat(128));
  await assert.rejects(() => verify(src, dst), /哈希不一致/);
}));

t('搬家大文件也核对内容，空目录缺失不能通过', () => temporary(async root => {
  const src = path.join(root, 'src'), dst = path.join(root, 'dst'); fs.mkdirSync(src); fs.mkdirSync(dst);
  fs.writeFileSync(path.join(src, 'large'), 'A'); fs.writeFileSync(path.join(dst, 'large'), 'B');
  const fsp = new Proxy(fs.promises, { get(target, key) {
    if (key !== 'stat') return target[key];
    return async file => Object.assign(await target.stat(file), { size: 513 * 1024 * 1024 });
  } });
  await assert.rejects(() => verifier(fsp)(src, dst), /哈希不一致/);
  fs.writeFileSync(path.join(dst, 'large'), 'A'); fs.mkdirSync(path.join(src, 'empty'));
  await assert.rejects(() => verifier()(src, dst), /目标缺少目录/);
}));

t('真实搬家保留切换期间的新内容和源备份', () => temporary(async root => {
  // Exercise the production handler on one volume; only the volume policy is stubbed.
  const policy = require('../lib/dir-move');
  const validateMove = policy.validateMove;
  policy.validateMove = p => validateMove({ ...p, allowSameVolume: true });
  const src = path.join(root, 'src'), dst = path.join(root, 'dst'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'data'), 'BEFORE');
  const moveHandlers = {};
  try {
    require('../ipc/dir-acl-links')({ nextJobSeq: () => 1 }, {
      handle: (ch, fn) => { moveHandlers[ch] = fn; },
      ps: async () => ({ stdout: '', code: 0 }), runCmd: async () => ({ stdout: '', code: 0 }),
      pathExists: exists, shortErr: String, PS_PATH_BATCH: 100,
      send: (ch, d) => {
        const event = JSON.parse(d.data);
        if (event.stage === 'verify' && event.ok === true) fs.writeFileSync(path.join(src, 'data'), 'AFTER!');
      },
    });
    const result = await moveHandlers[CH.DIR_MOVE.MOVE]({}, { src, dst });
    assert.strictEqual(result.ok, true); assert.strictEqual(result.bakRemoved, false);
    assert.strictEqual(result.bakRetained, true);
    assert.strictEqual(await fs.promises.readFile(path.join(result.bakPath, 'data'), 'utf8'), 'AFTER!');
    assert.strictEqual(await fs.promises.readFile(path.join(src, 'data'), 'utf8'), 'BEFORE');
    assert.ok(result.advice.includes(result.bakPath));
  } finally { policy.validateMove = validateMove; }
}));

done();
