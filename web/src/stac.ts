import type { BBox, Scene } from './types';

/** Earth Search 的 STAC 检索，经后端转发并缓存 */
const SEARCH_URL = '/api/stac/search';
/** 单页条数，过大时响应会被截断 */
const PAGE_LIMIT = 50;

export interface SearchParams {
  bbox: BBox;
  start: string;
  end: string;
  maxCloud: number;
  maxItems: number;
}

export interface SearchResult {
  scenes: Scene[];
  truncated: boolean;
}

/**
 * 只取前端用到的字段。Earth Search 默认总返回全部资产，须显式排除，
 * 否则每景约 19 KB，翻一页 50 景近 1 MB，会挤占主机有限的出口带宽
 */
const SCENE_FIELDS = {
  include: ['id', 'bbox', 'geometry', 'properties.datetime', 'properties.eo:cloud_cover', 'properties.grid:code'],
  exclude: ['assets', 'links'],
};

function toScene(f: any): Scene | undefined {
  const p = f.properties;
  if (!p?.datetime || !f.geometry) return undefined;
  return {
    id: f.id,
    datetime: p.datetime,
    date: String(p.datetime).slice(0, 10),
    cloud: p['eo:cloud_cover'] ?? 100,
    tile: String(p['grid:code'] ?? '').replace('MGRS-', ''),
    bbox: f.bbox,
    geometry: f.geometry,
  };
}

/**
 * 检索 Sentinel-2 L2A 景，按 links 中 rel=next 的 body.next 字段翻页。
 * 同一景可能以不同处理版本重复出现，按 MGRS 瓦片与时刻去重，保留后处理的版本。
 */
export async function searchScenes(
  params: SearchParams,
  signal: AbortSignal,
  onProgress: (count: number) => void,
): Promise<SearchResult> {
  let body: Record<string, unknown> = {
    collections: ['sentinel-2-l2a'],
    bbox: params.bbox,
    datetime: `${params.start}T00:00:00Z/${params.end}T23:59:59Z`,
    limit: PAGE_LIMIT,
    query: { 'eo:cloud_cover': { lte: params.maxCloud } },
    fields: SCENE_FIELDS,
  };
  const byKey = new Map<string, Scene>();
  let fetched = 0;
  let truncated = false;

  while (true) {
    const resp = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) throw new Error(`STAC 检索失败：HTTP ${resp.status}`);
    const page = await resp.json();
    for (const f of page.features ?? []) {
      const s = toScene(f);
      if (!s) continue;
      const key = `${s.tile}|${s.datetime.slice(0, 16)}`;
      const prev = byKey.get(key);
      if (!prev || s.id > prev.id) byKey.set(key, s);
    }
    fetched += page.features?.length ?? 0;
    onProgress(byKey.size);

    const next = (page.links ?? []).find((l: any) => l.rel === 'next');
    if (!next?.body?.next || !page.features?.length) break;
    if (fetched >= params.maxItems) {
      truncated = true;
      break;
    }
    body = { ...body, next: next.body.next };
  }

  return { scenes: [...byKey.values()], truncated };
}

/** 按景编号批量取足迹几何，每次请求最多 100 景，只要编号与几何字段 */
export async function sceneGeometries(ids: string[]): Promise<Map<string, Scene['geometry']>> {
  const out = new Map<string, Scene['geometry']>();
  for (let i = 0; i < ids.length; i += 100) {
    const resp = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collections: ['sentinel-2-l2a'],
        ids: ids.slice(i, i + 100),
        limit: 100,
        fields: { include: ['id', 'geometry'], exclude: ['assets', 'links'] },
      }),
    });
    if (!resp.ok) throw new Error(`STAC 检索失败：HTTP ${resp.status}`);
    for (const f of (await resp.json()).features ?? []) out.set(f.id, f.geometry);
  }
  return out;
}
