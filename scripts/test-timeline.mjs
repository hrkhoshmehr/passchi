/**
 * زمان‌های پیام باید در تلگرام **زدنی** باشند.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * تلگرام وقتی پیامی ریپلای یک صوت باشد، زمان‌های داخل متن را به لینکِ پخش
 * تبدیل می‌کند — ولی **نه داخل نقل‌قول**. ریزه‌کاری‌های هر بخش و زمانِ هر
 * نکته داخل `blockquote expandable` بودند، پس هیچ‌کدام زدنی نبودند و کاربر
 * گزارش داد که فقط اولین `00:00` کار می‌کند.
 *
 * و همان `00:00` دو بار می‌آمد: یک بار کنارِ عنوانِ بخش و یک بار در اولین
 * ریزه‌کاریِ همان بخش.
 *
 * قاعده‌ای که اینجا قفل می‌شود: هر زمان باید **بیرون از نقل‌قول**، در خطِ
 * خودش، و بدون قالبِ پررنگ یا کج باشد.
 *
 * اجرا: npx tsx scripts/test-timeline.mjs
 */
import { timelineMessage, extractedMessage } from "../src/bot/strings.ts";

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

/** زمان‌هایی که بیرون از هر نقل‌قول‌اند — یعنی آن‌ها که تلگرام لینک می‌کند. */
const linkableTimes = (msg) =>
  msg
    .replace(/<blockquote[\s\S]*?<\/blockquote>/g, "")
    .split("\n")
    .flatMap((l) => l.match(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?=\s|$)/g) ?? [])
    .map((s) => s.trim());

const chapter = (start, end, title, parts) => ({
  start_ms: start, end_ms: end, kind: "teaching", title, parts,
});

const report = {
  session_title: "جلسه", headline: "", class_recap: "", course_guess: null,
  chapters: [
    chapter(0, 900_000, "بخش اول", [
      { at_ms: 0, label: "شروع درس" },
      { at_ms: 240_000, label: "مثال" },
    ]),
    chapter(900_000, 1_800_000, "بخش دوم", [{ at_ms: 1_000_000, label: "ادامه" }]),
    chapter(1_800_000, 2_400_000, "بخش بی‌ریزه‌کاری", []),
  ],
  topics: [], professor_actions: [],
  key_points: [
    {
      kind: "exam", title: "نکتهٔ امتحانی", detail: "توضیح",
      evidence: { quote: "این تو امتحان میاد", at_ms: 300_000, speaker: "استاد", verified: true, score: 1 },
    },
  ],
  glossary: [], open_questions: [], next_session_hint: null,
  composition: [], silenceMs: 0, droppedCitations: 0,
};

// ─── بخش‌بندی کلاس ──────────────────────────────────────────────────────────
{
  const msg = timelineMessage(report, true);

  check("عنوان بخش دیگر زمان ندارد", !/^\d{1,2}:\d{2}.*<b>/m.test(msg));
  check("نقل‌قول بازشونده حذف شده", !msg.includes("<blockquote"));

  const times = linkableTimes(msg);
  // پنج تا: دو ریزه‌کاری بخش اول، «شروعِ» بخش دوم (چون اولین ریزه‌کاری‌اش
  // بیش از یک دقیقه دیرتر است) و خودِ آن ریزه‌کاری، و بخش سومِ بی‌ریزه‌کاری.
  check("همهٔ زمان‌ها بیرون از نقل‌قول‌اند", times.length === 5, times.join(" "));
  check("هیچ زمانی تکراری نیست", new Set(times).size === times.length, times.join(" "));

  // زمان باید سرِ خط و بی‌قالب باشد — مطمئن‌ترین جا برای تشخیصِ تلگرام
  const timeLines = msg.split("\n").filter((l) => /^\d{1,2}:\d{2}/.test(l));
  check("زمان سرِ خط است", timeLines.length === 5, `${timeLines.length} خط`);
  check("خطِ زمان قالب ندارد", timeLines.every((l) => !/<[bi]>|<blockquote/.test(l)));

  // بخشی که ریزه‌کاری ندارد باید همچنان یک زمانِ ورودی داشته باشد
  check("بخش بی‌ریزه‌کاری هم زمان دارد", msg.includes("30:00  شروع این بخش"));
  // و بخشی که اولین ریزه‌کاری‌اش خیلی دیرتر است، راهِ ورودی‌اش را از دست ندهد
  check("بخشِ با ریزه‌کاریِ دیر هم شروع دارد", msg.includes("15:00  شروع این بخش"));

  // ارقام لاتین شرطِ لینک‌شدن است
  check("ارقام زمان لاتین‌اند", !/[۰-۹]:/.test(msg));
}

// ─── نکته‌ها ────────────────────────────────────────────────────────────────
{
  const msg = extractedMessage(report);
  check("زمانِ نکته بیرون از نقل‌قول است", linkableTimes(msg).includes("05:00"), linkableTimes(msg).join(" "));
  const inQuote = msg.match(/<blockquote[\s\S]*?<\/blockquote>/g)?.join("") ?? "";
  check("داخل نقل‌قول زمانی نمانده", !/\d{1,2}:\d{2}/.test(inQuote));
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
