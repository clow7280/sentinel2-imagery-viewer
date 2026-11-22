import type { GeoJSONSource, Map as MlMap, RasterTileSource } from 'maplibre-gl';
import { groupByDate, type DateGroup } from './composition';
import type { Info } from './info';
import type { ClickEvent } from './popup';
import { fillGaps, pickTile, tileAt, tileBBox, tileRing, tilesInBBox } from './regions';
import { scenesByIds, searchScenes } from './stac';
import { setStack } from './tiles';
import { Timeline } from './timeline';
import type { BBox, Scene } from './types';

/** 自动检索视野内影像的最低缩放级别 */
export const MIN_IMAGERY_ZOOM = 7;
/** 影像图层的最低缩放级别，与后端一致；低于检索级别时只显示已知景，主要是服务器已缓存的影像 */
const MIN_TILE_ZOOM = 4;
/** 自动挑选的时间窗，单位月 */
export const AUTO_MONTHS = 3;
/** 视野检索先只取云量不超过该值的景 */
const AUTO_CLOUD = 20;
/** 没有晴空景的区域补检时的条数上限 */
const CLOUDY_ITEMS = 300;
/** 区域边界用色，与界面的 sulu 色系一致 */
const SULU_100 = '#b8e876';
/** 检索范围上限，单位平方度，过大时一次检索会返回上千景 */
export const MAX_SEARCH_AREA = 36;
const MAX_ITEMS = 1500;
/** 检索范围按该粒度向外取整，小幅平移不重复检索，也便于后端按请求缓存，单位度 */
const BBOX_SNAP = 0.1;
/** 地图停止移动后多久自动检索 */
const MOVE_SEARCH_DELAY_MS = 600;
/** 已缓存影像列表的最短刷新间隔 */
const CACHED_REFRESH_MS = 15000;
/** 平均每月可用日期少于该数时提醒提高云量上限 */
const SPARSE_PER_MONTH = 1;

/**
 * 各区域保存的日期选择，连同所用的景存在浏览器本地，打开页面后不等检索就能显示。
 * 键为 MGRS 分幅
 */
const PICKS_KEY = 'sentinel2:region-picks';
interface RegionPick {
  date: string;
  scenes: Scene[];
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const bboxArea = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);

export interface ImageryOptions {
  /** 区域时间轴的面板 */
  timelineEl: HTMLElement;
  info: Info;
  /** 卫星影像图层是否打开 */
  isOn: () => boolean;
  /** 时间轴弹出后按图例位置重新排布 */
  layoutTimeline: () => void;
}

/**
 * 卫星影像与区域：维护已知的景，按 MGRS 分幅自动挑选或按保存的选择合成影像图层，
 * 地图停止移动后检索视野内的影像，点击区域弹出它的时间轴
 */
export function createImagery(map: MlMap, opts: ImageryOptions) {
  const { info } = opts;

  const savedPicks: Record<string, RegionPick> = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(PICKS_KEY) ?? '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  })();
  function storePicks() {
    try {
      localStorage.setItem(PICKS_KEY, JSON.stringify(savedPicks));
    } catch {
      // 存储空间不足或被禁用时只在本次会话内生效
    }
  }

  /** 已知的景，来自视野检索、区域检索、已保存的选择与服务器已缓存的影像，键为景编号 */
  const known = new Map<string, Scene>();
  for (const p of Object.values(savedPicks)) for (const s of p.scenes) known.set(s.id, s);
  /** 有已知景的分幅，点击这些区域才弹出时间轴 */
  const knownTiles = new Set<string>();
  /** 当前影像图层使用的景编号序列 */
  let appliedIds = '';

  const state = {
    /** 视野检索的参数，相同时不再重复检索 */
    autoKey: '',
    autoAbort: undefined as AbortController | undefined,
    /** 选中的区域，时间轴列出它的影像 */
    region: undefined as string | undefined,
    regionKey: '',
    regionAbort: undefined as AbortController | undefined,
    regionGroups: [] as DateGroup[],
    regionSearched: undefined as { start: string; end: string } | undefined,
    /** 时间轴中点选、尚未保存的日期 */
    preview: undefined as string | undefined,
  };

  const timeline = new Timeline(opts.timelineEl, {
    onChange: () => regionSearch(),
    onSelect: previewDate,
    onSave: savePick,
    onReset: resetPick,
    onClose: closeRegion,
  });

  function addLayers(beforeId: string | undefined) {
    map.addSource('s2', {
      type: 'raster',
      tiles: [setStack([])],
      tileSize: 256,
      minzoom: MIN_TILE_ZOOM,
      maxzoom: 15,
    });
    map.addLayer({ id: 's2', type: 'raster', source: 's2', paint: { 'raster-fade-duration': 0 } }, beforeId);
    // 影像边界即区域划分：每个有影像的 MGRS 分幅画出方格，选中的区域加粗
    map.addSource('regions', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer(
      {
        id: 'regions-line',
        type: 'line',
        source: 'regions',
        minzoom: MIN_TILE_ZOOM,
        paint: { 'line-color': SULU_100, 'line-width': 0.6, 'line-opacity': 0.5 },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'region-selected',
        type: 'line',
        source: 'regions',
        minzoom: MIN_TILE_ZOOM,
        filter: ['==', ['get', 'tile'], ''],
        paint: { 'line-color': SULU_100, 'line-width': 2, 'line-opacity': 0.8 },
      },
      beforeId,
    );
  }

  /** 当前视野按 BBOX_SNAP 向外取整后的检索范围 */
  function currentBBox(): BBox {
    const b = map.getBounds();
    const down = (v: number) => Math.floor(v / BBOX_SNAP) * BBOX_SNAP;
    const up = (v: number) => Math.ceil(v / BBOX_SNAP) * BBOX_SNAP;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return [
      r(Math.max(-180, down(b.getWest()))),
      r(Math.max(-85, down(b.getSouth()))),
      r(Math.min(180, up(b.getEast()))),
      r(Math.min(85, up(b.getNorth()))),
    ];
  }

  /** 缩放与视野范围足够小时才自动检索视野内的影像 */
  const inRange = () => map.getZoom() >= MIN_IMAGERY_ZOOM && bboxArea(currentBBox()) <= MAX_SEARCH_AREA;

  /** 自动挑选的时间窗起点，UTC 日期 */
  function autoStart(): string {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - AUTO_MONTHS);
    return isoDate(d);
  }

  function addKnown(scenes: Scene[]) {
    for (const s of scenes) known.set(s.id, s);
  }

  function tileScenes(tile: string): Scene[] {
    return [...known.values()].filter((s) => s.tile === tile);
  }

  /** 自动挑选的候选：时间窗内有景时只取窗内的，否则取全部已知景，例如只缓存了更早影像的区域 */
  function candidates(list: Scene[]): Scene[] {
    const from = autoStart();
    const recent = list.filter((s) => s.date >= from);
    return recent.length ? recent : list;
  }

  function autoPick(list: Scene[]): Scene[] {
    return pickTile(candidates(list));
  }

  /** 某区域正在显示的日期：时间轴中的预览优先，其次是保存的选择，最后是自动挑选 */
  function shownDate(tile: string): string | undefined {
    if (tile === state.region && state.preview) return state.preview;
    return savedPicks[tile]?.date ?? autoPick(tileScenes(tile))[0]?.date;
  }

  /**
   * 按区域合成影像图层的景序列：各区域的首选景排在前面，补缺测的景排在后面，
   * 单个瓦片的景数有上限时优先保住首选景。后端合成时每景只填自己的方格，区域之间互不遮挡
   */
  function rebuildStack() {
    const byTile = new Map<string, Scene[]>();
    for (const s of known.values()) {
      const list = byTile.get(s.tile) ?? [];
      list.push(s);
      byTile.set(s.tile, list);
    }
    const top: Scene[] = [];
    const fill: Scene[] = [];
    for (const [tile, list] of byTile) {
      const date = tile === state.region && state.preview ? state.preview : savedPicks[tile]?.date;
      const picked = date ? list.filter((s) => s.date === date).sort((a, b) => a.cloud - b.cloud) : [];
      if (picked.length) {
        // 手动选的日期有缺测时，同样用其他轨道的景在下层补齐
        top.push(...picked);
        fill.push(...fillGaps(picked, candidates(list)));
        continue;
      }
      const [best, ...rest] = autoPick(list);
      top.push(best);
      fill.push(...rest);
    }
    const stack = [...top, ...fill];
    const ids = stack.map((s) => s.id).join(',');
    if (ids !== appliedIds) {
      appliedIds = ids;
      map.getSource<RasterTileSource>('s2')?.setTiles([setStack(stack)]);
    }
    if (byTile.size !== knownTiles.size) {
      for (const t of byTile.keys()) knownTiles.add(t);
      map.getSource<GeoJSONSource>('regions')?.setData({
        type: 'FeatureCollection',
        features: [...knownTiles].map((tile) => ({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [tileRing(tile)] },
          properties: { tile },
        })),
      });
    }
    syncTimeline();
  }

  /**
   * 自动检索视野内近 AUTO_MONTHS 个月的影像。先只取云量不超过 AUTO_CLOUD 的景，
   * 多数区域在其中就能挑出最佳影像；一景都没有的区域再按云量从低到高补检，只取前 CLOUDY_ITEMS 条
   */
  async function autoSearch() {
    if (!inRange()) return;
    const bbox = currentBBox();
    const start = autoStart();
    const end = isoDate(new Date());
    const key = JSON.stringify([bbox, start]);
    if (key === state.autoKey) return;
    state.autoAbort?.abort();
    const ac = new AbortController();
    state.autoAbort = ac;
    const job = info.beginSearch(`视野内近 ${AUTO_MONTHS} 个月的影像`);
    try {
      const base = { bbox, start, end };
      const clear = await searchScenes({ ...base, maxCloud: AUTO_CLOUD, maxItems: MAX_ITEMS }, ac.signal, (n) => (job.found = n));
      const covered = new Set(clear.scenes.map((s) => s.tile));
      const missing = tilesInBBox(bbox).filter((t) => !covered.has(t));
      const cloudy = missing.length
        ? await searchScenes(
            { ...base, maxCloud: 100, maxItems: CLOUDY_ITEMS, tiles: missing, clearFirst: true },
            ac.signal,
            (n) => (job.found = clear.scenes.length + n),
          )
        : { scenes: [] };
      state.autoKey = key;
      addKnown([...clear.scenes, ...cloudy.scenes]);
      rebuildStack();
    } catch (err) {
      if (!ac.signal.aborted) info.reportError('视野影像检索失败', err);
    } finally {
      info.endSearch(job);
    }
  }

  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  map.on('moveend', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(autoSearch, MOVE_SEARCH_DELAY_MS);
  });

  /** 按时间轴的时间段与云量上限检索选中区域的影像，参数与上次相同时跳过 */
  async function regionSearch() {
    const tile = state.region;
    if (!tile) return;
    const { start, end } = timeline.range();
    const maxCloud = timeline.cloud();
    const key = JSON.stringify([tile, start, end, maxCloud]);
    if (key === state.regionKey) return;
    state.regionAbort?.abort();
    const ac = new AbortController();
    state.regionAbort = ac;
    const job = info.beginSearch(`区域 ${tile} 的影像`);
    try {
      const { scenes, truncated } = await searchScenes(
        { bbox: tileBBox(tile), start, end, maxCloud, maxItems: MAX_ITEMS, tiles: [tile] },
        ac.signal,
        (n) => (job.found = n),
      );
      state.regionKey = key;
      state.regionGroups = groupByDate(scenes);
      state.regionSearched = { start, end };
      const n = state.regionGroups.length;
      const months = (Date.parse(end) - Date.parse(start) + 86400_000) / (30.44 * 86400_000);
      const sparse = maxCloud < 100 && n / months < SPARSE_PER_MONTH;
      const hint = sparse ? '，偏少，可提高云量上限' : '';
      timeline.setStatus(
        n ? `${n} 个日期有影像${truncated ? `，已达上限 ${MAX_ITEMS} 条，可缩短时间段` : hint}` : `没有符合条件的影像${hint}`,
        sparse && !truncated,
      );
      addKnown(scenes);
      rebuildStack();
    } catch (err) {
      if (!ac.signal.aborted) {
        timeline.setStatus('检索失败');
        info.reportError(`区域 ${tile} 影像检索失败`, err);
      }
    } finally {
      info.endSearch(job);
    }
  }

  /** 把区域状态同步到时间轴：日期柱、自动挑选的星标、正在显示的日期与按钮状态 */
  function syncTimeline() {
    const tile = state.region;
    if (!tile) return;
    const saved = savedPicks[tile]?.date;
    timeline.setPickState(!!saved, !!state.preview && state.preview !== saved);
    if (!state.regionSearched) return;
    timeline.setGroups(state.regionGroups, autoPick(tileScenes(tile))[0]?.date, shownDate(tile), state.regionSearched);
  }

  /** 点击区域：高亮该区域并在底部弹出它的时间轴，再次点击同一区域则收起 */
  function openRegion(tile: string) {
    if (tile === state.region) {
      closeRegion();
      return;
    }
    if (state.region) closeRegion();
    state.region = tile;
    state.regionKey = '';
    state.regionGroups = [];
    state.regionSearched = undefined;
    timeline.setRegion(tile);
    opts.timelineEl.hidden = false;
    opts.layoutTimeline();
    map.setFilter('region-selected', ['==', ['get', 'tile'], tile]);
    syncTimeline();
    regionSearch();
  }

  /** 关闭时间轴并取消选择区域，未保存的预览恢复为原来的影像 */
  function closeRegion() {
    state.regionAbort?.abort();
    state.region = undefined;
    state.preview = undefined;
    opts.timelineEl.hidden = true;
    map.setFilter('region-selected', ['==', ['get', 'tile'], '']);
    rebuildStack();
  }

  function previewDate(date: string) {
    if (!state.region) return;
    state.preview = date;
    rebuildStack();
  }

  function savePick() {
    const tile = state.region;
    if (!tile || !state.preview) return;
    const date = state.preview;
    savedPicks[tile] = { date, scenes: tileScenes(tile).filter((s) => s.date === date) };
    storePicks();
    state.preview = undefined;
    rebuildStack();
  }

  function resetPick() {
    const tile = state.region;
    if (!tile) return;
    delete savedPicks[tile];
    storePicks();
    state.preview = undefined;
    rebuildStack();
  }

  let cachedAt = 0;
  let cachedLoading = false;
  let cachedTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 读取服务器已缓存的景编号，未知的经 STAC 按编号补取元数据后参与各区域的挑选，
   * 缩小到检索级别以下时已缓存区域仍显示影像。
   * 两次读取至少间隔 CACHED_REFRESH_MS，间隔内的调用合并为间隔结束时的一次
   */
  async function refreshCached() {
    const wait = cachedAt + CACHED_REFRESH_MS - Date.now();
    if (cachedLoading || wait > 0) {
      cachedTimer ??= setTimeout(() => {
        cachedTimer = undefined;
        refreshCached();
      }, Math.max(wait, 1000));
      return;
    }
    cachedLoading = true;
    cachedAt = Date.now();
    try {
      const ids: string[] = await (await fetch('/api/cached-scenes')).json();
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length) {
        addKnown(await scenesByIds(missing));
        rebuildStack();
      }
    } catch (err) {
      info.reportError('已缓存影像读取失败', err);
    } finally {
      cachedLoading = false;
    }
  }

  return {
    addLayers,
    /** 图层加入后按已知景合成影像，并读取服务器缓存、检索视野 */
    start() {
      rebuildStack();
      refreshCached();
      autoSearch();
    },
    refreshCached,
    inRange,
    /** 点中有影像的区域时弹出该区域的时间轴 */
    handleClick(ev: ClickEvent) {
      if (!opts.isOn() || map.getZoom() < MIN_TILE_ZOOM) return;
      const tile = tileAt(ev.lngLat.lng, ev.lngLat.lat);
      if (tile && knownTiles.has(tile)) openRegion(tile);
    },
  };
}
