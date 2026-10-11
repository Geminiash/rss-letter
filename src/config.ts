/**
 * 配置：所有运行时准据都来自环境变量，不落盘、不进仓库。
 * 命名约定：RSS_LETTER_* 为服务自身配置，SMTP_* 为邮件通道配置。
 */
import type { Lang } from './db.js';

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  adminToken: string;
  /** RSS 源列表（env RSS_SOURCES，逗号分隔） */
  rssSources: string[];
  /** 摘要时间窗（天） */
  digestDays: number;
  /** 单封摘要最多条目数 */
  digestMaxItems: number;
  /** 站点/服务名（邮件署名与标题用） */
  siteName: string;
  /** 面向用户的站点主页 */
  siteUrl: string;
  /** 本服务对外可达的基础地址（确认/退订链接用），缺省回退 siteUrl */
  apiUrl: string;
  senderName: string;
  senderEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  /** 模板覆盖目录 */
  templatesDir: string;
  defaultLang: Lang;
}

function str(env: Record<string, string | undefined>, key: string, fallback = ''): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const v = Number(env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const rssSources = str(env, 'RSS_SOURCES')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s));

  return {
    port: num(env, 'PORT', 3000),
    host: str(env, 'HOST', '127.0.0.1'),
    dbPath: str(env, 'RSS_LETTER_DB', './data/rss-letter.sqlite'),
    adminToken: str(env, 'RSS_LETTER_ADMIN_TOKEN'),
    rssSources,
    digestDays: num(env, 'DIGEST_DAYS', 7),
    digestMaxItems: num(env, 'DIGEST_MAX_ITEMS', 20),
    siteName: str(env, 'SITE_NAME', 'rss-letter'),
    siteUrl: str(env, 'SITE_URL', 'http://localhost:3000'),
    apiUrl: str(env, 'API_URL', ''),
    senderName: str(env, 'SENDER_NAME', 'rss-letter'),
    senderEmail: str(env, 'SENDER_EMAIL'),
    smtpHost: str(env, 'SMTP_HOST'),
    smtpPort: num(env, 'SMTP_PORT', 465),
    smtpUser: str(env, 'SMTP_USER'),
    smtpPass: str(env, 'SMTP_PASS'),
    templatesDir: str(env, 'TEMPLATES_DIR', './templates'),
    defaultLang: str(env, 'DEFAULT_LANG', 'zh') === 'en' ? 'en' : 'zh',
  };
}

/** 对外链接的基座：优先 API_URL，回退 SITE_URL */
export function baseUrl(cfg: AppConfig): string {
  return (cfg.apiUrl || cfg.siteUrl).replace(/\/+$/, '');
}

export function smtpConfigured(cfg: AppConfig): boolean {
  return Boolean(cfg.smtpHost && cfg.smtpUser && cfg.smtpPass && cfg.senderEmail);
}
