import { addProtocol, Map as MlMap, ScaleControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 默认按自身模块地址推算 Worker 路径，经 Vite 打包后会失效，改为单独打包后显式指定
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import { Protocol as PmtilesProtocol } from 'pmtiles';
import { createImagery } from './imagery';
import { createInfo } from './info';
import { createLayers, GAP } from './layers';
import { createOverview } from './overview';
import { registerProtocol } from './tiles';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  timeline: $('timeline'),
  info: $('info'),
  about: $<HTMLDialogElement>('about'),
  aboutOpen: $('about-open'),
  aboutClose: $('about-close'),
};

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

/**
 * 各模块之间的调用经下面传入的回调完成，回调在地图事件与定时器中才执行，此时各模块均已创建
 */
const info = createInfo(map, ui.info, {
  maxRight: () => layers.panel.getBoundingClientRect().left - GAP,
  inRange: () => imagery.inRange(),
  imageryOn: () => layers.isOn('s2'),
  onBatchDone: () => imagery.refreshCached(),
});
const overview = createOverview(map, { isOn: (key) => layers.isOn(key), reportError: info.reportError });
const layers = createLayers(map, { timelineEl: ui.timeline, extras: { plan: overview.planOpts }, onToggle: refreshOverlays });
const imagery = createImagery(map, {
  timelineEl: ui.timeline,
  info,
  isOn: () => layers.isOn('s2'),
  layoutTimeline: layers.layoutTimeline,
});

/** 缩放或图层开关改变后刷新图例与概览图层 */
function refreshOverlays() {
  layers.update();
  overview.refresh();
}
map.on('zoomend', refreshOverlays);

map.on('click', (ev) => {
  if (layers.handleClick(ev) || overview.handleClick(ev)) return;
  imagery.handleClick(ev);
});
map.on('load', () => {
  // 影像、参考图层、概览图层依次插在同一位置之下，先加入的在下层
  const beforeId = layers.anchor();
  imagery.addLayers(beforeId);
  layers.addReferenceLayers(beforeId);
  overview.addLayers(beforeId);
  imagery.start();
  refreshOverlays();
  overview.loadPlan();
});

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
