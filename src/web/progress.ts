/**
 * پیشرفت کار برای کلاینت وب.
 *
 * ربات پیشرفت را با ویرایش یک پیام نشان می‌دهد؛ وب چنین کانالی ندارد. ساده‌ترین
 * چیزی که کار می‌کند: آخرین وضعیتِ هر جلسه در حافظه بماند و کلاینت هر چند
 * ثانیه بپرسد.
 *
 * چرا در حافظه و نه در پایگاه‌داده: این داده در ثانیه چند بار عوض می‌شود و
 * عمرش به عمر همان کار است. ستون `status` جدول `sessions` وضعیت **ماندگار**
 * را دارد (و خط لوله خودش می‌نویسدش)، پس اگر سرور وسط کار بازراه‌اندازی شود،
 * کلاینت از همان ستون می‌فهمد کجاست — فقط جزئیات لحظه‌ای را از دست می‌دهد.
 */

import type { Stage } from "../pipeline.js";

export interface JobProgress {
  stage: Stage["stage"] | "done" | "error";
  detail?: string;
  updatedAt: number;
  /** فقط وقتی stage برابر error است */
  message?: string;
}

const state = new Map<string, JobProgress>();

/** کارهای تمام‌شده بعد از این مدت از حافظه پاک می‌شوند. */
const TTL_MS = 30 * 60_000;

export function setProgress(sessionId: string, p: Omit<JobProgress, "updatedAt">): void {
  state.set(sessionId, { ...p, updatedAt: Date.now() });
}

export function getProgress(sessionId: string): JobProgress | null {
  return state.get(sessionId) ?? null;
}

export function clearProgress(sessionId: string): void {
  state.delete(sessionId);
}

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, p] of state) {
    if (p.updatedAt < cutoff) state.delete(id);
  }
}, 5 * 60_000).unref();
