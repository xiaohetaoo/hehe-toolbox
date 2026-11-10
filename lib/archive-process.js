'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DEFAULT_LIMITS, err } = require('./archive-guard');

async function checkOutput(root, limits = {}) {
  const cap = { ...DEFAULT_LIMITS, ...limits };
  const pending = [[root, 0]];
  let total = 0, count = 0;
  while (pending.length) {
    const [dir, depth] = pending.pop();
    if (depth > cap.maxDepth) throw err('TOO_DEEP', '解压目录层级超过上限');
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (++count > cap.maxEntries) throw err('TOO_MANY_ENTRIES', '实际解压条目数超过上限');
      if (entry.isSymbolicLink()) throw err('SYMLINK', '拒绝解压链接条目');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { pending.push([file, depth + 1]); continue; }
      const stat = await fs.promises.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
      if (!stat) continue;
      if (!stat.isFile()) throw err('SPECIAL_ENTRY', '拒绝解压特殊条目');
      total += stat.size;
      if (stat.size > cap.maxEntryBytes || total > cap.maxTotalBytes) {
        throw err('TOO_LARGE', '实际解压数据超过安全上限，已停止解压');
      }
    }
  }
  return { bytes: total, entries: count };
}

/** The watchdog bounds dishonest archive metadata as well as normal extraction.
 * Polling may allow one polling interval of extra output before termination.
 */
function extractLimited(bin, args, options) {
  const { root, limits, timeout = 600000, pollMs = 100, spawnImpl = spawn } = options;
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(bin, args, { windowsHide: true }); }
    catch (e) { reject(e); return; }
    let failure = null, stdout = '', stderr = '', closed = false, checking = false;
    let currentCheck = Promise.resolve();
    const stop = error => {
      if (failure) return;
      failure = error;
      try { child.kill('SIGKILL'); } catch (e) {}
    };
    const interval = setInterval(() => {
      if (checking || closed) return;
      checking = true;
      currentCheck = checkOutput(root, limits).then(() => {}, stop).finally(() => { checking = false; });
    }, pollMs);
    const deadline = setTimeout(() => stop(err('TIMEOUT', '解压超时，已停止')), timeout);
    child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-16000); });
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-16000); });
    child.once('error', error => { failure = error; });
    child.once('close', async code => {
      closed = true; clearInterval(interval); clearTimeout(deadline);
      try {
        await currentCheck;
        if (failure) throw failure;
        if (code === 0) await checkOutput(root, limits);
        resolve({ code, stdout, stderr });
      } catch (e) { reject(e); }
    });
  });
}

module.exports = { checkOutput, extractLimited };
