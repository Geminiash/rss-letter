/**
 * 邮件发送与模板。
 * 内置中英双语模板；templates/ 目录下同名文件（含 subject frontmatter）可覆盖。
 * 页脚必须带一键退订链接（隐私纪律）。
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { baseUrl, smtpConfigured } from './config.js';
import type { Lang } from './db.js';

export interface MailText {
  subject: string;
  html: string;
}

export interface DigestItem {
  title: string;
  link: string;
  description: string;
  source: string;
  date: Date;
}

/** 发送函数签名：便于测试注入 mock transporter。 */
export type MailSender = (to: string, mail: MailText, token: string) => Promise<void>;

export function createTransporter(cfg: AppConfig): Transporter | null {
  if (!smtpConfigured(cfg)) return null;
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
  });
}

export function realSender(cfg: AppConfig, transporter: Transporter): MailSender {
  return async (to, mail, token) => {
    await transporter.sendMail({
      from: `"${cfg.senderName}" <${cfg.senderEmail}>`,
      to,
      subject: mail.subject,
      html: mail.html,
      list: { unsubscribe: `${baseUrl(cfg)}/unsubscribe/${token}` },
    });
  };
}

// ---- 内置模板（zh / en）----

interface BuiltinTemplate {
  subject: string;
  body: string;
}

const BUILTIN: Record<string, Record<Lang, BuiltinTemplate>> = {
  confirm: {
    zh: {
      subject: '确认一下，订阅就差这一步',
      body: `<p>收到你对 {{siteName}} 的订阅请求。点击下面的链接即可生效；如果你没有订阅过，忽略这封信就好。</p>
<p style="margin:20px 0;"><a href="{{confirmLink}}" style="display:inline-block;background:#46688c;color:#fff;text-decoration:none;padding:10px 22px;border-radius:999px;">确认订阅</a></p>
<p style="color:#8a8f96;font-size:13px;">若按钮无效，请复制此链接到浏览器打开：<br /><a href="{{confirmLink}}">{{confirmLink}}</a></p>`,
    },
    en: {
      subject: 'One click left to confirm your subscription',
      body: `<p>You asked to subscribe to {{siteName}}. Click below to confirm — not interested? Just ignore this letter.</p>
<p style="margin:20px 0;"><a href="{{confirmLink}}" style="display:inline-block;background:#46688c;color:#fff;text-decoration:none;padding:10px 22px;border-radius:999px;">Confirm subscription</a></p>
<p style="color:#8a8f96;font-size:13px;">If the button doesn't work, copy this link into your browser:<br /><a href="{{confirmLink}}">{{confirmLink}}</a></p>`,
    },
  },
  welcome: {
    zh: {
      subject: '欢迎来到 {{siteName}}',
      body: `<p>订阅成功。往后每周你会收到一封信：过去一周所有订阅源的新内容，按时间排好，没有广告，随时可退订。</p>
<p>第一封信正在路上。期间不妨去<a href="{{homeLink}}">首页</a>随便逛逛。</p>`,
    },
    en: {
      subject: 'Welcome to {{siteName}}',
      body: `<p>You're in. Every week you'll get one letter: everything new from the feeds this week, sorted by time. No ads, unsubscribe anytime.</p>
<p>The first letter is on its way. Meanwhile, feel free to <a href="{{homeLink}}">wander around</a>.</p>`,
    },
  },
  digest: {
    zh: {
      subject: '{{siteName}} 每周摘要：本周 {{count}} 条更新',
      body: `<p>过去一周订阅源共有 {{count}} 条更新，拣最新的放在最前面。</p>
<ul style="padding-left:20px;margin:16px 0;">{{items}}</ul>
<p style="color:#8a8f96;font-size:13px;">下周见。如果哪篇帮到了你，转发给一个需要的人就是最好的支持。</p>`,
    },
    en: {
      subject: '{{siteName}} Weekly: {{count}} new {{countLabel}} this week',
      body: `<p>{{count}} new {{countLabel}} from your feeds this week — the freshest ones are at the top.</p>
<ul style="padding-left:20px;margin:16px 0;">{{items}}</ul>
<p style="color:#8a8f96;font-size:13px;">See you next week. If one of these helped, forwarding it is the best thanks.</p>`,
    },
  },
};

// ---- 工具 ----

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** RSS 摘要可能携带 HTML，去掉标签再截断，保证邮件正文干净。 */
export function stripTags(s: string, maxLen = 180): string {
  const text = s
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => vars[key] ?? m);
}

function layout(cfg: AppConfig, lang: Lang, bodyHtml: string, unsubscribeLink: string): string {
  const footer =
    lang === 'zh'
      ? `这封信由 ${escapeHtml(cfg.siteName)} 发出。不想要了？<a href="${unsubscribeLink}">随时退订</a>。`
      : `This letter comes from ${escapeHtml(cfg.siteName)}. Not for you? <a href="${unsubscribeLink}">Unsubscribe anytime</a>.`;
  return `<!doctype html><html lang="${lang}"><body style="margin:0;padding:24px;background:#fafaf9;color:#26282b;font:15px/1.7 -apple-system,'Segoe UI','PingFang SC',sans-serif;">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e4e1;border-radius:10px;padding:28px;">
${bodyHtml}
<hr style="border:none;border-top:1px solid #e4e4e1;margin:24px 0 12px;" />
<p style="color:#8a8f96;font-size:12px;margin:0;">${footer}</p>
</div></body></html>`;
}

/** 解析模板覆盖文件：`---` frontmatter 里一行 `subject: ...`，其余为正文。 */
export function parseOverrideFile(raw: string): { subject?: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: raw };
  const subject = m[1]?.match(/^subject:\s*(.+)$/m)?.[1]?.trim();
  return { subject: subject || undefined, body: (m[2] ?? '').trim() };
}

function loadTemplate(
  cfg: AppConfig,
  name: string,
  lang: Lang,
): { subject: string; body: string } {
  const builtin = BUILTIN[name]?.[lang];
  const fallback = builtin ?? { subject: name, body: '' };
  const file = join(cfg.templatesDir, `${name}.${lang}.html`);
  if (existsSync(file)) {
    try {
      const parsed = parseOverrideFile(readFileSync(file, 'utf8'));
      return { subject: parsed.subject ?? fallback.subject, body: parsed.body };
    } catch {
      // 读取失败时回退内置模板，不让坏文件拖垮发信
    }
  }
  return fallback;
}

function render(
  cfg: AppConfig,
  name: string,
  lang: Lang,
  vars: Record<string, string>,
): MailText {
  const allVars = {
    siteName: cfg.siteName,
    homeLink: cfg.siteUrl,
    ...vars,
  };
  const tpl = loadTemplate(cfg, name, lang);
  return {
    subject: interpolate(tpl.subject, allVars),
    html: layout(
      cfg,
      lang,
      interpolate(tpl.body, allVars),
      vars['unsubscribeLink'] ?? '',
    ),
  };
}

export function confirmMail(cfg: AppConfig, token: string, lang: Lang): MailText {
  const base = baseUrl(cfg);
  return render(cfg, 'confirm', lang, {
    confirmLink: `${base}/confirm/${token}`,
    unsubscribeLink: `${base}/unsubscribe/${token}`,
  });
}

export function welcomeMail(cfg: AppConfig, token: string, lang: Lang): MailText {
  const base = baseUrl(cfg);
  return render(cfg, 'welcome', lang, {
    unsubscribeLink: `${base}/unsubscribe/${token}`,
  });
}

export function renderDigestItems(items: DigestItem[], lang: Lang): string {
  const sourceLabel = (it: DigestItem): string =>
    escapeHtml(it.source) +
    (Number.isFinite(it.date.valueOf())
      ? ` · ${it.date.toISOString().slice(0, 10)}`
      : '');
  return items
    .map(
      (it) =>
        `<li style="margin-bottom:12px;"><a href="${escapeHtml(it.link)}">${escapeHtml(it.title)}</a><br />` +
        `<span style="color:#8a8f96;font-size:13px;">${sourceLabel(it)}${it.description ? ' — ' + escapeHtml(it.description) : ''}</span></li>`,
    )
    .join('\n');
}

export function digestMail(
  cfg: AppConfig,
  token: string,
  lang: Lang,
  items: DigestItem[],
): MailText {
  const base = baseUrl(cfg);
  const count = String(items.length);
  return render(cfg, 'digest', lang, {
    count,
    countLabel: items.length === 1 ? (lang === 'zh' ? '条更新' : 'update') : lang === 'zh' ? '条更新' : 'updates',
    items: renderDigestItems(items, lang),
    unsubscribeLink: `${base}/unsubscribe/${token}`,
  });
}
