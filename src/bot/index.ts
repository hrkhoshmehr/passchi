import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { config, requireKey } from "../config.js";
import { logger } from "../util/logger.js";
import { chunkMessage, escapeHtml } from "../util/text.js";
import { fmtClock, fmtDuration, toFaDigits } from "../util/time.js";
import { extractClip, TimeMap } from "../audio/ffmpeg.js";
import { runPipeline } from "../pipeline.js";
import { cancel as cancelJob, enqueue, isBusy, queueDepth } from "../queue.js";
import * as S from "./strings.js";
import { downloadTelegramFile, FileTooLargeError } from "./download.js";
import { commit, InsufficientCredit, grant, refund, reserve, totalShareRefunds } from "../billing/ledger.js";
import { accessibleSessions, fairShare, registerOwner, setShareEnabled, shareStatus } from "../billing/sharing.js";
import { handleJoin, invitationMessage, joinPreview, shareToggleKeyboard } from "./share.js";
import {
  addCredit, clearAudioPath, consumeCredit, courseTerms, createCourse, createSession,
  expiredAudio, getCourse, getSession, getUser, listCourses, listSessions,
  purgeSession, sessionReport, sessionTimeMap, updateSession, upsertUser,
} from "../db/index.js";

export const bot = new Bot(
  requireKey("BOT_TOKEN"),
  config.TELEGRAM_API_ROOT ? { client: { apiRoot: config.TELEGRAM_API_ROOT } } : undefined,
);

// ─── وضعیت گفت‌وگوی کوتاه‌مدت (در حافظه) ────────────────────────────────────

type Pending =
  | { kind: "await_course_name" }
  | { kind: "await_professor"; courseName: string }
  | { kind: "await_mode"; sessionId: string; audioFile: string; courseId: number | null; durationSec: number };

const convo = new Map<number, Pending>();
const shortId = () => randomBytes(6).toString("hex");

function isAdmin(id: number): boolean {
  return config.ADMIN_IDS.includes(id);
}

async function reply(ctx: Context, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  for (const part of chunkMessage(text)) {
    await ctx.reply(part, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
  }
}

function touchUser(ctx: Context) {
  const u = ctx.from;
  if (!u) return null;
  const existing = getUser(u.id);
  const row = upsertUser(u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || null, u.username ?? null);
  // اعتبار آزمایشی فقط یک بار، هنگام اولین دیدار
  if (!existing && config.FREE_TRIAL_MINUTES > 0) {
    grant(u.id, Math.round(config.FREE_TRIAL_MINUTES * 60), "trial");
    return getUser(u.id);
  }
  return row;
}

// ─── دستورها ────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const u = touchUser(ctx);

  // لینک دعوت: /start j_<sessionId>
  const payload = (ctx.match as string | undefined)?.trim() ?? "";
  if (payload.startsWith("j_")) {
    const sessionId = payload.slice(2);
    const s = getSession(sessionId);
    if (!s || s.status !== "done" || !s.share_enabled) {
      await reply(ctx, "این لینک معتبر نیست یا صاحبش اشتراک‌گذاری را خاموش کرده.");
      return;
    }
    if (s.tg_id === ctx.from!.id) {
      await reply(ctx, "این جلسهٔ خودت است. با /history بازش کن.");
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

  await reply(ctx, S.WELCOME);
  if (u && u.credit_sec > 0) {
    await reply(ctx, `🎁 <b>${fmtDuration(u.credit_sec * 1000)}</b> اعتبار آزمایشی برایت گذاشتم. امتحانش کن.`);
  }
});

bot.command("help", (ctx) => reply(ctx, S.HELP));

bot.command("credit", (ctx) => {
  const u = touchUser(ctx);
  if (!u) return;
  return reply(ctx, S.creditMessage(u.credit_sec, u.total_used_sec));
});

bot.command("course", async (ctx) => {
  touchUser(ctx);
  convo.set(ctx.from!.id, { kind: "await_course_name" });
  await reply(
    ctx,
    "نام درس را بفرست.\n\n<i>مثال: ریاضی مهندسی — یا هر اسمی که خودت می‌شناسی.</i>",
  );
});

bot.command("courses", async (ctx) => {
  touchUser(ctx);
  const courses = listCourses(ctx.from!.id);
  if (courses.length === 0) {
    await reply(ctx, "هنوز درسی ثبت نکرده‌ای. با /course شروع کن.");
    return;
  }
  const lines = ["<b>درس‌های تو</b>", ""];
  for (const c of courses) {
    const terms = courseTerms(c).length;
    lines.push(
      `• <b>${escapeHtml(c.name)}</b>${c.professor ? ` — ${escapeHtml(c.professor)}` : ""}` +
        (terms ? `\n  <i>${toFaDigits(terms)} اصطلاح تخصصی از جلسات قبل یاد گرفته شده</i>` : ""),
    );
  }
  await reply(ctx, lines.join("\n"));
});

bot.command("history", async (ctx) => {
  touchUser(ctx);
  const rows = listSessions(ctx.from!.id, 10);
  if (rows.length === 0) {
    await reply(ctx, "هنوز جلسه‌ای پردازش نکرده‌ای.");
    return;
  }
  for (const s of rows) {
    const kb = new InlineKeyboard();
    if (s.pdf_path) kb.text("📕 جزوه", `pdf:${s.id}`);
    if (s.report_json) kb.text("📋 تحلیل", `rep:${s.id}`);
    const status = s.status === "done" ? "" : ` <i>(${s.status})</i>`;
    await ctx.reply(
      `<b>${escapeHtml(s.title ?? "بدون عنوان")}</b>${status}\n<i>${escapeHtml(
        s.created_at,
      )} · ${fmtDuration(s.original_ms)}</i>`,
      { parse_mode: "HTML", reply_markup: kb.inline_keyboard.length ? kb : undefined },
    );
  }
});

bot.command("cancel", async (ctx) => {
  const id = ctx.from!.id;
  const rows = listSessions(id, 5).filter((s) => !["done", "error", "cancelled"].includes(s.status));
  let done = false;
  for (const s of rows) if (cancelJob(s.id)) { updateSession(s.id, { status: "cancelled" }); done = true; }
  convo.delete(id);
  await reply(ctx, done ? "لغو شد." : "کاری در حال انجام نیست.");
});

bot.command("grant", async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return;
  const [, target, minutes] = (ctx.match as string | undefined)?.split(/\s+/) ?? [];
  const t = Number(target);
  const m = Number(minutes);
  if (!Number.isFinite(t) || !Number.isFinite(m)) {
    await reply(ctx, "استفاده: <code>/grant &lt;tg_id&gt; &lt;minutes&gt;</code>");
    return;
  }
  grant(t, Math.round(m * 60), "grant");
  await reply(ctx, `اعتبار ${toFaDigits(m)} دقیقه به ${toFaDigits(t)} اضافه شد.`);
});

bot.command("privacy", (ctx) => reply(ctx, S.PRIVACY));

/**
 * حذف داده به‌خواستِ کاربر.
 *
 * هر محصولی که صدای آدم‌ها را نگه می‌دارد باید راهی برای پاک‌کردنش داشته
 * باشد، و آن راه باید یک دستور ساده باشد نه ایمیل‌زدن به پشتیبانی.
 * جلسه‌ای که اشتراکی شده استثناست: پاک‌کردنش دسترسی کسانی را که بابتش
 * پرداخت کرده‌اند از بین می‌برد، پس فقط اشتراک‌گذاری‌اش خاموش می‌شود.
 */
bot.command("forget", async (ctx) => {
  const id = ctx.from!.id;
  const arg = (ctx.match as string | undefined)?.trim() ?? "";

  if (arg !== "همه" && arg !== "all") {
    const rows = listSessions(id, 50);
    await reply(
      ctx,
      `<b>حذف داده</b>\n\n` +
        `الان ${toFaDigits(rows.length)} جلسه از تو ذخیره است.\n\n` +
        `برای پاک‌کردن همه‌شان — صوت، رونوشت، تحلیل و جزوه — بنویس:\n` +
        `<code>/forget همه</code>\n\n` +
        `<i>اعتبارت دست‌نخورده می‌ماند. جلساتی که اشتراکی کرده‌ای فقط از اشتراک خارج می‌شوند، ` +
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
      `\n\n<i>اعتبارت دست‌نخورده است.</i>`,
  );
});

bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return;
  const q = queueDepth();
  await reply(ctx, `صف: ${toFaDigits(q.active)} فعال، ${toFaDigits(q.pending)} در انتظار.`);
});

// ─── پیام متنی (ادامهٔ گفت‌وگو) ──────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const id = ctx.from.id;
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  const state = convo.get(id);
  if (!state) {
    await reply(ctx, "یک فایل صوتی بفرست تا شروع کنم. /help راهنما را نشان می‌دهد.");
    return;
  }

  if (state.kind === "await_course_name") {
    convo.set(id, { kind: "await_professor", courseName: text.slice(0, 80) });
    await reply(ctx, "نام استاد؟ اگر نمی‌خواهی بنویسی، «-» بفرست.");
    return;
  }

  if (state.kind === "await_professor") {
    const prof = text === "-" ? null : text.slice(0, 80);
    const c = createCourse(id, state.courseName, prof);
    convo.delete(id);
    await reply(
      ctx,
      `✅ درس <b>${escapeHtml(c.name)}</b> ثبت شد.\n\n` +
        "<i>از این به بعد اصطلاحات تخصصی هر جلسه ذخیره می‌شوند و در جلسات بعدی به موتور تشخیص گفتار داده می‌شوند — یعنی دقت این درس به‌مرور بهتر می‌شود.</i>\n\n" +
        "حالا صوت کلاس را بفرست.",
    );
  }
});

// ─── دریافت صوت ─────────────────────────────────────────────────────────────

bot.on(["message:audio", "message:voice", "message:document", "message:video_note"], async (ctx) => {
  const u = touchUser(ctx);
  if (!u) return;
  const id = ctx.from!.id;

  const msg = ctx.message!;
  const media =
    msg.audio ?? msg.voice ?? msg.video_note ?? (msg.document?.mime_type?.startsWith("audio/") ? msg.document : null);

  if (!media) {
    await reply(ctx, "این فایل صوتی نیست. یک فایل mp3، m4a، ogg، wav یا ویس تلگرام بفرست.");
    return;
  }

  if (isBusy(String(id))) {
    await reply(ctx, "یک کار در حال انجام است. صبر کن تمام شود یا /cancel بزن.");
    return;
  }

  const durationSec = "duration" in media && media.duration ? media.duration : 0;
  if (durationSec > 0 && u.credit_sec < durationSec) {
    await reply(
      ctx,
      `اعتبارت کافی نیست.\n\nطول این فایل ${fmtDuration(durationSec * 1000)} است ولی ` +
        `${fmtDuration(u.credit_sec * 1000)} اعتبار داری.\n\n/credit`,
    );
    return;
  }

  const sessionId = shortId();
  const sizeMb = Math.round((media.file_size ?? 0) / 1024 / 1024);
  const statusMsg = await ctx.reply(
    `⬇️ در حال دریافت فایل${sizeMb > 20 ? ` (${toFaDigits(sizeMb)} مگابایت)` : ""}…`,
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
          .editMessageText(ctx.chat!.id, statusMsg.message_id, `⬇️ در حال دریافت فایل… ${toFaDigits(p)}٪`)
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
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "❌ دریافت فایل ناموفق بود. دوباره بفرست.");
    return;
  }

  const courses = listCourses(id);
  const kb = new InlineKeyboard();
  for (const c of courses.slice(0, 8)) kb.text(c.name, `pick:${sessionId}:${c.id}`).row();
  kb.text("بدون درس مشخص", `pick:${sessionId}:0`);

  convo.set(id, { kind: "await_mode", sessionId, audioFile, courseId: null, durationSec });
  createSession(sessionId, id, null);
  // شناسهٔ پیام صوتی نگه داشته می‌شود تا نتایج «ریپلای» همان پیام شوند —
  // شرط لازم برای اینکه تلگرام زمان‌های داخل متن را لینک پخش کند.
  updateSession(sessionId, {
    audio_chat_id: ctx.chat!.id,
    audio_message_id: msg.message_id,
    audio_file_id: media.file_id,
    download_route: route,
  });

  await ctx.api.editMessageText(
    ctx.chat!.id,
    statusMsg.message_id,
    courses.length
      ? "✅ فایل رسید. این جلسه مربوط به کدام درس است؟"
      : "✅ فایل رسید.\n\n<i>هنوز درسی ثبت نکرده‌ای. ثبت درس دقت تشخیص اصطلاحات را بالا می‌برد — بعداً با /course انجامش بده.</i>",
    { parse_mode: "HTML", reply_markup: kb },
  );
});

// ─── کلیک‌ها ────────────────────────────────────────────────────────────────

bot.callbackQuery(/^pick:([a-f0-9]+):(\d+)$/, async (ctx) => {
  const [, sessionId, courseIdRaw] = ctx.match!;
  const courseId = Number(courseIdRaw) || null;
  const state = convo.get(ctx.from.id);
  if (!state || state.kind !== "await_mode" || state.sessionId !== sessionId) {
    await ctx.answerCallbackQuery({ text: "این درخواست منقضی شده." });
    return;
  }
  convo.set(ctx.from.id, { ...state, courseId });
  updateSession(sessionId, { course_id: courseId });

  const kb = new InlineKeyboard()
    .text("📕 تحلیل + جزوهٔ کامل", `go:${sessionId}:1`)
    .row()
    .text("⚡ فقط تحلیل (سریع‌تر)", `go:${sessionId}:0`);

  await ctx.editMessageText(
    "چه چیزی می‌خواهی؟\n\n" +
      "📕 <b>تحلیل + جزوه</b> — همه‌چیز، شامل جزوهٔ PDF کامل درس.\n" +
      "⚡ <b>فقط تحلیل</b> — خلاصه، نکات با منبع، پیش‌نیازها و سرفصل‌ها. سریع‌تر است.\n\n" +
      "<i>در هر دو حالت اعتبار به اندازهٔ مدت صوت کم می‌شود؛ جزوه هزینهٔ اضافه ندارد.</i>",
    { parse_mode: "HTML", reply_markup: kb },
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^go:([a-f0-9]+):([01])$/, async (ctx) => {
  const [, sessionId, pdfFlag] = ctx.match!;
  const state = convo.get(ctx.from.id);
  if (!state || state.kind !== "await_mode" || state.sessionId !== sessionId) {
    await ctx.answerCallbackQuery({ text: "این درخواست منقضی شده." });
    return;
  }
  convo.delete(ctx.from.id);
  await ctx.answerCallbackQuery();
  await startJob(ctx, sessionId!, state.audioFile, state.courseId, pdfFlag === "1", state.durationSec);
});

bot.callbackQuery(/^clip:([a-f0-9]+):(\d+)$/, async (ctx) => {
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

bot.callbackQuery(/^pdf:([a-f0-9]+)$/, async (ctx) => {
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

bot.callbackQuery(/^rep:([a-f0-9]+)$/, async (ctx) => {
  const s = getSession(ctx.match![1]!);
  await ctx.answerCallbackQuery();
  const r = s ? sessionReport(s) : null;
  if (!s || !r) {
    await ctx.reply("تحلیل این جلسه موجود نیست.");
    return;
  }
  const course = s.course_id ? getCourse(s.course_id) : null;
  await reply(
    ctx,
    S.overviewMessage({
      report: r,
      courseName: course?.name ?? null,
      sessionDate: s.session_date,
      durationMs: s.original_ms,
      savedMs: Math.max(0, s.original_ms - s.billed_ms),
      qualityWarnings: [],
    }),
  );
});

// ─── اجرای کار ──────────────────────────────────────────────────────────────

async function startJob(
  ctx: Context,
  sessionId: string,
  audioFile: string,
  courseId: number | null,
  makePdf: boolean,
  declaredDurationSec: number,
): Promise<void> {
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

  // اعتبار *پیش* از اجرا کنار گذاشته می‌شود، نه بعدش: وگرنه کاربر می‌تواند
  // چند کار پشت‌سرهم صف کند که مجموعشان از اعتبارش بیشتر است.
  const reservedSec = Math.max(60, declaredDurationSec);
  try {
    reserve(userId, reservedSec, sessionId);
  } catch (e) {
    if (e instanceof InsufficientCredit) {
      await edit(
        `اعتبارت کافی نیست.\n\nاین جلسه <b>${fmtDuration(e.needed * 1000)}</b> لازم دارد ` +
          `ولی <b>${fmtDuration(e.balance * 1000)}</b> داری.\n\n/credit`,
      );
      return;
    }
    throw e;
  }

  enqueue(String(userId), async (signal) => {
    try {
      const course = courseId ? getCourse(courseId) : null;
      const out = await runPipeline({
        sessionId,
        audioFile,
        course,
        sessionDate: new Date().toLocaleDateString("fa-IR"),
        makePdf,
        signal,
        onProgress: (s) => void edit(S.progressMessage(s.stage, s.detail)),
      });

      // تسویه: فقط تفاوت مدت واقعی و مدتی که رزرو شده بود جابه‌جا می‌شود
      const actualSec = Math.round(out.originalDurationMs / 1000);
      commit(userId, reservedSec, actualSec, sessionId);
      registerOwner(sessionId, userId, actualSec);

      await ctx.api.deleteMessage(chatId, progress.message_id).catch(() => {});
      await sendResults(ctx, sessionId, out, course?.name ?? null, makePdf);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error({ sessionId, err: message }, "pipeline failed");
      updateSession(sessionId, { status: "error", error: message.slice(0, 500) });
      refund(userId, reservedSec, sessionId, "کار ناموفق بود");
      await edit(
        `❌ <b>پردازش ناموفق بود</b>\n\n${escapeHtml(message)}\n\n<i>اعتبار رزروشده کامل برگشت.</i>`,
      );
    }
  });
}

type PipelineOut = Awaited<ReturnType<typeof runPipeline>>;

async function sendResults(
  ctx: Context,
  sessionId: string,
  out: PipelineOut,
  courseName: string | null,
  makePdf: boolean,
): Promise<void> {
  const r = out.report;
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
    S.overviewMessage({
      report: r,
      courseName,
      sessionDate: new Date().toLocaleDateString("fa-IR"),
      durationMs: out.originalDurationMs,
      savedMs: out.savedMs,
      qualityWarnings: out.qualityWarnings,
    }),
  );

  const outline = S.outlineMessage(r);
  if (outline) await reply(ctx, outline, asReply);

  const keyPoints = S.keyPointsMessage(r, linkable);
  if (keyPoints) await reply(ctx, keyPoints, asReply);

  const topics = S.topicsMessage(r);
  if (topics) await reply(ctx, topics, asReply);

  const assumed = S.assumedMessage(r);
  if (assumed) await reply(ctx, assumed, asReply);

  if (makePdf && out.pdfPath) {
    await ctx.replyWithDocument(new InputFile(out.pdfPath, out.pdfName ?? "جزوه.pdf"), {
      caption: "📕 جزوهٔ کامل این جلسه",
    });
  } else if (makePdf && out.notesError) {
    // تحلیل سالم است؛ فقط مدلِ جزوه در دسترس نبود
    await reply(
      ctx,
      "⚠️ <b>جزوه ساخته نشد</b> ولی تحلیل بالا کامل است.\n\n" +
        "<i>مدل تولید جزوه در دسترس نبود. با /history می‌توانی بعداً دوباره درخواستش کنی — " +
        "رونویسی کش شده و دوباره هزینه‌ای ندارد.</i>",
    );
  }

  await ctx.replyWithDocument(new InputFile(out.transcriptPath, "رونوشت کامل.txt"), {
    caption: "📄 رونوشت کامل با مهر زمانی",
  });

  const u = getUser(ctx.from!.id);
  const cost = Math.round(out.originalDurationMs / 1000);
  if (u) {
    await ctx.reply(
      `✅ تمام شد. <b>${fmtDuration(cost * 1000)}</b> اعتبار کم شد.\n` +
        `⏱ باقی‌مانده: <b>${fmtDuration(u.credit_sec * 1000)}</b>\n\n` +
        `<b>می‌خواهی هزینه‌اش را با هم‌کلاسی‌ها تقسیم کنی؟</b>\n` +
        `اگر ${toFaDigits(4)} نفر دیگر هم بردارند، سهم هرکس ` +
        `${fmtDuration(fairShare(cost, 5) * 1000)} می‌شود و بقیه‌اش به تو برمی‌گردد.`,
      { parse_mode: "HTML", reply_markup: shareToggleKeyboard(sessionId, false) },
    );
  }
}

// ─── اشتراک‌گذاری ───────────────────────────────────────────────────────────

bot.callbackQuery(/^son:([a-f0-9]+)$/, async (ctx) => {
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

bot.callbackQuery(/^slink:([a-f0-9]+)$/, async (ctx) => {
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
      `تا الان <b>${fmtDuration((st?.ownerRefundedSec ?? 0) * 1000)}</b> پس گرفته‌ای.\n\n` +
      `<i>سقف بازگشت، همان چیزی است که خودت داده‌ای — از این محصول نمی‌شود درآمد ساخت، فقط می‌شود هزینه‌اش را صفر کرد.</i>`,
    { parse_mode: "HTML" },
  );
}

bot.callbackQuery(/^jdo:([a-f0-9]+)$/, async (ctx) => {
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

bot.callbackQuery(/^jno:([a-f0-9]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("باشد، منصرف شدی. هر وقت خواستی دوباره روی لینک بزن.");
});

bot.command("shared", async (ctx) => {
  touchUser(ctx);
  const ids = accessibleSessions(ctx.from!.id, 15);
  if (ids.length === 0) {
    await reply(ctx, "هنوز در هیچ جلسهٔ اشتراکی نیستی.");
    return;
  }
  const lines = ["<b>جلساتی که به آن‌ها دسترسی داری</b>", ""];
  for (const id of ids) {
    const s = getSession(id);
    if (!s) continue;
    const st = shareStatus(id);
    const mine = s.tg_id === ctx.from!.id ? "فرستادهٔ خودت" : "پیوسته‌ای";
    lines.push(
      `• <b>${escapeHtml(s.title ?? "بدون عنوان")}</b> — ${mine}\n` +
        `  ${toFaDigits(st?.memberCount ?? 1)} نفر · سهم هرکس ${fmtDuration((st?.currentShareSec ?? 0) * 1000)}`,
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

bot.catch((err) => {
  logger.error({ err: String(err.error), update: err.ctx.update.update_id }, "bot error");
});

export { TimeMap, sessionTimeMap };
