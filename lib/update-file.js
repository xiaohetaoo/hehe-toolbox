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

module.exports = { verifyUpdateFile };
