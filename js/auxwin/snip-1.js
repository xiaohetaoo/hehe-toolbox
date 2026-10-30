  // 跟随主窗口的配色主题
  (function () {
    var ids = ['polar','mist','jade','violet','rose','gold','teal','sand','mono'];
    function apply(id) { if (ids.indexOf(id) !== -1) document.documentElement.dataset.accent = id; }
    try {
      var q = new URLSearchParams(location.search).get('accent');
      if (q) apply(q);
    } catch (e) {}
    if (window.hehe && window.hehe.on) {
      try { window.hehe.on('aux:accent', apply); } catch (e) {}
    }
  })();
  // canvas 不能直接用 CSS 变量，取计算后的主色
  // 注意：必须待在本脚本块内。放在结束标签之后会被 HTML 解析器当正文文本，
  // 页面上直接显示源码，且函数根本没定义——render() 一进“已有选区”分支就抛
  // ReferenceError，选区遮罩/手柄/标注全都被跳过，用户框选时毫无反馈。
  function accentPrimary() {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue('--aux-primary').trim() || '#165DFF';
    } catch (e) { return '#165DFF'; }
  }
