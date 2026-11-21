import React from 'react';
import {
  AbsoluteFill, Img, Sequence, interpolate, spring, staticFile,
  useCurrentFrame, Audio,
} from 'remotion';
import { PageCam, type CamKey } from './components/PageCam';
import { DigitRoll } from './components/DigitRoll';
import { T, PAGE_H } from './theme';
import { rect, rects } from './layout';

/* =================== 共用 =================== */

const Rain: React.FC<{ opacity?: number }> = ({ opacity = 0.5 }) => (
  <AbsoluteFill style={{
    backgroundImage:
      'linear-gradient(rgba(22,93,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(22,93,255,.05) 1px,transparent 1px)',
    backgroundSize: '64px 64px', opacity,
    maskImage: 'radial-gradient(ellipse at 45% 45%,#000 30%,transparent 80%)',
    WebkitMaskImage: 'radial-gradient(ellipse at 45% 45%,#000 30%,transparent 80%)',
  }} />
);

const fadeInOut = (f: number, a: number, b: number, c?: number, d?: number) => {
  const inT = interpolate(f, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (c == null || d == null) return inT;
  const outT = interpolate(f, [c, d], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return Math.min(inT, outT);
};

/* ============ 平滑运镜关键帧 ============
 * 【为什么不能只给 2–3 个关键帧】
 * PageCam 对**每一段**关键帧独立套 ease（默认 bezier 0.33,0,0.15,1）——
 * 于是每到一个关键帧速度都归零再重新加速，观感是「一顿一顿」，
 * 明明在推近却像被卡住。
 * 正确做法：把整条运动按 easeInOutSine 采样成 ~28 个密集关键帧，
 * 再让 PageCam 用**线性**插值（见 Stage 传 ease={linear}）。
 * 段间线性 + 采样点足够密 ⟹ 整条曲线连续、速度连续，肉眼是丝滑的。
 * 这也顺带解决了「缓动被重复施加两次」的问题。 */
type Pose = { cx: number; cy: number; zoom: number };
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

function smoothKeys(duration: number, from: Pose, to: Pose, steps = 28, ease = easeInOutSine): CamKey[] {
  const keys: CamKey[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const e = ease(t);
    keys.push({
      frame: Math.round(t * duration),
      cx: from.cx + (to.cx - from.cx) * e,
      cy: from.cy + (to.cy - from.cy) * e,
      zoom: from.zoom + (to.zoom - from.zoom) * e,
    });
  }
  return keys;
}

/* 线性插值：配合密集关键帧使用，避免二次缓动 */
const LINEAR = (t: number) => t;

/** 应用窗口卡片：内部仍是 1920×1080 的 PageCam，整体缩放到卡宽。 */
const Stage: React.FC<{
  src: string;
  keys: CamKey[];
  x: number; y: number; w: number;
  rotate?: number;
  children?: React.ReactNode;
  dof?: { focusY: number; strength: number };
  ease?: (t: number) => number;
}> = ({ src, keys, x, y, w, rotate = 0, children, dof, ease = LINEAR }) => {
  const h = (w * 9) / 16;
  const scale = w / 1920;
  return (
    <div style={{
      position: 'absolute', left: x, top: y, width: w, height: h,
      borderRadius: 18, overflow: 'hidden', border: `1px solid ${T.line}`,
      boxShadow: '0 34px 90px rgba(29,33,41,.18), 0 4px 14px rgba(29,33,41,.06)',
      background: '#fff', transform: `rotate(${rotate}deg)`,
    }}>
      <div style={{ width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
        <PageCam src={src} pageH={PAGE_H} keys={keys} dof={dof} bg={T.bg} ease={ease}>{children}</PageCam>
      </div>
    </div>
  );
};

const Chip: React.FC<{ children: React.ReactNode; accent?: boolean }> = ({ children, accent }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 9, padding: '11px 18px',
    borderRadius: 999, background: accent ? T.primary : T.card,
    color: accent ? '#fff' : T.t2, border: `1px solid ${accent ? T.primary : T.line}`,
    fontSize: 19, fontWeight: accent ? 600 : 500, boxShadow: '0 6px 18px rgba(29,33,41,.06)',
    fontFamily: T.font, whiteSpace: 'nowrap',
  }}>
    <span style={{ width: 8, height: 8, borderRadius: 4, background: accent ? '#fff' : T.primary }} />
    {children}
  </span>
);

/* =================== 1. 开场 =================== */
/* 【整窗必须完整可见】
 * 上一版 zoom 到 1.16 + rotY 透视，卡片的左右边缘被裁掉 —— 观众第一眼
 * 看到的「软件界面」是残缺的。开场这一段的任务是"让人看清这是什么"，
 * 所以 zoom 锁死 1.0（1.0 = 整屏页面刚好装进 1920×1080），只做轻微
 * 平移（cx/cy 漂移 25/16px）保留呼吸感，且**不加透视**（透视会切角）。 */
const Opening: React.FC = () => {
  const f = useCurrentFrame();
  /* 【整窗完整可见 + 尽量大】
   * 卡片宽 1000 → 高 562.5（16:9），从 (860,120) 放到 (1860,682.5)：
   * 右边界 1860 < 1920、下边界 682.5 < 1080，且 zoom 恒为 1.0 ——
   * 整窗内容全部落在卡片内（PageCam 只缩放页面，卡片外框由 Stage 固定，
   * 1.0 时页面刚好铺满，不会切掉窗口边框）。
   * 之前用 860 宽是怕挤压左侧标题，实测 1000 宽 + 800 宽的标题栏仍有余量。 */
  const keys = smoothKeys(126, { cx: 960, cy: 540, zoom: 1.0 }, { cx: 985, cy: 556, zoom: 1.0 }, 30);
  const card = rect('home', '.home-cat', 4);
  /* 【首帧必须有标题】原本 6–22 帧淡入，第 0 帧是空屏 —— 视频第一印象很重要。
   * 注意 interpolate(0, [0,12], [0,1]) 在第 0 帧返回 0（区间左端就是起点值），
   * 所以淡入区间要写成 [−1, 8]，让第 0 帧已经落在 0.125 以上。 */
  const titleT = fadeInOut(f, -1, 8, 100, 124);
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <Rain opacity={0.4} />
      <div style={{ position: 'absolute', left: 96, top: 190, width: 800, opacity: titleT, fontFamily: T.font, transform: `translateY(${interpolate(f, [6, 28], [16, 0], { extrapolateRight: 'clamp' })}px)` }}>
        <div style={{ fontSize: 19, letterSpacing: 9, color: T.t3 }}>HEHE TOOLBOX</div>
        <div style={{ fontSize: 86, fontWeight: 800, lineHeight: 1.16, marginTop: 20 }}>
          Windows 上的<br /><span style={{ color: T.primary }}>一站式效率工具箱</span>
        </div>
        <div style={{ fontSize: 28, color: T.t2, marginTop: 26 }}>111 个工具 · 全部本地运行 · 不联网也能用</div>
        <div style={{ display: 'flex', gap: 12, marginTop: 40, flexWrap: 'wrap' }}>
          <Chip>系统与硬件</Chip><Chip>文件处理</Chip><Chip>多媒体</Chip><Chip>开发调试</Chip>
        </div>
      </div>
      {/* 卡片 1000×562.5 放在 (860,120)：右侧与底部都留出边距，且足够大能看清界面 */}
      <Stage src="textures/home.png" keys={keys} x={860} y={120} w={1000} rotate={0}>
        {card ? (
          <div style={{
            position: 'absolute', left: card.x - 10, top: card.y - 10, width: card.w + 20, height: card.h + 20,
            borderRadius: 18, border: `3px solid ${T.primary}`,
            boxShadow: `0 0 0 8px ${T.primarySoft}, 0 24px 60px rgba(22,93,255,.18)`,
            opacity: fadeInOut(f, 22, 40),
          }} />
        ) : null}
      </Stage>
    </AbsoluteFill>
  );
};

/* =================== 2. 搜索 =================== */
const Search: React.FC = () => {
  const f = useCurrentFrame();
  const box = rect('home', '.hs-input', 0);
  /* 【取景必须从 rect 反推，不能凭感觉给 zoom】
   * 搜索框在页面空间宽约 1557px（1169 CSS × 1.332）。zoom 1.55 时
   * 只装得下 1920/1.55=1239px，框的两侧直接被切掉 —— 实测静帧就是
   * 左边文字被截断。正确做法：先定「框中心落在屏幕 (960, 380)」，
   * 再由 zoom 反解 cx/cy：
   *   tx = 380 - boxCenterY*zoom 且 tx = 540 - cy*zoom  ⟹ cy = (540 - tx)/zoom
   * zoom 取 1.05 时框宽 1635px < 1920，两侧各留 142px 余量。 */
  const ZOOM = 1.05;
  const boxCx = box ? box.x + box.w / 2 : 1108;
  const boxCy = box ? box.y + box.h / 2 : 217;
  const screenY = 380;
  const ty = screenY - boxCy * ZOOM;
  const cy = (540 - ty) / ZOOM;
  const keys = [
    ...smoothKeys(44, { cx: boxCx, cy: cy + 30, zoom: 1.0 }, { cx: boxCx, cy, zoom: ZOOM }, 16),
    { frame: 60, cx: boxCx, cy, zoom: ZOOM },
  ];
  const shown = '压缩'.slice(0, Math.max(0, Math.min(2, Math.floor((f - 8) / 7))));
  const rows = [['压缩解压（ZIP）', '文件处理'], ['图片压缩 · 目标体积', '多媒体处理'], ['视频压制 · 瘦身预设', '多媒体处理']];
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <Rain opacity={0.3} />
      <Stage src="textures/home.png" keys={keys} x={210} y={120} w={1500}>
        {box ? (
          <>
            {/* 高亮框：把真实搜索框圈出来，而不是在框内叠字（会和原占位文字重影） */}
            <div style={{
              position: 'absolute', left: box.x - 6, top: box.y - 6, width: box.w + 12, height: box.h + 12,
              borderRadius: 14, border: `3px solid ${T.primary}`,
              boxShadow: `0 0 0 8px ${T.primarySoft}`,
              opacity: interpolate(f, [4, 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            }} />
            {/* 键入的字符：贴在搜索框右侧空白处，跟随输入进度 */}
            <div style={{
              position: 'absolute', left: box.x + box.w - 240, top: box.y + box.h / 2 - 16,
              fontSize: 26, fontWeight: 600, color: T.primary, fontFamily: T.font,
              opacity: f > 6 ? 1 : 0,
            }}>{shown}<span style={{ opacity: (f % 16) < 8 ? 1 : 0 }}>|</span></div>
            <div style={{
              position: 'absolute', left: box.x, top: box.y + box.h + 8, width: box.w,
              background: T.card, borderRadius: 12, border: `1px solid ${T.line}`,
              boxShadow: '0 18px 44px rgba(29,33,41,.12)', overflow: 'hidden',
              opacity: interpolate(f, [20, 32], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
              transform: `translateY(${interpolate(f, [20, 34], [-6, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}px)`,
            }}>
              {rows.map(([name, mod], i) => (
                <div key={name} style={{
                  display: 'flex', justifyContent: 'space-between', padding: '15px 20px',
                  borderTop: i ? `1px solid ${T.line}` : 'none', fontFamily: T.font,
                  fontSize: 22, color: T.t1,
                  opacity: interpolate(f, [28 + i * 5, 38 + i * 5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
                }}>
                  <span>{name}</span><span style={{ fontSize: 17, color: T.t3 }}>{mod}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </Stage>
    </AbsoluteFill>
  );
};

/* =================== 3. 日常三连 =================== */
/* 【为什么改成「整屏交叉切」而不是三张小卡并排】
 * 三卡并排时每张只有 520px 宽（= 纹理宽度的 36%），界面文字全部糊成灰块，
 * 静帧实测完全看不出是哪三个工具 —— 而这一段的任务恰恰是「一眼认出日常工具」。
 * 改成每 25 帧满屏一张、交叉淡入，配左对齐工具名，画面撑满、文字可读。 */
const Daily: React.FC = () => {
  const f = useCurrentFrame();
  const cuts = [0, 25, 50];
  const items: Array<[string, string, string]> = [
    ['textures/zip.png', '压缩文件', '拖进来，选个路径'],
    ['textures/img-batch.png', '图片格式转换', '批量转，保质量'],
    ['textures/pomodoro.png', '番茄钟', '专注 25 分钟'],
  ];
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <Rain opacity={0.35} />
      {items.map(([src, name, sub], i) => {
        const local = f - cuts[i];
        if (local < -8 || local > 33) return null;
        /* 交叉淡入：上一张在 -8..0 退出，这一张在 -4..6 进入 */
        const op = Math.min(
          interpolate(local, [-6, 3], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
          i === items.length - 1 ? 1 : interpolate(local, [24, 32], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        );
        const push = interpolate(local, [-6, 28], [1.04, 1.0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <AbsoluteFill key={name} style={{ opacity: op }}>
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              transform: `scale(${push})`,
            }}>
              <div style={{
                width: 1340, borderRadius: 20, overflow: 'hidden', border: `1px solid ${T.line}`,
                boxShadow: '0 40px 100px rgba(29,33,41,.16)', background: '#fff',
              }}>
                <Img src={staticFile(src)} style={{ width: '100%', display: 'block' }} />
              </div>
            </div>
            <div style={{
              position: 'absolute', left: 120, top: 168, fontFamily: T.font,
              opacity: interpolate(local, [-2, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            }}>
              <div style={{ fontSize: 54, fontWeight: 800, color: T.t1, lineHeight: 1.1 }}>{name}</div>
              <div style={{ fontSize: 26, color: T.t2, marginTop: 8 }}>{sub}</div>
            </div>
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};

/* =================== 4. 磁盘 =================== */
const Disk: React.FC = () => {
  const keys = smoothKeys(81, { cx: 940, cy: 400, zoom: 1.06 }, { cx: 960, cy: 620, zoom: 1.2 }, 22);
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <Rain opacity={0.28} />
      <Stage src="textures/disk.png" keys={keys} x={190} y={110} w={1540} dof={{ focusY: 220, strength: 2 }} />
    </AbsoluteFill>
  );
};

/* =================== 5. 重命名 =================== */
const Rename: React.FC = () => {
  const f = useCurrentFrame();
  const keys = smoothKeys(84, { cx: 960, cy: 520, zoom: 1.04 }, { cx: 960, cy: 668, zoom: 1.16 }, 22);
  const cards = rects('batch-preview', '.card');
  const pulse = interpolate(f, [24, 32, 40, 58], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <Rain opacity={0.28} />
      <Stage src="textures/batch-preview.png" keys={keys} x={190} y={110} w={1540}>
        {cards[2] ? (
          <div style={{
            position: 'absolute', left: cards[2].x + 12, top: cards[2].y + 8,
            width: cards[2].w - 24, height: cards[2].h - 16, borderRadius: 12,
            border: `3px solid ${T.primary}`, opacity: pulse * 0.85, boxShadow: `0 0 0 8px ${T.primarySoft}`,
          }} />
        ) : null}
      </Stage>
    </AbsoluteFill>
  );
};

/* =================== 6. 垃圾清理 =================== */
/* 【高亮框坐标必须来自真实 DOM 测量】
 * 之前硬编码 `top: 296 + i*78`，是照截图目测出来的，结果每行都错位
 * （第一框套在按钮行上，后两个压住文字）。现在从 layout.json 读
 * `.junk-row`（采集时用 ROWS_JS 量出的、含 checkbox 的 .form-row 真实 rect）。 */
const Junk: React.FC = () => {
  const f = useCurrentFrame();
  const keys = smoothKeys(78, { cx: 920, cy: 360, zoom: 1.0 }, { cx: 940, cy: 430, zoom: 1.1 }, 22);
  const rows = rects('junk', '.junk-row');
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <Rain opacity={0.28} />
      <Stage src="textures/junk.png" keys={keys} x={190} y={110} w={1540}>
        {rows.map((r, i) => {
          const t = interpolate(f, [14 + i * 8, 26 + i * 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          return (
            <div key={i} style={{
              position: 'absolute', left: r.x - 8, top: r.y - 6, width: r.w + 16, height: r.h + 12,
              borderRadius: 10, border: `2.5px solid ${T.primary}`,
              background: `rgba(22,93,255,${0.05 * t})`,
              boxShadow: t ? '0 0 0 6px rgba(22,93,255,.09)' : 'none',
              opacity: t,
            }} />
          );
        })}
      </Stage>
    </AbsoluteFill>
  );
};

/* =================== 7. 还原点 =================== */
/* 【这一段不放行级高亮框】
 * 采集机上没有还原点数据，表格是空态（「没有可显示的还原点」），
 * 量出 0 行 —— 硬套框只会压住按钮与文字（上一版就是这么错的）。
 * 只做相机推近，让「创建 / 启用保护 / 删除最旧」这排真实按钮自己说话。 */
const Restore: React.FC = () => {
  const keys = smoothKeys(75, { cx: 920, cy: 350, zoom: 1.0 }, { cx: 940, cy: 405, zoom: 1.1 }, 22);
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <Rain opacity={0.28} />
      <Stage src="textures/restore.png" keys={keys} x={190} y={110} w={1540} />
    </AbsoluteFill>
  );
};

/* =================== 8. 门禁 =================== */
const Danger: React.FC = () => {
  const f = useCurrentFrame();
  const keys = smoothKeys(72, { cx: 930, cy: 400, zoom: 1.0 }, { cx: 930, cy: 440, zoom: 1.09 }, 22);
  const cards = rects('locked', '.card');
  const box = cards[0];
  const sweep = interpolate(f, [8, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const shake = f > 30 && f < 42 ? Math.sin(f * 3.4) * (42 - f) * 0.6 : 0;
  return (
    <AbsoluteFill style={{ background: T.bg, transform: `translateX(${shake}px)` }}>
      <Rain opacity={0.25} />
      <Stage src="textures/locked.png" keys={keys} x={190} y={110} w={1540}>
        {box ? (
          <div style={{
            position: 'absolute', left: box.x - 8, top: box.y - 8, width: box.w + 16, height: box.h + 16,
            border: `4px solid ${T.danger}`, borderRadius: 12, boxShadow: '0 0 0 10px rgba(245,63,63,.10)',
            opacity: fadeInOut(f, 6, 18, 260, 300),
          }}>
            {['tl', 'tr', 'bl', 'br'].map((k) => (
              <div key={k} style={{
                position: 'absolute', width: 24, height: 24, border: `4px solid ${T.danger}`,
                left: k[1] === 'l' ? -9 : undefined, right: k[1] === 'r' ? -9 : undefined,
                top: k[0] === 't' ? -9 : undefined, bottom: k[0] === 'b' ? -9 : undefined,
                borderRight: k[1] === 'l' ? 'none' : undefined, borderLeft: k[1] === 'r' ? 'none' : undefined,
                borderBottom: k[0] === 't' ? 'none' : undefined, borderTop: k[0] === 'b' ? 'none' : undefined,
              }} />
            ))}
            <div style={{
              position: 'absolute', left: 0, right: 0, top: `${sweep * 100}%`, height: 3,
              background: `linear-gradient(90deg,transparent,${T.danger},transparent)`, opacity: f < 34 ? 1 : 0,
            }} />
          </div>
        ) : null}
      </Stage>
    </AbsoluteFill>
  );
};

/* =================== 9. 设置开关 =================== */
const Settings: React.FC = () => {
  const f = useCurrentFrame();
  const keys = smoothKeys(75, { cx: 960, cy: 390, zoom: 1.0 }, { cx: 985, cy: 440, zoom: 1.1 }, 22);
  const sws = rects('danger-settings', '.switch');
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <Rain opacity={0.28} />
      <Stage src="textures/danger-settings.png" keys={keys} x={190} y={110} w={1540}>
        {sws.slice(0, 3).map((r, i) => {
          const t = interpolate(f, [18 + i * 12, 30 + i * 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          return (
            <div key={i} style={{
              position: 'absolute', left: r.x - 6, top: r.y - 6, width: r.w + 12, height: r.h + 12,
              borderRadius: (r.h + 12) / 2, background: `rgba(22,93,255,${0.10 + t * 0.10})`,
              boxShadow: t ? `0 0 0 ${Math.round(6 * t)}px rgba(22,93,255,.14)` : 'none',
              opacity: t,
            }} />
          );
        })}
      </Stage>
    </AbsoluteFill>
  );
};

/* =================== 10. 收尾 =================== */
const Outro: React.FC = () => {
  const f = useCurrentFrame();
  const titleT = interpolate(f, [54, 78], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const tagT = interpolate(f, [78, 96], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const chipsT = interpolate(f, [96, 112], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <Rain opacity={0.5} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: T.font }}>
        <div style={{ color: T.primary, fontWeight: 800, fontSize: 186, lineHeight: 1, display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <DigitRoll value="111" delay={4} fontSize={186} color={T.primary} />
          <span style={{ fontSize: 44, color: T.t2, fontWeight: 600 }}>个工具</span>
        </div>
        <div style={{ fontSize: 90, fontWeight: 800, marginTop: 24, color: T.t1, opacity: titleT, transform: `translateY(${(1 - titleT) * 10}px)` }}>核核工具箱</div>
        <div style={{ fontSize: 29, color: T.t2, marginTop: 14, letterSpacing: 2, opacity: tagT }}>
          Windows 上的一站式效率工具箱
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 48, opacity: chipsT }}>
          <Chip>本地运行</Chip><Chip>不上传</Chip><Chip>高危默认关闭</Chip><Chip>中英双语</Chip>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* =================== 声音 =================== */
type Cue = [number, string, number, number?];
const SFX: Cue[] = [
  [4, 'whoosh-big', 0.42],
  [28, 'impact-cine', 0.30],
  [58, 'sparkle', 0.22],
  [128, 'keyboard', 0.30, 44],
  [150, 'pop', 0.34],
  [188, 'swoosh-quick', 0.30],
  [212, 'pop', 0.30],
  [238, 'pop', 0.30],
  [262, 'whoosh-fast', 0.30],
  [300, 'pop', 0.22],
  [344, 'click-camera', 0.42],
  [368, 'pop', 0.30],
  [428, 'transition-soft', 0.34],
  [452, 'pop', 0.26],
  [506, 'swoosh-quick', 0.28],
  [580, 'whoosh-fast', 0.26],
  [610, 'impact-cine', 0.40],
  [653, 'click-camera', 0.30],
  [665, 'click-camera', 0.30],
  [728, 'riser-cine', 0.34, 44],
  [778, 'impact-cine', 0.38],
  [800, 'sparkle', 0.26],
];

/* 【音轨实际由 scripts/mix-audio.js 外部混】
 * 本机 Remotion 4.0.484 在 Windows 上预处理音轨报 Permission denied
 * （remotion-audio-mixing\0.wav 父目录不存在），所以渲染一律 --muted，
 * 这里的 <Audio> 只作为时间线声明存在。外部混音脚本从下面这张 SFX 表
 * 读帧位/音量/时长（含「无 dur 默认截 90 帧」规则），两边必须同规则。
 * 曾试过不用 Sequence 包 Audio（注释里写过 trimAfter/startFrom 方案），
 * 实测 staticFile 在 Sequence layout="none" 组合下报 404，最终回到
 * Sequence + --muted + 外部混音这条稳定链路。 */
const SfxTrack: React.FC = () => (
  <>
    {SFX.map(([from, name, volume, dur], i) => (
      <Sequence key={i} from={from} durationInFrames={dur || 90}>
        <Audio src={staticFile('audio/sfx/' + name + '.mp3')} volume={volume} />
      </Sequence>
    ))}
  </>
);

/* =================== 字幕 =================== */
const CAPTIONS: Array<[number, number, string]> = [
  [24, 118, '一个应用，装下 10 个模块'],
  [126, 182, '一句话找到你要的工具'],
  [186, 258, '日常小活，顺手就办了'],
  [261, 338, '谁占了空间，一眼看清'],
  [342, 422, '先预览，再动手'],
  [426, 500, '该清的清掉，勾选再执行'],
  [504, 575, '系统还原点，创建 / 删除都在这'],
  [579, 648, '高危功能默认关闭，逐项开启'],
  [651, 722, '你说了算，才打开'],
  [726, 830, '111 个工具 · 全部本地'],
];

const Captions: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <>
      {CAPTIONS.map(([a, b, text], i) => {
        const o = interpolate(f, [a, a + 8, b - 8, b], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        if (o <= 0) return null;
        /* 【位置随段落变】日常三连段（186–261）左下角有工具名大字，
         * 字幕放同处会打架；那一段把字幕挪到右下。其余段落左下即可。 */
        const inDaily = a >= 186 && b <= 261;
        return (
          <div key={i} style={{
            position: 'absolute', bottom: 58, ...(inDaily ? { right: 120 } : { left: 120 }),
            padding: '12px 22px', borderRadius: 10, background: 'rgba(255,255,255,.86)',
            border: `1px solid ${T.line}`, fontFamily: T.font, fontSize: 28, color: T.t2,
            letterSpacing: 1, opacity: o, backdropFilter: 'blur(6px)',
          }}>{text}</div>
        );
      })}
    </>
  );
};

/* =================== 时间线 =================== */
export const TOTAL = 900;

const SEGMENTS: Array<[number, number, React.FC]> = [
  [0, 126, Opening],
  [126, 186, Search],
  [186, 261, Daily],
  [261, 342, Disk],
  [342, 426, Rename],
  [426, 504, Junk],
  [504, 579, Restore],
  [579, 651, Danger],
  [651, 726, Settings],
  [726, TOTAL, Outro],
];

export const HehePromo: React.FC<{ bgm?: boolean }> = ({ bgm = true }) => {
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      {SEGMENTS.map(([from, to, C], i) => (
        <Sequence key={i} from={from} durationInFrames={to - from}>
          <C />
        </Sequence>
      ))}
      <Captions />
      <SfxTrack />
      {bgm ? <Audio src={staticFile('audio/bgm.mp3')} volume={0.55} /> : null}
    </AbsoluteFill>
  );
};