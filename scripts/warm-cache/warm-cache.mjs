#!/usr/bin/env node
/**
 * 为常见港口与海域预热 Sentinel-2 影像缓存，让用户首次打开这些地方时不必等待从 AWS 美西回源。
 *
 * 做法与前端一致：对每个地点检索近 3 个月的景，先取云量不超过 20% 的，一景都没有的分幅再按云量升序补检；
 * 每个 MGRS 分幅先看覆盖、再比云量挑出首选景，有缺测时从其他相对轨道各取最晴的一景补齐；
 * 再按缩放级别枚举与地点相交的地图瓦片，挑出与瓦片相交的景，请求 /api/s2 让后端渲染。
 *
 * 主要目的是让后端缓存 COG 的 1 MiB 分块，分块缓存只取决于读到哪些景的哪些位置，与请求顺序无关。
 * 渲染结果的缓存键含景编号的排列，前端按视野检索、各分幅在合成序列中的先后与这里未必相同，
 * 所以前端实际请求的瓦片未必命中这里渲染的结果，但会命中分块缓存，单瓦片只需几十毫秒渲染。
 *
 * 选景算法复制自 web/src/regions.ts、web/src/stac.ts、web/src/tiles.ts 与 web/src/composition.ts，
 * 前端规则调整后需同步修改。mgrs 取自 web 的依赖，先在仓库根目录执行过 pnpm install 即可。
 *
 * 用法见 node scripts/warm-cache/warm-cache.mjs --help
 */
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { LOCATIONS } from './locations.mjs';

const { forward, toPoint } = createRequire(new URL('../../web/package.json', import.meta.url))('mgrs');

/** 与前端 main.ts 一致的自动挑选参数 */
const AUTO_MONTHS = 3;
const AUTO_CLOUD = 20;
const MAX_ITEMS = 1500;
const CLOUDY_ITEMS = 300;
const PAGE_LIMIT = 50;
/** 与前端 regions.ts 一致 */
const COVER_TOL = 5;
const NO_GAP = 0.5;
const CLOUD_TIE = 2;
const SAMPLE_STEP = 0.2;
/** 与前端 tiles.ts、后端 index.ts 一致 */
const MAX_SCENES_PER_TILE = 24;
const TILE_SAMPLES = 6;
const MIN_ZOOM = 4;
const MAX_ZOOM = 15;
/** 后端每个 IP 每分钟限 3000 次请求，相邻请求至少间隔该毫秒数，留出余量给同一出口的浏览器 */
const MIN_INTERVAL_MS = 30;
const REQUEST_TIMEOUT_MS = 180_000;

const HELP = `用法：node scripts/warm-cache/warm-cache.mjs [选项]

  --target <地址>    后端或站点地址，默认 https://sentinel2.c410.space
                     本地可用 http://localhost:5173（经 Vite 转发）或 http://127.0.0.1:8787
  --zoom <a-b>       缩放级别范围，默认 8-12，限 ${MIN_ZOOM} 到 ${MAX_ZOOM} 级
  --scale <1|2|both> 1 为 256 像素瓦片，2 为高分屏的 512 像素 @2x 瓦片，默认 2
  --only <id,...>    只处理这些地点，id 见 --list
  --concurrency <n>  同时请求的瓦片数，默认 4
  --dry-run          只检索选景并统计瓦片数，不请求影像瓦片
  --list             列出地点与范围后退出
  --help             显示本说明

预演模式仍会经目标地址做 STAC 检索，检索结果在后端缓存 1 小时，开销很小。`;

const { values: opt } = parseArgs({
  options: {
    target: { type: 'string', default: 'https://sentinel2.c410.space' },
    zoom: { type: 'string', default: '8-12' },
    scale: { type: 'string', default: '2' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    'dry-run': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (opt.help) {
  console.log(HELP);
  process.exit(0);
}

if (opt.list) {
  for (const l of LOCATIONS) {
    const areas = [...(l.bboxes ?? []).map((b) => `[${b.join(', ')}]`), ...(l.lines ?? []).map((ln) => `中心线 ${ln.length} 点 ±${l.buffer}°`)];
    console.log(`${l.id.padEnd(20)} ${l.name}\n${' '.repeat(21)}${areas.join('；')}\n${' '.repeat(21)}来源：${l.source}`);
  }
  process.exit(0);
}

const target = opt.target.replace(/\/+$/, '');
const zm = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(opt.zoom);
if (!zm) fail(`--zoom 格式应为 8-12 或 10：${opt.zoom}`);
const [zMin, zMax] = [Number(zm[1]), Number(zm[2] ?? zm[1])];
if (zMin < MIN_ZOOM || zMax > MAX_ZOOM || zMin > zMax) fail(`--zoom 须在 ${MIN_ZOOM} 到 ${MAX_ZOOM} 之间且由小到大`);
const suffixes = { 1: [''], 2: ['@2x'], both: ['', '@2x'] }[opt.scale];
if (!suffixes) fail(`--scale 只能是 1、2 或 both：${opt.scale}`);
const concurrency = Number(opt.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) fail('--concurrency 须为 1 到 16 的整数');
const only = opt.only?.split(',').map((s) => s.trim()).filter(Boolean);
const unknown = only?.filter((id) => !LOCATIONS.some((l) => l.id === id)) ?? [];
if (unknown.length) fail(`未知的地点：${unknown.join(', ')}，可用 --list 查看`);
const locations = only ? LOCATIONS.filter((l) => only.includes(l.id)) : LOCATIONS;

// ---------- 分幅，复制自 web/src/regions.ts ----------

const normTile = (code) => code.replace(/^0/, '');

function tileAt(lon, lat) {
  try {
    return forward([lon, lat], 0);
  } catch {
    return undefined;
  }
}

function tilesInBBox([w, s, e, n]) {
  const out = new Set();
  for (let x = w; x <= e + 1e-9; x += SAMPLE_STEP) {
    for (let y = s; y <= n + 1e-9; y += SAMPLE_STEP) {
      const t = tileAt(Math.min(x, e), Math.min(y, n));
      if (t) out.add(t);
    }
  }
  return [...out];
}

const newer = (a, b) => (a.datetime > b.datetime ? a : b);

function pickTile(scenes) {
  if (!scenes.length) return [];
  const minNodata = Math.min(...scenes.map((s) => s.nodata));
  const pool = scenes.filter((s) => s.nodata <= minNodata + COVER_TOL);
  const minCloud = Math.min(...pool.map((s) => s.cloud));
  const best = pool.filter((s) => s.cloud <= minCloud + CLOUD_TIE).reduce(newer);
  return [best, ...fillGaps([best], scenes)];
}

function fillGaps(primary, scenes) {
  if (!primary.length || Math.min(...primary.map((s) => s.nodata)) <= NO_GAP) return [];
  const used = new Set(primary.map((s) => s.orbit));
  const byOrbit = new Map();
  for (const s of scenes) {
    if (used.has(s.orbit)) continue;
    const prev = byOrbit.get(s.orbit);
    if (!prev || s.cloud < prev.cloud) byOrbit.set(s.orbit, s);
  }
  return [...byOrbit.values()].sort((a, b) => a.cloud - b.cloud);
}

// ---------- STAC 检索，复制自 web/src/stac.ts ----------

const SCENE_FIELDS = {
  include: [
    'id',
    'bbox',
    'geometry',
    'properties.datetime',
    'properties.eo:cloud_cover',
    'properties.grid:code',
    'properties.s2:nodata_pixel_percentage',
    'properties.s2:product_uri',
  ],
  exclude: ['assets', 'links'],
};

function toScene(f) {
  const p = f.properties;
  if (!p?.datetime || !f.geometry) return undefined;
  return {
    id: f.id,
    datetime: p.datetime,
    date: String(p.datetime).slice(0, 10),
    cloud: p['eo:cloud_cover'] ?? 100,
    nodata: p['s2:nodata_pixel_percentage'] ?? 0,
    orbit: Number(/_R(\d{3})_/.exec(p['s2:product_uri'] ?? '')?.[1] ?? 0),
    tile: normTile(String(p['grid:code'] ?? '').replace('MGRS-', '')),
    bbox: f.bbox,
    geometry: f.geometry,
  };
}

async function searchScenes({ bbox, start, end, maxCloud, maxItems, tiles, clearFirst }) {
  let body = {
    collections: ['sentinel-2-l2a'],
    bbox,
    datetime: `${start}T00:00:00Z/${end}T23:59:59Z`,
    limit: PAGE_LIMIT,
    query: {
      'eo:cloud_cover': { lte: maxCloud },
      ...(tiles && { 'grid:code': { in: tiles.map((t) => `MGRS-${t}`) } }),
    },
    ...(clearFirst && { sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }] }),
    fields: SCENE_FIELDS,
  };
  const byKey = new Map();
  let fetched = 0;
  while (true) {
    const resp = await fetch(`${target}/api/stac/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    const next = (page.links ?? []).find((l) => l.rel === 'next');
    if (!next?.body?.next || !page.features?.length || fetched >= maxItems) break;
    body = { ...body, next: next.body.next };
  }
  return [...byKey.values()];
}

// ---------- 足迹与瓦片相交，复制自 web/src/composition.ts 与 web/src/tiles.ts ----------

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function sceneContains(s, lon, lat) {
  const [w, so, e, n] = s.bbox;
  if (lon < w || lon > e || lat < so || lat > n) return false;
  const polys = s.geometry.type === 'Polygon' ? [s.geometry.coordinates] : s.geometry.coordinates;
  return polys.some((rings) => inRing(lon, lat, rings[0]) && !rings.slice(1).some((h) => inRing(lon, lat, h)));
}

function touchesTile(s, [w, so, e, n]) {
  if (s.bbox[2] < w || s.bbox[0] > e || s.bbox[3] < so || s.bbox[1] > n) return false;
  for (let i = 0; i <= TILE_SAMPLES; i++) {
    for (let j = 0; j <= TILE_SAMPLES; j++) {
      if (sceneContains(s, w + ((e - w) * i) / TILE_SAMPLES, so + ((n - so) * j) / TILE_SAMPLES)) return true;
    }
  }
  const polys = s.geometry.type === 'Polygon' ? [s.geometry.coordinates] : s.geometry.coordinates;
  return polys.some((rings) => rings[0].some(([lx, ly]) => lx >= w && lx <= e && ly >= so && ly <= n));
}

// ---------- 地图瓦片 ----------

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lon = (v) => (v / n) * 360 - 180;
  const lat = (v) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

function addBBoxTiles(out, [w, s, e, n], z) {
  const max = 2 ** z - 1;
  for (let x = Math.max(0, lon2x(w, z)); x <= Math.min(max, lon2x(e, z)); x++) {
    for (let y = Math.max(0, lat2y(n, z)); y <= Math.min(max, lat2y(s, z)); y++) out.add(`${x}/${y}`);
  }
}

/** 中心线按不超过缓冲距一半的步长采样，每个采样点向四周扩展 buffer 后取相交瓦片 */
function addLineTiles(out, line, buffer, z) {
  const step = buffer / 2;
  for (let i = 0; i < line.length; i++) {
    const [x0, y0] = line[i];
    const [x1, y1] = line[Math.min(i + 1, line.length - 1)];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n;
      const y = y0 + ((y1 - y0) * k) / n;
      addBBoxTiles(out, [x - buffer, y - buffer, x + buffer, y + buffer], z);
    }
  }
}

function lineBBox(line, buffer) {
  const xs = line.map((p) => p[0]);
  const ys = line.map((p) => p[1]);
  return [Math.min(...xs) - buffer, Math.min(...ys) - buffer, Math.max(...xs) + buffer, Math.max(...ys) + buffer];
}

// ---------- 选景 ----------

const isoDate = (d) => d.toISOString().slice(0, 10);

/** 按前端 autoSearch 的两步检索，再按 rebuildStack 合成景序列：各分幅首选景在前，补缺景在后 */
async function pickStack(searchBoxes) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - AUTO_MONTHS);
  const start = isoDate(d);
  const end = isoDate(new Date());
  const known = new Map();
  for (const bbox of searchBoxes) {
    const base = { bbox, start, end };
    const clear = await searchScenes({ ...base, maxCloud: AUTO_CLOUD, maxItems: MAX_ITEMS });
    const covered = new Set(clear.map((s) => s.tile));
    const missing = tilesInBBox(bbox).filter((t) => !covered.has(t));
    const cloudy = missing.length
      ? await searchScenes({ ...base, maxCloud: 100, maxItems: CLOUDY_ITEMS, tiles: missing, clearFirst: true })
      : [];
    for (const s of [...clear, ...cloudy]) known.set(s.id, s);
  }
  const byTile = new Map();
  for (const s of known.values()) {
    const list = byTile.get(s.tile) ?? [];
    list.push(s);
    byTile.set(s.tile, list);
  }
  const top = [];
  const fill = [];
  for (const list of byTile.values()) {
    const [best, ...rest] = pickTile(list);
    top.push(best);
    fill.push(...rest);
  }
  return { tiles: byTile.size, top, fill, stack: [...top, ...fill] };
}

// ---------- 请求 ----------

let lastStart = 0;
async function throttle() {
  const wait = lastStart + MIN_INTERVAL_MS - Date.now();
  lastStart = Math.max(Date.now(), lastStart + MIN_INTERVAL_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 请求一个瓦片，429 等一分钟、5xx 与网络错误等 2 秒后重试，最多 3 次 */
async function warmTile(url) {
  for (let attempt = 1; ; attempt++) {
    await throttle();
    const t0 = performance.now();
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = resp.status === 200 ? await resp.arrayBuffer() : (await resp.text(), null);
      if (resp.status === 200 || resp.status === 204) {
        return { ok: true, status: resp.status, hit: resp.headers.get('x-cache') === 'HIT', bytes: body?.byteLength ?? 0, ms: performance.now() - t0 };
      }
      if (attempt >= 3 || (resp.status < 500 && resp.status !== 429)) return { ok: false, error: `HTTP ${resp.status}` };
      await sleep(resp.status === 429 ? 60_000 : 2000);
    } catch (err) {
      if (attempt >= 3) return { ok: false, error: String(err?.cause?.code ?? err?.name ?? err) };
      await sleep(2000);
    }
  }
}

async function runPool(urls, onDone) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      while (next < urls.length) {
        const url = urls[next++];
        onDone(url, await warmTile(url));
      }
    }),
  );
}

// ---------- 主流程 ----------

const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;
const fmtSec = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`);

console.log(
  `${opt['dry-run'] ? '预演' : '预热'} ${locations.length} 处，目标 ${target}，${zMin}–${zMax} 级，` +
    `${suffixes.map((s) => (s ? '512 像素' : '256 像素')).join('与')}瓦片${opt['dry-run'] ? '' : `，并发 ${concurrency}`}`,
);

const seen = new Set();
const total = { tiles: 0, requests: 0, dup: 0, hit: 0, miss: 0, empty: 0, failed: 0, bytes: 0, ms: 0 };
const failures = [];
const runStart = performance.now();

for (const [i, loc] of locations.entries()) {
  const label = `[${i + 1}/${locations.length}] ${loc.name}`;
  const searchBoxes = [...(loc.bboxes ?? []), ...(loc.lines ?? []).map((ln) => lineBBox(ln, loc.buffer))];
  let picked;
  try {
    picked = await pickStack(searchBoxes);
  } catch (err) {
    console.log(`${label}：选景失败，${err.message}`);
    failures.push(`${loc.id} 选景：${err.message}`);
    continue;
  }

  // 枚举各级瓦片，只留与至少一景相交的，前端对没有景的瓦片也不发请求
  const urls = [];
  const perZoom = [];
  let dup = 0;
  for (let z = zMin; z <= zMax; z++) {
    const xy = new Set();
    for (const b of loc.bboxes ?? []) addBBoxTiles(xy, b, z);
    for (const ln of loc.lines ?? []) addLineTiles(xy, ln, loc.buffer, z);
    let n = 0;
    for (const key of xy) {
      const [x, y] = key.split('/').map(Number);
      const b = tileBounds(z, x, y);
      const scenes = picked.stack.filter((s) => touchesTile(s, b)).slice(0, MAX_SCENES_PER_TILE);
      if (!scenes.length) continue;
      const ids = scenes.map((s) => s.id).join(',');
      for (const sfx of suffixes) {
        const url = `${target}/api/s2/${z}/${x}/${y}${sfx}.webp?ids=${ids}&sq=1`;
        n++;
        if (seen.has(url)) {
          dup++;
          continue;
        }
        seen.add(url);
        urls.push(url);
      }
    }
    perZoom.push(`z${z} ${n}`);
  }
  total.tiles += urls.length + dup;
  total.dup += dup;
  const dates = [...new Set(picked.top.map((s) => s.date))].sort();
  console.log(
    `${label}：分幅 ${picked.tiles}，首选景 ${picked.top.length}、补缺景 ${picked.fill.length}` +
      `（${dates[0] ?? '-'} 至 ${dates.at(-1) ?? '-'}）；瓦片 ${urls.length + dup}（${perZoom.join('，')}）` +
      (dup ? `，其中 ${dup} 个与前面地点重复` : ''),
  );
  if (opt['dry-run'] || !urls.length) continue;

  const st = { done: 0, hit: 0, miss: 0, empty: 0, failed: 0, bytes: 0, ms: 0 };
  const t0 = performance.now();
  let lastLog = t0;
  await runPool(urls, (url, r) => {
    st.done++;
    if (!r.ok) {
      st.failed++;
      failures.push(`${loc.id} ${url.replace(target, '').split('?')[0]}：${r.error}`);
    } else {
      if (r.status === 204) st.empty++;
      if (r.hit) st.hit++;
      else st.miss++;
      st.bytes += r.bytes;
      st.ms += r.ms;
    }
    const now = performance.now();
    if (now - lastLog > 10_000 || st.done === urls.length) {
      lastLog = now;
      const ok = st.done - st.failed;
      console.log(
        `    ${st.done}/${urls.length}  已缓存 ${st.hit}、新渲染 ${st.miss}、空 ${st.empty}、失败 ${st.failed}，` +
          `${fmtMB(st.bytes)}，平均 ${ok ? Math.round(st.ms / ok) : 0} 毫秒，用时 ${fmtSec(now - t0)}`,
      );
    }
  });
  total.requests += urls.length;
  for (const k of ['hit', 'miss', 'empty', 'failed', 'bytes', 'ms']) total[k] += st[k];
}

const elapsed = performance.now() - runStart;
if (opt['dry-run']) {
  console.log(`汇总：共 ${total.tiles} 个瓦片，去重后 ${total.tiles - total.dup} 个，检索用时 ${fmtSec(elapsed)}`);
} else {
  console.log(
    `汇总：请求 ${total.requests} 个瓦片（另有 ${total.dup} 个重复跳过），已缓存 ${total.hit}、新渲染 ${total.miss}、` +
      `空 ${total.empty}、失败 ${total.failed}，${fmtMB(total.bytes)}，总用时 ${fmtSec(elapsed)}`,
  );
}
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
  if (failures.length > 20) console.log(`  …另有 ${failures.length - 20} 项`);
  process.exitCode = 1;
}
