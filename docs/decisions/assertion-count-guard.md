# 断言总数护栏：防止「测试悄悄变少」

- 日期：2026-11-03
- 涉及：`scripts/check-assertion-count.js`、`scripts/assertions-baseline.json`、`.github/workflows/ci.yml`
- 触发：审查「还有什么能提升可维护性」时发现的缺口

## 缺口

仓库里已经有两层防护，但它们都挡不住最常见的一种退化：

| 已有防护 | 它能挡住什么 | 它挡不住什么 |
|---|---|---|
| `test-test-map.js` | 某个 lib 模块**完全没有**测试文件 | 有文件、但里面只剩 3 条用例 |
| harness 的 0 用例保护 | 一个套件**一条用例都没注册** | 注册了 40 条 → 删到 10 条 |
| CI 的 `grep '^(FAIL|SKIP) '` | 失败的断言 | **消失**的断言 |

这个缺口不是理论推演 —— 它真的发生过：

> 自动化「清理未使用声明」脚本把 `test-store-health.js` 从 81 行删到 25 行，
> 86 条断言变成十几条，而 `npm test` 依然**全绿**，CI 也没有任何反应。
> 因为剩下的那些用例确实都通过了。

## 做法

跑一遍完整的 `test:unit` + `test:ui`，数出 `PASS ` 行的总数，
与 `scripts/assertions-baseline.json` 逐文件比对：

- 某文件**少了** → FAIL，列出「基线 38 → 现在 35（少 3 条）」
- 某文件**多了** → PASS，并提示把基线调大（让它跟着项目一起长）

### 为什么数 `PASS` 行，而不是数 `t()` 调用

`t()` 只是**注册**。注册了不执行恰恰是另一个真踩到的坑 ——
`test-media-ffmpeg.js` 的 7a / 7b 定义在 `done()` 之后，从未运行过，
而报告一直显示全绿（见 `cases-must-precede-done.md`）。

`PASS` 行是「真的执行且通过」的证据，与 CI 的 grep 口径完全一致。

### 为什么脚本输出里没有文件名

测试是一条条 `node script.js` 串起来的，每个脚本的输出里不含自己的名字。
所以由守卫自己在每个脚本跑之前打印一行 `@@FILE <相对路径>` 作为分隔，
再按这个分隔归属统计。这样不依赖任何脚本改输出格式。

### 为什么不打印 PASS 行的脚本要特殊处理

`test-target-e2e.js` 全程只打「第N轮 q=… / 压缩幅度 / 源图未被修改」，
结尾 `process.exit(ok ? 0 : 1)`。它的「断言数」恒为 0，在基线里看起来像
「一个测试都没跑」，而它其实做了 3 条实质判定。

对这类脚本改用**退出码**当刻度：跑成功记 1，失败记 0。
这样删掉整个文件的判定逻辑仍会掉到 0，护栏照样有效。

## 变异验证

把 `test-mojibake.js` 里 3 条用例真的删掉：

```
$ node scripts/test-mojibake.js
结果: 35 通过 / 0 失败          ← 仍然全绿，CI 不会发现

$ node scripts/check-assertion-count.js
统计到 104 个脚本，PASS 共 1267 条
FAIL  有测试文件的断言数比基线少：
  · scripts/test-mojibake.js：基线 38 → 现在 35（少 3 条）
```

恢复文件后重新校验 → PASS。护栏有效。

## 有意删除时怎么办

```
node scripts/check-assertion-count.js --write
```

这一步会修改 `scripts/assertions-baseline.json`，**出现在 diff 里**。
评审时一眼就能看到「这次真的少测了 N 条」，而不是无声无息地少掉。

## 成本

这条守卫要再跑一遍完整测试（本机约 4 分钟）。CI 里它是一个独立 step，
只有前面全部通过才执行 —— 失败时不会白跑。

`--no-run` 可以读 `reports/test-output.log` 复用上一次的输出，
但**不要**在 CI 里用它：那份日志是同一次运行留下的，读它等于没验证本次改动。

`reports/` 已加进 `.gitignore`。
