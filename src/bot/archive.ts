/**
 * بایگانی ادمین — یک نسخه از هر جلسه در کانال خصوصی.
 *
 * برای این است که ادمین بدون سرکشیدن به پایگاه‌داده ببیند چه می‌گذرد: چه
 * کسی چه فرستاده، رایگان بوده یا پولی، و اگر پولی بوده خروجی‌اش چه شد.
 *
 * سه قاعده که کل این ماژول را شکل می‌دهند:
 *
 * **۱) هرگز مسیر کاربر را نمی‌شکند.** بایگانی یک قابلیت جانبی است؛ اگر ربات
 * از کانال اخراج شده باشد یا شناسه غلط باشد، کاربر نباید چیزی بفهمد. پس هر
 * تماس اینجا داخل try/catch است و شکستش فقط لاگ می‌شود.
 *
 * **۲) گزارش ریپلایِ صوتِ خودش است.** در کانالی که روزی صدها جلسه می‌آید،
 * گزارشِ شناور بی‌فایده است. شناسهٔ پیام صوت در `archive_message_id` ذخیره
 * می‌شود تا گزارش دقیقاً زیر همان صوت بنشیند.
 *
 * **۳) همیشه تلگرام، هر جا که کاربر باشد.** کانال بایگانی یک کانال تلگرامی
 * است و باید تنها جایی بماند که همه‌چیز آنجا دیده می‌شود. پس این ماژول هرگز
 * `ctx.api` نمی‌گیرد؛ خودش `Api` تلگرام را برمی‌دارد. پیش‌تر `ctx.api`
 * گرفته می‌شد و برای کاربر بله یعنی `sendAudio` روی سرورِ **بله** با شناسهٔ
 * چتِ **تلگرام** — که همیشه رد می‌شد، و چون شکست بایگانی بلعیده می‌شود
 * (قاعدهٔ ۱) بی‌صدا رد می‌شد. صوت مینی‌اپ هم اصلاً به اینجا نمی‌رسید.
 *
 * ⚠️ محتوای این کانال خصوصی است: صوت کلاس، صدای دانشجوهای دیگر، و تحلیل
 * جلسه. کانال باید خصوصی بماند و فقط ادمین‌ها عضوش باشند.
 */

import fs from "node:fs";
import { InputFile, type Api } from "grammy";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { escapeHtml, transcriptBytes } from "../util/text.js";
import { fmtDuration } from "../util/time.js";
import { fmtCost } from "../billing/coins.js";
import { getSession, updateSession, type SessionMode, type SessionRow } from "../db/index.js";
import type { Platform } from "../db/identity.js";
import type { AnalysisReport } from "../analysis/schema.js";
import { transcodeForTelegram } from "../audio/ffmpeg.js";
import { audioExt } from "../audio/container.js";
import * as S from "./strings.js";

/**
 * `Api` ربات تلگرام — تنها راهِ رسیدن به کانال بایگانی.
 *
 * با `setArchiveApi` از `bot/index.ts` پر می‌شود، به همان دلیلی که
 * `identity.setBaleApi` این‌طور است: وارد کردنِ مستقیمِ `bot` وابستگی حلقوی
 * می‌سازد، چون خودِ `index.ts` این فایل را وارد می‌کند.
 */
let tgApi: Api | null = null;

export function setArchiveApi(api: Api): void {
  tgApi = api;
}

/**
 * بایگانی وقتی خاموش است که شناسهٔ کانال ست نشده باشد.
 *
 * نبودِ `tgApi` هم خاموشش می‌کند: بدون آن راهی به کانال نیست، و ادعای
 * روشن‌بودن فقط خطای بی‌فایده تولید می‌کند.
 */
export function archiveEnabled(): boolean {
  return config.ARCHIVE_CHAT_ID !== undefined && tgApi !== null;
}

export interface Sender {
  tgId: number;
  name: string | null;
  username: string | null;
}

/** «حمید (@hamid) · 123456789» — تا ادمین بتواند مستقیم پیدایش کند. */
function senderLine(u: Sender): string {
  const parts = [u.name ? escapeHtml(u.name) : "بی‌نام"];
  if (u.username) parts.push(`@${escapeHtml(u.username)}`);
  return `👤 ${parts.join(" · ")}\n🆔 <code>${u.tgId}</code>`;
}

/**
 * از کدام در وارد شده.
 *
 * وقتی هر سه مسیر در یک کانال می‌نشینند، بدون این برچسب ادمین نمی‌فهمد چرا
 * صوتی کیفیتش پایین‌تر است یا چرا جلسه‌ای در کانال هست ولی در چت ربات نبوده.
 *
 * همان `Platform` پایگاه‌داده است و نه یک نوعِ موازی، تا اگر روزی سکوی
 * چهارمی اضافه شود، اینجا **کامپایل نشود** به‌جای اینکه بی‌برچسب بماند.
 */
const ORIGIN_LABEL: Record<Platform, string> = {
  telegram: "✈️ تلگرام",
  bale: "🟢 بله",
  web: "🌐 مینی‌اپ",
};

const MODE_LABEL: Record<SessionMode, string> = {
  free_trial: "🎁 رایگان (فقط رونویسی)",
  free_transcript: "🎁 رایگان (فقط رونویسی)",
  full: "💰 پولی (تحلیل کامل)",
};

/**
 * کپشن صوت — همان چیزی که ادمین در یک نگاه باید بفهمد.
 *
 * هزینه فقط برای جلسهٔ پولی می‌آید؛ برای رایگان عدد صفر گمراه‌کننده است
 * چون هزینهٔ واقعیِ رونویسی صفر نیست، فقط از کاربر گرفته نشده.
 */
export function audioCaption(i: {
  sender: Sender;
  mode: SessionMode;
  durationMs: number;
  sessionId: string;
  courseName: string | null;
  /** از کجا آمده — حالا که هر سه مسیر به یک کانال می‌ریزند، لازم است. */
  origin?: Platform;
  /**
   * اگر کاربر لینک فرستاده، خودِ آدرس.
   *
   * وقتی رونویسی یک جلسه بد در می‌آید، اولین سؤال این است که منبع چه بوده.
   * برای فایل، خودِ صوتِ بایگانی‌شده جواب می‌دهد؛ برای لینک، آدرس هم لازم
   * است تا بشود همان منبع را دوباره گرفت.
   */
  sourceUrl?: string;
}): string {
  const out = [
    MODE_LABEL[i.mode] ?? i.mode,
    "",
    senderLine(i.sender),
    `⏱ ${fmtDuration(i.durationMs)}`,
  ];
  if (i.origin && i.origin !== "telegram") out.push(ORIGIN_LABEL[i.origin]);
  if (i.sourceUrl) out.push(`🔗 ${escapeHtml(i.sourceUrl)}`);
  if (i.courseName) out.push(`📘 ${escapeHtml(i.courseName)}`);
  if (i.mode === "full") {
    out.push(`💸 ${fmtCost(Math.round(i.durationMs / 1000))}`);
  }
  out.push("", `<code>${i.sessionId}</code>`);
  return out.join("\n");
}

/**
 * سقف آپلود ربات تلگرام. عمداً از `deliver.ts` جدا نگه داشته نشده — همان
 * عدد است و از همان‌جا وارد نمی‌شود فقط تا این ماژول به تحویل وابسته نشود.
 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * منبع صوت برای بایگانی.
 *
 * `fileId` فقط وقتی معنی دارد که کاربر خودش در **تلگرام** فرستاده باشد؛
 * آنگاه تلگرام فایل را دارد و نه آپلود دوباره‌ای لازم است نه پهنای باندی.
 * `path` برای دو مسیر دیگر است: `file_id` بله روی تلگرام بی‌معنی است و
 * آپلود مینی‌اپ اصلاً `file_id` ندارد — در هر دو، همان فایلی که پردازش
 * می‌شود روی دیسک هست و از آنجا آپلود می‌شود.
 */
export type AudioSource = { fileId: string } | { path: string };

/**
 * صوت را طوری آماده کن که ربات بتواند آپلودش کند.
 *
 * بالای پنجاه مگابایت آپلود رد می‌شود، پس نسخهٔ فشردهٔ مونو ساخته می‌شود —
 * همان کاری که `deliver.playableAudio` برای کاربر می‌کند. برای بایگانی
 * کیفیتِ پایین‌تر قابل قبول است: رونویسی از فایل اصلی انجام شده و این نسخه
 * فقط برای این است که ادمین بتواند گوش بدهد.
 *
 * `null` یعنی نشد — و بایگانی باید بدون صوت جلو برود، نه اینکه هیچ ردی از
 * جلسه در کانال نماند.
 */
async function uploadable(sessionId: string, file: string): Promise<{ file: string; temp: boolean } | null> {
  if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size <= MAX_UPLOAD_BYTES) return { file, temp: false };
  try {
    const out = await transcodeForTelegram(file, config.workDir, MAX_UPLOAD_BYTES);
    return out ? { file: out, temp: true } : null;
  } catch (e) {
    logger.warn({ sessionId, err: String(e) }, "archive compress failed");
    return null;
  }
}

/**
 * فرستادن صوت به کانال، همراه کپشن.
 *
 * برمی‌گرداند شناسهٔ پیام را تا گزارش بعداً ریپلایش شود.
 *
 * اگر صوت به هیچ شکلی نرود (فایل نبود، فشرده‌سازی شکست خورد، آپلود رد شد)
 * **کپشن به‌تنهایی** فرستاده می‌شود. جلسه‌ای که در کانال هیچ ردی ندارد از
 * دید ادمین اصلاً وجود نداشته؛ بهتر است بداند جلسه‌ای بوده و صوتش نرفته.
 */
export async function archiveAudio(
  sessionId: string,
  source: AudioSource,
  caption: string,
  /**
   * مدت صوت، اگر می‌دانیم.
   *
   * **بدون این، صوتِ بایگانی پخش نمی‌شد.** فایلی که از بله می‌آید روی دیسک
   * `.bin` نام دارد و گرامی هم نامِ فایل را از همان مسیر برمی‌داشت؛ تلگرام
   * پسوند را باور می‌کند و برای ظرفی که نمی‌شناسد `duration: 0` می‌گذارد.
   * صوتِ با مدتِ صفر نه پخش می‌شود و نه زمان‌های گزارشِ ریپلای‌شده را به
   * لینکِ پخش تبدیل می‌کند — یعنی هر دو چیزی که این کانال برایش ساخته شده.
   */
  durationSec?: number,
): Promise<number | null> {
  if (!archiveEnabled()) return null;
  const chat = config.ARCHIVE_CHAT_ID!;

  let temp: string | null = null;
  try {
    let payload: string | InputFile | null = null;
    if ("fileId" in source) {
      payload = source.fileId;
    } else {
      const ready = await uploadable(sessionId, source.path);
      if (ready) {
        // نام با پسوندِ **واقعی** ساخته می‌شود، نه با آنچه روی دیسک است.
        payload = new InputFile(ready.file, `${sessionId}${audioExt(ready.file)}`);
        if (ready.temp) temp = ready.file;
      }
    }

    const sent = payload
      ? await tgApi!.sendAudio(chat, payload, {
          caption,
          parse_mode: "HTML",
          ...(durationSec && durationSec > 0 ? { duration: Math.round(durationSec) } : {}),
        })
      : await tgApi!.sendMessage(chat, `${caption}\n\n⚠️ صوت آپلود نشد.`, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });

    updateSession(sessionId, { archive_message_id: sent.message_id });
    return sent.message_id;
  } catch (e) {
    logger.warn({ sessionId, err: String(e) }, "archive audio failed");
    return null;
  } finally {
    if (temp) await fs.promises.unlink(temp).catch(() => {});
  }
}

/**
 * پارامترهای ریپلای — با شناسه‌ای که **همین حالا** در پایگاه‌داده است.
 *
 * سطرِ `SessionRow` که صدازننده در دست دارد یک عکس لحظه‌ای است و ممکن است
 * پیش از پایان آپلودِ صوت گرفته شده باشد: مسیر بله و مینی‌اپ آپلود را
 * `await` نمی‌کنند، پس `archive_message_id` در آن عکس هنوز `null` است در
 * حالی که در پایگاه‌داده نشسته. کد قبلی در همین حالت **کل گزارش را دور
 * می‌ریخت** — بی‌صدا، چون شرطِ زودهنگام بود نه خطا.
 *
 * و اگر واقعاً صوتی نرفته باشد (آپلود شکست خورده، یا هنوز در راه است)
 * `undefined` برمی‌گردد: گزارش شناور در کانال از نبودِ گزارش بهتر است، چون
 * `sessionId` در متنش هست و ادمین می‌تواند وصلش کند.
 */
function replyTo(s: SessionRow): {
  reply_parameters?: { message_id: number; allow_sending_without_reply: true };
} {
  const id = getSession(s.id)?.archive_message_id ?? s.archive_message_id;
  if (!id) return {};
  return { reply_parameters: { message_id: id, allow_sending_without_reply: true } };
}

/**
 * فرستادن گزارش جلسهٔ پولی، به‌صورت ریپلایِ همان صوت.
 *
 * همان سه پیامی که کاربر می‌گیرد، با همان تابع‌های `strings.ts` ساخته
 * می‌شوند — یعنی اگر روزی متن خروجی عوض شود، بایگانی هم خودبه‌خود عوض
 * می‌شود و از کاربر عقب نمی‌ماند.
 *
 * زمان‌ها اینجا لینکِ پخش **نمی‌شوند** چون این پیام‌ها ریپلایِ صوتِ همان چت
 * هستند ولی تلگرام این قابلیت را فقط در چت خصوصی موبایل می‌دهد؛ پس
 * `linkable=false` تا ادعای نادرستی نکنیم.
 */
export async function archiveReport(
  s: SessionRow,
  report: AnalysisReport,
  courseName: string | null,
): Promise<void> {
  if (!archiveEnabled()) return;

  const asReply = replyTo(s);

  const send = async (text: string) => {
    if (!text) return;
    for (const part of S.chunk(text)) {
      await tgApi!.sendMessage(config.ARCHIVE_CHAT_ID!, part, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...asReply,
      });
    }
  };

  try {
    await send(
      S.recapMessage({
        report,
        courseName,
        sessionDate: s.session_date,
        durationMs: s.original_ms,
        savedMs: 0,
        qualityWarnings: [],
      }),
    );
    await send(S.extractedMessage(report));
    await send(S.timelineMessage(report, false));
  } catch (e) {
    logger.warn({ sessionId: s.id, err: String(e) }, "archive report failed");
  }

  /**
   * جزوه و رونوشت هم می‌روند، نه فقط سه پیامِ متن.
   *
   * تا امروز بایگانی همان چیزی را داشت که کاربر **می‌خواند**، ولی نه چیزی را
   * که کاربر **می‌گیرد**. یعنی وقتی کسی می‌گفت جزوه‌اش بد در آمده، ادمین
   * فقط خلاصه را داشت و باید از پایگاه‌داده بازسازی می‌کرد — همان کاری که
   * این ماژول برای نکردنش ساخته شده بود.
   *
   * سطر تازه از پایگاه‌داده خوانده می‌شود، نه از `s`. دلیلش همان دلیلِ
   * `replyTo` است: آن سطر یک عکس لحظه‌ای است و ممکن است پیش از نوشته‌شدنِ
   * `pdf_path` گرفته شده باشد.
   *
   * هرکدام catch جدا دارد تا شکستِ یکی دیگری را نبلعد — و هیچ‌کدام نباید
   * چیزی را که قبلاً رفته باطل کند (قاعدهٔ ۱ بالای همین فایل).
   */
  const fresh = getSession(s.id) ?? s;
  const chat = config.ARCHIVE_CHAT_ID!;

  if (fresh.pdf_path && fs.existsSync(fresh.pdf_path)) {
    await tgApi!
      .sendDocument(chat, new InputFile(fresh.pdf_path, `${fresh.title ?? "جزوه"}.pdf`), {
        caption: "📕 جزوه",
        ...asReply,
      })
      .catch((e: unknown) => logger.warn({ sessionId: s.id, err: String(e) }, "archive pdf failed"));
  }

  // همان نسخه‌ای که کاربر می‌گیرد: PDF، و متن خام فقط وقتی PDF نبود.
  const txFile =
    fresh.transcript_pdf && fs.existsSync(fresh.transcript_pdf)
      ? new InputFile(fresh.transcript_pdf, "رونوشت کامل.pdf")
      : fresh.transcript_txt
        ? new InputFile(transcriptBytes(fresh.transcript_txt), "رونوشت کامل.txt")
        : null;
  if (txFile) {
    await tgApi!
      .sendDocument(chat, txFile, {
        caption: "📄 رونوشت کامل",
        ...asReply,
      })
      .catch((e: unknown) =>
        logger.warn({ sessionId: s.id, err: String(e) }, "archive transcript failed"),
      );
  }
}

/** خبر شکست پردازش — تا ادمین بدون گشتن در لاگ بفهمد چه جلسه‌ای خطا خورد. */
export async function archiveFailure(s: SessionRow, message: string): Promise<void> {
  if (!archiveEnabled()) return;
  try {
    await tgApi!.sendMessage(
      config.ARCHIVE_CHAT_ID!,
      `❌ <b>پردازش ناموفق بود</b> — <code>${s.id}</code>\n\n` +
        `<code>${escapeHtml(message.slice(0, 300))}</code>`,
      { parse_mode: "HTML", ...replyTo(s) },
    );
  } catch (e) {
    logger.warn({ sessionId: s.id, err: String(e) }, "archive failure note failed");
  }
}

/**
 * خبرِ ارتقای یک جلسهٔ رایگان به پولی.
 *
 * صوتش قبلاً در کانال هست و دوباره فرستادنش فقط تکرار است؛ پس فقط یک خط
 * ریپلای می‌شود که کپشن اولیه («رایگان») دیگر کل ماجرا نیست.
 */
export async function archiveUpgrade(s: SessionRow): Promise<void> {
  if (!archiveEnabled()) return;
  // برخلاف گزارش، این پیام بدون صوتِ بایگانی‌شده بی‌معنی است: کل حرفش این
  // است که «کپشنِ آن صوت دیگر درست نیست».
  const reply = replyTo(s);
  if (!reply.reply_parameters) return;
  try {
    await tgApi!.sendMessage(
      config.ARCHIVE_CHAT_ID!,
      `⬆️ <b>ارتقا به تحلیل کامل</b> — ${fmtCost(Math.round(s.original_ms / 1000))} کسر شد.`,
      { parse_mode: "HTML", ...reply },
    );
  } catch (e) {
    logger.warn({ sessionId: s.id, err: String(e) }, "archive upgrade note failed");
  }
}

/** برای لاگ راه‌اندازی: بایگانی روشن است یا نه. لاگ ماشین‌خوان است، پس ارقام لاتین. */
export function archiveStatus(): string {
  return archiveEnabled() ? String(config.ARCHIVE_CHAT_ID) : "off";
}
