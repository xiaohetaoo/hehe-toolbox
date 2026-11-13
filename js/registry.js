/* 工具注册表：所有工具在此注册，导航/搜索/首页均由此生成 */
(function () {
  /* 模块名给两种语言：nameEn 缺失时回退到 name。
     模块名会出现在导航、首页分类条、模块页标题、搜索结果行和面包屑五处，
     是外壳里露出频率最高的文字，所以必须翻译；工具名本身不翻译（工具正文是中文）。
     desc / descEn 同理：模块描述出现在首页分类卡与模块页副标题，也要双语。 */
  const MODULES = [
    { id: 'system',   name: '系统与硬件', nameEn: 'System & Hardware', icon: 'cpu',      desc: '硬件信息、进程管理、磁盘分析、系统维护', descEn: 'Hardware info, processes, disk analysis, maintenance',
      intro: '看清楚这台机器在干什么：谁在占 CPU 和内存、磁盘还剩多少、哪些文件最占地。也能顺手做点维护 —— 清理垃圾、管理启动项、调整窗口、按需关机重启。涉及删除和断电的动作默认关闭，要手动开。',
      introEn: 'See what the machine is doing: who is eating CPU and memory, how much disk is left, which files take the most space. Then do light maintenance — clean junk, manage startup items, arrange windows, shut down or restart on demand. Destructive actions stay off until you enable them.' },
    { id: 'file',     name: '文件处理',   nameEn: 'Files',             icon: 'folder',   desc: '哈希校验、批量重命名、加密分割、查重', descEn: 'Hashing, batch rename, encrypt & split, duplicates',
      intro: '围绕「一堆文件」的日常操作：批量改名与改扩展名、算哈希核对文件是否一致、加密与分割、找重复文件。删不掉又不知道被谁占着的时候，这里能查出来并解锁。',
      introEn: 'Everyday work on batches of files: rename in bulk, verify identity by hash, encrypt and split, find duplicates. When a file refuses to delete, this is where you find out who holds it and release it.' },
    { id: 'text',     name: '文本与编码', nameEn: 'Text & Encoding',   icon: 'type',     desc: '编解码转换、进制、文本批量处理', descEn: 'Encoding conversion, number bases, batch text ops',
      intro: '粘贴即用的文本工具箱：Base64 / URL / Unicode / HTML 实体互转、进制换算、大小写与命名风格转换、JSON 与 CSV 互转、文本统计。乱码了可以试着修回来。',
      introEn: 'Paste-and-go text utilities: Base64, URL, Unicode and HTML entity conversion, number bases, case and naming-style conversion, JSON to CSV, text statistics. And a repair tool for mojibake.' },
    { id: 'net',      name: '网络运维',   nameEn: 'Network',           icon: 'globe',    desc: '网络信息、Ping、端口、Hosts', descEn: 'Network info, ping, ports, hosts',
      intro: '查本机网络状况（IP、网关、DNS、Wi-Fi 密码），测连通性（Ping、路由追踪、测速），看端口占用与端口扫描，编辑 hosts 并刷新 DNS。下载文件也在这里排队。',
      introEn: 'Inspect the local network (IP, gateway, DNS, saved Wi-Fi passwords), test reachability (ping, traceroute, speed test), check port usage and scan ports, edit hosts and flush DNS. Downloads queue here too.' },
    { id: 'dev',      name: '开发调试',   nameEn: 'Dev Tools',         icon: 'code',     desc: '取色、二维码、HTTP、正则、计算', descEn: 'Color picker, QR codes, HTTP, regex, calculator',
      intro: '开发时的零碎需求一次给全：取色与颜色格式互转、正则实时测试、JSON 格式化、HTTP 请求调试、本地静态服务、二维码生成与识别、时间戳与单位换算。按 Ctrl+K 能从任何页面跳到任意工具。',
      introEn: 'All the small dev needs in one place: color picking and format conversion, live regex testing, JSON formatting, HTTP request debugging, a local static server, QR generate and decode, timestamps and unit conversion. Press Ctrl+K to jump to any tool from anywhere.' },
    { id: 'media',    name: '多媒体处理', nameEn: 'Media',             icon: 'image',    desc: '图片批量处理、水印、拼接', descEn: 'Batch images, watermarks, stitching',
      intro: '图片和音视频的批量活：压缩、缩放、加文字或图片水印、拼接长图、去重、视频压制与裁剪、抽帧、音频截取。ffmpeg 首次使用时会引导安装。',
      introEn: 'Batch work on images and media: compress, resize, add text or image watermarks, stitch long images, dedupe, re-encode and trim video, extract frames, cut audio. ffmpeg is set up on first use with a guided installer.' },
    { id: 'office',   name: '办公文档',   nameEn: 'Office & Docs',     icon: 'file-text',desc: 'PDF 处理、Markdown、文档对比', descEn: 'PDF tools, Markdown, document diff',
      intro: 'PDF 的合并、拆分、加页码水印、提取文字与瘦身；图片转 PDF；Word / Excel / PPT 与 PDF 互转（优先用 LibreOffice，没装则走 Office）；Markdown 预览与文档对比。',
      introEn: 'Merge, split, watermark and number PDF pages, extract text, slim down file size; images to PDF; convert Word, Excel and PPT to and from PDF (LibreOffice preferred, Office as fallback); Markdown preview and document diff.' },
    { id: 'security', name: '安全与密码', nameEn: 'Security',          icon: 'lock',     desc: '密码生成、强度检测、剪贴板', descEn: 'Password generation, strength check, clipboard',
      intro: '生成强密码、检测已有密码的强度、管理剪贴板历史。剪贴板会按形态识别令牌、私钥、连接串这类敏感内容并提醒清理，也能把刚复制的路径、网址、颜色值直接变成可执行的动作。',
      introEn: 'Generate strong passwords, check the strength of existing ones, keep a clipboard history. The clipboard spots tokens, private keys and connection strings by shape and offers to purge them, and turns a copied path, URL or color into one-click actions.' },
    { id: 'launch',   name: '快捷启动',   nameEn: 'Launchers',         icon: 'zap',      desc: '快捷启动栏、命令收藏、全局搜索', descEn: 'Quick launch bar, saved commands, global search',
      intro: '把常用程序和命令钉在一处，点一下就启动，不必再翻开始菜单或记路径。命令收藏存的是一组可重复执行的命令行，带参数占位。',
      introEn: 'Pin the programs and commands you use often, launch them in one click — no more Start menu digging or memorizing paths. Saved commands hold reusable command lines with parameter placeholders.' },
    { id: 'life',     name: '生活辅助',   nameEn: 'Everyday',          icon: 'coffee',   desc: '番茄钟、日历农历、便签、标尺', descEn: 'Pomodoro, calendar & lunar, notes, ruler',
      intro: '和干活没直接关系、但每天都会用到的小东西：番茄钟与倒计时、带农历与节气的日历、便签待办、屏幕标尺与坐标取点、文本朗读。',
      introEn: 'The small things you reach for daily: pomodoro and countdown timers, a calendar with lunar dates and solar terms, sticky notes and to-dos, an on-screen ruler and coordinate picker, and text-to-speech.' }
  ];
  /* 按当前界面语言取模块名。调用点很多，统一收在这里，
     免得每个渲染位置都写一遍 `i18n.lang === 'en' ? m.nameEn : m.name`。 */
  function modName(m) {
    if (!m) return '';
    const en = window.i18n && window.i18n.lang === 'en';
    return (en && m.nameEn) ? m.nameEn : m.name;
  }
  /* 模块描述同理：英文界面下优先 descEn，缺失时回退中文（不至于空白）。 */
  /* 工具名 / 工具的副标题也走同一套。
   * 【为什么工具也要】模块层早就双语了，但 102 个工具自身的 name/desc
   * 一直是纯中文 —— 英文界面下首页卡片、搜索结果、标签页标题全是中文，
   * 这比「正文没翻译」更致命：用户还没点进去就已经看不懂这是什么工具了。
   * 与模块保持同一约定：nameEn/descEn 缺失时回退中文，不出现空白。 */
  function toolName(t) {
    if (!t) return '';
    const en = window.i18n && window.i18n.lang === 'en';
    return (en && t.nameEn) ? t.nameEn : t.name;
  }
  function toolDesc(t) {
    if (!t) return '';
    const en = window.i18n && window.i18n.lang === 'en';
    return (en && t.descEn) ? t.descEn : (t.desc || '');
  }
  function modDesc(m) {
    if (!m) return '';
    const en = window.i18n && window.i18n.lang === 'en';
    return (en && m.descEn) ? m.descEn : (m.desc || '');
  }
  /* 分类介绍（两三句，比 desc 长）。
   * 【为什么要有它】desc 是一行关键词（"哈希校验、批量重命名、加密分割"），
   * 用户看完知道有哪些东西、不知道这一包能解决什么问题。
   * intro 补的就是这层。缺 intro 时退回 desc —— 老数据/第三方插件
   * 没有这个字段也不会渲染出空白。 */
  function modIntro(m) {
    if (!m) return '';
    const en = window.i18n && window.i18n.lang === 'en';
    const pick = en ? (m.introEn || m.descEn) : (m.intro || m.desc);
    return pick || '';
  }

  const tools = [];
  function register(tool) {
    // 必填字段校验：漏写 name 时 search() 里的 t.name.toLowerCase() 会抛 TypeError，
    // 而那个异常发生在 debounce 的 setTimeout 里，会逃出调用栈让搜索框整个失效且无提示。
    if (!tool || typeof tool !== 'object') { console.error('工具注册失败：非法对象', tool); return; }
    if (typeof tool.id !== 'string' || !tool.id) { console.error('工具注册失败：缺少 id', tool); return; }
    if (typeof tool.name !== 'string' || !tool.name) { console.error('工具注册失败：缺少 name', tool.id); return; }
    if (typeof tool.render !== 'function') { console.error('工具注册失败：缺少 render', tool.id); return; }
    if (tools.find(t => t.id === tool.id)) { console.warn('重复工具 id:', tool.id); return; }
    tools.push(tool);
  }
  /* ============ 卡片展示顺序 ============
   * 排列遵守两条原则，它们常常冲突，这里用「先分组、组内再排序」来折中：
   *
   * 1) 常用的在前。打开工具箱的绝大多数场景是「临时用一下某个功能」，
   *    最高频的那几个应该第一行就能点到，而不是滚一遍列表去找。
   * 2) 相似的工具挨着。压缩/解压、端口三件套、PDF 系列这类，
   *    用户通常是「先找到一个，再看旁边还有什么」，相邻能少来回扫视。
   *
   * 分组之间按「该组最常用那个的常用度」排，组内按常用度排。
   * 所以同一组里冷门的会排在热门组之后——这是刻意的取舍：
   * 「同一件事的几个做法放在一起」比「所有工具严格按热度排」更好用。
   *
   * 这张表是唯一事实来源。增删工具时忘了登记**不会**导致卡片消失：
   * 未登记的 id 会按注册顺序追加到末尾，并被打包冒烟与
   * scripts/test-tool-order.js 报出来（否则新工具会永远沉在列表最底下没人发现）。
   */
  const ORDER = {
    system: [
      // 进程与资源：最常开，替代任务管理器
      'process-manager', 'monitor', 'hw-info',
      // 空间与清理：三件套
      'disk-analyze', 'junk-clean', 'empty-dir-clean',
      // 磁盘健康：与空间分析同属「关心我的盘」，挨着放
      'disk-health',
      // 系统操作：断电类动作
      'quick-ops', 'scheduler', 'services-power',
      // 右键菜单：两个同类
      'ctxmenu-manage', 'win-classic-menu',
      // 剩下的单项
      'autostart', 'window-manager'
    ],
    file: [
      // 「删不掉、提示被占用，但不知道谁占的」是中文 Windows 上最高频的痛点，
      // 排第一位；随后是压缩与搜索这两组主力，保持同组相邻。
      'file-unlock',
      'zip-tool', 'archive-7z',
      'global-search', 'content-search',
      // 权限修复与占用解锁是「删不掉」的两个并列原因，紧随其后
      'acl-repair',
      // 链接体检（只读、看一眼就走）与搬家（高危、低频）放在主力之后，
      // 靠搜索也能直达，不占网格首行
      'link-doctor', 'dir-move',
      'batch-rename', 'batch-ext',
      // 查重与校验：判断「这是不是同一个文件」
      'dedupe', 'hash-tool',
      // 大文件与敏感文件
      'file-split', 'file-crypt'
    ],
    text: [
      // 编码五连：日常最常打交道的五种
      'base64', 'url-codec', 'unicode-convert', 'html-entity', 'hex-ascii',
      // 乱码修复：中文用户踩坑率极高，紧跟编码五连
      'mojibake-fix',
      // 数值与时间：开发者高频
      'radix', 'timestamp',
      // 文本处理三连
      'text-stats', 'text-batch', 'case-convert',
      // 语言与表格
      'zh-convert', 'csv-json',
      // 长驻型工具
      'local-notes', 'tts'
    ],
    net: [
      // 网络体检：先看状态，再测通不通
      'net-info', 'ping-test', 'lan-scan', 'tracert',
      // 端口三连：占用 → 连通 → 扫描
      'port-occupy', 'port-test', 'port-scan',
      // 传输
      'downloader', 'speedtest',
      // 配置类
      'hosts-edit', 'wifi-password'
    ],
    dev: [
      // 开发调试最常打的两样
      'json-format', 'regex-test',
      // 计算：表达式 → 单位
      'calculator', 'unit-convert',
      // 请求与本地服务
      'http-client', 'static-server',
      // 颜色：换算 → 取样
      'color-convert', 'color-picker',
      // 屏幕与码
      'coords-picker', 'qr-generate', 'qr-scan', 'random-gen',
      // 工具链是「跨工具」的编排入口，不属于任何单一分类，
      // 放在末尾：日常用它的人会通过 Ctrl+K 直达，不需要占网格首屏。
      'tool-chain'
    ],
    media: [
      // 截图抓取：标注 + 录屏（最常用的两个动作）
      'snip-tool', 'screen-rec',
      // 图片瘦身：压缩 + 压到目标体积
      'img-compress', 'target-size',
      // 文字识别：单张 → 批量
      'screenshot-ocr', 'batch-ocr',
      // 批量处理与水印
      'img-batch', 'img-watermark',
      // 拼接、查重、参数查看
      'img-stitch', 'img-dedup', 'exif-view',
      // 隐私遮挡：混淆与还原放在一起，紧挨着 EXIF（同属「发图前处理」）
      'img-scramble',
      // 音视频：转换 → 压制 → 裁剪 → 截帧 → 音频剪辑 → 参数
      // 裁剪挨着压制：都是"处理已有视频"，用户找其中一个时另一个多半也相关
      'av-convert', 'video-press', 'video-trim', 'video-frames', 'audio-cut', 'av-info',
      // 引擎配置放最后：装一次就不再动
      'ffmpeg-setup'
    ],
    office: [
      // PDF 四连：合并拆分 → 转图 → 图转 → Office 互转
      'pdf-tools', 'pdf2img', 'img2pdf', 'pdf-office-convert',
      // PDF 增强三件套：紧挨着 PDF 四连 —— 用户处理 PDF 时会在这两批之间来回
      'pdf-pages', 'pdf-watermark', 'pdf-extract-text', 'pdf-slim',
      // 预览：文档 → Markdown
      'doc-preview', 'markdown-preview',
      // 对比与翻译
      'diff-tool', 'diff3', 'translate'
    ],
    security: [
      // 生成 → 检测，同一件事的两个角度
      'password-gen', 'password-strength',
      'clipboard-history'
    ],
    launch: ['quick-launch', 'command-collection'],
    life: [
      // 计时与待办同属「专注」
      'pomodoro', 'notes',
      'calendar-lunar', 'screen-ruler'
    ]
  };

  /* 排序键：登记过的按表内位置，未登记的排到最后（保持注册顺序）。 */
  function rank(mid, id) {
    const list = ORDER[mid];
    if (!list) return Number.MAX_SAFE_INTEGER - 1;
    const i = list.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER - 1 : i;
  }
  const byModule = (mid) => tools
    .filter(t => t.module === mid)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (rank(mid, a.t.id) - rank(mid, b.t.id)) || (a.i - b.i))
    .map(x => x.t);
  const get = (id) => tools.find(t => t.id === id);
  /* 搜索：首页的主入口，因此按「用户真的会怎么打字」来设计。
   *
   * 旧实现在整串上做子串匹配，有三个硬伤：
   * 1) 「pdf 合并」这种把两个词分开写的查询 → 0 结果。
   *    名称里没有 "pdf 合并" 这个连续子串，关键词里也没有。
   * 2) 搜模块名（「办公」「网络」）→ 0 结果。用户想的是「找办公类的工具」，
   *    而模块名根本不在参与匹配的字段里。
   * 3) 中文同义词散落在各工具的 keywords 里，缺一个就搜不到。
   *
   * 现在：按空白切词，每个词必须至少命中一个字段（AND 语义），分值累加；
   * 整串连续命中名称再给一次加成，避免多词查询把精确结果挤下去。
   * 同分时按名称定序，保证顺序稳定 —— 否则每次输入顺序都可能抖动，
   * 键盘上下选的那一项会在手指底下换掉。
   */
  const norm = (s) => String(s == null ? '' : s).toLowerCase();
  /* 拼音首字母（lib/pinyin.js，由 index.html 挂到 window.Pinyin）。
   * 拿不到时降级成"永不全等"的空实现 —— 搜索仍可正常工作，
   * 只是不支持拼音，不会因为模块缺失而整个搜索崩掉。 */
  const PY = (typeof window !== 'undefined' && window.Pinyin) || null;
  const pyKey = (s) => (PY ? PY.toInitialKey(s) : '');

  /* 【拼音键要缓存】
   * search() 每次输入都会遍历 100 个工具，每个工具算一次
   * toInitialKey 就是 100 次 × N 个汉字的 collator 比较。
   * 而这个键只与工具自身有关（不会变），所以算一次存起来。 */
  const pyCache = new Map();
  function pyOfTool(t) {
    if (pyCache.has(t.id)) return pyCache.get(t.id);
    const key = pyKey(t.name);
    pyCache.set(t.id, key);
    return key;
  }
  function search(q) {
    const raw = norm(q).trim();
    if (!raw) return [];
    const tokens = raw.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const t of tools) {
      /* 【中英文都要命中】v0.4.2 给每个工具补了 nameEn / descEn，
       * 英文界面下用户看到的是英文名，用英文搜却不命中会很荒谬。
       * 反过来中文界面照旧用中文键，所以中文输入不受影响。
       * 两种语言的名字/描述一起参与评分，不区分当前界面语言 ——
       * 中文用户输 'video' 找到「视频压制」也有好处。 */
      /* 【精确/前缀判据必须按单个名称比，不能比拼接串】
       * 原来 `name === tk` 与 `name.startsWith(tk)` 都比的是
       * 「中文名 + 空格 + 英文名」这个拼接串 —— 而 103 个工具**全部**都有
       * nameEn，所以那个串恒为「科学计算器 calculator」这种两段式。
       * 用户输任何**单个词**都不可能与之全等：
       *   · 精确匹配（100 分）这一档永远是死代码，没人拿得到；
       *   · 英文名排在拼接串后面，startsWith 也永远为假，
       *     于是英文界面下搜 "calculator" 只能拿到 includes 的 60 分，
       *     反而输给某个在 keywords 里恰好有 calculator 整词的 70 分工具 ——
       *     用户搜的精确英文名被次相关结果压过。
       * 所以精确/前缀这两档拆成对 name / nameEn 分别判；
       * 拼接串仍保留给 includes 类判据（跨词包含确实需要它）。 */
      const nameZh = norm(t.name);
      const nameEnNorm = norm(t.nameEn || '');
      const name = norm(t.name + ' ' + (t.nameEn || ''));
      const kwList = (t.keywords || []).map(norm);
      const kws = kwList.join(' ');
      const desc = norm((t.desc || '') + ' ' + (t.descEn || ''));
      const modDef = MODULES.find(m => m.id === t.module);
      /* 【模块名要中英文一起参与匹配】
       * 原来只取 modDef.name（中文），于是英文界面下用户输 security 想找
       * 「安全与密码」下的工具，模块这一档（30 分）永远拿不到 ——
       * 而 MODULES 每项都有 nameEn，注释还专门写着「模块名会出现在五处、必须翻译」。
       *
       * 【注意：不要把 name/nameEn 的"精确/前缀分档"经验套过来】
       * 上面 nameZh / nameEnNorm 之所以拆开，是因为精确匹配（100 分）
       * 与前缀匹配（80 分）必须对**单个名称**判断，拼接串永远不可能全等。
       * 模块名这里只有 includes 一档（30 分），拼起来比较语义不变，
       * 不需要拆 —— 拆了反而会多出两个没人用的分值档。
       *
       * 【顺便去掉 no-shadow 压制】内层这个变量原来与外层 modName() 同名，
       * 改叫 modKey 比挂压制注释干净（压制注释比问题活得久）。 */
      const modKey = norm(modDef ? (modDef.name + ' ' + (modDef.nameEn || '')) : '');
      let total = 0;
      let ok = true;
      for (const tk of tokens) {
        let s = 0;
        if (nameZh === tk || (nameEnNorm && nameEnNorm === tk)) s = 100;
        else if (nameZh.startsWith(tk) || (nameEnNorm && nameEnNorm.startsWith(tk))) s = 80;
        else if (kwList.includes(tk)) s = 70;   // 关键词整词命中，优先于名称中段
        else if (name.includes(tk)) s = 60;
        else if (kws.includes(tk)) s = 40;
        else if (modKey.includes(tk)) s = 30;  // 「办公」「网络」「security」这类按模块找
        else if (desc.includes(tk)) s = 20;
        /* 拼音首字母（打 yssc 找「压缩」）。
         * 【为什么排在最后】它是**补充通道**，不是主通道：
         * 中文用户多数时候直接打汉字，英文/数字关键词也是精确的。
         * 把拼音放前面会让"打 tp 命中图片压缩"压过真正的精确匹配。
         * 而且纯字母输入本来就可能撞上英文关键词，放在末位可以
         * 保证"有更好匹配时优先用更好的"。 */
        else if (tk.length >= 2 && /^[a-z]+$/.test(tk) && pyOfTool(t).includes(tk)) s = 15;
        if (!s) { ok = false; break; }
        total += s;
      }
      if (!ok) continue;
      /* 【整串连续命中的加成也要按单个名称判】
       * 原来判的是拼接串 `name.includes(raw)` —— raw 是用户输入的**整条**查询。
       * 拼接串形如「科学计算器 calculator」，任何跨词的整串（"计算器 calc"）
       * 或单看英文名的整串（"calculator" 在中文名之后）都不可能命中，
       * 于是这个加成同样偏向"中文名里恰好含整串"的工具，英文名精确的拿不到。
       * 拆成两个名称分别判，谁是精确命中谁就该拿到加成。 */
      if (nameZh.includes(raw) || (nameEnNorm && nameEnNorm.includes(raw))) total += 60;
      scored.push({ tool: t, score: total });
    }
    return scored
      .sort((a, b) => b.score - a.score || norm(a.tool.name).localeCompare(norm(b.tool.name)))
      .map(s => s.tool);
  }

  window.Registry = { MODULES, register, byModule, get, all: tools, search, ORDER, modName, modDesc, modIntro, toolName, toolDesc };
})();
