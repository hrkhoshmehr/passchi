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
