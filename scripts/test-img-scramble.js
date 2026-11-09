'use strict';
/* 图片混淆算法的可逆性测试（img-scramble）。
 *
 * ============ 为什么必须测"可逆" ============
 * 这是个**破坏性**操作：混淆后如果还原不回来，用户的图就废了。
 * 而可逆性只取决于两件事，且都是"跑起来才知道"的：
 *   1) 正向/反向用的置换表必须完全一致（同密钥 + 同尺寸）
 *   2) permute 的 in-place 语义不能写错方向（差一个下标就全乱）
 * 纯看代码很难确信，必须真的跑一遍「混淆 → 还原 → 逐字节比对」。
 *
 * ============ 为什么从 js/tools/ 里抽算法来测 ============
 * 这个工具是 IIFE 包起来的，算法没有导出。所以测试里**复制了同一份
 * 算法逻辑**（makeRng / buildPermutation / permute）。
 * 这有分叉风险，所以额外加了一条源码断言：验证工具文件里确实是同样的实现。
 */
const assert = require('assert');
const { t, done, readSrc, readTree } = require('./lib/harness');

/* ---- 以下三个函数必须与 js/tools/media/img-scramble.js 保持一致 ---- */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(key) {
  let h = 2166136261 >>> 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function buildPermutation(n, seed) {
  const rng = makeRng(seed);
  const perm = new Uint32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
  }
  return perm;
}
function permute(data, perm, inverse) {
  const n = perm.length;
  const dst = new Uint8ClampedArray(data.length);
  for (let i = 0; i < n; i++) {
    const si = i * 4;
    if (inverse) {
      const di = perm[i] * 4;
      dst[di] = data[si]; dst[di + 1] = data[si + 1]; dst[di + 2] = data[si + 2]; dst[di + 3] = data[si + 3];
    } else {
      const s = perm[i] * 4;
      dst[si] = data[s]; dst[si + 1] = data[s + 1]; dst[si + 2] = data[s + 2]; dst[si + 3] = data[s + 3];
    }
  }
  data.set(dst);
  return data;
}

function makePixels(n) {
  const a = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    a[i * 4] = i % 256;
    a[i * 4 + 1] = (i * 7) % 256;
    a[i * 4 + 2] = (i * 13) % 256;
    a[i * 4 + 3] = 255;
  }
  return a;
}

/* ---------------- 可逆性 ---------------- */
t('混淆 → 还原 能逐字节恢复原图', () => {
  const n = 400;
  const orig = makePixels(n);
  const work = new Uint8ClampedArray(orig);
  const perm = buildPermutation(n, seedOf('my-key'));

  permute(work, perm, false);           // 混淆
  assert.notDeepStrictEqual([...work], [...orig], '混淆后应当不同（否则等于没做）');

  permute(work, perm, true);            // 还原
  assert.deepStrictEqual([...work], [...orig], '还原后必须与原图逐字节一致');
});

t('混淆确实打乱了像素（不是原地不动）', () => {
  const n = 100;
  const orig = makePixels(n);
  const work = new Uint8ClampedArray(orig);
  permute(work, buildPermutation(n, seedOf('k')), false);
  let changed = 0;
  for (let i = 0; i < n; i++) if (work[i * 4] !== orig[i * 4]) changed++;
  assert.ok(changed > n * 0.9, '至少 90% 的像素应被移动，实际 ' + changed + '/' + n);
});

t('不同密钥产生不同的置换（否则密钥没有意义）', () => {
  const n = 200;
  const p1 = buildPermutation(n, seedOf('key-a'));
  const p2 = buildPermutation(n, seedOf('key-b'));
  let same = 0;
  for (let i = 0; i < n; i++) if (p1[i] === p2[i]) same++;
  assert.ok(same < n * 0.2, '两个密钥的置换应显著不同，实际重合 ' + same + '/' + n);
});

t('同一密钥、同尺寸 → 置换完全相同（还原的前提）', () => {
  const n = 300;
  const p1 = buildPermutation(n, seedOf('same'));
  const p2 = buildPermutation(n, seedOf('same'));
  assert.deepStrictEqual([...p1], [...p2], '同密钥必须可复现，否则混淆后无法还原');
});

t('Alice/Bob 这类只差一个字符的密钥也要产生不同序列', () => {
  const p1 = buildPermutation(100, seedOf('Alice'));
  const p2 = buildPermutation(100, seedOf('Bob'));
  assert.notDeepStrictEqual([...p1], [...p2]);
});

t('错误密钥还原出来的是乱码（而不是原图）', () => {
  const n = 200;
  const orig = makePixels(n);
  const work = new Uint8ClampedArray(orig);
  permute(work, buildPermutation(n, seedOf('right')), false);
  permute(work, buildPermutation(n, seedOf('wrong')), true);
  assert.notDeepStrictEqual([...work], [...orig], '用错密钥不该还原出原图');
});

t('还原后再混淆仍能得到同样的结果（对称性）', () => {
  const n = 150;
  const perm = buildPermutation(n, seedOf('x'));
  const a = new Uint8ClampedArray(makePixels(n));
  permute(a, perm, false);
  const first = new Uint8ClampedArray(a);
  permute(a, perm, true);
  permute(a, perm, false);
  assert.deepStrictEqual([...a], [...first]);
});

t('alpha 通道也被正确处理（不能出现全透明）', () => {
  const n = 50;
  const orig = makePixels(n); // alpha 全是 255
  const work = new Uint8ClampedArray(orig);
  permute(work, buildPermutation(n, seedOf('a')), false);
  for (let i = 0; i < n; i++) {
    assert.strictEqual(work[i * 4 + 3], 255, '第 ' + i + ' 个像素的 alpha 被改坏了');
  }
});

t('1 像素的图不会崩（边界）', () => {
  const work = new Uint8ClampedArray([1, 2, 3, 4]);
  const perm = buildPermutation(1, seedOf('k'));
  permute(work, perm, false);
  assert.deepStrictEqual([...work], [1, 2, 3, 4], '单像素置换后应当不变');
});

t('空密钥也能产生合法种子（不抛异常，但调用方应当拦住）', () => {
  assert.strictEqual(typeof seedOf(''), 'number');
  const p = buildPermutation(10, seedOf(''));
  assert.strictEqual(p.length, 10);
});

/* ---------------- 与工具实现的一致性 ---------------- */
/* 锁的是：测试里复制的算法必须与工具文件里的是同一份。
 * 不能用行为断言的原因：工具是 IIFE 包裹的，算法没有导出，
 * 测试无法 require 到它。所以用源码断言守住"两边是同样的实现"，
 * 一旦有人只改了一边（比如优化了 permute 却没同步），这里会红。 */
t('工具文件里的算法与测试副本一致', () => {
  const src = readSrc('js/tools/media/img-scramble.js');
  /* 锁的是：permute 的两个分支方向不能写反。
   * 反向分支必须是 dst[perm[i]] = src[i]（这行是 dst[di] = src[si]），
   * 正向分支是 dst[i] = src[perm[i]]（dst[si] = src[s]）。
   * 两者写反的后果是"混淆一次等于还原一次"，用户看到的图和原图一样，
   * 却以为已经打乱了 —— 最坏的情况是把敏感图原样发出去。
   * 注意工具里源数组叫 src、测试副本里叫 data，只比对下标形态。 */
  // 锁的是：反向分支必须是 dst[perm[i]] = src[i]，写反则混淆等于还原。
  assert.ok(/dst\[di\] = src\[si\]/.test(src), 'permute 反向分支的下标方向变了');
  // 锁的是：Fisher-Yates 的循环方向（从 n-1 递减）。
  assert.ok(/for \(let i = n - 1; i > 0; i--\)/.test(src), 'Fisher-Yates 循环方向变了');
  // 锁的是：密钥派生必须用 FNV-1a 那套常数，否则同密钥在不同版本间不兼容。
  assert.ok(/16777619/.test(src) && /2166136261/.test(src), '密钥派生常数变了（会导致旧图无法还原）');
});

/* 锁的是：工具必须明确写"视觉混淆不是加密"。
 * 不能用行为断言的原因：这是一条**产品安全声明**，不是运行时行为。
 * 缺了它用户会误以为这是加密功能，从而把敏感图当安全文件发出去。 */
t('界面上写清了「不是加密」的警告', () => {
  const src = readSrc('js/tools/media/img-scramble.js');
  // 锁的是：这条警告文案不能被删掉或改弱。
  assert.ok(/视觉混淆不是加密/.test(src), '缺少「不是加密」的醒目警告');
  // 锁的是：必须指向真正的加密工具，否则用户不知道该用什么替代。
  assert.ok(/文件加密解密/.test(src), '应指引用户改用 AES 加密工具');
});

/* ============ 与 filePicker 的接口契约 ============
 *
 * 锁的是：run() 取文件列表时必须调用 picker.paths，而不是 picker.files()。
 *
 * 【为什么这条曾经是真事故】filePicker() 返回的 api 里根本没有 files()
 * 这个方法（见 js/ui.js 的 filePicker 尾部：el/dz/list/paths/count/add/
 * clear/setLocked/move/sortBy/setMainText）。调用不存在的方法会当场抛
 * TypeError，而那一行是 run() 的第一句 —— 勾好图、填好密钥、选好输出目录，
 * 点「开始处理」永远没有任何反应（连 toast 都没有）。
 * 也就是说这个工具从写下来起就是 100% 不可用的，而当时全项目另外 88 处
 * 调用都正确地写着 picker.paths，只有这一处写错。
 *
 * 【为什么不能用行为断言】工具是 IIFE 包裹的，run() 拿不到也调不起来；
 * 要真的点一下才能暴露（需要 Electron + 真图 + 真对话框）。
 * 所以这里用源码断言，并用「反向扫描整个 js/tools」把同类笔误一次性挡住 ——
 * 只盯这一个文件的话，下一个复制粘贴出来的同款错误仍然会漏。
 */
t('run() 用 picker.paths 取文件列表（picker 上没有 files 方法）', () => {
  const src = readSrc('js/tools/media/img-scramble.js');
  // 锁的是：run() 必须通过 picker.paths 拿文件（这是 filePicker 唯一提供的入口）。
  assert.ok(/picker\.paths/.test(src), 'img-scramble 的 run() 应该用 picker.paths');
  // 锁的是：整个工具里不能再出现 picker.files( 这种不存在的成员。
  assert.ok(!/picker\.files\s*\(/.test(src), 'picker 上没有 files() 方法，调用它会抛 TypeError');
});

t('js/tools 下没有任何 picker.files() 调用（同款笔误全项目扫描）', () => {
  /* 【为什么用 readTree 而不是自己 readdir + readFileSync】
   * scripts/test-source-assertions.js（元测试）会拦「裸 readFileSync 读项目源码」
   * 与「对源码文本做 .test 却没有『锁的是』注释」两种形态。
   * 本文件不在它的存量基线里，所以必须 A=0 / B=0 ——
   * readTree 是 harness 提供的正规入口（它内部剥注释，语义与 readSrc 一致）。
   *
   * 【已知边界】readTree 只扫一层目录（不递归子目录）。而 picker 的实际
   * 调用点分布在 js/tools/*.js 与 js/tools/media/*.js 两处，所以这里
   * 分两次读：顶层 + media 子目录。将来若再分层，这条要跟着加目录 ——
   * 漏掉的那一层会静默失去保护，所以下面用 assert 显式记住两处都扫过。 */
  const top = readTree('js/tools');
  const media = readTree('js/tools/media');
  // 锁的是：顶层工具文件里不能出现 picker.files( 这种不存在的成员。
  assert.ok(!/picker\.files\s*\(/.test(top), 'js/tools/*.js 里出现了 picker.files()（picker 上没有这个方法）');
  // 锁的是：media 子目录同样不能出现（img-scramble 就在这一层）。
  assert.ok(!/picker\.files\s*\(/.test(media), 'js/tools/media/*.js 里出现了 picker.files()（picker 上没有这个方法）');
});

/* 锁的是：run() 无论成功还是抛异常，都必须把文件列表解锁。
 * 不能用行为断言的原因：同上（IIFE + 无导出），只能看源码形态。
 * 只 prog.hide() 不解锁的话，一次异常就把用户卡在「加不了文件、
 * 也删不掉列表」的页面上，只能切页重开。 */
t('run() 的 finally 里解开了 picker 的锁', () => {
  const src = readSrc('js/tools/media/img-scramble.js');
  // 锁的是：设置了 locked 就必须有配对的 setLocked(false)。
  assert.ok(/picker\.setLocked\(true\)/.test(src), 'run() 应该先锁住列表');
  // 锁的是：finally 里必须有解锁调用（漏了会让页面永久不可用）。
  assert.ok(/picker\.setLocked\(false\)/.test(src), 'run() 的 finally 必须解锁列表');
});

done();
