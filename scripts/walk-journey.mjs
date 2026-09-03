/**
 * مسیر کاربر را از اول تا آخر چاپ می‌کند — بدون تلگرام.
 *
 * هدف: دیدن دقیقاً همان چیزی که کاربر می‌بیند، به همان ترتیب، تا بشود قضاوت
 * کرد کجا گیج می‌شود یا کجا متن زیاد است.
 */
import { WELCOME, HELP, PRIVACY, overviewMessage, keyPointsMessage, progressMessage, creditMessage, settlementMessage } from "../src/bot/strings.js";
import { SHORT_DESCRIPTION, DESCRIPTION, COMMANDS } from "../src/bot/profile.js";
import { listSessions, sessionReport } from "../src/db/index.js";
import { fmtDuration } from "../src/util/time.js";

const plain = (s) => s.replace(/<[^>]+>/g, "");
let total = 0;
const step = (who, text) => {
  const t = plain(text);
  total += t.length;
  console.log(`\n\x1b[2m${"─".repeat(64)}\x1b[0m`);
  console.log(`\x1b[1m${who}\x1b[0m  \x1b[2m(${t.length} کاراکتر)\x1b[0m\n`);
  console.log(t);
};

console.log("\x1b[1m═══ قبل از /start: چیزی که در پروفایل ربات می‌بیند ═══\x1b[0m");
console.log(`\nزیر نام ربات: ${SHORT_DESCRIPTION}\n`);
console.log("در چت خالی:\n" + plain(DESCRIPTION));
console.log("\nمنوی دستورها:");
for (const c of COMMANDS) console.log(`  /${c.command.padEnd(9)} ${c.description}`);

step("۱. کاربر /start می‌زند", WELCOME);
step("۲. کاربر یک صوت می‌فرستد", "⬇️ دارم فایلو می‌گیرم…");
step("۳. پردازش شروع می‌شود", progressMessage("preprocess"));
step("۴. حین رونویسی", progressMessage("stt", "از کش خوانده شد — هزینه‌ای نداشت"));
step("۵. حین تحلیل", progressMessage("analyze"));

// آخرین جلسهٔ واقعی از دیتابیس
const s = listSessions(900000099, 20).find((x) => x.report_json);
if (!s) {
  console.log("\n⚠️ جلسهٔ تحلیل‌شده‌ای در دیتابیس نیست — اول run-pipeline را اجرا کن.");
  process.exit(0);
}
const r = sessionReport(s);

step(
  "۶. نتیجه — پیام اول",
  overviewMessage({
    report: r, courseName: null, sessionDate: null,
    durationMs: s.original_ms, savedMs: 0, qualityWarnings: [],
  }),
);
const kp = keyPointsMessage(r, true);
if (kp) step("۷. نتیجه — پیام دوم", kp);
else console.log("\n(پیام دوم نیامد: نکتهٔ امتحانی پیدا نشد)");

step("۸. فایل‌ها", "📕 جزوهٔ این جلسه\n📄 رونوشت کامل با مهر زمانی");

const cost = Math.round(s.original_ms / 1000);
step(
  "۹. پیام پایانی + دکمهٔ اشتراک",
  `${plain(settlementMessage(cost, 4200))}\n[ 👥 تقسیم با هم‌کلاسیا ]`,
);

console.log(`\n\x1b[2m${"─".repeat(64)}\x1b[0m`);
console.log(`\x1b[1mجمع کل متنی که کاربر تا اینجا می‌خواند: ${total} کاراکتر\x1b[0m`);
console.log(`تعداد پیام‌ها تا رسیدن به نتیجه: ۹\n`);

console.log("\x1b[1m═══ دستورهای فرعی ═══\x1b[0m");
step("/credit", creditMessage(4200, 3000, 900));
step("/help", HELP);
step("/privacy", PRIVACY);
