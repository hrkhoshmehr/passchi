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

import { db, unreservedSql } from "../db/index.js";
import fs from "node:fs";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

export type LedgerReason =
  | "trial"          // اعتبار آزمایشی اولیه
  | "grant"          // شارژ دستی ادمین
  | "topup"          // شارژ کاربر پس از تأیید رسید
  | "reserve"        // کنارگذاشتن پیش از اجرای کار
  | "commit"         // تسویهٔ نهایی پس از موفقیت (تفاوت مدت واقعی و تخمینی)
  | "refund"         // برگشت به‌خاطر شکست کار
  | "share_charge"   // سهم کسی که به جلسه پیوسته
  | "share_refund"   // برگشت به اعضای قبلی چون سهم هرکس کمتر شد
  | "transfer_out"   // سکه‌ای که کاربر برای هم‌کلاسی‌اش فرستاد
  | "transfer_in";   // سکه‌ای که از هم‌کلاسی رسید

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

/** همان حرکت، بی تراکنشِ خودش — فقط از داخل `move` یا `atomic` صدا زده می‌شود. */
function applyMove(opt: MoveOptions): number {
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
  logger.debug(
    { tgId: opt.tgId, delta: actualDelta, balance: clamped, reason: opt.reason },
    "credit move",
  );
  return clamped;
}

/** یک حرکت اعتبار، اتمیک، با سطر دفتر کل در همان تراکنش. */
export function move(opt: MoveOptions): number {
  return atomic((m) => m(opt));
}

export type Mover = (opt: MoveOptions) => number;

/**
 * چند حرکت و چند نوشتنِ دیگر، **یک** تراکنش.
 *
 * خرید گروهی یک جلسه را میان چند حساب پخش می‌کند: ثبتِ صندلی و رزروِ سکهٔ
 * همان نفر، یا برگشتِ سکهٔ همهٔ نفرات و بستنِ گروه. اگر هرکدام تراکنشِ خودش
 * را داشت، مردنِ پروسه وسطِ کار گروهی نیمه‌باز می‌گذاشت که یا سکه‌اش دو بار
 * برمی‌گشت یا هرگز. همان قاعدهٔ `moveBetween`، برای هر تعداد حرکت.
 *
 * `fn` حرکت را از آرگومانش می‌گیرد نه از بیرون، تا نوشتنِ بی‌تراکنش در دسترس
 * هیچ جای دیگری نباشد. هر پرتابی کلِ کار را برمی‌گرداند.
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

// ─── سکهٔ خریداری‌شده ────────────────────────────────────────────────────────
//
// انتقال سکه میان کاربران ۲۰۲۶-۰۹-۱۳ برداشته شد؛ این سنجه برای سهمِ هدیه‌ایِ
// خرید گروهی مانده. سطرهای `transfer_in`/`transfer_out` تاریخچه‌اند.

/**
 * سکه‌هایی که کاربر **پول داده** و هنوز خرجشان نکرده — تنها چیزی که اجازهٔ
 * فرستادن دارد.
 *
 * ## چرا از دفتر، نه از `users.credit_sec`
 *
 * موجودی نمی‌گوید سکه از کجا آمده. اگر ملاکِ انتقال موجودی باشد، ده حساب
 * قلابی که هرکدام ۲۰ سکهٔ `trial` گرفته‌اند، ۲۰۰ سکهٔ مجانی را در یک حساب
 * جمع می‌کنند و هزینه‌اش را ما می‌دهیم. پس منبعِ هر سکه از `reason` خوانده
 * می‌شود و فقط دو منبع «خریداری‌شده» حساب می‌شوند:
 *
 *   • `topup` — پولی که واقعاً وارد شده.
 *   • `transfer_in` — سکه‌ای که خودش قبلاً `topup` بوده و دست‌به‌دست شده؛
 *     اگر اینجا نیاید، سکهٔ خریداری‌شده پس از یک انتقال می‌میرد.
 *
 * `trial` و `grant` بیرون‌اند — همان دروازهٔ اصلی. `share_refund` هم بیرون
 * است و این عمدی است: برگشتیِ اشتراک‌گذاری از جیبِ کسانی می‌آید که پیوسته‌اند،
 * و اگر آن‌ها حساب تازه باشند سهمشان را با سکهٔ هدیه داده‌اند. یعنی همان
 * قیفِ سکهٔ مجانی، فقط یک گام درازتر.
 *
 * ## کدام سکه اول خرج می‌شود: **خریداری‌شده**
 *
 * تصمیمِ عمدی، و سختگیرانه‌ترین حالت. هر ثانیه‌ای که کاربر خرج کرده اول از
 * سهمِ خریدش کم می‌شود و هدیه دست‌نخورده می‌ماند؛ پس آنچه در پایان قابل
 * انتقال است هرگز بیشتر از «آنچه خریدی و مصرف نکردی» نمی‌شود.
 *
 * عکسش (اول هدیه) دستِ کاربر را بازتر می‌گذارد ولی ارزشِ سکهٔ رایگان را از
 * راهِ کناری قابل‌انتقال می‌کند: کسی که ۱۰۰ سکه خریده و ۹۰ سکه خرج کرده، با
 * «اول هدیه» ۳۰ سکه می‌فرستد در حالی که ۲۰ تای آن هدیه بوده است. با «اول
 * خرید» ۱۰ سکه می‌فرستد — دقیقاً همان‌قدر که پولش را داده و مصرفش نکرده.
 *
 * هزینهٔ این سختگیری در عمل کم است: هم‌کلاسی‌ای که ۱۰ سکه می‌گذارد، معمولاً
 * تازه پکیج خریده. و قاعده در یک جمله گفتنی است: «هرچی خریدی و خرج نکردی».
 *
 * سرانجام با موجودیِ واقعی هم بریده می‌شود؛ سکه‌ای که همین حالا برای یک کارِ
 * در جریان رزرو شده، در `credit_sec` نیست و نباید فرستاده شود.
 */
export function transferableSec(tgId: number): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN reason IN ('topup','transfer_in') THEN delta_sec END), 0) AS bought,
         COALESCE(SUM(CASE WHEN reason = 'transfer_out' THEN -delta_sec END), 0) AS sent,
         -- خرجِ خالص: رزرو و تسویه و بازپرداخت با هم، تا کاری که برگشت خورده
         -- دو بار حساب نشود. برگشتیِ اشتراک‌گذاری عمداً اینجا نیست، پس خرج
         -- کمتر از واقع برآورد نمی‌شود.
         COALESCE(SUM(CASE WHEN reason IN ('reserve','commit','refund','share_charge')
                           THEN -delta_sec END), 0) AS spent
       FROM credit_ledger WHERE tg_id = ?`,
    )
    .get(tgId) as unknown as { bought: number; sent: number; spent: number };

  const free = row.bought - row.sent - Math.max(0, row.spent);
  return Math.max(0, Math.min(free, currentBalance(tgId)));
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

/**
 * جلسه‌هایی که سکه‌شان رزرو شد ولی هرگز تسویه یا برگشت نخورد.
 *
 * یعنی پروسه وسطِ کار مُرد. تا وقتی زنده است، هر شکستی از `catch` در
 * `startJob` رد می‌شود و بازپرداخت می‌کند؛ ولی `process.exit` و OOM و
 * `SIGKILL` پرتاب نمی‌کنند — فقط می‌میرند. آن‌وقت سکه رزرو-شده می‌ماند و
 * جلسه تا ابد روی `preprocess`.
 *
 * منبع حقیقت **دفتر** است نه ستون `status`: اگر جایی وضعیت درست به‌روز
 * نشود باز هم پول درست حساب می‌شود، و این همان چیزی است که کاربر می‌بیند.
 */
/**
 * جلسه‌هایی که در `queued` مانده‌اند بی‌آنکه هرگز رزروی برایشان ثبت شود.
 *
 * `createSession` وضعیت را همان اول `queued` می‌گذارد و رزرو چند گام بعد
 * انجام می‌شود؛ هر شکستی در این فاصله یک سطر یتیم می‌سازد که
 * `danglingReservations` نمی‌بیندش (سطر `reserve` ندارد).
 *
 * فقط جلسه‌های **کهنه** برگردانده می‌شوند: جلسه‌ای که همین حالا ساخته شده
 * ممکن است واقعاً در صف باشد، و جمع‌کردنش یعنی کشتنِ کارِ در جریان. این
 * تابع در راه‌اندازی صدا زده می‌شود که صف حافظه خالی است، ولی مهلت را
 * نگه می‌داریم تا اگر روزی جای دیگری هم صدا زده شد بی‌خطر بماند.
 *
 * **آپلودِ مینی‌اپی که فایلش هنوز هست، یتیم نیست.** مینی‌اپ فایل را آپلود و
 * جلسه را `queued` می‌گذارد تا دانشجو هزینه را تأیید کند؛ اگر سکه‌اش کم باشد
 * برای شارژ بیرون می‌رود و `GET /api/uploads/pending` با همین ملاک همان فایل را
 * دوباره پیشنهاد می‌دهد. بی این استثنا هر ری‌استارت — از جمله هر استقرار —
 * همان جلسه را `error` می‌کرد و قولِ «فایلت همین‌جا می‌مونه» دروغ درمی‌آمد.
 *
 * استثنا سقف دارد: `expiredAudio` جلسهٔ `queued` را پاک نمی‌کند، پس آپلودی که
 * از `KEEP_AUDIO_DAYS` گذشته مثل قبل جمع می‌شود تا فایلش بالاخره پاک شود.
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

export function danglingReservations(): Array<{
  sessionId: string;
  tgId: number;
  reservedSec: number;
}> {
  /**
   * **حسابِ خالصِ هر نفر در هر جلسه**، نه «آیا جلسه هیچ برگشتی دارد».
   *
   * نسخهٔ قبلی جلسه‌ای را که *یک* سطر `refund` یا `commit` داشت کلاً رها
   * می‌کرد. با خرید گروهی دو دام از همین درمی‌آمد: گروهی که پر نشد و سکه‌اش
   * برگشت و بعد مالک تنها پرداخت — سطرِ برگشتِ قدیمی رزروِ تازه را پنهان
   * می‌کرد و ری‌استارت وسطِ کار سکه‌اش را می‌بلعید؛ و چند نفر روی یک جلسه،
   * که تسویهٔ یکی رزروِ بقیه را پنهان می‌کرد. همان دام برای «دوباره تلاش کن»
   * پس از شکست هم بود.
   *
   * پس خالصِ رزرو و برگشتِ **همان نفر** سنجیده می‌شود، و تسویه فقط وقتی حساب
   * را می‌بندد که پس از آخرین رزروِ همان نفر نوشته شده باشد.
   *
   * ⚠️ `commit` وقتی تفاوت صفر باشد **هیچ سطری نمی‌نویسد**، پس نبودِ سطر
   * به‌تنهایی یعنی «ناتمام» نیست. جلسه‌ای که به سرانجام رسیده هرگز آویزان
   * نیست، هر چه در دفتر باشد.
   *
   * `awaiting_group` هم آویزان نیست: رزروِ گروهی که هنوز پر نشده **عمداً**
   * باز است و تا ۴۸ ساعت باز می‌ماند. بدون این استثنا هر ری‌استارت — از جمله
   * هر استقرار — همهٔ گروه‌های باز را خالی می‌کرد.
   */
  return db
    .prepare(
      `SELECT r.session_id AS sessionId, r.tg_id AS tgId,
              -SUM(CASE WHEN r.reason IN ('reserve', 'refund') THEN r.delta_sec ELSE 0 END) AS reservedSec
         FROM credit_ledger r
         JOIN sessions s ON s.id = r.session_id
        WHERE r.session_id IS NOT NULL
          AND s.status NOT IN ('done', 'error', 'cancelled', 'awaiting_group')
        GROUP BY r.session_id, r.tg_id
       HAVING reservedSec > 0
          AND NOT EXISTS (
            SELECT 1 FROM credit_ledger c
             WHERE c.session_id = r.session_id AND c.tg_id = r.tg_id AND c.reason = 'commit'
               AND c.id > (
                 SELECT MAX(m.id) FROM credit_ledger m
                  WHERE m.session_id = r.session_id AND m.tg_id = r.tg_id AND m.reason = 'reserve'
               )
          )`,
    )
    .all() as unknown as Array<{ sessionId: string; tgId: number; reservedSec: number }>;
}
