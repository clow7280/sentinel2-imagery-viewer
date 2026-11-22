import type { Map as MlMap } from 'maplibre-gl';
import { AUTO_MONTHS, MAX_SEARCH_AREA, MIN_IMAGERY_ZOOM } from './imagery';
import { tileStats } from './tiles';

/** UTC 时刻，HH:MM:SS */
export const hhmmss = (t: number) => new Date(t).toISOString().slice(11, 19);

export interface SearchJob {
  label: string;
  found: number;
}

export interface Info {
  /** 登记一项进行中的检索，信息窗口显示最近开始的一项 */
  beginSearch(label: string): SearchJob;
  endSearch(job: SearchJob): void;
  reportError(what: string, err: unknown): void;
}

export interface InfoOptions {
  /** 信息窗口右边缘允许到达的横坐标，不压到图层面板 */
  maxRight: () => number;
  /** 当前缩放与视野是否在影像自动检索范围内 */
  inRange: () => boolean;
  /** 卫星影像图层是否打开 */
  imageryOn: () => boolean;
  /** 一批影像瓦片加载完毕，服务器缓存随之增加 */
  onBatchDone: () => void;
}

const ERROR_SHOW_MS = 30000;
const ERROR_LIMIT = 20;
/** 文字内容持续不变超过该时长后收起，只留图标，悬停时展开 */
const INFO_IDLE_MS = 5000;

/**
 * 标题右侧的信息窗口：影像检索范围标志、加载状态与瓦片请求指标、最近的请求错误
 */
export function createInfo(map: MlMap, el: HTMLElement, opts: InfoOptions): Info {
  /** 进行中的检索 */
  const searches: SearchJob[] = [];
  /** 时刻为 UTC，与全站一致 */
  const errors: { at: number; text: string }[] = [];

  function reportError(what: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ at: Date.now(), text: `${what}：${msg}` });
    if (errors.length > ERROR_LIMIT) errors.shift();
    el.title = errors.map((e) => `${hhmmss(e.at)} ${e.text}`).join('\n');
  }

  // 底图、叠加图层与影像瓦片的加载失败都经地图的 error 事件上报
  map.on('error', (ev) => {
    const src = 'sourceId' in ev ? `图层 ${String(ev.sourceId)} ` : '';
    reportError(`${src}加载失败`, ev.error);
  });

  const infoZoom = el.querySelector<HTMLElement>('[data-zoom]')!;
  const infoSpin = el.querySelector<HTMLElement>('[data-spin]')!;
  const infoText = el.querySelector<HTMLElement>('[data-text]')!;
  const infoBody = el.querySelector<HTMLElement>('[data-body]')!;
  const infoDetail = el.querySelector<HTMLElement>('[data-detail]')!;
  let infoShown = '';
  let infoChangedAt = Date.now();
  let infoHover = false;
  el.addEventListener('mouseenter', () => (infoHover = true));
  el.addEventListener('mouseleave', () => (infoHover = false));
  let lastBusy = 0;
  setInterval(() => {
    // 宽度随内容变化，右侧不超过图层面板，留出间距
    el.style.maxWidth = `${Math.max(0, opts.maxRight() - el.getBoundingClientRect().left)}px`;

    const inRange = opts.inRange();
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
          : !opts.imageryOn()
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
    infoBody.hidden = !infoHover && Date.now() - infoChangedAt > INFO_IDLE_MS;
    if (lastBusy > 0 && st.inflight === 0) opts.onBatchDone();
    lastBusy = st.inflight;
  }, 300);

  return {
    beginSearch(label) {
      const job = { label, found: 0 };
      searches.push(job);
      return job;
    },
    endSearch(job) {
      const i = searches.indexOf(job);
      if (i >= 0) searches.splice(i, 1);
    },
    reportError,
  };
}
