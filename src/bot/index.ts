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
import {
  commit, InsufficientCredit, grant, refund, reserve, totalShareRefunds,
} from "../billing/ledger.js";
import {
  accessibleSessions, isMember, registerOwner, setShareEnabled, setShareTarget, shareStatus,
} from "../billing/sharing.js";
import {
  SHARE_CANCEL_CB, handleJoin, invitationMessage, joinPreview, shareTargetKeyboard, shareToggleKeyboard,
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
import {
  MORE_CB, MORE_PART_OF, closingKeyboard, moreKeyboard, reportReplyTo, sendMorePart,
} from "./deliver.js";
import {
  beginTopup, cancelTopup, decide, gatewayConfigured, paymentConfigured, receiveReceipt, settleTopup,
} from "./topup.js";
import {
  DEFAULT_GIFT_COINS, claim as claimGiftCode, claimedMessage, describeUser, giftSummary,
  mintGift, refusalMessage,
} from "./gift.js";
import {
  RATE_LINE, SHARE_TARGET, balanceCoins, coinsAsMinutesIfUseful, coinsToSec, costCoins, fmtBalance, fmtCoins,
  fmtCost, fmtToman,
} from "../billing/coins.js";
import {
  clearAudioPath, courseTerms, createCourse, createSession, expiredAudio,
  getCourse, getSession, getUser, isTranscriptOnly, listCourses, listSessions, pendingSessions,
  countHistory, listHistory, getGift, getTopup, listGifts, overview, pendingTopups, purgeSession, revokeGift, sessionReport,
  sessionTimeMap, updateSession,
  type SessionMode,
  type SessionRow,
} from "../db/index.js";
import { findIdentity, resolveIdentity } from "../db/identity.js";
import { platformOf, setBaleApi, uid } from "./identity.js";
import { sendDoc } from "./bale-upload.js";
import { notifyUser } from "./notify.js";
import { extractUrl, fetchUrlToFile, UrlFetchError, type FetchUrlResult } from "./fetch-url.js";
import { JobFailure } from "../util/job-failure.js";
import {
  GROUP_CB, GROUP_START_PREFIX, expireGroupsAndNotify, groupBuyEnabled, groupSizeKeyboard, groupSizesFor, joinGroup,
  openGroup, payRestAndStart, payRestKeyboard, sendGroupInvite, suggestedGroupSize,
} from "./group-buy.js";
import {
  GROUP_BUY_HOURS, GROUP_SIZES, cancelGroupBuy, groupProgress, groupSeat, groupSeats,
} from "../billing/group-buy.js";
import { funnelReport, recordStart, track } from "../db/funnel.js";
import { clearStarting, markStarting } from "../queue.js";
import { rememberPendingJoin } from "../db/index.js";
import { deliverSession } from "./share.js";

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
  /**
   * دکمه‌های حساب: شارژ و پشتیبانی. پشتیبانی اینجاست چون صفحهٔ حساب همان
   * جایی است که آدم با «سکه‌ام کجا رفت؟» می‌رسد.
   *
   * «سکه بده به هم‌کلاسی» ۲۰۲۶-۰۹-۱۳ رفت: با خرید گروهی و سهمِ هر نفر،
   * راهِ دومی برای جابه‌جا کردنِ سکه فقط یک قاعدهٔ دیگر برای فهمیدن بود.
   */
  const kb = new InlineKeyboard().text(S.CONFIRM_BTN.topup, "topup").row().text(BTN.support, "support");
  await reply(
    ctx,
    S.accountMessage({
      creditSec: u.credit_sec,
      usedSec: u.total_used_sec,
      refundedSec: totalShareRefunds(u.tg_id),
      sessionCount: done,
    }),
    { reply_markup: withBack(kb) },
  );
}

async function supportScreen(ctx: Context): Promise<void> {
  const platform = platformOf(ctx);
  await reply(ctx, supportMessage(platform), {
    reply_markup: withBack(supportKeyboard(platform) ?? new InlineKeyboard()),
  });
}

handlers.callbackQuery("support", async (ctx) => {
  await ctx.answerCallbackQuery();
  await supportScreen(ctx);
});

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
function sessionLabel(s: SessionRow, joined = false): string {
  const icon =
    s.status === "done" ? (isTranscriptOnly(s.mode) ? "📄" : "📋") : s.status === "error" ? "❌" : "⏳";
  const title = (s.title ?? "بدون عنوان").trim();
  const short = title.length > 30 ? title.slice(0, 29).trimEnd() + "…" : title;
  // تاریخ شمسی با نام ماه؛ چرایی در `faDate`.
  const when = S.faDate(s.created_at);
  return `${icon} ${joined ? `${S.MEMBER_MARK} ` : ""}${short}${when ? ` · ${when}` : ""}`;
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
  // جلسه‌های گرفته‌شده از هم‌کلاسی هم — چرایی در `listHistory`.
  const total = countHistory(id);

  if (total === 0) {
    await reply(ctx, S.HISTORY_EMPTY);
    return;
  }

  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  const safe = Math.min(Math.max(0, page), pages - 1);
  const rows = listHistory(id, HISTORY_PAGE, safe * HISTORY_PAGE);

  const kb = new InlineKeyboard();
  for (const s of rows) kb.text(sessionLabel(s, Boolean(s.joined)), `sess:${s.id}`).row();

  // نوار صفحه‌بندی فقط وقتی که واقعاً بیش از یک صفحه باشد.
  if (pages > 1) {
    if (safe > 0) kb.text("▶️ قبلی", `hpage:${safe - 1}`);
    kb.text(`${toFaDigits(safe + 1)} از ${toFaDigits(pages)}`, "noop");
    if (safe < pages - 1) kb.text("بعدی ◀️", `hpage:${safe + 1}`);
  }

  const anyJoined = rows.some((s) => s.joined);
  const text =
    `<b>📚 جلسه‌های تو</b> — ${toFaDigits(total)} جلسه\n\n<i>روی هرکدوم بزنی، بازش می‌کنم.</i>` +
    (anyJoined ? `\n<i>${S.MEMBER_MARK} یعنی از هم‌کلاسیت گرفتی.</i>` : "");

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
  /**
   * مالک **یا عضو** — همان `readableSession` که دکمه‌های جزوه و متن دارند.
   *
   * کارت پیش‌تر فقط برای مالک باز می‌شد؛ حالا که جلسه‌های گرفته‌شده در فهرست
   * می‌آیند، زدن رویشان نباید «پیدا نشد» بدهد. دکمه‌های مالک (شروع، ارتقا،
   * شریک‌شدن) فقط برای مالک ساخته می‌شوند — دست‌کدهایشان هم مالکیت را
   * می‌سنجند، ولی دکمه‌ای که بزنی و بگوید «مال تو نیست» نباید اصلاً دیده شود.
   */
  const s = readableSession(ctx, sessionId);
  if (!s) {
    await ctx.answerCallbackQuery({ text: "این جلسه پیدا نشد." });
    return;
  }
  await ctx.answerCallbackQuery();
  const owner = s.tg_id === uid(ctx);

  const kb = new InlineKeyboard();
  /**
   * جلسه‌ای که منتظر «بله» یا منتظر شارژ مانده باید از همین‌جا هم قابل
   * شروع باشد — وگرنه تنها راهش پیامِ اصلی است و آن پیام در چتِ شلوغ گم
   * می‌شود؛ یعنی کاربر باید فایل را دوباره بفرستد.
   */
  if (owner && (s.status === "awaiting_confirm" || s.status === "awaiting_credit") && s.original_file) {
    kb.text("✅ شروع کن", `go:${s.id}`).row();
  }
  // خرید گروهیِ باز: همان دو کاری که مالک از پیامِ دعوت هم می‌تواند بکند.
  if (owner && s.status === "awaiting_group") {
    kb.text(S.GROUP_BTN.payRest, `${GROUP_CB.rest}:${s.id}`).row();
    kb.text(S.GROUP_BTN.resend, `${GROUP_CB.link}:${s.id}`).row();
  }
  if (s.pdf_path) kb.text("📕 فایل جزوه", `pdf:${s.id}`);
  if (s.report_json) kb.text("📋 خلاصه و نکته‌ها", `rep:${s.id}`);
  if (s.transcript_txt) kb.row().text("📄 متن کامل کلاس", `txt:${s.id}`);
  if (owner && isTranscriptOnly(s.mode) && s.status === "done") {
    kb.row().text("✨ تحلیل کامل این جلسه", `full:${s.id}`);
  }
  if (owner && s.mode === "full" && s.status === "done") {
    kb.row().text(
      s.share_enabled ? S.SHARE_BTN.link : S.SHARE_BTN.off,
      s.share_enabled ? `slink:${s.id}` : `son:${s.id}`,
    );
  }
  kb.row().text("↩️ فهرست جلسه‌ها", "hpage:0").text("🏠 منوی اصلی", "home");

  const course = s.course_id ? getCourse(s.course_id) : null;
  const meta = [
    S.faDate(s.created_at),
    s.original_ms ? fmtDuration(s.original_ms) : null,
    course?.name,
    owner ? null : `${S.MEMBER_MARK} از هم‌کلاسیت`,
  ]
    .filter(Boolean)
    .join(" · ");
  // برچسبِ فارسی، نه نامِ ستون — چرایی در `STATUS_LABEL`.
  const status =
    s.status === "done"
      ? ""
      : ` ${s.status === "error" ? "❌" : "⏳"} <i>${S.sessionStatusLabel(s.status)}</i>`;

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
  // متن در strings است تا پیش‌نمایش هم همان را ببیند؛ جملهٔ اجازه هم آنجاست.
  await ctx.reply(S.sendPromptMessage(forwardLine, balanceSec), {
    parse_mode: "HTML",
    reply_markup: withBack(kb),
  });
}

// ─── دستورها ────────────────────────────────────────────────────────────────

handlers.command("start", async (ctx) => {
  const u = touchUser(ctx);

  const payload = (ctx.match as string | undefined)?.trim() ?? "";

  /**
   * منبعِ ورود، پیش از هر شاخه.
   *
   * لینکِ تبلیغ `?start=s_<نام>` است و هیچ شاخهٔ دیگری آن را نمی‌خواند، پس
   * به خوش‌آمدِ عادی می‌رسد. لینک‌های هدیه و جزوه هم منبع‌اند و همین‌جا ثبت
   * می‌شوند؛ `/funnel` از همین جدول می‌خواند.
   */
  if (u) recordStart(u.tg_id, payload);

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
    // لینکِ هدیه از خوش‌آمد و تورِ نمونه رد می‌شود؛ پس نمونه همین‌جا پیشنهاد
    // می‌شود، پیش از آنکه گیرنده بی‌آنکه خروجی را دیده باشد صوت بفرستد.
    await reply(ctx, claimedMessage(out.coins, out.balanceSec), {
      reply_markup: new InlineKeyboard()
        .text(S.START_BTN.sample, WELCOME_CB)
        .row()
        .text(S.START_BTN.send, "startnow"),
    });
    await notifyGiftClaimed(ctx, code, id, out.coins);
    return;
  }

  /**
   * لینکِ قدیمیِ انتقال سکه: /start t_<code>
   *
   * انتقال سکه برداشته شد، ولی لینک‌هایی که پیش از آن در گروه‌ها رفته‌اند
   * هنوز زده می‌شوند. سکه موقع ساختنِ لینک کم نمی‌شد، پس چیزی گم نشده؛ فقط
   * باید به‌جای خوش‌آمدِ بی‌ربط گفته شود که این لینک دیگر کار نمی‌کند.
   */
  if (payload.startsWith("t_")) {
    await ctx.reply("سلام 👋", { reply_markup: mainKeyboard });
    await reply(ctx, S.TRANSFER_GONE);
    return;
  }

  /**
   * لینک خرید گروهی: /start p_<sessionId>
   *
   * پرچم اینجا سنجیده **نمی‌شود**: اگر قابلیت خاموش شد و گروهی باز مانده،
   * هم‌کلاسی‌ها باید بتوانند همان را پر کنند؛ فقط ساختنِ گروهِ تازه بسته است.
   */
  if (payload.startsWith(GROUP_START_PREFIX)) {
    const sessionId = payload.slice(GROUP_START_PREFIX.length);
    const me = uid(ctx);
    const p = groupProgress(sessionId);
    const live = p && p.status === "open" && new Date(p.expiresAt).getTime() > Date.now();
    const refusal = !live
      ? S.GROUP_REFUSAL.closed
      : p.ownerId === me
        ? S.GROUP_REFUSAL.owner
        : groupSeats(sessionId).some((x) => x.tg_id === me)
          ? S.GROUP_REFUSAL.already
          : p.full
            ? S.GROUP_REFUSAL.full
            : null;
    if (refusal || !p) {
      await reply(ctx, refusal ?? S.GROUP_REFUSAL.closed, { reply_markup: mainKeyboard });
      return;
    }
    await ctx.reply(
      S.groupPreviewMessage({
        durationMs: p.costSec * 1000,
        seats: p.seats,
        filled: p.filled,
        seatCoins: p.seatCoins,
        balanceSec: u?.credit_sec ?? 0,
      }),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text(S.GROUP_BTN.join, `${GROUP_CB.join}:${sessionId}`)
          .row()
          .text(S.GROUP_BTN.later, `jno:${sessionId}`),
      },
    );
    return;
  }

  // لینک دعوت: /start j_<sessionId>
  if (payload.startsWith("j_")) {
    const sessionId = payload.slice(2);
    const s = getSession(sessionId);
    if (!s || s.status !== "done" || !s.share_enabled) {
      await reply(ctx, "این لینک دیگه کار نمی‌کنه؛ یا جلسه آماده نیست، یا صاحبش شریکی رو خاموش کرده.", {
        reply_markup: mainKeyboard,
      });
      return;
    }
    if (s.tg_id === uid(ctx)) {
      await reply(ctx, `این جلسهٔ خودته؛ از «${BTN.history}» بازش کن.`, { reply_markup: mainKeyboard });
      return;
    }
    const preview = joinPreview(s, u?.credit_sec ?? 0);
    if (!preview) {
      await reply(ctx, "این جلسه الان در دسترس نیست.", { reply_markup: mainKeyboard });
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
   * ندیده‌اند و اثباتِ کار، قوی‌ترین دلیل ماندن است. (این توضیح مدتی اینجا
   * بود در حالی که دکمهٔ نمونه اصلاً روی صفحه‌کلید نبود — «صوت می‌فرستم» اول
   * بود و «چطور کار می‌کنه» دوم، و نمونه فقط پشتِ دومی پیدا می‌شد.)
   */
  await ctx.reply("سلام 👋", { reply_markup: mainKeyboard });
  await ctx.reply(WELCOME, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: new InlineKeyboard()
      .text(S.START_BTN.sample, WELCOME_CB)
      .row()
      .text(S.START_BTN.send, "startnow")
      .row()
      .text(BTN.how, "howto"),
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
    reply_markup: withBack(new InlineKeyboard().text(S.START_BTN.sample, WELCOME_CB)),
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
  // «تور را دید» جای دیگری ثبت نمی‌شود و گامِ اولِ قیف است.
  track(uid(ctx), "demo");
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
      /**
       * وعدهٔ «رو زمان بزنی پخش میشه» فقط روی تلگرام.
       *
       * زمان‌های زدنی قابلیتِ تلگرام است و فقط در پیامی که ریپلایِ همین صوت
       * است — که گام‌های بعدیِ تور هستند. کاربر بله همان جمله را می‌خواند،
       * می‌زد و هیچ اتفاقی نمی‌افتاد؛ برای او فقط گفته می‌شود آن عددها چه‌اند.
       */
      caption:
        `🎧 <b>صوت همین جلسه</b> — ${escapeHtml(SAMPLE_COURSE)}\n` +
        (platform === "telegram"
          ? "<i>نگهش دار؛ پایین رو زمان‌ها که بزنی، از همون‌جا پخش می‌شه.</i>"
          : "<i>زمان‌هایی که پایین می‌بینی، دقیقه‌های همین صوته.</i>"),
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
      "بعدی: کلاس دقیقه‌به‌دقیقه ←",
    ),
  });
});

handlers.callbackQuery(new RegExp(String.raw`^${DEMO_CB.timeline}(?::\d+)?$`), async (ctx) => {
  await advance(ctx);
  // زمان‌ها فقط وقتی لینک می‌شوند که پیام واقعاً ریپلایِ صوت باشد — و فقط روی
  // تلگرام؛ بله قابلیتش را ندارد و نباید وعده‌اش را بخواند.
  const audioId = demoAudioIdOf(ctx);
  await reply(ctx, S.timelineMessage(SAMPLE_REPORT, audioId !== null && platformOf(ctx) === "telegram"), {
    ...demoReplyTo(ctx),
    reply_markup: stepKeyboard(DEMO_CB.outro, "بعدی: جزوهٔ این جلسه ←"),
  });
});

handlers.callbackQuery(DEMO_CB.outro, async (ctx) => {
  await advance(ctx);

  // جزوه و رونوشتِ همان جلسهٔ نمونه — دو تکهٔ آخرِ خروجی واقعی.
  await sendDoc(ctx, SAMPLE_PDF_PATH, "نمونه-جزوه.pdf", {
    caption: "📕 <b>فایل جزوهٔ همین جلسه</b>\n<i>فقط محتوای درس؛ نکته‌های امتحانی داخل متن رنگی‌اند.</i>",
    parse_mode: "HTML",
  });
  await sendDoc(ctx, SAMPLE_TRANSCRIPT_PATH, "نمونه-متن کامل کلاس.txt", {
    caption: "📄 متن کامل همین کلاس",
  });

  await reply(ctx, outroMessage(config.SUPPORT_USERNAME), {
    reply_markup: withBack(new InlineKeyboard().text(S.START_BTN.send, "startnow")),
  });
  demoAudioMsg.delete(uid(ctx));
});

handlers.command("help", (ctx) => reply(ctx, S.HELP, { reply_markup: mainKeyboard }));
handlers.command("menu", (ctx) => ctx.reply("بفرما 👇", { reply_markup: mainKeyboard }));
handlers.command("credit", (ctx) => accountScreen(ctx));
handlers.command("buy", (ctx) => topupScreen(ctx));

/**
 * انتقال سکه میان کاربران برداشته شد (۲۰۲۶-۰۹-۱۳).
 *
 * `/send` و دکمه‌های «سکه بده» که هنوز در چت‌های قدیمی مانده‌اند، جوابِ روشن
 * می‌گیرند نه سکوت — دکمه‌ای که بزنی و هیچ نشود، خراب خوانده می‌شود. ادمین
 * برای سکه دادن `/grant` و `/gift` را دارد.
 */
handlers.command("send", (ctx) => reply(ctx, S.TRANSFER_GONE));
handlers.callbackQuery(/^give(:\d+)?$/, (ctx) => ctx.answerCallbackQuery({ text: S.TRANSFER_GONE, show_alert: true }));

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
    /**
     * خرید گروهیِ باز اول بسته می‌شود، با برگشتِ سکهٔ همه.
     *
     * رزروِ هم‌کلاسی‌ها به همین جلسه بسته است؛ پاک‌کردنِ جلسه بی این کار آن
     * سکه‌ها را برای همیشه قفل می‌کرد، چون دیگر جلسه‌ای نمی‌ماند که
     * `danglingReservations` برگرداندش.
     */
    if (s.status === "awaiting_group") {
      const closed = cancelGroupBuy(s.id);
      for (const x of closed?.participants ?? []) {
        if (x.role === "member") await notifyUser(x.tgId, S.GROUP_CANCELLED_MEMBER).catch(() => {});
      }
    }
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
  const o = overview();

  /**
   * نام سکو فارسی می‌شود چون این پیام را آدم می‌خواند نه ماشین. سکوی ناشناخته
   * با نام خامش می‌آید تا اگر روزی سکوی سومی اضافه شد، بی‌صدا از آمار نیفتد.
   */
  const platformName: Record<string, string> = { telegram: "تلگرام", bale: "بله", web: "وب" };
  const platforms = o.byPlatform
    .map((p) => `${platformName[p.platform] ?? p.platform} ${toFaDigits(p.users)}`)
    .join("، ");

  await reply(
    ctx,
    `<b>کاربران</b>\n` +
      `کل: ${toFaDigits(o.users)}\n` +
      `${platforms || "—"}\n` +
      `تازه: امروز ${toFaDigits(o.usersToday)}، هفت روز ${toFaDigits(o.users7d)}\n\n` +
      `<b>استفاده</b>\n` +
      `کسانی که دست‌کم یک جلسه ساختند: ${toFaDigits(o.activeUsers)}\n` +
      `جلسه‌ها: ${toFaDigits(o.sessions)} کل، ${toFaDigits(o.sessionsDone)} کامل\n\n` +
      `<b>حالا</b>\n` +
      `صف: ${toFaDigits(q.active)} فعال، ${toFaDigits(q.pending)} در انتظار\n` +
      `شارژهای بی‌تکلیف: ${toFaDigits(pendingTopups(50).length)}`,
  );
});

/**
 * قیف — `/funnel` یا `/funnel 30`.
 *
 * هم‌گروهی است: هر عدد از میانِ کسانی است که در همان چند روز آمده‌اند. درصدِ
 * هر گام نسبت به کلِ آن گروه است نه گامِ قبل، تا یک نگاه بگوید چند نفر از
 * صد نفر به پرداخت رسیدند.
 */
handlers.command("funnel", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = Number(((ctx.match as string | undefined) ?? "").trim());
  const days = Number.isFinite(arg) && arg >= 1 && arg <= 365 ? Math.floor(arg) : 7;
  const r = funnelReport(days);
  const pct = (n: number, of: number) => (of ? ` (${toFaDigits(Math.round((100 * n) / of))}٪)` : "");
  const t = r.total;
  const line = (label: string, n: number) => `${label}: ${toFaDigits(n)}${pct(n, t.users)}`;

  const sources = r.bySource
    .slice(0, 10)
    .map(
      (s) =>
        `<code>${escapeHtml(s.source)}</code> — ${toFaDigits(s.users)} نفر، ` +
        `${toFaDigits(s.uploaded)} صوت، ${toFaDigits(s.joined)} جزوهٔ هم‌کلاسی، ${toFaDigits(s.paid)} پرداخت`,
    )
    .join("\n");

  const webNames: Record<string, string> = {
    landing_view: "بازدید سایت",
    landing_cta: "کلیک روی شروع",
    app_view: "صفحهٔ ورود",
    bot_link: "کلیک به ربات",
  };
  const web = r.web
    .slice(0, 12)
    .map((w) => `${webNames[w.name] ?? w.name} · <code>${escapeHtml(w.source)}</code>: ${toFaDigits(w.n)}`)
    .join("\n");

  await reply(
    ctx,
    `<b>قیف ${toFaDigits(days)} روز اخیر</b>\n` +
      `${line("آمدند", t.users)}\n` +
      `${line("نمونه رو دیدند", t.demo)}\n` +
      `${line("صوت فرستادند", t.uploaded)}\n` +
      `${line("جزوه گرفتند", t.delivered)}\n` +
      `${line("جزوهٔ هم‌کلاسی گرفتند", t.joined)}\n` +
      `${line("پرداخت کردند", t.paid)}\n\n` +
      `<b>منبع ورود</b>\n${sources || "—"}\n\n` +
      `<b>سایت</b>\n${web || "—"}\n\n` +
      `<b>یادآوری</b>\n` +
      `فرستاده: ${toFaDigits(r.nudges.sent)}، رسیده: ${toFaDigits(r.nudges.delivered)}، ` +
      `بعدش صوت فرستادند: ${toFaDigits(r.nudges.uploadedAfter)}\n\n` +
      `<i>«نمونه رو دیدند» از امروز شمرده می‌شود؛ بقیه تاریخچه دارند.</i>`,
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
    return void (await supportScreen(ctx));
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
      (gatewayConfigured()
        ? `<i>برای شارژ حساب، از «${BTN.account}» پکیجت رو انتخاب کن — پرداخت آنلاینه و رسید لازم نیست.</i>`
        : `<i>اگه رسید پرداخته، اول از «${BTN.account}» پکیجت رو انتخاب کن، بعد رسید رو بفرست.</i>`),
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

/**
 * صفحه‌کلیدِ تأییدِ هزینه — و **تصمیمِ تقسیم، پیش از خرج‌شدن سکه**.
 *
 * پیشنهادِ تقسیم تا امروز فقط *بعد* از تحویل می‌آمد. آن لحظه بدترین جای
 * ممکن است: کاربر جزوه‌اش را گرفته، سؤالش جواب گرفته، و دیگر دلیلی ندارد
 * دکمه‌ای بزند. اینجا اما دارد به هزینه نگاه می‌کند و «نصفش برمی‌گرده»
 * دقیقاً جوابِ همان چیزی است که در ذهنش می‌گذرد.
 *
 * دکمهٔ بعد از تحویل سرِ جایش می‌ماند — کسی که اینجا تصمیم نگرفت نباید
 * راهش بسته شود.
 *
 * وضعیت از خودِ ردیفِ جلسه خوانده می‌شود نه از پارامتر، چون هر سه مسیرِ
 * ورودی درست پیش از صداکردنِ این تابع جلسه را نوشته‌اند و یک منبعِ حقیقت
 * جلوی «دکمه می‌گوید خاموش، پایگاه‌داده می‌گوید روشن» را می‌گیرد.
 */
function confirmKeyboard(sessionId: string): InlineKeyboard {
  const s = getSession(sessionId);
  const kb = new InlineKeyboard()
    .text(S.CONFIRM_BTN.go, `go:${sessionId}`)
    .text(S.CONFIRM_BTN.cancel, `nogo:${sessionId}`)
    .row();
  return s?.share_enabled
    ? kb.text(S.shareOnButton(s.share_target ?? SHARE_TARGET), `spre:${sessionId}`)
    : kb.text(S.CONFIRM_BTN.share, `spre:${sessionId}`);
}

/**
 * همان صفحه، وقتی سکه کم است: شارژ، و راهِ ادامه پس از شارژ — و **فقط همین**.
 *
 * دکمهٔ «با بچه‌های کلاس شریک می‌شم» اینجا بود، با این استدلال که کسی که سکه
 * کم دارد بیشترین انگیزه را دارد. ولی زیرِ «۷۰ سکه کم داری» آن دکمه مثل راهِ
 * دور زدنِ کسری خوانده می‌شد: «شریک می‌شم، پس کمتر می‌دم». در حالی که کلِ
 * هزینه همچنان پیش از شروع از حسابِ خودش می‌رود و سهمِ هم‌کلاسی‌ها *بعد* از
 * تحویل برمی‌گردد. دکمه‌ای که انتظارِ غلط می‌سازد بدتر از نبودنش است؛ پس از
 * شارژ، همان پیشنهاد روی صفحهٔ تأیید هست.
 *
 * صادر شده تا آزمون همین را قفل کند.
 */
export function lowBalanceKeyboard(sessionId: string, resumeData = `go:${sessionId}`): InlineKeyboard {
  if (groupBuyEnabled()) {
    /**
     * خرید گروهی: دو راهِ **هم‌وزن** در یک ردیف.
     *
     * برخلافِ دکمهٔ شریک‌شدنِ حذف‌شده، این یکی واقعاً کمتر از جیبِ دانشجو
     * می‌گیرد: هزینه پیش از شروع میان همه تقسیم می‌شود. پس «راهِ کم‌دادن»
     * خواندنش انتظارِ غلط نیست، خودِ پیشنهاد است. هیچ‌کدام بالای دیگری
     * نمی‌نشیند، چون هیچ‌کدام پیش‌فرض نیست.
     */
    return new InlineKeyboard()
      .text(S.GROUP_BTN.self, "topup")
      .text(S.GROUP_BTN.group, `${GROUP_CB.open}:${sessionId}`)
      .row()
      .text(S.GROUP_BTN.resume, resumeData);
  }
  return new InlineKeyboard().text(S.CONFIRM_BTN.topup, "topup").row().text("▶️ ادامه بده", resumeData);
}

/** متنِ همان صفحه؛ با خرید گروهی برچسبِ شارژ و جملهٔ دلگرمی هم می‌آید. */
function lowBalanceText(sec: number, balanceSec: number): string {
  return groupBuyEnabled()
    ? S.lowBalanceGroupMessage(sec, balanceSec, suggestedGroupSize(sec, balanceSec), config.FREE_TRIAL_COINS)
    : S.lowBalanceMessage(sec, balanceSec);
}

/** وضعیتِ شریک‌شدنِ یک جلسه، به شکلی که صفحهٔ تأیید می‌خواهد. */
function shareOf(s: SessionRow | null): { people: number } | null {
  return s?.share_enabled ? { people: s.share_target ?? SHARE_TARGET } : null;
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
      lowBalanceText(sec, u.credit_sec) +
        "\n\n<i>فایلت همون‌جا تو چت هست — بعد از شارژ همین دکمه رو بزن، لازم نیست دوباره بفرستی.</i>",
      { reply_markup: lowBalanceKeyboard(sessionId) },
    );
    return;
  }

  await reply(ctx, S.confirmCostMessage(sec, u.credit_sec), {
    reply_markup: confirmKeyboard(sessionId),
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
      lowBalanceText(effectiveSec, u.credit_sec) +
        "\n\n<i>فایلت نگه داشته شد — بعد از شارژ لازم نیست دوباره بفرستی.</i>",
      { reply_markup: lowBalanceKeyboard(sessionId, `resume:${sessionId}`) },
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
      reply_markup: confirmKeyboard(sessionId),
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
  let out;
  try {
    out = await beginTopup(uid(ctx), ctx.match![1]!);
  } catch (e) {
    // زیبال جواب نداد و کارتی هم برای پشتیبان نیست. کاربر باید بداند مشکل
    // از ما بود نه از او، و اینکه دوباره تلاش‌کردن معنا دارد.
    logger.error({ err: String(e) }, "topup start failed");
    await ctx.answerCallbackQuery();
    await reply(
      ctx,
      "درگاه پرداخت الان جواب نمی‌ده 😕 چند دقیقهٔ دیگه دوباره امتحان کن." +
        (config.SUPPORT_USERNAME ? `\n\nاگه تکرار شد به @${config.SUPPORT_USERNAME} بگو.` : ""),
      { reply_markup: withBack(new InlineKeyboard().text("🔄 دوباره", "topup"), null) },
    );
    return;
  }
  if (!out) {
    await ctx.answerCallbackQuery({ text: "این پکیج دیگر موجود نیست." });
    return;
  }
  await ctx.answerCallbackQuery();
  await reply(ctx, out.text, { reply_markup: out.keyboard });
});

/**
 * «بررسی پرداخت» — برای وقتی که بازگشت از درگاه گم شده.
 *
 * همان `settleTopup` که مسیر بازگشت صدا می‌زند؛ اگر پرداخت معتبر باشد و
 * هنوز واریز نشده، همین‌جا واریز می‌شود. پیام واریز را `creditTopup`
 * خودش می‌فرستد، پس اینجا فقط toast لازم است.
 */
handlers.callbackQuery(/^pcheck:([a-f0-9]+)$/, async (ctx) => {
  const t = getTopup(ctx.match![1]!);
  if (!t || t.tg_id !== uid(ctx)) {
    await ctx.answerCallbackQuery({ text: "این سفارش پیدا نشد." });
    return;
  }
  const r = await settleTopup({ topupId: t.id });
  if (r.outcome === "credited" || r.outcome === "already") {
    await ctx.answerCallbackQuery({ text: r.detail });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery({ text: r.detail, show_alert: r.outcome === "error" });
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

  /**
   * خرید گروهیِ باز یا در جریان یعنی سهمِ هم‌کلاسی‌ها رزرو است.
   *
   * «شروع کن» یا «ادامه بده»ی قدیمی که هنوز در چت مانده، از اینجا کلِ هزینه
   * را دوباره از مالک می‌گرفت و کار را تنها شروع می‌کرد — و رزروِ بقیه هرگز
   * پایانی نمی‌گرفت. راهِ درست «بقیه‌اش رو خودم می‌دم» است که جای خالی را پر
   * و همه را با هم تسویه می‌کند.
   */
  const group = groupProgress(sessionId);
  if (group?.status === "open") {
    await reply(ctx, S.GROUP_OPEN_PAY_ALONE, { reply_markup: payRestKeyboard(sessionId) });
    return;
  }
  if (group?.status === "started") {
    await reply(ctx, S.GROUP_STARTED_OWNER);
    return;
  }

  if (isBusy(String(uid(ctx)))) {
    await reply(ctx, "یه کار در جریانه، صبر کن تموم شه 🙏");
    return;
  }

  let durationSec = Math.max(0, Math.round(s.original_ms / 1000));
  if (durationSec > 0 && u.credit_sec < durationSec) {
    await reply(ctx, lowBalanceText(durationSec, u.credit_sec), {
      reply_markup: lowBalanceKeyboard(sessionId),
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
            // «فرستنده» خودِ دانشجوست؛ عددِ اشتباه را سکو گفته بود نه او.
            await reply(
              ctx,
              `این فایل در واقع <b>${toFaDigits(fmtDuration(realSec * 1000))}</b> بود، بیشتر از چیزی که اول نشون داده شد.\n\n` +
                lowBalanceText(realSec, u.credit_sec),
              { reply_markup: lowBalanceKeyboard(sessionId) },
            );
            return;
          }
          updateSession(sessionId, { status: "awaiting_confirm" });
          await reply(
            ctx,
            `این فایل بلندتر از چیزی بود که اول نشون داده شد، پس هزینه‌ش هم بیشتره.\n\n` +
              S.confirmCostMessage(realSec, u.credit_sec, shareOf(getSession(sessionId))),
            { reply_markup: confirmKeyboard(sessionId) },
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
  // همان دامِ `resumeSession`: گروهِ باز یا در جریان را تنها از نو شروع نکن.
  const group = groupProgress(sessionId);
  if (group?.status === "open" || group?.status === "started") {
    await ctx.answerCallbackQuery({ text: S.GROUP_REFUSAL.exists });
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
  await sendDoc(ctx, transcriptBytes(s.transcript_txt), S.FILE_NAME.transcriptTxt, {
    caption: S.CAPTION.transcript,
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
  if (!(await sendDoc(ctx, s.pdf_path, "جزوه.pdf", { caption: S.CAPTION.notes }))) {
    await ctx.reply(`فایل جزوه نرفت 😕 یه بار دیگه بزن؛ اگه باز نشد از «${BTN.support}» بگو.`);
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
  // همان یک جفت ستونِ معتبر که هر دو مسیر تحویل می‌نویسند — نه
  // `audio_message_id` خام، که برای جلسه‌های آمده از مینی‌اپ همیشه تهی است و
  // اینجا بی‌صدا زمان‌ها را از لینکِ پخش می‌انداخت.
  const asReply = reportReplyTo(s, ctx.chat!.id, uid(ctx));
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
  const timeline = S.timelineMessage(
    r,
    "reply_parameters" in asReply && platformOf(ctx) === "telegram",
  );
  if (timeline) await reply(ctx, timeline, asReply);
});

/**
 * ### دکمهٔ زده‌شده **نمی‌رود**
 *
 * یک دوره دکمه را پس از زدن از روی پیام برمی‌داشتیم، با این استدلال که
 * کاربر باید بفهمد زدنش کار کرده. در عمل برعکس شد: دانشجو فایل را گرفته،
 * چت را بسته، و روز امتحان همان پیام را بالا آورده تا دوباره جزوه را
 * بردارد — و دکمه‌ای آنجا نبوده. یعنی برای یک بازخوردِ لحظه‌ای، تنها راهِ
 * دوباره‌گرفتن از دست می‌رفت.
 *
 * حالا دکمه‌ها می‌مانند و هر بار همان فایل را دوباره می‌فرستند؛ فرستادنِ
 * دوبارهٔ یک سند بی‌ضرر است و `answerCallbackQuery` هم همان لحظه نشان می‌دهد
 * که زدن گرفته شد.
 */

/**
 * بخش‌های بایگانیِ یک جلسه: بخش‌بندی زمانی، رونوشت کامل، و SRT.
 *
 * `readableSession` اینجا حیاتی است. `callback_data` یک URL است که هرکس
 * می‌تواند تکرارش کند و شناسهٔ جلسه هم رازی نیست (در لینک دعوت می‌آید)؛ بدون
 * این بررسی، هر کسی رونوشت هر جلسه‌ای را بی‌پرداختِ سهم برمی‌داشت.
 */
handlers.callbackQuery(
  new RegExp(
    String.raw`^(${MORE_CB.timeline}|${MORE_CB.transcript}|${MORE_CB.srt}|${MORE_CB.notes}):([a-f0-9]+)$`,
  ),
  async (ctx) => {
    const part = MORE_PART_OF[ctx.match![1]!]!;
    const s = readableSession(ctx, ctx.match![2]!);
    if (!s) {
      await ctx.answerCallbackQuery({ text: S.MORE_DENIED });
      return;
    }
    // دکمه سر جایش می‌ماند تا بشود دوباره زد — چرایش بالای همین بخش.
    await ctx.answerCallbackQuery({ text: S.MORE_SENDING[part] });
    // `viewerId`: عضو صوت را در چتِ خودش با شناسهٔ دیگری دارد — `reportReplyTo`.
    const ok = await sendMorePart(
      { api: ctx.api, chatId: ctx.chat!.id, platform: platformOf(ctx), viewerId: uid(ctx) },
      s,
      part,
    );
    // فایل ممکن است reap شده باشد (`KEEP_AUDIO_DAYS` و همسایه‌هایش). سکوت
    // بدترین جواب است: کاربر فکر می‌کند دکمه خراب است.
    if (!ok) await ctx.reply(S.MORE_GONE[part]);
  },
);

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
  // تا رزرو ننشسته، «در حال شروع» است — خرید گروهی روی همین جلسه باز نمی‌شود.
  markStarting(sessionId);
  const progress = await ctx.api
    .sendMessage(chatId, S.progressMessage("preprocess"), { parse_mode: "HTML" })
    .catch((e: unknown) => {
      clearStarting(sessionId);
      throw e;
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
    clearStarting(sessionId);
  } catch (e) {
    clearStarting(sessionId);
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
      /**
       * متنِ خطا به دانشجو نشان داده **نمی‌شود** — در لاگ و بایگانی مانده.
       * چرایی و سه حالتِ «مشکل از خودِ فایل است» در `jobFailedMessage`.
       *
       * دکمهٔ «دوباره» فقط برای شکستِ عمومی: فایلی که صدا ندارد یا از سقف
       * بلندتر است، دوباره هم همان نتیجه را می‌دهد.
       */
      const kind = e instanceof JobFailure ? e.kind : null;
      const offerRetry = canRetry && kind === null;
      await edit(
        S.jobFailedMessage(kind, offerRetry),
        offerRetry
          ? { reply_markup: new InlineKeyboard().text(S.RETRY_BTN, `retry:${sessionId}`) }
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
 * خروجی، در سه تکه و به همین ترتیب:
 *
 *   ۱) کلاس چه خبر بود — روایت، برای اینکه در سی ثانیه بداند چه از دست داده
 *   ۲) چی درآوردم — حضور و غیاب، تکلیف، نکته‌های امتحانی با نقل‌قول
 *   ۳) جزوهٔ PDF
 *
 * و بعد یک پیام کوتاه با سه دکمه: بخش‌بندی زمانی، رونوشت کامل، و SRT.
 *
 * **چرا دقیقاً همان تقسیمِ `deliverToBot`.** دو در ورودی داریم — آپلود در
 * خودِ ربات که به اینجا می‌رسد، و آپلود در مینی‌اپ که به `deliverToBot`
 * می‌رسد — و تا امروز هرکدام شکل خودش را داشت. یعنی نیمی از دانشجوها هفت
 * پیام می‌دیدند و نیمی پنج‌تا، و هر تغییرِ بعدی باید دو بار نوشته می‌شد؛
 * همان مکانیزمی که این دو مسیر را از اول از هم دور کرد. پس همان
 * `MORE_CB`/`moreKeyboard`/`sendMorePart` اینجا هم استفاده می‌شود، نه یک
 * پیاده‌سازی موازی.
 *
 * تفکیک عمدی است: هر تکه یک سؤال دارد، و کسی که فقط سؤال اول را دارد لازم
 * نیست از بقیه رد شود.
 */
// صادر شده تا آزمونِ تحویل بتواند همین مسیر را هم براند بدون اجرای خط لوله؛
// هیچ صدازنندهٔ دیگری بیرون از این فایل ندارد.
export async function sendResults(
  ctx: Context,
  sessionId: string,
  out: PipelineOut,
  courseName: string | null,
): Promise<void> {
  const r = out.report;
  if (!r) return;
  const before = getSession(sessionId);

  /**
   * صوتی که گزارش به آن آویزان می‌شود، همین‌جا **قطعی و ذخیره** می‌شود.
   *
   * زمان‌های داخل متن فقط وقتی لینکِ پخش می‌شوند که پیام، ریپلایِ همان پیام
   * صوتی باشد. (روی اندروید و آی‌اواس؛ در دسکتاپ فعلاً متن ساده می‌ماند.)
   *
   * اینجا آن صوت را **خودِ کاربر** فرستاده و `intakeAudio` شناسه‌اش را نگه
   * داشته؛ در مسیر مینی‌اپ `deliverToBot` خودش صوت را می‌فرستد. دو منبعِ
   * متفاوت با یک پرسشِ مشترک — «بخش‌بندی زمانی باید ریپلای کدام پیام در کدام
   * چت شود؟» — پس هر دو جواب را در همان یک جفت ستون می‌نویسند و
   * `sendMorePart` فقط همان را می‌خواند. اگر هرکدام میدان خودش را می‌داشت،
   * دکمه در یکی از دو مسیر بی‌صدا زمان‌هایش را می‌باخت.
   *
   * کاری که از **لینک** آمده هیچ پیام صوتی ندارد؛ آنجا این‌ها تهی می‌مانند و
   * بخش‌بندی بی‌ریپلای می‌رود، همان‌طور که تا امروز می‌رفته.
   */
  if (before?.audio_message_id) {
    updateSession(sessionId, {
      delivered_chat_id: before.audio_chat_id ?? ctx.chat!.id,
      delivered_audio_message_id: before.audio_message_id,
    });
  }
  const s = getSession(sessionId);
  const asReply = s ? reportReplyTo(s, ctx.chat!.id) : {};

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

  // بخش‌بندی زمانی دیگر اینجا نمی‌آید؛ پشت دکمه رفته و `sendMorePart` آن را
  // ریپلایِ همین صوت می‌فرستد تا زمان‌هایش لینکِ پخش بمانند.
  await reply(ctx, S.extractedMessage(r), asReply);

  if (out.pdfPath) {
    await sendDoc(ctx, out.pdfPath, out.pdfName ?? "جزوه.pdf", {
      caption: "📕 <b>جزوهٔ این جلسه</b>\n<i>فقط محتوای درس؛ نکته‌های امتحانی داخل متن رنگی‌اند.</i>",
      parse_mode: "HTML",
    });
  } else if (out.notesError) {
    // تحلیل سالم است؛ فقط جزوه نیامد. چرا متن به دکمه‌ای اشاره نمی‌کند: `NOTES_FAILED`.
    await reply(ctx, S.NOTES_FAILED);
  }

  /**
   * رونوشت کامل و SRT دیگر خودبه‌خود نمی‌آیند — پشت دکمه‌اند.
   *
   * `moreKeyboard` از **سطر پایگاه‌داده** ساخته می‌شود نه از `out`، و فقط
   * برای چیزهایی دکمه می‌گذارد که همان لحظه واقعاً هستند. پس جلسه‌ای که SRT
   * ندارد یا جزوه‌اش ساخته نشده، دکمه‌ای نمی‌گیرد که بزنی و چیزی نیاید.
   * خط لولهٔ پردازش هر سه مسیر (`transcript_pdf`، `transcript_srt`،
   * `report_json`) را پیش از برگشتن نوشته، پس سطر تازه است.
   */
  const u = getUser(uid(ctx));
  const cost = Math.round(out.originalDurationMs / 1000);
  /**
   * **اگر کاربر سرِ تأیید گفته بود «تقسیم می‌کنم»، حالا وقتِ لینک است.**
   *
   * پیش از این اینجا همیشه `false` نوشته شده بود، یعنی حتی جلسه‌ای که
   * اشتراکش روشن بود باز هم دکمهٔ «تقسیم با هم‌کلاسیا» می‌گرفت — کاربر
   * می‌دید انتخابش انگار ثبت نشده و دوباره از اول می‌پرسید.
   *
   * و فرستادنِ خودکارِ دعوت همان چیزی است که تصمیمِ زودهنگام را ارزشمند
   * می‌کند: کاربر یک بار انتخاب کرده، حالا لینک بی‌آنکه دکمه‌ای بزند آماده
   * است تا در گروه درس فوروارد شود.
   */
  const shareOn = Boolean(getSession(sessionId)?.share_enabled);
  // یک پیامِ پایانی، نه دو تا — چرایش در `closingKeyboard`.
  if (s && (u || moreKeyboard(s))) {
    const closingText = u
      ? S.settlementMessage(cost, u.credit_sec, shareOn, {
          people: s.share_target,
          hasArchive: moreKeyboard(s) !== null,
        })
      : S.MORE_PROMPT;
    await ctx.reply(closingText, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: closingKeyboard(s, shareOn),
    });
  }
  if (shareOn) await sendInvitation(ctx, sessionId);
}

// ─── اشتراک‌گذاری ───────────────────────────────────────────────────────────

/**
 * «👥 با هم‌کلاسیا تقسیم می‌کنم» روی صفحهٔ **تأیید هزینه**.
 *
 * پرسشِ تعداد در یک پیام **تازه** می‌آید و پیام تأیید دست‌نخورده می‌ماند —
 * اگر ویرایشش می‌کردیم، کاربری که تعداد را انتخاب نمی‌کرد دکمهٔ «شروع کن»
 * را از دست می‌داد و همان بن‌بستی می‌شد که جای دیگری داریم رفعش می‌کنیم.
 */
handlers.callbackQuery(/^spre:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  const s = getSession(sessionId);
  if (!s || s.tg_id !== uid(ctx)) {
    await ctx.answerCallbackQuery({ text: "این جلسه مال تو نیست." });
    return;
  }
  await ctx.answerCallbackQuery();
  const costSec = Math.round(s.original_ms / 1000);
  await ctx.reply(S.shareTargetPrompt(costSec), {
    parse_mode: "HTML",
    reply_markup: shareTargetKeyboard(sessionId, "sontp", costSec),
  });
});

/**
 * «بی‌خیال» زیر پرسشِ تعداد — فقط پیام را برمی‌دارد.
 *
 * هیچ حالتی عوض نمی‌شود: اگر شریک‌شدن از قبل روشن بود و کاربر فقط آمده بود
 * تعداد را عوض کند، «بی‌خیال» نباید خاموشش کند. مالکیت هم لازم نیست سنجیده
 * شود، چون تنها اثرش روی پیامی در چتِ خودِ همان کاربر است.
 *
 * اگر پاک‌کردن نشد (پیامِ قدیمی، یا سکویی که رد می‌کند) دکمه‌ها برداشته
 * می‌شوند تا دست‌کم دوباره زده نشوند.
 */
handlers.callbackQuery(new RegExp(String.raw`^${SHARE_CANCEL_CB}:([a-f0-9]+)$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(async () => {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });
});

/**
 * انتخابِ تعداد **پیش از پرداخت** — روشن می‌کند و تمام.
 *
 * برخلاف `sont:`، اینجا لینک دعوت فرستاده نمی‌شود: جلسه هنوز پردازش نشده و
 * `joinSession` روی جلسهٔ ناتمام کسی را راه نمی‌دهد. لینک همان لحظه‌ای که
 * نتیجه تحویل شد خودش می‌آید (`sendResults`).
 */
handlers.callbackQuery(/^sontp:([a-f0-9]+):(\d+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  const people = Number(ctx.match![2]);
  const s = getSession(sessionId);
  if (!s || s.tg_id !== uid(ctx)) {
    await ctx.answerCallbackQuery({ text: "این جلسه مال تو نیست." });
    return;
  }
  setShareTarget(sessionId, people);
  setShareEnabled(sessionId, true);
  await ctx.answerCallbackQuery({ text: "تقسیم روشن شد" });
  await ctx
    .editMessageText(S.sharePreEnabledMessage(Math.round(s.original_ms / 1000), people), {
      parse_mode: "HTML",
    })
    .catch(() => {});
});

handlers.callbackQuery(/^son:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  const s = getSession(sessionId);
  if (!s || s.tg_id !== uid(ctx)) {
    await ctx.answerCallbackQuery({ text: "این جلسه مال تو نیست." });
    return;
  }
  await ctx.answerCallbackQuery();
  const costSec = Math.round(s.original_ms / 1000);
  await ctx.reply(S.shareTargetPrompt(costSec), {
    parse_mode: "HTML",
    reply_markup: shareTargetKeyboard(sessionId, "sont", costSec),
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
  // با متن، نه خالی: بی آن، زدنِ دکمه روی بله هیچ نشانی نمی‌داد و کاربر
  // فکر می‌کرد دکمه خراب است.
  await ctx.answerCallbackQuery({ text: "لینک دعوت رو می‌فرستم…" });
  await sendInvitation(ctx, sessionId);
});

async function sendInvitation(ctx: Context, sessionId: string): Promise<void> {
  const s = getSession(sessionId)!;
  const st = shareStatus(sessionId);
  await ctx.reply(await invitationMessage(ctx.api, s), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  await ctx.reply(
    S.invitationTail({
      costSec: Math.round(s.original_ms / 1000),
      seatCoins: costCoins(st?.seatSec ?? 0),
      refundedCoins: costCoins(st?.ownerRefundedSec ?? 0),
      capReached: Boolean(st?.capReached),
    }),
    { parse_mode: "HTML" },
  );
}

handlers.callbackQuery(/^jdo:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  await ctx.answerCallbackQuery({ text: "در حال آماده‌سازی…" });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  try {
    const out = await handleJoin(ctx, sessionId);
    // صفحه‌کلیدِ دعوت همین بالا برداشته شده؛ اگر پاسخ دکمه‌ای دارد (سکهٔ کم)
    // باید همراه پیام برود، وگرنه تازه‌وارد در یک متنِ بی‌راه گیر می‌کند.
    // پیامِ خالی یعنی تأییدِ موفق پیش از تحویل رفته — دوباره نفرست.
    if (out.message) await reply(ctx, out.message, out.keyboard ? { reply_markup: out.keyboard } : {});
  } catch (e) {
    logger.error({ sessionId, err: String(e) }, "join failed");
    await reply(ctx, "پیوستن به این جلسه ممکن نشد. دوباره تلاش کن.");
  }
});

handlers.callbackQuery(/^jno:([a-f0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("باشه. هر وقت خواستی دوباره رو لینک بزن.").catch(() => {});
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

// ─── خرید گروهی ─────────────────────────────────────────────────────────────
//
// قاعده‌ها در `billing/group-buy.ts`، پیام‌ها و شروعِ کار در `bot/group-buy.ts`.
// اینجا فقط اتصالِ دکمه‌ها به آن دو.

/** جلسه‌ای که مالکش می‌تواند برایش گروه باز کند: خودش فرستاده و هنوز شروع نشده. */
function groupableSession(ctx: Context, sessionId: string): SessionRow | null {
  const s = getSession(sessionId);
  if (!s || s.tg_id !== uid(ctx)) return null;
  return s.status === "awaiting_credit" || s.status === "awaiting_confirm" ? s : null;
}

/**
 * فایلِ جلسه باید **پیش از** بازشدنِ گروه روی دیسک باشد.
 *
 * گروه با زدنِ آخرین هم‌کلاسی شروع می‌شود، در چتِ او؛ آنجا نه `file_id`
 * سکوی مالک به کار می‌آید نه می‌شود از مالک خواست فایل را دوباره بفرستد. پس
 * همین حالا، در چتِ خودِ مالک، گرفته می‌شود — و مدتِ واقعی هم همین‌جا معلوم
 * می‌شود تا سهم‌ها روی عددِ درست باشند نه تخمینِ سکو. بایگانی هم همین‌جا،
 * همان‌طور که `resumeSession` پس از دانلود می‌کند.
 */
async function audioForGroup(ctx: Context, s: SessionRow): Promise<{ sec: number } | null> {
  let sec = Math.round(s.original_ms / 1000);
  const onDisk =
    s.original_file !== null && (await fs.access(s.original_file).then(() => true).catch(() => false));
  if (onDisk) return { sec };
  if (!s.audio_file_id) {
    await reply(ctx, "فایل صوتی این جلسه دیگر روی سرور نیست 😔 دوباره بفرستش.");
    return null;
  }
  const dl = await downloadMedia(ctx, {
    sessionId: s.id,
    fileId: s.audio_file_id,
    messageId: s.audio_message_id ?? 0,
    declaredSize: 0,
  });
  if (!dl) return null;
  updateSession(s.id, { original_file: dl.audioFile, download_route: dl.route });
  try {
    const real = Math.round((await probe(dl.audioFile)).durationMs / 1000);
    if (real > 0) {
      sec = real;
      updateSession(s.id, { original_ms: real * 1000 });
    }
  } catch (e) {
    logger.warn({ sessionId: s.id, err: String(e) }, "probe before group buy failed");
  }
  const u = getUser(s.tg_id);
  const platform = platformOf(ctx);
  const caption = audioCaption({
    sender: { tgId: s.tg_id, name: u?.name ?? null, username: u?.username ?? null },
    mode: "full",
    durationMs: sec * 1000,
    sessionId: s.id,
    courseName: s.course_id ? (getCourse(s.course_id)?.name ?? null) : null,
    origin: platform,
  });
  if (platform === "bale") void archiveAudio(s.id, { path: dl.audioFile }, caption, sec);
  else await archiveAudio(s.id, { fileId: s.audio_file_id }, caption, sec);
  return { sec };
}

/**
 * «👥 با هم‌کلاسیا بخریم» — پرسشِ اندازه **جای** همان پیام می‌نشیند.
 *
 * برخلافِ پرسشِ شریک‌شدن که پیامِ تازه می‌فرستد، اینجا «بی‌خیال» باید به همان
 * دو گزینه برگردد؛ ویرایشِ یک پیام این رفت‌وبرگشت را بی‌آنکه چت پر شود
 * می‌دهد. اگر ویرایش نشد (پیامِ قدیمی)، پیامِ تازه.
 */
handlers.callbackQuery(new RegExp(String.raw`^${GROUP_CB.open}:([a-f0-9]+)$`), async (ctx) => {
  const s = groupableSession(ctx, ctx.match![1]!);
  if (!groupBuyEnabled() || !s) {
    await ctx.answerCallbackQuery({ text: S.GROUP_REFUSAL.not_found });
    return;
  }
  await ctx.answerCallbackQuery();
  const costSec = Math.round(s.original_ms / 1000);
  const balanceSec = getUser(uid(ctx))?.credit_sec ?? 0;
  const sizes = groupSizesFor(costSec, balanceSec);
  if (sizes.length === 0) {
    // حتی سهمِ بزرگ‌ترین گروه را هم ندارد: اندازه‌ای نشان نده که فقط به دیوار می‌رسد.
    const biggest = GROUP_SIZES[GROUP_SIZES.length - 1]!;
    const none = S.groupNoSizeMessage(groupSeat(costSec, biggest).seatCoins, balanceSec);
    const noneKb = new InlineKeyboard()
      .text(S.GROUP_BTN.self, "topup")
      .row()
      .text(S.GROUP_BTN.cancel, `${GROUP_CB.back}:${s.id}`);
    await ctx
      .editMessageText(none, { parse_mode: "HTML", reply_markup: noneKb })
      .catch(() => reply(ctx, none, { reply_markup: noneKb }));
    return;
  }
  const text = S.groupSizePrompt(costSec, GROUP_BUY_HOURS, sizes.length < GROUP_SIZES.length);
  const kb = groupSizeKeyboard(s.id, costSec, balanceSec);
  await ctx
    .editMessageText(text, { parse_mode: "HTML", reply_markup: kb })
    .catch(() => reply(ctx, text, { reply_markup: kb }));
});

/** «بی‌خیال» زیرِ اندازه‌ها: برگشت به همان دو گزینه. */
handlers.callbackQuery(new RegExp(String.raw`^${GROUP_CB.back}:([a-f0-9]+)$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = groupableSession(ctx, ctx.match![1]!);
  const u = getUser(uid(ctx));
  if (!s || !u) {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return;
  }
  await ctx
    .editMessageText(lowBalanceText(Math.round(s.original_ms / 1000), u.credit_sec), {
      parse_mode: "HTML",
      reply_markup: lowBalanceKeyboard(s.id),
    })
    .catch(() => {});
});

/** انتخابِ اندازه: فایل روی دیسک، سهمِ مالک رزرو، و پیامِ دعوت. */
handlers.callbackQuery(new RegExp(String.raw`^${GROUP_CB.size}:([a-f0-9]+):(\d+)$`), async (ctx) => {
  const sessionId = ctx.match![1]!;
  const people = Number(ctx.match![2]);
  const u = touchUser(ctx);
  const s = groupableSession(ctx, sessionId);
  if (!groupBuyEnabled() || !s || !u) {
    await ctx.answerCallbackQuery({ text: S.GROUP_REFUSAL.not_found });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

  const ready = await audioForGroup(ctx, s);
  if (!ready) return;

  const out = openGroup({ sessionId, ownerId: u.tg_id, costSec: ready.sec, people, origin: "bot" });
  if (!out.ok) {
    if (out.reason === "short") {
      await reply(ctx, S.groupOwnerShortMessage(costCoins(out.seatSec), out.balanceSec), {
        reply_markup: new InlineKeyboard().text(S.GROUP_BTN.self, "topup"),
      });
      return;
    }
    await reply(ctx, S.GROUP_REFUSAL[out.reason]);
    return;
  }
  const opened = S.groupOpenedMessage(out.progress.seats, out.progress.seatCoins);
  await ctx.editMessageText(opened, { parse_mode: "HTML" }).catch(() => reply(ctx, opened));
  await sendGroupInvite(sessionId, { api: ctx.api, chatId: ctx.chat!.id });
});

/**
 * «✅ هستم».
 *
 * اگر همین ورود گروه را پر کرد، کار شروع شده و خبرش را `startGroup` به همه —
 * این نفر هم — داده است؛ پس اینجا پیامِ دومی نمی‌رود.
 */
handlers.callbackQuery(new RegExp(String.raw`^${GROUP_CB.join}:([a-f0-9]+)$`), async (ctx) => {
  const sessionId = ctx.match![1]!;
  const u = touchUser(ctx);
  if (!u) return;
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  const out = await joinGroup(sessionId, u.tg_id);
  if (out.ok) {
    if (!out.started) {
      await reply(ctx, S.groupJoinedMessage(out.progress.seatCoins, out.progress.filled, out.progress.seats));
    }
    return;
  }
  if (out.reason === "short") {
    // همان الگوی جزوهٔ شریکی: کسری، دکمهٔ شارژ، و برگشت به همین گروه پس از شارژ.
    rememberPendingJoin(u.tg_id, sessionId);
    await reply(ctx, `${S.lowBalanceMessage(out.seatSec, out.balanceSec)}\n\n${S.JOIN_RETURN_HINT}`, {
      reply_markup: new InlineKeyboard().text(S.CONFIRM_BTN.topup, "topup"),
    });
    return;
  }
  await reply(ctx, S.GROUP_REFUSAL[out.reason]);
});

/** «بقیه‌اش رو خودم می‌دم، شروع کن» — خبرِ شروع را `startGroup` می‌دهد. */
handlers.callbackQuery(new RegExp(String.raw`^${GROUP_CB.rest}:([a-f0-9]+)$`), async (ctx) => {
  const sessionId = ctx.match![1]!;
  await ctx.answerCallbackQuery();
  const out = await payRestAndStart(sessionId, uid(ctx));
  if (out.ok) {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    if (!out.started) await reply(ctx, S.GROUP_REFUSAL.closed);
    return;
  }
  if (out.reason === "short") {
    await reply(ctx, S.lowBalanceMessage(out.seatSec, out.balanceSec), {
      reply_markup: new InlineKeyboard().text(S.CONFIRM_BTN.topup, "topup"),
    });
    return;
  }
  await reply(ctx, S.GROUP_REFUSAL[out.reason]);
});

/** دوباره پیامِ گروه کلاس — فقط برای مالک و فقط وقتی گروه باز است. */
handlers.callbackQuery(new RegExp(String.raw`^${GROUP_CB.link}:([a-f0-9]+)$`), async (ctx) => {
  const sessionId = ctx.match![1]!;
  const p = groupProgress(sessionId);
  if (!p || p.ownerId !== uid(ctx) || p.status !== "open") {
    await ctx.answerCallbackQuery({ text: S.GROUP_REFUSAL.closed });
    return;
  }
  await ctx.answerCallbackQuery();
  await sendGroupInvite(sessionId, { api: ctx.api, chatId: ctx.chat!.id });
});

/**
 * «📓 بفرستش» — نتیجهٔ خرید گروهی برای هم‌کلاسی.
 *
 * همان `deliverSession`ِ جزوهٔ شریکی: همان چهار چیز و همان دکمه‌های بایگانی،
 * نه یک تحویلِ سوم. `readableSession` عضویت را می‌سنجد، پس کال‌بکِ ساختگی
 * جزوه‌ای نمی‌دهد.
 */
handlers.callbackQuery(new RegExp(String.raw`^${GROUP_CB.get}:([a-f0-9]+)$`), async (ctx) => {
  const s = readableSession(ctx, ctx.match![1]!);
  if (!s || s.status !== "done") {
    await ctx.answerCallbackQuery({ text: S.MORE_DENIED });
    return;
  }
  // دکمه می‌ماند: هم‌کلاسی ممکن است بعداً همان جلسه را دوباره بخواهد.
  await ctx.answerCallbackQuery({ text: "در حال فرستادن…" });
  try {
    await deliverSession(ctx, s);
  } catch (e) {
    logger.error({ sessionId: s.id, err: String(e) }, "group buy member delivery failed");
    await reply(ctx, "فرستادنش الان نشد؛ از «📚 جلسه‌های من» دوباره امتحان کن.");
  }
});

// ─── نگهداری ────────────────────────────────────────────────────────────────

export async function cleanupOldAudio(): Promise<void> {
  // انقضای خرید گروهی سوارِ همین تایمر است، نه زمان‌بندِ تازه. اول می‌آید تا
  // جلسه‌ای که برگشت، در همین دور با وضعیتِ درستش دیده شود.
  await expireGroupsAndNotify().catch((e: unknown) =>
    logger.error({ err: String(e) }, "group buy expiry failed"),
  );
  for (const row of expiredAudio(config.KEEP_AUDIO_DAYS)) {
    await fs.unlink(row.original_file).catch(() => {});
    clearAudioPath(row.id);
  }
}

/**
 * دکمه‌ای که هیچ دست‌کدی نگرفتش — **ساکت نماند**.
 *
 * تا امروز چنین زدنی نه پیامی می‌داد نه خطی در لاگ: کاربر می‌گفت «می‌زنم
 * هیچی نمیاد» و از بیرون هیچ راهی نبود که بفهمیم کدام دکمه بوده. حالا هم
 * کاربر یک جمله می‌گیرد و هم `callback_data` در لاگ می‌نشیند.
 *
 * آخر از همه ثبت می‌شود تا فقط چیزی به آن برسد که از کنارِ همهٔ دست‌کدهای
 * بالا رد شده.
 */
handlers.on("callback_query:data", async (ctx) => {
  logger.warn(
    { data: ctx.callbackQuery.data, platform: platformOf(ctx), userId: uid(ctx) },
    "دکمهٔ بی‌دست‌کد",
  );
  await ctx.answerCallbackQuery({ text: "این دکمه دیگه کار نمی‌کنه؛ از «📚 جلسه‌های من» برو." });
});

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
