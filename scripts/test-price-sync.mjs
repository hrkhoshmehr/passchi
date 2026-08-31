/**
 * قیمت‌های صفحهٔ فرود باید با `PACKAGES` یکی باشند — و حاشیه باید بالای کف بماند.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * `public/index.html` نسخهٔ بی‌جاوااسکریپتِ کارت‌های قیمت را دستی دارد.
 * یک بار **دو نسل** از واقعیت عقب افتاد: تعداد سکه‌ها (۷۰۰/۲۰۰۰/۵۰۰۰) از
 * دورانِ «هفت سکه در هر دقیقه» مانده بود و مبلغ‌ها از افزایش قیمت ۲۰۲۶-۰۸-۲۷.
 * چون جاوااسکریپت معمولاً کار می‌کند، کسی متوجه نمی‌شد — ولی خزندهٔ گوگل و
 * کاربرِ بدون جاوااسکریپت همان اعداد غلط را می‌دیدند.
 *
 * همین خانواده از باگ قبلاً هم زده بود: سایت ۱۰۰ سکه تبلیغ می‌کرد و ربات ۲۰
 * سکه می‌داد.
 *
 * ## و بخش دوم: حاشیه
 *
 * جهش نرخ ارز قیمت فروش را عوض نمی‌کند ولی حاشیه را می‌خورد. اگر روزی
 * `USD_TOMAN` یا هزینهٔ مدل بالا برود و کسی پکیج‌ها را به‌روز نکند، این
 * آزمون قرمز می‌شود — به‌جای اینکه ماه‌ها زیر کف بفروشیم.
 *
 * اجرا: npx tsx scripts/test-price-sync.mjs
 */
import fs from "node:fs";

const { PACKAGES, COST_PER_COIN_TOMAN } = await import("../src/billing/coins.ts");

const html = fs.readFileSync("public/index.html", "utf8").split("\r\n").join("\n");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

/** «۱۱۸٬۰۰۰» → 118000 */
const faToNum = (s) =>
  Number(s.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[^\d]/g, ""));

/**
 * فقط بلوکِ **ایستا** خوانده می‌شود، نه قالبِ جاوااسکریپت.
 *
 * پایین همان فایل یک template literal هست که کارت‌ها را از `/api/packages`
 * می‌سازد و همان کلاس‌ها را دارد؛ اگر آن هم شمرده شود، چهار کارت پیدا
 * می‌شود و آزمون سرِ چیزی قرمز می‌شود که اصلاً مشکل نیست.
 */
const staticBlock = html.slice(html.indexOf('<div class="prices"'), html.indexOf("</div>\n\n    <div class=\"split-note\""));
const coinsOnPage = [...staticBlock.matchAll(/class="price-coins num">([^<$]+)</g)].map((m) => faToNum(m[1]));
const tomanOnPage = [...staticBlock.matchAll(/class="price-toman num">([^<$]+)</g)].map((m) => faToNum(m[1]));

check("سه کارت قیمت در صفحه هست", coinsOnPage.length === 3, String(coinsOnPage.length));
check("سه مبلغ در صفحه هست", tomanOnPage.length === 3, String(tomanOnPage.length));

for (const [i, p] of PACKAGES.entries()) {
  check(
    `پکیج ${i + 1}: تعداد سکه در صفحه با کد یکی است`,
    coinsOnPage[i] === p.coins,
    `صفحه ${coinsOnPage[i]} · کد ${p.coins}`,
  );
  check(
    `پکیج ${i + 1}: مبلغ در صفحه با کد یکی است`,
    tomanOnPage[i] === p.price,
    `صفحه ${tomanOnPage[i]} · کد ${p.price}`,
  );
}

// ─── حاشیه ──────────────────────────────────────────────────────────────────
//
// همان کفی که `coins.ts` در توضیحش قول داده: هر پکیج دست‌کم دو برابر هزینه.
const MIN_MARGIN = 2;
for (const p of PACKAGES) {
  const margin = p.price / p.coins / COST_PER_COIN_TOMAN;
  check(
    `پکیج ${p.coins} سکه‌ای بالای کف ×${MIN_MARGIN} است`,
    margin >= MIN_MARGIN - 0.005, // گردکردن مبلغ روی هزار، خطای ناچیز می‌سازد
    `×${margin.toFixed(2)}`,
  );
}

// نردبان تخفیف: پکیج بزرگ‌تر باید سکهٔ ارزان‌تری بدهد، وگرنه دلیلی برای
// انتخابش نیست.
for (let i = 1; i < PACKAGES.length; i++) {
  const prev = PACKAGES[i - 1].price / PACKAGES[i - 1].coins;
  const cur = PACKAGES[i].price / PACKAGES[i].coins;
  check(`پکیج ${PACKAGES[i].coins} سکهٔ ارزان‌تری از قبلی دارد`, cur < prev, `${cur.toFixed(0)} < ${prev.toFixed(0)}`);
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
