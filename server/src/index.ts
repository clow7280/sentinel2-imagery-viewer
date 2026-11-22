import { serve } from '@hono/node-server';
import { type Context, Hono } from 'hono';
import net from 'node:net';
import path from 'node:path';
import { type CacheStatus, DiskCache, type Entry, Semaphore, SharedTask } from './cache';
import { listCachedScenes, rebuildSceneIndex } from './cog';
import { config } from './config';
import { renderTile } from './render';
import { resolveScenes, SCENE_ID_RE, STAC_URL } from './scenes';
import { cached, upstreamFetch, UpstreamError } from './upstream';

// Node 双栈连接默认每个地址只等 250 ms，东京到 ESA 巴黎机房的往返时延接近这个值，建连会被误判超时
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const caches = {
  cog: new DiskCache('cog', path.join(config.cacheDir, 'cog'), config.maxBytes.cog),
  tiles: new DiskCache('tiles', path.join(config.cacheDir, 'tiles'), config.maxBytes.tiles),
  meta: new DiskCache('meta', path.join(config.cacheDir, 'meta'), config.maxBytes.meta),
};

const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?NAME=SENTINEL-2&FORMAT=TLE';
const ESA_ORIGIN = 'https://sentinels.copernicus.eu';
const ESA_PLAN_PAGE = `${ESA_ORIGIN}/copernicus/sentinel-2/acquisition-plans`;
const KML_RE = /^s2[a-z]_mp_acq__kml_\d{8}t\d{6}_\d{8}t\d{6}$/i;
/** 计划列表页中的 KML 链接，文件名带起止时刻 */
const PLAN_FILE_RE = /\/documents\/d\/sentinel\/(s2[a-z]_mp_acq__kml_(\d{8}t\d{6})_(\d{8}t\d{6}))/gi;
const parseStamp = (s: string) =>
  Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
const OFM_ORIGIN = 'https://tiles.openfreemap.org';
const OFM_PATH_RE = /^(styles|planet|natural_earth|fonts|sprites)(\/[\w@.,%\- ]+)*$/;
const SEAMARK_URL = 'https://tiles.openseamap.org/seamark';

const app = new Hono();

/** 公开访问下按 IP 做固定窗口限流，防止被当作通用代理 */
const hits = new Map<string, { n: number; t: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of hits) if (now - v.t > 60_000) hits.delete(ip);
}, 60_000).unref();

app.use('/api/*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';
  const now = Date.now();
  const v = hits.get(ip);
  if (!v || now - v.t > 60_000) hits.set(ip, { n: 1, t: now });
  else if (++v.n > config.rateLimitPerMinute) return c.text('请求过于频繁', 429);
  await next();
});

app.onError((err, c) => {
  // 客户端已断开，例如地图移走后取消的瓦片请求，不必记录也无人接收响应
  if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
  if (err instanceof UpstreamError) return c.text(err.message, err.status as 400);
  console.error(err);
  return c.text('服务器内部错误', 500);
});

function send(c: Context, r: { entry: Entry; status: CacheStatus }, maxAgeSec: number, body?: Buffer | string) {
  const ok = r.entry.status === 200;
  return c.body(typeof body === 'string' ? body : new Uint8Array(body ?? r.entry.body), r.entry.status as 200, {
    'Content-Type': r.entry.contentType,
    'Cache-Control': ok ? `public, max-age=${maxAgeSec}` : 'no-store',
    'X-Cache': r.status,
  });
}

/** 对外地址，反代后取 X-Forwarded-* 头，用于改写上游 JSON 中的绝对地址 */
function publicOrigin(c: Context) {
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
  return `${proto}://${host}`;
}

app.get('/api/health', (c) => c.json({ ok: true }));

// STAC 检索：同一请求体一小时内复用，新影像入库延迟本身就在小时量级
app.post('/api/stac/search', async (c) => {
  const text = await c.req.text();
  if (text.length > 16_384) return c.text('请求体过大', 413);
  let body: { collections?: unknown; limit?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return c.text('请求体不是合法 JSON', 400);
  }
  const collections = body.collections;
  if (!Array.isArray(collections) || collections.length !== 1 || collections[0] !== 'sentinel-2-l2a') {
    return c.text('只支持 sentinel-2-l2a 集合', 400);
  }
  if (typeof body.limit === 'number' && body.limit > 100) return c.text('limit 不能超过 100', 400);
  const canonical = JSON.stringify(body);
  const r = await cached(caches.meta, `stac:${canonical}`, HOUR, () =>
    upstreamFetch(STAC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: canonical }),
  );
  return send(c, r, 300);
});

// CelesTrak 要求同一数据两小时内只取一次，频繁请求会封禁来源 IP
app.get('/api/tle', async (c) => {
  const r = await cached(caches.meta, 'tle:sentinel-2', 2 * HOUR, () => upstreamFetch(TLE_URL));
  return send(c, r, 1800);
});

// ESA 采集计划：列表页每 6 小时刷新，KML 文件名带时段，内容基本不变
const loadPlanPage = () => cached(caches.meta, 'esa:plans', 6 * HOUR, () => upstreamFetch(ESA_PLAN_PAGE));
const loadKml = (name: string) =>
  cached(caches.meta, `esa:kml:${name.toLowerCase()}`, 7 * DAY, () =>
    upstreamFetch(`${ESA_ORIGIN}/documents/d/sentinel/${name}`),
  );

app.get('/api/esa/plans', async (c) => send(c, await loadPlanPage(), 3600));

app.get('/api/esa/kml/:name', async (c) => {
  const name = c.req.param('name');
  if (!KML_RE.test(name)) return c.text('不支持的文件名', 400);
  return send(c, await loadKml(name), DAY / 1000);
});

/**
 * 预取覆盖前一日到后两日的计划 KML。
 * 单个文件从 ESA 首次下载约需 10 秒，预取后用户打开当日计划时直接命中缓存。
 */
async function warmPlans() {
  const page = (await loadPlanPage()).entry.body.toString('utf8');
  const now = Date.now();
  const names = new Set<string>();
  for (const m of page.matchAll(PLAN_FILE_RE)) {
    const [start, stop] = [m[2], m[3]].map(parseStamp);
    if (start < now + 2 * DAY && stop > now - DAY) names.add(m[1].toLowerCase());
  }
  for (const name of names) await loadKml(name);
}
const warm = () => warmPlans().catch((err) => console.warn(`[warm] 采集计划预取失败：${String(err)}`));
warm();
setInterval(warm, 6 * HOUR).unref();

// OpenFreeMap 底图：样式与 TileJSON 中的绝对地址改写为本站，矢量瓦片按版本路径长期缓存
app.get('/api/ofm/*', async (c) => {
  const sub = c.req.path.replace(/^\/api\/ofm\//, '');
  if (!OFM_PATH_RE.test(sub) || sub.includes('..')) return c.text('不支持的路径', 400);
  const versioned = /^(planet\/[^/]+\/|natural_earth\/|fonts\/)/.test(sub);
  const ttl = versioned ? 30 * DAY : DAY;
  const r = await cached(caches.tiles, `ofm:${sub}`, ttl, () => upstreamFetch(`${OFM_ORIGIN}/${sub}`));
  if (r.entry.contentType.includes('json')) {
    const text = r.entry.body.toString('utf8').replaceAll(OFM_ORIGIN, `${publicOrigin(c)}/api/ofm`);
    return send(c, r, 3600, text);
  }
  return send(c, r, versioned ? 30 * 86400 : 86400);
});

// OpenSeaMap 海图标志瓦片
app.get('/api/seamark/:z/:x/:y', async (c) => {
  const { z, x, y } = c.req.param();
  const m = y.match(/^(\d+)\.png$/);
  if (!/^\d{1,2}$/.test(z) || !/^\d{1,7}$/.test(x) || !m) return c.text('不支持的瓦片', 400);
  const r = await cached(caches.tiles, `seamark:${z}/${x}/${m[1]}`, 7 * DAY, () =>
    upstreamFetch(`${SEAMARK_URL}/${z}/${x}/${m[1]}.png`),
  );
  return send(c, r, 86400);
});

/** 影像瓦片的缩放范围，与前端栅格源的 minzoom、maxzoom 一致 */
const S2_MIN_ZOOM = 7;
const S2_MAX_ZOOM = 15;
/** 单个瓦片最多参与合成的景数 */
const S2_MAX_SCENES = 24;
/**
 * 同时渲染的瓦片数。渲染本身只需几十毫秒，冷启动时主要在等东京到美西的回源，
 * 并发高一些才能让回源等待相互重叠；解码在 zlib 线程池中进行
 */
const renderLimit = new Semaphore(12);
const renderTasks = new SharedTask<Entry>();
const EMPTY = Buffer.alloc(0);

/**
 * Sentinel-2 影像瓦片：按景编号读取 COG，在服务端重投影合成为 WebP。
 * ids 按合成优先级排列，同一瓦片与景序列的结果不变，长期缓存；没有影像时返回 204
 */
app.get('/api/s2/:z/:x/:y', async (c) => {
  const { z: zs, x: xs, y: ys } = c.req.param();
  const m = ys.match(/^(\d{1,6})(@2x)?\.webp$/);
  const z = Number(zs);
  const x = Number(xs);
  if (!m || !/^\d{1,2}$/.test(zs) || !/^\d{1,6}$/.test(xs) || z < S2_MIN_ZOOM || z > S2_MAX_ZOOM) {
    return c.text('不支持的瓦片', 400);
  }
  const y = Number(m[1]);
  if (x >= 2 ** z || y >= 2 ** z) return c.text('瓦片超出范围', 400);
  const ids = (c.req.query('ids') ?? '').split(',');
  if (!ids.length || ids.length > S2_MAX_SCENES || new Set(ids).size !== ids.length || !ids.every((id) => SCENE_ID_RE.test(id))) {
    return c.text('景编号无效', 400);
  }
  const size = m[2] ? 512 : 256;
  const key = `s2:${size}:${z}/${x}/${y}:${ids.join(',')}`;
  const hit = await caches.tiles.get(key);
  const entry =
    hit ??
    (await renderTasks.run(key, c.req.raw.signal, async (signal) => {
      const scenes = await resolveScenes(caches.meta, ids);
      // 排队期间请求方都已离开时不再开始渲染
      const body = await renderLimit.run(() => {
        signal.throwIfAborted();
        return renderTile(caches.cog, z, x, y, size, scenes, signal);
      });
      const e: Entry = { status: body ? 200 : 204, contentType: 'image/webp', storedAt: Date.now(), body: body ?? EMPTY };
      await caches.tiles.put(key, e);
      return e;
    }));
  const headers = { 'Cache-Control': 'public, max-age=604800, immutable', 'X-Cache': hit ? 'HIT' : 'MISS' };
  if (entry.status === 204) return c.body(null, 204, headers);
  return c.body(new Uint8Array(entry.body), 200, { ...headers, 'Content-Type': 'image/webp' });
});

// 服务器已缓存影像的景编号，前端据此绘制影像边界
app.get('/api/cached-scenes', (c) =>
  c.json(listCachedScenes(), 200, { 'Cache-Control': 'public, max-age=60' }),
);

async function sweepAll() {
  for (const [name, cache] of Object.entries(caches)) {
    const removed = await cache.sweep().catch((err) => (console.error(err), 0));
    if (name === 'cog' && removed) await rebuildSceneIndex(cache);
  }
}
rebuildSceneIndex(caches.cog).then(sweepAll);
setInterval(sweepAll, 15 * 60_000).unref();

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[server] 监听 ${info.address}:${info.port}，缓存目录 ${config.cacheDir}`);
});
