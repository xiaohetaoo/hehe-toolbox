# hehe-toolbox（核核工具箱）项目约定

> 工作区：`D:\zcode\hehe` · 版本：`0.9.3` · 更新：2026-11-21
> 本文件记录**项目重要事项与协作约定**（协作规则第 3 条）。
> 完整交接文档在 `D:\dsh\hehe-tool.md`（架构、逐域说明、踩坑大全、发版流程）。

## 一、协作约定（用户 2026-11-18 明确，2026-11-21 补充第 5、6 条）

1. **任何上传到网络的操作都要经过用户同意**
   - 包括 `git push`、推送 tag、发 Release、上传任何文件到网络。
   - “这次先同意”只对那一次有效；下一次仍需明确许可。
   - 本地 commit 不受限，但推送前必须取得许可。
2. **不要乱往工作区外放文件；临时文件记得删除**
   - 临时产物只放工作区内（`.tmp-*` 等临时目录，用完即删）。
   - 允许清理：`.tmp-*/`、`reports/`、`.shots/`、`*.log`（测试/调试产物，可重建）。
   - **不要删**：`dist/`（用户要求的产物固定位置）、`node_modules/`。
   - 例外：告警/审查文档等长期资料放工作区 `docs/`；用户指定的外部文档
     （如 `D:\dsh\hehe-tool.md`）按用户要求维护。
3. **工作区要有 `项目名称.md` 记录重要事项与约定** —— 即本文件。
4. **版本号规则**（见下节）。
5. **工具或功能坏了、解决不了要向用户报告** —— 不静默绕过，不把失败伪装成成功。
6. **不要默认用户什么都会** —— 专业术语首次出现要解释（例如：IPC = 进程间通信，
   portable = 免安装便携版，artifact = 构建产物）。

## 二、版本号规则（2026-11-18 修订，覆盖旧规则）

格式 `x.y.z`，从 `0.0.1` 开始：

- **末位（z）只能是 0–9**，满 10 向中位进 1：`0.0.9 → 0.1.0`、`0.1.9 → 0.2.0`、
  `0.0.14 → 0.1.4`。
- **中位（y）可以 ≥10**，**不**向最大位进位：**`0.9.9 → 0.10.0`**（不是 1.0.0）、
  `0.10.9 → 0.11.0`、`0.99.9 → 0.100.0`。
- **最大位（x = major）只有得到用户明确允许才能升**：脚本必须同时给
  `--major` 与 `--approved`，否则拒绝（`node scripts/version.js --major --approved --write`）。
- 校验/预览/写入：
  ```bash
  node scripts/version.js              # 校验 package.json 当前版本
  node scripts/version.js --next       # 预览下一版（只动末位/中位）
  node scripts/version.js --next --write
  node scripts/version.js --major --approved --write   # 升最大位（需用户允许）
  ```
- 历史版本按旧规则发布（0.8.9 → 0.9.0），**新规则从 0.9.1 起生效**，不回改历史。

## 三、发版流程（与协作约定 1 配合）

1. 本地全绿：`npm test`（205 脚本 / 2265 断言；dist 与 package 同版本时 2292）+ `npm run lint` + `npm run typecheck`；
2. 升版本：`node scripts/version.js --next --write` + 同步 `package-lock.json`；
3. 写 `docs/release-notes/vX.Y.Z.md`（≥400 字）；
4. commit → **先问用户** → push → 等 CI 绿；
5. **再问用户** → `git tag -a vX.Y.Z` → push tag → Release workflow 自动构建发布；
6. 发布后：下载产物到 `dist/` 并核对 SHA256、跑 `verify-fixes-in-package.js`、
   更新 `D:\dsh\hehe-tool.md` 的 0/0.2/3.1/11/12 章与断言基线。

## 四、质量门禁（改代码前必读）

- 每次改动跑针对性测试；提交前 `npm test` 全绿、lint/typecheck 0。
- 断言基线：`scripts/assertions-baseline.json`，改测试后 `npm run test:count:write` 重拍；
  守卫只允许涨、不允许悄悄变少。
- 源码断言必须写「锁的是」（SA-4）：锁哪个历史回归 + 为什么不能行为化；
  能用行为断言就别用源码断言；读源码一律走 `readSrc/readTree/readMain`（SA-3）。
- 新 IPC 通道必须同步 `lib/channels.js` + `js/channels.js`（`MIGRATION.TOTAL` 对账），
  否则 `test-channels-sync` 红。
- 受保护操作（删文件、改注册表、电源、ACL、还原点删除等）必须走
  `CAP_GATED_CHANNELS` 门禁；破坏性分支必须 fail-closed，不能默认到更破坏的选项。
- 用户可见文案会原样渲染：不要用 Markdown 星号；图标用 `window.ui.icon()` 不用 emoji。

## 五、关键文件

| 文件 | 作用 |
|---|---|
| `main.js` / `ipc/*` | 主进程与 IPC 域 |
| `js/tools/*` | 111 个工具页 |
| `lib/*` | 纯逻辑（可单测，不 require electron） |
| `scripts/` | 测试 / 构建 / 发布脚本 |
| `docs/review-round*.md` | 历轮审查记录（含证据与排除的误报） |
| `docs/release-notes/` | 每版发布说明 |
| `dist/` | 产物固定位置（勿删；当前为 0.9.3 的 Portable exe + zip） |
| `D:\dsh\hehe-tool.md` | 完整交接文档（外部，用户指定维护） |

## 六、当前状态（2026-11-21 核对）

- 版本 `0.9.3`，tag `v0.9.3` → `e6c39a8`；`HEAD` 为 `b83f161`
  （tag 之后 1 个提交：产物校验支持 0.9.3 + 系统 7z 优先）。
- 工作区干净，`main` 与 `origin/main` 同步；远端 `git@github.com:xiaohetaoo/hehe-toolbox.git`。
- `dist/` 已有 0.9.3 两个产物：
  `hehe-toolbox-Portable-0.9.3.exe`（103.9 MB）、`hehe-toolbox-0.9.3-win-x64.zip`（161.4 MB）。
- 质量门禁：最近一次全量 `206 脚本 / 2278 条断言 / 0 失败 / 4 环境跳过`（332.7s），
  lint 0、typecheck 0；断言基线 `scripts/assertions-baseline.json` = 2278。
- 工具数 111（`js/tools/*.js` 29 个文件 + `js/tools/media/` 19 个文件，registry id 111）。
- 文档：`docs/decisions/` 15 篇平台结论，`docs/review-round*.md` 12 轮审查，
  `docs/release-notes/` 39 篇；交接文档 `D:\dsh\hehe-tool.md`（81.5 KB，第 11 章已记 v0.9.3）。
- 待办：无新增；第十二轮审查结论建议后续转为「新功能提交时按需审查」。
- 文档同步：README 已更新到 206 脚本 / 2278 断言（unit 173 + ui 33），工具数 111 无漂移。
