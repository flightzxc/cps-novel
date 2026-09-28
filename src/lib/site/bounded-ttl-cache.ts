/**
 * 有界 TTL/LRU 缓存。
 *
 * 移植自 CPS v8.5.1 `src/lib/site-search/bounded-cache.ts`（结构与注释逐条
 * 保留，仅去掉与 CPS 站内搜索耦合的措辞——本仓第一个调用方是
 * `related-novels.ts` 的相关推荐候选池，不是搜索）。泛型、零业务耦合：
 * 不 import 任何业务类型，TTL/容量全部由调用方通过 options 传入。
 */

export interface BoundedTtlCacheOptions<V> {
  maxEntries: number;
  ttlMs: number;
  /** in-flight 去重表的容量上限，默认等于 maxEntries。 */
  maxInflight?: number;
  /** 返回 false 的值不写入缓存（例如降级态/空结果不值得占位）。 */
  shouldCache?: (value: V) => boolean;
  /** 注入假时钟用，默认 Date.now。 */
  now?: () => number;
}

export interface BoundedTtlCache<V> {
  getOrLoad(key: string, load: () => Promise<V>): Promise<V>;
  /** 只读，不触发 LRU 提升——测试专用，不要在业务代码里调用。 */
  peekForTest(key: string): V | undefined;
  sizeForTest(): { entries: number; inflight: number };
  clear(): void;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export function createBoundedTtlCache<V>(options: BoundedTtlCacheOptions<V>): BoundedTtlCache<V> {
  const { maxEntries, ttlMs } = options;
  const maxInflight = options.maxInflight ?? maxEntries;
  const shouldCache = options.shouldCache ?? (() => true);
  const now = options.now ?? Date.now;

  // entries: Map 保持插入序，插入序即 LRU 序——队首
  // (entries.keys().next().value) 是最久未用的一条。每次命中或写入都会
  // 把该 key delete 后重新 set，使其移动到队尾（最近使用）。
  const entries = new Map<string, CacheEntry<V>>();
  const inflight = new Map<string, Promise<V>>();

  // 有界惰性清扫：从队首开始逐个检查过期，遇到未过期项立即停止（同一 ttl
  // 下，越靠队尾的条目 expiresAt 越晚，队首一旦未过期，后面的也不会过期）。
  // 用 maxEntries 兜底扫描次数上限，只是防御性保证终止，不是主要的效率来源
  // ——真正省下的是"不用每次写都全表扫描"。
  function evictExpiredFromFront(nowMs: number) {
    let scanned = 0;
    while (scanned < maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) return;
      const oldestEntry = entries.get(oldestKey);
      if (!oldestEntry || oldestEntry.expiresAt > nowMs) return;
      entries.delete(oldestKey);
      scanned += 1;
    }
  }

  // 写入前腾位置：仅当已达容量上限时才需要处理。先做有界惰性清扫，清扫后
  // 仍然满（说明队首都是未过期的活条目）则直接驱逐队首一条（纯 LRU 淘汰）。
  function makeRoomForWrite(nowMs: number) {
    if (entries.size < maxEntries) return;
    evictExpiredFromFront(nowMs);
    if (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) entries.delete(oldestKey);
    }
  }

  return {
    async getOrLoad(key, load) {
      // ttlMs <= 0 是运维关闭缓存的开关：直通，不写 entries/inflight 两张表，
      // 每次都真正调用 load。也便于测试对照"缓存开/关"两种行为。
      if (ttlMs <= 0) {
        return load();
      }

      const nowMs = now();
      const cached = entries.get(key);
      if (cached) {
        if (cached.expiresAt <= nowMs) {
          entries.delete(key);
        } else {
          // 命中：delete + set 把该 key 移到 Map 队尾，完成 LRU 提升。
          entries.delete(key);
          entries.set(key, cached);
          return cached.value;
        }
      }

      const pending = inflight.get(key);
      if (pending) return pending;

      // in-flight 表本身也必须有上限。公开入口下，大量互异查询词并发到来
      // 时，若 inflight 无界增长，即便 entries 有容量上限，内存依然可能被
      // 瞬时并发的 pending Promise 撑爆。超限时不注册去重、直接执行 load
      // 并返回——退化为这一次不做去重，但保证 inflight 表大小始终有界。
      if (inflight.size >= maxInflight) {
        return load();
      }

      const next = load()
        .then((value) => {
          if (shouldCache(value)) {
            const writeNowMs = now();
            makeRoomForWrite(writeNowMs);
            entries.set(key, { value, expiresAt: writeNowMs + ttlMs });
          }
          return value;
        })
        .finally(() => {
          // load reject 时同样要清理 inflight，让下次同 key 请求能重新执行
          // load；reject 本身不吞掉，继续向上抛给调用方。
          inflight.delete(key);
        });

      inflight.set(key, next);
      return next;
    },

    peekForTest(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) return undefined;
      return entry.value;
    },

    sizeForTest() {
      return { entries: entries.size, inflight: inflight.size };
    },

    clear() {
      entries.clear();
      inflight.clear();
    },
  };
}
