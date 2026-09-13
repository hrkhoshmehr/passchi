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
import { InlineKeyboard, type Api } from "grammy";
import { sendFileTo } from "./bale-upload.js";
import { config } from "../config.js";
import { audioExt } from "../audio/container.js";
import { logger } from "../util/logger.js";
import { escapeHtml, transcriptBytes } from "../util/text.js";
import { transcodeForTelegram } from "../audio/ffmpeg.js";
import {
  getCourse, getUser, memberDelivery, sessionReport, updateSession, type SessionRow,
} from "../db/index.js";
import type { Platform } from "../db/identity.js";
import { deliveryChannel } from "./notify.js";
import { invitationMessage, shareToggleKeyboard } from "./share.js";
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

/* ─── چیزهای پشتِ دکمه ────────────────────────────────────────────────────── */

/**
 * پیشوندِ کال‌بکِ هر بخشِ به‌تعویق‌افتاده.
 *
 * کوتاه‌اند چون `callback_data` تلگرام شصت‌وچهار بایت بیشتر نیست و شناسهٔ
 * جلسه هم در همان رشته می‌آید.
 */
export const MORE_CB = {
  timeline: "dtl",
  transcript: "dtx",
  srt: "dsrt",
} as const;

export type MorePart = keyof typeof MORE_CB;

/** از پیشوندِ کال‌بک به نام بخش — تا هندلر یک `switch` دستی نداشته باشد. */
export const MORE_PART_OF: Record<string, MorePart> = Object.fromEntries(
  Object.entries(MORE_CB).map(([part, cb]) => [cb, part as MorePart]),
) as Record<string, MorePart>;

/** مقصدِ ارسال، وقتی `Context` در کار نیست — همان شکلی که `deliveryChannel` می‌دهد. */
export interface SendTarget {
  api: Api;
  chatId: number;
  platform: Platform;
  /**
   * چه کسی دکمه را زده — مالک یا هم‌کلاسیِ عضو.
   *
   * لازم است چون هرکدام صوتِ جلسه را در چتِ خودش با شناسهٔ پیامِ متفاوت دارد؛
   * `reportReplyTo` از همین می‌فهمد ریپلایِ کدام پیام باشد.
   */
  viewerId?: number;
}

/**
 * رونوشت: PDF اگر هست، وگرنه متن خام. دلیلِ ترجیحِ PDF در `pdf/transcript.ts`.
 *
 * `null` یعنی هیچ‌کدام نمانده — فایل reap شده یا اصلاً ساخته نشده.
 */
function transcriptSource(
  s: SessionRow,
): { path: string; filename: string } | { bytes: Buffer; filename: string } | null {
  if (s.transcript_pdf && fs.existsSync(s.transcript_pdf)) {
    return { path: s.transcript_pdf, filename: "رونوشت کامل.pdf" };
  }
  if (s.transcript_txt) return { bytes: transcriptBytes(s.transcript_txt), filename: "رونوشت کامل.txt" };
  return null;
}

/** کدام بخش‌ها **همین حالا** واقعاً چیزی برای دادن دارند. */
export function moreParts(s: SessionRow): MorePart[] {
  const out: MorePart[] = [];
  const r = sessionReport(s);
  if (r && r.chapters.length > 0) out.push("timeline");
  if (transcriptSource(s)) out.push("transcript");
  if (s.transcript_srt && fs.existsSync(s.transcript_srt)) out.push("srt");
  return out;
}

/**
 * صفحه‌کلیدِ بخش‌های به‌تعویق‌افتاده — یا `null` اگر هیچ‌کدام نیست.
 *
 * هر دکمه ردیف خودش را دارد و هیچ `row()` انتهایی زده نمی‌شود: ردیف خالی را
 * تلگرام رد می‌کند و کل پیام از دست می‌رود.
 */
export function moreKeyboard(s: SessionRow): InlineKeyboard | null {
  const parts = moreParts(s);
  if (parts.length === 0) return null;
  const kb = new InlineKeyboard();
  parts.forEach((p, i) => {
    if (i) kb.row();
    kb.text(S.MORE_BTN[p], `${MORE_CB[p]}:${s.id}`);
  });
  return kb;
}

/**
 * صفحه‌کلیدِ پیامِ پایانی — تسویه و بخش‌های بایگانی، زیر **یک** پیام.
 *
 * این دو مستقل ساخته شدند و کنار هم دو پیامِ متنیِ پشت‌سرهم در انتهای تحویل
 * می‌ساختند: یکی «چیز دیگری هم هست» و یکی «چقدر کم شد». هیچ‌کدام به‌تنهایی
 * پیام کاملی نبود و کاربر آخرِ کار دو پیامِ نیمه می‌دید — یعنی همان شلوغی که
 * قرار بود با دکمه‌ای‌کردن کم شود، از راه دیگری برمی‌گشت.
 *
 * ترتیب سطرها عمدی است: تقسیم هزینه اول، چون کارِ همین حالاست؛ رونوشت و
 * زیرنویس بعد، چون بایگانی‌اند.
 */
export function closingKeyboard(s: SessionRow, shareOn: boolean): InlineKeyboard {
  const kb = shareToggleKeyboard(s.id, shareOn);
  const more = moreKeyboard(s);
  if (more) kb.inline_keyboard.push(...more.inline_keyboard);
  return kb;
}

/**
 * ریپلای به صوتی که گزارشِ این جلسه به آن آویزان است.
 *
 * این تنها راهِ زنده‌نگه‌داشتنِ زمان‌هاست وقتی بخش‌بندی دقایقی — یا هفته‌ها —
 * بعد از خودِ صوت فرستاده می‌شود: تلگرام `MM:SS` را فقط داخل پیامی که
 * ریپلایِ یک صوتِ **همان چت** است به لینکِ پخش تبدیل می‌کند.
 *
 * **یک جفت ستون، و بس.** دو مسیرِ تحویل دو صوتِ متفاوت دارند — در مسیر ربات
 * صوت را خودِ کاربر فرستاده و در مسیر مینی‌اپ ما — ولی هر دو همان یک پرسش را
 * جواب می‌دهند و جواب را در `delivered_chat_id`/`delivered_audio_message_id`
 * می‌نویسند. اگر هرکدام میدان خودش را می‌خواند، همان دوتکه‌شدنی تکرار می‌شد
 * که این بازنویسی برای بستنش انجام شد.
 *
 * شرطِ چت جدی است. عضوی که جلسه با او تقسیم شده دکمه را در چتِ خودش می‌زند و
 * آن شناسهٔ پیام آنجا یا وجود ندارد یا پیامِ دیگری است؛ پس بی‌ریپلای فرستاده
 * می‌شود و زمان‌ها متن ساده می‌مانند — که بدترین حالتش «کمی کمتر» است، نه
 * ریپلای به پیامِ اشتباه.
 */
export function reportReplyTo(
  s: SessionRow,
  chatId: number,
  viewerId?: number,
): Record<string, unknown> {
  const replyTo = (messageId: number) => ({
    reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
  });

  /**
   * **هم‌کلاسی جفتِ خودش را دارد** — کنارِ عضویتش در `session_members`.
   *
   * جلسه‌ای که با عضو تقسیم شده، صوتش را در چتِ خودِ عضو و با شناسهٔ پیامِ
   * دیگری می‌گیرد؛ آن پاسخ آنجا نوشته شده. اگر عضو جفتی ندارد (صوت نرسید، یا
   * پیش از این تغییر گرفته) بی‌ریپلای می‌رود و **هرگز** به جفتِ مالک برنمی‌گردد:
   * جلسه‌های قدیمی `delivered_chat_id` تهی دارند و شرطِ چتِ پایین آن را
   * نمی‌گیرد — یعنی شناسهٔ پیامِ مالک در چتِ عضو به پیامِ بی‌ربطی می‌چسبید.
   */
  if (viewerId !== undefined && viewerId !== s.tg_id) {
    const mine = memberDelivery(s.id, viewerId);
    return mine?.audioMessageId && mine.chatId === chatId ? replyTo(mine.audioMessageId) : {};
  }

  if (!s.delivered_audio_message_id) return {};
  if (s.delivered_chat_id !== null && s.delivered_chat_id !== chatId) return {};
  return replyTo(s.delivered_audio_message_id);
}

/**
 * یکی از بخش‌های پشتِ دکمه را بفرست.
 *
 * `false` یعنی چیزی برای فرستادن نبود یا نرفت — و صدازننده باید یک جملهٔ
 * روشن به کاربر بدهد. هیچ خطایی بیرون نمی‌زند: دکمه‌ای که هفته‌ها بعد زده
 * می‌شود روی فایلی که reap شده نباید هندلر را بترکاند.
 */
export async function sendMorePart(to: SendTarget, s: SessionRow, part: MorePart): Promise<boolean> {
  if (part === "timeline") {
    const r = sessionReport(s);
    const asReply = reportReplyTo(s, to.chatId, to.viewerId);
    // زدنی‌بودنِ زمان‌ها قابلیتِ تلگرام است؛ بله ندارد و نباید وعده‌اش را بخواند.
    const linkable = "reply_parameters" in asReply && to.platform === "telegram";
    const text = r ? S.timelineMessage(r, linkable) : "";
    if (!text) return false;
    let ok = true;
    for (const chunk of S.chunk(text)) {
      await to.api
        .sendMessage(to.chatId, chunk, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...asReply,
        })
        .catch((e: unknown) => {
          ok = false;
          logger.warn({ sessionId: s.id, err: String(e) }, "deferred timeline failed");
        });
    }
    return ok;
  }

  const source =
    part === "transcript"
      ? transcriptSource(s)
      : s.transcript_srt && fs.existsSync(s.transcript_srt)
        ? ({ path: s.transcript_srt, filename: "رونوشت زمان‌دار.srt" } as const)
        : null;
  if (!source) return false;

  // از `sendFileTo` و نه `InputFile` خام: روی بله ارجاعِ `attach://` رد می‌شود
  // و کاربر بی‌صدا چیزی نمی‌گیرد.
  return await sendFileTo(to.api, to.chatId, to.platform, "sendDocument", source, {
    caption: part === "transcript" ? S.CAPTION.transcript : S.CAPTION.srt,
  })
    .then(() => true)
    .catch((e: unknown) => {
      logger.warn({ sessionId: s.id, part, err: String(e) }, "deferred file failed");
      return false;
    });
}

/**
 * گزارش جلسه را به چتِ ربات بفرست.
 *
 * ترتیب عمدی است: اول صوت، بعد پیام‌های گزارش که **ریپلای همان صوت**اند.
 * تلگرام زمان‌ها را فقط در این حالت به لینک پخش تبدیل می‌کند.
 *
 * **چهار چیز می‌آید، سه چیز پشت دکمه می‌ماند.** پیش‌تر هر هفت‌تا پشت‌سرهم
 * می‌آمدند و نتیجه یک دیوار بود؛ حالا صوت و خلاصه و نکته‌ها و جزوه می‌رسند و
 * بخش‌بندی زمانی و رونوشت و SRT پشت دکمه‌های آخرین پیام‌اند.
 *
 * دکمه‌ها روی یک پیام کوتاهِ جداگانه می‌نشینند، نه روی خودِ جزوه: زدنِ
 * `reply_markup` روی مسیر آپلودِ دستیِ بله آزموده نشده، و اگر آنجا رد شود
 * **جزوه** از دست می‌رود — همان باگی که یک بار افتاد. یک پیام متنیِ اضافه
 * ارزان‌تر از آن ریسک است.
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
        { path: audio.file, filename: `${s.title ?? "جلسه"}${audioExt(audio.file)}` },
        {
          caption: `🎧 ${escapeHtml(s.title ?? "صوت جلسه")}`,
          ...(s.title ? { title: s.title } : {}),
          /**
           * مدت **صریح** گفته می‌شود، نه اینکه به تشخیصِ تلگرام سپرده شود.
           *
           * برای فایلی که ظرفش با پسوندش نمی‌خواند، تلگرام مدت را صفر
           * برمی‌گرداند — و صوتِ با مدتِ صفر نه پخش می‌شود نه زمان‌های گزارش
           * را به لینکِ پخش تبدیل می‌کند. پسوند که با `audioExt` درست شد این
           * را حل می‌کند، ولی عددی که خودمان داریم ارزان‌تر و قطعی‌تر است.
           */
          ...(s.original_ms > 0 ? { duration: Math.round(s.original_ms / 1000) } : {}),
        },
      );
      audioMessageId = sent?.message_id ?? null;
      // `file_id` نگه داشته می‌شود تا دفعهٔ بعد (اشتراک‌گذاری، تاریخچه) آپلود
      // دوباره لازم نباشد.
      //
      // و شناسهٔ همین پیام هم ذخیره می‌شود: بخش‌بندی زمانی پشت دکمه رفته و
      // وقتی زده شود باید **ریپلای همین صوت** باشد، وگرنه زمان‌هایش دیگر
      // لینکِ پخش نیستند. در حافظه نگه‌داشتنش کافی نیست چون دکمه ممکن است
      // بعد از ری‌استارتِ سرویس زده شود.
      updateSession(s.id, {
        ...(sent?.fileId ? { audio_file_id: sent.fileId } : {}),
        ...(audioMessageId !== null
          ? { delivered_chat_id: ch.chatId, delivered_audio_message_id: audioMessageId }
          : {}),
      });
    } catch (e) {
      logger.warn({ sessionId: s.id, err: String(e) }, "deliver audio failed");
    } finally {
      if (audio.temp) fs.promises.unlink(audio.file).catch(() => {});
    }
  }

  const asReply = audioMessageId
    ? { reply_parameters: { message_id: audioMessageId, allow_sending_without_reply: true } }
    : {};
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
  // بخش‌بندی زمانی دیگر اینجا نمی‌آید؛ پشت دکمه رفته و آنجا هم ریپلایِ همین
  // صوت فرستاده می‌شود تا زمان‌هایش لینکِ پخش بمانند.
  await send(S.extractedMessage(r), asReply);
  // خالی برمی‌گردد وقتی این جلسه پاسِ پرسش و پاسخ نداشته — پیش‌فرض خاموش است
  // و آن‌وقت `send` رشتهٔ خالی را همان اول رد می‌کند. جایش کنارِ نکته‌هاست نه
  // پشتِ دکمه: محتوای درسی است، نه بایگانی.
  await send(S.qaMessage(r), asReply);

  if (s.pdf_path && fs.existsSync(s.pdf_path)) {
    await sendFileTo(
      ch.api,
      ch.chatId,
      ch.platform,
      "sendDocument",
      { path: s.pdf_path, filename: `${s.title ?? "جزوه"}.pdf` },
      { caption: S.CAPTION.notes },
    ).catch((e: unknown) => logger.warn({ err: String(e) }, "deliver pdf failed"));
  }

  /**
   * آخرین پیامِ فوری: دکمه‌های بایگانی.
   *
   * سطرِ جلسه دوباره از حافظه ساخته نمی‌شود — `s` همان است — ولی شناسهٔ صوتِ
   * تحویل تازه در پایگاه‌داده نشسته و هندلرِ دکمه خودش سطر را تازه می‌خواند،
   * پس اینجا لازم نیست.
   */
  /**
   * تسویه و **تقسیم با هم‌کلاسیا** — که تا امروز روی این مسیر اصلاً نبود.
   *
   * کاربری که از مینی‌اپ می‌آمد نه می‌فهمید چقدر برایش مانده و نه هیچ‌وقت
   * پیشنهاد تقسیم را می‌دید: آن دکمه فقط در `sendResults` مسیر ربات بود. یعنی
   * برای کاربر بله — که به‌خاطر سقف بیست مگابایت اغلب از مینی‌اپ می‌آید —
   * کلِ اقتصادِ اشتراک خاموش بود.
   *
   * اگر کاربر سرِ تأییدِ هزینه گفته باشد «تقسیم می‌کنم»، لینک دعوت هم همین‌جا
   * می‌آید و لازم نیست دکمه‌ای بزند.
   */
  const u = getUser(userId);
  const shareOn = Boolean(s.share_enabled);
  const closing = closingKeyboard(s, shareOn);
  const closingText = u
    ? S.settlementMessage(Math.round(s.original_ms / 1000), u.credit_sec, shareOn, {
        people: s.share_target,
        hasArchive: moreKeyboard(s) !== null,
      })
    : S.MORE_PROMPT;
  if (u || moreKeyboard(s)) {
    await ch.api
      .sendMessage(ch.chatId, closingText, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: closing,
      })
      .catch((e: unknown) => logger.warn({ err: String(e) }, "deliver settlement failed"));
  }
  if (shareOn) {
    await ch.api
      .sendMessage(ch.chatId, await invitationMessage(ch.api, s), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      })
      .catch((e: unknown) => logger.warn({ err: String(e) }, "deliver invitation failed"));
  }

  logger.info({ sessionId: s.id, userId, platform: ch.platform }, "delivered to bot");
  return true;
}
