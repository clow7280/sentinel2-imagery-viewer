import { promisify } from 'node:util';
import { inflate } from 'node:zlib';
import { addDecoder, BaseDecoder, GeoTIFF, type GeoTIFFImage } from 'geotiff';
import proj4, { type Converter } from 'proj4';
import sharp from 'sharp';
import type { DiskCache } from './cache';
import { readCogRange } from './cog';

/** 瓦片合成所需的单景信息，来自 STAC 的 visual 资产 */
export interface SceneMeta {
  /** sentinel-cogs 桶内的对象路径 */
  path: string;
  epsg: number;
  /** proj:transform，c 与 f 为左上角 UTM 坐标 */
  transform: number[];
  /** proj:shape，[行数, 列数] */
  shape: [number, number];
}

const R = 6378137;
const ORIGIN = Math.PI * R;
/** 重投影控制格网的分段数，格网点精确投影，其余像元双线性插值 */
const GRID = 8;
/** 打开的 COG 句柄上限，超出后淘汰最久未用的 */
const COG_CACHE_LIMIT = 64;
/** 每批并发读取的景数 */
const BATCH = 3;
/** 允许的最大上采样倍数，1.5 倍以内肉眼难以察觉，读取量却可降到四分之一 */
const MAX_UPSAMPLE = 1.5;
const WEBP_QUALITY = 82;

// deflate 改用 Node 原生 zlib 异步解压，在线程池中执行，不阻塞事件循环
const inflateAsync = promisify(inflate);
class ZlibDecoder extends BaseDecoder {
  async decodeBlock(buffer: ArrayBufferLike): Promise<ArrayBuffer> {
    const out = await inflateAsync(new Uint8Array(buffer));
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  }
}
addDecoder([8, 32946], async () => ZlibDecoder as never, undefined, false);

interface Level {
  image: GeoTIFFImage;
  width: number;
  height: number;
  /** 该层像元的地面尺寸，单位米 */
  res: number;
}

/** geotiff 的数据源：按字节范围读取 COG，命中磁盘分块缓存，缺失时回源 */
function cogSource(cache: DiskCache, objPath: string) {
  let size: number | null = null;
  return {
    // geotiff 读窗口时会传入 readRasters 的 signal，中止后不再发起新的分块读取
    async fetch(slices: { offset: number; length: number }[], signal?: AbortSignal): Promise<ArrayBuffer[]> {
      signal?.throwIfAborted();
      return Promise.all(
        slices.map(async ({ offset, length }) => {
          const r = await readCogRange(cache, objPath, { start: offset, end: offset + length - 1 });
          size = r.total;
          const b = r.body;
          return b ? (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer) : new ArrayBuffer(0);
        }),
      );
    },
    get fileSize() {
      return size;
    },
    async close() {},
  };
}

const cogCache = new Map<string, Promise<Level[]>>();

function openCog(cache: DiskCache, scene: SceneMeta): Promise<Level[]> {
  const hit = cogCache.get(scene.path);
  if (hit) {
    cogCache.delete(scene.path);
    cogCache.set(scene.path, hit);
    return hit;
  }
  const p = (async () => {
    const tiff = await GeoTIFF.fromSource(cogSource(cache, scene.path) as never);
    const n = await tiff.getImageCount();
    const fullWidth = scene.shape[1];
    const images = await Promise.all(Array.from({ length: n }, (_, i) => tiff.getImage(i)));
    return images
      .map((image) => {
        const width = image.getWidth();
        return { image, width, height: image.getHeight(), res: (scene.transform[0] * fullWidth) / width };
      })
      .sort((a, b) => a.res - b.res);
  })();
  p.catch(() => cogCache.delete(scene.path));
  cogCache.set(scene.path, p);
  while (cogCache.size > COG_CACHE_LIMIT) cogCache.delete(cogCache.keys().next().value!);
  return p;
}

/** 选不超过上采样容限的最粗一层，兼顾清晰度与读取量 */
function pickLevel(levels: Level[], groundPx: number): Level {
  let best = levels[0];
  for (const lv of levels) if (lv.res <= groundPx * MAX_UPSAMPLE) best = lv;
  return best;
}

const converters = new Map<number, Converter>();
function converter(epsg: number): Converter {
  let c = converters.get(epsg);
  if (!c) {
    const zone = epsg % 100;
    const south = Math.floor(epsg / 100) === 327 ? ' +south' : '';
    c = proj4('EPSG:4326', `+proj=utm +zone=${zone}${south} +datum=WGS84 +units=m +no_defs`);
    converters.set(epsg, c);
  }
  return c;
}

interface Win {
  c0: number;
  r0: number;
  w: number;
  h: number;
}

/**
 * 景所属 MGRS 100 km 方格的 UTM 范围。Sentinel-2 分幅左上角与方格西北角相差几十米（如 199980、4100040），
 * 取整到最近的 100 km 即为方格西北角；分幅向东、向南各多出约 9.8 km 与相邻分幅重叠，
 * 每景只填自己的方格，影像接缝与前端画出的区域边界一致
 */
interface Square {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}
const SQUARE = 100_000;
function squareOf(scene: SceneMeta): Square {
  const xMin = Math.round(scene.transform[2] / SQUARE) * SQUARE;
  const yMax = Math.round(scene.transform[5] / SQUARE) * SQUARE;
  return { xMin, xMax: xMin + SQUARE, yMin: yMax - SQUARE, yMax };
}
const inSquare = (q: Square, x: number, y: number) => x >= q.xMin && x < q.xMax && y > q.yMin && y <= q.yMax;

/** 计算方格内未填像元落在某层上的最小读取窗口，完全不相交时返回 undefined */
function windowFor(ux: Float32Array, uy: Float32Array, filled: Uint8Array, scene: SceneMeta, lv: Level, sq: Square): Win | undefined {
  const x0 = scene.transform[2];
  const y0 = scene.transform[5];
  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (let k = 0; k < filled.length; k++) {
    if (filled[k] || !inSquare(sq, ux[k], uy[k])) continue;
    const c = (ux[k] - x0) / lv.res;
    const r = (y0 - uy[k]) / lv.res;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  }
  const c0 = Math.max(0, Math.floor(minC));
  const r0 = Math.max(0, Math.floor(minR));
  const c1 = Math.min(lv.width, Math.floor(maxC) + 1);
  const r1 = Math.min(lv.height, Math.floor(maxR) + 1);
  if (c0 >= c1 || r0 >= r1) return undefined;
  return { c0, r0, w: c1 - c0, h: r1 - r0 };
}

/** 瓦片的经纬度控制格网，各景按自身投影把它换算到 UTM */
interface TileGrid {
  size: number;
  lon: Float64Array;
  lat: Float64Array;
}

function tileGrid(z: number, x: number, y: number, size: number): TileGrid {
  const span = (2 * ORIGIN) / 2 ** z;
  const minX = -ORIGIN + x * span;
  const maxY = ORIGIN - y * span;
  const n = GRID + 1;
  const lon = new Float64Array(n * n);
  const lat = new Float64Array(n * n);
  for (let gj = 0; gj < n; gj++) {
    for (let gi = 0; gi < n; gi++) {
      const mx = minX + (gi / GRID) * span;
      const my = maxY - (gj / GRID) * span;
      lon[gj * n + gi] = (mx / R) * (180 / Math.PI);
      lat[gj * n + gi] = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI);
    }
  }
  return { size, lon, lat };
}

/** 一景在当前瓦片内的采样数据，供按优先级合成 */
interface Prepared {
  ux: Float32Array;
  uy: Float32Array;
  data: Uint8Array;
  win: Win;
  res: number;
  x0: number;
  y0: number;
  sq: Square;
}

/** 把瓦片未填像元换算到该景 UTM 坐标，并读取对应窗口的真彩色数据 */
async function prepare(
  cache: DiskCache,
  scene: SceneMeta,
  grid: TileGrid,
  filled: Uint8Array,
  signal?: AbortSignal,
): Promise<Prepared | undefined> {
  const { size } = grid;
  const n = GRID + 1;
  const conv = converter(scene.epsg);
  const gx = new Float64Array(n * n);
  const gy = new Float64Array(n * n);
  for (let k = 0; k < n * n; k++) {
    const [X, Y] = conv.forward([grid.lon[k], grid.lat[k]]);
    gx[k] = X;
    gy[k] = Y;
  }
  // UTM 坐标量级约 1e6，Float32 精度约 0.5 米，对 10 米像元足够
  const ux = new Float32Array(size * size);
  const uy = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const fy = ((j + 0.5) / size) * GRID;
    const j0 = Math.min(Math.floor(fy), GRID - 1);
    const ty = fy - j0;
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      if (filled[k]) continue;
      const fx = ((i + 0.5) / size) * GRID;
      const i0 = Math.min(Math.floor(fx), GRID - 1);
      const tx = fx - i0;
      const a = j0 * n + i0;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      ux[k] = (gx[a] * (1 - tx) + gx[b] * tx) * (1 - ty) + (gx[c] * (1 - tx) + gx[d] * tx) * ty;
      uy[k] = (gy[a] * (1 - tx) + gy[b] * tx) * (1 - ty) + (gy[c] * (1 - tx) + gy[d] * tx) * ty;
    }
  }
  const groundPx = Math.hypot(gx[GRID] - gx[0], gy[GRID] - gy[0]) / size;

  const lv = pickLevel(await openCog(cache, scene), groundPx);
  const sq = squareOf(scene);
  const win = windowFor(ux, uy, filled, scene, lv, sq);
  if (!win) return undefined;
  const data = (await lv.image.readRasters({
    window: [win.c0, win.r0, win.c0 + win.w, win.r0 + win.h],
    samples: [0, 1, 2],
    interleave: true,
    signal,
  })) as unknown as Uint8Array;
  return { ux, uy, data, win, res: lv.res, x0: scene.transform[2], y0: scene.transform[5], sq };
}

/** 把一景在其方格内的有效像元写入尚未填充的位置，返回新填充的像元数 */
function composite(p: Prepared, out: Uint8Array, filled: Uint8Array): number {
  let added = 0;
  for (let k = 0; k < filled.length; k++) {
    if (filled[k] || !inSquare(p.sq, p.ux[k], p.uy[k])) continue;
    const c = Math.floor((p.ux[k] - p.x0) / p.res) - p.win.c0;
    const r = Math.floor((p.y0 - p.uy[k]) / p.res) - p.win.r0;
    if (c < 0 || r < 0 || c >= p.win.w || r >= p.win.h) continue;
    const o = (r * p.win.w + c) * 3;
    const rv = p.data[o];
    const gv = p.data[o + 1];
    const bv = p.data[o + 2];
    if ((rv | gv | bv) === 0) continue;
    const q = k * 4;
    out[q] = rv;
    out[q + 1] = gv;
    out[q + 2] = bv;
    out[q + 3] = 255;
    filled[k] = 1;
    added++;
  }
  return added;
}

/**
 * 按优先级逐景合成 Web 墨卡托瓦片并编码为 WebP，瓦片内没有任何影像时返回 undefined。
 * 每批并发读取若干景以摊薄回源延迟，读完后仍按原顺序写入，排在前面的景优先占据像元
 * signal 中止后不再读取后续批次，抛出 AbortError
 */
export async function renderTile(
  cache: DiskCache,
  z: number,
  x: number,
  y: number,
  size: number,
  scenes: SceneMeta[],
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  const grid = tileGrid(z, x, y, size);
  const total = size * size;
  const out = new Uint8Array(total * 4);
  const filled = new Uint8Array(total);
  let remaining = total;

  for (let s = 0; s < scenes.length && remaining > 0; s += BATCH) {
    // 请求方都已离开时在读下一批景之前停下；批内读取在发起新的分块请求前也会停下，已发出的回源请求照常完成并写入分块缓存
    signal?.throwIfAborted();
    const batch = scenes.slice(s, s + BATCH);
    const prepared = await Promise.all(batch.map((sc) => prepare(cache, sc, grid, filled, signal)));
    for (const p of prepared) {
      if (p && remaining > 0) remaining -= composite(p, out, filled);
    }
  }
  if (remaining === total) return undefined;
  return sharp(out, { raw: { width: size, height: size, channels: 4 } })
    .webp({ quality: WEBP_QUALITY, alphaQuality: 100 })
    .toBuffer();
}
