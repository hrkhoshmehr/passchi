/**
 * پول — تومان، هم برای نمایش هم در دفتر کل.
 *
 * ## چرا تومان و نه «سکه» یا «ثانیهٔ صوت» (۲۰۲۶-۰۹-۱۴)
 *
 * سکه یک واحدِ دوم بود که دانشجو باید در ذهنش به پول برمی‌گرداند؛ و وقتی سهمِ
 * هم‌کلاسی «۱ سکه» می‌شد، هیچ‌کس نمی‌فهمید یعنی چند. تومان را همه می‌شناسند و
 * تقسیمش میان چند نفر خودش گویاست.
 *
 * و دفتر کل هم تومان است، نه ثانیه: اگر اعتبار به ثانیه ذخیره می‌ماند، هر
 * تغییرِ قیمتِ دقیقه بی‌صدا ارزشِ موجودیِ همه را عوض می‌کرد، و قابلیتی که
 * روزی به‌جای دقیقهٔ صوت پول بخواهد جایی در این واحد نداشت.
 *
 * موجودی‌های قدیمی یک بار با همین نرخ تبدیل شدند (`db/index.ts`).
 */

import { toFaDigits } from "../util/time.js";

/** قیمتِ هر دقیقه صوت، به تومان. */
export const TOMAN_PER_MINUTE = 1_500;

/** قیمت‌ها روی مضربِ پانصد تومان گرد می‌شوند تا عددِ گفتنی بمانند. */
export const PRICE_STEP = 500;

/**
 * قیمتِ یک فایل از روی مدتش — **به بالا** گرد، روی `PRICE_STEP`.
 *
 * رزرو، تسویه و نمایش همه از همین تابع می‌گذرند؛ عددی که دانشجو می‌بیند همان
 * است که کم می‌شود.
 */
export function priceOf(sec: number): number {
  if (sec <= 0) return 0;
  return Math.ceil((sec * TOMAN_PER_MINUTE) / 60 / PRICE_STEP) * PRICE_STEP;
}

/** عدد با جداکنندهٔ هزارگانِ فارسی: ۱٬۲۰۰ */
export function faGroup(n: number): string {
  return toFaDigits(Math.round(n).toLocaleString("en-US")).replace(/,/g, "٬");
}

/** «۱۳۵٬۰۰۰ تومان» */
export function fmtToman(toman: number): string {
  return `${faGroup(toman)} تومان`;
}

/** چند دقیقه صوت با این مبلغ درمی‌آید — به پایین. */
export function minutesFor(toman: number): number {
  return Math.floor(Math.max(0, toman) / TOMAN_PER_MINUTE);
}

/** «حدود ۱ ساعت و ۵۰ دقیقه صوت» — برای کنارِ موجودی و پکیج. */
export function fmtMinutesFor(toman: number): string {
  const min = minutesFor(toman);
  if (min < 60) return `حدود ${toFaDigits(min)} دقیقه صوت`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `حدود ${toFaDigits(h)} ساعت و ${toFaDigits(m)} دقیقه صوت` : `حدود ${toFaDigits(h)} ساعت صوت`;
}

/** جملهٔ نرخ — یک‌جا، تا سه صفحه سه جور نگویندش. */
export const RATE_LINE = `هر دقیقه صوت ${fmtToman(TOMAN_PER_MINUTE)}`;

// ─── هزینه و حاشیه ──────────────────────────────────────────────────────────
//
// قیمت‌ها از هزینهٔ واقعی درمی‌آیند. `scripts/pricing.mjs` حاشیهٔ هر پکیج را با
// همین اعداد چاپ می‌کند.

/**
 * هزینهٔ ما برای یک ساعت صوت، به دلار: رونویسی ۰٫۱۰ و دو پاسِ مدل ۰٫۰۴.
 * **بیشترِ هزینه رونویسی است، نه مدل** — پیشینهٔ کامل در تاریخچهٔ گیت همین فایل
 * (`coins.ts` پیش از ۲۰۲۶-۰۹-۱۴).
 */
export const STT_COST_PER_HOUR_USD = 0.1;
export const LLM_COST_PER_HOUR_USD = 0.04;
export const COST_PER_AUDIO_HOUR_USD = STT_COST_PER_HOUR_USD + LLM_COST_PER_HOUR_USD;

/** قیمت مدلی که رقم بالا با آن اندازه‌گیری شد — دلار بر یک میلیون توکن. */
export const MODEL_PRICE_BASELINE = { id: "google/gemini-2.5-flash", in: 0.3, out: 2.5 };

/** نرخ دلار برای قیمت‌گذاری؛ حاشیه را مستقیم می‌خورد. */
export const USD_TOMAN = 232_000;

/** هزینهٔ تمام‌شدهٔ یک دقیقه صوت برای ما، به تومان. */
export const COST_PER_MINUTE_TOMAN = (COST_PER_AUDIO_HOUR_USD / 60) * USD_TOMAN;

/** کارمزد زیبال: ۱٪، کف ۲ هزار، سقف ۲۰ هزار تومان، به‌علاوهٔ ۱۰٪ مالیات. */
export const GATEWAY_FEE_PCT = 0.01;
export const GATEWAY_FEE_MIN_TOMAN = 2_000;
export const GATEWAY_FEE_MAX_TOMAN = 20_000;
export const GATEWAY_FEE_VAT = 0.1;

export function gatewayFeeToman(priceToman: number): number {
  const fee = Math.min(GATEWAY_FEE_MAX_TOMAN, Math.max(GATEWAY_FEE_MIN_TOMAN, priceToman * GATEWAY_FEE_PCT));
  return fee * (1 + GATEWAY_FEE_VAT);
}

/** کف حاشیه پس از کارمزد — یک‌جا، تا اسکریپت‌ها چند عدد جدا نداشته باشند. */
export const MIN_MARGIN = 2;

/**
 * حاشیهٔ یک پکیج: آنچه **پس از کارمزد** به دستمان می‌رسد، بر هزینهٔ دقیقه‌هایی
 * که اعتبارش (با هدیه) می‌خرد.
 */
export function packageMargin(
  p: { price: number; credit: number },
  costPerMinute = COST_PER_MINUTE_TOMAN,
): number {
  return (p.price - gatewayFeeToman(p.price)) / (p.credit / TOMAN_PER_MINUTE) / costPerMinute;
}

// ─── پکیج‌ها ─────────────────────────────────────────────────────────────────

export interface CreditPackage {
  id: string;
  /** آنچه پرداخت می‌شود */
  price: number;
  /** آنچه به حساب می‌آید — قیمت به‌علاوهٔ هدیه */
  credit: number;
  /** «۱۵۰ هزار تومان» */
  title: string;
  /** یک جمله: هدیه و اینکه تقریباً چند دقیقه صوت می‌شود */
  blurb: string;
  featured?: boolean;
}

/**
 * **کمترین شارژ** — و پکیجِ اول درست همین است.
 *
 * سهمِ یک هم‌کلاسی ممکن است ده هزار تومان باشد، ولی پرداختِ ده هزار تومانی از
 * درگاه با کفِ ۲٬۲۰۰ تومانیِ کارمزد بیش از بیست درصدش را می‌سوزاند. پس هر
 * پرداختی — پکیج، «پرداخت همین فایل»، شارژ برای برداشتنِ جزوه — دست‌کم همین
 * است و اضافه‌اش در حساب می‌ماند.
 */
export const MIN_TOPUP_TOMAN = 50_000;

/**
 * سه پکیج (۲۰۲۶-۰۹-۱۴). شناسه‌ها تازه‌اند چون سفارش‌های قدیمی `p0`..`p6` هنوز در
 * جدول‌اند و واریزشان از مبلغِ ذخیره‌شده روی ردیف است، نه از این فهرست.
 *
 * حاشیه پس از کارمزد: ×۲٫۶۵ ، ×۲٫۴۹ ، ×۲٫۳۸ — `test-price-sync` می‌سنجد.
 */
export const PACKAGES: CreditPackage[] = [
  {
    id: "p7",
    price: MIN_TOPUP_TOMAN,
    credit: 50_000,
    title: "۵۰ هزار تومان",
    blurb: `${fmtMinutesFor(50_000)}. برای شروع، یا سهمت از جزوهٔ هم‌کلاسی.`,
  },
  {
    id: "p8",
    price: 150_000,
    credit: 165_000,
    title: "۱۵۰ هزار تومان",
    blurb: `۱۵ هزار تومان هدیه؛ روی هم ۱۶۵ هزار، ${fmtMinutesFor(165_000)}.`,
    featured: true,
  },
  {
    id: "p9",
    price: 400_000,
    credit: 460_000,
    title: "۴۰۰ هزار تومان",
    blurb: `۶۰ هزار تومان هدیه؛ روی هم ۴۶۰ هزار، ${fmtMinutesFor(460_000)}.`,
  },
];

export function findPackage(id: string): CreditPackage | null {
  return PACKAGES.find((p) => p.id === id) ?? null;
}

/**
 * **«پرداخت همین فایل»** — کسریِ همین فایل، گرد به هزار، و دست‌کم `MIN_TOPUP_TOMAN`.
 * همهٔ آنچه پرداخت شده به حساب می‌آید؛ اضافهٔ کف در حساب می‌ماند.
 */
export function fileTopup(shortToman: number): { price: number; credit: number } {
  const price = Math.max(MIN_TOPUP_TOMAN, Math.ceil(Math.max(0, shortToman) / 1_000) * 1_000);
  return { price, credit: price };
}

/** کوچک‌ترین پکیجی که کسری را می‌پوشاند؛ `null` اگر هیچ‌کدام. */
export function coveringPackage(shortToman: number): CreditPackage | null {
  const fits = PACKAGES.filter((p) => p.credit >= shortToman).sort((a, b) => a.price - b.price);
  return fits[0] ?? null;
}

// ─── شریک‌شدن با هم‌کلاسی‌ها ────────────────────────────────────────────────

/**
 * **سهمِ برابر، و کلِ هزینه برمی‌گردد جز سهمِ خودت.**
 *
 * صاحبِ جلسه می‌گوید لینک را برای چند نفر (با خودش) می‌فرستد؛ سهم = قیمت
 * تقسیم بر همان تعداد. هر هم‌کلاسی که با لینک بیاید همان سهم را می‌دهد و همان
 * به صاحبِ جلسه برمی‌گردد، تا جمعِ برگشتی به «قیمت منهای سهمِ خودش» برسد؛ از آن
 * به بعد برای بقیه مجانی است. پس صاحبِ جلسه در بدترین حالت کلِ قیمت را داده و در
 * بهترین حالت فقط سهمِ خودش را — هیچ‌وقت کمتر، یعنی سودی در کار نیست.
 *
 * پیش‌تر سقف نصفِ هزینه بود. برداشته شد چون «تو فقط سهم خودت را می‌دهی» را
 * دانشجو بی حساب‌وکتاب می‌فهمد و «تا نصف» را نه. خطرِ حساب‌های ساختگی که با
 * اعتبارِ هدیه سهم می‌دهند با بودجهٔ هفتگیِ هدیه در `sharing.ts` مهار می‌شود.
 */
export const SHARE_TARGET = 10;

/** کمترین سهم — زیرش «نفری ۵۰۰ تومان» فقط عددی مسخره است. */
export const MIN_SEAT_TOMAN = 5_000;

/** تعدادهایی که دکمه می‌شوند؛ فقط آن‌ها که سهمشان معنی دارد (`shareCountsFor`). */
export const SHARE_COUNTS = [2, 3, 5, 10, 20] as const;

export function shareSeat(costToman: number, people: number): number {
  const n = Math.max(2, Math.round(people));
  const seat = Math.ceil(costToman / n / PRICE_STEP) * PRICE_STEP;
  return Math.min(costToman, Math.max(MIN_SEAT_TOMAN, seat));
}

/** جمعِ آنچه به صاحبِ جلسه برمی‌گردد: همه‌چیز جز سهمِ خودش. */
export function shareCap(costToman: number, people: number): number {
  return Math.max(0, costToman - shareSeat(costToman, people));
}

/**
 * تعدادهایی که برای این قیمت دکمه می‌شوند.
 *
 * «۳۰ نفر · نفری ۱ سکه» روی فایلِ پنج‌دقیقه‌ای همین‌جا جلویش گرفته می‌شود:
 * تعدادی که سهمش به کف می‌خورد یا با تعدادِ کوچک‌تری هم‌سهم است، دکمه نمی‌شود.
 * فایلی که حتی دو نفرش هم کف را نمی‌پوشاند، اصلاً گزینهٔ شریک‌شدن ندارد.
 */
export function shareCountsFor(costToman: number): number[] {
  const out: number[] = [];
  let lastSeat = Infinity;
  for (const n of SHARE_COUNTS) {
    const exact = costToman / n;
    if (exact < MIN_SEAT_TOMAN) break;
    const seat = shareSeat(costToman, n);
    if (seat >= lastSeat) continue;
    out.push(n);
    lastSeat = seat;
  }
  return out;
}
