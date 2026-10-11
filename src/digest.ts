/**
 * 每周摘要：拉取全部源，聚合过去 N 天（默认 7）的新条目，
 * 按订阅者语言发送；无新内容不发信。
 * 可由 CLI（pnpm digest）、cron 或 POST /api/digest/run（x-admin-token）触发。
 */
import type { AppConfig } from './config.js';
import { confirmedSubscribers, type Lang } from './db.js';
import { digestMail, type DigestItem, type MailSender } from './mail.js';
import { fetchAllSources, type RssItem } from './rss.js';

export interface DigestResult {
  /** 聚合到的近窗条目数 */
  items: number;
  /** 实际发出的邮件数 */
  sent: number;
  perLang: { zh: number; en: number };
  failedSources: Array<{ url: string; error: string }>;
  /** 'no_new_items' | 'no_subscribers' | 'done' */
  outcome: 'no_new_items' | 'no_subscribers' | 'done' | 'no_sources';
}

/** 过去 N 天内的条目。 */
export function filterRecent(items: RssItem[], days: number, now = Date.now()): RssItem[] {
  const since = now - days * 24 * 3600 * 1000;
  return items.filter((it) => it.pubDate.valueOf() >= since);
}

/** 近窗 → 按链接去重 → 新→旧排序 → 截断到上限。 */
export function selectDigestItems(items: RssItem[], max: number, days: number, now = Date.now()): RssItem[] {
  const seen = new Set<string>();
  const deduped: RssItem[] = [];
  for (const it of filterRecent(items, days, now)) {
    const key = it.link || it.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }
  deduped.sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());
  return deduped.slice(0, Math.max(1, max));
}

function toDigestItems(items: RssItem[]): DigestItem[] {
  return items.map((it) => ({
    title: it.title,
    link: it.link,
    description: it.description,
    source: it.source,
    date: it.pubDate,
  }));
}

export async function runDigest(
  cfg: AppConfig,
  deps: {
    fetchSources?: (urls: string[]) => Promise<{ items: RssItem[]; failed: Array<{ url: string; error: string }> }>;
    send?: MailSender;
    now?: number;
  } = {},
): Promise<DigestResult> {
  const fetchSources = deps.fetchSources ?? fetchAllSources;
  const now = deps.now ?? Date.now();

  if (cfg.rssSources.length === 0) {
    console.error('[digest] 未配置 RSS_SOURCES，无事可做');
    return { items: 0, sent: 0, perLang: { zh: 0, en: 0 }, failedSources: [], outcome: 'no_sources' };
  }

  const { items, failed } = await fetchSources(cfg.rssSources);
  const selected = selectDigestItems(items, cfg.digestMaxItems, cfg.digestDays, now);
  console.log(
    `[digest] 源 ${cfg.rssSources.length} 个，拉到 ${items.length} 条，近 ${cfg.digestDays} 天 ${selected.length} 条` +
      (failed.length ? `，失败源 ${failed.length} 个` : ''),
  );
  for (const f of failed) console.error(`[digest] 源失败 ${f.url}: ${f.error}`);

  if (selected.length === 0) {
    console.log('[digest] 近窗没有新内容，本次不发信');
    return { items: 0, sent: 0, perLang: { zh: 0, en: 0 }, failedSources: failed, outcome: 'no_new_items' };
  }

  const digestItems = toDigestItems(selected);
  const perLang = { zh: 0, en: 0 };
  let anySubscriber = false;
  let sent = 0;

  for (const lang of ['zh', 'en'] as const) {
    const subscribers = confirmedSubscribers(lang as Lang);
    if (subscribers.length === 0) continue;
    anySubscriber = true;
    const send = deps.send;
    if (!send) {
      // dry-run（无 SMTP / 注入空 sender）：只确认有收件人，不计数
      continue;
    }
    for (const sub of subscribers) {
      try {
        await send(sub.email, digestMail(cfg, sub.token, lang, digestItems), sub.token);
        sent += 1;
        perLang[lang] += 1;
      } catch (err) {
        console.error(`[digest] 发送失败 ${sub.email}:`, err);
      }
    }
  }

  const outcome = anySubscriber ? 'done' : 'no_subscribers';
  console.log(`[digest] 完成：sent=${sent} outcome=${outcome}`);
  return { items: selected.length, sent, perLang, failedSources: failed, outcome };
}

// CLI 直执行：pnpm digest / node dist/digest.js
if (
  process.argv[1]?.replace(/\\/g, '/').endsWith('digest.ts') ||
  process.argv[1]?.endsWith('digest.js')
) {
  const { loadConfig, smtpConfigured } = await import('./config.js');
  const { createTransporter, realSender } = await import('./mail.js');
  const { configureDb } = await import('./db.js');
  const cfg = loadConfig();
  configureDb(cfg.dbPath);
  if (!smtpConfigured(cfg)) {
    console.error('[digest] SMTP 未配置（SMTP_HOST/SMTP_USER/SMTP_PASS/SENDER_EMAIL），无法发送');
    process.exit(1);
  }
  const transporter = createTransporter(cfg);
  if (!transporter) {
    console.error('[digest] SMTP 传输器创建失败');
    process.exit(1);
  }
  runDigest(cfg, { send: realSender(cfg, transporter) })
    .then((r) => {
      if (r.outcome === 'no_new_items') process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
