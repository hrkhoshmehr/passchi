import fs from "node:fs";
import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { bot, baleBot, cleanupOldAudio } from "./bot/index.js";
import { setNotifyApis } from "./bot/notify.js";
import { startWebServer } from "./web/server.js";
import { closeBrowser } from "./pdf/render.js";
import { disconnect as mtprotoDisconnect } from "./bot/mtproto.js";
import { publishProfile } from "./bot/profile.js";
import { resolveBotLinks } from "./bot/links.js";
import { APP_NAME } from "./bot/menu.js";
import { archiveStatus } from "./bot/archive.js";

for (const dir of [config.dataDir, config.audioDir, config.workDir, config.outDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const cleanupTimer = setInterval(() => void cleanupOldAudio(), 6 * 60 * 60_000);

const web = startWebServer();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  clearInterval(cleanupTimer);
  await bot.stop();
  await baleBot?.stop();
  web?.close();
  await mtprotoDisconnect();
  await closeBrowser();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

setNotifyApis(bot.api, baleBot?.api ?? null);

await publishProfile(bot.api);

// آدرس ربات‌ها یک بار پرسیده می‌شود؛ سایت و مینی‌اپ از همین می‌خوانند تا
// دکمهٔ «باز کردن در تلگرام / بله» هرگز به چت اشتباه نبرد.
await resolveBotLinks(bot.api, baleBot?.api ?? null);

void cleanupOldAudio();

/**
 * وضعیت بله را **می‌آزماید**، نه اینکه فقط وجود توکن را گزارش کند.
 *
 * پیش‌تر اینجا `baleBot ? "روشن" : "خاموش"` بود و همین یک بار گران تمام شد:
 * `apiRoot` اشتباه بود، هر درخواستی ۴۰۴ می‌گرفت، ولی چون grammY خطای شبکهٔ
 * polling را بی‌صدا دوباره تلاش می‌کند، نه لاگ خطایی بود و نه نشانه‌ای — و
 * راه‌اندازی با خوش‌بینی «بله: روشن» می‌گفت در حالی که هیچ پیامی نمی‌رسید.
 *
 * یک `getMe` ارزان است و همان چیزی را می‌سنجد که واقعاً مهم است: آیا این
 * پیکربندی به رباتِ زنده می‌رسد یا نه.
 */
async function baleStatus(): Promise<string> {
  if (!baleBot) return "خاموش";
  try {
    const me = await baleBot.api.getMe();
    /**
     * نبودِ `BALE_ADMIN_IDS` هم همین‌جا گفته می‌شود.
     *
     * بدون آن، `/gift` و بقیهٔ دستورهای مدیریتی روی بله بی‌صدا کار نمی‌کنند —
     * دقیقاً همان‌طور که خودِ اتصال بله یک بار بی‌صدا خراب بود و مدت‌ها
     * نادیده ماند.
     */
    const admins = config.BALE_ADMIN_IDS.length
      ? ""
      : " ⚠️ BALE_ADMIN_IDS خالی — دستورهای مدیریتی روی بله کار نمی‌کنند";
    return `روشن (@${me.username})${admins}`;
  } catch (e) {
    return `⚠️ پاسخ نمی‌دهد — ${String(e).slice(0, 80)}`;
  }
}

// مدلی که *واقعاً* اجرا می‌شود لاگ شود، نه مقدار ANALYSIS_MODEL: وقتی
// ارائه‌دهنده OpenRouter است آن مقدار اصلاً خوانده نمی‌شود و لاگ گمراه‌کننده
// می‌شود — همان اشتباهی که یک بار موقع بررسی سرور رخ داد.
const effectiveModel =
  config.ANALYSIS_PROVIDER === "openrouter"
    ? (config.OPENROUTER_ANALYSIS_MODEL || config.OPENROUTER_MODEL).split(",")[0]
    : config.ANALYSIS_MODEL;

logger.info(
  {
    provider: config.ANALYSIS_PROVIDER,
    model: effectiveModel,
    stt: config.SONIOX_MODEL,
    // بایگانی بی‌صدا شکست می‌خورد، پس دست‌کم موقع بالاآمدن معلوم باشد روشن است یا نه
    archive: archiveStatus(),
    bale: await baleStatus(),
    web: config.WEB_ENABLED ? `پورت ${config.WEB_PORT}` : "خاموش",
    // بدون سرویس پیامک، ورود با شماره **بسته** است نه ناامن: پیش‌تر کد تأیید
    // در پاسخ HTTP برمی‌گشت و هرکسی با دانستن یک شماره وارد حساب صاحبش می‌شد.
    // حالا هویت فقط از شناسهٔ سکو می‌آید و این خط می‌گوید کدام حالت برقرار است.
    sms: config.SMS_ENDPOINT
      ? config.SMS_PROVIDER || "روشن"
      : "خاموش — ورود با شماره بسته است، هویت از شناسهٔ سکو",
  },
  `${APP_NAME} در حال اجراست`,
);

/**
 * هر دو ربات با هم بالا می‌آیند.
 *
 * `bot.start()` تا وقتی ربات در حال کار است برنمی‌گردد، پس بلهٔ را نمی‌شود
 * پشت سرش `await` کرد — وگرنه هرگز شروع نمی‌شود.
 */
void baleBot?.start({ drop_pending_updates: true }).catch((e: unknown) => {
  logger.error({ err: String(e) }, "bale bot failed to start");
});
await bot.start({ drop_pending_updates: true });
