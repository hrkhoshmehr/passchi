/**
 * یادآوریِ «هنوز صوتی نفرستادی».
 *
 * روی سرور از ۶۵ کاربر فقط ۱۵ نفر صوت فرستاده بودند. بیشترِ بقیه هدیهٔ
 * شروع را گرفتند، شاید تور را هم دیدند، و رفتند — معمولاً چون همان لحظه
 * صوتی دستشان نبود. کلاسِ بعدی چند روز بعد است و تا آن وقت ربات فراموش شده.
 *
 * دو پیام، و فقط دو پیام: یکی بعد از یک روز (هدیه‌ات سر جایش است)، یکی بعد
 * از سه روز (کلاس کامل را لازم نیست تنها بدهی). بعد از آن سکوت؛ پیامِ سوم
 * دیگر یادآوری نیست، مزاحمت است و به بلاک‌شدن می‌رسد.
 *
 * **سه قاعدهٔ سخت:**
 * - فقط کسی که هیچ جلسه‌ای ندارد — نه خودش فرستاده، نه به جلسهٔ کسی
 *   پیوسته، نه در خرید گروهی جا گرفته. محصول به او نرسیده.
 * - فقط کاربرِ هفت روزِ اخیر. بدون این سقف، اولین اجرا بعد از استقرار به
 *   همهٔ کاربرانِ قدیمی یک‌جا پیام می‌داد.
 * - فقط روز، به وقت تهران. پیامِ ربات ساعت دو شب دلیلِ خوبی برای بلاک است.
 *
 * دروازهٔ یک‌بار ارسال، سطرِ `nudges` است که **پیش از** ارسال نوشته می‌شود.
 * ری‌استارتِ وسط ارسال در بدترین حالت یک پیام را نفرستاده می‌گذارد — هرگز
 * دوبار نمی‌فرستد.
 */

import { config } from "../config.js";
import { db } from "../db/index.js";
import "../db/funnel.js";
import { logger } from "../util/logger.js";
import { toFaDigits } from "../util/time.js";
import { balanceCoins } from "../billing/coins.js";
import { CONFIRM_BTN, START_BTN } from "../bot/strings.js";
import { notifyUser } from "../bot/notify.js";

export const NUDGE_MAX_AGE_DAYS = 7;

/** مرحله و فاصله‌اش از ثبت‌نام، به ساعت. */
export const NUDGE_STAGES = [
  { stage: 1, afterHours: 24 },
  { stage: 2, afterHours: 72 },
] as const;

/** بازهٔ مجاز ارسال به وقت تهران: از ۱۰ صبح تا پیش از ۹ شب. */
export const NUDGE_WINDOW = { from: 10, to: 21 } as const;

/** ساعتِ تهران. ایران از ۱۴۰۱ ساعت تابستانی ندارد، پس همیشه +۳:۳۰ است. */
export function tehranHour(now: Date): number {
  const minutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 210) % (24 * 60);
  return Math.floor(minutes / 60);
}

export function inSendWindow(now: Date): boolean {
  const h = tehranHour(now);
  return h >= NUDGE_WINDOW.from && h < NUDGE_WINDOW.to;
}

/** شکلِ `datetime('now')`ی SQLite، تا مقایسهٔ رشته‌ای با `created_at` درست باشد. */
function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export interface DueNudge {
  userId: number;
  stage: 1 | 2;
  creditSec: number;
}

/**
 * چه کسانی همین حالا یادآوری طلب دارند.
 *
 * مرحلهٔ دوم به **ارسالِ** مرحلهٔ اول هم وابسته است، نه فقط به عمرِ حساب:
 * کسی که روز سوم ثبت‌نام کرده و مرحلهٔ اول را امروز گرفته، نباید دو ساعت
 * بعد مرحلهٔ دوم را هم بگیرد. پس دست‌کم ۲۴ ساعت بین دو پیام.
 */
export function dueNudges(now: Date = new Date(), limit = 25): DueNudge[] {
  const t = sqlTime(now);
  const noActivity = `
    NOT EXISTS (SELECT 1 FROM sessions s WHERE s.tg_id = u.tg_id)
    AND NOT EXISTS (SELECT 1 FROM session_members m WHERE m.tg_id = u.tg_id)
    AND NOT EXISTS (SELECT 1 FROM group_buy_seats g WHERE g.tg_id = u.tg_id)
    AND EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.tg_id AND i.platform IN ('telegram', 'bale'))
    AND u.created_at >= datetime(?, '-${NUDGE_MAX_AGE_DAYS} days')`;

  const rows = db
    .prepare(
      `SELECT u.tg_id AS userId, 1 AS stage, u.credit_sec AS creditSec, u.created_at AS c
         FROM users u
        WHERE u.created_at <= datetime(?, '-${NUDGE_STAGES[0].afterHours} hours')
          AND NOT EXISTS (SELECT 1 FROM nudges n WHERE n.user_id = u.tg_id AND n.stage = 1)
          AND ${noActivity}
       UNION ALL
       SELECT u.tg_id, 2, u.credit_sec, u.created_at
         FROM users u
        WHERE u.created_at <= datetime(?, '-${NUDGE_STAGES[1].afterHours} hours')
          AND EXISTS (SELECT 1 FROM nudges n WHERE n.user_id = u.tg_id AND n.stage = 1
                        AND n.sent_at <= datetime(?, '-24 hours'))
          AND NOT EXISTS (SELECT 1 FROM nudges n WHERE n.user_id = u.tg_id AND n.stage = 2)
          AND ${noActivity}
        ORDER BY c
        LIMIT ?`,
    )
    .all(t, t, t, t, t, limit) as Array<{ userId: number; stage: number; creditSec: number }>;

  return rows.map((r) => ({
    userId: Number(r.userId),
    stage: Number(r.stage) === 2 ? 2 : 1,
    creditSec: Number(r.creditSec),
  }));
}

/** `true` فقط برای اولین صداکننده — همان الگوی `claimTopupPaid`. */
export function claimNudge(userId: number, stage: number, now: Date = new Date()): boolean {
  const r = db
    .prepare(`INSERT OR IGNORE INTO nudges (user_id, stage, sent_at) VALUES (?, ?, ?)`)
    .run(userId, stage, sqlTime(now));
  return Number(r.changes) === 1;
}

function markNudge(userId: number, stage: number, delivered: boolean): void {
  db.prepare(`UPDATE nudges SET delivered = ? WHERE user_id = ? AND stage = ?`).run(
    delivered ? 1 : 0,
    userId,
    stage,
  );
}

/**
 * متن هر مرحله.
 *
 * مرحلهٔ اول دربارهٔ هدیه است، چون تنها چیزی که کاربر همین حالا دارد همان
 * است. «۲۰ دقیقه» عمداً با کلاسِ کامل برابر گرفته نمی‌شود — کلاس نود
 * دقیقه‌ای است و وعدهٔ «یک کلاس رایگان» درست در لحظهٔ فرستادن زیرش می‌زند.
 *
 * مرحلهٔ دوم به مانعِ واقعیِ بعد از هدیه می‌پردازد: هزینهٔ کلاس کامل. اگر
 * خرید گروهی روشن است همان را می‌گوید، وگرنه شریک‌شدن پس از تحویل را —
 * هر دو با برچسبِ همان دکمه‌ای که کاربر واقعاً خواهد دید.
 */
export function nudgeMessage(stage: 1 | 2, creditSec: number, groupBuy: boolean): string {
  if (stage === 1) {
    const coins = balanceCoins(creditSec);
    const gift =
      coins > 0
        ? `🎁 <b>${toFaDigits(coins)} سکه‌ت</b> هنوز سر جاشه، یعنی ${toFaDigits(coins)} دقیقه صوت.\n`
        : "";
    return (
      `سلام 👋 هنوز صوتی برام نفرستادی.\n\n` +
      gift +
      `صوت کلاس بعدیتو با گوشی ضبط کن و همین‌جا بفرست؛ چند دقیقه بعد جزوه‌ش دستته.`
    );
  }
  const how = groupBuy
    ? `وقتی صوتو فرستادی، «${GROUP_BTN_LABEL}» رو بزن تا هزینه بین بچه‌های کلاس برابر تقسیم بشه.`
    : `وقتی صوتو فرستادی، «${CONFIRM_BTN.share}» رو بزن؛ هر کی جزوه رو بگیره سهمش میاد تو حساب تو.`;
  return (
    `یه کلاس کامل معمولاً نود دقیقه‌ست، و لازم نیست کل هزینه‌شو تنها بدی 📚\n\n` +
    `${how}\n\n` +
    `اگه هنوز مطمئن نیستی، اول خروجیِ یه کلاس واقعی رو ببین.`
  );
}

/** همان برچسبِ دکمهٔ «خرید گروهی» در صفحهٔ سکهٔ کم. */
export const GROUP_BTN_LABEL = "👥 با هم‌کلاسیا بخریم";

export function nudgeKeyboard(): Record<string, unknown> {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: START_BTN.send, callback_data: "startnow" }],
        [{ text: START_BTN.sample, callback_data: "demo:recap" }],
      ],
    },
  };
}

type Notify = (userId: number, text: string, extra?: Record<string, unknown>) => Promise<boolean>;

/** یک دور. تعدادِ پیام‌هایی که واقعاً رسیدند را برمی‌گرداند. */
export async function runNudges(
  opts: { now?: Date; notify?: Notify; limit?: number; gapMs?: number } = {},
): Promise<{ due: number; delivered: number }> {
  const now = opts.now ?? new Date();
  if (!inSendWindow(now)) return { due: 0, delivered: 0 };
  const notify = opts.notify ?? notifyUser;
  const due = dueNudges(now, opts.limit ?? 25);
  let delivered = 0;

  for (const d of due) {
    if (!claimNudge(d.userId, d.stage, now)) continue;
    let ok = false;
    try {
      ok = await notify(d.userId, nudgeMessage(d.stage, d.creditSec, config.GROUP_BUY), nudgeKeyboard());
    } catch (e) {
      logger.warn({ userId: d.userId, stage: d.stage, err: String(e) }, "nudge failed");
    }
    markNudge(d.userId, d.stage, ok);
    if (ok) delivered++;
    // سقفِ نرخِ سکوها؛ دور ۲۵ نفره با این فاصله زیر ده ثانیه تمام می‌شود.
    if (opts.gapMs !== 0) await new Promise((r) => setTimeout(r, opts.gapMs ?? 350));
  }

  if (due.length) logger.info({ due: due.length, delivered }, "یادآوری‌های فعال‌سازی فرستاده شد");
  return { due: due.length, delivered };
}

/** زمان‌بندی. `null` یعنی خاموش است. */
export function startNudges(): (() => void) | null {
  if (!config.NUDGES) return null;
  const tick = () => void runNudges().catch((e: unknown) => logger.warn({ err: String(e) }, "nudge tick failed"));
  // دقیقهٔ اول بعد از راه‌اندازی مالِ بازیابی و صف است؛ یادآوری عجله‌ای ندارد.
  const first = setTimeout(tick, 90_000);
  const every = setInterval(tick, 30 * 60_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
