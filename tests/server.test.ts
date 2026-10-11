import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config.js';
import { createApp } from '../src/index.js';
import { closeDb, configureDb } from '../src/db.js';
import type { MailText } from '../src/mail.js';
import type { RssItem } from '../src/rss.js';

const REPO_TEMPLATES = join(import.meta.dirname, '..', 'templates');

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: './data/test.sqlite',
    adminToken: 'test-admin-token',
    rssSources: ['https://example.org/rss.xml'],
    digestDays: 7,
    digestMaxItems: 20,
    siteName: 'rss-letter',
    siteUrl: 'https://example.org',
    apiUrl: '',
    senderName: 'rss-letter',
    senderEmail: 'noreply@example.org',
    smtpHost: 'smtp.example.org',
    smtpPort: 465,
    smtpUser: 'user',
    smtpPass: 'pass',
    templatesDir: REPO_TEMPLATES,
    defaultLang: 'zh',
    ...overrides,
  };
}

const sent: Array<{ to: string; mail: MailText; token: string }> = [];
const mockSender = async (to: string, mail: MailText, token: string): Promise<void> => {
  sent.push({ to, mail, token });
};

let app = createApp(cfg(), { sender: mockSender });
let dbFile: string;

beforeEach(() => {
  sent.length = 0;
  dbFile = join(
    tmpdir(),
    `rss-letter-srv-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  configureDb(dbFile);
  app = createApp(cfg(), { sender: mockSender });
});

afterEach(() => {
  closeDb();
});

function post(path: string, body: unknown, ip = '203.0.113.1'): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

function get(path: string, ip = '203.0.113.1'): Promise<Response> {
  return app.request(path, { headers: { 'x-forwarded-for': ip } });
}

describe('GET /api/health', () => {
  it('返回 ok 与源数量', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'rss-letter', sources: 1 });
  });
});

describe('POST /api/subscribe', () => {
  it('SMTP 未配置 → 503', async () => {
    const appNoSmtp = createApp(cfg({ smtpHost: '' }), { sender: null });
    const res = await appNoSmtp.request('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@example.com' }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('smtp_unconfigured');
  });

  it('非法邮箱 → 400', async () => {
    const res = await post('/api/subscribe', { email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_email');
  });

  it('合法请求发送确认邮件（mock transporter），邮箱转小写', async () => {
    const res = await post('/api/subscribe', { email: '  New@example.COM ', lang: 'zh' });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('new@example.com');
    expect(sent[0]!.mail.subject).toContain('确认');
    expect(sent[0]!.mail.html).toContain('/confirm/');
  });

  it('蜜罐字段：假意成功且不发信', async () => {
    const res = await post('/api/subscribe', { email: 'bot@example.com', website: 'http://spam' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it('每 IP 每分钟 5 次后 429，其他 IP 不受影响', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await post('/api/subscribe', { email: `f${i}@example.com` }, '198.51.100.7');
      expect(r.status).toBe(200);
    }
    const res = await post('/api/subscribe', { email: 'f6@example.com' }, '198.51.100.7');
    expect(res.status).toBe(429);
    expect((await post('/api/subscribe', { email: 'other@example.com' }, '198.51.100.8')).status).toBe(200);
  });
});

describe('GET /confirm/:token', () => {
  it('无效 token → 404 页面', async () => {
    const res = await get('/confirm/not-a-token');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('链接无效或已过期');
  });

  it('确认成功 → 双语页面 + 欢迎邮件', async () => {
    await post('/api/subscribe', { email: 'cf@example.com', lang: 'zh' });
    const token = sent[0]!.token;
    const res = await get(`/confirm/${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('订阅成功');
    expect(sent).toHaveLength(2); // confirm + welcome
    expect(sent[1]!.mail.subject).toContain('欢迎');
  });

  it('已退订的 token 不能再确认', async () => {
    await post('/api/subscribe', { email: 'gone@example.com' });
    const token = sent[0]!.token;
    await get(`/unsubscribe/${token}`);
    const res = await get(`/confirm/${token}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /unsubscribe/:token', () => {
  it('退订成功页面（跟随订户语言）', async () => {
    await post('/api/subscribe', { email: 'un@example.com', lang: 'en' });
    const token = sent[0]!.token;
    const res = await get(`/unsubscribe/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('You are unsubscribed');
    expect(html).toContain('Unsubscribed');
  });

  it('无效 token → 提示页', async () => {
    const res = await get('/unsubscribe/nope');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('链接无效或已退订');
  });
});

describe('admin endpoints', () => {
  it('无 token → 401', async () => {
    expect((await post('/api/digest/run', {})).status).toBe(401);
    expect((await get('/api/subscribers/count')).status).toBe(401);
  });

  it('x-admin-token 通过 → 订阅统计', async () => {
    await post('/api/subscribe', { email: 'admin@example.com' });
    const res = await app.request('/api/subscribers/count', {
      headers: { 'x-admin-token': 'test-admin-token' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.total).toBe(1);
    expect(json.pending).toBe(1);
  });

  it('Bearer 形式也可通过（digest/run，无源时返回 no_sources）', async () => {
    const appNoSources = createApp(cfg({ rssSources: [] }), { sender: mockSender });
    const res = await appNoSources.request('/api/digest/run', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.outcome).toBe('no_sources');
  });
});

describe('runDigest（mock fetchSources + mock sender）', () => {
  it('按语言发送近窗条目；无新内容不发', async () => {
    const { runDigest } = await import('../src/digest.js');
    const { confirmByToken, upsertPending } = await import('../src/db.js');
    confirmByToken(upsertPending('zh-reader@example.com', 'zh'));
    confirmByToken(upsertPending('en-reader@example.com', 'en'));

    const now = Date.parse('2026-10-11T00:00:00Z');
    const mkItem = (title: string, link: string, daysAgo: number): RssItem => ({
      title,
      link,
      description: 'd',
      pubDate: new Date(now - daysAgo * 24 * 3600 * 1000),
      source: 'https://example.org/rss.xml',
    });

    const result = await runDigest(cfg(), {
      send: mockSender,
      now,
      fetchSources: async () => ({
        items: [mkItem('A', 'https://x/1', 2), mkItem('B', 'https://x/2', 10)],
        failed: [{ url: 'https://dead.example.net/rss', error: 'HTTP 500' }],
      }),
    });
    expect(result.outcome).toBe('done');
    expect(result.items).toBe(1); // 10 天前那条在窗外
    expect(result.sent).toBe(2); // zh + en
    expect(sent.map((s) => s.to).sort()).toEqual(['en-reader@example.com', 'zh-reader@example.com']);
    expect(sent[0]!.mail.html).toContain('/unsubscribe/');

    sent.length = 0;
    const empty = await runDigest(cfg(), {
      send: mockSender,
      now,
      fetchSources: async () => ({ items: [mkItem('old', 'https://x/9', 20)], failed: [] }),
    });
    expect(empty.outcome).toBe('no_new_items');
    expect(empty.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
