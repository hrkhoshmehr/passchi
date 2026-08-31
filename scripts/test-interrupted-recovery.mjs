/**
 * جلسه‌ای که پروسه وسطش مُرد، سکه‌اش باید برگردد.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * `shutdown()` مستقیم `process.exit(0)` می‌زد. یک `systemctl restart` وسطِ
 * یک جلسه، پروسه را می‌کشت — و چون پروسه **می‌میرد** نه اینکه پرتاب کند،
 * آن `catch` در `startJob` که بازپرداخت می‌کند هرگز اجرا نمی‌شد. جلسه تا ابد
 * روی `preprocess` می‌ماند و سکهٔ کاربر رزرو-شده.
 *
 * روی کاربر واقعی افتاد: ۸۵ سکه رفت، هیچ خروجی‌ای نیامد، و تنها نشانه‌اش یک
 * سطر `reserve` بی‌جفت در دفتر بود.
 *
 * سه چیز اینجا سنجیده می‌شود:
 *
 *   ۱) رزروِ بی‌جفت پیدا و برگردانده می‌شود.
 *   ۲) جلسهٔ **تمام‌شده** دست نمی‌خورد — حتی وقتی `commit` هیچ سطری ننوشته،
 *      که وقتی تفاوت صفر باشد دقیقاً همان اتفاق می‌افتد. این ظریف‌ترین بخش
 *      است: بدون بررسیِ `status`، هر جلسهٔ موفقی دوباره سکه می‌گرفت.
 *   ۳) دوبار اجرا شدن دوبار پول نمی‌دهد.
 *
 * اجرا: npx tsx scripts/test-interrupted-recovery.mjs
 */
process.env.BOT_TOKEN ||= "111:aaa";

const { createSession, updateSession, getSession, upsertUser } = await import("../src/db/index.ts");
const { reserve, commit, currentBalance, danglingReservations } = await import(
  "../src/billing/ledger.ts"
);
const { recoverInterrupted } = await import("../src/jobs/service.ts");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const USER = 987654321;
upsertUser(USER, "آزمون", null);
const { grant } = await import("../src/billing/ledger.ts");
grant(USER, 10_000);
const start = currentBalance(USER);
check("موجودی اولیه", start >= 10_000, String(start));

// ─── ۱) جلسه‌ای که وسط کار مُرد ──────────────────────────────────────────────
const dead = "deadsess0001";
createSession(dead, USER, null);
updateSession(dead, { status: "preprocess" });
reserve(USER, 600, dead);
const afterReserve = currentBalance(USER);
check("رزرو کم کرد", afterReserve === start - 600, `${afterReserve}`);

// ─── ۲) جلسه‌ای که تمام شد و تفاوتش صفر بود (پس commit سطری ننوشت) ──────────
//
// این همان دامی است که ساده‌ترین پیاده‌سازی در آن می‌افتد.
const okSess = "okaysess0001";
createSession(okSess, USER, null);
reserve(USER, 300, okSess);
commit(USER, 300, 300, okSess); // تفاوت صفر ⇒ هیچ سطری در دفتر
updateSession(okSess, { status: "done" });
const beforeRecover = currentBalance(USER);

const dangling = danglingReservations().map((d) => d.sessionId);
check("جلسهٔ مُرده آویزان تشخیص داده شد", dangling.includes(dead));
check(
  "جلسهٔ تمام‌شده آویزان نیست (با وجود نبودِ سطر commit)",
  !dangling.includes(okSess),
  dangling.join(","),
);

// ─── ۳) جمع‌کردن ────────────────────────────────────────────────────────────
const n = recoverInterrupted();
check("دست‌کم یک جلسه جمع شد", n >= 1, String(n));
check(
  "سکهٔ جلسهٔ مُرده برگشت",
  currentBalance(USER) === beforeRecover + 600,
  `${currentBalance(USER)} (انتظار ${beforeRecover + 600})`,
);
check("وضعیت جلسهٔ مُرده error شد", getSession(dead).status === "error", getSession(dead).status);
check("جلسهٔ تمام‌شده دست‌نخورده ماند", getSession(okSess).status === "done");

// ─── ۴) اجرای دوباره نباید دوباره پول بدهد ──────────────────────────────────
const afterFirst = currentBalance(USER);
const second = recoverInterrupted();
check("بار دوم چیزی برای جمع‌کردن نیست", second === 0, String(second));
check("موجودی دوبار زیاد نشد", currentBalance(USER) === afterFirst, String(currentBalance(USER)));

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
