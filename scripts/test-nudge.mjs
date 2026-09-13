/**
 * یادآوریِ فعال‌سازی، روی پایگاه‌دادهٔ واقعی و با ارسالِ جعلی.
 *
 * ادعاها: فقط کسی که هیچ جلسه‌ای ندارد؛ نه پیش از ۲۴ ساعت، نه بعد از هفت
 * روز؛ مرحلهٔ دوم فقط بعد از ۷۲ ساعت و دست‌کم ۲۴ ساعت پس از مرحلهٔ اول؛
 * هیچ‌کس دوبار یک مرحله را نمی‌گیرد، حتی با دو دورِ همزمان؛ شب هیچ پیامی
 * نمی‌رود؛ و کاربرِ فقط-وب (بی‌ربات) انتخاب نمی‌شود.
 *
 * اجرا: DATA_DIR=./data/tmp-nudge node --import tsx scripts/test-nudge.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { db, upsertUser, createSession } = await import("../src/db/index.ts");
const N = await import("../src/jobs/nudge.ts");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (انتظار ${JSON.stringify(expected)})`}`);
}

// ۱۲ ظهر تهران = ۰۸:۳۰ UTC
const NOON = new Date("2026-09-20T08:30:00Z");
const hours = (h) => new Date(NOON.getTime() - h * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

function user(id, ageHours, platform = "telegram", creditSec = 1200) {
  upsertUser(id, `u${id}`, null);
  db.prepare(`UPDATE users SET created_at = ?, credit_sec = ? WHERE tg_id = ?`).run(hours(ageHours), creditSec, id);
  db.prepare(
    `INSERT OR IGNORE INTO identities (user_id, platform, platform_user_id) VALUES (?, ?, ?)`,
  ).run(id, platform, String(id));
}

const FRESH = 7_000_001;   // ۱۰ ساعت — هنوز زود است
const DAY = 7_000_002;     // ۳۰ ساعت — مرحلهٔ اول
const SENT = 7_000_003;    // ۳۰ ساعت ولی صوت فرستاده
const MEMBER = 7_000_004;  // ۳۰ ساعت ولی به جلسهٔ کسی پیوسته
const OLD = 7_000_005;     // ۱۰ روز — بیرون از سقف
const WEBONLY = 7_000_006; // ۳۰ ساعت، فقط وب
const LATE = 7_000_007;    // ۸۰ ساعت — مرحلهٔ اول (مرحلهٔ دوم هنوز نه)

user(FRESH, 10);
user(DAY, 30);
user(SENT, 30);
user(MEMBER, 30, "bale");
user(OLD, 240);
user(WEBONLY, 30, "web");
user(LATE, 80, "telegram", 0);

createSession("nd_sent", SENT, null);
upsertUser(7_000_099, "صاحب جلسه", null); // صاحبِ جلسه‌ای که MEMBER به آن پیوسته — خودش هویتِ ربات ندارد
createSession("nd_other", 7_000_099, null);
db.prepare(`INSERT INTO session_members (session_id, tg_id, paid_sec, role) VALUES ('nd_other', ?, 60, 'member')`).run(MEMBER);

// ─── بازهٔ ساعت ──────────────────────────────────────────────────────────────
check("ساعت تهران ظهر", N.tehranHour(NOON), 12);
check("۲۳:۳۰ UTC یعنی ۳ بامداد تهران", N.tehranHour(new Date("2026-09-20T23:30:00Z")), 3);
check("۱۷:۲۹ UTC یعنی ۲۰:۵۹ — هنوز مجاز", N.inSendWindow(new Date("2026-09-20T17:29:00Z")), true);
check("۱۷:۳۰ UTC یعنی ۲۱:۰۰ — بسته", N.inSendWindow(new Date("2026-09-20T17:30:00Z")), false);

// ─── انتخاب ──────────────────────────────────────────────────────────────────
const due = N.dueNudges(NOON).map((d) => `${d.userId}:${d.stage}`).sort();
check("فقط DAY و LATE مرحلهٔ اول", due, [`${DAY}:1`, `${LATE}:1`].sort());

// ─── شب هیچ‌چیز نمی‌رود و چیزی هم مصرف نمی‌شود ──────────────────────────────
const sentLog = [];
const fakeNotify = async (userId, text, extra) => {
  sentLog.push({ userId, text, extra });
  return userId !== LATE; // LATE ربات را بلاک کرده
};
const night = await N.runNudges({ now: new Date("2026-09-20T22:00:00Z"), notify: fakeNotify, gapMs: 0 });
check("شب: صفر", night.due, 0);
check("شب: سطری مصرف نشد", db.prepare(`SELECT COUNT(*) n FROM nudges`).get().n, 0);

// ─── دو دورِ همزمان — هر نفر یک پیام ────────────────────────────────────────
const [r1, r2] = await Promise.all([
  N.runNudges({ now: NOON, notify: fakeNotify, gapMs: 0 }),
  N.runNudges({ now: NOON, notify: fakeNotify, gapMs: 0 }),
]);
check("دو دور همزمان: دو پیام نه چهار", sentLog.length, 2);
check("رسیده‌ها", r1.delivered + r2.delivered, 1);
check(
  "بلاک‌شده با delivered=0 ثبت شد",
  db.prepare(`SELECT delivered FROM nudges WHERE user_id = ? AND stage = 1`).get(LATE).delivered,
  0,
);
check("متن مرحلهٔ اول سکه را می‌گوید", sentLog.find((s) => s.userId === DAY).text.includes("۲۰ سکه"), true);
check("متن بی‌سکه، سطر هدیه ندارد", sentLog.find((s) => s.userId === LATE).text.includes("سکه‌ت"), false);
check(
  "دکمه‌ها به دست‌کدهای موجود می‌روند",
  sentLog[0].extra.reply_markup.inline_keyboard.map((r) => r[0].callback_data),
  ["startnow", "demo:recap"],
);

await N.runNudges({ now: new Date(NOON.getTime() + 60_000), notify: fakeNotify, gapMs: 0 });
check("دور بعد: تکرار نمی‌شود", sentLog.length, 2);

// ─── مرحلهٔ دوم ──────────────────────────────────────────────────────────────
// LATE هشتاد ساعته است ولی مرحلهٔ اولش همین حالا رفته → هنوز نه.
check("مرحلهٔ دوم زودتر از ۲۴ ساعت پس از اول نمی‌آید", N.dueNudges(NOON).length, 0);

// DAY: ۸۰ ساعت، LATE: ۱۳۰ ساعت — و FRESH که ۱۰ ساعته بود حالا ۶۰ ساعته است
const later = new Date(NOON.getTime() + 50 * 3_600_000);
const d2 = N.dueNudges(later).map((d) => `${d.userId}:${d.stage}`).sort();
check("بعد از ۵۰ ساعت: DAY و LATE مرحلهٔ دوم، FRESH مرحلهٔ اول", d2, [`${FRESH}:1`, `${DAY}:2`, `${LATE}:2`].sort());

// کسی که بین دو مرحله صوت فرستاده، مرحلهٔ دوم نمی‌گیرد
createSession("nd_day_sent", DAY, null);
check(
  "فرستاد ← مرحلهٔ دوم نمی‌گیرد",
  N.dueNudges(later).map((d) => d.userId).sort(),
  [FRESH, LATE].sort(),
);

// ─── متن‌ها ──────────────────────────────────────────────────────────────────
check("مرحلهٔ دوم با خرید گروهی", N.nudgeMessage(2, 0, true).includes(N.GROUP_BTN_LABEL), true);
check("مرحلهٔ دوم بی خرید گروهی", N.nudgeMessage(2, 0, false).includes("شریک"), true);

// برچسبِ خرید گروهی باید همانی باشد که کاربر روی دکمه می‌بیند
const strings = await import("../src/bot/strings.ts");
const labels = JSON.stringify(strings);
check("برچسبِ خرید گروهی در strings.ts هست", labels.includes(N.GROUP_BTN_LABEL), true);

console.log(failures === 0 ? "\nهمه سبز ✅" : `\n${failures} شکست ❌`);
process.exit(failures === 0 ? 0 : 1);
