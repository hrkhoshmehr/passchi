/**
 * گرفتن صوت از یک لینک.
 *
 * خیلی از کلاس‌ها آنلاین برگزار می‌شوند و دانشجو به‌جای فایل، لینک ضبط جلسه
 * را دارد — اسکای‌روم، ادوبی کانکت، بیگ‌بلوباتن، یا یک آدرس ساده روی سرور
 * دانشگاه. تا پیش از این تنها راه، دانلود دستی و آپلود دوباره بود.
 *
 * ## چرا لینک را مستقیم به Soniox نمی‌دهیم
 *
 * Soniox خودش `audio_url` می‌پذیرد و وسوسه‌انگیز است که لینک را همان‌جا پاس
 * بدهیم. ولی خط لوله به **فایل روی دیسک** وابسته است، نه فقط به متن رونوشت:
 *
 * - حذف سکوت روی فایل انجام می‌شود و مبنای تخفیف هزینه است.
 * - کلیپ نقل‌قول‌ها (`extractClip`) از همان فایل بریده می‌شود.
 * - بایگانی ادمین نسخه‌ای از صوت می‌خواهد تا شکست‌ها قابل بررسی باشند.
 * - رزرو اعتبار به مدت واقعی نیاز دارد که با `probe` گرفته می‌شود.
 *
 * پس لینک اینجا دانلود می‌شود و از آن به بعد دقیقاً مثل فایلِ فرستاده‌شده
 * رفتار می‌کند. فرمت هم مسئله نیست: ffmpeg همه‌جا با `-vn` صدا زده می‌شود،
 * پس ویدیو خودبه‌خود فقط صدایش برداشته می‌شود.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "../util/logger.js";

/**
 * سقف حجم دانلود.
 *
 * بدون سقف، یک لینک به فایل ۲۰ گیگابایتی دیسک سرور را پر می‌کند و کل سرویس
 * را می‌خواباند — و کاربر لازم نیست قصد بدی داشته باشد، یک لینک اشتباه کافی
 * است. دو گیگابایت برای هر ضبط کلاسی که به درد بخورد کافی است.
 */
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** مهلت کل دانلود. لینک کند بهتر است شکست بخورد تا اینکه ساعت‌ها کار را بگیرد. */
const TIMEOUT_MS = 30 * 60_000;

export class UrlFetchError extends Error {
  constructor(
    message: string,
    /** پیامی که مستقیم به کاربر نشان داده می‌شود — بدون جزئیات فنی. */
    readonly userMessage: string,
  ) {
    super(message);
  }
}

export interface FetchUrlResult {
  filePath: string;
  sizeBytes: number;
  /** نام فایل روی سرور مقصد، اگر قابل حدس بود */
  remoteName: string | null;
}

/**
 * لینک‌هایی که فایل مستقیم نیستند.
 *
 * یوتیوب و آپارات و درایو صفحهٔ HTML برمی‌گردانند نه صوت. دانلودشان به
 * استخراج‌کننده نیاز دارد که اینجا نداریم — و مهم‌تر، این سرویس دستیار کلاس
 * است نه دانلودر ویدیو. پس زود و صریح رد می‌شوند، با پیامی که بگوید چه کار
 * کند؛ وگرنه یک صفحهٔ HTML دانلود می‌شود و خطا تا ffmpeg عقب می‌افتد و کاربر
 * پیامی می‌گیرد که هیچ ربطی به مشکلش ندارد.
 */
const UNSUPPORTED_HOSTS: Array<{ match: RegExp; label: string }> = [
  { match: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, label: "یوتیوب" },
  { match: /(^|\.)aparat\.com$/i, label: "آپارات" },
  { match: /(^|\.)drive\.google\.com$/i, label: "گوگل درایو" },
  { match: /(^|\.)instagram\.com$/i, label: "اینستاگرام" },
  { match: /(^|\.)t\.me$|(^|\.)telegram\.me$/i, label: "تلگرام" },
  { match: /(^|\.)ble\.ir$/i, label: "بله" },
];

/**
 * لینک را از متن پیام بیرون بکش.
 *
 * فقط http و https. بقیهٔ پروتکل‌ها رد می‌شوند — `file://` یعنی خواندن دیسک
 * خودِ سرور با آدرسی که کاربر می‌فرستد.
 */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>]+/i);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** اگر میزبان پشتیبانی نمی‌شود برچسبش را بده، وگرنه null. */
export function unsupportedHost(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return UNSUPPORTED_HOSTS.find((h) => h.match.test(host))?.label ?? null;
}

/**
 * آدرس‌های داخلی شبکه را رد کن.
 *
 * بدون این، کاربر می‌تواند با فرستادن `http://127.0.0.1:3000/...` سرور را
 * وادار کند سرویس‌های داخلی خودش را بخواند و نتیجه را پس بدهد. اینجا فقط نام
 * میزبان بررسی می‌شود که جلوی حالت‌های آشکار را می‌گیرد.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    return true;
  }
  if (h === "::1" || h === "0.0.0.0") return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  // IPv6 یکتا-محلی و link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

/** پسوند فایل را از آدرس یا نوع محتوا حدس بزن. */
function guessExt(url: string, contentType: string | null): string {
  const fromUrl = path.extname(new URL(url).pathname).toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(fromUrl)) return fromUrl;

  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/webm": ".webm",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
  };
  return map[ct] ?? ".bin";
}

/**
 * محتوایی که برگشته اصلاً رسانه هست؟
 *
 * سرورها برای لینکِ منقضی یا نیازمند ورود اغلب کد ۲۰۰ و یک صفحهٔ HTML
 * برمی‌گردانند. بدون این بررسی، آن صفحه دانلود می‌شود و کاربر به‌جای «لینکت
 * ورود می‌خواهد» پیام خطای ffmpeg می‌گیرد.
 */
function looksLikeMedia(contentType: string | null, ext: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("audio/") || ct.startsWith("video/")) return true;
  if (ct.includes("html") || ct.includes("json") || ct.includes("xml")) return false;
  // بعضی سرورها نوع درست نمی‌دهند؛ آن‌وقت پسوند حرف آخر را می‌زند
  return ext !== ".bin";
}

export interface FetchUrlRequest {
  url: string;
  destDir: string;
  baseName: string;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export async function fetchUrlToFile(req: FetchUrlRequest): Promise<FetchUrlResult> {
  const target = new URL(req.url);

  if (isPrivateHost(target.hostname)) {
    throw new UrlFetchError("private host", "این آدرس داخلیه و قابل دریافت نیست. لینک عمومی فایل رو بفرست.");
  }

  const label = unsupportedHost(req.url);
  if (label) {
    throw new UrlFetchError(
      `unsupported host: ${label}`,
      `لینک ${label} رو نمی‌تونم مستقیم بگیرم 🙏\n\n` +
        "فایلشو دانلود کن و همین‌جا بفرست، یا اگه لینک مستقیم خود فایل رو داری اونو بده.",
    );
  }

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    let res: Response;
    try {
      res = await fetch(req.url, {
        redirect: "follow",
        signal: ctrl.signal,
        headers: {
          // بعضی سرورها بدون User-Agent شناخته‌شده ۴۰۳ می‌دهند
          "User-Agent": "Mozilla/5.0 (compatible; PasschiBot/1.0)",
          Accept: "*/*",
        },
      });
    } catch (e) {
      throw new UrlFetchError(
        `fetch failed: ${String(e)}`,
        "نشد به این لینک وصل بشم. مطمئن شو درسته و تو مرورگر باز می‌شه.",
      );
    }

    if (!res.ok || !res.body) {
      const hint =
        res.status === 401 || res.status === 403
          ? "این لینک ورود یا رمز می‌خواد. لینکی بده که بدون لاگین باز بشه."
          : res.status === 404
            ? "این لینک پیدا نشد — شاید منقضی شده."
            : `سرورِ اون لینک جواب نداد (${res.status}). یه بار دیگه امتحان کن.`;
      throw new UrlFetchError(`http ${res.status}`, hint);
    }

    // نوع و نام را **بعد از** ریدایرکت‌ها از پاسخ نهایی بگیر
    const finalUrl = res.url || req.url;
    const contentType = res.headers.get("content-type");
    const ext = guessExt(finalUrl, contentType);

    if (!looksLikeMedia(contentType, ext)) {
      throw new UrlFetchError(
        `not media: ${contentType}`,
        "این لینک به یه صفحهٔ وب می‌رسه نه فایل صوتی.\n\n" +
          "<i>لینک مستقیم خود فایل رو بفرست — معمولاً به mp3 یا mp4 ختم می‌شه.</i>",
      );
    }

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) {
      throw new UrlFetchError(
        `too large: ${declared}`,
        "این فایل خیلی بزرگه. نسخهٔ فشرده‌ترش رو بفرست، یا فقط بخشی که کلاسه.",
      );
    }

    await fsp.mkdir(req.destDir, { recursive: true });
    const dest = path.join(req.destDir, `${req.baseName}${ext}`);

    /**
     * سقف حجم روی خودِ جریان هم بررسی می‌شود، نه فقط روی `content-length`.
     * آن هدر اختیاری است و برای پاسخ chunked اصلاً نمی‌آید — یعنی سقف بالا
     * دقیقاً در حالتی که بیشترین اهمیت را دارد ساکت رد می‌شود.
     */
    let done = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        done += chunk.byteLength;
        if (done > MAX_BYTES) {
          controller.error(new UrlFetchError("exceeded max bytes", "این فایل خیلی بزرگه."));
          return;
        }
        req.onProgress?.(done, declared);
        controller.enqueue(chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(res.body.pipeThrough(counter) as Parameters<typeof Readable.fromWeb>[0]),
        fs.createWriteStream(dest),
      );
    } catch (e) {
      await fsp.unlink(dest).catch(() => {});
      if (e instanceof UrlFetchError) throw e;
      throw new UrlFetchError(`stream failed: ${String(e)}`, "دانلود نصفه موند. یه بار دیگه امتحان کن.");
    }

    const st = await fsp.stat(dest);
    if (st.size === 0) {
      await fsp.unlink(dest).catch(() => {});
      throw new UrlFetchError("empty file", "فایلی که این لینک داد خالی بود.");
    }

    logger.info(
      { host: target.hostname, mb: Math.round(st.size / 1024 / 1024), contentType },
      "url media downloaded",
    );

    let remoteName: string | null = null;
    try {
      remoteName = decodeURIComponent(path.basename(new URL(finalUrl).pathname)) || null;
    } catch {
      remoteName = null;
    }

    return { filePath: dest, sizeBytes: st.size, remoteName };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

export { MAX_BYTES as URL_MAX_BYTES };
