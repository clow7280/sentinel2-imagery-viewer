import type { Position } from 'geojson';
import type { Scene } from './types';

export interface DateGroup {
  date: string;
  /** 云量低的在前 */
  scenes: Scene[];
  /** 当日最晴一景的云量，百分比 */
  cloud: number;
  /** 当日对分幅的数据覆盖比例，0 到 1，取覆盖最多的一景 */
  coverage: number;
}

function inRing(x: number, y: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function sceneContains(s: Scene, lon: number, lat: number): boolean {
  const [w, so, e, n] = s.bbox;
  if (lon < w || lon > e || lat < so || lat > n) return false;
  const polys = s.geometry.type === 'Polygon' ? [s.geometry.coordinates] : s.geometry.coordinates;
  return polys.some((rings) => inRing(lon, lat, rings[0]) && !rings.slice(1).some((h) => inRing(lon, lat, h)));
}

/** 把同一分幅的景按日期分组，日期从新到旧 */
export function groupByDate(scenes: Scene[]): DateGroup[] {
  const map = new Map<string, Scene[]>();
  for (const s of scenes) {
    const list = map.get(s.date) ?? [];
    list.push(s);
    map.set(s.date, list);
  }
  return [...map]
    .map(([date, list]) => {
      list.sort((a, b) => a.cloud - b.cloud);
      return {
        date,
        scenes: list,
        cloud: list[0].cloud,
        coverage: Math.max(...list.map((s) => 1 - s.nodata / 100)),
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}
