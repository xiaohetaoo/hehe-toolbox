# 第二轮审查修复记录

本记录对应第二轮审查的 F01–F10。第一轮目录搬家、解压路径、认证加密与临时文件保护的改动继续保留。

| 编号 | 修复后的行为 | 回归验证 |
| --- | --- | --- |
| F01 | 拒绝页面发起的文档导航；IPC 只接受应用页面的主框架；权限检查同时核对页面来源。 | `test-window-security.js`、`test-window-security-e2e.js`，后者使用真实隐藏 Electron 窗口。 |
| F02 | `file:unlock` 与 `proc:kill` 共用 `process-kill` 门禁，工具能力说明同步登记。 | `test-window-security.js`，真实 IPC 包装及模拟处理器。 |
| F03 | 续传携带 Range/If-Range，校验实体标识和 Content-Range；资源换版、416 或无验证器时重下；释放句柄后再重试与清理。 | `test-download-entity.js`，本地 HTTP 服务模拟断流、换版、范围错误、压缩响应和取消。 |
| F04 | adm-zip 升级至 0.6.1，修复零声明大小的无界膨胀；解压内容长度必须等于声明大小。 | `test-archive-resources.js`，伪造 ZIP 声明为零但压缩数据包含 4 MiB 内容，同时验证真实空文件兼容。 |
| F05 | 7z 解压前读取并检查完整目录；解压期间检查实际大小、条目数、深度和链接，超限或超时终止；提交前比较预检与实际文件清单。 | `test-archive-resources.js`，限额使用模拟进程；普通/加密包使用真实 7za 在任务临时目录解压。 |
| F06 | 更新文件绑定主进程的资产名称、目录、大小及可用的 SHA-256；页面不能修改更新缓存；无发布摘要也检查大小和 PE 头。替换脚本在复制前重验大小和摘要，复制后核对摘要。 | `test-update-file.js`，生成脚本并检查，实际替换不执行。 |
| F07 | 录屏会话在启动、暂停、恢复、停止期间互斥，并绑定发起窗口；暂停会话不能被第二次开始覆盖。停止分段后取消强制结束计时器。 | `test-media-session.js`，模拟子进程，验证暂停后恢复并保存全部分段。 |
| F08 | 视频静音只添加 `-an`，`-vn` 只用于纯音频输出。 | `test-media-session.js`；设置 `HEHE_TEST_FFMPEG` 后额外对合成视频运行真实 FFmpeg，并用 ffprobe 检查输出流。 |
| F09 | JSON 排序使用显式数据属性构造，保留 `__proto__`、`constructor` 及嵌套内容。 | `test-media-session.js`，排序后 JSON 往返。 |
| F10 | 非递归 ACL 授权不添加 `(OI)(CI)`，只在递归模式授予子项继承权限。 | `test-acl-repair.js`，比较命令参数，不修改真实权限。 |

## 验证边界

提交 `0.8.0-1` 前的验证结果：138 个单元测试脚本完成，1541 项通过，2 个环境相关脚本跳过；真实隐藏 Electron 专项通过；启用 FFmpeg 的媒体测试 5 项通过。类型检查通过，lint 无错误和警告（已清理多余屏蔽注释），版本与安装包命名检查通过，`git diff --check` 通过。已执行的测试与原断言数基线比较，没有覆盖数量下降。

- 7z 的实际输出检查为约 100 ms 一次的轮询，可以在发现超限时终止进程；它不是操作系统级磁盘或内存硬配额，停止前可能多输出一个检查周期的数据。
- 旧版 Release 缺少发布摘要时，大小及 PE 校验不能提供发布者级密码学认证；本次计算的摘要用于防止校验后的文件变化，不代替发布摘要。
- 不执行真实关机、结束用户进程、修改 ACL、采集录屏设备或更新程序替换；这些操作通过模拟依赖、命令参数和生成脚本验证。
- 单元测试中 `test-packaged-assets.js` 和 `test-video-trim.js` 因缺少各自要求的环境而跳过，不能据此宣称已经完成发布包及所有媒体环境的端到端验证。

验证命令：

```text
node scripts/run-tests.js --unit
node scripts/test-window-security-e2e.js
npm run typecheck
npm run lint
git diff --check
```

真实静音转换验证可在提供 FFmpeg/ffprobe 的环境中运行：设置 `HEHE_TEST_FFMPEG` 为 FFmpeg 可执行文件绝对路径，再运行 `node scripts/test-media-session.js`。测试只创建并处理临时合成媒体。
