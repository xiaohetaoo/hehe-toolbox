# 全局替换 TextDecoder 会污染整个进程

## 现象

有一条测试要验证「运行时没有 GBK 解码器时要退回小样本」。
最初的写法是：在 `lib/mojibake.js` 源码前面拼一个桩

```js
globalThis.TextDecoder = class { ... };   // 假的，不认 gbk
```

写进临时文件、`require` 它、跑完 `finally` 里 `unlink` 临时文件
并 `delete require.cache[...]`。

看起来收干净了，但**桩改的是 `globalThis.TextDecoder`，没有被还原**。
实测紧接这条之后 `new TextDecoder('gbk')` 直接抛
`RangeError: Unknown encoding: gbk` —— 于是该文件后续所有用例
都在「没有 GBK 解码器」的环境里跑。

最隐蔽的是它**当时仍然全绿**：后续断言恰好不依赖 GBK 解码器的存在。

## 实测方法

在桩安装之后、用例结束之后各打印一次：

```js
try { new TextDecoder('gbk'); console.log('ok'); }
catch (e) { console.log('THROW', e.message); }
```

桩之后打印 `THROW`，而那时该文件还有 10+ 条用例没跑。

## 结论

- **改全局内建对象必须用子进程隔离**，不能用「改回来」的方式：
  只要中间任何一条路径没走到还原（异常、提前 return、异步竞态），
  污染就会泄漏到后续用例，而泄漏的表现往往是"后面的测试变绿"。
- 现在的做法：把桩拼进临时文件，用 `execFileSync` 起**子进程**跑，
  结果以 JSON 从 stdout 取回。子进程退出，全局状态自然消失。
- 再补一条**回归锁**：在本进程里断言 `new TextDecoder('gbk')` 仍能解出
  `你`（`0xC4 0xE3`）。如果哪天有人把实现改回"在本进程替换"，
  这条立刻红。

## 影响到的代码位置

- `scripts/test-mojibake.js` —— 「运行时没有 GBK 解码器时要退回小样本」
  用例，子进程 + 回归锁。
- `scripts/test-mojibake.js` 的 `cp` —— 注意顶层那个 `cp` 已经不用了
  （子进程调用改用函数内的局部 require），由 `no-unused-vars` 报出后删除。
- `lib/mojibake.js:76` `buildCommonHanzi()` —— 降级逻辑本体
  （`usable` 判据：长度够且无替换字符才采用）。
