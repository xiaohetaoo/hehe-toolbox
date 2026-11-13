'use strict';
/* 窗口布局预设：把一组窗口一次摆成分屏/四宫格/堆叠。
 *
 * ============ 复用现有的 Win32 调用方式 ============
 * winmgr（置顶/透明度/置底）已经有一套「PowerShell Add-Type 内联 C#」
 * 的成熟模式，其中 SetWindowPos 就是摆窗口需要的函数。这里沿用同一套，
 * 不引入新依赖、也不新写一个原生模块。
 *
 * ============ 为什么要把"算位置"和"调 Win32"分开 ============
 * 位置计算是纯函数，可以在 Node 里用已知值验（格子边界、间距、
 * 多显示器偏移）；而 SetWindowPos 必须真机跑。
 * 混在一起写的话，位置算错了只能靠眼睛看，算对了也可能被
 * 窗口边框/DPI 的细节掩盖。分开之后前者可测、后者靠真机走查。
 */

/* ---------- 1. 纯函数：布局计算（可测） ---------- */
const LAYOUTS = {
  /* 分屏：左右各一半。最常见的用法是"一边写、一边查"。 */
  'v-split': { label: '左右分屏', slots: [[0, 0, 1 / 2, 1], [1 / 2, 0, 1 / 2, 1]] },
  'h-split': { label: '上下分屏', slots: [[0, 0, 1, 1 / 2], [0, 1 / 2, 1, 1 / 2]] },
  'grid-4': {
    label: '四宫格',
    slots: [[0, 0, 1 / 2, 1 / 2], [1 / 2, 0, 1 / 2, 1 / 2], [0, 1 / 2, 1 / 2, 1 / 2], [1 / 2, 1 / 2, 1 / 2, 1 / 2]],
  },
  'grid-3': {
    label: '三分（左大右两小）',
    slots: [[0, 0, 1 / 2, 1], [1 / 2, 0, 1 / 2, 1 / 2], [1 / 2, 1 / 2, 1 / 2, 1 / 2]],
  },
  'main-left': {
    label: '主窗左、其余右列',
    slots: null,   // 特殊：第一个占左半，其余平均分右半
  },
  'stack': {
    label: '层叠（依次错开）',
    slots: null,   // 特殊：固定尺寸 + 每层偏移
  },
};

/**
 * 算出一组窗口的目标矩形。
 * @param {string} kind   布局 id
 * @param {{x:number,y:number,width:number,height:number}} area 可用区域（屏幕工作区）
 * @param {number} count  窗口数量
 * @param {number} [gap]  窗口之间的间距
 * @returns {Array<{x:number,y:number,width:number,height:number}>}
 */
function computeLayout(kind, area, count, gap) {
  const g = Math.max(0, gap == null ? 8 : gap);
  const ax = Math.round(area.x), ay = Math.round(area.y);
  const aw = Math.round(area.width), ah = Math.round(area.height);
  const n = Math.max(1, Math.min(8, count | 0));
  const out = [];

  /* 层叠：不铺满，用固定 70% 尺寸 + 每层偏移，让所有标题栏都露出来 */
  if (kind === 'stack') {
    const w = Math.round(aw * 0.7), h = Math.round(ah * 0.7);
    const step = Math.min(32, Math.floor(Math.min(aw, ah) * 0.05));
    for (let i = 0; i < n; i++) {
      out.push({
        x: ax + step * i, y: ay + step * i,
        width: w, height: h,
      });
    }
    return out;
  }

  /* 主窗左、其余右列：窗口数 > 1 时才有意义 */
  if (kind === 'main-left') {
    if (n === 1) return [{ x: ax, y: ay, width: aw, height: ah }];
    const leftW = Math.round((aw - g) / 2);
    const rightW = aw - g - leftW;
    out.push({ x: ax, y: ay, width: leftW, height: ah });
    const rest = n - 1;
    const cellH = Math.floor((ah - g * (rest - 1)) / rest);
    for (let i = 0; i < rest; i++) {
      /* 最后一个吃掉余数，避免底部留 1-2px 缝隙 */
      const isLast = i === rest - 1;
      const y = ay + i * (cellH + g);
      out.push({
        x: ax + leftW + g, y,
        width: rightW, height: isLast ? (ay + ah - y) : cellH,
      });
    }
    return out;
  }

  const def = LAYOUTS[kind] || LAYOUTS['v-split'];
  const slots = def.slots || LAYOUTS['v-split'].slots;
  /* 槽位不够时循环复用（4 窗口用分屏布局 = 两两重叠，比不动好） */
  for (let i = 0; i < n; i++) {
    const s = slots[i % slots.length];
    const x = Math.round(ax + s[0] * aw);
    const y = Math.round(ay + s[1] * ah);
    const w = Math.round(s[2] * aw);
    const h = Math.round(s[3] * ah);
    /* 间距只在内侧收：左右各半的格子，右格左边缘内缩 gap，
     * 左格右边缘也内缩 —— 这样两格之间才有缝，且不会超出屏幕。 */
    const isRightCol = s[0] > 0;
    const isBottomRow = s[1] > 0;
    const dx = isRightCol ? Math.round(g / 2) : 0;
    const dy = isBottomRow ? Math.round(g / 2) : 0;
    const dw = (isRightCol ? -Math.round(g / 2) : (s[0] === 0 && s[2] < 1 ? -Math.round(g / 2) : 0));
    const dh = (isBottomRow ? -Math.round(g / 2) : (s[1] === 0 && s[3] < 1 ? -Math.round(g / 2) : 0));
    out.push({ x: x + dx, y: y + dy, width: w + dw, height: h + dh });
  }
  return out;
}

/* ---------- 2. Win32 调用（沿用 winmgr 的 Add-Type 模式） ---------- */
const LAYOUT_CS = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HeheLayout {
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  /* SW_RESTORE = 9：最大化/最小化的窗口直接 SetWindowPos 不会按预期移动，
   * 必须先恢复。这是 Win32 的既定行为，不是 bug。 */
  public static string Place(long h, int x, int y, int w, int cy2){
    var p = (IntPtr)h;
    ShowWindow(p, 9);
    /* SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10)：
     * 不动 Z 序、不抢焦点 —— 一次性摆 4 个窗口时，若每个都激活，
     * 最后焦点会落在最后那个上，用户还得再点回自己要用的。 */
    SetWindowPos(p, IntPtr.Zero, x, y, w, cy2, 0x4 | 0x10);
    return "OK";
  }
}
`;

/* ---------- 2b. 布局缩略图（用真实几何画，不另画一套） ---------- */
/**
 * 生成一个示意图 SVG 字符串。
 * 【为什么用 computeLayout 的真实输出画】画死一套静态图的话，
 * 改了算法就会出现"图上这么摆、实际那么摆"的分叉。
 * 用同一份几何生成，图与行为永远一致。
 * @param {string} kind  布局 id
 * @param {number} [w]   画布宽
 * @param {number} [h]   画布高
 * @param {number} [n]   示意用窗口数
 */
function layoutPreviewSvg(kind, w, h, n) {
  const W = w || 56, H = h || 40;
  const def = LAYOUTS[kind] || LAYOUTS['v-split'];
  /* 层叠/主窗右列这类"数量灵活"的布局给 3 个窗口示意，
   * 其余给槽位数 —— 这样图最接近实际效果。 */
  const count = n || (def.slots ? def.slots.length : 3);
  const rects = computeLayout(kind, { x: 0, y: 0, width: W, height: H }, count, 2);
  const parts = [];
  rects.forEach((r, i) => {
    /* 第一块用主色描边：让"顺序"也能从图上读出来
     * （用户勾选的顺序就是从第一块到最后一块的顺序） */
    const cls = i === 0 ? 'wl-pv-first' : 'wl-pv-rest';
    parts.push('<rect class="' + cls + '" x="' + r.x + '" y="' + r.y
      + '" width="' + Math.max(1, r.width) + '" height="' + Math.max(1, r.height)
      + '" rx="1.5" />');
  });
  return '<svg class="wl-pv" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H
    + '" aria-hidden="true">' + parts.join('') + '</svg>';
}

/* ---------- 3. 工具页 ---------- */
(function () {
  const ui = window.ui;
  const Channels = window.Channels;
  const { div, btn, toast, h, icon } = ui;
  const { invoke } = window.api;
  const MOD = 'system';

  let chosen = [];   // 选中的窗口 hwnd 列表
  let windows = [];  // 全部窗口
  let layout = 'v-split';
  let gap = 8;

  window.LayoutCalc = { LAYOUTS, computeLayout, LAYOUT_CS, layoutPreviewSvg };

  window.Registry.register({
    id: 'win-layout',
    name: '窗口布局',
    nameEn: 'Window Layout',
    module: MOD,
    icon: 'layout',
    desc: '把多个窗口一次摆成分屏、四宫格或层叠（可排除自身）',
    descEn: 'Arrange several windows into split, grid or stacked layouts in one click',
    keywords: ['窗口', '布局', '分屏', '四宫格', '排列', '平铺', 'window', 'layout',
      'tile', 'split', 'grid', 'arrange'],
    render(page) {
      const listBox = div('wl-list');
      const status = div('field-hint', '');
      const gapInput = h('input', { class: 'input input-sm', type: 'number', value: '8', min: '0', max: '40', style: { width: '80px' } });
      gapInput.addEventListener('input', () => { gap = Math.max(0, Math.min(40, Number(gapInput.value) || 0)); });

      async function loadWindows() {
        try {
          const rows = await invoke(Channels.CHANNELS.WINMGR.LIST);
          windows = rows || [];
          renderList();
        } catch (e) {
          status.textContent = '';
          toast('枚举窗口失败：' + e.message, 'error');
        }
      }

      function renderList() {
        listBox.innerHTML = '';
        if (!windows.length) {
          listBox.appendChild(div('field-hint', '还没有枚举窗口，点上面的「刷新」'));
          return;
        }
        windows.forEach((w) => {
          const row = div('wl-row');
          const cb = h('input', { type: 'checkbox', style: { marginRight: '8px' } });
          cb.checked = chosen.includes(w.hwnd);
          cb.addEventListener('change', () => {
            if (cb.checked) { if (!chosen.includes(w.hwnd)) chosen.push(w.hwnd); }
            else chosen = chosen.filter((x) => x !== w.hwnd);
            paintStatus();
          });
          row.appendChild(cb);
          row.appendChild(h('span', { class: 'wl-proc mono' }, w.proc || ''));
          row.appendChild(h('span', { class: 'wl-title' }, w.title || ''));
          listBox.appendChild(row);
        });
      }

      function paintStatus() {
        status.textContent = chosen.length
          ? '已选 ' + chosen.length + ' 个窗口，将按「' + (LAYOUTS[layout] || {}).label + '」排列'
          : '勾选要排列的窗口（顺序即从左到右 / 从上到下的顺序）';
      }

      /* 【必须重绘进已挂载的容器】旧实现每次点击都 return 一个**新** box，
       * 但页面里挂的是首次创建的那个 —— 新 box 没人接收，按钮高亮永远
       * 停在初始布局上，用户看到的"当前布局"与实际选择脱节。 */
      const layoutsBox = div('wl-layouts');
      function renderLayouts() {
        layoutsBox.innerHTML = '';
        Object.entries(LAYOUTS).forEach(([k, v]) => {
          /* 【卡片而不是文字按钮】布局是空间关系，一张缩略图一眼就懂；
           * "三分（左大右两小）"这种描述光靠文字要在脑子里建模。
           * 文字标签仍保留：读屏要念得出来，也方便"图上画的是哪种"对上号。 */
          const card = div('wl-layout-card' + (k === layout ? ' active' : ''));
          card.innerHTML = layoutPreviewSvg(k);
          card.appendChild(div('wl-layout-name', v.label));
          window.ui.makeButtonLike(card, '布局：' + v.label);
          card.addEventListener('click', () => {
            layout = k;
            renderLayouts();
            paintStatus();
          });
          layoutsBox.appendChild(card);
        });
      }
      renderLayouts();

      async function apply() {
        if (!chosen.length) return toast('先勾选要排列的窗口', 'warn');
        status.textContent = '排列中…';
        try {
          /* 可用区域 = 主显示器工作区（排除任务栏）。
           * 不去查每个窗口在哪台显示器：跨屏排列的预期本来就不明确，
           * 先做「摆到主屏」这个确定的行为，并在提示里说明。 */
          const info = await invoke(Channels.CHANNELS.APP.GET_INFO).catch(() => null);
          const area = (info && info.workArea) || { x: 0, y: 0, width: 1366, height: 768 };
          const rects = computeLayout(layout, area, chosen.length, gap);
          let ok = 0;
          for (let i = 0; i < chosen.length; i++) {
            const r = rects[i % rects.length];
            try {
              await invoke(Channels.CHANNELS.WINMGR.PLACE, chosen[i], r.x, r.y, r.width, r.height);
              ok++;
            } catch (e) { /* 单个失败不影响其余（有些窗口拒绝被移动） */ }
          }
          status.textContent = '已排列 ' + ok + '/' + chosen.length + ' 个窗口';
          toast(ok === chosen.length ? '已排列 ' + ok + ' 个窗口' : ok + ' 个成功、' + (chosen.length - ok) + ' 个拒绝移动',
            ok === chosen.length ? 'success' : 'warn');
        } catch (e) {
          status.textContent = '';
          toast(e.message, 'error');
        }
      }

      const refreshBtn = btn('刷新', 'btn-sm btn-secondary', loadWindows, 'refresh');
      const allBtn = btn('全选', 'btn-sm btn-text', () => {
        chosen = windows.map((w) => w.hwnd);
        renderList(); paintStatus();
      });
      const noneBtn = btn('清空选择', 'btn-sm btn-text', () => {
        chosen = []; renderList(); paintStatus();
      });

      page.appendChild(div('card', div('card-title', icon('layout'), '布局'),
        layoutsBox,
        div('form-row', h('span', { class: 'form-label' }, '窗口间距'), gapInput,
          h('span', { class: 'field-hint' }, '像素'))));
      page.appendChild(div('card', div('card-title', '窗口'),
        div('form-row', refreshBtn, allBtn, noneBtn),
        listBox));
      page.appendChild(div('card', div('card-title', '应用'),
        div('form-row', btn('排列这些窗口', 'btn-primary', apply, 'layout'), status),
        div('field-hint', '窗口会被摆到主显示器的工作区（不含任务栏）。'
          + '最小化或最大化的窗口会先恢复再移动 —— 这是 Win32 的要求。')));
      paintStatus();
    },
  });
})();
