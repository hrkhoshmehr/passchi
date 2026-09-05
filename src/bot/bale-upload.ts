/**
 * آپلود فایل به بله — دور زدنِ `attach://` که بله نمی‌فهمد.
 *
 * ## باگ
 *
 * هر `sendDocument`/`sendAudio`/`sendPhoto` که فایل واقعی می‌فرستاد، روی بله
 * با `400: Bad Request: failed to get HTTP URL content` رد می‌شد — و چون
 * فراخوانی‌ها `.catch(() => {})` داشتند، **بی‌صدا** رد می‌شد: کاربر بله در تور
 * نمونه نه جزوه می‌گرفت نه رونوشت، و هیچ خطی هم در لاگ نبود.
 *
 * ## علت
 *
 * grammY فایل را به‌جای گذاشتن مستقیم زیر نام میدان، با ارجاع می‌فرستد:
 *
 * ```
 * document=attach://f-8a3c…        ← مقدار میدان
 * f-8a3c…=<بایت‌های فایل>           ← بخش جداگانه
 * ```
 *
 * تلگرام این را می‌فهمد؛ بله نمی‌فهمد و رشتهٔ `attach://…` را یک **آدرس**
 * می‌بیند که نمی‌تواند دانلودش کند — دقیقاً همان متن خطا.
 *
 * روی خودِ سرور بله سنجیده شد: همان بایت‌ها با نام میدانِ مستقیم (`document`)
 * `ok: true` می‌گیرند و با `attach://` رد می‌شوند. پس مسئله نه حجم است، نه
 * قالب، نه `Content-Length` — که هر سه جداگانه آزموده و رد شدند.
 *
 * ## چرا اینجا و نه در یک ترنسفورمر
 *
 * ترنسفورمرهای `api.config.use` روی *payload* کار می‌کنند، ولی این باگ در
 * لایهٔ پایین‌ترِ کدگذاری multipart است که grammY آن را بیرون نمی‌دهد. پس
 * برای همین چند فراخوانی، درخواست دستی ساخته می‌شود.
 */
import fs from "node:fs/promises";
import { InputFile, type Api, type Context } from "grammy";
import { config } from "../config.js";
import { htmlToPlain } from "../util/text.js";
import { platformOf } from "./identity.js";
import type { Platform } from "../db/identity.js";
import { logger } from "../util/logger.js";

/** متدهایی که فایل می‌فرستند و نام میدانِ فایل در هرکدام. */
type UploadMethod = "sendDocument" | "sendAudio" | "sendPhoto" | "sendVoice" | "sendVideo";

const FIELD: Record<UploadMethod, string> = {
  sendDocument: "document",
  sendAudio: "audio",
  sendPhoto: "photo",
  sendVoice: "voice",
  sendVideo: "video",
};

export interface BaleUploadResult {
  message_id: number;
  document?: { file_id: string };
  audio?: { file_id: string };
  voice?: { file_id: string };
  photo?: Array<{ file_id: string }>;
  video?: { file_id: string };
}

/**
 * یک بخش `multipart/form-data` می‌سازد.
 *
 * نام فایل به‌صورت UTF-8 نوشته می‌شود چون اسم‌ها فارسی‌اند
 * («نمونه-جزوه.pdf») و بله همان را در پیام نشان می‌دهد.
 */
function part(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    "utf8",
  );
}

function filePart(boundary: string, name: string, filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    ),
    bytes,
    Buffer.from("\r\n", "utf8"),
  ]);
}

/**
 * فایلی را مستقیم به بله می‌فرستد، بدون `attach://`.
 *
 * `source` یا مسیر فایل روی دیسک است یا خودِ بایت‌ها. اگر `BALE_BOT_TOKEN`
 * تنظیم نباشد `null` برمی‌گردد — همان‌طور که بقیهٔ مسیرهای بله رفتار می‌کنند.
 *
 * برخلاف کد قبلی، خطا **بلعیده نمی‌شود**: صدازننده تصمیم می‌گیرد، ولی چیزی
 * که شکست بخورد حتماً در لاگ می‌آید. باگ اصلی دقیقاً به این دلیل ماه‌ها
 * نادیده ماند.
 */
export async function baleSendFile(
  method: UploadMethod,
  chatId: number | string,
  source: { path: string; filename: string } | { bytes: Buffer; filename: string },
  extra: Record<string, string | number | undefined> = {},
): Promise<BaleUploadResult | null> {
  if (!config.BALE_BOT_TOKEN) return null;

  const bytes = "bytes" in source ? source.bytes : await fs.readFile(source.path);
  const boundary = `----passchi${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  const chunks: Buffer[] = [part(boundary, "chat_id", String(chatId))];
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== "") chunks.push(part(boundary, k, String(v)));
  }
  chunks.push(filePart(boundary, FIELD[method], source.filename, bytes));
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

  const body = Buffer.concat(chunks);
  const root = config.BALE_API_ROOT.replace(/\/+$/, "");

  /**
   * **مهلت، چون بله گاهی بایت‌ها را می‌بلعد و هرگز جواب نمی‌دهد.**
   *
   * روی همین سرور دیده شد: یک آپلود ۲۵ مگابایتی که `ss -tni` تأییدش می‌کرد
   * کامل رفته و ack شده (`bytes_acked` برابر کل حجم)، ولی هفت دقیقه هیچ
   * پاسخی نیامد — در حالی که `getMe` در همان لحظه ۰٫۲ ثانیه جواب می‌داد. پس
   * سرویس بالا بود و فقط همان درخواست بی‌جواب ماند.
   *
   * بدون مهلت، `fetch` تا ابد معلق می‌ماند و چون این تابع **داخل کارِ صف**
   * صدا زده می‌شود، یکی از دو جای همزمان را برای همیشه اشغال می‌کرد. دو تای
   * این‌ها یعنی کل سرویس برای همهٔ کاربران می‌خوابید — بی‌آنکه خطایی در لاگ
   * باشد.
   *
   * مهلت سخاوتمندانه است چون آپلودِ سالمِ یک فایل بزرگ روی همین مسیر واقعاً
   * دقایقی طول می‌کشد؛ هدف گرفتنِ حالتِ «هرگز» است، نه حالتِ کند.
   */
  const UPLOAD_TIMEOUT_MS = 4 * 60_000;
  let res: Response;
  try {
    res = await fetch(`${root}/bot${config.BALE_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    logger.warn(
      { method, chatId, bytes: body.length, err: String(e instanceof Error ? e.message : e) },
      "ارسال فایل به بله بی‌جواب ماند یا شکست",
    );
    throw e;
  }

  const data = (await res.json().catch(() => ({ ok: false, description: `پاسخ نامعتبر (${res.status})` }))) as {
    ok: boolean;
    result?: BaleUploadResult;
    description?: string;
  };
  if (!data.ok) {
    logger.warn(
      { method, chatId, bytes: body.length, err: data.description },
      "ارسال فایل به بله شکست خورد",
    );
    throw new Error(data.description ?? "bale upload failed");
  }
  return data.result ?? null;
}

/**
 * فرستادن سند، روی هر دو سکو.
 *
 * مسیر بله دستی ساخته می‌شود (به دلیلِ `attach://` که بالا توضیح داده شد) و
 * مسیر تلگرام دست‌نخورده می‌ماند.
 *
 * خطا اینجا **لاگ می‌شود**. کد قبلی `.catch(() => {})` داشت و دقیقاً به همین
 * دلیل نبودِ جزوه و رونوشت در بله دیده نشد: کاربر چیزی نمی‌گرفت و لاگ هم
 * ساکت بود. یک سند نباید کل تحویل را بشکند، ولی سکوت هم نباید بکند.
 *
 * `true` یعنی رفت؛ `false` یعنی نرفت و صدازننده می‌تواند به کاربر بگوید.
 */
export async function sendDoc(
  ctx: Context,
  src: string | Buffer,
  filename: string,
  opts: { caption?: string; parse_mode?: "HTML" } = {},
): Promise<boolean> {
  const platform = platformOf(ctx);
  try {
    if (platform === "bale") {
      const source = typeof src === "string" ? { path: src, filename } : { bytes: src, filename };
      await baleSendFile("sendDocument", ctx.chat!.id, source, {
        // بله قالب‌بندی ندارد؛ همان کاری که ترنسفورمر با متن‌ها می‌کند.
        caption: opts.caption ? htmlToPlain(opts.caption) : undefined,
      });
      return true;
    }
    await ctx.replyWithDocument(new InputFile(src, filename), opts);
    return true;
  } catch (err) {
    logger.warn({ filename, platform, err: (err as Error).message }, "ارسال سند شکست خورد");
    return false;
  }
}

/**
 * همان کار، ولی بدون `Context` — برای مسیرهایی که فقط `Api` و شناسهٔ چت دارند.
 *
 * `deliverToBot` دقیقاً همین حالت است: از مینی‌اپ صدا زده می‌شود، جایی که
 * هیچ آپدیتی در کار نیست. پیش‌تر مستقیم `InputFile` می‌ساخت و برای کاربر
 * **بله** هر سه فایل — صوت، جزوه، و رونوشت — با
 * `failed to get HTTP URL content` رد می‌شدند؛ یعنی کاربر بله که از مینی‌اپ
 * آپلود کرده بود، متن‌ها را می‌گرفت ولی **جزوه‌اش هرگز نمی‌رسید**.
 *
 * `platform` صریح گرفته می‌شود نه حدس‌زده: صدازننده از `deliveryChannel`
 * می‌داند روی کدام سکو حرف می‌زند.
 */
export async function sendFileTo(
  api: Api,
  chatId: number,
  platform: Platform,
  method: UploadMethod,
  source: { path: string; filename: string } | { bytes: Buffer; filename: string },
  opts: { caption?: string; title?: string; duration?: number } = {},
): Promise<{ message_id: number; fileId: string | null } | null> {
  if (platform === "bale") {
    const res = await baleSendFile(method, chatId, source, {
      caption: opts.caption ? htmlToPlain(opts.caption) : undefined,
      title: opts.title,
      duration: opts.duration,
    });
    if (!res) return null;
    const fileId =
      res.audio?.file_id ?? res.document?.file_id ?? res.voice?.file_id ?? res.video?.file_id ?? null;
    return { message_id: res.message_id, fileId };
  }

  const file = "bytes" in source ? new InputFile(source.bytes, source.filename) : new InputFile(source.path, source.filename);
  const extra = {
    ...(opts.caption ? { caption: opts.caption, parse_mode: "HTML" as const } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.duration ? { duration: opts.duration } : {}),
  };
  const sent =
    method === "sendAudio"
      ? await api.sendAudio(chatId, file, extra)
      : await api.sendDocument(chatId, file, extra);
  const s = sent as { message_id: number; audio?: { file_id: string }; document?: { file_id: string } };
  return { message_id: s.message_id, fileId: s.audio?.file_id ?? s.document?.file_id ?? null };
}
