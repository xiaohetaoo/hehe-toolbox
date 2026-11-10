'use strict';
const { t, done, assert } = require('./lib/harness');
const { entityValidator } = require('../lib/download');
// Cancellation cleanup and HTTP 416 now exercise real local HTTP responses
// in test-download-entity.js instead of matching the former inline source.
t('下载实体标识优先使用强 ETag', () => {
  assert.strictEqual(entityValidator(new globalThis.Headers({ etag: '"version-1"',
    'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' })), '"version-1"');
});
t('弱 ETag 不可续传，只有有效修改时间可作为备用标识', () => {
  assert.strictEqual(entityValidator(new globalThis.Headers({ etag: 'W/"v1"' })), null);
  const modified = 'Wed, 21 Oct 2015 07:28:00 GMT';
  assert.strictEqual(entityValidator(new globalThis.Headers({ etag: 'W/"v1"', 'last-modified': modified })), modified);
  assert.strictEqual(entityValidator(new globalThis.Headers({ 'last-modified': 'invalid' })), null);
});
done();
