/**
 * تحویل نتیجهٔ جلسه به چتِ ربات — برای کاری که از **مینی‌اپ** شروع شده.
 *
 * چرا اصلاً لازم است: کاربر ایرانی صوت کلاس را به‌سختی داخل خودِ ربات آپلود
 * می‌کند. بله بالای بیست مگابایت را نمی‌پذیرد، و تلگرام برای او یعنی
 * فیلترشکن و آپلودِ کند. پس آپلود در مینی‌اپ انجام می‌شود — روی اینترنت ملی
 * و بدون محدودیت حجم — ولی **نتیجه باید در ربات بیاید**، چون آنجاست که
 * می‌شود جزوه را فوروارد کرد، زمان‌ها لینکِ پخش می‌شوند، و جلسه در تاریخچه
 * می‌ماند.
 *
 * تفاوتش با `share.deliverSession` این است که آن `Context` می‌خواهد (یعنی
 * فقط وقتی کار می‌کند که کاربر همان لحظه با ربات حرف زده باشد) و این با
 * `Api` و شناسهٔ چت کار می‌کند، پس از هر جایی صدا زدنی است.
 */

import fs from "node:fs";
import { sendFileTo } from "./bale-upload.js";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { escapeHtml } from "../util/text.js";
import { transcodeForTelegram } from "../audio/ffmpeg.js";
import { getCourse, sessionReport, updateSession, type SessionRow } from "../db/index.js";
import { deliveryChannel } from "./notify.js";
import * as S from "./strings.js";

/**
 * سقف ارسال فایل از ربات: **پنجاه مگابایت**.
 *
 * اندازه‌گیری شده، نه از مستندات: ۴۹٫۶ مگابایت در سه ثانیه رفت و ۶۰ مگابایت
 * خطای `413 Request Entity Too Large` گرفت.
 */
export const MAX_SEND_BYTES = 50 * 1024 * 1024;

/**
 * صوت را طوری آماده کن که ربات بتواند بفرستدش.
 *
 * زیر سقف، خودِ فایل می‌رود. بالای سقف، یک نسخهٔ فشردهٔ مونو ساخته می‌شود —
 * نه برای صرفه‌جویی، بلکه چون **بدون صوت در همان چت، زمان‌ها لینک نمی‌شوند**
 * و مهم‌ترین قابلیت گزارش از کار می‌افتد. کیفیت پخش کمی پایین‌تر می‌آید و
 * برای شنیدن حرف استاد کافی است؛ رونویسی از فایل اصلی انجام شده و این نسخه
 * فقط برای گوش‌دادن است.
 *
 * `null` یعنی نشد — و صدازننده باید بدون صوت جلو برود، نه اینکه کل تحویل را
 * از دست بدهد.
 */
async function playableAudio(s: SessionRow): Promise<{ file: string; temp: boolean } | null> {
  const src = s.original_file;
  if (!src || !fs.existsSync(src)) return null;

  const size = fs.statSync(src).size;
  if (size <= MAX_SEND_BYTES) return { file: src, temp: false };

  try {
    const out = await transcodeForTelegram(src, config.workDir, MAX_SEND_BYTES);
    return out ? { file: out, temp: true } : null;
  } catch (e) {
    logger.warn({ sessionId: s.id, err: String(e) }, "compress for delivery failed");
    return null;
  }
}

/**
 * گزارش کامل جلسه را به چتِ ربات بفرست.
 *
 * ترتیب عمدی است: اول صوت، بعد سه پیام گزارش که **ریپلای همان صوت**اند.
 * تلگرام زمان‌ها را فقط در این حالت به لینک پخش تبدیل می‌کند.
 *
 * هر شکستی بلعیده می‌شود جز نبودِ گزارش: کاربر جلسه‌اش را در تاریخچه دارد و
 * نباید یک خطای شبکه، کل نتیجه را از بین ببرد.
 */
export async function deliverToBot(userId: number, s: SessionRow): Promise<boolean> {
  const r = sessionReport(s);
  if (!r) return false;

  const ch = deliveryChannel(userId);
  if (!ch) {
    logger.info({ sessionId: s.id, userId }, "no bot channel to deliver to");
    return false;
  }

  const course = s.course_id ? getCourse(s.course_id) : null;

  // ─── صوت ──────────────────────────────────────────────────────────────────
  let audioMessageId: number | null = null;
  const audio = await playableAudio(s);
  if (audio) {
    try {
      // از `sendFileTo` و نه `InputFile` خام: روی بله، ارجاعِ `attach://` که
      // grammY می‌سازد با `failed to get HTTP URL content` رد می‌شود.
      const sent = await sendFileTo(
        ch.api,
        ch.chatId,
        ch.platform,
        "sendAudio",
        { path: audio.file, filename: `${s.title ?? "جلسه"}.mp3` },
        {
          caption: `🎧 ${escapeHtml(s.title ?? "صوت جلسه")}`,
          ...(s.title ? { title: s.title } : {}),
        },
      );
      audioMessageId = sent?.message_id ?? null;
      // `file_id` نگه داشته می‌شود تا دفعهٔ بعد (اشتراک‌گذاری، تاریخچه) آپلود
      // دوباره لازم نباشد.
      if (sent?.fileId) updateSession(s.id, { audio_file_id: sent.fileId });
    } catch (e) {
      logger.warn({ sessionId: s.id, err: String(e) }, "deliver audio failed");
    } finally {
      if (audio.temp) fs.promises.unlink(audio.file).catch(() => {});
    }
  }

  const asReply = audioMessageId
    ? { reply_parameters: { message_id: audioMessageId, allow_sending_without_reply: true } }
    : {};
  // زمان‌ها فقط وقتی لینک می‌شوند که صوتی در همان چت باشد و بشود ریپلایش کرد.
  const linkable = audioMessageId !== null && ch.platform === "telegram";

  const send = async (text: string, extra: Record<string, unknown> = {}) => {
    if (!text) return;
    for (const part of S.chunk(text)) {
      await ch.api
        .sendMessage(ch.chatId, part, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...extra,
        })
        .catch((e: unknown) => logger.warn({ err: String(e) }, "deliver message failed"));
    }
  };

  await send(
    S.recapMessage({
      report: r,
      courseName: course?.name ?? null,
      sessionDate: s.session_date,
      durationMs: s.original_ms,
      savedMs: Math.max(0, s.original_ms - s.billed_ms),
      qualityWarnings: [],
    }),
  );
  await send(S.extractedMessage(r), asReply);
  await send(S.timelineMessage(r, linkable), asReply);

  if (s.pdf_path && fs.existsSync(s.pdf_path)) {
    await sendFileTo(
      ch.api,
      ch.chatId,
      ch.platform,
      "sendDocument",
      { path: s.pdf_path, filename: `${s.title ?? "جزوه"}.pdf` },
      { caption: "📕 جزوهٔ این جلسه" },
    ).catch((e: unknown) => logger.warn({ err: String(e) }, "deliver pdf failed"));
  }
  if (s.transcript_txt) {
    await sendFileTo(
      ch.api,
      ch.chatId,
      ch.platform,
      "sendDocument",
      { bytes: Buffer.from(s.transcript_txt, "utf8"), filename: "رونوشت کامل.txt" },
      { caption: "📄 رونوشت کامل با مهر زمانی" },
    ).catch((e: unknown) => logger.warn({ err: String(e) }, "deliver transcript failed"));
  }

  logger.info({ sessionId: s.id, userId, platform: ch.platform }, "delivered to bot");
  return true;
}
