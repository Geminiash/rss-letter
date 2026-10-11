import { describe, expect, it } from 'vitest';
import { parseFeed, type RssItem } from '../src/rss.js';
import { filterRecent, selectDigestItems } from '../src/digest.js';

// ---- RSS 2.0 fixture（CDATA + 实体 + 常见字段）----
const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Example Blog</title>
<item>
  <title><![CDATA[第一篇：标题里有 & 符号]]></title>
  <link>https://example.org/posts/one</link>
  <pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate>
  <description><![CDATA[<p>正文摘要 <b>加粗</b></p>]]></description>
</item>
<item>
  <title>第二篇：纯文本标题</title>
  <link>https://example.org/posts/two</link>
  <pubDate>Tue, 06 Oct 2026 09:30:00 GMT</pubDate>
  <description>含 &amp;amp; 实体与 &lt;标签&gt; 文本</description>
</item>
</channel></rss>`;

// ---- Atom fixture（link href / published / summary）----
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Example Feed</title>
<entry>
  <title>Atom Entry A</title>
  <link rel="alternate" type="text/html" href="https://example.org/atom/a"/>
  <published>2026-10-07T10:00:00Z</published>
  <summary>Summary text here</summary>
</entry>
<entry>
  <title>Atom Entry B</title>
  <link href="https://example.org/atom/b"/>
  <updated>2026-10-08T12:00:00Z</updated>
  <content type="html">&lt;p&gt;escaped html content&lt;/p&gt;</content>
</entry>
</feed>`;

const SRC = 'https://example.org/feed.xml';

describe('parseFeed', () => {
  it('解析 RSS 2.0：CDATA、实体、日期', () => {
    const items = parseFeed(RSS2, SRC);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: '第一篇：标题里有 & 符号',
      link: 'https://example.org/posts/one',
      source: SRC,
    });
    expect(items[0]!.pubDate.valueOf()).toBe(Date.parse('2026-10-05T08:00:00Z'));
    expect(items[0]!.description).toBe('正文摘要 加粗');
    expect(items[1]!.description).toBe('含 & 实体与 文本');
  });

  it('解析 Atom：link href 属性、published/updated、summary/content', () => {
    const items = parseFeed(ATOM, SRC);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Atom Entry A',
      link: 'https://example.org/atom/a',
      description: 'Summary text here',
    });
    expect(items[0]!.pubDate.valueOf()).toBe(Date.parse('2026-10-07T10:00:00Z'));
    expect(items[1]!.link).toBe('https://example.org/atom/b');
    // content 里的 HTML 被剥掉，只留文本
    expect(items[1]!.description).toBe('escaped html content');
  });

  it('空 feed / 无条目返回空数组', () => {
    expect(parseFeed('<rss><channel><title>x</title></channel></rss>', SRC)).toEqual([]);
  });

  it('缺链接缺标题的条目被丢弃', () => {
    const xml = '<rss><channel><item><description>only desc</description></item></channel></rss>';
    expect(parseFeed(xml, SRC)).toHaveLength(0);
  });
});

describe('digest selection', () => {
  const now = Date.parse('2026-10-11T00:00:00Z');
  const mk = (daysAgo: number, link: string): RssItem => ({
    title: `item-${link}`,
    link,
    description: '',
    pubDate: new Date(now - daysAgo * 24 * 3600 * 1000),
    source: SRC,
  });

  it('filterRecent 只保留时间窗内的条目', () => {
    const items = [mk(1, 'a'), mk(6.9, 'b'), mk(8, 'c')];
    expect(filterRecent(items, 7, now).map((i) => i.link)).toEqual(['a', 'b']);
  });

  it('selectDigestItems：去重、按新到旧排序、截断上限', () => {
    const items = [
      mk(3, 'https://x/1'),
      mk(2, 'https://x/1'), // 重复链接
      mk(5, 'https://x/2'),
      mk(9, 'https://x/out-of-window'),
      mk(1, 'https://x/3'),
    ];
    const selected = selectDigestItems(items, 2, 7, now);
    // 去重保留首个（较旧的那条 x/1），新到旧排序后截断
    expect(selected.map((i) => i.link)).toEqual(['https://x/3', 'https://x/1']);
  });
});
