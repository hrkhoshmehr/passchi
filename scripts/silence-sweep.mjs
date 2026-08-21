/**
 * جاروب آستانهٔ سکوت روی صوت واقعی.
 *
 * ادعای اولیه این بود که «حذف سکوت تنها اهرم واقعی هزینه است». روی صوت
 * مصنوعی درست بود چون سکوتش سکوتِ دیجیتال بود. کلاس واقعی نویز زمینهٔ پیوسته
 * دارد — کولر، همهمه، خش میکروفون — و ممکن است هیچ‌وقت زیر آستانه نرود.
 * این اسکریپت جواب واقعی را با اندازه‌گیری می‌دهد، نه با حدس.
 */

import { analyze, probe } from "../src/audio/ffmpeg.js";
import { fmtDuration } from "../src/util/time.js";

const file = process.argv[2] ?? "example.mp3";
const info = await probe(file);
const durationSec = info.durationMs / 1000;

console.log(`فایل: ${file}`);
console.log(`مدت: ${fmtDuration(info.durationMs)} · ${info.codec} ${info.sampleRate}Hz ${info.channels}ch ${Math.round(info.bitRate / 1000)}kbps\n`);

const thresholds = [-50, -45, -40, -35, -30, -27, -24, -21, -18];
const minDur = Number(process.argv[3] ?? 1.5);

console.log(`حداقل طول سکوت: ${minDur} ثانیه\n`);
console.log("آستانه   بازه‌ها   سکوت کل        نسبت    صرفه‌جویی Soniox");
console.log("─".repeat(66));

let best = null;
for (const db of thresholds) {
  const a = await analyze(file, info.durationMs, {
    highpassHz: 80,
    silenceThresholdDb: db,
    silenceMinDurationSec: minDur,
  });
  const ratio = (a.totalSilenceSec / durationSec) * 100;
  const usd = (a.totalSilenceSec / 3600) * 0.1;
  console.log(
    `${String(db).padStart(5)}dB  ${String(a.silences.length).padStart(6)}  ` +
      `${fmtDuration(a.totalSilenceSec * 1000).padStart(16)}  ${ratio.toFixed(1).padStart(5)}٪   $${usd.toFixed(4)}`,
  );
  if (!best) best = { db, a, ratio };
  // بلندی گفتار فقط یک بار لازم است
  if (db === -35 && a.loudnorm) {
    best.loudnorm = a.loudnorm;
    best.mean = a.meanVolumeDb;
    best.max = a.maxVolumeDb;
  }
}

console.log("\n── سطوح سیگنال ──");
const a35 = await analyze(file, info.durationMs, {
  highpassHz: 80,
  silenceThresholdDb: -35,
  silenceMinDurationSec: minDur,
});
console.log(`  mean_volume (شامل سکوت): ${a35.meanVolumeDb} dB`);
console.log(`  max_volume:              ${a35.maxVolumeDb} dB`);
if (a35.loudnorm) {
  console.log(`  input_i  (بلندی گفتار، گیت‌شده): ${a35.loudnorm.input_i} LUFS`);
  console.log(`  input_tp (اوج واقعی):            ${a35.loudnorm.input_tp} dBTP`);
  console.log(`  input_lra (گسترهٔ دینامیک):      ${a35.loudnorm.input_lra} LU`);
  console.log(`  input_thresh:                    ${a35.loudnorm.input_thresh} LUFS`);
  console.log(
    `\n  → کف نویز حدود ${(Number(a35.loudnorm.input_i) - Number(a35.loudnorm.input_lra)).toFixed(1)} LUFS تخمین زده می‌شود.`,
  );
  console.log(
    `    آستانهٔ سکوت باید بین کف نویز و بلندی گفتار بنشیند، نه روی عددی ثابت.`,
  );
}

console.log("\n── توزیع طول سکوت‌ها در آستانهٔ -30dB ──");
const a30 = await analyze(file, info.durationMs, {
  highpassHz: 80,
  silenceThresholdDb: -30,
  silenceMinDurationSec: 0.5,
});
const lens = a30.silences.map((s) => s.endSec - s.startSec).sort((x, y) => y - x);
const bucket = (lo, hi) => lens.filter((l) => l >= lo && l < hi);
for (const [lo, hi, label] of [
  [0.5, 1, "۰٫۵ تا ۱ ثانیه"],
  [1, 2, "۱ تا ۲ ثانیه"],
  [2, 5, "۲ تا ۵ ثانیه"],
  [5, 15, "۵ تا ۱۵ ثانیه"],
  [15, Infinity, "بیش از ۱۵ ثانیه"],
]) {
  const b = bucket(lo, hi);
  const total = b.reduce((x, y) => x + y, 0);
  console.log(`  ${label.padEnd(18)} ${String(b.length).padStart(5)} بازه، جمعاً ${fmtDuration(total * 1000)}`);
}
console.log(`  بلندترین سکوت: ${lens[0]?.toFixed(1) ?? 0} ثانیه`);
