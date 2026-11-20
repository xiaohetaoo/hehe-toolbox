import layout from '../public/textures/layout.json';

export type Rect = { x: number; y: number; w: number; h: number };
export type PageLayout = { w: number; h: number; rects: Record<string, Rect[]> };
export const L = layout as unknown as Record<string, PageLayout>;

/* layout 里是采集视口（1441 宽）的 CSS px；转成 PageCam 的 1920 页面空间。 */
export const S = 1920 / 1441;
export const PAGE_H = 810 * S;

export function rect(page: string, sel: string, i = 0): Rect | null {
  const p = L[page];
  if (!p) return null;
  const arr = p.rects[sel];
  if (!arr || !arr[i]) return null;
  const r = arr[i];
  return { x: r.x * S, y: r.y * S, w: r.w * S, h: r.h * S };
}
export function rects(page: string, sel: string): Rect[] {
  const p = L[page];
  const arr = (p && p.rects[sel]) || [];
  return arr.map((r) => ({ x: r.x * S, y: r.y * S, w: r.w * S, h: r.h * S }));
}