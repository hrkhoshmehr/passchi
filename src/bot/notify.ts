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
import { identitiesOf } from "../db/identity.js";

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
