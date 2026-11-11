    const params = new URLSearchParams(location.search);
    const MODE = params.get('mode') === 'region' ? 'region' : 'annotate';
    const DX = +params.get('dx') || 0, DY = +params.get('dy') || 0, SCALE = +params.get('scale') || 1;
    /* eslint-disable-next-line no-unused-vars -- 历史遗留：变量赋值后未使用（下一轮清理；本轮要求零行为改动） */
    const W = +params.get('w') || window.innerWidth, H = +params.get('h') || window.innerHeight;
    const canvas = document.getElementById('c');
    const bar = document.getElementById('bar');
    /* stage 是整块画布容器（框选/拖动/标注的三个 mousedown/mousemove/mouseup
     * 都挂在它上面）。以前这里没写这一行，靠「元素的 id 会自动成为 window
     * 上的同名属性」这条老机制才没报错 —— 但那是浏览器兼容行为，
     * 本文件里 canvas/bar/tip/textInput 全是显式 getElementById，
     * 只有它悬空，读代码时会以为 stage 是从别处传进来的。补齐。 */
    const stage = document.getElementById('stage');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    let sel = null;           // {x,y,w,h} 逻辑坐标（相对本窗口）
    let selecting = false, dragStart = null;
    let tool = 'rect', color = '#FF4D4F', size = 3;
    let shapes = [];          // {type, x1,y1,x2,y2, color, size, text, pts}
    let drawing = null;

    /* 【画布尺寸与源图的映射：必须 1:1 物理像素对齐，不能拉伸】
     *
     * 实测（本机 187.5% 缩放，逻辑屏 1366×854）：
     *   窗口 innerWidth/innerHeight = 1367 × 855   ← 比屏幕逻辑尺寸多 1px
     *   devicePixelRatio            = 1.875
     *   canvas 位图                  = 2563 × 1603   ← 1367×1.875, 855×1.875
     *   源图（display.size × scaleFactor，已取整）
     *                               = 2561 × 1601   ← 1366×1.875, 854×1.875
     *
     * 原实现是
     *   ctx.scale(dpr, dpr);
     *   ctx.drawImage(img, 0, 0, innerWidth, innerHeight);   // 按窗口逻辑尺寸铺满
     * 也就是把 2561×1601 的源图**拉满** 2563×1603 个物理像素：
     *   横向 × 2563/2561 = 1.00078
     *   纵向 × 1603/1601 = 1.00125
     * 两个方向的拉伸比不一致 → **各向异性变形**，而且是非整数缩放，
     * 画面还会发虚。用户看到的就是「框选时屏幕变形」。
     * （1px 之差在 100% 缩放下几乎不可见，187.5%/250% 这类非整数缩放才显形。）
     *
     * 【修法】不做任何缩放：源图 1 个物理像素 ↔ 画布 1 个物理像素。
     *   · 画布位图尺寸仍然按 innerWidth*dpr 建 —— 这样它一定 ≥ 源图，
     *     多出来的右/下边缘留空（透明），不会出现"源图不够铺"的黑边；
     *   · 绘制时关掉 ctx.scale，直接把源图按**位图坐标**画到 (0,0)，
     *     尺寸取源图自身的 naturalWidth/Height（即 2561×1601）；
     *   · 多出的 2×2 物理像素在右/下边缘，被窗口裁掉，用户看不到。
     *
     * 【为什么不再用 ctx.scale(dpr,dpr)】
     * 它让"一个逻辑单位 = dpr 个物理像素"，于是所有几何都要在逻辑坐标里算，
     * 而源图是物理尺寸 —— 两者之间必须做一次换算，那个换算正是变形来源。
     * 改成"画布坐标 = 物理像素"之后，鼠标坐标也能直接乘 dpr 使用，
     * 整条链路只有一次乘法，不会再出现两个方向比例不同的情况。
     *
     * 【注意】下面 render() 与 finish() 里所有几何都改成了物理像素坐标，
     * 鼠标事件给的仍是逻辑像素，统一在取用处乘 dpr（见 toPhysical()）。 */
    const DPR = devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * DPR);
    canvas.height = Math.round(window.innerHeight * DPR);
    /* 不再 ctx.scale —— 画布坐标就是物理像素 */
    /* 逻辑像素 → 画布物理像素。鼠标事件（clientX/Y）与 sel 全程是逻辑像素，
     * 只有落到画布上时才换算，这样"选区几何"与"鼠标手感"仍是同一套数。 */
    function toPhysical(v) { return v * DPR; }
    img.src = 'file:///' + encodeURI(params.get('src').replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');

    function render() {
      /* 用物理像素清屏（画布坐标 = 物理像素） */
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      /* 【1:1 贴合，不拉伸】源图多大就画多大，尺寸取自 img 自身。
       * img 还没解码完时 naturalWidth 为 0，此时跳过绘制（load 后会再 render）。 */
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight);
      }
      const PW = canvas.width, PH = canvas.height;
      /* 下面所有几何都乘 DPR，落到物理像素坐标系 */
      const S = {
        x: toPhysical(sel ? sel.x : 0), y: toPhysical(sel ? sel.y : 0),
        w: toPhysical(sel ? sel.w : 0), h: toPhysical(sel ? sel.h : 0),
      };
      if (!sel) { // 未选区：全屏压暗
        ctx.fillStyle = 'rgba(0,0,20,0.28)';
        ctx.fillRect(0, 0, PW, PH);
      } else {
        // 选区外压暗（四块）
        ctx.fillStyle = 'rgba(0,0,20,0.38)';
        ctx.fillRect(0, 0, PW, S.y);
        ctx.fillRect(0, S.y, S.x, S.h);
        ctx.fillRect(S.x + S.w, S.y, PW - S.x - S.w, S.h);
        ctx.fillRect(0, S.y + S.h, PW, PH - S.y - S.h);
        // 边框（线宽按物理像素给，保持视觉粗细一致）
        ctx.strokeStyle = accentPrimary(); ctx.lineWidth = 1.5 * DPR;
        ctx.strokeRect(S.x + .5, S.y + .5, S.w - 1, S.h - 1);
        // 八个手柄（尺寸也乘 DPR，否则高 DPI 下手柄会显得很小）
        ctx.fillStyle = '#fff';
        const hs = 6 * DPR;
        for (const [hx, hy] of [[S.x, S.y], [S.x + S.w / 2, S.y], [S.x + S.w, S.y], [S.x, S.y + S.h / 2], [S.x + S.w, S.y + S.h / 2], [S.x, S.y + S.h], [S.x + S.w / 2, S.y + S.h], [S.x + S.w, S.y + S.h]])
          ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        /* 裁剪区绘制标注：标注的几何是逻辑坐标，这里用 transform 一次性换到物理像素，
         * 不用逐个改 drawShape（那些函数共用一套坐标语义，改它们风险更大）。 */
        ctx.save();
        ctx.beginPath(); ctx.rect(S.x, S.y, S.w, S.h); ctx.clip();
        ctx.scale(DPR, DPR);
        for (const s of shapes) drawShape(s);
        if (drawing) drawShape(drawing);
        ctx.restore();
      }
    }
    function drawShape(s) {
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.size;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (s.type === 'rect') ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
      else if (s.type === 'arrow') {
        const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        const head = Math.max(10, s.size * 3.5);
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x2, s.y2);
        ctx.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 7), s.y2 - head * Math.sin(ang - Math.PI / 7));
        ctx.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 7), s.y2 - head * Math.sin(ang + Math.PI / 7));
        ctx.closePath(); ctx.fill();
      } else if (s.type === 'pen' || s.type === 'mosaic') {
        if (s.type === 'pen') {
          ctx.beginPath();
          s.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
          ctx.stroke();
        } else {
          /* 【马赛克：必须「小图取样 → 大图铺开」，src 与 dst 尺寸不能相等】
           *
           * 原实现把源矩形和目标矩形都设成了同一个尺寸：
           *   drawImage(img, sx, sy, px*DPR, px*DPR,  p.x-px/2, p.y-px/2, px, px)
           * 而 drawShape 运行在 ctx.scale(DPR, DPR) 之下（见 render），
           * 所以目标尺寸 px 会被放大成 px*DPR —— **与源矩形完全相等**。
           * 1:1 复制 = 什么都没改，用户看到的就是「马赛克点了没反应」。
           * 实测（本机 DPR 1.875，size=3 → px=9）：
           *   源 9×1.875 = 16.875 物理像素 → 目标 9×1.875 = 16.875 物理像素
           *   棋盘格背景上「明暗跳变数」涂抹前后 2599 → 2909（没变，差异来自选区边框）
           *
           * 【修法】取样格子固定为 BLOCK 逻辑像素，源矩形取 BLOCK*DPR，
           * 目标矩形取 BLOCK —— 比例恒为 DPR，缩放恒定有效：
           *   · BLOCK 越大越糊，这里取 px（= size*3，马赛克与画笔线宽联动）；
           *   · 关闭 imageSmoothingEnabled 才能得到「硬边马赛克」而不是模糊。
           *
           * 【为什么用 9 宫格采样取平均色，而不是直接 drawImage 缩放】
           * drawImage 缩小时会做插值，得到的是一团模糊（等于高斯模糊），
           * 不是马赛克。真正的马赛克要「一格一个纯色」。所以先读该格的
           * 平均色，再用纯色填充 —— 这样格子边界清晰，也确实抹掉了细节。 */
          const block = Math.max(6, s.size * 3);
          /* 记录已经画过的格子，避免路径在自身附近往返时反复叠加
           * （每格纯色是幂等的，但可以省掉大量重复取样） */
          const painted = new Set();
          for (const p of s.pts) {
            const gx = Math.floor(p.x / block);
            const gy = Math.floor(p.y / block);
            const key = gx + ',' + gy;
            if (painted.has(key)) continue;
            painted.add(key);
            /* 取该格在源图上的平均色（源图是物理像素，坐标乘 DPR） */
            const sx = Math.round(gx * block * DPR);
            const sy = Math.round(gy * block * DPR);
            const sw = Math.max(1, Math.round(block * DPR));
            const sh = Math.max(1, Math.round(block * DPR));
            let r = 128, g = 128, b = 128;
            try {
              const id = getSourceData(sx, sy, sw, sh);
              if (id) {
                let sr = 0, sg = 0, sb = 0, n = 0;
                for (let i = 0; i < id.length; i += 4) { sr += id[i]; sg += id[i + 1]; sb += id[i + 2]; n++; }
                if (n) { r = Math.round(sr / n); g = Math.round(sg / n); b = Math.round(sb / n); }
              }
            } catch (e) { /* 越界取样（路径贴边）时退回灰色，不让整段标注炸掉 */ }
            ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
            ctx.fillRect(gx * block, gy * block, block, block);
          }
          ctx.fillStyle = s.color;   // 恢复，后面的图形继续用原色
        }
      } else if (s.type === 'text') {
        ctx.font = `${s.size * 7}px 'Microsoft YaHei', sans-serif`;
        ctx.textBaseline = 'top';
        const lines = String(s.text || '').split('\n');
        lines.forEach((ln, i) => ctx.fillText(ln, s.x1, s.y1 + i * s.size * 8));
      }
    }
    img.onload = render;
    window.addEventListener('resize', () => { render(); });

    /* 【从源图读一块像素的平均色 —— 马赛克要用】
     *
     * 不能在主画布 ctx 上直接 getImageData：那时画布上已经压了压暗遮罩
     * 和之前画的标注，取到的会是被污染的颜色（马赛克会把压暗的灰也吸进来，
     * 越涂越黑）。所以单独开一块离屏画布，只把源图对应区域画进去再读。
     *
     * 离屏画布按需创建、复用一张：每次 new canvas 会在连续拖拽时产生
     * 大量临时对象（一次拖拽可能几百个点）。
     * 采样尺寸封顶 64：块再大也不需要更高精度，读整块像素很贵。 */
    let srcCanvas = null, srcCtx = null;
    function getSourceData(sx, sy, sw, sh) {
      if (!img.naturalWidth) return null;
      const w = Math.max(1, Math.min(64, sw)), h = Math.max(1, Math.min(64, sh));
      if (!srcCanvas) {
        srcCanvas = document.createElement('canvas');
        srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (srcCanvas.width !== w || srcCanvas.height !== h) {
        srcCanvas.width = w; srcCanvas.height = h;
      }
      srcCtx.clearRect(0, 0, w, h);
      /* 越界部分不画（留透明），调用方按实际读到的像素求平均；
       * 源图边缘之外的马赛克会偏暗，这是可接受的（用户本来就涂在图上）。 */
      try { srcCtx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h); } catch (e) { return null; }
      try { return srcCtx.getImageData(0, 0, w, h).data; } catch (e) { return null; }
    }

    /* ---------- 选区 ---------- */
    const tip = document.getElementById('tip'), sizeTip = document.getElementById('sizeTip');
    setTimeout(() => { tip.style.display = 'block'; setTimeout(() => tip.style.display = 'none', 3000); }, 400);
    stage.addEventListener('mousedown', (e) => {
      if (!sel) {
        if (e.button !== 0) return;
        selecting = true; dragStart = { x: e.clientX, y: e.clientY };
      } else if (drawingTool()) {
        const p = { x: e.clientX, y: e.clientY };
        if (tool === 'pen' || tool === 'mosaic') drawing = { type: tool, color, size, pts: [p] };
        else if (tool === 'text') openTextInput(p);
        else drawing = { type: tool, color, size, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      }
    });
    /* 哪些工具靠「按下—拖动—抬起」产生图形。
     *
     * text 必须在内：它的流程是「点一下弹出输入框、回车落字」，没有拖拽那一步，
     * 但**第一下也要走这个 mousedown 分支**才能调到 openTextInput。
     * 以前白名单只有 rect/arrow/pen/mosaic，于是 tool==='text' 时整段被跳过 ——
     * 工具条上明明有 T 按钮（见 TOOLS），点了却在画布上没反应，
     * openTextInput 永远不会被调用。 */
    function drawingTool() { return ['rect', 'arrow', 'pen', 'mosaic', 'text'].includes(tool); }
    stage.addEventListener('mousemove', (e) => {
      if (selecting) {
        sel = { x: Math.min(dragStart.x, e.clientX), y: Math.min(dragStart.y, e.clientY),
          w: Math.abs(e.clientX - dragStart.x), h: Math.abs(e.clientY - dragStart.y) };
        sizeTip.style.display = 'block';
        sizeTip.style.left = (sel.x + sel.w / 2 - 30) + 'px';
        sizeTip.style.top = Math.max(4, sel.y - 26) + 'px';
        sizeTip.textContent = `${sel.w} × ${sel.h}`;
        render();
      } else if (drawing) {
        const p = { x: e.clientX, y: e.clientY };
        if (drawing.pts) drawing.pts.push(p);
        else { drawing.x2 = p.x; drawing.y2 = p.y; }
        render();
      }
    });
    stage.addEventListener('mouseup', () => {
      if (selecting) {
        selecting = false;
        sizeTip.style.display = 'none';
        if (sel && sel.w > 8 && sel.h > 8) {
          if (MODE === 'region') { finish('region'); return; }
          showBar();
        } else { sel = null; render(); }
      } else if (drawing) {
        if (drawing.type !== 'text' && !drawing.pts || (drawing.pts && drawing.pts.length > 1) || (!drawing.pts && (Math.abs(drawing.x2 - drawing.x1) + Math.abs(drawing.y2 - drawing.y1) > 3))) shapes.push(drawing);
        else if (drawing.pts && drawing.pts.length === 1) shapes.push(drawing);
        drawing = null; render();
      }
    });

    /* ---------- 工具条 ---------- */
    /* 【图标统一为线性 SVG】
     * 原来 TOOLS 用的是字符图标：▭ ➚ ✏️ T ▦。五个按钮三种形态：
     *   · ▭ ▦ 是 U+25A0 区段的几何字符 —— 依赖字体，缺字时是豆腐块；
     *   · ✏️ 是彩色 emoji —— 深色浮层上会被系统染色，且字重、基线、
     *     颜色全部不受控（项目在 afa0bdc 那轮把全项目 122 处同类 emoji
     *     换成了 SVG，唯独这里的工具条当时被认为"没有图标系统的位置"）；
     *   · T 是字母 —— 粗细跟着字体走，与线条图标不是一套。
     * 现在给每个按钮内联一段 24×24 / stroke 2 / currentColor 的路径，
     * 与 js/icons.js 的规范一致（这个页面不引 icons.js：它只依赖
     * js/auxwin/ 下的两个脚本，多引一个文件要多一条 CSP/打包校验）。
     * 路径直接照搬 js/icons.js 的同名图标，视觉上与主界面完全一致。 */
    const SVG = {
      rect: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
      arrow: '<path d="M5 19 19 5"/><polyline points="11 5 19 5 19 13"/>',
      pen: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
      text: '<polyline points="4 7 4 4 20 4 20 7"/><path d="M9 20h6M12 4v16"/>',
      mosaic: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
      undo: '<polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
      redo: '<polyline points="15 14 20 9 15 4"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/>',
      copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
      save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
      pin: '<path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
      ocr: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 12h8"/>',
      /* 调色板：与主界面「颜色转换器」用的是同一形状（扇形色块 + 三点） */
      palette: '<path d="M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 0-5H13a2 2 0 0 1 0-4h2.5A5.5 5.5 0 0 0 21 6.5"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
      /* 线宽：一端细一端粗的楔形，直观表达"粗细" */
      line: '<path d="M4 18 20 6"/><path d="M4 15v6h6"/>',
    };
    function svgIcon(name) {
      return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + (SVG[name] || '') + '</svg>';
    }
    const TOOLS = [
      ['rect', 'rect', '矩形'],
      ['arrow', 'arrow', '箭头'],
      ['pen', 'pen', '画笔'],
      ['text', 'text', '文字'],
      ['mosaic', 'mosaic', '马赛克'],
    ];
    /* 【常用色 + 调色板】
     * 原来只有 6 个固定色块，想用别的颜色（比如标注截图里的品牌色）没有办法。
     * 现在：左边 6 个常用色一键选，右边一个"调色板"按钮打开系统取色器，
     * 选完的颜色会**替换**当格显示，并记进「最近用过的颜色」。
     *
     * 为什么用 <input type="color"> 而不是自己画取色面板：
     * 系统取色器支持滴管、十六进制输入、色域切换，自己画一套既做不到
     * 这些，又要在全屏透明窗里额外管理一层浮层（点击穿透、Esc 层级）。
     * 原生控件还自带可访问性。 */
    const COLORS = ['#FF4D4F', '#FFC53D', '#165DFF', '#00B42A', '#FFFFFF', '#000000'];
    /* 线宽范围：1~12。原来只有细/中/粗三档（2/3/5），
     * 画细箭头和涂粗马赛克需要的粗细跨度远比这三档大。 */
    const SIZE_MIN = 1, SIZE_MAX = 12;
    function showBar() {
      bar.innerHTML = '';
      for (const [id, iconName, label] of TOOLS) {
        const b = document.createElement('button');
        b.className = 'tbtn' + (tool === id ? ' on' : '');
        b.innerHTML = svgIcon(iconName);
        /* title 与 aria-label 都给：title 供鼠标悬停，aria-label 供读屏器。
         * 图标按钮没有可见文字，缺 aria-label 时读屏器只能念"按钮"。 */
        b.title = label;
        b.setAttribute('aria-label', label);
        b.onclick = () => { tool = id; syncBar(); };
        bar.appendChild(b);
      }
      bar.appendChild(sep());

      /* ---- 常用色 + 调色板 ---- */
      const swWrap = document.createElement('div');
      swWrap.className = 'swwrap';
      for (const c of COLORS) {
        const s = document.createElement('div');
        s.className = 'sw';
        s.dataset.color = c;
        s.style.background = c;
        s.title = c;
        s.setAttribute('aria-label', c);
        s.onclick = () => { color = c; syncBar(); };
        swWrap.appendChild(s);
      }
      /* 调色板：原生取色器藏在色块后面，点色块 = 点取色器 */
      const custom = document.createElement('label');
      custom.className = 'sw sw-custom';
      custom.title = '调色板：自定义颜色';
      custom.setAttribute('aria-label', '调色板');
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.id = 'colorPicker';
      picker.value = color;
      picker.oninput = () => {
        color = picker.value;
        /* 自定义色不再属于常用色列表，但要让它显示出来：
         * 把色块背景改成当前色，并标记 .on */
        custom.style.background = color;
        syncBar();
      };
      /* 点开取色器时不要让事件冒泡到 stage（否则会开始画一笔） */
      picker.onclick = (e) => e.stopPropagation();
      custom.appendChild(picker);
      const ico = document.createElement('span');
      ico.className = 'sw-custom-ico';
      ico.innerHTML = svgIcon('palette');
      custom.appendChild(ico);
      swWrap.appendChild(custom);
      bar.appendChild(swWrap);
      bar.appendChild(sep());

      /* ---- 线宽滑杆 ---- */
      /* 【为什么从「细/中/粗」三档改成滑杆】
       * 三档覆盖不了实际需要：画细箭头想要 1px，涂马赛克想要 10px 以上，
       * 而三档只有 2/3/5。滑杆能连续调，且实时显示当前数值，
       * 用户不用试三次才知道哪档合适。
       *
       * 【为什么用 input[type=range] 而不是自己画】
       * 原生滑杆自带键盘可达性（方向键微调）、拖动惯性、触控支持，
       * 且在全屏透明窗里不会引入额外的浮层与点击穿透问题。 */
      const szWrap = document.createElement('div');
      szWrap.className = 'szwrap';
      const szIco = document.createElement('span');
      szIco.className = 'sz-ico';
      szIco.innerHTML = svgIcon('line');
      szWrap.appendChild(szIco);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.id = 'sizeSlider';
      slider.min = String(SIZE_MIN);
      slider.max = String(SIZE_MAX);
      slider.step = '1';
      slider.value = String(size);
      slider.title = '线宽 ' + size + ' px';
      slider.setAttribute('aria-label', '线宽');
      const val = document.createElement('span');
      val.className = 'sz-num';
      val.id = 'sizeNum';
      val.textContent = String(size);
      /* input 事件 = 拖动过程中持续触发；只更新数值，不重建工具条
       * （重建会让滑杆失去拖拽状态，手指一松就跳回去）。 */
      slider.oninput = () => {
        size = Number(slider.value);
        val.textContent = String(size);
        slider.title = '线宽 ' + size + ' px';
        slider.setAttribute('aria-valuetext', size + ' 像素');
        /* 更新已填充轨道比例（原生 range 无法只用 CSS 做双色轨道） */
        const fill = ((size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN)) * 100;
        slider.style.setProperty('--fill', fill.toFixed(1) + '%');
        /* 数值文字的粗细跟着线宽变：这是最直观的"当前多粗"预览，
         * 且不会像额外的圆点那样在大尺寸时与滑块本身混淆。 */
        val.style.fontWeight = String(300 + Math.min(9, size) * 70);
        placeBar();
      };
      /* 阻止拖动滑杆时的事件冒泡到 stage（否则会画出一笔） */
      slider.addEventListener('pointerdown', (e) => e.stopPropagation());
      slider.addEventListener('mousedown', (e) => e.stopPropagation());
      slider.addEventListener('click', (e) => e.stopPropagation());
      szWrap.appendChild(slider);
      szWrap.appendChild(val);
      bar.appendChild(szWrap);
      bar.appendChild(sep());

      bar.appendChild(mkBtn('撤销', 'tbtn texty', () => { shapes.pop(); render(); }, 'undo'));
      bar.appendChild(mkBtn('重选', 'tbtn texty', () => { sel = null; shapes = []; bar.style.display = 'none'; render(); }, 'redo'));
      bar.appendChild(sep());
      bar.appendChild(mkBtn('复制', 'tbtn act texty', () => finish('copy'), 'copy'));
      bar.appendChild(mkBtn('保存', 'tbtn act texty', () => finish('save'), 'save'));
      bar.appendChild(mkBtn('贴图', 'tbtn act texty', () => finish('pin'), 'pin'));
      bar.appendChild(mkBtn('OCR', 'tbtn act texty', () => finish('ocr'), 'ocr'));
      bar.style.display = 'flex';
      syncBar();
      requestAnimationFrame(placeBar);
    }

    /* 【syncBar：只同步状态，不重建 DOM】
     * 原来每次点颜色/粗细都调 showBar() 整条重建。三个直接后果：
     *   ① 滑杆拖到一半被重建 → 拖拽中断、值跳回；
     *   ② 重建后元素是新对象，正在悬停的那个按钮"闪一下"；
     *   ③ 每次都重新算布局，颜色多起来后有明显卡顿。
     * 现在 DOM 只建一次，状态变化只改 class / 属性。 */
    function syncBar() {
      const btns = [...bar.querySelectorAll('.tbtn')];
      TOOLS.forEach(([id], i) => {
        if (btns[i]) btns[i].classList.toggle('on', tool === id);
      });
      for (const s of bar.querySelectorAll('.sw')) {
        if (s.classList.contains('sw-custom')) {
          s.classList.toggle('on', COLORS.indexOf(color) === -1);
          if (COLORS.indexOf(color) === -1) s.style.background = color;
        } else {
          s.classList.toggle('on', s.dataset.color === color);
        }
      }
      const picker = bar.querySelector('#colorPicker');
      if (picker && COLORS.indexOf(color) === -1) picker.value = color;
      const slider = bar.querySelector('#sizeSlider');
      if (slider && Number(slider.value) !== size) slider.value = String(size);
      /* 初始也要把已填充轨道比例算出来，否则重建后滑杆右侧是空轨道 */
      if (slider) {
        const fill = ((size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN)) * 100;
        slider.style.setProperty('--fill', fill.toFixed(1) + '%');
      }
      const num = bar.querySelector('#sizeNum');
      if (num) {
        num.textContent = String(size);
        /* 与 oninput 保持一致：重建后数值的粗细也要跟上当前线宽 */
        num.style.fontWeight = String(300 + Math.min(9, size) * 70);
      }
    }

    /* 【工具条定位：独立成函数，滑杆拖动/颜色切换时也能重新贴边】
     * 原来这段逻辑内联在 showBar 的 requestAnimationFrame 里，
     * 只有"重建工具条"时才会重新定位 —— 而滑杆改变宽度后工具条变宽，
     * 会超出屏幕右缘（用户看不到右边的按钮）。 */
    function placeBar() {
      if (!sel || bar.style.display === 'none') return;
      const bw = bar.offsetWidth, bh = bar.offsetHeight;
      let x = sel.x + sel.w - bw, y = sel.y + sel.h + 10;
      if (y + bh > window.innerHeight) y = sel.y - bh - 10;
      if (y < 0) y = sel.y + 10;
      x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
      bar.style.left = x + 'px'; bar.style.top = y + 'px';
    }
    /* 【mkBtn 支持前置图标】
     * 原来只用 textContent，图标按钮与文字按钮无法混排。
     * 现在 iconName 可选：给了就先插 SVG 再插文字，两者都用同一套
     * .icon 尺寸与 currentColor，选中/悬停时颜色一起变。 */
    function mkBtn(t, cls, fn, iconName) {
      const b = document.createElement('button');
      b.className = cls;
      b.innerHTML = (iconName ? svgIcon(iconName) : '') + '<span>' + t + '</span>';
      b.title = t;
      b.setAttribute('aria-label', t);
      b.onclick = fn;
      return b;
    }
    function sep() { const s = document.createElement('div'); s.className = 'sep'; return s; }

    /* ---------- 文字输入 ---------- */
    const textInput = document.getElementById('textInput');
    /* 文字输入的提交必须**只挂一次**。
     *
     * 这里原来每次 openTextInput 都执行一次 textInput.addEventListener('keydown', ...)，
     * 而提交后只 removeEventListener('blur', commit) —— keydown 那一个从不摘除。
     * 于是每加一处文字就多留一个闭包，闭包里封着**那一次的坐标 p**，
     * 而 commit 读的是输入框**当前**的值：下一次输入时，所有旧闭包都被同一个
     * Enter 唤醒，各按自己记住的坐标 push 一份当前文本。
     * 实测「A 点输入甲 → B 点输入乙 → C 点输入丙」会得到 6 份文字标注（而不是 3 份）。
     *
     * 修法：keydown 用 onkeydown 赋值（每次覆盖，天然只有一份），
     * blur 仍在 commit 里自行摘除 —— 两条提交路径（Enter / 失焦）都要收一次尾。
     * 另加 committed 闸：Enter 提交后输入框会隐藏并失焦，blur 会再进来一次，
     * 没有这个闸就会同一次输入 push 两份。 */
    function openTextInput(p) {
      textInput.value = '';
      textInput.style.left = p.x + 'px'; textInput.style.top = p.y + 'px';
      textInput.style.color = color;
      textInput.style.display = 'block';
      textInput.focus();
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        textInput.style.display = 'none';
        textInput.onkeydown = null;
        if (textInput.value.trim()) {
          shapes.push({ type: 'text', x1: p.x, y1: p.y, color, size, text: textInput.value });
          render();
        }
        textInput.removeEventListener('blur', commit);
      };
      textInput.onkeydown = (ev) => {
        ev.stopPropagation();
        /* 【输入法组词中，回车/退格都归输入法，不能当提交/编辑处理】
         *
         * 中文用户打「你好」的实际顺序是：
         *   敲 n i h a o → 输入框里是拼音占位 → 按空格/回车选候选词
         *   → 此时才真正落汉字 → 再按一次回车才表示「写完了」。
         *
         * 选候选词那一次回车，浏览器给出的 KeyboardEvent 带 isComposing=true
         * （或 keyCode 229）。原实现只判 `ev.key === 'Enter'`，于是：
         *   · 用户打「ni'hao」第一次回车选词 → 直接把拼音 "nihao" 当成正文提交，
         *     输入框消失，汉字根本没机会进输入框 —— 中文输入法用户看到的就是
         *     「点了 T 什么都打不出来」或「打出来是拼音」。
         *   · 同样的道理，组词途中按 Esc 想取消候选词，会连整个输入一起取消。
         *
         * 所以组词期间直接放行给输入法（只 stopPropagation 防止触发全局快捷键，
         * 不做任何业务处理）。 */
        if (ev.isComposing || ev.keyCode === 229) return;
        /* Shift+Enter 换行：多行文字标注本来就是支持的（见 drawShape 里的
         * split('\n')），但输入框是 <input> 不是 textarea，所以这里把
         * Shift+Enter 转成一个换行符插到光标处，让多行标注真的可用。 */
        if (ev.key === 'Enter' && ev.shiftKey) {
          ev.preventDefault();
          const st = textInput.selectionStart == null ? textInput.value.length : textInput.selectionStart;
          const en = textInput.selectionEnd == null ? st : textInput.selectionEnd;
          textInput.value = textInput.value.slice(0, st) + '\n' + textInput.value.slice(en);
          try { textInput.setSelectionRange(st + 1, st + 1); } catch (e) {}
          return;
        }
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); textInput.value = ''; commit(); }
      };
      textInput.addEventListener('blur', commit);
    }

    /* ---------- 输出 ---------- */
    function finish(action) {
      if (action !== 'cancel' && !sel) return;
      let payload = { action };
      if (action === 'region') {
        // 物理坐标（供区域录制等）
        payload.rect = { x: Math.round((sel.x + DX) * SCALE), y: Math.round((sel.y + DY) * SCALE), w: Math.round(sel.w * SCALE), h: Math.round(sel.h * SCALE) };
      } else if (action !== 'cancel') {
        const dpr = DPR;
        /* 【导出裁剪：画布已经是物理像素，这里不再有"逻辑→位图"的换算】
         * 改版前 canvas 里存的是「逻辑坐标 × dpr」的位图，源矩形必须乘 dpr 才取对；
         * 现在 canvas 的坐标本身就是物理像素（见文件上方 DPR 段的说明），
         * 所以源矩形直接是 sel × dpr，仍然要乘——因为 sel 是逻辑像素。
         * 目标画布尺寸也按物理像素建，且**不再 octx.scale**：
         * 一旦 scale 了，drawImage 的目标矩形就变成逻辑单位，会再缩一次。
         * 输出尺寸 = sel.w*dpr × sel.h*dpr，正是用户框选区域在屏幕上的真实物理像素数。 */
        const sx = Math.round(sel.x * dpr), sy = Math.round(sel.y * dpr);
        const sw = Math.max(1, Math.round(sel.w * dpr)), sh = Math.max(1, Math.round(sel.h * dpr));
        const out = document.createElement('canvas');
        out.width = sw; out.height = sh;
        const octx = out.getContext('2d');
        octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        payload.dataUrl = out.toDataURL('image/png');
      }
      try { hehe.invoke(window.Channels.CHANNELS.SNIP.FINISH, payload).catch(() => {}); } catch (e) {}
      try { window.close(); } catch (e) {}
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') finish(sel ? 'cancel' : 'cancel');
      if (e.key === 'Enter' && sel && MODE !== 'region') finish('copy');
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { shapes.pop(); render(); }
    });
    window.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (sel) { shapes = []; sel = null; bar.style.display = 'none'; render(); } // 右键重选
    });
    render();

    /* E2E 测试钩子：只在开发/测试态挂出。
     *
     * 以前无条件 `window.__snipTest = {...}`，打包版里也一直躺着 —— 等于给生产
     * 包留了一个能直接改选区、塞 shape、触发 finish 的后门。js/tools/media.js
     * 里同类钩子都用 isDev 门控，这里跟它对齐。
     *
     * 辅助窗口没有渲染层的 window.api（那套只在主窗口的 js/api.js 里），
     * 但 preload.js 已经把 isDev 通过 contextBridge 暴露到 window.hehe，
     * 因此这里读 hehe.isDev 就够了，不需要另造注入机制。
     * scripts/test-snip-e2e.js 用未打包的 electron.exe 起窗口，此时
     * app.isPackaged 为 false → isDev 为 true，测试照常能拿到钩子。
     * 打包态若确实需要跑 E2E，设 HEHE_TEST_HOOKS=1 即可（见 preload.js）。 */
    if (window.hehe && window.hehe.isDev) {
      window.__snipTest = {
        select(x, y, w, h) { sel = { x, y, w, h }; if (MODE !== 'region') showBar(); render(); },
        setTool(t) { tool = t; },
        addShape(s) { shapes.push(s); render(); },
        finish,
        getSel: () => sel, getShapes: () => shapes
      };
    }
  
