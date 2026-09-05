/**
 * سرور وب — API و فایل‌های ایستا، کنار ربات و روی همان پایگاه‌داده.
 *
 * با `node:http` نوشته شده و نه با یک فریم‌ورک: کل سطح API چند مسیر است و
 * افزودن وابستگی برای این حجم، هزینه‌ای است بدون فایده. مسیریابی هم به همین
 * دلیل یک `switch` ساده است.
 *
 * چیزی که این سرور **ندارد** و عمدی است: منطق دامنه. هر مسیر یک لایهٔ نازک
 * روی همان توابعی است که ربات صدا می‌زند (`jobs/service`, `billing/*`,
 * `db/*`). قاعده این است که اگر چیزی اینجا نوشته شد که ربات هم لازمش دارد،
 * جایش اینجا نیست.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { shortId } from "../util/text.js";
import {
  createSessionToken, loginFromMiniApp, OtpError, phoneLoginEnabled, purgeExpiredSessions,
  requestOtp, revokeToken, userIdFromToken, verifyOtp,
} from "./auth.js";
import { botLinks } from "../bot/links.js";
import { deliverToBot } from "../bot/deliver.js";
import { archiveAudio, archiveFailure, archiveReport, audioCaption } from "../bot/archive.js";
import { liveMessage, notifyUser } from "../bot/notify.js";
import { progressMessage } from "../bot/strings.js";
import { createTusServer } from "./tus.js";
import type { Server as TusServer } from "@tus/server";
import { probe } from "../audio/ffmpeg.js";
import { getProgress, setProgress } from "./progress.js";
import { startJob } from "../jobs/service.js";
import { InsufficientCredit } from "../billing/ledger.js";
import { balanceCoins, costCoins, fmtCoins, PACKAGES, COINS_PER_MINUTE } from "../billing/coins.js";
import { history } from "../billing/ledger.js";
import {
  createCourse, createSession, getCourse, getSession, getUser, listCourses, listSessions,
  sessionReport, updateSession, isTranscriptOnly,
} from "../db/index.js";
import { identitiesOf } from "../db/identity.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../../public");

/** سقف اندازهٔ آپلود. با مسیر وب، محدودیت ۲۰ مگابایتی تلگرام معنا ندارد. */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

// ─── کمکی‌ها ────────────────────────────────────────────────────────────────

type Res = http.ServerResponse;

function json(res: Res, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

/**
 * رد کردن یک آپلود **بی‌آنکه کلاینت سرِ کار بماند.**
 *
 * ## باگی که این تابع رفع می‌کند
 *
 * وقتی سرور وسط یک آپلودِ در جریان پاسخ می‌داد و بدنه را نمی‌خواند، مرورگر
 * همچنان در حال فرستادن بود: بافر دریافتِ سوکت پر می‌شد، `TCP` پنجره را
 * می‌بست، و `xhr.upload.onprogress` **از حرکت می‌ایستاد**. کاربر یک نوار
 * درصد می‌دید که روی مثلاً ۳۸٪ خشک می‌شد و بعد از مدتی «اتصال قطع شد»
 * می‌گرفت — در حالی که سرور از همان اول جواب داده بود و مشکل شبکه نبود.
 *
 * روی اینترنت پرسرعت دیده نمی‌شد چون کل فایل پیش از پاسخ در بافرها جا
 * می‌شد؛ روی موبایل ایران با فایل ۵۰ مگابایتی، همیشه اتفاق می‌افتاد.
 *
 * پس بدنه **مصرف** می‌شود و بعد پاسخ می‌رود. بایت‌ها دور ریخته می‌شوند، ولی
 * کلاینت آپلودش را تمام می‌کند و خطای درست را می‌بیند. برای فایل بزرگ این
 * یعنی انتقالِ بی‌فایده، پس صدازننده باید **پیش از** شروع آپلود جلوی این
 * حالت را بگیرد (`POST /api/sessions/precheck`) و این تابع تور ایمنی است.
 */
function refuse(req: http.IncomingMessage, res: Res, status: number, body: unknown): void {
  // اگر بدنه‌ای در راه نیست، همان‌جا جواب بده.
  if (req.readableEnded || req.method === "GET" || req.method === "HEAD") {
    return json(res, status, body);
  }
  const done = () => json(res, status, body);
  req.on("end", done);
  req.on("error", done);
  req.resume(); // بایت‌ها را بخوان و دور بریز
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const buf = await readBody(req);
  return JSON.parse(buf.toString("utf8") || "{}") as T;
}

/**
 * کاربر از روی هدر `Authorization`.
 *
 * توکن در هدر می‌آید نه در کوکی، چون مینی‌اپ داخل iframe اجرا می‌شود و کوکیِ
 * شخص‌ثالث در مرورگرهای امروز بلوکه می‌شود. کلاینت توکن را در
 * `localStorage` نگه می‌دارد و خودش می‌فرستد.
 */
function authUser(req: http.IncomingMessage): number | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return userIdFromToken(h.slice(7).trim());
}

function requireUser(req: http.IncomingMessage, res: Res): number | null {
  const id = authUser(req);
  if (id === null) {
    // `refuse` و نه `json`: اگر توکن نشستِ کاربری وسط یک آپلود منقضی شود،
    // پاسخِ بی‌مصرف‌کردنِ بدنه، آپلود را روی همان درصد خشک می‌کند.
    refuse(req, res, 401, { error: "وارد نشده‌ای." });
    return null;
  }
  return id;
}

// ─── نمای بیرونی داده‌ها ────────────────────────────────────────────────────
//
// سطرهای پایگاه‌داده مستقیماً بیرون داده نمی‌شوند: مسیر فایل روی دیسک،
// هزینهٔ دلاری، و شناسهٔ پیام‌های بایگانی هیچ‌کدام به کلاینت مربوط نیستند.

function publicSession(s: ReturnType<typeof getSession>) {
  if (!s) return null;
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    date: s.session_date,
    createdAt: s.created_at,
    durationMs: s.original_ms,
    courseId: s.course_id,
    mode: s.mode,
    transcriptOnly: isTranscriptOnly(s.mode),
    hasPdf: Boolean(s.pdf_path),
    hasReport: Boolean(s.report_json),
    shareEnabled: Boolean(s.share_enabled),
    error: s.error,
  };
}

// ─── مسیرها ─────────────────────────────────────────────────────────────────

async function handleApi(req: http.IncomingMessage, res: Res, url: URL): Promise<void> {
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    // ── ورود ────────────────────────────────────────────────────────────────

    /** ورود از مینی‌اپ: initData را می‌گیرد، توکن نشست می‌دهد. */
    case "POST /api/auth/miniapp": {
      const { platform, initData } = await readJson<{ platform?: string; initData?: string }>(req);
      if (platform !== "telegram" && platform !== "bale") {
        return json(res, 400, { error: "سکو نامعتبر است." });
      }
      const user = loginFromMiniApp(platform, initData ?? "");
      if (!user) return json(res, 401, { error: "احراز هویت مینی‌اپ ناموفق بود." });
      return json(res, 200, {
        token: createSessionToken(user.tg_id, platform),
        user: { name: user.name, coins: balanceCoins(user.credit_sec) },
        /**
         * سکویی که امضایش **واقعاً** پذیرفته شد.
         *
         * کلاینت خودش نمی‌داند: وقتی `initData` از قطعهٔ آدرس خوانده می‌شود
         * (تنها راه در بله، چون SDK ندارد) `platform` سمت اپ `null` می‌ماند و
         * هر دو توکن امتحان می‌شوند. بدون این پاسخ، اپ نمی‌دانست کاربر از
         * کجا آمده و دکمهٔ «برگرد به ربات» کاربر بله را به **تلگرام** می‌برد.
         */
        platform,
      });
    }

    case "POST /api/auth/otp/request": {
      const { phone } = await readJson<{ phone?: string }>(req);
      try {
        const out = await requestOtp(phone ?? "");
        return json(res, 200, out);
      } catch (e) {
        if (e instanceof OtpError) return json(res, 400, { error: e.message, code: e.code });
        throw e;
      }
    }

    case "POST /api/auth/otp/verify": {
      const { phone, code } = await readJson<{ phone?: string; code?: string }>(req);
      try {
        const user = verifyOtp(phone ?? "", code ?? "");
        return json(res, 200, {
          token: createSessionToken(user.tg_id, "web"),
          user: { name: user.name, coins: balanceCoins(user.credit_sec) },
        });
      } catch (e) {
        if (e instanceof OtpError) return json(res, 400, { error: e.message, code: e.code });
        throw e;
      }
    }

    case "POST /api/auth/logout": {
      const h = req.headers.authorization;
      if (h?.startsWith("Bearer ")) revokeToken(h.slice(7).trim());
      return json(res, 200, { ok: true });
    }

    // ── حساب کاربری ─────────────────────────────────────────────────────────

    case "GET /api/me": {
      const uid = requireUser(req, res);
      if (uid === null) return;
      const u = getUser(uid)!;
      return json(res, 200, {
        name: u.name,
        username: u.username,
        coins: balanceCoins(u.credit_sec),
        creditSec: u.credit_sec,
        totalUsedSec: u.total_used_sec,
        coinsPerMinute: COINS_PER_MINUTE,
        platforms: identitiesOf(uid).map((i) => i.platform),
      });
    }

    case "GET /api/ledger": {
      const uid = requireUser(req, res);
      if (uid === null) return;
      return json(res, 200, {
        entries: history(uid, 30).map((r) => ({
          delta: r.delta_sec,
          deltaCoins: balanceCoins(Math.abs(r.delta_sec)) * Math.sign(r.delta_sec),
          reason: r.reason,
          sessionId: r.session_id,
          note: r.note,
          at: r.created_at,
        })),
      });
    }

    case "GET /api/packages":
      return json(res, 200, { packages: PACKAGES, coinsPerMinute: COINS_PER_MINUTE });

    /**
     * چه چیزهایی در این نصب روشن است.
     *
     * کلاینت نباید فرمی را نشان دهد که سرور جوابش را رد می‌کند: کاربری که
     * شماره‌اش را وارد می‌کند و «فعال نیست» می‌گیرد، فکر می‌کند خراب است.
     * پیش از هر چیز این خوانده می‌شود و فرم شماره فقط وقتی ساخته می‌شود که
     * واقعاً کار کند.
     */
    case "GET /api/config":
      return json(res, 200, {
        phoneLogin: phoneLoginEnabled(),
        coinsPerMinute: COINS_PER_MINUTE,
        // هدیهٔ شروع از پیکربندی می‌آید، نه از متنِ سفت‌شده در HTML. یک بار
        // صفحه «۱۰۰ سکه» تبلیغ می‌کرد در حالی که مقدار واقعی ۲۰ شده بود —
        // یعنی کاربر با وعده‌ای می‌آمد که ربات زیرش نمی‌زد.
        trialCoins: config.FREE_TRIAL_COINS,
        // آدرس‌ها از خودِ `getMe` می‌آیند نه از HTML سفت‌شده یا متغیر محیطی:
        // هر دو با عوض‌شدن توکن ربات بی‌صدا کهنه می‌شوند و کاربر را به چت
        // اشتباه می‌برند.
        bots: botLinks(),
      });

    // ── درس‌ها ──────────────────────────────────────────────────────────────

    case "GET /api/courses": {
      const uid = requireUser(req, res);
      if (uid === null) return;
      return json(res, 200, {
        courses: listCourses(uid).map((c) => ({
          id: c.id,
          name: c.name,
          professor: c.professor,
        })),
      });
    }

    case "POST /api/courses": {
      const uid = requireUser(req, res);
      if (uid === null) return;
      const { name, professor } = await readJson<{ name?: string; professor?: string }>(req);
      const clean = (name ?? "").trim();
      if (!clean) return json(res, 400, { error: "اسم درس لازم است." });
      const c = createCourse(uid, clean.slice(0, 80), (professor ?? "").trim().slice(0, 80) || null);
      return json(res, 200, { course: { id: c.id, name: c.name, professor: c.professor } });
    }

    // ── جلسه‌ها ─────────────────────────────────────────────────────────────

    case "GET /api/sessions": {
      const uid = requireUser(req, res);
      if (uid === null) return;
      return json(res, 200, { sessions: listSessions(uid, 50).map(publicSession) });
    }

    /**
     * پیش از فرستادن بایت‌ها بپرس: این فایل اصلاً قابل قبول است؟
     *
     * بدون این، تنها راهِ فهمیدنِ «اعتبارت کم است» فرستادن کل فایل بود — و
     * چون سرور وسط راه پاسخ می‌داد، آپلود روی همان درصد خشک می‌شد. حالا
     * کاربر پیش از مصرف یک بایت از اینترنت موبایلش جواب می‌گیرد.
     */
    case "POST /api/sessions/precheck": {
      const uid = requireUser(req, res);
      if (uid === null) return;
      const { durationSec = 0, sizeBytes = 0 } = await readJson<{
        durationSec?: number;
        sizeBytes?: number;
      }>(req);
      const u = getUser(uid)!;
      const sec = Math.max(0, Math.round(durationSec));

      if (sizeBytes > MAX_UPLOAD_BYTES) {
        return json(res, 413, {
          error: `فایل خیلی بزرگ است. سقف ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} مگابایت است.`,
        });
      }
      if (sec > 0 && u.credit_sec < sec) {
        return json(res, 402, {
          error: "اعتبارت کم است.",
          needCoins: costCoins(sec),
          haveCoins: balanceCoins(u.credit_sec),
        });
      }
      return json(res, 200, {
        ok: true,
        costCoins: sec > 0 ? costCoins(sec) : null,
        haveCoins: balanceCoins(u.credit_sec),
      });
    }

    case "POST /api/sessions/upload": {
      const uid = requireUser(req, res);
      if (uid === null) return;
      return uploadAudio(req, res, uid, url);
    }

    /**
     * آپلود تکه‌تکه — برای وب‌ویویی که یک اتصال طولانی را نگه نمی‌دارد.
     *
     * **چرا لازم شد:** لاگ nginx نشان داد وب‌ویوی اندرویدِ بله آپلود را وسط
     * راه **خودش** می‌بُرد؛ هشت بار پشت سر هم، هربار در نقطه‌ای متفاوت
     * (۰٫۹ و ۱۶ و ۲۳ و ۲۵ و ۳۴ مگابایت از ۵۰). نه سقف بود نه مهلت: آزمون با
     * نرخ ۲۰۰ کیلوبیت در ثانیه همان ۵۰ مگابایت را در ۲۵۶ ثانیه از همان CDN
     * سالم رساند. یعنی مسیر سالم است و فقط وب‌ویو اتصال طولانی را نمی‌کشد.
     *
     * تلاش دوبارهٔ قبلی از **صفر** شروع می‌کرد، پس روی اتصالی که سرِ ۲۰
     * مگابایت می‌مُرد، سه تلاش فقط سه بار همان ۲۰ مگابایت را می‌سوزاند و
     * کاربر آخرش هیچ. اینجا هر تکه جدا می‌رود و آنچه رسیده می‌ماند.
     *
     * `offset` صریح گرفته می‌شود تا تکهٔ تکراری دوباره نوشته نشود و ترتیب
     * هم تضمین شود؛ کلاینت می‌تواند با `GET` بپرسد تا کجا رسیده و از همان‌جا
     * ادامه دهد.
     */
    case "POST /api/uploads/chunk": {
      const uid = requireUser(req, res);
      if (uid === null) return;
      return uploadChunk(req, res, uid, url);
    }
  }

  if (url.pathname === "/api/uploads/status" && req.method === "GET") {
    const uid = requireUser(req, res);
    if (uid === null) return;
    const id = (url.searchParams.get("id") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!id) return json(res, 400, { error: "شناسهٔ آپلود نامعتبر است." });
    /**
     * **اندازهٔ فایل جواب نیست، طولِ پیوسته است.**
     *
     * با نوشتنِ موازی فایل می‌تواند سوراخ داشته باشد: تکه‌ای که در بایت ۸
     * مگابایت نشسته فایل را ۸ مگابایتی می‌کند حتی اگر میانه‌اش نرسیده باشد.
     * برگرداندنِ آن عدد یعنی کلاینت از جای اشتباه ادامه دهد و فایلِ سوراخ
     * تحویل شود.
     */
    const prog = uploads.get(uploadKey(uid, id));
    return json(res, 200, { received: prog ? contiguous(prog) : 0 });
  }

  // مسیرهای پارامتردار
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/);

  // تأیید شروعِ کار — تنها جایی که سکه کم می‌شود.
  if (sessionMatch && req.method === "POST" && sessionMatch[2] === "/confirm") {
    const uid = requireUser(req, res);
    if (uid === null) return;
    return confirmSession(res, uid, sessionMatch[1]!);
  }

  if (sessionMatch && req.method === "GET") {
    const uid = requireUser(req, res);
    if (uid === null) return;
    const s = getSession(sessionMatch[1]!);
    // «پیدا نشد» برای جلسهٔ دیگران هم برگردانده می‌شود، نه «اجازه نداری»:
    // پاسخ دوم تأیید می‌کند که چنین شناسه‌ای وجود دارد.
    if (!s || s.tg_id !== uid) return json(res, 404, { error: "جلسه پیدا نشد." });

    switch (sessionMatch[2]) {
      case undefined:
        return json(res, 200, {
          session: publicSession(s),
          report: sessionReport(s),
          notes: s.notes_md,
        });
      case "/progress":
        return json(res, 200, {
          progress: getProgress(s.id) ?? { stage: s.status, updatedAt: Date.now() },
          status: s.status,
        });
      case "/transcript":
        if (!s.transcript_txt) return json(res, 404, { error: "رونوشتی نیست." });
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("رونوشت.txt")}`,
        });
        return void res.end(s.transcript_txt);
      case "/pdf": {
        if (!s.pdf_path || !fs.existsSync(s.pdf_path)) {
          return json(res, 404, { error: "جزوه‌ای نیست." });
        }
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
            `${s.title ?? "جزوه"}.pdf`,
          )}`,
        });
        return void fs.createReadStream(s.pdf_path).pipe(res);
      }
    }
  }

  json(res, 404, { error: "مسیر پیدا نشد." });
}

/**
 * آپلود صوت.
 *
 * بدنه **خام** خوانده می‌شود نه `multipart/form-data`: پارس‌کردن مالتی‌پارت
 * برای فایل نیم‌گیگابایتی یا کتابخانه می‌خواهد یا کد ظریفِ بافرمحور، در حالی
 * که کلاینت به‌سادگی می‌تواند خودِ فایل را در بدنه بفرستد و نامش را در هدر.
 * نتیجه‌اش هم جریانی است: فایل مستقیم روی دیسک می‌رود و هرگز کامل در حافظه
 * نمی‌نشیند.
 */
/**
 * مسیر فایلِ نیمه‌کارهٔ یک آپلود تکه‌تکه.
 *
 * `userId` در نام هست تا آپلودِ نیمه‌کارهٔ یک کاربر با شناسه‌ای حدس‌زده به
 * دست کاربر دیگری ادامه پیدا نکند یا خوانده نشود.
 */
function partPath(userId: number, uploadId: string): string {
  return path.join(config.workDir, `up-${userId}-${uploadId}.part`);
}

/**
 * پیشرفتِ یک آپلودِ **موازی**، در حافظه.
 *
 * **چرا دیگر `stat().size` کافی نیست:** تا وقتی تکه‌ها ترتیبی می‌آمدند و به
 * انتهای فایل چسبانده می‌شدند، اندازهٔ فایل دقیقاً یعنی «چقدر رسیده». با
 * نوشتنِ موازی این حرف **غلط** می‌شود: تکه‌ای که در بایت ۸ مگابایت می‌نشیند
 * فایل را ۸ مگابایتی می‌کند حتی اگر مگابایت‌های ۲ تا ۸ هنوز نرسیده باشند —
 * یعنی فایل سوراخ دارد ولی اندازه‌اش می‌گوید کامل است. اگر کلاینت به آن عدد
 * تکیه کند، از جای اشتباه ادامه می‌دهد و فایل خراب تحویل می‌شود.
 *
 * پس بازه‌های رسیده صریح نگه داشته می‌شوند و «چقدر رسیده» یعنی **طولِ
 * پیوستهٔ از صفر**، نه اندازهٔ فایل.
 */
type UploadProgress = {
  /** بازه‌های `[start, end)` که واقعاً نوشته شده‌اند، مرتب و ادغام‌شده. */
  spans: Array<[number, number]>;
  /** آخرین دست‌درازی، برای جاروی آپلودهای رهاشده. */
  touched: number;
  /** آفستِ پایانِ تکهٔ پایانی — یعنی اندازهٔ واقعی فایل، وقتی رسیده باشد. */
  finalAt: number | null;
  /**
   * اندازهٔ کلِ فایل، آن‌طور که کلاینت روی **هر** درخواست اعلام می‌کند.
   *
   * **چرا جدا از `finalAt`:** تکیه‌کردن فقط به تکهٔ `final=1` یک بن‌بست
   * می‌ساخت — اگر همان یک درخواست وسط راه می‌مُرد، بایت‌هایش نوشته و ثبت
   * می‌شد ولی پرچمش هرگز نمی‌رسید، و از آن به بعد سرور تا ابد فکر می‌کرد
   * فایل ناتمام است؛ حتی وقتی همهٔ بایت‌ها رسیده بودند. کاربر پیام
   * «آپلود کامل شد ولی پاسخی نگرفتیم» می‌گرفت و ۵۰ مگابایتِ کاملْ بی‌مصرف
   * روی دیسک می‌ماند.
   *
   * `total` روی هر تکه می‌آید، پس گم‌شدنِ یک درخواست دیگر کارِ کل آپلود را
   * خراب نمی‌کند.
   */
  total: number;
};

const uploads = new Map<string, UploadProgress>();

/** کلید در حافظه، هم‌شکل با نام فایل تا دو کاربر قاطی نشوند. */
function uploadKey(userId: number, uploadId: string): string {
  return `${userId}:${uploadId}`;
}

/**
 * بازهٔ تازه را اضافه کن و هر چه هم‌پوشان است را در هم ادغام کن.
 *
 * ادغام لازم است چون تلاش دوباره می‌تواند بازه‌ای را بفرستد که با آنچه هست
 * هم‌پوشانی دارد؛ بدون ادغام، فهرست بی‌جهت بلند می‌شود و «طولِ پیوسته» هم
 * غلط درمی‌آید.
 */
function addSpan(p: UploadProgress, start: number, end: number): void {
  if (end <= start) return;
  p.spans.push([start, end]);
  p.spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const s of p.spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  p.spans = merged;
}

/**
 * چند بایت **پیوسته از صفر** رسیده است.
 *
 * این همان عددی است که کلاینت باید از آن ادامه دهد. با تکه‌های موازی، فایل
 * می‌تواند جلوتر از این عدد هم داده داشته باشد — ولی آن داده تا وقتی سوراخِ
 * پیش از خود پر نشده قابل اتکا نیست.
 */
function contiguous(p: UploadProgress): number {
  return p.spans.length > 0 && p.spans[0]![0] === 0 ? p.spans[0]![1] : 0;
}

/**
 * آپلودهای رهاشده را جارو کن.
 *
 * بدون این، هر آپلودِ نیمه‌کاره که کاربر رهایش کرد یک ورودی در حافظه و یک
 * فایل روی دیسک می‌ماند تا ابد. یک ساعت سخاوتمندانه است: کاربری که وسط
 * آپلود اینترنتش قطع شود و ده دقیقه بعد برگردد، باید بتواند ادامه دهد.
 */
const UPLOAD_TTL_MS = 60 * 60 * 1000;

async function sweepUploads(): Promise<void> {
  const now = Date.now();
  for (const [key, p] of uploads) {
    if (now - p.touched < UPLOAD_TTL_MS) continue;
    uploads.delete(key);
    const [uid, id] = key.split(":");
    await fsp.unlink(partPath(Number(uid), id!)).catch(() => {});
  }
}

/**
 * یک تکه از آپلود را در **جای خودش** می‌نویسد.
 *
 * **چرا موقعیتی و نه چسباندن به انتها:** کلاینت حالا چند تکه را هم‌زمان
 * می‌فرستد، تا وقتی یکی منتظر پاسخ است بقیه بایت بفرستند و اتصال بیکار
 * نماند. با `flags: "a"` این ممکن نبود — دو نوشتنِ هم‌زمان در هم می‌رفتند و
 * فایل خراب می‌شد. حالا هر تکه با `position` صریح می‌نشیند، پس ترتیبِ رسیدن
 * بی‌اهمیت است.
 *
 * پارامترها در آدرس‌اند: `id` (شناسهٔ آپلود)، `offset` (این تکه از کجای فایل
 * است)، `total` (اندازهٔ کل فایل) و در تکهٔ پایانی `final=1` به‌همراه همان
 * `duration`/`ext`/`courseId` که مسیر یک‌تکه می‌گیرد.
 */
async function uploadChunk(
  req: http.IncomingMessage,
  res: Res,
  userId: number,
  url: URL,
): Promise<void> {
  const id = (url.searchParams.get("id") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (!id) return json(res, 400, { error: "شناسهٔ آپلود نامعتبر است." });

  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const total = Math.max(0, Number(url.searchParams.get("total") ?? 0));
  const isFinal = url.searchParams.get("final") === "1";
  const len = Number(req.headers["content-length"] ?? 0);

  /**
   * سقف **پیش از نوشتن** سنجیده می‌شود، نه حین آن.
   *
   * با تکه‌های موازی، «مجموع تا حالا» دیگر از اندازهٔ فایل درنمی‌آید، و
   * فهمیدنِ عبور از سقف وسط نوشتن یعنی نیم‌گیگابایت را نوشته‌ایم و بعد
   * می‌فهمیم. `offset + len` همان چیزی است که این تکه ادعا می‌کند.
   */
  if (offset + len > MAX_UPLOAD_BYTES || total > MAX_UPLOAD_BYTES) {
    return json(res, 413, { error: "فایل خیلی بزرگ است." });
  }

  const key = uploadKey(userId, id);
  const part = partPath(userId, id);
  await fsp.mkdir(config.workDir, { recursive: true });

  let prog = uploads.get(key);
  if (!prog) {
    prog = { spans: [], touched: Date.now(), finalAt: null, total: 0 };
    /**
     * **`set` پیش از هر `await` — و این یک باگِ خرابیِ داده بود.**
     *
     * پیش‌تر `set` بعد از `await fsp.stat` می‌آمد. سه تکهٔ موازی که تقریباً
     * هم‌زمان می‌رسند، هر سه `get` را خالی می‌بینند، هر کدام یک `prog`ِ جدا
     * می‌سازد، منتظرِ `stat` می‌ماند، و آخری `set` را برنده می‌شود — ولی هر
     * درخواست بازه‌اش را روی `prog`ِ **خودش** می‌نویسد. هیچ نقشه‌ای همهٔ
     * بازه‌ها را ندارد، پس `contiguous` هرگز به کل نمی‌رسد و کار هرگز بسته
     * نمی‌شود. لاگِ CDN لو دادش: هر تکه ۲۰۰ می‌گرفت ولی `offset=0` و
     * `offset=1MB` هیچ‌کدام آن‌یکی را نمی‌دیدند.
     *
     * حالا `set` هم‌زمان با ساخت انجام می‌شود، پیش از هر `await`. پس تکه‌های
     * بعدی همین `prog`ِ مشترک را می‌گیرند و بازه‌ها روی هم جمع می‌شوند.
     */
    uploads.set(key, prog);

    /**
     * **بازیابیِ ری‌استارت، فقط وقتی هیچ‌کس دیگری در کار نیست.**
     *
     * نقشه در حافظه است، پس خاموشی وسط آپلود آن را می‌برد در حالی که `.part`
     * می‌ماند؛ این بازیابی آن بایت‌ها را برمی‌گرداند تا کلاینت از اول نفرستد.
     * ولی حالا که `set` زودتر است، تکهٔ موازیِ دیگری می‌تواند حین همین
     * `await stat` بازه‌اش را اضافه کند — و اندازهٔ فایل روی دیسک با نوشتنِ
     * موازی سوراخ دارد. پس فقط وقتی `[0, onDisk)` را ادعا می‌کنیم که نقشه
     * هنوز **دست‌نخورده** است؛ اگر کسی چیزی نوشته، دیگر این یک ری‌استارت
     * نیست و اندازهٔ سوراخ‌دار را نباید باور کرد.
     */
    const onDisk = await fsp.stat(part).then((s) => s.size).catch(() => 0);
    if (onDisk > 0 && prog.spans.length === 0) {
      addSpan(prog, 0, onDisk);
      logger.info({ uploadId: id, bytes: onDisk }, "آپلود نیمه‌کاره از دیسک بازیابی شد");
    }
  }
  prog.touched = Date.now();
  // بزرگ‌ترین مقدارِ اعلام‌شده برنده است تا یک درخواستِ ناقص یا دست‌کاری‌شده
  // نتواند اندازه را کوچک جا بزند و آپلود را زودتر از موعد «کامل» کند.
  if (total > prog.total) prog.total = total;

  /**
   * تکه‌ای که قبلاً کامل نشسته: پذیرفته‌شده اعلامش کن، دوباره ننویس.
   *
   * برخلاف نسخهٔ ترتیبی، اینجا شکاف **خطا نیست**. تکهٔ جلوتر ممکن است پیش
   * از تکهٔ عقب‌تر برسد و این عین انتظار است؛ ۴۰۹ دادن به آن یعنی جنگیدن با
   * همان موازی‌کاری که می‌خواهیم.
   */
  const already = len > 0 && prog.spans.some(([s, e]) => s <= offset && offset + len <= e);
  if (already) {
    req.resume(); // بدنه را مصرف کن وگرنه اتصال معلق می‌ماند
    /**
     * **تکراری یعنی «ننویس»، نه «کاری نکن».**
     *
     * این شاخه پیش‌تر همین‌جا تمام می‌شد و همان بن‌بستی بود که کاربر را به
     * «آپلود کامل شد ولی پاسخی نگرفتیم» می‌رساند: وقتی تکهٔ پایانی یک بار
     * می‌رفت و پاسخش گم می‌شد، کلاینت همان تکه را دوباره می‌فرستاد، سرور
     * «تکراری» می‌گفت و **هرگز** کار را نمی‌بست — با اینکه همهٔ بایت‌ها روی
     * دیسک بود.
     *
     * پس پرچمِ پایان اینجا هم به‌رسمیت شناخته می‌شود و همان بررسیِ کامل‌بودن
     * اجرا می‌شود که مسیر عادی دارد.
     */
    if (isFinal) prog.finalAt = offset + len;
    return completeIfWhole(res, { prog, key, userId, url, part, duplicate: true });
  }

  let written = 0;
  let fh: fsp.FileHandle | null = null;
  try {
    /**
     * **`r+` و نه `a+` — و این تفاوت، یک باگِ خرابیِ داده بود.**
     *
     * در حالت append هستهٔ سیستم آرگومانِ `position` را **نادیده می‌گیرد**:
     * هر نوشتن به انتهای فایل می‌رود، هرچه به آن بگویی. با تکه‌های ترتیبی
     * این هرگز دیده نمی‌شد چون انتهای فایل تصادفاً همان جای درست بود؛ با
     * تکه‌های موازی، سه نوشتنِ هم‌زمان پشت سر هم می‌چسبیدند و مرزها به هم
     * می‌ریخت.
     *
     * چطور پیدا شد: آزمونِ زندهٔ سه‌کارگرِ موازی فایلی به اندازهٔ **درست** و
     * با محتوای **غلط** ساخت — اولین اختلاف در بایت ۲۵۸۱۹۷، یعنی نزدیک
     * انتهای تکهٔ اول. اندازهٔ درست همان چیزی بود که خطا را پنهان می‌کرد.
     *
     * `r+` موقعیت را محترم می‌شمارد ولی فایلِ نبوده را نمی‌سازد، پس ساختن
     * جدا و **یک‌بار** انجام می‌شود.
     */
    fh = await fsp.open(part, "r+").catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // `wx` یعنی «بساز، و اگر هست شکست بخور» — پس مسابقهٔ دو تکهٔ هم‌زمان
      // فایل را دوبار خالی نمی‌کند. بازندهٔ مسابقه دوباره `r+` می‌زند.
      return fsp
        .open(part, "wx")
        .catch(() => fsp.open(part, "r+"));
    });
    const handle = fh;
    await new Promise<void>((resolve, reject) => {
      let pos = offset;
      let pending = 0;
      let ended = false;
      let failed = false;
      const settle = () => {
        if (ended && pending === 0 && !failed) resolve();
      };
      req.on("data", (c: Buffer) => {
        if (failed) return;
        if (len > 0 && written + c.length > len) {
          // بدنه از آنچه هدر اعلام کرده بزرگ‌تر است — به آن اعتماد نکن.
          failed = true;
          reject(new Error("اندازهٔ تکه با هدر نمی‌خواند."));
          req.destroy();
          return;
        }
        const at = pos;
        pos += c.length;
        written += c.length;
        pending++;
        req.pause();
        handle.write(c, 0, c.length, at).then(
          () => {
            pending--;
            req.resume();
            settle();
          },
          (err) => {
            pending--;
            failed = true;
            reject(err);
          },
        );
      });
      req.on("end", () => {
        ended = true;
        settle();
      });
      // قطع‌شدن وسط یک تکه فاجعه نیست: آنچه نوشته شده می‌ماند و کلاینت از
      // همان‌جا ادامه می‌دهد. فقط لاگ می‌شود تا الگویش دیده شود.
      req.on("error", (err: Error) => {
        failed = true;
        logger.warn({ uploadId: id, written, err: err.message }, "تکهٔ آپلود قطع شد");
        reject(new Error("ارتباط وسط تکه قطع شد."));
      });
      req.on("aborted", () => {
        failed = true;
        logger.warn({ uploadId: id, written }, "کلاینت تکه را رها کرد");
        reject(new Error("ارتباط وسط تکه قطع شد."));
      });
    });
  } catch (e) {
    /**
     * **آنچه واقعاً نوشته شد ثبت می‌شود، نه آنچه قرار بود.**
     *
     * تکه‌ای که وسط راه مُرد، بخشی از خودش را روی دیسک گذاشته. ثبت‌نکردنش
     * یعنی دوباره فرستادنِ همان بایت‌ها؛ ثبتِ کاملش یعنی سوراخِ نادیده. پس
     * دقیقاً همان مقداری که رسید ثبت می‌شود — نه بیشتر، نه کمتر.
     */
    if (written > 0) addSpan(prog, offset, offset + written);
    await fh?.close().catch(() => {});
    return json(res, 400, {
      received: contiguous(prog),
      error: e instanceof Error ? e.message : "تکه نرسید.",
    });
  }
  await fh?.close().catch(() => {});

  addSpan(prog, offset, offset + written);
  if (isFinal) prog.finalAt = offset + written;

  return completeIfWhole(res, { prog, key, userId, url, part, duplicate: false });
}

/**
 * اگر همهٔ بایت‌ها رسیده‌اند کار را ببند، وگرنه فقط بگو تا کجا رسیده.
 *
 * **چرا مشترک بین مسیر عادی و مسیر تکراری:** هر درخواستی که تمام می‌شود —
 * چه بایت تازه‌ای نوشته باشد چه نه — باید بتواند آخرین سوراخ را «ببیند» و
 * کار را ببندد. وقتی این بررسی فقط در مسیر عادی بود، تکهٔ پایانیِ تکراری
 * (یعنی همان چیزی که کلاینت موقع گم‌شدنِ پاسخ دوباره می‌فرستد) به بن‌بست
 * می‌خورد.
 */
async function completeIfWhole(
  res: Res,
  o: {
    prog: UploadProgress;
    key: string;
    userId: number;
    url: URL;
    part: string;
    duplicate: boolean;
  },
): Promise<void> {
  const { prog, key, userId, url, part, duplicate } = o;

  /**
   * **پایان یعنی پرشدنِ همهٔ سوراخ‌ها، نه رسیدنِ تکهٔ آخر.**
   *
   * با آپلود موازی، تکهٔ پایانی می‌تواند پیش از تکه‌های میانی برسد. اگر
   * همان‌جا فایل را ببندیم و به ffprobe بدهیم، فایلی با سوراخ تحویل داده‌ایم
   * که یا خطای مبهم می‌دهد یا — بدتر — صوتی ناقص را کامل جا می‌زند.
   *
   * `finalAt` مقدمِ `total` است چون دقیق‌تر است (بایتِ واقعیِ پایان)، ولی
   * نبودنش دیگر بن‌بست نیست: `total` روی هر درخواست می‌آید، پس گم‌شدنِ
   * تکهٔ `final=1` کل آپلود را زمین‌گیر نمی‌کند.
   */
  const size = prog.finalAt ?? (prog.total > 0 ? prog.total : null);
  if (size === null || contiguous(prog) < size) {
    return json(res, 200, {
      received: contiguous(prog),
      ...(duplicate ? { duplicate: true } : {}),
    });
  }

  /**
   * بستنِ کار **یک‌بار** اتفاق می‌افتد.
   *
   * چند تکهٔ موازی می‌توانند تقریباً هم‌زمان تمام شوند و هر کدام ببینند که
   * فایل کامل است. بدون این قفل، دو تای‌شان `rename` می‌زنند و دومی روی
   * فایلی کار می‌کند که دیگر آنجا نیست — یا بدتر، دو جلسه برای یک آپلود
   * ساخته می‌شود و کاربر دوبار حساب می‌شود.
   *
   * `Map.delete` اینجا نقشِ قفل را دارد چون جاوااسکریپت تک‌رشته‌ای است و
   * بین خواندن و حذف هیچ `await`ای نیست: فقط یکی `true` می‌گیرد.
   */
  if (!uploads.delete(key)) {
    return json(res, 200, { received: contiguous(prog) });
  }

  /**
   * فایل دقیقاً به اندازهٔ اعلام‌شده بریده می‌شود.
   *
   * تلاش دوبارهٔ یک تکه می‌تواند دم فایل را از اندازهٔ واقعی بلندتر کند
   * (نوشتنِ موقعیتی فایل را کِش می‌آورد). دنبالهٔ اضافه یعنی چند بایت
   * بی‌معنا ته صوت، که ffprobe را گیج می‌کند.
   */
  await fsp.truncate(part, size).catch(() => {});

  // نامِ نهایی و ساختِ جلسه داخلِ `finishUpload`؛ اینجا فقط فایلِ کامل را می‌دهیم.
  return finishUpload(res, {
    userId,
    dest: part,
    ext: (url.searchParams.get("ext") ?? "ogg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "ogg",
    declaredSec: Math.max(0, Number(url.searchParams.get("duration") ?? 0)),
    courseId: Number(url.searchParams.get("courseId") ?? 0) || null,
  });
}

async function uploadAudio(
  req: http.IncomingMessage,
  res: Res,
  userId: number,
  url: URL,
): Promise<void> {
  const u = getUser(userId)!;
  const declaredSec = Math.max(0, Number(url.searchParams.get("duration") ?? 0));
  const courseId = Number(url.searchParams.get("courseId") ?? 0) || null;

  if (declaredSec > 0 && u.credit_sec < declaredSec) {
    return refuse(req, res, 402, {
      error: "اعتبارت کم است.",
      needCoins: costCoins(declaredSec),
      haveCoins: balanceCoins(u.credit_sec),
    });
  }

  const sessionId = shortId();
  const ext = (url.searchParams.get("ext") ?? "ogg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "ogg";
  const dest = path.join(config.audioDir, `${sessionId}.${ext}`);
  await fsp.mkdir(config.audioDir, { recursive: true });

  /**
   * چند بایت **واقعاً** انتظار داریم.
   *
   * برای تشخیص «قطع‌شدن وسط راه» لازم است: بدون آن، یک آپلودِ نصفه‌کاره
   * فایلی سالم‌به‌نظر روی دیسک می‌گذارد و بعدتر با خطای مبهمِ ffmpeg رد
   * می‌شود. با آن می‌شود صریح گفت که ارتباط قطع شده و کاربر دوباره بفرستد.
   */
  const expected = Number(req.headers["content-length"] ?? 0);

  let received = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      req.on("data", (c: Buffer) => {
        received += c.length;
        if (received > MAX_UPLOAD_BYTES) {
          reject(new Error("فایل خیلی بزرگ است."));
          req.destroy();
          out.destroy();
        }
      });
      req.pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
      /**
       * قطع‌شدن ارتباط، خطای کاربر نیست و باید **لاگ** شود.
       *
       * پیش‌تر این مسیر بی‌صدا به «آپلود ناموفق بود» تبدیل می‌شد؛ همان پیامی
       * که کاربر گزارش کرد و هیچ ردی در لاگ نداشت، پس تشخیصش ممکن نبود.
       */
      req.on("error", (err: Error) => {
        logger.warn(
          { sessionId, received, expected, err: err.message },
          "آپلود وسط راه قطع شد",
        );
        reject(new Error("ارتباط وسط آپلود قطع شد. دوباره بفرست."));
      });
      req.on("aborted", () => {
        logger.warn({ sessionId, received, expected }, "کلاینت آپلود را رها کرد");
        reject(new Error("ارتباط وسط آپلود قطع شد. دوباره بفرست."));
      });
    });
  } catch (e) {
    await fsp.unlink(dest).catch(() => {});
    return json(res, 400, { error: e instanceof Error ? e.message : "آپلود ناموفق بود." });
  }

  /**
   * فایلِ ناقص را همین‌جا بگیر، نه چند ثانیه بعد با خطای ffmpeg.
   *
   * `finish` روی جریانِ نوشتن یعنی «هرچه رسید نوشته شد»، نه «همه‌اش رسید».
   * اگر ارتباط تمیز بسته شود ولی ناقص، اینجا تنها جایی است که می‌شود فهمید.
   */
  if (expected > 0 && received < expected) {
    await fsp.unlink(dest).catch(() => {});
    logger.warn({ sessionId, received, expected }, "آپلود ناقص رسید");
    return json(res, 400, {
      error: "فایل ناقص رسید. احتمالاً ارتباط قطع شده — دوباره بفرست.",
    });
  }

  return finishUpload(res, { userId, dest, ext, declaredSec, courseId });
}

/**
 * از «فایل کامل روی دیسک است» تا پاسخِ قیمت — مشترک بین آپلود یک‌تکه و تکه‌تکه.
 *
 * جدا شد تا مسیر تازهٔ تکه‌تکه همان راستی‌آزمایی‌ها و همان محاسبهٔ قیمت را
 * بگیرد؛ دو نسخه از این منطق یعنی روزی یکی از دو مسیر بی‌صدا از دیگری عقب
 * می‌ماند و قیمتی که کاربر می‌بیند با آنچه کم می‌شود فرق می‌کند.
 */
/**
 * قیمتی که پس از آپلود به کاربر نشان داده می‌شود.
 *
 * جدا شد تا مسیرِ دست‌سازِ تکه‌تکه و tus هر دو **یک** منطقِ ساختِ جلسه را
 * بگیرند، بی‌آنکه به `res` وابسته باشند — tus خودش پاسخ را می‌سازد.
 */
type UploadResult =
  | { status: 200; body: { sessionId: string; durationSec: number; costCoins: number; haveCoins: number; enough: boolean } }
  | { status: 400 | 402; body: { error: string } };

/**
 * فایلِ کاملِ روی دیسک را به یک جلسهٔ `queued` تبدیل می‌کند: مدت را می‌سنجد،
 * فایل را به مسیرِ صوت می‌برد، و قیمت را برمی‌گرداند. **هیچ سکه‌ای کم نمی‌شود**؛
 * آن منتظرِ `confirm` می‌ماند.
 *
 * `srcFile` می‌تواند هرجایی باشد (تکه‌تکه در `audioDir` می‌سازد، tus در پوشهٔ
 * خودش)؛ اینجا با `rename` به نامِ نهایی برده می‌شود.
 */
async function finalizeUpload(o: {
  userId: number;
  srcFile: string;
  ext: string;
  declaredSec: number;
  courseId: number | null;
}): Promise<UploadResult> {
  const { userId, srcFile, ext, declaredSec, courseId } = o;
  const u = getUser(userId)!;

  const stat = await fsp.stat(srcFile).catch(() => null);
  if (!stat || stat.size === 0) {
    await fsp.unlink(srcFile).catch(() => {});
    return { status: 400, body: { error: "فایل خالی است." } };
  }

  /**
   * مدت واقعی را **خودمان** اندازه می‌گیریم، نه از مرورگر: `duration`ِ مرورگر
   * برای فایلی که کامل بافر نشده صفر یا غلط است، و قیمت روی همین عدد است.
   */
  let sec = declaredSec;
  try {
    sec = Math.round((await probe(srcFile)).durationMs / 1000);
  } catch (e) {
    logger.warn({ srcFile, err: String(e) }, "probe for duration failed");
  }
  if (sec <= 0) {
    await fsp.unlink(srcFile).catch(() => {});
    return { status: 400, body: { error: "مدت این فایل خوانده نشد. فایل صوتی سالم بفرست." } };
  }

  const sessionId = shortId();
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 5) || "ogg";
  const dest = path.join(config.audioDir, `${sessionId}.${safeExt}`);
  await fsp.mkdir(config.audioDir, { recursive: true });
  await fsp.rename(srcFile, dest);

  createSession(sessionId, userId, courseId);
  updateSession(sessionId, { mode: "full", download_route: "web", original_file: dest });

  return {
    status: 200,
    body: {
      sessionId,
      durationSec: sec,
      costCoins: costCoins(sec),
      haveCoins: balanceCoins(u.credit_sec),
      enough: u.credit_sec >= sec,
    },
  };
}

/**
 * نسخهٔ HTTPِ `finalizeUpload` برای مسیرِ دست‌سازِ تکه‌تکه.
 *
 * فایل از قبل در `audioDir` است ولی با نامِ موقت؛ `finalizeUpload` آن را به
 * نامِ نهایی `rename` می‌کند. `dest` و `sessionId`ِ ورودی دیگر لازم نیست —
 * شناسه داخلِ `finalizeUpload` ساخته می‌شود تا با tus یکی باشد.
 */
async function finishUpload(
  res: Res,
  o: { userId: number; dest: string; ext: string; declaredSec: number; courseId: number | null },
): Promise<void> {
  const r = await finalizeUpload({
    userId: o.userId,
    srcFile: o.dest,
    ext: o.ext,
    declaredSec: o.declaredSec,
    courseId: o.courseId,
  });
  json(res, r.status, r.body);
}

/**
 * تأیید کاربر: از اینجا به بعد سکه کم می‌شود و کار شروع می‌شود.
 *
 * وضعیت در **ربات** دنبال می‌شود نه در مینی‌اپ — کاربر می‌تواند صفحه را
 * ببندد و برود. به همین دلیل بلافاصله پس از شروع، یک پیام «گرفتم» در ربات
 * فرستاده می‌شود تا کاربر بداند کجا منتظر بماند.
 */
async function confirmSession(res: Res, userId: number, sessionId: string): Promise<void> {
  const s = getSession(sessionId);
  if (!s || s.tg_id !== userId) return json(res, 404, { error: "این جلسه پیدا نشد." });
  // فقط جلسه‌ای که هنوز شروع نشده تأیید می‌شود؛ وگرنه دو بار زدن دکمه یعنی
  // دو بار کسر سکه.
  if (s.status !== "queued") return json(res, 409, { error: "این جلسه از قبل شروع شده." });
  if (!s.original_file) return json(res, 400, { error: "فایل این جلسه موجود نیست." });

  const dest = s.original_file;
  let sec = 0;
  try {
    sec = Math.round((await probe(dest)).durationMs / 1000);
  } catch {
    return json(res, 400, { error: "مدت این فایل خوانده نشد." });
  }

  setProgress(sessionId, { stage: "preprocess" });

  /**
   * وضعیت در **ربات** دنبال می‌شود، نه در مینی‌اپ.
   *
   * یک پیام که جای خودش ویرایش می‌شود — همان کاری که مسیر ربات می‌کند. کاربر
   * صفحهٔ مینی‌اپ را می‌بندد و می‌رود، پس نوار پیشرفتی که فقط آنجا دیده
   * می‌شود عملاً به چشم هیچ‌کس نمی‌رسد.
   */
  const live = liveMessage(userId);

  try {
    startJob({
      sessionId,
      userId,
      audioFile: dest,
      courseId: s.course_id ?? null,
      declaredDurationSec: sec,
      mode: "full",
      onProgress: (p) => {
        setProgress(sessionId, { stage: p.stage, ...(p.detail ? { detail: p.detail } : {}) });
        void live.update(progressMessage(p.stage, p.detail));
      },
      /**
       * کار در مینی‌اپ شروع شده ولی نتیجه در **ربات** تحویل داده می‌شود.
       *
       * دلیلش تجربهٔ کاربر است نه فنی: جزوه را در ربات می‌شود برای گروه درس
       * فوروارد کرد، زمان‌های گزارش آنجا لینکِ پخش می‌شوند، و جلسه در همان
       * تاریخچه‌ای می‌نشیند که کاربر می‌شناسد. مینی‌اپ فقط برای آپلود است،
       * چون بله بالای بیست مگابایت را نمی‌پذیرد و آپلود در تلگرام برای
       * کاربر ایرانی از پشت فیلترشکن کند است.
       *
       * شکستش بی‌صداست: کاربر جلسه‌اش را در تاریخچه دارد و یک خطای شبکه
       * نباید نتیجه را از بین ببرد.
       */
      onDone: (out) => {
        setProgress(sessionId, { stage: "done" });
        const done = getSession(sessionId);
        // گزارش، ریپلایِ همان صوتی که بالاتر به کانال رفت — همان چیزی که
        // مسیر ربات می‌کند، تا بایگانی برای هر سه در یک شکل باشد.
        if (done && out.report) {
          void archiveReport(
            done,
            out.report,
            done.course_id ? (getCourse(done.course_id)?.name ?? null) : null,
          );
        }
        // پیام وضعیت پیش از تحویل برداشته می‌شود، وگرنه «دارم جزوه رو
        // می‌نویسم…» بالای نتیجهٔ آماده می‌ماند.
        void live.finish().then(() => {
          if (done) {
            return deliverToBot(userId, done).catch((e: unknown) => {
              logger.warn({ sessionId, err: String(e) }, "deliver to bot failed");
            });
          }
        });
      },
      onError: (message) => {
        setProgress(sessionId, { stage: "error", message });
        const failed = getSession(sessionId);
        if (failed) void archiveFailure(failed, message);
        void live
          .finish()
          .then(() => notifyUser(userId, `⚠️ تحلیل این صوت به مشکل خورد.\n${message}`))
          .catch(() => {});
      },
    });
  } catch (e) {
    if (e instanceof InsufficientCredit) {
      return json(res, 402, {
        error: "اعتبارت کم است.",
        needCoins: costCoins(e.needed),
        haveCoins: balanceCoins(e.balance),
      });
    }
    throw e;
  }

  /**
   * یک نسخه به کانال بایگانی تلگرام — همان کانالی که صوت‌های ربات می‌روند.
   *
   * **اینجا و نه در `uploadAudio`:** آپلود هنوز تعهدی نیست؛ کاربر قیمت را
   * می‌بیند و می‌تواند برود. اگر بایگانی سرِ آپلود انجام می‌شد، کانال پر
   * می‌شد از صوت‌هایی که هیچ‌وقت پردازش نشدند.
   *
   * از `file_id` خبری نیست چون این فایل هرگز از تلگرام رد نشده؛ خودِ فایل
   * روی دیسک آپلود می‌شود و اگر از سقف ربات بزرگ‌تر بود، فشرده.
   *
   * `void`: آپلود یک فایل بزرگ می‌تواند طولانی باشد و پاسخِ `202` نباید
   * پشتش منتظر بماند. شکستش هم مثل هر مسیر بایگانیِ دیگر بی‌سروصداست.
   */
  const uc = getUser(userId);
  void archiveAudio(
    sessionId,
    { path: dest },
    audioCaption({
      sender: { tgId: userId, name: uc?.name ?? null, username: uc?.username ?? null },
      mode: "full",
      durationMs: sec * 1000,
      sessionId,
      courseName: s.course_id ? (getCourse(s.course_id)?.name ?? null) : null,
      origin: "web",
    }),
    sec,
  );

  /**
   * اولین پیام وضعیت را همین حالا بگذار، نه با اولین `onProgress`.
   *
   * کاربر مینی‌اپ را می‌بندد و می‌رود سراغ ربات؛ اگر چت خالی باشد فکر می‌کند
   * صوتش گم شده. همین پیام بعداً جای خودش ویرایش می‌شود، پس چیزی هم اضافه
   * نمی‌ماند.
   */
  void live.update(progressMessage("queue"));

  json(res, 202, { sessionId });
}

// ─── فایل‌های ایستا ─────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  /**
   * برای فایل‌های راستی‌آزماییِ مالکیت دامنه (درگاه پرداخت، وبمستر و مانند
   * آن‌ها) که یک `.txt` در ریشه می‌خواهند.
   *
   * بدون این، پیش‌فرض `application/octet-stream` می‌شد و مرورگر به‌جای
   * نشان‌دادن متن، دانلودش می‌کرد — و بعضی راستی‌آزماها همان را رد می‌کنند.
   */
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(req: http.IncomingMessage, res: Res, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");

  /**
   * مسیر باید **داخل** پوشهٔ عمومی بماند.
   *
   * `resolve` دنبالهٔ `..` را حل می‌کند، پس بررسی پیشوند بعد از آن انجام
   * می‌شود نه قبلش — وگرنه `/../.env` از فیلتر رد می‌شد.
   */
  const target = path.resolve(publicDir, rel);
  if (!target.startsWith(publicDir)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  let file = target;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    /**
     * بازگشت به صفحهٔ اپ فقط برای **مسیر**هاست، نه برای درخواست فایل.
     *
     * قاعدهٔ قبلی هر چیزِ پیدانشده را به `index.html` می‌داد تا مسیریابی
     * سمت کلاینت کار کند (`/app/session/xyz`). ولی همین یعنی
     * `GET /.env.production` هم پاسخ **۲۰۰** می‌گرفت. محتوایش فقط لندینگ
     * پیج بود و چیزی لو نمی‌رفت، ولی در لاگ دیدیم که اسکنرها دقیقاً همین
     * را می‌زنند و «۲۰۰» به آن‌ها می‌گوید اینجا چیزی هست — دعوت‌نامهٔ
     * تلاش بیشتر.
     *
     * پس هر مسیری که پسوند فایل دارد و پیدا نشد، صادقانه ۴۰۴ می‌گیرد.
     * مسیرهای بی‌پسوند همچنان به صفحهٔ اپ می‌روند.
     *
     * مسیرهای نقطه‌دار جداگانه بررسی می‌شوند، و بررسی روی **هر قطعه**
     * است نه فقط نام فایل. `extname` برای `.htaccess` رشتهٔ خالی می‌دهد
     * (نقطه پیشوند است نه پسوند) و `basename(".git/config")` هم برابر
     * `config` است — پس هر دو از تور در می‌رفتند، در حالی که دقیقاً
     * همین‌ها پرتکرارترین هدف اسکنرها هستند.
     */
    if (path.extname(rel) || rel.split("/").some((seg) => seg.startsWith("."))) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    file = path.join(publicDir, pathname.startsWith("/app") ? "app.html" : "index.html");
  }
  if (!fs.existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }

  const ext = path.extname(file).toLowerCase();

  /**
   * پوستهٔ اپ هرگز کش نمی‌شود — نه فقط HTML.
   *
   * پیش‌تر فقط `.html` روی `no-cache` بود و `app.js` یک ساعت کش می‌شد. نتیجه‌اش
   * ترکیبِ کشندهٔ «HTML تازه + جاوااسکریپت کهنه» بود: صفحه عناصر جدید را داشت
   * ولی کدِ قدیمی آن‌ها را نمی‌شناخت، و مینی‌اپِ بله روی «یه لحظه…» می‌ماند.
   * نسخه‌بندی فایل (hash در نام) راه درست‌تری است ولی مرحلهٔ ساخت می‌خواهد؛
   * این پروژه عمداً بدون آن نوشته شده، پس `no-cache` ارزان‌ترین جواب است.
   *
   * `no-cache` یعنی «کش کن ولی هر بار بپرس»، نه «کش نکن» — پس با ۳۰۴ همچنان
   * ارزان می‌ماند و فقط وقتی بایت می‌فرستد که واقعاً عوض شده باشد.
   *
   * دارایی‌های واقعاً ایستا (فونت، تصویر) همان یک ساعت را نگه می‌دارند.
   */
  const isShell = ext === ".html" || ext === ".js" || ext === ".css";

  /**
   * برچسب نسخه از اندازه و زمانِ تغییرِ فایل.
   *
   * بدون برچسب، `no-cache` یعنی «هر بار کاملش را بفرست» — درست ولی گران.
   * با برچسب، مرورگر می‌پرسد و اگر عوض نشده باشد ۳۰۴ می‌گیرد و چیزی دانلود
   * نمی‌شود. هش‌کردن محتوا دقیق‌تر است ولی برای فایلی که هر بار خوانده
   * می‌شود گران است؛ `mtime` و اندازه برای این کار کافی‌اند.
   */
  const stat = fs.statSync(file);
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(36)}"`;

  /**
   * فونت‌ها یک سال کش می‌شوند، چون هرگز عوض نمی‌شوند.
   *
   * محتوای یک `.woff2` ثابت است؛ اگر روزی نسخهٔ تازه‌ای لازم شود
   * `scripts/fetch-font.mjs` نام تازه می‌سازد. برای کاربری که روی اینترنت
   * ایران است، هر رفت‌وبرگشتِ اضافه — حتی یک ۳۰۴ — دیدنی است، و ۳۴۸ کیلوبایت
   * فونت نباید هر ساعت دوباره پرسیده شود.
   */
  const cache = isShell
    ? "no-cache"
    : ext === ".woff2"
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600";

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag, "cache-control": cache }).end();
    return;
  }

  /**
   * آدرس `app.js` و `styles.css` با **زمانِ خودِ فایل** مهر می‌خورد.
   *
   * **چرا لازم شد:** وب‌ویوی اندرویدِ بله `no-cache` را جدی نمی‌گیرد. پس از
   * استقرارِ آپلود تکه‌تکه، گوشی همچنان نسخهٔ کهنهٔ `app.js` را اجرا می‌کرد و
   * مستقیم به `/api/sessions/upload` می‌زد — یعنی مسیر یک‌تکهٔ قدیمی. در لاگ
   * nginx **هیچ درخواستی برای `app.js` نبود** ولی POST می‌آمد؛ همین نشانهٔ
   * قطعیِ کشِ گیرکرده است. نتیجه‌اش برای کاربر: فایل ۱۷ مگابایتی وسط راه
   * می‌برید و **از اول** شروع می‌شد، چون کدِ از سرگیری اصلاً اجرا نمی‌شد.
   *
   * `no-cache` و ETag سرجایشان می‌مانند، ولی دیگر تنها خط دفاع نیستند: با
   * عوض‌شدن فایل، آدرس هم عوض می‌شود و کشِ کهنه دیگر همان آدرس نیست. این
   * همان درسِ [[passchi-deployment]] است — «HTML تازه + جاوااسکریپت کهنه»
   * بدترین ترکیب است چون هیچ خطایی نمی‌دهد.
   */
  if (ext === ".html") {
    const html = await fsp.readFile(file, "utf8");
    const stamped = await stampAssets(html);
    const body = Buffer.from(stamped, "utf8");
    res.writeHead(200, {
      "content-type": MIME[ext]!,
      "cache-control": cache,
      "content-length": String(body.length),
      etag,
    });
    res.end(body);
    return;
  }

  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": cache,
    etag,
  });
  fs.createReadStream(file).pipe(res);
}

/**
 * به هر `src`/`href` محلیِ js و css یک `?v=<زمان فایل>` بچسبان.
 *
 * فقط آدرس‌های محلی: `https://…` دست‌نخورده می‌ماند چون فایلش را نمی‌بینیم و
 * مهرِ ساختگی روی آن بی‌معنی است.
 */
async function stampAssets(html: string): Promise<string> {
  const stamps = new Map<string, string>();
  const stampOf = async (rel: string): Promise<string> => {
    const cached = stamps.get(rel);
    if (cached !== undefined) return cached;
    const v = await fsp
      .stat(path.join(publicDir, rel.replace(/^\/+/, "")))
      .then((s) => Math.floor(s.mtimeMs).toString(36))
      .catch(() => "");
    stamps.set(rel, v);
    return v;
  };

  const targets = [...html.matchAll(/(?:src|href)="(\/[^"?]+\.(?:js|css))"/g)].map((m) => m[1]!);
  for (const rel of new Set(targets)) {
    const v = await stampOf(rel);
    if (!v) continue;
    html = html.split(`"${rel}"`).join(`"${rel}?v=${v}"`);
  }
  return html;
}

// ─── راه‌اندازی ─────────────────────────────────────────────────────────────

/**
 * سرورِ tus، یک‌بار ساخته می‌شود.
 *
 * تنبل است چون `finalizeUpload` را می‌گیرد که پایین‌تر در همین فایل تعریف
 * شده؛ ساختِ آنی هنگامِ بارگذاریِ ماژول ترتیبِ اعلان را حساس می‌کرد.
 */
let _tus: TusServer | null = null;
function getTusServer(): TusServer {
  if (!_tus) {
    _tus = createTusServer({
      uploadDir: path.join(config.workDir, "tus"),
      maxSize: MAX_UPLOAD_BYTES,
      tokenToUserId: (h) => (h?.startsWith("Bearer ") ? userIdFromToken(h.slice(7).trim()) : null),
      finalize: finalizeUpload,
      log: (o, msg) => logger.info(o, msg),
    });
  }
  return _tus;
}

export function createWebServer(): http.Server {
  return http.createServer((req, res) => {
    /**
     * هدر `Host` از بیرون می‌آید و **قابل اعتماد نیست**. اسکنرها مقدارهای
     * بدشکل می‌فرستند (یک نمونهٔ واقعی: `091.107.246.090` با صفرِ پیشوند)
     * و `new URL` روی آن پرتاب می‌کند. چون این خط بیرون از هر try بود،
     * یک درخواستِ بدشکل **کل پروسه را می‌کشت** — یعنی ربات تلگرام و بله و
     * سایت با هم می‌رفتند. دو بار در لاگ همین شد.
     * پس میزبانِ بدشکل را دور می‌ریزیم و به `localhost` برمی‌گردیم.
     */
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
    }

    /**
     * مینی‌اپ داخل iframe تلگرام و بله بارگذاری می‌شود، پس `X-Frame-Options`
     * گذاشته **نمی‌شود** — گذاشتنش یعنی صفحه در مینی‌اپ سفید بماند.
     */
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");

    /**
     * tus **پیش از** مدیریتِ عمومیِ OPTIONS/CORS مسیریابی می‌شود.
     *
     * tus خودش OPTIONS و CORS و متدهای PATCH/HEAD/DELETE را مدیریت می‌کند؛
     * اگر به بلوکِ عمومیِ زیر می‌رسید، آن فقط GET/POST/OPTIONS را مجاز
     * می‌کرد و preflightِ tus (که PATCH می‌خواهد) می‌شکست.
     */
    if (url.pathname === "/api/tus" || url.pathname.startsWith("/api/tus/")) {
      getTusServer()
        .handle(req, res)
        .catch((e: unknown) => {
          logger.error({ err: String(e) }, "tus handler error");
          if (!res.headersSent) res.writeHead(500).end();
        });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      });
      return void res.end();
    }
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("access-control-allow-origin", "*");
      handleApi(req, res, url).catch((e: unknown) => {
        logger.error({ err: String(e), path: url.pathname }, "web api error");
        if (!res.headersSent) json(res, 500, { error: "خطای سرور." });
        else res.end();
      });
      return;
    }

    serveStatic(req, res, url.pathname).catch((e: unknown) => {
      logger.error({ err: String(e) }, "static serve error");
      if (!res.headersSent) res.writeHead(500).end("error");
    });
  });
}

export function startWebServer(): http.Server | null {
  if (!config.WEB_ENABLED) return null;
  const server = createWebServer();
  server.listen(config.WEB_PORT, () => {
    logger.info({ port: config.WEB_PORT, publicUrl: config.PUBLIC_URL || "—" }, "web server listening");
  });
  setInterval(() => purgeExpiredSessions(), 6 * 60 * 60_000).unref();
  /**
   * آپلودهای رهاشده هم باید جارو شوند، وگرنه هر آپلودِ نیمه‌کاره یک فایل
   * روی دیسک و یک ورودی در حافظه می‌گذارد که هیچ‌وقت برداشته نمی‌شود.
   */
  setInterval(() => {
    void sweepUploads();
  }, 15 * 60_000).unref();
  return server;
}

export { fmtCoins };
