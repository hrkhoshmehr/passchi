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
 *   رونویسی Soniox stt-async-v5 ............... ۰٫۱۰
 *   هر دو پاس مدل (gemini-3.7-flash) .......... ۰٫۰۳
 *                                               ─────
 *                                                ۰٫۱۳
 *
 * رقم دوم **اندازه‌گیری شده** است نه تخمین: یک کلاس واقعی ۵۰ دقیقه‌ای روی
 * همین مدل ۰٫۰۱۲ دلار شد (یعنی ۰٫۰۱۴ بر ساعت) و اینجا با دو برابر حاشیه
 * نوشته شده، چون کلاسِ پرسؤال توکن بیشتری تولید می‌کند.
 *
 * مسیر آنتروپیک با Opus حدود چهار برابر این است (~۰٫۵۵ بر ساعت). اگر
 * `ANALYSIS_PROVIDER` را عوض کردی، این عدد و پکیج‌ها را هم عوض کن.
 * مقدار واقعی هر جلسه در ستون `cost_usd` می‌نشیند؛ `scripts/costs.mjs`
 * میانگین واقعی را از همان درمی‌آورد.
 */
export const STT_COST_PER_HOUR_USD = 0.1;
export const LLM_COST_PER_HOUR_USD = 0.03;
export const COST_PER_AUDIO_HOUR_USD = STT_COST_PER_HOUR_USD + LLM_COST_PER_HOUR_USD;

/**
 * قیمت مدلی که رقم بالا با آن اندازه‌گیری شد — دلار بر یک میلیون توکن.
 *
 * `scripts/price-watch.mjs` قیمت زندهٔ OpenRouter را با همین مقایسه می‌کند و
 * اگر گران شده باشد می‌گوید حاشیه کجا می‌رود. بدون این پایه، گران‌شدن مدل
 * فقط وقتی معلوم می‌شد که صورتحساب آمده باشد.
 */
export const MODEL_PRICE_BASELINE = { id: "google/gemini-3.7-flash", in: 0.375, out: 1.875 };

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
 * • هر پکیج باید حاشیهٔ حداقل **دو برابر** هزینه داشته باشد. حاشیهٔ درصدی
 *   مهم‌تر از مبلغ مطلق است، چون هزینهٔ هر جلسه کوچک است و یک جهش نرخ ارز
 *   یا یک کلاسِ پرحرف، به‌سرعت می‌بلعدش. سرور و پهنای باند و جلسه‌های
 *   شکست‌خورده و سهمیهٔ رایگان هم از همین حاشیه درمی‌آیند.
 * • پکیج بزرگ‌تر باید سکهٔ ارزان‌تری داشته باشد، وگرنه دلیلی برای انتخابش
 *   نیست. تخفیف از پایین به بالا: ۰٪ ، ۱۲٪ ، ۲۱٪.
 *
 * پایه‌ها با یک کلاس واقعی سنجیده شده‌اند: یک جلسهٔ ۹۰ دقیقه‌ای ۶۳۰ سکه است،
 * یعنی با پکیج پایه حدود ۷۹ هزار تومان — و تقسیم‌شده بین ده هم‌کلاسی، حدود
 * هفت هزار تومان برای هر نفر.
 */
export const PACKAGES: CoinPackage[] = [
  { id: "p1", coins: 700, price: 79_000, tag: "یک کلاس" },
  { id: "p2", coins: 2_000, price: 199_000, tag: "محبوب" },
  { id: "p3", coins: 5_000, price: 449_000, tag: "یک ترم" },
];

/** چند جلسهٔ ۹۰ دقیقه‌ای با این تعداد سکه در می‌آید. */
export function classesFor(coins: number, minutesPerClass = 90): number {
  return Math.floor(coins / (minutesPerClass * COINS_PER_MINUTE));
}

/**
 * تعداد نفراتی که در پیام‌ها به‌عنوان «تقسیم با هم‌کلاسیا» پیشنهاد می‌شود.
 *
 * ده نفر، چون در یک گروه کلاسی واقعی به‌راحتی جمع می‌شود.
 */
export const SHARE_TARGET = 10;

/**
 * سقف بازگشت به فرستنده — و چرا صد درصد نیست.
 *
 * بازپرداخت، سکه‌های خریداری‌شده را به فرستنده برمی‌گرداند و او دوباره
 * خرجشان می‌کند. با نرخ بازگشت r، هر خرید در نهایت **۱/(۱−r)** برابر خودش
 * پردازش می‌خرد. با r=۰٫۹ یعنی ده برابر، در حالی که حاشیهٔ ما بین ۲٫۴ تا ۳
 * برابر است — پس نرخ سربه‌سر حوالی ۶۰٪ می‌افتد.
 *
 * بدتر اینکه بازپرداخت از جیب کسانی می‌آید که می‌پیوندند، و اگر حساب تازه
 * باشند سهمشان را با سکهٔ *هدیه* می‌دهند: پولی وارد نشده ولی سکهٔ واقعیِ
 * فرستنده برگشته است. با ۹۰٪ بازگشت، یک خریدِ ۴۴۹ هزار تومانی در شبیه‌سازی
 * ۱٫۶ میلیون تومان هزینه روی دست ما می‌گذاشت.
 *
 * پنجاه درصد فاصلهٔ امنی تا نرخ سربه‌سر دارد و هنوز پیشنهاد قابل‌گفتنی است:
 * «نصف سکه‌هات برمی‌گرده». `scripts/economics.mjs` این را می‌سنجد.
 */
export const REFUND_CAP_PCT = 0.5;

/**
 * اگر جلسه‌ای با هزینهٔ costSec بین `people` نفر تقسیم شود، برای فرستنده چه
 * می‌ماند و چقدر برمی‌گردد — با احتساب سقف بازگشت.
 */
export function shareBack(costSec: number, people = SHARE_TARGET): { share: number; back: number; pct: number } {
  const total = costCoins(costSec);
  const share = costCoins(Math.ceil(costSec / people));
  const floor = Math.ceil(total * (1 - REFUND_CAP_PCT));
  const back = Math.max(0, total - Math.max(share, floor));
  return { share, back, pct: total > 0 ? Math.round((back / total) * 100) : 0 };
}

export function findPackage(id: string): CoinPackage | null {
  return PACKAGES.find((p) => p.id === id) ?? null;
}

export function fmtToman(price: number): string {
  return `${faGroup(price)} تومان`;
}
