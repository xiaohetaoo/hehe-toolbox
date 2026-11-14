'use strict';
/* IPC 通道名的**唯一来源**。
 *
 * ============ 为什么需要它 ============
 * 164 个通道名此前是三处独立的字符串字面量：
 *   · main.js 里 `handle('fs:read-text', ...)`
 *   · 渲染层里 `invoke('fs:read-text', ...)`
 *   · test-ipc-channels.js 用**正则扫两边源码**再做差集
 * 前两处靠人眼对齐，第三处靠文本匹配 —— 三者没有任何编译期约束。
 * 打错一个字母（`fs:read-text` vs `fs:readtext`）的表现是运行时
 * 「调用失败：No handler registered」，而这条链路没有任何测试能提前发现
 * （因为测试本身也是扫文本，两边都错成一样的就查不出来）。
 *
 * ============ 迁移策略：分域推进，不做一次大改 ============
 * 这一轮**只迁移两个域**（目录搬家 dir:、权限与链接 acl:/link:/file:who-locks），
 * 其余通道保持原样、列入下面的 TODO。理由：
 *   · 164 个通道一次性换成常量，改动面覆盖 main.js 与 20 个渲染层文件，
 *     一旦哪里漏了就是"运行时才炸"，而现有测试（扫文本）恰好抓不到 ——
 *     风险与收益不成比例。
 *   · 先拿两个域验证机制（含 lib↔渲染层的同步校验），再逐域推广。
 *
 * ============ 渲染层怎么用 ============
 * 渲染层在 contextIsolation 下**不能 require** lib/，所以另有一份
 * js/channels.js。两份必须一致，由 scripts/test-channels-sync.js 校验
 * （做法参照 test-job-prefix-sync.js：解析两边的键集合做比对）。
 * 注意：这里比 job 前缀那套更严 —— 不只比**键**，还比**值**，
 * 因为通道名拼错的表现和"键不同"一样是静默失败。
 */

/* 每个域一个分组对象。键是语义名，值是真实通道名。 */
const CHANNELS = {
  /* ---- 目录搬家（dir-* 通道）----
   * 名字与 lib/dir-move.js 的状态机对齐：precheck 只校验、move 真正执行。
   * 拆成两个通道而不是一个，是因为预检必须能在**不产生任何副作用**的前提下
   * 反复调用（用户改一下目标路径就会重查），而执行是一次性的。 */
  DIR_MOVE: {
    PRECHECK: 'dir:move-precheck',
    MOVE: 'dir:move',
  },

  /* ---- 权限与链接（acl / link / file 域）----
   * 这几组语义互相咬合：链接体检（link:scan）会调权限诊断（acl:diagnose）
   * 的同一套判据，所以放在同一组里常量化，改一处两边同步。 */
  ACL_LINKS: {
    ACL_DIAGNOSE: 'acl:diagnose',
    ACL_REPAIR: 'acl:repair',
    LINK_SCAN: 'link:scan',
    LINK_REMOVE: 'link:remove',
    /* 文件被哪个进程占用：单文件版与目录版。
     * 两个通道而不是一个，是因为 Restart Manager 的批量语义与单文件查询
     * 返回结构不同（见 lib/rm-lockers.js 顶部说明）。 */
    WHO_LOCKS: 'file:who-locks',
    WHO_LOCKS_DIR: 'file:who-locks-dir',
    /* 真正的「解锁」：结束占用文件的进程，然后重试原操作。
     *
     * 【为什么单开一条通道，而不是让渲染层连调 PROC.KILL + FS.DELETE】
     * 三步之间必须原子：① 复核占用已解除 ② 结束进程 ③ 重试删除。
     * 分开调的话，中间任何一步失败，界面都会停在一个说不清的状态
     * （进程杀了但文件还是删不掉 / 文件没了但提示失败）。
     * 而且「哪些进程允许结束」这条安全判据只能有一份 ——
     * 放渲染层就等于把它交给了可以被页面脚本影响的代码。 */
    UNLOCK: 'file:unlock',
  },

  /* ============================================================
   * v0.4.2：下面 39 组从字面量迁入，至此 168 个通道全部常量化。
   *
   * 此前这里是一段「TODO：下一轮逐域迁移」的说明加一张分布表。
   * 那套做法的前提是「一次只迁一个域」——因为迁移会连带打破二十多个
   * 测试里的 `src.indexOf("handle('通道名'")` 定位，那个耦合面比迁移
   * 本身更难处理。现在定位这件事已经收进 scripts/lib/seg-from-handler.js
   * （按通道名反查常量路径，两种写法都认），于是可以一次迁完，
   * 不必再维护一张会过期的进度表。
   * ============================================================ */

  /* ---- 应用级：窗口信息、主题/强调色/语言/热键、自启、崩溃日志入口 ---- */
  APP: {
    CRASH_CLEAR: 'app:crash-clear',
    CRASH_INFO: 'app:crash-info',
    CRASH_READ: 'app:crash-read',
    CRASH_REVEAL: 'app:crash-reveal',
    GET_AUTOSTART: 'app:get-autostart',
    GET_INFO: 'app:get-info',
    /* 把当前工具页「弹」成独立窗口（v0.6.0，标签拖出手势的后端）。 */
    OPEN_TOOL_WINDOW: 'app:open-tool-window',
    SET_ACCENT: 'app:set-accent',
    SET_AUTOSTART: 'app:set-autostart',
    SET_HOTKEY: 'app:set-hotkey',
    SET_LANG: 'app:set-lang',
    SET_THEME: 'app:set-theme',
    /* 「全局界面偏好变了」的推送（v0.6.4）。语言 / 配色 / 深浅这三项是
     * **整个应用**的偏好，但状态所有权一直在渲染层：i18n.setLang 只作用
     * 当前窗口，data-accent / data-theme 写的是当前 document 的
     * documentElement。主进程只被动收到渲染层的 SET_*，从来没有反向通道，
     * 于是已打开的独立工具窗口会一直停在旧语言、旧主色、旧明暗。
     * 这条通道就是那个反向通道：SET_LANG / SET_ACCENT / SET_THEME 三个
     * handler 写完之后各广播一次，每个窗口自己按收到的值应用。 */
    UI_PREFS_CHANGED: 'app:ui-prefs-changed',
  },

  /* ---- 开机自启项（注册表 Run 键） ---- */
  AUTOSTART: {
    DELETE: 'autostart:delete',
    DISABLED_LIST: 'autostart:disabled-list',
    ENABLE: 'autostart:enable',
    /* 只读汇总：注册表 Run + 启动文件夹 + 计划任务 + 自启服务 */
    INVENTORY: 'autostart:inventory',
    LIST: 'autostart:list',
  },

  /* ---- 剪贴板读写（文本与图片） ---- */
  CLIP: {
    READ_IMAGE: 'clip:read-image',
    READ_TEXT: 'clip:read-text',
    REMOVE_IMAGES: 'clip:remove-images',
    SAVE_IMAGE: 'clip:save-image',
    WRITE_IMAGE: 'clip:write-image',
    WRITE_TEXT: 'clip:write-text',
  },

  /* ---- 文件内容全文搜索 ---- */
  CONTENT: {
    SEARCH: 'content:search',
  },

  /* ---- 右键菜单（本项目自定义项 与 Win11 经典菜单） ---- */
  CTXMENU: {
    CLASSIC: 'ctxmenu:classic',
    CLASSIC_STATUS: 'ctxmenu:classic-status',
    LIST: 'ctxmenu:list',
    TOGGLE: 'ctxmenu:toggle',
  },

  /* ---- 高危功能门禁：开关状态与逐工具能力 ---- */
  DANGEROUS: {
    LIST: 'dangerous:list',
    SET: 'dangerous:set',
    TOOL_CAPS: 'dangerous:tool-caps',
  },

  /* ---- 系统打开/保存对话框 ---- */
  DIALOG: {
    OPEN: 'dialog:open',
    SAVE: 'dialog:save',
  },

  /* ---- 命令执行（受 CAP_GATED_CHANNELS 门禁保护） ---- */
  EXEC: {
    RUN: 'exec:run',
    STREAM: 'exec:stream',
  },

  /* ---- FFmpeg 环境与音视频处理 ---- */
  FFMPEG: {
    AUDIO_CUT: 'ffmpeg:audio-cut',
    CONVERT: 'ffmpeg:convert',
    DOWNLOAD: 'ffmpeg:download',
    FRAMES: 'ffmpeg:frames',
    /* 硬件编码能力探测（v0.6.8）。首次调用真跑三个编码器，约 1 秒，
     * 主进程内有缓存；设置页与转码页都靠它显示"当前用的是哪个编码器"。 */
    HW_PROBE: 'ffmpeg:hw-probe',
    PICK: 'ffmpeg:pick',
    PRESS: 'ffmpeg:press',
    PROBE: 'ffmpeg:probe',
    REMOVE: 'ffmpeg:remove',
    STATUS: 'ffmpeg:status',
    /* 视频裁剪（v0.5.0）。键名按字母序插在 STATUS 之后 ——
     * 这个表整体是按字母排的，新条目随手加到末尾会让 diff 变噪。 */
    TRIM: 'ffmpeg:trim',
  },

  /* ---- 文件系统（最大的一个域：读写/哈希/加密/分割/重命名/清理） ---- */
  FS: {
    CLEAN_JUNK: 'fs:clean-junk',
    DECRYPT_FILE: 'fs:decrypt-file',
    DEDUPE: 'fs:dedupe',
    DELETE: 'fs:delete',
    DELETE_EMPTY: 'fs:delete-empty',
    /* 逐层列出某个目录的直接子项及体积（空间分析器的下钻） */
    DIR_CHILDREN: 'fs:dir-children',
    ENCRYPT_FILE: 'fs:encrypt-file',
    EXISTS: 'fs:exists',
    HASH_FILE_MULTI: 'fs:hash-file-multi',
    HASH_TEXT_MULTI: 'fs:hash-text-multi',
    LIST: 'fs:list',
    MERGE_PARTS: 'fs:merge-parts',
    MKDIR: 'fs:mkdir',
    OPEN_PATH: 'fs:open-path',
    READ_FILE_B64: 'fs:read-file-b64',
    READ_TEXT: 'fs:read-text',
    RENAME: 'fs:rename',
    SCAN_EMPTY_DIRS: 'fs:scan-empty-dirs',
    SCAN_JUNK: 'fs:scan-junk',
    SCAN_TREE: 'fs:scan-tree',
    SHOW_ITEM: 'fs:show-item',
    SPLIT_FILE: 'fs:split-file',
    STAT: 'fs:stat',
    STAT_MULTI: 'fs:stat-multi',
    UNIQUE_PATH: 'fs:unique-path',
    WRITE_FILE_B64: 'fs:write-file-b64',
    WRITE_TEXT: 'fs:write-text',
  },

  /* ---- hosts 文件读写与备份还原 ---- */
  HOSTS: {
    BACKUP: 'hosts:backup',
    BACKUPS: 'hosts:backups',
    READ: 'hosts:read',
    RESTORE: 'hosts:restore',
    WRITE: 'hosts:write',
  },

  /* ---- 后台任务控制 ---- */
  JOB: {
    KILL: 'job:kill',
  },

  /* ---- 局域网扫描 ---- */
  LAN: {
    SCAN: 'lan:scan',
  },

  /* ---- 农历与公历互转 ---- */
  LUNAR: {
    L2S: 'lunar:l2s',
    S2L: 'lunar:s2l',
    /* 整月一次取（日历页专用）。原来要逐日 await 31 次串行 IPC，
     * 用户点一次「›」翻月就是 31 次往返，连续翻几个月明显卡顿。
     * 农历换算是纯计算，批量不会增加主进程负担。 */
    MONTH: 'lunar:month',
  },

  /* ---- 网络诊断（接口/公网 IP/端口/测速/下载） ---- */
  NET: {
    DOWNLOAD: 'net:download',
    HTTP: 'net:http',
    INTERFACES: 'net:interfaces',
    PUBLIC_IP: 'net:public-ip',
    SCAN: 'net:scan',
    SPEEDTEST: 'net:speedtest',
    TCP_TEST: 'net:tcp-test',
  },

  /* ---- 便签导出 ---- */
  NOTES: {
    PDF: 'notes:pdf',
  },

  /* ---- LibreOffice 文档转换 ---- */
  OFFICE: {
    CONVERT: 'office:convert',
    STATUS: 'office:status',
  },

  /* ---- 电源计划 ---- */
  POWER: {
    LIST: 'power:list',
    SET: 'power:set',
  },

  /* ---- 进程列表与结束 ---- */
  PROC: {
    DETAIL: 'proc:detail',
    KILL: 'proc:kill',
    LIST: 'proc:list',
  },

  /* ---- 二维码生成 ---- */
  QR: {
    GENERATE: 'qr:generate',
  },

  /* ---- 屏幕录制 ---- */
  REC: {
    AUDIO_DEVICES: 'rec:audio-devices',
    PAUSE: 'rec:pause',
    RESUME: 'rec:resume',
    START: 'rec:start',
    STOP: 'rec:stop',
  },

  /* ---- 定时任务 ---- */
  SCHED: {
    ADD: 'sched:add',
    LIST: 'sched:list',
    REMOVE: 'sched:remove',
    /* 一次性定时（睡眠 / 锁屏）。
     * 【为什么要有专门的通道】
     * 这两件事原来完全靠渲染层的 setInterval 计时，而 App.onCleanup 会在
     * 切页时把它清掉 —— 用户设了「30 分钟后睡眠」，去别的工具页待一会儿
     * 回来，倒计时没了、睡眠也不会发生，而界面那行「将在 30 分钟后睡眠」
     * 的承诺已经落空。关机/重启走的是系统 shutdown 计划，切页不受影响 ——
     * 同一个卡片里两种行为不一致，最容易让用户不信任。
     * 放到主进程：切页、关窗都不影响，配置持久化（重启后仍生效）。 */
    ONCE_ADD: 'sched:once-add',
    ONCE_LIST: 'sched:once-list',
    ONCE_REMOVE: 'sched:once-remove',
  },

  /* ---- 屏幕截图与取色 ---- */
  SCREEN: {
    CAPTURE: 'screen:capture',
    CURSOR: 'screen:cursor',
  },

  /* ---- 全局文件搜索（Everything 式） ---- */
  SEARCH: {
    BUILD: 'search:build',
    ENV: 'search:env',
    ES: 'search:es',
    FREE: 'search:free',
    INDEX_STATUS: 'search:index-status',
    QUERY: 'search:query',
    QUICK: 'search:quick',
  },

  /* ---- 本地静态服务器 ---- */
  SERVER: {
    START: 'server:start',
    STATUS: 'server:status',
    STOP: 'server:stop',
  },

  /* ---- 7-Zip 压缩与解压 ---- */
  SEVEN: {
    COMPRESS: 'seven:compress',
    EXTRACT: 'seven:extract',
    LIST: 'seven:list',
    STATUS: 'seven:status',
  },

  /* ---- 用系统默认程序打开 URL/路径 ---- */
  SHELL: {
    OPEN_URL: 'shell:open-url',
  },

  /* ---- 截图标注流程 ---- */
  SNIP: {
    FINISH: 'snip:finish',
    PIN_CLIPBOARD: 'snip:pin-clipboard',
    START: 'snip:start',
  },

  /* ---- 应用数据存储（settings/favorites/recents 等） ---- */
  STORE: {
    GET: 'store:get',
    HEALTH: 'store:health',
    SET: 'store:set',
  },

  /* ---- Windows 服务 ---- */
  SVC: {
    ACTION: 'svc:action',
    LIST: 'svc:list',
  },

  /* ---- 系统信息：硬件、监控、磁盘健康、回收站 ---- */
  SYS: {
    BATTERY_DETAIL: 'sys:battery-detail',
    DISK_HEALTH: 'sys:disk-health',
    HW_INFO: 'sys:hw-info',
    POWER: 'sys:power',
    RECYCLE_EMPTY: 'sys:recycle-empty',
    /* 系统还原点：列出 / 创建 / 删除（删除走「系统还原点」高危能力）/ 启停保护 / 查看占用 */
    RESTORE_CREATE: 'sys:restore-create',
    RESTORE_DELETE: 'sys:restore-delete',
    RESTORE_ENABLE: 'sys:restore-enable',
    RESTORE_LIST: 'sys:restore-list',
    RESTORE_STORAGE: 'sys:restore-storage',
  },

  /* ---- 目标体积压缩 ---- */
  TARGET: {
    COMPRESS_AV: 'target:compress-av',
    EVAL_IMAGE: 'target:eval-image',
    PLAN_IMAGE: 'target:plan-image',
  },

  /* ---- 文本编码探测与重编码 ---- */
  TEXT: {
    CAN_REENCODE: 'text:can-reencode',
    DETECT_ENCODING: 'text:detect-encoding',
  },

  /* ---- 语音合成 ---- */
  TTS: {
    SPEAK: 'tts:speak',
    VOICES: 'tts:voices',
    WAV: 'tts:wav',
  },

  /* ---- 自动更新 ---- */
  UPDATE: {
    APPLY: 'update:apply',
    /* 纯推送：启动时自动检查发现新版后通知渲染层（v0.6.8）。
     * 不注册 handle —— 渲染层只订阅，没有任何"调用"语义。见下方 PUSH_ONLY。 */
    AVAILABLE: 'update:available',
    CHECK: 'update:check',
    CLEANUP: 'update:cleanup',
    MARK_PENDING: 'update:mark-pending',
  },

  /* ---- WLAN 配置与密码 ---- */
  WIFI: {
    KEY: 'wifi:key',
    PROFILES: 'wifi:profiles',
  },

  /* ---- 主窗口与贴图/标尺辅助窗口 ---- */
  WIN: {
    CLOSE: 'win:close',
    MAXIMIZE: 'win:maximize',
    MINIMIZE: 'win:minimize',
    PIN_CLOSE: 'win:pin-close',
    PIN_MOVE: 'win:pin-move',
    PIN_RESIZE: 'win:pin-resize',
    RULER: 'win:ruler',
    RULER_CLOSE: 'win:ruler-close',
    RULER_MOVE: 'win:ruler-move',
    RULER_RESIZE: 'win:ruler-resize',
    /* 截取调用方窗口的内容区，供标签拖拽时做跟手预览（v0.6.3）。 */
    THUMBNAIL: 'win:thumbnail',
  },

  /* ---- 窗口管理（置顶/透明度/列表） ---- */
  WINMGR: {
    BOTTOM: 'winmgr:bottom',
    LIST: 'winmgr:list',
    OPACITY: 'winmgr:opacity',
    TOPMOST: 'winmgr:topmost',
    /* 把窗口摆到指定矩形（窗口布局工具用）。
     * 与 TOPMOST/BOTTOM 分开成一条新通道，而不是给它们加参数：
     * 那两个动作只改 Z 序、语义单一；摆位置要动几何、还要先恢复
     * 最小化/最大化的窗口（Win32 的既定要求），失败原因也不同。
     * 混成一个通道会让"置顶"也要处理几何参数，徒增出错面。 */
    PLACE: 'winmgr:place',
  },

  /* ---- zip 压缩与解压 ---- */
  ZIP: {
    COMPRESS: 'zip:compress',
    EXTRACT: 'zip:extract',
  },
};

/* 把分组对象拍平成「语义键 → 通道名」的 Map，便于校验与查找。
 * 键形如 'DIR_MOVE.MOVE'。 */
function flatten(groups) {
  const out = {};
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') out[prefix ? prefix + '.' + k : k] = v;
      else walk(v, prefix ? prefix + '.' + k : k);
    }
  };
  walk(groups || CHANNELS, '');
  return out;
}

/* ============================================================
 * 迁移进度声明（机读，供 scripts/test-channels-sync.js 比对）
 *
 * 【为什么要有这个常量】
 * 上面那段 TODO 注释是给人看的，但它和所有注释一样会过期：
 * 迁移完一个域之后，没人会想起来回来把 164 改成 156。
 * 一旦注释里的数字与事实不符，它就变成了**误导**——
 * 后来者会以为还有 26 个 fs 通道没迁，而实际上可能已经迁完了。
 *
 * 所以把「总共有多少条」「已迁移多少条」做成导出常量，
 * 让测试能拿它和「主进程实际注册的通道」算出的数字对账。
 * 迁移一个域时**必须**同时改这里 —— 测试会强制你改。
 * ============================================================ */
const MIGRATION = {
  /* 通道总数（含纯推送的 PUSH_ONLY 那一条）。
   *
   * 【这里曾经写着「那 4 个仍是 main.js 里的字面量，没并入 CHANNELS」】
   * 那是 v0.4.0 的事实，v0.4.2 全量迁移之后已经不成立 —— 全部进了
   * 常量表，主进程零字面量。注释没跟着改，于是它描述的是一个**相反**的
   * 状态：读到这里的人会以为还有 4 条没迁，去 main.js 里找那些字面量而找不到。
   * 这正是上面「注释会过期、所以要做成机读常量」那段话自己踩的坑 ——
   * 常量读起来是准的，旁边的解释却是错的，而人先读解释。
   * 现在 TOTAL 与 MIGRATED 相等，含义就是「一条都不剩」。
   * 新增通道时两个数字一起加：脚本 test-channels-sync 的 6f 会强制对齐。
   *
   * 【176 → 180（2026-11-09）】一次加了 4 条：
   *   LUNAR.MONTH       日历整月一次取（把 31 次串行 IPC 压成 1 次）
   *   SCHED.ONCE_ADD    一次性定时（睡眠/锁屏）持久化到主进程
   *   SCHED.ONCE_LIST   列出挂起的一次性定时
   *   SCHED.ONCE_REMOVE 撤销一条
   * 它们都真的注册了 handle（sched:once-fired 是推送，不在表里）。
   *
   * 【180 → 181（2026-11-13）】加了一条：
   *   WINMGR.PLACE      把窗口摆到指定矩形（窗口布局工具用）
   * 与 TOPMOST/BOTTOM 分开成新通道的理由：那两个只改 Z 序、语义单一；
   * 摆位置要动几何、还要先恢复最小化/最大化（Win32 的既定要求），
   * 失败原因也不同。混成一个通道会让"置顶"也要处理几何参数。 */
  TOTAL: 188,
  /* 已经换成常量引用的通道数 = flatten(CHANNELS) 的条目数。
   * 这里写死而不是用 Object.keys(flatten()).length 动态算，
   * 是为了让「加了常量但没在主进程用上」这种情况也能被发现：
   * 动态算的话，往表里加一条就自动算"已迁移"，而主进程可能还在用字面量。 */
  MIGRATED: 188,
};

/* ============================================================
 * 表里的「只推送、不注册」通道
 *
 * 【为什么需要这份声明】
 * 这张表原先 100% 是 invoke 通道 —— 渲染层 invoke、主进程 handle。
 * 于是几条审计把「表里有」直接等同于「主进程注册了」(test-channels-sync 的 6c)
 * 与「总数 = 注册数」(6f)。这个等价关系一直成立，也就一直没人写下来。
 *
 * v0.6.4 的 app:ui-prefs-changed 是第一条**纯推送**通道：主进程
 * webContents.send 出去，渲染层 on 订阅，从来没有 handle —— 它要是
 * 也去 handle 一个，反而会变成一条无人调用、白开入口的死通道。
 * 所以这个等价关系被打破了，必须显式声明，而不是把审计改松
 * （改松就再也挡不住「登记了但没实现」）。
 *
 * 【这条声明本身也被审计着】两个方向都查，见 scripts/test-channels-sync.js：
 *   · 声明在这里的通道，主进程必须真有 send 它；
 *   · 反过来，真的只推送的通道也必须登记在这里，否则 6c 会报「没注册」。
 * ============================================================ */
const PUSH_ONLY = ['APP.UI_PREFS_CHANGED', 'UPDATE.AVAILABLE'];

module.exports = { CHANNELS, flatten, MIGRATION, PUSH_ONLY };
