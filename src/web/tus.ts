/**
 * آپلودِ ازسرگیری‌پذیر با پروتکلِ **tus**.
 *
 * **چرا کنارِ مسیرِ دست‌سازِ تکه‌تکه، نه به‌جایش (فعلاً):** مسیرِ موازیِ خودمان
 * چهار باگِ جدی داشت (دامِ `a+`، مسابقهٔ `prog`، بن‌بستِ پاسخِ گم‌شده، خفگیِ
 * تکه). tus همهٔ این‌ها را از پایه ندارد — ازسرگیری، ردیابیِ offset، و بازیابیِ
 * پاسخِ گم‌شده (`HEAD` → `Upload-Offset`) توکار است. این ماژول را جدا گذاشتیم
 * تا هر دو مسیر زنده بمانند و بشود سرعت و پایداریِ موازی در برابرِ ترتیبی را
 * روی تونلِ واقعیِ NSIN سنجید، بعد تصمیمِ نهایی گرفت.
 *
 * **چرا تزریقِ وابستگی:** `server.ts` این را می‌سازد و `finalizeUpload`ِ خودش
 * را می‌دهد؛ اگر این ماژول مستقیم از `server.ts` وارد می‌کرد، حلقهٔ وابستگی
 * می‌شد.
 */
import path from "node:path";
import fsp from "node:fs/promises";
import { Server } from "@tus/server";
import { FileStore } from "@tus/file-store";

/** همان شکلی که `finalizeUpload`ِ سرور برمی‌گرداند. */
export type FinalizeResult =
  | {
      status: 200;
      body: { sessionId: string; durationSec: number; costCoins: number; haveCoins: number; enough: boolean };
    }
  | { status: 400 | 402; body: { error: string } };

export type TusDeps = {
  /** پوشهٔ کارِ tus؛ جدا از `.part`های مسیرِ دست‌ساز تا قاطی نشوند. */
  uploadDir: string;
  /** سقفِ اندازهٔ فایل. */
  maxSize: number;
  /** از هدرِ `Authorization` به شناسهٔ کاربر؛ `null` یعنی نامعتبر. */
  tokenToUserId: (authHeader: string | null | undefined) => number | null;
  /** فایلِ کامل را به جلسهٔ `queued` تبدیل می‌کند و قیمت را برمی‌گرداند. */
  finalize: (o: {
    userId: number;
    srcFile: string;
    ext: string;
    declaredSec: number;
    courseId: number | null;
  }) => Promise<FinalizeResult>;
  log: (o: Record<string, unknown>, msg: string) => void;
};

/** خطایی که tus شناسه و بدنه‌اش را به کلاینت می‌فرستد. */
function httpError(status: number, body: unknown): Error {
  return Object.assign(new Error(typeof body === "string" ? body : JSON.stringify(body)), {
    status_code: status,
    body: JSON.stringify(body),
  });
}

/** آپلودِ رهاشده پس از این مدت منقضی و جارو می‌شود — هم‌تراز با سقفِ `.part`. */
const TUS_EXPIRE_MS = 60 * 60 * 1000;

export function createTusServer(deps: TusDeps): Server {
  const store = new FileStore({
    directory: deps.uploadDir,
    expirationPeriodInMilliseconds: TUS_EXPIRE_MS,
  });

  const server = new Server({
    path: "/api/tus",
    datastore: store,
    maxSize: deps.maxSize,

    /**
     * **آدرسِ نسبی، نه مطلق — وگرنه PATCH به ریدایرکت می‌خورد.**
     *
     * پشتِ تونلِ NSIN مبدأ درخواست را روی `http` می‌بیند، پس tus آدرسِ
     * `http://passchi.ir/api/tus/<id>` را در `Location` می‌گذارد. کلاینت که
     * روی `https` است به آن `http` می‌زند، CDN به `https` ریدایرکت می‌کند، و
     * بدنهٔ PATCH وسطِ ریدایرکت می‌پرد. با آدرسِ نسبی (`/api/tus/<id>`)، کلاینت
     * خودش آن را به مبدأِ `https`ِ صفحه می‌چسباند و ریدایرکتی در کار نیست.
     */
    relativeLocation: true,

    /**
     * مینی‌اپ داخلِ iframe اجرا می‌شود و مبدأش ثابت نیست، پس همهٔ مبدأها
     * پذیرفته می‌شوند و `Authorization` به هدرهای مجازِ CORS اضافه می‌شود —
     * وگرنه preflightِ مرورگر توکن را نمی‌فرستد.
     */
    allowedOrigins: () => true,
    allowedHeaders: ["Authorization"],

    /**
     * دروازهٔ احراز هویت: هر درخواستِ tus (POST/PATCH/HEAD) باید توکنِ معتبر
     * داشته باشد، وگرنه همین‌جا با ۴۰۱ رد می‌شود.
     */
    onIncomingRequest: async (req) => {
      const uid = deps.tokenToUserId(req.headers.get("authorization"));
      if (uid == null) throw httpError(401, { error: "نشستت منقضی شده. دوباره وارد شو." });
    },

    /**
     * پس از رسیدنِ آخرین بایت: مدت را می‌سنجیم، جلسه می‌سازیم، و قیمت را در
     * بدنهٔ پاسخ برمی‌گردانیم تا کلاینت صفحهٔ تأیید را نشان دهد.
     *
     * بدنه در پاسخِ PATCHِ نهایی برخلافِ سختگیریِ پروتکل است ولی همهٔ کلاینت‌ها
     * می‌پذیرند؛ جایگزینش یک رفت‌وبرگشتِ اضافه بود.
     */
    onUploadFinish: async (req, upload) => {
      const uid = deps.tokenToUserId(req.headers.get("authorization"));
      if (uid == null) throw httpError(401, { error: "نشستت منقضی شده." });

      const md = upload.metadata ?? {};
      const src = path.join(deps.uploadDir, upload.id);
      const r = await deps.finalize({
        userId: uid,
        srcFile: src,
        ext: typeof md.ext === "string" ? md.ext : "ogg",
        declaredSec: Number(md.duration ?? 0),
        courseId: md.courseId ? Number(md.courseId) : null,
      });

      /**
       * سایدکارِ `<id>.json` را پاک کن.
       *
       * `finalize` فایلِ داده را با `rename` از store بیرون برد، ولی
       * FileStore متادیتای هر آپلود را در یک `<id>.json` کنارش نگه می‌دارد؛
       * بی این پاک‌سازی، آن‌ها تلنبار می‌شوند.
       */
      await fsp.unlink(path.join(deps.uploadDir, `${upload.id}.json`)).catch(() => {});

      if (r.status !== 200) {
        deps.log({ uploadId: upload.id, status: r.status }, "tus: ساختِ جلسه رد شد");
        throw httpError(r.status, r.body);
      }
      deps.log({ uploadId: upload.id, sessionId: r.body.sessionId }, "tus: جلسه ساخته شد");
      return {
        status_code: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r.body),
      };
    },
  });

  /**
   * آپلودهای نیمه‌کارهٔ رهاشده را دوره‌ای جارو کن.
   *
   * آپلودِ کامل را `onUploadFinish` از store بیرون می‌برد؛ ولی آپلودی که
   * کاربر وسطِ راه رها کرد (POST زد، تمام نکرد) در پوشه می‌ماند. بی این، مثل
   * `.part`های مسیرِ دست‌ساز تلنبار می‌شوند.
   */
  setInterval(() => {
    server.cleanUpExpiredUploads().catch((e: unknown) => deps.log({ err: String(e) }, "tus: جاروی انقضا شکست"));
  }, 15 * 60_000).unref();

  return server;
}
