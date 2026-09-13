import fs from "node:fs";
import { InlineKeyboard, type Api, type Context } from "grammy";
import { sendDoc, sendFileTo } from "./bale-upload.js";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { escapeHtml } from "../util/text.js";
import { audioExt } from "../audio/container.js";
import { fmtDuration, toFaDigits } from "../util/time.js";
import { fmtToman, shareCountsFor } from "../billing/money.js";
import {
  getCourse, getSession, rememberPendingJoin, sessionReport, setMemberDelivery, updateSession, type SessionRow,
} from "../db/index.js";
import { moreKeyboard, reportReplyTo, sendWithKeyboard } from "./deliver.js";
import { InsufficientCredit } from "../billing/ledger.js";
import {
  AlreadyMember,
  GiftBudgetExhausted,
  NotShareable,
  joinSession,
  members,
  shareStatus,
} from "../billing/sharing.js";
import * as S from "./strings.js";
import { notifyUser } from "./notify.js";
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
  return startLink(api, `j_${sessionId}`);
}

/**
 * لینکِ `/start` با هر پیشوندی، روی دامنهٔ همان سکو.
 *
 * خرید گروهی (`p_`) همان مشکلِ لینک دعوت را دارد و نباید نسخهٔ دومی از این
 * قاعده بسازد که روزی از آن عقب بماند.
 */
export async function startLink(api: Api, payload: string): Promise<string> {
  const platform = isBale(api) ? "bale" : "telegram";
  usernames[platform] ??= (await api.getMe()).username ?? null;
  const host = platform === "bale" ? "https://ble.ir" : "https://t.me";
  return `${host}/${usernames[platform]}?start=${payload}`;
}

/**
 * هزینهٔ یک هم‌کلاسی، به زبانِ کسی که ربات را نمی‌شناسد.
 *
 * برای تازه‌وارد «۵ سکه» به‌تنهایی هیچ نمی‌گوید و به نظر پول می‌آید. ولی
 * واقعیت این است که هر حسابِ تازه `FREE_TRIAL_TOMAN` سکه هدیه می‌گیرد؛ اگر
 * سهم از آن کمتر است، عملاً چیزی از جیبش نمی‌رود — و این دقیقاً همان جمله‌ای
 * است که او را به زدنِ لینک راضی می‌کند.
 *
 * فقط وقتی گفته می‌شود که **واقعاً** درست است: سهمی بزرگ‌تر از هدیه، یا
 * سروری که هدیه را خاموش کرده، جمله‌ای ساده به سکه می‌گیرد نه وعده.
 */
function classmateCost(seat: number, capReached: boolean): string {
  if (capReached) return "💰 برای تو مجانیه؛ هزینه‌ش قبلاً جمع شده.";
  const gift = config.FREE_TRIAL_TOMAN;
  if (gift > 0 && seat <= gift) {
    return `💰 سهم هر نفر ${fmtToman(seat)}؛ هر کی تازه بیاد ${fmtToman(gift)} هدیه می‌گیره، پس برات مجانی درمیاد.`;
  }
  return `💰 سهم هر نفر ${fmtToman(seat)}.`;
}

/**
 * «n نفر تا حالا گرفتنش» — و **نه وقتی صفر است**.
 *
 * «۰ نفر برداشتن» روی کارتِ دعوت یعنی «هیچ‌کس اعتماد نکرده»؛ همان عددی که
 * قرار بود اعتبار بدهد، اولین خواننده را فراری می‌داد.
 */
function takenLine(memberCount: number): string {
  return memberCount > 0 ? `👥 ${toFaDigits(memberCount)} نفر تا حالا گرفتنش` : "";
}

/** پیام دعوتی که فرستنده در گروه درس فوروارد می‌کند. */
export async function invitationMessage(api: Api, s: SessionRow): Promise<string> {
  const link = await shareLink(api, s.id);
  const st = shareStatus(s.id);
  const course = s.course_id ? getCourse(s.course_id) : null;
  const seat = st?.seat ?? 0;

  return [
    `📓 <b>${escapeHtml(s.title ?? "جلسهٔ کلاس")}</b>`,
    course ? `<i>${escapeHtml(course.name)}</i>` : "",
    "",
    `خلاصهٔ کلاس، نکته‌های امتحانی با عین حرف استاد${s.pdf_path ? "، و فایل جزوه" : ""}.`,
    "",
    classmateCost(seat, Boolean(st?.capReached)),
    takenLine(st?.memberCount ?? 0),
    "",
    // لینک خطِ خودش را دارد: نشانیِ لاتین وسط خط فارسی روی گوشی جابه‌جا چیده می‌شود.
    link,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function shareToggleKeyboard(sessionId: string, enabled: boolean): InlineKeyboard {
  return new InlineKeyboard().text(
    enabled ? S.SHARE_BTN.link : S.SHARE_BTN.off,
    enabled ? `slink:${sessionId}` : `son:${sessionId}`,
  );
}

/** دکمهٔ «بی‌خیال» زیر پرسشِ تعداد — فقط پیام را برمی‌دارد، هیچ حالتی را عوض نمی‌کند. */
export const SHARE_CANCEL_CB = "shx";

/**
 * انتخابِ تعدادِ کلاس — سهمِ ثابتِ هر نفر از همین درمی‌آید.
 *
 * **گزینهٔ «۱ نفر» حذف شد و برنمی‌گردد.** سهم با آن نصفِ کلِ جلسه می‌شد
 * (۴۵ سکه روی یک کلاس ۹۰ دقیقه‌ای) و از هدیهٔ ۲۰ سکه‌ایِ تازه‌وارد بیشتر بود؛
 * یعنی همان دکمه‌ای که قرار بود کلاس را بیاورد، اولین نفر را بیرون می‌انداخت.
 * چراییِ کامل در `SHARE_TARGET_MIN`.
 *
 * `prefix` دو مسیر را از هم جدا می‌کند: `sont` انتخابِ **پس از تحویل** است و
 * بلافاصله لینک دعوت می‌فرستد، `sontp` انتخابِ **پیش از پرداخت** روی صفحهٔ
 * تأیید که هنوز نتیجه‌ای برای دعوت‌کردن ندارد.
 */
export function shareTargetKeyboard(
  sessionId: string,
  prefix: "sont" | "sontp",
  costToman: number,
): InlineKeyboard {
  /**
   * سهمِ هر نفر **روی خودِ دکمه**: «۵ نفر · نفری ۲۷٬۰۰۰ تومان».
   *
   * فقط تعدادهایی که سهمشان معنی دارد (`shareCountsFor`): «۳۰ نفر · نفری ۱ سکه»
   * روی فایلِ کوتاه دکمه نمی‌شود. همان `shareSeat` که `joinSession` با آن کم
   * می‌کند، پس دکمه و کسرِ واقعی از هم جدا نمی‌افتند.
   */
  const kb = new InlineKeyboard();
  shareCountsFor(costToman).forEach((n, i) => {
    if (i && i % 2 === 0) kb.row();
    kb.text(S.shareCountLabel(n, costToman), `${prefix}:${sessionId}:${n}`);
  });
  // راهِ بیرون‌آمدن بدون انتخاب — وگرنه تنها کارِ ممکن زدنِ یکی از چهار عدد بود.
  return kb.row().text("✖️ بی‌خیال", `${SHARE_CANCEL_CB}:${sessionId}`);
}

/**
 * پیش‌نمایشی که تازه‌وارد پیش از پرداخت می‌بیند.
 *
 * `balanceSec` لازم است چون جملهٔ «هزینه: ۵ سکه» بی موجودی نصفِ جواب است: کسی
 * که از لینکِ گروه آمده نمی‌داند اصلاً سکه‌ای دارد یا نه، و بدون عددِ کنارش
 * یا از دکمه می‌ترسد یا روی دیوارِ «سکه‌هات کم میاد» می‌خورد.
 */
export function joinPreview(
  s: SessionRow,
  balanceSec: number,
): { text: string; keyboard: InlineKeyboard } | null {
  const st = shareStatus(s.id);
  if (!st) return null;
  const r = sessionReport(s);
  const course = s.course_id ? getCourse(s.course_id) : null;
  const meta = [course?.name ? escapeHtml(course.name) : null, s.original_ms ? fmtDuration(s.original_ms) : null]
    .filter(Boolean)
    .join(" · ");

  const text = [
    `📓 <b>${escapeHtml(s.title ?? "جلسهٔ کلاس")}</b>`,
    meta ? `<i>${meta}</i>` : "",
    "",
    r?.headline ? escapeHtml(r.headline) : "",
    "",
    "<b>چی گیرت میاد</b>",
    "• خلاصهٔ کلاس",
    /**
     * فهرست خالی را **تبلیغ نکن**.
     *
     * قبلاً «۰ نکتهٔ امتحانی» چاپ می‌شد — یعنی همان دروازه‌هایی که برای
     * اعتماد ساخته شده‌اند، به کارتِ دعوت شلیک می‌کردند. و «امتحانی» هم
     * دقیق نبود: این فهرست تکلیف و مهلت و امور کلاس را هم دارد.
     */
    (r?.key_points.length ?? 0) > 0
      ? `• ${toFaDigits(r!.key_points.length)} نکتهٔ کلیدی با عین حرف استاد`
      : "• نکته‌های کلاس با عین حرف استاد",
    s.pdf_path ? "• فایل جزوه" : "",
    "• صوت کلاس، متن کامل کلاس و کلاس دقیقه‌به‌دقیقه",
    "",
    `سهم تو: <b>${st.capReached ? "مجانی" : fmtToman(st.seat)}</b> · موجودیت: <b>${fmtToman(balanceSec)}</b>`,
    takenLine(st.memberCount),
  ]
    .filter((l) => l !== "")
    .join("\n");

  return {
    text,
    keyboard: new InlineKeyboard().text("✅ بگیرش", `jdo:${s.id}`).row().text("فعلاً نه", `jno:${s.id}`),
  };
}

/**
 * تحویل یک جلسه به کسی که تازه پیوسته — **همان شکلِ تحویلِ مالک**.
 *
 * ## دیوارِ هشت پیام
 *
 * تحویلِ مالک از هفت پیامِ پشت‌سرهم به چهار چیزِ فوری و بقیه پشتِ دکمه رسید،
 * ولی این مسیر عقب ماند: هم‌کلاسی هنوز صوت، خلاصه، نکته‌ها، بخش‌بندی، پرسش و
 * پاسخ، جزوه، رونوشت و SRT را پشت‌سرهم می‌گرفت — و «گرفتیش، n سکه کم شد»
 * *آخرِ* همه می‌آمد، یعنی هشت پیام بدون اینکه بداند پولی رفت یا نه.
 *
 * حالا تأییدِ کوتاه اول می‌آید (`handleJoin`)، بعد همان چهار چیزِ مالک، و
 * آخر همان `moreKeyboard` و `MORE_CB` و `sendMorePart` که مالک دارد — نه یک
 * پیاده‌سازیِ موازی که روزی از آن عقب بماند. `closingKeyboard` اینجا
 * نمی‌آید چون دکمهٔ شریک‌شدنش مالِ مالک است؛ عضو فقط بخش‌های بایگانی را
 * می‌خواهد.
 *
 * شناسهٔ صوتِ فرستاده‌شده کنارِ عضویتِ همین کاربر ذخیره می‌شود
 * (`setMemberDelivery`) تا دکمهٔ «کلاس دقیقه‌به‌دقیقه» هفته‌ها بعد هم ریپلایِ
 * همین صوت در همین چت باشد. چرایی در `reportReplyTo`.
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
    /**
     * **`file_id` با مدتِ صفر یعنی صوتِ مرده — دور بریزش و از دیسک بفرست.**
     *
     * سکو مدت را همراهِ فایلِ کش‌شده نگه می‌دارد و پارامتر `duration` را در
     * ارسالِ با `file_id` **نادیده می‌گیرد** — آزموده شد: همان `file_id` با
     * `duration: 3723` باز هم `duration: 0` برگرداند.
     *
     * پس صوتی که پیش از رفعِ مدت آپلود شده تا ابد مرده می‌ماند: دکمهٔ پخش
     * هست، فشارش می‌دهی، هیچ اتفاقی نمی‌افتد — و زمان‌های گزارش هم زدنی
     * نمی‌شوند چون سکو جایی برای پریدن نمی‌شناسد.
     *
     * از دیسک که بفرستیم مدت را خودمان می‌گوییم و `file_id` تازه از آن به
     * بعد سالم است. یعنی هر جلسهٔ قدیمی بار **اول** خودش را درمان می‌کند.
     */
    if (sent && "audio" in sent && sent.audio?.duration === 0 && s.original_ms > 0) {
      logger.info({ sessionId: s.id }, "cached audio had zero duration — re-uploading from disk");
      await ctx.api.deleteMessage(ctx.chat!.id, sent.message_id).catch(() => {});
    } else {
      audioMessageId = sent?.message_id ?? null;
    }
  }

  // فایل روی دیسک، وقتی `file_id` کار نکرد یا اصلاً نبود
  if (audioMessageId === null && s.original_file && fs.existsSync(s.original_file)) {
    try {
      const sent = await sendFileTo(
        ctx.api,
        ctx.chat!.id,
        platformOf(ctx),
        "sendAudio",
        { path: s.original_file, filename: `${s.title ?? "جلسه"}${audioExt(s.original_file)}` },
        {
          caption,
          ...(s.title ? { title: s.title } : {}),
          // بدون مدت، صوت با `duration: 0` می‌نشیند و نه پخش می‌شود نه
          // زمان‌های گزارش را زدنی می‌کند — همان باگی که در بایگانی دیده شد.
          ...(s.original_ms > 0 ? { duration: Math.round(s.original_ms / 1000) } : {}),
        },
      );
      audioMessageId = sent?.message_id ?? null;
      // `file_id` تازه مالِ سکوی همین کاربر است و دفعهٔ بعد کار می‌کند.
      if (sent?.fileId) updateSession(s.id, { audio_file_id: sent.fileId });
    } catch (e) {
      logger.warn({ sessionId: s.id, err: String(e) }, "resend audio from disk failed");
    }
  }

  /**
   * جفتِ «کدام صوت، کدام چت» برای **همین گیرنده**.
   *
   * عضو در `session_members` می‌نشیند و مالک — که فقط از مسیرِ «از قبل مال
   * خودته» به اینجا می‌رسد — در همان ستون‌های `delivered_*` جلسه، تا هر دو از
   * همان `reportReplyTo` بخوانند.
   */
  const viewer = uid(ctx);
  const chatId = ctx.chat!.id;
  if (audioMessageId !== null) {
    if (viewer === s.tg_id) {
      updateSession(s.id, { delivered_chat_id: chatId, delivered_audio_message_id: audioMessageId });
    } else {
      setMemberDelivery(s.id, viewer, chatId, audioMessageId);
    }
  }
  const fresh = getSession(s.id) ?? s;
  const asReply = reportReplyTo(fresh, chatId, viewer);

  const send = async (text: string, extra: Record<string, unknown> = {}) => {
    if (!text) return;
    for (const part of S.chunk(text)) {
      await ctx.reply(part, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
    }
  };

  // همان پیامِ یکی‌شدهٔ مالک — خلاصه و نکته‌ها با دکمه‌های بایگانی زیرش؛ دکمهٔ
  // شریک‌شدن نه، چون مالِ مالک است.
  await sendWithKeyboard(
    { api: ctx.api, chatId },
    S.deliveryMessage({
      report: r,
      courseName: course?.name ?? null,
      sessionDate: s.session_date,
      durationMs: s.original_ms,
      savedMs: Math.max(0, s.original_ms - s.billed_ms),
      qualityWarnings: [],
    }),
    asReply,
    moreKeyboard(fresh) ?? undefined,
  );
  // جلسهٔ اشتراکی همان گزارش را می‌گیرد؛ اگر این خط نباشد، هم‌کلاسیِ گیرنده
  // بخشی از خروجیِ همان جلسه را نمی‌بیند. خالی برمی‌گردد وقتی جلسه این پاس
  // را نداشته، پس در حالت پیش‌فرض هیچ پیامی اضافه نمی‌شود.
  await send(S.qaMessage(r), asReply);

  // `sendDoc` مسیر بله را دستی می‌فرستد و خطا را لاگ می‌کند؛ توضیح در
  // `bale-upload.ts`. پیش‌تر اینجا `.catch(() => {})` بود و کاربر بله جزوه را
  // بی‌صدا از دست می‌داد.
  if (s.pdf_path && fs.existsSync(s.pdf_path)) {
    await sendDoc(ctx, s.pdf_path, `${s.title ?? "جزوه"}.pdf`, { caption: S.CAPTION.notes });
  }

}

export interface JoinOutcome {
  ok: boolean;
  /**
   * پیامی که صدازننده باید بفرستد — **خالی** وقتی پیوستن موفق بوده، چون
   * تأییدش خودش پیش از تحویل رفته (چرایی در `handleJoin`).
   */
  message: string;
  session?: SessionRow;
  /**
   * دکمه‌ای که باید زیر پیام بنشیند — امروز فقط «شارژ حساب» وقتی سکه کم است.
   *
   * صداکننده (`jdo:`) پیش از این فقط متن را می‌فرستاد و صفحه‌کلیدِ دعوت را هم
   * برداشته بود، پس تازه‌واردی که از گروه درس آمده بود در یک پیامِ خشک گیر
   * می‌کرد. پاسخ باید راهِ خروج را با خودش بیاورد، نه اینکه به صداکننده
   * بسپاردش.
   */
  keyboard?: InlineKeyboard;
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
      // خبر اول، بعد فایل‌ها — همان قاعدهٔ پایین.
      await ctx.reply(S.JOIN_AGAIN, { parse_mode: "HTML" });
      if (s) await deliverSession(ctx, s);
      return { ok: true, message: "" };
    }
    if (e instanceof InsufficientCredit) {
      /**
       * سکهٔ کم روی مسیرِ **پیوستن** هم باید دکمهٔ شارژ داشته باشد.
       *
       * همان قاعده‌ای که مسیر آپلود از ممیزی لانچ گرفت: تازه‌وارد از گروه درس
       * می‌آید، ربات را نمی‌شناسد، و «از فلان بخش شارژ کن» یعنی گشتن دنبال
       * چیزی که ندیده. کسری هم در خودِ متن گفته می‌شود، چون تفاضلِ دو عدد را
       * کسی وسط تصمیم‌گرفتن حساب نمی‌کند.
       */
      rememberPendingJoin(tgId, sessionId);
      return {
        ok: false,
        message: S.lowBalanceMessage(e.needed, e.balance) + "\n\n" + S.JOIN_RETURN_HINT,
        keyboard: new InlineKeyboard().text(S.CONFIRM_BTN.topup, "topup"),
      };
    }
    if (e instanceof GiftBudgetExhausted) {
      rememberPendingJoin(tgId, sessionId);
      return {
        ok: false,
        message: S.giftBudgetFullMessage(e.seat),
        keyboard: new InlineKeyboard().text(S.CONFIRM_BTN.topup, "topup"),
      };
    }
    if (e instanceof NotShareable) return { ok: false, message: e.message };
    throw e;
  }

  const s = getSession(sessionId)!;

  /**
   * **تأییدِ کوتاه پیش از هر فایلی.**
   *
   * پیش‌تر «گرفتیش، n سکه کم شد» آخرِ همهٔ پیام‌ها می‌آمد؛ یعنی هم‌کلاسی چند
   * پیام و فایل می‌گرفت بی‌آنکه بداند پولی رفت یا نه، و خبر زیرِ همه گم می‌شد.
   * پول اولین سؤالِ کسی است که دکمهٔ «بگیرش» را زده.
   */
  await ctx.reply(S.joinedMessage(result.charged), {
    parse_mode: "HTML",
  });
  await deliverSession(ctx, s);

  // خبر به مالک که سهمش برگشت — این همان چیزی است که آدم را ترغیب می‌کند
  // لینک را پخش کند، پس باید دیده شود.
  if (result.ownerRefund > 0) {
    const tail = result.capJustReached
      ? `\n\n<b>سهم همه برگشت؛ تو فقط سهم خودت رو دادی.</b> از این به بعد برای بقیه مجانیه.`
      : "";
    /**
     * ⚠️ اینجا `ctx.api.sendMessage(result.ownerTgId, …)` بود و غلط بود.
     *
     * `ownerTgId` **شناسهٔ داخلی** مالک است نه شناسهٔ چتش، و `ctx.api` هم ربات
     * سکوی *پیوسته* است نه سکوی مالک. برای مالکی که از بله یا وب آمده،
     * شناسهٔ داخلی بالای ۲^۵۲ است و پیام بی‌صدا شکست می‌خورد؛ و اگر پیوسته در
     * بله باشد و مالک در تلگرام، همان عدد می‌توانست به یک کاربرِ بی‌ربطِ بله
     * برسد — دقیقاً همان چیزی که `notify.ts` برای جلوگیری از آن نوشته شد.
     *
     * بی‌صدا هم بود، چون خطا با `catch` خالی بلعیده می‌شد. و این پیام همان
     * چیزی است که مالک را ترغیب می‌کند لینک را پخش کند.
     */
    await notifyUser(
      result.ownerTgId,
      `💰 <b>${fmtToman(result.ownerRefund)}</b> برگشت به حسابت!\n\n` +
        `یکی از بچه‌ها «${escapeHtml(s.title ?? "کلاس")}» رو گرفت.${tail}`,
    ).catch(() => {});
  }

  // پیام همین بالا رفته؛ خالی یعنی صدازننده چیزی اضافه نفرستد.
  return { ok: true, message: "", session: s };
}

/** فرستنده پس از اتمام کار، به‌عنوان مالک با کل هزینه ثبت می‌شود. */
export function enableSharing(sessionId: string): void {
  updateSession(sessionId, {});
  const list = members(sessionId);
  logger.debug({ sessionId, members: list.length }, "sharing enabled");
}

export { shareStatus, config };
