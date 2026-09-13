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

const { PACKAGES, MIN_MARGIN, packageMargin, classesFor, COINS_PER_MINUTE } = await import("../src/billing/coins.ts");

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

// تعداد از خودِ `PACKAGES` می‌آید نه عددِ سفت‌شده: وقتی پکیج چهارم آمد، صفحه‌ای
// که هنوز سه کارت دارد باید قرمز شود، نه اینکه کسی «۳» را دستی عوض کند.
check(`${PACKAGES.length} کارت قیمت در صفحه هست`, coinsOnPage.length === PACKAGES.length, String(coinsOnPage.length));
check(`${PACKAGES.length} مبلغ در صفحه هست`, tomanOnPage.length === PACKAGES.length, String(tomanOnPage.length));

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
// همان کفی که `coins.ts` در توضیحش قول داده: هر پکیج دست‌کم دو برابر هزینه —
// **پس از کارمزد درگاه**، چون آن بخش از مبلغ هیچ‌وقت به دست ما نمی‌رسد.
for (const p of PACKAGES) {
  const margin = packageMargin(p);
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

// اسمِ پکیج تعدادِ کلاس است. عددِ اسم باید با `classesFor` بخواند، وگرنه روزی که
// سکه‌های یک پکیج عوض شود، اسمش بی‌صدا دروغ می‌گوید — همان خانوادهٔ باگی که
// قیمت‌های دستیِ همین صفحه را دو نسل عقب نگه داشته بود.
for (const p of PACKAGES) {
  const n = classesFor(p.coins);
  const m = String(p.title).match(/^([۰-۹]+) کلاس$/);
  if (n >= 1) {
    check(`اسم پکیج ${p.coins} سکه‌ای تعداد کلاس درست را می‌گوید`, Boolean(m) && faToNum(m[1]) === n, `«${p.title}» · باید ${n} کلاس باشد`);
  } else {
    check(`پکیج ${p.coins} سکه‌ای ادعای کلاس ندارد`, !m, `«${p.title}»`);
  }
}

// آزمون‌های بالا فقط عدد و مبلغ را می‌سنجیدند؛ اسم و سطرِ «هر کلاس» هم دستی در
// HTML تکرار شده‌اند و باید با کد بخوانند. `$` بیرون گذاشته شده تا قالبِ
// جاوااسکریپتِ همین صفحه (`${esc(p.title)}`) به‌جای کارتِ ایستا شمرده نشود.
const titlesOnPage = [...staticBlock.matchAll(/<h3>([^<$]+)<\/h3>/g)].map((m) => m[1].trim());
check(
  "اسم‌های پکیج در صفحه با کد یکی است",
  titlesOnPage.join("|") === PACKAGES.map((p) => p.title).join("|"),
  `صفحه: ${titlesOnPage.join("، ")} · کد: ${PACKAGES.map((p) => p.title).join("، ")}`,
);

const perClassOnPage = [...staticBlock.matchAll(/class="price-worth">هر کلاس ۹۰ دقیقه‌ای: حدود ([۰-۹٬]+) هزار تومان</g)].map((m) => faToNum(m[1]));
const classPkgs = PACKAGES.filter((p) => classesFor(p.coins) >= 1);
check("برای هر پکیجِ کلاسی یک سطرِ «هر کلاس» در صفحه هست", perClassOnPage.length === classPkgs.length, `${perClassOnPage.length} در برابر ${classPkgs.length}`);
classPkgs.forEach((p, i) => {
  const want = Math.round((90 * COINS_PER_MINUTE * p.price) / p.coins / 1000);
  check(`قیمت هر کلاسِ پکیج ${p.coins} سکه‌ای در صفحه درست است`, perClassOnPage[i] === want, `صفحه ${perClassOnPage[i]} · کد ${want}`);
});

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
