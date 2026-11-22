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
import { groupByDate, type DateGroup } from './composition';
import { dailyPlan, planCollection, type DailyPlan } from './acquisition';
import { loadSats, orbitFeatures, type Sat } from './orbits';
import { Protocol as PmtilesProtocol } from 'pmtiles';
import { fillGaps, pickTile, tileAt, tileBBox, tileRing, tilesInBBox } from './regions';
import { scenesByIds, searchScenes } from './stac';
import { registerProtocol, setStack, tileStats } from './tiles';
import { Timeline } from './timeline';
import type { BBox, Scene } from './types';

/** 自动检索视野内影像的最低缩放级别 */
const MIN_IMAGERY_ZOOM = 7;
/** 影像图层的最低缩放级别，与后端一致；低于检索级别时只显示已知景，主要是服务器已缓存的影像 */
const MIN_TILE_ZOOM = 4;
/** 自动挑选的时间窗，单位月 */
const AUTO_MONTHS = 3;
/** 视野检索先只取云量不超过该值的景 */
const AUTO_CLOUD = 20;
/** 没有晴空景的区域补检时的条数上限 */
const CLOUDY_ITEMS = 300;
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
/** 已缓存影像列表的最短刷新间隔 */
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
 * 各区域保存的日期选择，连同所用的景存在浏览器本地，打开页面后不等检索就能显示。
 * 键为 MGRS 分幅
 */
const PICKS_KEY = 'sentinel2:region-picks';
interface RegionPick {
  date: string;
  scenes: Scene[];
}
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

/** 进行中的检索，信息窗口显示最近开始的一项 */
const searches: { label: string; found: number }[] = [];
function beginSearch(label: string) {
  const job = { label, found: 0 };
  searches.push(job);
  return job;
}
function endSearch(job: { label: string; found: number }) {
  const i = searches.indexOf(job);
  if (i >= 0) searches.splice(i, 1);
}

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
      paint: { 'line-color': SULU_100, 'line-width': 1, 'line-opacity': 0.7 },
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
      paint: { 'line-color': SULU_100, 'line-width': 3 },
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
 * 右上角图层面板，按常见 WebGIS 图层列表排布：分组标题下每行为图例图标、名称与右侧开关。
 * 采集计划的日期选择嵌在该项下方；采集计划与扫描带只在缩放不超过 OVERVIEW_MAX_ZOOM 时可见，
 * 放大后这两行置灰并提示可见级别
 */
interface Overlay {
  key: string;
  label: string;
  group: string;
  /** 名称左侧的小图标，与图层的配色一致 */
  icon: string;
  overview?: boolean;
  layers: () => readonly string[];
}
const ICON = 'flex size-4 flex-none items-center justify-center rounded-[3px]';
const OVERLAYS: Overlay[] = [
  {
    key: 's2',
    group: '影像',
    label: '卫星影像',
    icon: `<i class="${ICON} bg-linear-to-br from-amber-700 via-lime-800 to-sky-900"></i>`,
    layers: () => ['s2'],
  },
  {
    key: 'regions',
    group: '影像',
    label: '影像边界',
    icon: `<i class="${ICON} border border-sulu-500 bg-[linear-gradient(var(--color-sulu-500),var(--color-sulu-500))_center/1px_100%_no-repeat,linear-gradient(var(--color-sulu-500),var(--color-sulu-500))_center/100%_1px_no-repeat]"></i>`,
    layers: () => ['regions-line', 'region-selected'],
  },
  {
    key: 'labels',
    group: '参考',
    label: '地名注记',
    icon: `<i class="${ICON} bg-stone-100 text-[10px] font-semibold text-stone-600 not-italic">文</i>`,
    layers: () => labelLayers,
  },
  {
    key: 'seamark',
    group: '参考',
    label: '海图标志',
    icon: `<i class="${ICON} bg-stone-100 text-[11px] text-fuchsia-700 not-italic">⚓</i>`,
    layers: () => ['seamark'],
  },
  {
    key: 'routes',
    group: '参考',
    label: '主要航路',
    icon: `<i class="${ICON} flex-col justify-center gap-[3px] bg-stone-100 px-0.5"><b class="h-0.5 w-full rounded bg-orange-600/80"></b><b class="h-0.5 w-full rounded bg-violet-600/80"></b></i>`,
    layers: () => ['lanes', ...ARCTIC_LAYERS],
  },
  {
    key: 'plan',
    group: '参考',
    overview: true,
    label: '卫星采集计划',
    icon: `<i class="${ICON} border border-sulu-600 bg-sulu-400/50"></i>`,
    layers: () => ['plan-fill', 'plan-line'],
  },
  {
    key: 'orbits',
    group: '参考',
    overview: true,
    label: '卫星扫描带',
    icon: `<i class="${ICON} border border-sky-700 bg-sky-500/25"></i>`,
    layers: () => ['swath', 'track-past', 'track-future', 'sat-point', 'sat-label'],
  },
];
const overlayOn: Record<string, boolean> = Object.fromEntries(OVERLAYS.map((o) => [o.key, true]));

const PLAN_OPTS =
  '<div data-plan-opts class="mb-1 ml-8 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pr-1.5 text-xs text-stone-500">' +
  '<input type="date" class="field-input py-0 text-xs" />UTC' +
  '<span data-plan class="basis-full leading-snug empty:hidden"></span></div>';

const layerRow = (o: Overlay) =>
  `<label data-row="${o.key}" class="group flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-stone-100/80 has-disabled:cursor-default has-disabled:hover:bg-transparent">` +
  `<span class="contents group-has-disabled:opacity-40">${o.icon}</span>` +
  '<span class="min-w-0 flex-1 group-has-disabled:text-stone-400 group-has-[input:not(:checked)]:text-stone-400">' +
  `<span class="block truncate">${o.label}</span>` +
  (o.overview
    ? `<span class="hidden text-[11px] leading-tight text-stone-400 group-has-disabled:block">缩小到 ${OVERVIEW_MAX_ZOOM} 级及以下可见</span>`
    : '') +
  '</span>' +
  `<input type="checkbox" class="layer-switch" data-overlay="${o.key}" checked /></label>`;

const layerPanel = document.createElement('div');
layerPanel.className =
  'maplibregl-ctrl w-56 rounded-lg bg-white/95 p-1.5 text-[13px] text-stone-700 shadow-sm ring-1 ring-stone-200';
layerPanel.innerHTML =
  '<div class="border-b border-stone-100 px-1.5 pt-0.5 pb-1.5 text-sm font-semibold text-stone-800">图层</div>' +
  [...new Set(OVERLAYS.map((o) => o.group))]
    .map(
      (group) =>
        `<div class="px-1.5 pt-2 pb-0.5 text-[11px] font-medium tracking-wider text-stone-400">${group}</div>` +
        OVERLAYS.filter((o) => o.group === group)
          .map((o) => layerRow(o) + (o.key === 'plan' ? PLAN_OPTS : ''))
          .join(''),
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

/** 右下角图例，只列出当前可见的矢量图层，每行一条 */
const swatchLine = (cls: string, text: string) =>
  `<span class="inline-flex items-center gap-1"><i class="inline-block w-3.5 border-t-2 ${cls}"></i>${text}</span>`;
const swatchBox = (cls: string, text: string) =>
  `<span class="inline-flex items-center gap-1"><i class="inline-block h-2.5 w-3.5 border ${cls}"></i>${text}</span>`;
const LEGEND: { key: string; overview: boolean; title: string; items: string[] }[] = [
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
    title: '卫星采集计划（本日）',
    items: [swatchBox('border-sulu-600 bg-sulu-400/60', '已采集'), swatchBox('border-sulu-600 bg-sulu-400/25', '待采集')],
  },
  {
    key: 'orbits',
    overview: true,
    title: '卫星扫描带（近1小时）',
    items: [
      swatchBox('border-sky-700 bg-sky-500/20', '成像区域'),
      swatchLine('border-sky-700', '已飞过的轨迹'),
      swatchLine('border-dashed border-sky-700', '将飞过的轨迹'),
    ],
  },
];
const legend = document.createElement('div');
legend.className =
  'maplibregl-ctrl flex flex-col gap-1.5 rounded bg-white/90 px-2.5 py-1.5 text-[11px] text-stone-700 shadow-sm ring-1 ring-stone-200';
legend.innerHTML = LEGEND.map(
  (l) =>
    `<div data-legend="${l.key}" class="flex flex-col gap-0.5"><span class="text-stone-500">${l.title}</span>` +
    `${l.items.join('')}</div>`,
).join('');
map.addControl({ onAdd: () => legend, onRemove: () => legend.remove() }, 'bottom-right');
/**
 * 时间轴始终水平居中。会压到右下角图例时先左右对称收窄，
 * 收窄后不足 TIMELINE_MIN_WIDTH 时恢复宽度，整体上移到图例上方。
 * 宽度、位置与底边距写成内联样式，覆盖 index.html 中的类
 */
const GAP = 10;
/** 56rem */
const TIMELINE_WIDTH = 896;
const TIMELINE_MIN_WIDTH = 560;
/** 与 index.html 中的 bottom-14 一致 */
const TIMELINE_BOTTOM = 56;
function layoutTimeline() {
  const W = window.innerWidth;
  const full = Math.min(TIMELINE_WIDTH, W - 2 * GAP);
  let width = full;
  let bottom = TIMELINE_BOTTOM;
  const lr = legend.offsetWidth ? legend.getBoundingClientRect() : undefined;
  if (lr && lr.top < window.innerHeight - TIMELINE_BOTTOM) {
    const room = 2 * (lr.left - GAP - W / 2);
    if (room >= Math.min(TIMELINE_MIN_WIDTH, full)) width = Math.min(full, room);
    else bottom = window.innerHeight - lr.top + GAP;
  }
  Object.assign(ui.timeline.style, {
    left: `${(W - width) / 2}px`,
    width: `${width}px`,
    bottom: `${bottom}px`,
    maxWidth: 'none',
    translate: 'none',
  });
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
    if (o.overview) layerPanel.querySelector<HTMLInputElement>(`[data-overlay="${o.key}"]`)!.disabled = !zoomOk;
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

const timeline = new Timeline(ui.timeline, {
  onChange: () => regionSearch(),
  onSelect: previewDate,
  onSave: savePick,
  onReset: resetPick,
  onClose: closeRegion,
});

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

/** 缩放与视野范围足够小时才自动检索视野内的影像 */
const imageryInRange = () => map.getZoom() >= MIN_IMAGERY_ZOOM && bboxArea(currentBBox()) <= MAX_SEARCH_AREA;

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
  if (!imageryInRange()) return;
  const bbox = currentBBox();
  const start = autoStart();
  const end = isoDate(new Date());
  const key = JSON.stringify([bbox, start]);
  if (key === state.autoKey) return;
  state.autoAbort?.abort();
  const ac = new AbortController();
  state.autoAbort = ac;
  const job = beginSearch(`视野内近 ${AUTO_MONTHS} 个月的影像`);
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
    if (!ac.signal.aborted) reportError('视野影像检索失败', err);
  } finally {
    endSearch(job);
  }
}

let moveTimer: ReturnType<typeof setTimeout> | undefined;
map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(autoSearch, MOVE_SEARCH_DELAY_MS);
});

/** 平均每月可用日期少于该数时提醒提高云量上限 */
const SPARSE_PER_MONTH = 1;

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
  const job = beginSearch(`区域 ${tile} 的影像`);
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
      reportError(`区域 ${tile} 影像检索失败`, err);
    }
  } finally {
    endSearch(job);
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
  ui.timeline.hidden = false;
  layoutTimeline();
  map.setFilter('region-selected', ['==', ['get', 'tile'], tile]);
  syncTimeline();
  regionSearch();
}

/** 关闭时间轴并取消选择区域，未保存的预览恢复为原来的影像 */
function closeRegion() {
  state.regionAbort?.abort();
  state.region = undefined;
  state.preview = undefined;
  ui.timeline.hidden = true;
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
  // 点中有影像的区域时弹出该区域的时间轴
  if (!overlayOn.s2 || map.getZoom() < MIN_TILE_ZOOM) return;
  const tile = tileAt(ev.lngLat.lng, ev.lngLat.lat);
  if (tile && knownTiles.has(tile)) openRegion(tile);
});
map.on('load', () => {
  addImageryLayers();
  rebuildStack();
  refreshOverview();
  refreshCached();
  loadPlan();
  autoSearch();
});

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
const infoBody = ui.info.querySelector<HTMLElement>('[data-body]')!;
const infoDetail = ui.info.querySelector<HTMLElement>('[data-detail]')!;
/** 文字内容持续不变超过该时长后收起，只留图标，悬停时展开 */
const INFO_IDLE_MS = 5000;
let infoShown = '';
let infoChangedAt = Date.now();
let infoHover = false;
ui.info.addEventListener('mouseenter', () => (infoHover = true));
ui.info.addEventListener('mouseleave', () => (infoHover = false));
let lastBusy = 0;
setInterval(() => {
  // 宽度随内容变化，右侧不超过图层面板，留出间距
  const room = layerPanel.getBoundingClientRect().left - GAP - ui.info.getBoundingClientRect().left;
  ui.info.style.maxWidth = `${Math.max(0, room)}px`;

  const inRange = imageryInRange();
  infoZoom.className = `relative flex size-6 flex-none items-center justify-center rounded-full transition-colors ${
    inRange ? 'bg-sulu-100 text-sulu-700' : 'text-stone-300'
  }`;
  infoZoom.title = inRange
    ? `视野内各区域自动显示近 ${AUTO_MONTHS} 个月的最佳影像`
    : `放大到 ${MIN_IMAGERY_ZOOM} 级及以上、视野不超过 ${MAX_SEARCH_AREA} 平方度时自动检索影像，此前只显示已缓存的区域`;

  const st = tileStats();
  const baseLoading = !map.isStyleLoaded() || !map.areTilesLoaded();
  const job = searches.at(-1);
  infoSpin.hidden = !(st.inflight || job || baseLoading);
  infoText.textContent = st.inflight
    ? `正在加载影像，还剩 ${st.inflight} 块瓦片`
    : job
      ? `正在检索${job.label}${job.found ? `，已获取 ${job.found} 景` : ''}`
      : baseLoading
        ? '正在加载底图'
        : !overlayOn.s2
          ? '卫星影像已关闭'
          : inRange
            ? '点击影像可查看该区域的历史影像'
            : `放大到 ${MIN_IMAGERY_ZOOM} 级以上检索更多区域`;

  const recent = errors.filter((e) => Date.now() - e.at < ERROR_SHOW_MS);
  const last = recent.at(-1);
  infoDetail.classList.toggle('text-red-600', !!last);
  infoDetail.classList.toggle('text-stone-500', !last);
  if (last) {
    infoDetail.textContent = `${hhmmss(last.at)} ${last.text}${recent.length > 1 ? `（另有 ${recent.length - 1} 条）` : ''}`;
  } else {
    const avg = st.done ? `${Math.round(st.ms / st.done)} ms` : '—';
    infoDetail.textContent = st.requested
      ? `本批 ${st.requested} 块瓦片 · 已完成 ${st.done} · 服务器已缓存 ${st.hits}` +
        `${st.failed ? ` · 失败 ${st.failed}` : ''}${st.canceled ? ` · 已取消 ${st.canceled}` : ''}` +
        ` · 平均 ${avg} · 共 ${(st.bytes / 1024).toFixed(0)} KB`
      : '';
  }
  const shown = infoText.textContent + infoDetail.textContent;
  if (shown !== infoShown) {
    infoShown = shown;
    infoChangedAt = Date.now();
  }
  const idle = !infoHover && Date.now() - infoChangedAt > INFO_IDLE_MS;
  infoBody.hidden = idle;
  // 一批瓦片加载完后服务器缓存会增加，重新读取影像边界
  if (lastBusy > 0 && st.inflight === 0) refreshCached();
  lastBusy = st.inflight;
}, 300);
