import { config } from "./config.js";
import { logger } from "./util/logger.js";

interface Job {
  id: string;
  run: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
}

const pending: Job[] = [];
const active = new Map<string, Job>();

function pump(): void {
  while (active.size < config.MAX_CONCURRENT_JOBS && pending.length > 0) {
    const job = pending.shift()!;
    active.set(job.id, job);
    void job
      .run(job.controller.signal)
      .catch((e: unknown) => logger.error({ jobId: job.id, err: String(e) }, "job failed"))
      .finally(() => {
        active.delete(job.id);
        pump();
      });
  }
}

export function enqueue(id: string, run: (signal: AbortSignal) => Promise<void>): number {
  const job: Job = { id, run, controller: new AbortController() };
  pending.push(job);
  const position = pending.length;
  pump();
  return active.has(id) ? 0 : position;
}

export function cancel(id: string): boolean {
  const idx = pending.findIndex((j) => j.id === id);
  if (idx >= 0) {
    pending.splice(idx, 1);
    return true;
  }
  const job = active.get(id);
  if (job) {
    job.controller.abort();
    return true;
  }
  return false;
}

export function isBusy(id: string): boolean {
  return active.has(id) || pending.some((j) => j.id === id);
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

