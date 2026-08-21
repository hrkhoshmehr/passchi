/**
 * دانلود فایل‌هایی که Bot API تحویل نمی‌دهد.
 *
 * Bot API ابری دانلود ربات را روی ۲۰ مگابایت می‌بندد. یک کلاس ۹۰ دقیقه‌ای که
 * با ضبط‌کنندهٔ گوشی گرفته شده معمولاً ۴۰ تا ۹۰ مگابایت است، پس این سقف در عمل
 * همیشه می‌خورد. MTProto چنین سقفی ندارد و ربات می‌تواند مستقیم با آن حرف بزند:
 * ورود با **همان توکن ربات** انجام می‌شود — نه حساب کاربری لازم است، نه شماره تلفن،
 * نه سشنی که متعلق به یک آدم باشد.
 *
 * سه نکته که کار را ممکن می‌کنند و به‌راحتی اشتباه می‌شوند:
 *
 * ۱) `updateManager.stop()` بلافاصله پس از اتصال. معادل `receive_updates=False`
 *    در Telethon است. بدون آن، این اتصال برای گرفتن آپدیت‌ها با polling ربات
 *    رقابت می‌کند و پیام‌ها شروع به گم‌شدن می‌کنند. teleproto پارامتری برای این
 *    کار ندارد، ولی متوقف‌کردن مدیر آپدیت همان اثر را دارد: حلقهٔ getDifference
 *    که آپدیت‌ها را مصرف می‌کند دیگر اجرا نمی‌شود.
 *
 * ۲) `accessHash = 0`. به‌طور کلی هش دسترسی صفر نامعتبر است، ولی تلگرام آن را
 *    از یک ربات، برای کاربرانی که به همان ربات پیام داده‌اند، می‌پذیرد — که دقیقاً
 *    همین حالت است. تبدیل peer به روش معمول شکست می‌خورد.
 *
 * ۳) ربات‌ها اجازهٔ خواندن تاریخچه ندارند، ولی می‌توانند پیام را **با شناسه**
 *    بگیرند. پس `getMessages(peer, { ids })` کار می‌کند و `getMessages(peer,
 *    { limit })` نه.
 *
 * اتصال با اولین فایل بزرگ برقرار می‌شود و پس از بی‌کاری قطع — تا پنجره‌ای که
 * در آن ممکن است آپدیتی ربوده شود تا حد ممکن کوچک بماند.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

/**
 * بایت به ازای هر درخواست. سقف سرور ۱ مگابایت است و مقدار باید بر ۴۰۹۶ بخش‌پذیر
 * باشد. انتقال به تعداد رفت‌وبرگشت وابسته است نه به پهنای باند، پس درخواست‌های
 * بزرگ‌تر بیشترین سهم بهبود را می‌دهند.
 */
const REQUEST_SIZE = 512 * 1024;

/** اگر این‌قدر بی‌کار ماند، اتصال را ببند. */
const IDLE_DISCONNECT_MS = 3 * 60_000;

const SESSION_FILE = path.join(config.dataDir, "mtproto.session");

let client: TelegramClient | null = null;
let connecting: Promise<TelegramClient> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

export function mtprotoAvailable(): boolean {
  return Boolean(config.TELEGRAM_API_ID && config.TELEGRAM_API_HASH);
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void disconnect(), IDLE_DISCONNECT_MS);
  idleTimer.unref?.();
}

async function connect(): Promise<TelegramClient> {
  if (client?.connected) {
    touchIdle();
    return client;
  }
  connecting ??= (async () => {
    const saved = await fsp.readFile(SESSION_FILE, "utf8").catch(() => "");
    const c = new TelegramClient(
      new StringSession(saved.trim()),
      config.TELEGRAM_API_ID!,
      config.TELEGRAM_API_HASH!,
      { connectionRetries: 5, requestRetries: 3, autoReconnect: true },
    );
    await c.start({ botAuthToken: config.BOT_TOKEN });

    // معادل receive_updates=False — باید بلافاصله بعد از start صدا زده شود
    c.updateManager.stop();

    const session = (c.session as StringSession).save();
    await fsp.writeFile(SESSION_FILE, session, "utf8").catch(() => {});
    logger.info("mtproto connected");
    client = c;
    touchIdle();
    return c;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function disconnect(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const c = client;
  client = null;
  if (!c) return;
  await c.destroy().catch(() => {});
  logger.info("mtproto disconnected");
}

function toPeer(chatId: number): Api.TypeInputPeer {
  if (chatId >= 0) {
    return new Api.InputPeerUser({ userId: bigInt(chatId), accessHash: bigInt(0) });
  }
  const s = String(chatId);
  if (s.startsWith("-100")) {
    return new Api.InputPeerChannel({ channelId: bigInt(s.slice(4)), accessHash: bigInt(0) });
  }
  return new Api.InputPeerChat({ chatId: bigInt(-chatId) });
}

export interface MtprotoDownload {
  filePath: string;
  sizeBytes: number;
}

/**
 * یک پیام را با شناسه می‌گیرد و رسانه‌اش را روی دیسک می‌نویسد.
 *
 * `onProgress(done, total)` صدا زده می‌شود تا کاربر بی‌خبر نماند — دانلود
 * ۸۰ مگابایتی چند دقیقه سکوت است و کاربر آن را «ربات هنگ کرده» می‌خواند.
 *
 * وقتی پیام یا رسانه‌اش پیدا نشود `null` برمی‌گرداند تا فراخوان بتواند به
 * مسیر Bot API برگردد، نه اینکه کل کار شکست بخورد.
 */
export async function downloadMedia(
  chatId: number,
  messageId: number,
  destDir: string,
  baseName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<MtprotoDownload | null> {
  const c = await connect();
  const messages = await c.getMessages(toPeer(chatId), { ids: [messageId] });
  const message = messages.find((m): m is Api.Message => Boolean(m?.media));
  if (!message) {
    logger.warn({ messageId }, "mtproto found no media for message");
    return null;
  }

  const doc =
    message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document
      ? message.media.document
      : null;
  const total = doc ? Number(doc.size) : 0;
  const ext = extensionOf(doc) ?? ".bin";

  await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${baseName}${ext}`);

  let done = 0;
  const handle = fs.createWriteStream(dest);
  try {
    for await (const chunk of c.iterDownload(message, { requestSize: REQUEST_SIZE })) {
      if (!handle.write(chunk)) await new Promise((r) => handle.once("drain", r));
      done += chunk.length;
      onProgress?.(done, total);
    }
  } finally {
    await new Promise<void>((resolve) => handle.end(resolve));
  }

  touchIdle();
  const st = await fsp.stat(dest);
  logger.info({ messageId, bytes: st.size }, "mtproto downloaded");
  return { filePath: dest, sizeBytes: st.size };
}

const MIME_EXT: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "audio/amr": ".amr",
  "video/mp4": ".mp4",
};

function extensionOf(doc: Api.Document | null): string | null {
  if (!doc) return null;
  for (const attr of doc.attributes) {
    if (attr instanceof Api.DocumentAttributeFilename) {
      const e = path.extname(attr.fileName);
      if (e) return e;
    }
  }
  return MIME_EXT[doc.mimeType] ?? null;
}
