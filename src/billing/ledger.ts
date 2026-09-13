/**
 * حرکت‌های اعتبار — به **تومان**.
 *
 * **هر** تغییر در `users.credit_toman` از این ماژول رد می‌شود و در همان تراکنش
 * یک سطر در `credit_ledger` می‌نویسد. هیچ جای دیگری اجازه ندارد مستقیم
 * `UPDATE users SET credit_toman` بزند — دفتر کل سند مالی است و موجودی‌ای که
 * با آن نخواند باگی است که نمی‌شود بازسازی‌اش کرد.
 *
 * چرخهٔ عمر یک کار: `reserve` سپس اجرای کار، و بعد `commit` در موفقیت یا
 * `refund` در هر شکست، وقفه، یا لغو. مبلغ‌ها از `priceOf` در `money.ts`
 * درمی‌آیند؛ این ماژول از مدتِ صوت خبری ندارد.
 *
 * تا ۲۰۲۶-۰۹-۱۴ واحد ثانیهٔ صوت بود؛ چرایی تغییر در `money.ts`.
 */

import { db, unreservedSql } from "../db/index.js";
import fs from "node:fs";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

export type LedgerReason =
  | "trial"          // هدیهٔ شروع
  | "grant"          // اعتبار دستی ادمین یا کد هدیه
  | "topup"          // شارژ کاربر پس از تأیید پرداخت
  | "reserve"        // کنارگذاشتن پیش از اجرای کار
  | "commit"         // تسویهٔ نهایی پس از موفقیت (تفاوت مبلغ واقعی و رزرو)
  | "refund"         // برگشت به‌خاطر شکست کار
  | "share_charge"   // سهم کسی که به جلسه پیوسته
  | "share_refund"   // برگشت همان سهم به صاحب جلسه
  | "transfer_out"   // تاریخچه؛ انتقال برداشته شد
  | "transfer_in"    // تاریخچه
  | "free_file";     // اعتبار اولین صوتِ رایگان، به‌اندازهٔ همان فایل

export class InsufficientCredit extends Error {
  readonly shortfall: number;
  constructor(
    readonly balance: number,
    readonly needed: number,
  ) {
    super(`اعتبار ${balance} تومان کمتر از ${needed} تومانِ لازم است.`);
    this.shortfall = needed - balance;
    this.name = "InsufficientCredit";
  }
}

interface MoveOptions {
  tgId: number;
  /** منفی یعنی برداشت، به تومان */
  delta: number;
  reason: LedgerReason;
  sessionId?: string | null;
  note?: string | null;
  /** اگر true باشد، موجودی ناکافی خطا می‌دهد به‌جای اینکه تا صفر پایین بیاید */
  strict?: boolean;
}

const balanceOf = db.prepare(`SELECT credit_toman FROM users WHERE tg_id = ?`);
const applyDelta = db.prepare(`UPDATE users SET credit_toman = ? WHERE tg_id = ?`);
const bumpSpent = db.prepare(`UPDATE users SET total_spent_toman = total_spent_toman + ? WHERE tg_id = ?`);
const writeRow = db.prepare(
  `INSERT INTO credit_ledger (tg_id, delta_toman, balance_after, reason, session_id, note)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

/** همان حرکت، بی تراکنشِ خودش — فقط از داخل `move` یا `atomic` صدا زده می‌شود. */
function applyMove(opt: MoveOptions): number {
  const row = balanceOf.get(opt.tgId) as unknown as { credit_toman: number } | undefined;
  if (!row) throw new Error(`کاربر ${opt.tgId} وجود ندارد.`);

  const balance = row.credit_toman;
  const next = balance + Math.round(opt.delta);
  if (next < 0 && opt.strict !== false) throw new InsufficientCredit(balance, -Math.round(opt.delta));
  const clamped = Math.max(0, next);
  const actualDelta = clamped - balance;

  applyDelta.run(clamped, opt.tgId);
  if (actualDelta < 0) bumpSpent.run(-actualDelta, opt.tgId);
  writeRow.run(opt.tgId, actualDelta, clamped, opt.reason, opt.sessionId ?? null, opt.note ?? null);
  logger.debug({ tgId: opt.tgId, delta: actualDelta, balance: clamped, reason: opt.reason }, "credit move");
  return clamped;
}

/** یک حرکت اعتبار، اتمیک، با سطر دفتر کل در همان تراکنش. */
export function move(opt: MoveOptions): number {
  return atomic((m) => m(opt));
}

export type Mover = (opt: MoveOptions) => number;

/**
 * چند حرکت و چند نوشتنِ دیگر، **یک** تراکنش — مثلاً سهمِ هم‌کلاسی و برگشتش به
 * صاحب جلسه. `fn` حرکت را از آرگومانش می‌گیرد تا نوشتنِ بی‌تراکنش در دسترس
 * جای دیگری نباشد. هر پرتابی کلِ کار را برمی‌گرداند.
 */
export function atomic<T>(fn: (m: Mover) => T): T {
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const out = fn(applyMove);
    db.prepare("COMMIT").run();
    return out;
  } catch (e) {
    db.prepare("ROLLBACK").run();
    throw e;
  }
}

export function grant(tgId: number, toman: number, reason: LedgerReason = "grant"): number {
  return move({ tgId, delta: Math.round(toman), reason });
}

/** پیش از اجرای کار کنار گذاشته می‌شود تا کاربر نتواند بیش از اعتبارش کار صف کند. */
export function reserve(tgId: number, toman: number, sessionId: string): number {
  return move({ tgId, delta: -Math.round(toman), reason: "reserve", sessionId });
}

/**
 * تسویه پس از موفقیت: فقط تفاوتِ رزرو و مبلغِ واقعی جابه‌جا می‌شود.
 *
 * ⚠️ تفاوتِ صفر **هیچ سطری نمی‌نویسد** — `danglingReservations` این را می‌داند.
 */
export function commit(tgId: number, reservedToman: number, actualToman: number, sessionId: string): number {
  const diff = Math.round(reservedToman - actualToman);
  if (diff === 0) return currentBalance(tgId);
  return move({
    tgId,
    delta: diff,
    reason: "commit",
    sessionId,
    note: diff > 0 ? "مبلغ واقعی کمتر از رزرو بود" : "مبلغ واقعی بیشتر از رزرو بود",
    strict: false,
  });
}

export function refund(tgId: number, toman: number, sessionId: string, note?: string): number {
  return move({ tgId, delta: Math.round(toman), reason: "refund", sessionId, ...(note ? { note } : {}) });
}

export function currentBalance(tgId: number): number {
  const row = balanceOf.get(tgId) as unknown as { credit_toman: number } | undefined;
  return row?.credit_toman ?? 0;
}

/**
 * اعتباری که کاربر **پول داده** و هنوز خرجش نکرده.
 *
 * موجودی نمی‌گوید پول از کجا آمده. ده حسابِ ساختگی که هرکدام هدیهٔ شروع گرفته‌اند
 * می‌توانند با سهم‌دادن در جلسهٔ یک نفر، هدیه را به اعتبارِ واقعیِ او تبدیل
 * کنند. پس سهمی که از این مبلغ بیشتر است «با هدیه» شمرده می‌شود و بودجهٔ هفتگیِ
 * هدیه (`sharing.ts`) را می‌خورد.
 *
 * فقط `topup` خریداری‌شده است؛ `share_refund` عمداً نه، چون از جیبِ همان
 * پیوسته‌ها می‌آید. خرج اول از خریداری‌شده کم می‌شود (سختگیرانه‌ترین حالت).
 */
export function paidCredit(tgId: number): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN reason IN ('topup','transfer_in') THEN delta_toman END), 0) AS bought,
         COALESCE(SUM(CASE WHEN reason = 'transfer_out' THEN -delta_toman END), 0) AS sent,
         COALESCE(SUM(CASE WHEN reason IN ('reserve','commit','refund','share_charge')
                           THEN -delta_toman END), 0) AS spent
       FROM credit_ledger WHERE tg_id = ?`,
    )
    .get(tgId) as unknown as { bought: number; sent: number; spent: number };
  const free = row.bought - row.sent - Math.max(0, row.spent);
  return Math.max(0, Math.min(free, currentBalance(tgId)));
}

export interface LedgerRow {
  id: number;
  delta_toman: number;
  balance_after: number;
  reason: LedgerReason;
  session_id: string | null;
  note: string | null;
  created_at: string;
}

export function history(tgId: number, limit = 20): LedgerRow[] {
  return db
    .prepare(
      `SELECT id, delta_toman, balance_after, reason, session_id, note, created_at
       FROM credit_ledger WHERE tg_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(tgId, limit) as unknown as LedgerRow[];
}

/** مجموع آنچه کاربر از شریک‌شدنِ جلسه‌هایش پس گرفته است. */
export function totalShareRefunds(tgId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(delta_toman), 0) AS total FROM credit_ledger
       WHERE tg_id = ? AND reason = 'share_refund'`,
    )
    .get(tgId) as unknown as { total: number };
  return row.total;
}

/**
 * جلسه‌هایی که در `queued` مانده‌اند بی‌آنکه هرگز رزروی برایشان ثبت شود.
 *
 * هر شکستی میانِ ساختِ جلسه و رزرو یک سطرِ یتیم می‌سازد که
 * `danglingReservations` نمی‌بیندش. فقط جلسه‌های **کهنه**؛ و آپلودِ مینی‌اپی که
 * فایلش هنوز هست یتیم نیست — منتظرِ تأیید یا شارژ است.
 */
export function orphanedQueued(olderThanMinutes = 30): Array<{ id: string; tgId: number }> {
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.tg_id AS tgId, s.download_route AS route, s.original_file AS file,
              julianday('now') - julianday(s.created_at) AS ageDays
         FROM sessions s
        WHERE s.status = 'queued'
          AND s.created_at < datetime('now', ?)
          AND ${unreservedSql("s")}`,
    )
    .all(`-${Math.max(1, Math.round(olderThanMinutes))} minutes`) as unknown as Array<{
    id: string;
    tgId: number;
    route: string | null;
    file: string | null;
    ageDays: number;
  }>;
  return rows
    .filter(
      (r) =>
        !(r.route === "web" && r.file && r.ageDays < config.KEEP_AUDIO_DAYS && fs.existsSync(r.file)),
    )
    .map(({ id, tgId }) => ({ id, tgId }));
}

/**
 * جلسه‌هایی که پولشان رزرو شد ولی هرگز تسویه یا برگشت نخورد — پروسه وسطِ کار مُرد.
 *
 * **حسابِ خالصِ هر نفر در هر جلسه**، و تسویه فقط وقتی حساب را می‌بندد که پس از
 * آخرین رزروِ همان نفر نوشته شده باشد. جلسه‌ای که به سرانجام رسیده هرگز آویزان
 * نیست، هر چه در دفتر باشد.
 */
export function danglingReservations(): Array<{
  sessionId: string;
  tgId: number;
  reserved: number;
}> {
  return db
    .prepare(
      `SELECT r.session_id AS sessionId, r.tg_id AS tgId,
              -SUM(CASE WHEN r.reason IN ('reserve', 'refund') THEN r.delta_toman ELSE 0 END) AS reserved
         FROM credit_ledger r
         JOIN sessions s ON s.id = r.session_id
        WHERE r.session_id IS NOT NULL
          AND s.status NOT IN ('done', 'error', 'cancelled', 'awaiting_group')
        GROUP BY r.session_id, r.tg_id
       HAVING reserved > 0
          AND NOT EXISTS (
            SELECT 1 FROM credit_ledger c
             WHERE c.session_id = r.session_id AND c.tg_id = r.tg_id AND c.reason = 'commit'
               AND c.id > (
                 SELECT MAX(m.id) FROM credit_ledger m
                  WHERE m.session_id = r.session_id AND m.tg_id = r.tg_id AND m.reason = 'reserve'
               )
          )`,
    )
    .all() as unknown as Array<{ sessionId: string; tgId: number; reserved: number }>;
}
