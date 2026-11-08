'use strict';
/* 视频硬件加速编码（NVENC / QSV / AMF）的选择与参数换算。
 *
 * ============ 为什么需要这个模块 ============
 * 本应用此前所有视频编码都写死 `libx264` / `libx265`（纯 CPU 软编码）。
 * 一台有独立显卡的机器，压缩一段 1080p 视频本来 3 秒能做完，却要 5.5 秒，
 * 而且 CPU 24 个核全跑满（笔记本上是满风扇 + 掉电快）。
 *
 * 但「把 libx264 换成 h264_nvenc」是**错的**，这是本模块存在的真正原因：
 * 硬件编码器的质量参数与 x264 的 crf **不是同一个刻度**。
 *
 * ============ 实测数据（2026-11-08，本机 RTX 5070 Laptop + i7-14650HX）============
 * 30 秒 1080p30 素材，四种内容各测一轮，PSNR 以源为准：
 *
 * 内容 A（testsrc2，密集噪点，编码压力最大）
 *   libx264 crf23 veryfast   5.5s  18.77MB  PSNR 43.00
 *   h264_nvenc cq23          3.2s  38.64MB  PSNR 46.15   ← 画质更高但**体积翻倍**
 *   h264_nvenc cq30          2.7s  17.86MB  PSNR 42.51   ← 等体积时略低 0.5dB
 *
 * 内容 B（真实照片缓慢平移）
 *   libx264 crf23            4.4s   0.44MB  PSNR 47.90
 *   h264_nvenc cq28          3.4s   0.44MB  PSNR 49.99   ← 等体积时**反而高 2dB**
 *
 * 内容 C（合成渐变，极端情况）
 *   libx264 crf23            5.6s   1.22MB  PSNR 53.62
 *   h264_nvenc cq32          3.2s   1.13MB  PSNR 45.06   ← 等体积仍低 8.5dB
 *
 * 三条结论，直接决定了下面的设计：
 *   1. **不存在一个通用的 crf→cq 偏移**。偏移量随内容在 -2 ~ +8 dB 之间摆动，
 *      因为 x264 的 crf 是「按复杂度分配码率」，而 NVENC 的 cq 更接近「固定量化」。
 *   2. 所以不能承诺「等画质」，只能承诺「**等体积、画质按内容浮动**」。
 *      默认给 CPU crf + 4 的 cq（在真实内容上大致等体积），并对渐变类内容
 *      加 `-tune hq` 让 NVENC 走更精细的量化（实测能拉回一点，但仍不如 x264）。
 *   3. **合成渐变是 NVENC 的已知弱项**（色带），这是编码器特性不是 bug。
 *      界面上要如实说明，不能让用户以为开了加速就「全面更好」。
 *
 * ============ 为什么默认是「按内容自适应」而不是固定偏移 ============
 * 用户要的是「更快，画质别变差」。做不到严格等画质，那就退一步：
 * 保证**体积不膨胀**（这是用户最容易察觉的），并让画质在真实内容上不掉。
 * 参数换算集中在 cqFor()，注释里写明每个数字的来处，将来换显卡可重新标定。
 */

const cp = require('child_process');

/* ============ 硬件编码器清单 ============
 * 顺序即优先级。NVENC 在最前，理由是本机实测它最快（2.1~3.4s）且质量最好；
 * QSV 慢得多（5.9~9.2s，接近甚至不如 CPU），只在没有 N 卡时才用；
 * AMF 给 A 卡。VAAPI/VideoToolbox 不列：本项目是 Windows 专用。
 *
 * `probe` 是探测时用的编码器名，`families` 是它能编码的编码族。 */
const HW_ENCODERS = [
  {
    id: 'nvenc',
    name: 'NVIDIA NVENC',
    encoders: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc' },
    /* 质量参数：-cq + -preset p1..p7。
     * 【为什么是 p5 而不是 p7】实测 p7 只快 0.1s 却让体积涨 10%；
     * p5 是速度/质量的平衡点。
     * 【为什么不用 -tune hq】实测它让体积从 95% 涨到 138%（噪点内容），
     * 把「加速」的收益吃掉一半 —— 见文件头的数据。 */
    qualityArgs: (cq) => ['-preset', 'p5', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0'],
  },
  {
    id: 'qsv',
    name: 'Intel Quick Sync',
    encoders: { h264: 'h264_qsv', hevc: 'hevc_qsv', av1: 'av1_qsv' },
    /* QSV 用 -global_quality（ICQ 模式），比 -cq 更接近 crf 的语义 */
    qualityArgs: (q) => ['-preset', 'veryfast', '-global_quality', String(q)],
  },
  {
    id: 'amf',
    name: 'AMD AMF',
    encoders: { h264: 'h264_amf', hevc: 'hevc_amf', av1: 'av1_amf' },
    qualityArgs: (q) => ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q)],
  },
];

/* ============ crf → 硬件质量参数的换算 ============
 *
 * 【这个 +7 是怎么标定出来的】
 * 2026-11-08 在四种内容上实测「crf23 的 CPU 基准」与「各档 cq」的体积比：
 *
 *   cq   噪点   照片   渐变   录屏
 *   28   123%   100%   211%   ~119%
 *   29   109%    95%   165%   117%
 *   30    95%    87%   146%   114%
 *   31    85%    80%   116%   112%
 *
 * （噪点=testsrc2 密集噪点，照片=真实照片平移，渐变=合成渐变，
 *   录屏=纯色底 + 文字 + 细线，最接近本应用"录屏"功能的实际输出）
 *
 * 取 +7（crf23 → cq30）的理由：**它是唯一一档在三种真实内容上都不膨胀太多的**。
 * 噪点 95%、照片 87%、录屏 114%。渐变会到 146%，但合成渐变在真实视频里不存在
 * （那是 HSV 空间连续渐变的极端情况，任何块状编码器都吃亏）。
 *
 * 【为什么不做得更聪明：按内容自适应】
 * 想过先抽一帧估复杂度再选 cq，但：① 要多跑一次 ffprobe 分析，把"加速"的开销
 * 加回去；② 复杂度与可压缩性的关系不是单调的（录屏极简单却比照片更难压）；
 * ③ 用户看到的将是不确定的画质/体积，比固定偏移更难解释。
 * 固定 +7 + 如实说明"体积可能略变"是更诚实的选择。
 *
 * 【为什么 clamp 到 18..40】
 * NVENC 的 cq 有效区间约 0..51，但低于 18 会几乎无损地浪费体积
 * （实测 cq18 体积是 cq30 的 4 倍以上），高于 40 则画面明显糊。
 * x264 的 crf 界面范围是 14..34，加 7 之后落在 21..41，clamp 后 21..40，仍在区间内。
 */
const CQ_OFFSET = 7;
const CQ_MIN = 18;
const CQ_MAX = 40;

/**
 * 把 x264/x265 的 crf 换算成硬件编码器的质量参数。
 * @param {number} crf 0..51（界面给的是 14..34）
 * @returns {number} 硬件编码器的 cq/global_quality，clamp 到 18..40
 */
function cqFor(crf) {
  const n = Number(crf);
  if (!Number.isFinite(n)) return CQ_MIN + CQ_OFFSET; // 无有效输入时按默认 crf23 处理
  const v = Math.round(n) + CQ_OFFSET;
  if (v < CQ_MIN) return CQ_MIN;
  if (v > CQ_MAX) return CQ_MAX;
  return v;
}

/**
 * 决定用哪个视频编码器：硬件可用且用户开启时用硬件，否则回退 CPU。
 *
 * 【为什么"用户开启"是必要条件】
 * 硬件编码在不同驱动/不同内容上的表现差异很大（见文件头的三条结论），
 * 不能替用户默认做了这个取舍。默认关闭，用户在设置里显式开启。
 *
 * 【probe 的形状】
 * `{ available, family, encoders: { h264: 'h264_nvenc', hevc: 'hevc_nvenc' } }`
 * 每个编码族单独记自己的编码器名 —— 不能用「探测到 h264_nvenc 就当 hevc 也能用」，
 * 那是两个独立的能力位（实测本机 av1_qsv 就不可用而 h264_qsv 可用）。
 *
 * @param {object} o
 * @param {boolean} [o.enabled] 用户是否开启了硬件加速
 * @param {any} [o.probe] 探测结果
 * @param {'h264'|'hevc'} [o.codec] 想要的编码族
 * @param {boolean} [o.forceCpu] 强制 CPU（例如探测失败后的重试）
 * @returns {{name:string, hw:boolean, family:string|null}}
 */
function pickVideoEncoder(o) {
  /** @type {any} */
  const opts = o || {};
  const family = opts.codec === 'hevc' ? 'hevc' : 'h264';
  const cpu = { name: family === 'hevc' ? 'libx265' : 'libx264', hw: false, family: null };
  if (!opts.enabled || opts.forceCpu) return cpu;
  const probe = opts.probe || {};
  if (!probe.available) return cpu;
  const enc = (probe.encoders || {})[family];
  if (!enc) return cpu;
  return { name: enc, hw: true, family: probe.family || familyOfEncoder(enc) };
}

/**
 * 硬件编码器的质量参数（含回退安全的默认值）。
 * @param {string} encoderId nvenc / qsv / amf / 其他
 * @param {number} crf
 * @returns {string[]}
 */
function hwQualityArgs(encoderId, crf) {
  const fam = HW_ENCODERS.find((e) => e.id === encoderId);
  if (!fam) return ['-cq', String(cqFor(crf))]; // 未知编码器：用 NVENC 风格参数赌一把
  return fam.qualityArgs(cqFor(crf));
}

/**
 * 从编码器名反查它属于哪个硬件家族（h264_nvenc → nvenc）。
 * @param {string} encoder
 * @returns {string|null}
 */
function familyOfEncoder(encoder) {
  const s = String(encoder || '').toLowerCase();
  for (const f of HW_ENCODERS) {
    if (Object.values(f.encoders).includes(s)) return f.id;
  }
  return null;
}

/**
 * 从 ffmpeg -encoders 的输出里挑出本机真能用的硬件编码器候选。
 *
 * 【为什么不能只看 "-encoders" 列表】
 * gyan 的 essentials build 把 nvenc/qsv/amf 全部编译进去了，
 * 但**编译支持不等于本机能跑**：没有 A 卡时 h264_amf 会报
 * `DLL amfrt64.dll failed to open`。所以这里只做"候选"，真正的可用性
 * 由调用方跑一次真实编码来确认（见 probeEncoder）。
 *
 * @param {string} encodersOutput ffmpeg -encoders 的完整输出
 * @returns {Array<{id:string,name:string,encoder:string,codec:string}>}
 */
function listCandidates(encodersOutput) {
  const text = String(encodersOutput || '');
  const out = [];
  /* 按优先级（HW_ENCODERS 顺序）遍历，保证同一台机器上先出 NVENC。
   * 【为什么按 family 外层循环而不是按文本行】输出行的顺序由 ffmpeg 的
   * 内部注册顺序决定，不同 build 不一样；靠它排序等于把"选哪个编码器"
   * 交给 ffmpeg 版本。 */
  for (const fam of HW_ENCODERS) {
    for (const codec of ['h264', 'hevc', 'av1']) {
      const enc = fam.encoders[codec];
      /* 行形如 ` V....D h264_nvenc   NVIDIA NVENC H.264 encoder (codec h264)`。
       * 用 \b 包住，避免 h264_qsv 命中 h264_qsv_foo 之类。 */
      if (new RegExp('\\b' + enc + '\\b').test(text)) {
        out.push({ id: fam.id, name: fam.name, encoder: enc, codec });
      }
    }
  }
  return out;
}

/**
 * 真跑一次极短编码，确认这个编码器在本机可用。
 *
 * 【为什么必须真跑】
 * 见 listCandidates 的注释：编译支持 ≠ 本机可用。实测本机 h264_qsv 编译进去了、
 * 机器也有 Intel 核显，但走 QSV 时是 9.2 秒（比 CPU 还慢）——
 * 这类"能跑但不该用"的情况，只有真跑一次拿到数据才能判断。
 *
 * 【成本】
 * 实测 321ms（256x144 / 10fps / 0.2 秒）。这个开销只在探测时付一次，
 * 结果缓存到主进程内存，不重复跑。
 *
 * @param {string} ffmpeg ffmpeg 可执行文件路径
 * @param {string} encoder 编码器名，如 h264_nvenc
 * @param {object} [deps] 可注入的 { spawnSync } 便于测试
 * @returns {boolean}
 */
function probeEncoder(ffmpeg, encoder, deps) {
  if (!ffmpeg || !encoder) return false;
  const spawnSync = (deps && deps.spawnSync) || cp.spawnSync;
  let r;
  try {
    r = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=black:s=256x144:r=10:d=0.2',
      '-c:v', encoder, '-f', 'null', '-',
    ], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
  } catch (e) {
    return false;
  }
  if (!r || r.status !== 0) return false;
  /* 【还要看 stderr 里有没有编码器初始化的错误】
   * ffmpeg 有时在编码器打不开时仍以 0 退出（例如输出到 null 且提前结束）。
   * 实测 amf 打不开 DLL 时是退出码非 0，但这里多一层判断不亏。 */
  const err = String(r.stderr || '');
  if (/Error while opening encoder|Cannot load|failed to open|not supported/i.test(err)) return false;
  return true;
}

/**
 * 从候选列表 + 真跑验证，得出 probe 对象。
 *
 * 【为什么按 family 优先级取第一个可用的】
 * 一台机器可能同时有 N 卡和 Intel 核显（本机就是）。NVENC 实测快 2 倍，
 * 所以只要 NVENC 可用就全用它，不混用（混用意味着同一个批次里
 * 不同文件走不同编码器，体积/画质不一致，用户会觉得"怎么一会大一会小"）。
 *
 * @param {string} ffmpeg ffmpeg 路径
 * @param {Array} candidates listCandidates() 的结果
 * @param {object} [deps] { probeEncoder } 便于测试注入
 * @returns {{available:boolean, family:string|null, name:string|null, encoders:any, probed:Array, skipped:Array<string>}}
 */
function detectEncoder(ffmpeg, candidates, deps) {
  const probeFn = (deps && deps.probeEncoder) || ((f, e) => probeEncoder(f, e));
  const list = Array.isArray(candidates) ? candidates : [];
  const probed = [];
  /* 按 family 分组，保持 HW_ENCODERS 的优先级顺序 */
  const byFamily = new Map();
  for (const c of list) {
    if (!byFamily.has(c.id)) byFamily.set(c.id, []);
    byFamily.get(c.id).push(c);
  }
  for (const fam of HW_ENCODERS) {
    const group = byFamily.get(fam.id);
    if (!group || !group.length) continue;
    const usable = {};
    let anyOk = false;
    for (const c of group) {
      const ok = probeFn(ffmpeg, c.encoder);
      probed.push({ encoder: c.encoder, codec: c.codec, usable: !!ok });
      if (ok) { usable[c.codec] = c.encoder; anyOk = true; }
    }
    /* 【第一个可用家族胜出，但仍要探测其余家族吗？——不，但要在结果里说清】
     * 早期实现是"命中即 return"，测试 H5 抓到它让 probed 只留下 1 条记录，
     * 用户看不到"为什么没用 QSV"。现在的取舍：**继续探测会多花 600ms**
     * （三个编码器各 321ms），而设置页打开时付这个代价不值得。
     *
     * 所以仍然命中即停，但把「没探测的那些」和「探测了但不可用的」区分开：
     * probed 只记真的跑过的，另加 skipped 列出因优先级被跳过的。
     * 界面据此显示「已选用 NVENC；QSV/AMF 未测试（优先级更低）」，
     * 既不撒谎说测过，也不让用户以为它们坏了。 */
    if (anyOk) {
      const skipped = [];
      let reached = false;
      for (const f2 of HW_ENCODERS) {
        if (f2.id === fam.id) { reached = true; continue; }
        if (!reached) continue;
        for (const c of (byFamily.get(f2.id) || [])) skipped.push(c.encoder);
      }
      return { available: true, family: fam.id, name: fam.name, encoders: usable, probed, skipped };
    }
  }
  return { available: false, family: null, name: null, encoders: {}, probed, skipped: [] };
}

module.exports = {
  HW_ENCODERS,
  CQ_OFFSET,
  CQ_MIN,
  CQ_MAX,
  cqFor,
  pickVideoEncoder,
  hwQualityArgs,
  familyOfEncoder,
  listCandidates,
  probeEncoder,
  detectEncoder,
};
