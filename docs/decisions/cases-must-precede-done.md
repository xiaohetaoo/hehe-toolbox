# 用例必须写在 `done()` 之前 —— 否则它们永远不跑

- 日期：2026-11-03
- 涉及：`scripts/test-media-ffmpeg.js`（已修）、`scripts/lib/harness.js`
- 触发：修 P4 时顺手扫出来的

## 现象

`scripts/test-media-ffmpeg.js` 的 `done()` 写在**第 489 行**，而 7a / 7b
两条用例定义在它后面（491 / 506 行）。报告显示：

```
结果: 18 通过 / 0 失败
```

看着全绿。但 7a / 7b 一次都没执行过 —— 它们连注册都没来得及。

## 为什么

harness 的默认模式是 **deferred**：`t()` 在注册时就立即执行同步用例，
`done()` 负责汇总并 `process.exit()`。所以**声明顺序是有语义的**：

```js
t('...', () => { ... });     // 执行
done();                      // 汇总 + exit(0/1)
t('...', () => { ... });     // 永远不执行
```

`done()` 里的 `process.exit()` 不会给后者留任何机会。

## 与另一个已知坑的关系

这跟 `docs/decisions/zero-tests-registered-must-fail.md` 是同一族问题的两个方向：

- **那个坑**：0 条用例注册 + `done()` → 静默 exit 0（已由 harness 兜住，改成 FAIL）
- **这个坑**：N 条用例注册 + `done()` → 后面那些**消失**，报告仍显示「全部通过」

两者的共同点是「测试消失了而不是失败了」，而 CI 的 `grep -E '^(FAIL|SKIP) '`
对消失没有任何反应。

## 已经排除了的误报

扫全仓 `scripts/` 有 5 个文件在 `done()` 之后还有 `t()`，其中 4 个是**合法**的：

| 文件 | 为什么合法 |
|---|---|
| `test-harness.js` | 它就是在测 done 语义本身 |
| `test-dir-move-e2e.js` | `done(); return;` 提前收尾，后面是 return 之后不可达的主流程 |
| `test-links.js` | 同上，`if (…) { done(); }` 分支 |
| `test-tray-i18n.js` | 同上，`if (!fs.existsSync(ELECTRON)) { done(); }` 提前 SKIP |

判据不是「`done()` 之后还有没有 `t()`」，而是**那个 `done()` 是否在无条件路径上**。
上面 4 个都在 `if` / `return` 之后，只有 `test-media-ffmpeg.js` 的 `done()`
在顶层无条件执行 —— 那才是真缺陷。

## 修法

把 `done()` 挪到文件最后，并在旁边写明它必须在最后。没有做自动化检查：
这 4 个合法形态会让「`done()` 后有 `t()` 就判红」的规则一直误报，
而误报的检查迟早会被关掉。
