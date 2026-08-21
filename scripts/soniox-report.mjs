/**
 * گزارش ساختار پاسخ Soniox — کاملاً آفلاین، روی فایل کش‌شده.
 *
 * جواب می‌دهد به: چه فیلدهایی واقعاً برمی‌گردند، دیارایزیشن چطور رفتار کرده،
 * اطمینان مدل کجاها افت کرده، رونوشت رندرشده چند توکن برای Claude است، و
 * کدام پیش‌پردازش چقدر صرفه داشته یا می‌توانست داشته باشد.
 *
 *   npx tsx scripts/soniox-report.mjs <cache-base>
 *   npx tsx scripts/soniox-report.mjs            # آخرین کش
 */

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";
import { TimeMap } from "../src/audio/ffmpeg.js";
import { buildTranscript, renderForModel } from "../src/stt/transcript.js";
import { fmtClock, fmtDuration } from "../src/util/time.js";

const cacheDir = path.join(config.dataDir, "cache");
let base = process.argv[2];
if (!base) {
  const files = (await fs.readdir(cacheDir).catch(() => []))
    .filter((f) => f.endsWith(".soniox.json"))
    .sort();
  base = files.at(-1)?.replace(/\.soniox\.json$/, "");
}
if (!base) {
  console.error("کشی پیدا نشد. اول این را اجرا کن: npx tsx scripts/soniox-once.mjs <audio>");
  process.exit(1);
}

const raw = JSON.parse(await fs.readFile(path.join(cacheDir, `${base}.soniox.json`), "utf8"));
const tokens = raw.transcript?.tokens ?? [];
const pre = raw.preprocess ?? {};

const h = (s) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}\x1b[0m`);
const pctOf = (a, b) => (b ? ((a / b) * 100).toFixed(1) : "0.0");

// ── ۱) شکل پاسخ ────────────────────────────────────────────────────────────
h("شکل پاسخ");
console.log("کلیدهای transcription:", Object.keys(raw.transcription ?? {}).join(", "));
console.log("کلیدهای transcript:   ", Object.keys(raw.transcript ?? {}).join(", "));
const fieldCounts = new Map();
for (const t of tokens) for (const k of Object.keys(t)) fieldCounts.set(k, (fieldCounts.get(k) ?? 0) + 1);
console.log("فیلدهای توکن:");
for (const [k, n] of [...fieldCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} در ${pctOf(n, tokens.length)}٪ توکن‌ها`);
}
console.log("\nنمونهٔ سه توکن اول:");
for (const t of tokens.slice(0, 3)) console.log("  " + JSON.stringify(t));

// ── ۲) توکن‌ها ─────────────────────────────────────────────────────────────
h("توکن‌ها");
const words = tokens.filter((t) => /\S/.test(t.text) && /[\p{L}\p{N}]/u.test(t.text));
const punct = tokens.filter((t) => /^[^\p{L}\p{N}\s]+$/u.test(t.text));
const spacing = tokens.filter((t) => !/\S/.test(t.text));
console.log(`کل توکن‌ها:   ${tokens.length}`);
console.log(`  واژه‌دار:   ${words.length}  (${pctOf(words.length, tokens.length)}٪)`);
console.log(`  نقطه‌گذاری: ${punct.length}  (${pctOf(punct.length, tokens.length)}٪)`);
console.log(`  فاصله/خالی: ${spacing.length}`);
const text = raw.transcript?.text ?? "";
console.log(`طول متن کامل: ${text.length} کاراکتر، ${text.split(/\s+/).filter(Boolean).length} کلمه`);

// ── ۳) زبان ────────────────────────────────────────────────────────────────
h("تشخیص زبان");
const byLang = new Map();
for (const t of words) byLang.set(t.language ?? "—", (byLang.get(t.language ?? "—") ?? 0) + 1);
for (const [lang, n] of [...byLang].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(lang).padEnd(6)} ${String(n).padStart(6)} توکن  (${pctOf(n, words.length)}٪)`);
}

// ── ۴) گوینده‌ها ───────────────────────────────────────────────────────────
h("دیارایزیشن");
const bySpk = new Map();
for (const t of tokens) {
  const k = t.speaker ?? "—";
  const s = bySpk.get(k) ?? { tokens: 0, ms: 0, switches: 0 };
  s.tokens++;
  s.ms += Math.max(0, (t.end_ms ?? 0) - (t.start_ms ?? 0));
  bySpk.set(k, s);
}
let switches = 0;
for (let i = 1; i < tokens.length; i++) if (tokens[i].speaker !== tokens[i - 1].speaker) switches++;
for (const [spk, s] of [...bySpk].sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(`  گوینده ${String(spk).padEnd(4)} ${String(s.tokens).padStart(6)} توکن، ${fmtDuration(s.ms).padStart(18)}  (${pctOf(s.tokens, tokens.length)}٪)`);
}
console.log(`تعویض گوینده: ${switches} بار`);
if (switches > words.length / 20) {
  console.log("  ⚠️ نرخ تعویض بالاست — احتمالاً دیارایزیشن ناپایدار بوده.");
}

// ── ۵) اطمینان ─────────────────────────────────────────────────────────────
h("اطمینان مدل");
const confs = words.map((t) => t.confidence ?? 1).sort((a, b) => a - b);
const q = (p) => confs[Math.floor(confs.length * p)] ?? 0;
console.log(`  کمینه ${confs[0]?.toFixed(3)}  ص۱۰ ${q(0.1)?.toFixed(3)}  میانه ${q(0.5)?.toFixed(3)}  ص۹۰ ${q(0.9)?.toFixed(3)}`);
console.log(`  میانگین: ${(confs.reduce((a, b) => a + b, 0) / (confs.length || 1)).toFixed(3)}`);
for (const th of [0.3, 0.5, 0.7, 0.9]) {
  const n = confs.filter((c) => c < th).length;
  console.log(`  زیر ${th}: ${String(n).padStart(6)} واژه (${pctOf(n, words.length)}٪)`);
}

// بدترین ده بازهٔ ۳۰ ثانیه‌ای — جایی که ضبط ضعیف بوده
const buckets = new Map();
for (const t of words) {
  const b = Math.floor((t.start_ms ?? 0) / 30_000);
  const s = buckets.get(b) ?? { sum: 0, n: 0 };
  s.sum += t.confidence ?? 1;
  s.n++;
  buckets.set(b, s);
}
const worst = [...buckets]
  .filter(([, s]) => s.n >= 10)
  .map(([b, s]) => [b, s.sum / s.n])
  .sort((a, b) => a[1] - b[1])
  .slice(0, 8);
console.log("\nضعیف‌ترین بازه‌های ۳۰ ثانیه‌ای (روی فایل پردازش‌شده):");
for (const [b, avg] of worst) console.log(`  ${fmtClock(b * 30_000, true)}  میانگین ${avg.toFixed(3)}`);

// ── ۶) رونوشت ساخته‌شده و هزینهٔ تحلیل ────────────────────────────────────
h("رونوشت ساخته‌شده");
const timeMap = new TimeMap(pre.timeMap ?? []);
const built = buildTranscript(tokens, timeMap);
const rendered = renderForModel(built);
console.log(`پاره‌گفتار: ${built.utterances.length}`);
console.log(`گوینده‌ها:  ${built.speakers.map((s) => `${s.role}=${s.speakerId} (${fmtDuration(s.speechMs)})`).join("، ")}`);
console.log(`نسبت اطمینان پایین: ${(built.lowConfidenceRatio * 100).toFixed(1)}٪`);
console.log(`طول رونوشت رندرشده: ${rendered.length} کاراکتر`);

// فارسی به‌ازای هر توکن حدود ۲ تا ۲٫۵ کاراکتر می‌گیرد؛ برای برآورد کافی است
const estTokens = Math.round(rendered.length / 2.3);
console.log(`تخمین توکن Claude: ~${estTokens.toLocaleString("en-US")}`);
console.log(`  پاس ۱ ورودی (نوشتن کش، Opus 5): ~$${((estTokens * 5 * 1.25) / 1e6).toFixed(3)}`);
console.log(`  پاس ۲ ورودی (خواندن کش):        ~$${((estTokens * 5 * 0.1) / 1e6).toFixed(3)}`);
console.log(`  همان ورودی روی Sonnet 5:        ~$${((estTokens * 3 * 1.25) / 1e6).toFixed(3)}`);

console.log("\nده خط اول رونوشت:");
for (const line of rendered.split("\n").slice(0, 10)) console.log("  " + line.slice(0, 150));

// ── ۷) پیش‌پردازش ──────────────────────────────────────────────────────────
h("پیش‌پردازش — چه چیزی صرفه داشت");
console.log(`منبع: ${pre.source?.codec} ${pre.source?.sampleRate}Hz ${pre.source?.channels}ch ${Math.round((pre.source?.bitRate ?? 0) / 1000)}kbps`);
console.log(`حجم: ${Math.round((pre.source?.sizeBytes ?? 0) / 1024)}KB → ${Math.round((pre.outSizeBytes ?? 0) / 1024)}KB  (${((pre.source?.sizeBytes ?? 1) / (pre.outSizeBytes || 1)).toFixed(1)}× کوچک‌تر)`);
console.log(`مدت: ${fmtDuration(pre.originalDurationMs ?? 0)} → ${fmtDuration(pre.billedDurationMs ?? 0)}`);
const savedUsd = ((pre.savedMs ?? 0) / 3_600_000) * 0.1;
console.log(`سکوت حذف‌شده: ${fmtDuration(pre.savedMs ?? 0)} = ${pctOf(pre.savedMs ?? 0, pre.originalDurationMs ?? 1)}٪  ≈ $${savedUsd.toFixed(3)} صرفه`);
console.log(`کیفیت: ${pre.quality?.level} (گسترهٔ بلندی ${pre.quality?.loudnessRangeDb} LU)`);
for (const w of pre.quality?.warnings ?? []) console.log(`  ⚠️ ${w}`);
for (const n of pre.quality?.notes ?? []) console.log(`  ℹ️ ${n}`);

// ── ۸) سرفصل‌های ممکن از روی خود داده ─────────────────────────────────────
h("شکاف‌های گفتاری (کاندید مرز موضوع)");
const gaps = [];
for (let i = 1; i < built.utterances.length; i++) {
  const gap = built.utterances[i].startMs - built.utterances[i - 1].endMs;
  if (gap > 3000) gaps.push({ atMs: built.utterances[i].startMs, gap });
}
gaps.sort((a, b) => b.gap - a.gap);
console.log(`${gaps.length} شکاف بیش از ۳ ثانیه. ده تای بزرگ‌تر:`);
for (const g of gaps.slice(0, 10)) {
  console.log(`  ${fmtClock(g.atMs, true)}  پس از ${(g.gap / 1000).toFixed(1)} ثانیه سکوت`);
}
console.log("\n(اینها بدون هیچ مدلی از خود سیگنال درمی‌آیند — نامزد خوبی برای مرز فصل‌ها هستند.)");
