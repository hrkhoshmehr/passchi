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

const { PACKAGES, MIN_MARGIN, packageMargin } = await import("../src/billing/coins.ts");

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

// اسمِ پکیج تعدادِ سکه است، نه کلاس (کلاس‌ها طولِ یکسانی ندارند). عددِ اسم باید
// با سکه‌ها بخواند، وگرنه روزی که سکه‌های یک پکیج عوض شود، اسمش بی‌صدا دروغ
// می‌گوید — همان خانوادهٔ باگی که قیمت‌های دستیِ این صفحه را عقب نگه داشته بود.
for (const p of PACKAGES) {
  const m = String(p.title).match(/^([۰-۹٬]+) سکه$/);
  check(`اسم پکیج ${p.coins} سکه‌ای همان تعداد سکه است`, Boolean(m) && faToNum(m[1]) === p.coins, `«${p.title}»`);
  check(`پکیج ${p.coins} سکه‌ای هیچ‌جا تعداد کلاس نمی‌گوید`, !/کلاس ۹۰|[۰-۹]+ کلاس/.test(`${p.title} ${p.blurb}`), p.blurb);
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

const perCoinOnPage = [...staticBlock.matchAll(/class="price-worth">هر سکه حدود ([۰-۹٬]+) تومان</g)].map((m) => faToNum(m[1]));
check("برای هر پکیج یک سطرِ «هر سکه» در صفحه هست", perCoinOnPage.length === PACKAGES.length, `${perCoinOnPage.length} در برابر ${PACKAGES.length}`);
PACKAGES.forEach((p, i) => {
  const want = Math.round(p.price / p.coins);
  check(`قیمت هر سکهٔ پکیج ${p.coins} سکه‌ای در صفحه درست است`, perCoinOnPage[i] === want, `صفحه ${perCoinOnPage[i]} · کد ${want}`);
});
check("صفحهٔ قیمت هیچ‌جا «n کلاس» نمی‌گوید", !/[۰-۹]+ کلاس|هر کلاس ۹۰/.test(staticBlock));

// «پرداخت همین فایل» باید از کوچک‌ترین پکیج گران‌تر باشد، وگرنه پکیج بی‌معنا
// می‌شود — و خودش هم باید بالای کف بماند، با همان کارمزدِ درگاه.
const { fileTopup, FILE_COIN_PRICE_TOMAN, FILE_MIN_TOMAN } = await import("../src/billing/coins.ts");
const cheapest = Math.min(...PACKAGES.map((p) => p.price / p.coins));
check("هر سکهٔ «پرداخت همین فایل» از هر پکیجی گران‌تر است", FILE_COIN_PRICE_TOMAN > Math.max(...PACKAGES.map((p) => p.price / p.coins)), `${FILE_COIN_PRICE_TOMAN} · ${cheapest.toFixed(0)}`);
for (const short of [1, 7, 20, 21, 71, 130]) {
  const t = fileTopup(short);
  check(`پرداخت فایل با ${short} سکه کسری: کسری پوشش داده می‌شود`, t.coins >= short, JSON.stringify(t));
  check(`… مبلغ مضرب هزار و دست‌کم ${FILE_MIN_TOMAN}`, t.price % 1000 === 0 && t.price >= FILE_MIN_TOMAN, String(t.price));
  check(`… و بالای کف ×${MIN_MARGIN}`, packageMargin(t) >= MIN_MARGIN, `×${packageMargin(t).toFixed(2)}`);
}
check("۷۱ سکه کسری ⇒ ۱۰۷ هزار تومان", fileTopup(71).price === 107_000 && fileTopup(71).coins === 71, JSON.stringify(fileTopup(71)));
check("۷ سکه کسری ⇒ کفِ ۳۰ هزار، و ۲۰ سکه می‌گیرد نه ۷", fileTopup(7).price === 30_000 && fileTopup(7).coins === 20, JSON.stringify(fileTopup(7)));

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
