/* 工具注册表：所有工具在此注册，导航/搜索/首页均由此生成 */
(function () {
  const MODULES = [
    { id: 'system',   name: '系统与硬件', icon: 'cpu',      desc: '硬件信息、进程管理、磁盘分析、系统维护' },
    { id: 'file',     name: '文件处理',   icon: 'folder',   desc: '哈希校验、批量重命名、加密分割、查重' },
    { id: 'text',     name: '文本与编码', icon: 'type',     desc: '编解码转换、进制、文本批量处理' },
    { id: 'net',      name: '网络运维',   icon: 'globe',    desc: '网络信息、Ping、端口、Hosts' },
    { id: 'dev',      name: '开发调试',   icon: 'code',     desc: '取色、二维码、HTTP、正则、计算' },
    { id: 'media',    name: '多媒体处理', icon: 'image',    desc: '图片批量处理、水印、拼接' },
    { id: 'office',   name: '办公文档',   icon: 'file-text',desc: 'PDF 处理、Markdown、文档对比' },
    { id: 'security', name: '安全与密码', icon: 'lock',     desc: '密码生成、强度检测、剪贴板' },
    { id: 'launch',   name: '快捷启动',   icon: 'zap',      desc: '快捷启动栏、命令收藏、全局搜索' },
    { id: 'life',     name: '生活辅助',   icon: 'coffee',   desc: '番茄钟、日历农历、便签、标尺' }
  ];

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
      // 系统操作：断电类动作
      'quick-ops', 'scheduler', 'services-power',
      // 右键菜单：两个同类
      'ctxmenu-manage', 'win-classic-menu',
      // 剩下的单项
      'autostart', 'window-manager'
    ],
    file: [
      // 压缩、搜索、改名：这三类是全盘操作里最高频的
      'zip-tool', 'archive-7z',
      'global-search', 'content-search',
      'batch-rename', 'batch-ext',
      // 查重与校验：判断「这是不是同一个文件」
      'dedupe', 'hash-tool',
      // 大文件与敏感文件
      'file-split', 'file-crypt'
    ],
    text: [
      // 编码五连：日常最常打交道的五种
      'base64', 'url-codec', 'unicode-convert', 'html-entity', 'hex-ascii',
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
      'net-info', 'ping-test', 'tracert',
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
      'coords-picker', 'qr-generate', 'qr-scan', 'random-gen'
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
      // 音视频：转换 → 压制 → 截帧 → 音频剪辑 → 参数
      'av-convert', 'video-press', 'video-frames', 'audio-cut', 'av-info',
      // 引擎配置放最后：装一次就不再动
      'ffmpeg-setup'
    ],
    office: [
      // PDF 四连：合并拆分 → 转图 → 图转 → Office 互转
      'pdf-tools', 'pdf2img', 'img2pdf', 'pdf-office-convert',
      // 预览：文档 → Markdown
      'doc-preview', 'markdown-preview',
      // 对比与翻译
      'diff-tool', 'translate'
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
  function search(q) {
    const raw = norm(q).trim();
    if (!raw) return [];
    const tokens = raw.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const t of tools) {
      const name = norm(t.name);
      const kwList = (t.keywords || []).map(norm);
      const kws = kwList.join(' ');
      const desc = norm(t.desc);
      const modDef = MODULES.find(m => m.id === t.module);
      const modName = norm(modDef ? modDef.name : '');
      let total = 0;
      let ok = true;
      for (const tk of tokens) {
        let s = 0;
        if (name === tk) s = 100;
        else if (name.startsWith(tk)) s = 80;
        else if (kwList.includes(tk)) s = 70;   // 关键词整词命中，优先于名称中段
        else if (name.includes(tk)) s = 60;
        else if (kws.includes(tk)) s = 40;
        else if (modName.includes(tk)) s = 30;  // 「办公」「网络」这类按模块找
        else if (desc.includes(tk)) s = 20;
        if (!s) { ok = false; break; }
        total += s;
      }
      if (!ok) continue;
      if (name.includes(raw)) total += 60;
      scored.push({ tool: t, score: total });
    }
    return scored
      .sort((a, b) => b.score - a.score || norm(a.tool.name).localeCompare(norm(b.tool.name)))
      .map(s => s.tool);
  }

  window.Registry = { MODULES, register, byModule, get, all: tools, search, ORDER };
})();
