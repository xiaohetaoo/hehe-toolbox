/* 模块：多媒体处理 —— screen-rec（任务 9 从 media.js 拆出，逻辑逐字搬移，未改语义） */
(function () {
  const Channels = window.Channels;   // IPC 通道名常量（见 lib/channels.js）
  const { register } = window.Registry;
  const { div, btn, toast, fmtBytes } = window.ui;
  const { invoke } = window.api;
  const MOD = 'media';

register({
    id: 'screen-rec', name: '屏幕录制', nameEn: 'Screen Record', module: MOD, icon: 'film',
    desc: '录制全屏或框选区域为 MP4，可选麦克风与摄像头画中画、暂停恢复、直出 GIF', descEn: 'Record the screen or a region, optionally with microphone and camera overlay',
    keywords: ['录制', '录屏', '屏幕', 'video', 'capture', '区域', '摄像头', '画中画', 'camera', 'webcam'],
    render(page) {
      const fpsSel = h('select', { class: 'select input-sm' },
        h('option', { value: '15' }, '15 帧（文件小）'), h('option', { value: '30', selected: true }, '30 帧（流畅）'), h('option', { value: '60' }, '60 帧（高帧率）'));
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
      let destroyed = false;
      async function stopPreview() {
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
        if (destroyed) return;   // 页面已销毁就别再开摄像头了
        if (!dshowName) { camPreviewHint.textContent = '选择摄像头后在此预览'; return; }
        try {
          const realId = await resolveDeviceId(dshowName);
          if (destroyed) return;   // resolveDeviceId 里要等权限，可能已经切走了
          if (!realId) {
            // 不静默回落到默认摄像头：那会预览一个跟录制不同的设备，比不预览更误导
            camPreviewHint.textContent = '预览不可用：浏览器未匹配到该摄像头（名称不一致），录制不受影响';
            return;
          }
          const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: realId } }, audio: false });
          /* 拿到 stream 时再查一次 destroyed：这个 await 可能跨越了整个页面生命周期。
           * 已销毁的话直接关掉，否则摄像头会一直亮着 —— 而此刻页面已经没了，
           * 除了重启程序没有任何办法把它关掉。 */
          if (destroyed) { stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); return; }
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
      /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
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
       * 同时置 destroyed：getUserMedia 的 await 可能还没回来，
       * 光停「当时已知的」stream 挡不住那个迟到的结果（见 startPreview）。 */
      window.App.onCleanup(() => { destroyed = true; stopPreview(); });
      [fpsSel, audioSel, camPosSel, camSizeSel].forEach(el => el.addEventListener('change', saveRecPrefs));
      gifChk.addEventListener('change', saveRecPrefs);
      async function pickRegion() {
        try {
          await invoke(Channels.CHANNELS.SNIP.START, 'region');
          status.textContent = '请在屏幕上框选录制区域…';
          const rect = await new Promise((resolve) => {
            const t = setTimeout(() => { unsub(); resolve(null); }, 120000);
            const unsub = window.api.on('snip:region', (rr) => { clearTimeout(t); unsub(); resolve(rr); });
          });
          if (rect && rect.w >= 64 && rect.h >= 64) { region = rect; regionLabel.textContent = `${rect.w}×${rect.h}`; status.textContent = '已选择录制区域'; }
          else if (rect) toast('区域太小，请重新选择', 'warn');
          else status.textContent = '未选择区域（保持全屏）';
        } catch (e) { toast(e.message, 'error'); }
      }
      async function start() {
        const st = await invoke(Channels.CHANNELS.FFMPEG.STATUS).catch(() => ({ ffmpeg: null }));
        if (!st.ffmpeg) { toast('未安装 FFmpeg，请先前往「FFmpeg 环境」安装', 'warn'); window.App.openTool('ffmpeg-setup'); return; }
        const p = await invoke(Channels.CHANNELS.DIALOG.SAVE, { defaultPath: '录屏-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.mp4', filters: [{ name: 'MP4', extensions: ['mp4'] }] });
        if (!p) return;
        try {
          // 摄像头是独占设备：录制前必须先释放预览流，否则 ffmpeg 打不开设备
          await stopPreview();
          /* overwrite: true —— 这个路径来自上面的 dialog:save，用户若选了已存在的
           * 文件，Windows 原生保存框已经弹过「要替换它吗？」并拿到了「是」。
           * 不传这个标志就会在 rec:start 里被二次否决，想覆盖旧录像只能手动改名。 */
          await invoke(Channels.CHANNELS.REC.START, { outPath: p, fps: +fpsSel.value, rect: region, audio: audioSel.value || null,
            overwrite: true,
            camera: camSel.value || null, camPos: camPosSel.value, camScale: +camSizeSel.value });
          recording = true; paused = false;
          startBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false;
          status.textContent = '录制中…' + (region ? `（${region.w}×${region.h}）` : '（全屏）') + (audioSel.value ? ' + 麦克风' : '') + (camSel.value ? ' + 摄像头画中画' : '');
          camPreviewHint.textContent = '录制中（预览已让给录制）';
        } catch (e) { toast(e.message, 'error'); if (camSel.value) startPreview(camSel.value); }
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
      window.App.onCleanup(() => { if (recording) invoke(Channels.CHANNELS.REC.STOP, false).catch(() => {}); });
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
