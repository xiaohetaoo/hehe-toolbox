'use strict';
/* 用户可调偏好的**唯一定义源**。
 *
 * ============ 为什么要有这个文件 ============
 * v0.6.8 起把一批原本写死的常量变成可配置项（剪贴板条数、最近使用条数、
 * 图片压缩默认质量、拖拽递归深度…）。如果每个使用点各写一遍
 *
 *     const v = await invoke(STORE.GET, 'settings.xxx', 默认值)
 *
 * 会出现两个必然的漂移：
 *   ① **默认值写两遍**（设置页一遍、使用点一遍），改一处忘一处；
 *   ② **范围校验写两遍**，设置页夹了 1~10，使用点没夹 → 手工改配置文件后行为不一致。
 *
 * 所以：所有键的「默认值 + 合法区间 + 类型」都定义在 SPECS 里，
 * 使用点只写 `Prefs.get('xxx')`。加新项只改这一个文件。
 *
 * ============ 为什么放在 lib/ 而不是 js/ ============
 * 第一版本文件在 js/prefs-spec.js，lint 直接红：`'module' is not defined`。
 * js/** 的 eslint 环境是 **browser**（见 eslint.config.js），没有 module；
 * lib/** 是 node + browser 双环境，主进程才能 require 它。
 * 所以搬到 lib/ 了 —— 这个文件的**位置本身就是那条 lint 规则的解法**，
 * 别再搬回 js/。
 *
 * 写法照 lib/exif.js / lib/pinyin.js：两个独立的 if 分别挂载 ——
 * 只有 typeof module 时才写 module.exports，只有 root 存在时才挂全局。
 * 不用 `window.X = ...` 这种写法（tsc 会报 Property 'X' does not exist
 * on type 'Window'）。
 */
(function () {
  /* ============ 规格表 ============
   * 每一项：默认值 + 合法区间 + 步长 + 单位。设置页据此生成控件，
   * 使用点据此拿值，**两边永远一致**。 */
  const SPECS = {
    /* ---- 剪贴板历史 ---- */
    /* 【步长 10 而不是 50】第一版用 50（50/100/150/200…），实测发现
     * 用户想要 80 这种值时根本选不到 —— 下拉框直接跳过，唯一出路是手改配置文件。
     * 对一个"1~1000 连续区间"的偏好，步长只该大到"够用又不至于几百个选项"，
     * 10 给出约 96 个档位，够细且不会让人滚很久。 */
    clipHistoryLimit: { def: 200, min: 50, max: 1000, step: 10, unit: '条' },
    /* 单条文本上限。界面用 KB，存也是 KB（便于用户理解）。
     * 上限 4096KB 是保守值：store 是整份 JSON 原子写盘，单条太大会让每次
     * 剪贴板写入都变慢，且断电时更容易写坏。
     * 【步长 16】16 的倍数正好覆盖 16/32/64/128/256/512/1024… 这些常用档位。 */
    clipTextLimitKB: { def: 256, min: 16, max: 4096, step: 16, unit: 'KB' },

    /* ---- 首页 ---- */
    /* 最近使用条数。0 = 整个区块隐藏（这是用户要的"可关闭"语义）。 */
    recentLimit: { def: 12, min: 0, max: 30, step: 1, unit: '个' },

    /* ---- 工具默认值 ---- */
    imgCompressQuality: { def: 80, min: 10, max: 100, step: 5, unit: '' },
    recFps: { def: 30, min: 10, max: 60, step: 5, unit: 'fps' },

    /* ---- 更新 ---- */
    /* 更新检查缓存时长（小时）。0 = 每次都查（不缓存）。 */
    updateTtlHours: { def: 6, min: 0, max: 72, step: 1, unit: '小时' },
    /* 启动时自动检查更新。默认关：本项目一直把"检查更新"做成手动，
     * 改成默认开属于行为变更，所以保持关闭，只给需要的人开。 */
    updateCheckOnStart: { def: false, type: 'bool' },

    /* ---- 排障 ---- */
    crashLogKeep: { def: 5, min: 1, max: 20, step: 1, unit: '份' },

    /* ---- 交互 ---- */
    /* 拖拽文件夹时的递归深度与文件数上限。
     * 【为什么两个都要】只限深度会被"浅但宽"的目录打爆（一个目录 5 万个文件）；
     * 只限数量会被"深但窄"的目录拖死（递归 100 层）。 */
    dragMaxDepth: { def: 8, min: 2, max: 20, step: 1, unit: '层' },
    dragMaxFiles: { def: 3000, min: 200, max: 20000, step: 100, unit: '个' },

    /* ---- 屏幕标尺 ---- */
    rulerMinLen: { def: 160, min: 20, max: 800, step: 10, unit: 'px' },
  };

  /** 把任意输入夹到该项的合法区间，并**对齐到步长网格**；bool 项返回布尔。
   *
   *  【为什么必须对齐步长】设置页的控件是下拉框，选项只包含 min + n*step。
   *  如果 normalize 允许返回 80（而步长是 50），就会出现两种坏情况：
   *    ① 手工改了配置文件写 80 → 下拉框没有这个选项 → 显示成空选中；
   *    ② 代码里想"临时设成 80" → 存进去了，但界面显示的还是最近的那个网格值，
   *       用户看到的值和实际生效的值不一致。
   *  对齐之后，任何输入都会落到一个真实存在的选项上，界面与行为永远一致。 */
  function normalize(key, raw) {
    const spec = SPECS[key];
    if (!spec) return undefined;
    if (spec.type === 'bool') return raw === true;
    let n = Number(raw);
    if (!Number.isFinite(n)) n = spec.def;
    n = Math.round(n);
    if (n < spec.min) n = spec.min;
    if (n > spec.max) n = spec.max;
    /* 对齐到网格：round((n - min) / step) * step + min。
     * 四舍五入而不是向下取整 —— 用户输入 88（步长 10）时给他 90 比 80 更接近意图。 */
    const steps = Math.round((n - spec.min) / spec.step);
    n = spec.min + steps * spec.step;
    /* 对齐后可能又越界（浮点/边界），再夹一次 */
    if (n < spec.min) n = spec.min;
    if (n > spec.max) n = spec.max;
    return n;
  }

  /** 默认值表（由 SPECS 推导，不手写第二份）。 */
  function defaults() {
    const out = {};
    for (const k of Object.keys(SPECS)) out[k] = SPECS[k].def;
    return out;
  }

  const api = { SPECS, normalize, defaults };
  /* 【UMD 形态：node 与渲染层共用同一份实现】
   * 渲染层在 contextIsolation 下无法 require lib/，所以由 index.html 用
   * <script> 引入，挂到 window.PrefsSpec；node 侧 require 拿到的就是同一个对象。
   * 与 lib/exif.js / lib/fail-text.js 同一种写法 —— 两份副本会慢慢分叉，这个项目踩过。
   *
   * 【为什么这个文件在 lib/ 而不是 js/】
   * js/** 的 lint 环境是 browser（没有 module），lib/** 才是 node+browser 共用。
   * 这份规格要同时被主进程、渲染层、测试三处用到，放 lib/ 才对得上既有约定。
   *
   * 【为什么用 root 而不是直接写 window】
   * tsc 会检查 window.XXX 是否存在对应声明；走 root 参数就没有这个问题，
   * lib/exif.js 与 lib/pinyin.js 也是这个写法。 */
  (function (root, exportsApi) {
    if (typeof module === 'object' && module && module.exports) module.exports = exportsApi;
    if (!root) return;
    root.PrefsSpec = exportsApi;
    /* 工具页用的极简同步读接口。真实实现由 app.js 覆盖（它持有 invoke 与缓存）；
     * 这里只是**永不为空的兜底**：取不到时返回规格里的默认值，
     * 保证工具页在极端时序下（App 还没装好就渲染）也不会拿到 undefined。 */
    root.Prefs = root.Prefs || {};
    if (!root.Prefs.get) {
      root.Prefs.get = function (key) {
        const spec = exportsApi.SPECS[key];
        return spec ? spec.def : undefined;
      };
    }
  })(typeof window !== 'undefined' ? window
    : (typeof globalThis !== 'undefined' ? globalThis : null), api);
})();
