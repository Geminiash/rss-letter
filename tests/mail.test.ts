import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config.js';
import {
  confirmMail,
  digestMail,
  escapeHtml,
  parseOverrideFile,
  stripTags,
  welcomeMail,
} from '../src/mail.js';

const REPO_TEMPLATES = join(import.meta.dirname, '..', 'templates');

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    dbPath: './data/test.sqlite',
    adminToken: 'test-admin',
    rssSources: ['https://example.org/rss.xml'],
    digestDays: 7,
    digestMaxItems: 20,
    siteName: 'rss-letter',
    siteUrl: 'https://example.org',
    apiUrl: 'https://api.example.org',
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

afterEach(() => {
  rmSync(join(tmpdir(), 'rss-letter-mail-test'), { recursive: true, force: true });
});

describe('builtin template rendering', () => {
  it('confirmMail zh：含确认链接、退订链接、站点名', () => {
    const mail = confirmMail(cfg(), 'tok-1', 'zh');
    expect(mail.subject).toContain('确认');
    expect(mail.html).toContain('https://api.example.org/confirm/tok-1');
    expect(mail.html).toContain('https://api.example.org/unsubscribe/tok-1');
    expect(mail.html).toContain('rss-letter');
  });

  it('confirmMail en：英文主题与英文正文', () => {
    const mail = confirmMail(cfg(), 'tok-2', 'en');
    expect(mail.subject).toBe('One click left to confirm your subscription');
    expect(mail.html).toContain('Confirm subscription');
  });

  it('welcomeMail：链接退订在页脚', () => {
    for (const lang of ['zh', 'en'] as const) {
      const mail = welcomeMail(cfg(), 'tok-3', lang);
      expect(mail.html).toContain('/unsubscribe/tok-3');
      expect(mail.html).toContain(cfg().siteUrl);
    }
  });

  it('digestMail：条目数、来源与日期、链接安全转义', () => {
    const mail = digestMail(cfg(), 'tok-4', 'zh', [
      {
        title: '一 <script>alert(1)</script> 标题',
        link: 'https://example.org/p?x=1&y=2',
        description: '描述<b>加粗</b>',
        source: 'https://source.example.net/rss',
        date: new Date('2026-10-10T00:00:00Z'),
      },
    ]);
    expect(mail.subject).toContain('每周摘要：本周 1 条更新');
    expect(mail.html).toContain('过去一周订阅源共有 1 条更新');
    expect(mail.html).toContain('https://example.org/p?x=1&amp;y=2');
    expect(mail.html).toContain('source.example.net');
    expect(mail.html).toContain('2026-10-10');
    // 标题被转义，原始 <script> 不出现在邮件里
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('digestMail en：单复数 countLabel', () => {
    const one = digestMail(cfg(), 't', 'en', [
      { title: 'a', link: 'https://a', description: '', source: 's', date: new Date() },
    ]);
    const two = digestMail(cfg(), 't', 'en', [
      { title: 'a', link: 'https://a', description: '', source: 's', date: new Date() },
      { title: 'b', link: 'https://b', description: '', source: 's', date: new Date() },
    ]);
    expect(one.subject).toContain('1 new update');
    expect(two.subject).toContain('2 new updates');
  });
});

describe('template override (templates/ dir)', () => {
  it('templates/ 目录下的默认文件可正常渲染（本仓库自带）', () => {
    const mail = confirmMail(cfg(), 'tok-9', 'zh');
    expect(mail.subject).toContain('确认');
    expect(mail.html).toContain('/confirm/tok-9');
  });

  it('自定义 templatesDir 覆盖内置：subject frontmatter + {{vars}}', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rss-letter-mail-test-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'confirm.zh.html'),
      '---\nsubject: 自定义确认主题 {{siteName}}\n---\n<p>自定义正文 {{confirmLink}}</p>',
    );
    const mail = confirmMail(cfg({ templatesDir: dir }), 'tok-10', 'zh');
    expect(mail.subject).toBe('自定义确认主题 rss-letter');
    expect(mail.html).toContain('自定义正文 https://api.example.org/confirm/tok-10');
    rmSync(dir, { recursive: true, force: true });
  });

  it('覆盖文件缺 subject 时回退内置主题', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rss-letter-mail-test-'));
    writeFileSync(join(dir, 'welcome.en.html'), '<p>custom body only</p>');
    const mail = welcomeMail(cfg({ templatesDir: dir }), 'tok-11', 'en');
    expect(mail.subject).toContain('Welcome to');
    expect(mail.html).toContain('custom body only');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('parseOverrideFile', () => {
  it('解析 frontmatter 与正文', () => {
    const r = parseOverrideFile('---\nsubject: S\n---\nBODY');
    expect(r.subject).toBe('S');
    expect(r.body).toBe('BODY');
  });

  it('无 frontmatter 时整段当正文', () => {
    const r = parseOverrideFile('just body');
    expect(r.subject).toBeUndefined();
    expect(r.body).toBe('just body');
  });
});

describe('sanitizers', () => {
  it('escapeHtml', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('stripTags 剥标签、折叠空白、截断加省略号', () => {
    expect(stripTags('<p>hello <b>world</b></p>  next')).toBe('hello world next');
    const long = stripTags('x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(180);
    expect(long.endsWith('…')).toBe(true);
  });
});
