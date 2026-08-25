import fs from "node:fs";
import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { bot, cleanupOldAudio } from "./bot/index.js";
import { closeBrowser } from "./pdf/render.js";
import { disconnect as mtprotoDisconnect } from "./bot/mtproto.js";
import { publishProfile } from "./bot/profile.js";
import { APP_NAME } from "./bot/menu.js";
import { archiveStatus } from "./bot/archive.js";

for (const dir of [config.dataDir, config.audioDir, config.workDir, config.outDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const cleanupTimer = setInterval(() => void cleanupOldAudio(), 6 * 60 * 60_000);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  clearInterval(cleanupTimer);
  await bot.stop();
  await mtprotoDisconnect();
  await closeBrowser();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

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
  },
  `${APP_NAME} در حال اجراست`,
);
await bot.start({ drop_pending_updates: true });
