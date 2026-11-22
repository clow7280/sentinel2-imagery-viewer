import { forward, toPoint } from 'mgrs';
import type { Position } from 'geojson';
import type { BBox, Scene } from './types';

/**
 * 区域即 Sentinel-2 的 MGRS 100 km 分幅。影像分幅比方格向东、向南各多出 9.8 km，
 * 后端合成时每景只填自己的方格，影像接缝与这里画出的方格边界一致
 */

/** 缺测与该分幅最少缺测相差不超过该值的景视为覆盖最好，百分点 */
const COVER_TOL = 5;
/** 缺测不超过该比例时不再补齐，百分比 */
const NO_GAP = 0.5;
/** 云量相差不超过该值时取更新的景，百分点 */
const CLOUD_TIE = 2;
/** 枚举视野内分幅时的采样间距，单位度，远小于方格边长 */
const SAMPLE_STEP = 0.2;

/** 去掉带号前补的零，与 mgrs 的写法一致 */
export const normTile = (code: string) => code.replace(/^0/, '');

/** 某点所在的分幅，极区不在 MGRS 覆盖范围内时返回 undefined */
export function tileAt(lon: number, lat: number): string | undefined {
  try {
    return forward([lon, lat], 0);
  } catch {
    return undefined;
  }
}

const polygons = new Map<string, Position[]>();

/** 分幅方格的外环，四角由 MGRS 坐标换算 */
export function tileRing(tile: string): Position[] {
  let ring = polygons.get(tile);
  if (!ring) {
    const corner = (e: string, n: string) => toPoint(`${tile}${e}${n}`) as Position;
    const sw = corner('00000', '00000');
    ring = [sw, corner('99999', '00000'), corner('99999', '99999'), corner('00000', '99999'), sw];
    polygons.set(tile, ring);
  }
  return ring;
}

export function tileBBox(tile: string): BBox {
  const ring = tileRing(tile);
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 与检索范围相交的分幅，海上的方格没有影像，检索时自然没有结果 */
export function tilesInBBox([w, s, e, n]: BBox): string[] {
  const out = new Set<string>();
  for (let x = w; x <= e + 1e-9; x += SAMPLE_STEP) {
    for (let y = s; y <= n + 1e-9; y += SAMPLE_STEP) {
      const t = tileAt(Math.min(x, e), Math.min(y, n));
      if (t) out.add(t);
    }
  }
  return [...out];
}

const newer = (a: Scene, b: Scene) => (a.datetime > b.datetime ? a : b);

/**
 * 为一个分幅挑选影像，返回按合成优先级排列的景：
 * 先看覆盖，只在缺测接近该分幅最少缺测的景中挑；再取其中云量最低的，云量相差不超过 CLOUD_TIE 时取更新的。
 * 扫描带边缘的分幅每条轨道只覆盖一部分，首选景有缺测时由 fillGaps 从其他轨道补齐
 */
export function pickTile(scenes: Scene[]): Scene[] {
  if (!scenes.length) return [];
  const minNodata = Math.min(...scenes.map((s) => s.nodata));
  const pool = scenes.filter((s) => s.nodata <= minNodata + COVER_TOL);
  const minCloud = Math.min(...pool.map((s) => s.cloud));
  const best = pool.filter((s) => s.cloud <= minCloud + CLOUD_TIE).reduce(newer);
  return [best, ...fillGaps([best], scenes)];
}

/**
 * 补齐缺测的景：同一相对轨道的缺测位置相同，补不上，
 * 因此从其他每条轨道各取云量最低的一景，按云量从低到高排在首选景之下
 */
export function fillGaps(primary: Scene[], scenes: Scene[]): Scene[] {
  if (!primary.length || Math.min(...primary.map((s) => s.nodata)) <= NO_GAP) return [];
  const used = new Set(primary.map((s) => s.orbit));
  const byOrbit = new Map<number, Scene>();
  for (const s of scenes) {
    if (used.has(s.orbit)) continue;
    const prev = byOrbit.get(s.orbit);
    if (!prev || s.cloud < prev.cloud) byOrbit.set(s.orbit, s);
  }
  return [...byOrbit.values()].sort((a, b) => a.cloud - b.cloud);
}
