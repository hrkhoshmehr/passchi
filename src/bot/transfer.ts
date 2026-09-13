/**
 * فرستادن سکه به هم‌کلاسی.
 *
 * ## چرا هست
 *
 * یک نفر صوت کلاس را می‌فرستد و جزوه را در گروه درس می‌گذارد. هفتهٔ بعد
 * سکه‌اش تمام شده و کوچک‌ترین پکیج (آن روز) ۱۱۸ هزار تومان بود — یعنی برای ادامه‌دادنِ
 * یک جلسه باید یک پکیج کامل بخرد. بچه‌های کلاس حاضرند نفری ده سکه بگذارند،
 * ولی راهی برایش نبود و کار همان‌جا می‌ایستاد.
 *
 * این یک **راهِ موقت** است تا صندوق مشترکِ درس ساخته شود؛ عمداً کوچک نگه
 * داشته شده: یک دستور، یک لینک، بدون کیف‌پول و بدون تاریخچهٔ جدا.
 *
 * ## دو جهت، همان تقسیمِ `/gift` و `/grant`
 *
 * `/grant` شناسهٔ داخلی می‌خواهد و فقط برای کسی کار می‌کند که از قبل با ربات
 * حرف زده باشد؛ `/gift` لینک می‌سازد و گیرنده خودش را معرفی می‌کند. اینجا هم
 * همان دو جهت هست، ولی در **یک** دستور، چون کاربر عادی — برخلاف ادمین — دو
 * دستور را از هم تشخیص نمی‌دهد.
 *
 * و جهتِ اصلی **لینک** است، نه شناسه: فرستنده معمولاً شناسهٔ داخلیِ
 * هم‌کلاسی‌اش را ندارد و راهی هم برای پیدا کردنش نیست.
 *
 * ## سکهٔ هدیه فرستاده نمی‌شود
 *
 * دروازهٔ اصلیِ این ماژول در `billing/ledger.ts` است: `transferableSec`. بدون
 * آن، ده حساب قلابی که هرکدام سهمیهٔ رایگانِ ثبت‌نام را گرفته‌اند، ۲۰۰ سکهٔ
 * مجانی را در یک حساب جمع می‌کنند.
 */

import { randomBytes } from "node:crypto";
import type { Api } from "grammy";
import { logger } from "../util/logger.js";
import { balanceCoins, coinsToSec } from "../billing/coins.js";
import { InsufficientCredit, moveBetween, transferableSec } from "../billing/ledger.js";
import {
  createTransfer, getTransfer, getUser, insertTransferClaim, transferClaim,
  type TransferRow,
} from "../db/index.js";
import { isBale } from "./identity.js";

/**
 * حروفِ کد — همان مجموعهٔ `gift.ts`.
 *
 * `0/O` و `1/I/l` نیستند، چون کد گاهی به‌جای کلیک دستی تایپ می‌شود و این
 * جفت‌ها همان‌جایی‌اند که اشتباه می‌شود.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function newCode(len = 8): string {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * نام کاربری ربات، به تفکیک سکو.
 *
 * کلید خودِ شیء `Api` است نه یک متغیر ساده — دقیقاً به همان دلیلی که در
 * `gift.ts` نوشته شده: تلگرام و بله دو ربات جدا با دو نام کاربری‌اند، و یک
 * متغیرِ مشترک یعنی هرکدام زودتر صدا زده شود نامش برای دیگری هم به کار
 * می‌رود.
 */
const usernames = new WeakMap<Api, string>();

/**
 * لینک انتقال روی سکوی همان رباتی که دستور از آن آمده.
 *
 * `t.me` داخل بله باز نمی‌شود، پس دامنه هم با سکو عوض می‌شود. (`share.ts`
 * این را اشتباه دارد و `t.me` را ثابت نوشته؛ از آنجا کپی نکن.)
 */
export async function transferLink(api: Api, code: string): Promise<string> {
  let username = usernames.get(api);
  if (!username) {
    username = (await api.getMe()).username;
    usernames.set(api, username);
  }
  const host = isBale(api) ? "ble.ir" : "t.me";
  return `https://${host}/${username}?start=t_${code}`;
}

export interface NewTransfer {
  transfer: TransferRow;
  link: string;
}

/**
 * ساختِ لینک — بدون کنارگذاشتنِ سکه.
 *
 * سکه در لحظهٔ **برداشتن** کم می‌شود، نه اینجا. توضیحِ چراییِ این انتخاب
 * کنار جدول `coin_transfers` در `db/index.ts` است. نتیجه‌اش برای اینجا: اگر
 * فرستنده به اندازهٔ کافی سکهٔ قابل‌انتقال ندارد، همین حالا جلویش گرفته
 * می‌شود تا لینکی که از اول کار نمی‌کند ساخته نشود.
 */
export async function mintTransfer(
  api: Api,
  opt: { fromId: number; coins: number; note?: string | null },
): Promise<NewTransfer | { error: "insufficient"; availableCoins: number }> {
  const needSec = coinsToSec(opt.coins);
  const freeSec = transferableSec(opt.fromId);
  if (freeSec < needSec) {
    return { error: "insufficient", availableCoins: balanceCoins(freeSec) };
  }

  // برخورد کد عملاً ناممکن است ولی نتیجه‌اش — پرت‌شدن روی کلید تکراری —
  // آنقدر بد است که چند تلاش ارزانش می‌ارزد.
  let row: TransferRow | null = null;
  for (let i = 0; i < 5 && !row; i++) {
    const code = newCode();
    if (getTransfer(code)) continue;
    row = createTransfer({ code, fromId: opt.fromId, coins: opt.coins, note: opt.note ?? null });
  }
  if (!row) throw new Error("ساخت لینک انتقال ناموفق بود.");

  logger.info({ code: row.code, coins: row.coins, from: opt.fromId }, "transfer minted");
  return { transfer: row, link: await transferLink(api, row.code) };
}

export type TransferOutcome =
  | { ok: true; coins: number; fromId: number; balanceSec: number }
  | {
      ok: false;
      reason: "unknown" | "self" | "already" | "insufficient";
      /** فقط برای `insufficient` — چقدر واقعاً قابل انتقال بود */
      availableCoins?: number;
    };

/**
 * برداشتِ لینک توسط گیرنده.
 *
 * همهٔ بررسی‌های پیش از تراکنش فقط برای **پیامِ بهتر**اند؛ درستیِ کار به
 * هیچ‌کدامشان بند نیست. تنها دروازهٔ واقعی، تراکنشِ `moveBetween` است که
 * ثبتِ برداشت و جابه‌جایی سکه را با هم انجام می‌دهد: دو کلیکِ همزمان روی یک
 * لینک، دومی روی کلیدِ تکراری می‌افتد و کل انتقالش برمی‌گردد.
 */
export function claimTransfer(code: string, toId: number): TransferOutcome {
  const t = getTransfer(code);
  if (!t) return { ok: false, reason: "unknown" };
  if (t.from_id === toId) return { ok: false, reason: "self" };
  if (transferClaim(code)) return { ok: false, reason: "already" };

  try {
    const moved = moveBetween({
      fromId: t.from_id,
      toId,
      deltaSec: coinsToSec(t.coins),
      note: `transfer ${code}`,
      // درون همان تراکنش: `false` یعنی کسی زودتر برداشته و انتقال نباید بشود.
      guard: () => insertTransferClaim(code, toId, t.coins),
    });
    if (!moved) return { ok: false, reason: "already" };
    logger.info({ code, from: t.from_id, to: toId, coins: t.coins }, "transfer claimed");
    return { ok: true, coins: t.coins, fromId: t.from_id, balanceSec: moved.toBalance };
  } catch (e) {
    if (e instanceof InsufficientCredit) {
      // فرستنده بین ساختِ لینک و برداشتن، سکه‌هایش را خرج کرده است.
      return { ok: false, reason: "insufficient", availableCoins: balanceCoins(e.balance) };
    }
    throw e;
  }
}

/**
 * فرستادنِ مستقیم به کسی که شناسه‌اش معلوم است — جهتِ دوم، همان که `/grant`
 * می‌رود.
 */
export function sendDirect(
  fromId: number,
  toId: number,
  coins: number,
): TransferOutcome {
  if (fromId === toId) return { ok: false, reason: "self" };
  if (!getUser(toId)) return { ok: false, reason: "unknown" };
  try {
    const moved = moveBetween({ fromId, toId, deltaSec: coinsToSec(coins), note: "transfer direct" });
    // بدون `guard` هرگز `null` برنمی‌گردد، ولی تایپ اجازه‌اش را می‌دهد.
    if (!moved) return { ok: false, reason: "already" };
    logger.info({ from: fromId, to: toId, coins }, "transfer direct");
    return { ok: true, coins, fromId, balanceSec: moved.toBalance };
  } catch (e) {
    if (e instanceof InsufficientCredit) {
      return { ok: false, reason: "insufficient", availableCoins: balanceCoins(e.balance) };
    }
    throw e;
  }
}
