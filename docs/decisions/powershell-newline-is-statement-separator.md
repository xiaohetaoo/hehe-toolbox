# PowerShell 把换行当语句分隔符，不是空白

## 现象

把一段命令拼成单个字符串传给 `powershell -Command` 时，**字符串里的换行
会变成语句分隔符**。于是：

```js
// 想传一个参数值
ps(`write-output "第一行\n第二行"`)
```

不会输出一个含换行的字符串，而是执行两条语句。同理，路径或正则里
如果混进换行，会被 PowerShell 当成两条命令。

## 实测方法

```powershell
powershell -NoProfile -NonInteractive -Command "echo a`nb"
```

输出两行 `a` / `b`，而不是 `a<换行>b`。

再试 `-EncodedCommand`（UTF-16LE base64）：换行不再是分隔符，
因为整段被当成一个已解析的脚本块。这一点用来判断「某个调用到底走的是
字符串拼接还是编码传输」。

## 结论

- 拼命令行时，**任何来自用户或文件的字符串都必须先把 `\r` / `\n` 处理掉**
  （转义、或改成 here-string / 编码传输）。
- 诊断「为什么这条命令只执行了一半」时，第一件事是看参数里有没有换行。
- `-EncodedCommand` 能规避这个问题，但它的参数是 base64，可读性差，
  本项目只在必须传多行脚本时用。

## 影响到的代码位置

- `lib/power-gate.js` —— 命令归一化时要处理多行（`headWord` 只看第一个词，
  换行会切出多个「第一个词」）。
- `ipc/dir-acl-links.js` 的 `ps()` 调用点 —— 凡是把路径拼进 `-Command`
  的地方都做了单引号转义（`''` 表示一个字面单引号）。
- `scripts/test-powergate.js` —— 有专门一组断言覆盖「换行切出的第二段命令」。
