  // 跟随主窗口的配色主题
  (function () {
    var ids = ['polar','mist','jade','violet','rose','gold','teal','sand','mono'];
    function apply(id) { if (ids.indexOf(id) !== -1) document.documentElement.dataset.accent = id; }
    function setLang(l) {
      var next = l === 'en' ? 'en' : 'zh-CN';
      if (document.documentElement.lang === next) return false;
      document.documentElement.lang = next;
      return true;
    }
    try {
      var q = new URLSearchParams(location.search);
      var accent = q.get('accent');
      if (accent) apply(accent);
      /* 初次打开就按主窗语言渲染提示；旧实现只监听 UI_PREFS_CHANGED，
       * 英文界面下先开贴图窗会看到中文提示，直到用户再切一次语言才变。 */
      if (q.get('lang')) setLang(q.get('lang'));
    } catch (e) {}
    if (window.hehe && window.hehe.on) {
      try { window.hehe.on('aux:accent', apply); } catch (e) {}
      try {
        window.hehe.on(window.Channels.CHANNELS.APP.UI_PREFS_CHANGED, function (p) {
          if (setLang(p && p.lang)) {
            /* 通知本窗口的 DOM 逻辑：语言变了，按钮/title/提示要即时重画。
             * UI_PREFS_CHANGED 也会随主题/主色广播；语言没变就不要重画。 */
            try { window.dispatchEvent(new Event('hehe-lang')); } catch (e) {}
          }
        });
      } catch (e) {}
    }
  })();
