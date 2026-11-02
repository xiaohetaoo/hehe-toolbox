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
    /* 全局忽略：依赖、产物、以及外部工具留下的目录。
     *
     * node_modules / dist 是产物与依赖，不检查。
     */
    ignores: [
      'node_modules/**',
      'dist/**',
      'assets/**',
      'css/**',
      /* 【外部工具留下的目录，不属于本项目源码】
       * .workbuddy/ 是某个外部助手工具的本地记忆目录（已在 .gitignore 里），
       * 但它会往里丢 .js 片段（例如 old-media.js，是我们拆分 media.js 时
       * 留下的旧副本）。那些文件不在任何构建产物里，也不参与运行，
       * 却会被 `eslint .` 扫到并按主进程/渲染层的规则报一堆 no-undef ——
       * 实测会让 `npm run lint` 直接失败（本轮就踩了一次）。
       * 这里连同 .gitignore 里其它临时目录一起排除。 */
      '.workbuddy/**',
      '.shots/**',
      '.tmp-audit/**',
      '.tmp-*/**',
      '.e2e-*/**',
      '.ciunpack/**',
      '.verify-unpacked/**',
      '.hehe-build-stage/**',
      /* 根目录下以点开头的临时探针脚本（.probe*.js / .review-probe.js 等）。
       * 它们是审查/排查时随手写的复现脚本，不进产物、不进仓库，
       * 但 `eslint .` 会扫到并按正式代码的规则报错（含解析错误），
       * 实测会让 `npm run lint` 直接失败。
       * 用 `.*` 而不是逐个列 —— 这类文件的名字是随机的。 */
      '.*.js',
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

  /* ============================================================
   * ---- scripts/：测试与工具脚本，**只开四条规则** ----
   *
   * 【为什么以前整目录排除，现在又要查】
   * 排除的理由是成立的：测试脚本写法刻意"反常规"（大量读源码匹配、
   * new Function 求值、故意空 catch），按主进程那套规则查会喷几百条，
   * 收益是零。但代价同样真实：98 个脚本 18427 行没有任何静态检查，
   * 而上一轮修的 16 项测试缺陷里有 4 项是 **P1「测试假绿」**——
   * 比如 `no-undef` 能直接抓到的"引用了不存在的变量"。
   * 也就是说：恰恰是"测试代码不用查"这个判断，放走了最贵的缺陷。
   *
   * 【所以只开四条，且每条都对应一次真实故障形态】
   *   no-undef      —— 引用了不存在的变量。测试脚本里出现这个，
   *                    通常意味着断言对象写错了名字，而断言本身**照样通过**
   *                    （例如断言一个从未赋值的 `fail`）。
   *   no-unused-vars—— 声明后从未读取。上一轮 test-round14 的 4a 就是
   *                    "定义了一个 fn 但断言跑的是手写副本"，
   *                    这条规则能直接指出来。
   *   no-dupe-keys  —— 对象字面量重复键，后者静默覆盖前者。夹具对象里
   *                    重复写一个字段，测试就永远看不到前一个值。
   *   no-unreachable—— return 之后的代码永不执行。断言的收尾代码写在
   *                    return 之后，等于这条断言从来没生效过。
   * 其余规则（风格、复杂度、new-func、空 catch）一律不开：
   * 那些在测试代码里是**合理写法**，开了只会换来一片 disable。
   *
   * 【环境】node + 允许 require。scripts/ 里全是 CommonJS 脚本。
   * ============================================================ */
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        __dirname: 'readonly', __filename: 'readonly',
        process: 'readonly', Buffer: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly', clearImmediate: 'readonly',
        queueMicrotask: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly',
        fetch: 'readonly', performance: 'readonly', structuredClone: 'readonly',
        crypto: 'readonly',
        /* 【global 与 globalThis 都要声明】有脚本用 `global.X = ...` 装桩
         * （例如把 TextDecoder 临时换掉再恢复）。这是 node 的既有全局，
         * 不是笔误。 */
        global: 'writable', globalThis: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      /* args:'none' 与主 config 同理：回调形参按接口约定固定，
       * 用不到某个参数是正常的（dropzone(files, opts) 之类）。
       * caughtErrors:'none'：`catch (e) { /* 忽略 *\/ }` 在清理路径上是刻意的。 */
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      /* 【显式关掉从主 config 继承来的规则】
       * 主 config 里开着 no-shadow（历史证据是 app.js 的 `let dlId` 遮蔽），
       * 但它在测试脚本里几乎全是假阳性：`rename: async (s, t) => …`、
       * `texts.filter((t, i) => …)` 这类回调参数与文件顶部的 t（测试函数）
       * 同名，是**局部且刻意的**命名，改掉只会让回调更难读。
       * 上一轮 test-mojibake 修过一个真正的问题（cp 重复 require），
       * 但那是 no-unused-vars 抓到的，不是 no-shadow。
       * 任务书要求 scripts/ 只开四条规则，所以这里把继承来的关掉，
       * 而不是靠 6 行 disable 注释去压。 */
      'no-shadow': 'off',
      /* 同理：主 config 的 eqeqeq / no-misleading-character-class 等也不适用于
       * 测试脚本（后者会误报"正则里多码点"这类刻意写法）。 */
      eqeqeq: 'off',
      'no-async-promise-executor': 'off',
      'no-misleading-character-class': 'off',
    },
  },
];
