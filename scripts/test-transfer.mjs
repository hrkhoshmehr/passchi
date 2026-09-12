/**
 * انتقال سکه بین دو کاربر، روی پایگاه‌دادهٔ واقعی.
 *
 * چیزی که این آزمون نگه می‌دارد:
 *
 * • سکهٔ **هدیه و رایگان** فرستاده نمی‌شود. این تنها چیزی است که بین «کمک
 *   هم‌کلاسی» و «قیفِ سکهٔ مجانی از ده حساب قلابی» فرق می‌گذارد.
 * • انتقال اتمیک است: هر دو سطر دفتر با هم می‌آیند یا هیچ‌کدام.
 * • بیش از سقف رد می‌شود و **هیچ سطری** نمی‌نویسد.
 * • یک لینک دو بار برداشته نمی‌شود، حتی با دو برداشتِ همزمان.
 * • فرستادن به خود رد می‌شود.
 *
 * اجرا: DATA_DIR=./data/tmp npx tsx scripts/test-transfer.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { db, upsertUser, createTransfer, transferClaim } = await import("../src/db/index.ts");
const { currentBalance, grant, move, transferableSec } = await import("../src/billing/ledger.ts");
const { claimTransfer, sendDirect } = await import("../src/bot/transfer.ts");
const { balanceCoins, coinsToSec } = await import("../src/billing/coins.ts");

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${label}: ${actual}${ok ? "" : ` (انتظار ${expected})`}`);
}

/** چند سطر دفتر با این دلیل برای این کاربر هست. */
const rows = (tgId, reason) =>
  db
    .prepare(`SELECT COUNT(*) AS n FROM credit_ledger WHERE tg_id = ? AND reason = ?`)
    .get(tgId, reason).n;

/** جمع دلتای یک دلیل. */
const sum = (tgId, reason) =>
  db
    .prepare(`SELECT COALESCE(SUM(delta_sec),0) AS s FROM credit_ledger WHERE tg_id = ? AND reason = ?`)
    .get(tgId, reason).s;

const coins = (tgId) => balanceCoins(currentBalance(tgId));
const freeCoins = (tgId) => balanceCoins(transferableSec(tgId));

/** کاربر تازه با صفر موجودی و دفترِ خالی. */
let nextId = 9_300_000;
function user(name) {
  const id = ++nextId;
  upsertUser(id, name, null);
  db.prepare(`UPDATE users SET credit_sec = 0, total_used_sec = 0 WHERE tg_id = ?`).run(id);
  db.prepare(`DELETE FROM credit_ledger WHERE tg_id = ?`).run(id);
  return id;
}

/** شارژِ واقعی — سطر `topup`، همان چیزی که پول دادنش را نشان می‌دهد. */
const buy = (id, n) => move({ tgId: id, deltaSec: coinsToSec(n), reason: "topup" });

// ─── ۱) انتقال موفق ──────────────────────────────────────────────────────────
const alice = user("آلیس");
const bob = user("باب");
buy(alice, 100);

const ok = sendDirect(alice, bob, 30);
check("انتقال موفق", ok.ok, true);
check("از فرستنده کم شد", coins(alice), 70);
check("به گیرنده رسید", coins(bob), 30);
check("سطر برداشت نوشته شد", rows(alice, "transfer_out"), 1);
check("سطر واریز نوشته شد", rows(bob, "transfer_in"), 1);
check("دو سطر قرینه‌اند", sum(alice, "transfer_out") + sum(bob, "transfer_in"), 0);
// فرستادن مصرف نیست؛ آمار «چقدر خرج کردی» نباید تکان بخورد.
check(
  "total_used_sec دست‌نخورد",
  db.prepare(`SELECT total_used_sec AS u FROM users WHERE tg_id = ?`).get(alice).u,
  0,
);
// سکهٔ رسیده خودش قابل انتقال است، وگرنه پس از یک دست‌به‌دست‌شدن می‌میرد.
check("سکهٔ رسیده قابل انتقال است", freeCoins(bob), 30);

// ─── ۲) سکهٔ هدیه و آزمایشی قابل انتقال نیست ─────────────────────────────────
const mule = user("حساب قلابی");
grant(mule, coinsToSec(20), "trial");
grant(mule, coinsToSec(50), "grant");
check("موجودیِ حسابِ هدیه‌ای", coins(mule), 70);
check("ولی قابل انتقالش صفر است", freeCoins(mule), 0);

const stolen = sendDirect(mule, bob, 10);
check("انتقال سکهٔ هدیه رد شد", stolen.ok === false && stolen.reason, "insufficient");
check("موجودی حساب قلابی دست‌نخورد", coins(mule), 70);
check("هیچ سطر برداشتی ننوشت", rows(mule, "transfer_out"), 0);
check("گیرنده چیزی نگرفت", coins(bob), 30);

// خریدِ کوچک روی حسابِ پرِ هدیه: فقط همان خرید قابل انتقال است.
buy(mule, 15);
check("پس از خرید، فقط خریده قابل انتقال است", freeCoins(mule), 15);

// ─── ۳) «اول سکهٔ خریداری‌شده خرج می‌شود» ────────────────────────────────────
//
// تصمیمِ عمدی و سختگیرانه: خرج از سهمِ خرید کم می‌شود، پس آنچه می‌ماند و
// قابل انتقال است هرگز از «خریدی و مصرف نکردی» بیشتر نمی‌شود.
const spender = user("خرج‌کننده");
grant(spender, coinsToSec(20), "trial");
buy(spender, 100);
move({ tgId: spender, deltaSec: -coinsToSec(90), reason: "reserve", sessionId: "s-spend" });
check("موجودیِ باقی‌مانده", coins(spender), 30);
check("ولی قابل انتقال فقط ۱۰ است", freeCoins(spender), 10);
check("۱۱ سکه رد می‌شود", sendDirect(spender, bob, 11).reason, "insufficient");
check("۱۰ سکه می‌رود", sendDirect(spender, bob, 10).ok, true);
check("و بعدش دیگر هیچ", freeCoins(spender), 0);

// ─── ۴) بیش از سقف، بدون هیچ نوشته‌ای ────────────────────────────────────────
const carol = user("کارول");
buy(carol, 10);
const before = db.prepare(`SELECT COUNT(*) AS n FROM credit_ledger`).get().n;
const tooMuch = sendDirect(carol, bob, 40);
check("بیش از سقف رد شد", tooMuch.ok === false && tooMuch.reason, "insufficient");
check("هیچ سطری نوشته نشد", db.prepare(`SELECT COUNT(*) AS n FROM credit_ledger`).get().n, before);
check("موجودی فرستنده دست‌نخورد", coins(carol), 10);

// ─── ۵) فرستادن به خود ───────────────────────────────────────────────────────
check("انتقال مستقیم به خود رد شد", sendDirect(carol, carol, 1).reason, "self");
check("موجودی پس از آن", coins(carol), 10);
createTransfer({ code: "selfy", fromId: carol, coins: 5 });
check("برداشتنِ لینکِ خودت رد شد", claimTransfer("selfy", carol).reason, "self");
check("لینک هنوز برداشته نشده", transferClaim("selfy"), null);

// ─── ۶) لینک: برداشت یک‌باره ─────────────────────────────────────────────────
const dave = user("دیوید");
const eve = user("حوا");
const frank = user("فرانک");
buy(dave, 50);
createTransfer({ code: "link1", fromId: dave, coins: 20 });

const got = claimTransfer("link1", eve);
check("برداشت اول موفق", got.ok, true);
check("گیرنده گرفت", coins(eve), 20);
check("فرستنده داد", coins(dave), 30);

check("برداشت دوم همان نفر رد", claimTransfer("link1", eve).reason, "already");
check("برداشت نفر دیگر رد", claimTransfer("link1", frank).reason, "already");
check("نفر دیگر چیزی نگرفت", coins(frank), 0);
check("فرستنده فقط یک بار داد", rows(dave, "transfer_out"), 1);
check("لینک ناموجود رد", claimTransfer("nosuch", eve).reason, "unknown");

// ─── ۷) دو برداشتِ همزمان روی یک لینک ────────────────────────────────────────
//
// همان الگوی `test-topup-gateway`: دو تسویه با هم روی یک سفارش. اینجا هم دو
// نفر روی یک لینک، و دقیقاً یکی باید برنده شود — نه صفر، نه دو.
const gina = user("جینا");
const h1 = user("هما");
const h2 = user("هانیه");
buy(gina, 40);
createTransfer({ code: "race1", fromId: gina, coins: 25 });

const [r1, r2] = await Promise.all([
  Promise.resolve().then(() => claimTransfer("race1", h1)),
  Promise.resolve().then(() => claimTransfer("race1", h2)),
]);
const outcomes = [r1.ok ? "ok" : r1.reason, r2.ok ? "ok" : r2.reason].sort().join(",");
check("از دو برداشت همزمان یکی گرفت", outcomes, "already,ok");
check("دقیقاً ۲۵ سکه از فرستنده رفت", coins(gina), 15);
check("جمع دو گیرنده ۲۵ است", coins(h1) + coins(h2), 25);
check("فقط یک سطر برداشت در جدول", db.prepare(`SELECT COUNT(*) AS n FROM coin_transfer_claims WHERE code = 'race1'`).get().n, 1);

// ─── ۸) دفتر کل با موجودی می‌خواند ───────────────────────────────────────────
//
// آخرین حرف را دفتر می‌زند: اگر موجودی و جمعِ دلتاها از هم جدا بیفتند، یعنی
// جایی سکه بی‌سطر جابه‌جا شده — همان چیزی که با دو `move` جدا اتفاق می‌افتد.
for (const id of [alice, bob, mule, spender, carol, dave, eve, frank, gina, h1, h2]) {
  const s = db
    .prepare(`SELECT COALESCE(SUM(delta_sec),0) AS s FROM credit_ledger WHERE tg_id = ?`)
    .get(id).s;
  check(`دفتر ${id} با موجودی می‌خواند`, s, currentBalance(id));
}

// جمعِ همهٔ transfer_out با جمعِ همهٔ transfer_in صفر می‌شود — هیچ سکه‌ای در
// راه گم یا ساخته نشده است.
const legs = db
  .prepare(
    `SELECT COALESCE(SUM(delta_sec),0) AS s FROM credit_ledger
      WHERE reason IN ('transfer_out','transfer_in')`,
  )
  .get().s;
check("جمع دو سمتِ همهٔ انتقال‌ها صفر", legs, 0);

console.log(failures === 0 ? "\nهمه سبز ✅" : `\n${failures} بررسی شکست خورد ❌`);
process.exit(failures === 0 ? 0 : 1);
