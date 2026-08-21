/**
 * تقسیم هزینهٔ یک جلسه بین هم‌کلاسی‌ها.
 *
 * مسئله: یک جلسه یک بار پردازش می‌شود ولی بیست‌وپنج نفر همان درس را دارند.
 * اگر هرکس جدا بفرستد، بیست‌وپنج بار هزینه می‌دهیم برای یک محتوا. اگر فقط
 * یک نفر بفرستد، همان یک نفر تمام هزینه را می‌دهد و بقیه مفت سوار می‌شوند.
 *
 * قاعده: **تقسیم مساوی با بازپرداخت رونده.** جلسه یک هزینهٔ ثابت دارد
 * (مدت صوت). هر بار کسی می‌پیوندد، سهم هر نفر دوباره حساب می‌شود و مابه‌التفاوت
 * به اعضای قبلی برمی‌گردد. یعنی:
 *
 *   یک نفر  → همان یک نفر کل ۵۰ دقیقه را می‌دهد
 *   دو نفر  → هرکدام ۲۵ دقیقه، فرستنده ۲۵ دقیقه پس می‌گیرد
 *   پنج نفر → هرکدام ۱۰ دقیقه، فرستنده تا اینجا ۴۰ دقیقه پس گرفته
 *
 * دو ویژگی که عمداً این‌طور انتخاب شده‌اند:
 *
 * • **فرستنده هیچ‌وقت سود نمی‌کند.** بازپرداخت تا سقف چیزی است که خودش داده.
 *   اگر بیشتر بود، محصول تبدیل می‌شد به طرحی که مردم برای درآمد واردش می‌شوند
 *   و انگیزه از «جزوهٔ درسم را می‌خواهم» به «عضو جمع کنم» جابه‌جا می‌شد.
 *
 * • **پلتفرم همیشه دقیقاً یک بار هزینهٔ جلسه را می‌گیرد،** فارغ از تعداد اعضا.
 *   حاشیه حفظ می‌شود و پیام به کاربر هم صادقانه است: «یک بار برای جلسه حساب
 *   می‌شود، شما تقسیمش می‌کنید».
 */

import { db } from "../db/index.js";
import { logger } from "../util/logger.js";
import { InsufficientCredit, move } from "./ledger.js";

/**
 * کف سهم هر نفر. بدون این، یک گروه صدنفره سهم را به سی ثانیه می‌رساند و
 * محصول عملاً رایگان می‌شود؛ ضمن اینکه سربار هر عضو (ارسال فایل و پیام‌ها)
 * خودش هزینه دارد حتی وقتی پردازش دوباره انجام نمی‌شود.
 */
export const MIN_SHARE_SEC = 90;

export interface Member {
  session_id: string;
  tg_id: number;
  paid_sec: number;
  role: "owner" | "member";
  joined_at: string;
}

export interface JoinResult {
  /** آنچه از تازه‌وارد کسر شد */
  chargedSec: number;
  /** سهم فعلی هر نفر پس از این پیوستن */
  shareSec: number;
  memberCount: number;
  /** به چه کسانی چقدر برگشت */
  refunds: Array<{ tgId: number; amountSec: number }>;
}

export class AlreadyMember extends Error {
  constructor() {
    super("این جلسه از قبل در دسترس شماست.");
    this.name = "AlreadyMember";
  }
}

export class NotShareable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotShareable";
  }
}

/** سهم هر نفر وقتی جلسه بین `count` نفر تقسیم شود. */
export function fairShare(costSec: number, count: number): number {
  if (count <= 0) return costSec;
  return Math.max(MIN_SHARE_SEC, Math.ceil(costSec / count));
}

export function members(sessionId: string): Member[] {
  return db
    .prepare(`SELECT * FROM session_members WHERE session_id = ? ORDER BY joined_at`)
    .all(sessionId) as unknown as Member[];
}

export function isMember(sessionId: string, tgId: number): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM session_members WHERE session_id = ? AND tg_id = ?`).get(sessionId, tgId),
  );
}

/** فرستنده به‌عنوان مالک ثبت می‌شود، با کل هزینهٔ جلسه به پای خودش. */
export function registerOwner(sessionId: string, tgId: number, costSec: number): void {
  db.prepare(
    `INSERT INTO session_members (session_id, tg_id, paid_sec, role) VALUES (?, ?, ?, 'owner')
     ON CONFLICT(session_id, tg_id) DO UPDATE SET paid_sec = excluded.paid_sec`,
  ).run(sessionId, tgId, Math.round(costSec));
}

interface SessionCost {
  id: string;
  tg_id: number;
  status: string;
  original_ms: number;
  share_enabled: number;
}

/**
 * پیوستن به یک جلسهٔ اشتراکی.
 *
 * همهٔ حرکت‌های اعتبار — کسر از تازه‌وارد و بازپرداخت به اعضای قبلی — از
 * دفتر کل رد می‌شوند. اگر تازه‌وارد اعتبار کافی نداشته باشد، هیچ‌چیز تغییر
 * نمی‌کند: بررسی موجودی پیش از هر نوشتنی انجام می‌شود.
 */
export function joinSession(sessionId: string, tgId: number): JoinResult {
  const s = db
    .prepare(`SELECT id, tg_id, status, original_ms, share_enabled FROM sessions WHERE id = ?`)
    .get(sessionId) as unknown as SessionCost | undefined;

  if (!s) throw new NotShareable("این جلسه پیدا نشد.");
  if (s.status !== "done") throw new NotShareable("این جلسه هنوز آماده نیست.");
  if (!s.share_enabled) throw new NotShareable("صاحب این جلسه اشتراک‌گذاری را روشن نکرده است.");
  if (isMember(sessionId, tgId)) throw new AlreadyMember();

  const costSec = Math.round(s.original_ms / 1000);
  const existing = members(sessionId);
  const count = existing.length + 1;
  const share = fairShare(costSec, count);

  // بررسی موجودی *قبل* از هر نوشتنی — تا نیمه‌کاره نماند
  const bal = db.prepare(`SELECT credit_sec FROM users WHERE tg_id = ?`).get(tgId) as unknown as
    | { credit_sec: number }
    | undefined;
  if (!bal) throw new NotShareable("اول ربات را با /start شروع کن.");
  if (bal.credit_sec < share) throw new InsufficientCredit(bal.credit_sec, share);

  move({
    tgId,
    deltaSec: -share,
    reason: "share_charge",
    sessionId,
    note: `سهم ${count} نفره`,
  });
  db.prepare(
    `INSERT INTO session_members (session_id, tg_id, paid_sec, role) VALUES (?, ?, ?, 'member')`,
  ).run(sessionId, tgId, share);

  const refunds: JoinResult["refunds"] = [];
  for (const m of existing) {
    const back = m.paid_sec - share;
    if (back <= 0) continue;
    move({
      tgId: m.tg_id,
      deltaSec: back,
      reason: "share_refund",
      sessionId,
      note: `سهم به ${count} نفر تقسیم شد`,
    });
    db.prepare(`UPDATE session_members SET paid_sec = ? WHERE session_id = ? AND tg_id = ?`).run(
      share,
      sessionId,
      m.tg_id,
    );
    refunds.push({ tgId: m.tg_id, amountSec: back });
  }

  logger.info({ sessionId, tgId, share, count, refunds: refunds.length }, "session joined");
  return { chargedSec: share, shareSec: share, memberCount: count, refunds };
}

export function setShareEnabled(sessionId: string, enabled: boolean): void {
  db.prepare(`UPDATE sessions SET share_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, sessionId);
}

export interface ShareStatus {
  enabled: boolean;
  memberCount: number;
  costSec: number;
  /** سهم فعلی هر نفر */
  currentShareSec: number;
  /** سهمی که نفر بعدی می‌پردازد */
  nextShareSec: number;
  /** آنچه مالک تا حالا پس گرفته */
  ownerRefundedSec: number;
  ownerPaidSec: number;
}

export function shareStatus(sessionId: string): ShareStatus | null {
  const s = db
    .prepare(`SELECT id, tg_id, original_ms, share_enabled FROM sessions WHERE id = ?`)
    .get(sessionId) as unknown as SessionCost | undefined;
  if (!s) return null;

  const costSec = Math.round(s.original_ms / 1000);
  const list = members(sessionId);
  const owner = list.find((m) => m.role === "owner");
  const count = Math.max(1, list.length);

  return {
    enabled: Boolean(s.share_enabled),
    memberCount: list.length,
    costSec,
    currentShareSec: fairShare(costSec, count),
    nextShareSec: fairShare(costSec, count + 1),
    ownerPaidSec: owner?.paid_sec ?? costSec,
    ownerRefundedSec: Math.max(0, costSec - (owner?.paid_sec ?? costSec)),
  };
}

/** جلساتی که کاربر به آن‌ها دسترسی دارد — چه فرستاده باشد چه پیوسته باشد. */
export function accessibleSessions(tgId: number, limit = 20): string[] {
  return (
    db
      .prepare(
        `SELECT session_id FROM session_members WHERE tg_id = ?
         ORDER BY joined_at DESC LIMIT ?`,
      )
      .all(tgId, limit) as unknown as Array<{ session_id: string }>
  ).map((r) => r.session_id);
}
