/**
 * کد هدیه — راهِ ادمین برای دادن سکه بدون گرفتن پول.
 *
 * `/grant` از قبل هست ولی شناسهٔ عددیِ گیرنده را می‌خواهد، و آن شناسه را
 * فقط کسی دارد که *قبلاً* با ربات حرف زده باشد. یعنی دقیقاً برای کاربر تازه
 * — همان کسی که هدیه بیشترین اثر را رویش دارد — کار نمی‌کند.
 *
 * پس اینجا جهتِ جریان برعکس می‌شود: ادمین یک **لینک** می‌سازد و می‌فرستد،
 * و گیرنده با زدن رویش خودش را معرفی می‌کند. نه شناسه‌ای لازم است، نه
 * گیرنده باید از قبل کاربر باشد.
 *
 * لینک، همان مسیرِ `/start` است با پیشوند `g_` — همان الگویی که لینک دعوت
 * جلسه (`j_`) از آن استفاده می‌کند.
 */

import { randomBytes } from "node:crypto";
import type { Api } from "grammy";
import { logger } from "../util/logger.js";
import { toFaDigits } from "../util/time.js";
import { coinsAsMinutes, coinsToSec, fmtBalance, fmtCoins } from "../billing/coins.js";
import { grant } from "../billing/ledger.js";
import { claimGift, createGift, getGift, giftClaimedBy, giftUses, type GiftRow } from "../db/index.js";
import { getUser } from "../db/index.js";

/**
 * پیش‌فرضِ هدیه: بیست سکه.
 *
 * هر سکه یک دقیقه صوت است، پس بیست سکه یعنی بیست دقیقه — کافی برای اینکه
 * گیرنده یک جلسهٔ کوتاه یا نیمی از یک کلاس را واقعاً ببیند، و کم‌تر از آنکه
 * دادنش به چند نفر گران تمام شود.
 */
export const DEFAULT_GIFT_COINS = 20;

/**
 * حروفِ کد.
 *
 * `0/O` و `1/I/l` عمداً نیستند: کد گاهی به‌جای کلیک روی لینک، دستی تایپ
 * می‌شود و این جفت‌ها همان‌جایی‌اند که اشتباه می‌شود.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function newCode(len = 8): string {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

let botUsername: string | null = null;

export async function giftLink(api: Api, code: string): Promise<string> {
  botUsername ??= (await api.getMe()).username;
  return `https://t.me/${botUsername}?start=g_${code}`;
}

export interface NewGift {
  gift: GiftRow;
  link: string;
}

export async function mintGift(
  api: Api,
  opt: { coins: number; maxUses: number; note?: string | null; createdBy: number; days?: number | null },
): Promise<NewGift> {
  const expiresAt =
    opt.days && opt.days > 0
      ? new Date(Date.now() + opt.days * 86_400_000).toISOString()
      : null;

  // برخورد کد عملاً ناممکن است ولی نتیجه‌اش — پرت‌شدن روی کلید تکراری — آنقدر
  // بد است که چند تلاش ارزانش می‌ارزد.
  let gift: GiftRow | null = null;
  for (let i = 0; i < 5 && !gift; i++) {
    const code = newCode();
    if (getGift(code)) continue;
    gift = createGift({
      code,
      coins: opt.coins,
      maxUses: opt.maxUses,
      note: opt.note ?? null,
      createdBy: opt.createdBy,
      expiresAt,
    });
  }
  if (!gift) throw new Error("ساخت کد هدیه ناموفق بود.");

  logger.info(
    { code: gift.code, coins: gift.coins, maxUses: gift.max_uses, by: opt.createdBy },
    "gift minted",
  );
  return { gift, link: await giftLink(api, gift.code) };
}

export type ClaimOutcome =
  | { ok: true; coins: number; balanceSec: number }
  | { ok: false; reason: "unknown" | "revoked" | "expired" | "already" | "exhausted" };

/**
 * برداشتِ کد توسط گیرنده.
 *
 * ترتیب عمداً «اول ثبتِ برداشت، بعد واریز» است. اگر برعکس بود، شکستِ ثبت پس
 * از واریزِ موفق یعنی سکهٔ داده‌شده بدون سطرِ متناظر — و کدِ یک‌بارمصرفی که
 * باز مانده. این‌طوری بدترین حالت، سطرِ برداشتی است که سکه‌اش نرسیده و در
 * دفتر کل هم اثری ندارد؛ قابلِ دیدن و قابلِ جبران.
 */
export function claim(code: string, tgId: number): ClaimOutcome {
  const g = getGift(code);
  if (!g) return { ok: false, reason: "unknown" };
  if (g.revoked) return { ok: false, reason: "revoked" };
  if (g.expires_at && new Date(g.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (giftClaimedBy(code, tgId)) return { ok: false, reason: "already" };

  if (!claimGift(code, tgId, g.coins)) {
    // تراکنش رد شد: یا سهمیه در همین لحظه پر شد، یا همین کاربر همزمان دو بار زد.
    return { ok: false, reason: giftClaimedBy(code, tgId) ? "already" : "exhausted" };
  }

  const balanceSec = grant(tgId, coinsToSec(g.coins), "grant");
  logger.info({ code, tgId, coins: g.coins }, "gift claimed");
  return { ok: true, coins: g.coins, balanceSec };
}

/** پیامی که گیرنده پس از برداشتِ موفق می‌بیند. */
export function claimedMessage(coins: number, balanceSec: number): string {
  return [
    `🎁 <b>${fmtCoins(coins)}</b> به حسابت اضافه شد!`,
    "",
    `یعنی ${coinsAsMinutes(coins)} — هر سکه یک دقیقه.`,
    `موجودی‌ات: <b>${fmtBalance(balanceSec)}</b>`,
    "",
    "صوت کلاستو بفرست تا خلاصه، نکات امتحانی و جزوه‌اش رو برات دربیارم 🎧",
  ].join("\n");
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

/** خلاصهٔ یک کد برای ادمین: چند بار برداشته شده و چه کسانی. */
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
  return `<code>${g.code}</code> — ${fmtCoins(g.coins)} · ${uses}${state}`;
}

/** نام گیرنده برای گزارشِ برداشت به ادمین. */
export function describeUser(tgId: number): string {
  const u = getUser(tgId);
  const who = [u?.name, u?.username ? `@${u.username}` : null].filter(Boolean).join(" ");
  return who || String(tgId);
}
