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
      try {
        window.hehe.on(Channels.CHANNELS.APP.UI_PREFS_CHANGED, function (p) {
          document.documentElement.lang = (p && p.lang === 'en') ? 'en' : 'zh-CN';
        });
      } catch (e) {}
    }
  })();
