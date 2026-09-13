/**
 * سهمِ هم‌کلاسی — کفِ تعداد، دکمه‌هایی که عددِ واقعی می‌گویند، و مسیرِ پیوستنی
 * که بن‌بست نیست.
 *
 * ## باگ‌هایی که این آزمون نگه می‌دارد
 *
 * ۱. **گزینهٔ «۱ نفر».** با یک نفر سهم کلِ جلسه می‌شد و «شریک‌شدن» معنایی
 *    نداشت. کف حالا دو نفر است: مالک و دست‌کم یک هم‌کلاسی.
 *
 * ۲. **کف فقط در صفحه‌کلید نباشد.** صفحه‌کلید تنها راهِ رسیدن به
 *    `setShareTarget` نیست؛ دست‌کدِ دستی و مینی‌اپ هم هستند. کف در خودِ
 *    تابع بسته می‌شود، و `shareSeat` هم آن را اعمال می‌کند تا ردیف‌های
 *    قدیمیِ `share_target = 1` در پایگاه‌داده بی‌مهاجرت درمان شوند.
 *
 * ۳. **«۳۰ نفر · نفری ۱ سکه».** روی فایلِ کوتاه تعدادهایی دکمه می‌شدند که
 *    سهمشان عددی مسخره بود. فقط `shareCountsFor` دکمه می‌شود، و سهمِ روی دکمه
 *    همان است که `joinSession` واقعاً کم می‌کند.
 *
 * ۴. **موجودیِ کم روی مسیر پیوستن، بن‌بست بود.** `handleJoin` فقط یک متن
 *    برمی‌گرداند؛ تازه‌واردی که از گروه درس آمده در یک پیامِ بی‌راه گیر می‌کرد.
 *
 * اجرا: DATA_DIR=./data/tmp-seat npx tsx scripts/test-share-seat.mjs
 */
process.env.BOT_TOKEN ||= "x";

const { db, upsertUser } = await import("../src/db/index.ts");
const { grant, currentBalance } = await import("../src/billing/ledger.ts");
const { joinSession, setShareEnabled, setShareTarget, registerOwner, shareStatus } = await import(
  "../src/billing/sharing.ts"
);
const { MIN_SEAT_TOMAN, SHARE_TARGET, fmtToman, priceOf, shareCountsFor, shareSeat } = await import(
  "../src/billing/money.ts"
);
const { shareTargetKeyboard, handleJoin } = await import("../src/bot/share.ts");
const { config } = await import("../src/config.ts");
const S = await import("../src/bot/strings.ts");

const CLASS_SEC = 90 * 60;
const COST = priceOf(CLASS_SEC); // ۱۳۵٬۰۰۰ تومان
const SESSION = "seatsession01";
const OWNER = 6_000_001;
const FLOOR = 2;

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
registerOwner(SESSION, OWNER, COST);
setShareEnabled(SESSION, true);

const targetOf = () =>
  db.prepare(`SELECT share_target AS t FROM sessions WHERE id = ?`).get(SESSION).t;

for (const asked of [1, 2, 4, 0, -3]) {
  setShareTarget(SESSION, asked);
  const want = Math.max(FLOOR, asked);
  check(`«${asked} نفر» ⇒ ${want} (کف ${FLOOR})`, targetOf() === want, `ذخیره شد: ${targetOf()}`);
}
setShareTarget(SESSION, 20);
check("تعدادِ بالای کف دست‌نخورده می‌ماند", targetOf() === 20, `ذخیره شد: ${targetOf()}`);

// حتی اگر ردیفی از قبل با ۱ در پایگاه‌داده نشسته باشد، محاسبه کف را می‌گذارد
db.prepare(`UPDATE sessions SET share_target = 1 WHERE id = ?`).run(SESSION);
check(
  "ردیفِ قدیمیِ «۱ نفر» هم در محاسبه کف می‌خورد",
  shareSeat(COST, 1) === shareSeat(COST, FLOOR) && shareStatus(SESSION).seat === shareSeat(COST, FLOOR),
  fmtToman(shareStatus(SESSION).seat),
);
check(
  "… و مالک با کف هنوز چیزی پس می‌گیرد (سقف = قیمت منهای سهم)",
  shareStatus(SESSION).cap === COST - shareSeat(COST, FLOOR) && shareStatus(SESSION).cap > 0,
  fmtToman(shareStatus(SESSION).cap),
);

// ─── ۲. دکمه‌های تعداد ───────────────────────────────────────────────────────

// دکمهٔ «بی‌خیال» تعداد نیست؛ گزینه‌ها فقط دکمه‌های عددی‌اند.
const isCount = (b) => !b.callback_data.startsWith("shx:");
const allButtons = shareTargetKeyboard(SESSION, "sont", COST).inline_keyboard.flat();
const buttons = allButtons.filter(isCount);
const options = buttons.map((b) => Number(b.callback_data.split(":").pop()));
console.log(`\nکلاس ${fmtToman(COST)} · گزینه‌های صفحه‌کلید: ${options.join(" · ")}\n`);
check("راهِ «بی‌خیال» هست", allButtons.some((b) => b.callback_data === `shx:${SESSION}`));
check("دکمه‌ها همان shareCountsFor هستند", options.join(",") === shareCountsFor(COST).join(","), options.join(" · "));
// سهمِ روی دکمه باید همان باشد که `joinSession` واقعاً کم می‌کند.
for (const b of buttons) {
  const n = Number(b.callback_data.split(":").pop());
  check(`دکمهٔ «${n} نفر» سهمِ واقعی را می‌گوید`, b.text.includes(`نفری ${fmtToman(shareSeat(COST, n))}`), b.text);
}
check("گزینهٔ «۱ نفر» نیست", !options.includes(1));
check("کمترین گزینه، خودِ کف است", Math.min(...options) === FLOOR);
check("هیچ دکمه‌ای سهمِ زیرِ کمترین سهم ندارد", options.every((n) => shareSeat(COST, n) >= MIN_SEAT_TOMAN));
check(
  "دو دکمه با سهمِ یکسان نیست",
  new Set(options.map((n) => shareSeat(COST, n))).size === options.length,
);
check("ردیف خالی ندارد", !shareTargetKeyboard(SESSION, "sont", COST).inline_keyboard.some((r) => r.length === 0));

// فایلِ کوتاه: تعدادهای بزرگ دکمه نمی‌شوند، و فایلِ خیلی کوتاه اصلاً گزینه ندارد.
{
  const mid = priceOf(20 * 60); // ۳۰٬۰۰۰ تومان
  const midOpts = shareTargetKeyboard(SESSION, "sont", mid).inline_keyboard.flat().filter(isCount)
    .map((b) => Number(b.callback_data.split(":").pop()));
  check("فایلِ ۲۰ دقیقه‌ای «۱۰ نفر» و «۲۰ نفر» ندارد", !midOpts.includes(10) && !midOpts.includes(20) && midOpts.length > 0, midOpts.join(" · "));
  const tiny = priceOf(5 * 60); // ۷٬۵۰۰ تومان
  const tinyOpts = shareTargetKeyboard(SESSION, "sont", tiny).inline_keyboard.flat().filter(isCount);
  check(
    "فایلِ پنج‌دقیقه‌ای دکمهٔ تعداد ندارد — حتی دو نفر به کمترین سهم نمی‌رسد",
    tinyOpts.length === 0 && shareCountsFor(tiny).length === 0,
    tinyOpts.map((b) => b.text).join(" | "),
  );
}

// مسیرِ پیش از پرداخت، دست‌کدِ خودش را دارد و با مسیرِ پس از تحویل قاطی نمی‌شود
const pre = shareTargetKeyboard(SESSION, "sontp", COST).inline_keyboard.flat().filter(isCount);
check("انتخابِ پیش از پرداخت دست‌کد جدا دارد", pre.length > 0 && pre.every((b) => b.callback_data.startsWith("sontp:")));
check(
  "دست‌کدِ پس از تحویل با پیش از پرداخت اشتباه نمی‌شود",
  buttons.every((b) => /^sont:/.test(b.callback_data)) && !/^sont:/.test(pre[0].callback_data),
);

// ─── ۳. سهمِ پیش‌فرض در دسترسِ تازه‌وارد ────────────────────────────────────

setShareTarget(SESSION, SHARE_TARGET);
const seat = shareSeat(COST, SHARE_TARGET);
check(
  `با تعدادِ پیش‌فرض (${SHARE_TARGET} نفر) سهمِ کلاسِ ۹۰ دقیقه‌ای داخلِ هدیهٔ شروع است`,
  seat <= config.FREE_TRIAL_TOMAN,
  `${fmtToman(seat)} · هدیه ${fmtToman(config.FREE_TRIAL_TOMAN)}`,
);

// ─── ۴. پیوستن با موجودیِ کم، دکمهٔ شارژ دارد ────────────────────────────────

const POOR = 6_000_050;
upsertUser(POOR, "تازه‌وارد", null);
const poorBalance = seat - 500; // پانصد تومان کم
grant(POOR, poorBalance, "grant");
const ctx = { from: { id: POOR, first_name: "تازه‌وارد" }, api: { token: "x" } };

const out = await handleJoin(ctx, SESSION);
console.log(`\nموجودی تازه‌وارد ${fmtToman(poorBalance)} · سهم ${fmtToman(seat)}`);
console.log(out.message.replace(/<\/?[a-z][^>]*>/g, ""), "\n");

check("پیوستن انجام نشد", out.ok === false);
check("پاسخ دکمه دارد", Boolean(out.keyboard));
const topup = out.keyboard?.inline_keyboard.flat().find((b) => b.callback_data === "topup");
check("دکمهٔ شارژ حساب هست", Boolean(topup), topup?.text ?? "—");
check(
  "سهم و موجودی هر دو به تومان گفته شده",
  out.message.includes(fmtToman(seat)) && out.message.includes(fmtToman(poorBalance)),
);
check("می‌گوید بعد از شارژ همین جزوه برمی‌گردد", out.message.includes(S.JOIN_RETURN_HINT));
check("هیچ عضویتی ثبت نشده", !db
  .prepare(`SELECT 1 FROM session_members WHERE session_id = ? AND tg_id = ?`)
  .get(SESSION, POOR));
check("پولی کم نشد", currentBalance(POOR) === poorBalance, String(currentBalance(POOR)));

// و همان تازه‌وارد با هدیهٔ شروع باید بتواند برش دارد
const RICH = 6_000_060;
upsertUser(RICH, "تازه‌واردِ هدیه‌دار", null);
grant(RICH, config.FREE_TRIAL_TOMAN, "trial");
try {
  const r = joinSession(SESSION, RICH);
  check(
    "تازه‌وارد با هدیهٔ شروع برش می‌دارد و دقیقاً سهم کم می‌شود",
    r.charged === seat && currentBalance(RICH) === config.FREE_TRIAL_TOMAN - seat,
    `${fmtToman(r.charged)} کم شد`,
  );
} catch (e) {
  check("تازه‌وارد با هدیهٔ شروع برش می‌دارد", false, String(e));
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
