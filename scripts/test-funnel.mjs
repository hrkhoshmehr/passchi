/**
 * قیف و منبعِ ورود، روی پایگاه‌دادهٔ واقعی.
 *
 * چیزهایی که باید ثابت شوند: منبعِ اولین ورود با ورودِ بعدی عوض نمی‌شود؛
 * نامِ منبعِ ساختگی (تگ، حروف بزرگ، طول زیاد) تمیز یا رد می‌شود؛ هر گامِ
 * قیف فقط همان گروهِ کاربران را می‌شمارد؛ و هم‌کلاسیِ پیوسته «نفرستاد» شمرده
 * نمی‌شود.
 *
 * اجرا: DATA_DIR=./data/tmp-funnel node --import tsx scripts/test-funnel.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { db, upsertUser, createSession, updateSession } = await import("../src/db/index.ts");
const F = await import("../src/db/funnel.ts");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (انتظار ${JSON.stringify(expected)})`}`);
}

// ─── تمیزکردنِ منبع ─────────────────────────────────────────────────────────
check("s_ ساده", F.sourceFromStartPayload("s_instagram"), "instagram");
check("حروف بزرگ کوچک می‌شود", F.sourceFromStartPayload("s_Insta"), "insta");
check("تگ رد می‌شود", F.sourceFromStartPayload("s_<b>x"), "direct");
check("طولانی رد می‌شود", F.sourceFromStartPayload("s_" + "a".repeat(40)), "direct");
check("بی‌پارامتر", F.sourceFromStartPayload(""), "direct");
check("هدیه", F.sourceFromStartPayload("g_abc"), "gift");
check("لینک جزوه", F.sourceFromStartPayload("j_abc123"), "share");
check("خرید گروهی", F.sourceFromStartPayload("p_abc123"), "group");
check("انتقال", F.sourceFromStartPayload("t_abc"), "transfer");
check("ناشناخته", F.sourceFromStartPayload("zzz"), "other");
check("رویداد وب مجاز", F.isWebEvent("landing_view"), true);
check("رویداد وب ساختگی", F.isWebEvent("drop table"), false);

// ─── منبعِ اولین ورود ثابت می‌ماند ───────────────────────────────────────────
const A = 8_100_001, B = 8_100_002, C = 8_100_003, D = 8_100_004;
for (const u of [A, B, C, D]) upsertUser(u, `u${u}`, null);

F.recordStart(A, "s_instagram");
F.recordStart(A, "g_later");
check("منبع اول می‌ماند", F.sourceOf(A), "instagram");

// کاربرِ قدیمی که حالا روی آگهی می‌زند، به حسابِ آگهی نوشته نمی‌شود
const RETURNING = 8_100_008;
upsertUser(RETURNING, "returning", null);
// بیرون از هم‌گروهیِ هفت‌روزه، تا شمارشِ پایین را عوض نکند
db.prepare(`UPDATE users SET created_at = datetime('now', '-30 days') WHERE tg_id = ?`).run(RETURNING);
F.recordStart(RETURNING, "s_instagram");
check("کاربرِ قدیمی منبع نمی‌گیرد", F.sourceOf(RETURNING), null);
F.recordStart(B, "");
F.recordStart(C, "j_sess1");
F.recordStart(D, "s_instagram");

// ─── گام‌های قیف ─────────────────────────────────────────────────────────────
F.track(A, "demo");
F.track(A, "demo"); // دوبار دیدنِ تور یک نفر است
F.track(B, "demo");

createSession("fs_a1", A, null);
updateSession("fs_a1", { status: "done" });
createSession("fs_b1", B, null); // فرستاد ولی تحویل نشد
db.prepare(`INSERT INTO session_members (session_id, tg_id, paid_toman, role) VALUES ('fs_a1', ?, 0, 'owner')`).run(A);
db.prepare(`INSERT INTO session_members (session_id, tg_id, paid_toman, role) VALUES ('fs_a1', ?, 3000, 'member')`).run(C);
db.prepare(
  `INSERT INTO topups (id, tg_id, package_id, credit_toman, price_toman, status) VALUES ('ft1', ?, 'p8', 165000, 150000, 'approved')`,
).run(A);
db.prepare(
  `INSERT INTO topups (id, tg_id, package_id, credit_toman, price_toman, status) VALUES ('ft2', ?, 'p8', 165000, 150000, 'rejected')`,
).run(B);

// کاربرِ قدیمی بیرون از بازه
const OLD = 8_100_009;
upsertUser(OLD, "old", null);
db.prepare(`UPDATE users SET created_at = datetime('now', '-40 days') WHERE tg_id = ?`).run(OLD);
createSession("fs_old", OLD, null);

const r = F.funnelReport(7);
check("کاربرانِ بازه", r.total.users, 4);
check("تور دیده", r.total.demo, 2);
check("صوت فرستاده", r.total.uploaded, 2);
check("تحویل گرفته", r.total.delivered, 1);
check("جزوهٔ کسِ دیگر — مالک خودش شمرده نمی‌شود", r.total.joined, 1);
check("پرداخت تأییدشده — ردشده نه", r.total.paid, 1);

const insta = r.bySource.find((x) => x.source === "instagram");
check("اینستاگرام: نفر", insta?.users, 2);
check("اینستاگرام: پرداخت", insta?.paid, 1);
check("منبعِ لینک جزوه", r.bySource.find((x) => x.source === "share")?.joined, 1);

// ─── رویدادِ ناشناسِ وب ─────────────────────────────────────────────────────
F.track(null, "landing_view", "instagram");
F.track(null, "landing_view", "instagram");
F.track(null, "landing_cta", null);
const r2 = F.funnelReport(7);
check(
  "بازدیدِ وب به تفکیک منبع",
  r2.web.find((w) => w.name === "landing_view" && w.source === "instagram")?.n,
  2,
);
check("کلیکِ بی‌منبع direct است", r2.web.find((w) => w.name === "landing_cta")?.source, "direct");
check("رویدادِ کاربر در وب شمرده نمی‌شود", r2.web.some((w) => w.name === "demo"), false);

console.log(failures === 0 ? "\nهمه سبز ✅" : `\n${failures} شکست ❌`);
process.exit(failures === 0 ? 0 : 1);
