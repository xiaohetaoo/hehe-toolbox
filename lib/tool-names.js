'use strict';
/* 工具 id → 工具中英文名（主进程侧用）。
 *
 * ============ 为什么需要这张表 ============
 * 独立工具窗口在 main.js 里创建，而工具名只存在于渲染层的注册表
 * （js/tools/*.js 的 register({ id, name, nameEn })）—— 主进程在
 * contextIsolation 下读不到它，也没有任何 require 路径能拿到。
 * 于是 openToolWindow 只能给所有窗口写死同一个标题「核核工具箱」：
 * 开三个工具窗口后，任务栏与 Alt+Tab 里是三个同名条目，只能靠缩略图辨认。
 *
 * ============ 为什么不把注册表 require 进来 ============
 * js/tools/*.js 是浏览器脚本（直接引用 window / document / Registry），
 * 在 Node 里 require 会立刻 TypeError。为它加一套 UMD 适配要动 100 多个
 * 工具文件 —— 那是把「窗口标题」这件小事变成一次全局改造。
 *
 * ============ 两张表会漂移吗 ============
 * 会，所以由 scripts/test-tool-window-title.js 守着：它扫 js/tools 下每个
 * register({...}) 块，断言这里的每一条都与注册表一致（多、少、名字不同都红）。
 * 新增工具时忘了补这张表，CI 会直接指出来。
 *
 * 渲染层不需要这份文件：它本来就有注册表，取工具名走 Registry.toolName()，
 * 那个函数会按当前语言在 name / nameEn 之间选。
 */

/* 与 js/tools/**\/*.js 的 register({ id, name, nameEn }) 逐字对应。
 * 顺序按 id 字典序，便于人工比对。 */
const TOOL_NAMES = {
    'acl-repair': { zh: '权限修复', en: 'Permission Repair' },
    'archive-7z': { zh: '7z 压缩包', en: '7-Zip Archive' },
    'audio-cut': { zh: '音频剪辑', en: 'Audio Trim' },
    'autostart': { zh: '开机自启管理', en: 'Startup Apps' },
    'av-convert': { zh: '音视频格式转换', en: 'Media Convert' },
    'av-info': { zh: '音视频信息查看', en: 'Media Info' },
    'base64': { zh: 'Base64 编解码', en: 'Base64 Codec' },
    'batch-ext': { zh: '批量改后缀', en: 'Batch Rename Extension' },
    'batch-ocr': { zh: '批量图片 OCR', en: 'Batch Image OCR' },
    'batch-rename': { zh: '批量重命名', en: 'Batch Rename' },
    'calculator': { zh: '科学计算器', en: 'Calculator' },
    'calendar-lunar': { zh: '日历与农历', en: 'Calendar & Lunar' },
    'case-convert': { zh: '大小写转换', en: 'Case Convert' },
    'clipboard-history': { zh: '剪贴板历史', en: 'Clipboard History' },
    'color-convert': { zh: '颜色转换器', en: 'Color Converter' },
    'color-picker': { zh: '屏幕取色器', en: 'Screen Color Picker' },
    'command-collection': { zh: '命令收藏', en: 'Saved Commands' },
    'content-search': { zh: '文件内容搜索', en: 'Content Search' },
    'coords-picker': { zh: '屏幕坐标拾取', en: 'Screen Coordinates' },
    'csv-json': { zh: 'CSV / JSON 互转', en: 'CSV ↔ JSON' },
    'ctxmenu-manage': { zh: '右键菜单管理', en: 'Context Menu' },
    'dedupe': { zh: '重复文件查找', en: 'Duplicate Finder' },
    'diff-tool': { zh: '文档对比', en: 'Document Diff' },
    'diff3': { zh: '三栏对比', en: 'Three-way Compare' },
    'dir-move': { zh: '目录搬家', en: 'Move Folder' },
    'disk-analyze': { zh: '磁盘空间分析', en: 'Disk Usage' },
    'disk-health': { zh: '磁盘健康', en: 'Disk Health' },
    'doc-preview': { zh: '文档预览', en: 'Document Preview' },
    'downloader': { zh: '文件下载', en: 'Downloader' },
    'empty-dir-clean': { zh: '空目录清理', en: 'Empty Folder Cleanup' },
    'exif-view': { zh: 'EXIF 信息查看', en: 'EXIF Viewer' },
    'ffmpeg-setup': { zh: 'FFmpeg 环境', en: 'FFmpeg Setup' },
    'file-crypt': { zh: '文件加密解密', en: 'Encrypt / Decrypt' },
    'file-split': { zh: '文件分割合并', en: 'Split & Merge' },
    'file-unlock': { zh: '文件占用解锁', en: 'File Unlock' },
    'global-search': { zh: '全局文件搜索', en: 'Global Search' },
    'hash-tool': { zh: '哈希校验', en: 'Hash Check' },
    'hex-ascii': { zh: 'Hex / ASCII 互转', en: 'Hex ↔ ASCII' },
    'hosts-edit': { zh: 'Hosts 编辑', en: 'Hosts Editor' },
    'html-entity': { zh: 'HTML 实体转义', en: 'HTML Entities' },
    'http-client': { zh: 'HTTP 客户端', en: 'HTTP Client' },
    'hw-info': { zh: '硬件信息总览', en: 'Hardware Info' },
    'img-batch': { zh: '图片批量处理', en: 'Batch Images' },
    'img-compress': { zh: '图片压缩', en: 'Image Compress' },
    'img-dedup': { zh: '相似图片查找', en: 'Similar Images' },
    'img-scramble': { zh: '图片混淆', en: 'Image Scramble' },
    'img-stitch': { zh: '长截图拼接', en: 'Stitch Screenshots' },
    'img-watermark': { zh: '图片水印', en: 'Image Watermark' },
    'img2pdf': { zh: '图片转 PDF', en: 'Images to PDF' },
    'json-format': { zh: 'JSON 格式化', en: 'JSON Formatter' },
    'junk-clean': { zh: '垃圾清理', en: 'Junk Cleanup' },
    'lan-scan': { zh: '局域网设备', en: 'LAN Scan' },
    'link-doctor': { zh: '链接体检', en: 'Link Doctor' },
    'local-notes': { zh: '本地笔记', en: 'Markdown Notebook' },
    'markdown-preview': { zh: 'Markdown 预览', en: 'Markdown Preview' },
    'mojibake-fix': { zh: '乱码修复', en: 'Fix Mojibake' },
    'monitor': { zh: '实时状态监控', en: 'Live Monitor' },
    'net-info': { zh: '网络信息查询', en: 'Network Info' },
    'notes': { zh: '便签 / 待办', en: 'Sticky Notes & To-do' },
    'password-gen': { zh: '密码生成器', en: 'Password Generator' },
    'password-strength': { zh: '密码强度检测', en: 'Password Strength' },
    'pdf-office-convert': { zh: 'Word/Excel ↔ PDF', en: 'PDF ↔ Office' },
    'pdf-tools': { zh: 'PDF 合并拆分', en: 'PDF Merge & Split' },
    /* PDF 增强三件套（v0.8.3）。独立窗口的标题从这里取，
     * 不登记会退化成兜底名（"pdf-watermark" 这种 id）。 */
    'pdf-pages': { zh: 'PDF 页面管理', en: 'PDF Page Organizer' },
    'pdf-watermark': { zh: 'PDF 水印与页码', en: 'PDF Watermark & Page Numbers' },
    'pdf-extract-text': { zh: 'PDF 提取文字', en: 'Extract PDF Text' },
    'pdf-slim': { zh: 'PDF 瘦身', en: 'PDF Slimmer' },
    'pdf2img': { zh: 'PDF 转图片', en: 'PDF to Images' },
    'ping-test': { zh: 'Ping 测试', en: 'Ping' },
    'pomodoro': { zh: '番茄钟 / 倒计时', en: 'Pomodoro' },
    'port-occupy': { zh: '端口占用查询', en: 'Port Occupied' },
    'port-scan': { zh: '本机端口扫描', en: 'Port Scan' },
    'port-test': { zh: '端口连通测试', en: 'Port Test' },
    'process-manager': { zh: '进程管理', en: 'Process Manager' },
    'qr-generate': { zh: '二维码生成', en: 'QR Generate' },
    'qr-scan': { zh: '二维码识别', en: 'QR Scan' },
    'quick-launch': { zh: '快捷启动栏', en: 'Quick Launch' },
    'quick-ops': { zh: '系统快捷操作', en: 'Quick Actions' },
    'radix': { zh: '进制转换', en: 'Radix Convert' },
    'random-gen': { zh: '随机生成器', en: 'Random Generator' },
    'regex-test': { zh: '正则测试', en: 'Regex Test' },
    'scheduler': { zh: '定时任务', en: 'Scheduled Tasks' },
    'screen-rec': { zh: '屏幕录制', en: 'Screen Record' },
    'screen-ruler': { zh: '屏幕标尺', en: 'Screen Ruler' },
    'screenshot-ocr': { zh: '截图 OCR 文字识别', en: 'Screenshot OCR' },
    'services-power': { zh: '服务与电源', en: 'Services & Power' },
    'snip-tool': { zh: '截图标注', en: 'Snip & Annotate' },
    'speedtest': { zh: '网速测试', en: 'Speed Test' },
    'static-server': { zh: '本地静态服务器', en: 'Static Server' },
    'target-size': { zh: '目标体积压缩', en: 'Target Size Compress' },
    'text-batch': { zh: '文本批量处理', en: 'Batch Text' },
    'text-stats': { zh: '文本统计', en: 'Text Stats' },
    'timestamp': { zh: '时间戳工具', en: 'Timestamp' },
    /* 工具链（v0.9）。独立窗口标题从这里取，不登记会退化成 "tool-chain" */
    'tool-chain': { zh: '工具链', en: 'Tool Chain' },
    'tracert': { zh: '路由追踪', en: 'Traceroute' },
    'translate': { zh: '翻译工具', en: 'Translate' },
    'tts': { zh: '文本朗读', en: 'Text to Speech' },
    'unicode-convert': { zh: 'Unicode 转换', en: 'Unicode Convert' },
    'unit-convert': { zh: '单位换算', en: 'Unit Convert' },
    'url-codec': { zh: 'URL 编解码', en: 'URL Codec' },
    'video-frames': { zh: '视频截帧', en: 'Video Frames' },
    'video-press': { zh: '视频压制', en: 'Video Compress' },
    'video-trim': { zh: '视频裁剪', en: 'Video Trim' },
    'wifi-password': { zh: 'WiFi 密码查看', en: 'Wi-Fi Passwords' },
    'win-classic-menu': { zh: '经典右键菜单', en: 'Classic Context Menu' },
    'window-manager': { zh: '窗口管理', en: 'Window Manager' },
    'zh-convert': { zh: '简繁转换', en: 'Chinese Convert' },
    'zip-tool': { zh: '压缩解压', en: 'Zip Tool' },
};

/** 打包后未登录时可能拿到的兜底名（与 index.html 的 <title> 一致）。 */
const DEFAULT_TITLE = '核核工具箱';

/**
 * 取一个工具的窗口标题。
 * @param {string} id 工具 id
 * @param {string} [lang] 'zh' | 'en'，默认中文
 * @returns {string} 没有登记的 id 返回兜底标题（绝不返回空串：
 *   BrowserWindow 的 title 为 '' 时会显示可执行文件名，比兜底更莫名其妙）
 */
function toolTitle(id, lang) {
  const e = TOOL_NAMES[id];
  if (!e) return DEFAULT_TITLE;
  return (lang === 'en' && e.en) ? e.en : e.zh;
}

module.exports = { TOOL_NAMES, DEFAULT_TITLE, toolTitle };
