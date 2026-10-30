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
      'settings.tray': '关闭时最小化到托盘',
      'settings.trayDesc': '点击关闭按钮时隐藏窗口而不是退出',
      'settings.hotkey': '全局唤起热键',
      'settings.hotkeyDesc': '任意界面一键调出主窗口',
      'settings.apply': '应用',
      'settings.hotkeyOk': '热键已生效',
      'settings.hotkeyFail': '热键注册失败，可能被其他程序占用',
      'settings.browserNA': '浏览器模式不可用',

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
      'data.privacyDesc': '核核工具箱不收集任何操作日志与个人信息；联网功能仅在主动触发时执行；所有本地数据仅存于用户电脑'
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
      'settings.tray': 'Minimize to tray on close',
      'settings.trayDesc': 'Hide the window instead of quitting when you click close',
      'settings.hotkey': 'Global hotkey',
      'settings.hotkeyDesc': 'Bring up the main window from anywhere',
      'settings.apply': 'Apply',
      'settings.hotkeyOk': 'Hotkey applied',
      'settings.hotkeyFail': 'Failed to register hotkey — it may be taken by another app',
      'settings.browserNA': 'Unavailable in browser mode',

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
      'data.privacyDesc': 'HeHe Toolbox collects no activity logs or personal data; network features run only when you trigger them; all local data stays on your PC'
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
