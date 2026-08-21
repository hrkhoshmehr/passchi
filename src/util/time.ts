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
