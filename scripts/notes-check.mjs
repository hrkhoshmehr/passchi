/**
 * جزوهٔ یک کلاس را می‌سازد و می‌سنجد — برای وقتی که می‌خواهی بدانی روی
 * **این درس** چه درمی‌آید، نه روی کلاسِ نمونه.
 *
 * ## چه چیزی را می‌سنجد و چرا
 *
 * • **طول.** با کفِ واقعی سنجیده می‌شود: `notesBudget` همان جدولی را
 *   می‌سازد که به مدل داده می‌شود، پس سنجه و خواسته یکی‌اند. آستانهٔ قبلی
 *   («۱۲ کلمه بر دقیقهٔ کلاس») یک‌سومِ خواسته بود و به جزوهٔ ۱۸۸۸ کلمه‌ای
 *   برای کلاسی که ۲۹۲۰ کلمه می‌خواست، «سالم» می‌داد.
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
import { analyzeClass, notesBudget } from "../src/analysis/analyze.ts";

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
// اسکلتِ پاس ۱ کنارِ جزوه نوشته می‌شود: وقتی مطلبی از جزوه غایب است، اول
// باید دید اصلاً در topics آمده یا نه — وگرنه دنبال ایرادِ پاس ۲ می‌گردی.
if (OUT) fs.writeFileSync(OUT.replace(/\.md$/, "") + ".report.json", JSON.stringify(report, null, 2), "utf8");

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

/**
 * سنجهٔ طول باید **همان چیزی** باشد که به مدل داده‌ایم، نه عددی جدا.
 *
 * پیش‌تر آستانه «۱۲ کلمه بر دقیقهٔ کلاس» بود، در حالی که پرامپت «چهارصد کلمه
 * به‌ازای هر ده دقیقه تدریس» می‌خواست. فاصلهٔ این دو عدد یعنی جزوه‌ای که
 * یک‌سومِ خواسته بود اینجا «✅ سالم» می‌گرفت — و دقیقاً همین سبزِ دروغین
 * باعث شد ماه‌ها معلوم نشود قاعده اصلاً رعایت نمی‌شود.
 *
 * پس بودجه از خودِ `notesBudget` خوانده می‌شود، همان تابعی که جدولش را به
 * پاس دوم می‌فرستد. اگر روزی نرخ یا دسته‌ها عوض شوند، هر دو با هم عوض
 * می‌شوند.
 */
const budget = notesBudget(report.chapters);
const target = budget.reduce((s, c) => s + c.floor, 0);
const budgetMin = budget.reduce((s, c) => s + c.minutes, 0);
console.log(
  `بخش‌های درسی: ${Math.round(budgetMin)} دقیقه → کف ${target} کلمه · جزوه ${words} کلمه ` +
    `(٪${Math.round((words / Math.max(1, target)) * 100)} کف)`,
);
console.log(`تأکیدها: ${emphLines.length} بلوک، ${emphWords} کلمه (٪${Math.round((emphWords / words) * 100)} جزوه)`);
console.log(`«خارج از کلاس»: ${(md.match(/خارج از کلاس/g) ?? []).length}   (حداکثر ۳)`);
console.log(`ریاضی: ${inlineMath.length} درون‌خطی، ${blockMath.length} بلوکی، ${faMath.length} با کلمهٔ فارسی`);

// ابزارهای دیداری سهمیه دارند و سهمیه سقف است نه هدف — عدد صفر هشدار نیست،
// عددِ بالای سقف هست: یعنی جزوه دارد به کادر تبدیل می‌شود.
const countLabel = (label) =>
  md.split("\n").filter((l) => l.trimStart().startsWith(">") && l.includes(`**${label}**`)).length;
const visuals = {
  "کادر تعریف": [countLabel("تعریف"), 4],
  "کادر مثال": [countLabel("مثال"), 4],
  جدول: [(md.match(/^\s*\|.*\|\s*$/gm) ?? []).length ? (md.match(/^\s*\|\s*:?-+/gm) ?? []).length : 0, 3],
  درخت: [(md.match(/^```\s*(tree|درخت)\s*$/gm) ?? []).length, 3],
  زنجیره: [(md.match(/^```\s*(flow|فلو|زنجیره)\s*$/gm) ?? []).length, 3],
};
console.log(
  "ابزار دیداری: " +
    Object.entries(visuals)
      .map(([k, [n, cap]]) => `${k} ${n}/${cap}${n > cap ? " ⚠️" : ""}`)
      .join(" · "),
);
console.log(`واژه‌نامه: ${report.glossary.length} · نکات باز: ${report.open_questions.length}`);
console.log("\nسرفصل‌های سطح دو:");
for (const h of md.match(/^## .+$/gm) ?? []) console.log("  " + h.replace(/^## /, ""));

// «لاغر» یعنی زیر کفِ خودِ پرامپت، با کمی رواداری برای تخمینِ شمار کلمه
const thin = words < target * 0.85;
const emphHeavy = emphWords / words > 0.15;
if (thin)
  console.log(
    `\n⚠️ جزوه لاغر است — ${words} کلمه در برابر کفِ ${target} کلمه برای ${Math.round(budgetMin)} دقیقه بخشِ درسی`,
  );
if (emphHeavy) console.log("⚠️ سهم تأکیدها زیاد است — جزوه دارد کارِ پیام گزارش را تکرار می‌کند");
if (!thin && !emphHeavy) console.log("\n✅ نسبت‌ها سالم‌اند");
