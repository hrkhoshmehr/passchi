import fs from "node:fs/promises";
import path from "node:path";
import { Bot, Composer, InlineKeyboard, InputFile, type Api, type Context } from "grammy";
import { config, requireKey } from "../config.js";
import { logger } from "../util/logger.js";
import { chunkMessage, escapeHtml, htmlToPlain, shortId } from "../util/text.js";
import { fmtClock, fmtDuration, toFaDigits } from "../util/time.js";
import { extractClip, probe, TimeMap } from "../audio/ffmpeg.js";
import { runPipeline } from "../pipeline.js";
import { cancel as cancelJob, enqueue, isBusy, queueDepth } from "../queue.js";
import * as S from "./strings.js";
import { downloadTelegramFile, FileTooLargeError } from "./download.js";
import { commit, InsufficientCredit, grant, refund, reserve, totalShareRefunds } from "../billing/ledger.js";
import { accessibleSessions, registerOwner, setShareEnabled, shareStatus } from "../billing/sharing.js";
import { handleJoin, invitationMessage, joinPreview, shareToggleKeyboard } from "./share.js";
import {
  BTN, HOW_IT_WORKS, WELCOME, WELCOME_CB, mainKeyboard, menuActionOf, packagesKeyboard,
  packagesMessage, supportKeyboard, supportMessage,
} from "./menu.js";
import {
  DEMO_CB, DEMO_INTRO, SAMPLE_COURSE, SAMPLE_DURATION_MS, SAMPLE_PDF_PATH, sampleAudioFileId,
  SAMPLE_REPORT, SAMPLE_TRANSCRIPT_PATH, outroMessage, stepKeyboard,
} from "./demo.js";
import {
  archiveAudio, archiveFailure, archiveReport, archiveUpgrade, audioCaption,
} from "./archive.js";
import { beginTopup, cancelTopup, decide, paymentConfigured, receiveReceipt } from "./topup.js";
import {
  DEFAULT_GIFT_COINS, claim as claimGiftCode, claimedMessage, describeUser, giftSummary,
  mintGift, refusalMessage,
} from "./gift.js";
import {
  coinsAsMinutesIfUseful, coinsToSec, fmtBalance, fmtCoins, fmtCost, fmtToman,
} from "../billing/coins.js";
import {
  clearAudioPath, courseTerms, createCourse, createSession, expiredAudio,
  getCourse, getSession, getUser, isTranscriptOnly, listCourses, listSessions,
  countSessions, getGift, listGifts, pendingTopups, purgeSession, revokeGift, sessionReport,
  sessionTimeMap, updateSession,
  type SessionMode,
  type SessionRow,
} from "../db/index.js";
import { findIdentity, resolveIdentity } from "../db/identity.js";
import { platformOf, setBaleApi, uid } from "./identity.js";
import { notifyUser } from "./notify.js";

export const bot = new Bot(
  requireKey("BOT_TOKEN"),
  config.TELEGRAM_API_ROOT ? { client: { apiRoot: config.TELEGRAM_API_ROOT } } : undefined,
);

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

function isAdmin(id: number): boolean {
  return config.ADMIN_IDS.includes(id);
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
    { reply_markup: new InlineKeyboard().text("🪙 شارژ حساب", "topup") },
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
      { reply_markup: supportKeyboard(platformOf(ctx)) },
    );
    return;
  }
  await reply(ctx, packagesMessage(), { reply_markup: packagesKeyboard() });
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
    await reply(ctx, "هنوز جلسه‌ای نفرستادی 📭\n\nیه فایل صوتی یا ویس بفرست تا شروع کنیم 🎧");
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
async function sessionCard(ctx: Context, sessionId: string): Promise<void> {
  const s = getSession(sessionId);
  if (!s || s.tg_id !== uid(ctx)) {
    await ctx.answerCallbackQuery({ text: "این جلسه پیدا نشد." });
    return;
  }
  await ctx.answerCallbackQuery();

  const kb = new InlineKeyboard();
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
  kb.row().text("↩️ برگشت به فهرست", "hpage:0");

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
  const kb = new InlineKeyboard().text("➕ درس جدید", "newcourse");
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
  const kb = new InlineKeyboard();
  if (config.PUBLIC_URL.startsWith("https://")) {
    kb.webApp("📤 ارسال صوت", `${config.PUBLIC_URL.replace(/\/+$/, "")}/app`);
  }

  await ctx.reply(
    [
      "🎧 <b>صوت کلاستو برسون</b>",
      "",
      "<b>۱. اگه صوت تو همین پیام‌رسانه</b>",
      "فورواردش کن همین‌جا — سریع‌ترین راه، چون فایل اصلاً از گوشیت آپلود نمی‌شه.",
      "",
      "<b>۲. اگه صوت تو گوشیته</b>",
      "دکمهٔ <b>📤 ارسال صوت</b> پایین رو بزن. یه صفحه باز می‌شه که همون‌جا فایلو انتخاب" +
        " می‌کنی و آپلود می‌شه — با اینترنت ملی و بدون محدودیت حجم.",
      "",
      "<i>چه فوروارد کنی چه آپلود، نتیجه همین‌جا تو ربات برات میاد.</i>",
      "",
      "<b>دو نکته که کیفیتو بالا می‌بره:</b>",
      "• گوشی رو بذار رو میز، نه تو کیف",
      "• هرچی به استاد نزدیک‌تر، بهتر",
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: kb.inline_keyboard.length ? kb : undefined },
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
      .text("👀 نمونهٔ یه کلاس واقعی", WELCOME_CB)
      .row()
      .text("🎧 شروع می‌کنم، صوت دارم", "startnow"),
  });
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
  return demoAudioMsg.get(ctx.from!.id) ?? null;
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
  if (sent) demoAudioMsg.set(ctx.from.id, sent.message_id);
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
  await ctx
    .replyWithDocument(new InputFile(SAMPLE_PDF_PATH, "نمونه-جزوه.pdf"), {
      caption: "📕 <b>جزوهٔ همین جلسه</b>\n<i>فقط محتوای درس؛ نکته‌های امتحانی داخل متن رنگی‌اند.</i>",
      parse_mode: "HTML",
    })
    .catch(() => {});
  await ctx
    .replyWithDocument(new InputFile(SAMPLE_TRANSCRIPT_PATH, "نمونه-رونوشت.txt"), {
      caption: "📄 رونوشت کامل با مهر زمانی",
    })
    .catch(() => {});

  await reply(ctx, outroMessage(config.FREE_TRIAL_COINS, config.SUPPORT_USERNAME), {
    reply_markup: supportKeyboard(platformOf(ctx)),
  });
  demoAudioMsg.delete(ctx.from.id);
});

handlers.command("help", (ctx) => reply(ctx, S.HELP, { reply_markup: mainKeyboard }));
handlers.command("menu", (ctx) => ctx.reply("بفرما 👇", { reply_markup: mainKeyboard }));
handlers.command("credit", (ctx) => accountScreen(ctx));
handlers.command("buy", (ctx) => topupScreen(ctx));

handlers.command("course", async (ctx) => {
  touchUser(ctx);
  convo.set(ctx.from!.id, { kind: "await_course_name" });
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
  convo.delete(ctx.from!.id);
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
  if (!isAdmin(ctx.from!.id)) return;
  const [target, amount] = ((ctx.match as string | undefined) ?? "").trim().split(/\s+/);
  const t = Number(target);
  const coins = Number(amount);
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
  if (!isAdmin(ctx.from!.id)) return;

  const parts = ((ctx.match as string | undefined) ?? "").trim().split(/\s+/).filter(Boolean);
  let coins: number | null = null;
  let maxUses = 1;
  let days: number | null = null;
  const words: string[] = [];

  for (const raw of parts) {
    const tok = raw.replace(/[٬,]/g, "");
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
  if (!isAdmin(ctx.from!.id)) return;
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
  if (!isAdmin(ctx.from!.id)) return;
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
  for (const admin of config.ADMIN_IDS) {
    await ctx.api.sendMessage(admin, text, { parse_mode: "HTML" }).catch((e: unknown) => {
      logger.warn({ admin, err: String(e) }, "notify gift claim failed");
    });
  }
}

handlers.command("privacy", (ctx) => reply(ctx, S.PRIVACY));

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
    if (s.original_file) await fs.unlink(s.original_file).catch(() => {});
    if (s.pdf_path) await fs.unlink(s.pdf_path).catch(() => {});
    if (s.share_enabled) {
      setShareEnabled(s.id, false);
      updateSession(s.id, { original_file: null, pdf_path: null });
      unshared++;
    } else {
      purgeSession(s.id);
      removed++;
    }
  }
  await reply(
    ctx,
    `✅ ${toFaDigits(removed)} جلسه کامل پاک شد` +
      (unshared ? ` و ${toFaDigits(unshared)} جلسهٔ اشتراکی از اشتراک خارج شد.` : ".") +
      `\n\n<i>سکه‌هایت دست‌نخورده‌اند.</i>`,
  );
});

handlers.command("stats", async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return;
  const q = queueDepth();
  await reply(
    ctx,
    `صف: ${toFaDigits(q.active)} فعال، ${toFaDigits(q.pending)} در انتظار.\n` +
      `شارژهای بی‌تکلیف: ${toFaDigits(pendingTopups(50).length)}`,
  );
});

/** فهرست شارژهای منتظر تأیید — برای وقتی که پیامِ اعلانِ ادمین گم شده باشد. */
handlers.command("pending", async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return;
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
  const id = ctx.from.id;
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
    if (action === "how") return void (await reply(ctx, HOW_IT_WORKS));
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
    return void (await reply(ctx, supportMessage(), { reply_markup: supportKeyboard(platformOf(ctx)) }));
  }

  const state = convo.get(id);
  if (!state) {
    touchUser(ctx);
    await reply(ctx, "یه فایل صوتی بفرست تا شروع کنم 🎧\n\n<i>یا از دکمه‌های پایین یکی رو بزن.</i>", {
      reply_markup: mainKeyboard,
    });
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
        "حالا صوت کلاسو بفرست 🎧",
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

handlers.on(["message:audio", "message:voice", "message:document", "message:video_note"], async (ctx) => {
  const u = touchUser(ctx);
  if (!u) return;
  const id = ctx.from!.id;

  const msg = ctx.message!;
  const media =
    msg.audio ?? msg.voice ?? msg.video_note ?? (msg.document?.mime_type?.startsWith("audio/") ? msg.document : null);

  if (!media) {
    await reply(ctx, "این صوت نیست 🤔 یه فایل صوتی یا ویس بفرست.");
    return;
  }

  if (isBusy(String(id))) {
    await reply(ctx, "یه کار دارم انجام می‌دم، صبر کن تموم شه 🙏");
    return;
  }

  const durationSec = "duration" in media && media.duration ? media.duration : 0;

  const sessionId = shortId();
  const sizeMb = Math.round((media.file_size ?? 0) / 1024 / 1024);
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
    const dl = await downloadTelegramFile(ctx.api, {
      fileId: media.file_id,
      chatId: ctx.chat!.id,
      messageId: msg.message_id,
      declaredSize: media.file_size ?? 0,
      destDir: config.audioDir,
      baseName: sessionId,
      onProgress: (done, total) => {
        if (total < 20 * 1024 * 1024) return;
        const p = Math.floor((done / total) * 10) * 10;
        if (p <= lastShown || p >= 100) return;
        lastShown = p;
        void ctx.api
          .editMessageText(ctx.chat!.id, statusMsg.message_id, `⬇️ دارم فایلو می‌گیرم… ${toFaDigits(p)}٪`)
          .catch(() => {});
      },
    });
    audioFile = dl.filePath;
    route = dl.route;
  } catch (e) {
    if (e instanceof FileTooLargeError) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        "❌ این فایل بزرگ‌تر از سقف دانلود تلگرام است (۲۰ مگابایت) و مسیر جایگزین پیکربندی نشده.\n\n" +
          "<b>راه‌حل مدیر سیستم:</b> مقدار <code>TELEGRAM_API_ID</code> و <code>TELEGRAM_API_HASH</code> را ست کن تا مسیر MTProto فعال شود.\n\n" +
          "<b>راه‌حل فوری برای تو:</b> فایل را به‌صورت <b>ویس</b> بفرست — تلگرام خودش فشرده‌اش می‌کند و کیفیتش برای تشخیص گفتار کافی است.",
        { parse_mode: "HTML" },
      );
      return;
    }
    logger.error({ err: String(e) }, "download failed");
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "❌ نشد فایلو بگیرم. یه بار دیگه بفرست.");
    return;
  }

  createSession(sessionId, id, null);
  // شناسهٔ پیام صوتی نگه داشته می‌شود تا نتایج «ریپلای» همان پیام شوند —
  // شرط لازم برای اینکه تلگرام زمان‌های داخل متن را لینک پخش کند.
  updateSession(sessionId, {
    audio_chat_id: ctx.chat!.id,
    audio_message_id: msg.message_id,
    audio_file_id: media.file_id,
    download_route: route,
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
  const courses = listCourses(id);
  const recent = listSessions(id, 20).find((s) => s.course_id !== null)?.course_id ?? null;
  const courseId =
    courses.length === 1 ? courses[0]!.id : (recent && courses.some((c) => c.id === recent) ? recent : null);
  if (courseId) updateSession(sessionId, { course_id: courseId });

  updateSession(sessionId, { mode: "full" });
  await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

  /**
   * یک نسخه به کانال بایگانی.
   *
   * همین‌جا و نه بعد از پردازش: اگر خط لوله شکست بخورد هم ادمین باید صوت را
   * داشته باشد تا بفهمد چه چیزی شکست. گزارش بعداً ریپلایِ همین پیام می‌شود.
   */
  await archiveAudio(
    ctx.api,
    sessionId,
    media.file_id,
    audioCaption({
      sender: { tgId: id, name: u.name, username: u.username },
      mode: "full",
      durationMs: durationSec * 1000,
      sessionId,
      courseName: courseId ? (getCourse(courseId)?.name ?? null) : null,
    }),
  );

  /**
   * مدت واقعی — نه فقط آنچه تلگرام گفته.
   *
   * تلگرام برای `audio` و `voice` مدت را می‌دهد ولی برای فایلی که به‌صورت
   * **سند** فرستاده شده اغلب نمی‌دهد و `durationSec` صفر می‌ماند. رزرو اعتبار
   * روی همین عدد انجام می‌شود، پس صفر یعنی جلسه‌ای که هزینه‌اش کسر نمی‌شود.
   *
   * فایل همین‌جا روی دیسک هست، پس وقتی تلگرام ساکت است خودمان می‌پرسیم.
   * شکستِ probe نباید مسیر را بشکند: در آن حالت مثل قبل جلو می‌رویم.
   */
  let effectiveSec = durationSec;
  if (effectiveSec === 0) {
    try {
      effectiveSec = Math.round((await probe(audioFile)).durationMs / 1000);
    } catch (e) {
      logger.warn({ sessionId, err: String(e) }, "probe for duration failed");
    }
  }

  /**
   * اعتبار کم؟ **پیش از** پردازش بگو، نه بعدش.
   *
   * رزرو در `startJob` هم این را می‌گیرد، ولی آنجا کاربر فایلش را فرستاده و
   * منتظر مانده است. اینجا هنوز چیزی شروع نشده و پیام «شارژ کن» با دکمه‌اش
   * بی‌اصطکاک‌ترین جایی است که می‌شود گفت.
   */
  if (effectiveSec > 0 && u.credit_sec < effectiveSec) {
    await reply(ctx, S.lowBalanceMessage(effectiveSec, u.credit_sec), {
      reply_markup: new InlineKeyboard().text("🪙 شارژ حساب", "topup"),
    });
    return;
  }

  await startJob(ctx, {
    sessionId,
    audioFile,
    courseId,
    // مدت واقعی، نه فقط آنچه تلگرام گفته — مبنای رزرو اعتبار همین است
    declaredDurationSec: effectiveSec,
    mode: "full",
  });
});

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
  convo.set(ctx.from.id, { kind: "await_course_name" });
  await reply(ctx, "اسم درس چیه؟\n\n<i>مثلاً: ریاضی مهندسی</i>");
});

handlers.callbackQuery(/^buy:(\w+)$/, async (ctx) => {
  touchUser(ctx);
  const out = beginTopup(ctx.from.id, ctx.match![1]!);
  if (!out) {
    await ctx.answerCallbackQuery({ text: "این پکیج دیگر موجود نیست." });
    return;
  }
  await ctx.answerCallbackQuery();
  await reply(ctx, out.text, { reply_markup: out.keyboard });
});

handlers.callbackQuery(/^bcancel:([a-f0-9]+)$/, async (ctx) => {
  const ok = cancelTopup(ctx.match![1]!, ctx.from.id);
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
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "این دکمه مال تو نیست." });
    return;
  }
  const out = await decide(ctx.api, ctx.match![2]!, ctx.from.id, ctx.match![1] === "tok");
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
  if (!s || !u || s.tg_id !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "این جلسه مال تو نیست." });
    return;
  }
  if (!s.original_file) {
    await ctx.answerCallbackQuery();
    await reply(ctx, "فایل صوتی این جلسه دیگر روی سرور نیست 😔 دوباره بفرستش تا کامل تحلیلش کنم.");
    return;
  }
  if (isBusy(String(ctx.from.id))) {
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
  await archiveUpgrade(ctx.api, s);
  await startJob(ctx, {
    sessionId,
    audioFile: s.original_file,
    courseId: s.course_id,
    declaredDurationSec: durationSec,
    mode: "full",
  });
});

handlers.callbackQuery(/^txt:([a-f0-9]+)$/, async (ctx) => {
  const s = getSession(ctx.match![1]!);
  await ctx.answerCallbackQuery();
  if (!s?.transcript_txt) {
    await ctx.reply("رونوشت این جلسه موجود نیست.");
    return;
  }
  await ctx.replyWithDocument(new InputFile(Buffer.from(s.transcript_txt, "utf8"), "رونوشت کامل.txt"), {
    caption: "📄 رونوشت کامل با مهر زمانی",
  });
});

handlers.callbackQuery(/^clip:([a-f0-9]+):(\d+)$/, async (ctx) => {
  const [, sessionId, atMsRaw] = ctx.match!;
  const s = getSession(sessionId!);
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
  const s = getSession(ctx.match![1]!);
  await ctx.answerCallbackQuery();
  if (!s?.pdf_path) {
    await ctx.reply("جزوهٔ این جلسه موجود نیست.");
    return;
  }
  await ctx.replyWithDocument(new InputFile(s.pdf_path)).catch(async () => {
    await ctx.reply("فایل جزوه دیگر روی سرور نیست.");
  });
});

handlers.callbackQuery(/^rep:([a-f0-9]+)$/, async (ctx) => {
  const s = getSession(ctx.match![1]!);
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
  const timeline = S.timelineMessage(r, Boolean(s.audio_message_id));
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
  const userId = ctx.from!.id;
  const progress = await ctx.api.sendMessage(chatId, S.progressMessage("preprocess"), {
    parse_mode: "HTML",
  });

  let lastText = "";
  const edit = async (text: string) => {
    if (text === lastText) return;
    lastText = text;
    await ctx.api.editMessageText(chatId, progress.message_id, text, { parse_mode: "HTML" }).catch(() => {});
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
      await edit(S.lowBalanceMessage(e.needed, e.balance));
      return;
    }
    throw e;
  }

  enqueue(String(userId), async (signal) => {
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
        await archiveReport(ctx.api, saved, out.report, course?.name ?? null);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error({ sessionId, err: message }, "pipeline failed");
      updateSession(sessionId, { status: "error", error: message.slice(0, 500) });
      refund(userId, reservedSec, sessionId, "کار ناموفق بود");
      const failed = getSession(sessionId);
      if (failed) await archiveFailure(ctx.api, failed, message);
      await edit(
        `❌ <b>پردازش ناموفق بود</b>\n\n${escapeHtml(message)}\n\n` +
          "<i>سکه‌های رزروشده کامل برگشت.</i>",
      );
    }
  });
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
  const linkable = audioMsgId !== null;
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
    await ctx.replyWithDocument(new InputFile(out.pdfPath, out.pdfName ?? "جزوه.pdf"), {
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

  await ctx.replyWithDocument(new InputFile(out.transcriptPath, "رونوشت کامل.txt"), {
    caption: "📄 رونوشت کامل با مهر زمانی",
  });

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
  if (!s || s.tg_id !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "این جلسه مال تو نیست." });
    return;
  }
  setShareEnabled(sessionId, true);
  await ctx.answerCallbackQuery({ text: "اشتراک‌گذاری روشن شد" });
  await sendInvitation(ctx, sessionId);
});

handlers.callbackQuery(/^slink:([a-f0-9]+)$/, async (ctx) => {
  const sessionId = ctx.match![1]!;
  const s = getSession(sessionId);
  if (!s || s.tg_id !== ctx.from.id) {
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
  await ctx.reply(
    "☝️ این پیام را در گروه درس فوروارد کن.\n\n" +
      `هر کسی که از این لینک بیاید، سهم هر نفر کمتر می‌شود و مابه‌التفاوت به تو برمی‌گردد. ` +
      `تا الان <b>${fmtCost(st?.ownerRefundedSec ?? 0)}</b> پس گرفته‌ای.\n\n` +
      `<i>سقف بازگشت، همان چیزی است که خودت داده‌ای — از این محصول نمی‌شود درآمد ساخت، فقط می‌شود هزینه‌اش را صفر کرد.</i>`,
    { parse_mode: "HTML" },
  );
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
    lines.push(
      `• <b>${escapeHtml(s.title ?? "بدون عنوان")}</b> — ${mine}\n` +
        `  ${toFaDigits(st?.memberCount ?? 1)} نفر · سهم هرکس ${fmtCost(st?.currentShareSec ?? 0)}`,
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
