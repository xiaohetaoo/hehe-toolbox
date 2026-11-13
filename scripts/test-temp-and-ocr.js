'use strict';
/* 14b) OCR 重入护栏要给出可理解的提示
 * 14c) 临时名白名单漏了 tempPathFor 的产出；hosts 的 tmp 要显式声明不清扫
 * 17b) 目标体积的 MB 口径要在界面上标清楚
 */
const path = require('path');
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const TN = require(path.join(__dirname, '..', 'lib', 'temp-names'));

/* ============ 14c) 白名单 ============ */
t('TN1 tempPathFor 的产出被认成自己的临时文件', () => {
  /* 锁的是：生成器在 lib/fs-ops.js、白名单在 lib/temp-names.js，
   * 两边靠人记得同步 —— 实测就是漏了：
   * isOwnTempName('out.mkv.merging-1700000000000-a1b2') 返回 false，
   * 于是这类残留永远不会被清扫，用户目录里越堆越多。 */
  const sample = TN.tempPathFor('out.mkv', 'merging');
  assert.strictEqual(TN.isOwnTempName(path.basename(sample)), true,
    'tempPathFor 的产出没被白名单覆盖：' + sample);
});

t('TN2 生成器与白名单现在在同一个文件里（结构上不会再分叉）', () => {
  /* 锁的是：又把 tempPathFor 挪回 lib/fs-ops.js —— 那正是漏登记的原因。 */
  const tn = readSrc('lib/temp-names.js');
  assert.ok(/function tempPathFor/.test(tn), 'tempPathFor 不在 temp-names 里');
  const fso = readSrc('lib/fs-ops.js');
  /* 锁的是：两边各留一份实现 —— 生成形态与白名单迟早对不上。 */
  assert.ok(!/function tempPathFor\s*\(/.test(fso),
    'lib/fs-ops.js 里还留着一份 tempPathFor 实现（应改为 require）');
});

t('TN3 hosts 的两个备份被显式声明为「不清扫」', () => {
  /* 锁的是：有人看到 hosts.hehe.tmp / hosts.hehe.restore.tmp 没被任何正则
   * 覆盖，就顺手补一条 —— 那会把用户灾难恢复时唯一的备份删掉。 */
  assert.ok(Array.isArray(TN.MUST_NOT_SWEEP), '没有 MUST_NOT_SWEEP 声明');
  const names = TN.MUST_NOT_SWEEP.map((x) => x.name);
  assert.ok(names.includes('hosts.hehe.tmp'), 'hosts.hehe.tmp 未被声明');
  assert.ok(names.includes('hosts.hehe.restore.tmp'), 'hosts.hehe.restore.tmp 未被声明');
  /* 并且它们确实不在清扫白名单里（声明 ≠ 放行） */
  /* 锁的是：声明了却又把它们加进白名单 —— 那声明就变成谎话。 */
  assert.strictEqual(TN.isOwnTempName('hosts.hehe.tmp'), false,
    'hosts.hehe.tmp 被清扫白名单覆盖了（那是灾难恢复用的备份）');
  assert.strictEqual(TN.isOwnTempName('hosts.hehe.restore.tmp'), false,
    'hosts.hehe.restore.tmp 被清扫白名单覆盖了');
});

t('TN4 白名单不能把正常用户文件误判成临时产物', () => {
  /* 锁的是：新加的正则写得太宽（例如 \.+.*-\d+-.*），
   * 把用户的普通文件当成自家残留删掉。 */
  const normal = ['报告.docx', 'out.mkv', 'a.tar.gz', 'photo-2024.jpg', 'notes-1.txt'];
  for (const n of normal) {
    /* 锁的是：过宽的规则 → 删用户文件。 */
    assert.strictEqual(TN.isOwnTempName(n), false, '正常文件被判成了临时产物：' + n);
  }
});

/* ============ 14b) OCR 重入 ============ */
t('OCR1 批量 OCR 的重入挡板给了可理解的提示（不是静默 return）', () => {
  const src = readSrc('js/tools/media/batch-ocr.js');
  /* 锁的是：裸 `if (running) return;` —— 点了没反应也没提示，
   * 而超时并不会杀掉后台 worker，用户完全不知道发生了什么。 */
  const i = src.indexOf('if (running) {');
  assert.ok(i > 0, '还是裸 return，没有给出提示');
  const seg = src.slice(i, i + 300);
  /* 锁的是：提示只说"已在运行中"、看不出"上一次可能还在后台耗着" ——
   * 而超时并不会杀掉 worker，用户不知道等的是什么。 */
  assert.ok(/上一次识别/.test(seg), '提示里没有说明"上一次仍在进行"');
  /* 锁的是：只改状态行不给 toast —— 不看底部状态栏的用户完全感知不到。 */
  assert.ok(/toast\(/.test(seg), '没有 toast 提示');
});

t('OCR2 批量 OCR 仍保留超时归因与 finally 复位', () => {
  const src = readSrc('js/tools/media/batch-ocr.js');
  /* 锁的是：为了加提示而把已有的超时保护/复位弄丢 ——
   * 那会让整批卡死或按钮永久不可用。
   * v0.9 给批量识别加了停止按钮，finally 里同步复位按钮（取消后可回用）。 */
  assert.ok(/OcrGuard\.withTimeout/.test(src), '单张超时保护不见了');
  /* 锁的是：finally 复位 running 与 prog —— v0.9 加停止按钮后还要同步复位
   * 按钮（取消后按钮可回用）。复位丢了表现为「第二次点开始没反应」。 */
  assert.ok(/finally \{ running = false; prog\.hide\(\); ocrStopBtn\.disabled = true; \}/.test(src),
    'finally 复位不见了（应同时复位 running / prog / 停止按钮）');
});

/* ============ 17b) MB 口径 ============ */
t('MB1 目标体积界面标明了 1 MB = 10^6 字节', () => {
  const src = readSrc('js/tools/target-size.js');
  /* 锁的是：界面只写「MB」而换算用 10^6，与项目 fmtBytes 的 1024² 不同 ——
   * 用户填 10 MB、结果列表显示 9.5 MiB，看着像算错了。 */
  assert.ok(/10⁶|1,000,000/.test(src), '界面没有说明 MB 的口径');
  /* 换算本身保持不变（这是有意的设计选择，只是要标清楚） */
  /* 锁的是：为了"对齐"把换算改成 1024² —— 那会超过平台的上传限制。 */
  assert.ok(/mb \* 1000000/.test(src), '换算被改了（应保持 10^6）');
});

done();
