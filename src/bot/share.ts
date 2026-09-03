import fs from "node:fs";
import { InlineKeyboard, type Api, type Context } from "grammy";
import { sendDoc, sendFileTo } from "./bale-upload.js";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { escapeHtml } from "../util/text.js";
import { fmtDuration, toFaDigits } from "../util/time.js";
import { fmtCost } from "../billing/coins.js";
import { getCourse, getSession, sessionReport, updateSession, type SessionRow } from "../db/index.js";
import { InsufficientCredit } from "../billing/ledger.js";
import {
  AlreadyMember,
  NotShareable,
  joinSession,
  members,
  shareStatus,
} from "../billing/sharing.js";
import * as S from "./strings.js";
import { isBale, platformOf, uid } from "./identity.js";

/**
 * نام کاربری ربات، **به تفکیک سکو**.
 *
 * پیش از این یک متغیر تکی بود و اولین سکویی که صدا می‌زد آن را پر می‌کرد؛
 * از آن به بعد کاربر بله لینکی با نام کاربری تلگرام می‌گرفت (یا برعکس).
 * روی این پروژه هر دو ربات یک نام دارند، پس هیچ‌وقت دیده نمی‌شد — و روزی
 * که نام‌ها فرق کنند بی‌صدا می‌شکست.
 */
const usernames: { telegram: string | null; bale: string | null } = {
  telegram: null,
  bale: null,
};

/**
 * لینک دعوت، روی دامنهٔ همان سکو.
 *
 * **`t.me` داخل بله باز نمی‌شود.** لینک سفت‌شده یعنی هر کاربر بله که جلسه‌اش
 * را با هم‌کلاسی‌ها به اشتراک می‌گذاشت، لینکی می‌فرستاد که برای گیرنده‌ها
 * بن‌بست بود — و چون خودِ فرستنده رویش کلیک نمی‌کند، هیچ‌کس گزارش نمی‌داد.
 *
 * همان قاعدهٔ `links.ts`: دامنه از سکو می‌آید، نه از ثابتِ کد.
 */
export async function shareLink(api: Api, sessionId: string): Promise<string> {
  const platform = isBale(api) ? "bale" : "telegram";
  usernames[platform] ??= (await api.getMe()).username ?? null;
  const host = platform === "bale" ? "https://ble.ir" : "https://t.me";
  return `${host}/${usernames[platform]}?start=j_${sessionId}`;
}

/** پیام دعوتی که فرستنده در گروه درس فوروارد می‌کند. */
export async function invitationMessage(api: Api, s: SessionRow): Promise<string> {
  const link = await shareLink(api, s.id);
  const st = shareStatus(s.id);
  const course = s.course_id ? getCourse(s.course_id) : null;
  const seat = st ? st.seatSec : Math.round(s.original_ms / 1000);
  const taken = toFaDigits(st?.memberCount ?? 0);

  return [
    `📓 <b>${escapeHtml(s.title ?? "جلسهٔ کلاس")}</b>`,
    course ? `<i>${escapeHtml(course.name)}</i>` : "",
    "",
    `خلاصهٔ کلاس، نکات امتحانی با عین حرف استاد${s.pdf_path ? "، و جزوهٔ کامل PDF" : ""}.`,
    "",
    st?.capReached
      ? `👥 ${taken} نفر برداشتن · <b>رایگان</b> — هزینه‌اش قبلاً حساب شده`
      : `👥 ${taken} نفر برداشتن · سهم تو: <b>${fmtCost(seat)}</b>`,
    "",
    "<i>سهم هرکس ثابته. وقتی نصف هزینه برگشت، بقیه رایگان می‌گیرنش.</i>",
    "",
    link,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function shareToggleKeyboard(sessionId: string, enabled: boolean): InlineKeyboard {
  return new InlineKeyboard().text(
    enabled ? "🔗 لینک دعوت" : "👥 تقسیم با هم‌کلاسیا",
    enabled ? `slink:${sessionId}` : `son:${sessionId}`,
  );
}

/** انتخابِ تعدادِ کلاس — سهمِ ثابتِ هر نفر از همین درمی‌آید. */
export function shareTargetKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("۱ نفر", `sont:${sessionId}:1`)
    .text("۵ نفر", `sont:${sessionId}:5`)
    .row()
    .text("۱۰ نفر", `sont:${sessionId}:10`)
    .text("۲۰ نفر", `sont:${sessionId}:20`);
}

/** پیش‌نمایشی که تازه‌وارد پیش از پرداخت می‌بیند. */
export function joinPreview(s: SessionRow): { text: string; keyboard: InlineKeyboard } | null {
  const st = shareStatus(s.id);
  if (!st) return null;
  const r = sessionReport(s);
  const course = s.course_id ? getCourse(s.course_id) : null;

  const text = [
    `📓 <b>${escapeHtml(s.title ?? "جلسهٔ کلاس")}</b>`,
    course ? `<i>${escapeHtml(course.name)} · ${fmtDuration(s.original_ms)}</i>` : "",
    "",
    r?.headline ? escapeHtml(r.headline) : "",
    "",
    "<b>چی گیرت میاد</b>",
    "• خلاصهٔ کلاس در یک نگاه",
    `• ${toFaDigits(r?.key_points.length ?? 0)} نکتهٔ امتحانی با عین حرف استاد`,
    s.pdf_path ? "• جزوهٔ کامل PDF" : "",
    "• صوت و رونوشت کامل",
    "",
    st.capReached
      ? `👥 ${toFaDigits(st.memberCount)} نفر برداشتن · سهم تو <b>رایگان</b> — هزینه‌اش قبلاً حساب شده`
      : `👥 ${toFaDigits(st.memberCount)} نفر برداشتن · سهم تو <b>${fmtCost(st.seatSec)}</b>`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  return {
    text,
    keyboard: new InlineKeyboard()
      .text(st.capReached ? "✅ رایگان برش می‌دارم" : "✅ برش می‌دارم", `jdo:${s.id}`)
      .row()
      .text("فعلاً نه", `jno:${s.id}`),
  };
}

/**
 * تحویل کامل یک جلسه به کسی که تازه پیوسته.
 *
 * صوت با `file_id` دوباره فرستاده می‌شود — سکو فایل را نگه داشته، پس نه
 * آپلودی لازم است نه فضایی. بدون این کار، زمان‌های داخل پیام‌ها برای او لینک
 * پخش نمی‌شوند، چون لینک‌شدن به ریپلای‌بودن روی صوتِ *همان چت* وابسته است.
 *
 * **`file_id` بین دو سکو قابل حمل نیست.** جلسه‌ای که در تلگرام ساخته شده
 * `file_id` تلگرامی دارد و بله آن را نمی‌شناسد (و برعکس) — و لینک دعوت
 * می‌تواند از هر سکویی باز شود. پیش از این فقط یک `warn` در لاگ می‌نشست و
 * کاربر بی‌صدا هم صوت را از دست می‌داد و هم لینک‌شدن زمان‌ها را؛ یعنی
 * مهم‌ترین قابلیت گزارش، بدون هیچ نشانه‌ای برای او خاموش می‌شد.
 *
 * پس اگر `file_id` نگرفت، از فایل روی دیسک آپلود می‌شود و `file_id` تازه
 * جایگزین می‌شود. فایل تا `KEEP_AUDIO_DAYS` می‌ماند؛ بعد از آن دیگر کاری
 * نمی‌شود کرد و بدون صوت جلو می‌رویم.
 */
export async function deliverSession(ctx: Context, s: SessionRow): Promise<void> {
  const r = sessionReport(s);
  if (!r) throw new Error("تحلیل این جلسه در دسترس نیست.");
  const course = s.course_id ? getCourse(s.course_id) : null;

  const caption = `🎧 ${escapeHtml(s.title ?? "صوت جلسه")}`;
  let audioMessageId: number | null = null;

  if (s.audio_file_id) {
    const sent = await ctx
      .replyWithAudio(s.audio_file_id, { caption, parse_mode: "HTML" })
      .catch((e: unknown) => {
        logger.warn(
          { sessionId: s.id, err: String(e) },
          "resend audio by file_id failed — will try the file on disk",
        );
        return null;
      });
    audioMessageId = sent?.message_id ?? null;
  }

  // فایل روی دیسک، وقتی `file_id` کار نکرد یا اصلاً نبود
  if (audioMessageId === null && s.original_file && fs.existsSync(s.original_file)) {
    try {
      const sent = await sendFileTo(
        ctx.api,
        ctx.chat!.id,
        platformOf(ctx),
        "sendAudio",
        { path: s.original_file, filename: `${s.title ?? "جلسه"}.mp3` },
        { caption, ...(s.title ? { title: s.title } : {}) },
      );
      audioMessageId = sent?.message_id ?? null;
      // `file_id` تازه مالِ سکوی همین کاربر است و دفعهٔ بعد کار می‌کند.
      if (sent?.fileId) updateSession(s.id, { audio_file_id: sent.fileId });
    } catch (e) {
      logger.warn({ sessionId: s.id, err: String(e) }, "resend audio from disk failed");
    }
  }

  const asReply = audioMessageId
    ? { reply_parameters: { message_id: audioMessageId, allow_sending_without_reply: true } }
    : {};
  const linkable = audioMessageId !== null;

  const send = async (text: string, extra: Record<string, unknown> = {}) => {
    if (!text) return;
    for (const part of S.chunk(text)) {
      await ctx.reply(part, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
    }
  };

  // همان سه پیامی که فرستندهٔ اصلی گرفت، به همان ترتیب
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

  // `sendDoc` مسیر بله را دستی می‌فرستد و خطا را لاگ می‌کند؛ توضیح در
  // `bale-upload.ts`. پیش‌تر اینجا `.catch(() => {})` بود و کاربر بله جزوه و
  // رونوشتِ جلسهٔ اشتراکی را بی‌صدا از دست می‌داد.
  if (s.pdf_path) {
    await sendDoc(ctx, s.pdf_path, "جزوه.pdf", { caption: "📕 جزوهٔ این جلسه" });
  }
  if (s.transcript_txt) {
    await sendDoc(ctx, Buffer.from(s.transcript_txt, "utf8"), "رونوشت کامل.txt", {
      caption: "📄 رونوشت کامل با مهر زمانی",
    });
  }
}

export interface JoinOutcome {
  ok: boolean;
  message: string;
  session?: SessionRow;
}

/** برداشتن + تحویل. خبرِ بازگشتِ سهم به مالک هم از اینجا می‌رود. */
export async function handleJoin(ctx: Context, sessionId: string): Promise<JoinOutcome> {
  const tgId = uid(ctx);
  let result;
  try {
    result = joinSession(sessionId, tgId);
  } catch (e) {
    if (e instanceof AlreadyMember) {
      const s = getSession(sessionId);
      if (s) await deliverSession(ctx, s);
      return { ok: true, message: "این جلسه از قبل مال خودته — دوباره فرستادم 👍" };
    }
    if (e instanceof InsufficientCredit) {
      return { ok: false, message: S.lowBalanceMessage(e.needed, e.balance) };
    }
    if (e instanceof NotShareable) return { ok: false, message: e.message };
    throw e;
  }

  const s = getSession(sessionId)!;
  await deliverSession(ctx, s);

  // خبر به مالک که سهمش برگشت — این همان چیزی است که آدم را ترغیب می‌کند
  // لینک را پخش کند، پس باید دیده شود.
  if (result.ownerRefundSec > 0) {
    const tail = result.capJustReached
      ? `\n\n<b>نصفِ هزینه برگشت.</b> از این به بعد هم‌کلاسی‌ها رایگان برش می‌دارن.`
      : "";
    await ctx.api
      .sendMessage(
        result.ownerTgId,
        `💰 <b>${fmtCost(result.ownerRefundSec)}</b> برگشت به حسابت!\n\n` +
          `یکی «${escapeHtml(s.title ?? "کلاس")}» رو برداشت.${tail}`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
  }

  return {
    ok: true,
    message: result.free
      ? "✅ گرفتیش! سهم تو ۰ — هزینهٔ این جلسه قبلاً حساب شده."
      : `✅ گرفتیش! <b>${fmtCost(result.chargedSec)}</b> کم شد.`,
    session: s,
  };
}

/** فرستنده پس از اتمام کار، به‌عنوان مالک با کل هزینه ثبت می‌شود. */
export function enableSharing(sessionId: string): void {
  updateSession(sessionId, {});
  const list = members(sessionId);
  logger.debug({ sessionId, members: list.length }, "sharing enabled");
}

export { shareStatus, config };
