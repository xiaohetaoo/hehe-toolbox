# 测试脚本一条用例都没注册时，退出码必须是 1

## 现象

有脚本的前置探针失败时走 `done(); return;`（例如 `test-tool-i18n-e2e`
没拿到 Electron 落盘的 `TI18N`）。那时 **0 条用例被注册**，harness 打印

```
结果: 0 通过 / 0 失败
```

并以 **exit 0** 结束。CI 的失败抓取是 `grep -E '^(FAIL|SKIP) '`，
一条输出都没有 → 看起来全绿。

实测确认过这个形态：一个只 `require(harness); done();` 的脚本
输出「0 通过 / 0 失败」、退出码 0。

## 实测方法

```js
// t-zero.js
const { done } = require('./scripts/lib/harness');
done();
```

```
$ node t-zero.js; echo $?
结果: 0 通过 / 0 失败
0
```

## 结论

- 这正是「CI 静默少跑」最隐蔽的一种：**不是测试失败，是测试消失了**。
- 所以 harness 的出口处硬性要求至少注册过一条用例；否则打印以
  `FAIL ` 开头的原因并 `exit 1`。
- 想表达「环境不满足、主动跳过」的脚本必须**显式打印一行以 `SKIP ` 开头**
  的日志（CI 会把它当 annotation 报出来，人能看见），而不是悄悄以 0 结束。
- 为什么做成 harness 级而不是逐个脚本改：这个形态在任何「前置条件不满足
  就提前收尾」的分支上都可能出现，逐处防守必然会漏。收在出口处，
  新增脚本自动受保护。
- 「主动跳过」时也不能只是静默 exit 0 —— 跳过本身要可见。

## 影响到的代码位置

- `scripts/lib/harness.js:200` `doneAsync()` —— `pass + fail === 0` 的硬性拦截。
- `scripts/test-dir-move-e2e.js:37` —— 本机没有第二块可写磁盘时，
  原来引用了一对**从未声明**的 `pass`/`fail`（脚本用的是 harness，
  没有本地计数器），于是抛 `ReferenceError: pass is not defined`。
  现在改成打印显式 `SKIP ` 行 + `done()`。
- `.github/workflows/ci.yml` —— 失败抓取规则 `grep -E '^(FAIL|SKIP) '`，
  是上面两条设计的前提。
