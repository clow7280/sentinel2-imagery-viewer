import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Entry {
  status: number;
  contentType: string;
  storedAt: number;
  /** 附加元数据，例如 COG 对象的总字节数 */
  extra?: Record<string, unknown>;
  body: Buffer;
}

export type CacheStatus = 'HIT' | 'MISS' | 'STALE';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * 以文件为单位的磁盘缓存，单个文件格式为 4 字节元数据长度、JSON 元数据、响应体。
 * 读取命中时刷新修改时间，淘汰时按修改时间从旧到新删除，近似 LRU。
 */
export class DiskCache {
  constructor(
    readonly name: string,
    readonly dir: string,
    readonly maxBytes: number,
  ) {}

  private file(key: string) {
    const h = sha(key);
    return path.join(this.dir, h.slice(0, 2), h);
  }

  async get(key: string): Promise<Entry | undefined> {
    const f = this.file(key);
    try {
      const buf = await readFile(f);
      const n = buf.readUInt32BE(0);
      const meta = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
      const now = new Date();
      utimes(f, now, now).catch(() => {});
      return { ...meta, body: buf.subarray(4 + n) };
    } catch {
      return undefined;
    }
  }

  /**
   * 先写临时文件再改名，读者不会读到半个文件。
   * 同一键可能被并发写入，例如相互重叠的 COG 分块区间，临时文件名带随机串避免互相覆盖；
   * 缓存只是加速手段，写入失败只记日志，不影响本次响应
   */
  async put(key: string, entry: Entry): Promise<void> {
    const f = this.file(key);
    const { body, ...meta } = entry;
    const head = Buffer.from(JSON.stringify(meta), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length, 0);
    const tmp = `${f}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(tmp, Buffer.concat([len, head, body]));
      await rename(tmp, f);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      console.warn(`[cache] ${this.name} 写入失败：${(err as Error).message}`);
    }
  }

  /** 逐个读取缓存文件的元数据，不读响应体 */
  async *metas(): AsyncGenerator<Omit<Entry, 'body'>> {
    const subdirs = await readdir(this.dir).catch(() => [] as string[]);
    for (const sub of subdirs) {
      const d = path.join(this.dir, sub);
      for (const name of await readdir(d).catch(() => [] as string[])) {
        if (name.endsWith('.tmp')) continue;
        const fh = await open(path.join(d, name)).catch(() => undefined);
        if (!fh) continue;
        try {
          const len = Buffer.alloc(4);
          await fh.read(len, 0, 4, 0);
          const head = Buffer.alloc(len.readUInt32BE(0));
          await fh.read(head, 0, head.length, 4);
          yield JSON.parse(head.toString('utf8'));
        } catch {
          // 写入中或损坏的文件跳过
        } finally {
          await fh.close();
        }
      }
    }
  }

  /** 超出上限时删除最久未访问的文件，直到降到上限的九成，返回删除的文件数 */
  async sweep(): Promise<number> {
    const files: { f: string; size: number; mtime: number }[] = [];
    let total = 0;
    let subdirs: string[];
    try {
      subdirs = await readdir(this.dir);
    } catch {
      return 0;
    }
    for (const sub of subdirs) {
      const d = path.join(this.dir, sub);
      for (const name of await readdir(d).catch(() => [] as string[])) {
        const f = path.join(d, name);
        const st = await stat(f).catch(() => undefined);
        if (!st?.isFile()) continue;
        if (name.endsWith('.tmp') && Date.now() - st.mtimeMs > 3600_000) {
          await rm(f, { force: true });
          continue;
        }
        files.push({ f, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      }
    }
    if (total <= this.maxBytes) return 0;
    files.sort((a, b) => a.mtime - b.mtime);
    const target = this.maxBytes * 0.9;
    let removed = 0;
    for (const { f, size } of files) {
      if (total <= target) break;
      await rm(f, { force: true });
      total -= size;
      removed++;
    }
    console.log(`[cache] ${this.name} 淘汰 ${removed} 个文件，剩余 ${(total / 1024 ** 3).toFixed(2)} GB`);
    return removed;
  }
}

/** 限制同时进行的上游请求数，避免突发瓦片请求压垮小内存主机 */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** 同一键的并发请求只向上游发一次 */
export class Inflight<T> {
  private map = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.map.get(key);
    if (!p) {
      p = fn().finally(() => this.map.delete(key));
      this.map.set(key, p);
    }
    return p;
  }
}
