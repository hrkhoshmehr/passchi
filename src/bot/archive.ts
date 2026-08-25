/**
 * بایگانی ادمین — یک نسخه از هر جلسه در کانال خصوصی.
 *
 * برای این است که ادمین بدون سرکشیدن به پایگاه‌داده ببیند چه می‌گذرد: چه
 * کسی چه فرستاده، رایگان بوده یا پولی، و اگر پولی بوده خروجی‌اش چه شد.
 *
 * دو قاعده که کل این ماژول را شکل می‌دهند:
 *
 * **۱) هرگز مسیر کاربر را نمی‌شکند.** بایگانی یک قابلیت جانبی است؛ اگر ربات
 * از کانال اخراج شده باشد یا شناسه غلط باشد، کاربر نباید چیزی بفهمد. پس هر
 * تماس اینجا داخل try/catch است و شکستش فقط لاگ می‌شود.
 *
 * **۲) گزارش ریپلایِ صوتِ خودش است.** در کانالی که روزی صدها جلسه می‌آید،
 * گزارشِ شناور بی‌فایده است. شناسهٔ پیام صوت در `archive_message_id` ذخیره
 * می‌شود تا گزارش دقیقاً زیر همان صوت بنشیند.
 *
 * ⚠️ محتوای این کانال خصوصی است: صوت کلاس، صدای دانشجوهای دیگر، و تحلیل
 * جلسه. کانال باید خصوصی بماند و فقط ادمین‌ها عضوش باشند.
 */

import type { Api } from "grammy";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { escapeHtml } from "../util/text.js";
import { fmtDuration } from "../util/time.js";
import { fmtCost } from "../billing/coins.js";
import { updateSession, type SessionMode, type SessionRow } from "../db/index.js";
import type { AnalysisReport } from "../analysis/schema.js";
import * as S from "./strings.js";

/** بایگانی وقتی خاموش است که شناسهٔ کانال ست نشده باشد. */
export function archiveEnabled(): boolean {
  return config.ARCHIVE_CHAT_ID !== undefined;
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
}): string {
  const out = [
    MODE_LABEL[i.mode] ?? i.mode,
    "",
    senderLine(i.sender),
    `⏱ ${fmtDuration(i.durationMs)}`,
  ];
  if (i.courseName) out.push(`📘 ${escapeHtml(i.courseName)}`);
  if (i.mode === "full") {
    out.push(`💸 ${fmtCost(Math.round(i.durationMs / 1000))}`);
  }
  out.push("", `<code>${i.sessionId}</code>`);
  return out.join("\n");
}

/**
 * فرستادن صوت به کانال، همراه کپشن.
 *
 * با `file_id` فرستاده می‌شود نه با فایل روی دیسک: تلگرام خودش فایل را دارد،
 * پس نه آپلود دوباره‌ای لازم است نه پهنای باندی. برمی‌گرداند شناسهٔ پیام را
 * تا گزارش بعداً ریپلایش شود.
 */
export async function archiveAudio(
  api: Api,
  sessionId: string,
  fileId: string,
  caption: string,
): Promise<number | null> {
  if (!archiveEnabled()) return null;
  try {
    const sent = await api.sendAudio(config.ARCHIVE_CHAT_ID!, fileId, {
      caption,
      parse_mode: "HTML",
    });
    updateSession(sessionId, { archive_message_id: sent.message_id });
    return sent.message_id;
  } catch (e) {
    logger.warn({ sessionId, err: String(e) }, "archive audio failed");
    return null;
  }
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
  api: Api,
  s: SessionRow,
  report: AnalysisReport,
  courseName: string | null,
): Promise<void> {
  if (!archiveEnabled() || !s.archive_message_id) return;

  const asReply = {
    reply_parameters: {
      message_id: s.archive_message_id,
      allow_sending_without_reply: true,
    },
  } as const;

  const send = async (text: string) => {
    if (!text) return;
    for (const part of S.chunk(text)) {
      await api.sendMessage(config.ARCHIVE_CHAT_ID!, part, {
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
}

/** خبر شکست پردازش — تا ادمین بدون گشتن در لاگ بفهمد چه جلسه‌ای خطا خورد. */
export async function archiveFailure(api: Api, s: SessionRow, message: string): Promise<void> {
  if (!archiveEnabled() || !s.archive_message_id) return;
  try {
    await api.sendMessage(
      config.ARCHIVE_CHAT_ID!,
      `❌ <b>پردازش ناموفق بود</b>\n\n<code>${escapeHtml(message.slice(0, 300))}</code>`,
      {
        parse_mode: "HTML",
        reply_parameters: {
          message_id: s.archive_message_id,
          allow_sending_without_reply: true,
        },
      },
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
export async function archiveUpgrade(api: Api, s: SessionRow): Promise<void> {
  if (!archiveEnabled() || !s.archive_message_id) return;
  try {
    await api.sendMessage(
      config.ARCHIVE_CHAT_ID!,
      `⬆️ <b>ارتقا به تحلیل کامل</b> — ${fmtCost(Math.round(s.original_ms / 1000))} کسر شد.`,
      {
        parse_mode: "HTML",
        reply_parameters: {
          message_id: s.archive_message_id,
          allow_sending_without_reply: true,
        },
      },
    );
  } catch (e) {
    logger.warn({ sessionId: s.id, err: String(e) }, "archive upgrade note failed");
  }
}

/** برای لاگ راه‌اندازی: بایگانی روشن است یا نه. لاگ ماشین‌خوان است، پس ارقام لاتین. */
export function archiveStatus(): string {
  return archiveEnabled() ? String(config.ARCHIVE_CHAT_ID) : "off";
}
