/**
 * سهمِ هم‌کلاسی باید از هدیهٔ تازه‌وارد کمتر بماند — و مسیر پیوستن بن‌بست نباشد.
 *
 * ## سه باگی که این آزمون نگه می‌دارد
 *
 * ۱. **گزینهٔ «۱ نفر».** `seat = ceil(cap/n)` است، پس با یک نفر سهم می‌شد
 *    نصفِ کلِ جلسه: ۴۵ سکه روی یک کلاس ۹۰ دقیقه‌ای، در حالی که تازه‌وارد
 *    ۲۰ سکه هدیه دارد. یعنی همان دکمه‌ای که قرار بود کلاس را بیاورد، اولین
 *    نفر را بیرون می‌انداخت — و مالک هیچ‌وقت نمی‌فهمید چرا کسی برنداشت.
 *    شکلِ سودآورِ حساب‌سازی هم همین بود: یک حساب جعلی، نصفِ خرجِ مالک.
 *
 * ۲. **کف فقط در صفحه‌کلید نباشد.** صفحه‌کلید تنها راهِ رسیدن به
 *    `setShareTarget` نیست؛ دست‌کدِ دستی و مینی‌اپ هم هستند. کف در خودِ
 *    تابع بسته می‌شود، و `shareBack` هم آن را اعمال می‌کند تا ردیف‌های
 *    قدیمیِ `share_target = 1` در پایگاه‌داده بی‌مهاجرت درمان شوند.
 *
 * ۳. **سکهٔ کم روی مسیر پیوستن، بن‌بست بود.** `handleJoin` فقط یک متن
 *    برمی‌گرداند و صداکننده صفحه‌کلید دعوت را هم برداشته بود؛ تازه‌واردی که
 *    از گروه درس آمده در یک پیامِ بی‌راه گیر می‌کرد.
 *
 * اجرا: DATA_DIR=./data/tmp-seat npx tsx scripts/test-share-seat.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { db, upsertUser } = await import("../src/db/index.ts");
const { grant } = await import("../src/billing/ledger.ts");
const { setShareEnabled, setShareTarget, registerOwner } = await import(
  "../src/billing/sharing.ts"
);
const { SHARE_TARGET_MIN, balanceCoins, coinsToSec, costCoins, shareBack } = await import(
  "../src/billing/coins.ts"
);
const { shareTargetKeyboard, handleJoin } = await import("../src/bot/share.ts");
const { DEFAULT_GIFT_COINS } = await import("../src/bot/gift.ts");

const CLASS_SEC = 90 * 60; // کلاس ۹۰ دقیقه‌ای = ۹۰ سکه
const SESSION = "seatsession01";
const OWNER = 6_000_001;

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ─── ۱. کفِ تعداد ────────────────────────────────────────────────────────────

upsertUser(OWNER, "مالک", null);
db.prepare(
  `INSERT OR REPLACE INTO sessions (id, tg_id, status, original_ms, share_enabled, share_target, mode)
   VALUES (?, ?, 'done', ?, 1, NULL, 'full')`,
).run(SESSION, OWNER, CLASS_SEC * 1000);
registerOwner(SESSION, OWNER, CLASS_SEC);
setShareEnabled(SESSION, true);

const targetOf = () =>
  db.prepare(`SELECT share_target AS t FROM sessions WHERE id = ?`).get(SESSION).t;

for (const asked of [1, 2, 4, 0, -3]) {
  setShareTarget(SESSION, asked);
  check(`«${asked} نفر» روی کف می‌نشیند`, targetOf() >= SHARE_TARGET_MIN, `ذخیره شد: ${targetOf()}`);
}
setShareTarget(SESSION, 20);
check("تعدادِ بالای کف دست‌نخورده می‌ماند", targetOf() === 20, `ذخیره شد: ${targetOf()}`);

// حتی اگر ردیفی از قبل با ۱ در پایگاه‌داده نشسته باشد، محاسبه کف را می‌گذارد
db.prepare(`UPDATE sessions SET share_target = 1 WHERE id = ?`).run(SESSION);
check(
  "ردیفِ قدیمیِ «۱ نفر» هم در محاسبه کف می‌خورد",
  shareBack(CLASS_SEC, 1).seat === shareBack(CLASS_SEC, SHARE_TARGET_MIN).seat,
  `${shareBack(CLASS_SEC, 1).seat} سکه`,
);

// ─── ۲. سهمی که تازه‌وارد از پسش برمی‌آید ────────────────────────────────────

const seat5 = shareBack(CLASS_SEC, SHARE_TARGET_MIN).seat;
console.log(
  `\nکلاس ${costCoins(CLASS_SEC)} سکه‌ای · کمترین گروه (${SHARE_TARGET_MIN} نفر) ⇒ سهم ${seat5} سکه · ` +
    `هدیهٔ تازه‌وارد ${DEFAULT_GIFT_COINS} سکه\n`,
);
check(
  `سهم در بدترین حالت از هدیهٔ ${DEFAULT_GIFT_COINS} سکه‌ای کمتر است`,
  seat5 <= DEFAULT_GIFT_COINS,
  `${seat5} سکه`,
);

// و هیچ گزینه‌ای روی صفحه‌کلید نباید از این بدتر باشد
const buttons = shareTargetKeyboard(SESSION).inline_keyboard.flat();
const options = buttons.map((b) => Number(b.callback_data.split(":").pop()));
console.log(`گزینه‌های صفحه‌کلید: ${options.join(" · ")}\n`);
check("گزینهٔ «۱ نفر» حذف شده", !options.includes(1));
check("کمترین گزینه، خودِ کف است", Math.min(...options) === SHARE_TARGET_MIN);
for (const n of options) {
  const { seat } = shareBack(CLASS_SEC, n);
  check(
    `«${n} نفر» ⇒ سهم ${seat} سکه، داخل هدیهٔ تازه‌وارد`,
    seat <= DEFAULT_GIFT_COINS,
  );
}
check("ردیف خالی ندارد", !shareTargetKeyboard(SESSION).inline_keyboard.some((r) => r.length === 0));

// مسیرِ پیش از پرداخت، دست‌کدِ خودش را دارد و با مسیرِ پس از تحویل قاطی نمی‌شود
const pre = shareTargetKeyboard(SESSION, "sontp").inline_keyboard.flat();
check("انتخابِ پیش از پرداخت دست‌کد جدا دارد", pre.every((b) => b.callback_data.startsWith("sontp:")));
check(
  "دست‌کدِ پس از تحویل با پیش از پرداخت اشتباه نمی‌شود",
  buttons.every((b) => /^sont:/.test(b.callback_data)) && !/^sont:/.test(pre[0].callback_data),
);

// ─── ۳. پیوستن با سکهٔ کم، دکمهٔ شارژ دارد ───────────────────────────────────

setShareTarget(SESSION, 10);
const seat = shareBack(CLASS_SEC, 10).seat;

const POOR = 6_000_050;
upsertUser(POOR, "تازه‌وارد", null);
grant(POOR, coinsToSec(Math.max(0, seat - 1)), "grant"); // یک سکه کم
const ctx = { from: { id: POOR, first_name: "تازه‌وارد" }, api: { token: "x" } };

const out = await handleJoin(ctx, SESSION);
console.log(`\nموجودی تازه‌وارد ${balanceCoins(coinsToSec(seat - 1))} سکه · سهم ${seat} سکه`);
console.log(out.message.replace(/<\/?[a-z][^>]*>/g, ""), "\n");

check("پیوستن انجام نشد", out.ok === false);
check("پاسخ دکمه دارد", Boolean(out.keyboard));
const topup = out.keyboard?.inline_keyboard.flat().find((b) => b.callback_data === "topup");
check("دکمهٔ شارژ حساب هست", Boolean(topup), topup?.text ?? "—");
check("کسری به سکه گفته شده", /کم داری/.test(out.message));
check("هیچ عضویتی ثبت نشده", !db
  .prepare(`SELECT 1 FROM session_members WHERE session_id = ? AND tg_id = ?`)
  .get(SESSION, POOR));

// و همان تازه‌وارد با هدیهٔ ۲۰ سکه‌ای باید بتواند برش دارد
const RICH = 6_000_060;
upsertUser(RICH, "تازه‌واردِ هدیه‌دار", null);
grant(RICH, coinsToSec(DEFAULT_GIFT_COINS), "gift");
const joined = { chargedSec: 0 };
try {
  const { joinSession } = await import("../src/billing/sharing.ts");
  const r = joinSession(SESSION, RICH);
  joined.chargedSec = r.chargedSec;
  check("تازه‌وارد با سکهٔ هدیه برش می‌دارد", true, `${costCoins(r.chargedSec)} سکه کم شد`);
} catch (e) {
  check("تازه‌وارد با سکهٔ هدیه برش می‌دارد", false, String(e));
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
