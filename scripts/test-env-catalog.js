'use strict';
/* 开发环境目录（lib/env-catalog.js）的契约测试。
 *
 * 这里锁的是「清单本身可信」：URL 必须 https、SHA256 必须 64 位、解压格式在白名单内、
 * binDirs 不能带穿越。清单是离线的唯一事实来源，一旦手滑写错，用户会装到错的东西。
 */
const { t, done } = require('./lib/harness');
const assert = require('assert');
const cat = require('../lib/env-catalog');

t('EC1 内置清单自检通过（URL/SHA/格式/binDirs）', () => {
  const problems = cat.validateCatalog(cat.getRuntimes());
  /* 锁的是：清单里出现 http、短 sha、未知压缩格式或带 .. 的 binDirs。
   * 这类错误不会在运行时立刻炸，却会让安装流程信任一个不可信的包。 */
  assert.deepStrictEqual(problems, [], '清单自检失败：' + problems.join('；'));
});

t('EC2 首批四个运行时齐全且版本非空', () => {
  const ids = cat.getRuntimes().map((r) => r.id);
  /* 锁的是：某个运行时被误删 —— 界面少一张卡，用户以为不支持。 */
  assert.deepStrictEqual(ids.sort(), ['jdk', 'mingw', 'node', 'python']);
  for (const r of cat.getRuntimes()) {
    assert.ok(r.version && /^\d/.test(r.version), r.id + ' 版本号应可读：' + r.version);
    assert.ok(r.official && r.official.url, r.id + ' 必须有官方安装器入口');
  }
});

t('EC3 版本号 → 目录名：特殊字符必须净化', () => {
  /* 锁的是：`21.0.13+9` 带着 `+` 进路径 —— Windows 合法但容易被工具链误解析，
   * 且与 URL 编码后的版本号不一致，排查时对不上。 */
  assert.strictEqual(cat.safeVersion('21.0.13+9'), '21.0.13_9');
  assert.strictEqual(cat.safeVersion('a/b c'), 'a_b_c');
  assert.strictEqual(cat.safeVersion(''), '');
});

t('EC4 安装目录与 bin 目录按运行时展开正确', () => {
  const ud = 'C:\\Users\\x\\AppData\\Roaming\\核核工具箱';
  const nodeRt = cat.findRuntime('node');
  const jdkRt = cat.findRuntime('jdk');
  const pyRt = cat.findRuntime('python');
  const nodeDir = cat.installLayout(ud, nodeRt).dir;
  /* 锁的是：安装目录不在 userData/envs 下 —— 删不干净、或误写系统目录。 */
  assert.strictEqual(nodeDir, ud + '\\envs\\node\\22.23.5');
  /* 锁的是：node 的 bin 目录指错（node.exe 在根，不在 bin/）。 */
  assert.deepStrictEqual(cat.binPaths(nodeDir, nodeRt), [nodeDir]);
  /* 锁的是：JDK 的 bin 指到根 —— java.exe 在 bin\ 下。 */
  assert.deepStrictEqual(cat.binPaths('D:\\jdk', jdkRt), ['D:\\jdk\\bin']);
  /* 锁的是：Python 少加 Scripts —— pip/黑窗口工具找不到。 */
  assert.deepStrictEqual(cat.binPaths('D:\\py', pyRt), ['D:\\py', 'D:\\py\\Scripts']);
});

t('EC5 环境变量展开：JAVA_HOME 指向安装根，其余为空', () => {
  /* 锁的是：JAVA_HOME 被写成 bin 目录 —— Maven/Gradle 会找不到 lib。 */
  assert.deepStrictEqual(cat.envPairs('D:\\jdk', cat.findRuntime('jdk')), { JAVA_HOME: 'D:\\jdk' });
  assert.deepStrictEqual(cat.envPairs('D:\\node', cat.findRuntime('node')), {});
});

t('EC6 未知运行时返回 null（不猜）', () => {
  /* 锁的是：findRuntime 对未知 id 返回一个"默认项" —— 安装流程会装错东西。 */
  assert.strictEqual(cat.findRuntime('nope'), null);
  assert.strictEqual(cat.findRuntime(null), null);
});

done();