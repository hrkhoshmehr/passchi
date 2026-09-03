/**
 * تقسیم هزینهٔ یک جلسه بین هم‌کلاسی‌ها.
 *
 * مسئله: یک جلسه یک بار پردازش می‌شود ولی بیست‌وپنج نفر همان درس را دارند.
 * اگر هرکس جدا بفرستد، بیست‌وپنج بار هزینه می‌دهیم برای یک محتوا. اگر فقط
 * یک نفر بفرستد، همان یک نفر تمام هزینه را می‌دهد و بقیه مفت سوار می‌شوند.
 *
 * قاعده: **سهمِ ثابت، تا سقف، بعدش رایگان.** مالک هنگام روشن‌کردن اشتراک
 * می‌گوید تقریباً چند نفر است و از همان‌جا `seat` معلوم می‌شود — هزینه‌ای
 * که هر هم‌کلاسی هنگام برداشتن می‌دهد، ثابت و از پیش معلوم. همان مبلغ به
 * حساب مالک برمی‌گردد، تا جمعِ بازگشت به نصفِ هزینه (`cap`) برسد. از آن
 * به بعد برداشتن **رایگان** است: نه از تازه‌وارد چیزی کم می‌شود، نه پلتفرم
 * مابه‌التفاوت را برمی‌دارد.
 *
 * روی یک جلسهٔ ۵۲ سکه‌ای (`cap` = ۲۶):
 *
 *   مالک «۱ نفر» می‌گوید  → آن یک نفر ۲۶ می‌دهد و کامل به مالک برمی‌گردد
 *   مالک «۱۰ نفر» می‌گوید → هر نفر ۳ سکه، تا جمعاً ۲۶ به مالک برگردد، بعد رایگان
 *
 * سه ویژگی که عمداً این‌طور انتخاب شده‌اند:
 *
 * • **مالک هیچ‌وقت سود نمی‌کند.** بازگشت تا سقفِ نصفِ چیزی است که خودش داده.
 *   اگر بیشتر بود، محصول تبدیل می‌شد به طرحی که مردم برای درآمد واردش می‌شوند
 *   و انگیزه از «جزوهٔ درسم را می‌خواهم» به «عضو جمع کنم» جابه‌جا می‌شد.
 *
 * • **سقف بازگشت، حلقهٔ بی‌انتها را می‌بندد.** بدون آن، مالک پس می‌گیرد،
 *   جلسهٔ بعد را می‌خرد، دوباره پس می‌گیرد — و اگر تازه‌واردها با سکهٔ هدیه
 *   پرداخت کنند، این چرخه بدون ورود هیچ پولی می‌چرخد. چرایش در
 *   `REFUND_CAP_PCT` و اندازه‌گیری‌اش در `scripts/economics.mjs`.
 *
 * • **پلتفرم دست‌کم نصفِ هزینهٔ جلسه را از مالک نگه می‌دارد،** فارغ از تعداد
 *   اعضا؛ و بعد از سقف، از تازه‌واردها چیزی نمی‌گیرد. مابه‌التفاوتِ حاشیهٔ
 *   پکیجِ خریداری‌شدهٔ مالک همان است که هزینهٔ لایهٔ رایگان را می‌پوشاند.
 */

import { db } from "../db/index.js";
import { logger } from "../util/logger.js";
import { SHARE_TARGET, coinsToSec, costCoins, shareBack } from "./coins.js";
import { InsufficientCredit, move } from "./ledger.js";

export interface Member {
  session_id: string;
  tg_id: number;
  paid_sec: number;
  role: "owner" | "member";
  joined_at: string;
}

export interface JoinResult {
  /** آنچه از تازه‌وارد کسر شد (۰ اگر سقف پر بوده و برداشتن رایگان شده) */
  chargedSec: number;
  /** سقفِ بازگشتِ مالک پر بوده و این برداشتن رایگان انجام شد */
  free: boolean;
  /** سهمِ ثابتِ هر نفر در این جلسه */
  seatSec: number;
  /** شمار هم‌کلاسی‌هایی که تا حالا برداشته‌اند (بدون مالک) */
  memberCount: number;
  /** این برداشتن چقدر به مالک برگرداند */
  ownerRefundSec: number;
  ownerTgId: number;
  /** سقفِ بازگشت دقیقاً با همین برداشتن پر شد */
  capJustReached: boolean;
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

/**
 * فرستنده به‌عنوان مالک ثبت می‌شود، با کل هزینهٔ جلسه به پای خودش.
 *
 * `paid_sec` روی مضربِ دقیقهٔ کامل نشانده می‌شود تا حساب‌وکتابِ بازگشت
 * (که در سکه انجام می‌شود) بی‌گِردکردنِ خطادار سرراست بماند.
 */
export function registerOwner(sessionId: string, tgId: number, costSec: number): void {
  db.prepare(
    `INSERT INTO session_members (session_id, tg_id, paid_sec, role) VALUES (?, ?, ?, 'owner')
     ON CONFLICT(session_id, tg_id) DO UPDATE SET paid_sec = excluded.paid_sec`,
  ).run(sessionId, tgId, coinsToSec(costCoins(costSec)));
}

/** مالک تعداد تقریبیِ کلاس را انتخاب می‌کند؛ سهمِ ثابتِ هر نفر از همین درمی‌آید. */
export function setShareTarget(sessionId: string, people: number): void {
  db.prepare(`UPDATE sessions SET share_target = ? WHERE id = ?`).run(
    Math.max(1, Math.round(people)),
    sessionId,
  );
}

interface SessionCost {
  id: string;
  tg_id: number;
  status: string;
  original_ms: number;
  share_enabled: number;
  share_target: number | null;
}

/**
 * برداشتنِ یک جلسهٔ اشتراکی.
 *
 * سهمِ هر نفر ثابت است (`seat`، از تعدادی که مالک گفته). همان مبلغ از
 * تازه‌وارد کم و به مالک اضافه می‌شود، تا جمعِ بازگشتِ مالک به نصفِ هزینه
 * برسد. از آن به بعد برداشتن رایگان است: نه کسری، نه حرکتی در دفتر کل.
 *
 * همهٔ حرکت‌های اعتبار از دفتر کل رد می‌شوند و بررسی موجودی پیش از هر
 * نوشتنی انجام می‌شود، تا اگر تازه‌وارد اعتبار کافی نداشت هیچ‌چیز نیمه‌کاره
 * نماند.
 */
export function joinSession(sessionId: string, tgId: number): JoinResult {
  const s = db
    .prepare(
      `SELECT id, tg_id, status, original_ms, share_enabled, share_target FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as unknown as SessionCost | undefined;

  if (!s) throw new NotShareable("این جلسه پیدا نشد.");
  if (s.status !== "done") throw new NotShareable("این جلسه هنوز آماده نیست.");
  if (!s.share_enabled) throw new NotShareable("صاحب این جلسه اشتراک‌گذاری را روشن نکرده است.");
  if (isMember(sessionId, tgId)) throw new AlreadyMember();

  const costSec = Math.round(s.original_ms / 1000);
  const totalCoins = costCoins(costSec);
  const { seat: seatCoins, cap: capCoins } = shareBack(costSec, s.share_target ?? SHARE_TARGET);
  const seatSec = coinsToSec(seatCoins);

  const existing = members(sessionId);
  const owner = existing.find((m) => m.role === "owner");
  const ownerTgId = owner?.tg_id ?? s.tg_id;
  const classmates = existing.filter((m) => m.role === "member").length;

  // چقدر از سقفِ بازگشتِ مالک باقی مانده — از روی آنچه هنوز به پایش نوشته شده
  const ownerPaidCoins = owner ? costCoins(owner.paid_sec) : totalCoins;
  const refundedCoins = Math.max(0, totalCoins - ownerPaidCoins);
  const remainingCoins = Math.max(0, capCoins - refundedCoins);

  const chargeCoins = remainingCoins <= 0 ? 0 : Math.min(seatCoins, remainingCoins);
  const chargeSec = coinsToSec(chargeCoins);

  // بررسی موجودی *قبل* از هر نوشتنی — فقط وقتی واقعاً چیزی کسر می‌شود
  if (chargeCoins > 0) {
    const bal = db.prepare(`SELECT credit_sec FROM users WHERE tg_id = ?`).get(tgId) as unknown as
      | { credit_sec: number }
      | undefined;
    if (!bal) throw new NotShareable("اول ربات را با /start شروع کن.");
    if (bal.credit_sec < chargeSec) throw new InsufficientCredit(bal.credit_sec, chargeSec);
  }

  db.prepare(
    `INSERT INTO session_members (session_id, tg_id, paid_sec, role) VALUES (?, ?, ?, 'member')`,
  ).run(sessionId, tgId, chargeSec);

  let ownerRefundSec = 0;
  let capJustReached = false;

  if (chargeCoins > 0) {
    move({ tgId, deltaSec: -chargeSec, reason: "share_charge", sessionId, note: "سهمِ هم‌کلاسی" });
    if (owner) {
      move({
        tgId: ownerTgId,
        deltaSec: chargeSec,
        reason: "share_refund",
        sessionId,
        note: "هم‌کلاسی برداشت",
      });
      db.prepare(
        `UPDATE session_members SET paid_sec = MAX(0, paid_sec - ?) WHERE session_id = ? AND tg_id = ?`,
      ).run(chargeSec, sessionId, ownerTgId);
      ownerRefundSec = chargeSec;
      capJustReached = remainingCoins - chargeCoins <= 0;
    }
  }

  const memberCount = classmates + 1;
  logger.info(
    { sessionId, tgId, chargeCoins, memberCount, free: chargeCoins === 0, capJustReached },
    "session joined",
  );
  return {
    chargedSec: chargeSec,
    free: chargeCoins === 0,
    seatSec,
    memberCount,
    ownerRefundSec,
    ownerTgId,
    capJustReached,
  };
}

export function setShareEnabled(sessionId: string, enabled: boolean): void {
  db.prepare(`UPDATE sessions SET share_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, sessionId);
}

export interface ShareStatus {
  enabled: boolean;
  /** شمار هم‌کلاسی‌هایی که برداشته‌اند — بدون مالک */
  memberCount: number;
  costSec: number;
  /** سهمِ ثابتِ هر نفر */
  seatSec: number;
  /** سقفِ بازگشتِ مالک (نصفِ هزینه) */
  capSec: number;
  /** آنچه مالک تا حالا پس گرفته */
  ownerRefundedSec: number;
  ownerPaidSec: number;
  /** سقف پر شده — برداشتن‌های بعدی رایگان است */
  capReached: boolean;
  /** تعدادی که مالک گفته */
  target: number;
}

export function shareStatus(sessionId: string): ShareStatus | null {
  const s = db
    .prepare(`SELECT id, tg_id, original_ms, share_enabled, share_target FROM sessions WHERE id = ?`)
    .get(sessionId) as unknown as SessionCost | undefined;
  if (!s) return null;

  const costSec = Math.round(s.original_ms / 1000);
  const totalCoins = costCoins(costSec);
  const target = s.share_target ?? SHARE_TARGET;
  const { seat, cap } = shareBack(costSec, target);
  const list = members(sessionId);
  const owner = list.find((m) => m.role === "owner");
  const ownerPaidSec = owner?.paid_sec ?? coinsToSec(totalCoins);
  const refundedCoins = Math.max(0, totalCoins - costCoins(ownerPaidSec));

  return {
    enabled: Boolean(s.share_enabled),
    memberCount: list.filter((m) => m.role === "member").length,
    costSec,
    seatSec: coinsToSec(seat),
    capSec: coinsToSec(cap),
    ownerPaidSec,
    ownerRefundedSec: coinsToSec(refundedCoins),
    capReached: refundedCoins >= cap,
    target,
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
