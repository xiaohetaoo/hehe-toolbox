'use strict';
const fs = require('fs');
const tempNames = require('./temp-names');

function entityValidator(headers) {
  const etag = headers.get('etag');
  if (etag && !/^W\//i.test(etag)) return etag;
  const modified = headers.get('last-modified');
  return modified && Number.isFinite(Date.parse(modified)) ? modified : null;
}

/** Stream retries only within the same validated HTTP representation.
 * Dependencies are injectable so tests use local servers and bounded delays.
 */
async function download(url, dest, id, ctrl, label, dependencies = {}) {
  const request = dependencies.fetch || fetch;
  const send = dependencies.send || (() => {});
  const pause = dependencies.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const tmp = tempNames.downloadPart(dest);
  let owned = false, got = 0, total = 0, validator = null, lastEmit = 0;
  const cleanup = async () => {
    if (!owned) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await fs.promises.rm(tmp, { force: true }); return; }
      catch (e) { if (attempt === 4) throw e; await pause(200); }
    }
  };
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      let file = null, reader = null;
      try {
        if (ctrl.signal.aborted) throw new Error('ABORTED');
        // Unvalidated partial data cannot be resumed safely.
        if (!validator || !total) got = 0;
        const headers = { 'Accept-Encoding': 'identity' };
        if (got > 0) { headers.Range = 'bytes=' + got + '-'; headers['If-Range'] = validator; }
        const response = await request(url, { signal: ctrl.signal, redirect: 'follow', headers });
        if (response.status === 416) {
          got = 0; total = 0; validator = null;
          if (response.body) await response.body.cancel().catch(() => {});
          throw new Error('服务器拒绝续传，将从零重新下载');
        }
        if (!response.ok) {
          if (response.body) await response.body.cancel().catch(() => {});
          throw new Error('下载源响应 ' + response.status);
        }
        reader = response.body.getReader();
        const encoding = response.headers.get('content-encoding');
        const encoded = !!encoding && encoding.toLowerCase() !== 'identity';
        const nextValidator = entityValidator(response.headers);
        const lengthHeader = response.headers.get('content-length');
        const length = lengthHeader === null ? null : Number(lengthHeader);
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
          if (!got || !validator || !range || encoded || Number(range[1]) !== got ||
              Number(range[3]) !== total || Number(range[2]) < got || Number(range[2]) >= total ||
              (length !== null && length !== Number(range[2]) - got + 1) ||
              (nextValidator && nextValidator !== validator)) {
            got = 0; total = 0; validator = null;
            throw new Error('续传资源或范围已变化，将重新下载');
          }
        } else if (response.status === 200) {
          got = 0;
          total = !encoded && Number.isSafeInteger(length) && length >= 0 ? length : 0;
          validator = encoded ? null : nextValidator;
        } else {
          throw new Error('下载源返回了不支持的状态 ' + response.status);
        }
        file = await fs.promises.open(tmp, owned ? (got ? 'a' : 'w') : 'wx');
        owned = true;
        while (true) {
          const { done, value } = await reader.read();
          if (ctrl.signal.aborted) throw new Error('ABORTED');
          if (done) break;
          await file.writeFile(value);
          got += value.length;
          const now = Date.now();
          if (now - lastEmit > 400) {
            lastEmit = now;
            send('job:stream', { id, data: JSON.stringify({ pct: total ? Math.min(99, got / total * 100) : 0, mb: got / 1048576, totalMB: total / 1048576, label }) });
          }
        }
        if (!got || (total > 0 && got !== total)) throw new Error('下载内容为空或体积不符');
        await file.close(); file = null;
        await fs.promises.rename(tmp, dest);
        owned = false;
        return { size: got };
      } catch (error) {
        // Release both handles before inspecting the offset or retrying on Windows.
        if (reader) { await reader.cancel().catch(() => {}); reader = null; }
        if (file) { await file.close().catch(() => {}); file = null; }
        if (ctrl.signal.aborted || error.message === 'ABORTED') throw new Error('下载已取消');
        if (owned) got = (await fs.promises.stat(tmp)).size;
        if (attempt === 5) throw new Error('下载失败（已重试 6 次）：' + error.message);
        send('job:stream', { id, data: JSON.stringify({ stage: 'retry', attempt: attempt + 1, label, reason: error.message }) });
        await pause(1500);
      } finally {
        if (reader) await reader.cancel().catch(() => {});
        if (file) await file.close().catch(() => {});
      }
    }
    throw new Error('下载失败');
  } finally { await cleanup(); }
}

module.exports = { download, entityValidator };
