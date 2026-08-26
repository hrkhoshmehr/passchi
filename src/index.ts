import fs from "node:fs";
import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { bot, baleBot, cleanupOldAudio } from "./bot/index.js";
import { setNotifyApis } from "./bot/notify.js";
import { startWebServer } from "./web/server.js";
import { closeBrowser } from "./pdf/render.js";
import { disconnect as mtprotoDisconnect } from "./bot/mtproto.js";
import { publishProfile } from "./bot/profile.js";
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

void cleanupOldAudio();

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
    bale: baleBot ? "روشن" : "خاموش",
    web: config.WEB_ENABLED ? `پورت ${config.WEB_PORT}` : "خاموش",
    // ورودِ وب بدون سرویس پیامک یعنی کد تأیید در پاسخ برمی‌گردد — در تولید
    // فاجعه است، پس نباید بی‌صدا بماند.
    sms: config.SMS_ENDPOINT ? config.SMS_PROVIDER || "روشن" : "⚠️ تنظیم‌نشده (کد در پاسخ برمی‌گردد)",
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
