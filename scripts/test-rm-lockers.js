'use strict';
/* lib/rm-lockers.js 的契约测试。
 *
 * ============ 为什么这里只能测到「常量契约」这一层 ============
 * 这个模块**只导出一个东西**：`FILES_CS`，一段内嵌的 C# 源码字符串。
 * 真正的查询逻辑（RmStartSession → RmRegisterResources → RmGetList）写在
 * 那段 C# 里，由 PowerShell 的 Add-Type 现场编译执行；JS 侧只负责把它拼进
 * 命令行脚本。也就是说：
 *   · JS 里没有可调用的纯函数 —— 没有入参、没有返回值，无从单测；
 *   · 要真跑一遍 RmGetList 得先有一个被独占的文件（需要真进程占用它），
 *     而且结论随机器状态变化 —— 那是 e2e 的活，不是单元测试。
 * 所以这一组只能锁住「拼进去的那段 C# 是否完整、是否还保留着几条关键约束」。
 * 这些约束每一条都对应一个**真实的 Windows API 陷阱**，删掉任意一条都会
 * 让功能静默降级（返回空列表 = 用户以为"没有进程占用"）。
 *
 * 更上层的覆盖在：
 *   · scripts/test-file-unlock-e2e.js  —— 端到端：真进程占用 → 能查出来
 *   · scripts/test-acl-repair.js       —— 诊断/修复链路
 * 本文件补的是它们都覆盖不到的「源码退化了但 e2e 恰好没踩到」这一层。
 *
 * ============ 历史上这里出过什么 ============
 * 「注册目录整批 ERR 5」：RmRegisterResources 对**目录**返回
 * ERROR_ACCESS_DENIED(5)，而且是整批失败 —— 只要列表里混进一个目录，
 * 同一批里所有正常文件的占用信息也一起没了。修法是在上层先过滤成文件
 * （见 ipc/dir-acl-links.js 的 rmQueryLockers 注释）。本文件锁住"C# 侧必须把
 * 注册失败如实回报"，否则上层永远不知道该过滤什么。
 */
const assert = require('assert');

const { t, done, readSrc } = require('./lib/harness');
const { FILES_CS } = require('../lib/rm-lockers');

t('FILES_CS 是一段可用的 C# 源码（有命名空间、类、方法）', () => {
  assert.strictEqual(typeof FILES_CS, 'string', 'FILES_CS 应当是字符串');
  assert.ok(FILES_CS.length > 2000, 'C# 源码太短了（实际 ' + FILES_CS.length + ' 字符），可能被截断');
  assert.ok(/namespace\s+HeheFiles\s*\{/.test(FILES_CS), '缺命名空间 HeheFiles');
  assert.ok(/public\s+static\s+string\s+Lockers\s*\(/.test(FILES_CS), '缺入口方法 Lockers(string[] paths)');
});

t('三个 WIN32 常量保持头文件里的原值（改小会截断名字，改大会越界）', () => {
  /* 这三个值不是"我们挑的"，是 rstrtmgr.h 里的固定定义。
   * 写成断言是因为它们是**魔数**：后来者看到 32 / 255 / 63 很可能
   * 以为是随手写的，顺手"统一成一个常量"——那会直接读越界或截断。 */
  const want = [
    ['CCH_RM_SESSION_KEY', 32],
    ['CCH_RM_MAX_APP_NAME', 255],
    ['CCH_RM_MAX_SVC_NAME', 63],
  ];
  for (const [name, val] of want) {
    const re = new RegExp('const\\s+int\\s+' + name + '\\s*=\\s*(\\d+)');
    const m = re.exec(FILES_CS);
    assert.ok(m, '找不到常量 ' + name);
    assert.strictEqual(Number(m[1]), val,
      name + ' 必须是 ' + val + '（WIN32 头文件定义），实际 ' + m[1]);
  }
});

t('注册失败会如实回报错误码（否则上层不知道该过滤什么）', () => {
  /* 锁的是：注册目录整批 ERR 5 这个历史缺陷。
   * RmRegisterResources 返回非 0 时必须把码值带出去，绝不能当成"空列表"。
   * 一旦这里被改成 `if (rc != 0) return ""`，上层就再也分不清
   * 「没有进程占用」和「查询失败」——用户会看到"没占用"，然后删不掉文件。 */
  assert.ok(/if\s*\(\s*rc\s*!=\s*ERROR_SUCCESS\s*\)\s*return\s*"ERR\\tregister\\t"\s*\+\s*rc/.test(FILES_CS),
    '注册失败没有回报 ERR+错误码（会被误当成"没有占用"）');
  assert.ok(/if\s*\(\s*rc\s*!=\s*ERROR_SUCCESS\s*\)\s*return\s*"ERR\\tlist\\t"\s*\+\s*rc/.test(FILES_CS),
    '取列表失败没有回报 ERR+错误码');
});

t('ERROR_MORE_DATA 分支存在（第一次调用只问数量）', () => {
  /* RmGetList 的固定用法：第一次传空数组，它返回 ERROR_MORE_DATA(234)
   * 并给出 needed；必须按 needed 重新分配再取一次。
   * 少了这一步，拿到的永远是空列表（rc 不是 SUCCESS，被上面的分支挡掉），
   * 表现就是"永远查不到占用"。 */
  assert.ok(/ERROR_MORE_DATA/.test(FILES_CS), '缺 ERROR_MORE_DATA 常量');
  assert.ok(/if\s*\(\s*rc\s*==\s*ERROR_MORE_DATA\s*\)/.test(FILES_CS),
    '缺「先问数量再重取」的分支');
  assert.ok(/new\s+RM_PROCESS_INFO\s*\[\s*needed\s*\]/.test(FILES_CS),
    '没有按 needed 重新分配数组');
});

t('RmEndSession 在 finally 里（系统上限 64，泄漏会耗尽）', () => {
  /* 系统的 Restart Manager session 上限是 64 个。这个 C# 方法每次调用都会
   * RmStartSession，如果 RmEndSession 不在 finally 里，任何一次异常路径
   * 都会漏掉一个 session —— 跑几十次之后整个功能就再也起不来了，
   * 而每次单独调用看起来都"正常"。 */
  const finallyIdx = FILES_CS.lastIndexOf('finally');
  const endIdx = FILES_CS.lastIndexOf('RmEndSession');
  assert.ok(finallyIdx > 0, '没有 finally 块');
  assert.ok(endIdx > finallyIdx, 'RmEndSession 不在 finally 块里（异常路径会泄漏 session）');
});

t('Tab 分隔的输出格式与上层解析对得上', () => {
  /* 上层（ipc/dir-acl-links.js 的 rmQueryLockers）按 '\t' 切分：
   *   pid \t name \t type
   * 而且是 `line.split('\t')` 后取 p[0]/p[1]/p[2]。
   * 这里锁住 C# 侧 Append 的顺序，以及**名字里的 Tab 必须被替换掉**——
   * 进程名理论上可以含 Tab（虽然极罕见），不替换会让一行的字段数变成 4，
   * 于是 type 读到垃圾、pid 解析成 NaN 被丢弃。
   * 另外 ERR 行的前缀是两条固定字符串，上层用 /^ERR\t/m 判断。 */
  assert.ok(/Append\(p\.Process\.dwProcessId\)\s*\.Append\('\\t'\)/.test(FILES_CS),
    '输出的第一列不是「pid + Tab」');
  assert.ok(/Replace\('\\t',\s*'\s*'\)/.test(FILES_CS),
    '进程名里的 Tab 没有被替换（会让字段数错位）');
  /* ERR 前缀必须能在行首匹配到，所以它们必须各自占一整行 */
  assert.ok(/"ERR\\tregister\\t"/.test(FILES_CS), 'register 错误前缀变了');
  assert.ok(/"ERR\\tlist\\t"/.test(FILES_CS), 'list 错误前缀变了');
  /* 上层的正则 /^ERR\t/m 依赖这两条前缀出现在行首
   * 锁的是：C# 侧与 JS 侧的输出协议漂移——两边分别改过之后，
   * 「ERR 行被当成正常行解析」会让一次查询失败显示成「没有进程占用」，
   * 而那正是用户最需要看到错误的一刻。 */
  assert.ok(/\^ERR\\t/.test(readSrc('ipc/dir-acl-links.js')),
    '上层的 ERR 行匹配规则变了，与 C# 侧不再对应');
});

t('应用名与服务名的取值规则：服务优先用短名', () => {
  /* 服务类型时，strAppName 往往是 "Service: xxx" 这类展示名，
   * strServiceShortName 才是用户能在服务管理器里搜到的名字。
   * 这条在注释里写着，这里把它锁住，避免"顺手简化"。 */
  assert.ok(/ApplicationType\s*==\s*1\s*\?\s*"service"\s*:\s*"app"/.test(FILES_CS),
    '服务/app 的类型判定变了');
  assert.ok(/type\s*==\s*"service"\s*&&\s*p\.strServiceShortName\.Length\s*>\s*0/.test(FILES_CS),
    '服务没有优先用短名');
});

done();
