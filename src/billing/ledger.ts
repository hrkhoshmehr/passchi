/**
 * حرکت‌های اعتبار.
 *
 * **هر** تغییر در `users.credit_sec` از این ماژول رد می‌شود و در همان تراکنش
 * یک سطر در `credit_ledger` می‌نویسد. هیچ جای دیگری اجازه ندارد مستقیم
 * `UPDATE users SET credit_sec` بزند — دفتر کل سند مالی است و موجودی‌ای که
 * با آن نخواند باگی است که نمی‌شود بازسازی‌اش کرد.
 *
 * چرخهٔ عمر یک کار: `reserve` سپس اجرای کار، و بعد `commit` در موفقیت یا
 * `refund` در هر شکست، وقفه، یا لغو.
 *
 * واحد **ثانیهٔ صوت** است نه سکه. هزینهٔ واقعی ما با مدت می‌آید نه با تعداد
 * درخواست، پس هر واحد دیگری فقط یک لایهٔ ترجمه اضافه می‌کند که جایی برای
 * خطا باز می‌کند.
 */

import { db } from "../db/index.js";
import { logger } from "../util/logger.js";

export type LedgerReason =
  | "trial"          // اعتبار آزمایشی اولیه
  | "grant"          // شارژ دستی ادمین
  | "topup"          // شارژ کاربر پس از تأیید رسید
  | "reserve"        // کنارگذاشتن پیش از اجرای کار
  | "commit"         // تسویهٔ نهایی پس از موفقیت (تفاوت مدت واقعی و تخمینی)
  | "refund"         // برگشت به‌خاطر شکست کار
  | "share_charge"   // سهم کسی که به جلسه پیوسته
  | "share_refund";  // برگشت به اعضای قبلی چون سهم هرکس کمتر شد

export class InsufficientCredit extends Error {
  readonly shortfall: number;
  constructor(
    readonly balance: number,
    readonly needed: number,
  ) {
    super(`اعتبار ${balance} ثانیه کمتر از ${needed} ثانیهٔ لازم است.`);
    this.shortfall = needed - balance;
    this.name = "InsufficientCredit";
  }
}

interface MoveOptions {
  tgId: number;
  /** منفی یعنی برداشت */
  deltaSec: number;
  reason: LedgerReason;
  sessionId?: string | null;
  note?: string | null;
  /** اگر true باشد، موجودی ناکافی خطا می‌دهد به‌جای اینکه تا صفر پایین بیاید */
  strict?: boolean;
}

const balanceOf = db.prepare(`SELECT credit_sec FROM users WHERE tg_id = ?`);
const applyDelta = db.prepare(`UPDATE users SET credit_sec = ? WHERE tg_id = ?`);
const bumpUsed = db.prepare(`UPDATE users SET total_used_sec = total_used_sec + ? WHERE tg_id = ?`);
const writeRow = db.prepare(
  `INSERT INTO credit_ledger (tg_id, delta_sec, balance_after, reason, session_id, note)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

/** یک حرکت اعتبار، اتمیک، با سطر دفتر کل در همان تراکنش. */
export function move(opt: MoveOptions): number {
  const run = db.prepare("BEGIN IMMEDIATE");
  run.run();
  try {
    const row = balanceOf.get(opt.tgId) as unknown as { credit_sec: number } | undefined;
    if (!row) throw new Error(`کاربر ${opt.tgId} وجود ندارد.`);

    const balance = row.credit_sec;
    const next = balance + opt.deltaSec;
    if (next < 0) {
      if (opt.strict !== false) throw new InsufficientCredit(balance, -opt.deltaSec);
    }
    const clamped = Math.max(0, next);
    const actualDelta = clamped - balance;

    applyDelta.run(clamped, opt.tgId);
    if (actualDelta < 0) bumpUsed.run(-actualDelta, opt.tgId);
    writeRow.run(
      opt.tgId,
      actualDelta,
      clamped,
      opt.reason,
      opt.sessionId ?? null,
      opt.note ?? null,
    );

    db.prepare("COMMIT").run();
    logger.debug(
      { tgId: opt.tgId, delta: actualDelta, balance: clamped, reason: opt.reason },
      "credit move",
    );
    return clamped;
  } catch (e) {
    db.prepare("ROLLBACK").run();
    throw e;
  }
}

export function grant(tgId: number, seconds: number, reason: LedgerReason = "grant"): number {
  return move({ tgId, deltaSec: Math.round(seconds), reason });
}

/** پیش از اجرای کار کنار گذاشته می‌شود تا کاربر نتواند بیش از اعتبارش کار صف کند. */
export function reserve(tgId: number, seconds: number, sessionId: string): number {
  return move({ tgId, deltaSec: -Math.round(seconds), reason: "reserve", sessionId });
}

/**
 * تسویه پس از موفقیت.
 *
 * رزرو بر پایهٔ مدتی است که تلگرام اعلام کرده؛ مدت واقعی بعد از پردازش معلوم
 * می‌شود. اینجا فقط تفاوت جابه‌جا می‌شود — نه دوباره کل مبلغ.
 */
export function commit(tgId: number, reservedSec: number, actualSec: number, sessionId: string): number {
  const diff = Math.round(reservedSec - actualSec);
  if (diff === 0) return currentBalance(tgId);
  return move({
    tgId,
    deltaSec: diff,
    reason: "commit",
    sessionId,
    note: diff > 0 ? "مدت واقعی کمتر از تخمین بود" : "مدت واقعی بیشتر از تخمین بود",
    strict: false,
  });
}

export function refund(tgId: number, seconds: number, sessionId: string, note?: string): number {
  return move({
    tgId,
    deltaSec: Math.round(seconds),
    reason: "refund",
    sessionId,
    ...(note ? { note } : {}),
  });
}

export function currentBalance(tgId: number): number {
  const row = balanceOf.get(tgId) as unknown as { credit_sec: number } | undefined;
  return row?.credit_sec ?? 0;
}

export interface LedgerRow {
  id: number;
  delta_sec: number;
  balance_after: number;
  reason: LedgerReason;
  session_id: string | null;
  note: string | null;
  created_at: string;
}

export function history(tgId: number, limit = 20): LedgerRow[] {
  return db
    .prepare(
      `SELECT id, delta_sec, balance_after, reason, session_id, note, created_at
       FROM credit_ledger WHERE tg_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(tgId, limit) as unknown as LedgerRow[];
}

/** مجموع آنچه کاربر بابت اشتراکی‌شدن جلسات پس گرفته است. */
export function totalShareRefunds(tgId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(delta_sec), 0) AS total FROM credit_ledger
       WHERE tg_id = ? AND reason = 'share_refund'`,
    )
    .get(tgId) as unknown as { total: number };
  return row.total;
}
