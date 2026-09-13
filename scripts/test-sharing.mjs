/**
 * بازگشتِ سهم و «مجانی بعد از سقف» را روی دفتر کل واقعی می‌سنجد، نه روی فرمول.
 *
 * پانزده نفر یکی‌یکی به یک جلسهٔ ۹۰ دقیقه‌ای با «۱۰ نفر» می‌پیوندند. قاعده: هر
 * هم‌کلاسی سهمِ برابر می‌دهد و همان به مالک برمی‌گردد، تا مالک فقط سهمِ خودش را
 * داده باشد (سقف = قیمت منهای سهم)؛ بعد برای بقیه مجانی است. بررسی می‌شود که
 * مالک دقیقاً تا سقف پس گرفت — نه کمتر، و نه بیشتر (سودی در کار نیست) — بعدش
 * برداشتن مجانی شد، و آنچه از هم‌کلاسی‌ها کم شد همان است که به مالک رسید.
 *
 * و بودجهٔ هفتگیِ هدیه: سهمی که با اعتبارِ هدیه (نه خریداری‌شده) داده می‌شود، پس
 * از پرشدنِ بودجه رد می‌شود و ردّی در دفتر و عضویت نمی‌گذارد؛ سهم با اعتبارِ
 * خریداری‌شده همچنان پذیرفته می‌شود.
 *
 * اجرا: DATA_DIR=./data/tmp-share node --import tsx scripts/test-sharing.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { db, upsertUser } = await import("../src/db/index.ts");
const { grant, currentBalance, totalShareRefunds } = await import("../src/billing/ledger.ts");
const { GiftBudgetExhausted, joinSession, registerOwner, setShareEnabled, setShareTarget, shareStatus, members } =
  await import("../src/billing/sharing.ts");
const { fmtToman, priceOf, shareCap, shareSeat } = await import("../src/billing/money.ts");
const { config } = await import("../src/config.ts");

const CLASS_SEC = 90 * 60;
const SESSION = "testsession01";
const OWNER = 5_000_001;
const TARGET = 10;
const JOINERS = 15;

let bad = 0;
const fail = (msg) => {
  console.log(`❌ ${msg}`);
  bad++;
};

const makeSession = (id, owner) => {
  db.prepare(
    `INSERT OR REPLACE INTO sessions (id, tg_id, status, original_ms, share_enabled, share_target, mode)
     VALUES (?, ?, 'done', ?, 1, ?, 'full')`,
  ).run(id, owner, CLASS_SEC * 1000, TARGET);
  db.prepare(`DELETE FROM session_members WHERE session_id = ?`).run(id);
};

upsertUser(OWNER, "مالک", null);
makeSession(SESSION, OWNER);
setShareEnabled(SESSION, true);
setShareTarget(SESSION, TARGET);

const cost = priceOf(CLASS_SEC);
registerOwner(SESSION, OWNER, cost);
const seat = shareSeat(cost, TARGET);
const cap = shareCap(cost, TARGET);
const ownerStart = currentBalance(OWNER);
console.log(
  `جلسهٔ ${fmtToman(cost)} · «${TARGET} نفر» ⇒ سهم هر نفر ${fmtToman(seat)} · سقف بازگشت ${fmtToman(cap)}\n`,
);

let freeFrom = 0;
let charged = 0;
for (let i = 1; i <= JOINERS; i++) {
  const joiner = 5_000_100 + i;
  upsertUser(joiner, `عضو ${i}`, null);
  grant(joiner, 50_000, "topup");
  const before = currentBalance(joiner);
  const r = joinSession(SESSION, joiner);
  charged += r.charged;
  if (r.free && !freeFrom) freeFrom = i;
  if (r.charged > seat) fail(`نفر ${i} بیش از سهم داد (${r.charged} > ${seat})`);
  if (r.seat !== seat) fail(`سهمِ گزارش‌شده برای نفر ${i} با shareSeat نمی‌خواند (${r.seat} ≠ ${seat})`);
  if (before - currentBalance(joiner) !== r.charged) fail(`کسرِ دفترِ نفر ${i} با charged نمی‌خواند`);
  if (r.ownerRefund !== r.charged) fail(`برگشتِ مالک در برداشتِ ${i} با سهمِ کسرشده نمی‌خواند`);
  console.log(
    `${String(i).padStart(2)} · ${r.free ? "مجانی" : `کسر ${fmtToman(r.charged)}`}` +
      ` · مالک تا حالا ${fmtToman(currentBalance(OWNER) - ownerStart)} پس گرفته` +
      `${r.capJustReached ? "  ← سقف پر شد" : ""}`,
  );
}

const refunded = currentBalance(OWNER) - ownerStart;
const st = shareStatus(SESSION);
const classmatesPaid = members(SESSION)
  .filter((m) => m.role === "member")
  .reduce((a, m) => a + m.paid_toman, 0);
const expectFreeFrom = Math.ceil(cap / seat) + 1;

console.log(
  `\nمالک ${fmtToman(refunded)} پس گرفت (سقف ${fmtToman(cap)}) · خرجِ خالصِ مالک ${fmtToman(cost - refunded)} · سهمِ خودش ${fmtToman(seat)}`,
);
console.log(`اولین برداشتِ مجانی: نفر ${freeFrom || "—"}`);

if (refunded > cap) fail("بازگشت از سقف رد شد — مالک سود کرد");
if (refunded !== cap) fail(`بازگشت به سقف نرسید (${refunded} ≠ ${cap})`);
if (cost - refunded !== seat) fail(`مالک در نهایت چیزی جز سهمِ خودش داد (${cost - refunded} ≠ ${seat})`);
if (charged !== refunded) fail(`آنچه از هم‌کلاسی‌ها کم شد با آنچه به مالک رسید نمی‌خواند (${charged} ≠ ${refunded})`);
if (totalShareRefunds(OWNER) !== refunded) fail("سطرهای share_refund دفتر با موجودیِ مالک نمی‌خواند");
if (classmatesPaid !== refunded) fail(`paid_toman عضوها با برگشتیِ مالک نمی‌خواند (${classmatesPaid} ≠ ${refunded})`);
if (!freeFrom) fail("هیچ برداشتی مجانی نشد");
else if (freeFrom !== expectFreeFrom) fail(`مجانی از نفرِ ${freeFrom} شروع شد، انتظار ${expectFreeFrom}`);
if (!st || st.ownerRefunded !== refunded || !st.capReached || st.cap !== cap || st.seat !== seat) {
  fail(`shareStatus با دفتر نمی‌خواند: ${JSON.stringify(st)}`);
}

// ─── بودجهٔ هفتگیِ هدیه ─────────────────────────────────────────────────────
//
// سهم‌های بالا با اعتبارِ خریداری‌شده بودند و بودجه را نخوردند. بودجه اینجا
// جای یک سهمِ هدیه‌ای را دارد، نه دو تا.
{
  const S2 = "testsession02";
  const OWNER2 = 5_000_002;
  upsertUser(OWNER2, "مالکِ دوم", null);
  makeSession(S2, OWNER2);
  registerOwner(S2, OWNER2, cost);
  const savedBudget = config.SHARE_GIFT_TOMAN_PER_WEEK;
  config.SHARE_GIFT_TOMAN_PER_WEEK = seat + Math.floor(seat / 2);

  const giftOnly = (id) => {
    upsertUser(id, `هدیه‌ای ${id}`, null);
    grant(id, 20_000, "trial");
    return id;
  };
  const G1 = giftOnly(5_000_201);
  const G2 = giftOnly(5_000_202);
  const P1 = 5_000_203;
  upsertUser(P1, "خریدار", null);
  grant(P1, 50_000, "topup");

  try {
    const r = joinSession(S2, G1);
    if (r.charged !== seat) fail(`اولین سهمِ هدیه‌ای باید کامل کم شود (${r.charged} ≠ ${seat})`);
  } catch (e) {
    fail(`اولین سهمِ هدیه‌ای، داخلِ بودجه، باید پذیرفته شود: ${e}`);
  }

  const owner2Before = currentBalance(OWNER2);
  let threw = null;
  try {
    joinSession(S2, G2);
  } catch (e) {
    threw = e;
  }
  if (!(threw instanceof GiftBudgetExhausted)) fail(`سهمِ هدیه‌ایِ دوم باید با GiftBudgetExhausted رد شود: ${threw}`);
  else if (threw.seat !== seat) fail(`سهمِ گفته‌شده در خطا با سهمِ جلسه نمی‌خواند (${threw.seat} ≠ ${seat})`);
  if (currentBalance(G2) !== 20_000) fail("از تازه‌واردِ ردشده پولی کم شد");
  if (currentBalance(OWNER2) !== owner2Before) fail("برای سهمِ ردشده چیزی به مالک رسید");
  if (members(S2).some((m) => m.tg_id === G2)) fail("عضویتِ ردشده ثبت شد");

  try {
    const r = joinSession(S2, P1);
    if (r.charged !== seat) fail(`سهمِ خریدار کامل کم نشد (${r.charged} ≠ ${seat})`);
  } catch (e) {
    fail(`سهم با اعتبارِ خریداری‌شده باید با بودجهٔ پر هم پذیرفته شود: ${e}`);
  }
  config.SHARE_GIFT_TOMAN_PER_WEEK = savedBudget;
}

console.log(
  bad === 0
    ? `\n✅ مالک دقیقاً همه‌چیز جز سهمِ خودش را پس گرفت، بعدش مجانی شد، هیچ‌کس سود نکرد، و بودجهٔ هدیه نگه داشت.`
    : `\n${bad} خطا`,
);
process.exit(bad === 0 ? 0 : 1);
