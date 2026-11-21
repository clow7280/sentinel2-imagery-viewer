import path from 'node:path';

const GB = 1024 ** 3;
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const config = {
  port: num('PORT', 8787),
  host: process.env.HOST ?? '127.0.0.1',
  cacheDir: path.resolve(process.env.CACHE_DIR ?? '.cache'),
  /** 各类缓存的磁盘上限，超出后按最近访问时间淘汰 */
  maxBytes: {
    cog: num('CACHE_COG_GB', 20) * GB,
    tiles: num('CACHE_TILES_GB', 4) * GB,
    meta: num('CACHE_META_GB', 1) * GB,
  },
  /** 每个 IP 每分钟允许的接口请求数 */
  rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 3000),
  /** 同时向上游发出的请求数上限 */
  upstreamConcurrency: num('UPSTREAM_CONCURRENCY', 24),
};
