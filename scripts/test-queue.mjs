/**
 * صف: سقفِ همزمانی و «هر کاربر یک کار».
 *
 * ## باگی که این آزمون را لازم کرد
 *
 * کارهای در جریان در یک `Map` با کلیدِ شناسهٔ کاربر نگه داشته می‌شدند. دو کارِ
 * هم‌زمانِ یک نفر روی هم می‌افتادند، پس `active.size` بالا نمی‌رفت و سقفِ
 * `MAX_CONCURRENT_JOBS` بی‌اثر می‌شد. با پنج کارِ یک کاربر، هر پنج‌تا هم‌زمان
 * اجرا می‌شدند — روی سروری که هم‌زمان ffmpeg و کرومیوم هم دارد یعنی کمبود
 * حافظه.
 *
 * مسیر رسیدن به آن فرضی نبود: مسیر ربات پیش از صف‌کردن `isBusy` می‌زند، ولی
 * مسیر تأییدِ سرور وب نمی‌زد.
 */
import { config } from "../src/config.ts";
import { enqueue, isBusy, cancel, queueDepth } from "../src/queue.ts";

const LIMIT = config.MAX_CONCURRENT_JOBS;
let bad = 0;
const fail = (m) => { console.log(`❌ ${m}`); bad++; };

let running = 0;
let peakTotal = 0;
const peakPerUser = new Map();
const now = new Map();

const job = (user, ms) => () =>
  enqueue(user, async () => {
    running++;
    const n = (now.get(user) ?? 0) + 1;
    now.set(user, n);
    peakTotal = Math.max(peakTotal, running);
    peakPerUser.set(user, Math.max(peakPerUser.get(user) ?? 0, n));
    await new Promise((r) => setTimeout(r, ms));
    now.set(user, now.get(user) - 1);
    running--;
  });

// ── ۱) پنج کار از یک کاربر ────────────────────────────────────────────────
for (let i = 0; i < 5; i++) job("u1", 40)();

if (!isBusy("u1")) fail("isBusy باید بلافاصله پس از صف‌کردن true باشد");

await new Promise((r) => setTimeout(r, 400));

if (peakPerUser.get("u1") > 1) {
  fail(`یک کاربر ${peakPerUser.get("u1")} کارِ هم‌زمان داشت — باید ۱ باشد`);
}
if (peakTotal > LIMIT) fail(`همزمانی به ${peakTotal} رسید — سقف ${LIMIT} است`);
if (isBusy("u1")) fail("پس از تمام‌شدن همه، isBusy باید false باشد");

// ── ۲) کاربرهای متفاوت باید موازی بروند، تا سقف ──────────────────────────
peakTotal = 0;
running = 0;
for (let i = 0; i < LIMIT + 2; i++) job(`v${i}`, 40)();
await new Promise((r) => setTimeout(r, 400));

if (peakTotal !== LIMIT) {
  fail(`کاربرهای متفاوت باید تا سقف موازی بروند — بیشینه ${peakTotal}، سقف ${LIMIT}`);
}

// ── ۳) لغو، هم کارِ در صف و هم کارِ در جریان را بردارد ────────────────────
running = 0;
for (let i = 0; i < 3; i++) job("w1", 200)();
if (!cancel("w1")) fail("cancel باید true برگرداند وقتی کاری هست");
if (isBusy("w1") && queueDepth().pending > 0) fail("پس از لغو نباید کاری در صف بماند");

await new Promise((r) => setTimeout(r, 300));

console.log(bad === 0 ? "✅ صف: سقف همزمانی و «هر کاربر یک کار» درست کار می‌کند." : `${bad} مورد اشتباه.`);
process.exit(bad === 0 ? 0 : 1);
