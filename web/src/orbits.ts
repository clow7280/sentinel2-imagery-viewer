import type { Feature, FeatureCollection, Position } from 'geojson';
import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from 'satellite.js';

/** 经后端取 CelesTrak 的 TLE，后端按两小时缓存，避免浏览器频繁请求导致来源 IP 被封 */
const TLE_URL = '/api/tle';
/** 轨道周期约 100.6 分钟，前后各取半圈即覆盖一整圈 */
const HALF_ORBIT_MS = 50.3 * 60000;
const STEP_MS = 30000;
/** MSI 幅宽 290 km */
const HALF_SWATH_KM = 145;
const EARTH_R_KM = 6371;

export interface Sat {
  name: string;
  satrec: SatRec;
  /** TLE 历元 */
  epoch: Date;
}

export async function loadSats(): Promise<Sat[]> {
  const resp = await fetch(TLE_URL);
  if (!resp.ok) throw new Error(`TLE 获取失败：HTTP ${resp.status}`);
  const lines = (await resp.text())
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const sats: Sat[] = [];
  for (let i = 0; i + 2 < lines.length && lines[i + 1].startsWith('1 '); i += 3) {
    const satrec = twoline2satrec(lines[i + 1], lines[i + 2]);
    sats.push({
      name: lines[i].replace('SENTINEL-', 'S'),
      satrec,
      epoch: new Date((satrec.jdsatepoch - 2440587.5) * 86400000),
    });
  }
  return sats;
}

function subpoint(sat: Sat, date: Date): Position | undefined {
  const pv = propagate(sat.satrec, date);
  if (!pv) return undefined;
  const geo = eciToGeodetic(pv.position, gstime(date));
  return [degreesLong(geo.longitude), degreesLat(geo.latitude)];
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function bearing([lon1, lat1]: Position, [lon2, lat2]: Position): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return Math.atan2(y, x);
}

/** 大圆上从某点沿方位角走一段距离后的终点 */
function destination([lon, lat]: Position, brg: number, km: number): Position {
  const d = km / EARTH_R_KM;
  const p1 = rad(lat);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(brg));
  const l2 = rad(lon) + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(l2), deg(p2)];
}

/** 以首点为基准展开经度，避免小多边形跨越 180° 经线时被拉成横跨全球的面 */
function unwrap(ring: Position[]): Position[] {
  const ref = ring[0][0];
  return ring.map(([lon, lat]) => [lon + Math.round((ref - lon) / 360) * 360, lat]);
}

/** 按 180° 经线把轨迹切成多段 */
function splitAtAntimeridian(pts: Position[]): Position[][] {
  const parts: Position[][] = [[]];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && Math.abs(pts[i][0] - pts[i - 1][0]) > 180) parts.push([]);
    parts.at(-1)!.push(pts[i]);
  }
  return parts.filter((p) => p.length > 1);
}

/** 生成各卫星当前位置、前后半圈地面轨迹与扫描带 */
export function orbitFeatures(sats: Sat[], now: Date): FeatureCollection {
  const features: Feature[] = [];
  for (const sat of sats) {
    const past: Position[] = [];
    const future: Position[] = [];
    for (let t = -HALF_ORBIT_MS; t <= HALF_ORBIT_MS; t += STEP_MS) {
      const p = subpoint(sat, new Date(now.getTime() + t));
      if (!p) continue;
      if (t <= 0) past.push(p);
      if (t >= 0) future.push(p);
    }
    const all = [...past, ...future.slice(1)];
    for (let i = 0; i + 1 < all.length; i++) {
      const b = bearing(all[i], all[i + 1]);
      const ring = unwrap([
        destination(all[i], b - Math.PI / 2, HALF_SWATH_KM),
        destination(all[i + 1], b - Math.PI / 2, HALF_SWATH_KM),
        destination(all[i + 1], b + Math.PI / 2, HALF_SWATH_KM),
        destination(all[i], b + Math.PI / 2, HALF_SWATH_KM),
      ]);
      ring.push(ring[0]);
      features.push({ type: 'Feature', properties: { kind: 'swath', sat: sat.name }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    for (const [kind, pts] of [
      ['past', past],
      ['future', future],
    ] as const) {
      features.push({
        type: 'Feature',
        properties: { kind, sat: sat.name },
        geometry: { type: 'MultiLineString', coordinates: splitAtAntimeridian(pts) },
      });
    }
    const here = subpoint(sat, now);
    if (here) features.push({ type: 'Feature', properties: { kind: 'sat', sat: sat.name }, geometry: { type: 'Point', coordinates: here } });
  }
  return { type: 'FeatureCollection', features };
}
