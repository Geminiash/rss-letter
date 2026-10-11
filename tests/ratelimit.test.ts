import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/ratelimit.js';

describe('createRateLimiter', () => {
  it('窗口内放行 max 次，之后拒绝', () => {
    let t = 1_000_000;
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000, now: () => t });
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip1')).toBe(false);
    expect(limiter.check('ip1')).toBe(false);
    // 不同 key 互不影响
    expect(limiter.check('ip2')).toBe(true);
    t += 60_001;
    expect(limiter.check('ip1')).toBe(true);
  });

  it('窗口边界：resetAt 之前仍拒绝，之后重置', () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 10_000, now: () => t });
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    t = 9_999;
    expect(limiter.check('a')).toBe(false);
    t = 10_000;
    expect(limiter.check('a')).toBe(true);
  });

  it('reset 清空计数', () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => t });
    limiter.check('a');
    expect(limiter.check('a')).toBe(false);
    limiter.reset();
    expect(limiter.check('a')).toBe(true);
  });

  it('大量 key 时顺带清理过期条目', () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1_000, now: () => t });
    for (let i = 0; i < 2_000; i++) limiter.check(`key-${i}`);
    t = 2_000;
    for (let i = 0; i < 2_000; i++) limiter.check(`key2-${i}`);
    // 过期的 key-* 已被清理，Map 不会无限膨胀
    expect(limiter.size).toBeLessThanOrEqual(2_000);
    expect(limiter.size).toBeGreaterThan(0);
  });
});
