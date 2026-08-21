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

/** حداکثر ۱۲۰ کاراکتر — زیر نام ربات در صفحهٔ پروفایل و در نتایج جست‌وجو */
export const SHORT_DESCRIPTION =
  "صوت کلاس را بفرست: تحلیل جلسه، نکات با ذکر منبع، و جزوهٔ کامل PDF بگیر.";

/** حداکثر ۵۱۲ کاراکتر — در چت خالی، قبل از اینکه کاربر /start بزند */
export const DESCRIPTION = `صوت کلاست را بفرست، در چند دقیقه تحویل بگیر:

📋 تحلیل جلسه — زمان کلاس صرف چه شد، استاد چه اعلام کرد
🎯 نکات با ذکر منبع — هر تکلیف و نکتهٔ امتحانی با عین جملهٔ استاد و زمانش
🧩 پیش‌نیازها — چیزهایی که استاد فرض کرد بلدی و توضیح نداد
📕 جزوهٔ کامل PDF — بازسازی درس، نه خلاصه

هزینه را می‌توانی با هم‌کلاسی‌ها تقسیم کنی: هرچه بیشتر باشید سهم هرکس کمتر می‌شود.

برای شروع /start را بزن.`;

export const COMMANDS = [
  { command: "start", description: "شروع و راهنمای سریع" },
  { command: "course", description: "ثبت درس جدید — دقت را بالا می‌برد" },
  { command: "courses", description: "فهرست درس‌های من" },
  { command: "history", description: "جلسات اخیر و جزوه‌هایشان" },
  { command: "shared", description: "جلسات اشتراکی و سهم من" },
  { command: "credit", description: "اعتبار باقی‌مانده" },
  { command: "privacy", description: "با صوت و داده‌ام چه می‌شود" },
  { command: "forget", description: "حذف داده‌های من" },
  { command: "help", description: "راهنمای کامل" },
  { command: "cancel", description: "لغو کار در حال انجام" },
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
