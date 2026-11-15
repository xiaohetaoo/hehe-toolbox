'use strict';
/* 开发环境「用户环境」状态机（apply / unapply / remove）的行为测试。
 *
 * 做法：给 ipc/env-manager.js 注入一个**内存版用户环境**（userEnvIO），
 * 于是可以真的跑 apply/unapply 的状态机与备份/还原逻辑，而不碰本机真实 PATH。
 * 这是 v0.8.8 收尾时学到的：只靠"真机跑一遍"会撞上 PATH 被去重/二次转义的坑，
 * 状态机本身必须能被反复、可断言地测。
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
  const user = { path: INITIAL_PATH, vars: { JAVA_HOME: INITIAL_JAVA } };
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
    userEnvIO: {
      read: async () => ({ path: user.path, vars: Object.assign({}, user.vars) }),
      write: async ({ pathValue, vars, removeVars }) => {
        if (pathValue != null) user.path = pathValue;
        for (const [k, v] of Object.entries(vars || {})) user.vars[k] = v;
        for (const k of removeVars || []) delete user.vars[k];
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
      /* 锁的是：已安装/未安装状态串了 —— 界面会给出错误的「已安装」。 */
      assert.ok(byId.node.installed && byId.node.installed.dir, 'node 应显示已安装');
      assert.strictEqual(byId.python.installed, null, 'python 未安装应为 null');
    } finally { f.cleanup(); }
  });

  await t('ES2 APPLY：只加新目录，用户已有项（含重复）原样保留', async () => {
    const f = fixture();
    try {
      const r = await f.call('env:apply', ['node']);
      assert.deepStrictEqual(r.appliedIds, ['node']);
      /* 锁的是：应用后把用户 PATH 去重/重排 —— v0.8.8 真机踩过（长度反而变短）。 */
      assert.strictEqual(f.user.path, f.nodeDir + ';' + INITIAL_PATH);
      assert.ok(f.user.path.endsWith('C:\\tools;C:\\tools'), '重复项必须保留');
      /* 锁的是：没把 bin 放到最前面 —— 系统旧版本仍会优先命中。 */
      assert.strictEqual(f.user.path.split(';')[0], f.nodeDir);
    } finally { f.cleanup(); }
  });

  await t('ES3 APPLY jdk：设置 JAVA_HOME，且不影响已应用的 node', async () => {
    const f = fixture();
    try {
      await f.call('env:apply', ['node']);
      await f.call('env:apply', ['jdk']);
      /* 锁的是：JAVA_HOME 指向 bin 或没设置 —— Maven/Gradle 找不到。 */
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
      /* 锁的是：还原成"去重后的 PATH"—— 用户原值里有重复项，必须一模一样回来。 */
      assert.strictEqual(f.user.path, INITIAL_PATH, '撤销后 PATH 必须与初始值逐字一致');
      assert.strictEqual(f.user.vars.JAVA_HOME, INITIAL_JAVA, 'JAVA_HOME 必须还原');
      assert.ok(r.restoredVars.includes('JAVA_HOME'));
      const st = f.store.get('envApplied');
      assert.ok(!st, '取消应用后状态应清空');
      assert.ok(!f.store.get('envVarsBackup'), '备份也应清掉');
    } finally { f.cleanup(); }
  });

  await t('ES6 REMOVE：已应用时先摘环境项，再删目录与 manifest', async () => {
    const f = fixture();
    try {
      await f.call('env:apply', ['node']);
      const r = await f.call('env:remove', 'node');
      assert.deepStrictEqual(r, { removed: true });
      /* 锁的是：删了目录却把 PATH 项留着 —— 新终端里 node 直接坏掉。 */
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
      /* 锁的是：未安装时仍然改了 PATH —— 用户会看到一条不存在的路径。 */
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
      /* 锁的是：撤销后尾分号丢了 —— 真机 E2E 抓到过，PATH 与原始值差 1 个字符。 */
      assert.strictEqual(f.user.path, INITIAL_PATH + ';');
    } finally { f.cleanup(); }
  });

  done();
})().catch((e) => { console.error('测试崩溃：', e); process.exit(1); });