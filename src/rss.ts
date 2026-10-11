/**
 * RSS / Atom 解析：零依赖，正则提取足够应对主流 feed。
 * 同时兼容 RSS 2.0（item/pubDate/description）与 Atom（entry/published/summary + link href）。
 */
import { stripTags } from './mail.js';

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: Date;
  /** 来源 feed 的 URL（聚合去重与展示用） */
  source: string;
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function decodeEntities(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&nbsp;', ' ');
}

function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(stripCdata(m[1] ?? '')) : '';
}

/** Atom 条目的链接在 <link href="..."> 属性上，优先 rel="alternate"，其次第一个无 rel 的 link。 */
function atomLink(block: string): string {
  const alternate = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alternate) return decodeEntities(alternate[1] ?? '');
  const plain = block.match(/<link\b(?![^>]*rel=)[^>]*href=["']([^"']+)["']/i);
  if (plain) return decodeEntities(plain[1] ?? '');
  const bare = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  return bare ? decodeEntities(bare[1] ?? '') : '';
}

function parseItemBlock(block: string, source: string, isAtom: boolean): RssItem | null {
  const title = tagText(block, 'title');
  const link = isAtom ? atomLink(block) : tagText(block, 'link');
  const rawDescription =
    tagText(block, 'description') ||
    tagText(block, 'summary') ||
    tagText(block, 'content:encoded') ||
    tagText(block, 'content');
  const dateRaw =
    tagText(block, 'pubDate') ||
    tagText(block, 'published') ||
    tagText(block, 'updated') ||
    tagText(block, 'dc:date');
  const pubDate = new Date(dateRaw);

  if (!title && !link) return null;
  return {
    title: stripTags(title, 300) || '(untitled)',
    link: link.trim(),
    // 两级解码夹一次剥标签：XML 转义 → 去 HTML 标签 → 残留实体（&amp; 等）呈现为明文
    description: decodeEntities(stripTags(decodeEntities(rawDescription))),
    pubDate,
    source,
  };
}

/** 解析 feed XML 为条目列表（RSS 2.0 与 Atom 皆可）。 */
export function parseFeed(xml: string, source: string): RssItem[] {
  const blocks = [
    ...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi),
  ].map((m) => ({ kind: (m[1] ?? '').toLowerCase(), body: m[2] ?? '' }));
  const items: RssItem[] = [];
  for (const block of blocks) {
    const item = parseItemBlock(block.body, source, block.kind === 'entry');
    if (item) items.push(item);
  }
  return items;
}

/** 拉取单个 feed。失败抛错，由上层聚合处理。 */
export async function fetchFeed(url: string, timeoutMs = 15_000): Promise<RssItem[]> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'rss-letter/0.1 (+self-hosted digest)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`RSS 拉取失败：${url} → HTTP ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml, url);
}

export interface FetchResult {
  items: RssItem[];
  failed: Array<{ url: string; error: string }>;
}

/** 并发拉取全部源：单个源失败不影响其他源，失败信息原样返回。 */
export async function fetchAllSources(urls: string[]): Promise<FetchResult> {
  const results = await Promise.allSettled(urls.map((url) => fetchFeed(url)));
  const items: RssItem[] = [];
  const failed: Array<{ url: string; error: string }> = [];
  results.forEach((r, i) => {
    const url = urls[i] ?? '';
    if (r.status === 'fulfilled') {
      items.push(...r.value);
    } else {
      failed.push({ url, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }
  });
  return { items, failed };
}
