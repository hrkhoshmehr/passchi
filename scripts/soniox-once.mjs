/**
 * یک بار Soniox، برای همیشه.
 *
 * پاسخ خام روی دیسک ذخیره می‌شود و اجرای بعدی همان را می‌خواند. مادامی که
 * فایل کش هست، هیچ درخواستی به API نمی‌رود — پس این اسکریپت را می‌شود آزادانه
 * دوباره اجرا کرد بدون اینکه ریالی خرج شود.
 *
 *   npx tsx scripts/soniox-once.mjs example.mp3
 *   npx tsx scripts/soniox-once.mjs example.mp3 --force   # فقط با نیت صریح
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fingerprint } from "../src/stt/cache.js";
import { preprocess } from "../src/audio/preprocess.js";
import { transcribe } from "../src/stt/soniox.js";
import { config } from "../src/config.js";
import { fmtDuration } from "../src/util/time.js";

const input = process.argv[2];
const force = process.argv.includes("--force");
if (!input) {
  console.error("استفاده: npx tsx scripts/soniox-once.mjs <audio-file> [--force]");
  process.exit(1);
}

const cacheDir = path.join(config.dataDir, "cache");
await fs.mkdir(cacheDir, { recursive: true });

// نام کش از محتوای فایل می‌آید نه از اسمش، تا تغییر نام باعث پرداخت دوباره نشود
const digest = await fingerprint(input);
const base = `${path.basename(input, path.extname(input))}.${digest}`;
const rawPath = path.join(cacheDir, `${base}.soniox.json`);
const prePath = path.join(cacheDir, `${base}.preprocess.json`);

const cached = await fs.readFile(rawPath, "utf8").catch(() => null);
if (cached && !force) {
  const c = JSON.parse(cached);
  console.log("✅ از کش خوانده شد — هیچ درخواستی به Soniox نرفت.");
  console.log("   فایل:", rawPath);
  console.log("   توکن‌ها:", c.transcript?.tokens?.length ?? 0);
  console.log("\nبرای گزارش ساختار: npx tsx scripts/soniox-report.mjs", base);
  process.exit(0);
}

if (force && cached) {
  console.log("⚠️  --force داده شده: این اجرا دوباره از Soniox هزینه می‌گیرد.");
}

// ── ۱) پیش‌پردازش ──────────────────────────────────────────────────────────
console.log("در حال پیش‌پردازش…");
const pre = await preprocess(input, base);
const preMeta = {
  source: pre.source,
  originalDurationMs: pre.originalDurationMs,
  billedDurationMs: pre.billedDurationMs,
  savedMs: pre.savedMs,
  outSizeBytes: pre.outSizeBytes,
  quality: pre.quality,
  steps: pre.steps,
  transcoded: pre.transcoded,
  elapsedMs: pre.elapsedMs,
  timeMap: pre.timeMap.toJSON(),
};
await fs.writeFile(prePath, JSON.stringify(preMeta, null, 2), "utf8");

console.log(`  مدت اصلی:        ${fmtDuration(pre.originalDurationMs)}`);
console.log(`  مدت ارسالی:      ${fmtDuration(pre.billedDurationMs)}  (مبنای هزینه)`);
console.log(`  صرفه‌جویی:        ${fmtDuration(pre.savedMs)}`);
console.log(`  حجم:             ${Math.round(pre.source.sizeBytes / 1024)}KB → ${Math.round(pre.outSizeBytes / 1024)}KB`);
console.log(`  ترنسکد:          ${pre.transcoded ? "بله" : "خیر (فایل اصلی مستقیم می‌رود)"}`);
console.log(`  زمان پیش‌پردازش: ${(pre.elapsedMs / 1000).toFixed(1)} ثانیه`);
console.log(`  کیفیت:           ${pre.quality.level}`);
for (const w of pre.quality.warnings) console.log(`    ⚠️ ${w}`);

// ── ۲) یک تماس با Soniox ──────────────────────────────────────────────────
const billedHours = pre.billedDurationMs / 3_600_000;
console.log(`\nارسال به Soniox (${config.SONIOX_MODEL}) — تخمین هزینه ${(billedHours * 0.1).toFixed(3)} دلار`);

const t0 = Date.now();
const result = await transcribe({
  filePath: pre.processedFile,
  languageHints: ["fa", "en"],
  clientReferenceId: base,
  onStatus: (s) => console.log("  وضعیت:", s),
});
const elapsed = Math.round((Date.now() - t0) / 1000);

await fs.writeFile(
  rawPath,
  JSON.stringify(
    {
      savedAt: new Date().toISOString(),
      sourceFile: path.basename(input),
      sha256Prefix: digest,
      model: config.SONIOX_MODEL,
      elapsedSec: elapsed,
      preprocess: preMeta,
      transcription: result.raw.transcription,
      transcript: result.raw.transcript,
    },
    null,
    2,
  ),
  "utf8",
);

// وقتی ترنسکد نشده، processedFile خودِ فایل ورودی است — پاکش نکن
if (pre.transcoded) await fs.unlink(pre.processedFile).catch(() => {});

console.log(`\n✅ ذخیره شد در ${rawPath}`);
console.log(`   ${result.tokens.length} توکن، ${elapsed} ثانیه پردازش، زبان‌ها: ${result.languages.join(", ")}`);
console.log("\nگزارش ساختار: npx tsx scripts/soniox-report.mjs", base);
