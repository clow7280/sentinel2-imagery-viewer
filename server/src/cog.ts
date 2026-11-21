import { DiskCache, type Entry, Inflight } from './cache';
import { upstreamFetch, UpstreamError } from './upstream';

const S3_ORIGIN = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com';
/** 只允许取 Sentinel-2 L2A 的真彩色与场景分类 COG */
const PATH_RE = /^sentinel-s2-l2a-cogs\/\d{1,2}\/[A-Z]\/[A-Z]{2}\/\d{4}\/\d{1,2}\/[A-Za-z0-9_]+\/(TCI|SCL)\.tif$/;
/** 缓存分块大小，浏览器端 geotiff 的读取以 64 KB 块为单位聚合，1 MiB 分块能覆盖相邻块并摊薄跨洋延迟 */
const CHUNK = 1024 * 1024;
/** 单次请求允许的最大字节范围，防止被用来整文件下载 */
const MAX_SPAN = 32 * CHUNK;

const inflight = new Inflight<Buffer[]>();

/** 最近用过的分块留在内存，geotiff 解析文件头时会对同一分块发起多次小范围读取 */
const MEMO_LIMIT = 64;
const memo = new Map<string, Entry>();
function remember(key: string, e: Entry) {
  memo.delete(key);
  memo.set(key, e);
  while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
}
async function getChunk(cache: DiskCache, key: string): Promise<Entry | undefined> {
  const m = memo.get(key);
  if (m) {
    remember(key, m);
    return m;
  }
  const e = await cache.get(key);
  if (e) remember(key, e);
  return e;
}

/**
 * 已缓存影像的景编号，取 COG 路径中的目录名，如 S2B_50SMG_20261007_0_L2A。
 * 由分块元数据中的路径重建，读写分块时补登记，缓存淘汰后需重建。
 */
const cachedScenes = new Set<string>();
const sceneOf = (objPath: string) => objPath.split('/').at(-2)!;

export function listCachedScenes(): string[] {
  return [...cachedScenes].sort();
}

export async function rebuildSceneIndex(cache: DiskCache) {
  const found = new Set<string>();
  for await (const meta of cache.metas()) {
    const p = meta.extra?.path;
    if (typeof p === 'string') found.add(sceneOf(p));
  }
  cachedScenes.clear();
  for (const s of found) cachedScenes.add(s);
  console.log(`[cog] 已缓存影像 ${cachedScenes.size} 景`);
}

export function isAllowedCogPath(p: string): boolean {
  return PATH_RE.test(p);
}

interface Range {
  start: number;
  end: number;
}

/**
 * 从上游一次取回连续的若干分块并写入缓存。
 * 返回各分块内容与对象总大小，总大小来自 Content-Range。
 */
async function fetchChunks(cache: DiskCache, objPath: string, first: number, last: number) {
  return inflight.run(`${objPath}#${first}-${last}`, async () => {
    const resp = await upstreamFetch(`${S3_ORIGIN}/${objPath}`, {
      headers: { Range: `bytes=${first * CHUNK}-${(last + 1) * CHUNK - 1}` },
    });
    if (resp.status === 416) return [];
    if (resp.status !== 206) throw new UpstreamError(resp.status === 404 ? 404 : 502, `COG 上游返回 ${resp.status}`);
    const total = Number(resp.headers.get('content-range')?.split('/')[1]);
    const body = Buffer.from(await resp.arrayBuffer());
    const chunks: Buffer[] = [];
    for (let i = first; i <= last; i++) {
      const part = body.subarray((i - first) * CHUNK, (i - first + 1) * CHUNK);
      if (!part.length) break;
      chunks.push(part);
      const entry: Entry = {
        status: 206,
        contentType: 'image/tiff',
        storedAt: Date.now(),
        extra: { total, path: objPath },
        body: part,
      };
      remember(`${objPath}#${i}`, entry);
      await cache.put(`${objPath}#${i}`, entry);
    }
    return chunks;
  });
}

/** 按字节范围读取 COG，命中的分块直接取缓存，缺失的连续分块合并成一次上游请求 */
export async function readCogRange(cache: DiskCache, objPath: string, range: Range) {
  if (range.end - range.start + 1 > MAX_SPAN) throw new UpstreamError(416, '请求范围过大');
  const first = Math.floor(range.start / CHUNK);
  const last = Math.floor(range.end / CHUNK);
  const parts = new Map<number, Buffer>();
  let total: number | undefined;
  let hits = 0;

  for (let i = first; i <= last; i++) {
    const e = await getChunk(cache, `${objPath}#${i}`);
    if (e) {
      parts.set(i, e.body);
      total ??= e.extra?.total as number | undefined;
      hits++;
    }
  }
  for (let i = first; i <= last; i++) {
    if (parts.has(i)) continue;
    let j = i;
    while (j + 1 <= last && !parts.has(j + 1)) j++;
    const fetched = await fetchChunks(cache, objPath, i, j);
    fetched.forEach((b, k) => parts.set(i + k, b));
    if (total === undefined) {
      const meta = await getChunk(cache, `${objPath}#${i}`);
      total = meta?.extra?.total as number | undefined;
    }
    i = j;
  }
  if (total === undefined) throw new UpstreamError(502, '无法确定 COG 大小');
  cachedScenes.add(sceneOf(objPath));
  if (range.start >= total) return { total, body: undefined };

  const end = Math.min(range.end, total - 1);
  const buf = Buffer.concat([...Array(last - first + 1).keys()].map((k) => parts.get(first + k) ?? Buffer.alloc(0)));
  const offset = range.start - first * CHUNK;
  return {
    total,
    start: range.start,
    end,
    body: buf.subarray(offset, offset + end - range.start + 1),
    status: hits === last - first + 1 ? 'HIT' : hits ? 'PARTIAL' : 'MISS',
  };
}
