# 参与开发

本文只写**这个仓库特有**的规矩。通用的 JS / Electron 惯例不重复。

很多规矩背后都有一次真实的翻车，那些细节在 [`docs/decisions/`](docs/decisions/) 里。
本文只给结论和最短的理由；想深究就顺着链接去看。

---

## 快速开始

```bash
npm ci                      # 首次
npm start                   # 跑起来（electron .）
npm test                    # 全部测试（约 4 分钟）
npm run test:unit           # 只跑纯逻辑（约 25 秒，改 lib/ 时用这个）
npm run lint                # ESLint
npm run typecheck           # tsc -p jsconfig.json（checkJs，不出产物）
```

CI 会跑：语法检查 → lint → 类型检查 → 版本格式 → 工具数 → 全部测试 →
断言数守卫 → 冒烟测试。**本地把 `npm test`、`npm run lint`、`npm run typecheck`
跑绿，CI 基本就绿了。**

---

## 项目结构

```
main.js            主进程入口。IPCs 在这里注册，但大部分域已经搬出去了
preload.js         contextBridge 暴露给渲染层的 API
ipc/               从 main.js 搬出来的 IPC 域（每个文件一个域）
  dir-acl-links.js   目录搬家 / 权限修复 / 链接
  media-ffmpeg.js    ffmpeg / 屏幕录制 / 目标体积
  fs-ops.js          文件读写 / 哈希 / 加密 / 分割 / 去重 / 压缩
lib/               纯函数。能单测的都放这里
js/                渲染层（无打包器，靠 <script> 顺序加载）
  tools/             每个工具一个文件，通过 register({...}) 自注册
scripts/           测试与工程脚本
  lib/               测试共用助手（harness / src-scan / test-fs / ...）
docs/decisions/    每个「为什么不这么做」的决策记录
```

**判断一段代码该放哪：**

- 不碰 Electron、不碰 IPC、只做数据变换 → `lib/`
- 是某个域的一组 IPC handler → `ipc/<域>.js`
- 是渲染层的一个工具页 → `js/tools/`
- 剩下的（窗口、托盘、生命周期、跨域的胶水）→ `main.js`

---

## 测试：几条必须知道的规矩

### 用例要写在 `done()` 之前

harness 默认是 **deferred** 模式：`t()` 在**注册时**就执行同步用例，
`done()` 负责汇总并 `process.exit()`。所以**声明顺序有语义**：

```js
t('用例', () => { ... });   // 执行
done();                     // 汇总 + exit
t('用例', () => { ... });   // 永远不会执行，报告里看不出来
```

这条踩过：`test-media-ffmpeg.js` 有两条用例写在 `done()` 后面，从未跑过，
而报告一直显示全绿。详见 [cases-must-precede-done.md](docs/decisions/cases-must-precede-done.md)。

### 一条用例都没注册 = 失败，不是通过

前置条件不满足时想「跳过」，必须显式打印以 `SKIP ` 开头的行，
不能靠 `done(); return;` 静默收尾。CI 的 grep 抓的是 `^(FAIL|SKIP) `。
详见 [zero-tests-registered-must-fail.md](docs/decisions/zero-tests-registered-must-fail.md)。

### 优先写行为断言，其次才是源码断言

源码断言（`assert.ok(/xxx/.test(mainSrc))`）是在「这段代码长什么样」上做约束，
重构时会误报一片。只有以下情况才用它：

- 要验的东西需要真实 Electron / 真实设备 / 竞态才能观察到
- 要验的是**依赖关系**（比如「主进程用的是 lib 里的共享实现，不是自己复制的副本」）

写源码断言时，**上方 3 行内必须有一句 `锁的是……`**，说清锁的是哪个回归、
为什么不能用行为断言替代。元测试会检查这一点（见下）。

### 读源码要用 `readSrc` / `readTree` / `readMain`

不要裸 `fs.readFileSync('main.js')`：

- 这三个助手会自动剥注释（否则注释里出现的示例代码会被当成真代码）
- `readMain()` 会拼接 `main.js + ipc/*.js`

**最后这点很关键**：域搬到 `ipc/` 之后，只读 `main.js` 的断言会变成永久假红，
而假红到最后就是整段被忽略。改代码位置时，记得同步改测试的读取位置。

确实不能改的（读测试自己生成的临时文件、读构建产物），要登记到
`scripts/source-assertions-baseline.txt` 并写明理由。

---

## 三道「元检查」

仓库里有几道检查是**检查测试本身的**，改测试时容易撞到它们：

| 检查 | 它防什么 | 撞到了怎么办 |
|---|---|---|
| `test-source-assertions.js` | 源码断言越写越多、且没写清在锁什么 | 补 `锁的是……`，或改写成行为断言，或登记基线 |
| `test-test-map.js` | 某个 lib 模块没有测试 | 给它写测试（白名单尽量别加） |
| `check-assertion-count.js` | 某个测试文件悄悄少了一半用例 | 有意删就 `npm run test:count:write` 重拍基线 |

**最后一道要特别说明**：它比对的是「每个文件的 PASS 条数」，
允许**变多**、不允许**变少**。少了必须显式重拍基线 —— 那一步会出现在 diff 里，
评审时能看见「这次真的少测了 N 条」。

本机环境不满足（缺第二块盘、没有 ffmpeg、无交互桌面）时，那些测试会打印 `SKIP`，
守卫会放行但**逐条列出来**。所以看到「PASS」时也要瞄一眼下面的跳过列表 ——
那不代表全测过了。

---

## 加一个 IPC 通道

1. 在 `main.js` 或对应的 `ipc/*.js` 里 `handle('域:动作', async (e, ...args) => {...})`
2. 渲染层用 `window.api.invoke('域:动作', ...)` 调用
3. 如果它属于高危能力（删文件、改注册表、关机…），**加到 `CAP_GATED_CHANNELS`**

**关于高危门禁**：判定逻辑在 `main.js` 的 `handle` 包装层里，不在各个 handler 内部。
搬走的模块用的是**注入进来的 handle**，所以门禁照常生效 ——
**不要在模块里再实现一遍**，两处判定迟早会分叉。

`test-ipc-channels.js` 会检查「注册了但没人调用」和「渲染层调了但没注册」两个方向。

---

## 加一个工具页

1. 在 `js/tools/` 下新建文件，写 `register({ id, name, module, icon, desc, keywords, render(page) })`
2. 在 `index.html` 里加 `<script src="...">`（顺序：在 `js/registry.js` 之后）
3. 有耗时操作的，用 `window.ui.guard(fn)` 包一层防重入

CI 会统计 `register({` 的数量，少于 90 个直接失败（防批量误删）。

**多语言**：界面文案不要硬编码中文，走 `test-i18n-coverage.js` 检查的那套机制。

---

## 提交与发布

提交信息用中文，第一行说清「改了什么、为什么」。改动涉及取舍的，
在 `docs/decisions/` 里补一篇 —— **写清当时量到的数字和否掉的方案**，
不要只写结论。

发布流程：

```bash
# 1. 升版本（注意：version:bump 只打印，不写文件）
npm run version:bump        # 输出 0.3.10
# 手工改 package.json 的 version

# 2. 写发布说明
#    docs/release-notes/v0.3.10.md（会作为 Release 正文）

# 3. 本地验证并构建
npm run lint && npm run typecheck && npm test
npm run dist                # 产物落在 dist/

# 4. 推送，等 CI 绿，再打 tag
git push origin main
git tag -a v0.3.10 -m "核核工具箱 v0.3.10"
git push origin v0.3.10     # 触发 Release 工作流
```

**顺序很重要：先等 CI 绿再打 tag。** tag 一旦推送就会触发完整的构建+发布，
打出去就收不回来了。

发版前确认 `dist/` 里只有**当前版本**的产物 —— 两份产物校验脚本会读第一个 zip，
多版本共存时会校验到旧包。

---

## 平台限制

这个项目是 Windows 专属的，很多实现细节来自 Windows 的怪癖，
每一条都有决策记录，改之前先看一眼：

- [windows-rename-overwrites.md](docs/decisions/windows-rename-overwrites.md)
- [icacls-date-serialization.md](docs/decisions/icacls-date-serialization.md)
- [restart-manager-rejects-directories.md](docs/decisions/restart-manager-rejects-directories.md)
- [restart-manager-has-no-file-to-process-mapping.md](docs/decisions/restart-manager-has-no-file-to-process-mapping.md)
- [junction-needs-no-symlink-privilege.md](docs/decisions/junction-needs-no-symlink-privilege.md)
- [powershell-newline-is-statement-separator.md](docs/decisions/powershell-newline-is-statement-separator.md)
- [global-textdecoder-patch-needs-child-process.md](docs/decisions/global-textdecoder-patch-needs-child-process.md)

---

## 几条经验（都是踩出来的）

1. **删除的边界要由具体文本决定，不能由「看起来属于它」决定。**
   自动清理脚本两次误删：一次把测试用例当死代码删了，一次把函数上方的说明注释
   连同函数一起吃掉。后者靠 `git show HEAD:<path>` 才救回来。

2. **「反正一直红」的检查等于没有检查。**
   两份产物校验脚本写完后从没被调用过，里面的断言过期了也没人知道。
   接进自动化流程才算真的存在。

3. **假绿的形态比假红多。**
   假红会有人去修，假绿不会。断言「看起来在测」是最危险的状态 ——
   改断言时问一句：把被测代码删掉，这条会红吗？

4. **测不了行为时才退到源码断言，并且写清为什么。**
   半年后的你看不懂当初为什么只查了个正则。
