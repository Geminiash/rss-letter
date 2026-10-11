/**
 * 进程内限流器：滑动窗口太重，固定窗口（每 IP 每 60 秒 N 次）对自托管场景足够。
 * 纯函数化 now 注入，便于测试。
 */
export interface RateLimiter {
  /** 返回 true 表示放行，false 表示已超限。 */
  check(key: string): boolean;
  /** 清空计数（测试与运维用）。 */
  reset(): void;
  get size(): number;
}

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  now?: () => number;
}

interface Entry {
  count: number;
  resetAt: number;
}

/** 计数超过阈值时顺带清理过期 key，防止长期运行的内存膨胀。 */
function prune(map: Map<string, Entry>, now: number): void {
  if (map.size < 1024) return;
  for (const [key, entry] of map) {
    if (entry.resetAt < now) map.delete(key);
  }
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { max, windowMs, now = Date.now } = options;
  const map = new Map<string, Entry>();

  return {
    check(key: string): boolean {
      const t = now();
      prune(map, t);
      const entry = map.get(key);
      if (!entry || entry.resetAt <= t) {
        map.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= max;
    },
    reset(): void {
      map.clear();
    },
    get size(): number {
      return map.size;
    },
  };
}
