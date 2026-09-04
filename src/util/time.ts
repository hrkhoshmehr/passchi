const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

export function toFaDigits(s: string | number): string {
  return String(s).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]!);
}

/** ms → "HH:MM:SS" یا "MM:SS" */
export function fmtClock(ms: number, forceHours = false): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 || forceHours ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * همان fmtClock ولی همیشه با ارقام لاتین.
 *
 * تلگرام وقتی پیامی *ریپلای* یک پیام صوتی باشد، الگوهای زمانی داخل متن را
 * به لینک تبدیل می‌کند و لمس‌شان صوت را از همان لحظه پخش می‌کند. این تشخیص
 * فقط با ارقام لاتین کار می‌کند — «۰۰:۳۴:۱۲» لینک نمی‌شود.
 */
export function fmtClockLink(ms: number): string {
  return fmtClock(ms, ms >= 3_600_000);
}

/** ms → «۱ ساعت و ۲۳ دقیقه» */
export function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${toFaDigits(total)} ثانیه`;
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h && m) return `${toFaDigits(h)} ساعت و ${toFaDigits(m)} دقیقه`;
  if (h) return `${toFaDigits(h)} ساعت`;
  return `${toFaDigits(m)} دقیقه`;
}

export function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * مدتی که سکو اعلام کرده، با واحدِ **تشخیص‌داده‌شده** — بدون دانلود فایل.
 *
 * ## باگی که این را لازم کرد
 *
 * یک ویسِ ۴۹ ثانیه‌ای در بله، ۸۲۴ سکه قیمت خورد. **بله مدتِ ویس را به
 * میلی‌ثانیه می‌دهد و تلگرام به ثانیه**؛ آن فایل ۴۹٬۴۴۰ میلی‌ثانیه بود و
 * همان عدد به‌جای ثانیه نشست — هزار برابر. کاربر «اعتبارت کم است» گرفت و
 * کارش همان‌جا ماند.
 *
 * ## چرا واحد را از حجم می‌فهمیم، نه از نام سکو
 *
 * وسوسه‌کننده است که بنویسیم «اگر بله بود تقسیم بر هزار». ولی شاهدی نداریم
 * که بله برای **همهٔ** انواع رسانه یک‌جور رفتار کند، و اگر جایی ثانیه بدهد
 * و ما تقسیم کنیم، هزینه هزار برابر **کم‌تر** حساب می‌شود — خطایی که سمتِ
 * ضررِ ماست و هیچ‌کس هم شکایتی نمی‌کند تا بفهمیم.
 *
 * حجم فایل در همان پیام هست و مرزهای نرخ‌بیت فیزیکی‌اند: هیچ صوت یا ویدیویی
 * زیر چهار کیلوبیت بر ثانیه یا بالای بیست مگابیت بر ثانیه نیست. پس از روی
 * حجم می‌شود گفت کدام تفسیرِ عدد اصلاً ممکن است. این قاعده هم بله را درست
 * می‌خواند و هم اگر روزی تلگرام واحدش را عوض کرد.
 *
 * وقتی هیچ تفسیری جور درنمی‌آید، همان عددِ خام برمی‌گردد و `sure` می‌شود
 * `false` — صدازننده باید بداند که این یک تخمین است و پیش از کسرِ نهایی
 * فایل را `probe` کند.
 */
export function declaredDurationSec(
  declared: number,
  sizeBytes: number,
  maxSec = 240 * 60,
): { sec: number; sure: boolean } {
  if (!Number.isFinite(declared) || declared <= 0) return { sec: 0, sure: false };

  // مرزهای نرخ‌بیت: از اپوسِ خیلی فشرده تا ویدیوی باکیفیت
  const bits = sizeBytes > 0 ? sizeBytes * 8 : 0;
  const plausible = (sec: number): boolean => {
    if (sec < 1 || sec > maxSec) return false;
    if (bits <= 0) return true; // حجم نداریم، فقط سقفِ مدت را می‌سنجیم
    const bitrate = bits / sec;
    return bitrate >= 4_000 && bitrate <= 20_000_000;
  };

  if (plausible(declared)) return { sec: Math.round(declared), sure: true };
  const asMs = declared / 1000;
  if (plausible(asMs)) return { sec: Math.round(asMs), sure: true };
  return { sec: Math.round(declared), sure: false };
}
