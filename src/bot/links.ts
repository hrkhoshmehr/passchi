/**
 * آدرس ربات‌ها روی هر سکو — یک بار از خودِ سکو پرسیده می‌شود.
 *
 * سایت و مینی‌اپ باید بتوانند بگویند «در تلگرام باز کن»، ولی نام کاربری نه
 * در HTML سفت‌شود و نه به یک متغیر محیطی تازه گره بخورد: هر دو با عوض‌شدن
 * توکن ربات بی‌صدا کهنه می‌شوند و کاربر را به چت اشتباه می‌برند.
 *
 * پس منبع حقیقت خودِ `getMe` است. یک بار در راه‌اندازی پر می‌شود و بعد از
 * حافظه خوانده می‌شود. اگر پر نشده باشد `null` می‌ماند و صداکننده باید همان
 * را به‌عنوان «نداریم» بپذیرد، نه اینکه حدس بزند.
 */

import type { Api } from "grammy";
import { logger } from "../util/logger.js";

export interface BotLinks {
  telegram: string | null;
  bale: string | null;
}

const links: BotLinks = { telegram: null, bale: null };

/** در راه‌اندازی صدا زده می‌شود؛ شکستش کشنده نیست. */
export async function resolveBotLinks(telegram: Api | null, bale: Api | null): Promise<void> {
  const [tg, bl] = await Promise.all([
    telegram?.getMe().catch(() => null) ?? null,
    bale?.getMe().catch(() => null) ?? null,
  ]);
  if (tg?.username) links.telegram = `https://t.me/${tg.username}`;
  if (bl?.username) links.bale = `https://ble.ir/${bl.username}`;
  logger.debug({ links }, "bot links resolved");
}

export function botLinks(): BotLinks {
  return { ...links };
}
