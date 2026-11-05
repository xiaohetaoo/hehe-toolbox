/* IPC 通道名（渲染层版本）。
 *
 * 【为什么有第二份】渲染层在 contextIsolation 下无法 require lib/，
 * 但通道名必须与主进程完全一致 —— 拼错一个字母的表现是运行时
 * 「调用失败：No handler registered」，而且现有的 test-ipc-channels
 * 是**扫文本**做差集的：两边都错成一样的就查不出来。
 *
 * 所以这里放一份同构的常量表，并由 scripts/test-channels-sync.js 校验：
 * 不只比键集合，还比**每个键对应的值**（值不同同样会导致静默失败）。
 *
 * 【迁移状态】目前只迁移了两个域（目录搬家、权限与链接）。
 * 其余域的通道仍是散落的字符串字面量，按 lib/channels.js 里的 TODO 逐轮推进。
 *
 * 【加载顺序】index.html 里要在 ui.js / registry.js 之前引入 ——
 * 工具文件在定义时就会引用 window.Channels（例如注册时的通道表）。
 */
(function () {
  'use strict';

  /* 与 lib/channels.js 的 CHANNELS 逐字一致 —— 由 test-channels-sync 校验 */
  const CHANNELS = {
    DIR_MOVE: {
      PRECHECK: 'dir:move-precheck',
      MOVE: 'dir:move',
    },
    ACL_LINKS: {
      ACL_DIAGNOSE: 'acl:diagnose',
      ACL_REPAIR: 'acl:repair',
      LINK_SCAN: 'link:scan',
      LINK_REMOVE: 'link:remove',
      WHO_LOCKS: 'file:who-locks',
      WHO_LOCKS_DIR: 'file:who-locks-dir',
    },

  /* v0.4.2：以下 39 组与 lib/channels.js 逐字一致（缩进差两格），
   * 由 scripts/test-channels-sync.js 逐键比对值。 */
    /* ---- 应用级：窗口信息、主题/强调色/语言/热键、自启、崩溃日志入口 ---- */
    APP: {
      CRASH_CLEAR: 'app:crash-clear',
      CRASH_INFO: 'app:crash-info',
      CRASH_READ: 'app:crash-read',
      CRASH_REVEAL: 'app:crash-reveal',
      GET_AUTOSTART: 'app:get-autostart',
      GET_INFO: 'app:get-info',
      SET_ACCENT: 'app:set-accent',
      SET_AUTOSTART: 'app:set-autostart',
      SET_HOTKEY: 'app:set-hotkey',
      SET_LANG: 'app:set-lang',
      SET_THEME: 'app:set-theme',
      OPEN_TOOL_WINDOW: 'app:open-tool-window',
    },

    /* ---- 开机自启项（注册表 Run 键） ---- */
    AUTOSTART: {
      DELETE: 'autostart:delete',
      DISABLED_LIST: 'autostart:disabled-list',
      ENABLE: 'autostart:enable',
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
      PICK: 'ffmpeg:pick',
      PRESS: 'ffmpeg:press',
      PROBE: 'ffmpeg:probe',
      REMOVE: 'ffmpeg:remove',
      STATUS: 'ffmpeg:status',
      TRIM: 'ffmpeg:trim',
    },

    /* ---- 文件系统（最大的一个域：读写/哈希/加密/分割/重命名/清理） ---- */
    FS: {
      CLEAN_JUNK: 'fs:clean-junk',
      DECRYPT_FILE: 'fs:decrypt-file',
      DEDUPE: 'fs:dedupe',
      DELETE: 'fs:delete',
      DELETE_EMPTY: 'fs:delete-empty',
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
    },

    /* ---- 窗口管理（置顶/透明度/列表） ---- */
    WINMGR: {
      BOTTOM: 'winmgr:bottom',
      LIST: 'winmgr:list',
      OPACITY: 'winmgr:opacity',
      TOPMOST: 'winmgr:topmost',
    },

    /* ---- zip 压缩与解压 ---- */
    ZIP: {
      COMPRESS: 'zip:compress',
      EXTRACT: 'zip:extract',
    },
  };

  /** 拍平成 '组名.键名' → 通道名，便于按语义取用与校验。 */
  function flatten(groups) {
    const out = {};
    const walk = (obj, prefix) => {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === 'string') out[prefix ? prefix + '.' + k : k] = v;
        else walk(v, prefix ? prefix + '.' + k : k);
      }
    };
    walk(groups || CHANNELS, '');
    return out;
  }

  window.Channels = { CHANNELS, flatten };
})();
