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
import { drain } from "./queue.js";
import { recoverInterrupted } from "./jobs/service.js";

for (const dir of [config.dataDir, config.audioDir, config.workDir, config.outDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const cleanupTimer = setInterval(() => void cleanupOldAudio(), 6 * 60 * 60_000);

const web = startWebServer();

/**
 * خاموشیِ باقاعده — **اول کارهای در جریان، بعد خروج.**
 *
 * پیش‌تر مستقیم `process.exit(0)` می‌زد. یک `systemctl restart` وسطِ یک
 * جلسه، پروسه را می‌کشت؛ و چون پروسه **می‌میرد** نه اینکه پرتاب کند، آن
 * `catch` در `startJob` که سکه را برمی‌گرداند هرگز اجرا نمی‌شد. جلسه تا
 * ابد روی `preprocess` می‌ماند و سکه‌ها رزروشده. یک بار روی کاربر واقعی
 * افتاد: ۸۵ سکه رفت و هیچ خروجی‌ای نیامد.
 *
 * ترتیب مهم است: **اول** polling می‌ایستد تا کار تازه‌ای نیاید، بعد منتظر
 * کارهای در جریان می‌مانیم، و آخر منابع بسته می‌شوند — بستنِ مرورگر پیش از
 * پایانِ کاری که دارد PDF می‌سازد، همان کار را می‌شکند.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  clearInterval(cleanupTimer);

  // اول در ورودی را ببند: از این به بعد کار تازه‌ای وارد صف نمی‌شود.
  await bot.stop();
  await baleBot?.stop();

  const { finished, active } = await drain();
  logger.info({ finished, active }, finished ? "کارهای در جریان تمام شدند" : "مهلت خاموشی تمام شد");

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
 * جلسه‌های نیمه‌کاره‌ای که از اجرای قبلی مانده‌اند.
 *
 * `drain()` هنگام خاموشیِ باقاعده جلویشان را می‌گیرد، ولی `SIGKILL` و OOM
 * مهلتی نمی‌دهند. اینجا تنها جایی است که می‌شود بعد از آن حالت‌ها سکه‌ها را
 * برگرداند — و **پیش از** بالاآمدن ربات انجام می‌شود تا کاربری که همان
 * لحظه پیام می‌دهد، موجودیِ درست را ببیند.
 */
const recovered = recoverInterrupted();

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

// جزوه می‌تواند روی مدل دیگری برود؛ اگر لاگ فقط یکی را نشان دهد، همان
// گمراهیِ بالا از در دیگر برمی‌گردد.
const effectiveNotesModel =
  config.NOTES_PROVIDER === "openrouter"
    ? (config.OPENROUTER_NOTES_MODEL || config.OPENROUTER_MODEL).split(",")[0]
    : config.NOTES_MODEL;

logger.info(
  {
    provider: config.ANALYSIS_PROVIDER,
    model: effectiveModel,
    ...(effectiveNotesModel !== effectiveModel ? { notesModel: effectiveNotesModel } : {}),
    stt: config.SONIOX_MODEL,
    // اگر اجرای قبلی وسط کار مرده باشد، اینجا معلوم می‌شود چند جلسه جمع شد
    ...(recovered ? { recovered } : {}),
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
 * تور نجات پروسه.
 *
 * سه سکو (تلگرام، بله، سایت) در **یک** پروسه‌اند، پس هر پرتابِ گرفته‌نشده
 * هر سه را با هم می‌برد. یک بار همین شد: هدر `Host` بدشکل از یک اسکنر،
 * `new URL` را در وب‌سرور پراند و ربات برای همه از کار افتاد.
 *
 * لاگ می‌کنیم و **زنده می‌مانیم**. خطای ناشناخته در یک درخواست، دلیلی برای
 * قطع سرویس همهٔ کاربران نیست. اگر وضعیت واقعاً خراب باشد، systemd با
 * `Restart=always` بالا می‌آورد — ولی آن تصمیم باید از یک شکستِ واقعی
 * بیاید نه از یک درخواست بدشکل.
 */
process.on("uncaughtException", (err) => {
  logger.error({ err: String(err), stack: err?.stack }, "uncaught exception — پروسه زنده ماند");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: String(reason) }, "unhandled rejection — پروسه زنده ماند");
});

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
