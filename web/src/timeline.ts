import type { DateGroup } from './composition';

const DAY = 86400000;
/** 时间轴可见跨度的上下限，过长时单次检索会超出条数上限 */
const MIN_SPAN = 7 * DAY;
const MAX_SPAN = 730 * DAY;
/** Sentinel-2A 于 2015 年 6 月发射，更早没有影像 */
const ARCHIVE_START = Date.UTC(2015, 5, 23);
/** 拖动或滚轮停止后多久触发检索 */
const CHANGE_DELAY_MS = 450;
/** 刻度间距下限，单位像素 */
const TICK_MIN_PX = 64;
const CLOUD_OPTIONS = [10, 20, 30, 50, 100];
const DEFAULT_CLOUD = 20;

export interface TimelineOptions {
  /** 检索时间段或云量上限改变，拖动与滚轮在停止后才触发 */
  onChange: () => void;
  /** 点击日期柱，在该区域预览这一天的影像 */
  onSelect: (date: string) => void;
  /** 保存当前预览的日期为该区域的选择 */
  onSave: () => void;
  /** 清除该区域保存的选择，恢复自动挑选 */
  onReset: () => void;
  onClose: () => void;
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayStart = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const floorDay = (t: number) => Math.floor(t / DAY) * DAY;
const tomorrow = () => floorDay(Date.now()) + DAY;

/** 云量越低颜色越深 */
function cloudClass(cloud: number): string {
  if (cloud < 5) return 'bg-sulu-600';
  if (cloud < 15) return 'bg-sulu-500';
  if (cloud < 30) return 'bg-sulu-400';
  if (cloud < 60) return 'bg-sulu-200';
  return 'bg-stone-300';
}

/** 景编号前缀即卫星，如 S2B */
const satellites = (g: DateGroup) => [...new Set(g.scenes.map((s) => s.id.slice(0, 3)))].sort().join('、');

/**
 * 区域时间轴：点击影像后在底部弹出，列出该 MGRS 分幅的影像。
 * 可见范围即检索时间段，拖动平移、滚轮缩放，也可手动输入起止日期。
 * 每个有影像的日期画一根柱，柱高为对分幅的覆盖比例，颜色深浅表示云量，星标为自动挑选的日期
 */
export class Timeline {
  /** 可见范围，毫秒，end 不含 */
  private start: number;
  private end: number;
  private groups: DateGroup[] = [];
  private recommended?: string;
  private selected?: string;
  /** 当前记录对应的检索时间段，毫秒，end 不含；之外的部分尚未检索 */
  private searched?: { start: number; end: number };
  private changeTimer?: ReturnType<typeof setTimeout>;
  private frame = 0;
  private readonly track: HTMLElement;
  private readonly bars: HTMLElement;
  private readonly axis: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly status: HTMLElement;
  private readonly startInput: HTMLInputElement;
  private readonly endInput: HTMLInputElement;
  private readonly cloudSelect: HTMLSelectElement;
  private readonly regionLabel: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: TimelineOptions,
  ) {
    // 默认近 3 个月
    const now = new Date();
    this.end = tomorrow();
    this.start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, now.getUTCDate());

    root.innerHTML =
      '<div class="flex items-center gap-2 text-xs text-stone-600">' +
      '<span data-region class="text-[13px] font-semibold text-stone-800 tabular-nums"></span>' +
      '<input type="date" data-start class="field-input py-0 text-xs" />–<input type="date" data-end class="field-input py-0 text-xs" />' +
      `<label class="flex items-center gap-1">云量 ≤<select data-cloud class="field-input py-0 text-xs">${CLOUD_OPTIONS.map(
        (c) => `<option value="${c}" ${c === DEFAULT_CLOUD ? 'selected' : ''}>${c}%</option>`,
      ).join('')}</select></label>` +
      '<span data-status class="ml-auto truncate text-stone-500"></span>' +
      '<button data-reset hidden class="tl-btn">恢复自动</button>' +
      '<button data-save class="tl-btn">保存区域选择</button>' +
      '<button data-close aria-label="关闭" title="关闭并取消选择区域" class="-mr-1 cursor-pointer rounded px-1 text-base leading-none text-stone-500 hover:bg-stone-100">×</button></div>' +
      '<div data-track class="relative mt-1 h-10 cursor-grab touch-none overflow-hidden rounded bg-stone-100 select-none active:cursor-grabbing">' +
      '<div data-bars class="absolute inset-0"></div></div>' +
      '<div data-axis class="relative h-3.5 overflow-hidden text-[10px] text-stone-500"></div>' +
      '<div data-tip hidden class="pointer-events-none absolute bottom-full mb-1.5 w-max max-w-72 rounded bg-stone-800/95 px-2.5 py-1.5 text-[11px] leading-relaxed text-white shadow"></div>';
    const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
    this.track = q('[data-track]');
    this.bars = q('[data-bars]');
    this.axis = q('[data-axis]');
    this.tip = q('[data-tip]');
    this.status = q('[data-status]');
    this.startInput = q('[data-start]');
    this.endInput = q('[data-end]');
    this.cloudSelect = q('[data-cloud]');
    this.regionLabel = q('[data-region]');
    this.saveBtn = q('[data-save]');
    this.resetBtn = q('[data-reset]');
    this.saveBtn.addEventListener('click', () => opts.onSave());
    this.resetBtn.addEventListener('click', () => opts.onReset());
    q('[data-close]').addEventListener('click', () => opts.onClose());

    this.startInput.addEventListener('change', () => this.applyInputs());
    this.endInput.addEventListener('change', () => this.applyInputs());
    this.cloudSelect.addEventListener('change', () => opts.onChange());
    this.bindPointer();
    this.track.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false });
    new ResizeObserver(() => this.render()).observe(this.track);
    this.render();
  }

  /** 检索时间段，起止均为含当天的 UTC 日期 */
  range(): { start: string; end: string } {
    return { start: isoDay(floorDay(this.start)), end: isoDay(Math.ceil(this.end / DAY) * DAY - DAY) };
  }

  cloud(): number {
    return Number(this.cloudSelect.value);
  }

  /** warn 为真时以提醒色显示 */
  setStatus(text: string, warn = false) {
    this.status.textContent = text;
    this.status.title = text;
    this.status.classList.toggle('text-amber-700', warn);
    this.status.classList.toggle('text-stone-500', !warn);
  }

  /** 更新记录，searched 为这些记录所属的检索时间段，起止均为含当天的 UTC 日期 */
  setGroups(
    groups: DateGroup[],
    recommended: string | undefined,
    selected: string | undefined,
    searched: { start: string; end: string },
  ) {
    this.groups = groups;
    this.recommended = recommended;
    this.selected = selected;
    this.searched = { start: dayStart(searched.start), end: dayStart(searched.end) + DAY };
    this.render();
  }

  setSelected(date: string | undefined) {
    this.selected = date;
    this.render();
  }

  /** 切换到另一个区域，清空上一个区域的记录 */
  setRegion(tile: string) {
    this.regionLabel.textContent = `区域 ${tile}`;
    this.groups = [];
    this.searched = undefined;
    this.setStatus('');
    this.render();
  }

  /** saved 为该区域已有保存的选择，dirty 为预览的日期尚未保存 */
  setPickState(saved: boolean, dirty: boolean) {
    this.saveBtn.disabled = !dirty;
    this.resetBtn.hidden = !saved;
  }

  private applyInputs() {
    const s = dayStart(this.startInput.value);
    const e = dayStart(this.endInput.value) + DAY;
    if (!(s < e)) {
      this.setStatus('起始日期晚于结束日期');
      return;
    }
    this.setRange(s, e);
    this.opts.onChange();
  }

  /** 设置可见范围，限制跨度并夹在存档起点与明天之间 */
  private setRange(start: number, end: number) {
    let span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, end - start));
    let s = start;
    if (end - start !== span) s = start + (end - start - span) / 2;
    const max = tomorrow();
    if (s + span > max) s = max - span;
    if (s < ARCHIVE_START) {
      s = ARCHIVE_START;
      span = Math.min(span, max - s);
    }
    this.start = s;
    this.end = s + span;
    this.scheduleRender();
  }

  private scheduleChange() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.opts.onChange(), CHANGE_DELAY_MS);
  }

  private scheduleRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private x(t: number, width: number) {
    return ((t - this.start) / (this.end - this.start)) * width;
  }

  private bindPointer() {
    let down: { x: number; start: number; end: number; moved: boolean } | undefined;
    this.track.addEventListener('pointerdown', (ev) => {
      down = { x: ev.clientX, start: this.start, end: this.end, moved: false };
      this.track.setPointerCapture(ev.pointerId);
      this.tip.hidden = true;
    });
    this.track.addEventListener('pointermove', (ev) => {
      if (!down) {
        this.showTip(ev);
        return;
      }
      const dx = ev.clientX - down.x;
      if (!down.moved && Math.abs(dx) < 4) return;
      down.moved = true;
      const shift = (-dx / this.track.clientWidth) * (down.end - down.start);
      this.setRange(down.start + shift, down.end + shift);
    });
    const finish = (ev: PointerEvent) => {
      if (!down) return;
      const { moved } = down;
      down = undefined;
      if (moved) {
        this.scheduleChange();
        return;
      }
      // 指针已被轨道捕获，事件目标总是轨道本身，按松开位置取柱子
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const date = hit?.closest<HTMLElement>('[data-date]')?.dataset.date;
      if (date) this.opts.onSelect(date);
    };
    this.track.addEventListener('pointerup', finish);
    this.track.addEventListener('pointercancel', () => (down = undefined));
    this.track.addEventListener('pointerleave', () => (this.tip.hidden = true));
  }

  /** 横向滚动平移，纵向滚动以指针为中心缩放 */
  private onWheel(ev: WheelEvent) {
    ev.preventDefault();
    const width = this.track.clientWidth;
    const span = this.end - this.start;
    if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
      const shift = (ev.deltaX / width) * span;
      this.setRange(this.start + shift, this.end + shift);
    } else {
      const rect = this.track.getBoundingClientRect();
      const anchor = this.start + ((ev.clientX - rect.left) / width) * span;
      const next = Math.min(MAX_SPAN, Math.max(MIN_SPAN, span * Math.exp(ev.deltaY * 0.0015)));
      const s = anchor - ((anchor - this.start) / span) * next;
      this.setRange(s, s + next);
    }
    this.tip.hidden = true;
    this.scheduleChange();
  }

  private showTip(ev: PointerEvent) {
    const bar = (ev.target as HTMLElement).closest<HTMLElement>('[data-date]');
    const g = bar && this.groups.find((x) => x.date === bar.dataset.date);
    if (!bar || !g) {
      this.tip.hidden = true;
      return;
    }
    const times = g.scenes.map((s) => s.datetime.slice(11, 19)).sort();
    const span = times[0] === times.at(-1) ? times[0] : `${times[0]}–${times.at(-1)}`;
    const weekday = '日一二三四五六'[new Date(g.date).getUTCDay()];
    const rows: [string, string][] = [
      ['成像时刻', `${span} UTC`],
      ['卫星', satellites(g)],
      ['景数', `${g.scenes.length} 景`],
      ['分幅覆盖', `${(g.coverage * 100).toFixed(0)}%`],
      ['平均云量', `${g.cloud.toFixed(1)}%`],
    ];
    this.tip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'font-semibold';
    title.textContent = `${g.date} 周${weekday}${g.date === this.recommended ? ' · 自动挑选' : ''}${g.date === this.selected ? ' · 正在显示' : ''}`;
    this.tip.append(title);
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.textContent = `${k}：${v}`;
      this.tip.append(row);
    }
    this.tip.hidden = false;
    const rootRect = this.root.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const center = barRect.left + barRect.width / 2 - rootRect.left;
    const w = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(Math.max(center - w / 2, 4), rootRect.width - w - 4)}px`;
  }

  private render() {
    const width = this.track.clientWidth;
    if (!width) return;
    if (document.activeElement !== this.startInput && document.activeElement !== this.endInput) {
      const r = this.range();
      this.startInput.value = r.start;
      this.endInput.value = r.end;
    }
    const dayPx = (DAY / (this.end - this.start)) * width;
    const barW = Math.max(3, Math.min(12, dayPx * 0.7));

    const ticks = this.ticks(width);
    const grid = ticks
      .map(([t]) => `<i class="absolute inset-y-0 w-px bg-stone-200" style="left:${this.x(t, width).toFixed(1)}px"></i>`)
      .join('');
    const bars = this.groups
      .map((g) => {
        const t = dayStart(g.date) + DAY / 2;
        if (t < this.start - DAY || t > this.end + DAY) return '';
        const left = this.x(t, width) - barW / 2;
        const h = Math.max(8, Math.round(g.coverage * 100));
        const sel = g.date === this.selected;
        const star =
          g.date === this.recommended
            ? `<b class="pointer-events-none absolute -top-0.5 -translate-x-1/2 text-[9px] leading-none text-sulu-800" style="left:${(left + barW / 2).toFixed(1)}px">★</b>`
            : '';
        return (
          `<span data-date="${g.date}" class="absolute bottom-0 cursor-pointer rounded-t-sm ${cloudClass(g.cloud)} hover:brightness-90 ${sel ? 'outline-2 outline-offset-1 outline-sky-600' : ''}" ` +
          `style="left:${left.toFixed(1)}px;width:${barW.toFixed(1)}px;height:calc(${h}% - 12px)"></span>` +
          star
        );
      })
      .join('');
    // 尚未检索的部分以斜纹遮盖
    const hatch = (a: number, b: number) => {
      const l = Math.max(0, this.x(a, width));
      const r = Math.min(width, this.x(b, width));
      return r - l > 0.5
        ? `<i class="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,var(--color-stone-200)_0_3px,transparent_3px_7px)]" style="left:${l.toFixed(1)}px;width:${(r - l).toFixed(1)}px"></i>`
        : '';
    };
    const sr = this.searched;
    const pending = sr ? hatch(this.start, sr.start) + hatch(sr.end, this.end) : hatch(this.start, this.end);
    this.bars.innerHTML = pending + grid + bars;
    this.axis.innerHTML = ticks
      .map(
        ([t, label]) =>
          `<span class="absolute top-0 -translate-x-1/2 whitespace-nowrap tabular-nums" style="left:${this.x(t, width).toFixed(1)}px">${label}</span>`,
      )
      .join('');
  }

  /** 按可见跨度选刻度间隔：日、周、半月或若干月 */
  private ticks(width: number): [number, string][] {
    const span = this.end - this.start;
    const pxPerDay = (width / span) * DAY;
    const out: [number, string][] = [];
    const dayLabel = (t: number) => {
      const d = new Date(t);
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    };
    for (const step of [1, 2, 7, 14]) {
      if (step * pxPerDay < TICK_MIN_PX) continue;
      // 周刻度对齐到周一，1970-01-05 是周一
      const base = step === 7 || step === 14 ? Date.UTC(1970, 0, 5) : 0;
      let t = Math.ceil((this.start - base) / (step * DAY)) * step * DAY + base;
      for (; t <= this.end; t += step * DAY) out.push([t, dayLabel(t)]);
      return out;
    }
    for (const months of [1, 2, 3, 6, 12]) {
      if (months * 30.4 * pxPerDay < TICK_MIN_PX) continue;
      const d = new Date(this.start);
      let y = d.getUTCFullYear();
      let m = Math.ceil((d.getUTCMonth() + (d.getUTCDate() > 1 ? 1 : 0)) / months) * months;
      for (;;) {
        const t = Date.UTC(y + Math.floor(m / 12), m % 12, 1);
        if (t > this.end) break;
        const mm = (m % 12) + 1;
        out.push([t, mm === 1 || months === 12 ? `${y + Math.floor(m / 12)} 年` : `${mm} 月`]);
        m += months;
      }
      return out;
    }
    return out;
  }
}
