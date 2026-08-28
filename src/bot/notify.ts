/**
 * پیام‌دادن به کاربر، وقتی فقط شناسهٔ داخلی‌اش را داری.
 *
 * تا پیش از این، `api.sendMessage(user.tg_id, …)` درست کار می‌کرد چون شناسهٔ
 * داخلی و شناسهٔ چتِ تلگرام یک عدد بودند. با آمدن بله و وب دیگر نیستند:
 * شناسهٔ داخلیِ یک کاربر بله عددی از فضای جداست و فرستادن پیام به آن یا
 * شکست می‌خورد یا — بدتر — به چتِ بی‌ربطی می‌رسد.
 *
 * پس مقصد از جدول `identities` درمی‌آید: کاربر روی هر سکویی که هویت دارد،
 * پیام را از ربات همان سکو می‌گیرد. کاربری که فقط از وب آمده هیچ رباتی
 * ندارد و پیامی هم نمی‌گیرد — که درست است، نه یک شکست.
 */

import type { Api } from "grammy";
import { logger } from "../util/logger.js";
import { identitiesOf, type Platform } from "../db/identity.js";

interface Channel {
  api: Api;
  /** شناسهٔ چت روی این سکو */
  chatId: number;
}

let telegramApi: Api | null = null;
let baleApi: Api | null = null;

export function setNotifyApis(telegram: Api | null, bale: Api | null): void {
  telegramApi = telegram;
  baleApi = bale;
}

/**
 * بهترین کانالِ **تحویل نتیجه** برای این کاربر.
 *
 * با `notifyUser` فرق دارد: آن به *همهٔ* سکوها می‌فرستد چون یک خبر کوتاه است
 * و تکرارش بی‌ضرر. تحویل جلسه اما صوت و جزوه و سه پیام است؛ فرستادنش به دو
 * جا یعنی دو برابر آپلود و یک چت شلوغ.
 *
 * تلگرام مقدم است چون فقط آنجا زمان‌های گزارش لینکِ پخش می‌شوند.
 */
export function deliveryChannel(
  userId: number,
): { api: Api; chatId: number; platform: Platform } | null {
  for (const platform of ["telegram", "bale"] as const) {
    const row = identitiesOf(userId).find((i) => i.platform === platform);
    if (!row) continue;
    const api = platform === "telegram" ? telegramApi : baleApi;
    if (!api) continue;
    const chatId = Number(row.platform_user_id);
    if (Number.isFinite(chatId)) return { api, chatId, platform };
  }
  return null;
}

/** همهٔ راه‌هایی که می‌شود به این کاربر پیام داد. */
function channelsFor(userId: number): Channel[] {
  const out: Channel[] = [];
  for (const i of identitiesOf(userId)) {
    const api = i.platform === "telegram" ? telegramApi : i.platform === "bale" ? baleApi : null;
    if (!api) continue;
    const chatId = Number(i.platform_user_id);
    if (Number.isFinite(chatId)) out.push({ api, chatId });
  }
  return out;
}

/**
 * یک پیامِ **زنده** در ربات: فرستاده می‌شود و بعد جای خودش ویرایش می‌شود.
 *
 * برای کاری که از مینی‌اپ شروع شده لازم است. کاربر صفحه را می‌بندد و
 * می‌رود، پس تنها جایی که می‌تواند وضعیت را ببیند همان چتِ ربات است — و
 * چهار پیام پشت‌سرهم برای چهار مرحله، چت را خراب می‌کند.
 *
 * تحویل روی **یک** سکو انجام می‌شود (همان که `deliveryChannel` انتخاب
 * می‌کند)، تا وضعیت جایی برود که نتیجه هم می‌رود.
 *
 * هر شکستی بلعیده می‌شود: ناتوانی در نشان‌دادن وضعیت نباید کار را متوقف کند.
 */
export function liveMessage(userId: number): {
  update: (text: string) => Promise<void>;
  finish: () => Promise<void>;
} {
  const ch = deliveryChannel(userId);
  let messageId: number | null = null;
  let last = "";
  // ویرایش‌ها ترتیب دارند؛ بدون این صف، دو مرحله‌ای که سریع پشت هم بیایند
  // می‌توانند وارونه بنشینند و کاربر مرحلهٔ عقب‌تر را آخر ببیند.
  let chain: Promise<void> = Promise.resolve();

  const run = (fn: () => Promise<void>) => {
    chain = chain.then(fn, fn).catch(() => {});
    return chain;
  };

  return {
    update: (text) =>
      run(async () => {
        if (!ch || text === last) return;
        last = text;
        try {
          if (messageId === null) {
            const m = await ch.api.sendMessage(ch.chatId, text, { parse_mode: "HTML" });
            messageId = m.message_id;
          } else {
            await ch.api.editMessageText(ch.chatId, messageId, text, { parse_mode: "HTML" });
          }
        } catch (e) {
          // «message is not modified» و پیامِ پاک‌شده هر دو بی‌ضررند.
          logger.debug({ userId, err: String(e) }, "live message update failed");
        }
      }),

    /**
     * پیام وضعیت را بردار.
     *
     * نتیجهٔ کامل بلافاصله بعدش می‌آید، و ماندنِ «دارم تحلیل می‌کنم…» بالای
     * آن فقط گیج‌کننده است.
     */
    finish: () =>
      run(async () => {
        if (!ch || messageId === null) return;
        try {
          await ch.api.deleteMessage(ch.chatId, messageId);
        } catch {
          /* پاک‌نشدن پیام وضعیت، مسئلهٔ کاربر نیست */
        }
        messageId = null;
      }),
  };
}

/**
 * پیام را به هر سکویی که کاربر آنجا هست بفرست.
 *
 * `true` یعنی دست‌کم یک جا رسید. شکست‌ها بلعیده می‌شوند — کاربری که ربات را
 * بلاک کرده نباید مسیر ادمین را بشکند — ولی لاگ می‌شوند.
 */
export async function notifyUser(
  userId: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  let delivered = false;
  for (const ch of channelsFor(userId)) {
    try {
      await ch.api.sendMessage(ch.chatId, text, { parse_mode: "HTML", ...extra });
      delivered = true;
    } catch (e) {
      logger.warn({ userId, err: String(e) }, "notify failed on one channel");
    }
  }
  return delivered;
}
