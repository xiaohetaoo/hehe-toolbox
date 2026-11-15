'use strict';
/* 开发环境「用户环境」状态机（apply / unapply / remove）的行为测试。
 *
 * 做法：给 ipc/env-manager.js 注入一个**内存版用户环境**（userEnvIO），
 * 于是可以真的跑 apply/unapply 的状态机与备份/还原逻辑，而不碰本机真实 PATH。
 * 第五轮审查补的三件事也在这里钉住：
 *   · 值类型（REG_EXPAND_SZ / %VAR%）必须原样保留；
 *   · 并发 apply 必须串行，不能丢更新；
 *   · 撤销逐字还原（含重复项、尾分号）。
 */
const { t, done } = require('./lib/harness');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmDir } = require('./lib/test-fs');
const envCatalog = require('../lib/env-catalog');

const INITIAL_PATH = 'C:\\Windows;C:\\tools;C:\\tools';   // 故意带重复项
const INITIAL_JAVA = 'C:\\old-jdk';

function fixture() {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'envmgr-'));
  const store = new Map();
  const handlers = new Map();
  let seq = 0;
  const user = { path: INITIAL_PATH, pathKind: 'String', vars: { JAVA_HOME: INITIAL_JAVA }, varKinds: { JAVA_HOME: 'String' } };
  const nodeRt = envCatalog.findRuntime('node');
  const jdkRt = envCatalog.findRuntime('jdk');
  const nodeDir = envCatalog.installLayout(ud, nodeRt).dir;
  const jdkDir = envCatalog.installLayout(ud, jdkRt).dir;
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.mkdirSync(jdkDir, { recursive: true });

  require('../ipc/env-manager')({ nextJobSeq: () => ++seq }, {
    handle: (ch, fn) => handlers.set(ch, fn),
    jobs: new Map(),
    nextJobSeq: () => ++seq,
    setLatestCancelable: () => {},
    downloadToFile: async () => { throw new Error('测试不应真的下载'); },
    userDataDir: () => ud,
    runCmd: async () => ({ code: 0, stdout: '', stderr: '' }),
    storeGet: (k, d) => (store.has(k) ? store.get(k) : d),
    storeSet: (k, v) => { store.set(k, v); return true; },
    psSingleQuote: (s) => "'" + String(s).replace(/'/g, "''") + "'",
    moveFile: async (src, dst) => { await fs.promises.rename(src, dst); return { moved: true, copied: false }; },
    userEnvIO: {
      /* 模拟一点延迟：没有串行锁时两个 apply 会交错、后写覆盖先写 */
      read: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return {
          path: user.path, pathKind: user.pathKind,
          vars: Object.assign({}, user.vars), varKinds: Object.assign({}, user.varKinds),
        };
      },
      write: async ({ pathValue, pathKind, vars, removeVars }) => {
        if (pathValue != null) { user.path = pathValue; user.pathKind = pathKind || 'String'; }
        for (const v of vars || []) { user.vars[v.name] = v.value; user.varKinds[v.name] = v.kind || 'String'; }
        for (const k of removeVars || []) { delete user.vars[k]; delete user.varKinds[k]; }
      },
    },
  });
  store.set('envInstalled', {
    node: { version: nodeRt.version, dir: nodeDir, at: Date.now() },
    jdk: { version: jdkRt.version, dir: jdkDir, at: Date.now() },
  });
  const call = (ch, ...args) => handlers.get(ch)({}, ...args);
  return { ud, store, handlers, user, nodeDir, jdkDir, call, cleanup: () => rmDir(ud) };
}

(async () => {
  await t('ES1 CATALOG：返回四个运行时，未应用时 applied 为 null', async () => {
    const f = fixture();
    try {
      const r = await f.call('env:catalog');
      assert.deepStrictEqual(r.runtimes.map((x) => x.id).sort(), ['jdk', 'mingw', 'node', 'python']);
      assert.strictEqual(r.applied, null);
      const byId = Object.fromEntries(r.runtimes.map((x) => [x.id, x]));
      assert.ok(byId.node.installed && byId.node.installed.dir, 'node 应显示已安装');
      assert.strictEqual(byId.python.installed, null, 'python 未安装应为 null');
    } finally { f.cleanup(); }
  });

  await t('ES2 APPLY：只加新目录，用户已有项（含重复）原样保留', async () => {
    const f = fixture();
    try {
      const r = await f.call('env:apply', ['node']);
      assert.deepStrictEqual(r.appliedIds, ['node']);
      assert.strictEqual(f.user.path, f.nodeDir + ';' + INITIAL_PATH);
      assert.ok(f.user.path.endsWith('C:\\tools;C:\\tools'), '重复项必须保留');
      assert.strictEqual(f.user.path.split(';')[0], f.nodeDir);
    } finally { f.cleanup(); }
  });

  await t('ES3 APPLY jdk：设置 JAVA_HOME，且不影响已应用的 node', async () => {
    const f = fixture();
    try {
      await f.call('env:apply', ['node']);
      await f.call('env:apply', ['jdk']);
      assert.strictEqual(f.user.vars.JAVA_HOME, f.jdkDir);
      assert.ok(f.user.path.includes(f.nodeDir) && f.user.path.includes(f.jdkDir));
    } finally { f.cleanup(); }
  });

  await t('ES4 UNAPPLY 单个：只摘该运行时，其它保持', async () => {
    const f = fixture();
    try {
      await f.call('env:apply', ['node']);
      await f.call('env:apply', ['jdk']);
      await f.call('env:unapply', ['node']);
      assert.ok(!f.user.path.includes(f.nodeDir), 'node 目录应被移除');
      assert.ok(f.user.path.includes(f.jdkDir), 'jdk 目录必须保留');
      assert.strictEqual(f.user.vars.JAVA_HOME, f.jdkDir, 'JAVA_HOME 不能被误还原');
    } finally { f.cleanup(); }
  });

  await t('ES5 UNAPPLY 全部：PATH 逐字还原、JAVA_HOME 还原为原值', async () => {
    const f = fixture();
    try {
      await f.call('env:apply', ['node']);
      await f.call('env:apply', ['jdk']);
      const r = await f.call('env:unapply');
      assert.strictEqual(f.user.path, INITIAL_PATH, '撤销后 PATH 必须与初始值逐字一致');
      assert.strictEqual(f.user.vars.JAVA_HOME, INITIAL_JAVA, 'JAVA_HOME 必须还原');
      assert.ok(r.restoredVars.includes('JAVA_HOME'));
      assert.ok(!f.store.get('envApplied'), '取消应用后状态应清空');
      assert.ok(!f.store.get('envVarsBackup'), '备份也应清掉');
    } finally { f.cleanup(); }
  });

  await t('ES6 REMOVE：已应用时先摘环境项，再删目录与 manifest', async () => {
    const f = fixture();
    try {
      await f.call('env:apply', ['node']);
      const r = await f.call('env:remove', 'node');
      assert.deepStrictEqual(r, { removed: true });
      assert.ok(!f.user.path.includes(f.nodeDir), 'PATH 里不能残留已删除的目录');
      assert.ok(!fs.existsSync(f.nodeDir), '安装目录应被删除');
      assert.ok(!f.store.get('envInstalled').node, 'manifest 条目应删除');
    } finally { f.cleanup(); }
  });

  await t('ES7 APPLY 未安装的 id：不写环境，返回警告', async () => {
    const f = fixture();
    try {
      const r = await f.call('env:apply', ['python']);
      assert.deepStrictEqual(r.appliedIds, []);
      assert.ok(r.warnings.length > 0, '应提示"先安装"');
      assert.strictEqual(f.user.path, INITIAL_PATH);
    } finally { f.cleanup(); }
  });

  await t('ES8 尾分号：原 PATH 以分号结尾时，撤销要逐字还原', async () => {
    const f = fixture();
    try {
      f.user.path = INITIAL_PATH + ';';
      await f.call('env:apply', ['node']);
      assert.ok(f.user.path.endsWith(';'), '应用后尾分号应保留');
      await f.call('env:unapply');
      assert.strictEqual(f.user.path, INITIAL_PATH + ';');
    } finally { f.cleanup(); }
  });

  await t('ES9 值类型：REG_EXPAND_SZ 与 %VAR% 引用必须原样保留', async () => {
    const f = fixture();
    try {
      const orig = '%USERPROFILE%\\bin;' + INITIAL_PATH;
      f.user.path = orig;
      f.user.pathKind = 'ExpandString';
      f.user.varKinds.JAVA_HOME = 'ExpandString';
      f.user.vars.JAVA_HOME = '%JDK_HOME%';
      await f.call('env:apply', ['jdk']);
      /* 锁的是：写回时把 ExpandString 降级成 String、或把 %VAR% 展开成字面量。 */
      assert.strictEqual(f.user.pathKind, 'ExpandString', 'PATH 值类型必须保留');
      assert.ok(f.user.path.includes('%USERPROFILE%\\bin'), '%VAR% 引用必须保留');
      assert.strictEqual(f.user.varKinds.JAVA_HOME, 'ExpandString', 'JAVA_HOME 类型必须保留');
      await f.call('env:unapply');
      assert.strictEqual(f.user.path, orig, '撤销后必须逐字还原（含 %VAR%）');
      assert.strictEqual(f.user.pathKind, 'ExpandString', '撤销后类型仍须是 ExpandString');
      assert.strictEqual(f.user.vars.JAVA_HOME, '%JDK_HOME%', 'JAVA_HOME 原值必须还原');
    } finally { f.cleanup(); }
  });

  await t('ES10 并发：两个 apply 同时发起，不能丢更新', async () => {
    const f = fixture();
    try {
      /* 锁的是：read-改-write 交错 —— 后写覆盖先写，最终只有一个目录进 PATH。 */
      await Promise.all([f.call('env:apply', ['node']), f.call('env:apply', ['jdk'])]);
      assert.ok(f.user.path.includes(f.nodeDir), 'node 目录不能丢');
      assert.ok(f.user.path.includes(f.jdkDir + '\\bin'), 'jdk 的 bin 目录不能丢');
      const dirs = f.user.path.split(';');
      assert.strictEqual(dirs.filter((x) => x === f.nodeDir).length, 1, 'node 目录只应出现一次');
      assert.strictEqual(dirs.filter((x) => x === f.jdkDir + '\\bin').length, 1, 'jdk 目录只应出现一次');
    } finally { f.cleanup(); }
  });

  await t('ES11 旧版备份形状（纯字符串）也能正确还原', async () => {
    const f = fixture();
    try {
      /* 模拟上一版存下的 { JAVA_HOME: 'C:\\old-jdk' } */
      f.store.set('envVarsBackup', { JAVA_HOME: INITIAL_JAVA, at: Date.now() });
      await f.call('env:apply', ['jdk']);
      await f.call('env:unapply');
      assert.strictEqual(f.user.vars.JAVA_HOME, INITIAL_JAVA);
    } finally { f.cleanup(); }
  });

  done();
})().catch((e) => { console.error('测试崩溃：', e); process.exit(1); });