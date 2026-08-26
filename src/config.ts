import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? d : v.toLowerCase() === "true"));

const num = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? d : Number(v)))
    .pipe(z.number().finite());

const Schema = z.object({
  BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_API_ROOT: z.string().optional(),
  TELEGRAM_LOCAL_MODE: bool(false),
  // برای مسیر MTProto — از my.telegram.org گرفته می‌شوند
  TELEGRAM_API_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? Number(v) : undefined)),
  TELEGRAM_API_HASH: z.string().optional(),

  SONIOX_API_KEY: z.string().optional().default(""),
  SONIOX_MODEL: z.string().optional().default("stt-async-v5"),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANALYSIS_MODEL: z.string().optional().default("claude-opus-5"),
  NOTES_MODEL: z.string().optional().default("claude-opus-5"),
  ANALYSIS_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().default("high"),

  // مسیر OpenRouter — مسیر تولیدِ فعلی
  OPENROUTER_API_KEY: z.string().optional(),
  /**
   * فهرست جداشده با کاما، به ترتیب امتحان می‌شود.
   *
   * gemini-3.7-flash روی یک کلاس فارسی واقعی سنجیده شد و برنده بود: مرزهای
   * زمانی درست، نکات دقیق با نقل‌قول تأییدشدنی، و فارسیِ روان — با ۰٫۰۱۲
   * دلار برای پنجاه دقیقه. deepseek-v3.2 روایت کلاس را خالی برگرداند و
   * qwen3-235b زمان‌ها را در مقیاس غلط داد، پس qwen فقط جایگزین آخر است.
   */
  OPENROUTER_MODEL: z
    .string()
    .optional()
    .default("google/gemini-3.7-flash,google/gemini-2.5-flash,qwen/qwen3-235b-a22b-2507"),
  // کدام پاس روی کدام ارائه‌دهنده برود
  ANALYSIS_PROVIDER: z.enum(["anthropic", "openrouter"]).optional().default("openrouter"),
  NOTES_PROVIDER: z.enum(["anthropic", "openrouter"]).optional().default("openrouter"),
  OPENROUTER_ANALYSIS_MODEL: z.string().optional(),
  OPENROUTER_NOTES_MODEL: z.string().optional(),

  AUDIO_SAMPLE_RATE: num(16000),
  AUDIO_BITRATE: z.string().optional().default("32k"),
  // off | edges | full — پیش‌فرض «off».
  //
  // هر برشی زمان‌ها را جابه‌جا می‌کند و نگاشت TimeMap لازم می‌شود. اندازه‌گیری
  // نشان داد صرفه‌اش روی کلاس واقعی کسری از یک سنت است، در حالی که ارجاع دقیق
  // به لحظهٔ صوت ستون اصلی محصول است. پس فاصله‌های خالی دست‌نخورده می‌مانند و
  // هر زمانی که به کاربر نشان داده می‌شود دقیقاً روی فایل اصلی می‌افتد.
  SILENCE_TRIM: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return "off" as const;
      const s = v.toLowerCase();
      if (s === "true") return "full" as const;
      if (s === "false") return "off" as const;
      return (["off", "edges", "full"].includes(s) ? s : "edges") as "off" | "edges" | "full";
    }),
  SILENCE_THRESHOLD_DB: num(-35),
  SILENCE_MIN_DURATION: num(2.5),
  SILENCE_PAD_MS: num(250),
  SILENCE_MIN_GAIN_PCT: num(8),

  // کش رونویسی روی هش محتوا — دو فرستادن یک فایل، یک بار هزینه
  STT_CACHE: bool(true),
  MAX_AUDIO_MINUTES: num(240),
  // هدیهٔ شروع، به سکه. عمداً کم است: به‌اندازهٔ یک بار «پیوستن به جلسهٔ
  // اشتراکی» کافی است و به‌اندازهٔ پردازش یک کلاس کامل نیست.
  FREE_TRIAL_COINS: num(100),
  // اولین جلسهٔ هر کاربر رایگان است ولی فقط رونوشت، و فقط تا این مدت.
  FREE_TRANSCRIPT_MINUTES: num(15),
  MAX_CONCURRENT_JOBS: num(2),
  DATA_DIR: z.string().optional().default("./data"),
  KEEP_AUDIO_DAYS: num(7),

  // شارژ کارت‌به‌کارت: اگر شمارهٔ کارت خالی باشد، دکمهٔ شارژ کاربر را به
  // پشتیبانی ارجاع می‌دهد به‌جای اینکه صفحهٔ پرداختِ ناقص نشان دهد.
  CARD_NUMBER: z.string().optional().default(""),
  CARD_HOLDER: z.string().optional().default(""),
  /** بدون @ — دکمهٔ «پشتیبانی» به این آیدی لینک می‌شود */
  SUPPORT_USERNAME: z.string().optional().default(""),

  /**
   * کانال بایگانی ادمین — هر صوتی که کاربر می‌فرستد اینجا هم می‌رود.
   *
   * شناسهٔ عددی کانال یا سوپرگروه، معمولاً منفی و با پیشوند `-100`. ربات باید
   * عضو آن باشد و اجازهٔ ارسال داشته باشد. خالی بگذاری، کل این مسیر خاموش
   * است و هیچ چیزی جایی فرستاده نمی‌شود.
   *
   * ⚠️ این کانال محتوای خصوصی دانشجوها را نگه می‌دارد: صوت کلاس، صدای
   * دانشجوهای دیگر، و تحلیل جلسه. باید **خصوصی** بماند و فقط ادمین‌ها
   * عضوش باشند. متن `/privacy` هم صریح می‌گوید که یک نسخه برای بازبینی
   * نگه داشته می‌شود — اگر این را خاموش کنی، آن جمله هم باید برود.
   */
  ARCHIVE_CHAT_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? Number(v.trim()) : undefined))
    .pipe(z.number().int().optional()),

  /**
   * ربات بله — همان محصول، سکوی دیگر.
   *
   * بله کلونِ Bot API تلگرام است، پس همان کتابخانه و همان دست‌کدها کار
   * می‌کنند و فقط `apiRoot` فرق دارد. خالی بگذاری، مسیر بله کامل خاموش است.
   */
  BALE_BOT_TOKEN: z.string().optional().default(""),
  BALE_API_ROOT: z.string().optional().default("https://tapi.bale.ai"),

  // ─── سرور وب ─────────────────────────────────────────────────────────────
  WEB_ENABLED: bool(true),
  WEB_PORT: num(3000),
  /**
   * آدرس عمومی سایت — برای ساختن لینک مینی‌اپ و دکمه‌های `web_app`.
   *
   * تلگرام و بله هر دو **اجبار** می‌کنند که آدرس مینی‌اپ HTTPS باشد؛ با
   * `http://localhost` دکمه اصلاً ساخته نمی‌شود. برای توسعهٔ محلی یک تونل
   * (مثل cloudflared یا ngrok) لازم است.
   */
  PUBLIC_URL: z.string().optional().default(""),

  // ─── پیامک (ورود با شماره از مرورگر) ─────────────────────────────────────
  /** نام ارائه‌دهنده، فقط برای لاگ. خالی = پیامک خاموش و کد در پاسخ برمی‌گردد. */
  SMS_PROVIDER: z.string().optional().default(""),
  /** آدرس با جاگذاری `{phone}` و `{code}`؛ عوض‌کردن درگاه یعنی عوض‌کردن همین. */
  SMS_ENDPOINT: z.string().optional().default(""),
  SMS_METHOD: z.string().optional().default("GET"),

  LOG_LEVEL: z.string().optional().default("info"),
  ADMIN_IDS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number),
    ),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`).join("\n");
  console.error("پیکربندی نامعتبر است (.env را بررسی کن):\n" + issues);
  process.exit(1);
}

const raw = parsed.data;

export const config = {
  ...raw,
  dataDir: path.resolve(raw.DATA_DIR),
  audioDir: path.resolve(raw.DATA_DIR, "audio"),
  workDir: path.resolve(raw.DATA_DIR, "work"),
  outDir: path.resolve(raw.DATA_DIR, "out"),
  dbPath: path.resolve(raw.DATA_DIR, "kharkhoon.db"),
  /** سقف دانلود Bot API عمومی: ۲۰ مگابایت. با local server عملاً ۲ گیگابایت. */
  telegramDownloadLimitBytes: raw.TELEGRAM_API_ROOT ? 2_000 * 1024 * 1024 : 20 * 1024 * 1024,
};

export type Config = typeof config;

export type SecretName =
  | "BOT_TOKEN"
  | "SONIOX_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "OPENROUTER_API_KEY";

/**
 * کلیدها هنگام *استفاده* بررسی می‌شوند، نه هنگام بارگذاری — تا اسکریپت‌های
 * آفلاین (پیش‌پردازش، رندر PDF، گزارش روی رونوشت کش‌شده) بدون توکن ربات
 * و بدون کلید سرویس‌های پولی اجرا شوند.
 */
export function requireKey(name: SecretName): string {
  const value = config[name];
  if (!value) throw new Error(`${name} در فایل .env تنظیم نشده است.`);
  return value;
}
