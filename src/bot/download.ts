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
 * سقفِ **آپلودِ** بله — اندازه‌گیری‌شده، ولی نه همان چیزی که برای دانلود لازم است.
 *
 * با آپلود پلکانی از خودِ API: ۵۰ مگابایت می‌رود، **۵۱** مگابایت
 * `{"ok":false,"error_code":413,"description":"Request Entity Too Large"}`
 * می‌گیرد — یعنی خودِ بله رد می‌کند نه حدسِ ما. بالاتر از آن پاسخ، HTMLِ خام
 * nginx است. برای `sendAudio` و `sendDocument` یکسان است.
 *
 * **ولی این عدد جهتِ دانلود را تضمین نمی‌کند.** کاربر با اپ موبایل آپلود
 * می‌کند نه با API ربات، و سقف اپ می‌تواند بالاتر باشد؛ چون با API نمی‌شود
 * فایلِ بزرگ‌تر ساخت، آن جهت آزموده نشد. به همین دلیل این مقدار **مانعِ
 * تلاش** نیست و فقط عددی است که در پیامِ خطا به کاربر گفته می‌شود — تصمیمِ
 * واقعی را پاسخِ خودِ بله می‌گیرد.
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
    /**
     * روی بله **اول تلاش می‌کنیم، بعد تسلیم می‌شویم** — و این عمدی است.
     *
     * سقفِ ۵۰ مگابایت که می‌شناسیم از سمتِ **آپلود** اندازه‌گیری شده: وقتی
     * ربات با `sendAudio` یا `sendDocument` فایل می‌فرستد، ۵۰ مگابایت
     * می‌رود و ۵۱ مگابایت `{"ok":false,"error_code":413}` می‌گیرد — یعنی
     * خودِ API بله رد می‌کند، نه حدسِ ما.
     *
     * ولی آنچه اینجا لازم داریم جهتِ **دانلود** است، و آن دو یکی نیستند:
     * کاربر با اپ موبایل آپلود می‌کند نه با API ربات، و سقف اپ می‌تواند
     * بالاتر باشد. چون نمی‌توانیم با API فایلِ بزرگ‌تر بسازیم، این جهت
     * آزمودنی نبود.
     *
     * پس به‌جای ردکردنِ زودهنگام — که اگر سقفِ اپ بالاتر باشد یعنی فایلی
     * را رد می‌کنیم که بله حاضر بود بدهد، و کاربر هرگز نمی‌فهمد — تلاش
     * می‌کنیم و فقط اگر خودِ بله رد کرد تسلیم می‌شویم. `getFile` برای
     * فایلِ بزرگ‌تر از سقف خطا می‌دهد و همان‌جا به `FileTooLargeError`
     * ترجمه می‌شود.
     */
    try {
      return await viaBotApi(api, req, origin);
    } catch (e) {
      // اگر بله صریحاً به‌خاطر حجم رد کرد، پیامِ درست به کاربر برسد.
      const msg = String(e instanceof Error ? e.message : e);
      if (/413|too large|too big/i.test(msg)) {
        throw new FileTooLargeError(req.declaredSize, BALE_LIMIT_BYTES);
      }
      throw e;
    }
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
   * دو مهلتِ جدا، چون دو شکستِ جدا وجود دارد.
   *
   * **اندازه‌گیری روی بله** (دوازده دانلود پیاپیِ همان فایل ۳۰ مگابایتی):
   * رفتار کاملاً **دوحالته** است —
   *   • موفق: اولین بایت در ۲۵۸ تا ۲۹۴ میلی‌ثانیه، بدون استثنا
   *   • ناموفق: **هیچ بایتی نمی‌آید**، نه کند، بلکه هرگز
   *
   * هیچ حالت میانی‌ای نیست، و همین اجازه می‌دهد مهلتِ سرآیند خیلی کوتاه
   * باشد: ۸ ثانیه یعنی بیست‌وهفت برابرِ کندترین پاسخِ سالم، پس هیچ دانلود
   * درستی را نمی‌کُشد، ولی به‌جای ۴۵ ثانیه انتظار، در ۸ ثانیه تلاش بعدی
   * شروع می‌شود. با نرخ موفقیتِ حدود دوسوم، معمولاً تلاش دوم یا سوم می‌گیرد.
   *
   * ولی همین عدد برای **بدنه** فاجعه بود: دانلودِ سالمِ یک فایل بزرگ روی
   * اتصال کند می‌تواند دقایقی طول بکشد. پس آنجا مهلت روی **بی‌حرکتی** است و
   * با هر تکه بایت صفر می‌شود — فقط سکوتِ ممتد کشنده است.
   */
  const HEADER_MS = 8_000;
  const STALL_MS = 45_000;
  const ac = new AbortController();
  let stall: NodeJS.Timeout | null = null;
  const arm = (ms: number, why: string): void => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => ac.abort(new Error(why)), ms);
    stall.unref?.();
  };
  /** پس از رسیدن اولین بایت، فقط بی‌حرکتی مهم است. */
  const bump = (): void => arm(STALL_MS, "سرور وسط دانلود ساکت شد.");

  arm(HEADER_MS, "سرور جواب نداد.");

  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } catch (e) {
    if (stall) clearTimeout(stall);
    throw e;
  }
  // سرآیند رسید؛ از این به بعد مهلتِ بلندترِ بی‌حرکتی حاکم است.
  bump();
  if (!res.ok || !res.body) {
    if (stall) clearTimeout(stall);
    /**
     * پاسخِ خطا خوانده می‌شود، چون **تنها جایی است که سکو دلیل را می‌گوید**.
     *
     * روی بله `getFile` هیچ اعتبارسنجی‌ای نمی‌کند: هر `file_id` — حتی
     * `"zzzz"` — با `ok:true` و همان `file_size: 85` جعلی برمی‌گردد. پس
     * «این فایل بزرگ‌تر از سقف است» فقط از خودِ درخواستِ دانلود درمی‌آید،
     * و بدون خواندن بدنه، آن دلیل دور ریخته می‌شود.
     */
    const why = await res.text().catch(() => "");
    throw new Error(
      `دانلود فایل ناموفق بود (${res.status})${why ? ` — ${why.replace(/\s+/g, " ").slice(0, 120)}` : ""}.`,
    );
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

  /**
   * **کفِ سرعت — حالت سومی که مهلتِ بی‌حرکتی نمی‌گیردش.**
   *
   * بله سه حالت دارد، نه دو تا: یا سالم است (۲۴ مگابایت بر ثانیه)، یا اصلاً
   * جواب نمی‌دهد، **یا می‌خزد**. حالت سوم اندازه‌گیری شد: ۱۶ کیلوبایت بر
   * ثانیه، یعنی هزار و پانصد برابر کندتر از حالت سالم. یک فایل ۳۰ مگابایتی
   * در آن حالت **بیست‌وهفت دقیقه** طول می‌کشد.
   *
   * مهلتِ بی‌حرکتی این را نمی‌گیرد چون بایت‌ها *می‌آیند*، فقط قطره‌قطره. پس
   * جدا از آن، بعد از یک دورهٔ گرم‌شدن، نرخ سنجیده می‌شود: اگر زیر کف باشد
   * اتصال رها و تلاش دوباره می‌شود — که با نرخ موفقیت دوسوم معمولاً همان
   * تلاش بعدی سالم است و در ثانیه‌ای تمام می‌کند.
   *
   * کف عمداً خیلی پایین است (۱۲۸ کیلوبایت بر ثانیه، یعنی یک‌دویستمِ سرعت
   * سالم): هدف کشتنِ اتصالِ کندِ سالم نیست، بلکه فقط رهاکردنِ آن خزیدنی است
   * که هیچ‌وقت به سرانجام نمی‌رسد. با این کف، ۳۰ مگابایت حداکثر چهار دقیقه
   * می‌شود.
   */
  const MIN_BPS = 128 * 1024;
  const WARMUP_MS = 10_000;
  const startedAt = Date.now();

  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  // هر تکه‌ای که می‌رسد یعنی اتصال زنده است — شمارندهٔ بی‌حرکتی صفر می‌شود.
  body.on("data", (chunk: Buffer) => {
    bump();
    done += chunk.length;

    const elapsed = Date.now() - startedAt;
    if (elapsed > WARMUP_MS && done / (elapsed / 1000) < MIN_BPS) {
      ac.abort(
        new Error(
          `سرعت دانلود خیلی کم بود (${Math.round(done / (elapsed / 1000) / 1024)} کیلوبایت بر ثانیه).`,
        ),
      );
      return;
    }

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
