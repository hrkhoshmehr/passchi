/**
 * خرید گروهی — هزینهٔ یک جلسه، **پیش از پردازش**، برابر میان چند نفر.
 *
 * ## مسئله
 *
 * تقریباً اولین تلاشِ واقعیِ هر دانشجوی تازه به دیوار می‌خورد: یک کلاس نود
 * دقیقه‌ای (۹۰ سکه) می‌فرستد و بیست سکهٔ هدیه دارد. تنها راهِ جلو پرداخت بود،
 * درست در لحظه‌ای که بیشترین انگیزه را دارد. شریک‌شدنِ پس از تحویل
 * (`sharing.ts`) اینجا کمکی نمی‌کند، چون اول باید کل هزینه را خودش بدهد.
 *
 * ## قاعده‌ها (تصمیم‌شده، عوض نشوند)
 *
 * • **سهم برابر.** هر کس پیش از شروع وارد شد، مالک هم، یک سهم می‌دهد:
 *   `ceil(هزینه / تعداد)`. هیچ‌کس سود نمی‌کند.
 * • **تا شروع هیچ چیز قطعی نیست.** هر سهم فقط `reserve` است و کامل
 *   برمی‌گردد. پر که شد کار شروع می‌شود؛ اگر تا ۴۸ ساعت پر نشد، همه برمی‌گردد.
 * • **هر رزرو دقیقاً یک پایان دارد.** در موفقیت تسویه، در شکست یا انقضا
 *   برگشت — و هر کدام در **یک** تراکنش برای همهٔ نفرات (`atomic`).
 *
 * ## چرا تسویه در پایانِ کار است، نه لحظهٔ شروع
 *
 * اگر سهمِ هم‌کلاسی‌ها سرِ شروع قطعی می‌شد و خط لوله بعدش شکست می‌خورد، آن‌ها
 * برای چیزی که هرگز نیامد پول داده بودند؛ و برگرداندنِ سکهٔ «تسویه‌شده» یعنی
 * یک رزرو با دو پایان. پس سرِ شروع فقط **قفل** می‌شود (دیگر نه ورود، نه
 * انقضا) و رزروها مثل کارِ تک‌نفره تا پایان باز می‌مانند: موفقیت همه را
 * تسویه می‌کند، شکست همه را برمی‌گرداند، و ری‌استارتِ وسطِ کار را
 * `danglingReservations` برای تک‌تکِ نفرات می‌گیرد.
 *
 * ## اختلافِ مدت
 *
 * هم‌کلاسی‌ها سهمِ ثابتشان را می‌دهند. مالک باقی را: `مدت واقعی − سهم اعضا`،
 * همان «مالک اختلاف را جذب می‌کند» که امروز هم هست. کف صفر است، پس اگر مدتِ
 * واقعی کمتر درآمد یا گِرد کردنِ سهم‌ها جمع را بالاتر برد، مالک کمتر می‌دهد
 * ولی هیچ‌وقت چیزی **به** او برنمی‌گردد.
 *
 * این ماژول از تلگرام و بله هیچ نمی‌داند؛ پیام‌ها در `bot/group-buy.ts`اند.
 */

import { config } from "../config.js";
import { db, getSession } from "../db/index.js";
import { logger } from "../util/logger.js";
import { GROUP_BUY_HOURS, GROUP_SIZES, coinsToSec, costCoins, groupSeat } from "./coins.js";
import { atomic, transferableSec } from "./ledger.js";

// عددها در `coins.ts` نشسته‌اند تا متن‌ها و پیش‌نمایش بی پایگاه‌داده بخوانندشان.
export { GROUP_BUY_HOURS, GROUP_SIZES, groupSeat };

export type GroupOrigin = "bot" | "web";
export type GroupStatus = "open" | "started" | "done" | "failed" | "expired" | "cancelled";

export interface GroupBuyRow {
  session_id: string;
  owner_id: number;
  seats: number;
  seat_sec: number;
  cost_sec: number;
  origin: GroupOrigin;
  status: GroupStatus;
  owner_paid_sec: number | null;
  created_at: string;
  expires_at: string;
  closed_at: string | null;
}

export interface SeatRow {
  session_id: string;
  tg_id: number;
  role: "owner" | "member";
  reserved_sec: number;
  gift_sec: number;
  joined_at: string;
}

export type RefusalReason =
  | "not_found" | "bad_size" | "exists" | "closed" | "owner" | "already" | "full" | "gift_cap";

/** ردِ یک کارِ گروهی — پیامِ فارسی‌اش در `strings.ts`، کلیدش اینجا. */
export class GroupBuyRefused extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`group buy refused: ${reason}`);
    this.name = "GroupBuyRefused";
  }
}

export function groupBuy(sessionId: string): GroupBuyRow | null {
  return (
    (db.prepare(`SELECT * FROM group_buys WHERE session_id = ?`).get(sessionId) as unknown as
      | GroupBuyRow
      | undefined) ?? null
  );
}

export function groupSeats(sessionId: string): SeatRow[] {
  return db
    .prepare(`SELECT * FROM group_buy_seats WHERE session_id = ? ORDER BY joined_at, rowid`)
    .all(sessionId) as unknown as SeatRow[];
}

export interface GroupProgress {
  sessionId: string;
  ownerId: number;
  seats: number;
  /** چند سهم رزرو شده — «بقیه‌اش رو خودم می‌دم» همه را پر می‌کند */
  filled: number;
  /** چند نفر واقعاً وارد شده‌اند، مالک هم */
  people: number;
  full: boolean;
  seatSec: number;
  seatCoins: number;
  costSec: number;
  origin: GroupOrigin;
  status: GroupStatus;
  expiresAt: string;
}

export function groupProgress(sessionId: string): GroupProgress | null {
  const g = groupBuy(sessionId);
  if (!g) return null;
  const seats = groupSeats(sessionId);
  const reserved = seats.reduce((a, s) => a + s.reserved_sec, 0);
  const filled = Math.min(g.seats, Math.floor(reserved / g.seat_sec));
  return {
    sessionId,
    ownerId: g.owner_id,
    seats: g.seats,
    filled,
    people: seats.length,
    full: reserved >= g.seats * g.seat_sec,
    seatSec: g.seat_sec,
    seatCoins: costCoins(g.seat_sec),
    costSec: g.cost_sec,
    origin: g.origin,
    status: g.status,
    expiresAt: g.expires_at,
  };
}

/** گروهِ باز و هنوز منقضی‌نشده. */
function isLive(g: GroupBuyRow, now: Date): boolean {
  return g.status === "open" && new Date(g.expires_at).getTime() > now.getTime();
}

/** کسی که هنوز می‌تواند وارد این گروه شود — برای پیشنهادِ پس از شارژ. */
export function groupJoinable(sessionId: string, tgId: number, now = new Date()): boolean {
  const g = groupBuy(sessionId);
  if (!g || !isLive(g, now) || g.owner_id === tgId) return false;
  const p = groupProgress(sessionId)!;
  return !p.full && !groupSeats(sessionId).some((s) => s.tg_id === tgId);
}

// ─── بودجهٔ سکهٔ هدیه ────────────────────────────────────────────────────────

/**
 * سهمی که با سکهٔ هدیه داده می‌شود.
 *
 * ملاک `transferableSec` است — «هرچی خریدی و خرج نکردی»، همان دروازه‌ای که
 * فرستادنِ سکه را می‌بندد. اگر آن از سهم کمتر است، دست‌کم بخشی از این سهم
 * هدیه است و کلش هدیه شمرده می‌شود: ساده‌ترین قاعدهٔ گفتنی، و سمتِ محتاط.
 */
function giftFunded(tgId: number, sec: number): boolean {
  return transferableSec(tgId) < sec;
}

/**
 * سکهٔ هدیه‌ای که این هفته در خرید گروهی خرج شده یا در راه خرج‌شدن است.
 *
 * گروه‌های منقضی و شکست‌خورده شمرده نمی‌شوند: سکه‌شان برگشته و هزینه‌ای برای
 * ما نساخته‌اند.
 */
function giftSecThisWeek(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(x.gift_sec), 0) AS total
         FROM group_buy_seats x JOIN group_buys g ON g.session_id = x.session_id
        WHERE g.status IN ('open', 'started', 'done')
          AND x.joined_at > datetime('now', '-7 days')`,
    )
    .get() as unknown as { total: number };
  return row.total;
}

/** سهمِ هدیه‌ای که از بودجهٔ هفته بیرون بزند رد می‌شود؛ سهمِ خریداری‌شده همیشه می‌رود. */
function assertGiftBudget(sec: number): void {
  const cap = coinsToSec(Math.max(0, config.GROUP_BUY_GIFT_COINS_PER_WEEK));
  if (giftSecThisWeek() + sec > cap) throw new GroupBuyRefused("gift_cap");
}

// ─── ساختن، وارد شدن، پرکردن ────────────────────────────────────────────────

/**
 * گروه را باز کن و **سهمِ مالک را همین حالا رزرو کن**.
 *
 * رزروِ مالک و ثبتِ گروه و `awaiting_group` یک تراکنش‌اند: اگر مالک حتی یک
 * سهم نداشته باشد، `InsufficientCredit` بیرون می‌زند و هیچ گروهی نمی‌ماند.
 *
 * گروهِ بستهٔ قبلی روی همان جلسه (منقضی، لغو، شکست) پاک و از نو ساخته
 * می‌شود؛ پولش پیش‌تر کامل برگشته است.
 */
export function createGroupBuy(o: {
  sessionId: string;
  ownerId: number;
  costSec: number;
  people: number;
  origin: GroupOrigin;
  now?: Date;
}): GroupProgress {
  if (!(GROUP_SIZES as readonly number[]).includes(o.people)) throw new GroupBuyRefused("bad_size");
  const now = o.now ?? new Date();
  const { seatSec } = groupSeat(o.costSec, o.people);
  const expires = new Date(now.getTime() + GROUP_BUY_HOURS * 3_600_000).toISOString();

  atomic((m) => {
    const s = getSession(o.sessionId);
    if (!s || s.tg_id !== o.ownerId) throw new GroupBuyRefused("not_found");
    const old = groupBuy(o.sessionId);
    if (old && (old.status === "open" || old.status === "started")) throw new GroupBuyRefused("exists");
    if (old) db.prepare(`DELETE FROM group_buys WHERE session_id = ?`).run(o.sessionId);

    const gift = giftFunded(o.ownerId, seatSec);
    if (gift) assertGiftBudget(seatSec);

    db.prepare(
      `INSERT INTO group_buys (session_id, owner_id, seats, seat_sec, cost_sec, origin, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).run(o.sessionId, o.ownerId, o.people, seatSec, Math.round(o.costSec), o.origin, expires);
    db.prepare(
      `INSERT INTO group_buy_seats (session_id, tg_id, role, reserved_sec, gift_sec) VALUES (?, ?, 'owner', ?, ?)`,
    ).run(o.sessionId, o.ownerId, seatSec, gift ? seatSec : 0);
    m({ tgId: o.ownerId, deltaSec: -seatSec, reason: "reserve", sessionId: o.sessionId, note: "سهم خرید گروهی" });
    db.prepare(`UPDATE sessions SET status = 'awaiting_group', original_ms = ? WHERE id = ?`).run(
      Math.round(o.costSec) * 1000,
      o.sessionId,
    );
    return gift;
  });

  const p = groupProgress(o.sessionId)!;
  logger.info(
    {
      event: "group_buy", action: "created", sessionId: o.sessionId, ownerId: o.ownerId, origin: o.origin,
      seats: p.seats, seatCoins: p.seatCoins, costCoins: costCoins(o.costSec),
      giftFunded: groupSeats(o.sessionId)[0]!.gift_sec > 0,
    },
    "group buy created",
  );
  return p;
}

/**
 * یک هم‌کلاسی وارد می‌شود: سهمش رزرو و خودش عضوِ جلسه می‌شود.
 *
 * هر بررسی **داخل** تراکنش است، چون دو نفر که همزمان روی آخرین جای خالی
 * بزنند هر دو همان عددِ کهنه را می‌بینند؛ بیرون از تراکنش هر دو وارد می‌شدند
 * و گروه یک سهم اضافه می‌گرفت.
 *
 * عضویت در `session_members` همین حالا نوشته می‌شود تا جلسه از همان لحظه در
 * «📚 جلسه‌های من» او باشد؛ اگر گروه پر نشد، همراه سکه‌اش برداشته می‌شود.
 */
export function joinGroupBuy(
  sessionId: string,
  tgId: number,
  now = new Date(),
): { progress: GroupProgress; giftFunded: boolean } {
  const gift = atomic((m) => {
    const g = groupBuy(sessionId);
    if (!g) throw new GroupBuyRefused("not_found");
    if (!isLive(g, now)) throw new GroupBuyRefused("closed");
    if (g.owner_id === tgId) throw new GroupBuyRefused("owner");
    if (groupSeats(sessionId).some((s) => s.tg_id === tgId)) throw new GroupBuyRefused("already");
    if (groupProgress(sessionId)!.full) throw new GroupBuyRefused("full");

    const gift = giftFunded(tgId, g.seat_sec);
    if (gift) assertGiftBudget(g.seat_sec);

    db.prepare(
      `INSERT INTO group_buy_seats (session_id, tg_id, role, reserved_sec, gift_sec) VALUES (?, ?, 'member', ?, ?)`,
    ).run(sessionId, tgId, g.seat_sec, gift ? g.seat_sec : 0);
    m({ tgId, deltaSec: -g.seat_sec, reason: "reserve", sessionId, note: "سهم خرید گروهی" });
    db.prepare(
      `INSERT INTO session_members (session_id, tg_id, paid_sec, role) VALUES (?, ?, ?, 'member')
       ON CONFLICT(session_id, tg_id) DO NOTHING`,
    ).run(sessionId, tgId, g.seat_sec);
    return gift;
  });

  const progress = groupProgress(sessionId)!;
  logger.info(
    {
      event: "group_buy", action: "joined", sessionId, tgId, giftFunded: gift,
      filled: progress.filled, seats: progress.seats, full: progress.full,
    },
    "group buy joined",
  );
  return { progress, giftFunded: gift };
}

/**
 * «بقیه‌اش رو خودم می‌دم» — سهم‌های خالی از مالک رزرو می‌شود.
 *
 * همان قاعدهٔ بودجه: اگر آن مقدار را با سکهٔ هدیه می‌دهد، از سقفِ هفته
 * کم می‌شود. نتیجه همیشه گروهِ پر است؛ شروع با صدازننده.
 */
export function ownerPaysRest(sessionId: string, ownerId: number, now = new Date()): GroupProgress {
  atomic((m) => {
    const g = groupBuy(sessionId);
    if (!g || g.owner_id !== ownerId) throw new GroupBuyRefused("not_found");
    if (!isLive(g, now)) throw new GroupBuyRefused("closed");
    const reserved = groupSeats(sessionId).reduce((a, s) => a + s.reserved_sec, 0);
    const rest = g.seats * g.seat_sec - reserved;
    if (rest <= 0) return;

    const gift = giftFunded(ownerId, rest);
    if (gift) assertGiftBudget(rest);
    db.prepare(
      `UPDATE group_buy_seats SET reserved_sec = reserved_sec + ?, gift_sec = gift_sec + ?
        WHERE session_id = ? AND tg_id = ?`,
    ).run(rest, gift ? rest : 0, sessionId, ownerId);
    m({ tgId: ownerId, deltaSec: -rest, reason: "reserve", sessionId, note: "بقیهٔ سهم‌های خرید گروهی" });
  });
  return groupProgress(sessionId)!;
}

// ─── شروع و پایان ───────────────────────────────────────────────────────────

/**
 * گروهِ پر را **قفل** کن — فقط یک بار.
 *
 * دو نفرِ آخر می‌توانند همزمان برسند و هر دو «پر شد» ببینند؛ این `UPDATE`
 * شرطی تنها دروازه است و فقط یکی `true` می‌گیرد. جلسه به `queued` می‌رود تا
 * از این لحظه هر ری‌استارتی رزروها را آویزان ببیند و برگرداند.
 */
export function lockGroupBuy(sessionId: string): boolean {
  return atomic(() => {
    const p = groupProgress(sessionId);
    if (!p || p.status !== "open" || !p.full) return false;
    const r = db
      .prepare(`UPDATE group_buys SET status = 'started' WHERE session_id = ? AND status = 'open'`)
      .run(sessionId);
    if (Number(r.changes) !== 1) return false;
    db.prepare(`UPDATE sessions SET status = 'queued', error = NULL WHERE id = ?`).run(sessionId);
    logger.info(
      { event: "group_buy", action: "started", sessionId, seats: p.seats, people: p.people, seatCoins: p.seatCoins },
      "group buy started",
    );
    return true;
  });
}

/**
 * کار موفق شد: همه تسویه، و مالک اختلافِ مدت را می‌دهد.
 *
 * هم‌کلاسی‌ها سهمِ ثابتشان را دادند و تفاوتی ندارند، پس برایشان سطری نوشته
 * نمی‌شود (همان رفتارِ `commit` با تفاوتِ صفر). برگرداندنِ سهمِ پرداختیِ
 * مالک، مبنای سقفِ شریک‌شدنِ پس از تحویل است.
 */
export function settleGroupBuy(sessionId: string, actualSec: number): number {
  return atomic((m) => {
    const g = groupBuy(sessionId);
    if (!g || g.status !== "started") throw new Error(`خرید گروهی ${sessionId} در حال اجرا نیست.`);
    const seats = groupSeats(sessionId);
    const members = seats.filter((s) => s.role === "member").reduce((a, s) => a + s.reserved_sec, 0);
    const owner = seats.find((s) => s.role === "owner")!;
    const ownerSec = Math.max(0, Math.round(actualSec) - members);
    const diff = owner.reserved_sec - ownerSec;
    if (diff !== 0) {
      m({
        tgId: g.owner_id,
        deltaSec: diff,
        reason: "commit",
        sessionId,
        note: diff > 0 ? "خرید گروهی: سهم مالک کمتر از رزرو" : "خرید گروهی: مدت واقعی بیشتر از تخمین بود",
        strict: false,
      });
    }
    db.prepare(
      `UPDATE group_buys SET status = 'done', owner_paid_sec = ?, closed_at = datetime('now') WHERE session_id = ?`,
    ).run(ownerSec, sessionId);
    return ownerSec;
  });
}

/** نفراتی که سکه‌شان برگشت، برای خبردادن. */
export interface ClosedGroup {
  sessionId: string;
  ownerId: number;
  origin: GroupOrigin;
  participants: Array<{ tgId: number; role: "owner" | "member"; sec: number }>;
}

/**
 * برگرداندنِ **همهٔ** رزروها و بستنِ گروه — در یک تراکنش.
 *
 * `from` می‌گوید از کدام وضعیت: گروهِ باز (انقضا یا لغو) یا گروهی که کارش
 * شروع شد و شکست خورد. شرط روی وضعیت داخلِ همان تراکنش است، پس دو بار صدا
 * زدن دو بار پول نمی‌دهد.
 *
 * گروهِ باز جلسه‌اش را به جایی برمی‌گرداند که مالک هنوز بتواند تنها بپردازد
 * — ربات: منتظر شارژ، مینی‌اپ: آپلودِ تأییدنشده — و فایل دست نمی‌خورد.
 * عضویت‌های پیش از شروع هم برداشته می‌شوند: پولی نداده‌اند.
 */
function closeWithRefund(
  sessionId: string,
  from: "open" | "started",
  to: "expired" | "cancelled" | "failed",
  note: string,
): ClosedGroup | null {
  return atomic((m) => {
    const g = groupBuy(sessionId);
    if (!g || g.status !== from) return null;
    const seats = groupSeats(sessionId);
    for (const s of seats) {
      if (s.reserved_sec > 0) m({ tgId: s.tg_id, deltaSec: s.reserved_sec, reason: "refund", sessionId, note });
    }
    db.prepare(`UPDATE group_buys SET status = ?, closed_at = datetime('now') WHERE session_id = ?`).run(
      to,
      sessionId,
    );
    db.prepare(`DELETE FROM session_members WHERE session_id = ? AND role = 'member'`).run(sessionId);
    if (from === "open") {
      db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(
        g.origin === "web" ? "queued" : "awaiting_credit",
        sessionId,
      );
    }
    return {
      sessionId,
      ownerId: g.owner_id,
      origin: g.origin,
      participants: seats.map((s) => ({ tgId: s.tg_id, role: s.role, sec: s.reserved_sec })),
    };
  });
}

/** کارِ گروهی شکست خورد: همه برمی‌گردد. جلسه `error` می‌ماند، همان‌جا که خط لوله گذاشته. */
export function refundGroupBuy(sessionId: string, note: string): ClosedGroup | null {
  return closeWithRefund(sessionId, "started", "failed", note);
}

/**
 * گروهی که ری‌استارت وسطِ کارش را برید.
 *
 * سکه‌ها را `recoverInterrupted` نفر به نفر برگردانده؛ اینجا فقط وضعیت
 * درست می‌شود تا سهم‌هایش از بودجهٔ هدیهٔ هفته بیرون بروند.
 */
export function markGroupBuyFailed(sessionId: string): void {
  db.prepare(
    `UPDATE group_buys SET status = 'failed', closed_at = datetime('now') WHERE session_id = ? AND status = 'started'`,
  ).run(sessionId);
}

/** مالک خودش گروه را بست — مثلاً `/forget`. */
export function cancelGroupBuy(sessionId: string): ClosedGroup | null {
  const out = closeWithRefund(sessionId, "open", "cancelled", "خرید گروهی لغو شد");
  if (out) logger.info({ event: "group_buy", action: "cancelled", sessionId }, "group buy cancelled");
  return out;
}

/**
 * گروه‌هایی که مهلتشان گذشته و پر نشده‌اند.
 *
 * از تایمرِ جاروی صوت صدا زده می‌شود، نه یک زمان‌بندِ تازه. هر گروه
 * جداگانه بسته می‌شود تا شکستِ یکی بقیه را نگه ندارد.
 */
export function expireGroupBuys(now = new Date()): ClosedGroup[] {
  const due = db
    .prepare(`SELECT session_id AS id FROM group_buys WHERE status = 'open' AND expires_at <= ?`)
    .all(now.toISOString()) as unknown as Array<{ id: string }>;
  const out: ClosedGroup[] = [];
  for (const { id } of due) {
    const before = groupProgress(id);
    const closed = closeWithRefund(id, "open", "expired", "خرید گروهی در مهلت پر نشد");
    if (!closed) continue;
    out.push(closed);
    logger.info(
      {
        event: "group_buy", action: "expired", sessionId: id, seats: before?.seats,
        filled: before?.filled, people: before?.people,
      },
      "group buy expired",
    );
  }
  return out;
}

/**
 * آنچه مالکِ یک خرید گروهیِ تمام‌شده واقعاً داد — یا `null` اگر گروهی نبود.
 *
 * شریک‌شدنِ پس از تحویل سقفِ برگشتش را از همین می‌گیرد، نه از کل هزینه:
 * مالکی که فقط یک سهم داده نباید از هم‌کلاسی‌های دیرآمده بیش از آن پس بگیرد.
 */
export function groupBuyOwnerPaidSec(sessionId: string): number | null {
  const row = db
    .prepare(`SELECT owner_paid_sec AS paid FROM group_buys WHERE session_id = ? AND status = 'done'`)
    .get(sessionId) as unknown as { paid: number | null } | undefined;
  return row?.paid ?? null;
}
