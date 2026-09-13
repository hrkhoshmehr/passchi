/**
 * کدهای هدیه را روی پایگاه‌دادهٔ واقعی می‌سنجد، نه روی فرمول.
 *
 * چیزی که واقعاً باید ثابت شود این است که یک کد **بیش از ظرفیتش** اعتبار نمی‌دهد:
 * نه با برداشت دوبارهٔ یک نفر، نه با شلوغیِ چند نفر روی یک کد یک‌بارمصرف، و نه
 * پس از باطل‌شدن یا انقضا. پس هر ادعا با موجودیِ دفتر کل بررسی می‌شود.
 *
 * اجرا: DATA_DIR=./data/tmp-gift node scripts/test-gift.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { db, upsertUser, createGift, getGift, giftUses, revokeGift, listGifts } = await import(
  "../src/db/index.ts"
);
const { currentBalance } = await import("../src/billing/ledger.ts");
const { claim, DEFAULT_GIFT_TOMAN } = await import("../src/bot/gift.ts");

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${label}: ${actual}${ok ? "" : ` (انتظار ${expected})`}`);
}

const ADMIN = 9_000_000;
const users = [9_000_001, 9_000_002, 9_000_003];
upsertUser(ADMIN, "ادمین", null);
for (const u of users) {
  upsertUser(u, `کاربر ${u}`, null);
  db.prepare(`UPDATE users SET credit_toman = 0 WHERE tg_id = ?`).run(u);
}

// ─── ۱) هدیهٔ یک‌بارمصرف ──────────────────────────────────────────────────────
createGift({ code: "once1", toman: DEFAULT_GIFT_TOMAN, maxUses: 1, createdBy: ADMIN });

const first = claim("once1", users[0]);
check("برداشت اول موفق", first.ok, true);
check("مبلغِ داده‌شده", first.ok && first.toman, DEFAULT_GIFT_TOMAN);
check("موجودی گیرنده", currentBalance(users[0]), DEFAULT_GIFT_TOMAN);

check("برداشت دوم همان نفر رد", claim("once1", users[0]).reason, "already");
check("موجودی بعد از تلاش دوم", currentBalance(users[0]), DEFAULT_GIFT_TOMAN);

check("نفر دوم روی کد پرشده رد", claim("once1", users[1]).reason, "exhausted");
check("نفر دوم چیزی نگرفت", currentBalance(users[1]), 0);
check("شمار برداشت", giftUses("once1"), 1);

// ─── ۲) کد چندنفره ───────────────────────────────────────────────────────────
createGift({ code: "many1", toman: 20_000, maxUses: 2, createdBy: ADMIN });
check("نفر اول", claim("many1", users[0]).ok, true);
check("نفر دوم", claim("many1", users[1]).ok, true);
check("نفر سوم رد", claim("many1", users[2]).reason, "exhausted");
check("ظرفیت رعایت شد", giftUses("many1"), 2);
check("نفر سوم صفر ماند", currentBalance(users[2]), 0);

// ─── ۳) باطل‌کردن ────────────────────────────────────────────────────────────
createGift({ code: "revok1", toman: 20_000, maxUses: 5, createdBy: ADMIN });
check("پیش از ابطال", claim("revok1", users[2]).ok, true);
revokeGift("revok1");
const beforeRevoke = currentBalance(users[0]);
check("پس از ابطال رد", claim("revok1", users[0]).reason, "revoked");
check("موجودی دست‌نخورد", currentBalance(users[0]), beforeRevoke);

// ─── ۴) انقضا ────────────────────────────────────────────────────────────────
createGift({
  code: "expir1",
  toman: 20_000,
  maxUses: 5,
  createdBy: ADMIN,
  expiresAt: new Date(Date.now() - 1000).toISOString(),
});
check("کد منقضی رد", claim("expir1", users[0]).reason, "expired");

// ─── ۵) کد ناموجود ───────────────────────────────────────────────────────────
check("کد ناموجود رد", claim("nosuch", users[0]).reason, "unknown");

// ─── ۶) دفتر کل با موجودی می‌خواند ───────────────────────────────────────────
//
// هر تومانِ هدیه باید یک سطر «grant» داشته باشد. اگر واریز بدون سطر انجام شده
// باشد، موجودی درست به‌نظر می‌رسد ولی مالی‌اش قابل بازسازی نیست.
for (const u of users) {
  const row = db
    .prepare(`SELECT COALESCE(SUM(delta_toman),0) AS s FROM credit_ledger WHERE tg_id = ? AND reason = 'grant'`)
    .get(u);
  check(`دفتر کل ${u} با موجودی می‌خواند`, row.s, currentBalance(u));
}

// ─── ۷) مجموع داده‌شده از مجموع ظرفیت‌ها بیشتر نیست ─────────────────────────
const granted = db
  .prepare(`SELECT COALESCE(SUM(toman),0) AS c FROM gift_claims`)
  .get().c;
const capacity = listGifts(100).reduce((a, g) => a + g.toman * g.max_uses, 0);
check("مجموع داده‌شده ≤ مجموع ظرفیت", granted <= capacity, true);

console.log(failures === 0 ? "\nهمه سبز ✅" : `\n${failures} بررسی شکست خورد ❌`);
process.exit(failures === 0 ? 0 : 1);
