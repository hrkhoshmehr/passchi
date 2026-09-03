import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Api } from "grammy";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { isBale } from "./identity.js";
import { downloadMedia, mtprotoAvailable } from "./mtproto.js";

/** سقف دانلود Bot API ابری تلگرام. `getFile` برای فایل بزرگ‌تر از این اصلاً خطا می‌دهد. */
const CLOUD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * سقف بله، اندازه‌گیری‌شده نه حدس‌زده.
 *
 * `scripts/probe-bale-limits.mjs` با آپلود پلکانی پیدایش کرد: ۵۰ مگابایت
 * می‌رود، ۵۵ مگابایت **۴۱۳** می‌گیرد — و پاسخ HTML خودِ nginx بله است، نه JSON
 * ربات. پس این سقف زیرساخت آن‌هاست و با توکن یا تنظیمات ما عوض نمی‌شود.
 *
 * برخلاف تلگرام، بله برای دانلود سقف جدا ندارد: هرچه بالا رفته پایین می‌آید.
 */
const BALE_LIMIT_BYTES = 50 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    /** سقفی که این فایل از آن رد شده — برای اینکه پیام بتواند عدد بدهد. */
    readonly limitBytes: number,
  ) {
    super("فایل بزرگ‌تر از سقف دانلود این سکو است.");
  }
}

export type DownloadRoute = "bot-api" | "bot-api-local" | "bale" | "mtproto";

export interface DownloadResult {
  filePath: string;
  sizeBytes: number;
  route: DownloadRoute;
}

export interface DownloadRequest {
  fileId: string;
  /** برای مسیر MTProto لازم است — پیام با شناسه گرفته می‌شود، نه با file_id */
  chatId: number;
  messageId: number;
  /** اندازهٔ اعلام‌شده در آپدیت؛ برای انتخاب مسیر پیش از هر درخواستی */
  declaredSize: number;
  destDir: string;
  baseName: string;
  onProgress?: (done: number, total: number) => void;
}

/**
 * مبدأ و توکنی که فایل باید از آن گرفته شود.
 *
 * **این کل باگی بود که کاربر بله را زمین زد.** پیش از این، `API_ROOT` و توکن
 * یک ثابت ماژول بودند که از `config.TELEGRAM_API_ROOT` و `config.BOT_TOKEN`
 * می‌آمدند — در حالی که `getFile` روی `ctx.api` صدا زده می‌شد. یعنی برای کاربر
 * بله، `file_path` را از **بله** می‌گرفتیم و بعد همان را با **توکن تلگرام** از
 * **سرور تلگرام** می‌خواستیم. نتیجه ۴۰۴ بود، هربار، برای هر فایل.
 *
 * درس همان درسِ [[internal-id-everywhere]] است: هرجا کد از `config` مستقیم
 * می‌خواند به‌جای اینکه از `ctx`/`api` بگیرد، یکی از دو سکو بی‌صدا می‌شکند.
 */
function originOf(api: Api): { root: string; token: string; bale: boolean } {
  if (isBale(api)) {
    return {
      root: config.BALE_API_ROOT.replace(/\/+$/, ""),
      token: config.BALE_BOT_TOKEN,
      bale: true,
    };
  }
  return {
    root: (config.TELEGRAM_API_ROOT ?? "https://api.telegram.org").replace(/\/+$/, ""),
    token: config.BOT_TOKEN,
    bale: false,
  };
}

/** سقف دانلودِ این سکو، برای تصمیم‌گیری پیش از هر درخواستی. */
export function downloadLimitFor(api: Api): number {
  if (isBale(api)) return BALE_LIMIT_BYTES;
  if (config.TELEGRAM_API_ROOT) return 2_000 * 1024 * 1024;
  return mtprotoAvailable() ? Number.POSITIVE_INFINITY : CLOUD_LIMIT_BYTES;
}

/**
 * دانلود فایل صوتی، با مسیرهایی که به سکو بستگی دارند:
 *
 * **بله** — فقط یک مسیر: `{BALE_API_ROOT}/file/bot{BALE_TOKEN}/{file_path}`.
 * نه سرور محلی دارد نه MTProto (که پروتکل تلگرام است و روی بله بی‌معنی).
 *
 * **تلگرام** — سه مسیر به ترتیب ترجیح:
 * ۱. **Bot API محلی** — اگر `TELEGRAM_API_ROOT` ست باشد، سقف ۲ گیگابایت.
 * ۲. **Bot API ابری** — ساده‌ترین، ولی فقط تا ۲۰ مگابایت.
 * ۳. **MTProto** — بدون سقف، برای فایل بزرگ وقتی سرور محلی نداریم.
 */
export async function downloadTelegramFile(
  api: Api,
  req: DownloadRequest,
): Promise<DownloadResult> {
  const origin = originOf(api);

  if (origin.bale) {
    // بله نه سرور محلی دارد نه MTProto. اگر از سقف رد شده، همان اول بگو —
    // تلاش کردن فقط وقت کاربر را می‌گیرد و به همان ۴۱۳ می‌رسد.
    if (req.declaredSize > BALE_LIMIT_BYTES) {
      throw new FileTooLargeError(req.declaredSize, BALE_LIMIT_BYTES);
    }
    return viaBotApi(api, req, origin);
  }

  const useLocalServer = Boolean(config.TELEGRAM_API_ROOT);
  const tooBigForCloud = !useLocalServer && req.declaredSize > CLOUD_LIMIT_BYTES;

  // فایل بزرگ: اصلاً سراغ getFile نرو — برای بیش از ۲۰ مگابایت خطا می‌دهد
  if (tooBigForCloud) {
    if (!mtprotoAvailable()) throw new FileTooLargeError(req.declaredSize, CLOUD_LIMIT_BYTES);
    const out = await downloadMedia(
      req.chatId,
      req.messageId,
      req.destDir,
      req.baseName,
      req.onProgress,
    );
    if (!out) throw new FileTooLargeError(req.declaredSize, CLOUD_LIMIT_BYTES);
    return { ...out, route: "mtproto" };
  }

  try {
    return await viaBotApi(api, req, origin);
  } catch (e) {
    // getFile گاهی برای فایلی که آپدیت اندازه‌اش را کوچک‌تر گزارش کرده هم رد می‌دهد
    if (!mtprotoAvailable()) throw e;
    logger.warn({ err: String(e) }, "bot api download failed — falling back to mtproto");
    const out = await downloadMedia(
      req.chatId,
      req.messageId,
      req.destDir,
      req.baseName,
      req.onProgress,
    );
    if (!out) throw e;
    return { ...out, route: "mtproto" };
  }
}

async function viaBotApi(
  api: Api,
  req: DownloadRequest,
  origin: { root: string; token: string; bale: boolean },
): Promise<DownloadResult> {
  const file = await api.getFile(req.fileId);
  if (!file.file_path) throw new Error("مسیر فایل برگردانده نشد.");

  await fsp.mkdir(req.destDir, { recursive: true });

  /**
   * پسوند از `file_path` درمی‌آید — ولی روی بله `file_path` خودِ `file_id`
   * است (`623775863:-84145…:1:9b03…`) و هیچ پسوندی ندارد. بدتر: دو نقطهٔ
   * داخلش `path.extname` را گول می‌زند و چیزی مثل `:1:9b03…` برمی‌گرداند که
   * نه پسوند است نه روی همهٔ سیستم‌فایل‌ها مجاز.
   *
   * پس فقط پسوندی پذیرفته می‌شود که واقعاً پسوند به‌نظر برسد؛ وگرنه از نام
   * فایلی که کاربر فرستاده یا از `.bin` استفاده می‌شود. ffprobe بعداً فرمت
   * واقعی را از خودِ بایت‌ها می‌خواند، پس پسوند فقط برچسب است.
   */
  const raw = path.extname(file.file_path);
  const ext = /^\.[A-Za-z0-9]{1,5}$/.test(raw) ? raw : ".bin";
  const dest = path.join(req.destDir, `${req.baseName}${ext}`);

  // در حالت سرور محلی، file_path یک مسیر مطلق روی همان ماشین است
  if (!origin.bale && config.TELEGRAM_LOCAL_MODE && path.isAbsolute(file.file_path)) {
    await fsp.copyFile(file.file_path, dest);
    await fsp.unlink(file.file_path).catch(() => {});
    const st = await fsp.stat(dest);
    return { filePath: dest, sizeBytes: st.size, route: "bot-api-local" };
  }

  const url = `${origin.root}/file/bot${origin.token}/${file.file_path}`;
  /**
   * مهلت روی **بی‌حرکتی**، نه روی کل دانلود.
   *
   * `fetch` خالی هیچ مهلتی ندارد: اگر سرور اتصال را بپذیرد و بعد ساکت بماند،
   * این تابع تا ابد معلق می‌ماند و کاربر فقط «⬇️ دارم فایلو می‌گیرم…» را
   * می‌بیند که تکان نمی‌خورد — همان «صفحهٔ ساکن بدون خطا» که بدترین شکل
   * شکست است.
   *
   * مهلتِ کل غلط بود: دانلودِ سالمِ یک فایل بزرگ روی اتصال کند می‌تواند
   * دقایقی طول بکشد و بریدنش یعنی کشتنِ کارِ درست. پس شمارنده با **هر تکه
   * بایت** صفر می‌شود؛ فقط سکوتِ ممتد کشنده است.
   */
  const STALL_MS = 45_000;
  const ac = new AbortController();
  let stall: NodeJS.Timeout | null = null;
  const bump = (): void => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => ac.abort(new Error("سرور وسط دانلود ساکت شد.")), STALL_MS);
    stall.unref?.();
  };
  bump();

  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } catch (e) {
    if (stall) clearTimeout(stall);
    throw e;
  }
  if (!res.ok || !res.body) {
    if (stall) clearTimeout(stall);
    throw new Error(`دانلود فایل ناموفق بود (${res.status}).`);
  }

  /**
   * پیشرفت روی خودِ بایت‌های دریافتی شمرده می‌شود، نه از `getFile`.
   *
   * **`getFile.file_size` روی بله دروغ می‌گوید:** برای همان فایل ۳۰ مگابایتی
   * عدد `85` برگرداند. `content-length` پاسخِ دانلود درست است، و اندازهٔ
   * اعلام‌شده در آپدیت هم درست است — فقط این یکی نه. پس هیچ‌جا به آن تکیه نشده.
   */
  const total = Number(res.headers.get("content-length")) || req.declaredSize || 0;
  let done = 0;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  // هر تکه‌ای که می‌رسد یعنی اتصال زنده است — شمارندهٔ بی‌حرکتی صفر می‌شود.
  body.on("data", (chunk: Buffer) => {
    bump();
    done += chunk.length;
    if (req.onProgress && total > 0) req.onProgress(done, total);
  });

  try {
    await pipeline(body, fs.createWriteStream(dest));
  } finally {
    if (stall) clearTimeout(stall);
  }

  const st = await fsp.stat(dest);
  if (st.size === 0) {
    await fsp.unlink(dest).catch(() => {});
    throw new Error("فایل خالی دریافت شد.");
  }

  /**
   * ناقص‌بودن باید **همین‌جا** گرفته شود، نه چند مرحله بعد با خطای ffmpeg.
   *
   * اتصالی که تمیز بسته شود ولی نصفه، فایلی سالم‌به‌نظر روی دیسک می‌گذارد.
   * `content-length` تنها جایی است که می‌شود فهمید.
   */
  if (total > 0 && st.size < total) {
    await fsp.unlink(dest).catch(() => {});
    throw new Error(`فایل ناقص رسید (${st.size} از ${total} بایت).`);
  }

  logger.debug(
    { dest, kb: Math.round(st.size / 1024), bale: origin.bale },
    "file downloaded",
  );
  return {
    filePath: dest,
    sizeBytes: st.size,
    route: origin.bale ? "bale" : config.TELEGRAM_API_ROOT ? "bot-api-local" : "bot-api",
  };
}
