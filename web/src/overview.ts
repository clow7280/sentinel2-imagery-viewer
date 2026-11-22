import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { dailyPlan, planCollection, type DailyPlan } from './acquisition';
import { hhmmss } from './info';
import { loadSats, orbitFeatures, type Sat } from './orbits';
import { type ClickEvent, featuresAt, infoPopup } from './popup';

/** 缩放级别不超过该值时显示采集计划与卫星扫描带 */
export const OVERVIEW_MAX_ZOOM = 4;
const ORBIT_REFRESH_MS = 10000;
/** 图层用色，与界面的 sulu 色系一致，卫星轨迹用天蓝色区分 */
const SULU_400 = '#84a753';
const SULU_600 = '#587136';
const SKY = '#0ea5e9';
const SKY_DARK = '#0369a1';

export const overviewVisible = (map: MlMap) => map.getZoom() <= OVERVIEW_MAX_ZOOM;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export interface OverviewOptions {
  /** 采集计划或卫星扫描带图层是否打开 */
  isOn: (key: 'plan' | 'orbits') => boolean;
  reportError: (what: string, err: unknown) => void;
}

/**
 * 低缩放级别的概览图层：ESA 采集计划条带、卫星扫描带、地面轨迹与当前位置，
 * 以及点击它们时的弹窗。采集计划的日期选择由 planOpts 提供，嵌在图层面板中
 */
export function createOverview(map: MlMap, opts: OverviewOptions) {
  const planOpts = document.createElement('div');
  planOpts.className = 'mb-1 ml-8 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pr-1.5 text-xs text-stone-500';
  planOpts.innerHTML =
    '<input type="date" class="field-input py-0 text-xs" />UTC' +
    '<span data-plan class="basis-full leading-snug empty:hidden"></span>';
  const planDate = planOpts.querySelector('input')!;
  const planInfo = planOpts.querySelector<HTMLElement>('[data-plan]')!;
  planDate.value = isoDate(new Date());

  let sats: Sat[] = [];
  let plan: DailyPlan | undefined;
  /** 卫星位置的推算时刻，弹窗中显示 */
  let orbitTime = new Date();

  function addLayers(beforeId: string | undefined) {
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

  /** 按当前时刻刷新采集计划的完成状态与卫星位置，缩放超出概览级别时跳过 */
  function refresh() {
    if (!overviewVisible(map) || !map.getSource('orbits')) return;
    const now = new Date();
    if (plan && opts.isOn('plan')) map.getSource<GeoJSONSource>('plan')!.setData(planCollection(plan, now.getTime()));
    if (!sats.length || !opts.isOn('orbits')) return;
    orbitTime = now;
    map.getSource<GeoJSONSource>('orbits')!.setData(orbitFeatures(sats, now));
  }

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
      refresh();
    } catch (err) {
      if (planDate.value === day) planInfo.textContent = '读取失败，切换日期可重试';
      opts.reportError('采集计划读取失败', err);
    }
  }

  planDate.addEventListener('change', loadPlan);
  loadSats()
    .then((list) => {
      sats = list;
      refresh();
    })
    .catch((err) => opts.reportError('卫星轨道根数读取失败', err));
  setInterval(refresh, ORBIT_REFRESH_MS);

  /** 点中卫星、地面轨迹或扫描带时弹出卫星名、推算时刻与 TLE 历元 */
  function showOrbit(ev: ClickEvent) {
    const hits = featuresAt(map, ev, ['sat-point', 'track-past', 'track-future', 'swath']);
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
    infoPopup(map, ev.lngLat, '卫星扫描带', rows);
    return true;
  }

  /** 点中采集计划条带时弹出该处各采集段的卫星、相对轨道、时段与状态 */
  function showPlan(ev: ClickEvent) {
    const hits = featuresAt(map, ev, ['plan-fill'], 0);
    if (!hits.length) return false;
    const segs = hits
      .map((f) => f.properties as { sat: string; orbit: string; begin: number; end: number; done: boolean })
      .sort((a, b) => a.begin - b.begin);
    const rows: [string, string][] = segs.map((p) => [
      `${p.sat} 相对轨道 ${p.orbit}`,
      `${hhmmss(p.begin)}–${hhmmss(p.end)} UTC，${p.done ? '已采集' : '待采集'}`,
    ]);
    rows.push(['', '来自 ESA 采集计划 KML，只含 NOMINAL 标称观测']);
    infoPopup(map, ev.lngLat, `采集计划 ${planDate.value}`, rows, '360px');
    return true;
  }

  return {
    planOpts,
    addLayers,
    refresh,
    loadPlan,
    /** 点中概览要素时弹窗并返回 true */
    handleClick: (ev: ClickEvent) => showOrbit(ev) || showPlan(ev),
  };
}
