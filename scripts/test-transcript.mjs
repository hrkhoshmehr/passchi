import { TimeMap } from "../src/audio/ffmpeg.js";
import { buildTranscript, renderForModel, verifyQuote } from "../src/stt/transcript.js";

// شبیه‌سازی توکن‌های Soniox روی فایل *پردازش‌شده* (سکوت‌ها حذف شده‌اند)
function tok(text, startMs, speaker, confidence = 0.95) {
  return { text, start_ms: startMs, end_ms: startMs + 400, speaker, confidence };
}

const words = [
  ["سلام ", 0, "1"], ["بچه‌ها ", 400, "1"], ["لیست ", 900, "1"], ["رو ", 1300, "1"],
  ["می‌خونم ", 1700, "1"], ["هرکی ", 2100, "1"], ["نبود ", 2500, "1"], ["غیبت ", 2900, "1"],
  ["می‌خوره ", 3300, "1"],
  ["استاد ", 6000, "2"], ["ببخشید ", 6400, "2"], ["تکلیف ", 6800, "2"], ["کی ", 7200, "2"], ["هست ", 7600, "2"],
  ["سری ", 12000, "1"], ["سه ", 12400, "1"], ["رو ", 12800, "1"], ["بردارید ", 13200, "1"],
  ["تا ", 13600, "1"], ["شنبه ", 14000, "1"], ["تحویل ", 14400, "1"], ["بدید ", 14800, "1"],
  ["و ", 20000, "1"], ["این ", 20400, "1"], ["تیپ ", 20800, "1"], ["سؤال ", 21200, "1"],
  ["سطح ", 21600, "1"], ["تراز ", 22000, "1"], ["تو ", 22400, "1"], ["میان‌ترم ", 22800, "1"], ["هست ", 23200, "1"],
];

const tokens = words.map(([t, ms, sp]) => tok(t, ms, sp));

// نقشهٔ زمان: ۱۰ ثانیه سکوت پیش از ثانیهٔ ۱۲ فایل پردازش‌شده حذف شده بود
const timeMap = new TimeMap([
  { origStartMs: 0, origEndMs: 12000, newStartMs: 0, newEndMs: 12000 },
  { origStartMs: 22000, origEndMs: 45000, newStartMs: 12000, newEndMs: 35000 },
]);

const t = buildTranscript(tokens, timeMap);

console.log("── رونوشت آماده برای مدل ──");
console.log(renderForModel(t));

console.log("\n── گوینده‌ها ──");
for (const s of t.speakers) {
  console.log(`  ${s.speakerId}: نقش=${s.role} گفتار=${s.speechMs}ms نوبت=${s.turns} کلمه=${s.words}`);
}

console.log("\n── راستی‌آزمایی نقل‌قول ──");
const cases = [
  ["سری سه رو بردارید تا شنبه تحویل بدید", "باید تأیید شود — عین متن"],
  ["سری ۳ رو بردارید تا شنبه تحویل بدید", "باید تأیید شود — رقم فارسی/لاتین"],
  ["لیست رو میخونم هرکی نبود غیبت میخوره", "باید تأیید شود — بدون نیم‌فاصله"],
  ["این تیپ سوال سطح تراز تو میانترم هست", "باید تأیید شود — املای متفاوت"],
  ["امتحان پایان‌ترم هفتهٔ آینده برگزار می‌شود", "باید رد شود — در صوت نبوده"],
  ["فردا کلاس تعطیل است و جبرانی می‌گذاریم", "باید رد شود — توهم مدل"],
];
for (const [q, expect] of cases) {
  const m = verifyQuote(t, q);
  const mark = m.ok ? "✅ تأیید" : "❌ رد   ";
  console.log(`  ${mark} score=${m.score.toFixed(2)} at=${m.atMs}ms  «${q}»`);
  console.log(`           انتظار: ${expect}`);
}

console.log("\n── نگاشت زمان (پردازش‌شده → اصلی) ──");
console.log("  توکن «سری» در 12000ms پردازش‌شده →", timeMap.toOriginal(12000), "ms اصلی (انتظار ۲۲۰۰۰)");
