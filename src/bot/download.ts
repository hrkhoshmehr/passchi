import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Api } from "grammy";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { downloadMedia, mtprotoAvailable } from "./mtproto.js";

const API_ROOT = config.TELEGRAM_API_ROOT ?? "https://api.telegram.org";

/** سقف دانلود Bot API ابری. `getFile` برای فایل بزرگ‌تر از این اصلاً خطا می‌دهد. */
const CLOUD_LIMIT_BYTES = 20 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super("فایل بزرگ‌تر از سقف دانلود تلگرام است و مسیر جایگزینی پیکربندی نشده.");
  }
}

export type DownloadRoute = "bot-api" | "bot-api-local" | "mtproto";

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
 * دانلود فایل صوتی از تلگرام، با سه مسیر به ترتیب ترجیح:
 *
 * ۱. **Bot API محلی** — اگر `TELEGRAM_API_ROOT` ست باشد، سقف ۲ گیگابایت است و
 *    فایل مستقیم روی دیسک همان ماشین ساخته می‌شود (بدون دانلود شبکه‌ای).
 * ۲. **Bot API ابری** — ساده‌ترین مسیر، ولی فقط تا ۲۰ مگابایت.
 * ۳. **MTProto** — بدون سقف. برای فایل‌های بزرگ وقتی سرور محلی نداریم.
 */
export async function downloadTelegramFile(
  api: Api,
  req: DownloadRequest,
): Promise<DownloadResult> {
  const useLocalServer = Boolean(config.TELEGRAM_API_ROOT);
  const tooBigForCloud = !useLocalServer && req.declaredSize > CLOUD_LIMIT_BYTES;

  // فایل بزرگ: اصلاً سراغ getFile نرو — برای بیش از ۲۰ مگابایت خطا می‌دهد
  if (tooBigForCloud) {
    if (!mtprotoAvailable()) throw new FileTooLargeError(req.declaredSize);
    const out = await downloadMedia(
      req.chatId,
      req.messageId,
      req.destDir,
      req.baseName,
      req.onProgress,
    );
    if (!out) throw new FileTooLargeError(req.declaredSize);
    return { ...out, route: "mtproto" };
  }

  try {
    return await viaBotApi(api, req, useLocalServer);
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
  useLocalServer: boolean,
): Promise<DownloadResult> {
  const file = await api.getFile(req.fileId);
  if (!file.file_path) throw new Error("تلگرام مسیر فایل را برنگرداند.");

  await fsp.mkdir(req.destDir, { recursive: true });
  const ext = path.extname(file.file_path) || ".bin";
  const dest = path.join(req.destDir, `${req.baseName}${ext}`);

  // در حالت سرور محلی، file_path یک مسیر مطلق روی همان ماشین است
  if (config.TELEGRAM_LOCAL_MODE && path.isAbsolute(file.file_path)) {
    await fsp.copyFile(file.file_path, dest);
    await fsp.unlink(file.file_path).catch(() => {});
    const st = await fsp.stat(dest);
    return { filePath: dest, sizeBytes: st.size, route: "bot-api-local" };
  }

  const url = `${API_ROOT}/file/bot${config.BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`دانلود فایل ناموفق بود (${res.status}).`);
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    fs.createWriteStream(dest),
  );

  const st = await fsp.stat(dest);
  logger.debug({ dest, kb: Math.round(st.size / 1024) }, "telegram file downloaded");
  return {
    filePath: dest,
    sizeBytes: st.size,
    route: useLocalServer ? "bot-api-local" : "bot-api",
  };
}
