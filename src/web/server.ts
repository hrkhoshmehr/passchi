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
import { getProgress, setProgress } from "./progress.js";
import { startJob } from "../jobs/service.js";
import { InsufficientCredit } from "../billing/ledger.js";
import { balanceCoins, costCoins, fmtCoins, PACKAGES, COINS_PER_MINUTE } from "../billing/coins.js";
import { history } from "../billing/ledger.js";
import {
  createCourse, createSession, getSession, getUser, listCourses, listSessions,
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
    json(res, 401, { error: "وارد نشده‌ای." });
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

    case "POST /api/sessions/upload": {
      const uid = requireUser(req, res);
      if (uid === null) return;
      return uploadAudio(req, res, uid, url);
    }
  }

  // مسیرهای پارامتردار
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/);
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
    return json(res, 402, {
      error: "اعتبارت کم است.",
      needCoins: costCoins(declaredSec),
      haveCoins: balanceCoins(u.credit_sec),
    });
  }

  const sessionId = shortId();
  const ext = (url.searchParams.get("ext") ?? "ogg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "ogg";
  const dest = path.join(config.audioDir, `${sessionId}.${ext}`);
  await fsp.mkdir(config.audioDir, { recursive: true });

  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_UPLOAD_BYTES) {
          reject(new Error("فایل خیلی بزرگ است."));
          req.destroy();
          out.destroy();
        }
      });
      req.pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
      req.on("error", reject);
    });
  } catch (e) {
    await fsp.unlink(dest).catch(() => {});
    return json(res, 400, { error: e instanceof Error ? e.message : "آپلود ناموفق بود." });
  }

  const stat = await fsp.stat(dest);
  if (stat.size === 0) {
    await fsp.unlink(dest).catch(() => {});
    return json(res, 400, { error: "فایل خالی است." });
  }

  createSession(sessionId, userId, courseId);
  updateSession(sessionId, {
    mode: "full",
    download_route: "web",
  });

  setProgress(sessionId, { stage: "preprocess" });

  try {
    startJob({
      sessionId,
      userId,
      audioFile: dest,
      courseId,
      declaredDurationSec: declaredSec,
      mode: "full",
      onProgress: (s) => setProgress(sessionId, { stage: s.stage, ...(s.detail ? { detail: s.detail } : {}) }),
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
      onDone: () => {
        setProgress(sessionId, { stage: "done" });
        const s = getSession(sessionId);
        if (s) {
          void deliverToBot(userId, s).catch((e: unknown) => {
            logger.warn({ sessionId, err: String(e) }, "deliver to bot failed");
          });
        }
      },
      onError: (message) => setProgress(sessionId, { stage: "error", message }),
    });
  } catch (e) {
    if (e instanceof InsufficientCredit) {
      await fsp.unlink(dest).catch(() => {});
      return json(res, 402, {
        error: "اعتبارت کم است.",
        needCoins: costCoins(e.needed),
        haveCoins: balanceCoins(e.balance),
      });
    }
    throw e;
  }

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

  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": cache,
    etag,
  });
  fs.createReadStream(file).pipe(res);
}

// ─── راه‌اندازی ─────────────────────────────────────────────────────────────

export function createWebServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    /**
     * مینی‌اپ داخل iframe تلگرام و بله بارگذاری می‌شود، پس `X-Frame-Options`
     * گذاشته **نمی‌شود** — گذاشتنش یعنی صفحه در مینی‌اپ سفید بماند.
     */
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");

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
  return server;
}

export { fmtCoins };
