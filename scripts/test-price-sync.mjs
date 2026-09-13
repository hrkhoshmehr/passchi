/**
 * قیمت‌های صفحهٔ فرود باید با `PACKAGES` یکی باشند — و حاشیه باید بالای کف بماند.
 *
 * ## باگی که این آزمون نگه می‌دارد
 *
 * `public/index.html` نسخهٔ بی‌جاوااسکریپتِ کارت‌های قیمت را دستی دارد و یک بار
 * **دو نسل** از واقعیت عقب افتاد. چون جاوااسکریپت معمولاً کار می‌کند کسی متوجه
 * نمی‌شد — ولی خزندهٔ گوگل و کاربرِ بدون جاوااسکریپت همان اعداد غلط را می‌دیدند.
 *
 * ## و بخش دوم: حاشیه
 *
 * جهش نرخ ارز قیمت فروش را عوض نمی‌کند ولی حاشیه را می‌خورد. اگر روزی
 * `USD_TOMAN` یا هزینهٔ مدل بالا برود و کسی پکیج‌ها را به‌روز نکند، این آزمون
 * قرمز می‌شود — به‌جای اینکه ماه‌ها زیر کف بفروشیم.
 *
 * اجرا: npx tsx scripts/test-price-sync.mjs
 */
import fs from "node:fs";

const {
  PACKAGES, MIN_MARGIN, MIN_TOPUP_TOMAN, TOMAN_PER_MINUTE, fileTopup, fmtMinutesFor, packageMargin, priceOf,
  shareCountsFor, shareSeat, shareCap,
} = await import("../src/billing/money.ts");

const html = fs.readFileSync("public/index.html", "utf8").split("\r\n").join("\n");

let bad = 0;
const check = (label, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

/** «۱۱۸٬۰۰۰» → 118000 */
const faToNum = (s) => Number(s.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[^\d]/g, ""));

/**
 * فقط بلوکِ **ایستا** خوانده می‌شود، نه قالبِ جاوااسکریپتِ پایینِ صفحه — `$`
 * در الگوها بیرون گذاشته شده تا `${…}` قالب شمرده نشود.
 */
const staticBlock = html.slice(html.indexOf('<div class="prices"'), html.indexOf('</div>\n\n    <div class="split-note"'));
const pricesOnPage = [...staticBlock.matchAll(/class="price-toman num">([^<$]+)</g)].map((m) => faToNum(m[1]));
const creditsOnPage = [...staticBlock.matchAll(/class="price-credit num">اعتبار ([^<$]+) تومان</g)].map((m) => faToNum(m[1]));
const titlesOnPage = [...staticBlock.matchAll(/<h3>([^<$]+)<\/h3>/g)].map((m) => m[1].trim());
const worthOnPage = [...staticBlock.matchAll(/class="price-worth">([^<$]+)</g)].map((m) => m[1].trim());

check(`${PACKAGES.length} کارت قیمت در صفحه هست`, pricesOnPage.length === PACKAGES.length, String(pricesOnPage.length));
for (const [i, p] of PACKAGES.entries()) {
  check(`پکیج ${i + 1}: مبلغ در صفحه با کد یکی است`, pricesOnPage[i] === p.price, `صفحه ${pricesOnPage[i]} · کد ${p.price}`);
  check(`پکیج ${i + 1}: اعتبار در صفحه با کد یکی است`, creditsOnPage[i] === p.credit, `صفحه ${creditsOnPage[i]} · کد ${p.credit}`);
  check(`پکیج ${i + 1}: اسم در صفحه با کد یکی است`, titlesOnPage[i] === p.title, `«${titlesOnPage[i]}» · «${p.title}»`);
  check(`پکیج ${i + 1}: دقیقه‌ها در صفحه با کد یکی است`, worthOnPage[i] === fmtMinutesFor(p.credit), `«${worthOnPage[i]}» · «${fmtMinutesFor(p.credit)}»`);
  // اسمِ پکیج همان مبلغ است؛ اگر مبلغ عوض شود و اسم نه، اسم بی‌صدا دروغ می‌گوید.
  check(`پکیج ${i + 1}: اسمش همان مبلغ است`, faToNum(p.title) * 1000 === p.price, p.title);
}
check("صفحهٔ قیمت هیچ‌جا «سکه» یا «n کلاس» نمی‌گوید", !/سکه|[۰-۹]+ کلاس/.test(staticBlock));
check("کمترین شارژ همان پکیجِ اول است", PACKAGES[0].price === MIN_TOPUP_TOMAN);
check("هیچ‌جای صفحه «سکه» نمانده", !html.includes("سکه"));

// ─── حاشیه، پس از کارمزد و با هدیه ──────────────────────────────────────────
for (const p of PACKAGES) {
  const margin = packageMargin(p);
  check(`پکیج ${p.price} بالای کف ×${MIN_MARGIN} است`, margin >= MIN_MARGIN - 0.005, `×${margin.toFixed(2)}`);
}
// نردبان: پکیج بزرگ‌تر باید هر تومان اعتبار را ارزان‌تر بدهد، وگرنه دلیلی برای انتخابش نیست.
for (let i = 1; i < PACKAGES.length; i++) {
  const prev = PACKAGES[i - 1].price / PACKAGES[i - 1].credit;
  const cur = PACKAGES[i].price / PACKAGES[i].credit;
  check(`پکیج ${PACKAGES[i].price} هر تومان اعتبارش ارزان‌تر از قبلی است`, cur < prev, `${cur.toFixed(3)} < ${prev.toFixed(3)}`);
}

// ─── «پرداخت همین فایل» ──────────────────────────────────────────────────────
for (const short of [1, 7_000, 49_999, 50_000, 71_500, 200_300]) {
  const t = fileTopup(short);
  check(`پرداخت فایل با کسری ${short}: کسری پوشش داده می‌شود`, t.credit >= short, JSON.stringify(t));
  check(`… مبلغ مضرب هزار و دست‌کم ${MIN_TOPUP_TOMAN}`, t.price % 1000 === 0 && t.price >= MIN_TOPUP_TOMAN, String(t.price));
  check(`… و بالای کف ×${MIN_MARGIN}`, packageMargin(t) >= MIN_MARGIN, `×${packageMargin(t).toFixed(2)}`);
}

// ─── قیمت و سهم ──────────────────────────────────────────────────────────────
check("نرخِ دقیقه ۱٬۵۰۰ تومان", TOMAN_PER_MINUTE === 1_500);
check("کلاس ۹۰ دقیقه‌ای ۱۳۵ هزار تومان", priceOf(90 * 60) === 135_000, String(priceOf(90 * 60)));
check("قیمت روی مضربِ پانصد و به بالا", priceOf(61) === 2_000 && priceOf(1) === 500 && priceOf(0) === 0, `${priceOf(61)} ${priceOf(1)}`);
check("صفحه نرخ و قیمتِ کلاس را همان می‌گوید", html.includes("۱٬۵۰۰") && html.includes("۱۳۵"));
{
  const cls = priceOf(90 * 60);
  check("۵ نفر روی کلاسِ ۱۳۵ هزاری: نفری ۲۷ هزار، برگشتی تا ۱۰۸ هزار", shareSeat(cls, 5) === 27_000 && shareCap(cls, 5) === 108_000, `${shareSeat(cls, 5)} ${shareCap(cls, 5)}`);
  check("روی فایلِ ۵ دقیقه‌ای (۷٬۵۰۰) هیچ تعدادی دکمه نمی‌شود", shareCountsFor(priceOf(5 * 60)).length === 0, JSON.stringify(shareCountsFor(priceOf(5 * 60))));
  check("هیچ تعدادی سهمِ زیرِ ۵ هزار نمی‌سازد", shareCountsFor(cls).every((n) => shareSeat(cls, n) >= 5_000), JSON.stringify(shareCountsFor(cls)));
}

console.log(bad === 0 ? "\nهمه سبز ✅" : `\n${bad} بررسی شکست خورد ❌`);
process.exit(bad === 0 ? 0 : 1);
