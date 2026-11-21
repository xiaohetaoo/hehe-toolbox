'use strict';
/* 把 BGM 与 SFX 混进 Remotion 渲染出的无音轨视频。
 *
 * 用法（在 promo/ 目录下）：
 *   node scripts/mix-audio.js                 # 默认：BGM + Main.tsx 里的全部 SFX
 *   node scripts/mix-audio.js --keyboard-only # 只保留打字声（去掉其余 SFX）
 *   node scripts/mix-audio.js --no-bgm        # 不要 BGM
 *
 * 【为什么不在 Remotion 里混】这台机器的 Remotion 4.0.484 在 Windows 上
 * 预处理音轨时报 `Permission denied`（remotion-audio-mixing\0.wav 父目录不存在），
 * 所以改成「--muted 渲画面 + ffmpeg 外部混音」。
 *
 * 【为什么不用 amix 的 normalize 参数】本机 ffmpeg 是 2018 构建（Lavc58），
 * amix 还没有 normalize（4.4+ 才有），带上会 "Option not found"。
 * 【不要额外加增益】实测该版本 amix 之后是各路直接叠加、不按 1/n 衰减：
 *   BGM(0.42) −20.5/−5.0 dB，打字声(0.30) −35.3/−12.0 dB，
 *   amix 后 −20.6/−5.0 dB（正常）；乘 2 变 −14.6/−0.0 dB（削波）。
 *
 * 需要 ffmpeg：优先用 REMOTION_FFMPEG 环境变量，其次 promo/.ffmpeg/ffmpeg.exe，
 * 最后找系统 PATH 里的 ffmpeg。
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PRO = path.resolve(__dirname, '..');
const OUT = path.join(PRO, 'out');
const FPS = 30;

function findFfmpeg() {
  const cands = [
    process.env.REMOTION_FFMPEG,
    path.join(PRO, '.ffmpeg', 'ffmpeg.exe'),
    path.join(PRO, '.ffmpeg', 'ffmpeg'),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  try {
    const { execSync } = require('child_process');
    const p = execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg',
      { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* 没装 */ }
  throw new Error('找不到 ffmpeg。请设置 REMOTION_FFMPEG 或把它放到 promo/.ffmpeg/ffmpeg.exe');
}

const args = process.argv.slice(2);
const keyboardOnly = args.includes('--keyboard-only');
const useBgm = !args.includes('--no-bgm');

const video = path.join(OUT, 'video-only.mp4');
if (!fs.existsSync(video)) {
  throw new Error('缺少画面轨 ' + video + '\n请先运行：npx remotion render src/index.ts HehePromo out/video-only.mp4 --muted');
}

/* 从 Main.tsx 读 SFX 表与总帧数，保证混音与时间线同源（改片不用改两处）。 */
const mainSrc = fs.readFileSync(path.join(PRO, 'src', 'Main.tsx'), 'utf8');
function readCues() {
  return [...mainSrc.matchAll(/\[(\d+), '([a-z-]+)', ([\d.]+)(?:, (\d+))?\]/g)]
    .map((m) => ({ frame: +m[1], name: m[2], vol: +m[3], dur: m[4] ? +m[4] : null }))
    .filter((c) => c.name !== 'bgm');
}
const totalM = /export const TOTAL = (\d+)/.exec(mainSrc);
if (!totalM) throw new Error('Main.tsx 里找不到 export const TOTAL，无法确定片长');
const TOTAL_SEC = +totalM[1] / FPS;

/* --keyboard-only：只保留 keyboard，并按实测把增益提到 0.75
 * （0.30 时打字声窗 mean −31.3 dB，比 BGM 安静窗 −23.0 dB 还低，等于没加）。
 * 帧位/时长从 SFX 表取，不在这里手抄 —— 手抄会在改片后悄悄漂移。 */
const KEYBOARD_VOL = 0.75;
const cues = keyboardOnly
  ? readCues().filter((c) => c.name === 'keyboard').map((c) => ({ ...c, vol: KEYBOARD_VOL }))
  : readCues();
if (keyboardOnly && !cues.length) throw new Error('SFX 表里没有 keyboard 条目，--keyboard-only 无从混起');

const inputs = [video];
const filters = [];
const labels = [];

cues.forEach((c, i) => {
  const f = path.join(PRO, 'public', 'audio', 'sfx', c.name + '.mp3');
  if (!fs.existsSync(f)) { console.warn('缺音效，跳过：' + c.name); return; }
  inputs.push(f);
  const idx = inputs.length - 1;
  const delayMs = Math.round((c.frame / FPS) * 1000);
  /* 【与 Main.tsx 的 SfxTrack 同规则】没写 dur 的条目在 Remotion 时间线里
   * 默认截到 90 帧（3s）——impact-cine 4.1s / sparkle 4.6s 的尾巴若不截，
   * 外部混音就比时间线多响 1 秒多，「同源」名存实亡（实测时长后补上）。 */
  const durFrames = c.dur || 90;
  const trim = `atrim=0:${(durFrames / FPS).toFixed(3)},`;
  filters.push(`[${idx}:a]${trim}volume=${c.vol},adelay=${delayMs}|${delayMs}[s${i}]`);
  labels.push(`[s${i}]`);
});

if (useBgm) {
  const bgm = path.join(PRO, 'public', 'audio', 'bgm.mp3');
  if (!fs.existsSync(bgm)) throw new Error('缺 BGM 文件 ' + bgm + '（或用 --no-bgm 跳过）');
  inputs.push(bgm);
  const bi = inputs.length - 1;
  const fadeSt = (TOTAL_SEC - 0.6).toFixed(3);
  filters.push(`[${bi}:a]atrim=0:${TOTAL_SEC},volume=0.42,afade=t=out:st=${fadeSt}:d=0.6[bgm]`);
  labels.push('[bgm]');
}

if (!labels.length) throw new Error('没有任何音轨可混（既没有 SFX 也没有 BGM）');

/* 【为什么是 -t 而不是 -shortest】-shortest 按最短流截断：
 * --keyboard-only --no-bgm 时音轨只有几秒，实测 2s 画面 + 0.5s 音频
 * 出来只剩 0.67s —— 整条画面被音轨长度截掉。改用 -t 按片长
 * （Main.tsx 的 TOTAL）收口：画面永远完整，音轨短就让它自然结束。
 * 【不要加 apad】本机 2018 版 ffmpeg 两个坑（都实测过）：
 *   ① apad 没有 whole_dur 参数（Option not found）；
 *   ② 无限 apad + -t 提前收口会触发 trim.c:303 断言直接崩溃
 *      （keyboard+BGM 两路 amix 时必现）。不加 apad 反而全组合稳定。 */
const graph = filters.join(';') + ';'
  + labels.join('') + `amix=inputs=${labels.length}:duration=longest[mix]`;

const outFile = path.join(OUT, 'promo.mp4');
const ffArgs = ['-y'];
for (const i of inputs) ffArgs.push('-i', i);
ffArgs.push('-filter_complex', graph);
ffArgs.push('-map', '0:v', '-map', '[mix]');
ffArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(TOTAL_SEC), outFile);

const ff = findFfmpeg();
console.log('ffmpeg:', ff);
console.log('音轨:', labels.join('') || '(none)', '| BGM:', useBgm, '| 仅打字:', keyboardOnly);
try {
  execFileSync(ff, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  /* execFileSync 默认只报命令行，ffmpeg 的真实死因在 stderr —— 不打出来没法排查 */
  if (e.stderr) console.error(String(e.stderr).split(/\r?\n/).slice(-15).join('\n'));
  throw e;
}
const st = fs.statSync(outFile);
console.log('完成', path.relative(PRO, outFile), (st.size / 1048576).toFixed(2) + ' MB');

/* 混完直接报电平，避免"以为好了其实削波"（本项目真实踩过 max_volume 0.0 dB）。
 * 【必须读 stderr】volumedetect 的结果写在 stderr，stdout 恒为空 ——
 * 原先用 execFileSync 的返回值（stdout）去匹配，这条报告从来没生效过（实测）。 */
const probe = spawnSync(ff, ['-i', outFile, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
const m = /max_volume:\s*(-?[\d.]+) dB/.exec(probe.stderr || '');
if (m) console.log('峰值电平:', m[1], 'dB' + (parseFloat(m[1]) > -0.5 ? '  ⚠ 接近削波，请降低增益' : '  ✓'));
else console.warn('没能从 ffmpeg 读到峰值电平（不影响成片）');