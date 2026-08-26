/**
 * سلامتِ نمونه‌ای که به هر کاربر تازه نشان داده می‌شود.
 *
 * نمونه ویترین محصول است و دو بار گاف داده: یک بار نکته‌هایش از دروازهٔ
 * تأکید رد نمی‌شدند (یعنی همان تأکید ساختگی‌ای که دروازه برایش هست، در
 * ویترین نشسته بود)، و یک بار زمان‌هایش در ده دقیقهٔ اول فشرده شده بودند.
 *
 * هر دو را چشمی پیدا کردیم، که یعنی دفعهٔ بعد هم ممکن است پیدا نکنیم. این
 * اسکریپت همان دو بررسی را خودکار می‌کند تا هر وقت نمونه عوض شد، پیش از
 * کامیت معلوم شود.
 */
import fs from "node:fs";
import { statesImportance } from "../src/analysis/analyze.ts";
import {
  SAMPLE_REPORT, SAMPLE_DURATION_MS, SAMPLE_PDF_PATH, SAMPLE_TRANSCRIPT_PATH,
} from "../src/bot/demo.ts";

const fail = [];
const ok = (m) => console.log("  ✅ " + m);

// ── ۱) هر نکتهٔ تأکید/امتحان باید در خودِ جملهٔ استاد نشانهٔ اهمیت داشته باشد
console.log("نکته‌ها");
for (const k of SAMPLE_REPORT.key_points) {
  if ((k.kind === "exam" || k.kind === "emphasis") && !statesImportance(k.evidence.quote)) {
    fail.push(`نکتهٔ «${k.title}» از دروازهٔ تأکید رد نمی‌شود: «${k.evidence.quote}»`);
  }
}
if (SAMPLE_REPORT.key_points.length === 0) {
  console.log("  ⚠️ نمونه هیچ نکته‌ای ندارد — ویترین ضعیفی است، ولی خطا نیست.");
} else if (!fail.length) {
  ok(`${SAMPLE_REPORT.key_points.length} نکته، همه با تأکید صریح استاد`);
}

// ── ۲) زمان‌ها باید در کل مدت پخش باشند، نه فشرده در ابتدا
console.log("زمان‌بندی");
const ch = SAMPLE_REPORT.chapters;
if (ch.length >= 2) {
  const lastStart = ch[ch.length - 1].start_ms;
  const pct = Math.round((lastStart / SAMPLE_DURATION_MS) * 100);
  if (pct < 25) {
    fail.push(`بخش آخر از ${pct}٪ مدت شروع می‌شود — زمان‌ها در ابتدا فشرده شده‌اند`);
  } else {
    ok(`بخش آخر از ${pct}٪ مدت شروع می‌شود`);
  }
}
// هیچ زمانی نباید بیرون از مدت صوت باشد
for (const c of ch) {
  for (const p of c.parts) {
    if (p.at_ms > SAMPLE_DURATION_MS) fail.push(`زمان بیرون از صوت: ${p.at_ms} > ${SAMPLE_DURATION_MS}`);
  }
}

// ── ۳) فایل‌های همراه باید باشند، وگرنه تور روی سرور نصفه می‌ماند
console.log("فایل‌ها");
for (const p of [SAMPLE_PDF_PATH, SAMPLE_TRANSCRIPT_PATH]) {
  if (!fs.existsSync(p)) fail.push(`فایل نمونه نیست: ${p}`);
  else ok(`${p.split(/[\\/]/).pop()} — ${Math.round(fs.statSync(p).size / 1024)} کیلوبایت`);
}

if (fail.length) {
  console.error("\n❌ نمونه ایراد دارد:");
  for (const f of fail) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ نمونه سالم است.");
