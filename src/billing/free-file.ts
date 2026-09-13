/**
 * اولین صوتِ رایگان — یک بار برای هر حساب.
 *
 * ## چرا جای سکهٔ هدیهٔ بیشتر
 *
 * بیست سکهٔ هدیه برای دیدنِ یک کلاسِ واقعی کم است، و بالا بردنش سکه‌ای
 * می‌سازد که به هر کاری می‌رود — از جمله سهمِ خرید گروهی. فایلِ اولِ رایگان
 * فقط همان یک تجربه را می‌خرد: دانشجو کلاسِ خودش را می‌فرستد و جزوه‌اش را
 * می‌بیند، بی آنکه اول پول بدهد.
 *
 * ## سازوکار: سکه به‌اندازهٔ همین فایل، درست پیش از شروع
 *
 * به‌جای راهِ پردازشِ جدا، به حساب همان‌قدر سکه واریز می‌شود که فایل لازم دارد
 * (تا سقف) و کار از همان مسیرِ همیشگیِ رزرو و تسویه می‌گذرد. پس بازپرداختِ
 * شکست، ری‌استارت، و «ادامه بده» پس از شارژ همه همان‌اند که آزموده شده‌اند.
 * فایلِ بلندتر از سقف: سقفش رایگان واریز می‌شود و بقیه مثل هر فایلِ دیگر.
 *
 * ## سه دروازه
 *
 * • یک بار برای هر حساب (`tg_id` کلید اصلی جدول است).
 * • یک بار برای هر **محتوای** صوت: همان فایل با حسابِ دوم رایگان نمی‌شود.
 * • سقفِ هفتگی: وقتی پر شد، خاموش نمی‌شود و فقط سقفِ دقیقه پایین می‌آید —
 *   تازه‌واردِ آن هفته هم هنوز چیزی برای دیدن دارد.
 *
 * شماره‌تلفن عمداً در کار نیست تا تسترها بی آن امتحان کنند؛ حساب‌سازیِ انبوه
 * را همان سقفِ هفتگی مهار می‌کند.
 */

import { db } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { atomic } from "./ledger.js";
import { priceOf } from "./money.js";

export interface FreeFileOffer {
  /** سقفِ رایگانِ همین حالا، به دقیقه */
  minutes: number;
  /** سقفِ هفتگی پر شده و سقفِ کوچک‌تر در کار است */
  fallback: boolean;
}

export type FreeFileRefusal = "off" | "used" | "audio_used";

export type FreeFileClaim =
  | { ok: true; granted: number; fallback: boolean }
  | { ok: false; reason: FreeFileRefusal };

function usedBy(tgId: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM free_files WHERE tg_id = ?`).get(tgId));
}

function audioUsed(fingerprint: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM free_files WHERE fingerprint = ?`).get(fingerprint));
}

function claimedThisWeek(): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM free_files WHERE created_at > datetime('now', '-7 days')`)
    .get() as unknown as { n: number };
  return Number(row.n);
}

function currentOffer(): FreeFileOffer {
  const fallback = claimedThisWeek() >= config.FREE_FIRST_FILE_PER_WEEK;
  return {
    minutes: fallback ? config.FREE_FALLBACK_MIN : config.FREE_FIRST_FILE_MAX_MIN,
    fallback,
  };
}

/** پیشنهادِ رایگان برای این حساب، یا `null` اگر خاموش است یا قبلاً گرفته. */
export function freeFileOffer(tgId: number): FreeFileOffer | null {
  if (!config.FREE_FIRST_FILE || usedBy(tgId)) return null;
  return currentOffer();
}

/**
 * رایگان را بگیر و سکه‌اش را واریز کن — ثبت و واریز یک اتم.
 *
 * `durationSec` مدتِ **واقعیِ** فایلِ روی دیسک است، نه عددِ سکو. کمترینِ
 * واریز یک دقیقه است چون `startJob` برای هر کاری دست‌کم یک دقیقه رزرو می‌کند؛
 * بی آن فایلِ بیست‌ثانیه‌ای با وجودِ رایگان «سکه‌ات کمه» می‌گرفت.
 */
export function claimFreeFile(o: {
  tgId: number;
  sessionId: string;
  fingerprint: string;
  durationSec: number;
}): FreeFileClaim {
  const out = atomic((m): FreeFileClaim => {
    if (!config.FREE_FIRST_FILE) return { ok: false, reason: "off" };
    if (usedBy(o.tgId)) return { ok: false, reason: "used" };
    if (audioUsed(o.fingerprint)) return { ok: false, reason: "audio_used" };

    const offer = currentOffer();
    // اعتبار به‌اندازهٔ قیمتِ همین فایل تا سقفِ دقیقه — همان `priceOf` که رزرو می‌کند.
    const granted = priceOf(Math.min(offer.minutes * 60, Math.max(1, Math.round(o.durationSec))));
    db.prepare(
      `INSERT INTO free_files (tg_id, session_id, fingerprint, granted_toman, fallback) VALUES (?, ?, ?, ?, ?)`,
    ).run(o.tgId, o.sessionId, o.fingerprint, granted, offer.fallback ? 1 : 0);
    m({
      tgId: o.tgId,
      delta: granted,
      reason: "free_file",
      sessionId: o.sessionId,
      note: offer.fallback ? "سقف هفتگی پر بود" : null,
    });
    return { ok: true, granted, fallback: offer.fallback };
  });

  if (out.ok) {
    logger.info({ tgId: o.tgId, sessionId: o.sessionId, toman: out.granted, fallback: out.fallback }, "free file granted");
  } else {
    logger.info({ tgId: o.tgId, sessionId: o.sessionId, reason: out.reason }, "free file refused");
  }
  return out;
}
