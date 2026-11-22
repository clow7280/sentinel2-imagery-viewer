import { addProtocol } from 'maplibre-gl';
import { sceneContains } from './composition';
import type { Scene } from './types';

export const PROTOCOL = 's2';
/** 后端单次请求最多参与合成的景数，与后端上限一致 */
const MAX_SCENES_PER_REQUEST = 24;
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
 * 景数超过 MAX_SCENES_PER_REQUEST 时把瓦片内的景拆成多次请求，否则原样作为一次请求。
 * 同一分幅的首选景与补缺测景必须在同一请求内，后端才能按优先级合成；
 * 不同分幅各填自己的方格，可以分开渲染再拼合。单个分幅的景数超过上限时截掉排在后面的补缺测景。
 * 分组只取决于分幅名：先按 MGRS 网格带（分幅名去掉末两位，如 36S）分块，块内按分幅名排序后装箱，
 * 某个分幅的景有变化时只影响所在网格带的请求，其余请求的地址不变，仍可命中缓存。
 * 每组内的景保持传入时的先后，即各分幅的首选景在前、补缺测景在后
 */
function packByRegion(scenes: Scene[]): Scene[][] {
  if (scenes.length <= MAX_SCENES_PER_REQUEST) return [scenes];
  const regions = new Map<string, Scene[]>();
  for (const s of scenes) {
    const list = regions.get(s.tile) ?? [];
    list.push(s);
    regions.set(s.tile, list);
  }
  const batches: Scene[][] = [];
  let cur: Scene[] = [];
  let zone = '';
  for (const name of [...regions.keys()].sort()) {
    const group = regions.get(name)!.slice(0, MAX_SCENES_PER_REQUEST);
    const z = name.slice(0, -2);
    if (cur.length && (z !== zone || cur.length + group.length > MAX_SCENES_PER_REQUEST)) {
      batches.push(cur);
      cur = [];
    }
    zone = z;
    cur.push(...group);
  }
  if (cur.length) batches.push(cur);
  const order = new Map(scenes.map((s, i) => [s, i]));
  return batches.map((batch) => batch.sort((a, b) => order.get(a)! - order.get(b)!));
}

/** 请求一组景合成的瓦片，没有影像时返回 undefined */
async function fetchPart(path: string, scenes: Scene[], signal: AbortSignal) {
  const ids = scenes.map((s) => s.id).join(',');
  const resp = await fetch(`${path}?ids=${ids}&sq=1`, { signal });
  if (!resp.ok && resp.status !== 204) throw new Error(`影像瓦片渲染失败：HTTP ${resp.status}`);
  const data = resp.status === 204 ? undefined : await resp.arrayBuffer();
  return { data, hit: resp.headers.get('x-cache') === 'HIT' };
}

/**
 * 影像瓦片由后端渲染为 WebP：前端只挑出与瓦片相交的景，按合成优先级把景编号交给后端。
 * 高分屏请求 512 像素的 @2x 瓦片；没有影像时后端返回 204，按透明瓦片处理。
 * 缩小后一个瓦片可能覆盖几十个分幅，超出后端单次景数上限时按分幅拆成多次请求，在浏览器中拼合。
 * sq=1 后端不读取，只让浏览器缓存与按方格裁切之前的同名瓦片区分
 */
export function registerProtocol(): void {
  addProtocol(PROTOCOL, async (params, abortController) => {
    const [, , , z, x, y] = params.url.split('/');
    const b = tileBounds(Number(z), Number(x), Number(y));
    const scenes = stack.filter((s) => touchesTile(s, b));
    if (!scenes.length) return { data: new ArrayBuffer(0) };

    const retina = devicePixelRatio >= 1.5 ? '@2x' : '';
    const path = `/api/s2/${z}/${x}/${y}${retina}.webp`;
    if (inflight === 0) Object.assign(stats, { requested: 0, done: 0, hits: 0, failed: 0, canceled: 0, bytes: 0, ms: 0 });
    inflight++;
    stats.requested++;
    const t0 = performance.now();
    try {
      const { signal } = abortController;
      const results = await Promise.allSettled(packByRegion(scenes).map((batch) => fetchPart(path, batch, signal)));
      abortController.signal.throwIfAborted();
      const parts = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
      // 部分请求失败时仍显示其余分幅，全部失败才算瓦片失败
      if (!parts.length) throw errors[0];
      if (errors.length) console.warn(`影像瓦片 ${z}/${x}/${y} 有 ${errors.length} 组请求失败，只显示其余部分`, errors[0]);
      const images = parts.flatMap((p) => (p.data ? [p.data] : []));
      const data = images.length > 1 ? await mergeImages(images) : (images[0] ?? new ArrayBuffer(0));
      stats.done++;
      stats.bytes += parts.reduce((n, p) => n + (p.data?.byteLength ?? 0), 0);
      stats.ms += performance.now() - t0;
      if (!errors.length && parts.every((p) => p.hit)) stats.hits++;
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

/**
 * 把各组渲染结果叠成一张瓦片。各组只覆盖自己的分幅方格，仅在 UTM 带交界处可能重叠；
 * 从最后一组画起，排在前面的组后画、覆盖在上，重叠处的取舍只取决于分组先后，结果固定
 */
async function mergeImages(images: ArrayBuffer[]): Promise<ImageBitmap> {
  const decoded = await Promise.allSettled(images.map((d) => createImageBitmap(new Blob([d], { type: 'image/webp' }))));
  const bitmaps = decoded.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  try {
    const bad = decoded.find((r) => r.status === 'rejected');
    if (bad) throw bad.reason;
    const canvas = new OffscreenCanvas(bitmaps[0].width, bitmaps[0].height);
    const ctx = canvas.getContext('2d')!;
    for (const bm of bitmaps.toReversed()) ctx.drawImage(bm, 0, 0);
    return canvas.transferToImageBitmap();
  } finally {
    for (const bm of bitmaps) bm.close();
  }
}

export function tileStats(): TileStats {
  return { ...stats, inflight };
}
