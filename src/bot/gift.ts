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
import {
  RATE_LINE, balanceCoins, coinsAsMinutesIfUseful, coinsToSec, costCoins, fmtCoins,
} from "../billing/coins.js";
import { grant } from "../billing/ledger.js";
import { claimGift, createGift, getGift, giftClaimedBy, giftUses, type GiftRow } from "../db/index.js";
import { isBale } from "./identity.js";
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
 * سکهٔ لازم برای یک کلاس کامل — مبنای جمله‌ای که انتظار گیرنده را تنظیم می‌کند.
 *
 * از `costCoins` درمی‌آید نه از عدد ثابت، تا اگر نرخ عوض شد این جمله هم با آن
 * برود. نود دقیقه، همان طولی است که بقیهٔ متن‌ها هم «یک کلاس» می‌نامندش.
 */
const FULL_CLASS_COINS = costCoins(90 * 60);

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

/**
 * نام کاربری ربات، به تفکیک سکو.
 *
 * کلید، خودِ شیء `Api` است نه یک متغیر ساده: تلگرام و بله دو ربات جدا با دو
 * نام کاربری‌اند، و یک متغیرِ مشترک یعنی هر کدام که زودتر صدا زده شود نامش
 * برای دیگری هم به کار می‌رود — لینکی که به چت اشتباه می‌برد.
 */
const usernames = new WeakMap<Api, string>();

/**
 * لینک هدیه روی سکوی همان رباتی که دستور از آن آمده.
 *
 * دامنه هم با سکو عوض می‌شود: `t.me` برای تلگرام و `ble.ir` برای بله. لینکِ
 * `t.me` داخل بله باز نمی‌شود، پس ادمینی که از بله `/gift` می‌زند باید لینکِ
 * بله بگیرد.
 */
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

/**
 * پیامی که گیرنده پس از برداشتِ موفق می‌بیند.
 *
 * «۲۰ سکه» و «۲۰ دقیقه» با نرخ ۱ یک عددند، پس گفتنِ هر دو در یک نفس کاربر را
 * دنبال تفاوتی می‌فرستد که نیست. یک بار معنیِ سکه گفته می‌شود — و معادل
 * دقیقه‌ای فقط وقتی می‌آید که به ساعت رسیده باشد و واقعاً ترجمه لازم باشد.
 *
 * موجودی هم فقط وقتی نشان داده می‌شود که با خودِ هدیه فرق داشته باشد؛ برای
 * کاربر تازه این دو عدد یکی‌اند و تکرارِ یک عدد در دو خط، پیام را شلوغ می‌کند.
 */
export function claimedMessage(coins: number, balanceSec: number): string {
  const asTime = coinsAsMinutesIfUseful(coins);
  const balance = balanceCoins(balanceSec);

  // خطوط خالی بین گروه‌ها می‌آیند نه داخلشان، وگرنه هر سطرِ اختیاریِ حذف‌شده
  // یک خط خالیِ اضافه جا می‌گذارد.
  const groups = [
    [`🎁 <b>${fmtCoins(coins)}</b> به حسابت اضافه شد!`],
    [
      // «۲۰ سکه یعنی ۲۰ دقیقه» عدد را دو بار می‌گوید. جملهٔ نرخ به‌تنهایی همان
      // را می‌رساند، و برای گیرنده‌ای که تازه با واژهٔ «سکه» روبه‌رو شده کافی
      // است. معادل ساعتی فقط وقتی می‌آید که خودش خبر تازه باشد.
      asTime ? `یعنی ${asTime}. <i>${RATE_LINE}.</i>` : `<i>${RATE_LINE}.</i>`,
      ...(balance !== coins ? [`موجودی‌ات: <b>${fmtCoins(balance)}</b>`] : []),
    ],
    // انتظار را همین‌جا تنظیم می‌کند: یک کلاس کامل ۹۰ دقیقه‌ای به اندازهٔ
    // `FULL_CLASS_COINS` سکه می‌خواهد، پس هدیهٔ کوچک برای *کل* یک کلاس کافی
    // نیست. اگر اینجا گفته نشود، گیرنده صوت کلاسش را آپلود می‌کند و تازه
    // آن‌وقت به دیوارِ «سکه‌هات کم میاد» می‌خورد — بدترین لحظهٔ ممکن.
    //
    // مبنا **موجودی** است نه خودِ هدیه: کسی که از قبل سکه داشته، آن‌ها را هم
    // می‌تواند خرج کند و گفتنِ عددِ هدیه به او کمتر از واقعیت نشان می‌دهد.
    ...(balance < FULL_CLASS_COINS
      ? [[
          `<i>یه کلاس کامل ۹۰ دقیقه‌ای ${fmtCoins(FULL_CLASS_COINS)} می‌خواد. با این موجودی ` +
            `می‌تونی یه جلسهٔ کوتاه‌تر رو کامل تحلیل کنی، یا ${toFaDigits(balance)} دقیقه از یه کلاس رو.</i>`,
        ]]
      : []),
    ["صوت کلاستو بفرست تا خلاصه، نکات امتحانی و جزوه‌اش رو برات دربیارم 🎧"],
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
