/* IPC 通道名（渲染层版本）。
 *
 * 【为什么有第二份】渲染层在 contextIsolation 下无法 require lib/，
 * 但通道名必须与主进程完全一致 —— 拼错一个字母的表现是运行时
 * 「调用失败：No handler registered」，而且现有的 test-ipc-channels
 * 是**扫文本**做差集的：两边都错成一样的就查不出来。
 *
 * 所以这里放一份同构的常量表，并由 scripts/test-channels-sync.js 校验：
 * 不只比键集合，还比**每个键对应的值**（值不同同样会导致静默失败）。
 *
 * 【迁移状态】目前只迁移了两个域（目录搬家、权限与链接）。
 * 其余域的通道仍是散落的字符串字面量，按 lib/channels.js 里的 TODO 逐轮推进。
 *
 * 【加载顺序】index.html 里要在 ui.js / registry.js 之前引入 ——
 * 工具文件在定义时就会引用 window.Channels（例如注册时的通道表）。
 */
(function () {
  'use strict';

  /* 与 lib/channels.js 的 CHANNELS 逐字一致 —— 由 test-channels-sync 校验 */
  const CHANNELS = {
    DIR_MOVE: {
      PRECHECK: 'dir:move-precheck',
      MOVE: 'dir:move',
    },
    ACL_LINKS: {
      ACL_DIAGNOSE: 'acl:diagnose',
      ACL_REPAIR: 'acl:repair',
      LINK_SCAN: 'link:scan',
      LINK_REMOVE: 'link:remove',
      WHO_LOCKS: 'file:who-locks',
      WHO_LOCKS_DIR: 'file:who-locks-dir',
    },
  };

  /** 拍平成 '组名.键名' → 通道名，便于按语义取用与校验。 */
  function flatten(groups) {
    const out = {};
    const walk = (obj, prefix) => {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === 'string') out[prefix ? prefix + '.' + k : k] = v;
        else walk(v, prefix ? prefix + '.' + k : k);
      }
    };
    walk(groups || CHANNELS, '');
    return out;
  }

  window.Channels = { CHANNELS, flatten };
})();
