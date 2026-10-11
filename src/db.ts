/**
 * 订阅数据库（node:sqlite）。
 * 隐私约定：只保存邮箱、语言偏好、订阅时间与状态，不做其他用途。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export type Lang = 'zh' | 'en';
export type Status = 'pending' | 'confirmed' | 'unsubscribed';

export interface SubscriberRow {
  id: number;
  email: string;
  lang: Lang;
  status: Status;
  token: string;
  subscribed_at: string;
  confirmed_at: string | null;
}

export interface SubscriberCounts {
  total: number;
  confirmed: number;
  pending: number;
  unsubscribed: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    lang TEXT NOT NULL DEFAULT 'zh',
    status TEXT NOT NULL DEFAULT 'pending',
    token TEXT NOT NULL UNIQUE,
    subscribed_at TEXT NOT NULL,
    confirmed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_subscribers_status_lang ON subscribers(status, lang);
`;

let _db: DatabaseSync | null = null;
let _path = process.env.RSS_LETTER_DB ?? './data/rss-letter.sqlite';

/** 测试或迁移场景：切换数据库文件（会先关闭现有连接）。 */
export function configureDb(path: string): void {
  closeDb();
  _path = path;
}

export function getDb(): DatabaseSync {
  if (!_db) {
    mkdirSync(dirname(_path), { recursive: true });
    _db = new DatabaseSync(_path);
    _db.exec(SCHEMA);
  }
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

/** 测试辅助：关闭并删除数据库文件。 */
export function destroyDb(): void {
  const path = _path;
  closeDb();
  try {
    rmSync(path, { force: true });
  } catch {
    /* 忽略：文件可能已被外部清理 */
  }
}

export function upsertPending(email: string, lang: Lang): string {
  const db = getDb();
  const existing = db.prepare('SELECT id, status, token FROM subscribers WHERE email = ?').get(email) as
    | { id: number; status: Status; token: string }
    | undefined;

  // 已确认的老订户不重置状态与 token，只同步语言偏好（可重发确认邮件以防丢失）
  if (existing?.status === 'confirmed') {
    db.prepare('UPDATE subscribers SET lang = ? WHERE id = ?').run(lang, existing.id);
    return existing.token;
  }

  const token = randomUUID();
  const now = new Date().toISOString();
  if (existing) {
    // pending / unsubscribed 都回到 pending：换新 token，清空确认时间
    db.prepare(
      "UPDATE subscribers SET lang = ?, token = ?, subscribed_at = ?, status = 'pending', confirmed_at = NULL WHERE id = ?",
    ).run(lang, token, now, existing.id);
    return token;
  }
  db.prepare(
    'INSERT INTO subscribers (email, lang, status, token, subscribed_at) VALUES (?, ?, ?, ?, ?)',
  ).run(email, lang, 'pending', token, now);
  return token;
}

export function findByToken(token: string): SubscriberRow | undefined {
  return getDb().prepare('SELECT * FROM subscribers WHERE token = ?').get(token) as
    | SubscriberRow
    | undefined;
}

export function confirmByToken(token: string): SubscriberRow | undefined {
  const row = findByToken(token);
  if (!row || row.status === 'unsubscribed') return undefined;
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ? WHERE id = ?")
    .run(now, row.id);
  return { ...row, status: 'confirmed', confirmed_at: now };
}

export function unsubscribeByToken(token: string): boolean {
  const result = getDb()
    .prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE token = ?")
    .run(token);
  return Number(result.changes) > 0;
}

export function confirmedSubscribers(lang: Lang): SubscriberRow[] {
  return getDb()
    .prepare("SELECT * FROM subscribers WHERE status = 'confirmed' AND lang = ?")
    .all(lang) as unknown as SubscriberRow[];
}

export function countSubscribers(): SubscriberCounts {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status')
    .all() as Array<{ status: Status; n: number }>;
  const byStatus = new Map(rows.map((r) => [r.status, r.n]));
  const confirmed = byStatus.get('confirmed') ?? 0;
  const pending = byStatus.get('pending') ?? 0;
  const unsubscribed = byStatus.get('unsubscribed') ?? 0;
  return { total: confirmed + pending + unsubscribed, confirmed, pending, unsubscribed };
}
