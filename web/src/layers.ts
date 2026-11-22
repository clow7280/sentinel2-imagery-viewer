import type { Map as MlMap } from 'maplibre-gl';
import { OVERVIEW_MAX_ZOOM, overviewVisible } from './overview';
import { type ClickEvent, featuresAt, infoPopup } from './popup';

/** 航路用色：橙色为大洋航路，紫色为北极航道 */
const LANE = '#ea580c';
const ARCTIC = '#7c3aed';
const ARCTIC_LAYERS = ['arctic', 'arctic-schematic'];
/** 航路线条整体降低的不透明度比例 */
const ROUTE_OPACITY = 0.8;
/** 浮动面板与窗口边缘、面板之间的间距，像素 */
export const GAP = 10;

/** 56rem */
const TIMELINE_WIDTH = 896;
const TIMELINE_MIN_WIDTH = 560;
/** 与 index.html 中的 bottom-14 一致 */
const TIMELINE_BOTTOM = 56;

/**
 * 右上角图层面板，按常见 WebGIS 图层列表排布：分组标题下每行为图例图标、名称与右侧开关。
 * 采集计划与扫描带只在缩放不超过 OVERVIEW_MAX_ZOOM 时可见，放大后这两行置灰并提示可见级别
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

export interface LayersOptions {
  /** 时间轴面板，按图例位置居中排布 */
  timelineEl: HTMLElement;
  /** 嵌在某图层行下方的附加控件，如采集计划的日期选择，键为图层 key */
  extras: Record<string, HTMLElement>;
  /** 图层开关改变 */
  onToggle: () => void;
}

/**
 * 图层面板、图例与时间轴排布，以及海图标志、航路等参考图层与北极航道的弹窗
 */
export function createLayers(map: MlMap, opts: LayersOptions) {
  /** 底图中的注记图层 */
  let labelLayers: string[] = [];

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

  const panel = document.createElement('div');
  panel.className = 'maplibregl-ctrl w-56 rounded-lg bg-white/95 p-1.5 text-[13px] text-stone-700 shadow-sm ring-1 ring-stone-200';
  panel.innerHTML =
    '<div class="border-b border-stone-100 px-1.5 pt-0.5 pb-1.5 text-sm font-semibold text-stone-800">图层</div>' +
    [...new Set(OVERLAYS.map((o) => o.group))]
      .map(
        (group) =>
          `<div class="px-1.5 pt-2 pb-0.5 text-[11px] font-medium tracking-wider text-stone-400">${group}</div>` +
          OVERLAYS.filter((o) => o.group === group)
            .map(layerRow)
            .join(''),
      )
      .join('');
  for (const [key, el] of Object.entries(opts.extras)) panel.querySelector(`[data-row="${key}"]`)!.after(el);

  function setOverlay(overlay: Overlay, on: boolean) {
    overlayOn[overlay.key] = on;
    for (const id of overlay.layers()) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
    opts.onToggle();
  }
  panel.addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement;
    const overlay = OVERLAYS.find((o) => o.key === input.dataset.overlay);
    if (overlay) setOverlay(overlay, input.checked);
  });
  map.addControl({ onAdd: () => panel, onRemove: () => panel.remove() }, 'top-right');

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
    Object.assign(opts.timelineEl.style, {
      left: `${(W - width) / 2}px`,
      width: `${width}px`,
      bottom: `${bottom}px`,
      maxWidth: 'none',
      translate: 'none',
    });
  }
  new ResizeObserver(layoutTimeline).observe(legend);
  window.addEventListener('resize', layoutTimeline);

  /** 按当前缩放与图层开关更新图例、概览图层行的可用状态与附加控件 */
  function update() {
    const zoomOk = overviewVisible(map);
    let any = false;
    for (const l of LEGEND) {
      const show = overlayOn[l.key] && (!l.overview || zoomOk);
      legend.querySelector<HTMLElement>(`[data-legend="${l.key}"]`)!.hidden = !show;
      any ||= show;
    }
    legend.hidden = !any;
    for (const o of OVERLAYS) {
      if (o.overview) panel.querySelector<HTMLInputElement>(`[data-overlay="${o.key}"]`)!.disabled = !zoomOk;
      const extra = opts.extras[o.key];
      if (extra) extra.hidden = !(overlayOn[o.key] && (!o.overview || zoomOk));
    }
  }

  /**
   * 记下底图末尾的注记图层，返回叠加图层的插入位置。
   * 底图样式中注记层与道路层交错，只取末尾连续的注记层；
   * 影像与各叠加层插在中国视角边界之下，边界与注记压在影像之上
   */
  function anchor(): string | undefined {
    const layers = map.getStyle().layers;
    let tail = layers.length;
    while (tail > 0 && layers[tail - 1].type === 'symbol') tail--;
    labelLayers = layers.slice(tail).map((l) => l.id);
    return layers.find((l) => l.id.startsWith('cn-boundary'))?.id ?? labelLayers[0];
  }

  /** 海图标志与航路图层 */
  function addReferenceLayers(beforeId: string | undefined) {
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
  }

  /** 点中北极航道时弹出名称、类别、数据年份与来源，返回是否点中 */
  function handleClick(ev: ClickEvent) {
    const hit = featuresAt(map, ev, ARCTIC_LAYERS)[0];
    if (!hit) return false;
    const p = hit.properties as Record<string, string>;
    infoPopup(map, ev.lngLat, p.name, [
      ['类别', p.category],
      ['数据年份', p.data_year],
      ['通行情况', p.note],
      ['几何来源', p.geometry_source],
      ['资料来源', p.data_source],
    ]);
    return true;
  }

  return {
    panel,
    isOn: (key: string) => overlayOn[key],
    anchor,
    addReferenceLayers,
    update,
    layoutTimeline,
    handleClick,
  };
}
