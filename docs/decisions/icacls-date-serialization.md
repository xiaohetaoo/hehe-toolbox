# icacls 的日期序列化形态 `/Date(...)/`

## 现象

`Get-Acl` 返回的 `Owner` / 访问规则里没有日期，但 `Get-Acl` 的某些字段
（例如 `LastWriteTime`、审计条目的时间）经 PowerShell 的 JSON 序列化后
会变成 `/Date(1700000000000)/` 这种形态 —— 那是 .NET 的
`DateTime` 序列化约定（毫秒时间戳包在 `/Date(...)/` 里），不是 ISO 8601。

直接 `new Date(str)` 会得到 `Invalid Date`，界面上渲染成
`NaN-NaN-NaN`，比不显示还糟。

## 实测方法

```powershell
Get-Item C:\Windows\System32\drivers\etc\hosts | Select-Object LastWriteTime | ConvertTo-Json
```

输出里 `LastWriteTime` 的形态随 PowerShell 版本与 `-Depth` 不同：
Windows PowerShell 5.1 给 `/Date(1700000000000)/`，
PowerShell 7 给 ISO 8601。同一个项目要同时兼容两种。

## 结论

- 解析日期前必须先判形态：`/Date(<ms>)/` 用正则取毫秒，
  其余的再交给 `new Date()`。
- 取不到 / 解析失败时**显示 `-`**，不要渲染 `NaN`。
  这条写成了断言（`scripts/test-round15-fixes.js` 的「fmtBoot 防御」）。
- 判断不能写成 `if (!(n >= 0)) return '-'` —— `null >= 0` 是 `true`，
  会让空值一路走到 `new Date(NaN)`。必须用 `Number.isFinite`。

## 影响到的代码位置

- `main.js` 的 `fmtBoot()` —— 专门为 `/Date(...)/` 写的防御函数。
- `scripts/test-round15-fixes.js` —— 「/Date(ms)/ 要能解析，坏值显示 -」
  与「flat 地调 fmtDate 会把 NaN 渲染成 NaN-NaN-NaN」两条断言。
- `lib/acl-repair.js` —— 权限条目的时间字段同样走这套解析。
