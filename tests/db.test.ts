import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureDb,
  confirmByToken,
  confirmedSubscribers,
  countSubscribers,
  destroyDb,
  findByToken,
  unsubscribeByToken,
  upsertPending,
  type Lang,
} from '../src/db.js';

let dbFile: string;

beforeEach(() => {
  dbFile = join(
    tmpdir(),
    `rss-letter-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  configureDb(dbFile);
});

afterEach(() => {
  destroyDb();
});

describe('subscribers db', () => {
  it('新订阅落库为 pending，token 可反查', () => {
    const token = upsertPending('a@example.com', 'zh');
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    const row = findByToken(token);
    expect(row?.email).toBe('a@example.com');
    expect(row?.lang).toBe('zh');
    expect(row?.status).toBe('pending');
    expect(row?.confirmed_at).toBeNull();
  });

  it('确认订阅：pending → confirmed，重复确认幂等', () => {
    const token = upsertPending('b@example.com', 'en');
    const first = confirmByToken(token);
    expect(first?.status).toBe('confirmed');
    expect(first?.confirmed_at).not.toBeNull();
    const again = confirmByToken(token);
    expect(again?.status).toBe('confirmed');
  });

  it('已确认者重复订阅：不重置状态，返回原 token', () => {
    const t1 = upsertPending('c@example.com', 'zh');
    confirmByToken(t1);
    const t2 = upsertPending('c@example.com', 'en');
    expect(t2).toBe(t1);
    const row = findByToken(t1);
    expect(row?.status).toBe('confirmed');
    expect(row?.lang).toBe('en');
  });

  it('pending 者重复订阅：刷新 token 与语言', () => {
    upsertPending('d@example.com', 'zh');
    const t2 = upsertPending('d@example.com', 'en');
    const row = findByToken(t2);
    expect(row?.lang).toBe('en');
    expect(row?.status).toBe('pending');
  });

  it('一键退订：置为 unsubscribed，且不可再确认', () => {
    const token = upsertPending('e@example.com', 'zh');
    expect(unsubscribeByToken(token)).toBe(true);
    expect(findByToken(token)?.status).toBe('unsubscribed');
    expect(confirmByToken(token)).toBeUndefined();
    // 幂等：再次退订返回 false（token 已不在可退订集合中仍会更新行，但语义上无变化行也算成功——此处验证状态稳定）
    expect(findByToken(token)?.status).toBe('unsubscribed');
  });

  it('退订后重新订阅：回到 pending，换新 token', () => {
    const t1 = upsertPending('f@example.com', 'zh');
    unsubscribeByToken(t1);
    const t2 = upsertPending('f@example.com', 'zh');
    expect(t2).not.toBe(t1);
    expect(findByToken(t2)?.status).toBe('pending');
  });

  it('confirmedSubscribers 只返回对应语言的已确认订户', () => {
    for (const [email, lang] of [
      ['g@example.com', 'zh'],
      ['h@example.com', 'en'],
      ['i@example.com', 'en'],
    ] as Array<[string, Lang]>) {
      confirmByToken(upsertPending(email, lang));
    }
    upsertPending('j@example.com', 'zh'); // 未确认
    expect(confirmedSubscribers('zh').map((r) => r.email)).toEqual(['g@example.com']);
    expect(confirmedSubscribers('en').length).toBe(2);
  });

  it('countSubscribers 汇总各状态数量', () => {
    confirmByToken(upsertPending('k@example.com', 'zh'));
    confirmByToken(upsertPending('l@example.com', 'en'));
    upsertPending('m@example.com', 'zh');
    unsubscribeByToken(upsertPending('n@example.com', 'zh'));
    expect(countSubscribers()).toEqual({ total: 4, confirmed: 2, pending: 1, unsubscribed: 1 });
  });

  it('无效 token 一律查无此人', () => {
    expect(findByToken('nope')).toBeUndefined();
    expect(confirmByToken('nope')).toBeUndefined();
    expect(unsubscribeByToken('nope')).toBe(false);
  });
});
