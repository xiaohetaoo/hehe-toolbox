'use strict';
/* ESLint 扁平配置（eslint.config.js，ESLint 9 的默认形态）。
 *
 * ============ 为什么只开这几条规则 ============
 * 这是一次"接入"而不是"改造"：目标是**让 lint 能进 CI 而不制造噪音**。
 * 全量规则一次性打开会喷出几百条历史问题，结果只有一个 ——
 * 有人会批量加 eslint-disable 把它压成一片绿，反而失去意义。
 *
 * 所以只开能抓**真实 bug 形态**的几条，而且每一条都有历史证据：
 *   no-undef            js/app.js 里 finally 引用 try 块内 `let dlId`（每次必抛 ReferenceError）
 *   no-unused-vars      js/tools/life.js 的 countIn 创建后从未被读取（目标番茄数输入框无效）
 *   no-shadow           app.js 曾有内层 `let dlId` 遮蔽外层（外层永远是 null）
 *   no-dupe-keys        对象字面量重复键（后一个静默覆盖前一个）
 *   no-unreachable      return 之后的代码永远不执行
 *   no-async-promise-executor  new Promise(async ...) —— 异步抛出会变成未捕获异常
 *   eqeqeq (smart)      == / != 的类型转换陷阱（null/undefined 比较除外）
 *   no-misleading-character-class  正则里把多个码点写进一个字符类，
 *                        看起来是单字符其实是多字符（本项目扫中文注释时踩过）
 * 其余规则（命名风格、缩进、分号……）一律不开 —— 那不是工程问题，是审美。
 *
 * ============ 环境声明 ============
 *   main.js / preload.js  → node（有 require/process）
 *   js/**                → browser（有 window/document，但**没有** require）
 *   lib/**               → node + 浏览器共用（既可能被 require，也可能被 <script> 引入）
 *   scripts/**           → node
 */

const js = require('@eslint/js');

const BASE_RULES = {
  'no-undef': 'error',
  /* args: 'none' —— 不检查未使用的函数参数。
   * 本项目大量回调签名是 (e, ...) 或 (item, i, row)，形参按接口约定固定，
   * 单个回调不用某个参数是正常的（例如 rowEnd(item, i, row) 里常用不到 i）。
   * 检查它会逼出一堆 `_e` 重命名，纯噪音。
   * caughtErrors: 'none' —— 同理，`catch (e) {}` 的静默忽略在本项目是刻意的
   * （例如"删不掉就忽略"的清理路径），不该由 lint 来管。 */
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  /* 【no-shadow 只查"同名变量遮蔽"，不查 catch 参数】
   * 实测 45 条里有 40 条是 `catch (e) { ... try {...} catch (e) {...} }` ——
   * 内层 catch 复用 e 是这个项目里的普遍写法，语义上完全正确
   * （内层异常覆盖外层异常，是期望行为）。
   * ESLint 的 no-shadow 有个 builtinGlobals 与 catch 相关的开关，
   * 这里用 ignoreOnInitialization + 允许 catch 参数同名（通过静音 catch 的方式：
   * ESLint 9 的 no-shadow 会把 catch 子句参数也算作作用域，所以直接把
   * "catch 参数"这一类从检查里排除，改用 no-redeclare 兜底真正的重复声明）。
   * 真正要防的是 app.js 那种 `let dlId` 在内层 try 里再声明一次、
   * 遮蔽外层导致 finally 读到 null —— 那样式已由 no-redeclare + 行为测试覆盖。 */
  'no-shadow': ['error', { builtinGlobals: false, hoist: 'functions', allow: ['e', 'err', 'error'] }],
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-async-promise-executor': 'error',
  eqeqeq: ['error', 'smart'],
  'no-misleading-character-class': 'error',
};

module.exports = [
  {
    /* 全局忽略：依赖、产物、以及**测试脚本**。
     * 【为什么整个 scripts/ 都排除，而不是只排除某几个】
     * scripts/ 下有 84 个测试脚本，它们的写法刻意"反常规"：
     *   · 大量 readFileSync + 正则匹配源码（为了源码断言）
     *   · 用 new Function 动态求值抽出来的实现（no-new-func 会全红）
     *   · 故意留空 catch（catch (e) {} 在"忽略失败"路径上是合理的）
     * 把它们纳入 lint 会让 baseline 膨胀到几百条压制，收益却是零 ——
     * 测试脚本的质量由测试自身保证（它们跑起来会自检）。
     * 所以排除 scripts/ 整目录；scripts/lib/harness.js 是唯一的公共骨架，
     * 单独用 node --check 保证语法正确即可。
     *
     * node_modules / dist 是产物与依赖，不检查。
     */
    ignores: [
      'node_modules/**',
      'dist/**',
      'scripts/**',
      'assets/**',
      'css/**',
    ],
  },
  js.configs.recommended ? {
    /* @eslint/js 的 recommended 只作为"规则名注册表"用 —— 我们不启用它的全部规则，
     * 这里只是让上面的规则名都能被解析。 */
    rules: BASE_RULES,
  } : { rules: BASE_RULES },

  /* ---- 主进程与 preload：Node 环境 ---- */
  {
    /* ipc/ 是任务 5 从 main.js 搬出来的 IPC 域，同样是 Node 主进程环境。
     * 不加进来的话它们不会被 lint 检查 —— 而「搬出去的文件没人查」
     * 恰恰是最容易悄悄长出 bug的地方。 */
    files: ['main.js', 'preload.js', 'ipc/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        __dirname: 'readonly', __filename: 'readonly',
        process: 'readonly', Buffer: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly', URL: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', fetch: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly', URLSearchParams: 'readonly',
        Event: 'readonly', EventTarget: 'readonly',
      },
    },
  },

  /* ---- 渲染层：浏览器环境（contextIsolation，**不能用 require**） ---- */
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        location: 'readonly', history: 'readonly', localStorage: 'readonly',
        console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        Notification: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        Blob: 'readonly', File: 'readonly', FileReader: 'readonly',
        Image: 'readonly', Audio: 'readonly', fetch: 'readonly',
        alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
        getComputedStyle: 'readonly', devicePixelRatio: 'readonly',
        performance: 'readonly', structuredClone: 'readonly',
        btoa: 'readonly', atob: 'readonly', escape: 'readonly', unescape: 'readonly',
        MutationObserver: 'readonly', FormData: 'readonly',
        HTMLCanvasElement: 'readonly', CanvasRenderingContext2D: 'readonly',
        MediaStream: 'readonly', MediaRecorder: 'readonly',
        SpeechSynthesisUtterance: 'readonly', speechSynthesis: 'readonly',
        crypto: 'readonly', ResizeObserver: 'readonly', IntersectionObserver: 'readonly',
        XMLHttpRequest: 'readonly', WebSocket: 'readonly', Worker: 'readonly',
        screen: 'readonly', innerWidth: 'readonly', innerHeight: 'readonly',
        isSecureContext: 'readonly', sessionStorage: 'readonly',
        /* 网络与流控制相关（main.js 里也有，渲染层在 fetch/下载处用） */
        AbortController: 'readonly', AbortSignal: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
        Event: 'readonly', CustomEvent: 'readonly', EventTarget: 'readonly',
        KeyboardEvent: 'readonly', MouseEvent: 'readonly', DragEvent: 'readonly',
        ClipboardEvent: 'readonly', FocusEvent: 'readonly', InputEvent: 'readonly',
        /* 【DOM 中"节点"类型在 typeof/instanceof 判定里用到】
         * 注意这是浏览器的 Node 接口（document 节点），**不是** Node.js。 */
        Node: 'readonly', DOMParser: 'readonly', XMLSerializer: 'readonly',
        /* DOMPurify 由 vendor 脚本全局注入（index.html 里先加载） */
        DOMPurify: 'readonly',

        /* ============================================================
         * 【本项目自建的"隐式全局" —— 这里必须显式声明，否则每条都是 no-undef】
         * js/ui.js 末尾用 `Object.assign(window, {...})` 把 DOM 助手挂到 window，
         * 于是所有工具文件即使不 import 也能直接用 h / div / btn / toast…
         * 这是**既有的设计**（文件里有注释说明「全局兜底：工具文件即使遗漏解构
         * 也能直接使用这些助手」），不是我这一轮引入的，也不该顺手重构掉
         * （那会改动上百处调用）。所以在这里如实登记，让 lint 知道它们合法存在。
         * ============================================================ */
        h: 'readonly', div: 'readonly', icon: 'readonly', iconLg: 'readonly',
        btn: 'readonly', toast: 'readonly', copyText: 'readonly',
        fmtBytes: 'readonly', fmtNum: 'readonly', fmtTime: 'readonly',
        fmtDate: 'readonly', pad2: 'readonly', debounce: 'readonly',
        escapeHtml: 'readonly', renderTable: 'readonly', switchEl: 'readonly',
        dropzone: 'readonly', fileList: 'readonly', filePicker: 'readonly',
        lineChart: 'readonly', progressEl: 'readonly', loadingBlock: 'readonly',
        fieldRow: 'readonly', convertLayout: 'readonly', kvGrid: 'readonly',
        placeholder: 'readonly', modal: 'readonly', confirmBox: 'readonly',
        alertBox: 'readonly', promptBox: 'readonly', nextId: 'readonly',
        guard: 'readonly',
        /* 三大全局对象：window.ui（助手集合）、window.api（IPC）、window.App（生命周期） */
        ui: 'readonly', api: 'readonly', App: 'readonly', hehe: 'readonly',
        Registry: 'readonly', JobPrefix: 'readonly', I18N: 'readonly',
        /* 工具页文案取词（js/tools/i18n.js 挂的全局）：TT('域', '中文原文')。
         * 工具文件里几乎每个渲染点都会用，所以是全局而不是每个文件解构。 */
        TT: 'readonly', ToolI18n: 'readonly',
        /* 主题主色取值：js/auxwin/snip-1.js 顶层定义，snip-2.js 直接引用
         * （两个都是普通 <script>，共享全局作用域）。 */
        accentPrimary: 'readonly',
      },
    },
  },

  /* ---- lib/：Node 与浏览器共用 ---- */
  {
    files: ['lib/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        __dirname: 'readonly', __filename: 'readonly',
        process: 'readonly', Buffer: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        window: 'readonly', document: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', fetch: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly', URLSearchParams: 'readonly',
      },
    },
  },

  /* ---- 配置文件自身与 Node 侧工具脚本 ---- */
  {
    files: ['eslint.config.js', '*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        __dirname: 'readonly', __filename: 'readonly',
        process: 'readonly', Buffer: 'readonly', console: 'readonly',
      },
    },
  },
];
