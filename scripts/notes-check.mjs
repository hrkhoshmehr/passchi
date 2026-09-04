/**
 * جزوهٔ یک کلاس را می‌سازد و می‌سنجد — برای وقتی که می‌خواهی بدانی روی
 * **این درس** چه درمی‌آید، نه روی کلاسِ نمونه.
 *
 * ## چه چیزی را می‌سنجد و چرا
 *
 * • **طول و ساختار.** جزوهٔ لاغر یک بار اتفاق افتاده و از عدد پیدا شد نه از
 *   نگاه: حدود ۹۰۰ کلمه و هشت سرفصل برای یک کلاس ۹۴ دقیقه‌ای.
 * • **سهم تأکیدها.** جزوه نباید فهرستِ «تأکید استاد» باشد؛ آن‌ها جدا نشان
 *   داده می‌شوند. اگر سهمشان از چند درصد بگذرد، جزوه دارد کارِ پیام گزارش
 *   را تکرار می‌کند.
 * • **ریاضی.** درس فنی فرمول دارد و درس نظری هم گاهی مدل را وسوسه می‌کند که
 *   رابطه‌اش را با نمادِ ریاضی بنویسد. فرمولی که کلمهٔ فارسی داشته باشد
 *   نباید به KaTeX برود (متریکِ فارسی ندارد و جهت را برعکس می‌کند).
 * • **«خارج از کلاس».** حداکثر سه مورد مجاز است.
 *
 *   npx tsx scripts/notes-check.mjs data/cache/<hash>.soniox.json [خروجی.md]
 *
 * رونوشت از کش خوانده می‌شود، پس فقط هزینهٔ مدل را می‌دهی.
 */
import fs from "node:fs";
import { buildTranscript } from "../src/stt/transcript.ts";
import { analyzeClass } from "../src/analysis/analyze.ts";

const CACHE = process.argv[2];
const OUT = process.argv[3] ?? null;

if (!CACHE || !fs.existsSync(CACHE)) {
  console.error("مسیرِ رونوشتِ کش‌شده را بده:\n  npx tsx scripts/notes-check.mjs data/cache/<hash>.soniox.json");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const t = buildTranscript(raw.transcript.tokens, { toOriginal: (ms) => ms, skippedMs: 0 });
const durationMs = raw.transcription?.audio_duration_ms ?? 0;

const { report, notesMarkdown: md, notesError } = await analyzeClass(t, {
  courseName: null,
  professorName: null,
  sessionDate: null,
  originalDurationMs: durationMs,
  silenceMs: 0,
  speakerSummary: "نامشخص",
  qualityNote: "",
});

if (notesError) {
  console.error("ساخت جزوه شکست خورد:", notesError);
  process.exit(1);
}
if (OUT) fs.writeFileSync(OUT, md, "utf8");

const words = md.split(/\s+/).filter(Boolean).length;
const heads = md.match(/^#{1,4} .+$/gm) ?? [];
const emphLines = md.split("\n").filter((l) => l.includes("تأکید استاد"));
const emphWords = emphLines.join(" ").split(/\s+/).filter(Boolean).length;
const inlineMath = md.match(/(^|[^\\$])\$([^$\n]+?)\$/g) ?? [];
const blockMath = md.match(/\$\$([\s\S]+?)\$\$/g) ?? [];
const faMath = [...inlineMath, ...blockMath].filter((s) => /[؀-ۿ]/.test(s));
const minutes = Math.round(durationMs / 60000);

console.log(`عنوان: ${report.class_recap ? (heads[0] ?? "").replace(/^#+ /, "") : "—"}`);
console.log(`مدت: ${minutes} دقیقه · بخش‌ها: ${report.chapters.length} · نکته‌ها: ${report.key_points.length}`);
console.log(`جزوه: ${words} کلمه · ${heads.length} سرفصل · ${(md.match(/^\s*[-*] /gm) ?? []).length} بولت`);
console.log(`کلمه بر دقیقهٔ کلاس: ${(words / Math.max(1, minutes)).toFixed(1)}`);
console.log(`تأکیدها: ${emphLines.length} بلوک، ${emphWords} کلمه (٪${Math.round((emphWords / words) * 100)} جزوه)`);
console.log(`«خارج از کلاس»: ${(md.match(/خارج از کلاس/g) ?? []).length}   (حداکثر ۳)`);
console.log(`ریاضی: ${inlineMath.length} درون‌خطی، ${blockMath.length} بلوکی، ${faMath.length} با کلمهٔ فارسی`);
console.log(`واژه‌نامه: ${report.glossary.length} · نکات باز: ${report.open_questions.length}`);
console.log("\nسرفصل‌های سطح دو:");
for (const h of md.match(/^## .+$/gm) ?? []) console.log("  " + h.replace(/^## /, ""));

const thin = words / Math.max(1, minutes) < 12;
const emphHeavy = emphWords / words > 0.15;
if (thin) console.log("\n⚠️ جزوه برای این مدت لاغر است");
if (emphHeavy) console.log("⚠️ سهم تأکیدها زیاد است — جزوه دارد کارِ پیام گزارش را تکرار می‌کند");
if (!thin && !emphHeavy) console.log("\n✅ نسبت‌ها سالم‌اند");
