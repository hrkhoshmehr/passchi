import fs from "node:fs";
import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { bot, cleanupOldAudio } from "./bot/index.js";
import { closeBrowser } from "./pdf/render.js";
import { disconnect as mtprotoDisconnect } from "./bot/mtproto.js";
import { publishProfile } from "./bot/profile.js";

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

logger.info({ model: config.ANALYSIS_MODEL, stt: config.SONIOX_MODEL }, "خرخوان در حال اجراست");
await bot.start({ drop_pending_updates: true });
