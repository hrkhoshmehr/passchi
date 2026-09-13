/**
 * پیش‌نمایش متن صفحه‌ها و پیام‌های خروجی، بدون بالاآوردن ربات.
 *
 * پیام‌های تلگرام تنها رابط کاربری این محصول‌اند و تنها راه دیدنشان پیش از
 * انتشار، همین است: چاپشان در ترمینال.
 *
 * اجرا: `node --import tsx scripts/ux-preview.mjs`
 * (`tsx` لازم است چون همین‌جا مستقیم از `src/*.ts` می‌خواند؛ با `node` تنها
 * روی `ERR_MODULE_NOT_FOUND` می‌افتد.)
 */
import { WELCOME, HOW_IT_WORKS, packagesMessage, supportMessage, mainKeyboard } from "../src/bot/menu.ts";
import {
  HELP, PRIVACY, accountMessage, confirmCostMessage, extractedMessage, lowBalanceMessage,
  recapMessage, settlementMessage, sharePreEnabledMessage, shareTargetPrompt, timelineMessage,
  upsellMessage,
} from "../src/bot/strings.ts";
import {
  DEMO_INTRO, SAMPLE_COURSE, SAMPLE_DURATION_MS, SAMPLE_REPORT, outroMessage,
} from "../src/bot/demo.ts";
import { DEFAULT_GIFT_COINS, claimedMessage, refusalMessage } from "../src/bot/gift.ts";
import { coinsToSec } from "../src/billing/coins.ts";

const line = (t) => console.log("\n" + "─".repeat(64) + `  ${t}\n`);
const show = (t) => console.log(t.replace(/<\/?[a-z][^>]*>/g, ""));

const ev = (quote, at_ms) => ({ quote, at_ms, speaker: "استاد", verified: true, score: 1 });

const report = {
  session_title: "مشتق جهت‌دار و گرادیان",
  course_guess: "ریاضی مهندسی",
  headline: "مشتق جهت‌دار و گرادیان تدریس شد.",
  class_recap:
    "استاد اول یه ربع حضور و غیاب کرد و گفت غیبت سوم یعنی حذف. بعد رفت سراغ مشتق جهت‌دار و از رو " +
    "تعریف شروع کرد، دو تا مثال هم حل کرد که مثال دومی روی سطح تراز بود و همون‌جا گفت شبیهش تو " +
    "امتحان میاد. وسطاش یه ده دقیقه‌ای از پروژهٔ دوران دانشجویی خودش تعریف کرد. آخر کلاس تکلیف " +
    "سری سوم رو داد، تحویل شنبهٔ آینده.",
  chapters: [
    {
      start_ms: 0, end_ms: 900_000, kind: "admin", title: "حضور و غیاب و اطلاعیه‌ها",
      parts: [
        { at_ms: 240_000, label: "خواندن لیست حضور" },
        { at_ms: 600_000, label: "اعلام کلاس جبرانی پنج‌شنبه" },
      ],
    },
    {
      start_ms: 900_000, end_ms: 3_000_000, kind: "teaching", title: "مشتق جهت‌دار",
      parts: [
        { at_ms: 900_000, label: "تعریف و شرط یکه‌بودن بردار" },
        { at_ms: 1_620_000, label: "مثال اول: تابع دومتغیره" },
        { at_ms: 2_400_000, label: "خاطرهٔ پروژهٔ دوران دانشجویی" },
      ],
    },
    {
      start_ms: 3_000_000, end_ms: 4_200_000, kind: "teaching", title: "گرادیان و سطح تراز",
      parts: [
        { at_ms: 3_000_000, label: "گرادیان به‌عنوان جهت بیشترین افزایش" },
        { at_ms: 3_600_000, label: "مثال دوم: بردار عمود بر سطح تراز" },
      ],
    },
    {
      start_ms: 4_200_000, end_ms: 4_800_000, kind: "qa", title: "پرسش و پاسخ",
      parts: [{ at_ms: 4_260_000, label: "سؤال دربارهٔ مشتق‌پذیری" }],
    },
    {
      start_ms: 4_800_000, end_ms: 5_400_000, kind: "admin", title: "اعلام تکلیف سری سوم",
      parts: [],
    },
  ],
  composition: [
    { kind: "teaching", ms: 2_700_000, pct: 50 },
    { kind: "admin", ms: 1_200_000, pct: 22.2 },
    { kind: "offtopic", ms: 600_000, pct: 11.1 },
    { kind: "qa", ms: 600_000, pct: 11.1 },
    { kind: "break", ms: 300_000, pct: 5.6 },
  ],
  silenceMs: 300_000,
  droppedCitations: 1,
  professor_actions: [
    {
      action: "attendance", happened: true, detail: "شفاهی، دقیقهٔ ۴",
      evidence: ev("لیست رو می‌خونم، هرکی نبود غیبت می‌خوره", 240_000),
    },
    { action: "quiz", happened: false, detail: "", evidence: null },
    { action: "exam_info", happened: true, detail: "میان‌ترم هفتهٔ نهم", evidence: null },
    { action: "homework", happened: true, detail: "سری سوم", evidence: null },
    { action: "makeup_class", happened: true, detail: "پنج‌شنبه ساعت ۱۰", evidence: null },
  ],
  key_points: [
    {
      kind: "exam", title: "سطح تراز در میان‌ترم می‌آید",
      detail: "استاد گفت یک سؤال از جنس مثال دوم — پیداکردن بردار عمود بر سطح تراز — در میان‌ترم هست.",
      due: null,
      evidence: ev("این تیپ سؤال سطح تراز رو خوب یاد بگیرید، تو میان‌ترم هست", 3_600_000),
    },
    {
      kind: "homework", title: "تمرین‌های سری سوم",
      detail:
        "مسائل ۱ تا ۱۴ فصل پنجم کتاب. تحویل حضوری سر کلاس، روی کاغذ. گفت تمرین ۹ اختیاری است و نمرهٔ اضافه دارد.",
      due: "شنبهٔ هفتهٔ آینده",
      evidence: ev("سری سه رو بردارید تا شنبه تحویل بدید", 4_980_000),
    },
    {
      kind: "emphasis", title: "نرمال‌کردن بردار جهت",
      detail: "دو بار برگشت سراغش و گفت رایج‌ترین اشتباه همین است.",
      due: null,
      evidence: ev("خیلی‌ها یادشون میره بردار رو نرمال کنن، جواب کلاً غلط میشه", 2_700_000),
    },
  ],
  topics: [],
  glossary: [],
  open_questions: [],
  next_session_hint: "جلسهٔ بعد ضرب‌کنندهٔ لاگرانژ شروع می‌شود.",
};

line("منو");
// صفحه‌کلید واقعی، نه فهرست برچسب‌ها: دکمهٔ مینی‌اپ جای «صوت بفرستم» را
// می‌گیرد و این تفاوت فقط در خروجی ساخته‌شده دیده می‌شود.
for (const row of mainKeyboard.build()) {
  console.log(row.map((b) => b.text).join("  |  "));
}
line("/start");
show(WELCOME);
line("چطور کار می‌کنه");
show(HOW_IT_WORKS);

line("۱ — کلاس چه خبر بود");
show(
  recapMessage({
    report,
    courseName: "ریاضی مهندسی",
    sessionDate: "۱۴۰۵/۰۵/۲۹",
    durationMs: 5_400_000,
    savedMs: 0,
    qualityWarnings: [],
  }),
);
line("۲ — چی از کلاس درآوردم");
show(extractedMessage(report));
line("۳ — بخش‌بندی کلاس (ریپلای صوت)");
show(timelineMessage(report, true));
line("۴ — تسویه و پیشنهاد اشتراک");
show(settlementMessage(5400, 1_800));
line("۴ب — تسویه، وقتی سرِ تأیید گفته «تقسیم می‌کنم»");
show(settlementMessage(5400, 1_800, true));

line("پایان اجرای رایگان — رونوشت و پیشنهاد");
show(upsellMessage(5400));

// ── تور نمونه: همان چیزی که کاربر تازه پس از /start می‌بیند ────────────────
line("تور نمونه — سرصفحه");
show(DEMO_INTRO);
line("تور نمونه — گام ۱: کلاس چه خبر بود");
show(
  recapMessage({
    report: SAMPLE_REPORT,
    courseName: SAMPLE_COURSE,
    sessionDate: null,
    durationMs: SAMPLE_DURATION_MS,
    savedMs: 0,
    qualityWarnings: [],
  }),
);
line("تور نمونه — گام ۲: چی از کلاس درآوردم");
show(extractedMessage(SAMPLE_REPORT));
line("تور نمونه — گام ۳: بخش‌بندی کلاس");
show(timelineMessage(SAMPLE_REPORT, false));
line("تور نمونه — گام ۴: پایان تور");
show(outroMessage("SUPPORT_ID"));

line("حساب");
show(accountMessage({ creditSec: coinsToSec(20), usedSec: 0, refundedSec: 0, sessionCount: 0 }));
line("حساب — کاربر فعال");
show(
  accountMessage({
    creditSec: coinsToSec(430),
    usedSec: 90 * 60,
    refundedSec: 45 * 60,
    sessionCount: 4,
  }),
);
line("شارژ");
show(packagesMessage());
line("سکهٔ کم");
show(lowBalanceMessage(90 * 60, coinsToSec(20)));

// ── تصمیمِ تقسیم، پیش از خرج‌شدن سکه ────────────────────────────────────────
line("تأیید هزینه — جایی که تصمیمِ تقسیم هم گرفته می‌شود");
show(confirmCostMessage(90 * 60, coinsToSec(120)));
console.log("\n[ ✅ شروع کن ] [ ✖️ بی‌خیال ]\n[ 👥 با هم‌کلاسیا تقسیم می‌کنم ]");
line("چند نفرید؟");
show(shareTargetPrompt(90 * 60));
console.log("\n[ ۵ نفر ] [ ۱۰ نفر ]\n[ ۲۰ نفر ] [ ۳۰ نفر ]");
line("تقسیم، پیش از پرداخت روشن شد");
show(sharePreEnabledMessage(90 * 60, 10));
line("پشتیبانی");
show(supportMessage());
line("راهنما");
show(HELP);
line("حریم خصوصی");
show(PRIVACY);

line("هدیه — گیرندهٔ تازه");
show(claimedMessage(DEFAULT_GIFT_COINS, coinsToSec(DEFAULT_GIFT_COINS)));
line("هدیه — کسی که از قبل سکه داشت");
show(claimedMessage(20, coinsToSec(50)));
line("هدیه — مقدار بزرگ");
show(claimedMessage(120, coinsToSec(120)));
// ── صفحه‌های تازهٔ این دسته: دکمه‌ها هم چاپ می‌شوند، چون بخشی از متن‌اند ────
const { sendPromptMessage, START_BTN, SHARE_COUNTS, invitationTail } = await import("../src/bot/strings.ts");
const { shareBack } = await import("../src/billing/coins.ts");
const { BTN } = await import("../src/bot/menu.ts");
const faN = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);

line("خوش‌آمد — دکمه‌ها");
console.log(`[ ${START_BTN.sample} ]\n[ ${START_BTN.send} ]\n[ ${BTN.how} ]`);
line("ارسال صوت");
show(sendPromptMessage("معمولاً تا حدود ۲۰ مگ.", coinsToSec(20)));
line("تأیید هزینه، با شریکی روشن (۱۰ نفر)");
show(confirmCostMessage(90 * 60, coinsToSec(120), { people: 10 }));
line("چند نفر — با دکمه‌ها");
show(shareTargetPrompt(90 * 60));
console.log(
  "\n" +
    SHARE_COUNTS.map((n) => `[ ${faN(n)} نفر · نفری ${faN(shareBack(5400, n).seat)} سکه ]`).join(" ") +
    "\n[ ✖️ بی‌خیال ]",
);
line("پیام پایانی — شریکی خاموش");
show(settlementMessage(5400, coinsToSec(30), false, { hasArchive: true }));
line("پیام پایانی — شریکی روشن (۱۰ نفر)");
show(settlementMessage(5400, coinsToSec(30), true, { people: 10, hasArchive: true }));
line("زیر دعوت — فقط برای فرستنده");
show(invitationTail({ costSec: 5400, seatCoins: 5, refundedCoins: 0, capReached: false }));

line("هدیه — پیام‌های رد");
for (const r of ["unknown", "revoked", "expired", "already", "exhausted"]) {
  console.log(`  ${r.padEnd(10)} → ${refusalMessage(r)}`);
}

// ── خرید گروهی (پشت پرچم GROUP_BUY) ────────────────────────────────────────
{
  const G = await import("../src/bot/strings.ts");
  const { groupSeat, GROUP_SIZES, GROUP_BUY_HOURS } = await import("../src/billing/coins.ts");
  const NL = "\n";
  line("خرید گروهی — سکهٔ کم، دو راه");
  show(G.lowBalanceGroupMessage(90 * 60, coinsToSec(20)));
  console.log(`${NL}[ ${G.GROUP_BTN.self} ] [ ${G.GROUP_BTN.group} ]${NL}[ ${G.GROUP_BTN.resume} ]`);
  line("خرید گروهی — چند نفر");
  show(G.groupSizePrompt(5400, GROUP_BUY_HOURS));
  console.log(
    NL +
      GROUP_SIZES.map((n) => `[ ${G.groupSizeLabel(n, groupSeat(5400, n).seatCoins, 20)} ]`).join(NL) +
      `${NL}[ ${G.GROUP_BTN.cancel} ]`,
  );
  line("خرید گروهی — باز شد (مالک)");
  show(G.groupOpenedMessage(5, 18));
  line("خرید گروهی — دعوت برای گروه کلاس");
  show(
    G.groupInviteMessage({
      durationMs: 5_400_000, seats: 5, seatCoins: 18, giftCoins: 20,
      link: "https://ble.ir/passchi_bot?start=p_ab12cd34ef56",
    }),
  );
  line("خرید گروهی — زیر دعوت (فقط مالک)");
  show(G.groupInviteTail(1, 5));
  console.log(`${NL}[ ${G.GROUP_BTN.payRest} ]`);
  line("خرید گروهی — پیش‌نمایش هم‌کلاسی");
  show(G.groupPreviewMessage({ durationMs: 5_400_000, seats: 5, filled: 2, seatCoins: 18, balanceSec: coinsToSec(20) }));
  console.log(`${NL}[ ${G.GROUP_BTN.join} ]${NL}[ ${G.GROUP_BTN.later} ]`);
  line("خرید گروهی — «هستم» زد");
  show(G.groupJoinedMessage(18, 3, 5));
  line("خرید گروهی — خبر هر ورود به مالک");
  show(G.groupProgressMessage(3, 5));
  console.log(`${NL}[ ${G.GROUP_BTN.payRest} ]`);
  line("خرید گروهی — پر شد");
  show(G.GROUP_STARTED_OWNER);
  show(G.GROUP_STARTED_MEMBER);
  line("خرید گروهی — نتیجه برای هم‌کلاسی");
  show(G.groupReadyMessage("مشتق جهت‌دار و گرادیان"));
  console.log(`[ ${G.GROUP_BTN.get} ]`);
  line("خرید گروهی — انقضا");
  show(G.groupExpiredMessage("owner", "bot", GROUP_BUY_HOURS));
  console.log(`[ ${G.GROUP_BTN.resume} ]`);
  show(G.groupExpiredMessage("owner", "web", GROUP_BUY_HOURS));
  show(G.groupExpiredMessage("member", "bot", GROUP_BUY_HOURS));
}
