import {
  addProtocol,
  GeoJSONSource,
  Map as MlMap,
  Popup,
  RasterTileSource,
  ScaleControl,
  setWorkerUrl,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 默认按自身模块地址推算 Worker 路径，经 Vite 打包后会失效，改为单独打包后显式指定
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import { groupByDate, recommendBase, sceneContains, singleDay, type DateGroup } from './composition';
import { dailyPlan, planCollection, type DailyPlan } from './acquisition';
import { loadSats, orbitFeatures, type Sat } from './orbits';
import { Protocol as PmtilesProtocol } from 'pmtiles';
import { sceneGeometries, searchScenes } from './stac';
import { registerProtocol, setStack, tileStats } from './tiles';
import { Timeline } from './timeline';
import type { BBox, Scene } from './types';

const MIN_IMAGERY_ZOOM = 7;
/** 地图图层用色，与界面的 sulu 色系一致，补洞景与卫星轨迹用天蓝色区分 */
const SULU_100 = '#b8e876';
const SULU_400 = '#84a753';
const SULU_600 = '#587136';
const SKY = '#0ea5e9';
const SKY_DARK = '#0369a1';
const LANE = '#ea580c';
const ARCTIC = '#7c3aed';
const ARCTIC_LAYERS = ['arctic', 'arctic-schematic'];
/** 航路线条整体降低的不透明度比例 */
const ROUTE_OPACITY = 0.8;
/** 缩放级别不超过该值时显示采集计划与卫星扫描带 */
const OVERVIEW_MAX_ZOOM = 4;
const ORBIT_REFRESH_MS = 10000;
/** 检索范围上限，单位平方度，过大时一次检索会返回上千景 */
const MAX_SEARCH_AREA = 36;
const MAX_ITEMS = 1500;
/** 检索范围按该粒度向外取整，小幅平移不重复检索，也便于后端按请求缓存，单位度 */
const BBOX_SNAP = 0.1;
/** 地图停止移动后多久自动检索 */
const MOVE_SEARCH_DELAY_MS = 600;
/** 已缓存影像边界的最短刷新间隔 */
const CACHED_REFRESH_MS = 15000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  timeline: $('timeline'),
  info: $('info'),
  about: $<HTMLDialogElement>('about'),
  aboutOpen: $('about-open'),
  aboutClose: $('about-close'),
};

/**
 * 上次显示的景序列存在本地，下次打开时先按它请求瓦片，已缓存的区域不必等检索返回就能显示；
 * 检索返回后若该日期仍在结果中则保持选中，景序列不变时不重新请求
 */
const LAST_STACK_KEY = 'sentinel2:last-stack';
const lastStack: { date: string; scenes: Scene[] } | undefined = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_STACK_KEY) ?? 'null');
    return v && typeof v.date === 'string' && Array.isArray(v.scenes) ? v : undefined;
  } catch {
    return undefined;
  }
})();
/** 当前影像图层使用的景编号序列 */
let appliedIds = lastStack?.scenes.map((s) => s.id).join(',') ?? '';

const state = {
  scenes: [] as Scene[],
  groups: [] as DateGroup[],
  recommended: undefined as string | undefined,
  selected: lastStack?.date,
  searchAbort: undefined as AbortController | undefined,
  /** 最近一次检索的参数，相同时不再重复检索 */
  searchKey: '',
  searching: false,
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

setWorkerUrl(maplibreWorkerUrl);
registerProtocol();
// 中国视角边界瓦片打包为 PMTiles，按字节范围直接读取静态文件
addProtocol('pmtiles', new PmtilesProtocol().tile);

/**
 * 中国视角底图样式由 web/scripts/sync-basemap.mjs 从 osm-cn-basemap 同步，路径从站点根目录起算，
 * MapLibre 要求绝对地址，加载时补上当前站点；同时加上地球投影外围的大气层
 */
function absolutizeStyle(_prev: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification {
  const abs = (u: string) =>
    u.startsWith('/') ? location.origin + u : u.replace('pmtiles:///', `pmtiles://${location.origin}/`);
  const sources = Object.fromEntries(
    Object.entries(next.sources).map(([id, src]) => {
      const out = { ...src } as { url?: string; tiles?: string[] };
      if (out.url) out.url = abs(out.url);
      if (out.tiles) out.tiles = out.tiles.map(abs);
      return [id, out];
    }),
  ) as StyleSpecification['sources'];
  return {
    ...next,
    sprite: typeof next.sprite === 'string' ? abs(next.sprite) : next.sprite,
    glyphs: next.glyphs && abs(next.glyphs),
    sources,
    sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
  };
}

const map = new MlMap({
  container: 'map',
  hash: true,
  center: [119.5, 37.75],
  zoom: 8,
  minZoom: 0,
  maxZoom: 18,
  // 底行只保留必需的简短署名，完整的版权声明在关于窗口的数据标签页
  attributionControl: false,
  // 国界与注记按中国视角绘制，矢量瓦片仍来自 OpenFreeMap，经后端转发
  style: `${location.origin}/basemap/style.json`,
  transformStyle: absolutizeStyle,
  // 中日韩字符用本机字体渲染，不下载对应的字形
  localIdeographFontFamily: "'PingFang SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif",
});
// 样式加载后切到地球投影：缩小时为三维地球，放大后自动过渡为墨卡托平面
map.on('style.load', () => map.setProjection({ type: 'globe' }));
/**
 * 左下角底行：比例尺、鼠标所指经纬度与缩放级别、底图署名。
 * OSMF 署名指南要求署名无需交互即可见，完整的版权声明在关于窗口的数据标签页
 */
const scaleEl = new ScaleControl({ unit: 'metric' }).onAdd(map);
// 去掉 maplibregl-ctrl 类，避免角落容器的外边距与浮动规则作用到行内元素
scaleEl.classList.remove('maplibregl-ctrl');
scaleEl.classList.add('map-scale-text');
const cursorInfo = document.createElement('span');
cursorInfo.className = 'map-scale-text';
const credit = document.createElement('span');
credit.className = 'map-scale-text';
credit.innerHTML =
  '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '<a href="https://openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>';
const baseRow = document.createElement('div');
baseRow.className = 'maplibregl-ctrl flex items-end gap-1.5';
baseRow.append(scaleEl, cursorInfo, credit);
map.addControl({ onAdd: () => baseRow, onRemove: () => baseRow.remove() }, 'bottom-left');
let cursor: { lng: number; lat: number } | undefined;
function updateCursorInfo() {
  const pos = cursor ? `${cursor.lat.toFixed(5)}°, ${cursor.lng.toFixed(5)}°` : '—';
  cursorInfo.textContent = `${pos} · 缩放 ${map.getZoom().toFixed(2)}`;
}
map.on('mousemove', (ev) => {
  cursor = ev.lngLat;
  updateCursorInfo();
});
map.on('mouseout', () => {
  cursor = undefined;
  updateCursorInfo();
});
map.on('zoom', updateCursorInfo);
updateCursorInfo();

/** 底图中的注记图层 */
let labelLayers: string[] = [];

function addImageryLayers() {
  // 底图样式中注记层与道路层交错，只取末尾连续的注记层；
  // 影像与各叠加层插在中国视角边界之下，边界与注记压在影像之上
  const layers = map.getStyle().layers;
  let tail = layers.length;
  while (tail > 0 && layers[tail - 1].type === 'symbol') tail--;
  labelLayers = layers.slice(tail).map((l) => l.id);
  const beforeId = layers.find((l) => l.id.startsWith('cn-boundary'))?.id ?? labelLayers[0];
  map.addSource('s2', {
    type: 'raster',
    tiles: [setStack(lastStack?.scenes ?? [])],
    tileSize: 256,
    minzoom: MIN_IMAGERY_ZOOM,
    maxzoom: 15,
  });
  map.addLayer({ id: 's2', type: 'raster', source: 's2', paint: { 'raster-fade-duration': 0 } }, beforeId);
  // 服务器已缓存影像的覆盖范围，同一位置缓存的日期越多填充越深
  map.addSource('cached', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer(
    { id: 'cached-fill', type: 'fill', source: 'cached', paint: { 'fill-color': SULU_400, 'fill-opacity': 0.08 } },
    beforeId,
  );
  map.addLayer(
    {
      id: 'cached-line',
      type: 'line',
      source: 'cached',
      paint: { 'line-color': SULU_100, 'line-width': 1, 'line-opacity': 0.8 },
    },
    beforeId,
  );
  // OpenSeaMap 航标、灯塔、港口等海图要素，透明 PNG 叠加在影像之上、地名注记之下
  map.addSource('seamark', {
    type: 'raster',
    tiles: [`${location.origin}/api/seamark/{z}/{x}/{y}.png`],
    tileSize: 256,
    maxzoom: 18,
  });
  map.addLayer({ id: 'seamark', type: 'raster', source: 'seamark' }, beforeId);
  // 航路图层：大洋航路与北极航道共用一个开关，以颜色区分
  // 大洋航路，按 CIA 2012 年世界海洋图数字化，分主要、次要、支线三级
  map.addSource('lanes', {
    type: 'geojson',
    data: `${import.meta.env.BASE_URL}shipping-lanes.geojson`,
  });
  const laneWidth = (major: number, middle: number, minor: number) =>
    ['match', ['get', 'type'], 'Major', major, 'Middle', middle, minor] as unknown as number;
  map.addLayer(
    {
      id: 'lanes',
      type: 'line',
      source: 'lanes',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': LANE,
        'line-opacity': ['match', ['get', 'type'], 'Major', 0.9 * ROUTE_OPACITY, 'Middle', 0.75 * ROUTE_OPACITY, 0.55 * ROUTE_OPACITY],
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          1,
          laneWidth(1.6, 1, 0.5),
          8,
          laneWidth(3.5, 2.2, 1.2),
        ],
      },
    },
    beforeId,
  );
  // 北极航道，实线取自 Eurostat MARNET，虚线为按公开资料人工数字化的示意走向
  map.addSource('arctic', {
    type: 'geojson',
    data: `${import.meta.env.BASE_URL}arctic-routes.geojson`,
  });
  const arcticWidth = ['interpolate', ['linear'], ['zoom'], 1, 1.8, 8, 3.5] as unknown as number;
  for (const [id, schematic] of [
    ['arctic', false],
    ['arctic-schematic', true],
  ] as const) {
    map.addLayer(
      {
        id,
        type: 'line',
        source: 'arctic',
        filter: ['==', ['get', 'schematic'], schematic],
        layout: { 'line-join': 'round', 'line-cap': schematic ? 'butt' : 'round' },
        paint: {
          'line-color': ARCTIC,
          'line-opacity': 0.85 * ROUTE_OPACITY,
          'line-width': arcticWidth,
          ...(schematic && { 'line-dasharray': [2.5, 1.5] }),
        },
      },
      beforeId,
    );
  }
  addOverviewLayers(beforeId);
}

/** 低缩放级别的全球观测范围、卫星扫描带、地面轨迹与当前位置 */
function addOverviewLayers(beforeId: string | undefined) {
  // 图层 maxzoom 不含自身，略微放宽让整 4 级仍然显示
  const maxzoom = OVERVIEW_MAX_ZOOM + 0.001;
  map.addSource('plan', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('orbits', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const kind = (k: string) => ['==', ['get', 'kind'], k] as ['==', ['get', string], string];
  for (const layer of [
    { id: 'plan-fill', type: 'fill', source: 'plan', maxzoom, paint: { 'fill-color': SULU_400, 'fill-opacity': ['case', ['get', 'done'], 0.5, 0.2] } },
    { id: 'plan-line', type: 'line', source: 'plan', maxzoom, paint: { 'line-color': SULU_600, 'line-opacity': 0.7, 'line-width': 0.6 } },
    { id: 'swath', type: 'fill', source: 'orbits', maxzoom, filter: kind('swath'), paint: { 'fill-color': SKY, 'fill-opacity': 0.16, 'fill-antialias': false } },
    { id: 'track-past', type: 'line', source: 'orbits', maxzoom, filter: kind('past'), paint: { 'line-color': SKY_DARK, 'line-width': 1.2 } },
    { id: 'track-future', type: 'line', source: 'orbits', maxzoom, filter: kind('future'), paint: { 'line-color': SKY_DARK, 'line-width': 1.2, 'line-dasharray': [2, 2] } },
    { id: 'sat-point', type: 'circle', source: 'orbits', maxzoom, filter: kind('sat'), paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': SKY_DARK, 'circle-stroke-width': 2 } },
    {
      id: 'sat-label',
      type: 'symbol',
      source: 'orbits',
      maxzoom,
      filter: kind('sat'),
      layout: { 'text-field': ['get', 'sat'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
      paint: { 'text-color': SKY_DARK, 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    },
  ] as const) {
    map.addLayer(layer as Parameters<typeof map.addLayer>[0], beforeId);
  }
}

const overviewVisible = () => map.getZoom() <= OVERVIEW_MAX_ZOOM;

/**
 * 右下角图层控制，分影像与参考两组，采集计划的日期选择嵌在该项下方；
 * 采集计划与扫描带只在缩放不超过 OVERVIEW_MAX_ZOOM 时可见，开关也只在此时显示
 */
interface Overlay {
  key: string;
  label: string;
  group: string;
  overview?: boolean;
  layers: () => readonly string[];
}
const OVERLAYS: Overlay[] = [
  { key: 's2', group: '影像', label: '卫星影像', layers: () => ['s2'] },
  { key: 'cached', group: '影像', label: '影像边界', layers: () => ['cached-fill', 'cached-line'] },
  { key: 'labels', group: '参考', label: '地名注记', layers: () => labelLayers },
  { key: 'seamark', group: '参考', label: '海图标志', layers: () => ['seamark'] },
  { key: 'routes', group: '参考', label: '主要航路', layers: () => ['lanes', ...ARCTIC_LAYERS] },
  { key: 'plan', group: '参考', overview: true, label: '采集计划', layers: () => ['plan-fill', 'plan-line'] },
  {
    key: 'orbits',
    group: '参考',
    overview: true,
    label: '扫描带',
    layers: () => ['swath', 'track-past', 'track-future', 'sat-point', 'sat-label'],
  },
];
const overlayOn: Record<string, boolean> = Object.fromEntries(OVERLAYS.map((o) => [o.key, true]));

const PLAN_OPTS =
  '<div data-plan-opts class="mt-0.5 mb-1 ml-5 flex flex-wrap items-center gap-x-1.5 text-stone-500">' +
  '<input type="date" class="field-input py-0 text-xs" />UTC' +
  '<span data-plan class="basis-full empty:hidden"></span></div>';

const layerPanel = document.createElement('div');
layerPanel.className =
  'maplibregl-ctrl w-56 rounded-lg bg-white/95 px-3.5 py-2.5 text-[13px] text-stone-700 shadow-sm ring-1 ring-stone-200';
layerPanel.innerHTML =
  '<div class="text-sm font-semibold text-stone-800">图层</div>' +
  [...new Set(OVERLAYS.map((o) => o.group))]
    .map(
      (group) =>
        '<div class="mt-2">' +
        `<div class="mb-0.5 text-xs text-stone-400">${group}</div>` +
        OVERLAYS.filter((o) => o.group === group)
          .map(
            (o) =>
              `<label data-row="${o.key}" class="flex cursor-pointer items-center gap-1.5 py-0.5"><input type="checkbox" data-overlay="${o.key}" checked />${o.label}</label>` +
              (o.key === 'plan' ? PLAN_OPTS : ''),
          )
          .join('') +
        '</div>',
    )
    .join('');
const planOpts = layerPanel.querySelector<HTMLElement>('[data-plan-opts]')!;
const planDate = planOpts.querySelector('input')!;
const planInfo = planOpts.querySelector<HTMLElement>('[data-plan]')!;
planDate.value = isoDate(new Date());

function setOverlay(overlay: Overlay, on: boolean) {
  overlayOn[overlay.key] = on;
  for (const id of overlay.layers()) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  refreshOverview();
}
layerPanel.addEventListener('change', (ev) => {
  const input = ev.target as HTMLInputElement;
  const overlay = OVERLAYS.find((o) => o.key === input.dataset.overlay);
  if (overlay) setOverlay(overlay, input.checked);
});
map.addControl({ onAdd: () => layerPanel, onRemove: () => layerPanel.remove() }, 'top-right');

/** 左下角图例，只列出当前可见的矢量图层 */
const swatchLine = (cls: string, text: string) =>
  `<span class="inline-flex items-center gap-1"><i class="inline-block w-3.5 border-t-2 ${cls}"></i>${text}</span>`;
const swatchBox = (cls: string, text: string) =>
  `<span class="inline-flex items-center gap-1"><i class="inline-block h-2.5 w-3.5 border ${cls}"></i>${text}</span>`;
const LEGEND: { key: string; overview: boolean; title: string; items: string[] }[] = [
  {
    key: 'cached',
    overview: false,
    title: '影像边界',
    items: [swatchBox('border-sulu-100 bg-sulu-400/20', '已缓存区域')],
  },
  {
    key: 'routes',
    overview: false,
    title: '主要航路',
    items: [
      swatchLine('border-orange-600/80', '大洋航路'),
      swatchLine('border-violet-600/80', '北极航道'),
      swatchLine('border-dashed border-violet-600/80', '北极航道（推算）'),
    ],
  },
  {
    key: 'plan',
    overview: true,
    title: '本日采集计划',
    items: [swatchBox('border-sulu-600 bg-sulu-400/60', '已采集'), swatchBox('border-sulu-600 bg-sulu-400/25', '待采集')],
  },
  {
    key: 'orbits',
    overview: true,
    title: '近 1 小时扫描带',
    items: [
      swatchBox('border-sky-700 bg-sky-500/20', '成像扫描带'),
      swatchLine('border-sky-700', '已飞过的轨迹'),
      swatchLine('border-dashed border-sky-700', '将飞过的轨迹'),
    ],
  },
];
const legend = document.createElement('div');
legend.className =
  'maplibregl-ctrl grid max-w-80 grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded bg-white/90 px-2.5 py-1.5 text-[11px] text-stone-700 shadow-sm ring-1 ring-stone-200';
legend.innerHTML = LEGEND.map(
  (l) =>
    `<div data-legend="${l.key}" class="contents"><span class="text-stone-500">${l.title}</span>` +
    `<span class="flex flex-wrap gap-x-2.5">${l.items.join('')}</span></div>`,
).join('');
map.addControl({ onAdd: () => legend, onRemove: () => legend.remove() }, 'bottom-right');
/**
 * 时间轴默认居中；居中会压到右下角图例时向左让开，仍放不下再收窄。
 * 宽度与位置写成内联样式，覆盖 index.html 中的居中类
 */
const GAP = 10;
/** 44rem */
const TIMELINE_WIDTH = 704;
function layoutTimeline() {
  const W = window.innerWidth;
  const lw = legend.offsetWidth;
  const right = lw ? W - lw - 2 * GAP : W - GAP;
  const width = Math.min(TIMELINE_WIDTH, W - 2 * GAP, right - GAP);
  const left = Math.max(GAP, Math.min((W - width) / 2, right - width));
  Object.assign(ui.timeline.style, { left: `${left}px`, width: `${width}px`, maxWidth: 'none', translate: 'none' });
}
new ResizeObserver(layoutTimeline).observe(legend);
window.addEventListener('resize', layoutTimeline);

function updateLegend() {
  const zoomOk = overviewVisible();
  let any = false;
  for (const l of LEGEND) {
    const show = overlayOn[l.key] && (!l.overview || zoomOk);
    legend.querySelector<HTMLElement>(`[data-legend="${l.key}"]`)!.hidden = !show;
    any ||= show;
  }
  legend.hidden = !any;
  for (const o of OVERLAYS) {
    if (o.overview) layerPanel.querySelector<HTMLElement>(`[data-row="${o.key}"]`)!.hidden = !zoomOk;
  }
  planOpts.hidden = !(zoomOk && overlayOn.plan);
}

let sats: Sat[] = [];
let plan: DailyPlan | undefined;

async function loadPlan() {
  const day = planDate.value;
  plan = undefined;
  map.getSource<GeoJSONSource>('plan')?.setData({ type: 'FeatureCollection', features: [] });
  planInfo.textContent = '正在读取';
  try {
    const result = await dailyPlan(day);
    if (planDate.value !== day) return;
    plan = result;
    const failed = result.failed.length ? `${result.failed.join('、')} 有计划文件获取失败，切换日期可重试` : '';
    planInfo.textContent = result.features.length ? failed : '该日没有已发布的采集计划';
    refreshOverview();
  } catch (err) {
    if (planDate.value === day) planInfo.textContent = '读取失败，切换日期可重试';
    reportError('采集计划读取失败', err);
  }
}

/** 卫星位置的推算时刻，弹窗中显示 */
let orbitTime = new Date();

function refreshOverview() {
  updateLegend();
  const visible = overviewVisible();
  if (!visible || !map.getSource('orbits')) return;
  const now = new Date();
  if (plan && overlayOn.plan) map.getSource<GeoJSONSource>('plan')!.setData(planCollection(plan, now.getTime()));
  if (!sats.length || !overlayOn.orbits) return;
  orbitTime = now;
  map.getSource<GeoJSONSource>('orbits')!.setData(orbitFeatures(sats, now));
}

planDate.addEventListener('change', loadPlan);
loadSats()
  .then((list) => {
    sats = list;
    refreshOverview();
  })
  .catch((err) => reportError('卫星轨道根数读取失败', err));
setInterval(refreshOverview, ORBIT_REFRESH_MS);
map.on('zoomend', refreshOverview);

const timeline = new Timeline(ui.timeline, { onChange: () => runSearch(), onSelect: selectDate });

function setStatus(text: string, warn = false) {
  timeline.setStatus(text, warn);
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

const bboxArea = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);

/** 视野足够小时才检索，缩放到影像显示级别以上才显示影像 */
const imageryInRange = () => map.getZoom() >= MIN_IMAGERY_ZOOM && bboxArea(currentBBox()) <= MAX_SEARCH_AREA;

/** 平均每月可用日期少于该数时提醒提高云量上限 */
const SPARSE_PER_MONTH = 1;

/** 按当前视野与时间轴的时间段、云量上限检索，参数与上次相同时跳过 */
async function runSearch() {
  const bbox = currentBBox();
  if (bboxArea(bbox) > MAX_SEARCH_AREA) {
    setStatus('');
    return;
  }
  const { start, end } = timeline.range();
  const maxCloud = timeline.cloud();
  const key = JSON.stringify([bbox, start, end, maxCloud]);
  if (key === state.searchKey) return;
  state.searchAbort?.abort();
  const ac = new AbortController();
  state.searchAbort = ac;
  setStatus('检索中');
  state.searching = true;
  try {
    const { scenes, truncated } = await searchScenes(
      { bbox, start, end, maxCloud, maxItems: MAX_ITEMS },
      ac.signal,
      (n) => setStatus(`检索中，已获取 ${n} 景`),
    );
    state.searchKey = key;
    state.scenes = scenes;
    state.groups = groupByDate(scenes, bbox);
    state.recommended = recommendBase(state.groups);
    if (!state.groups.some((g) => g.date === state.selected)) state.selected = state.recommended;
    const months = (Date.parse(end) - Date.parse(start) + 86400_000) / (30.44 * 86400_000);
    const sparse = maxCloud < 100 && state.groups.length / months < SPARSE_PER_MONTH;
    const hint = sparse ? '，结果偏少，可提高云量上限' : '';
    setStatus(
      scenes.length
        ? `${state.groups.length} 个日期，${scenes.length} 景${truncated ? `，已达上限 ${MAX_ITEMS} 条，可缩短时间段` : hint}`
        : `没有符合条件的影像${hint}`,
      sparse && !truncated,
    );
    timeline.setGroups(state.groups, state.recommended, state.selected, { start, end });
    applyStack();
  } catch (err) {
    if (!ac.signal.aborted) {
      setStatus('检索失败');
      reportError('影像检索失败', err);
    }
  } finally {
    if (state.searchAbort === ac) state.searching = false;
  }
}

let moveTimer: ReturnType<typeof setTimeout> | undefined;
map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(runSearch, MOVE_SEARCH_DELAY_MS);
});

/** 景的成像时刻，取自 STAC datetime，即该 MGRS 瓦片的传感时间，UTC */
const utcTime = (s: Scene) => s.datetime.slice(11, 19);

function applyStack() {
  const stack = state.selected ? singleDay(state.groups, state.selected) : [];
  const ids = stack.map((s) => s.id).join(',');
  if (ids === appliedIds) return;
  appliedIds = ids;
  map.getSource<RasterTileSource>('s2')?.setTiles([setStack(stack)]);
  if (!stack.length) return;
  try {
    localStorage.setItem(LAST_STACK_KEY, JSON.stringify({ date: state.selected, scenes: stack }));
  } catch {
    // 存储空间不足或被禁用时不影响使用
  }
}

function selectDate(date: string) {
  if (date === state.selected) return;
  state.selected = date;
  timeline.setSelected(date);
  applyStack();
}

function showPointHistory(lon: number, lat: number) {
  const hits = state.scenes
    .filter((s) => sceneContains(s, lon, lat))
    .sort((a, b) => (a.date === b.date ? a.cloud - b.cloud : a.date < b.date ? 1 : -1));
  if (!hits.length) return;
  const rows = hits
    .map(
      (s) =>
        `<tr data-date="${s.date}" aria-selected="${s.date === state.selected}" class="cursor-pointer hover:bg-sulu-50/60 aria-selected:font-semibold aria-selected:text-sulu-700">` +
        `<td class="px-1.5 py-0.5">${s.date}</td><td class="px-1.5">${utcTime(s)}</td><td class="px-1.5">${s.id.slice(0, 3)}</td>` +
        `<td class="px-1.5">${s.tile}</td><td class="px-1.5">云 ${s.cloud.toFixed(1)}%</td></tr>`,
    )
    .join('');
  const el = document.createElement('div');
  el.className = 'text-stone-800';
  el.innerHTML =
    `<h3 class="mb-1.5 text-[13px] font-semibold">${lon.toFixed(4)}, ${lat.toFixed(4)} 处共 ${hits.length} 景，时刻为 UTC</h3>` +
    `<table class="text-xs whitespace-nowrap tabular-nums">${rows}</table>`;
  el.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest('a')) return;
    const tr = target.closest<HTMLElement>('tr');
    if (!tr?.dataset.date) return;
    selectDate(tr.dataset.date);
    for (const r of el.querySelectorAll<HTMLElement>('tr')) r.ariaSelected = String(r.dataset.date === state.selected);
  });
  new Popup({ maxWidth: '360px' }).setLngLat([lon, lat]).setDOMContent(el).addTo(map);
}


ui.aboutOpen.addEventListener('click', () => ui.about.showModal());
ui.aboutClose.addEventListener('click', () => ui.about.close());
$('about-version').textContent = `版本 ${__APP_VERSION__} · 构建于 ${__BUILD_TIME__} UTC`;
// 点击遮罩关闭：对话框无内边距，点在对话框元素自身上即为遮罩区域
ui.about.addEventListener('click', (ev) => {
  if (ev.target === ui.about) ui.about.close();
});
ui.about.querySelector('[role=tablist]')!.addEventListener('click', (ev) => {
  const tab = (ev.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
  if (!tab) return;
  for (const b of ui.about.querySelectorAll<HTMLElement>('[data-tab]')) b.ariaSelected = String(b.dataset.tab === tab);
  for (const p of ui.about.querySelectorAll<HTMLElement>('[data-panel]')) p.hidden = p.dataset.panel !== tab;
});

document.addEventListener('keydown', (ev) => {
  if (ui.about.open || (ev.target as HTMLElement).closest('input, select') || !state.groups.length) return;
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  const i = state.groups.findIndex((g) => g.date === state.selected);
  // 日期按倒序排列，左键向更早，右键向更晚
  const j = ev.key === 'ArrowLeft' ? i + 1 : i - 1;
  if (j >= 0 && j < state.groups.length) selectDate(state.groups[j].date);
  ev.preventDefault();
});

/** 弹窗：标题加若干「标签：内容」行，内容按纯文本写入 */
function infoPopup(lngLat: { lng: number; lat: number }, title: string, rows: [string, string][], maxWidth = '320px') {
  const el = document.createElement('div');
  el.className = 'space-y-0.5 text-xs text-stone-700';
  const h = document.createElement('h3');
  h.className = 'mb-1 text-[13px] font-semibold text-stone-800';
  h.textContent = title;
  el.append(h);
  for (const [label, value] of rows) {
    const row = document.createElement('p');
    row.textContent = label ? `${label}：${value}` : value;
    el.append(row);
  }
  new Popup({ maxWidth }).setLngLat(lngLat).setDOMContent(el).addTo(map);
}

type ClickEvent = { point: { x: number; y: number }; lngLat: { lng: number; lat: number } };

/** 点击位置附近指定图层中的要素 */
function featuresAt(ev: ClickEvent, layers: readonly string[], pad = 4) {
  const present = layers.filter((id) => map.getLayer(id));
  if (!present.length) return [];
  const { x, y } = ev.point;
  return map.queryRenderedFeatures(
    [
      [x - pad, y - pad],
      [x + pad, y + pad],
    ],
    { layers: present },
  );
}

const hhmmss = (t: number) => new Date(t).toISOString().slice(11, 19);

/** 点中北极航道时弹出名称、类别、数据年份与来源，返回是否点中 */
function showArcticRoute(ev: ClickEvent) {
  const hit = featuresAt(ev, ARCTIC_LAYERS)[0];
  if (!hit) return false;
  const p = hit.properties as Record<string, string>;
  infoPopup(ev.lngLat, p.name, [
    ['类别', p.category],
    ['数据年份', p.data_year],
    ['通行情况', p.note],
    ['几何来源', p.geometry_source],
    ['资料来源', p.data_source],
  ]);
  return true;
}

/** 点中卫星、地面轨迹或扫描带时弹出卫星名、推算时刻与 TLE 历元 */
function showOrbit(ev: ClickEvent) {
  const hits = featuresAt(ev, ['sat-point', 'track-past', 'track-future', 'swath']);
  if (!hits.length) return false;
  const names = [...new Set(hits.map((f) => f.properties.sat as string))].sort();
  const rows: [string, string][] = names.map((name) => {
    const epoch = sats.find((s) => s.name === name)?.epoch.toISOString().slice(0, 16).replace('T', ' ');
    return [name, `TLE 历元 ${epoch ?? '未知'} UTC`];
  });
  rows.push(
    ['', `位置按 ${orbitTime.toISOString().slice(11, 19)} UTC 推算，每 ${ORBIT_REFRESH_MS / 1000} 秒刷新`],
    ['', '扫描带宽 290 km，轨道根数来自 CelesTrak，按 SGP4 推算'],
  );
  infoPopup(ev.lngLat, '卫星扫描带', rows);
  return true;
}

/** 点中采集计划条带时弹出该处各采集段的卫星、相对轨道、时段与状态 */
function showPlan(ev: ClickEvent) {
  const hits = featuresAt(ev, ['plan-fill'], 0);
  if (!hits.length) return false;
  const segs = hits
    .map((f) => f.properties as { sat: string; orbit: string; begin: number; end: number; done: boolean })
    .sort((a, b) => a.begin - b.begin);
  const rows: [string, string][] = segs.map((p) => [
    `${p.sat} 相对轨道 ${p.orbit}`,
    `${hhmmss(p.begin)}–${hhmmss(p.end)} UTC，${p.done ? '已采集' : '待采集'}`,
  ]);
  rows.push(['', '来自 ESA 采集计划 KML，只含 NOMINAL 标称观测']);
  infoPopup(ev.lngLat, `采集计划 ${planDate.value}`, rows, '360px');
  return true;
}

map.on('click', (ev) => {
  if (showArcticRoute(ev) || showOrbit(ev) || showPlan(ev)) return;
  showPointHistory(ev.lngLat.lng, ev.lngLat.lat);
});
map.on('load', () => {
  addImageryLayers();
  refreshOverview();
  refreshCached();
  loadPlan();
  runSearch();
});

/** 已取得几何的景，键为景编号 */
const cachedGeometry = new Map<string, Scene['geometry']>();
let cachedAt = 0;
let cachedLoading = false;
let cachedTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 读取服务器已缓存的景编号，缺几何的经 STAC 按编号补取，再绘制影像边界。
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
    const missing = ids.filter((id) => !cachedGeometry.has(id));
    for (const [id, geom] of await sceneGeometries(missing)) cachedGeometry.set(id, geom);
    map.getSource<GeoJSONSource>('cached')?.setData({
      type: 'FeatureCollection',
      features: ids
        .filter((id) => cachedGeometry.has(id))
        .map((id) => ({ type: 'Feature', geometry: cachedGeometry.get(id)!, properties: { id } })),
    });
  } catch (err) {
    reportError('已缓存影像读取失败', err);
  } finally {
    cachedLoading = false;
  }
}

/**
 * 标题右侧的信息窗口：影像检索范围标志、加载状态与瓦片请求指标、最近的请求错误
 */
const ERROR_SHOW_MS = 30000;
const ERROR_LIMIT = 20;
/** 时刻为 UTC，与全站一致 */
const errors: { at: number; text: string }[] = [];

function reportError(what: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  errors.push({ at: Date.now(), text: `${what}：${msg}` });
  if (errors.length > ERROR_LIMIT) errors.shift();
  ui.info.title = errors.map((e) => `${hhmmss(e.at)} ${e.text}`).join('\n');
}

// 底图、叠加图层与影像瓦片的加载失败都经地图的 error 事件上报
map.on('error', (ev) => {
  const src = 'sourceId' in ev ? `图层 ${String(ev.sourceId)} ` : '';
  reportError(`${src}加载失败`, ev.error);
});

const infoZoom = ui.info.querySelector<HTMLElement>('[data-zoom]')!;
const infoSpin = ui.info.querySelector<HTMLElement>('[data-spin]')!;
const infoText = ui.info.querySelector<HTMLElement>('[data-text]')!;
const infoDetail = ui.info.querySelector<HTMLElement>('[data-detail]')!;
let lastBusy = 0;
setInterval(() => {
  // 宽度随内容变化，右侧不超过图层面板，留出间距
  const room = layerPanel.getBoundingClientRect().left - GAP - ui.info.getBoundingClientRect().left;
  ui.info.style.maxWidth = `${Math.max(0, room)}px`;

  const inRange = imageryInRange();
  infoZoom.className = `flex size-7 flex-none items-center justify-center rounded-full transition-colors ${
    inRange ? 'bg-sulu-100 text-sulu-700' : 'text-stone-300'
  }`;
  infoZoom.title = inRange ? '当前缩放与视野可检索并显示影像' : `放大到 ${MIN_IMAGERY_ZOOM} 级及以上后检索并显示影像`;

  const st = tileStats();
  const baseLoading = !map.isStyleLoaded() || !map.areTilesLoaded();
  infoSpin.hidden = !(st.inflight || state.searching || baseLoading);
  infoText.textContent = st.inflight
    ? `正在加载影像瓦片，剩余 ${st.inflight} 个`
    : state.searching
      ? '正在检索影像'
      : baseLoading
        ? '正在加载底图与叠加图层'
        : st.requested
          ? '影像瓦片已加载'
          : '就绪';

  const recent = errors.filter((e) => Date.now() - e.at < ERROR_SHOW_MS);
  const last = recent.at(-1);
  infoDetail.classList.toggle('text-red-600', !!last);
  infoDetail.classList.toggle('text-stone-500', !last);
  if (last) {
    infoDetail.textContent = `${hhmmss(last.at)} ${last.text}${recent.length > 1 ? `（另有 ${recent.length - 1} 条）` : ''}`;
  } else {
    const avg = st.done ? `${Math.round(st.ms / st.done)} ms` : '—';
    infoDetail.textContent = st.requested
      ? `请求 ${st.requested} · 完成 ${st.done} · 缓存命中 ${st.hits}` +
        `${st.failed ? ` · 失败 ${st.failed}` : ''}${st.canceled ? ` · 取消 ${st.canceled}` : ''}` +
        ` · 平均 ${avg} · ${(st.bytes / 1024).toFixed(0)} KB`
      : '';
  }
  // 一批瓦片加载完后服务器缓存会增加，重新读取影像边界
  if (lastBusy > 0 && st.inflight === 0) refreshCached();
  lastBusy = st.inflight;
}, 300);
