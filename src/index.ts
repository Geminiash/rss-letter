/**
 * rss-letter 服务入口（Hono）。
 *   POST /api/subscribe       订阅请求（蜜罐 + 邮箱校验 + 每 IP 限流）→ 确认邮件
 *   GET  /confirm/:token      双重确认 → 欢迎邮件
 *   GET  /unsubscribe/:token  一键退订页面
 *   GET  /api/health          健康检查
 *   POST /api/digest/run      手动触发摘要（x-admin-token）
 *   GET  /api/subscribers/count 订阅统计（x-admin-token）
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppConfig } from './config.js';
import { baseUrl, loadConfig, smtpConfigured } from './config.js';
import {
  configureDb,
  confirmByToken,
  countSubscribers,
  findByToken,
  unsubscribeByToken,
  upsertPending,
  type Lang,
} from './db.js';
import {
  confirmMail,
  createTransporter,
  realSender,
  welcomeMail,
  type MailSender,
} from './mail.js';
import { createRateLimiter, type RateLimiter } from './ratelimit.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface AppDeps {
  /** 发信实现；测试注入 mock，缺省按 cfg 建 nodemailer transport。 */
  sender?: MailSender | null;
  limiter?: RateLimiter;
  now?: () => number;
}

export function clientIp(headers: Headers, envRemoteAddr?: string): string {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim() || 'unknown';
  return envRemoteAddr || 'unknown';
}

function page(cfg: AppConfig, title: string, body: string, lang: Lang): string {
  const zh = lang === 'zh';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:48px 16px;background:#fafaf9;color:#26282b;font:16px/1.7 -apple-system,'Segoe UI','PingFang SC',sans-serif;text-align:center;">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e4e4e1;border-radius:12px;padding:36px 28px;">
${body}
<p style="margin-top:24px;"><a href="${cfg.siteUrl}" style="color:#46688c;">${zh ? '回到首页' : 'Back home'}</a></p>
</div></body></html>`;
}

/** 订阅落地页（GET /）：表单 + 蜜罐 + 错误文案映射，样式与确认/退订页一致 */
export function subscribePage(cfg: AppConfig): string {
  const zh = cfg.defaultLang === 'zh';
  const t = zh
    ? {
        title: '订阅每周摘要',
        lead: '订阅后，每周你会收到一封信：过去七天的新内容，按时间排好，没有广告，随时可退订。',
        email: '邮箱地址',
        submit: '订阅',
        ok: '确认邮件已发出，请查收邮箱并点击确认链接。',
        invalid: '邮箱格式好像不对，再看一眼？',
        rate: '尝试太频繁了，等一分钟再试。',
        smtp: '发信服务还没配置好，暂时订阅不了。',
        fail: '发送失败了，稍后再试一次。',
      }
    : {
        title: 'Subscribe to the weekly letter',
        lead: 'One email a week: new posts from the past 7 days, newest first. No ads, unsubscribe anytime.',
        email: 'Email address',
        submit: 'Subscribe',
        ok: 'A confirmation email is on its way — please click the link inside.',
        invalid: "That doesn't look like a valid email.",
        rate: 'Too many attempts — wait a minute and retry.',
        smtp: 'The mail service is not configured yet.',
        fail: 'Sending failed, please retry later.',
      };
  const messages = JSON.stringify({
    ok: t.ok,
    invalid_email: t.invalid,
    rate_limited: t.rate,
    smtp_unconfigured: t.smtp,
    send_failed: t.fail,
    fail: t.fail,
  });
  return page(
    cfg,
    t.title,
    `<h1 style="margin:0 0 14px;font-size:22px;">${t.title}</h1>
<p style="margin:0 0 18px;">${t.lead}</p>
<form id="f" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:0;">
  <input id="email" type="email" required placeholder="${t.email}" autocomplete="email"
    style="flex:1;min-width:200px;padding:10px 12px;border:1px solid #d9d9d4;border-radius:8px;font:inherit;background:#fff;color:inherit;" />
  <input id="website" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;" />
  <button type="submit" style="padding:10px 18px;border:0;border-radius:8px;background:#46688c;color:#fff;font:inherit;cursor:pointer;">${t.submit}</button>
</form>
<p id="msg" style="display:none;margin:16px 0 0;color:#8a5a2b;"></p>
<script>
(() => {
  const form = document.getElementById('f');
  const msg = document.getElementById('msg');
  const map = ${messages};
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.style.display = 'none';
    const payload = { email: document.getElementById('email').value.trim() };
    const honeypot = document.getElementById('website').value;
    if (honeypot) payload.website = honeypot;
    let code = 'fail';
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      code = json.ok ? 'ok' : json.error || 'fail';
    } catch {}
    msg.textContent = map[code] || map.fail;
    msg.style.display = 'block';
  });
})();
</script>`,
    cfg.defaultLang,
  );
}

export function createApp(cfg: AppConfig, deps: AppDeps = {}): Hono {
  const app = new Hono();
  const limiter =
    deps.limiter ??
    createRateLimiter({ max: 5, windowMs: 60_000, now: deps.now ?? Date.now });
  const sender = deps.sender !== undefined ? deps.sender : null;

  const isAdmin = (c: { req: { header(n: string): string | undefined } }): boolean => {
    if (!cfg.adminToken) return false;
    const header = c.req.header('x-admin-token');
    const auth = c.req.header('authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    return header === cfg.adminToken || bearer === cfg.adminToken;
  };

  app.get('/', (c) => c.html(subscribePage(cfg)));

  app.get('/api/health', (c) =>
    c.json({ ok: true, service: 'rss-letter', sources: cfg.rssSources.length }),
  );

  app.post('/api/subscribe', async (c) => {
    const ip = clientIp(c.req.raw.headers, (c.env as Record<string, unknown> | undefined)?.['REMOTE_ADDR'] as string | undefined);
    if (!limiter.check(ip)) {
      return c.json({ ok: false, error: 'rate_limited' }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: string;
      lang?: string;
      website?: string;
    };

    // 蜜罐：正常用户不会填写 website 字段；假意成功，不给机器人信号
    if (body.website) return c.json({ ok: true });

    const email = (body.email ?? '').trim().toLowerCase();
    const lang: Lang = body.lang === 'en' ? 'en' : 'zh';
    if (!EMAIL_RE.test(email)) {
      return c.json({ ok: false, error: 'invalid_email' }, 400);
    }
    if (!smtpConfigured(cfg) || !sender) {
      return c.json({ ok: false, error: 'smtp_unconfigured' }, 503);
    }

    try {
      const token = upsertPending(email, lang);
      await sender(email, confirmMail(cfg, token, lang), token);
      return c.json({ ok: true });
    } catch (err) {
      console.error('[subscribe] 发送确认邮件失败：', err);
      return c.json({ ok: false, error: 'send_failed' }, 502);
    }
  });

  app.get('/confirm/:token', async (c) => {
    const token = c.req.param('token');
    const row = confirmByToken(token);
    if (!row) {
      return c.html(
        page(
          cfg,
          '404',
          '<p>链接无效或已过期。</p><p style="color:#8a8f96;font-size:13px;">Invalid or expired link.</p>',
          cfg.defaultLang,
        ),
        404,
      );
    }
    const lang: Lang = row.lang === 'en' ? 'en' : 'zh';
    if (sender) {
      try {
        await sender(row.email, welcomeMail(cfg, row.token, lang), row.token);
      } catch (err) {
        console.error('[confirm] 欢迎邮件发送失败：', err);
      }
    }
    const zh = lang === 'zh';
    return c.html(
      page(
        cfg,
        zh ? '订阅成功' : 'Subscribed',
        zh
          ? '<p>订阅成功。往后每周你会收到一封信：过去一周所有订阅源的新内容。</p>'
          : "<p>You're in. Every week you'll get one letter: everything new from your feeds this week.</p>",
        lang,
      ),
    );
  });

  app.get('/unsubscribe/:token', (c) => {
    const token = c.req.param('token');
    const row = findByToken(token);
    const ok = unsubscribeByToken(token);
    const lang: Lang = row?.lang === 'en' ? 'en' : 'zh';
    const zh = lang === 'zh';
    return c.html(
      page(
        cfg,
        zh ? '已退订' : 'Unsubscribed',
        ok
          ? zh
            ? '<p>已退订。你的邮箱已从列表移除，以后不会再收到邮件。</p>'
            : '<p>You are unsubscribed. Your address has been removed.</p>'
          : zh
            ? '<p>链接无效或已退订。</p><p style="color:#8a8f96;font-size:13px;">Invalid link or already unsubscribed.</p>'
            : '<p>Invalid link or already unsubscribed.</p>',
        lang,
      ),
    );
  });

  app.post('/api/digest/run', async (c) => {
    if (!isAdmin(c)) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const { runDigest } = await import('./digest.js');
    const result = await runDigest(cfg, { send: sender ?? undefined });
    return c.json({ ok: true, ...result });
  });

  app.get('/api/subscribers/count', (c) => {
    if (!isAdmin(c)) return c.json({ ok: false, error: 'unauthorized' }, 401);
    return c.json({ ok: true, ...countSubscribers() });
  });

  app.notFound((c) => c.json({ ok: false, error: 'not_found' }, 404));
  return app;
}

// ---- 直执行入口 ----
function isMain(): boolean {
  const self = process.argv[1]?.replace(/\\/g, '/') ?? '';
  return self.endsWith('index.ts') || self.endsWith('index.js');
}

if (isMain()) {
  const cfg = loadConfig();
  configureDb(cfg.dbPath);
  const transporter = createTransporter(cfg);
  const sender = transporter ? realSender(cfg, transporter) : null;
  const app = createApp(cfg, { sender });
  const port = cfg.port;
  serve({ fetch: app.fetch, port, hostname: cfg.host }, (info) => {
    console.log(`[rss-letter] listening on http://${cfg.host}:${info.port}`);
    console.log(`[rss-letter] base url: ${baseUrl(cfg)} | sources: ${cfg.rssSources.length} | smtp: ${sender ? 'on' : 'off'}`);
  });

  const shutdown = (): void => {
    console.log('[rss-letter] shutting down');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
