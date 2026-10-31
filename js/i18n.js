/* 轻量 i18n：只在「界面外壳」提供中英切换，不翻译 93 个工具正文。
 *
 * 【为什么是这个范围】
 * 工具页文案有 20094 个中文字符（含说明、错误、按钮），逐条翻译并维护
 * 两份文案的成本远超收益，而且改一处逻辑要同步改两处文案，很容易漏。
 * 外壳（导航、首页、设置、状态栏、危险门禁提示、通用按钮）是每个用户
 * 每次都会看到的，先把它做扎实。
 *
 * 工具正文保持中文 —— 这一点会在设置页明确写出来，不让用户期待落空。
 *
 * 【取词方式】t('nav.home') 以点号键名取词，缺失时回退中文再回退键名本身，
 * 保证任何一条漏翻都不会显示成空白或 undefined。
 */
(function () {
  const DICT = {
    zh: {
      'app.name': '核核工具箱',
      'app.tagline': '{n} 个工具，本地运行，不联网也能用',
      'nav.home': '首页',
      'nav.modules': '功能模块',
      'nav.favorites': '我的收藏',
      'nav.settings': '设置',
      'nav.collapse': '收起',
      'nav.expand': '展开',
      'notify.schedTitle': '核核工具箱 · 定时任务',
      'notify.schedBody': '周期任务触发',

      'search.placeholder': '搜索工具，如「pdf 合并」「图片压缩」「密码」…',
      'search.aria': '搜索工具',
      'search.results': '{n} 个结果',
      'search.hint': '↑↓ 选择 · Enter 打开 · Esc 清空',
      'search.empty': '没有找到「{q}」相关的工具',
      'search.emptyTip': '换个说法试试，比如「压缩」「PDF」「密码」「截图」；也可以清空搜索浏览全部分类',
      'search.more': '另有 {n} 个结果，在首页搜索中查看',
      'search.titlebar': '搜索工具，Ctrl+K 快速聚焦…',

      'home.recent': '最近使用',
      'home.categories': '按分类浏览',
      'home.tools': '{n} 个工具',

      'fav.empty': '还没有收藏工具，在工具页面点击 ★ 收藏',
      'fav.desc': '高频工具快速访问',

      'tool.favorite': '收藏',
      'tool.favorited': '已收藏',
      'tool.notFound': '工具不存在',
      'tool.renderFail': '工具加载失败',
      'tool.loadFail': '页面加载失败',
      'tool.backHome': '返回首页',

      'danger.title': '该工具属于高危功能，默认未启用',
      'danger.text': '「{name}」涉及的破坏性操作可能造成数据丢失或系统状态中断，因此默认关闭。请在「设置 → 高危功能」中按需开启，开启后本工具才会可用。',
      'danger.goSettings': '前往设置 → 高危功能',
      'danger.tag': '高危',
      'danger.disabled': '未启用',
      'danger.partialNotice': '本工具的「{op}」属于高危操作，需在「设置 → 高危功能」中开启后才会生效；其他功能可正常使用。',

      'status.ready': '就绪',
      'status.browser': '浏览器演示模式（部分功能不可用）',

      'settings.title': '设置',
      'settings.subtitle': '个性化你的核核工具箱',
      'settings.general': '通用',
      'settings.appearance': '外观',
      'settings.danger': '高危功能',
      'settings.data': '数据与隐私',
      'settings.about': '关于',
      'settings.language': '界面语言',
      'settings.languageDesc': '仅影响导航、首页、设置等界面文字；工具页内容保持中文',
      'settings.autostart': '开机自动启动',
      'settings.autostartDesc': '登录 Windows 后自动运行核核工具箱',
      'settings.autostartOn': '已开启开机自启',
      'settings.autostartOff': '已关闭开机自启',
      'settings.tray': '关闭时最小化到托盘',
      'settings.trayDesc': '点击关闭按钮时隐藏窗口而不是退出',
      'settings.hotkey': '全局唤起热键',
      'settings.hotkeyDesc': '任意界面一键调出主窗口',
      'settings.apply': '应用',
      'settings.hotkeyOk': '热键已生效',
      'settings.hotkeyFail': '热键注册失败，可能被其他程序占用',
      'settings.browserNA': '浏览器模式不可用',
      'settings.browserMode': '（浏览器演示模式）',

      'about.title': '关于',
      'about.env': '运行环境',
      'about.user': '当前用户',
      'about.dataDir': '数据目录',
      'about.checkUpdate': '检查更新',
      'about.checking': '正在检查更新…',
      'about.latest': '✓ 已是最新版本（v{v}）',
      'about.throttled': '检查太频繁，{s} 秒后可再试（当前最新 v{v}）',
      'about.found': '发现新版本 v{new}（当前 v{cur}），正在下载…',
      'about.manual': '发现新版本 v{v}，请到 GitHub Releases 下载',
      'about.downloading': '下载新版本 v{v}：{p}%（{mb}MB）',
      'about.downloaded': '✓ v{v} 已下载完成',
      'about.downloadFail': '✗ 下载失败：{err}',
      'about.restart': '🚀 重启并替换',
      'about.openDir': '打开所在目录',
      'danger.readFail': '✗ 无法读取高危功能配置：{err}',
      'danger.enableTitle': '开启高危功能',
      'danger.enableMsg': '确定开启「{name}」？\n\n{desc}\n\n开启后该能力会立即可用，相关工具卡片会变成红色。',
      'danger.enableOk': '确认开启',
      'danger.enabled': '已开启「{name}」',
      'danger.disabledToast': '已关闭「{name}」',
      'danger.tip': '提示：关闭某项能力后，相关工具会重新变为不可用，但已经产生的数据不会自动恢复。',
      'data.openDir': '打开目录',
      'data.clearBtn': '清除',
      'data.clearConfirm': '将清空最近使用记录与剪贴板历史，确定继续？',
      'settings.accentOk': '已切换到「{name}」',
      'about.brand': '核核工具箱',
      'about.os': '运行环境',
      'about.userShort': '当前用户',

      'common.ok': '确定',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.copy': '复制',
      'common.minimize': '最小化',
      'common.maximize': '最大化',
      'common.theme': '切换深浅色',
      'common.copied': '已复制',
      'common.unknown': '未知',

      'data.dir': '数据目录',
      'data.dirDesc': '配置、收藏、剪贴板历史等全部保存在本机，不上传云端',
      'data.clear': '清除使用记录',
      'data.clearDesc': '清空最近使用与剪贴板历史（不影响收藏）',
      'data.clearOk': '已清除',
      'data.privacy': '隐私承诺',
      'data.privacyDesc': '核核工具箱不收集任何操作日志与个人信息；联网功能仅在主动触发时执行；所有本地数据仅存于用户电脑',
      /* ---- 设置页正文（语言切换后这些也必须跟着变） ---- */
      'settings.mode': '明暗模式',
      'settings.mode.auto': '（自动切换）',
      'settings.appearanceDesc': '选择界面的明暗，与下面的配色主题自由组合',
      'settings.mode.light': '浅色',
      'settings.mode.dark': '深色',
      'settings.mode.system': '跟随系统',
      'settings.accent': '配色主题',
      'settings.accentDesc': '选择你喜欢的强调色，预览会实时跟随',
      'settings.dangerDesc': '这些操作会改动文件或系统状态，默认全部关闭。开启后对应工具才可用',
      'settings.danger.hint': '高危操作默认关闭。开启前请确认你了解它的后果',
      'settings.danger.on': '已开启',
      'settings.danger.off': '已关闭',
      'settings.aboutDesc': '版本、运行环境与更新',
      'settings.aboutUpdateNote': '这里是唯一的版本与更新入口，别处不再重复放置',
      'settings.readInfoFail': '读取版本信息失败：{err}',
      'settings.notice.wholeToolLocked': '该工具属于高危功能，默认未启用',
      'settings.notice.wholeToolLockedText': '「{name}」涉及的破坏性操作可能造成数据丢失或系统状态中断，因此默认关闭。请在「设置 → 高危功能」中按需开启，开启后本工具才会可用。',
      'settings.notice.deleteOnly': '⚠ 删除功能默认关闭，其余功能可正常使用',
      'settings.notice.deleteOnlyText': '本工具的「删除」属于高危操作，需在「设置 → 高危功能」中开启后才会生效；浏览、编辑、复制等操作不受影响。',
      'settings.notice.goDanger': '前往设置 → 高危功能',
      'settings.hotkeyLabel': '全局唤起热键',
      'settings.langSwitched.en': '界面语言已切换为 English',
      'settings.langSwitched.zh': '界面语言已切换为简体中文',
      'settings.restartHint': '部分设置需要重启程序后完全生效',
      'settings.unknownErr': '未知错误',
      'common.refresh': '刷新',
      'common.save': '保存',
      'common.delete': '删除',
      'common.confirm': '确认',
      'common.loading': '加载中…',
      'update.checking': '正在检查更新…',
      'update.throttled': '检查太频繁，{s} 秒后可再试（当前最新 v{v}）',
      'update.latest': '✓ 已是最新版本（v{v}）',
      'update.found': '发现新版本 v{latest}（当前 v{current}），正在下载…',
      'update.manual': '发现新版本 v{latest}，请到 GitHub Releases 下载：{url}',
      'update.downloading': '下载新版本 v{latest}：{pct}%（{mb}MB）',
      'update.downloaded': '✓ v{v} 已下载完成：{path}',
      'update.downloadFail': '✗ 下载失败：{err}',
      'update.startFail': '✗ 下载启动失败',
      'update.applyFail': '✗ 替换失败：{err}',
      'update.applying': '正在退出并替换，稍候会自动重启…',
      'update.readyToast': '新版本已下载',
      'update.rollbackScript': '回滚脚本：{path}',
      'update.confirmTitle': '重启并替换',
      'update.confirmOk': '重启并替换',
      'update.openDir': '打开所在目录',
      'update.confirmMsg': '将退出当前版本，用 v{v} 覆盖程序文件并自动重启。\n\n旧版本会自动备份为 .bak，若新版无法启动可运行「回滚」脚本退回。\n配置文件与数据不受影响。',
      'settings.aboutCheckOnce': '同一页面的更新检查只登记一次清理，离开页面时一次退订',
    },
    en: {
      'app.name': 'HeHe Toolbox',
      'app.tagline': '{n} tools · runs locally · works offline',
      'nav.home': 'Home',
      'nav.modules': 'Modules',
      'nav.favorites': 'Favorites',
      'nav.settings': 'Settings',
      'nav.collapse': 'Collapse',
      'nav.expand': 'Expand',
      'notify.schedTitle': 'HeHe Toolbox · Scheduled task',
      'notify.schedBody': 'Scheduled task fired',

      'search.placeholder': 'Search tools, e.g. “pdf merge”, “image compress”, “password”…',
      'search.aria': 'Search tools',
      'search.results': '{n} results',
      'search.hint': '↑↓ select · Enter open · Esc clear',
      'search.empty': 'No tools found for “{q}”',
      'search.emptyTip': 'Try another word such as “compress”, “PDF”, “password” or “screenshot”; or clear the search to browse all categories',
      'search.more': '{n} more results — search on the Home page to see them',
      'search.titlebar': 'Search tools, Ctrl+K to focus…',

      'home.recent': 'Recently used',
      'home.categories': 'Browse by category',
      'home.tools': '{n} tools',

      'fav.empty': 'No favorites yet — tap ★ on any tool page to add one',
      'fav.desc': 'Quick access to frequently used tools',

      'tool.favorite': 'Favorite',
      'tool.favorited': 'Favorited',
      'tool.notFound': 'Tool not found',
      'tool.renderFail': 'Failed to load tool',
      'tool.loadFail': 'Failed to load page',
      'tool.backHome': 'Back to Home',

      'danger.title': 'This tool is a high-risk feature and is disabled by default',
      'danger.text': 'Destructive actions in “{name}” can cause data loss or interrupt system state, so it is off by default. Enable it under Settings → High-risk features to use this tool.',
      'danger.goSettings': 'Open Settings → High-risk',
      'danger.tag': 'High risk',
      'danger.disabled': 'Disabled',
      'danger.partialNotice': 'The “{op}” action in this tool is high-risk and requires enabling under Settings → High-risk features; other features work normally.',

      'status.ready': 'Ready',
      'status.browser': 'Browser demo mode (some features unavailable)',

      'settings.title': 'Settings',
      'settings.subtitle': 'Personalize your HeHe Toolbox',
      'settings.general': 'General',
      'settings.appearance': 'Appearance',
      'settings.danger': 'High-risk',
      'settings.data': 'Data & privacy',
      'settings.about': 'About',
      'settings.language': 'Interface language',
      'settings.languageDesc': 'Affects navigation, home and settings text only; tool pages stay in Chinese',
      'settings.autostart': 'Launch at startup',
      'settings.autostartDesc': 'Start HeHe Toolbox automatically after Windows sign-in',
      'settings.autostartOn': 'Launch at login enabled',
      'settings.autostartOff': 'Launch at login disabled',
      'settings.tray': 'Minimize to tray on close',
      'settings.trayDesc': 'Hide the window instead of quitting when you click close',
      'settings.hotkey': 'Global hotkey',
      'settings.hotkeyDesc': 'Bring up the main window from anywhere',
      'settings.apply': 'Apply',
      'settings.hotkeyOk': 'Hotkey applied',
      'settings.hotkeyFail': 'Failed to register hotkey — it may be taken by another app',
      'settings.browserNA': 'Unavailable in browser mode',
      'settings.browserMode': ' (browser demo mode)',

      'about.title': 'About',
      'about.env': 'Runtime',
      'about.user': 'Current user',
      'about.dataDir': 'Data folder',
      'about.checkUpdate': 'Check for updates',
      'about.checking': 'Checking for updates…',
      'about.latest': '✓ You are on the latest version (v{v})',
      'about.throttled': 'Too frequent — retry in {s}s (latest v{v})',
      'about.found': 'New version v{new} found (current v{cur}), downloading…',
      'about.manual': 'New version v{v} found — download it from GitHub Releases',
      'about.downloading': 'Downloading v{v}: {p}% ({mb} MB)',
      'about.downloaded': '✓ v{v} downloaded',
      'about.downloadFail': '✗ Download failed: {err}',
      'about.restart': '🚀 Restart & replace',
      'about.openDir': 'Show in folder',
      'danger.readFail': '✗ Failed to read high-risk settings: {err}',
      'danger.enableTitle': 'Enable high-risk feature',
      'danger.enableMsg': 'Enable "{name}"?\n\n{desc}\n\nIt becomes usable immediately and the related tool cards turn red.',
      'danger.enableOk': 'Enable',
      'danger.enabled': 'Enabled "{name}"',
      'danger.disabledToast': 'Disabled "{name}"',
      'danger.tip': 'Note: turning a capability off makes the related tools unavailable again, but data already created is not restored automatically.',
      'data.openDir': 'Open folder',
      'data.clearBtn': 'Clear',
      'data.clearConfirm': 'This clears recent items and clipboard history. Continue?',
      'settings.accentOk': 'Switched to "{name}"',
      'about.brand': 'HeHe Toolbox',
      'about.os': 'Runtime',
      'about.userShort': 'Current user',

      'common.ok': 'OK',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.copy': 'Copy',
      'common.minimize': 'Minimize',
      'common.maximize': 'Maximize',
      'common.theme': 'Toggle light/dark',
      'common.copied': 'Copied',
      'common.unknown': 'Unknown',

      'data.dir': 'Data folder',
      'data.dirDesc': 'Settings, favorites and clipboard history stay on this machine — nothing is uploaded',
      'data.clear': 'Clear usage history',
      'data.clearDesc': 'Clears recent items and clipboard history (favorites are kept)',
      'data.clearOk': 'Cleared',
      'data.privacy': 'Privacy',
      'data.privacyDesc': 'HeHe Toolbox collects no activity logs or personal data; network features run only when you trigger them; all local data stays on your PC',
      /* ---- Settings body copy (must follow the language switch) ---- */
      'settings.mode': 'Light or dark',
      'settings.mode.auto': ' (auto)',
      'settings.appearanceDesc': 'Pick light or dark for the UI; combine freely with the accent below',
      'settings.mode.light': 'Light',
      'settings.mode.dark': 'Dark',
      'settings.mode.system': 'Follow system',
      'settings.accent': 'Accent color',
      'settings.accentDesc': 'Pick the accent you like; the preview updates live',
      'settings.dangerDesc': 'These actions change files or system state. All are off by default; the related tools stay locked until enabled',
      'settings.danger.hint': 'Dangerous actions are off by default. Make sure you understand the consequences before enabling',
      'settings.danger.on': 'Enabled',
      'settings.danger.off': 'Disabled',
      'settings.aboutDesc': 'Version, runtime environment, and updates',
      'settings.aboutUpdateNote': 'This is the only place to check for updates; it is not duplicated elsewhere',
      'settings.readInfoFail': 'Failed to read version info: {err}',
      'settings.notice.wholeToolLocked': 'This tool is a high-risk feature and is disabled by default',
      'settings.notice.wholeToolLockedText': 'The destructive actions in "{name}" may cause data loss or break system state, so it is off by default. Enable it under Settings → High-risk features to unlock this tool.',
      'settings.notice.deleteOnly': '⚠ Delete is off by default; everything else still works',
      'settings.notice.deleteOnlyText': 'Deleting is a high-risk action and only takes effect after enabling it under Settings → High-risk features. Browse, edit, and copy are unaffected.',
      'settings.notice.goDanger': 'Open Settings → High-risk features',
      'settings.hotkeyLabel': 'Global hotkey',
      'settings.langSwitched.en': 'Language switched to English',
      'settings.langSwitched.zh': 'Language switched to Simplified Chinese',
      'settings.restartHint': 'Some settings take full effect after restarting the app',
      'settings.unknownErr': 'Unknown error',
      'common.refresh': 'Refresh',
      'common.save': 'Save',
      'common.delete': 'Delete',
      'common.confirm': 'Confirm',
      'common.loading': 'Loading…',
      'update.checking': 'Checking for updates…',
      'update.throttled': 'Too many checks; try again in {s}s (latest is v{v})',
      'update.latest': '✓ You are up to date (v{v})',
      'update.found': 'New version v{latest} found (current v{current}); downloading…',
      'update.manual': 'New version v{latest} found; download it from GitHub Releases: {url}',
      'update.downloading': 'Downloading v{latest}: {pct}% ({mb}MB)',
      'update.downloaded': '✓ v{v} downloaded: {path}',
      'update.downloadFail': '✗ Download failed: {err}',
      'update.startFail': '✗ Failed to start the download',
      'update.applyFail': '✗ Replacement failed: {err}',
      'update.applying': 'Quitting and replacing; the app will restart shortly…',
      'update.readyToast': 'New version downloaded',
      'update.rollbackScript': 'Rollback script: {path}',
      'update.confirmTitle': 'Restart and replace',
      'update.confirmOk': 'Restart and replace',
      'update.openDir': 'Open containing folder',
      'update.confirmMsg': 'The current version will quit, be replaced by v{v}, and restart automatically.\n\nThe old build is backed up as .bak; run the rollback script if the new build will not start.\nConfiguration and data are unaffected.',
      'settings.aboutCheckOnce': 'Update checks on this page register a single cleanup and unsubscribe once when leaving',
    }
  };

  const SUPPORTED = ['zh', 'en'];
  let current = 'zh';

  function detect() {
    try {
      const nav = (navigator.language || 'zh-CN').toLowerCase();
      return nav.startsWith('en') ? 'en' : 'zh';
    } catch (e) { return 'zh'; }
  }

  function normalize(l) { return SUPPORTED.includes(l) ? l : null; }

  function t(key, vars) {
    const d = DICT[current] || DICT.zh;
    let s = d[key];
    // 缺词回退链：当前语言 → 中文 → 键名。任何一条没翻都不至于显示空白。
    if (s == null) s = DICT.zh[key];
    if (s == null) s = key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
    }
    return s;
  }

  function setLang(lang) {
    const n = normalize(lang) || 'zh';
    current = n;
    document.documentElement.lang = n === 'en' ? 'en' : 'zh-CN';
    document.documentElement.dataset.lang = n;
    return n;
  }

  window.i18n = {
    t, setLang, detect, normalize,
    get lang() { return current; },
    get supported() { return SUPPORTED.slice(); },
    DICT
  };
  // 让工具页也能拿到 t（虽然它们不用，但避免某些公共组建漏报 undefined）
  window.t = t;
})();
