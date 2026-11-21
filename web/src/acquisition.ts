import type { Feature, FeatureCollection, Polygon, Position } from 'geojson';

/** ESA 采集计划站点不带 CORS 头，经后端转发并缓存 */
const PLAN_PAGE = '/api/esa/plans';
const FILE_RE = /\/documents\/d\/sentinel\/((s2[a-z])_mp_acq__kml_(\d{8}t\d{6})_(\d{8}t\d{6}))/gi;
const DAY_MS = 86400000;

interface PlanFile {
  sat: string;
  start: number;
  stop: number;
  path: string;
}

export interface DailyPlan {
  features: Feature<Polygon>[];
  /** 各卫星在当日的计划采集段数 */
  counts: Record<string, number>;
  /** 有计划文件获取失败的卫星，其采集段尽量由更早发布的计划补齐 */
  failed: string[];
}

const parseStamp = (s: string) =>
  Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));

let filesPromise: Promise<PlanFile[]> | undefined;

/** 从采集计划页面中解析各卫星已发布的 KML 文件及其起止时间 */
function listPlanFiles(): Promise<PlanFile[]> {
  filesPromise ??= (async () => {
    const resp = await fetch(PLAN_PAGE);
    if (!resp.ok) throw new Error(`采集计划列表获取失败：HTTP ${resp.status}`);
    const html = await resp.text();
    const files = new Map<string, PlanFile>();
    for (const m of html.matchAll(FILE_RE)) {
      files.set(m[1].toLowerCase(), {
        sat: m[2].toUpperCase(),
        start: parseStamp(m[3]),
        stop: parseStamp(m[4]),
        path: `/api/esa/kml/${m[1]}`,
      });
    }
    return [...files.values()];
  })();
  filesPromise.catch(() => (filesPromise = undefined));
  return filesPromise;
}

const kmlCache = new Map<string, Promise<Document>>();

function loadKml(path: string): Promise<Document> {
  let p = kmlCache.get(path);
  if (!p) {
    p = fetch(path)
      .then((r) => {
        if (!r.ok) throw new Error(`采集计划 KML 获取失败：HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => new DOMParser().parseFromString(text, 'application/xml'));
    p.catch(() => kmlCache.delete(path));
    kmlCache.set(path, p);
  }
  return p;
}

/** 以首点为基准展开经度，跨 180° 经线的采集段不会被拉成横跨全球的面 */
function unwrap(ring: Position[]): Position[] {
  const ref = ring[0][0];
  return ring.map(([lon, lat]) => [lon + Math.round((ref - lon) / 360) * 360, lat]);
}

const utc = (s: string) => Date.parse(s.endsWith('Z') ? s : `${s}Z`);

/**
 * 取某个 UTC 日的计划采集段。
 * 计划文件每周发布、时段相互重叠，同一时刻以最新发布、即起始时间最晚的文件为准；
 * 只保留 NOBS 标称观测，定标等其他模式的数据不对用户分发。
 */
export async function dailyPlan(day: string): Promise<DailyPlan> {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const dayEnd = dayStart + DAY_MS;
  const files = (await listPlanFiles())
    .filter((f) => f.start < dayEnd && f.stop > dayStart)
    .sort((a, b) => b.start - a.start);

  const docs = await Promise.allSettled(files.map((f) => loadKml(f.path)));
  if (files.length && docs.every((d) => d.status === 'rejected')) throw (docs[0] as PromiseRejectedResult).reason;
  const failed = new Set<string>();
  const features: Feature<Polygon>[] = [];
  const counts: Record<string, number> = {};
  /** 各卫星已由更新文件覆盖的最早时刻，更旧的文件只补这之前的部分 */
  const coveredFrom: Record<string, number> = {};

  files.forEach((file, i) => {
    const doc = docs[i];
    if (doc.status === 'rejected') {
      failed.add(file.sat);
      return;
    }
    const limit = Math.min(coveredFrom[file.sat] ?? Infinity, dayEnd);
    for (const pm of doc.value.querySelectorAll('Placemark')) {
      if (!pm.querySelector('styleUrl')?.textContent?.includes('NOBS')) continue;
      const begin = utc(pm.querySelector('TimeSpan > begin')?.textContent ?? '');
      const end = utc(pm.querySelector('TimeSpan > end')?.textContent ?? '');
      if (!(end > dayStart && begin < limit && begin >= file.start)) continue;
      const coords = pm.querySelector('Polygon coordinates')?.textContent?.trim();
      if (!coords) continue;
      const ring = unwrap(coords.split(/\s+/).map((c) => c.split(',').slice(0, 2).map(Number)));
      const orbit = pm.querySelector('Data[name="OrbitRelative"] > value')?.textContent ?? '';
      features.push({
        type: 'Feature',
        properties: { sat: file.sat, begin, end, orbit },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
      counts[file.sat] = (counts[file.sat] ?? 0) + 1;
    }
    coveredFrom[file.sat] = Math.min(coveredFrom[file.sat] ?? Infinity, file.start);
  });
  return { features, counts, failed: [...failed] };
}

/** 按当前时刻标记已采集与待采集的段 */
export function planCollection(plan: DailyPlan, now: number): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: plan.features.map((f) => ({ ...f, properties: { ...f.properties, done: f.properties!.end < now } })),
  };
}
