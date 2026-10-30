/* 启动进度窗的渲染脚本（独立于 app.js，必须先于主界面尽快跑完） */
(function () {
  var q = new URLSearchParams(location.search);
  var html = document.documentElement;
  if (q.get('theme') === 'dark') html.dataset.theme = 'dark';
  var accent = q.get('accent');
  if (accent) html.dataset.accent = accent;
  var ver = q.get('v');
  if (ver) document.getElementById('ver').textContent = 'v' + ver;

  var fill = document.getElementById('fill');
  var label = document.getElementById('label');
  var pct = document.getElementById('pct');

  var target = 8;   // 主进程推来的目标百分比
  var cur = 8;      // 实际展示的百分比
  var done = false;

  function paint() {
    var n = Math.round(cur);
    fill.style.width = n + '%';
    pct.textContent = n + '%';
  }
  paint();

  /* 两次事件之间进度条不能「卡死」：用缓动缓慢逼近目标。
     实测主进程从 window-created 到 ready-to-show 有数百毫秒空档，
     没有这个缓动，进度条会一直停在同一个数字上。 */
  setInterval(function () {
    if (done) return;
    if (cur < target) cur = Math.min(target, cur + Math.max(0.6, (target - cur) * 0.12));
    paint();
  }, 60);

  if (window.hehe && window.hehe.on) {
    window.hehe.on('splash:step', function (d) {
      if (!d) return;
      if (typeof d.pct === 'number') target = Math.max(target, Math.min(99, d.pct));
      if (d.label && d.label !== label.textContent) {
        /* 阶段文字换掉时做一次极短的交替淡入：
           直接替换会让这 0.7 秒里唯一有信息量的东西"跳"一下，看起来像故障。
           用 opacity 过渡而不是换元素，避免触发重排。 */
        label.style.opacity = '0.25';
        setTimeout(function () { label.textContent = d.label; label.style.opacity = '1'; }, 90);
      }
    });
    window.hehe.on('splash:done', function () {
      done = true; cur = 100; target = 100; paint();
      label.textContent = '准备就绪';
      label.style.opacity = '1';
      document.body.classList.add('out'); // 淡出，主进程随后关闭本窗口
    });
  }
})();
