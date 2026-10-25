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
    if (tools.find(t => t.id === tool.id)) { console.warn('重复工具 id:', tool.id); return; }
    tools.push(tool);
  }
  const byModule = (mid) => tools.filter(t => t.module === mid);
  const get = (id) => tools.find(t => t.id === id);
  function search(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const t of tools) {
      const name = t.name.toLowerCase();
      const kws = (t.keywords || []).join(' ').toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 60;
      else if (kws.includes(q)) score = 40;
      else if ((t.desc || '').toLowerCase().includes(q)) score = 20;
      if (score) scored.push({ tool: t, score });
    }
    return scored.sort((a, b) => b.score - a.score).map(s => s.tool);
  }

  window.Registry = { MODULES, register, byModule, get, all: tools, search };
})();
