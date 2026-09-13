/**
 * قیف: از کجا آمد، تا کجا رفت.
 *
 * تا امروز `/stats` فقط می‌گفت چند نفر آمده‌اند و چند جلسه ساخته شده. روی
 * سرور ۶۵ کاربر بود و ۱۵ نفر صوت فرستاده بودند — ولی معلوم نبود بقیه کجا
 * ریختند: تور نمونه را دیدند و رفتند؟ اصلاً تور را باز نکردند؟ و از کدام
 * تبلیغ آمده بودند؟ بدون این عددها هر تصمیمِ بازاریابی حدس است.
 *
 * **آنچه تاریخچه دارد از جدول خودش شمرده می‌شود، نه از رویداد.** فرستادنِ
 * صوت در `sessions` است، تحویل در `sessions.status`، پرداخت در `topups`.
 * اگر این‌ها هم رویداد می‌شدند، قیف از روز استقرار صفر شروع می‌شد و
 * تاریخچهٔ واقعی دور ریخته می‌شد. رویداد فقط برای چیزهایی است که هیچ‌جا
 * ثبت نمی‌شوند: دیدنِ تور، بازدید و کلیکِ سایت، و منبعِ ورود.
 */

import { db } from "./index.js";

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- تهی برای بازدیدِ ناشناسِ سایت
  user_id    INTEGER,
  name       TEXT NOT NULL,
  source     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, created_at);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, name);

-- منبعِ **اولین** ورود. عمداً فقط یک بار نوشته می‌شود: کسی که از تبلیغ آمده و
-- فردا از لینک هدیه برمی‌گردد، هنوز مالِ همان تبلیغ است.
CREATE TABLE IF NOT EXISTS user_sources (
  user_id    INTEGER PRIMARY KEY,
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- یادآوریِ «هنوز صوتی نفرستادی». کلید اصلی دروازهٔ یک‌بار ارسال است.
CREATE TABLE IF NOT EXISTS nudges (
  user_id   INTEGER NOT NULL,
  stage     INTEGER NOT NULL,
  sent_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- تهی: در حال ارسال؛ ۰: به هیچ سکویی نرسید (مثلاً ربات را بلاک کرده)
  delivered INTEGER,
  PRIMARY KEY (user_id, stage)
);
`);

/** رویدادهایی که سایت و مینی‌اپ بی‌احراز می‌فرستند. هر نام دیگری رد می‌شود. */
export const WEB_EVENTS = ["landing_view", "landing_cta", "app_view", "bot_link"] as const;
export type WebEvent = (typeof WEB_EVENTS)[number];

export function isWebEvent(name: unknown): name is WebEvent {
  return typeof name === "string" && (WEB_EVENTS as readonly string[]).includes(name);
}

/**
 * نام منبع را تمیز می‌کند؛ نامعتبر یعنی `null`.
 *
 * منبع از آدرسی می‌آید که هرکسی می‌تواند بسازد، پس هر چیزی جز حروف کوچک
 * لاتین، رقم، خط‌تیره و زیرخط دور ریخته می‌شود — هم برای اینکه در پیام
 * `/funnel` تگ HTML نسازد، هم تا `Instagram` و `instagram` دو ردیف نشوند.
 */
export function normalizeSource(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(s) ? s : null;
}

/**
 * منبع از پارامترِ `/start`.
 *
 * `s_<نام>` برای تبلیغ است: `t.me/passchi_bot?start=s_instagram`. بقیهٔ
 * پیشوندها لینک‌هایی‌اند که خودِ محصول می‌سازد و همان هم منبعِ واقعیِ ورود
 * است — کسی که با لینک جزوهٔ هم‌کلاسی آمده، رشدِ دهان‌به‌دهان است.
 */
export function sourceFromStartPayload(payload: string): string {
  const p = payload.trim();
  if (!p) return "direct";
  if (p.startsWith("s_")) return normalizeSource(p.slice(2)) ?? "direct";
  if (p.startsWith("g_")) return "gift";
  if (p.startsWith("t_")) return "transfer";
  if (p.startsWith("p_")) return "group";
  if (p.startsWith("j_")) return "share";
  return "other";
}

export function track(userId: number | null, name: string, source: string | null = null): void {
  try {
    db.prepare(`INSERT INTO events (user_id, name, source) VALUES (?, ?, ?)`).run(userId, name, source);
  } catch {
    /* شمارش هرگز نباید مسیرِ کاربر را بشکند */
  }
}

/** `/start` را ثبت می‌کند و منبعِ اولین ورود را، اگر هنوز نداشت. */
export function recordStart(userId: number, payload: string): string {
  const source = sourceFromStartPayload(payload);
  try {
    db.prepare(`INSERT OR IGNORE INTO user_sources (user_id, source) VALUES (?, ?)`).run(userId, source);
  } catch {
    /* همان قاعدهٔ `track` */
  }
  track(userId, "start", source);
  return source;
}

export function sourceOf(userId: number): string | null {
  const r = db.prepare(`SELECT source FROM user_sources WHERE user_id = ?`).get(userId) as
    | { source: string }
    | undefined;
  return r?.source ?? null;
}

// ─── گزارش ───────────────────────────────────────────────────────────────────

export interface FunnelRow {
  users: number;
  demo: number;
  uploaded: number;
  delivered: number;
  joined: number;
  paid: number;
}

export interface FunnelReport {
  days: number;
  total: FunnelRow;
  bySource: Array<FunnelRow & { source: string }>;
  web: Array<{ name: string; source: string; n: number }>;
  nudges: { sent: number; delivered: number; uploadedAfter: number };
}

/**
 * گروهِ کاربرانی که در `days` روزِ اخیر آمده‌اند، و هر گام برای همان گروه.
 *
 * هم‌گروهی (cohort) است نه شمارشِ رویدادِ همان بازه: «۲۰ نفر آمدند و ۵ نفر
 * صوت فرستادند» فقط وقتی معنا دارد که آن ۵ نفر از همان ۲۰ نفر باشند.
 *
 * «گرفتنِ جزوهٔ کسِ دیگر» گامِ جداست: هم‌کلاسی‌ای که با لینک به جلسه
 * پیوسته، هیچ صوتی نفرستاده ولی محصول به او رسیده — ریختنِ او در ستونِ
 * «نفرستاد» قیف را بدتر از واقعیت نشان می‌داد.
 */
export function funnelReport(days: number): FunnelReport {
  const since = `-${Math.max(1, Math.floor(days))} days`;
  const steps = `
    COUNT(*) AS users,
    SUM(EXISTS (SELECT 1 FROM events e WHERE e.user_id = u.tg_id AND e.name = 'demo')) AS demo,
    SUM(EXISTS (SELECT 1 FROM sessions s WHERE s.tg_id = u.tg_id)) AS uploaded,
    SUM(EXISTS (SELECT 1 FROM sessions s WHERE s.tg_id = u.tg_id AND s.status = 'done')) AS delivered,
    SUM(EXISTS (SELECT 1 FROM session_members m JOIN sessions s ON s.id = m.session_id
                 WHERE m.tg_id = u.tg_id AND s.tg_id != u.tg_id)) AS joined,
    SUM(EXISTS (SELECT 1 FROM topups t WHERE t.tg_id = u.tg_id AND t.status = 'approved')) AS paid`;
  const num = (r: Record<string, unknown>): FunnelRow => ({
    users: Number(r.users ?? 0),
    demo: Number(r.demo ?? 0),
    uploaded: Number(r.uploaded ?? 0),
    delivered: Number(r.delivered ?? 0),
    joined: Number(r.joined ?? 0),
    paid: Number(r.paid ?? 0),
  });

  const total = num(
    db.prepare(`SELECT ${steps} FROM users u WHERE u.created_at >= datetime('now', ?)`).get(since) as Record<
      string,
      unknown
    >,
  );

  const bySource = (
    db
      .prepare(
        `SELECT COALESCE(us.source, 'unknown') AS source, ${steps}
           FROM users u LEFT JOIN user_sources us ON us.user_id = u.tg_id
          WHERE u.created_at >= datetime('now', ?)
          GROUP BY 1 ORDER BY users DESC`,
      )
      .all(since) as Array<Record<string, unknown>>
  ).map((r) => ({ source: String(r.source), ...num(r) }));

  const web = db
    .prepare(
      `SELECT name, COALESCE(source, 'direct') AS source, COUNT(*) AS n
         FROM events
        WHERE user_id IS NULL AND created_at >= datetime('now', ?)
        GROUP BY 1, 2 ORDER BY name, n DESC`,
    )
    .all(since) as Array<{ name: string; source: string; n: number }>;

  const n = db
    .prepare(
      `SELECT COUNT(*) AS sent,
              COALESCE(SUM(delivered = 1), 0) AS delivered,
              COALESCE(SUM(EXISTS (SELECT 1 FROM sessions s
                                    WHERE s.tg_id = nd.user_id AND s.created_at >= nd.sent_at)), 0) AS uploadedAfter
         FROM nudges nd WHERE nd.sent_at >= datetime('now', ?)`,
    )
    .get(since) as { sent: number; delivered: number; uploadedAfter: number };

  return {
    days,
    total,
    bySource,
    web,
    nudges: { sent: Number(n.sent), delivered: Number(n.delivered), uploadedAfter: Number(n.uploadedAfter) },
  };
}
