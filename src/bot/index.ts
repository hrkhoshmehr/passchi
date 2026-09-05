import fs from "node:fs/promises";
import path from "node:path";
import { Bot, Composer, InlineKeyboard, InputFile, type Api, type Context } from "grammy";
import { config, requireKey } from "../config.js";
import { logger } from "../util/logger.js";
import {
  chunkMessage,
  escapeHtml,
  htmlToPlain,
  shortId,
  transcriptBytes,
} from "../util/text.js";
import { declaredDurationSec, fmtClock, fmtDuration, toFaDigits } from "../util/time.js";
import { extractClip, probe, TimeMap } from "../audio/ffmpeg.js";
import { runPipeline } from "../pipeline.js";
import { cancel as cancelJob, enqueue, isBusy, queueDepth } from "../queue.js";
import * as S from "./strings.js";
import {
  callWithDeadline,
  downloadLimitFor,
  downloadTelegramFile,
  FileTooLargeError,
} from "./download.js";
import { commit, InsufficientCredit, grant, refund, reserve, totalShareRefunds } from "../billing/ledger.js";
import {
  accessibleSessions, isMember, registerOwner, setShareEnabled, setShareTarget, shareStatus,
} from "../billing/sharing.js";
import {
  handleJoin, invitationMessage, joinPreview, shareTargetKeyboard, shareToggleKeyboard,
} from "./share.js";
import {
  BTN, HOW_IT_WORKS, WELCOME, WELCOME_CB, mainKeyboard, menuActionOf, packagesKeyboard,
  packagesMessage, supportKeyboard, supportMessage,
} from "./menu.js";
import {
  DEMO_CB, DEMO_INTRO, SAMPLE_COURSE, SAMPLE_DURATION_MS, SAMPLE_PDF_PATH, sampleAudioFileId,
  SAMPLE_REPORT, SAMPLE_TRANSCRIPT_PATH, outroMessage, stepKeyboard,
} from "./demo.js";
import {
  archiveAudio, archiveFailure, archiveReport, archiveUpgrade, audioCaption, setArchiveApi,
} from "./archive.js";
import { beginTopup, cancelTopup, decide, paymentConfigured, receiveReceipt } from "./topup.js";
import {
  DEFAULT_GIFT_COINS, claim as claimGiftCode, claimedMessage, describeUser, giftSummary,
  mintGift, refusalMessage,
} from "./gift.js";
import {
  RATE_LINE, coinsAsMinutesIfUseful, coinsToSec, costCoins, fmtBalance, fmtCoins, fmtCost, fmtToman,
} from "../billing/coins.js";
import {
  clearAudioPath, courseTerms, createCourse, createSession, expiredAudio,
  getCourse, getSession, getUser, isTranscriptOnly, listCourses, listSessions, pendingSessions,
  countSessions, getGift, listGifts, pendingTopups, purgeSession, revokeGift, sessionReport,
  sessionTimeMap, updateSession,
  type SessionMode,
  type SessionRow,
} from "../db/index.js";
import { findIdentity, resolveIdentity } from "../db/identity.js";
import { platformOf, setBaleApi, uid } from "./identity.js";
import { sendDoc } from "./bale-upload.js";
import { notifyUser } from "./notify.js";
import { extractUrl, fetchUrlToFile, UrlFetchError, type FetchUrlResult } from "./fetch-url.js";

export const bot = new Bot(
  requireKey("BOT_TOKEN"),
  config.TELEGRAM_API_ROOT ? { client: { apiRoot: config.TELEGRAM_API_ROOT } } : undefined,
);

/**
 * کانال بایگانی تلگرامی است، پس همیشه از `Api` تلگرام رد می‌شود — حتی وقتی
 * کاربر در بله است یا از مینی‌اپ آپلود کرده.
 */
setArchiveApi(bot.api);

/**
 * ربات بله — همان دست‌کدها، سرور دیگر.
 *
 * بله Bot API تلگرام را کلون کرده، پس grammY بدون تغییر رویش کار می‌کند و
 * فقط `apiRoot` عوض می‌شود. به همین دلیل هیچ دست‌کدی دو بار نوشته نشده:
 * `registerHandlers` هر دو نمونه را می‌گیرد.
 *
 * `null` یعنی توکنی تنظیم نشده و کل این مسیر خاموش است.
 */
export const baleBot = config.BALE_BOT_TOKEN
  ? new Bot(config.BALE_BOT_TOKEN, {
      // `apiRoot` بدون `/bot` است: grammY خودش آدرس را به شکل
      // `{root}/bot{token}/{method}` می‌سازد. با افزودن `/bot` اینجا، مسیر
      // `/bot/bot<token>/` می‌شد و بله به آن ۴۰۴ می‌داد — و چون grammY خطای
      // شبکهٔ polling را بی‌صدا دوباره تلاش می‌کند، لاگ راه‌اندازی «بله: روشن»
      // می‌گفت در حالی که هیچ آپدیتی نمی‌رسید و هیچ خطایی هم ثبت نمی‌شد.
      client: { apiRoot: config.BALE_API_ROOT.replace(/\/+$/, "") },
    })
  : null;

/**
 * بله قالب‌بندی ندارد — پس تگ‌ها پیش از ارسال برداشته می‌شوند.
 *
 * آزمون روی خودِ سرور بله: `sendMessage` با `parse_mode: "HTML"` موفق
 * برمی‌گردد ولی متنِ پاسخ **تگ‌ها را دست‌نخورده** دارد. `Markdown` و
 * `MarkdownV2` هم همان‌طور، و `entities` هم بی‌صدا دور ریخته می‌شود. یعنی
 * کاربر بله عیناً `<b>` را در پیام می‌دید.
 *
 * چرا اینجا و نه در سی‌ودو جای صدازننده: دست‌کدها عمداً یک‌بار نوشته شده‌اند
 * تا دو سکو نتوانند از هم عقب بمانند. اگر هر `reply` خودش این را می‌فهمید،
 * اولین پیامِ تازه‌ای که کسی اضافه می‌کرد دوباره تگ‌دار می‌رفت. یک ترنسفورمر
 * روی `api` تنها جایی است که *همهٔ* مسیرها — پاسخ‌ها، اعلان‌ها، بایگانی،
 * و کپشن‌ها — از آن رد می‌شوند.
 */
function stripFormattingForBale(api: Api): void {
  api.config.use(async (prev, method, payload, signal) => {
    const p = payload as Record<string, unknown>;
    if (typeof p.text === "string") p.text = htmlToPlain(p.text);
    if (typeof p.caption === "string") p.caption = htmlToPlain(p.caption);
    // `parse_mode` برداشته می‌شود چون دیگر چیزی برای پارس‌کردن نمانده و
    // نگه‌داشتنش فقط این توهم را می‌سازد که بله قالب‌بندی می‌فهمد.
    delete p.parse_mode;
    return prev(method, payload as typeof payload, signal);
  });
}

if (baleBot) stripFormattingForBale(baleBot.api);

setBaleApi(baleBot?.api ?? null);

/**
 * همهٔ دست‌کدها اینجا ثبت می‌شوند، نه مستقیم روی `bot`.
 *
 * `Composer` یک بستهٔ دست‌کدِ مستقل از نمونهٔ ربات است. با آن، تلگرام و بله
 * **عیناً** یک مجموعه رفتار می‌گیرند و امکان اینکه یکی از دو سکو از دیگری
 * عقب بماند از بین می‌رود — هزینه‌ای که کپی‌کردن فایل حتماً داشت.
 */
const handlers = new Composer<Context>();

// ─── وضعیت گفت‌وگوی کوتاه‌مدت (در حافظه) ────────────────────────────────────

type Pending =
  | { kind: "await_course_name" }
  | { kind: "await_professor"; courseName: string };

const convo = new Map<number, Pending>();

/**
 * آیا این گفت‌وگو مالِ یک ادمین است؟
 *
 * **چرا `Context` می‌گیرد و نه یک عدد:** `ADMIN_IDS` شناسه‌های تلگرام‌اند، و
 * پیش‌تر همان `ctx.from.id` خام با آن مقایسه می‌شد. روی بله شناسهٔ کاربر
 * عدد دیگری است، پس هیچ ادمینی روی بله ادمین شناخته نمی‌شد و دستورهای
 * مدیریتی — از جمله `/gift` — **بی‌صدا** هیچ کاری نمی‌کردند: نه خطا، نه
 * پیام، فقط `return`.
 *
 * حالا از هویت داخلی هم پرسیده می‌شود: اگر ادمینی حساب تلگرام و بلهٔ خود را
 * زیر یک کاربر داشته باشد، روی هر دو ادمین است. مقایسهٔ خام هم می‌ماند تا
 * ادمینی که هنوز هویت ثبت‌شده ندارد قفل نشود.
 */
function isAdmin(ctx: Context): boolean {
  const raw = ctx.from?.id;
  if (raw === undefined) return false;

  // فهرست درست برای همین سکو — شناسهٔ بله با شناسهٔ تلگرام یکی نیست.
  const list = platformOf(ctx) === "bale" ? config.BALE_ADMIN_IDS : config.ADMIN_IDS;
  if (list.includes(raw)) return true;

  /**
   * اگر ادمین حساب‌هایش را زیر یک کاربر آورده باشد، روی هر دو سکو ادمین است.
   *
   * این راهِ دوم لازم است چون امروز حساب تلگرام و بلهٔ یک نفر دو کاربر جدا
   * هستند؛ روزی که سینک شماره‌موبایل بیاید، همین شرط بدون تغییر کار می‌کند.
   */
  const me = uid(ctx);
  return config.ADMIN_IDS.some(
    (adminTgId) => findIdentity("telegram", String(adminTgId))?.user_id === me,
  );
}

async function reply(ctx: Context, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  for (const part of chunkMessage(text)) {
    await ctx.reply(part, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
  }
}

/**
 * کاربر را از روی `ctx.from` پیدا کن یا بساز.
 *
 * از `upsertUser` مستقیم استفاده **نمی‌شود** و به جایش `resolveIdentity` صدا
 * زده می‌شود: با آمدن بله، `ctx.from.id` دیگر یکتا نیست. شناسه‌های بله از
 * فضای شمارهٔ خودشان می‌آیند و می‌توانند با شناسهٔ یک کاربر تلگرامی برابر
 * شوند — یعنی دو نفر روی یک حساب، با سکه‌ها و جلسه‌های مشترک.
 *
 * برای تلگرام نتیجه دقیقاً مثل قبل است (شناسهٔ داخلی همان شناسهٔ تلگرام)، پس
 * کاربران فعلی هیچ تغییری نمی‌بینند.
 */
function touchUser(ctx: Context) {
  const u = ctx.from;
  if (!u) return null;
  const platform = platformOf(ctx);
  const known = findIdentity(platform, String(u.id));
  const row = resolveIdentity({
    platform,
    platformUserId: String(u.id),
    name: [u.first_name, u.last_name].filter(Boolean).join(" ") || null,
    username: u.username ?? null,
  });
  // هدیهٔ شروع فقط یک بار، هنگام اولین دیدار
  if (!known && config.FREE_TRIAL_COINS > 0) {
    grant(row.tg_id, coinsToSec(config.FREE_TRIAL_COINS), "trial");
    return getUser(row.tg_id);
  }
  return row;
}

// ─── صفحه‌ها ────────────────────────────────────────────────────────────────
//
// هر دکمهٔ منو دقیقاً یک صفحه دارد، و همان صفحه پشت یک دستور هم هست. کاربر
// تازه از منو می‌رود و کاربر قدیمی دستور می‌زند، بی‌آنکه دو مسیر جدا در کد
// باشد که از هم عقب بمانند.

/**
 * دکمهٔ بازگشت — هر صفحه‌ای که باز می‌شود باید راه برگشت داشته باشد.
 *
 * صفحه‌کلیدِ پایین همیشه هست، ولی وقتی کاربر چند پیام پایین رفته دیگر
 * دیده نمی‌شود و باید اسکرول کند. یک دکمهٔ شیشه‌ایِ زیر همان پیام، راهِ
 * برگشت را همان‌جا می‌گذارد که کاربر ایستاده.
 *
 * `home` منوی اصلی را دوباره می‌فرستد؛ بقیهٔ مقصدها برای صفحه‌های تودرتو
 * است (مثلاً از «یک جلسه» به فهرست جلسه‌ها).
 */
function withBack(kb: InlineKeyboard, to: "home" | null = "home"): InlineKeyboard {
  if (to !== "home") return kb;
  /**
   * ردیف تازه فقط وقتی باز می‌شود که ردیف **آخر** چیزی داشته باشد.
   *
   * `new InlineKeyboard()` خودش با یک ردیفِ خالی شروع می‌شود (`[[]]`), پس
   * شرطِ `length` روی خودِ آرایه گول‌زننده است و یک ردیف خالی جا می‌گذارد —
   * که تلگرام کل پیام را به‌خاطرش رد می‌کند.
   */
  const rows = kb.inline_keyboard;
  if (rows.length && rows[rows.length - 1]!.length) kb.row();
  return kb.text("🏠 منوی اصلی", "home");
}

/** منوی اصلی، به‌عنوان یک پیام — مقصدِ همهٔ دکمه‌های بازگشت. */
async function homeScreen(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "🏠 <b>منوی اصلی</b>",
      "",
      "از دکمه‌های پایین انتخاب کن، یا مستقیم صوت کلاستو بفرست.",
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: mainKeyboard },
  );
}

handlers.callbackQuery("home", async (ctx) => {
  await ctx.answerCallbackQuery();
  await homeScreen(ctx);
});

async function accountScreen(ctx: Context): Promise<void> {
  const u = touchUser(ctx);
  if (!u) return;
  const done = listSessions(u.tg_id, 500).filter((s) => s.status === "done").length;
  await reply(
    ctx,
    S.accountMessage({
      creditSec: u.credit_sec,
      usedSec: u.total_used_sec,
      refundedSec: totalShareRefunds(u.tg_id),
      sessionCount: done,
    }),
    { reply_markup: withBack(new InlineKeyboard().text("🪙 شارژ حساب", "topup")) },
  );
}

async function topupScreen(ctx: Context): Promise<void> {
  touchUser(ctx);
  if (!paymentConfigured()) {
    await reply(
      ctx,
      "فعلاً شارژ خودکار فعال نیست 🙏\n\n" +
        (config.SUPPORT_USERNAME
          ? `برای شارژ حساب به @${config.SUPPORT_USERNAME} پیام بده.`
          : "کمی بعد دوباره سر بزن."),
      { reply_markup: withBack(supportKeyboard(platformOf(ctx)) ?? new InlineKeyboard()) },
    );
    return;
  }
  await reply(ctx, packagesMessage(), { reply_markup: withBack(packagesKeyboard()) });
}

/**
 * تاریخچه.
 *
 * هر جلسه یک پیام با دکمه‌های خودش: جزوه، تحلیل، رونوشت، اشتراک‌گذاری. چیزی
 * که کاربر برایش برمی‌گردد دقیقاً همین است — «اون جزوهٔ هفتهٔ پیش کجا بود».
 */
/** چند جلسه در هر صفحه. هشت‌تا در یک پیام جا می‌شود بدون اسکرول زیاد. */
const HISTORY_PAGE = 8;

/**
 * عنوان کوتاه برای دکمه.
 *
 * تلگرام متن دکمه را در یک خط نشان می‌دهد و بلندش را می‌برد، پس خودمان
 * می‌بریم تا وسط کلمه قطع نشود.
 */
function sessionLabel(s: SessionRow): string {
  const icon =
    s.status === "done" ? (isTranscriptOnly(s.mode) ? "📄" : "📋") : s.status === "error" ? "❌" : "⏳";
  const title = (s.title ?? "بدون عنوان").trim();
  const short = title.length > 32 ? title.slice(0, 31).trimEnd() + "…" : title;
  const when = s.created_at.slice(5, 10).replace("-", "/");
  return `${icon} ${short} · ${toFaDigits(when)}`;
}

/**
 * فهرست جلسه‌ها — **یک پیام، دکمه‌ای، با صفحه‌بندی**.
 *
 * پیش‌تر برای هر جلسه یک پیام جدا فرستاده می‌شد؛ ده جلسه یعنی ده پیام پشت
 * سر هم که کل چت را پر می‌کرد و پیدا‌کردن جلسهٔ دیروز را سخت می‌کرد. حالا
 * یک پیام با فهرست دکمه‌هاست و محتوای هر جلسه فقط وقتی می‌آید که رویش زده
 * شود.
 *
 * `edit` یعنی همان پیام به‌روز شود نه اینکه پیام تازه‌ای بیاید — چون
 * صفحه‌بندی که هر بار یک پیام تازه بسازد، همان شلوغی را از راه دیگری
 * برمی‌گرداند.
 */
async function historyScreen(ctx: Context, page = 0, edit = false): Promise<void> {
  touchUser(ctx);
  const id = uid(ctx);
  const total = countSessions(id);

  if (total === 0) {
    await reply(
      ctx,
      "هنوز جلسه‌ای نفرستادی 📭\n\nیه فایل صوتی، ویس یا ویدیو بفرست تا شروع کنیم 🎧\n\n" +
        "<i>کلاست آنلاین بوده؟ ویدیوش هم قبوله.</i>",
    );
    return;
  }

  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  const safe = Math.min(Math.max(0, page), pages - 1);
  const rows = listSessions(id, HISTORY_PAGE, safe * HISTORY_PAGE);

  const kb = new InlineKeyboard();
  for (const s of rows) kb.text(sessionLabel(s), `sess:${s.id}`).row();

  // نوار صفحه‌بندی فقط وقتی که واقعاً بیش از یک صفحه باشد.
  if (pages > 1) {
    if (safe > 0) kb.text("▶️ قبلی", `hpage:${safe - 1}`);
    kb.text(`${toFaDigits(safe + 1)} از ${toFaDigits(pages)}`, "noop");
    if (safe < pages - 1) kb.text("بعدی ◀️", `hpage:${safe + 1}`);
  }

  const text = `<b>📚 جلسه‌های تو</b> — ${toFaDigits(total)} جلسه\n\n<i>روی هرکدوم بزنی، بازش می‌کنم.</i>`;

  if (edit) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    return;
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

/**
 * یک جلسه، با همان دکمه‌هایی که قبلاً کنار هر سطر بود.
 *
 * جدا شدنش از فهرست عمدی است: کاربر اول انتخاب می‌کند و بعد گزینه‌ها را
 * می‌بیند، نه اینکه هشت مجموعه دکمه هم‌زمان جلویش باشد.
 */
/**
 * جلسه‌ای که این کاربر حق دیدنش را دارد — مالکش باشد یا بابتش پرداخته باشد.
 *
 * ## چرا لازم شد
 *
 * دکمه‌های جزوه و رونوشت و تحلیل و برشِ صوت فقط جلسه را از پایگاه‌داده
 * می‌خواندند و هیچ‌جا نمی‌سنجیدند مالِ چه کسی است — در حالی که همهٔ دکمه‌های
 * هم‌ردیفشان (`son:`، `slink:`، `full:`، `retry:`) می‌سنجیدند. یعنی یک از قلم
 * افتادن بود، نه یک تصمیم.
 *
 * و شناسهٔ جلسه اسرارآمیز نیست: لینک دعوت به شکل `j_<sessionId>` است و مالک
 * همان را در گروه درس فوروارد می‌کند. پس هر کسی که در آن گروه است شناسه را
 * دارد، و با کلاینتی که کال‌بکِ دلخواه بفرستد جزوه را بدون پرداختِ سهم
 * برمی‌داشت — یعنی کلِ منطقِ سهم و سقف دور می‌خورد.
 *
 * عضو بودن کافی است، نه فقط مالک بودن: کسی که سهمش را داده باید بتواند
 * جزوه و رونوشت همان جلسه را دوباره بگیرد.
 */
function readableSession(ctx: Context, sessionId: string): SessionRow | null {
  const s = getSession(sessionId);
  if (!s) return null;
  const me = uid(ctx);
  if (s.tg_id === me) return s;
  return isMember(sessionId, me) ? s : null;
}

async function sessionCard(ctx: Context, sessionId: string): Promise<void> {
  const s = getSession(sessionId);
  if (!s || s.tg_id !== uid(ctx)) {
    await ctx.answerCallbackQuery({ text: "این جلسه پیدا نشد." });
    return;
  }
  await ctx.answerCallbackQuery();

  const kb = new InlineKeyboard();
  /**
   * جلسه‌ای که منتظر «بله» یا منتظر شارژ مانده باید از همین‌جا هم قابل
   * شروع باشد — وگرنه تنها راهش پیامِ اصلی است و آن پیام در چتِ شلوغ گم
   * می‌شود؛ یعنی کاربر باید فایل را دوباره بفرستد.
   */
  if ((s.status === "awaiting_confirm" || s.status === "awaiting_credit") && s.original_file) {
    kb.text("✅ شروع کن", `go:${s.id}`).row();
  }
  if (s.pdf_path) kb.text("📕 جزوه", `pdf:${s.id}`);
  if (s.report_json) kb.text("📋 تحلیل", `rep:${s.id}`);
  if (s.transcript_txt) kb.text("📄 رونوشت", `txt:${s.id}`);
  if (isTranscriptOnly(s.mode) && s.status === "done") {
    kb.row().text("✨ تحلیل کامل این جلسه", `full:${s.id}`);
  }
  if (s.mode === "full" && s.status === "done") {
    kb.row().text(
      s.share_enabled ? "🔗 لینک دعوت" : "👥 تقسیم با هم‌کلاسیا",
      s.share_enabled ? `slink:${s.id}` : `son:${s.id}`,
    );
  }
  kb.row().text("↩️ فهرست جلسه‌ها", "hpage:0").text("🏠 منوی اصلی", "home");

  const course = s.course_id ? getCourse(s.course_id) : null;
  const meta = [s.created_at.slice(0, 10), s.original_ms ? fmtDuration(s.original_ms) : null, course?.name]
    .filter(Boolean)
    .join(" · ");
  const status =
    s.status === "done" ? "" : s.status === "error" ? " ❌ <i>ناموفق</i>" : ` ⏳ <i>${s.status}</i>`;

  await ctx.reply(`<b>${escapeHtml(s.title ?? "بدون عنوان")}</b>${status}\n<i>${escapeHtml(meta)}</i>`, {
    parse_mode: "HTML",
    reply_markup: kb.inline_keyboard.length ? kb : undefined,
  });
}

async function coursesScreen(ctx: Context): Promise<void> {
  touchUser(ctx);
  const courses = listCourses(uid(ctx));
  const kb = withBack(new InlineKeyboard().text("➕ درس جدید", "newcourse"));
  if (courses.length === 0) {
    await reply(
      ctx,
      "<b>📘 درس‌های من</b>\n\nهنوز درسی ثبت نکردی.\n\n" +
        "<i>لازم هم نیست — بدون درس هم کار می‌کنم. ولی وقتی درس را ثبت کنی، اصطلاح‌های تخصصی‌اش را " +
        "جلسه‌به‌جلسه یاد می‌گیرم و رونویسی دقیق‌تر می‌شود.</i>",
      { reply_markup: kb },
    );
    return;
  }
  const lines = ["<b>📘 درس‌های من</b>", ""];
  for (const c of courses) {
    const terms = courseTerms(c).length;
    lines.push(
      `• <b>${escapeHtml(c.name)}</b>${c.professor ? ` — ${escapeHtml(c.professor)}` : ""}` +
        (terms ? `\n  <i>${toFaDigits(terms)} اصطلاح ازش یاد گرفتم</i>` : ""),
    );
  }
  await reply(ctx, lines.join("\n"), { reply_markup: kb });
}

/**
 * راهنمای فرستادن صوت — دو راه، و صریح دربارهٔ اینکه کدام برای چه کسی.
 *
 * محدودیت‌ها واقعی‌اند و کاربر باید **پیش از تلاش** بداندشان، نه بعد از یک
 * آپلود شکست‌خورده:
 *
 *   • **بله** فایل بالای بیست مگابایت را در خودِ ربات نمی‌پذیرد.
 *   • **تلگرام** برای کاربر ایرانی یعنی فیلترشکن، و آپلود صوت یک کلاس با
 *     آن سرعت دردناک است.
 *
 * پس ترتیب از ارزان‌ترین کار به گران‌ترین است: **فوروارد** (اگر صوت از قبل
 * در همان پیام‌رسان هست، هیچ بایتی از گوشی بالا نمی‌رود)، بعد **مینی‌اپ**
 * (آپلود روی اینترنت ملی، بدون سقف حجم).
 */
async function sendPrompt(ctx: Context): Promise<void> {
  const balanceSec = getUser(uid(ctx))?.credit_sec ?? 0;
  const kb = new InlineKeyboard();
  if (config.PUBLIC_URL.startsWith("https://")) {
    kb.webApp(BTN.app, `${config.PUBLIC_URL.replace(/\/+$/, "")}/app`);
  }

  /**
   * کوتاه، چون این صفحه سرِ راهِ کار است نه خودِ کار.
   *
   * نسخهٔ قبلی سه بند توضیح داشت و یکی از آن‌ها هم **دروغ** بود: «لینک ضبط
   * جلسه رو بفرست» در حالی که `fetch-url` فقط لینکِ مستقیمِ فایل را می‌گیرد
   * و صفحهٔ اسکای‌روم و ریلاین و امثالشان HTML برمی‌گردانند و رد می‌شوند.
   *
   * حجم هم **پیش از** تلاش گفته می‌شود، چون یک کلاس ۹۰ دقیقه‌ای معمولاً از
   * سقفِ بله رد می‌شود و بهتر است کاربر همین‌جا بداند نه بعد از فرستادن.
   *
   * ولی عدد با «حدود» گفته می‌شود، نه قطعی: سقفی که می‌شناسیم از جهتِ
   * **آپلود** اندازه‌گیری شده و جهتِ دانلود آزموده نشد (با API نمی‌شود فایل
   * بزرگ‌تر ساخت). وعدهٔ قطعیِ عددی که مطمئن نیستیم، همان اشتباهی است که
   * دربارهٔ «لینک ضبط جلسه» کردیم.
   *
   * روی تلگرام با MTProto سقفی در کار نیست و `downloadLimitFor` بی‌نهایت
   * می‌دهد — که اگر مستقیم چاپ شود «Infinity مگ» نشان داده می‌شود.
   */
  const limit = downloadLimitFor(ctx.api);
  const forwardLine = Number.isFinite(limit)
    ? `معمولاً تا حدود ${toFaDigits(Math.floor(limit / 1024 / 1024))} مگ.`
    : "هر حجمی.";
  await ctx.reply(
    [
      "🎧 <b>صوت کلاستو برسون</b>",
      "",
      `• <b>تو همین پیام‌رسان داریش؟</b> فورواردش کن همین‌جا — ${forwardLine}`,
      "• <b>تو گوشیته؟</b> دکمهٔ پایین — تا ۵۰۰ مگ، و اگه وسطش قطع شه از همون‌جا ادامه می‌ده.",
      "• <b>لینک؟</b> فقط لینک مستقیم فایل. صفحهٔ ضبط جلسه و یوتیوب نمیشه.",
      "",
      "ویدیو هم قبوله؛ فقط صداشو برمی‌دارم و بابت تصویر سکه نمی‌گیرم.",
      "",
      // موجودی و نرخ **پیش از** آپلود گفته می‌شود، وگرنه کاربر صوت ۹۰
      // دقیقه‌ای را می‌فرستد و آن‌سرِ کار «سکه‌هات کم میاد» می‌گیرد.
      `💰 موجودیت: <b>${fmtBalance(balanceSec)}</b> — ${RATE_LINE}.`,
      "",
      "<i>گوشی رو بذار رو میز نه تو کیف، و هرچی به استاد نزدیک‌تر بهتر.</i>",
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: withBack(kb) },
  );
}

// ─── دستورها ────────────────────────────────────────────────────────────────

handlers.command("start", async (ctx) => {
  const u = touchUser(ctx);

  const payload = (ctx.match as string | undefined)?.trim() ?? "";

  /**
   * لینک هدیه: /start g_<code>
   *
   * پیش از شاخهٔ دعوت و پیش از منوی خوشامد می‌آید، چون گیرنده روی لینکی زده
   * که به او سکه وعده داده — نشان‌دادن منوی عمومی به‌جای آن، خرابیِ وعده است.
   *
   * صفحه‌کلید پایین در هر دو حالت — موفق یا ناموفق — نشانده می‌شود: کسی که
   * از لینک هدیه آمده ممکن است هرگز `/start` ساده نزند، و بدون این پیام،
   * رباتی بی‌دکمه تحویل می‌گیرد.
   */
  if (payload.startsWith("g_")) {
    const code = payload.slice(2);
    const id = uid(ctx);
    const out = claimGiftCode(code, id);
    await ctx.reply("سلام 👋", { reply_markup: mainKeyboard });
    if (!out.ok) {
      await reply(ctx, refusalMessage(out.reason));
      return;
    }
    await reply(ctx, claimedMessage(out.coins, out.balanceSec));
    await notifyGiftClaimed(ctx, code, id, out.coins);
    return;
  }

  // لینک دعوت: /start j_<sessionId>
  if (payload.startsWith("j_")) {
    const sessionId = payload.slice(2);
    const s = getSession(sessionId);
    if (!s || s.status !== "done" || !s.share_enabled) {
      await reply(ctx, "این لینک معتبر نیست یا صاحبش اشتراک‌گذاری را خاموش کرده.");
      return;
    }
    if (s.tg_id === uid(ctx)) {
      await reply(ctx, `این جلسهٔ خودت است. از «${BTN.history}» بازش کن.`);
      return;
    }
    const preview = joinPreview(s);
    if (!preview) {
      await reply(ctx, "این جلسه در دسترس نیست.");
      return;
    }
    await ctx.reply(preview.text, { parse_mode: "HTML", reply_markup: preview.keyboard });
    return;
  }

  void u;

  /**
   * دو پیام لازم است چون تلگرام اجازه نمی‌دهد صفحه‌کلید ثابتِ پایین چت و
   * دکمهٔ شیشه‌ایِ زیر پیام در یک پیام باشند. پیام اول منو را می‌نشاند و
   * پیام دوم — همان توضیح محصول — دکمه‌ها را دارد.
   *
   * **دو دکمه، نه یکی.** کاربری که تازه رسیده دو حالت دارد و پیش‌فرض‌گرفتنِ
   * یکی، دیگری را می‌راند: آن که می‌خواهد اول بفهمد ماجرا چیست، و آن که
   * همین حالا صوتش را دارد و می‌خواهد شروع کند. پیش‌تر فقط «نمونه رو ببین»
   * بود و کسی که آماده بود، مجبور بود از تور رد شود تا به کار برسد.
   *
   * ترتیب عمدی است: «نمونه» اول می‌آید چون بیشترِ کاربران تازه هنوز چیزی
   * ندیده‌اند و اثباتِ کار، قوی‌ترین دلیل ماندن است.
   */
  await ctx.reply("سلام 👋", { reply_markup: mainKeyboard });
  await ctx.reply(WELCOME, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: new InlineKeyboard()
      .text("🎧 صوت می‌فرستم", "startnow")
      .row()
      .text("❓ چطور کار می‌کنه", "howto"),
  });
});

/**
 * «چطور کار می‌کنه» — و زیرش راهِ دیدن نمونه.
 *
 * ترتیب عمدی است: کاربری که این را زده هنوز قانع نشده، پس بعد از توضیح
 * باید **اثبات** ببیند نه دکمهٔ خرید. «نمونه» همان اثبات است و «بازگشت»
 * راهِ بیرون‌آمدن بدون گیرکردن.
 */
async function howtoScreen(ctx: Context): Promise<void> {
  await reply(ctx, HOW_IT_WORKS, {
    reply_markup: withBack(new InlineKeyboard().text("👀 نمونهٔ یه کلاس واقعی", WELCOME_CB)),
  });
}

handlers.callbackQuery("howto", async (ctx) => {
  await ctx.answerCallbackQuery();
  await howtoScreen(ctx);
});

/**
 * «شروع می‌کنم» — همان راهنمای فرستادن صوت.
 *
 * کاربری که این را می‌زند تصمیمش را گرفته؛ نباید دوباره متن فروش ببیند،
 * فقط باید بداند صوت را چطور برساند.
 */
handlers.callbackQuery("startnow", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await sendPrompt(ctx);
});

// ─── تور نمونه ──────────────────────────────────────────────────────────────
//
// چهار گام، هرکدام پشت دکمهٔ خودش. کاربر تازه به‌جای خواندن توصیف، خروجی
// واقعیِ یک کلاس واقعی را می‌بیند — و خودش تصمیم می‌گیرد جلو برود یا نه.

/** دکمهٔ گام بعد را از پیامِ قبلی برمی‌دارد تا کاربر دوبار نزند. */
async function advance(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
}

/**
 * شناسهٔ پیام صوتِ نمونه در چتِ همین کاربر.
 *
 * تلگرام زمان‌ها را فقط وقتی لینکِ پخش می‌کند که پیام ریپلایِ یک صوت در
 * **همان چت** باشد، پس شناسه‌اش تا پایان تور لازم است. در حافظه می‌ماند و
 * نه در پایگاه‌داده: اگر ربات ری‌استارت شود بدترین اتفاق این است که کاربر
 * زمان‌های غیرقابل‌کلیک ببیند، و آن ارزش یک ستون تازه را ندارد.
 */
const demoAudioMsg = new Map<number, number>();

/**
 * شناسهٔ صوت نمونه را از خودِ دکمه می‌خواند، و اگر نبود از حافظه.
 *
 * `callback_data` تا ۶۴ بایت جا دارد و شناسهٔ پیام یک عدد کوچک است، پس
 * می‌شود آن را در خود دکمه حمل کرد: `demo:timeline:4213`. با این کار
 * زنجیرهٔ ریپلای به حافظهٔ فرایند وابسته نیست و اگر ربات وسط تور ری‌استارت
 * شود، زمان‌ها همچنان لینکِ پخش می‌مانند.
 *
 * حافظه به‌عنوان مسیر پشتیبان می‌ماند تا دکمه‌های قدیمیِ بدون شناسه — آنهایی
 * که پیش از این تغییر فرستاده شده‌اند — همچنان کار کنند.
 */
function demoAudioIdOf(ctx: Context): number | null {
  const fromButton = Number((ctx.callbackQuery?.data ?? "").split(":")[2]);
  if (Number.isFinite(fromButton) && fromButton > 0) return fromButton;
  return demoAudioMsg.get(uid(ctx)) ?? null;
}

handlers.callbackQuery(DEMO_CB.recap, async (ctx) => {
  await advance(ctx);
  await reply(ctx, DEMO_INTRO);

  /**
   * اول خودِ صوت.
   *
   * بدون این، «۰۷:۲۴» فقط یک عدد است و کاربر نمی‌تواند وعده‌ای را که در
   * پیام خوش‌آمد داده‌ایم امتحان کند. با `file_id` فرستاده می‌شود پس فایل
   * ۹۱ مگابایتی دوباره آپلود نمی‌شود.
   */
  /**
   * بار اول فایل آپلود می‌شود و `file_id`اش برای همان سکو نگه داشته می‌شود؛
   * دفعه‌های بعد فقط همان ارجاع می‌رود. شناسه به تفکیک سکوست چون شناسهٔ
   * تلگرام روی بله کار نمی‌کند.
   */
  const platform = platformOf(ctx);
  const fileId = sampleAudioFileId(platform);
  const sent = !fileId
    ? null
    : await ctx
    .replyWithAudio(fileId, {
      caption:
        `🎧 <b>صوت همین جلسه</b> — ${escapeHtml(SAMPLE_COURSE)}\n` +
        "<i>نگهش دار؛ پایین رو زمان‌ها که بزنی، از همون‌جا پخش می‌شه.</i>",
      parse_mode: "HTML",
    })
    .catch((e: unknown) => {
      logger.warn({ platform, err: String(e) }, "demo audio failed");
      return null;
    });
  if (!fileId) {
    logger.warn({ platform }, "sample audio file id not configured; tour has no audio");
  }
  if (sent) demoAudioMsg.set(uid(ctx), sent.message_id);
  // شناسهٔ صوت در خودِ دکمه حمل می‌شود تا زنجیرهٔ ریپلای به حافظه وابسته نباشد
  const audioSuffix = sent ? `:${sent.message_id}` : "";

  await reply(
    ctx,
    S.recapMessage({
      report: SAMPLE_REPORT,
      courseName: SAMPLE_COURSE,
      sessionDate: null,
      durationMs: SAMPLE_DURATION_MS,
      savedMs: 0,
      qualityWarnings: [],
    }),
    { reply_markup: stepKeyboard(DEMO_CB.extracted + audioSuffix, "بعدی: چی از کلاس درآوردم ←") },
  );
});

/** ریپلای به صوت نمونه، اگر فرستاده شده باشد. */
function demoReplyTo(ctx: Context): Record<string, unknown> {
  const id = demoAudioIdOf(ctx);
  return id ? { reply_parameters: { message_id: id, allow_sending_without_reply: true } } : {};
}

// الگو پسوند اختیاریِ شناسهٔ صوت را هم می‌پذیرد: `demo:extracted:4213`
handlers.callbackQuery(new RegExp(String.raw`^${DEMO_CB.extracted}(?::\d+)?$`), async (ctx) => {
  await advance(ctx);
  const audioId = demoAudioIdOf(ctx);
  await reply(ctx, S.extractedMessage(SAMPLE_REPORT), {
    ...demoReplyTo(ctx),
    reply_markup: stepKeyboard(
      DEMO_CB.timeline + (audioId ? `:${audioId}` : ""),
      "بعدی: بخش‌بندی کلاس ←",
    ),
  });
});

handlers.callbackQuery(new RegExp(String.raw`^${DEMO_CB.timeline}(?::\d+)?$`), async (ctx) => {
  await advance(ctx);
  // زمان‌ها فقط وقتی لینک می‌شوند که پیام واقعاً ریپلایِ صوت باشد.
  const audioId = demoAudioIdOf(ctx);
  await reply(ctx, S.timelineMessage(SAMPLE_REPORT, audioId !== null), {
    ...demoReplyTo(ctx),
    reply_markup: stepKeyboard(DEMO_CB.outro, "بعدی: جزوهٔ این جلسه ←"),
  });
});

handlers.callbackQuery(DEMO_CB.outro, async (ctx) => {
  await advance(ctx);

  // جزوه و رونوشتِ همان جلسهٔ نمونه — دو تکهٔ آخرِ خروجی واقعی.
  await sendDoc(ctx, SAMPLE_PDF_PATH, "نمونه-جزوه.pdf", {
    caption: "📕 <b>جزوهٔ همین جلسه</b>\n<i>فقط محتوای درس؛ نکته‌های امتحانی داخل متن رنگی‌اند.</i>",
    parse_mode: "HTML",
  });
  await sendDoc(ctx, SAMPLE_TRANSCRIPT_PATH, "نمونه-رونوشت.txt", {
    caption: "📄 رونوشت کامل با مهر زمانی",
  });

  await reply(ctx, outroMessage(config.SUPPORT_USERNAME), {
    reply_markup: withBack(new InlineKeyboard().text("🎧 صوت می‌فرستم", "startnow")),
  });
  demoAudioMsg.delete(uid(ctx));
});

handlers.command("help", (ctx) => reply(ctx, S.HELP, { reply_markup: mainKeyboard }));
handlers.command("menu", (ctx) => ctx.reply("بفرما 👇", { reply_markup: mainKeyboard }));
handlers.command("credit", (ctx) => accountScreen(ctx));
handlers.command("buy", (ctx) => topupScreen(ctx));

handlers.command("course", async (ctx) => {
  touchUser(ctx);
  convo.set(uid(ctx), { kind: "await_course_name" });
  await reply(
    ctx,
    "اسم درس چیه؟\n\n<i>مثلاً: ریاضی مهندسی</i>",
  );
});

handlers.command("courses", (ctx) => coursesScreen(ctx));
handlers.command("history", (ctx) => historyScreen(ctx));

handlers.command("cancel", async (ctx) => {
  const id = uid(ctx);
  const rows = listSessions(id, 5).filter((s) => !["done", "error", "cancelled"].includes(s.status));
  let done = false;
  for (const s of rows) if (cancelJob(s.id)) { updateSession(s.id, { status: "cancelled" }); done = true; }
  convo.delete(id);
  await reply(ctx, done ? "لغو شد ✅" : "کاری در جریان نیست.");
});

/**
 * شارژ مستقیم حساب کسی که شناسه‌اش را داری.
 *
 *   /grant <tg_id> <coins>
 *
 * دو چیز اینجا اصلاح شد: واحد از دقیقه به **سکه** رفت — حالا که هر سکه یک
 * دقیقه است این دو یکی‌اند، ولی نوشتنش به سکه یعنی اگر روزی نرخ عوض شد این
 * دستور همچنان همان چیزی را می‌دهد که ادمین تایپ کرده. و آرگومان‌ها دیگر با
 * الگوی سه‌تایی خوانده نمی‌شوند: `ctx.match` خودِ دستور را در بر ندارد، پس
 * عنصر اول همان شناسه است و انداختنش یعنی شناسه به‌جای مقدار خوانده می‌شد.
 *
 * برای کسی که هنوز با ربات حرف نزده شناسه‌ای وجود ندارد — آنجا `/gift` کار
 * درست است، نه این.
 */
handlers.command("grant", async (ctx) => {
  if (!isAdmin(ctx)) return;
  // رقم فارسی/عربی هم پذیرفته می‌شود — همان دلیلی که در `/gift` توضیح داده شد.
  const digits = (s: string | undefined) =>
    (s ?? "")
      .replace(/[٬,]/g, "")
      .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

  const [target, amount] = ((ctx.match as string | undefined) ?? "").trim().split(/\s+/);
  const t = Number(digits(target));
  const coins = Number(digits(amount));
  if (!Number.isFinite(t) || !Number.isFinite(coins) || coins <= 0) {
    await reply(
      ctx,
      "استفاده: <code>/grant &lt;tg_id&gt; &lt;coins&gt;</code>\n\n" +
        `<i>هر سکه یک دقیقه صوت. برای کسی که هنوز شناسه‌ای ندارد از </i><code>/gift</code><i> استفاده کن.</i>`,
    );
    return;
  }
  if (!getUser(t)) {
    await reply(ctx, "چنین کاربری در پایگاه‌داده نیست. اگر هنوز با ربات حرف نزده، <code>/gift</code> بساز.");
    return;
  }
  const balance = grant(t, coinsToSec(coins), "grant");
  await reply(
    ctx,
    `✅ ${fmtCoins(coins)} به ${escapeHtml(describeUser(t))} اضافه شد.\n\nموجودی جدیدش: <b>${fmtBalance(balance)}</b>`,
  );
  await notifyUser(
    t,
    `🎁 <b>${fmtCoins(coins)}</b> به حسابت اضافه شد!\n\nموجودی‌ات: <b>${fmtBalance(balance)}</b>`,
  ).catch(() => {});
});

/**
 * ساخت لینک هدیه.
 *
 *   /gift                 →  ${DEFAULT_GIFT_COINS} سکه، یک‌بارمصرف
 *   /gift 50              →  ۵۰ سکه، یک‌بارمصرف
 *   /gift 20 x10          →  ۲۰ سکه برای هرکدام از ۱۰ نفر اول
 *   /gift 20 x10 7d       →  همان، با هفت روز مهلت
 *   /gift 20 برای رضا     →  یادداشت، تا بعداً معلوم باشد این کد بابت چه بود
 *
 * ترتیب آرگومان‌ها آزاد است چون این دستور را ادمین با عجله و از روی موبایل
 * می‌زند؛ هر چیزی که «xعدد» باشد ظرفیت است، هرچه «عددd» باشد مهلت، اولین
 * عددِ خالی مقدار سکه، و باقی‌مانده یادداشت.
 */
handlers.command("gift", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const parts = ((ctx.match as string | undefined) ?? "").trim().split(/\s+/).filter(Boolean);
  let coins: number | null = null;
  let maxUses = 1;
  let days: number | null = null;
  const words: string[] = [];

  for (const raw of parts) {
    /**
     * رقم فارسی و عربی هم عدد است.
     *
     * ادمین این دستور را از روی موبایل و با صفحه‌کلید فارسی می‌زند، و
     * `/gift ۵۰` پیش‌تر بی‌صدا به «یادداشت» می‌افتاد: کد با ۲۰ سکهٔ پیش‌فرض
     * ساخته می‌شد و هیچ‌کس نمی‌فهمید تا وقتی گیرنده کمتر از انتظار بگیرد.
     */
    const tok = raw
      .replace(/[٬,]/g, "")
      .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
    let m: RegExpMatchArray | null;
    if ((m = tok.match(/^x(\d+)$/i))) maxUses = Number(m[1]);
    else if ((m = tok.match(/^(\d+)d$/i))) days = Number(m[1]);
    else if (coins === null && /^\d+$/.test(tok)) coins = Number(tok);
    else words.push(raw);
  }

  coins ??= DEFAULT_GIFT_COINS;
  if (coins <= 0 || maxUses <= 0) {
    await reply(ctx, "مقدار سکه و ظرفیت باید بیشتر از صفر باشد.");
    return;
  }

  const { gift, link } = await mintGift(ctx.api, {
    coins,
    maxUses,
    note: words.join(" ") || null,
    createdBy: uid(ctx),
    days,
  });

  // معادل دقیقه‌ای فقط وقتی می‌آید که به ساعت رسیده باشد؛ «۲۰ سکه — ۲۰ دقیقه»
  // یک عدد را دو بار می‌گوید.
  const asTime = coinsAsMinutesIfUseful(gift.coins);

  // یادداشت با `.filter(Boolean)` حذف نمی‌شود، چون آن خطوطِ خالیِ عمدی را هم
  // با خودش می‌برد و فاصله‌گذاری پیام را به هم می‌ریزد.
  const facts = [
    asTime ? `${fmtCoins(gift.coins)} — ${asTime}` : fmtCoins(gift.coins),
    gift.max_uses === 1 ? "یک‌بارمصرف" : `برای ${toFaDigits(gift.max_uses)} نفر اول`,
    days ? `مهلت: ${toFaDigits(days)} روز` : "بدون مهلت",
    ...(gift.note ? [`یادداشت: ${escapeHtml(gift.note)}`] : []),
  ];

  await reply(
    ctx,
    [
      "🎁 <b>لینک هدیه ساخته شد</b>",
      "",
      ...facts,
      "",
      // لینک داخل <code> است تا با یک لمس کپی شود و تلگرام پیش‌نمایشش را باز نکند.
      `<code>${link}</code>`,
      "",
      `<i>برای باطل‌کردن: </i><code>/ungift ${gift.code}</code>`,
    ].join("\n"),
  );
});

/** باطل‌کردن کدی که هنوز خرج نشده — یا خرج شده و جلوی بقیه‌اش باید گرفته شود. */
handlers.command("ungift", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const code = ((ctx.match as string | undefined) ?? "").trim().replace(/^g_/, "");
  if (!code) {
    await reply(ctx, "استفاده: <code>/ungift &lt;code&gt;</code>");
    return;
  }
  if (!getGift(code)) {
    await reply(ctx, "چنین کدی نیست.");
    return;
  }
  // سکه‌هایی که برداشته شده‌اند پس گرفته نمی‌شوند: کاربر ممکن است خرجشان کرده
  // باشد و پس‌گرفتنِ اعتبارِ مصرف‌شده، موجودیِ منفی می‌سازد.
  await reply(
    ctx,
    revokeGift(code)
      ? `✅ کد <code>${code}</code> باطل شد.\n\n<i>سکه‌هایی که تا الان برداشته شده سر جایش می‌ماند.</i>`
      : "این کد از قبل باطل بود.",
  );
});

/** کدهای اخیر و وضعیتشان. */
handlers.command("gifts", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = listGifts(20);
  if (rows.length === 0) {
    await reply(ctx, "هنوز کد هدیه‌ای ساخته نشده. با <code>/gift</code> بساز.");
    return;
  }
  await reply(ctx, ["🎁 <b>کدهای هدیه</b>", "", ...rows.map((g) => giftSummary(g))].join("\n"));
});

/**
 * خبردادن به ادمین‌ها که هدیه برداشته شد.
 *
 * بی‌صدا شکست می‌خورد: گیرنده سکه‌اش را گرفته و هیچ خطایی در مسیر او نباید
 * از این خبررسانی بیرون بزند.
 */
async function notifyGiftClaimed(ctx: Context, code: string, tgId: number, coins: number): Promise<void> {
  const text = [
    "🎁 <b>هدیه برداشته شد</b>",
    "",
    `کد: <code>${escapeHtml(code)}</code>`,
    `گیرنده: ${escapeHtml(describeUser(tgId))} — <code>${tgId}</code>`,
    fmtCoins(coins),
  ].join("\n");
  /**
   * هر ادمین از رباتِ سکوی خودش خبر می‌گیرد.
   *
   * پیش‌تر همه با `ctx.api` فرستاده می‌شد — یعنی اگر هدیه‌ای در بله برداشته
   * می‌شد، شناسهٔ تلگرامیِ ادمین به API بله داده می‌شد و پیام یا شکست
   * می‌خورد یا به چتِ بی‌ربطی می‌رفت.
   */
  const targets: Array<[Api | null, number]> = [
    ...config.ADMIN_IDS.map((id) => [bot.api, id] as [Api, number]),
    ...config.BALE_ADMIN_IDS.map((id) => [baleBot?.api ?? null, id] as [Api | null, number]),
  ];
  for (const [api, admin] of targets) {
    if (!api) continue;
    await api.sendMessage(admin, text, { parse_mode: "HTML" }).catch((e: unknown) => {
      logger.warn({ admin, err: String(e) }, "notify gift claim failed");
    });
  }
}

handlers.command("privacy", (ctx) =>
  reply(ctx, S.PRIVACY, { reply_markup: withBack(new InlineKeyboard()) }),
);

/**
 * حذف داده به‌خواستِ کاربر.
 *
 * هر محصولی که صدای آدم‌ها را نگه می‌دارد باید راهی برای پاک‌کردنش داشته
 * باشد، و آن راه باید یک دستور ساده باشد نه ایمیل‌زدن به پشتیبانی.
 * جلسه‌ای که اشتراکی شده استثناست: پاک‌کردنش دسترسی کسانی را که بابتش
 * پرداخت کرده‌اند از بین می‌برد، پس فقط اشتراک‌گذاری‌اش خاموش می‌شود.
 */
handlers.command("forget", async (ctx) => {
  const id = uid(ctx);
  const arg = (ctx.match as string | undefined)?.trim() ?? "";

  if (arg !== "همه" && arg !== "all") {
    const rows = listSessions(id, 50);
    await reply(
      ctx,
      `<b>حذف داده</b>\n\n` +
        `الان ${toFaDigits(rows.length)} جلسه از تو ذخیره است.\n\n` +
        `برای پاک‌کردن همه‌شان — صوت، رونوشت، تحلیل و جزوه — بنویس:\n` +
        `<code>/forget همه</code>\n\n` +
        `<i>سکه‌هایت دست‌نخورده می‌مانند. جلساتی که اشتراکی کرده‌ای فقط از اشتراک خارج می‌شوند، ` +
        `چون پاک‌کردنشان دسترسی کسانی را که بابتشان پرداخت کرده‌اند از بین می‌برد.</i>`,
    );
    return;
  }

  let removed = 0;
  let unshared = 0;
  for (const s of listSessions(id, 500)) {
    /**
     * جلسهٔ اشتراکی فقط از اشتراک خارج می‌شود، و **فایل‌هایش می‌مانند**.
     *
     * پیش‌تر حلقه پیش از هر شرطی صوت و جزوه را از دیسک پاک می‌کرد و بعد تازه
     * شاخهٔ اشتراکی را جدا می‌کرد — یعنی دقیقاً خلافِ چیزی که پیام به کاربر
     * وعده می‌دهد: جزوه‌ای که هم‌کلاسی بابتش سکه داده بود از بین می‌رفت و
     * دکمهٔ جزوه‌اش از آن به بعد خطا می‌داد.
     *
     * صوت هم می‌ماند، وگرنه زمان‌های گزارشِ همان هم‌کلاسی‌ها دیگر لینکِ پخش
     * نمی‌شوند. خاموش‌شدنِ اشتراک جلوی پیوستنِ تازه را می‌گیرد، که همان چیزی
     * است که کاربر خواسته.
     */
    if (s.share_enabled) {
      setShareEnabled(s.id, false);
      unshared++;
      continue;
    }
    if (s.original_file) await fs.unlink(s.original_file).catch(() => {});
    if (s.pdf_path) await fs.unlink(s.pdf_path).catch(() => {});
    purgeSession(s.id);
    removed++;
  }
  await reply(
    ctx,
    `✅ ${toFaDigits(removed)} جلسه کامل پاک شد` +
      (unshared ? ` و ${toFaDigits(unshared)} جلسهٔ اشتراکی از اشتراک خارج شد.` : ".") +
      `\n\n<i>سکه‌هایت دست‌نخورده‌اند.</i>`,
  );
});

handlers.command("stats", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const q = queueDepth();
  await reply(
    ctx,
    `صف: ${toFaDigits(q.active)} فعال، ${toFaDigits(q.pending)} در انتظار.\n` +
      `شارژهای بی‌تکلیف: ${toFaDigits(pendingTopups(50).length)}`,
  );
});

/** فهرست شارژهای منتظر تأیید — برای وقتی که پیامِ اعلانِ ادمین گم شده باشد. */
handlers.command("pending", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = pendingTopups(20);
  if (rows.length === 0) {
    await reply(ctx, "شارژ بی‌تکلیفی نیست ✅");
    return;
  }
  for (const t of rows) {
    const u = getUser(t.tg_id);
    const kb = new InlineKeyboard().text("✅ تأیید", `tok:${t.id}`).text("❌ رد", `trej:${t.id}`);
    const caption =
      `<code>${escapeHtml(t.id)}</code> — ${escapeHtml(u?.name ?? String(t.tg_id))}\n` +
      `${fmtCoins(t.coins)} · ${fmtToman(t.price_toman)}\n<i>${escapeHtml(t.created_at)}</i>`;
    if (t.receipt_file_id) {
      await ctx.replyWithPhoto(t.receipt_file_id, { caption, parse_mode: "HTML", reply_markup: kb });
    } else {
      await ctx.reply(caption, { parse_mode: "HTML", reply_markup: kb });
    }
  }
});

// ─── پیام متنی: اول منو، بعد ادامهٔ گفت‌وگو ─────────────────────────────────

handlers.on("message:text", async (ctx) => {
  const id = uid(ctx);
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  /**
   * دکمه‌های منو پیش از وضعیت گفت‌وگو بررسی می‌شوند.
   *
   * اگر کاربر وسط ثبت درس روی «حساب و سکه‌ها» بزند، منظورش رفتن به حساب است
   * نه اینکه اسم درسش این باشد. برعکسش کاربر را در گفت‌وگویی حبس می‌کند که
   * راه خروجی ندارد.
   */
  const action = menuActionOf(text);
  if (action) {
    convo.delete(id);
    if (action === "send") return void (await sendPrompt(ctx));
    if (action === "history") return void (await historyScreen(ctx));
    if (action === "account") return void (await accountScreen(ctx));
    if (action === "courses") return void (await coursesScreen(ctx));
    if (action === "how") return void (await howtoScreen(ctx));
    /**
     * دکمهٔ مینی‌اپ خودش پنجره را باز می‌کند و اصلاً متنی نمی‌فرستد، پس
     * عملاً به اینجا نمی‌رسد. صریح نوشته شده تا اگر روزی رسید (کلاینت
     * قدیمی، یا کاربری که برچسب را دستی تایپ کند) جواب «پشتیبانی» نگیرد.
     */
    if (action === "app") {
      return void (await reply(
        ctx,
        config.PUBLIC_URL
          ? `اپ را از دکمهٔ «${BTN.app}» باز کن، یا از مرورگر: ${config.PUBLIC_URL}`
          : "فعلاً نسخهٔ تحت وب فعال نیست. همین‌جا صوتت را بفرست 🎧",
      ));
    }
    return void (await reply(ctx, supportMessage(), { reply_markup: withBack(supportKeyboard(platformOf(ctx)) ?? new InlineKeyboard()) }));
  }

  const state = convo.get(id);

  /**
   * لینک صوت — ولی نه وسط گفت‌وگو.
   *
   * اگر کاربر در حال ثبت درس است، متنش اسم درس است حتی اگر شبیه لینک باشد.
   * بیرون از گفت‌وگو، متنی که لینک دارد یعنی «این ضبط کلاسمه، بگیرش».
   */
  if (!state) {
    const url = extractUrl(text);
    if (url) return void (await handleLink(ctx, url));
  }

  if (!state) {
    touchUser(ctx);
    await reply(
      ctx,
      "یه فایل صوتی بفرست تا شروع کنم 🎧\n\n" +
        "<i>ویدیو هم قبوله — صداشو خودم برمی‌دارم.</i>",
      { reply_markup: mainKeyboard },
    );
    return;
  }

  if (state.kind === "await_course_name") {
    convo.set(id, { kind: "await_professor", courseName: text.slice(0, 80) });
    await reply(ctx, "اسم استاد؟ اگه نمی‌خوای بنویسی «-» بفرست.");
    return;
  }

  if (state.kind === "await_professor") {
    const prof = text === "-" ? null : text.slice(0, 80);
    const c = createCourse(id, state.courseName, prof);
    convo.delete(id);
    await reply(
      ctx,
      `✅ <b>${escapeHtml(c.name)}</b> ثبت شد.\n\n` +
        "<i>اصطلاحای تخصصی این درسو یاد می‌گیرم، پس هر جلسه دقیق‌تر میشم.</i>\n\n" +
        "حالا صوت کلاسو بفرست 🎧\n\n<i>ویدیو هم قبوله.</i>",
    );
  }
});

// ─── عکس: رسید پرداخت ───────────────────────────────────────────────────────
//
// پیش از هندلر صوت می‌آید و اگر عکس را مصرف نکند با next() رد می‌کند، تا
// سندِ صوتی همچنان به مسیر اصلی برسد.

handlers.on(["message:photo", "message:document"], async (ctx, next) => {
  const doc = ctx.message?.document;
  const fileId =
    ctx.message?.photo?.at(-1)?.file_id ?? (doc?.mime_type?.startsWith("image/") ? doc.file_id : undefined);
  if (!fileId) return next();

  touchUser(ctx);
  if (await receiveReceipt(ctx, fileId)) return;

  await reply(
    ctx,
    `این عکسه 🤔 من فایل <b>صوتی</b> می‌خوام.\n\n` +
      `<i>اگه رسید پرداخته، اول از «${BTN.account}» پکیجت رو انتخاب کن، بعد رسید رو بفرست.</i>`,
  );
});

// ─── دریافت صوت ─────────────────────────────────────────────────────────────

handlers.on(
  ["message:audio", "message:voice", "message:document", "message:video_note", "message:video"],
  async (ctx) => {
  const u = touchUser(ctx);
  if (!u) return;
  const id = u.tg_id;

  const msg = ctx.message!;
  /**
   * ویدیو هم پذیرفته می‌شود.
   *
   * کلاس آنلاین که ضبط می‌شود ویدیو است، و دانشجو همان را دارد. ffmpeg در
   * تمام مسیرها با `-vn` صدا زده می‌شود، پس تصویر همان اول کنار گذاشته
   * می‌شود و از آنجا به بعد فرقی با یک فایل صوتی ندارد.
   */
  const mediaDoc =
    msg.document?.mime_type?.startsWith("audio/") || msg.document?.mime_type?.startsWith("video/")
      ? msg.document
      : null;
  const media = msg.audio ?? msg.voice ?? msg.video ?? msg.video_note ?? mediaDoc;

  if (!media) {
    await reply(ctx, "این صوت نیست 🤔 یه فایل صوتی، ویس یا ویدیو بفرست.");
    return;
  }

  if (isBusy(String(id))) {
    await reply(ctx, "یه کار دارم انجام می‌دم، صبر کن تموم شه 🙏");
    return;
  }
  if (await tooManyPending(ctx, id)) return;

  const sessionId = shortId();

  /**
   * **قیمت پیش از دانلود.**
   *
   * سکو مدت را همان‌جا در پیام می‌گوید، پس برای قیمت‌دادن لازم نیست فایل را
   * بگیریم. کاربری که منصرف می‌شود یا اعتبارش کم است، دیگر هیچ بایتی روی
   * سرور نمی‌آورد — روی کلاسِ چندصدمگابایتی این تفاوتِ کوچکی نیست.
   *
   * واحدِ آن عدد از **حجم فایل** تشخیص داده می‌شود نه از نام سکو، چون بله
   * مدتِ ویس را به میلی‌ثانیه می‌دهد و تلگرام به ثانیه. جزئیاتش در
   * `declaredDurationSec`.
   *
   * `sec === 0` یعنی سکو مدتی نگفته — که برای فایلِ فرستاده‌شده به‌صورت
   * **سند** عادی است. آن‌وقت چاره‌ای جز دانلود و `probe` نیست و مسیر قدیمی
   * ادامه پیدا می‌کند.
   */
  const declared = declaredDurationSec(
    "duration" in media && media.duration ? media.duration : 0,
    media.file_size ?? 0,
    config.MAX_AUDIO_MINUTES * 60,
  );
  if (declared.sec > 0) {
    await holdBeforeDownload(ctx, {
      sessionId,
      sec: declared.sec,
      fileId: media.file_id,
      messageId: msg.message_id,
    });
    return;
  }

  const durationSec = 0;
  const dl = await downloadMedia(ctx, {
    sessionId,
    fileId: media.file_id,
    messageId: msg.message_id,
    declaredSize: media.file_size ?? 0,
  });
  if (!dl) return;
  const { audioFile, route } = dl;

  await intakeAudio(ctx, {
    sessionId,
    audioFile,
    downloadRoute: route,
    messageId: msg.message_id,
    fileId: media.file_id,
    declaredDurationSec: durationSec,
  });
},
);

// ─── دریافت از لینک ─────────────────────────────────────────────────────────

/**
 * کلاس آنلاین لینک دارد، نه فایل.
 *
 * ضبط جلسه‌های اسکای‌روم و ادوبی کانکت و مشابهشان یک آدرس است که دانشجو
 * دارد. پیش از این باید خودش دانلود می‌کرد و دوباره آپلود — روی اینترنت
 * ایران، برای یک فایل چندصدمگابایتی، همان‌جا کار را رها می‌کرد.
 *
 * از لحظه‌ای که فایل روی دیسک نشست، هیچ فرقی با صوتِ فرستاده‌شده ندارد و از
 * `intakeAudio` رد می‌شود. ویدیو هم مسئله‌ای نیست: ffmpeg همه‌جا `-vn` دارد.
 */
async function handleLink(ctx: Context, url: string): Promise<void> {
  const u = touchUser(ctx);
  if (!u) return;
  const id = u.tg_id;

  if (isBusy(String(id))) {
    await reply(ctx, "یه کار دارم انجام می‌دم، صبر کن تموم شه 🙏");
    return;
  }
  if (await tooManyPending(ctx, id)) return;

  const sessionId = shortId();
  const statusMsg = await ctx.reply("⬇️ دارم از لینک می‌گیرم…", { parse_mode: "HTML" });

  let fetched: FetchUrlResult;
  try {
    // مثل مسیر تلگرام، پیشرفت با گام درشت نشان داده می‌شود — ویرایش پیام
    // محدودیت نرخ دارد و یک دانلود بزرگ صدها بار صدا می‌زند.
    let lastShown = 0;
    fetched = await fetchUrlToFile({
      url,
      destDir: config.audioDir,
      baseName: sessionId,
      onProgress: (done, total) => {
        if (total < 20 * 1024 * 1024) return;
        const p = Math.floor((done / total) * 10) * 10;
        if (p <= lastShown || p >= 100) return;
        lastShown = p;
        void ctx.api
          .editMessageText(ctx.chat!.id, statusMsg.message_id, `⬇️ دارم از لینک می‌گیرم… ${toFaDigits(p)}٪`)
          .catch(() => {});
      },
    });
  } catch (e) {
    // پیام کاربر از خودِ خطا می‌آید: هر شاخه دقیقاً می‌داند چه چیزی خراب شده
    // و کاربر باید چه کار کند. یک پیام عمومی هر سه حالت را یکسان می‌کرد.
    const text =
      e instanceof UrlFetchError
        ? `❌ ${e.userMessage}`
        : "❌ نشد از این لینک فایلو بگیرم. یه بار دیگه امتحان کن.";
    if (!(e instanceof UrlFetchError)) logger.error({ err: String(e), url }, "url fetch failed");
    await ctx.api
      .editMessageText(ctx.chat!.id, statusMsg.message_id, text, { parse_mode: "HTML" })
      .catch(() => {});
    return;
  }

  await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

  await intakeAudio(ctx, {
    sessionId,
    audioFile: fetched.filePath,
    downloadRoute: "url",
    // لینک نه پیام صوتی دارد نه `file_id` — هر دو عمداً خالی می‌مانند
    declaredDurationSec: 0,
    sourceUrl: url,
  });
}

/**
 * از «فایل روی دیسک است» تا «کار شروع شد» — مسیر مشترک هر منبعی.
 *
 * فایلِ فرستاده‌شده و لینکِ دانلودشده از اینجا به بعد فرقی ندارند: هر دو یک
 * صوت روی دیسک‌اند. این تابع عمداً بیرون کشیده شد چون بندهای زیر ترتیب حساسی
 * دارند — بایگانی پیش از پردازش، مدت واقعی پیش از رزرو، و هشدار اعتبار پیش
 * از هر کاری. دو نسخهٔ موازی از این ترتیب یعنی روزی یکی‌شان عقب می‌ماند.
 */
/**
 * فایل را از سکو بگیر و روی دیسک بگذار — با تلاش دوباره و پیامِ زندهٔ پیشرفت.
 *
 * از دلِ دست‌کدِ صوت بیرون کشیده شد چون حالا **دو** صدازننده دارد: مسیرِ
 * قدیمی (فایلی که سکو مدتش را نگفته و باید probe شود) و دکمهٔ «شروع کن»
 * روی جلسه‌ای که قیمتش پیش از دانلود اعلام شده بود.
 *
 * `null` یعنی نشد — و پیامِ مناسبش همین‌جا به کاربر داده شده، پس صدازننده
 * فقط باید برگردد.
 */
/**
 * پیامِ شکست باید برسد — حتی وقتی همان سکو خراب است.
 *
 * **این باگی بود که کاربر را روی «تلاش ۲» فریز کرد.** پنجم سپتامبر ۲۰۲۶، API
 * بله یک دقیقه‌ای پایین رفت. تلاش‌های دانلود شکست خوردند و کد رفت سراغ پیامِ
 * «نشد» — ولی آن `editMessageText` هیچ گاردی نداشت. همان سکویی که دانلود را
 * رد کرده بود، ویرایش را هم رد کرد؛ خطا از دست‌کد بالا رفت، `bot.catch` فقط
 * لاگش کرد، و پیامِ وضعیت تا ابد روی آخرین ویرایشِ موفق ماند.
 *
 * نکتهٔ اصلی این است: مسیرِ خبردادنِ شکست **همیشه** وقتی اجرا می‌شود که سکو
 * ناسالم است. پس دقیقاً همان‌جا نباید به یک تماسِ بی‌گارد تکیه کرد.
 *
 * پس چند بار با فاصلهٔ فزاینده تلاش می‌شود، و اگر ویرایش نگرفت پیامِ **تازه**
 * فرستاده می‌شود — چون شاید مشکل از خودِ آن پیام باشد، نه از سکو. و در نهایت
 * خطا بالا نمی‌رود: خبرندادن بد است، ولی انداختنِ دست‌کد چیزی را بهتر نمی‌کند.
 */
async function tellFailure(
  ctx: Context,
  statusMessageId: number,
  text: string,
  extra: { parse_mode?: "HTML"; reply_markup?: InlineKeyboard } = {},
): Promise<void> {
  const chatId = ctx.chat!.id;
  const gaps = [0, 1_500, 4_000, 8_000];
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i]) await new Promise((r) => setTimeout(r, gaps[i]));
    try {
      // تلاش آخر پیامِ تازه است نه ویرایش: اگر خودِ پیامِ وضعیت مشکل داشته
      // باشد، هرچقدر هم ویرایش را تکرار کنیم همان جواب را می‌گیریم.
      await callWithDeadline(15_000, "سکو به پیام شکست جواب نداد.", async (signal) => {
        if (i < gaps.length - 1) {
          await ctx.api.editMessageText(chatId, statusMessageId, text, extra, signal);
        } else {
          await ctx.api.sendMessage(chatId, text, extra, signal);
        }
      });
      return;
    } catch (e) {
      logger.warn({ err: String(e), attempt: i + 1 }, "failure notice not delivered");
    }
  }
}

async function downloadMedia(
  ctx: Context,
  o: { sessionId: string; fileId: string; messageId: number; declaredSize: number },
): Promise<{ audioFile: string; route: string } | null> {
  const sizeMb = Math.round((o.declaredSize) / 1024 / 1024);
  const statusMsg = await ctx.reply(
    `⬇️ دارم فایلو می‌گیرم${sizeMb > 20 ? ` (${toFaDigits(sizeMb)} مگ)` : ""}…`,
    { parse_mode: "HTML" },
  );

  let audioFile: string;
  let route: string;
  try {
    // پیشرفت را فقط برای فایل بزرگ نشان بده و با گام درشت — ویرایش پیام
    // در تلگرام محدودیت نرخ دارد و دانلود ۸۰ مگابایتی صدها بار صدا می‌زند.
    let lastShown = 0;
    const req = {
      fileId: o.fileId,
      chatId: ctx.chat!.id,
      messageId: o.messageId,
      declaredSize: o.declaredSize,
      destDir: config.audioDir,
      baseName: o.sessionId,
      onProgress: (done: number, total: number) => {
        if (total < 20 * 1024 * 1024) return;
        const p = Math.floor((done / total) * 10) * 10;
        if (p <= lastShown || p >= 100) return;
        lastShown = p;
        void ctx.api
          .editMessageText(ctx.chat!.id, statusMsg.message_id, `⬇️ دارم فایلو می‌گیرم… ${toFaDigits(p)}٪`)
          .catch(() => {});
      },
    };

    /**
     * تلاش دوباره اینجاست، نه روی دوشِ کاربر.
     *
     * پیام قبلی می‌گفت «یه بار دیگه بفرست» — و کاربر شش بار فرستاد، چون از
     * او خواسته بودیم. فایل که همان‌جاست و `file_id` معتبر است؛ اگر شکست
     * گذرا باشد (شبکه، ۵xx) خودمان باید دوباره بزنیم.
     *
     * **بودجه زمانی است نه شماری — و این درسِ یک شکستِ واقعی است.**
     *
     * اندازه‌گیری روی بله نشان داد سرورِ فایل حدود یک‌سومِ مواقع اصلاً جواب
     * نمی‌دهد، و این شکست **مستقل** است نه پایدار: در همان دوازده آزمون، هر
     * شکست با تلاش بعدی جبران شد. پس تلاشِ بیشتر بهتر از تسلیمِ زودهنگام
     * است — تا اینجا درست بود.
     *
     * ولی نسخهٔ قبلی فقط تعداد را می‌شمرد (شش تلاش) و بدترین حالتش را ۵۳
     * ثانیه حساب می‌کرد، چون فرض کرده بود هر شکست حدود هشت ثانیه — یعنی
     * مهلتِ سرآیند — طول می‌کشد. آن فرض فقط برای یک حالت درست است.
     *
     * حالتِ دوم پنجم سپتامبر ۲۰۲۶ اتفاق افتاد: **خودِ API بله پایین بود**، نه
     * فقط سرورِ فایل. آن‌وقت `getFile` در هشتاد میلی‌ثانیه رد می‌دهد نه در
     * هشت ثانیه؛ شش تلاش در **۴٫۴ ثانیه** سوخت و ربات تسلیم شد، در حالی که
     * سکو هنوز دقایقی پایین بود. یعنی دقیقاً وقتی شکست ارزان است، بودجهٔ
     * شمارشی زودتر از همیشه تمام می‌شود.
     *
     * پس معیار زمانِ سپری‌شده است: تا یک دقیقه تلاش کن، هر چند تلاش که در آن
     * جا شود. سقفِ شمارش فقط بندِ ایمنی است تا اگر شکست در یک میلی‌ثانیه
     * برگردد سرور را چکش نکنیم.
     *
     * تأخیر هم به همین دلیل نمایی شد ولی با سقف: وقتی شکست فوری است، تنها
     * چیزی که فاصله می‌سازد همین تأخیر است. سقفِ چهارثانیه‌ای طوری چیده شده
     * که حالتِ اول دست‌نخورده بماند — آنجا هر تلاش خودش هشت ثانیه طول می‌کشد
     * و باز هم شش تلاش در بودجه جا می‌شود، همان عددی که اندازه‌گیری اولیه به
     * آن رسیده بود.
     *
     * `FileTooLargeError` استثناست: تکرارش قطعاً به همان نتیجه می‌رسد، پس
     * بلافاصله بالا می‌رود.
     */
    const TRY_BUDGET_MS = 60_000;
    const MAX_TRIES = 16;
    const startedTrying = Date.now();
    let gap = 800;
    let lastErr: unknown;
    let dl: Awaited<ReturnType<typeof downloadTelegramFile>> | null = null;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      try {
        dl = await downloadTelegramFile(ctx.api, req);
        if (attempt > 1) logger.info({ attempt }, "download succeeded after retry");
        break;
      } catch (e) {
        if (e instanceof FileTooLargeError) throw e;
        lastErr = e;
        logger.warn({ err: String(e), attempt }, "download attempt failed");
        if (attempt === MAX_TRIES || Date.now() - startedTrying + gap >= TRY_BUDGET_MS) break;
        lastShown = 0;
        /**
         * پیام باید **تکان بخورد**.
         *
         * سرور بله یک‌سوم مواقع جواب نمی‌دهد و تلاش دوباره می‌تواند تا حدود
         * یک دقیقه طول بکشد. پیامِ ساکنِ «دارم فایلو می‌گیرم…» در آن مدت
         * دقیقاً همان چیزی است که کاربر «گیر کرده» می‌خواندش و فایل را دوباره
         * می‌فرستد — که کار را بدتر می‌کند.
         *
         * شمارهٔ کل دیگر گفته نمی‌شود چون دیگر عددِ ثابتی نیست؛ «از ۶» وقتی
         * بودجه زمانی است یعنی وعده‌ای که ممکن است دروغ دربیاید.
         */
        void ctx.api
          .editMessageText(
            ctx.chat!.id,
            statusMsg.message_id,
            `⬇️ سرور ${platformOf(ctx) === "bale" ? "بله" : "تلگرام"} جواب نداد، ` +
              `دارم دوباره تلاش می‌کنم… (تلاش ${toFaDigits(attempt + 1)})`,
          )
          .catch(() => {});
        await new Promise((r) => setTimeout(r, gap));
        gap = Math.min(gap * 2, 4_000);
      }
    }
    if (!dl) throw lastErr;
    audioFile = dl.filePath;
    route = dl.route;
  } catch (e) {
    if (e instanceof FileTooLargeError) {
      /**
       * پیام باید کاری بگوید که **خودِ کاربر** بتواند انجام دهد — و راهی که
       * واقعاً جواب می‌دهد.
       *
       * متن قبلی «ویس بفرست» را پیشنهاد می‌داد، که روی بله بی‌ربط است: سقف
       * بله (۵۰ مگابایت) برای ویس و فایل یکی است. مینی‌اپ تا ۵۰۰ مگابایت
       * می‌گیرد چون مستقیم روی سرور خودمان می‌نشیند و اصلاً از Bot API
       * رد نمی‌شود — پس تنها راهِ درست برای فایل بزرگ همان است.
       */
      const limitMb = Math.floor(e.limitBytes / 1024 / 1024);
      const gotMb = Math.round(e.sizeBytes / 1024 / 1024);
      /**
       * دکمه **ضمیمه** می‌شود، نه فقط نامش در متن.
       *
       * پیش از این متن می‌گفت «از دکمهٔ آپلود فایل استفاده کن» ولی دکمه‌ای
       * همان‌جا نبود؛ کاربر باید برمی‌گشت به منو و پیدایش می‌کرد — یعنی
       * همان‌جایی که آدم‌ها رها می‌کنند. اشارهٔ قبلی به «لینک ضبط آنلاین» هم
       * برداشته شد: مسیر لینک فقط فایلِ مستقیم می‌گیرد و صفحهٔ ضبط جلسه رد
       * می‌شود، پس آن پیشنهاد کاربر را به بن‌بست دوم می‌فرستاد.
       */
      const kb = new InlineKeyboard();
      if (config.PUBLIC_URL.startsWith("https://")) {
        kb.webApp(BTN.app, `${config.PUBLIC_URL.replace(/\/+$/, "")}/app`);
      }
      await tellFailure(
        ctx,
        statusMsg.message_id,
        `❌ این فایل ${toFaDigits(gotMb)} مگه و ${platformOf(ctx) === "bale" ? "بله" : "تلگرام"} ` +
          `بیشتر از ${toFaDigits(limitMb)} مگ رو به ربات نمی‌ده.\n\n` +
          `<b>از دکمهٔ پایین بفرستش</b> — اونجا تا ۵۰۰ مگ می‌گیرم.`,
        { parse_mode: "HTML", ...(kb.inline_keyboard.length ? { reply_markup: kb } : {}) },
      );
      return null;
    }
    logger.error({ err: String(e), platform: platformOf(ctx) }, "download failed");
    const kb = new InlineKeyboard();
    if (config.PUBLIC_URL.startsWith("https://")) {
      kb.webApp(BTN.app, `${config.PUBLIC_URL.replace(/\/+$/, "")}/app`);
    }
    await tellFailure(
      ctx,
      statusMsg.message_id,
      `❌ چند بار تلاش کردم ولی سرور ${platformOf(ctx) === "bale" ? "بله" : "تلگرام"} فایلو نداد.\n\n` +
        `<b>مشکل از سمت منه نه تو.</b> از دکمهٔ پایین امتحان کن — مسیرش جداست.`,
      { parse_mode: "HTML", ...(kb.inline_keyboard.length ? { reply_markup: kb } : {}) },
    );
    return null;
  }

  await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
  return { audioFile, route };
}


/**
 * سقفِ جلسه‌های تصمیم‌نگرفته — تا کسی نتواند ربات را با فایل پر کند.
 *
 * ## چه چیزی را می‌بندد و چه چیزی را نه
 *
 * حالا که قیمت **پیش از دانلود** اعلام می‌شود، فرستادنِ فایل و انصراف دیگر
 * هیچ باری روی سرور نمی‌گذارد: هیچ بایتی دانلود نمی‌شود. آنچه می‌ماند
 * ارزان‌تر ولی صفر نیست — هر بار یک سطر پایگاه‌داده و دو سه تماس با Bot API.
 *
 * و یک حالت گران‌تر هم هست: کاربری که تأیید می‌کند، فایل دانلود می‌شود، و
 * `probe` نشان می‌دهد مدت واقعی خیلی بیشتر از اعلامِ فرستنده است و اعتبارش
 * نمی‌رسد. آن فایل روی دیسک می‌ماند. با سقف، چنین کسی بعد از چند بار
 * می‌بندد و باید تکلیفِ قبلی‌ها را روشن کند.
 *
 * سقف عمداً پایین نیست: دانشجویی که سه کلاسِ یک روز را پشت سر هم می‌فرستد
 * کارِ عادی می‌کند و نباید ببندد.
 */
const MAX_PENDING_SESSIONS = 5;

async function tooManyPending(ctx: Context, userId: number): Promise<boolean> {
  const pending = pendingSessions(userId);
  if (pending.length < MAX_PENDING_SESSIONS) return false;

  await reply(
    ctx,
    `<b>${toFaDigits(pending.length)} فایل داری که هنوز تصمیمی براشون نگرفتی.</b>\n\n` +
      `اول اونا رو شروع کن یا بی‌خیالشون شو، بعد فایل تازه بفرست.`,
    {
      reply_markup: new InlineKeyboard()
        .text("✅ شروعِ آخرین فایل", `go:${pending[0]!.id}`)
        .row()
        .text(`📚 ${BTN.history}`, "hpage:0"),
    },
  );
  return true;
}

/** درسی که خودمان حدس می‌زنیم — بدون پرسیدن از کاربر. */
function autoCourseId(userId: number): number | null {
  const courses = listCourses(userId);
  if (courses.length === 1) return courses[0]!.id;
  const recent = listSessions(userId, 20).find((s) => s.course_id !== null)?.course_id ?? null;
  return recent && courses.some((c) => c.id === recent) ? recent : null;
}

/**
 * جلسه را **پیش از دانلود** نگه دار و قیمتش را بگو.
 *
 * سکو مدت را در خودِ پیام گفته، پس برای قیمت‌دادن به فایل نیازی نیست. آنچه
 * ذخیره می‌شود شناسهٔ فایل است نه خودش؛ دانلود تازه وقتی انجام می‌شود که
 * کاربر «شروع کن» را بزند. یعنی فایلِ کسی که منصرف شد یا اعتبارش کم بود
 * اصلاً روی سرور نمی‌آید.
 *
 * ⚠️ مدتِ اینجا **تخمینِ سکو**ست. مبنای کسرِ نهایی نیست: خط لوله فایل را
 * خودش `probe` می‌کند و تسویه با مدت واقعی انجام می‌شود. این عدد فقط برای
 * قیمتِ نشان‌داده‌شده و رزروِ اولیه است.
 */
async function holdBeforeDownload(
  ctx: Context,
  spec: { sessionId: string; sec: number; fileId: string; messageId: number },
): Promise<void> {
  const u = touchUser(ctx);
  if (!u) return;
  const { sessionId, sec } = spec;

  createSession(sessionId, u.tg_id, autoCourseId(u.tg_id));
  updateSession(sessionId, {
    status: u.credit_sec < sec ? "awaiting_credit" : "awaiting_confirm",
    original_ms: sec * 1000,
    audio_file_id: spec.fileId,
    audio_chat_id: ctx.chat!.id,
    audio_message_id: spec.messageId,
    mode: "full",
  });

  if (u.credit_sec < sec) {
    await reply(
      ctx,
      S.lowBalanceMessage(sec, u.credit_sec) +
        "\n\n<i>فایلت همون‌جا تو چت هست — بعد از شارژ همین دکمه رو بزن، لازم نیست دوباره بفرستی.</i>",
      {
        reply_markup: new InlineKeyboard()
          .text("🪙 شارژ حساب", "topup")
          .row()
          .text("▶️ ادامه بده", `go:${sessionId}`),
      },
    );
    return;
  }

  await reply(ctx, S.confirmCostMessage(sec, u.credit_sec), {
    reply_markup: new InlineKeyboard()
      .text("✅ شروع کن", `go:${sessionId}`)
      .text("✖️ بی‌خیال", `nogo:${sessionId}`),
  });
}

interface IntakeSpec {
  sessionId: string;
  audioFile: string;
  downloadRoute: string;
  /** پیام صوتی کاربر، اگر فایل فرستاده باشد. برای لینک وجود ندارد. */
  messageId?: number;
  /** `file_id` سکو، اگر از خودِ سکو آمده باشد. لینک ندارد. */
  fileId?: string;
  /** مدتی که سکو اعلام کرده؛ صفر یعنی خودمان باید probe کنیم. */
  declaredDurationSec: number;
  /** آدرس منبع، فقط وقتی از لینک آمده — برای بایگانی و اشکال‌زدایی. */
  sourceUrl?: string;
}

async function intakeAudio(ctx: Context, spec: IntakeSpec): Promise<void> {
  const u = touchUser(ctx);
  if (!u) return;
  const id = u.tg_id;
  const { sessionId, audioFile } = spec;

  createSession(sessionId, id, null);
  /**
   * شناسهٔ پیام صوتی نگه داشته می‌شود تا نتایج «ریپلای» همان پیام شوند —
   * شرط لازم برای اینکه تلگرام زمان‌های داخل متن را لینک پخش کند.
   *
   * برای لینک چنین پیامی وجود ندارد: کاربر یک آدرس فرستاده نه صوت. آن‌جا
   * این فیلدها خالی می‌مانند و بقیهٔ کد همین حالا هم با `audio_message_id`
   * تهی کنار می‌آید (`linkable` در کارت جلسه).
   */
  updateSession(sessionId, {
    audio_chat_id: ctx.chat!.id,
    ...(spec.messageId !== undefined ? { audio_message_id: spec.messageId } : {}),
    ...(spec.fileId !== undefined ? { audio_file_id: spec.fileId } : {}),
    download_route: spec.downloadRoute,
  });

  /**
   * انتخاب درس بدون پرسیدن.
   *
   * قبلاً دو سؤال بین «فایل را فرستادم» و «کار شروع شد» بود: کدام درس، و
   * جزوه می‌خواهی یا نه. هر دو حذف شدند. کاربر تازه‌وارد جواب هیچ‌کدام را
   * نمی‌داند — هنوز ندیده جزوه چه شکلی است — و هر سؤال یک جای رهاکردن است.
   *
   * پس: درسی نداری، بدون درس جلو می‌رویم. یک درس داری، همان. چند تا داری،
   * آخرین درسی که استفاده کردی. تصحیحش بعد از دیدن نتیجه یک کلیک است.
   */
  const courseId = autoCourseId(id);
  if (courseId) updateSession(sessionId, { course_id: courseId });

  updateSession(sessionId, { mode: "full" });

  /**
   * یک نسخه به کانال بایگانی — که همیشه در تلگرام است، حتی برای کاربر بله.
   *
   * همین‌جا و نه بعد از پردازش: اگر خط لوله شکست بخورد هم ادمین باید صوت را
   * داشته باشد تا بفهمد چه چیزی شکست. گزارش بعداً ریپلایِ همین پیام می‌شود.
   *
   * منبع بر اساس سکو فرق می‌کند: `file_id` تلگرام را خودِ تلگرام می‌شناسد و
   * آپلود دوباره لازم ندارد، ولی `file_id` بله برای تلگرام یک رشتهٔ بی‌معنی
   * است — پس همان فایلی که تازه دانلود شد آپلود می‌شود.
   *
   * و دقیقاً به همین دلیل مسیر بله `await` نمی‌شود: فرستادن `file_id` یک
   * تماس کوتاه است، ولی آپلودِ ده‌ها مگابایت می‌تواند دقیقه‌ها طول بکشد و
   * کاربر بله را پشت یک قابلیتِ ادمین منتظر نگه دارد.
   *
   * صوتی که از لینک آمده `file_id` ندارد — هیچ سکویی آن را نمی‌شناسد — پس
   * مثل بله از روی فایل آپلود می‌شود و به همان دلیل `await` نمی‌شود.
   */
  const platform = platformOf(ctx);

  /**
   * اینجا سکو مدتی نگفته بود، پس فایل را خودمان می‌پرسیم.
   *
   * وقتی سکو عددی بدهد، کار پیش از دانلود تمام شده و اصلاً به اینجا
   * نمی‌رسیم — `declaredDurationSec` واحدش را از حجم تشخیص می‌دهد و
   * `holdBeforeDownload` همان‌جا قیمت می‌دهد. این مسیر برای فایلی است که
   * به‌صورت **سند** آمده یا از لینک گرفته شده و هیچ مدتی همراهش نیست.
   *
   * probe **پیش از** بایگانی صدا زده می‌شود تا عنوانِ نسخهٔ ادمین هم مدت
   * درست را داشته باشد، نه صفرِ اعلام‌نشده.
   */
  let effectiveSec = spec.declaredDurationSec;
  if (effectiveSec === 0) {
    try {
      effectiveSec = Math.round((await probe(audioFile)).durationMs / 1000);
    } catch (e) {
      logger.warn({ sessionId, err: String(e) }, "probe for duration failed");
    }
  }

  const caption = audioCaption({
    sender: { tgId: id, name: u.name, username: u.username },
    mode: "full",
    durationMs: effectiveSec * 1000,
    sessionId,
    courseName: courseId ? (getCourse(courseId)?.name ?? null) : null,
    origin: platform,
    ...(spec.sourceUrl ? { sourceUrl: spec.sourceUrl } : {}),
  });
  if (platform === "bale" || !spec.fileId) {
    void archiveAudio(sessionId, { path: audioFile }, caption, effectiveSec);
  } else {
    await archiveAudio(sessionId, { fileId: spec.fileId }, caption, effectiveSec);
  }

  /**
   * اعتبار کم؟ **پیش از** پردازش بگو، نه بعدش.
   *
   * رزرو در `startJob` هم این را می‌گیرد، ولی آنجا کاربر فایلش را فرستاده و
   * منتظر مانده است. اینجا هنوز چیزی شروع نشده و پیام «شارژ کن» با دکمه‌اش
   * بی‌اصطکاک‌ترین جایی است که می‌شود گفت.
   */
  if (effectiveSec > 0 && u.credit_sec < effectiveSec) {
    /**
     * **فایل دانلود شده و سرجایش است — پس این نباید بن‌بست باشد.**
     *
     * پیش از این فقط `return` بود: کاربر فایل ۱۳۰ دقیقه‌ای‌اش را فرستاده
     * بود، ما کامل گرفته بودیمش، و بعد می‌گفتیم «سکه‌ات کمه». او شارژ
     * می‌کرد و **هیچ راهی برای ادامه نبود** — نه دکمه‌ای، نه پیامی. مجبور
     * می‌شد همان فایل را دوباره بفرستد، که روی اینترنت موبایل یعنی دوباره
     * چند ده مگابایت و چند دقیقه.
     *
     * حالا جلسه با وضعیت `awaiting_credit` نگه داشته می‌شود و پس از شارژ
     * خودش ادامه می‌دهد؛ دکمهٔ ادامه هم همین‌جا هست.
     */
    // مدت هم ذخیره می‌شود، وگرنه «ادامه بده» با صفر شروع می‌کند و بررسیِ اعتبار
    // بی‌اثر می‌شود — `resumeSession` مدت را از همین ستون می‌خواند.
    updateSession(sessionId, {
      status: "awaiting_credit",
      original_file: audioFile,
      original_ms: effectiveSec * 1000,
    });
    await reply(
      ctx,
      S.lowBalanceMessage(effectiveSec, u.credit_sec) +
        "\n\n<i>فایلت نگه داشته شد — بعد از شارژ لازم نیست دوباره بفرستی.</i>",
      {
        reply_markup: new InlineKeyboard()
          .text("🪙 شارژ حساب", "topup")
          .row()
          .text("▶️ ادامه بده", `resume:${sessionId}`),
      },
    );
    return;
  }

  /**
   * تأیید پیش از خرج‌کردن سکه.
   *
   * تا پیش از این، فرستادنِ فایل یعنی شروعِ فوریِ کار و کسرِ سکه — کاربر عدد
   * را اولین بار *بعد* از خرج‌شدن می‌دید. برای یک کلاس ۹۰ دقیقه‌ای یعنی ۹۰
   * سکه بی‌آنکه کسی پرسیده باشد.
   *
   * این با آن دو سؤالی که عمداً حذف شدند فرق دارد: آنها («کدام درس»، «جزوه
   * می‌خواهی؟») چیزهایی بودند که کاربر تازه جوابشان را نمی‌داند. این یکی
   * دربارهٔ پولِ خودش است و جوابش را می‌داند.
   *
   * فایل روی دیسک نگه داشته می‌شود و هیچ سکه‌ای رزرو نمی‌شود تا وقتی «شروع
   * کن» را بزند. مینی‌اپ همین کار را از قبل می‌کرد — آنجا حتی پیش از آپلود،
   * چون مرورگر مدت را از خودِ فایل می‌خواند.
   *
   * مدت صفر یعنی نه سکو گفته و نه `probe` توانست بخواند. آن‌وقت عددی برای
   * نشان‌دادن نداریم و پرسیدن بی‌معنی است، پس مثل قبل جلو می‌رویم؛ تسویه
   * به‌هرحال با مدت واقعی انجام می‌شود.
   */
  if (effectiveSec > 0) {
    // مدت هم ذخیره می‌شود — `resumeSession` که پشتِ دکمهٔ «شروع کن» است
    // مبنای رزروش را از همین ستون می‌خواند، نه از حافظه.
    updateSession(sessionId, {
      status: "awaiting_confirm",
      original_file: audioFile,
      original_ms: effectiveSec * 1000,
    });
    await reply(ctx, S.confirmCostMessage(effectiveSec, u.credit_sec), {
      reply_markup: new InlineKeyboard()
        .text("✅ شروع کن", `go:${sessionId}`)
        .text("✖️ بی‌خیال", `nogo:${sessionId}`),
    });
    return;
  }

  await startJob(ctx, {
    sessionId,
    audioFile,
    courseId,
    // مدت واقعی، نه فقط آنچه سکو گفته — مبنای رزرو اعتبار همین است
    declaredDurationSec: effectiveSec,
    mode: "full",
  });
}

// ─── کلیک‌ها ────────────────────────────────────────────────────────────────

/** رفتن بین صفحه‌های فهرست جلسه‌ها — همان پیام ویرایش می‌شود. */
handlers.callbackQuery(/^hpage:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await historyScreen(ctx, Number(ctx.match![1]), true);
});

/** بازکردن یک جلسه از فهرست. */
handlers.callbackQuery(/^sess:([a-f0-9]+)$/, (ctx) => sessionCard(ctx, ctx.match![1]!));

/** شمارندهٔ وسط نوار صفحه‌بندی؛ فقط برچسب است. */
handlers.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

handlers.callbackQuery("topup", async (ctx) => {
  await ctx.answerCallbackQuery();
  await topupScreen(ctx);
});

handlers.callbackQuery("newcourse", async (ctx) => {
  await ctx.answerCallbackQuery();
  convo.set(uid(ctx), { kind: "await_course_name" });
  await reply(ctx, "اسم درس چیه؟\n\n<i>مثلاً: ریاضی مهندسی</i>");
});

/**
 * ⚠️ `uid(ctx)` و نه `ctx.from.id` — و این در کل این فایل قاعده است.
 *
 * سفارش شارژ با شناسه‌ای ساخته می‌شد که از `ctx.from.id` می‌آمد، ولی
 * `receiveReceipt` با `uid(ctx)` دنبالش می‌گشت. روی تلگرام این دو **برابرند**
 * پس هیچ‌وقت دیده نشد؛ روی بله شناسهٔ داخلی از فضای دیگری می‌آید و سفارش
 * عملاً گم می‌شد: کاربر پکیج را انتخاب می‌کرد، رسید می‌فرستاد، و جواب
 * می‌گرفت «این عکسه 🤔 من فایل صوتی می‌خوام» — یعنی پول داده بود و ربات
 * وانمود می‌کرد سفارشی در کار نیست.
 *
 * همین اشتباه در مقایسهٔ مالکیت جلسه هم بود (`s.tg_id !== ctx.from.id`) و
 * به کاربر بله می‌گفت جلسهٔ خودش مال او نیست.
 */
handlers.callbackQuery(/^buy:(\w+)$/, async (ctx) => {
  touchUser(ctx);
  const out = beginTopup(uid(ctx), ctx.match![1]!);
  if (!out) {
    await ctx.answerCallbackQuery({ text: "این پکیج دیگر موجود نیست." });
    return;
  }
  await ctx.answerCallbackQuery();
  await reply(ctx, out.text, { reply_markup: out.keyboard });
});

handlers.callbackQuery(/^bcancel:([a-f0-9]+)$/, async (ctx) => {
  const ok = cancelTopup(ctx.match![1]!, uid(ctx));
  await ctx.answerCallbackQuery({ text: ok ? "سفارش لغو شد." : "این سفارش دیگر باز نیست." });
  if (ok) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
});

/**
 * تصمیم ادمین دربارهٔ یک رسید.
 *
 * دکمه‌ها پس از تصمیم برداشته می‌شوند، چون همان پیام برای *همهٔ* ادمین‌ها
 * فرستاده شده و بدون این کار دومی روی سفارشِ بسته کلیک می‌کند.
 */
handlers.callbackQuery(/^(tok|trej):([a-f0-9]+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "این دکمه مال تو نیست." });
    return;
  }
  const out = await decide(ctx.api, ctx.match![2]!, uid(ctx), ctx.match![1] === "tok");
  await ctx.answerCallbackQuery({ text: out.toast });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  if (out.adminNote) await ctx.reply(out.adminNote);
});

/**
 * ارتقای یک جلسهٔ رایگان به تحلیل کامل.
 *
 * روی *همان* سطر جلسه اجرا می‌شود، نه یک جلسهٔ تازه: پیام صوتی اصلی همان‌جا
 * ثبت است و بدون آن، زمان‌های نتیجهٔ جدید دیگر لینک پخش نمی‌شوند. صوت هم
 * همان فایل کامل است — نه نسخهٔ بریدهٔ ۳۰ دقیقه‌ای — پس هزینه‌اش هم بر پایهٔ
 * کل جلسه حساب می‌شود.
 */
handlers.callbackQuery(/^full:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  const s = getSession(sessionId);
  const u = touchUser(ctx);
  if (!s || !u || s.tg_id !== u.tg_id) {
    await ctx.answerCallbackQuery({ text: "این جلسه مال تو نیست." });
    return;
  }
  if (!s.original_file) {
    await ctx.answerCallbackQuery();
    await reply(ctx, "فایل صوتی این جلسه دیگر روی سرور نیست 😔 دوباره بفرستش تا کامل تحلیلش کنم.");
    return;
  }
  if (isBusy(String(uid(ctx)))) {
    await ctx.answerCallbackQuery({ text: "یه کار در جریانه، صبر کن تموم شه." });
    return;
  }

  const durationSec = Math.round(s.original_ms / 1000);
  if (u.credit_sec < durationSec) {
    await ctx.answerCallbackQuery();
    await reply(ctx, S.lowBalanceMessage(durationSec, u.credit_sec), {
      reply_markup: new InlineKeyboard().text("🪙 شارژ حساب", "topup"),
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "شروع کردم…" });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  updateSession(sessionId, { mode: "full" });
  // صوتش قبلاً در کانال هست؛ فقط خبر ارتقا ریپلای می‌شود تا کپشن «رایگان»
  // آخرین حرف نباشد.
  await archiveUpgrade(s);
  await startJob(ctx, {
    sessionId,
    audioFile: s.original_file,
    courseId: s.course_id,
    declaredDurationSec: durationSec,
    mode: "full",
  });
});

/**
 * تلاش دوباره روی جلسه‌ای که پردازشش شکست خورده.
 *
 * **بدون این، پیام شکست بن‌بست بود:** کاربر باید همان فایل ۵۰ مگابایتی را
 * دوباره آپلود می‌کرد، در حالی که فایل تا `KEEP_AUDIO_DAYS` روی سرور هست.
 * روی اینترنت موبایل ایران، «دوباره بفرست» یعنی «بی‌خیال شو».
 *
 * سکه‌ها موقع شکست کامل برگشته‌اند، پس این یک اجرای تازه است و مثل هر اجرای
 * دیگری دوباره رزرو می‌کند — نه رایگان است نه دوبار حساب می‌شود.
 */
/**
 * جلسهٔ متوقف‌مانده را از همان فایلِ روی دیسک ادامه بده.
 *
 * هم دکمهٔ «ادامه بده» صدایش می‌زند و هم مسیر تأیید شارژ — تا کاربری که
 * شارژ کرد اصلاً لازم نباشد دکمه‌ای بزند.
 */
async function resumeSession(ctx: Context, sessionId: string): Promise<void> {
  const s = getSession(sessionId);
  const u = touchUser(ctx);
  if (!s || !u || s.tg_id !== u.tg_id) return;

  if (isBusy(String(uid(ctx)))) {
    await reply(ctx, "یه کار در جریانه، صبر کن تموم شه 🙏");
    return;
  }

  let durationSec = Math.max(0, Math.round(s.original_ms / 1000));
  if (durationSec > 0 && u.credit_sec < durationSec) {
    await reply(ctx, S.lowBalanceMessage(durationSec, u.credit_sec), {
      reply_markup: new InlineKeyboard()
        .text("🪙 شارژ حساب", "topup")
        .row()
        .text("▶️ ادامه بده", `go:${sessionId}`),
    });
    return;
  }

  /**
   * **حالا تازه دانلود می‌کنیم.**
   *
   * جلسه‌ای که قیمتش پیش از دانلود اعلام شده هنوز فایلی روی دیسک ندارد؛ فقط
   * شناسهٔ فایل را نگه داشته‌ایم. کاربری که تأیید نکرد یا اعتبارش نرسید،
   * هیچ‌وقت به اینجا نمی‌رسد و هیچ بایتی هم روی سرور نمی‌آید.
   *
   * بایگانی هم همین‌جاست و نه زودتر، چون تا این لحظه چیزی برای بایگانی‌کردن
   * وجود نداشت.
   */
  let audioFile = s.original_file;
  const onDisk =
    audioFile !== null && (await fs.access(audioFile).then(() => true).catch(() => false));

  if (!onDisk) {
    if (!s.audio_file_id) {
      await reply(ctx, "فایل صوتی این جلسه دیگر روی سرور نیست 😔 دوباره بفرستش.");
      return;
    }
    const dl = await downloadMedia(ctx, {
      sessionId,
      fileId: s.audio_file_id,
      messageId: s.audio_message_id ?? 0,
      declaredSize: 0,
    });
    if (!dl) return;
    audioFile = dl.audioFile;
    updateSession(sessionId, { original_file: audioFile, download_route: dl.route });

    /**
     * **مدتِ اعلام‌شده حرفِ فرستنده است، نه واقعیت.**
     *
     * سکو آن عدد را از کلاینت می‌گیرد؛ یک کلاینتِ دست‌کاری‌شده می‌تواند برای
     * یک فایل چهارساعته بنویسد «یک ثانیه». تا امروز این یعنی پردازشِ مجانی:
     * رزرو روی همان عدد انجام می‌شد، خط لوله کامل اجرا می‌شد (و رونویسیِ
     * چهار ساعت پولِ واقعی است)، و `commit` هم چون `strict: false` است
     * مابه‌التفاوت را **تا صفر می‌بُرد** به‌جای اینکه شکست بخورد.
     *
     * پس از این لحظه فایل روی دیسکِ ماست و `ffprobe` ارزان است. مبنای رزرو
     * و کسر، همین عددِ خودمان است — عددِ سکو فقط برای *نمایشِ* قیمت بود.
     */
    try {
      const realSec = Math.round((await probe(audioFile)).durationMs / 1000);
      if (realSec > 0 && realSec !== durationSec) {
        logger.info({ sessionId, quoted: durationSec, real: realSec }, "مدت واقعی با تخمین فرق داشت");
        updateSession(sessionId, { original_ms: realSec * 1000 });

        // گران‌تر از آنچه قول داده بودیم؟ دوباره بپرس، نه اینکه بی‌خبر بگیری.
        if (costCoins(realSec) > costCoins(durationSec) + 1) {
          if (u.credit_sec < realSec) {
            updateSession(sessionId, { status: "awaiting_credit" });
            await reply(
              ctx,
              `مدت واقعی این فایل <b>${toFaDigits(fmtDuration(realSec * 1000))}</b> بود، نه چیزی که فرستنده اعلام کرده بود.\n\n` +
                S.lowBalanceMessage(realSec, u.credit_sec),
              {
                reply_markup: new InlineKeyboard()
                  .text("🪙 شارژ حساب", "topup")
                  .row()
                  .text("▶️ ادامه بده", `go:${sessionId}`),
              },
            );
            return;
          }
          updateSession(sessionId, { status: "awaiting_confirm" });
          await reply(
            ctx,
            `مدت واقعی بیشتر از چیزی بود که سکو اعلام کرده بود.\n\n` +
              S.confirmCostMessage(realSec, u.credit_sec),
            {
              reply_markup: new InlineKeyboard()
                .text("✅ شروع کن", `go:${sessionId}`)
                .text("✖️ بی‌خیال", `nogo:${sessionId}`),
            },
          );
          return;
        }
        // از این‌جا به بعد عددِ خودمان ملاک است، نه تخمینِ سکو.
        durationSec = realSec;
      }
    } catch (e) {
      logger.warn({ sessionId, err: String(e) }, "probe after download failed");
    }

    const platform = platformOf(ctx);
    const caption = audioCaption({
      sender: { tgId: u.tg_id, name: u.name, username: u.username },
      mode: "full",
      durationMs: durationSec * 1000,
      sessionId,
      courseName: s.course_id ? (getCourse(s.course_id)?.name ?? null) : null,
      origin: platform,
    });
    if (platform === "bale" || !s.audio_file_id) {
      void archiveAudio(sessionId, { path: audioFile }, caption, durationSec);
    } else {
      await archiveAudio(sessionId, { fileId: s.audio_file_id }, caption, durationSec);
    }
  }

  updateSession(sessionId, { status: "queued", error: null });
  await startJob(ctx, {
    sessionId,
    audioFile: audioFile!,
    courseId: s.course_id,
    declaredDurationSec: durationSec,
    mode: (s.mode as SessionMode) ?? "full",
  });
}

handlers.callbackQuery(/^resume:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await resumeSession(ctx, sessionId);
});

/**
 * «شروع کن» روی تأییدِ هزینه — همان مسیر `resume` است.
 *
 * جلسه از قبل ساخته شده، فایلش روی دیسک است و مالکیتش سنجیده می‌شود؛ تنها
 * چیزی که نبود، «بله»ی کاربر بود.
 */
handlers.callbackQuery(/^go:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  await ctx.answerCallbackQuery({ text: "شروع کردم…" });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await resumeSession(ctx, sessionId);
});

/**
 * «بی‌خیال» — ولی **بن‌بست نه**.
 *
 * فایل همان‌جا می‌ماند و دکمهٔ شروع سرِ جایش. کاربری که منصرف شده اغلب
 * پشیمان می‌شود یا اول می‌رود شارژ می‌کند؛ اگر اینجا راه بسته باشد باید
 * همان چند ده مگابایت را دوباره بفرستد.
 */
handlers.callbackQuery(/^nogo:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  const s = getSession(sessionId);
  await ctx.answerCallbackQuery();
  if (!s || s.tg_id !== uid(ctx)) return;
  await ctx.editMessageText(
    `باشه، شروع نکردم و سکه‌ای کم نشد.\n\n` +
      `<i>فایلت تا ${toFaDigits(config.KEEP_AUDIO_DAYS)} روز نگه داشته می‌شه — هر وقت خواستی بزن.</i>`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("✅ شروع کن", `go:${sessionId}`),
    },
  ).catch(() => {});
});

handlers.callbackQuery(/^retry:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  const s = getSession(sessionId);
  const u = touchUser(ctx);
  if (!s || !u || s.tg_id !== u.tg_id) {
    await ctx.answerCallbackQuery({ text: "این جلسه مال تو نیست." });
    return;
  }
  if (!s.original_file || !(await fs.access(s.original_file).then(() => true).catch(() => false))) {
    await ctx.answerCallbackQuery();
    await reply(ctx, "فایل صوتی این جلسه دیگر روی سرور نیست 😔 دوباره بفرستش.");
    return;
  }
  if (isBusy(String(uid(ctx)))) {
    await ctx.answerCallbackQuery({ text: "یه کار در جریانه، صبر کن تموم شه." });
    return;
  }

  await ctx.answerCallbackQuery({ text: "دوباره شروع کردم…" });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  // خطای قبلی پاک می‌شود تا اگر باز شکست خورد، پیامِ تازه گیج‌کننده نباشد.
  updateSession(sessionId, { status: "queued", error: null });
  await startJob(ctx, {
    sessionId,
    audioFile: s.original_file,
    courseId: s.course_id,
    declaredDurationSec: Math.max(0, Math.round(s.original_ms / 1000)) || 0,
    mode: (s.mode as SessionMode) ?? "full",
  });
});

handlers.callbackQuery(/^txt:([a-f0-9]+)$/, async (ctx) => {
  const s = readableSession(ctx, ctx.match![1]!);
  await ctx.answerCallbackQuery();
  if (!s?.transcript_txt) {
    await ctx.reply("رونوشت این جلسه موجود نیست.");
    return;
  }
  await sendDoc(ctx, transcriptBytes(s.transcript_txt), "رونوشت کامل.txt", {
    caption: "📄 رونوشت کامل با مهر زمانی",
  });
});

handlers.callbackQuery(/^clip:([a-f0-9]+):(\d+)$/, async (ctx) => {
  const [, sessionId, atMsRaw] = ctx.match!;
  const s = readableSession(ctx, sessionId!);
  if (!s || !s.original_file) {
    await ctx.answerCallbackQuery({ text: "فایل صوتی این جلسه دیگر ذخیره نیست." });
    return;
  }
  await ctx.answerCallbackQuery({ text: "در حال بریدن…" });
  const atMs = Number(atMsRaw);
  const out = path.join(config.workDir, `${sessionId}-${atMs}.ogg`);
  try {
    await fs.mkdir(config.workDir, { recursive: true });
    await extractClip(s.original_file, out, atMs, 35, 5);
    await ctx.replyWithVoice(new InputFile(out), {
      caption: `🎧 ${toFaDigits(fmtClock(atMs, true))} — از فایل اصلی`,
    });
  } catch (e) {
    logger.error({ err: String(e) }, "clip failed");
    await ctx.reply("بریدن این قسمت ممکن نشد.");
  } finally {
    await fs.unlink(out).catch(() => {});
  }
});

handlers.callbackQuery(/^pdf:([a-f0-9]+)$/, async (ctx) => {
  const s = readableSession(ctx, ctx.match![1]!);
  await ctx.answerCallbackQuery();
  if (!s?.pdf_path) {
    await ctx.reply("جزوهٔ این جلسه موجود نیست.");
    return;
  }
  if (!(await sendDoc(ctx, s.pdf_path, "جزوه.pdf", { caption: "📕 جزوهٔ این جلسه" }))) {
    await ctx.reply("فرستادن جزوه ممکن نشد. دوباره امتحان کن یا به پشتیبانی بگو.");
  }
});

handlers.callbackQuery(/^rep:([a-f0-9]+)$/, async (ctx) => {
  const s = readableSession(ctx, ctx.match![1]!);
  await ctx.answerCallbackQuery();
  const r = s ? sessionReport(s) : null;
  if (!s || !r) {
    await ctx.reply("تحلیل این جلسه موجود نیست.");
    return;
  }
  const course = s.course_id ? getCourse(s.course_id) : null;
  const asReply = s.audio_message_id
    ? { reply_parameters: { message_id: s.audio_message_id, allow_sending_without_reply: true } }
    : {};
  await reply(
    ctx,
    S.recapMessage({
      report: r,
      courseName: course?.name ?? null,
      sessionDate: s.session_date,
      durationMs: s.original_ms,
      savedMs: Math.max(0, s.original_ms - s.billed_ms),
      qualityWarnings: [],
    }),
  );
  await reply(ctx, S.extractedMessage(r), asReply);
  // زدنی‌بودن زمان‌ها قابلیتِ **تلگرام** است؛ بله ندارد. بدون این شرط، کاربر
  // بله وعده‌ای می‌خواند که سکویش نمی‌تواند انجام دهد.
  const timeline = S.timelineMessage(r, Boolean(s.audio_message_id) && platformOf(ctx) === "telegram");
  if (timeline) await reply(ctx, timeline, asReply);
});

// ─── اجرای کار ──────────────────────────────────────────────────────────────

interface JobRequest {
  sessionId: string;
  audioFile: string;
  courseId: number | null;
  declaredDurationSec: number;
  mode: SessionMode;
}

async function startJob(ctx: Context, job: JobRequest): Promise<void> {
  const { sessionId, mode } = job;
  const chatId = ctx.chat!.id;
  const userId = uid(ctx);
  const progress = await ctx.api.sendMessage(chatId, S.progressMessage("preprocess"), {
    parse_mode: "HTML",
  });

  let lastText = "";
  const edit = async (text: string, extra: { reply_markup?: InlineKeyboard } = {}) => {
    // با دکمه، متنِ یکسان هم باید دوباره برود: بار اول ممکن است دکمه نداشته باشد.
    if (text === lastText && !extra.reply_markup) return;
    lastText = text;
    await ctx.api
      .editMessageText(chatId, progress.message_id, text, { parse_mode: "HTML", ...extra })
      .catch(() => {});
  };

  /**
   * اعتبار *پیش* از اجرا کنار گذاشته می‌شود، نه بعدش: وگرنه کاربر می‌تواند
   * چند کار پشت‌سرهم صف کند که مجموعشان از اعتبارش بیشتر است. تسویهٔ نهایی
   * پس از پردازش انجام می‌شود، وقتی مدت واقعی معلوم شد.
   */
  const reservedSec = Math.max(60, job.declaredDurationSec);
  try {
    reserve(userId, reservedSec, sessionId);
  } catch (e) {
    if (e instanceof InsufficientCredit) {
      /**
       * دکمهٔ شارژ همین‌جا لازم است، نه فقط اشاره به منو.
       *
       * این پیام جای پیامِ «دارم کار می‌کنم» را می‌گیرد و کاربر درست در
       * لحظه‌ای است که می‌خواهد ادامه دهد. بدون دکمه، باید صفحه‌کلید پایین
       * را پیدا کند — یعنی همان‌جا که آدم‌ها ول می‌کنند.
       */
      await ctx.api
        .editMessageText(chatId, progress.message_id, S.lowBalanceMessage(e.needed, e.balance), {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🪙 شارژ حساب", "topup"),
        })
        .catch(() => {});
      return;
    }
    throw e;
  }

  /**
   * جای صف به کاربر گفته می‌شود.
   *
   * `MAX_CONCURRENT_JOBS` دوتاست، پس در ساعت شلوغ — مثلاً وقتی یک گروه درسی
   * با هم می‌فرستند — کاربر سوم باید منتظر بماند. بدون این پیام او فقط
   * «دارم آماده می‌شم…» می‌بیند که تکان نمی‌خورد، و خرابی می‌فهمدش.
   */
  const position = enqueue(String(userId), async (signal) => {
    try {
      const course = job.courseId ? getCourse(job.courseId) : null;
      const out = await runPipeline({
        sessionId,
        audioFile: job.audioFile,
        course,
        sessionDate: new Date().toLocaleDateString("fa-IR"),
        makePdf: true,
        mode,
        signal,
        onProgress: (s) => void edit(S.progressMessage(s.stage, s.detail)),
      });

      await ctx.api.deleteMessage(chatId, progress.message_id).catch(() => {});

      // تسویه: فقط تفاوت مدت واقعی و مدتی که رزرو شده بود جابه‌جا می‌شود
      const actualSec = Math.round(out.originalDurationMs / 1000);
      commit(userId, reservedSec, actualSec, sessionId);
      registerOwner(sessionId, userId, actualSec);
      await sendResults(ctx, sessionId, out, course?.name ?? null);

      // گزارش جلسهٔ پولی، ریپلایِ صوتِ همان جلسه در کانال بایگانی
      const saved = getSession(sessionId);
      if (saved && out.report) {
        await archiveReport(saved, out.report, course?.name ?? null);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error({ sessionId, err: message }, "pipeline failed");
      updateSession(sessionId, { status: "error", error: message.slice(0, 500) });
      refund(userId, reservedSec, sessionId, "کار ناموفق بود");
      const failed = getSession(sessionId);
      if (failed) await archiveFailure(failed, message);

      /**
       * **فایل هنوز روی سرور است — پس دوباره‌فرستادن لازم نیست.**
       *
       * پیش از این پیامِ شکست بن‌بست بود: کاربر یا باید همان ۵۰ مگابایت را
       * دوباره آپلود می‌کرد یا رها می‌کرد. روی اینترنت موبایل ایران، دومی.
       * در حالی که `original_file` سرجایش است و تا `KEEP_AUDIO_DAYS` می‌ماند.
       *
       * دکمه فقط وقتی ساخته می‌شود که فایل واقعاً باشد؛ دکمه‌ای که بزنی و
       * بگوید «نیست» از نبودنش بدتر است.
       */
      const canRetry = failed?.original_file
        ? await fs
            .access(failed.original_file)
            .then(() => true)
            .catch(() => false)
        : false;
      await edit(
        `❌ <b>پردازش ناموفق بود</b>\n\n${escapeHtml(message)}\n\n` +
          "<i>سکه‌های رزروشده کامل برگشت.</i>" +
          (canRetry ? "\n\n<i>فایلت همین‌جا نگه داشته شده — لازم نیست دوباره بفرستی.</i>" : ""),
        canRetry
          ? { reply_markup: new InlineKeyboard().text("🔄 دوباره تلاش کن", `retry:${sessionId}`) }
          : {},
      );
    }
  });

  // صفر یعنی همین حالا شروع شد؛ فقط وقتی واقعاً پشت کسی است خبر بده.
  if (position > 0) {
    await edit(
      `⏳ <b>نوبتت تو صفه</b>\n\nنفر <b>${toFaDigits(position)}</b> در صف. تا نوبتت برسه همین‌جا خبرت می‌کنم.`,
    );
  }
}

type PipelineOut = Awaited<ReturnType<typeof runPipeline>>;

/**
 * خروجی کامل، در چهار تکه و به همین ترتیب:
 *
 *   ۱) کلاس چه خبر بود — روایت، برای اینکه در سی ثانیه بداند چه از دست داده
 *   ۲) چی درآوردم — حضور و غیاب، تکلیف، نکته‌های امتحانی با نقل‌قول
 *   ۳) بخش‌بندی کلاس — ریپلای صوت، تا زمان‌ها لینک پخش شوند
 *   ۴) جزوهٔ PDF و رونوشت
 *
 * تفکیک عمدی است: هر تکه یک سؤال دارد، و کسی که فقط سؤال اول را دارد لازم
 * نیست از سه پیام دیگر رد شود.
 */
async function sendResults(
  ctx: Context,
  sessionId: string,
  out: PipelineOut,
  courseName: string | null,
): Promise<void> {
  const r = out.report;
  if (!r) return;
  const s = getSession(sessionId);

  /**
   * زمان‌های داخل متن فقط وقتی لینکِ پخش می‌شوند که پیام، ریپلایِ همان پیام
   * صوتی باشد. پس هر پیامی که مهر زمانی دارد باید به پیام صوت وصل شود.
   * (روی اندروید و آی‌اواس کار می‌کند؛ در نسخهٔ دسکتاپ فعلاً متن ساده می‌ماند.)
   */
  const audioMsgId = s?.audio_message_id ?? null;
  /**
   * **زدنی‌بودن زمان‌ها فقط روی تلگرام است.**
   *
   * بله چنین قابلیتی ندارد؛ ریپلای‌کردنِ پیام روی صوت هیچ زمانی را به لینکِ
   * پخش تبدیل نمی‌کند. شرط قبلی فقط «صوتی هست؟» بود، پس کاربر بله خطِ «رو هر
   * زمان بزنی، صوت از همون‌جا پخش میشه» را می‌خواند و هرچه می‌زد هیچ اتفاقی
   * نمی‌افتاد — بدترین نوع باگ، چون کاربر فکر می‌کند خودش بلد نیست.
   *
   * ریپلای اما روی هر دو سکو می‌ماند: آنجا فقط به گزارش زمینه می‌دهد.
   */
  const linkable = audioMsgId !== null && platformOf(ctx) === "telegram";
  const asReply = linkable
    ? { reply_parameters: { message_id: audioMsgId, allow_sending_without_reply: true } }
    : {};

  await reply(
    ctx,
    S.recapMessage({
      report: r,
      courseName,
      sessionDate: new Date().toLocaleDateString("fa-IR"),
      durationMs: out.originalDurationMs,
      savedMs: out.savedMs,
      qualityWarnings: out.qualityWarnings,
    }),
  );

  await reply(ctx, S.extractedMessage(r), asReply);

  const timeline = S.timelineMessage(r, linkable);
  if (timeline) await reply(ctx, timeline, asReply);

  if (out.pdfPath) {
    await sendDoc(ctx, out.pdfPath, out.pdfName ?? "جزوه.pdf", {
      caption: "📕 <b>جزوهٔ این جلسه</b>\n<i>فقط محتوای درس؛ نکته‌های امتحانی داخل متن رنگی‌اند.</i>",
      parse_mode: "HTML",
    });
  } else if (out.notesError) {
    // تحلیل سالم است؛ فقط مدلِ جزوه در دسترس نبود
    await reply(
      ctx,
      "⚠️ <b>جزوه ساخته نشد</b> ولی تحلیل بالا کامل است.\n\n" +
        `<i>مدل تولید جزوه در دسترس نبود. از «${BTN.history}» می‌توانی بعداً دوباره درخواستش کنی — ` +
        "رونویسی کش شده و دوباره هزینه‌ای ندارد.</i>",
    );
  }

  /**
   * رونوشت **PDF** فرستاده می‌شود، نه `.txt`.
   *
   * فایل متنی روی موبایلِ بله ناخوانا در می‌آمد و هیچ چیزی داخل خودش این را
   * درست نمی‌کرد — نه BOM، نه اعلامِ رمزگذاری (هر پنج ترکیب آزموده شد و بله
   * همه را `text/plain; charset=utf-8` ثبت کرد). PDF قلم و رمزگذاری را با
   * خودش می‌برد. متنِ خام همچنان با دکمهٔ «رونوشت» در تاریخچه در دسترس است.
   */
  await sendDoc(
    ctx,
    out.transcriptPdfPath ?? out.transcriptPath,
    out.transcriptPdfPath ? "رونوشت کامل.pdf" : "رونوشت کامل.txt",
    { caption: "📄 <b>رونوشت کامل</b>\n<i>همهٔ حرف‌های جلسه، پشت سر هم.</i>", parse_mode: "HTML" },
  );
  if (out.transcriptSrtPath) {
    await sendDoc(ctx, out.transcriptSrtPath, "رونوشت زمان‌دار.srt", {
      caption: "⏱ <b>نسخهٔ زمان‌دار</b>\n<i>برای پیدا کردن یک لحظه، یا زیرنویسِ ویدیوی کلاس.</i>",
      parse_mode: "HTML",
    });
  }

  const u = getUser(uid(ctx));
  const cost = Math.round(out.originalDurationMs / 1000);
  if (u) {
    await ctx.reply(S.settlementMessage(cost, u.credit_sec), {
      parse_mode: "HTML",
      reply_markup: shareToggleKeyboard(sessionId, false),
    });
  }
}

// ─── اشتراک‌گذاری ───────────────────────────────────────────────────────────

handlers.callbackQuery(/^son:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  const s = getSession(sessionId);
  if (!s || s.tg_id !== uid(ctx)) {
    await ctx.answerCallbackQuery({ text: "این جلسه مال تو نیست." });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.reply(S.shareTargetPrompt(Math.round(s.original_ms / 1000)), {
    parse_mode: "HTML",
    reply_markup: shareTargetKeyboard(sessionId),
  });
});

handlers.callbackQuery(/^sont:([a-f0-9]+):(\d+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  const people = Number(ctx.match![2]);
  const s = getSession(sessionId);
  if (!s || s.tg_id !== uid(ctx)) {
    await ctx.answerCallbackQuery({ text: "این جلسه مال تو نیست." });
    return;
  }
  setShareTarget(sessionId, people);
  setShareEnabled(sessionId, true);
  await ctx.answerCallbackQuery({ text: "اشتراک‌گذاری روشن شد" });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await sendInvitation(ctx, sessionId);
});

handlers.callbackQuery(/^slink:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  const s = getSession(sessionId);
  if (!s || s.tg_id !== uid(ctx)) {
    await ctx.answerCallbackQuery({ text: "این جلسه مال تو نیست." });
    return;
  }
  await ctx.answerCallbackQuery();
  await sendInvitation(ctx, sessionId);
});

async function sendInvitation(ctx: Context, sessionId: string): Promise<void> {
  const s = getSession(sessionId)!;
  const st = shareStatus(sessionId);
  await ctx.reply(await invitationMessage(ctx.api, s), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  const tail = st?.capReached
    ? "نصفِ هزینه برگشته و از این به بعد هم‌کلاسی‌ها رایگان برش می‌دارن."
    : `هر کی از این لینک بیاد <b>${fmtCost(st?.seatSec ?? 0)}</b> می‌ده و همون به حسابت برمی‌گرده، ` +
      `تا نصفِ هزینه. تا الان <b>${fmtCost(st?.ownerRefundedSec ?? 0)}</b> پس گرفته‌ای.`;
  await ctx.reply(`☝️ این پیام را در گروه درس فوروارد کن.\n\n${tail}`, { parse_mode: "HTML" });
}

handlers.callbackQuery(/^jdo:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  await ctx.answerCallbackQuery({ text: "در حال آماده‌سازی…" });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  try {
    const out = await handleJoin(ctx, sessionId);
    await reply(ctx, out.message);
  } catch (e) {
    logger.error({ sessionId, err: String(e) }, "join failed");
    await reply(ctx, "پیوستن به این جلسه ممکن نشد. دوباره تلاش کن.");
  }
});

handlers.callbackQuery(/^jno:([a-f0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("باشد، منصرف شدی. هر وقت خواستی دوباره روی لینک بزن.");
});

handlers.command("shared", async (ctx) => {
  touchUser(ctx);
  const ids = accessibleSessions(uid(ctx), 15);
  if (ids.length === 0) {
    await reply(ctx, "هنوز در هیچ جلسهٔ اشتراکی نیستی.");
    return;
  }
  const lines = ["<b>جلساتی که به آن‌ها دسترسی داری</b>", ""];
  for (const id of ids) {
    const s = getSession(id);
    if (!s) continue;
    const st = shareStatus(id);
    const mine = s.tg_id === uid(ctx) ? "فرستادهٔ خودت" : "پیوسته‌ای";
    const share = st?.capReached ? "رایگان" : `سهم هرکس ${fmtCost(st?.seatSec ?? 0)}`;
    lines.push(
      `• <b>${escapeHtml(s.title ?? "بدون عنوان")}</b> — ${mine}\n` +
        `  ${toFaDigits(st?.memberCount ?? 0)} نفر برداشتن · ${share}`,
    );
  }
  await reply(ctx, lines.join("\n"));
});

// ─── نگهداری ────────────────────────────────────────────────────────────────

export async function cleanupOldAudio(): Promise<void> {
  for (const row of expiredAudio(config.KEEP_AUDIO_DAYS)) {
    await fs.unlink(row.original_file).catch(() => {});
    clearAudioPath(row.id);
  }
}

/**
 * دست‌کدها روی هر دو ربات سوار می‌شوند.
 *
 * بعد از تعریف شدنشان انجام می‌شود، نه بالای فایل: `Composer` در لحظهٔ
 * `use` محتوایش را می‌گیرد.
 */
bot.use(handlers);
baleBot?.use(handlers);

const onError = (label: string) => (err: { error: unknown; ctx: { update: { update_id: number } } }) => {
  logger.error({ err: String(err.error), update: err.ctx.update.update_id, bot: label }, "bot error");
};
bot.catch(onError("telegram"));
baleBot?.catch(onError("bale"));

export { TimeMap, sessionTimeMap };
