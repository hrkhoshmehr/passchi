/**
 * کد هدیه — راهِ ادمین برای دادنِ اعتبار بدون گرفتن پول، به **تومان**.
 *
 * `/grant` از قبل هست ولی شناسهٔ عددیِ گیرنده را می‌خواهد، و آن شناسه را
 * فقط کسی دارد که *قبلاً* با ربات حرف زده باشد. پس اینجا جهتِ جریان برعکس
 * است: ادمین یک **لینک** می‌سازد و گیرنده با زدن رویش خودش را معرفی می‌کند.
 *
 * لینک، همان مسیرِ `/start` است با پیشوند `g_` — همان الگوی لینک دعوت (`j_`).
 */

import { randomBytes } from "node:crypto";
import type { Api } from "grammy";
import { logger } from "../util/logger.js";
import { toFaDigits } from "../util/time.js";
import { RATE_LINE, TOMAN_PER_MINUTE, fmtMinutesFor, fmtToman, priceOf } from "../billing/money.js";
import { grant } from "../billing/ledger.js";
import { claimGift, createGift, getGift, giftClaimedBy, giftUses, type GiftRow } from "../db/index.js";
import { isBale } from "./identity.js";
import { getUser } from "../db/index.js";

/** پیش‌فرضِ هدیه: بیست هزار تومان — همان هدیهٔ شروع. */
export const DEFAULT_GIFT_TOMAN = 20_000;

/** قیمتِ یک کلاس کامل ۹۰ دقیقه‌ای — از `priceOf`، تا با نرخ برود. */
const FULL_CLASS_TOMAN = priceOf(90 * 60);

/** حروفِ کد، بی `0/O` و `1/I/l` که دستی اشتباه تایپ می‌شوند. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function newCode(len = 8): string {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** نام کاربری ربات، به تفکیکِ شیء `Api` — تلگرام و بله دو ربات‌اند. */
const usernames = new WeakMap<Api, string>();

/** لینک هدیه روی سکوی همان رباتی که دستور از آن آمده (`t.me` یا `ble.ir`). */
export async function giftLink(api: Api, code: string): Promise<string> {
  let username = usernames.get(api);
  if (!username) {
    username = (await api.getMe()).username;
    usernames.set(api, username);
  }
  const host = isBale(api) ? "ble.ir" : "t.me";
  return `https://${host}/${username}?start=g_${code}`;
}

export interface NewGift {
  gift: GiftRow;
  link: string;
}

export async function mintGift(
  api: Api,
  opt: { toman: number; maxUses: number; note?: string | null; createdBy: number; days?: number | null },
): Promise<NewGift> {
  const expiresAt =
    opt.days && opt.days > 0 ? new Date(Date.now() + opt.days * 86_400_000).toISOString() : null;

  // برخورد کد عملاً ناممکن است ولی پرت‌شدن روی کلید تکراری آن‌قدر بد است که چند تلاش بارزد.
  let gift: GiftRow | null = null;
  for (let i = 0; i < 5 && !gift; i++) {
    const code = newCode();
    if (getGift(code)) continue;
    gift = createGift({
      code,
      toman: opt.toman,
      maxUses: opt.maxUses,
      note: opt.note ?? null,
      createdBy: opt.createdBy,
      expiresAt,
    });
  }
  if (!gift) throw new Error("ساخت کد هدیه ناموفق بود.");

  logger.info({ code: gift.code, toman: gift.toman, maxUses: gift.max_uses, by: opt.createdBy }, "gift minted");
  return { gift, link: await giftLink(api, gift.code) };
}

export type ClaimOutcome =
  | { ok: true; toman: number; balance: number }
  | { ok: false; reason: "unknown" | "revoked" | "expired" | "already" | "exhausted" };

/**
 * برداشتِ کد توسط گیرنده — «اول ثبتِ برداشت، بعد واریز»، تا بدترین حالت
 * سطرِ برداشتی باشد که پولش نرسیده و قابلِ دیدن و جبران است.
 */
export function claim(code: string, tgId: number): ClaimOutcome {
  const g = getGift(code);
  if (!g) return { ok: false, reason: "unknown" };
  if (g.revoked) return { ok: false, reason: "revoked" };
  if (g.expires_at && new Date(g.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (giftClaimedBy(code, tgId)) return { ok: false, reason: "already" };

  if (!claimGift(code, tgId, g.toman)) {
    return { ok: false, reason: giftClaimedBy(code, tgId) ? "already" : "exhausted" };
  }

  const balance = grant(tgId, g.toman, "grant");
  logger.info({ code, tgId, toman: g.toman }, "gift claimed");
  return { ok: true, toman: g.toman, balance };
}

/**
 * پیامی که گیرنده پس از برداشتِ موفق می‌بیند.
 *
 * انتظار را همین‌جا تنظیم می‌کند: اگر موجودی به یک کلاس کامل نمی‌رسد، گفته
 * می‌شود با آن چه می‌شود کرد (صوتِ کوتاه یا سهمِ جزوهٔ هم‌کلاسی)، وگرنه گیرنده
 * صوت کلاسش را می‌فرستد و تازه آن‌وقت به «موجودیت کافی نیست» می‌خورد.
 */
export function claimedMessage(toman: number, balance: number): string {
  const groups = [
    [`🎁 <b>${fmtToman(toman)}</b> به حسابت اضافه شد!`],
    [
      `<i>${fmtMinutesFor(toman)} · ${RATE_LINE}.</i>`,
      ...(balance !== toman ? [`موجودیت: <b>${fmtToman(balance)}</b>`] : []),
    ],
    ...(balance < FULL_CLASS_TOMAN
      ? [[
          `با ${fmtToman(balance)} می‌تونی صوتی تا ${toFaDigits(Math.floor(balance / TOMAN_PER_MINUTE))} دقیقه بفرستی. ` +
            `یه کلاس کامل ۹۰ دقیقه‌ای ${fmtToman(FULL_CLASS_TOMAN)} میشه.`,
          "با همین موجودی سهمِ جزوه‌ای رو هم که هم‌کلاسیت شریک شده می‌تونی بدی.",
        ]]
      : []),
    ["اول نمونهٔ یه کلاس واقعی رو ببین، یا همین حالا صوت کلاستو بفرست 👇"],
  ];
  return groups.map((x) => x.join("\n")).join("\n\n");
}

const REFUSALS: Record<Exclude<ClaimOutcome, { ok: true }>["reason"], string> = {
  unknown: "این کد هدیه معتبر نیست.",
  revoked: "این کد هدیه باطل شده.",
  expired: "مهلت این کد هدیه تمام شده.",
  already: "این هدیه را قبلاً برداشته‌ای 🙂",
  exhausted: "ظرفیت این کد هدیه پر شده.",
};

export function refusalMessage(reason: Exclude<ClaimOutcome, { ok: true }>["reason"]): string {
  return REFUSALS[reason];
}

/** خلاصهٔ یک کد برای ادمین: چند بار برداشته شده. */
export function giftSummary(g: GiftRow): string {
  const used = giftUses(g.code);
  const state = g.revoked
    ? " · <b>باطل</b>"
    : g.expires_at && new Date(g.expires_at).getTime() < Date.now()
      ? " · <b>منقضی</b>"
      : used >= g.max_uses
        ? " · <b>تمام</b>"
        : "";
  const uses = g.max_uses === 1 ? "یک‌بارمصرف" : `${toFaDigits(used)} از ${toFaDigits(g.max_uses)}`;
  return `<code>${g.code}</code> — ${fmtToman(g.toman)} · ${uses}${state}`;
}

/** نام گیرنده برای گزارشِ برداشت به ادمین. */
export function describeUser(tgId: number): string {
  const u = getUser(tgId);
  const who = [u?.name, u?.username ? `@${u.username}` : null].filter(Boolean).join(" ");
  return who || String(tgId);
}
