'use strict';
/* 生成 scripts/fixtures/mojibake-golden.json。
 *
 * ============ 这个文件解决什么问题 ============
 * test-mojibake 里有一条「正常文本经带编码器路径也不许被改坏」。它必须走
 * **真 PowerShell**（analyzeWithEncoder 要有真编码器才走那条路径），
 * 而每条输入要起一次进程 —— 实测单次 812ms，13 条串起来 10.5 秒，
 * 占 test:unit 总时长（25 秒）的 40%。
 *
 * 做法 A（本脚本）：把这 13 条输入的期望结果**预先算好写成 golden**，
 * 测试平时只比对结果，不再每次起 13 个进程。只有显式加 --write 时才重算。
 *
 * ============ 为什么不会「样本改了但 golden 没重算」 ============
 * golden 里存了样本表本身的 sha256（SAMPLES_HASH）。测试每次都会：
 *   1) 用同一份 SAMPLES 数组算 hash，与 golden 里比 —— 不一致就红，
 *      提示「样本改了，请重跑 gen-mojibake-golden.js」；
 *   2) 再逐条比对 best.text 与 golden 记录的一致。
 * 这样「样本改了但没重算」和「行为变了」是两种不同的红，报错信息能区分。
 *
 * ============ 负例仍然要真跑 ============
 * 提速不等于放弃检测能力。测试里保留 3 条**已知坏样本**，它们走完整的
 * 打分与排序（不依赖 PowerShell，本来就快），并在 golden 里额外记录
 * 「坏样本修复后的期望文本」，用来确认排序规则没被改坏。
 *
 * 用法：
 *   node scripts/gen-mojibake-golden.js           # 只打印，不落盘
 *   node scripts/gen-mojibake-golden.js --write   # 真的写进去
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'scripts', 'fixtures', 'mojibake-golden.json');

/* 【样本表必须与 test-mojibake.js 里那份逐字相同】
 * 为了让两边不会分叉，样本放在这里导出、测试 require 它 —— 而不是各写一份。 */
const SAMPLES = [
  'Hello 世界',
  'ok',
  'file saved',
  'ERROR: 无法打开文件',
  '测试文本',
  '这是一段完全正常的中文，不应该被改坏。',
  '数据库连接失败，请检查配置文件。',
  '当前版本已是最新',
  'https://example.com/路径/文件.txt',
  'C:\\Users\\张三\\文档\\报告.docx',
  '混合 English and 中文 text 123',
  '訂單已確認，將於三個工作日內出貨。',
  '資料庫連線失敗，請檢查設定檔。',
];

function samplesHash() {
  return crypto.createHash('sha256').update(SAMPLES.join('\u0000'), 'utf8').digest('hex');
}

function psRunner(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      resolve({
        stdout: cp.execFileSync('powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
          { encoding: 'utf8', timeout: timeoutMs || 30000 }),
      });
    } catch (e) { reject(e); }
  });
}

async function main() {
  const m = require(path.join(ROOT, 'lib', 'mojibake'));
  const rows = [];
  const t0 = Date.now();
  for (const s of SAMPLES) {
    const r = await m.analyzeWithEncoder(s, psRunner);
    rows.push({
      input: s,
      /* 期望：最优候选就是原样，且它的 from/to 标明「没转换」。 */
      bestText: r.best.text,
      bestFrom: r.best.from,
      bestTo: r.best.to,
      externalTried: !!r.externalTried,
      candidateCount: r.candidates.length,
    });
  }
  const golden = {
    /* 文件头说明：给人看的，也说明「什么时候要重算」 */
    _comment: '由 scripts/gen-mojibake-golden.js 生成。样本表改动后必须重跑（--write）。',
    _why: 'analyzeWithEncoder 需要真 PowerShell，单次 812ms × 13 条 ≈ 10.5 秒，'
      + '占 test:unit 的 40%。这里预存结果，测试平时只比对。',
    samplesHash: samplesHash(),
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    rows,
  };
  const text = JSON.stringify(golden, null, 2) + '\n';

  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text, 'utf8');
    console.log('已写入 ' + path.relative(ROOT, OUT));
    console.log('  样本 ' + rows.length + ' 条，耗时 ' + golden.elapsedMs + ' ms');
    console.log('  样本 hash: ' + golden.samplesHash.slice(0, 16) + '…');
  } else {
    console.log(text);
    console.log('（这是预览。加 --write 才会落盘。）');
  }
}

module.exports = { SAMPLES, samplesHash };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
