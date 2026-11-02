# Restart Manager 注册目录会整批返回 ERR 5

## 现象

给 `RmRegisterResources` 传**目录**（而不是文件）时，返回 `ERROR_ACCESS_DENIED(5)`，
而且整批失败 —— 同一批里那些正常文件的占用信息也一条都拿不到。

用户侧的表现是「文件占用解锁」工具对一个目录查询，返回一个错误码，
而不是「没有进程占用」。这两个结论天差地别：前者说明查询失败了，
后者会让用户以为文件真的没人占着，然后去删一个删不掉的文件。

## 实测方法

用 `ipc/dir-acl-links.js` 的 `rmQueryLockers` 分别喂：

1. 纯文件列表（全存在的 .txt）；
2. 纯目录列表；
3. 混合列表（一个目录 + 几个文件）。

第 1 组正常返回，第 2、3 组返回 `ERR\tregister\t5`。把目录换成文件后立刻恢复。

## 结论

- `RmRegisterResources` 只接受**文件**路径。**这是 API 语义，不是权限问题** ——
  即使以管理员身份运行，注册目录仍然返回 5。
- 一批里混进一个目录，整批作废。所以必须**在调用之前**把目录过滤掉。
- 反过来说，不能把 `ERR` 行当成「空列表」处理：那样用户会看到"没占用"。

## 影响到的代码位置

- `ipc/dir-acl-links.js:66` `rmQueryLockers()` —— 入口处先 `pathExists` 过滤，
  并对分块内的 `ERR\t` 行单独记账（`blockErrors`），一块失败不影响其余块。
- `ipc/dir-acl-links.js:81` —— 拼 `Add-Type` 的位置，紧邻分块循环。
- `lib/rm-lockers.js:100` —— C# 侧 `if (rc != ERROR_SUCCESS) return "ERR\tregister\t" + rc;`
  这一行是「如实回报」的落点，被 `scripts/test-rm-lockers.js` 锁住。
- `lib/dir-move.js:200` —— `lockedPaths` 非空时的文案：只能说「N 个**进程**」，
  不能说「N 个文件」（RM 拿不到路径↔进程的对应关系）。
