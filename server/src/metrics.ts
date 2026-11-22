import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/** renderTile 内部各阶段耗时，单位毫秒 */
export interface RenderTiming {
  /** 等待各批景读取完成，含回源、解压与重投影坐标计算 */
  read: number;
  /** 按优先级写入像元 */
  composite: number;
  /** WebP 编码 */
  encode: number;
  /** 实际读取了窗口的景数 */
  scenes: number;
}

export interface RenderRecord extends RenderTiming {
  tile: string;
  /** 解析景元数据，未命中时需查询 STAC */
  resolve: number;
  /** 在渲染并发信号量前排队 */
  queue: number;
  /** renderTile 总耗时 */
  render: number;
}

/** 汇总周期 */
const INTERVAL_MS = 60_000;
/** 渲染耗时超过此值的瓦片单独记一条日志 */
const SLOW_MS = 5_000;
/** 空闲周期内事件循环延迟最大值超过此值时仍输出汇总 */
const LAG_ALERT_MS = 200;

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
let elu = performance.eventLoopUtilization();

let records: RenderRecord[] = [];
let aborted = 0;
let failed = 0;

export function recordRender(r: RenderRecord) {
  records.push(r);
  if (r.render >= SLOW_MS) {
    console.log(
      `[render] 慢瓦片 ${r.tile} ${r.scenes} 景，排队 ${ms(r.queue)}，渲染 ${ms(r.render)}` +
        `（读取 ${ms(r.read)}，合成 ${ms(r.composite)}，编码 ${ms(r.encode)}）`,
    );
  }
}

/** 渲染任务未完成即结束，中止指所有请求方都已离开 */
export function recordRenderEnd(isAbort: boolean) {
  if (isAbort) aborted++;
  else failed++;
}

const ms = (v: number) => `${Math.round(v)} ms`;
const MB = 1024 ** 2;

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function dist(values: number[]) {
  const s = values.toSorted((a, b) => a - b);
  return `p50 ${Math.round(pct(s, 0.5))} / p95 ${Math.round(pct(s, 0.95))} / max ${Math.round(s.at(-1)!)} ms`;
}

/**
 * 每个周期输出一行汇总：瓦片渲染的排队与渲染耗时分布、渲染各阶段占比、
 * 事件循环延迟与利用率、进程内存。没有渲染且事件循环正常时不输出
 */
function report() {
  const lagMax = loopDelay.max / 1e6;
  const done = records;
  if (done.length || aborted || failed || lagMax >= LAG_ALERT_MS) {
    const parts: string[] = [];
    if (done.length) {
      const total = done.reduce((a, r) => a + r.read + r.composite + r.encode, 0) || 1;
      const share = (k: 'read' | 'composite' | 'encode') =>
        `${Math.round((done.reduce((a, r) => a + r[k], 0) / total) * 100)}%`;
      parts.push(
        `瓦片 ${done.length} 个，排队 ${dist(done.map((r) => r.queue))}，渲染 ${dist(done.map((r) => r.render))}` +
          `（读取 ${share('read')}，合成 ${share('composite')}，编码 ${share('encode')}）`,
      );
    }
    if (aborted || failed) parts.push(`中止 ${aborted} 个，失败 ${failed} 个`);
    const u = performance.eventLoopUtilization(elu);
    const lag = (p: number) => Math.round(loopDelay.percentile(p) / 1e6);
    parts.push(`事件循环延迟 p50 ${lag(50)} / p99 ${lag(99)} / max ${Math.round(lagMax)} ms，利用率 ${Math.round(u.utilization * 100)}%`);
    const m = process.memoryUsage();
    parts.push(`rss ${Math.round(m.rss / MB)} MB，ArrayBuffer ${Math.round(m.arrayBuffers / MB)} MB`);
    console.log(`[metrics] ${parts.join('；')}`);
  }
  records = [];
  aborted = 0;
  failed = 0;
  loopDelay.reset();
  elu = performance.eventLoopUtilization();
}

setInterval(report, INTERVAL_MS).unref();
