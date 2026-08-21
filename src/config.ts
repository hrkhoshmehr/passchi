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

  // مسیر OpenRouter — برای اجرای بدون هزینه با مدل‌های رایگان
  OPENROUTER_API_KEY: z.string().optional(),
  // فهرست جداشده با کاما — به ترتیب امتحان می‌شود. لایهٔ رایگان مدام
  // rate-limit می‌شود و اسلاگ‌ها بدون اطلاع عوض می‌شوند، پس جایگزین لازم است.
  OPENROUTER_MODEL: z.string().optional().default("google/gemma-4-31b-it:free,openai/gpt-oss-20b:free,google/gemma-4-26b-a4b-it:free,z-ai/glm-5.2:free"),
  // کدام پاس روی کدام ارائه‌دهنده برود
  ANALYSIS_PROVIDER: z.enum(["anthropic", "openrouter"]).optional().default("anthropic"),
  NOTES_PROVIDER: z.enum(["anthropic", "openrouter"]).optional().default("anthropic"),
  OPENROUTER_ANALYSIS_MODEL: z.string().optional(),
  OPENROUTER_NOTES_MODEL: z.string().optional(),

  AUDIO_SAMPLE_RATE: num(16000),
  AUDIO_BITRATE: z.string().optional().default("32k"),
  // off | edges | full — «edges» پیش‌فرض است چون تنها حالتی که واقعاً صرفه دارد
  // سکوت ابتدا و انتهای ضبط است؛ «full» کل فایل را اسکن می‌کند و گران است.
  SILENCE_TRIM: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return "edges" as const;
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
  FREE_TRIAL_MINUTES: num(90),
  MAX_CONCURRENT_JOBS: num(2),
  DATA_DIR: z.string().optional().default("./data"),
  KEEP_AUDIO_DAYS: num(7),

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
