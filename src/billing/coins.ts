/**
 * سکه — واحدی که کاربر می‌بیند.
 *
 * دفتر کل عمداً به **ثانیهٔ صوت** می‌ماند: هزینهٔ واقعی ما با مدت می‌آید، و
 * تقسیم هزینهٔ یک جلسه بین هم‌کلاسی‌ها (`billing/sharing`) به دقتِ ثانیه
 * نیاز دارد — اگر واحد ذخیره‌سازی درشت شود، بازپرداخت‌های کوچک گم می‌شوند.
 *
 * پس سکه یک **لایهٔ نمایش** است، نه یک واحد ذخیره‌سازی. تنها جایی که ترجمه
 * انجام می‌شود همین فایل است.
 *
 * دو تبدیل جدا لازم است و جایشان را نباید عوض کرد:
 *
 *   • موجودی → سکه با **گِرد کردن به پایین**
 *   • هزینه  → سکه با **گِرد کردن به بالا**
 *
 * چون فقط با این ترکیب، «موجودی نمایش‌داده‌شده ≥ هزینهٔ نمایش‌داده‌شده» تضمین
 * می‌کند که کسر واقعی هم موفق می‌شود. عکسش یعنی کاربری که ۱۰۰ سکه می‌بیند و
 * برای کاری ۱۰۰ سکه‌ای پیغام «اعتبارت کم میاد» می‌گیرد.
 */

import { toFaDigits } from "../util/time.js";

/** نرخ ثابت. تغییرش قیمت همهٔ پکیج‌ها را هم جابه‌جا می‌کند. */
export const COINS_PER_MINUTE = 7;

const SEC_PER_COIN = 60 / COINS_PER_MINUTE;

/** موجودی (ثانیه) → سکه، گِرد به پایین */
export function balanceCoins(sec: number): number {
  return Math.floor((sec * COINS_PER_MINUTE) / 60);
}

/** هزینه (ثانیه) → سکه، گِرد به بالا */
export function costCoins(sec: number): number {
  return Math.ceil((sec * COINS_PER_MINUTE) / 60);
}

/**
 * سکه → ثانیه، برای واریز پس از شارژ یا هدیه.
 *
 * گِرد به بالا، چون موجودی با گِرد به پایین نمایش داده می‌شود: با گِرد به
 * پایین اینجا، کسی که ۱۰۰ سکه خریده در حسابش «۹۹ سکه» می‌دید.
 */
export function coinsToSec(coins: number): number {
  return Math.ceil(coins * SEC_PER_COIN);
}

/** عدد با جداکنندهٔ هزارگانِ فارسی: ۱٬۲۰۰ */
function faGroup(n: number): string {
  return toFaDigits(n.toLocaleString("en-US")).replace(/,/g, "٬");
}

/** «۶۳۰ سکه» */
export function fmtCoins(coins: number): string {
  return `${faGroup(coins)} سکه`;
}

/** موجودیِ ثانیه‌ای را مستقیم به متن سکه‌ای تبدیل می‌کند. */
export function fmtBalance(sec: number): string {
  return fmtCoins(balanceCoins(sec));
}

export function fmtCost(sec: number): string {
  return fmtCoins(costCoins(sec));
}

/** «۱٬۲۰۰ سکه ≈ ۲ ساعت و ۵۱ دقیقه صوت» — برای صفحهٔ شارژ */
export function coinsAsMinutes(coins: number): string {
  const min = Math.floor(coins / COINS_PER_MINUTE);
  if (min < 60) return `${toFaDigits(min)} دقیقه صوت`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${toFaDigits(h)} ساعت و ${toFaDigits(m)} دقیقه صوت` : `${toFaDigits(h)} ساعت صوت`;
}

export interface CoinPackage {
  id: string;
  coins: number;
  /** قیمت به تومان */
  price: number;
  /** برچسب کوچک روی دکمه، مثلاً «محبوب» */
  tag?: string;
}

// ─── قیمت‌گذاری ─────────────────────────────────────────────────────────────
//
// قیمت‌ها از هزینهٔ واقعی درمی‌آیند، نه از حدس. سه عدد زیر تنها فرض‌های این
// محاسبه‌اند و هرکدام جداگانه قابل به‌روزرسانی است. `scripts/pricing.mjs`
// حاشیهٔ هر پکیج را با همین اعداد چاپ می‌کند — پس از هر تغییری اجرایش کن.

/**
 * هزینهٔ ما برای یک ساعت صوت، به دلار.
 *
 *   رونویسی Soniox stt-async-v5 ......... ۰٫۱۰
 *   پاس ۱ تحلیل (Opus؛ ~۱۸k ورودی، ~۵k خروجی) ... ۰٫۲۲
 *   پاس ۲ جزوه (ورودی از کش، ~۹k خروجی) ......... ۰٫۲۳
 *                                         ─────
 *                                          ۰٫۵۵
 *
 * با `NOTES_MODEL=claude-sonnet-5` رقم سوم حدود نصف می‌شود. مقدار واقعی هر
 * جلسه در ستون `cost_usd` می‌نشیند؛ با `scripts/costs.mjs` کالیبره کن.
 */
export const COST_PER_AUDIO_HOUR_USD = 0.55;

/** نرخ تبدیل برای قیمت‌گذاری. با تغییر محسوس بازار باید به‌روز شود. */
export const USD_TOMAN = 120_000;

/** هزینهٔ تمام‌شدهٔ یک سکه برای ما، به تومان. */
export const COST_PER_COIN_TOMAN =
  (COST_PER_AUDIO_HOUR_USD / 60 / COINS_PER_MINUTE) * USD_TOMAN;

/**
 * پکیج‌های شارژ — تنها جایی که قیمت‌ها نوشته می‌شوند.
 *
 * دو قاعده:
 *
 * • هر پکیج باید حاشیهٔ حداقل ۱٫۵ برابر هزینه داشته باشد. زیر این عدد، یک
 *   جهش نرخ ارز یا یک جلسهٔ پرحرف‌تر از معمول، فروش را زیان‌ده می‌کند.
 * • پکیج بزرگ‌تر باید سکهٔ ارزان‌تری داشته باشد، وگرنه دلیلی برای انتخابش
 *   نیست. تخفیف از پایین به بالا: ۰٪ ، ۱۱٪ ، ۱۵٪.
 *
 * پایه‌ها با یک کلاس واقعی سنجیده شده‌اند: یک جلسهٔ ۹۰ دقیقه‌ای ۶۳۰ سکه است.
 */
export const PACKAGES: CoinPackage[] = [
  { id: "p1", coins: 700, price: 195_000, tag: "یک کلاس" },
  { id: "p2", coins: 2_000, price: 495_000, tag: "محبوب" },
  { id: "p3", coins: 5_000, price: 1_190_000, tag: "یک ترم" },
];

/** چند جلسهٔ ۹۰ دقیقه‌ای با این تعداد سکه در می‌آید. */
export function classesFor(coins: number, minutesPerClass = 90): number {
  return Math.floor(coins / (minutesPerClass * COINS_PER_MINUTE));
}

/**
 * تعداد نفراتی که در پیام‌ها به‌عنوان «تقسیم با هم‌کلاسیا» پیشنهاد می‌شود.
 *
 * ده نفر، چون هم در یک گروه کلاسی واقعی به‌راحتی جمع می‌شود و هم بازگشت
 * حاصلش (۹۰٪) عددی است که آدم را وادار به فرستادن لینک می‌کند.
 */
export const SHARE_TARGET = 10;

/** اگر جلسه‌ای با هزینهٔ costSec بین SHARE_TARGET نفر تقسیم شود، چقدر برمی‌گردد. */
export function shareBack(costSec: number, people = SHARE_TARGET): { share: number; back: number; pct: number } {
  const share = costCoins(Math.ceil(costSec / people));
  const total = costCoins(costSec);
  const back = Math.max(0, total - share);
  return { share, back, pct: total > 0 ? Math.round((back / total) * 100) : 0 };
}

export function findPackage(id: string): CoinPackage | null {
  return PACKAGES.find((p) => p.id === id) ?? null;
}

export function fmtToman(price: number): string {
  return `${faGroup(price)} تومان`;
}
