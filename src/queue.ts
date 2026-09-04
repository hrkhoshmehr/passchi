import { config } from "./config.js";
import { logger } from "./util/logger.js";

interface Job {
  /** کلید صف: شناسهٔ داخلی کاربر. یک نفر می‌تواند چند کار داشته باشد. */
  id: string;
  run: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
}

const pending: Job[] = [];

/**
 * کارهای در جریان — **مجموعه**، نه نگاشتِ کلیدخورده روی کاربر.
 *
 * ## باگی که این را عوض کرد
 *
 * قبلاً `Map<string, Job>` بود با کلیدِ شناسهٔ کاربر. دو کارِ هم‌زمانِ یک نفر
 * روی یک کلید می‌نشستند، پس:
 *
 * • `active.size` بالا نمی‌رفت و `pump` سقف `MAX_CONCURRENT_JOBS` را رد
 *   می‌کرد — با پنج کارِ یک کاربر، هر پنج‌تا هم‌زمان اجرا می‌شدند.
 * • تمام‌شدنِ اولی ورودیِ دومی را پاک می‌کرد، پس `isBusy` دروغ می‌گفت.
 * • `cancel` فقط آخرین کار را می‌دید.
 *
 * مسیر رسیدن به آن فرضی نبود: مسیر ربات پیش از صف‌کردن `isBusy` می‌زند ولی
 * مسیر تأییدِ سرور وب نمی‌زد، پس یک آپلود از مینی‌اپ وسط یک کار در ربات کافی
 * بود. روی یک سرور کوچک که هم‌زمان ffmpeg و کرومیوم هم دارد، نتیجه‌اش کمبود
 * حافظه است — یعنی همان چیزی که `recoverInterrupted` برای پاک‌کردن پس از آن
 * ساخته شده.
 */
const active = new Set<Job>();

/** چند کارِ در جریان به نام این کاربر است. */
function activeFor(id: string): number {
  let n = 0;
  for (const j of active) if (j.id === id) n++;
  return n;
}

function start(job: Job): void {
  active.add(job);
  void job
    .run(job.controller.signal)
    .catch((e: unknown) => logger.error({ jobId: job.id, err: String(e) }, "job failed"))
    .finally(() => {
      active.delete(job);
      pump();
    });
}

/**
 * هر کاربر **یک** کارِ در جریان دارد، و کلِ سیستم `MAX_CONCURRENT_JOBS` تا.
 *
 * قید per-user اینجا اعمال می‌شود نه در صدازننده‌ها: مسیر ربات `isBusy` را
 * می‌زند و پیام مهربان می‌دهد، ولی مسیر وب نمی‌زد. با اعمالِ قید در یک جا،
 * کارِ دومِ همان کاربر به‌جای اجرای موازی، پشتِ اولی صبر می‌کند.
 */
function pump(): void {
  let started = true;
  while (started && active.size < config.MAX_CONCURRENT_JOBS) {
    started = false;
    for (let i = 0; i < pending.length; i++) {
      const job = pending[i]!;
      if (activeFor(job.id) > 0) continue; // نوبتش بعد از کارِ در جریانِ خودش
      pending.splice(i, 1);
      start(job);
      started = true;
      break;
    }
  }
}

export function enqueue(id: string, run: (signal: AbortSignal) => Promise<void>): number {
  const job: Job = { id, run, controller: new AbortController() };
  pending.push(job);
  pump();
  if (active.has(job)) return 0;
  return pending.filter((j) => j.id === id).indexOf(job) + 1;
}

/** کارهای این کاربر را لغو کن — چه در صف، چه در جریان. */
export function cancel(id: string): boolean {
  let hit = false;
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i]!.id === id) {
      pending.splice(i, 1);
      hit = true;
    }
  }
  for (const job of active) {
    if (job.id === id) {
      job.controller.abort();
      hit = true;
    }
  }
  return hit;
}

export function isBusy(id: string): boolean {
  return activeFor(id) > 0 || pending.some((j) => j.id === id);
}

export function queueDepth(): { active: number; pending: number } {
  return { active: active.size, pending: pending.length };
}

/**
 * منتظر بمان تا کارهای در جریان تمام شوند — برای خاموشیِ باقاعده.
 *
 * ## چرا لازم شد
 *
 * `shutdown()` مستقیم `process.exit(0)` می‌زد. یک `systemctl restart` وسطِ
 * یک جلسه یعنی پروسه می‌میرد، و چون **پرتاب نمی‌شود** بلکه می‌میرد، آن
 * `catch` در `startJob` که سکه‌ها را برمی‌گرداند هرگز اجرا نمی‌شود. نتیجه:
 * جلسه تا ابد روی `preprocess` می‌ماند و سکه‌های کاربر رزرو-شده می‌مانند.
 *
 * یک بار روی کاربر واقعی اتفاق افتاد: ۸۵ سکه رفت و هیچ خروجی‌ای نیامد.
 *
 * کارهای **در صف** (که هنوز شروع نشده‌اند) دور ریخته می‌شوند نه اینکه
 * منتظرشان بمانیم — آن‌ها هنوز چیزی مصرف نکرده‌اند و صدازننده با
 * `drainPending` می‌تواند سکه‌شان را برگرداند.
 *
 * `timeoutMs` تور ایمنی است: اگر کاری گیر کرده باشد، خاموشی نباید تا ابد
 * معلق بماند. `TimeoutStopSec` در systemd سی ثانیه است، پس پیش‌فرض کمتر از
 * آن گرفته شده تا خودمان تمام کنیم نه اینکه systemd با `SIGKILL` بزند.
 */
export async function drain(timeoutMs = 25_000): Promise<{ finished: boolean; active: number }> {
  const dropped = pending.splice(0, pending.length);
  for (const j of dropped) logger.warn({ jobId: j.id }, "کار صف‌نشده هنگام خاموشی دور ریخته شد");

  const deadline = Date.now() + timeoutMs;
  while (active.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return { finished: active.size === 0, active: active.size };
}

