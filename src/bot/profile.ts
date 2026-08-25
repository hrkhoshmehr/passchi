/**
 * هویت ربات در تلگرام: توضیح کوتاه، توضیح بلند، و فهرست دستورها.
 *
 * این‌ها همان چیزی‌اند که کاربر **قبل از زدن /start** می‌بیند، پس تنها فرصت
 * توضیح‌دادن محصول‌اند. تلگرام برای هرکدام سقف کاراکتر دارد و اگر رد شود
 * خطای ۴۰۰ می‌دهد، برای همین طول‌ها اینجا بررسی می‌شوند.
 *
 * هر بار بالا آمدن ربات ست می‌شوند. تلگرام روی این متدها محدودیت نرخ دارد،
 * پس اگر مقدار عوض نشده باشد درخواستی فرستاده نمی‌شود.
 */

import type { Api } from "grammy";
import { logger } from "../util/logger.js";
import { fmtCoins } from "../billing/coins.js";
import { TRIAL_COINS } from "./menu.js";

/** حداکثر ۱۲۰ کاراکتر — زیر نام ربات در صفحهٔ پروفایل و در نتایج جست‌وجو */
export const SHORT_DESCRIPTION =
  "دیگه لازم نیست سر کلاس جزوه بنویسی. صوت کلاسو بفرست، جزوه‌شو بگیر.";

/** حداکثر ۵۱۲ کاراکتر — در چت خالی، قبل از اینکه کاربر /start بزند */
export const DESCRIPTION = `دیگه لازم نیست سر کلاس جزوه بنویسی. صوت کلاسو بفرست، بگیر:

📋 خلاصهٔ کلاس در یک نگاه
📌 حضور و غیاب، کوییز، تکلیف با مهلت
🎯 نکته‌های امتحانی با عین حرف استاد و دقیقه‌ش
🕘 بخش‌بندی کلاس با زمان
📕 جزوهٔ کامل PDF

خرجشو با هم‌کلاسیات تقسیم کن — با ۱۰ نفر، نصف سکه‌هات برمی‌گرده.

اول کار نمونهٔ یه کلاس واقعی رو نشونت می‌دم، و یه صوت هم رایگان برات پیاده می‌کنم. /start بزن.`;

/**
 * فقط دستورهایی که دانشجو واقعاً لازم دارد.
 *
 * کار اصلی هیچ دستوری لازم ندارد — فقط فرستادن صوت — و بقیه هم روی
 * صفحه‌کلید منو هستند. این فهرست برای کسی است که به تایپ‌کردن عادت دارد.
 * /privacy و /forget و /cancel همچنان کار می‌کنند، فقط در منو نیستند.
 */
export const COMMANDS = [
  { command: "start", description: "شروع" },
  { command: "menu", description: "منوی اصلی" },
  { command: "history", description: "جلسه‌های قبلی" },
  { command: "credit", description: "حساب و سکه‌ها" },
  { command: "buy", description: "شارژ حساب" },
  { command: "course", description: "ثبت درس" },
  { command: "help", description: "راهنما" },
] as const;

function check(label: string, text: string, max: number): void {
  if (text.length > max) {
    throw new Error(`${label} ${text.length} کاراکتر است و از سقف ${max} رد شده.`);
  }
}

export async function publishProfile(api: Api): Promise<void> {
  check("توضیح کوتاه", SHORT_DESCRIPTION, 120);
  check("توضیح بلند", DESCRIPTION, 512);

  await api.setMyCommands([...COMMANDS]);

  // تلگرام روی این دو متد محدودیت نرخ دارد؛ فقط وقتی عوض شده‌اند بفرست
  const [short, long] = await Promise.all([
    api.getMyShortDescription().catch(() => null),
    api.getMyDescription().catch(() => null),
  ]);

  if (short?.short_description !== SHORT_DESCRIPTION) {
    await api.setMyShortDescription(SHORT_DESCRIPTION).catch((e: unknown) => {
      logger.warn({ err: String(e) }, "setMyShortDescription failed");
    });
  }
  if (long?.description !== DESCRIPTION) {
    await api.setMyDescription(DESCRIPTION).catch((e: unknown) => {
      logger.warn({ err: String(e) }, "setMyDescription failed");
    });
  }

  logger.info({ commands: COMMANDS.length }, "پروفایل ربات ثبت شد");
}
