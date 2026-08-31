/**
 * سرویس کار — همان چیزی که ربات انجام می‌داد، بدون اینکه چیزی از تلگرام بداند.
 *
 * پیش از این، ترتیبِ حساس «رزرو اعتبار، اجرا، تسویه یا بازگشت» فقط داخل
 * `bot/index.ts` وجود داشت و با ارسال پیام تلگرام درهم بافته بود. با آمدن وب،
 * دو انتخاب بود: کپی‌کردنش، یا بیرون‌کشیدنش. کپی یعنی روزی یکی از دو نسخه در
 * مسیر شکست بازپرداخت نکند و کاربر سکه‌اش را از دست بدهد — اشکالی که در آزمون
 * دیده نمی‌شود چون فقط در شکست رخ می‌دهد.
 *
 * پس اینجا یک نسخه هست و هر دو سکو صدایش می‌زنند. تفاوتشان فقط در
 * `onProgress` و `onDone` است: ربات پیام ویرایش می‌کند، وب در حافظه می‌نویسد
 * تا کلاینت با نظرسنجی بخواند.
 */

import { logger } from "../util/logger.js";
import { runPipeline, type Stage } from "../pipeline.js";
import { enqueue } from "../queue.js";
import { commit, danglingReservations, refund, reserve, InsufficientCredit } from "../billing/ledger.js";
import { registerOwner } from "../billing/sharing.js";
import {
  getCourse, getSession, markFreeRunUsed, updateSession,
  type SessionMode,
} from "../db/index.js";
import type { PipelineOutput } from "../pipeline.js";

export interface JobSpec {
  sessionId: string;
  userId: number;
  audioFile: string;
  courseId: number | null;
  /** مدت اعلام‌شده به ثانیه؛ مبنای رزرو است نه تسویه. */
  declaredDurationSec: number;
  mode: SessionMode;
  /** سقف مدت برای اجرای رایگان. */
  limitMs?: number;
  sessionDate?: string | null;
  onProgress?: (s: Stage) => void;
  onDone?: (out: PipelineOutput) => Promise<void> | void;
  onError?: (message: string) => Promise<void> | void;
}

/**
 * کار را در صف بگذار و اعتبار را **پیش از اجرا** کنار بگذار.
 *
 * رزرو قبل از صف انجام می‌شود، نه داخل آن: وگرنه کاربر می‌تواند چند کار پشت
 * سر هم صف کند که مجموعشان از اعتبارش بیشتر است، و همه شروع می‌شوند.
 *
 * پرتاب `InsufficientCredit` عمدی است و صدازننده باید بگیردش — تنها حالتی که
 * کار اصلاً به صف نمی‌رسد.
 */
export function startJob(job: JobSpec): void {
  const free = job.mode === "free_trial";
  const reservedSec = free ? 0 : Math.max(60, job.declaredDurationSec);

  if (!free) reserve(job.userId, reservedSec, job.sessionId);

  enqueue(String(job.userId), async (signal) => {
    try {
      const course = job.courseId ? getCourse(job.courseId) : null;
      const out = await runPipeline({
        sessionId: job.sessionId,
        audioFile: job.audioFile,
        course,
        sessionDate: job.sessionDate ?? new Date().toLocaleDateString("fa-IR"),
        makePdf: !free,
        mode: job.mode,
        ...(job.limitMs ? { limitMs: job.limitMs } : {}),
        signal,
        onProgress: (s) => job.onProgress?.(s),
      });

      if (free) {
        markFreeRunUsed(job.userId);
      } else {
        // تسویه: فقط تفاوت مدت واقعی و مدت رزروشده جابه‌جا می‌شود
        const actualSec = Math.round(out.originalDurationMs / 1000);
        commit(job.userId, reservedSec, actualSec, job.sessionId);
        registerOwner(job.sessionId, job.userId, actualSec);
      }

      await job.onDone?.(out);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error({ sessionId: job.sessionId, err: message }, "pipeline failed");
      updateSession(job.sessionId, { status: "error", error: message.slice(0, 500) });
      if (!free) refund(job.userId, reservedSec, job.sessionId, "کار ناموفق بود");
      await job.onError?.(message);
    }
  });
}

export { InsufficientCredit, getSession };

/**
 * جلسه‌های نیمه‌کاره‌ای که از اجرای قبلی مانده‌اند را جمع کن.
 *
 * ## چرا لازم است
 *
 * تا وقتی پروسه زنده است، هر شکستی از `catch` بالا رد می‌شود و سکه برمی‌گردد.
 * ولی سه چیز **پرتاب نمی‌کنند، فقط می‌کشند**: `process.exit` در خاموشی،
 * `SIGKILL` وقتی مهلت systemd تمام شود، و OOM. در آن حالت نه بازپرداختی
 * هست نه به‌روزرسانی وضعیت — جلسه تا ابد روی `preprocess` می‌ماند و سکهٔ
 * کاربر رزرو-شده.
 *
 * یک بار روی کاربر واقعی افتاد و ۸۵ سکه‌اش رفت. `drain()` در `index.ts`
 * جلوی حالتِ **باقاعده** را می‌گیرد؛ این تابع تورِ حالت‌های دیگر است.
 *
 * عمداً کار را **دوباره اجرا نمی‌کند**: فایل ممکن است پاک شده باشد، و مهم‌تر
 * اینکه اجرای خودکارِ چیزی که همین حالا سرور را کشته راهِ خوبی برای کشتنِ
 * دوبارهٔ آن است. سکه برمی‌گردد و کاربر خودش تصمیم می‌گیرد.
 */
export function recoverInterrupted(): number {
  const dangling = danglingReservations();
  for (const d of dangling) {
    refund(d.tgId, d.reservedSec, d.sessionId, "سرور وسط پردازش متوقف شد");
    updateSession(d.sessionId, {
      status: "error",
      error: "سرور وسط پردازش متوقف شد؛ سکه‌ها برگشت. دوباره بفرست.",
    });
    logger.warn(
      { sessionId: d.sessionId, tgId: d.tgId, sec: d.reservedSec },
      "جلسهٔ نیمه‌کاره جمع شد و سکه برگشت",
    );
  }
  return dangling.length;
}
