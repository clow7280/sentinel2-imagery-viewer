import { type CacheStatus, type DiskCache, type Entry, Inflight, Semaphore } from './cache';
import { config } from './config';

export const upstreamLimit = new Semaphore(config.upstreamConcurrency);
const inflight = new Inflight<Entry>();
const USER_AGENT = 'sentinel2-imagery-viewer/0.1 (upstream cache)';
const TIMEOUT_MS = 60_000;

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 网关类状态多为上游瞬时故障，与连接错误一样值得重试 */
const RETRY_STATUS = new Set([502, 503, 504]);
const RETRY_DELAY_MS = 1000;

/** 连接错误与网关类错误状态等待片刻后重试一次，其他 HTTP 状态原样返回 */
export function upstreamFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const once = () =>
    fetch(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  const host = new URL(url).host;
  return upstreamLimit.run(async () => {
    try {
      const resp = await once();
      if (!RETRY_STATUS.has(resp.status)) return resp;
      await resp.body?.cancel();
      console.warn(`[upstream] ${host} 返回 ${resp.status}，重试一次`);
    } catch (err) {
      console.warn(`[upstream] ${host} 连接失败，重试一次：${errorText(err)}`);
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return once();
  });
}

const errorText = (err: unknown) => {
  const cause = (err as { cause?: { code?: string } })?.cause?.code;
  return cause ? `${String(err)} (${cause})` : String(err);
};

/**
 * 读缓存，过期则回源；上游失败时若有旧副本则返回旧副本。
 * 只缓存 200 响应，其他状态原样透传。
 */
export async function cached(
  cache: DiskCache,
  key: string,
  ttlMs: number,
  load: () => Promise<Response>,
): Promise<{ entry: Entry; status: CacheStatus }> {
  const hit = await cache.get(key);
  if (hit && Date.now() - hit.storedAt < ttlMs) return { entry: hit, status: 'HIT' };
  try {
    const entry = await inflight.run(`${cache.name}:${key}`, async () => {
      const resp = await load();
      const body = Buffer.from(await resp.arrayBuffer());
      const e: Entry = {
        status: resp.status,
        contentType: resp.headers.get('content-type') ?? 'application/octet-stream',
        storedAt: Date.now(),
        body,
      };
      if (resp.ok) await cache.put(key, e);
      return e;
    });
    if (entry.status >= 500 && hit) return { entry: hit, status: 'STALE' };
    return { entry, status: 'MISS' };
  } catch (err) {
    console.warn(`[upstream] ${cache.name} ${key.slice(0, 120)} 失败：${errorText(err)}`);
    if (hit) return { entry: hit, status: 'STALE' };
    throw new UpstreamError(502, `上游请求失败：${errorText(err)}`);
  }
}
