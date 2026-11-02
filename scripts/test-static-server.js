'use strict';
const { t, done } = require('./lib/harness');
/* 静态服务器的行为测试（原 test-round15 的 5a / 5b）。
 *
 * 锁的是：页面切走再切回来时，按钮还停在"已停止"，而服务其实还在跑 ——
 * 用户点「启动」会报端口占用。修法是加只读的 server:status，
 * 页面初始化时查一次并回填。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stripComments = require('../lib/src-scan').stripComments;
const mainSrc = require('./lib/harness').readMain({ raw: true });
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

t('5a 主进程有只读的 server:status', () => {
  const code = stripComments(mainSrc);
  assert.ok(/handle\('server:status'/.test(code), '没有 server:status 通道');
  const i = code.indexOf("handle('server:status'");
  const seg = code.slice(i, i + 400);
  assert.ok(/running/.test(seg) && /url/.test(seg) && /root/.test(seg), 'status 返回字段不全');
  // 必须记录 root/port，否则回填不了
  assert.ok(/serverRoot = root/.test(code) || /serverRoot\s*=\s*root/.test(code), 'server:start 没有记录根目录');
});

t('5b 页面初始化会查一次状态并回填按钮', () => {
  const code = stripComments(read('js/tools/dev.js'));
  assert.ok(/invoke\('server:status'\)/.test(code), '页面没有查询服务状态（切页回来会是死局）');
  const i = code.indexOf("invoke('server:status')");
  const seg = code.slice(i, i + 700);
  assert.ok(/paintRunning/.test(seg), '查到在跑却没有回填界面状态');
  assert.ok(/dirIn\.value/.test(seg) && /portIn\.value/.test(seg), '没有把目录/端口填回输入框');
});

/* ==================== 6. 电源门禁三种穿透 ==================== */

done();
