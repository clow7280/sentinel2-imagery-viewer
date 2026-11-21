import type { Position } from 'geojson';
import type { BBox, Scene } from './types';

export interface DateGroup {
  date: string;
  scenes: Scene[];
  /** 按覆盖面积加权的平均云量，百分比 */
  cloud: number;
  /** 该日足迹对检索范围的覆盖比例，0 到 1 */
  coverage: number;
}

const SAMPLE_N = 32;

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

/** 在检索范围内取规则采样点，用点落入足迹的比例近似覆盖率 */
function samplePoints(bbox: BBox): [number, number][] {
  const [w, s, e, n] = bbox;
  const pts: [number, number][] = [];
  for (let i = 0; i < SAMPLE_N; i++) {
    for (let j = 0; j < SAMPLE_N; j++) {
      pts.push([w + ((i + 0.5) / SAMPLE_N) * (e - w), s + ((j + 0.5) / SAMPLE_N) * (n - s)]);
    }
  }
  return pts;
}

export function groupByDate(scenes: Scene[], bbox: BBox): DateGroup[] {
  const pts = samplePoints(bbox);
  const map = new Map<string, Scene[]>();
  for (const s of scenes) {
    const list = map.get(s.date) ?? [];
    list.push(s);
    map.set(s.date, list);
  }
  const groups: DateGroup[] = [];
  for (const [date, list] of map) {
    list.sort((a, b) => a.cloud - b.cloud);
    let hit = 0;
    let cloudSum = 0;
    for (const [x, y] of pts) {
      const s = list.find((sc) => sceneContains(sc, x, y));
      if (s) {
        hit++;
        cloudSum += s.cloud;
      }
    }
    groups.push({
      date,
      scenes: list,
      coverage: hit / pts.length,
      cloud: hit ? cloudSum / hit : list[0].cloud,
    });
  }
  return groups.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 推荐基准日：覆盖率与晴空比例乘积最大的日期 */
export function recommendBase(groups: DateGroup[]): string | undefined {
  let best: DateGroup | undefined;
  let bestScore = -1;
  for (const g of groups) {
    const score = g.coverage * (1 - g.cloud / 100);
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best?.date;
}

/** 取当天各景，云量低的在上 */
export function singleDay(groups: DateGroup[], date: string): Scene[] {
  return groups.find((g) => g.date === date)?.scenes ?? [];
}
