import type { DiskCache } from './cache';
import { isAllowedCogPath } from './cog';
import type { SceneMeta } from './render';
import { cached, upstreamFetch, UpstreamError } from './upstream';

export const STAC_URL = 'https://earth-search.aws.element84.com/v1/search';
const S3_ORIGIN = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/';
/** 景元数据基本不变，查询结果长期缓存 */
const META_TTL_MS = 30 * 86400_000;
const KNOWN_LIMIT = 50_000;

/** Earth Search 的景编号，如 S2B_50SMG_20261007_0_L2A */
export const SCENE_ID_RE = /^S2[A-D]_\d{1,2}[A-Z]{3}_\d{8}_\d+_L2A$/;

const known = new Map<string, SceneMeta>();

/** 按景编号取渲染所需的元数据，缺失的经 STAC 一次批量查询，未知编号报 404 */
export async function resolveScenes(cache: DiskCache, ids: string[]): Promise<SceneMeta[]> {
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    const body = JSON.stringify({
      collections: ['sentinel-2-l2a'],
      ids: missing,
      limit: 100,
      fields: { include: ['id', 'properties.proj:epsg', 'assets.visual'] },
    });
    const r = await cached(cache, `stac-meta:${body}`, META_TTL_MS, () =>
      upstreamFetch(STAC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
    );
    if (r.entry.status !== 200) throw new UpstreamError(502, `STAC 查询失败：HTTP ${r.entry.status}`);
    if (known.size > KNOWN_LIMIT) known.clear();
    for (const f of JSON.parse(r.entry.body.toString('utf8')).features ?? []) {
      const v = f.assets?.visual;
      const path = typeof v?.href === 'string' ? v.href.replace(S3_ORIGIN, '') : '';
      const epsg = f.properties?.['proj:epsg'];
      if (!isAllowedCogPath(path) || !epsg || !v['proj:transform'] || !v['proj:shape']) continue;
      known.set(f.id, { path, epsg, transform: v['proj:transform'], shape: v['proj:shape'] });
    }
  }
  return ids.map((id) => {
    const m = known.get(id);
    if (!m) throw new UpstreamError(404, `未知的景：${id}`);
    return m;
  });
}
