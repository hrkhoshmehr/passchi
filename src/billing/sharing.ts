/**
 * تقسیم هزینهٔ یک جلسه بین هم‌کلاسی‌ها — به تومان.
 *
 * مسئله: یک جلسه یک بار پردازش می‌شود ولی بیست‌وپنج نفر همان درس را دارند.
 *
 * قاعده (۲۰۲۶-۰۹-۱۴): **هر کس سهمِ برابرش را می‌دهد، و صاحبِ جلسه فقط سهمِ خودش
 * را.** صاحب جلسه می‌گوید لینک را برای چند نفر (با خودش) می‌فرستد؛ سهم =
 * قیمت ÷ همان تعداد (`shareSeat`). هر هم‌کلاسی همان سهم را می‌دهد و همان به
 * صاحب جلسه برمی‌گردد تا جمعش به «قیمت منهای سهمِ خودش» (`shareCap`) برسد؛
 * بعد برای بقیه مجانی است.
 *
 * سه ویژگی که عمدی‌اند:
 *
 * • **صاحب جلسه سود نمی‌کند.** برگشتی هیچ‌وقت از آنچه داده منهای سهمِ خودش
 *   بیشتر نمی‌شود.
 * • **سهم و برگشت یک تراکنش‌اند** (`atomic`)؛ مردنِ پروسه میانِ «از تازه‌وارد کم
 *   شد» و «به صاحب جلسه رسید» نیمه‌کاره نمی‌ماند.
 * • **هدیه بودجهٔ هفتگی دارد.** سهمی که با اعتبارِ هدیه (نه خریداری‌شده) داده
 *   می‌شود به‌اعتبارِ واقعیِ صاحب جلسه تبدیل می‌شود؛ ده حسابِ ساختگی بی این سقف
 *   یعنی ده سهمِ مجانی که هزینه‌اش را ما داده‌ایم. `SHARE_GIFT_TOMAN_PER_WEEK`.
 */

import { db } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { SHARE_TARGET, priceOf, shareCap, shareSeat } from "./money.js";
import { InsufficientCredit, atomic, paidCredit } from "./ledger.js";

export interface Member {
  session_id: string;
  tg_id: number;
  paid_toman: number;
  gift_toman: number;
  role: "owner" | "member";
  joined_at: string;
}

export interface JoinResult {
  /** آنچه از تازه‌وارد کسر شد (۰ یعنی مجانی بود) */
  charged: number;
  free: boolean;
  /** سهمِ هر نفر در این جلسه */
  seat: number;
  /** شمار هم‌کلاسی‌هایی که تا حالا برداشته‌اند (بدون مالک) */
  memberCount: number;
  /** این برداشتن چقدر به مالک برگرداند */
  ownerRefund: number;
  ownerTgId: number;
  /** برگشتیِ مالک دقیقاً با همین برداشتن کامل شد */
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

/** بودجهٔ هفتگیِ سهم‌های هدیه‌ای پر شده؛ تازه‌وارد باید با اعتبارِ خریداری‌شده بیاید. */
export class GiftBudgetExhausted extends Error {
  constructor(readonly seat: number) {
    super("gift budget exhausted");
    this.name = "GiftBudgetExhausted";
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

/** فرستنده به‌عنوان مالک ثبت می‌شود، با آنچه واقعاً برای جلسه داد. */
export function registerOwner(sessionId: string, tgId: number, paidToman: number): void {
  db.prepare(
    `INSERT INTO session_members (session_id, tg_id, paid_toman, role) VALUES (?, ?, ?, 'owner')
     ON CONFLICT(session_id, tg_id) DO UPDATE SET paid_toman = excluded.paid_toman`,
  ).run(sessionId, tgId, Math.max(0, Math.round(paidToman)));
}

/** مالک تعدادِ کلاس (با خودش) را انتخاب می‌کند؛ کف دو نفر اینجا بسته است. */
export function setShareTarget(sessionId: string, people: number): void {
  db.prepare(`UPDATE sessions SET share_target = ? WHERE id = ?`).run(Math.max(2, Math.round(people)), sessionId);
}

export function setShareEnabled(sessionId: string, enabled: boolean): void {
  db.prepare(`UPDATE sessions SET share_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, sessionId);
}

/**
 * قیمتی که سهم‌ها از آن حساب می‌شوند: آنچه مالک بابت جلسه داد.
 *
 * جلسهٔ رایگانِ اول هم مالکی دارد که «داده» — به‌اندازهٔ اعتبارِ رایگان — پس
 * همان ملاک است. جلسه‌های قدیمیِ خرید گروهی فقط سهمِ مالک را دارند.
 */
export function shareBasis(s: { id: string; original_ms: number }): number {
  const g = db
    .prepare(`SELECT owner_paid_sec FROM group_buys WHERE session_id = ? AND status = 'done'`)
    .get(s.id) as unknown as { owner_paid_sec: number | null } | undefined;
  return priceOf(g?.owner_paid_sec ?? Math.round(s.original_ms / 1000));
}

interface SessionCost {
  id: string;
  tg_id: number;
  status: string;
  original_ms: number;
  share_enabled: number;
  share_target: number | null;
}

/** سهم‌های هدیه‌ای این هفته — جلسه‌های پیوستهٔ همهٔ کاربران. */
function giftThisWeek(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(gift_toman), 0) AS total FROM session_members
        WHERE role = 'member' AND joined_at > datetime('now', '-7 days')`,
    )
    .get() as unknown as { total: number };
  return Number(row.total);
}

/**
 * برداشتنِ یک جلسهٔ اشتراکی — سهم از تازه‌وارد، همان به مالک، یک تراکنش.
 */
export function joinSession(sessionId: string, tgId: number): JoinResult {
  const s = db
    .prepare(`SELECT id, tg_id, status, original_ms, share_enabled, share_target FROM sessions WHERE id = ?`)
    .get(sessionId) as unknown as SessionCost | undefined;

  if (!s) throw new NotShareable("این جلسه پیدا نشد.");
  if (s.status !== "done") throw new NotShareable("این جلسه هنوز آماده نیست.");
  if (!s.share_enabled) throw new NotShareable("صاحب این جلسه اشتراک‌گذاری را روشن نکرده است.");
  if (isMember(sessionId, tgId)) throw new AlreadyMember();

  const cost = shareBasis(s);
  const people = s.share_target ?? SHARE_TARGET;
  const seat = shareSeat(cost, people);
  const cap = shareCap(cost, people);

  const out = atomic((m) => {
    const list = members(sessionId);
    const owner = list.find((x) => x.role === "owner");
    const ownerTgId = owner?.tg_id ?? s.tg_id;
    const classmates = list.filter((x) => x.role === "member").length;

    // آنچه تا حالا به مالک برگشته = آنچه هم‌کلاسی‌ها داده‌اند
    const refunded = list.filter((x) => x.role === "member").reduce((a, x) => a + x.paid_toman, 0);
    const remaining = owner ? Math.max(0, cap - refunded) : 0;
    const charge = Math.min(seat, remaining);

    let gift = 0;
    if (charge > 0) {
      const bal = db.prepare(`SELECT credit_toman FROM users WHERE tg_id = ?`).get(tgId) as unknown as
        | { credit_toman: number }
        | undefined;
      if (!bal) throw new NotShareable("اول ربات را با /start شروع کن.");
      if (bal.credit_toman < charge) throw new InsufficientCredit(bal.credit_toman, charge);
      gift = Math.max(0, charge - paidCredit(tgId));
      if (gift > 0 && giftThisWeek() + gift > config.SHARE_GIFT_TOMAN_PER_WEEK) {
        throw new GiftBudgetExhausted(charge);
      }
    }

    db.prepare(
      `INSERT INTO session_members (session_id, tg_id, paid_toman, gift_toman, role) VALUES (?, ?, ?, ?, 'member')`,
    ).run(sessionId, tgId, charge, gift);

    if (charge > 0) {
      m({ tgId, delta: -charge, reason: "share_charge", sessionId, note: "سهمِ هم‌کلاسی" });
      m({ tgId: ownerTgId, delta: charge, reason: "share_refund", sessionId, note: "هم‌کلاسی برداشت" });
    }
    return { charge, ownerTgId, classmates, capJustReached: charge > 0 && remaining - charge <= 0 };
  });

  logger.info(
    { sessionId, tgId, charge: out.charge, members: out.classmates + 1, capJustReached: out.capJustReached },
    "session joined",
  );
  return {
    charged: out.charge,
    free: out.charge === 0,
    seat,
    memberCount: out.classmates + 1,
    ownerRefund: out.charge,
    ownerTgId: out.ownerTgId,
    capJustReached: out.capJustReached,
  };
}

export interface ShareStatus {
  enabled: boolean;
  /** شمار هم‌کلاسی‌هایی که برداشته‌اند — بدون مالک */
  memberCount: number;
  cost: number;
  seat: number;
  /** سقفِ برگشتِ مالک: قیمت منهای سهمِ خودش */
  cap: number;
  /** آنچه مالک تا حالا پس گرفته */
  ownerRefunded: number;
  /** برگشتی کامل شده — برداشتن‌های بعدی مجانی است */
  capReached: boolean;
  target: number;
}

export function shareStatus(sessionId: string): ShareStatus | null {
  const s = db
    .prepare(`SELECT id, tg_id, original_ms, share_enabled, share_target FROM sessions WHERE id = ?`)
    .get(sessionId) as unknown as SessionCost | undefined;
  if (!s) return null;

  const cost = shareBasis(s);
  const target = s.share_target ?? SHARE_TARGET;
  const cap = shareCap(cost, target);
  const list = members(sessionId);
  const refunded = list.filter((m) => m.role === "member").reduce((a, m) => a + m.paid_toman, 0);

  return {
    enabled: Boolean(s.share_enabled),
    memberCount: list.filter((m) => m.role === "member").length,
    cost,
    seat: shareSeat(cost, target),
    cap,
    ownerRefunded: refunded,
    capReached: refunded >= cap,
    target,
  };
}

/** جلساتی که کاربر به آن‌ها دسترسی دارد — چه فرستاده باشد چه پیوسته باشد. */
export function accessibleSessions(tgId: number, limit = 20): string[] {
  return (
    db
      .prepare(`SELECT session_id FROM session_members WHERE tg_id = ? ORDER BY joined_at DESC LIMIT ?`)
      .all(tgId, limit) as unknown as Array<{ session_id: string }>
  ).map((r) => r.session_id);
}
