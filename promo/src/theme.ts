export const T = {
  bg: '#F2F3F5',
  card: '#FFFFFF',
  primary: '#165DFF',
  primarySoft: '#E8F3FF',
  t1: '#1D2129',
  t2: '#4E5969',
  t3: '#86909C',
  line: '#E5E6EB',
  danger: '#F53F3F',
  font: '"Segoe UI","Microsoft YaHei UI","PingFang SC",sans-serif',
};

/* BGM：124 BPM，首拍 0.474s，拍间隔 0.484s。帧号一律走 beatF。 */
export const FPS = 30;
export const BPM = 124;
export const BEAT_FRAMES = (60 / BPM) * FPS; // 14.516
export const PHASE_FRAMES = 0.474 * FPS;     // 14.22
export const beatF = (n: number) => Math.round(PHASE_FRAMES + n * BEAT_FRAMES);
export const secF = (s: number) => Math.round(s * FPS);

/* 纹理采集时的 CSS 视口宽（layout.json 坐标系），PageCam 页面空间宽 1920。 */
export const TEX_W = 1441;
export const TEX_H = 810;
export const S = 1920 / TEX_W;          // 1.3324
export const PAGE_H = TEX_H * S;        // 1079.2