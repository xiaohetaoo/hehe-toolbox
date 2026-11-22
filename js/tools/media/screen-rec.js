/* 模块：多媒体处理 —— screen-rec（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { escapeHtml, div, btn, toast, fmtBytes } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'screen-rec', name: '屏幕录制', nameEn: 'Screen Record', module: MOD, icon: 'film',
    desc: '录制全屏或框选区域为 MP4，可选麦克风与摄像头画中画、暂停恢复、直出 GIF', descEn: 'Record the screen or a region, optionally with microphone and camera overlay',
    keywords: ['录制', '录屏', '屏幕', 'video', 'capture', '区域', '摄像头', '画中画', 'camera', 'webcam'],
    render(page) {
      /* 【默认帧率可配置】设置 → 通用 → 录屏默认帧率。
       * 优先级：上次用的（settings.recPrefs，见下方 prefsP 恢复）> 本设置 > 30。
       * 也就是说：用户在这个页面上手动选过就以那次为准，
       * 全局设置只决定"第一次打开时默认是什么"。 */
      const defFps = String((window.Prefs && window.Prefs.get('recFps')) || 30);
      const fpsSel = h('select', { class: 'select input-sm' },
        h('option', { value: '15' }, '15 帧（文件小）'), h('option', { value: '30' }, '30 帧（流畅）'), h('option', { value: '60' }, '60 帧（高帧率）'));
      /* 用 select 已有选项匹配，避免配置值不在列表里（例如 45）时变成空选中 */
      fpsSel.value = [...fpsSel.options].some(o => o.value === defFps) ? defFps : '30';
      const audioSel = h('select', { class: 'select input-sm', style: { maxWidth: '220px' } },
        h('option', { value: '' }, '不录声音'));
      const camSel = h('select', { class: 'select input-sm', style: { maxWidth: '220px' } },
        h('option', { value: '' }, '不录摄像头'));
      const camPosSel = h('select', { class: 'select input-sm' },
        h('option', { value: 'rb', selected: true }, '右下角'), h('option', { value: 'lb' }, '左下角'),
        h('option', { value: 'rt' }, '右上角'), h('option', { value: 'lt' }, '左上角'));
      camPosSel.disabled = true;
      const camSizeSel = h('select', { class: 'select input-sm' },
        h('option', { value: '0.15' }, '小（15%）'), h('option', { value: '0.25', selected: true }, '中（25%）'), h('option', { value: '0.35' }, '大（35%）'));
      camSizeSel.disabled = true;
      // 摄像头实时预览：选完就能看到画面，避免录完才发现角度/位置不对
      const camPreview = h('video', { autoplay: true, muted: true, playsinline: true,
        style: { width: '160px', height: '120px', objectFit: 'cover', borderRadius: '8px', background: '#000', display: 'none' } });
      const camPreviewHint = h('span', { class: 'field-hint' }, '选择摄像头后在此预览');
      let previewStream = null;
      /* 【页面已销毁的标记】
       * onCleanup 里 stopPreview() 只能停掉「当时已知」的 stream。
       * 但 getUserMedia 是异步的：用户刚选完摄像头就切走页面时，
       * 请求还在飞 —— stopPreview 跑完了、previewStream 还是 null，
       * 随后 getUserMedia 才 resolve，于是摄像头被打开、指示灯亮起，
       * 而这段代码所属的页面已经销毁，再也没有人会去停它。
       * 所以用一个标记把这条路堵上：destroyed 之后不再启动预览，
       * 并且拿到 stream 时若发现已销毁，立刻把它关掉。 */
      /* 【两套 per-run token】
       * ① recordingRunToken —— start() 里跨了 FFMPEG.STATUS / DIALOG.SAVE /
       *    REC.START 三个 await，用户可能在任一时刻离开页面。离开时递增
       *    序号；异步返回后若序号不一致，说明「这趟已经作废」：
       *      · 不能把 recording 置真、不能改界面；
       *      · 如果 REC.START 真的已经启动，必须立刻 REC.STOP 收尾，
       *        否则录屏会偷偷在后台跑（用户以为没开始）。
       * ② previewGeneration —— startPreview() 里 getUserMedia 可能跨越页面
       *    生命周期。每次调用递增；返回时序号不一致就把刚拿到的 stream
       *    关掉（不能留着，摄像头的指示灯会一直亮）。
       * 用序号而不是布尔 destroyed：布尔复位后无法区分「旧请求」与「新请求」，
       * 复用回来时旧请求会拿到新状态的通行证。 */
      let recordingRunToken = 0;
      let previewGeneration = 0;
      async function stopPreview() {
        /* 递增 generation：任何在飞的 getUserMedia 回来时都会发现自己过期 */
        previewGeneration++;
        if (previewStream) { previewStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); previewStream = null; }
        camPreview.srcObject = null;
        camPreview.style.display = 'none';
      }
      // dshow 设备名（ffmpeg 用）与 getUserMedia 的 deviceId 是两套体系：
      // deviceId 是浏览器侧的 GUID，拿 dshow 名当 deviceId 约束永远不会命中，
      // ideal 语义下静默回落到系统默认摄像头 —— 预览和录制可能不是同一个设备。
      // 正确做法：enumerateDevices() 拿 label，按名称匹配出真正的 deviceId。
      async function resolveDeviceId(dshowName) {
        if (!dshowName || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return null;
        try {
          // 未授权前 enumerateDevices 的 label 是空的，先申请一次权限把 label 解锁
          const needPerm = async () => {
            const list = await navigator.mediaDevices.enumerateDevices();
            return list.some(d => d.kind === 'videoinput' && !d.label);
          };
          if (await needPerm()) {
            try {
              const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
              tmp.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
            } catch (e) { /* 无权限就用不了预览，但录制不受影响 */ }
          }
          const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
          // 1) 完全相等 2) 忽略大小写相等 3) 双向包含（浏览器 label 常带 " (VID_xxx)" 后缀）
          const norm = s => String(s || '').toLowerCase().replace(/^\s*📷\s*/, '').trim();
          const want = norm(dshowName);
          let hit = cams.find(d => norm(d.label) === want);
          if (!hit) hit = cams.find(d => norm(d.label).includes(want) || want.includes(norm(d.label)));
          return hit ? hit.deviceId : null;
        } catch (e) { return null; }
      }
      async function startPreview(dshowName) {
        await stopPreview();
        /* stopPreview 已经递增过 generation，这里领当下的值 */
        const gen = previewGeneration;
        if (!dshowName) { camPreviewHint.textContent = '选择摄像头后在此预览'; return; }
        try {
          const realId = await resolveDeviceId(dshowName);
          /* resolveDeviceId 里要等权限，可能已经离开页面/换过设备 */
          if (gen !== previewGeneration) return;
          if (!realId) {
            // 不静默回落到默认摄像头：那会预览一个跟录制不同的设备，比不预览更误导
            camPreviewHint.textContent = '预览不可用：浏览器未匹配到该摄像头（名称不一致），录制不受影响';
            return;
          }
          const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: realId } }, audio: false });
          /* 【拿到 stream 时再比一次 generation】这个 await 可能跨越了整个
           * 页面生命周期（或用户又切了别的摄像头）。过期就把刚拿到的流关掉 ——
           * 否则摄像头指示灯一直亮，而此刻没有任何界面能关它。 */
          if (gen !== previewGeneration) {
            stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
            return;
          }
          previewStream = stream;
          camPreview.srcObject = previewStream;
          camPreview.style.display = 'block';
          camPreviewHint.textContent = '预览中（录制时叠加到画面角落）';
        } catch (e) {
          camPreviewHint.textContent = '预览不可用：' + e.message + '（不影响录制）';
        }
      }
      const regionLabel = h('span', { class: 'field-hint' }, '全屏');
      const regionBtn = btn('选择区域', 'btn-sm btn-secondary', pickRegion, 'crop');
      // 按钮文案改成「清除区域」：原来叫「✕ 全屏」，而紧挨着的 regionLabel 也显示「全屏」，
      // 两个「全屏」并排重复，用户分不清哪个是按钮哪个是状态。
      // 另外这里必须放在 regionLabel 之后声明 —— 原来的箭头函数引用了后面的 const，
      // 属于暂时性死区，点击瞬间虽然能用，但顺序本身是不可靠的写法。
      const clearRegionBtn = btn('清除区域', 'btn-sm btn-text', () => { region = null; regionLabel.textContent = '全屏'; });
      const gifChk = h('input', { type: 'checkbox', class: 'checkbox' });
      const status = h('div', { class: 'field-hint' }, '支持区域录制、麦克风、摄像头画中画、暂停恢复；停止后自动封装');
      const startBtn = btn('开始录制', 'btn-primary', start, 'activity');
      const pauseBtn = btn('暂停', 'btn-secondary', () => ctl(true), 'timer');
      const resumeBtn = btn('继续', 'btn-secondary', () => ctl(false), 'play');
      const stopBtn = btn('停止并保存', 'btn-danger-plain', stop, 'stop');
      pauseBtn.disabled = resumeBtn.disabled = stopBtn.disabled = true;
      /* region 现在被 onEnter 的 status 文案与区域标签读取，已不是"只赋值未使用"，
       * 所以不再需要 eslint-disable。 */
      let recording = false, paused = false, region = null;
      const camOn = () => {
        /* 这里没挂 no-shadow 压制 —— 因为 eslint 并不认为这里有遮蔽
         * （模块顶层的 on 来自 window.api 解构，与这里的局部 on 不在同一
         * 作用域链上）。原来挂过一条压制注释，eslint 报它
         * 「Unused eslint-disable directive」：注释比问题活得久。
         * 删掉之后 baseline 里只留下真正在生效的压制。 */
        const on = !!camSel.value;
        camPosSel.disabled = !on; camSizeSel.disabled = !on;
        if (!on) { stopPreview(); camPreviewHint.textContent = '选择摄像头后在此预览'; }
        else startPreview(camSel.value);
        saveRecPrefs();
      };
      camSel.addEventListener('change', camOn);
      // 记住上次的录制设置（麦克风/摄像头/位置/大小/帧率/GIF）
      function saveRecPrefs() {
        try {
          invoke(Channels.CHANNELS.STORE.SET, 'settings.recPrefs', {
            fps: fpsSel.value, audio: audioSel.value, camera: camSel.value,
            camPos: camPosSel.value, camScale: camSizeSel.value, gif: gifChk.checked
          }).catch(() => {});
        } catch (e) {}
      }
      invoke(Channels.CHANNELS.REC.AUDIO_DEVICES).then((r) => {
        const prefsP = invoke(Channels.CHANNELS.STORE.GET, 'settings.recPrefs', null).catch(() => null);
        for (const d of (r.devices || [])) audioSel.appendChild(h('option', { value: d }, d));
        // 兼容旧返回：新版本才有 video 字段
        for (const d of (r.video || [])) camSel.appendChild(h('option', { value: d }, d));
        prefsP.then((p) => {
          if (!p || typeof p !== 'object') return;
          // 只在设备仍存在时恢复，否则回落到默认值
          if (p.fps && [...fpsSel.options].some(o => o.value === String(p.fps))) fpsSel.value = String(p.fps);
          if (p.audio && [...audioSel.options].some(o => o.value === p.audio)) audioSel.value = p.audio;
          if (p.camera && [...camSel.options].some(o => o.value === p.camera)) camSel.value = p.camera;
          if (p.camPos) camPosSel.value = p.camPos;
          if (p.camScale) camSizeSel.value = String(p.camScale);
          if (p.gif) gifChk.checked = true;
          camOn();
        }).catch(() => {});
      }).catch(() => {});
      /* 【清理注册必须在这次 IPC 之外】
       * 原来这行写在 invoke(Channels.CHANNELS.REC.AUDIO_DEVICES).then(...) 的**内部** ——
       * 设备枚举一旦 reject（ffmpeg 不可用、驱动查询失败、主进程抛错），
       * 就一路 catch(() => {}) 吞掉，onCleanup 根本没注册。
       * 后果：用户进过录制页、触发过摄像头预览，然后离开页面 ——
       * 预览的 MediaStream 不会被 stop，摄像头指示灯一直亮着，
       * 而 JS 已经找不到那个 stream 了（页面已销毁），只能去设备管理器禁用。
       * 所以把它提到 then 外面，跟同级其它清理注册放一起：
       * 无论枚举成败，离开页面时都会停掉预览。
       * 同时递增 previewGeneration：getUserMedia 的 await 可能还没回来，
       * 光停「当时已知的」stream 挡不住那个迟到的结果（见 startPreview）。
       * 【不要在这里写 stopPreview 之外的清理】停录与按钮复位在文件末尾
       * 那一处 cleanup 里统一做（那里也递增 token），两处都写会重复 STOP。 */
      window.App.onCleanup(() => { stopPreview(); });
      [fpsSel, audioSel, camPosSel, camSizeSel].forEach(el => el.addEventListener('change', saveRecPrefs));
      gifChk.addEventListener('change', saveRecPrefs);
      async function pickRegion() {
        try {
          await invoke(Channels.CHANNELS.SNIP.START, 'region');
          status.textContent = '请在屏幕上框选录制区域…';
          /* 【定时器与订阅都要能提前回收】
           * 主进程的 cancel 分支现在会立刻回一条 snip:region(null)（见 main.js），
           * 所以正常情况下不会等满 120 秒。但两道保险都要有：
           *   · 超时/收到事件时都 clearTimeout + unsub（否则重复框选会叠订阅）；
           *   · 登记到 App.onCleanup —— 用户在这 120 秒里切走页面时，
           *     刚才是既不退订也不清定时器的，订阅和挂着的 Promise 一起泄漏。
           * 重复框选前也要先清掉上一轮（下面先调一次 cleanup）。 */
          let _cleanup = null;
          const cleanup = () => { if (_cleanup) { try { _cleanup(); } catch (e2) {} _cleanup = null; } };
          if (window.App && App.onCleanup) App.onCleanup(cleanup);
          const rect = await new Promise((resolve) => {
            let settled = false;
            const t = setTimeout(() => finish(null), 120000);
            const unsub = window.api.on('snip:region', (rr) => finish(rr));
            function finish(v) {
              if (settled) return;
              settled = true;
              clearTimeout(t);
              try { unsub(); } catch (e2) {}
              _cleanup = null;
              resolve(v);
            }
            _cleanup = () => { if (!settled) { settled = true; clearTimeout(t); try { unsub(); } catch (e2) {} resolve(null); } };
          });
          if (rect && rect.w >= 64 && rect.h >= 64) { region = rect; regionLabel.textContent = `${rect.w}×${rect.h}`; status.textContent = '已选择录制区域'; }
          else if (rect) toast('区域太小，请重新选择', 'warn');
          else status.textContent = '未选择区域（保持全屏）';
        } catch (e) { toast(e.message, 'error'); }
      }
      async function start() {
        /* 【领序号：这一趟录制请求的有效凭证】 */
        const runToken = ++recordingRunToken;
        const st = await invoke(Channels.CHANNELS.FFMPEG.STATUS).catch(() => ({ ffmpeg: null }));
        /* 每个 await 之后都要复查：过期就直接退出，不弹框、不改界面 */
        if (runToken !== recordingRunToken) return;
        if (!st.ffmpeg) { toast('未安装 FFmpeg，请先前往「FFmpeg 环境」安装', 'warn'); window.App.openTool('ffmpeg-setup'); return; }
        const p = await invoke(Channels.CHANNELS.DIALOG.SAVE, { defaultPath: '录屏-' + window.TimeStamp.localStampDash() + '.mp4', filters: [{ name: 'MP4', extensions: ['mp4'] }] });
        if (!p) return;
        if (runToken !== recordingRunToken) return;
        try {
          // 摄像头是独占设备：录制前必须先释放预览流，否则 ffmpeg 打不开设备
          await stopPreview();
          if (runToken !== recordingRunToken) return;
          /* overwrite: true —— 这个路径来自上面的 dialog:save，用户若选了已存在的
           * 文件，Windows 原生保存框已经弹过「要替换它吗？」并拿到了「是」。
           * 不传这个标志就会在 rec:start 里被二次否决，想覆盖旧录像只能手动改名。 */
          await invoke(Channels.CHANNELS.REC.START, { outPath: p, fps: +fpsSel.value, rect: region, audio: audioSel.value || null,
            overwrite: true,
            camera: camSel.value || null, camPos: camPosSel.value, camScale: +camSizeSel.value });
          /* 【最关键的复查】REC.START 的 await 之后才发现页面已离开 ——
           * 录制其实已经真的开始了。必须立刻停掉并保留文件（用户可能已经
           * 录了几秒），否则它在后台一直录，而界面上什么都没显示。 */
          if (runToken !== recordingRunToken) {
            try { await invoke(Channels.CHANNELS.REC.STOP, false); } catch (e) {}
            return;
          }
          recording = true; paused = false;
          startBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false;
          status.textContent = '录制中…' + (region ? `（${region.w}×${region.h}）` : '（全屏）') + (audioSel.value ? ' + 麦克风' : '') + (camSel.value ? ' + 摄像头画中画' : '');
          camPreviewHint.textContent = '录制中（预览已让给录制）';
        } catch (e) {
          /* 过期的请求不弹错（用户已经不在这一页了） */
          if (runToken !== recordingRunToken) return;
          toast(e.message, 'error'); if (camSel.value) startPreview(camSel.value);
        }
      }
      /* 参数是布尔而不是通道名：原来把两个通道名当普通字符串传进来、
       * 函数里再比一次，等于让通道名以「数据」的形式在渲染层多存在一份，
       * 迁移成常量后只会更难对齐。 */
      async function ctl(doPause) {
        try {
          if (doPause) { await invoke(Channels.CHANNELS.REC.PAUSE); paused = true; pauseBtn.disabled = true; resumeBtn.disabled = false; status.textContent = '已暂停（分段保存，停止时自动拼接）'; }
          else { await invoke(Channels.CHANNELS.REC.RESUME); paused = false; pauseBtn.disabled = false; resumeBtn.disabled = true; status.textContent = '继续录制中…'; }
        } catch (e) { toast(e.message, 'error'); }
      }
      async function stop() {
        if (!recording) return;
        pauseBtn.disabled = resumeBtn.disabled = stopBtn.disabled = true;
        status.textContent = '正在封装' + (gifChk.checked ? '（并生成 GIF）' : '') + '…';
        try {
          const r = await invoke(Channels.CHANNELS.REC.STOP, gifChk.checked);
          recording = false; startBtn.disabled = false;
          status.textContent = `✓ 已保存：${r.outPath}（${fmtBytes(r.size || 0)}）` + (r.gif ? ` · GIF：${r.gif}` : '');
          toast('录制完成：' + fmtBytes(r.size || 0), 'success');
          // 降级（分段合并失败、只保住第一段）必须明确告知用户，
          // 否则用户以为录到的是完整的，后半段其实丢了。
          if (r.degraded) {
            status.innerHTML = '<span class="status-err">✗ ' + escapeHtml(r.degraded) + '</span>';
            toast('录制不完整：' + r.degraded, 'error', 8000);
          }
        } catch (e) { recording = false; startBtn.disabled = false; status.textContent = '✗ ' + e.message; }
        // 录制结束把摄像头交还给预览
        if (camSel.value) startPreview(camSel.value);
      }
      /* 【离开页面必须停录，并把 UI 复位成「可以重新开始」】
       * 原来只发 REC.STOP 就完事，三件事全没做：
       *   ① recording 仍是 true → 保活复用后界面显示「录制中…」、开始按钮禁用；
       *   ② 再点「停止」会对**已经结束的**录制再发一次 REC.STOP（二次 STOP，
       *      主进程那边要么报错要么重复封装）；
       *   ③ 摄像头预览/暂停按钮状态保持上一次的样子。
       * 现在：发 STOP（尽力而为）+ 立刻把本地状态与所有按钮复位。
       * 【为什么先把 recording 置 false 再发 STOP】
       * invoke 是异步的，若等它返回再置位，用户在这段时间里切回来会看到
       * 仍是「录制中」；而 stop() 里有 `if (!recording) return` 守卫，
       * 提前置 false 正好也挡住了重复 STOP。 */
      window.App.onCleanup(() => {
        /* 【先递增两套序号】任何在飞的 start()/startPreview() 立刻作废：
         * 它们的 await 返回时会发现 token 变了，于是：
         *   · start() 若已把 REC.START 发出去，会自己发 STOP 收尾；
         *   · startPreview() 会把刚拿到的 stream 关掉。
         * 【必须在发 STOP 之前递增】否则同一 tick 内返回的旧请求
         * 仍会通过检查并把 recording 置真。 */
        recordingRunToken++;
        previewGeneration++;
        /* 停止预览：离开页面时摄像头不该继续占用（也让之后的 getUserMedia 失效） */
        try { stopPreview(); } catch (e) {}
        if (!recording) {
          /* 没在录，但界面可能停在「录制中…」（旧请求刚把它刷上去），一并复位 */
          try {
            startBtn.disabled = false;
            pauseBtn.disabled = resumeBtn.disabled = stopBtn.disabled = true;
            paused = false;
            if (/录制中|正在封装/.test(status.textContent || '')) status.textContent = '已离开页面，录制已停止';
            camPreviewHint.textContent = '已离开页面，预览已释放';
          } catch (e) {}
          return;
        }
        recording = false;
        try {
          pauseBtn.disabled = true; resumeBtn.disabled = true; stopBtn.disabled = true;
          startBtn.disabled = false;
          paused = false;
          status.textContent = '已离开页面，录制已停止';
          /* 【提示文案必须跟着复位】原来一直停在
           * 「录制中（预览已让给录制）」—— 而录制已经停了、预览也已经释放，
           * 复用回来后用户看到这句话会以为还在录。 */
          camPreviewHint.textContent = '已离开页面，预览已释放';
        } catch (e) {}
        invoke(Channels.CHANNELS.REC.STOP, false).catch((e) => {
          /* 【不能静默】停不下来意味着后台还在录 —— 这是必须让用户知道的事
           * （规则第 5 条：解决不了要报告）。用 toast 明示。 */
          try { toast('停止录制失败：' + ((e && e.message) || e), 'error', 8000); } catch (e2) {}
        });
      });
      /* 【复用回来时按真实状态重刷，并把摄像头预览恢复起来】
       * 保活复用的是同一块 DOM；cleanup 已经把预览释放掉了（stopPreview），
       * 但 DOM 里 camPreview 还留着上一轮的残留状态。不重新启动预览的话，
       * 返回页面后选着摄像头的用户会看到一个永久黑掉的预览框 ——
       * 因为 destroyed 那套旧方案从不复位，预览再也起不来。 */
      if (window.App.onEnter) {
        window.App.onEnter(() => {
          try {
            const on = !!recording;
            startBtn.disabled = on;
            stopBtn.disabled = !on;
            pauseBtn.disabled = !on || paused;
            resumeBtn.disabled = !on || !paused;
            if (!on && /录制中|正在封装/.test(status.textContent || '')) status.textContent = '已离开页面，录制已停止';
            /* 恢复预览：录制没在跑时才恢复（录制要独占设备） */
            if (!on) {
              if (camSel.value) startPreview(camSel.value);
              else camPreviewHint.textContent = '选择摄像头后在此预览';
            }
          } catch (e) {}
        });
      }
      page.appendChild(div('card', div('card-title', '录制'),
        div('form-row', h('span', { class: 'form-label' }, '帧率'), fpsSel,
          h('span', { class: 'form-label', style: { minWidth: 'auto' } }, '区域'), regionBtn, clearRegionBtn, regionLabel),
        div('form-row', h('span', { class: 'form-label' }, '声音'), audioSel,
          h('label', { class: 'field-hint' }, gifChk, ' 停止时同时导出 GIF')),
        div('form-row', h('span', { class: 'form-label' }, '摄像头'), camSel, camPosSel, camSizeSel),
        div('form-row', h('span', { class: 'form-label' }, '预览'), camPreview, camPreviewHint),
        div('form-row', startBtn, ' ', pauseBtn, resumeBtn, ' ', stopBtn, status)));
    }
  })
})();
