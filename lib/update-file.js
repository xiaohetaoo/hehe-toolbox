'use strict';
const fs = require('fs');
const crypto = require('crypto');

/** Validate against release metadata, even when an older release has no digest. */
async function verifyUpdateFile(file, metadata) {
  const expectedSize = Number(metadata && metadata.assetSize);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 64) throw new Error('缺少可信的更新文件大小，请重新检查更新');
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize) throw new Error('更新文件体积不符，请重新下载');
  const handle = await fs.promises.open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('更新文件不是有效的 Windows 可执行文件');
    }
    const offset = header.readUInt32LE(0x3c);
    if (offset < 64 || offset > stat.size - 4) throw new Error('更新文件 PE 头无效');
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, 4, offset);
    if (!signature.equals(Buffer.from([0x50, 0x45, 0, 0]))) throw new Error('更新文件 PE 签名无效');
  } finally { await handle.close(); }
  const digest = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', data => hash.update(data)).on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
  const expected = metadata.assetSha256;
  if (expected != null && (!/^[a-f0-9]{64}$/i.test(expected) || digest !== expected.toLowerCase())) {
    throw new Error('更新文件 SHA-256 不符，请重新下载');
  }
  return { size: stat.size, sha256: digest };
}

/**
 * 这个路径是不是「本项目自己的更新包」。
 *
 * 用途：net:download 有一条「目标已存在就拒绝，避免覆盖用户文件」的闸门。
 * 但更新包下载的目标固定是 `<userData>/update/<assetName>` —— 同一版本
 * 反复下载会撞上自己上次留下的那份，于是被闸门挡住，且界面此时已经没有
 * 下载/安装按钮，形成「下载过一次、没装、就再也装不了」的死锁（第四轮审查）。
 *
 * 判据必须严格：只有「在 userData/update 目录下 + 文件名是更新包的资产名」
 * 才算我们自己的；其它路径继续走原来的拒绝逻辑，绝不放宽用户文件的保护。
 *
 * @param {string} filePath 待判断的下载目标
 * @param {string} userDataDir app.getPath('userData')
 * @returns {boolean}
 */
function isOwnUpdateArtifact(filePath, userDataDir) {
  const p = String(filePath == null ? '' : filePath);
  const base = String(userDataDir == null ? '' : userDataDir);
  if (!p || !base) return false;
  const path = require('path');
  const updateDir = path.join(path.resolve(base), 'update');
  if (path.dirname(path.resolve(p)).toLowerCase() !== updateDir.toLowerCase()) return false;
  /* 资产名在发布侧固定为英文（中文名会被 GitHub 剥离），这里只认这个形态 */
  return /^hehe-toolbox-Portable-[\w.-]+\.exe$/i.test(path.basename(p));
}

module.exports = { verifyUpdateFile, isOwnUpdateArtifact };
