import { preprocess } from "../src/audio/preprocess.js";
import { fmtDuration } from "../src/util/time.js";

const file = process.argv[2] ?? "data/audio/test.wav";
const r = await preprocess(file, "smoketest");

console.log("\n── نتیجهٔ پیش‌پردازش ──");
console.log("منبع:", r.source.codec, r.source.sampleRate + "Hz", r.source.channels + "ch",
  Math.round(r.source.sizeBytes / 1024) + "KB");
console.log("مدت اصلی:", fmtDuration(r.originalDurationMs), `(${r.originalDurationMs}ms)`);
console.log("مدت پس از حذف سکوت:", fmtDuration(r.billedDurationMs), `(${r.billedDurationMs}ms)`);
console.log("صرفه‌جویی:", fmtDuration(r.savedMs),
  `= ${Math.round((r.savedMs / r.originalDurationMs) * 100)}٪`);
console.log("حجم خروجی:", Math.round(r.outSizeBytes / 1024) + "KB",
  `(نسبت فشرده‌سازی ${(r.source.sizeBytes / r.outSizeBytes).toFixed(1)}×)`);
console.log("کیفیت:", r.quality.level, "| گسترهٔ بلندی:", r.quality.loudnessRangeDb, "LU",
  "| بلندی گفتار:", r.quality.speechLufs, "LUFS | اوج:", r.quality.truePeakDb, "dBTP");
console.log("ترنسکد شد؟", r.transcoded ? "بله" : "خیر — فایل اصلی مستقیم می‌رود");
console.log("زمان پیش‌پردازش:", (r.elapsedMs / 1000).toFixed(1), "ثانیه");
if (r.quality.warnings.length) console.log("هشدارها:", r.quality.warnings);
console.log("مراحل:");
for (const s of r.steps) console.log("  •", s);

console.log("\n── آزمون نگاشت زمان ──");
for (const t of [0, 1000, 5000, 9000, 14000]) {
  console.log(`  پردازش‌شده ${t}ms → اصلی ${r.timeMap.toOriginal(t)}ms`);
}
console.log("قطعه‌ها:", JSON.stringify(r.timeMap.toJSON()));
