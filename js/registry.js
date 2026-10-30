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
  const byModule = (mid) => tools.filter(t => t.module === mid);
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

  window.Registry = { MODULES, register, byModule, get, all: tools, search };
})();
