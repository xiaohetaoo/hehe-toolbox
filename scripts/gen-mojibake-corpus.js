'use strict';
/* 生成 scripts/fixtures/mojibake-corpus.json。
 *
 * ============ 这个文件解决什么问题 ============
 * test-mojibake 里那条「三条前提合起来，语料上『第三种文本』必须为 0」需要
 * 对 33 条真实乱码输入跑 analyzeWithEncoder。含 FFFD 的 19 条会走
 * 「不该借外部编码器」的分支（不起进程，很快），剩下 14 条每条要起一次
 * PowerShell —— 实测单次 688ms，合计 9.6 秒，占 test-mojibake（11.2s）的 85%，
 * 也是 test:unit 涨到 20 秒的主因。
 *
 * 做法：把这 14 条的期望结果预先算好写成 golden，测试平时只比对结果。
 * 【含 FFFD 的那 19 条不在 golden 里做真值比对】测试仍然真跑它们 ——
 * 那正是本轮缺陷的核心（.NET 把 FFFD 编成问号），用桩就测不到了。
 *
 * ============ 为什么不会「样本改了但 golden 没重算」 ============
 * 与 gen-mojibake-golden.js 同一套手法：golden 里存语料表的 sha256，
 * 测试每次先用同一份 SHAPES 算 hash 比对 —— 不一致就红，并提示重跑。
 * 于是「样本改了没重算」与「行为真的变了」是两种不同的红。
 *
 * 用法：
 *   node scripts/gen-mojibake-corpus.js           # 只打印，不落盘
 *   node scripts/gen-mojibake-corpus.js --write   # 真的写进去
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'scripts', 'fixtures', 'mojibake-corpus.json');

/* 【语料表必须与测试用的是同一份】这里导出，测试 require 它 —— 不各写一份。 */
const TEXTS = [
  '你好，世界', '配置文件已保存', '请检查网络连接', '数据加载完成',
  '操作失败，请重试', '系统提示：磁盘空间不足', '用户手册第一章', '今日天气晴朗',
  '无法打开该文件', '设置已更新', '文件已成功写入',
];

const gbk = (b) => new TextDecoder('gbk', { fatal: false }).decode(b);

/** 按机理造出真实乱码形态（不是随机字节）。 */
function buildShapes() {
  const out = [];
  for (const orig of TEXTS) {
    const buf = Buffer.from(orig, 'utf8');
    out.push({ orig, kind: 'gbk-clean', input: gbk(buf) });
    out.push({ orig, kind: 'gbk-tail1', input: gbk(buf.subarray(0, buf.length - 1)) });
    out.push({
      orig, kind: 'gbk-tail2',
      input: gbk(buf.subarray(0, buf.length - 2)) + gbk(buf.subarray(buf.length - 2)),
    });
  }
  return out;
}

const SHAPES = buildShapes();

function samplesHash() {
  const key = SHAPES.map((s) => s.orig + '\u0000' + s.kind + '\u0000' + s.input).join('\u0001');
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function psRunner(script, timeoutMs) {
  return Promise.resolve({
    stdout: cp.execFileSync('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: timeoutMs || 30000 }),
  });
}

async function main() {
  const m = require(path.join(ROOT, 'lib', 'mojibake'));
  const rows = [];
  let externalTried = false;
  const t0 = Date.now();
  for (const s of SHAPES) {
    const r = await m.analyzeWithEncoder(s.input, psRunner);
    if (r.externalTried) externalTried = true;
    rows.push({
      orig: s.orig,
      kind: s.kind,
      input: s.input,
      hasFffd: s.input.indexOf('\uFFFD') !== -1,
      bestText: r.best.text,
      bestFrom: r.best.from,
      bestTo: r.best.to,
      bestScore: r.best.score,
      externalTried: r.externalTried,
    });
  }
  const elapsedMs = Date.now() - t0;
  const payload = {
    _comment: '乱码修复的语料快照。由 scripts/gen-mojibake-corpus.js 生成，不要手改。',
    _why: '含 FFFD 的输入不起 PowerShell（走「不该借外部编码器」分支），'
      + '测试仍然真跑它们；不含 FFFD 的这 14 条每条要起一次进程（688ms），'
      + '所以把期望结果预存成 golden，平时只比对不重算。',
    samplesHash: samplesHash(),
    generatedAt: new Date().toISOString(),
    elapsedMs,
    externalTried,
    rows,
  };
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
    console.log('已写入 ' + OUT);
  } else {
    console.log('（预览，不落盘。加 --write 才写）');
  }
  console.log('语料 ' + rows.length + ' 条，耗时 ' + (elapsedMs / 1000).toFixed(1) + 's');
  const stat = { FIXED: 0, SAME: 0, THIRD: 0 };
  for (const r of rows) {
    if (r.bestText === r.orig) stat.FIXED++;
    else if (r.bestText === r.input) stat.SAME++;
    else stat.THIRD++;
  }
  console.log('FIXED ' + stat.FIXED + ' / SAME ' + stat.SAME + ' / THIRD ' + stat.THIRD);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { TEXTS, SHAPES, samplesHash };
