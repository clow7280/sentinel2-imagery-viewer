import { addProtocol } from 'maplibre-gl';
import { sceneContains } from './composition';
import type { Scene } from './types';

export const PROTOCOL = 's2';
/** 单个瓦片最多参与合成的景数，与后端上限一致 */
const MAX_SCENES_PER_TILE = 24;
const TILE_SAMPLES = 6;

let stack: Scene[] = [];
let version = 0;
let inflight = 0;

/** 一批影像瓦片请求的统计，从空闲后的第一个请求开始累计 */
export interface TileStats {
  inflight: number;
  requested: number;
  done: number;
  /** 后端已渲染并缓存，直接返回 */
  hits: number;
  failed: number;
  /** 地图移动后被取消的请求 */
  canceled: number;
  bytes: number;
  /** 已完成请求的耗时总和，毫秒 */
  ms: number;
}
const stats: Omit<TileStats, 'inflight'> = { requested: 0, done: 0, hits: 0, failed: 0, canceled: 0, bytes: 0, ms: 0 };

/** 更新当前合成的景序列，返回带版本号的瓦片地址模板，替换后 MapLibre 会重新请求 */
export function setStack(scenes: Scene[]): string {
  stack = scenes;
  version++;
  return `${PROTOCOL}://${version}/{z}/{x}/{y}`;
}

function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (v: number) => (v / n) * 360 - 180;
  const lat = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/** 粗判足迹与瓦片是否相交：瓦片内采样点落入足迹，或足迹顶点落入瓦片 */
function touchesTile(s: Scene, b: [number, number, number, number]): boolean {
  const [w, so, e, n] = b;
  if (s.bbox[2] < w || s.bbox[0] > e || s.bbox[3] < so || s.bbox[1] > n) return false;
  for (let i = 0; i <= TILE_SAMPLES; i++) {
    for (let j = 0; j <= TILE_SAMPLES; j++) {
      if (sceneContains(s, w + ((e - w) * i) / TILE_SAMPLES, so + ((n - so) * j) / TILE_SAMPLES)) return true;
    }
  }
  const polys = s.geometry.type === 'Polygon' ? [s.geometry.coordinates] : s.geometry.coordinates;
  return polys.some((rings) => rings[0].some(([lx, ly]) => lx >= w && lx <= e && ly >= so && ly <= n));
}

/**
 * 影像瓦片由后端渲染为 WebP：前端只挑出与瓦片相交的景，按合成优先级把景编号交给后端。
 * 高分屏请求 512 像素的 @2x 瓦片；没有影像时后端返回 204，按透明瓦片处理。
 * sq=1 后端不读取，只让浏览器缓存与按方格裁切之前的同名瓦片区分
 */
export function registerProtocol(): void {
  addProtocol(PROTOCOL, async (params, abortController) => {
    const [, , , z, x, y] = params.url.split('/');
    const b = tileBounds(Number(z), Number(x), Number(y));
    const scenes = stack.filter((s) => touchesTile(s, b)).slice(0, MAX_SCENES_PER_TILE);
    if (!scenes.length) return { data: new ArrayBuffer(0) };

    const retina = devicePixelRatio >= 1.5 ? '@2x' : '';
    const ids = scenes.map((s) => s.id).join(',');
    if (inflight === 0) Object.assign(stats, { requested: 0, done: 0, hits: 0, failed: 0, canceled: 0, bytes: 0, ms: 0 });
    inflight++;
    stats.requested++;
    const t0 = performance.now();
    try {
      const resp = await fetch(`/api/s2/${z}/${x}/${y}${retina}.webp?ids=${ids}&sq=1`, { signal: abortController.signal });
      if (!resp.ok && resp.status !== 204) throw new Error(`影像瓦片渲染失败：HTTP ${resp.status}`);
      const data = resp.status === 204 ? new ArrayBuffer(0) : await resp.arrayBuffer();
      stats.done++;
      stats.bytes += data.byteLength;
      stats.ms += performance.now() - t0;
      if (resp.headers.get('x-cache') === 'HIT') stats.hits++;
      return { data };
    } catch (err) {
      if (abortController.signal.aborted) stats.canceled++;
      else stats.failed++;
      throw err;
    } finally {
      inflight--;
    }
  });
}

export function tileStats(): TileStats {
  return { ...stats, inflight };
}
