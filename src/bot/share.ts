import { InlineKeyboard, InputFile, type Api, type Context } from "grammy";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { escapeHtml } from "../util/text.js";
import { fmtDuration, toFaDigits } from "../util/time.js";
import { getCourse, getSession, sessionReport, updateSession, type SessionRow } from "../db/index.js";
import { InsufficientCredit } from "../billing/ledger.js";
import {
  AlreadyMember,
  NotShareable,
  fairShare,
  joinSession,
  members,
  shareStatus,
} from "../billing/sharing.js";
import * as S from "./strings.js";

let botUsername: string | null = null;

export async function shareLink(api: Api, sessionId: string): Promise<string> {
  botUsername ??= (await api.getMe()).username;
  return `https://t.me/${botUsername}?start=j_${sessionId}`;
}

/** پیام دعوتی که فرستنده در گروه درس فوروارد می‌کند. */
export async function invitationMessage(api: Api, s: SessionRow): Promise<string> {
  const link = await shareLink(api, s.id);
  const st = shareStatus(s.id);
  const course = s.course_id ? getCourse(s.course_id) : null;
  const nextShare = st ? st.nextShareSec : Math.round(s.original_ms / 1000);

  return [
    `📓 <b>${escapeHtml(s.title ?? "جلسهٔ کلاس")}</b>`,
    course ? `<i>${escapeHtml(course.name)}</i>` : "",
    "",
    `صوت این جلسه تحلیل شده: خلاصه، نکات امتحانی با ذکر منبع${s.pdf_path ? "، و جزوهٔ کامل PDF" : ""}.`,
    "",
    `👥 تا الان <b>${toFaDigits(st?.memberCount ?? 1)}</b> نفر برداشته‌اند.`,
    `سهم نفر بعدی: <b>${fmtDuration(nextShare * 1000)}</b> اعتبار`,
    "",
    "<i>هرچه بیشتر باشیم سهم هرکس کمتر می‌شود و به قبلی‌ها برمی‌گردد — چون جلسه فقط یک بار پردازش شده.</i>",
    "",
    link,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function shareToggleKeyboard(sessionId: string, enabled: boolean): InlineKeyboard {
  return new InlineKeyboard().text(
    enabled ? "🔗 دریافت لینک دعوت" : "👥 اشتراک‌گذاری با هم‌کلاسی‌ها",
    enabled ? `slink:${sessionId}` : `son:${sessionId}`,
  );
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
    "<b>با پیوستن اینها را می‌گیری</b>",
    "• کلاس در یک نگاه",
    `• ${toFaDigits(r?.key_points.length ?? 0)} نکتهٔ امتحانی با ذکر منبع`,
    `• ${toFaDigits(r?.topics.length ?? 0)} سرفصل با زمان`,
    s.pdf_path ? "• جزوهٔ کامل PDF" : "",
    "• فایل صوتی و رونوشت کامل",
    "",
    `👥 تا الان ${toFaDigits(st.memberCount)} نفر`,
    `💳 سهم تو: <b>${fmtDuration(st.nextShareSec * 1000)}</b> اعتبار`,
    "",
    `<i>هزینهٔ کل این جلسه ${fmtDuration(st.costSec * 1000)} بود و بین همه تقسیم می‌شود. با پیوستن تو، سهم هرکس به ${fmtDuration(st.nextShareSec * 1000)} می‌رسد و مابه‌التفاوت به قبلی‌ها برمی‌گردد.</i>`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  return {
    text,
    keyboard: new InlineKeyboard()
      .text(`✅ مشارکت و دریافت`, `jdo:${s.id}`)
      .row()
      .text("انصراف", `jno:${s.id}`),
  };
}

/**
 * تحویل کامل یک جلسه به کسی که تازه پیوسته.
 *
 * صوت با `file_id` دوباره فرستاده می‌شود — تلگرام فایل را نگه داشته، پس نه
 * آپلودی لازم است نه فضایی. بدون این کار، زمان‌های داخل پیام‌ها برای او لینک
 * پخش نمی‌شوند، چون لینک‌شدن به ریپلای‌بودن روی صوتِ *همان چت* وابسته است.
 */
export async function deliverSession(ctx: Context, s: SessionRow): Promise<void> {
  const r = sessionReport(s);
  if (!r) throw new Error("تحلیل این جلسه در دسترس نیست.");
  const course = s.course_id ? getCourse(s.course_id) : null;

  let audioMessageId: number | null = null;
  if (s.audio_file_id) {
    const sent = await ctx
      .replyWithAudio(s.audio_file_id, {
        caption: `🎧 ${escapeHtml(s.title ?? "صوت جلسه")}`,
        parse_mode: "HTML",
      })
      .catch((e: unknown) => {
        logger.warn({ err: String(e) }, "resend audio failed");
        return null;
      });
    audioMessageId = sent?.message_id ?? null;
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

  await send(
    S.overviewMessage({
      report: r,
      courseName: course?.name ?? null,
      sessionDate: s.session_date,
      durationMs: s.original_ms,
      savedMs: Math.max(0, s.original_ms - s.billed_ms),
      qualityWarnings: [],
    }),
  );
  await send(S.keyPointsMessage(r, linkable), asReply);

  if (s.pdf_path) {
    await ctx
      .replyWithDocument(new InputFile(s.pdf_path), { caption: "📕 جزوهٔ کامل این جلسه" })
      .catch(() => {});
  }
  if (s.transcript_txt) {
    await ctx
      .replyWithDocument(new InputFile(Buffer.from(s.transcript_txt, "utf8"), "رونوشت کامل.txt"), {
        caption: "📄 رونوشت کامل با مهر زمانی",
      })
      .catch(() => {});
  }
}

export interface JoinOutcome {
  ok: boolean;
  message: string;
  session?: SessionRow;
}

/** پیوستن + تحویل. پیام‌های بازپرداخت به اعضای قبلی هم از اینجا می‌رود. */
export async function handleJoin(ctx: Context, sessionId: string): Promise<JoinOutcome> {
  const tgId = ctx.from!.id;
  let result;
  try {
    result = joinSession(sessionId, tgId);
  } catch (e) {
    if (e instanceof AlreadyMember) {
      const s = getSession(sessionId);
      if (s) await deliverSession(ctx, s);
      return { ok: true, message: "این جلسه از قبل مال توست — دوباره برایت فرستادم." };
    }
    if (e instanceof InsufficientCredit) {
      return {
        ok: false,
        message:
          `اعتبارت کافی نیست.\n\nسهم این جلسه <b>${fmtDuration(e.needed * 1000)}</b> است ` +
          `ولی <b>${fmtDuration(e.balance * 1000)}</b> داری.\n\n/credit`,
      };
    }
    if (e instanceof NotShareable) return { ok: false, message: e.message };
    throw e;
  }

  const s = getSession(sessionId)!;
  await deliverSession(ctx, s);

  // به اعضای قبلی خبر بده که سهمشان برگشت — این همان چیزی است که آدم را
  // ترغیب می‌کند لینک را پخش کند، پس باید دیده شود.
  for (const rf of result.refunds) {
    await ctx.api
      .sendMessage(
        rf.tgId,
        `💰 <b>${fmtDuration(rf.amountSec * 1000)}</b> اعتبار به تو برگشت.\n\n` +
          `یک نفر دیگر به جلسهٔ «${escapeHtml(s.title ?? "کلاس")}» پیوست، ` +
          `پس سهم هرکس به ${fmtDuration(result.shareSec * 1000)} رسید. ` +
          `الان ${toFaDigits(result.memberCount)} نفرید.`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
  }

  return {
    ok: true,
    message:
      `✅ جلسه برایت باز شد. <b>${fmtDuration(result.chargedSec * 1000)}</b> اعتبار کم شد — ` +
      `سهم ${toFaDigits(result.memberCount)} نفره.`,
    session: s,
  };
}

/** فرستنده پس از اتمام کار، به‌عنوان مالک با کل هزینه ثبت می‌شود. */
export function enableSharing(sessionId: string): void {
  updateSession(sessionId, {});
  const list = members(sessionId);
  logger.debug({ sessionId, members: list.length }, "sharing enabled");
}

export { fairShare, shareStatus, config };
