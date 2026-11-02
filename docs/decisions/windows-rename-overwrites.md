# Windows 上 rename 会覆盖已存在的目标

## 现象

POSIX 的 `rename(2)` 在目标存在时**覆盖**目标；Windows 的
`MoveFileEx` 默认**失败**（`EPERM`/`EEXIST`）。但 Node 的
`fs.renameSync` 走的是 `MoveFileEx` + `MOVEFILE_REPLACE_EXISTING`，
所以**它也会覆盖**。

这与很多人的直觉相反，也与 `lib/destrucive` 相关注释里的早期假设相反。

## 实测方法

```js
fs.writeFileSync('a.txt', 'A');
fs.writeFileSync('b.txt', 'B');
fs.renameSync('a.txt', 'b.txt');   // 不抛
console.log(fs.readFileSync('b.txt', 'utf8'));  // 'A'
```

在 Windows 10 / Node 24 上确认：**不抛异常，直接覆盖**。

顺带实测：`fs.renameSync` **跨卷**会抛 `EXDEV`，
必须退化成「复制 + 删除」。

## 结论

- 「写到临时文件再 rename」这个原子写模式在 Windows 上**真的能覆盖**，
  不需要先删目标。这也意味着：如果目标已存在且用户不希望覆盖，
  **必须在 rename 之前自己检查**，rename 本身不会拦。
- 跨卷时 rename 会 `EXDEV`，所以 `moveFile()` 里保留了「先试 rename、
  失败再复制+删」的降级路径。
- 反过来说，「先 `rm(dest)` 再 `rename(tmp, dest)`」是**更差**的写法：
  中间那一刻两个文件都不存在，断电就全丢了。项目里曾经这么写过，
  `scripts/test-destructive.js` 有一条断言专门锁住它不许回退。

## 影响到的代码位置

- `main.js` 的 `writeFileAtomic()` —— 注释里对「Windows rename 是否覆盖」
  的描述与实测不完全一致（无害，因为走的是安全路径），
  但**行为**是对的：临时文件 + rename，不先删目标。
- `lib/fs-ops.js` 的 `moveFile()` —— 跨卷 `EXDEV` 的降级路径。
- `main.js` 的 `downloadToFile()` —— 最后一步是 `fsp.rename(tmp, dest)`，
  所以在它**之前**必须查覆盖（`net:download` 里做了）。
- `scripts/test-destructive.js` —— 「writeFileAtomic 不许先删目标」的断言。
- `scripts/test-crossdrive.js` —— 跨卷搬家的真实验证。
