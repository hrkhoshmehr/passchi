/**
 * احراز هویت وب — سه در ورودی، یک نشست.
 *
 * سه راه ورود وجود دارد و هر سه به یک چیز ختم می‌شوند: یک توکن نشست که
 * `user_id` داخلی را حمل می‌کند. بقیهٔ سرور فقط همان را می‌بیند و اصلاً
 * نمی‌داند کاربر از کدام در آمده.
 *
 *   • مینی‌اپ تلگرام — `initData` که با HMAC توکن ربات امضا شده
 *   • مینی‌اپ بله — همان ساختار، ولی امضا با کلید خودش
 *   • مرورگر — شمارهٔ موبایل و کد پیامکی
 *
 * دربارهٔ initData: تلگرام رشته‌ای می‌دهد که خودِ کلاینت می‌فرستد، پس **باید**
 * راستی‌آزمایی شود وگرنه هرکسی می‌تواند `user.id` دلخواه بنویسد و به حساب
 * دیگری وارد شود. الگوریتم: کلید مخفی از `HMAC_SHA256("WebAppData", botToken)`
 * و بعد امضای رشتهٔ مرتب‌شدهٔ فیلدها با آن کلید.
 */

import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { db } from "../db/index.js";
import { normalizePhone, resolveIdentity, type Platform } from "../db/identity.js";
import type { UserRow } from "../db/index.js";

// ─── نشست‌ها ────────────────────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS web_sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  platform   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
`);

const SESSION_DAYS = 30;

export function createSessionToken(userId: number, platform: Platform): string {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO web_sessions (token, user_id, platform, expires_at)
     VALUES (?, ?, ?, datetime('now', ?))`,
  ).run(token, userId, platform, `+${SESSION_DAYS} days`);
  return token;
}

export function userIdFromToken(token: string): number | null {
  const row = db
    .prepare(`SELECT user_id FROM web_sessions WHERE token = ? AND expires_at > datetime('now')`)
    .get(token) as unknown as { user_id: number } | undefined;
  return row?.user_id ?? null;
}

export function revokeToken(token: string): void {
  db.prepare(`DELETE FROM web_sessions WHERE token = ?`).run(token);
}

/** نشست‌های منقضی؛ در پاک‌سازی دوره‌ای صدا زده می‌شود. */
export function purgeExpiredSessions(): void {
  db.prepare(`DELETE FROM web_sessions WHERE expires_at <= datetime('now')`).run();
  db.prepare(`DELETE FROM otp_codes WHERE expires_at <= datetime('now', '-1 day')`).run();
}

// ─── initData مینی‌اپ ───────────────────────────────────────────────────────

export interface MiniAppUser {
  id: string;
  name: string | null;
  username: string | null;
}

/**
 * راستی‌آزمایی `initData` و بیرون‌کشیدن کاربر.
 *
 * `hash` از رشته کنار گذاشته می‌شود، بقیهٔ جفت‌ها بر اساس کلید مرتب و با
 * `\n` به هم چسبانده می‌شوند، و امضا با کلید مشتق‌شده از توکن ربات مقایسه
 * می‌شود. مقایسه با `timingSafeEqual` است نه `===` — مقایسهٔ رشته‌ای معمولی
 * در اولین بایت متفاوت برمی‌گردد و همین تفاوتِ زمان، نشت اطلاعات است.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 24 * 60 * 60,
): MiniAppUser | null {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => [k, v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  /**
   * `auth_date` هم بررسی می‌شود: بدون آن، یک initData معتبرِ لو رفته تا ابد
   * قابل استفادهٔ دوباره است. امضا فقط می‌گوید «این داده دستکاری نشده»، نه
   * «این داده تازه است».
   */
  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "null") as {
      id?: number | string;
      first_name?: string;
      last_name?: string;
      username?: string;
    } | null;
    if (!user?.id) return null;
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || null;
    return { id: String(user.id), name, username: user.username ?? null };
  } catch {
    return null;
  }
}

/**
 * ورود از مینی‌اپ — تلگرام یا بله.
 *
 * ساختار initData در بله عیناً از تلگرام تقلید شده، پس همان تابع کار می‌کند؛
 * فقط توکن امضاکننده فرق دارد. اگر توکن بله تنظیم نشده باشد، این در بسته
 * است و **باز نمی‌شود** — هرگز به initDataِ راستی‌آزمایی‌نشده اعتماد نکن،
 * چون معنایش این است که هرکسی با یک درخواست ساده به حساب هرکسی وارد شود.
 */
export function loginFromMiniApp(platform: "telegram" | "bale", initData: string): UserRow | null {
  const token = platform === "telegram" ? config.BOT_TOKEN : config.BALE_BOT_TOKEN;
  if (!token) {
    logger.warn({ platform }, "mini app login attempted but bot token is not configured");
    return null;
  }
  const u = verifyInitData(initData, token);
  if (!u) return null;
  return resolveIdentity({
    platform,
    platformUserId: u.id,
    name: u.name,
    username: u.username,
  });
}

// ─── ورود با شمارهٔ موبایل ──────────────────────────────────────────────────

const OTP_TTL_MIN = 5;
const OTP_MAX_ATTEMPTS = 5;
/** فاصلهٔ لازم بین دو درخواست کد برای یک شماره — جلوی پیامک‌بمباران را می‌گیرد. */
const OTP_RESEND_SEC = 60;

export class OtpError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_phone" | "too_soon" | "expired" | "wrong" | "too_many",
  ) {
    super(message);
  }
}

function hashCode(phone: string, code: string): string {
  return crypto.createHash("sha256").update(`${phone}:${code}`).digest("hex");
}

/**
 * کد را بساز، بفرست، و **هشِ** آن را ذخیره کن.
 *
 * ذخیرهٔ خودِ کد لازم نیست: تنها کاری که با آن می‌کنیم مقایسه است. اگر
 * پایگاه‌داده جایی درز کند، کدهای فعال هم لو نمی‌روند.
 */
export async function requestOtp(rawPhone: string): Promise<{ phone: string; devCode?: string }> {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new OtpError("شمارهٔ موبایل معتبر نیست.", "invalid_phone");

  const prev = db
    .prepare(
      `SELECT sent_at, (julianday('now') - julianday(sent_at)) * 86400 AS age FROM otp_codes WHERE phone = ?`,
    )
    .get(phone) as unknown as { age: number } | undefined;
  if (prev && prev.age < OTP_RESEND_SEC) {
    throw new OtpError(`کمی صبر کن، کد قبلی هنوز معتبر است.`, "too_soon");
  }

  const code = String(crypto.randomInt(100_000, 999_999));
  db.prepare(
    `INSERT INTO otp_codes (phone, code_hash, attempts, sent_at, expires_at)
     VALUES (?, ?, 0, datetime('now'), datetime('now', ?))
     ON CONFLICT(phone) DO UPDATE SET
       code_hash = excluded.code_hash, attempts = 0,
       sent_at = datetime('now'), expires_at = excluded.expires_at`,
  ).run(phone, hashCode(phone, code), `+${OTP_TTL_MIN} minutes`);

  const sent = await sendSms(phone, code);

  /**
   * وقتی سرویس پیامک تنظیم نشده، کد در پاسخ برگردانده می‌شود تا توسعه و
   * آزمایش ممکن باشد. این مسیر در تولید **باید** بسته باشد، وگرنه هرکسی با
   * دانستن یک شماره واردِ حساب صاحبش می‌شود؛ پس به `SMS_PROVIDER` گره خورده
   * و در لاگ راه‌اندازی هم هشدارش چاپ می‌شود.
   */
  return sent ? { phone } : { phone, devCode: code };
}

export function verifyOtp(rawPhone: string, code: string): UserRow {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new OtpError("شمارهٔ موبایل معتبر نیست.", "invalid_phone");

  const row = db.prepare(`SELECT * FROM otp_codes WHERE phone = ?`).get(phone) as unknown as
    | { code_hash: string; attempts: number; expires_at: string }
    | undefined;
  if (!row) throw new OtpError("کدی برای این شماره فرستاده نشده.", "expired");
  if (new Date(row.expires_at + "Z").getTime() < Date.now()) {
    throw new OtpError("کد منقضی شده. دوباره درخواست بده.", "expired");
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    throw new OtpError("تعداد تلاش‌ها زیاد شد. کد تازه بگیر.", "too_many");
  }

  const given = Buffer.from(hashCode(phone, code.trim()), "hex");
  const want = Buffer.from(row.code_hash, "hex");
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);

  if (!ok) {
    db.prepare(`UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?`).run(phone);
    throw new OtpError("کد درست نیست.", "wrong");
  }

  db.prepare(`DELETE FROM otp_codes WHERE phone = ?`).run(phone);
  return resolveIdentity({ platform: "web", platformUserId: phone, phone });
}

/**
 * ارسال پیامک. `false` یعنی سرویسی پیکربندی نشده — نه اینکه شکست خورد.
 *
 * درگاه‌های ایرانی (کاوه‌نگار، SMS.ir، …) هر کدام قالب خودشان را دارند ولی
 * همه یک درخواست HTTP ساده‌اند. `SMS_ENDPOINT` قالبی با جاگذاری می‌گیرد تا
 * عوض‌کردن ارائه‌دهنده فقط تغییر `.env` باشد، نه تغییر کد.
 */
async function sendSms(phone: string, code: string): Promise<boolean> {
  if (!config.SMS_PROVIDER || !config.SMS_ENDPOINT) return false;
  const url = config.SMS_ENDPOINT.replaceAll("{phone}", encodeURIComponent(phone)).replaceAll(
    "{code}",
    encodeURIComponent(code),
  );
  try {
    const res = await fetch(url, { method: config.SMS_METHOD });
    if (!res.ok) {
      logger.error({ status: res.status }, "sms send failed");
      // شکستِ ارسال نباید کد را «توسعه‌ای» کند: در تولید بهتر است کاربر
      // خطا ببیند تا اینکه کد روی صفحه‌اش چاپ شود.
      return true;
    }
    return true;
  } catch (e) {
    logger.error({ err: String(e) }, "sms send threw");
    return true;
  }
}
