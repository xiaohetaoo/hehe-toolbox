# 删 junction 不需要 SeCreateSymbolicLinkPrivilege，但创建需要

## 现象

在**非管理员**账户下：

- `fs.symlinkSync(target, link, 'junction')` —— **成功**；
- `fs.symlinkSync(target, link, 'dir')` —— 需要「创建符号链接」特权，
  普通用户失败（`EPERM`）。

也就是说 junction 与符号链接在权限要求上不是一回事，尽管
`lstat().isSymbolicLink()` 对两者都返回 `true`。

## 实测方法

用普通用户（非提权）在 `%TEMP%` 下分别建 `'junction'`、`'dir'`、`'file'`
三种链接，记录 errno；再用 `fs.readlinkSync` 与 `lstatSync` 观察
`isSymbolicLink()` 与 `isDirectory()` 的组合。最后用 `fs.rmSync(link)`
（不带 `recursive`）删链接，确认目标目录仍在。

Windows 的 reparse point tag：junction 是 `0xA0000003`，
符号链接是 `0xA000000C`。Node 的 `lstat` **不暴露**这个 tag，
所以想区分两者必须自己读 reparse point。

## 结论

- 本项目**只用 junction** 做目录搬家：它不需要特权，覆盖了绝大多数场景。
- **不能用 `realpath` 做删除判据。** `realpath(junction)` 会解析到目标，
  于是「删这个路径」变成「删那个目标」——用户的数据就没了。
  必须用 `lstat` 判断它是不是链接。
- `fs.rmSync(link, { recursive: true })` 对 junction 是**安全的**：
  Node 会识别 reparse point，只删链接本身，不会跟进目标。
  （这一点与「手写递归删除」相反：自己实现的话一定会跟进。）
- 区分 junction 与符号链接要读 reparse point，不能靠 `lstat`。

## 影响到的代码位置

- `lib/links.js:15` —— 顶部注释讲三种删除方式（`rmSync recursive` /
  `unlink` / `rmdir`）在 junction 上的不同结果。
- `lib/links.js:32` —— `0xA0000003` 这个 tag 常量与它的来源。
- `lib/links.js` 的 `linkStat()` —— 判断「是不是链接」的唯一入口，
  明确不调用 `realpath`。
- `scripts/test-links.js` / `scripts/test-dir-move-e2e.js` —— 用真目录验证
  「删链接不删目标」。
